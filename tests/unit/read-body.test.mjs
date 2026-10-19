/**
 * Unit tests — readBody error semantics (ISS-008 regression fix)
 * framework: node:test
 *
 * Regression guard: the ISS-008 body-cap fix once settled BOTH "body over the
 * cap" and "client aborted / stream error" as { ok:false, status:413 }, so the
 * caller reported a network reset as "Payload Too Large". These cases pin the
 * two failure modes apart:
 *   ① over-limit (declared Content-Length OR streamed bytes) → 413 + that msg
 *   ② client abort / stream error                            → 400, NOT 413
 *   ③ happy path (empty body / invalid JSON) stays { ok:true, value:{} }
 *
 * ADR-004 (2026-10-19) — in-process, no spawn / no listen: the `createApp()`
 * seam is imported and its handler driven with mock req/res
 * (tests/helpers/inject.mjs). `emitError:true` makes the mock req emit a stream
 * "error" event, reproducing a client abort / reset.
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

const PLAIN_PASSWORD = "unit-readbody-pw";
// Mirrors MAX_BODY_BYTES in src/server.mjs; kept as a literal so cap drift in
// production surfaces as a failing test rather than a silent mismatch.
const MAX_BODY_BYTES = 64 * 1024;

/** Build a fresh in-process gateway (no listen) against a throwaway env. */
function makeEnv() {
  const tmp = mkdtempSync(join(tmpdir(), "paaw-gw-readbody-"));
  const paawRoot = join(tmp, "paaw-root");
  mkdirSync(join(paawRoot, "data"), { recursive: true });
  mkdirSync(join(paawRoot, ".paaw"), { recursive: true });
  writeFileSync(join(paawRoot, "data", "db.json"), '{"unit":"seed"}');

  const configPath = join(tmp, "config.json");
  writeFileSync(configPath, JSON.stringify({
    host: "127.0.0.1",
    port: 4199,
    paawRoot,
    paawServerCmd: "node unit-no-such-file.mjs",
    paawServerPort: 4991,
    backupDir: join(tmp, "backups"),
    autoStartPaaw: false,
    users: [{ id: "admin", name: "Admin", role: "admin", passwordHash: PLAIN_PASSWORD }],
    sessionSecret: "unit-secret",
    sessionMaxAge: 86_400_000,
  }));

  const saved = new Map();
  for (const [k, v] of Object.entries({
    PAAW_CONFIG: configPath,
    PAAW_ROOT: paawRoot,
    PAAW_BACKUP_DIR: join(tmp, "backups"),
    PAAW_EVENT_LOG: join(tmp, "events.jsonl"),
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

  return { app, tmp, dispose: () => rmSync(tmp, { recursive: true, force: true }) };
}

const login = (app, opts) =>
  call(app, {
    method: "POST",
    url: "/api/auth/login",
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });

describe("Unit · readBody — over-limit vs client abort (ISS-008 regression)", () => {
  let env;
  before(() => { env = makeEnv(); });
  after(() => env.dispose());

  it("declared Content-Length over the cap → 413 Payload Too Large (unchanged)", async () => {
    const res = await login(env.app, {
      headers: { "content-length": String(MAX_BODY_BYTES + 1) },
      body: JSON.stringify({ userId: "admin", password: PLAIN_PASSWORD }),
    });
    assert.equal(res.status, 413, `expected 413, got ${res.status}`);
    assert.deepEqual(res.data, { error: "Payload Too Large" });
  });

  it("streamed bytes over the cap (no Content-Length) → 413 Payload Too Large", async () => {
    // A chunk list with NO content-length exercises the byte-count defence.
    const chunk = Buffer.alloc(48 * 1024, 0x61); // 'a'
    const res = await login(env.app, {
      chunks: [chunk, chunk], // 96 KiB > 64 KiB cap
    });
    assert.equal(res.status, 413, `expected 413, got ${res.status}`);
    assert.deepEqual(res.data, { error: "Payload Too Large" });
  });

  it("client abort / stream error → 400 Bad Request, NOT 413 Payload Too Large", async () => {
    const res = await login(env.app, {
      body: JSON.stringify({ userId: "admin", password: PLAIN_PASSWORD }),
      emitError: true, // mock req emits "error" → client reset, not over-limit
    });
    assert.notEqual(res.status, 413, "a client reset must not be reported as over-limit");
    assert.equal(res.status, 400, `expected 400 on abort, got ${res.status}`);
    assert.deepEqual(res.data, { error: "Bad Request" });
    assert.notDeepEqual(res.data, { error: "Payload Too Large" });
  });

  it("empty body → parsed as {} → 401 (credentials missing), never 413", async () => {
    const res = await call(env.app, {
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      // no body at all
    });
    assert.equal(res.status, 401, `empty body must reach auth and fail as 401, got ${res.status}`);
    assert.deepEqual(res.data, { error: "Invalid credentials" });
  });

  it("invalid JSON → parsed as {} → 401, never 413", async () => {
    const res = await login(env.app, { body: "{ not json" });
    assert.equal(res.status, 401, `invalid JSON must reach auth and fail as 401, got ${res.status}`);
    assert.deepEqual(res.data, { error: "Invalid credentials" });
  });

  it("server stays responsive to a subsequent valid login after a 413", async () => {
    const ok = await login(env.app, {
      body: JSON.stringify({ userId: "admin", password: PLAIN_PASSWORD }),
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.ok(ok.data.token, "a token must be issued after recovery");
  });
});
