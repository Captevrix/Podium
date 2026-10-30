/**
 * Spec for tokens.json permissions.
 *
 * These tests fail while tokenStore.js writes tokens with fs.writeFileSync
 * and no owner-only mode. They pass once every write below leaves the bearer
 * tokens unreadable by other local users, including when tokens.json already
 * exists mode 0644:
 *
 *   saveTokens, savePodiumTokens, saveLocationId
 *
 * Run:
 *   node --test tests/token-file-permissions.test.js
 *
 * The GoHighLevel and Podium HTTP exchanges are not called. Those handlers
 * persist tokens only through the three functions above.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const testFile = fileURLToPath(import.meta.url);

if (process.env.TOKEN_STORE_CHILD === "1") {
  process.umask(Number(process.env.TOKEN_STORE_UMASK));
  const { saveTokens, savePodiumTokens, saveLocationId } = await import(
    "../tokenStore.js"
  );
  const steps = JSON.parse(process.env.TOKEN_STORE_PAYLOAD);
  for (const step of steps) {
    if (step.op === "saveTokens") saveTokens(step.tokens);
    else if (step.op === "savePodiumTokens") savePodiumTokens(step.tokens);
    else if (step.op === "saveLocationId") saveLocationId(step.locationId);
    else throw new Error(`unknown op ${step.op}`);
  }
} else {
  const GHL_ACCESS = "ghl-access-token-value";
  const GHL_REFRESH = "ghl-refresh-token-value";
  const GHL_ACCESS_REFRESHED = "ghl-access-token-refreshed";
  const GHL_REFRESH_REFRESHED = "ghl-refresh-token-refreshed";
  const PODIUM_ACCESS = "podium-access-token-value";
  const PODIUM_REFRESH = "podium-refresh-token-value";
  const PODIUM_ACCESS_REFRESHED = "podium-access-token-refreshed";
  const LOCATION_ID = "location-id-value";

  function makeTraversableDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-mode-"));
    // mkdtemp is 0700. The attack needs a directory other users can traverse,
    // which is the usual mode for an application working directory.
    fs.chmodSync(dir, 0o755);
    return dir;
  }

  function writeTokens(cwd, umask, steps) {
    const result = spawnSync(process.execPath, [testFile], {
      cwd,
      env: {
        ...process.env,
        TOKEN_STORE_CHILD: "1",
        TOKEN_STORE_UMASK: String(umask),
        TOKEN_STORE_PAYLOAD: JSON.stringify(steps),
      },
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      0,
      `token writer failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }

  function seedWorldReadable(dir, obj) {
    const file = path.join(dir, "tokens.json");
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
    fs.chmodSync(file, 0o644);
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  }

  function assertOthersCannotRead(dir, secrets) {
    const file = path.join(dir, "tokens.json");
    const ownerText = fs.readFileSync(file, "utf8");
    for (const secret of secrets) {
      assert.ok(
        ownerText.includes(secret),
        `service account file is missing ${secret}`
      );
    }

    const reads = [];
    for (const name of fs.readdirSync(dir)) {
      const entry = path.join(dir, name);
      const st = fs.lstatSync(entry);
      if (!st.isFile()) continue;
      const mode = st.mode & 0o777;
      const other = spawnSync(
        "sudo",
        ["-n", "-u", "nobody", "--", "cat", "--", entry],
        { encoding: "utf8" }
      );
      reads.push({
        name,
        mode,
        status: other.status,
        stdout: other.stdout,
        stderr: other.stderr,
        error: other.error,
      });
    }

    assert.ok(reads.length > 0, "tokens.json was not created");

    for (const secret of secrets) {
      for (const read of reads) {
        const leaked = read.status === 0 && read.stdout.includes(secret);
        assert.equal(
          leaked,
          false,
          `user nobody read ${secret} from ${read.name} (mode ${read.mode.toString(8)}):\n${read.stdout}`
        );
      }
    }

    for (const read of reads) {
      assert.equal(
        read.mode & 0o077,
        0,
        `${read.name} mode ${read.mode.toString(8)} is readable by group or other`
      );
      assert.equal(
        read.mode & 0o600,
        0o600,
        `${read.name} mode ${read.mode.toString(8)} is not owner read/write`
      );
      assert.equal(read.error, undefined, `sudo failed: ${read.error}`);
      assert.notEqual(
        read.status,
        0,
        `user nobody read ${read.name} (mode ${read.mode.toString(8)})`
      );
      assert.match(read.stderr || "", /Permission denied/);
    }
  }

  function withDir(fn) {
    const dir = makeTraversableDir();
    try {
      fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test("saveTokens creates tokens.json other local users cannot read", () => {
    withDir((dir) => {
      writeTokens(dir, 0o022, [
        {
          op: "saveTokens",
          tokens: {
            access_token: GHL_ACCESS,
            refresh_token: GHL_REFRESH,
            expires_at: 1,
          },
        },
      ]);
      assertOthersCannotRead(dir, [GHL_ACCESS, GHL_REFRESH]);
    });
  });

  test("saveTokens stays owner-only when the process umask is 000", () => {
    withDir((dir) => {
      writeTokens(dir, 0o000, [
        {
          op: "saveTokens",
          tokens: {
            access_token: GHL_ACCESS,
            refresh_token: GHL_REFRESH,
            expires_at: 1,
          },
        },
      ]);
      assertOthersCannotRead(dir, [GHL_ACCESS, GHL_REFRESH]);
    });
  });

  test("savePodiumTokens creates tokens.json other local users cannot read", () => {
    withDir((dir) => {
      writeTokens(dir, 0o022, [
        {
          op: "savePodiumTokens",
          tokens: {
            access_token: PODIUM_ACCESS,
            refresh_token: PODIUM_REFRESH,
            expires_at: 1,
          },
        },
      ]);
      assertOthersCannotRead(dir, [PODIUM_ACCESS, PODIUM_REFRESH]);
    });
  });

  test("saveTokens then saveLocationId keeps GHL bearer tokens unreadable", () => {
    withDir((dir) => {
      writeTokens(dir, 0o022, [
        {
          op: "saveTokens",
          tokens: {
            access_token: GHL_ACCESS,
            refresh_token: GHL_REFRESH,
            expires_at: 1,
          },
        },
        { op: "saveLocationId", locationId: LOCATION_ID },
      ]);
      assertOthersCannotRead(dir, [GHL_ACCESS, GHL_REFRESH, LOCATION_ID]);
    });
  });

  test("a later saveTokens refresh keeps the new bearer token unreadable", () => {
    withDir((dir) => {
      writeTokens(dir, 0o022, [
        {
          op: "saveTokens",
          tokens: {
            access_token: GHL_ACCESS,
            refresh_token: GHL_REFRESH,
            expires_at: 1,
          },
        },
        {
          op: "saveTokens",
          tokens: {
            access_token: GHL_ACCESS_REFRESHED,
            refresh_token: GHL_REFRESH_REFRESHED,
            expires_at: 2,
          },
        },
      ]);
      const stored = JSON.parse(
        fs.readFileSync(path.join(dir, "tokens.json"), "utf8")
      );
      assert.equal(stored.ghl.access_token, GHL_ACCESS_REFRESHED);
      assert.equal(stored.ghl.refresh_token, GHL_REFRESH_REFRESHED);
      assertOthersCannotRead(dir, [
        GHL_ACCESS_REFRESHED,
        GHL_REFRESH_REFRESHED,
      ]);
    });
  });

  test("a later savePodiumTokens refresh keeps the new bearer token unreadable", () => {
    withDir((dir) => {
      writeTokens(dir, 0o022, [
        {
          op: "savePodiumTokens",
          tokens: {
            access_token: PODIUM_ACCESS,
            refresh_token: PODIUM_REFRESH,
            expires_at: 1,
          },
        },
        {
          op: "savePodiumTokens",
          tokens: {
            access_token: PODIUM_ACCESS_REFRESHED,
            refresh_token: PODIUM_REFRESH,
            expires_at: 2,
          },
        },
      ]);
      const stored = JSON.parse(
        fs.readFileSync(path.join(dir, "tokens.json"), "utf8")
      );
      assert.equal(stored.podium.access_token, PODIUM_ACCESS_REFRESHED);
      assertOthersCannotRead(dir, [PODIUM_ACCESS_REFRESHED, PODIUM_REFRESH]);
    });
  });

  test("saving both accounts leaves every bearer token unreadable", () => {
    withDir((dir) => {
      writeTokens(dir, 0o022, [
        {
          op: "saveTokens",
          tokens: {
            access_token: GHL_ACCESS,
            refresh_token: GHL_REFRESH,
            expires_at: 1,
          },
        },
        { op: "saveLocationId", locationId: LOCATION_ID },
        {
          op: "savePodiumTokens",
          tokens: {
            access_token: PODIUM_ACCESS,
            refresh_token: PODIUM_REFRESH,
            expires_at: 1,
          },
        },
      ]);
      assertOthersCannotRead(dir, [
        GHL_ACCESS,
        GHL_REFRESH,
        PODIUM_ACCESS,
        PODIUM_REFRESH,
      ]);
    });
  });

  test("saveTokens replaces a mode 0644 tokens.json with owner-only permissions", () => {
    withDir((dir) => {
      seedWorldReadable(dir, {
        ghl: { access_token: GHL_ACCESS, refresh_token: GHL_REFRESH },
      });
      writeTokens(dir, 0o022, [
        {
          op: "saveTokens",
          tokens: {
            access_token: GHL_ACCESS_REFRESHED,
            refresh_token: GHL_REFRESH_REFRESHED,
            expires_at: 2,
          },
        },
      ]);
      assertOthersCannotRead(dir, [
        GHL_ACCESS_REFRESHED,
        GHL_REFRESH_REFRESHED,
      ]);
    });
  });

  test("savePodiumTokens replaces a mode 0644 tokens.json with owner-only permissions", () => {
    withDir((dir) => {
      seedWorldReadable(dir, {
        ghl: { access_token: GHL_ACCESS, refresh_token: GHL_REFRESH },
        podium: { access_token: PODIUM_ACCESS, refresh_token: PODIUM_REFRESH },
      });
      writeTokens(dir, 0o022, [
        {
          op: "savePodiumTokens",
          tokens: {
            access_token: PODIUM_ACCESS_REFRESHED,
            refresh_token: PODIUM_REFRESH,
            expires_at: 2,
          },
        },
      ]);
      assertOthersCannotRead(dir, [
        GHL_ACCESS,
        GHL_REFRESH,
        PODIUM_ACCESS_REFRESHED,
      ]);
    });
  });

  test("saveLocationId replaces a mode 0644 tokens.json with owner-only permissions", () => {
    withDir((dir) => {
      seedWorldReadable(dir, {
        ghl: { access_token: GHL_ACCESS, refresh_token: GHL_REFRESH },
      });
      writeTokens(dir, 0o022, [
        { op: "saveLocationId", locationId: LOCATION_ID },
      ]);
      assertOthersCannotRead(dir, [GHL_ACCESS, GHL_REFRESH, LOCATION_ID]);
    });
  });
}
