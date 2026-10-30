/**
 * Spec for the OAuth error-page HTML reflection.
 *
 * These tests fail while error_description is written into an HTML response
 * without encoding. They pass when each callback HTML-encodes that value or
 * returns a fixed plain-text error (Content-Type other than HTML, and not a
 * type browsers treat as markup).
 *
 * The same interpolation is on:
 *   GET /oauth/podium/callback  (services/podium.js podiumCallback)
 *   GET /oauth/callback         (index.js GoHighLevel callback)
 *
 * Not covered here: token-exchange catch blocks that interpolate err.message
 * (services/podium.js and index.js) and the GHL success page that interpolates
 * JSON.stringify(tokens). Those strings come from the HTTP client or the token
 * response, not from error_description.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 38741;
const tokensPath = path.join(root, 'tokens.json');

const SCRIPT = '<script>window.__oauthErrorXss=1</script>';
const BREAKOUT = '</p><img src=x onerror="window.__oauthErrorXss=1"><p>';

let server;
let tokensBefore;

function isMarkupContentType(contentType) {
  const media = String(contentType || '').split(';')[0].trim().toLowerCase();
  return (
    media === '' ||
    media === 'text/html' ||
    media === 'application/xhtml+xml' ||
    media === 'image/svg+xml'
  );
}

function reflectsPayloadAsMarkup(contentType, body, payload) {
  return isMarkupContentType(contentType) && body.includes(payload);
}

async function getUnauthenticated(pathnameAndQuery) {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathnameAndQuery}`, {
    redirect: 'manual',
  });
  const body = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    body,
  };
}

function errorQuery(payload) {
  return `error=access_denied&error_description=${encodeURIComponent(payload)}`;
}

function repeatedErrorQuery(payload) {
  const encoded = encodeURIComponent(payload);
  return `error=access_denied&error_description=${encoded}&error_description=${encoded}`;
}

before(async () => {
  tokensBefore = fs.existsSync(tokensPath) ? fs.readFileSync(tokensPath) : null;
  server = spawn(process.execPath, ['index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      DOTENV_CONFIG_QUIET: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`server did not start\n${output}`));
    }, 8000);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes('Server running')) {
        clearTimeout(timer);
        resolve();
      }
    };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
    server.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}\n${output}`));
    });
  });
  await ready;
});

after(async () => {
  if (!server || server.killed) return;
  server.kill('SIGTERM');
  await once(server, 'exit').catch(() => {});
});

const routes = [
  {
    name: 'Podium OAuth callback',
    path: '/oauth/podium/callback',
  },
  {
    name: 'GoHighLevel OAuth callback',
    path: '/oauth/callback',
  },
];

for (const route of routes) {
  for (const payload of [SCRIPT, BREAKOUT]) {
    test(`${route.name} does not treat error_description as HTML (${payload.slice(0, 12)}…)`, async () => {
      const result = await getUnauthenticated(`${route.path}?${errorQuery(payload)}`);

      assert.notEqual(result.status, 401);
      assert.notEqual(result.status, 403);
      assert.equal(
        reflectsPayloadAsMarkup(result.contentType, result.body, payload),
        false,
        `status=${result.status} content-type=${JSON.stringify(result.contentType)} body=${JSON.stringify(result.body)}`
      );
    });
  }

  test(`${route.name} does not reflect a repeated error_description as HTML`, async () => {
    const payload = '<script>window.__oauthErrorXss=2</script>';
    const result = await getUnauthenticated(`${route.path}?${repeatedErrorQuery(payload)}`);

    assert.notEqual(result.status, 401);
    assert.notEqual(result.status, 403);
    assert.equal(
      reflectsPayloadAsMarkup(result.contentType, result.body, payload),
      false,
      `status=${result.status} content-type=${JSON.stringify(result.contentType)} body=${JSON.stringify(result.body)}`
    );
  });
}

test('OAuth error responses do not create or change tokens.json', async () => {
  const payload = SCRIPT;
  await getUnauthenticated(`/oauth/podium/callback?${errorQuery(payload)}`);
  await getUnauthenticated(`/oauth/callback?${errorQuery(payload)}`);

  const tokensAfter = fs.existsSync(tokensPath) ? fs.readFileSync(tokensPath) : null;
  assert.deepEqual(tokensAfter, tokensBefore);
});
