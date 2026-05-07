// services/podium.js
import axios from "axios";
import dotenv from "dotenv";
import { savePodiumTokens, loadPodiumTokens } from "./../tokenStore.js";

dotenv.config();

const PODIUM_API_BASE = "https://api.podium.com/v4";
const TOKEN_URL = "https://api.podium.com/oauth/token";

let tokenCache = loadPodiumTokens();

/**
 * Refresh Podium access token if expired
 */
async function refreshPodiumTokenIfNeeded() {
  if (!tokenCache.access_token || Date.now() >= (tokenCache.expires_at || 0)) {
    if (!tokenCache.refresh_token) throw new Error("No Podium refresh token available");

    const { data } = await axios.post(TOKEN_URL, new URLSearchParams({
      client_id: process.env.PODIUM_CLIENT_ID,
      client_secret: process.env.PODIUM_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: tokenCache.refresh_token,
      redirect_uri: process.env.PODIUM_REDIRECT_URI,
    }), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    tokenCache = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || tokenCache.refresh_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    };

    savePodiumTokens(tokenCache);
  }

  return tokenCache.access_token;
}

/**
 * Handle Podium OAuth callback — exchange code for tokens and store them.
 * Bound to GET /oauth/podium/callback in index.js.
 */
export async function podiumCallback(req, res) {
  const { code, error, error_description } = req.query;

  if (error) {
    return res.send(`<h1>Podium OAuth Error:</h1><p>${error_description}</p>`);
  }

  if (!code) {
    return res.send("<h2>No OAuth code received from Podium.</h2>");
  }

  try {
    const { data } = await axios.post(TOKEN_URL, new URLSearchParams({
      client_id: process.env.PODIUM_CLIENT_ID,
      client_secret: process.env.PODIUM_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.PODIUM_REDIRECT_URI,
    }), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    tokenCache = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    };

    savePodiumTokens(tokenCache);
    res.send(`<h2>Podium Tokens Saved</h2>`);
  } catch (err) {
    console.error("Podium OAuth error:", err.response?.data || err.message);
    res.status(500).send(`<h2>Podium Token Exchange Error</h2><pre>${err.message}</pre>`);
  }
}

/**
 * Send an outbound SMS via Podium (Osender).
 *
 * Called from index.js when GHL fires a /webhook/ghl event and we need to
 * deliver the agent's reply back to the customer through Podium.
 *
 * @param {string} phone       - Customer phone number (E.164 or local format)
 * @param {string} message     - Message text to send
 * @param {string} contactName - Customer display name (used for contact lookup/creation)
 */
export async function sendToPodium(phone, message, contactName) {
  const accessToken = await refreshPodiumTokenIfNeeded();

  // Log without token
  console.log("📤 Podium Request: sendToPodium", { phone, contactName, messageLength: message?.length });

  // Podium messages are sent via the messages endpoint.
  // The orgUid is required — set PODIUM_ORG_UID in .env from your Podium account.
  const orgUid = process.env.PODIUM_ORG_UID;
  if (!orgUid) throw new Error("Missing PODIUM_ORG_UID env var");

  const body = {
    type: "TEXT",
    body: message,
    // Podium needs either a locationUid or an existing conversation uid.
    // Set PODIUM_LOCATION_UID in .env to your Podium location/inbox uid.
    locationUid: process.env.PODIUM_LOCATION_UID,
    customer: {
      name: contactName || "",
      phoneNumber: phone,
    },
  };

  try {
    const resp = await axios.post(
      `${PODIUM_API_BASE}/messages`,
      body,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("✅ Podium message sent:", resp.data?.uid || resp.status);
    return resp.data;
  } catch (err) {
    console.error("❌ Podium sendToPodium error:", err.response?.data || err.message);
    throw err;
  }
}
