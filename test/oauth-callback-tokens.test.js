/**
 * Spec for the GHL OAuth callback token leak.
 *
 * These tests fail while GET /oauth/callback embeds the access token and
 * refresh token in the HTML body, or omits Cache-Control: no-store.
 * They pass once that response is a static success page, the callback
 * sends Cache-Control: no-store, and the tokens remain only in the
 * server-side token store.
 *
 * The GoHighLevel token host is not contacted. A local stand-in accepts
 * the POST that services/ghl.js issues and returns the JSON fields that
 * exchangeCodeForToken reads. Axios, Express, and the token store run
 * as shipped.
 */
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import axios from "axios";

const GHL_TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";

const ACCESS_TOKEN = "ya29.ghl-access-9ed0574b0dbe430a";
const REFRESH_TOKEN = "1//ghl-refresh-129a947d67d9";
const LOCATION_ID = "loc_test_9ed0574b";
const AUTH_CODE = "splitted/code-value";

const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "ghl-oauth-callback-"));
process.chdir(tokenDir);

const appPort = await freePort();
const tokenPort = await freePort();

process.env.PORT = String(appPort);
process.env.GHL_CLIENT_ID = "test-ghl-client-id";
process.env.GHL_CLIENT_SECRET = "test-ghl-client-secret";
process.env.GHL_REDIRECT_URI = `http://127.0.0.1:${appPort}/oauth/callback`;
delete process.env.GHL_ACCESS_TOKEN;

const exchanges = [];

const tokenServer = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const params = new URLSearchParams(rawBody);
    exchanges.push({
      method: req.method,
      url: req.url,
      rawBody,
      code: params.get("code"),
      grantType: params.get("grant_type"),
      userType: params.get("user_type"),
      clientId: params.get("client_id"),
      redirectUri: params.get("redirect_uri"),
    });

    const body = JSON.stringify({
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      expires_in: 3600,
      locationId: LOCATION_ID,
      token_type: "Bearer",
    });
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  });
});

await new Promise((resolve) => tokenServer.listen(tokenPort, "127.0.0.1", resolve));

axios.interceptors.request.use((config) => {
  if (config.url === GHL_TOKEN_URL) {
    config.url = `http://127.0.0.1:${tokenPort}/oauth/token`;
  }
  return config;
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await import(pathToFileURL(path.join(repoRoot, "index.js")).href);

await waitForHttp(`http://127.0.0.1:${appPort}/`);

after(() => {
  tokenServer.close();
});

test("GET /oauth/callback keeps GHL tokens out of the browser response", async () => {
  const response = await fetch(
    `http://127.0.0.1:${appPort}/oauth/callback?code=${encodeURIComponent(AUTH_CODE)}`
  );
  const body = await response.text();
  const stored = JSON.parse(fs.readFileSync(path.join(tokenDir, "tokens.json"), "utf8"));

  assert.equal(exchanges.length, 1, "callback did not exchange the authorization code");
  const exchange = exchanges[0];
  assert.equal(exchange.method, "POST");
  assert.equal(exchange.url, "/oauth/token");
  assert.equal(exchange.grantType, "authorization_code");
  assert.equal(exchange.userType, "Location");
  assert.equal(exchange.clientId, process.env.GHL_CLIENT_ID);
  assert.equal(exchange.redirectUri, process.env.GHL_REDIRECT_URI);
  assert.equal(
    exchange.code,
    AUTH_CODE,
    "token request did not carry the code parsed from the callback query"
  );

  assert.equal(response.status, 200);
  assert.equal(stored.ghl.access_token, ACCESS_TOKEN);
  assert.equal(stored.ghl.refresh_token, REFRESH_TOKEN);
  assert.equal(stored.location_id, LOCATION_ID);

  const problems = [];
  if (body.includes(ACCESS_TOKEN)) {
    problems.push("response body contains the access token value");
  }
  if (body.includes(REFRESH_TOKEN)) {
    problems.push("response body contains the refresh token value");
  }
  if (body.includes("access_token")) {
    problems.push("response body contains the access_token field");
  }
  if (body.includes("refresh_token")) {
    problems.push("response body contains the refresh_token field");
  }

  for (const [name, value] of response.headers) {
    if (value.includes(ACCESS_TOKEN) || value.includes(REFRESH_TOKEN)) {
      problems.push(`response header ${name} contains a token value`);
    }
  }

  const cacheControl = response.headers.get("cache-control");
  if (!cacheControl || !/no-store/i.test(cacheControl)) {
    problems.push(
      `Cache-Control is ${cacheControl === null ? "absent" : JSON.stringify(cacheControl)}; expected no-store`
    );
  }

  const headerDump = [...response.headers.entries()]
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
  assert.deepEqual(
    problems,
    [],
    `${problems.join("\n")}\n\nstatus: ${response.status}\n\nheaders:\n${headerDump}\n\nbody:\n${body}`
  );
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`status ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError;
}
