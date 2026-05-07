// tokenStore.js
import fs from "fs";
import path from "path";

const tokenFile = path.join(process.cwd(), "tokens.json");

// internal read/write
function _read() {
  try {
    if (!fs.existsSync(tokenFile)) return {};
    const raw = fs.readFileSync(tokenFile, "utf8");
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error("tokenStore read error", e);
    return {};
  }
}

function _write(obj) {
  try {
    fs.writeFileSync(tokenFile, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("tokenStore write error", e);
  }
}

// Public API
export function saveTokens(tokens) {
  const all = _read();
  all.ghl = { ...(all.ghl || {}), ...tokens };
  _write(all);
}

export function loadTokens() {
  const all = _read();
  return all.ghl || {};
}

export function saveLocationId(locationId) {
  const all = _read();
  all.location_id = locationId;
  _write(all);
}

export function getLocationId() {
  const all = _read();
  return all.location_id || null;
}

// Podium token helpers
export function savePodiumTokens(tokens) {
  const all = _read();
  all.podium = { ...(all.podium || {}), ...tokens };
  _write(all);
}

export function loadPodiumTokens() {
  const all = _read();
  return all.podium || {};
}

export function getAllTokens() {
  return _read();
}
