/**
 * Spec for TEST_SECRET on webhook registration and contact lookup.
 *
 * These tests fail while the routes accept TEST_SECRET from the query string
 * and perform the upstream action. They pass once both operations:
 *
 * - are not served by GET, and
 * - authorize POST only from the `x-test-secret` header or a JSON `secret`
 *   field, and
 * - do not perform the upstream call when the query string contains a
 *   `secret` parameter, even if the header or body secret is also correct.
 *
 * An authorized POST /test-contact upserts the phone and name from the JSON
 * body and returns the upstream JSON unchanged.
 * An authorized POST /setup/register-webhook returns
 * `{ ok: true, webhook: <upstream JSON> }`, including the signing secret
 * the upstream webhook record carries.
 *
 * Run: node --test --test-force-exit test/setup-secret-query.test.js
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

const SECRET = "TEST_SECRET_VALUE_9f3a";
const SIGNING_SECRET = "PODIUM_SIGNING_SECRET_abc";
const LOCATION_ID = "loc_test_1";
const LOCATION_UID = "podium-loc-1";
const WEBHOOK_URL = "https://app.example.test/webhook/podium";
const GHL_TOKEN = "ghl-access-token-test";
const CONTACT_ID = "ghl-contact-1";
const WEBHOOK_ID = "wh_1";

const upstreamCalls = [];
const proxyLog = [];

const tokenFile = path.join(process.cwd(), "tokens.json");
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), "podium-query-secret-"));
const certPath = path.join(certDir, "cert.pem");
const keyPath = path.join(certDir, "key.pem");

let standInPort;
let appPort;
let proxyPort;
let standInServer;
let proxyServer;
const originalHttpsRequest = https.request.bind(https);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048",
  "-keyout", keyPath,
  "-out", certPath,
  "-days", "1",
  "-nodes",
  "-subj", "/CN=localhost",
], { stdio: "ignore" });

function installUpstreamRedirect() {
  https.request = function request(options, callback) {
    if (
      options &&
      typeof options === "object" &&
      (options.hostname === "services.leadconnectorhq.com" ||
        options.hostname === "api.podium.com")
    ) {
      const servername = options.hostname;
      options = {
        ...options,
        hostname: "127.0.0.1",
        port: standInPort,
        servername,
        rejectUnauthorized: false,
        agent: new https.Agent({ rejectUnauthorized: false }),
      };
    }
    return originalHttpsRequest(options, callback);
  };
}

before(async () => {
  standInServer = https.createServer(
    {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    },
    async (req, res) => {
      const raw = await readBody(req);
      let body = {};
      if (raw.length) {
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          body = { unparsed: raw.toString("utf8") };
        }
      }
      const call = {
        method: req.method,
        url: req.url,
        body,
        authorization: req.headers.authorization || "",
      };
      upstreamCalls.push(call);

      if (req.method === "POST" && req.url === "/contacts/upsert") {
        const payload = {
          contact: {
            id: CONTACT_ID,
            phone: body.phone,
            name: body.name,
          },
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
        return;
      }

      if (req.method === "POST" && req.url === "/v4/webhooks") {
        const payload = {
          id: WEBHOOK_ID,
          secret: SIGNING_SECRET,
          url: body.url,
          locationUid: body.locationUid,
          eventTypes: body.eventTypes,
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
        return;
      }

      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unexpected upstream call", method: req.method, url: req.url }));
    }
  );
  standInPort = await listen(standInServer);
  installUpstreamRedirect();

  appPort = await freePort();
  process.env.PORT = String(appPort);
  process.env.DOTENV_CONFIG_QUIET = "true";
  process.env.TEST_SECRET = SECRET;
  process.env.GHL_ACCESS_TOKEN = GHL_TOKEN;
  process.env.PODIUM_LOCATION_UID = LOCATION_UID;
  process.env.PODIUM_WEBHOOK_URL = WEBHOOK_URL;
  process.env.PODIUM_WEBHOOK_SECRET = "env-webhook-secret";

  fs.writeFileSync(tokenFile, JSON.stringify({
    location_id: LOCATION_ID,
    podium: {
      access_token: "podium-access-token-test",
      refresh_token: "podium-refresh-token-test",
      expires_at: Date.now() + 60 * 60 * 1000,
    },
  }));

  // The isolated test runner reads serialized reports from stdout. The app
  // logs request bodies there, which corrupts that stream.
  console.log = () => {};

  await import("../index.js");

  proxyServer = http.createServer(async (req, res) => {
    const body = await readBody(req);
    proxyLog.push({
      method: req.method,
      url: req.url,
      requestTarget: `${req.method} ${req.url} HTTP/${req.httpVersion}`,
    });
    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: appPort,
        method: req.method,
        path: req.url,
        headers: {
          ...req.headers,
          host: `127.0.0.1:${appPort}`,
        },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );
    upstream.on("error", (err) => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(err.message);
    });
    upstream.end(body);
  });
  proxyPort = await listen(proxyServer);

  const health = await send("GET", "/");
  assert.equal(health.status, 200);
});

after(() => {
  https.request = originalHttpsRequest;
  fs.rmSync(tokenFile, { force: true });
  fs.rmSync(certDir, { recursive: true, force: true });
  proxyServer?.close();
  standInServer?.close();
});

function send(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: proxyPort,
        method,
        path: urlPath,
        headers: {
          ...headers,
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": String(payload.length),
              }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, text, json });
        });
      }
    );
    req.on("error", reject);
    req.end(payload ?? undefined);
  });
}

function resetTraffic() {
  upstreamCalls.length = 0;
  proxyLog.length = 0;
}

function proxySawSecret() {
  return proxyLog.some((entry) => entry.url.includes(`secret=${SECRET}`) || entry.requestTarget.includes(SECRET));
}

function responseLeaksAction(res) {
  return res.text.includes(CONTACT_ID) || res.text.includes(SIGNING_SECRET) || res.text.includes(WEBHOOK_ID);
}

function assertRefused(res, label) {
  assert.equal(
    upstreamCalls.length,
    0,
    `${label}: upstream ran anyway. calls=${JSON.stringify(upstreamCalls)} proxy=${JSON.stringify(proxyLog)} status=${res.status} body=${res.text}`
  );
  assert.notEqual(res.status, 200, `${label}: status ${res.status} body=${res.text}`);
  assert.equal(responseLeaksAction(res), false, `${label}: response leaked the action result: ${res.text}`);
}

test("GET /test-contact with TEST_SECRET in the query does not upsert or return the contact", async () => {
  resetTraffic();
  const phone = "15550001111";
  const res = await send("GET", `/test-contact?secret=${SECRET}&phone=${phone}&name=Ada`);
  assert.equal(proxySawSecret(), true, `proxy request-target did not record the query secret: ${JSON.stringify(proxyLog)}`);
  assertRefused(res, "GET /test-contact");
});

test("GET /setup/register-webhook with TEST_SECRET in the query does not register or return the webhook", async () => {
  resetTraffic();
  const res = await send("GET", `/setup/register-webhook?secret=${SECRET}`);
  assert.equal(proxySawSecret(), true, `proxy request-target did not record the query secret: ${JSON.stringify(proxyLog)}`);
  assertRefused(res, "GET /setup/register-webhook");
});

test("POST /test-contact with TEST_SECRET only in the query does not upsert", async () => {
  resetTraffic();
  const res = await send("POST", `/test-contact?secret=${SECRET}`, {
    body: { phone: "15550002222", name: "Bea" },
  });
  assert.equal(proxySawSecret(), true, `proxy request-target did not record the query secret: ${JSON.stringify(proxyLog)}`);
  assertRefused(res, "POST /test-contact query secret");
});

test("POST /setup/register-webhook with TEST_SECRET only in the query does not register", async () => {
  resetTraffic();
  const res = await send("POST", `/setup/register-webhook?secret=${SECRET}`, {
    body: {},
  });
  assert.equal(proxySawSecret(), true, `proxy request-target did not record the query secret: ${JSON.stringify(proxyLog)}`);
  assertRefused(res, "POST /setup/register-webhook query secret");
});

test("POST /test-contact rejects a query-string secret even when x-test-secret matches", async () => {
  resetTraffic();
  const res = await send("POST", `/test-contact?secret=${SECRET}&phone=15559999999&name=Query`, {
    headers: { "x-test-secret": SECRET },
    body: { phone: "15550003333", name: "Cara" },
  });
  assert.equal(proxySawSecret(), true, `proxy request-target did not record the query secret: ${JSON.stringify(proxyLog)}`);
  assertRefused(res, "POST /test-contact query plus header");
});

test("POST /setup/register-webhook rejects a query-string secret even when the JSON body secret matches", async () => {
  resetTraffic();
  const res = await send("POST", `/setup/register-webhook?secret=${SECRET}`, {
    body: { secret: SECRET },
  });
  assert.equal(proxySawSecret(), true, `proxy request-target did not record the query secret: ${JSON.stringify(proxyLog)}`);
  assertRefused(res, "POST /setup/register-webhook query plus body");
});

test("POST /test-contact with x-test-secret upserts the body phone and name and the proxy log omits the secret", async () => {
  resetTraffic();
  const phone = "15550004444";
  const name = "Dina";
  const res = await send("POST", "/test-contact", {
    headers: { "x-test-secret": SECRET },
    body: { phone, name },
  });
  assert.equal(proxySawSecret(), false, `proxy recorded TEST_SECRET: ${JSON.stringify(proxyLog)}`);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json, {
    contact: { id: CONTACT_ID, phone, name },
  });
  assert.equal(upstreamCalls.length, 1, JSON.stringify(upstreamCalls));
  assert.equal(upstreamCalls[0].method, "POST");
  assert.equal(upstreamCalls[0].url, "/contacts/upsert");
  assert.equal(upstreamCalls[0].authorization, `Bearer ${GHL_TOKEN}`);
  assert.deepEqual(upstreamCalls[0].body, {
    locationId: LOCATION_ID,
    phone,
    name,
  });
});

test("POST /test-contact with JSON secret upserts the body contact, not the query phone", async () => {
  resetTraffic();
  const phone = "15550005555";
  const name = "Eden";
  const res = await send("POST", "/test-contact?phone=15559999999&name=QueryName", {
    body: { secret: SECRET, phone, name },
  });
  assert.equal(proxySawSecret(), false, `proxy recorded TEST_SECRET: ${JSON.stringify(proxyLog)}`);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json, {
    contact: { id: CONTACT_ID, phone, name },
  });
  assert.equal(upstreamCalls.length, 1, JSON.stringify(upstreamCalls));
  assert.deepEqual(upstreamCalls[0].body, {
    locationId: LOCATION_ID,
    phone,
    name,
  });
});

test("POST /setup/register-webhook with x-test-secret returns the upstream webhook including the signing secret", async () => {
  resetTraffic();
  const res = await send("POST", "/setup/register-webhook", {
    headers: { "x-test-secret": SECRET },
    body: {},
  });
  assert.equal(proxySawSecret(), false, `proxy recorded TEST_SECRET: ${JSON.stringify(proxyLog)}`);
  assert.equal(res.status, 200, res.text);
  assert.equal(upstreamCalls.length, 1, JSON.stringify(upstreamCalls));
  assert.equal(upstreamCalls[0].method, "POST");
  assert.equal(upstreamCalls[0].url, "/v4/webhooks");
  assert.equal(upstreamCalls[0].authorization, "Bearer podium-access-token-test");
  assert.equal(upstreamCalls[0].body.url, WEBHOOK_URL);
  assert.equal(upstreamCalls[0].body.locationUid, LOCATION_UID);
  assert.equal(upstreamCalls[0].body.secret, "env-webhook-secret");
  assert.deepEqual(upstreamCalls[0].body.eventTypes, ["message.received", "message.sent"]);
  assert.deepEqual(res.json, {
    ok: true,
    webhook: {
      id: WEBHOOK_ID,
      secret: SIGNING_SECRET,
      url: WEBHOOK_URL,
      locationUid: LOCATION_UID,
      eventTypes: ["message.received", "message.sent"],
    },
  });
});

test("POST /setup/register-webhook with JSON secret returns the upstream webhook", async () => {
  resetTraffic();
  const res = await send("POST", "/setup/register-webhook", {
    body: { secret: SECRET },
  });
  assert.equal(proxySawSecret(), false, `proxy recorded TEST_SECRET: ${JSON.stringify(proxyLog)}`);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json?.ok, true);
  assert.equal(res.json?.webhook?.secret, SIGNING_SECRET);
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].url, "/v4/webhooks");
});

test("wrong or missing x-test-secret does not upsert or register", async () => {
  resetTraffic();
  const contact = await send("POST", "/test-contact", {
    headers: { "x-test-secret": "not-the-secret" },
    body: { phone: "15550006666", name: "Fay" },
  });
  const missing = await send("POST", "/test-contact", {
    body: { phone: "15550006666", name: "Fay" },
  });
  const webhook = await send("POST", "/setup/register-webhook", {
    headers: { "x-test-secret": "not-the-secret" },
  });
  assertRefused(contact, "wrong header contact");
  assert.equal(upstreamCalls.length, 0, JSON.stringify(upstreamCalls));
  assert.notEqual(missing.status, 200, missing.text);
  assert.equal(responseLeaksAction(missing), false, missing.text);
  assert.notEqual(webhook.status, 200, webhook.text);
  assert.equal(responseLeaksAction(webhook), false, webhook.text);
  assert.equal(upstreamCalls.length, 0, JSON.stringify(upstreamCalls));
});

test("GET with x-test-secret and no query secret does not upsert or register", async () => {
  resetTraffic();
  const contact = await send("GET", "/test-contact?phone=15550007777&name=Gia", {
    headers: { "x-test-secret": SECRET },
  });
  const webhook = await send("GET", "/setup/register-webhook", {
    headers: { "x-test-secret": SECRET },
  });
  assert.equal(proxySawSecret(), false, JSON.stringify(proxyLog));
  assertRefused(contact, "GET contact with header");
  assert.notEqual(webhook.status, 200, webhook.text);
  assert.equal(responseLeaksAction(webhook), false, webhook.text);
  assert.equal(upstreamCalls.length, 0, JSON.stringify(upstreamCalls));
});
