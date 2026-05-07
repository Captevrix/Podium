// index.js
import express from "express";
import dotenv from "dotenv";
import bodyParser from "body-parser";

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
app.use(bodyParser.json());

// In-memory idempotency set for GHL webhook events.
// Stores messageId values seen in the last MAX_IDS entries to prevent
// duplicate processing when GHL retries a webhook delivery.
const MAX_IDS = 500;
const seenGhlMessageIds = new Set();

function markSeen(id) {
  seenGhlMessageIds.add(id);
  if (seenGhlMessageIds.size > MAX_IDS) {
    // Drop the oldest entry to keep memory bounded
    seenGhlMessageIds.delete(seenGhlMessageIds.values().next().value);
  }
}

/////////////////////////////////////////////////
// Home
/////////////////////////////////////////////////
app.get("/", (req, res) => {
  res.send("<h1>🚀 GHL ↔ Podium Integration Server Running</h1>");
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
    return res.send("<h2>❌ No OAuth Code received from GHL.</h2>");
  }

  try {
    const tokens = await exchangeCodeForToken(code);
    res.send(`<h2>✅ GHL Tokens Saved</h2><pre>${JSON.stringify(tokens, null, 2)}</pre>`);
  } catch (err) {
    res.status(500).send(`<h2>❌ Token Exchange Error</h2><pre>${err.message}</pre>`);
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
// Test Contact API
/////////////////////////////////////////////////
app.get("/test-contact", async (req, res) => {
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
    // Return 200 so GHL does not retry a malformed payload indefinitely
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
    console.log("   📌 Full contact:", JSON.stringify(getcontact.contact, null, 2));
  } catch (err) {
    console.log("   ❌ GHL getContactDetails FAILED");
    console.log("   Status:", err.response?.status);
    console.log("   Error:", JSON.stringify(err.response?.data || err.message, null, 2));
    // Return 200 to prevent GHL from retrying — error is logged above
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

    const result = await sendToPodium(phone, message, contactName);
    console.log("   ✅ Podium accepted the message");
    console.log("══════════════════════════════════════════\n");
    return res.sendStatus(200);
  } catch (err) {
    console.log("   ❌ Podium sendToPodium FAILED");
    console.log("   Status:", err.response?.status);
    console.log("   Error Body:", JSON.stringify(err.response?.data || err.message, null, 2));
    console.log("   Headers:", JSON.stringify(err.response?.headers || {}, null, 2));
    console.log("══════════════════════════════════════════\n");
    // Return 200 to prevent GHL from retrying and sending a duplicate message
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
