// index.js
import express from "express";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import crypto from "crypto";

import {
  exchangeCodeForToken,
  upsertContact,
  sendMessageToGHL,
  sendOutboundToGHL,
  getContactDetails
} from "./services/ghl.js";

import {
  podiumCallback,
  sendToPodium
} from "./services/podium.js";

dotenv.config();

const app = express();

// Raw body buffer needed for Podium HMAC verification — must come before
// bodyParser.json() so we can read the raw bytes on /webhook/podium.
app.use((req, res, next) => {
  if (req.path === "/webhook/podium") {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      req.rawBody = raw;
      try { req.body = JSON.parse(raw); } catch { req.body = {}; }
      next();
    });
  } else {
    next();
  }
});

app.use(bodyParser.json());

// In-memory idempotency set for GHL webhook events.
// Stores messageId values seen in the last MAX_IDS entries to prevent
// duplicate processing when GHL retries a webhook delivery.
const MAX_IDS = 500;
const seenGhlMessageIds = new Set();

function markSeen(id) {
  seenGhlMessageIds.add(id);
  if (seenGhlMessageIds.size > MAX_IDS) {
    seenGhlMessageIds.delete(seenGhlMessageIds.values().next().value);
  }
}

/**
 * Verify Podium webhook HMAC-SHA256 signature.
 * Podium sends the signature in the x-podium-signature header as
 * "sha256=<hex>". Set PODIUM_WEBHOOK_SECRET in .env to enable.
 * If the secret is not configured the check is skipped (graceful degradation).
 */
function verifyPodiumSignature(req) {
  const secret = process.env.PODIUM_WEBHOOK_SECRET;
  if (!secret) return true;

  const header = req.headers["x-podium-signature"] || "";
  const [, receivedHex] = header.split("=");
  if (!receivedHex) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody || "")
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(receivedHex, "hex")
  );
}

/**
 * Verify GHL webhook shared secret.
 * GHL sends the secret in the x-ghl-signature or Authorization header
 * depending on workflow config. Set GHL_WEBHOOK_SECRET in .env to enable.
 * If the secret is not configured the check is skipped.
 */
function verifyGhlSignature(req) {
  const secret = process.env.GHL_WEBHOOK_SECRET;
  if (!secret) return true;

  const provided =
    req.headers["x-ghl-signature"] ||
    req.headers["x-webhook-secret"] ||
    req.headers["authorization"]?.replace("Bearer ", "") ||
    "";

  return provided === secret;
}

/////////////////////////////////////////////////
// Home
/////////////////////////////////////////////////
app.get("/", (req, res) => {
  res.send("<h1>GHL &harr; Podium Integration Server Running</h1>");
});

/////////////////////////////////////////////////
// GHL OAuth
/////////////////////////////////////////////////
app.get("/oauth/start", (req, res) => {
  const scopes = [
    "conversations.readonly",
    "conversations.write",
    "conversations/message.readonly",
    "conversations/message.write",
    "contacts.readonly",
    "contacts.write",
    "locations.readonly",
    "users.readonly"
  ].join(" ");

  const authURL = `https://marketplace.gohighlevel.com/oauth/chooselocation?response_type=code&redirect_uri=${process.env.GHL_REDIRECT_URI}&client_id=${process.env.GHL_CLIENT_ID}&scope=${scopes}`;
  res.redirect(authURL);
});

app.get("/oauth/callback", async (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    return res.send(`<h1>OAuth Error:</h1><p>${error_description}</p>`);
  }

  if (!code) {
    return res.send("<h2>No OAuth Code received from GHL.</h2>");
  }

  try {
    const tokens = await exchangeCodeForToken(code);
    res.send(`<h2>GHL Tokens Saved</h2><pre>${JSON.stringify(tokens, null, 2)}</pre>`);
  } catch (err) {
    res.status(500).send(`<h2>Token Exchange Error</h2><pre>${err.message}</pre>`);
  }
});

/////////////////////////////////////////////////
// Podium OAuth
/////////////////////////////////////////////////
app.get("/oauth/podium/start", (req, res) => {
  const scopes = [
    "read_messages",
    "write_messages",
    "read_contacts",
    "write_contacts"
  ].join(" ");

  const authURL = `https://api.podium.com/oauth/authorize?client_id=${process.env.PODIUM_CLIENT_ID}&redirect_uri=${process.env.PODIUM_REDIRECT_URI}&response_type=code&scope=${encodeURIComponent(scopes)}`;
  res.redirect(authURL);
});

app.get("/oauth/podium/callback", podiumCallback);

/////////////////////////////////////////////////
// Test Contact API — protected by TEST_SECRET in production
/////////////////////////////////////////////////
app.get("/test-contact", async (req, res) => {
  const secret = process.env.TEST_SECRET;
  if (secret && req.query.secret !== secret) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const { phone, name } = req.query;
    const contact = await upsertContact(phone, name);
    res.json(contact);
  } catch (err) {
    res.status(500).send(err.response?.data || err.message);
  }
});

