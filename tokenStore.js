// tokenStore.js
import fs from "fs";
import path from "path";

const tokenFile = path.join(process.cwd(), "tokens.json");

// In-memory cache for locationId — never changes after OAuth, no reason to
// re-read the file on every single API call.
let _locationIdCache = null;

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

/**
 * Migrate any orphaned top-level token keys (legacy structure) into the `ghl`
 * sub-key so the file layout stays canonical after a re-auth.
 */
function _migrate(all) {
  const orphanKeys = ["access_token", "refresh_token", "expires_at"];
  const hasOrphans = orphanKeys.some((k) => Object.prototype.hasOwnProperty.call(all, k));
  if (!hasOrphans) return all;

  const migrated = { ...all };
  const ghl = { ...(migrated.ghl || {}) };
  for (const k of orphanKeys) {
    if (migrated[k] !== undefined && !ghl[k]) ghl[k] = migrated[k];
    delete migrated[k];
  }
  migrated.ghl = ghl;
  return migrated;
}

// Public API

export function saveTokens(tokens) {
  let all = _read();
  all = _migrate(all);
  all.ghl = { ...(all.ghl || {}), ...tokens };
  _write(all);
}

export function loadTokens() {
  const all = _migrate(_read());
  return all.ghl || {};
}

export function saveLocationId(locationId) {
  const all = _migrate(_read());
  all.location_id = locationId;
  _write(all);
  _locationIdCache = locationId;
}

export function getLocationId() {
  if (_locationIdCache !== null) return _locationIdCache;
  const all = _read();
  _locationIdCache = all.location_id || null;
  return _locationIdCache;
}

// Podium token helpers
export function savePodiumTokens(tokens) {
  const all = _migrate(_read());
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
