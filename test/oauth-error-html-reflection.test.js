/**
 * Spec for the OAuth error pages.
 *
 * These tests fail while error_description is copied into an HTML response.
 * They pass once each callback either HTML-encodes that value before inserting
 * it, or answers with a plain-text body that does not treat the value as HTML.
 *
 * Run:
 *   node --test --test-concurrency=1 test/oauth-error-html-reflection.test.js
 *
 * google-chrome must be on PATH. The browser check is the script-execution step.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, before, after } from "node:test";
import { fileURLToPath } from "node:url";

const PORT = 39123;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCRIPT_PAYLOAD =
  '</p><script>document.documentElement.setAttribute("data-xss","confirmed")</script><p>';
const IMG_PAYLOAD =
  "<img src=x onerror=\"document.documentElement.setAttribute('data-xss','confirmed')\">";
const SVG_PAYLOAD =
  "<svg/onload=\"document.documentElement.setAttribute('data-xss','confirmed')\">";

let server;

before(async () => {
  server = spawn(process.execPath, ["index.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`server did not start\n${logs}`));
    }, 10000);
    const onData = (chunk) => {
      logs += chunk.toString();
      if (logs.includes("Server running")) {
        clearTimeout(timer);
        resolve();
      }
    };
    server.stdout.on("data", onData);
    server.stderr.on("data", onData);
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code} before listening\n${logs}`));
    });
  });

  await ready;
});

after(async () => {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await Promise.race([
    once(server, "exit"),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  if (server.exitCode === null) server.kill("SIGKILL");
});

function callbackUrl(pathname, descriptions) {
  const query = [
    `error=${encodeURIComponent("access_denied")}`,
    ...descriptions.map(
      (description) => `error_description=${encodeURIComponent(description)}`
    ),
  ].join("&");
  return `${BASE}${pathname}?${query}`;
}

function isHtml(contentType) {
  return /text\/html/i.test(contentType || "");
}

async function dumpDom(url) {
  const profile = await mkdtemp(path.join(tmpdir(), "oauth-error-chrome-"));
  const proc = spawn(
    "google-chrome",
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--disable-extensions",
      `--user-data-dir=${profile}`,
      "--virtual-time-budget=2000",
      "--dump-dom",
      url,
    ],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] }
  );

  let dom = "";
  let err = "";
  const stop = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  };

  const finished = new Promise((resolve) => {
    const timer = setTimeout(stop, 15000);
    proc.stdout.on("data", (chunk) => {
      dom += chunk.toString();
      if (dom.includes("</html>")) {
        clearTimeout(timer);
        stop();
      }
    });
    proc.stderr.on("data", (chunk) => {
      err += chunk.toString();
    });
    proc.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
    proc.on("error", (error) => {
      clearTimeout(timer);
      err += String(error);
      resolve();
    });
  });

  await finished;
  await rm(profile, { recursive: true, force: true });

  if (!dom.includes("<html")) {
    throw new Error(
      `google-chrome did not return a document for ${url}\n${err.slice(-500)}`
    );
  }
  return dom;
}

async function assertErrorPageDoesNotExecute(pathname, descriptions) {
  const url = callbackUrl(pathname, descriptions);
  const response = await fetch(url);
  const body = await response.text();
  const contentType = response.headers.get("content-type") || "";
  const csp = response.headers.get("content-security-policy");
  const dom = await dumpDom(url);

  const reflected = descriptions.filter(
    (description) => isHtml(contentType) && body.includes(description)
  );
  const executed = dom.includes('data-xss="confirmed"');

  assert.equal(
    reflected.length === 0 && !executed,
    true,
    [
      `${pathname} treated error_description as HTML.`,
      `content-type: ${contentType}`,
      `content-security-policy: ${csp ?? "(none)"}`,
      `reflected raw values: ${reflected.length}`,
      `browser executed payload: ${executed}`,
      `body: ${body}`,
    ].join("\n")
  );
}

test(
  "GET /oauth/callback does not run a script supplied as error_description",
  { timeout: 30000 },
  async () => {
    await assertErrorPageDoesNotExecute("/oauth/callback", [SCRIPT_PAYLOAD]);
  }
);

test(
  "GET /oauth/callback does not run an event handler supplied as error_description",
  { timeout: 30000 },
  async () => {
    await assertErrorPageDoesNotExecute("/oauth/callback", [IMG_PAYLOAD]);
  }
);

test(
  "GET /oauth/callback does not run repeated error_description values",
  { timeout: 30000 },
  async () => {
    await assertErrorPageDoesNotExecute("/oauth/callback", [
      SCRIPT_PAYLOAD,
      SVG_PAYLOAD,
    ]);
  }
);

test(
  "GET /oauth/podium/callback does not run a script supplied as error_description",
  { timeout: 30000 },
  async () => {
    await assertErrorPageDoesNotExecute("/oauth/podium/callback", [
      SCRIPT_PAYLOAD,
    ]);
  }
);

test(
  "GET /oauth/podium/callback does not run an event handler supplied as error_description",
  { timeout: 30000 },
  async () => {
    await assertErrorPageDoesNotExecute("/oauth/podium/callback", [IMG_PAYLOAD]);
  }
);

test(
  "GET /oauth/podium/callback does not run repeated error_description values",
  { timeout: 30000 },
  async () => {
    await assertErrorPageDoesNotExecute("/oauth/podium/callback", [
      SCRIPT_PAYLOAD,
      SVG_PAYLOAD,
    ]);
  }
);
