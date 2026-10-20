/**
 * E2E tests — Gateway login hardening (TASK-018 / ISS-002)
 * framework: node:test
 *
 * ADR-004 (2026-10-19) — de-socketed, in-process:
 *  No spawn, no `listen`. The seam `createApp({ cfg })` is imported and its
 *  handler driven directly with mock req/res (tests/helpers/inject.mjs).
 *
 *  Lockout isolation: the login lockout state lives in the auth instance owned
 *  by each `createApp()` call (per-instance, never a module singleton). The
 *  lockout case therefore builds its OWN fresh app so the fixed-window counter
 *  cannot leak into / from sibling cases.
 *
 * NOTE: the previous `it("listens on loopback only, not 0.0.0.0")` genuinely
 *  requires a real `listen` and cannot be expressed in-process; it has MOVED to
 *  tests/e2e/network/gateway-bind-host.test.mjs, which is skipped unless
 *  PAAW_E2E_ALLOW_LISTEN=1 (the config-level loopback guarantee remains covered
 *  in unit tests via DEFAULT_HOST / config.host).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "../../src/server.mjs";
import { createConfig } from "../../src/server/config.mjs";
import { call } from "../helpers/inject.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, "..", "..", "src");

const PLAIN_PASSWORD = "e2e-hardened-pw";

/**
 * Build a fresh in-process gateway (no listen) against a throwaway env.
 * @param {object} [configOverrides]
 */
function makeEnv(configOverrides = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "paaw-gw-auth-"));
  const paawRoot = join(tmp, "paaw-root");
  const backupDir = join(tmp, "backups");
  const eventLogPath = join(tmp, "events.jsonl");
  mkdirSync(join(paawRoot, "data"), { recursive: true });
  mkdirSync(join(paawRoot, ".paaw"), { recursive: true });
  writeFileSync(join(paawRoot, "data", "db.json"), '{"e2e":"seed"}');

  const configPath = join(tmp, "config.json");
  writeFileSync(configPath, JSON.stringify({
    host: "127.0.0.1",
    port: 4199,
    paawRoot,
    paawServerCmd: "node e2e-no-such-file.mjs",
    paawServerPort: 4990,
    backupDir,
    autoStartPaaw: false,
    users: [{ id: "admin", name: "Admin", role: "admin", passwordHash: PLAIN_PASSWORD }],
    sessionSecret: "e2e-secret",
    sessionMaxAge: 86_400_000,
    ...configOverrides,
  }));

  const saved = new Map();
  for (const [k, v] of Object.entries({
    PAAW_CONFIG: configPath,
    PAAW_ROOT: paawRoot,
    PAAW_BACKUP_DIR: backupDir,
    PAAW_EVENT_LOG: eventLogPath,
  })) {
    saved.set(k, Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined);
    process.env[k] = v;
  }
  let app;
  try {
    app = createApp({ cfg: createConfig(SRC_DIR) });
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  const login = (userId, password) =>
    call(app, {
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, password }),
    }).then((r) => ({ status: r.status, data: r.data, headers: r.headers }));

  return { app, login, tmp, dispose: () => rmSync(tmp, { recursive: true, force: true }) };
}

describe("E2E · Gateway login hardening (TASK-018, in-process)", () => {
  let env;
  before(() => { env = makeEnv(); });
  after(() => env.dispose());

  it("correct password (bcrypt-stored) → 200 { token, user }", async () => {
    const { status, data } = await env.login("admin", PLAIN_PASSWORD);
    assert.equal(status, 200, JSON.stringify(data));
    assert.ok(data.token, "a token must be issued");
    assert.deepEqual(data.user, { id: "admin", name: "Admin", role: "admin" });
    assert.equal("passwordHash" in data.user, false, "must not echo the credential");
  });

  it("wrong password and unknown user return the SAME 401 (no enumeration)", async () => {
    const wrong = await env.login("admin", "nope");
    const ghost = await env.login("ghost", "nope");
    assert.equal(wrong.status, 401);
    assert.equal(ghost.status, 401);
    assert.deepEqual(wrong.data, { error: "Invalid credentials" });
    assert.deepEqual(ghost.data, wrong.data, "responses must be byte-identical");
  });
});

describe("E2E · Gateway login lockout (TASK-018, in-process)", () => {
  // Fresh app per case → the per-instance rate limiter starts clean.
  let env;
  before(() => { env = makeEnv(); });
  after(() => env.dispose());

  it("repeated failures → 429 with Retry-After for further WRONG attempts", async () => {
    for (let i = 0; i < 5; i++) {
      const { status } = await env.login("admin", "wrong");
      assert.equal(status, 401, `failure #${i + 1} should be 401`);
    }
    const locked = await env.login("admin", "wrong");
    assert.equal(locked.status, 429, "after the limit, further failures must be refused");
    assert.ok(locked.headers["retry-after"], "a Retry-After header must be set");
    assert.match(locked.data.error, /too many/i);
  });

  it("login_locked audit entry sanitizes the attacker-controlled userId (no log injection)", async () => {
    // Fresh app → clean rate-limit counters.
    const fresh = makeEnv();
    try {
      // A userId carrying CR/LF + control chars could forge extra log lines
      // if written verbatim into the audit trail.
      const evil = "admin\r\nINJECTED\t\u0000entry";
      for (let i = 0; i < 5; i++) await fresh.login(evil, "wrong");
      const locked = await fresh.login(evil, "wrong");
      assert.equal(locked.status, 429, "the flooding principal must be locked");

      const entry = fresh.app.events.find((e) => e.type === "login_locked");
      assert.ok(entry, "a login_locked audit entry must exist");
      assert.equal(/[\r\n\t\u0000-\u001f]/.test(entry.detail), false,
        `audit detail must contain no control characters: ${JSON.stringify(entry.detail)}`);
      // Traceability preserved: the printable subset of the id survives.
      assert.ok(entry.detail.includes("INJECTED"), "printable chars retained for tracing");
    } finally {
      fresh.dispose();
    }
  });

  it("a username flood does NOT lock out the correct password (DoS fix)", async () => {
    // Fresh app so the previous case's counters cannot leak in.
    const fresh = makeEnv();
    try {
      for (let i = 0; i < 5; i++) {
        await fresh.login("admin", "wrong");
      }
      // The legitimate user must still authenticate — the account is not
      // globally locked by someone else's wrong attempts.
      const ok = await fresh.login("admin", PLAIN_PASSWORD);
      assert.equal(ok.status, 200, JSON.stringify(ok.data));
      assert.ok(ok.data.token, "a token must still be issued");
    } finally {
      fresh.dispose();
    }
  });
});
