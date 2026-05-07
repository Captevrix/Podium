// services/ghl.js
import axios from "axios";
import dotenv from "dotenv";
import { saveTokens, loadTokens, saveLocationId, getLocationId } from "./../tokenStore.js";

dotenv.config();
let lastConversataionID = null;
let lastMessage = null;
let messageSentTime = null;
const TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";
const API_BASE = "https://services.leadconnectorhq.com";

let tokenCache = loadTokens();

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

  // Save tokens to file under "ghl"
  saveTokens(tokenCache);

  // Extract locationId from token response (if available)
  if (data.locationId) {
    saveLocationId(data.locationId);
  }

  return tokenCache;
}

/**
 * Refresh access token if expired
 */
async function refreshTokenIfNeeded() {
  // prefer env variable if provided (manual override)
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
  console.log("CallGHLapi Data" + JSON.stringify(data, null, 2))
  const accessToken = await refreshTokenIfNeeded();
  const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Version: "2021-07-28" };

  // const resp = await axios({
  //   url: `${API_BASE}${endpoint}`,
  //   method,
  //   headers,
  //   data,
  // });

  // return resp.data;

  //temp API

  console.log("📤 GHL Request:", JSON.stringify({
    url: `${API_BASE}${endpoint}`,
    method,
    headers,
    data
  }, null, 2));

  try {
    const resp = await axios({
      url: `${API_BASE}${endpoint}`,
      method,
      headers,
      data,
    });

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
  console.log("Location ID from Upsertcontact function " + locationId);
  if (!locationId) throw new Error("Missing locationId in token store. Ensure GHL OAuth completed.");
  const body = {
    locationId,
    phone,
    name: name || "",
  };
  return callGHLApi("/contacts/upsert", "POST", body);
}

/**
 * Send a message into GHL conversation
 */
// export async function sendMessageToGHL(contactId, message) {
//   const locationId = getLocationId();
//   console.log("Location ID from sendMessageToGHL function" + locationId);
//   const body = {
//     locationId,
//     contactId,
//     message,
//     messageType: "SMS",
//   };
//   return callGHLApi("/conversations/messages/", "POST", body);
// }

export async function sendMessageToGHL(contactId, message) {
  if (message === lastMessage && conversationid === lastConversataionID) {
    return;
  }
  const locationId = getLocationId();
  console.log("Location ID from sendMessageToGHL function " + locationId);
  const body = {
    type: "SMS",
    conversationProviderId: "6925fd0c527ff0b8f1e92b60",
    contactId,
    message,
    direction: "inbound",
    date: new Date().toISOString()
  };
  return callGHLApi("/conversations/messages/inbound", "POST", body);
}

export async function sendOutboundToGHL(contactId, message, conversationid) {
  if (message === lastMessage && conversationid === lastConversataionID) {
    return;
  }
  const locationId = getLocationId();
  console.log("Location ID from sendMessageToGHL function " + locationId);
  const body = {
    type: "SMS",
    conversationProviderId: "6925fd0c527ff0b8f1e92b60",
    contactId,
    message,
    direction: "outbound",
    date: new Date().toISOString()
  };
  return callGHLApi("/conversations/messages/inbound", "POST", body);
}

export async function getContactDetails(contactId) {
 
  return callGHLApi(`/contacts/${contactId}`, "GET");
}

export async function saveConversationMessage(conversationID, message) {
  lastConversataionID = conversationID
  lastMessage = message
  messageSentTime = Date.now();
}

  // Auto reset after 10 seconds
setInterval(() => {
  if (Date.now() - messageSentTime > 10000) {
    messageSentTime = null;
    lastMessage = null;
    lastConversataionID = null;
  }
}, 3000);
