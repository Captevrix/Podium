// services/ghl.js
import axios from "axios";
import dotenv from "dotenv";
import { saveTokens, loadTokens, saveLocationId, getLocationId } from "./../tokenStore.js";

dotenv.config();

const TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";
const API_BASE = "https://services.leadconnectorhq.com";

let tokenCache = loadTokens();

// Dedup store: Map<conversationId, { message, sentAt }>
// Keyed per conversation so concurrent conversations don't clobber each other.
const dedupMap = new Map();
const DEDUP_TTL_MS = 10_000;

function isDuplicate(conversationId, message) {
  const entry = dedupMap.get(conversationId);
  if (!entry) return false;
  if (Date.now() - entry.sentAt > DEDUP_TTL_MS) {
    dedupMap.delete(conversationId);
    return false;
  }
  return entry.message === message;
}

function recordSent(conversationId, message) {
  dedupMap.set(conversationId, { message, sentAt: Date.now() });
}

// Periodically purge expired dedup entries to avoid memory growth
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of dedupMap) {
    if (now - entry.sentAt > DEDUP_TTL_MS) dedupMap.delete(id);
  }
}, 5_000);

/**
 * Exchange OAuth "code" for access + refresh token
 */
export async function exchangeCodeForToken(code) {
  const params = new URLSearchParams();
  params.append("client_id", process.env.GHL_CLIENT_ID);
  params.append("client_secret", process.env.GHL_CLIENT_SECRET);
  params.append("grant_type", "authorization_code");
  params.append("code", code);
  params.append("redirect_uri", process.env.GHL_REDIRECT_URI);
  params.append("user_type", "Location");

  const { data } = await axios.post(TOKEN_URL, params, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  tokenCache = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };

  saveTokens(tokenCache);

  if (data.locationId) {
    saveLocationId(data.locationId);
  }

  return tokenCache;
}

/**
 * Refresh access token if expired
 */
async function refreshTokenIfNeeded() {
  if (process.env.GHL_ACCESS_TOKEN) return process.env.GHL_ACCESS_TOKEN;

  if (!tokenCache.access_token || Date.now() >= (tokenCache.expires_at || 0)) {
    if (!tokenCache.refresh_token) throw new Error("No refresh token available for GHL");

    const params = new URLSearchParams();
    params.append("client_id", process.env.GHL_CLIENT_ID);
    params.append("client_secret", process.env.GHL_CLIENT_SECRET);
    params.append("grant_type", "refresh_token");
    params.append("refresh_token", tokenCache.refresh_token);
    params.append("user_type", "Location");

    const { data } = await axios.post(TOKEN_URL, params, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    tokenCache = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || tokenCache.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };

    saveTokens(tokenCache);
  }

  return tokenCache.access_token;
}

/**
 * Generic GHL API caller
 */
export async function callGHLApi(endpoint, method = "GET", data = {}) {
  const accessToken = await refreshTokenIfNeeded();
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Version: "2021-07-28"
  };

  // Log request details without exposing the bearer token
  console.log("📤 GHL Request:", JSON.stringify({
    url: `${API_BASE}${endpoint}`,
    method,
    data
  }, null, 2));

  try {
    const resp = await axios({ url: `${API_BASE}${endpoint}`, method, headers, data });
    return resp.data;
  } catch (err) {
    console.log("❌ GHL Error:", err.response?.data || err.message);
    throw err;
  }
}

/**
 * Upsert contact by phone and optional name
 */
export async function upsertContact(phone, name = "") {
  const locationId = getLocationId();
  if (!locationId) throw new Error("Missing locationId in token store. Ensure GHL OAuth completed.");
  const body = { locationId, phone, name: name || "" };
  return callGHLApi("/contacts/upsert", "POST", body);
}

/**
 * Log an inbound SMS into a GHL conversation (message received from customer).
 *
 * GHL Conversation Provider API uses /conversations/messages/inbound for ALL
 * provider-sourced messages. The `direction` field ("inbound"/"outbound") tells
 * GHL which way the message flowed — it does not change the endpoint.
 */
export async function sendMessageToGHL(contactId, message, conversationId) {
  if (isDuplicate(conversationId, message)) {
    console.log("⚠️ Duplicate inbound message detected — skipping.");
    return;
  }
  const body = {
    type: "SMS",
    conversationProviderId: "6925fd0c527ff0b8f1e92b60",
    contactId,
    message,
    direction: "inbound",
    date: new Date().toISOString()
  };
  const result = await callGHLApi("/conversations/messages/inbound", "POST", body);
  recordSent(conversationId, message);
  return result;
}

/**
 * Log an outbound SMS into a GHL conversation (message sent from GHL/agent).
 *
 * Same /inbound endpoint as above — GHL provider API design uses this endpoint
 * for both directions; direction is communicated via the `direction` field.
 */
export async function sendOutboundToGHL(contactId, message, conversationId) {
  if (isDuplicate(conversationId, message)) {
    console.log("⚠️ Duplicate outbound message detected — skipping.");
    return;
  }
  const body = {
    type: "SMS",
    conversationProviderId: "6925fd0c527ff0b8f1e92b60",
    contactId,
    message,
    direction: "outbound",
    date: new Date().toISOString()
  };
  const result = await callGHLApi("/conversations/messages/inbound", "POST", body);
  recordSent(conversationId, message);
  return result;
}

export async function getContactDetails(contactId) {
  return callGHLApi(`/contacts/${contactId}`, "GET");
}
