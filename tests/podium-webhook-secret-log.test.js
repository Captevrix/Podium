/**
 * Spec for the Podium webhook signing-secret log leak.
 *
 * These tests fail while registerPodiumWebhook writes the signing secret
 * or the raw provider response to stdout/stderr. They pass once those
 * values are no longer written to the process logs.
 *
 * The outbound Podium and GoHighLevel calls are stopped inside the axios
 * instance this process loads (axios@1.13.2). The adapter records the
 * request the application built and returns a fixture response. It does
 * not reimplement registration or signature checks.
 *
 * Run:
 *   node --test --test-force-exit tests/podium-webhook-secret-log.test.js
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import axios from "axios";

const SIGNING_SECRET = "whsec_7f3c9a1e4b2d48a0b6c1e9d0f5a4b3c2";
const PROVIDER_MARKER = "provider-response-marker-55cc44dd";
const OPERATOR_SECRET = "operator-gate";
const PORT = 18765;
const WEBHOOK_URL = "https://app.example.test/webhook/podium";
const LOCATION_UID = "loc_podium_test";
const tokenFile = path.join(process.cwd(), "tokens.json");

const calls = [];
let podiumMode = "ok";

axios.defaults.adapter = async function podiumTestAdapter(config) {
  const url = String(config.url || "");
  calls.push({
    url,
    method: String(config.method || "").toLowerCase(),
    data: config.data,
  });

  if (url === "https://api.podium.com/v4/webhooks") {
    if (podiumMode === "error") {
      throw new axios.AxiosError(
        "webhook create failed",
        "ERR_BAD_REQUEST",
        config,
        null,
        {
          status: 422,
          statusText: "Unprocessable Entity",
          headers: {},
          config,
          data: {
            secret: SIGNING_SECRET,
            marker: PROVIDER_MARKER,
            message: "rejected",
          },
        }
      );
    }

    return {
      status: 200,
      statusText: "OK",
      headers: {},
      config,
      data: {
        uid: "wh_test_uid",
        secret: SIGNING_SECRET,
        marker: PROVIDER_MARKER,
        url: WEBHOOK_URL,
        eventTypes: ["message.received", "message.sent"],
      },
    };
  }

  if (url === "https://services.leadconnectorhq.com/contacts/upsert") {
    return {
      status: 200,
      statusText: "OK",
      headers: {},
      config,
      data: { contact: { id: "contact-1" } },
    };
  }

  if (url === "https://services.leadconnectorhq.com/conversations/messages/inbound") {
    return {
      status: 200,
      statusText: "OK",
      headers: {},
      config,
      data: { success: true },
    };
  }

  throw new Error(`unexpected outbound request ${config.method} ${url}`);
};

function requestBody(data) {
  if (typeof data === "string") return JSON.parse(data);
  return data;
}

function httpRequest({ method, path: requestPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: PORT,
        path: requestPath,
        method,
        headers: {
          ...headers,
          ...(body === undefined
            ? {}
            : { "content-length": Buffer.byteLength(body) }),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const res = await httpRequest({ method: "GET", path: "/" });
      if (res.status === 200) return;
    } catch {
      // Server is still binding the port.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("server did not start");
}

async function capture(fn) {
  const chunks = [];
  const wrap = (stream) => {
    const original = stream.write;
    stream.write = function write(chunk, ...rest) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      return original.call(stream, chunk, ...rest);
    };
    return () => {
      stream.write = original;
    };
  };
  const restore = [wrap(process.stdout), wrap(process.stderr)];
  try {
    try {
      const result = await fn();
      return { result, error: null, logs: chunks.join("") };
    } catch (error) {
      return { result: null, error, logs: chunks.join("") };
    }
  } finally {
    for (const restoreStream of restore) restoreStream();
  }
}

function assertLogsHideSecrets(logs) {
  assert.equal(
    logs.includes(SIGNING_SECRET),
    false,
    "process logs include the webhook signing secret"
  );
  assert.equal(
    logs.includes(PROVIDER_MARKER),
    false,
    "process logs include the raw webhook provider response"
  );
}

function sign(rawBody, secret) {
  const hex = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return `sha256=${hex}`;
}

function podiumEvent(eventType, message) {
  return JSON.stringify({
    metadata: { eventType },
    data: {
      body: message,
      contactName: "Injected Contact",
      conversation: {
        uid: `conv-${eventType}`,
        channel: { identifier: "+15555550199" },
      },
    },
  });
}

async function postPodium(rawBody, secret) {
  const headers = { "content-type": "application/json" };
  if (secret !== null) {
    headers["x-podium-signature"] = sign(rawBody, secret);
  }
  return httpRequest({
    method: "POST",
    path: "/webhook/podium",
    headers,
    body: rawBody,
  });
}

function ghlMessages() {
  return calls
    .filter((call) => call.url.endsWith("/conversations/messages/inbound"))
    .map((call) => requestBody(call.data));
}

let registerPodiumWebhook;

before(async () => {
  fs.writeFileSync(
    tokenFile,
    JSON.stringify({
      location_id: "ghl-location-1",
      podium: {
        access_token: "podium-access-test",
        refresh_token: "podium-refresh-test",
        expires_at: Date.now() + 60 * 60 * 1000,
      },
      ghl: {
        access_token: "ghl-access-test",
        refresh_token: "ghl-refresh-test",
        expires_at: Date.now() + 60 * 60 * 1000,
      },
    })
  );

  process.env.PORT = String(PORT);
  process.env.PODIUM_WEBHOOK_SECRET = SIGNING_SECRET;
  process.env.PODIUM_WEBHOOK_URL = WEBHOOK_URL;
  process.env.PODIUM_LOCATION_UID = LOCATION_UID;
  process.env.PODIUM_CLIENT_ID = "podium-client";
  process.env.PODIUM_CLIENT_SECRET = "podium-client-secret";
  process.env.PODIUM_REDIRECT_URI = "http://127.0.0.1/oauth/podium/callback";
  process.env.TEST_SECRET = OPERATOR_SECRET;
  process.env.GHL_ACCESS_TOKEN = "ghl-access-test";
  process.env.GHL_CLIENT_ID = "ghl-client";
  process.env.GHL_CLIENT_SECRET = "ghl-client-secret";

  await import("../index.js");
  ({ registerPodiumWebhook } = await import("../services/podium.js"));
  await waitForServer();
});

after(() => {
  fs.rmSync(tokenFile, { force: true });
});

test("operator webhook registration does not log the signing secret or provider response", async () => {
  calls.length = 0;
  podiumMode = "ok";

  const captured = await capture(() =>
    httpRequest({
      method: "GET",
      path: `/setup/register-webhook?secret=${encodeURIComponent(OPERATOR_SECRET)}`,
    })
  );

  assert.equal(captured.error, null);
  assert.equal(captured.result.status, 200);

  const registration = calls.find((call) => call.url === "https://api.podium.com/v4/webhooks");
  assert.ok(registration, "registration did not call the Podium webhook create endpoint");
  const sent = requestBody(registration.data);
  assert.equal(sent.secret, SIGNING_SECRET);
  assert.equal(sent.url, WEBHOOK_URL);
  assert.deepEqual(sent.eventTypes, ["message.received", "message.sent"]);
  assert.equal(sent.locationUid, LOCATION_UID);

  const inboundBody = podiumEvent("message.received", "forged inbound message");
  const outboundBody = podiumEvent("message.sent", "forged outbound message");
  const beforeGhl = ghlMessages().length;

  const inbound = await postPodium(inboundBody, SIGNING_SECRET);
  const outbound = await postPodium(outboundBody, SIGNING_SECRET);
  const wrongSecret = await postPodium(inboundBody, "wrong-secret-not-the-real-one");
  const missingSignature = await postPodium(
    podiumEvent("message.received", "unsigned message"),
    null
  );

  assert.equal(inbound.status, 200);
  assert.equal(outbound.status, 200);
  assert.equal(wrongSecret.status, 401);
  assert.equal(missingSignature.status, 401);

  const forwarded = ghlMessages().slice(beforeGhl);
  assert.deepEqual(
    forwarded.map((message) => ({ direction: message.direction, message: message.message })),
    [
      { direction: "inbound", message: "forged inbound message" },
      { direction: "outbound", message: "forged outbound message" },
    ]
  );
  assert.equal(ghlMessages().length, beforeGhl + 2);

  assertLogsHideSecrets(captured.logs);
});

test("failed webhook registration does not log the signing secret or provider error body", async () => {
  calls.length = 0;
  podiumMode = "error";

  const captured = await capture(() =>
    httpRequest({
      method: "GET",
      path: `/setup/register-webhook?secret=${encodeURIComponent(OPERATOR_SECRET)}`,
    })
  );

  assert.equal(captured.error, null);
  assert.equal(captured.result.status, 500);

  const registration = calls.find((call) => call.url === "https://api.podium.com/v4/webhooks");
  assert.ok(registration, "registration did not call the Podium webhook create endpoint");
  assert.equal(requestBody(registration.data).secret, SIGNING_SECRET);

  assertLogsHideSecrets(captured.logs);
});

test("registerPodiumWebhook does not log the signing secret or provider response", async () => {
  calls.length = 0;
  podiumMode = "ok";

  const captured = await capture(() => registerPodiumWebhook());

  assert.equal(captured.error, null);
  assert.equal(captured.result?.uid, "wh_test_uid");

  const registration = calls.find((call) => call.url === "https://api.podium.com/v4/webhooks");
  assert.ok(registration, "registerPodiumWebhook did not call the Podium webhook create endpoint");
  assert.equal(requestBody(registration.data).secret, SIGNING_SECRET);

  assertLogsHideSecrets(captured.logs);
});

test("registerPodiumWebhook failure does not log the signing secret or provider error body", async () => {
  calls.length = 0;
  podiumMode = "error";

  const captured = await capture(() => registerPodiumWebhook());

  assert.ok(captured.error, "expected webhook registration to fail");
  assert.equal(captured.error.response?.data?.marker, PROVIDER_MARKER);
  assert.equal(requestBody(calls.at(-1).data).secret, SIGNING_SECRET);

  assertLogsHideSecrets(captured.logs);
});
