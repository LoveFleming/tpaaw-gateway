/**
 * E2E tests — Gateway Admin: request body size limit (ISS-008, DoS hardening)
 * framework: node:test
 *
 * ADR-004 (2026-10-19) — de-socketed, in-process:
 *  No spawn, no `listen`. The production seam `createApp({ cfg })` is imported
 *  and its handler is driven directly with mock req/res (tests/helpers/inject.mjs).
 *  A chunked request (no Content-Length) is simulated by feeding the mock req a
 *  `chunks` array, so the byte-count defence is exercised exactly as before.
 *
 * What this locks down (ISS-008):
 *  ① a normal (small) login body still succeeds → 200 { token, user }
 *  ② an oversized body (declared Content-Length) is rejected with 413, and the
 *     server stays responsive afterwards (health → 200)
 *  ③ the cap is enforced on ACTUAL streamed bytes: a chunked request that omits
 *     Content-Length is rejected too (Content-Length cannot be trusted)
 *  ④ boundary: a body of exactly 64 KiB is accepted; one byte over is rejected
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

const PLAIN_PASSWORD = "e2e-body-limit-pw";
// Mirrors MAX_BODY_BYTES in src/server.mjs; kept as a literal so cap drift in
// production surfaces as a failing test rather than a silent mismatch.
const MAX_BODY_BYTES = 64 * 1024;
const OVERSIZE_KB = 128; // ≫ 64 KiB cap

/** Build a fresh in-process gateway (no listen) against a throwaway env. */
function makeEnv() {
  const tmp = mkdtempSync(join(tmpdir(), "paaw-gw-body-"));
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
    // Plaintext passwordHash is accepted by verifyPassword (legacy path) and is
    // what the original file used; keeps this test focused on the body cap.
    users: [{ id: "admin", name: "Admin", role: "admin", passwordHash: PLAIN_PASSWORD }],
    sessionSecret: "e2e-secret",
    sessionMaxAge: 86_400_000,
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

  return { app, tmp, dispose: () => rmSync(tmp, { recursive: true, force: true }) };
}

/**
 * Build a login JSON body whose UTF-8 byte length is exactly `targetBytes`.
 * Pads with a `pad` field; asserts the exact size so a helper bug fails loudly.
 */
function loginBodyOfSize(targetBytes) {
  const head = JSON.stringify({ userId: "admin", password: PLAIN_PASSWORD, pad: "" });
  // head ends with ..."pad":""} → drop the empty pad value's closing quote/brace
  const suffix = '"}';
  const prefix = head.slice(0, head.length - suffix.length); // ..."pad":"
  const padLen = targetBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  assert.ok(padLen >= 0, `targetBytes ${targetBytes} too small for the envelope`);
  const body = prefix + "x".repeat(padLen) + suffix;
  assert.equal(Buffer.byteLength(body), targetBytes, "helper must produce the exact byte size");
  return body;
}

describe("E2E · Gateway admin body limit (ISS-008, in-process)", () => {
  let env;
  before(() => { env = makeEnv(); });
  after(() => env.dispose());

  const postBody = (body, headers = {}) =>
    call(env.app, { method: "POST", url: "/api/auth/login", headers, body });
  const health = () => call(env.app, { method: "GET", url: "/api/health" });

  // ── ① small body → 200 { token, user } ──
  it("normal (small) login body still succeeds → 200 { token }", async () => {
    const { status, data } = await postBody(
      JSON.stringify({ userId: "admin", password: PLAIN_PASSWORD }),
      { "content-type": "application/json" },
    );
    assert.equal(status, 200, JSON.stringify(data));
    assert.ok(data.token, "a token must be issued for a valid small body");
  });

  // ── ② oversized declared Content-Length → 413, server still healthy ──
  it("oversized body (declared Content-Length) → 413, then server still healthy", async () => {
    const huge = "x".repeat(OVERSIZE_KB * 1024);
    const body = JSON.stringify({ userId: "admin", password: PLAIN_PASSWORD, pad: huge });
    const res = await postBody(body, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    });

    assert.equal(res.status, 413, `expected 413, got ${res.status} (raw bytes=${Buffer.byteLength(body)})`);
    assert.deepEqual(res.data, { error: "Payload Too Large" });
    // Defence line 1 (early abort on declared length) destroys the request stream.
    assert.equal(res.reqDestroyed, true, "oversized request stream must be destroyed");

    // Regression guard: the server must not have crashed / leaked the stream.
    const h = await health();
    assert.equal(h.status, 200, "server must stay responsive after a 413");
  });

  // ── ③ chunked, NO Content-Length, over-limit → 413 (byte-count defence) ──
  it("oversized chunked body with NO Content-Length → 413 (byte-count defence)", async () => {
    const chunk = "y".repeat(16 * 1024);
    const chunks = Array.from({ length: 8 }, () => chunk); // 128 KiB total, no content-length
    // Drive with the explicit chunk array: feed the mock req multiple data events
    // and NO content-length header, modelling a hostile chunked client.
    const chunked = await call(env.app, {
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" }, // deliberately NO content-length
      chunks,
    });
    assert.equal(
      chunked.status,
      413,
      `a chunked over-limit body must be rejected too (streamed bytes=${
        chunks.length * Buffer.byteLength(chunk)
      })`,
    );
    assert.equal(chunked.reqDestroyed, true, "over-limit chunked stream must be destroyed");

    const h = await health();
    assert.equal(h.status, 200, "server must stay responsive after a chunked 413");
  });

  // ── ④ boundary: exactly 64 KiB accepted, 64 KiB + 1 rejected ──
  it("boundary: body of exactly 64 KiB → 200; 64 KiB + 1 → 413", async () => {
    const atCap = loginBodyOfSize(MAX_BODY_BYTES); // == cap → allowed (cap is a strict `>`)
    const overCap = loginBodyOfSize(MAX_BODY_BYTES + 1);

    const ok = await postBody(atCap, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(atCap)),
    });
    assert.equal(ok.status, 200, `exactly ${MAX_BODY_BYTES} bytes must be accepted: ${JSON.stringify(ok.data)}`);
    assert.ok(ok.data.token, "a token must be issued at the cap");

    const bad = await postBody(overCap, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(overCap)),
    });
    assert.equal(bad.status, 413, `cap+1 bytes (${MAX_BODY_BYTES + 1}) must be rejected`);
    assert.deepEqual(bad.data, { error: "Payload Too Large" });
  });
});