/////////////////////////////////////////////////
// Podium → GHL Webhook
/////////////////////////////////////////////////
app.post("/webhook/podium", async (req, res) => {
  // Verify Podium HMAC signature before processing
  if (!verifyPodiumSignature(req)) {
    console.warn("⚠️ [Podium] Invalid signature — rejecting request.");
    return res.sendStatus(401);
  }

  try {
    console.log("📩 Podium Webhook Received:", req.body);

    const payload = req.body;
    const data = payload.data || payload;

    const eventType = payload?.metadata?.eventType || null;

    const phoneNumber = data?.conversation?.channel?.identifier;
    const message = data?.body;
    const name = data?.contactName || data?.contact?.name || "Podium User";

    if (!phoneNumber || !message) {
      console.log("⚠️ Missing phone/message — ignoring.");
      return res.sendStatus(200);
    }

    const contact = await upsertContact(phoneNumber, name);
    console.log("eventType " + eventType);
    const isOutbound = eventType === "message.sent";
    const isInbound  = eventType === "message.received";

    console.log("Is Inbound? " + isInbound);
    console.log("Is Outbound? " + isOutbound);

    if (isInbound) {
      console.log("📥 INBOUND from Podium → GHL");
      await sendMessageToGHL(contact.contact.id, message, data.conversation.uid);
    }

    if (isOutbound) {
      console.log("📤 OUTBOUND from Podium → GHL");
      await sendOutboundToGHL(contact.contact.id, message, data.conversation.uid);
    }

    if (!isInbound && !isOutbound) {
      console.log("ℹ️ Unrecognised eventType — no action taken.");
    }

    console.log("✅ Message forwarded to GHL.");
    return res.sendStatus(200);

  } catch (err) {
    console.error("❌ Podium Webhook Error:", err.message);
    return res.sendStatus(200);
  }
});

/////////////////////////////////////////////////
// GHL → Podium Webhook
/////////////////////////////////////////////////
app.post("/webhook/ghl", async (req, res) => {
  // Verify GHL shared secret before processing
  if (!verifyGhlSignature(req)) {
    console.warn("⚠️ [GHL] Invalid signature — rejecting request.");
    return res.sendStatus(401);
  }

  console.log("\n══════════════════════════════════════════");
  console.log("📩 [GHL→Podium] Webhook received at", new Date().toISOString());
  console.log("══════════════════════════════════════════");
  console.log("📦 Raw Body:", JSON.stringify(req.body, null, 2));

  const { phone, message, contactId, messageId } = req.body;

  // Idempotency check — GHL retries deliver the same messageId; ignore replays.
  if (messageId && seenGhlMessageIds.has(messageId)) {
    console.log(`⚠️ [GHL→Podium] Duplicate messageId=${messageId} — ignoring replay.`);
    return res.sendStatus(200);
  }

  console.log("🔍 Extracted Fields:");
  console.log("   phone     →", phone || "⚠️ MISSING");
  console.log("   message   →", message || "⚠️ MISSING");
  console.log("   contactId →", contactId || "⚠️ MISSING");
  console.log("   messageId →", messageId || "⚠️ MISSING");

  if (!phone || !message || !contactId) {
    const missing = [];
    if (!phone) missing.push("phone");
    if (!message) missing.push("message");
    if (!contactId) missing.push("contactId");
    console.log(`❌ [GHL→Podium] REJECTED — Missing fields: ${missing.join(", ")}`);
    return res.status(200).json({
      error: "Missing required fields",
      missing,
      received: req.body
    });
  }

  // Mark as seen before processing so a concurrent retry is also dropped
  if (messageId) markSeen(messageId);

  // ── Step 1: Get contact details from GHL ──
  let getcontact;
  try {
    console.log("\n── Step 1: Fetching contact from GHL ──");
    console.log("   contactId:", contactId);
    getcontact = await getContactDetails(contactId);
    console.log("   ✅ Contact found:", getcontact.contact?.firstName, getcontact.contact?.lastName);
  } catch (err) {
    console.log("   ❌ GHL getContactDetails FAILED");
    console.log("   Status:", err.response?.status);
    console.log("   Error:", JSON.stringify(err.response?.data || err.message, null, 2));
    return res.status(200).json({
      error: "Failed to fetch contact from GHL",
      step: "getContactDetails",
      contactId,
      status: err.response?.status,
      details: err.response?.data || err.message
    });
  }

  // ── Step 2: Send message to Podium ──
  try {
    const contactName = `${getcontact.contact.firstName || ""} ${getcontact.contact.lastName || ""}`.trim();
    console.log("\n── Step 2: Sending message to Podium ──");
    console.log("   phone:", phone);
    console.log("   message:", message);
    console.log("   contactName:", contactName);

    await sendToPodium(phone, message, contactName);
    console.log("   ✅ Podium accepted the message");
    console.log("══════════════════════════════════════════\n");
    return res.sendStatus(200);
  } catch (err) {
    console.log("   ❌ Podium sendToPodium FAILED");
    console.log("   Status:", err.response?.status);
    console.log("   Error Body:", JSON.stringify(err.response?.data || err.message, null, 2));
    console.log("══════════════════════════════════════════\n");
    return res.status(200).json({
      error: "Failed to send message to Podium",
      step: "sendToPodium",
      phone,
      status: err.response?.status,
      details: err.response?.data || err.message
    });
  }
});

/////////////////////////////////////////////////
// Start Server
/////////////////////////////////////////////////
app.listen(process.env.PORT || 3000, () => {
  console.log(`✅ Server running on port ${process.env.PORT || 3000}`);
});
