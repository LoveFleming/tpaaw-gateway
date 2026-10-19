/**
 * E2E tests — Gateway Admin: request body size limit (ISS-008, DoS hardening)
 * framework: node:test
 *
 * Isolation (identical to gateway-login-hardening.test.mjs):
 *  - spawn the real src/server.mjs against a throwaway config (PAAW_CONFIG knob)
 *    on a random free port → never touches the dev gateway on :4199
 *  - PAAW_ROOT / PAAW_BACKUP_DIR / PAAW_EVENT_LOG → mkdtemp temp dir
 *  - autoStartPaaw: false → no PAAW child, no outbound fetch
 *  - process-exit kill-switch so a mid-hook failure cannot orphan the child
 *
 * What this locks down (ISS-008):
 *  - a normal (small) login body still succeeds → 200 { token, user }
 *  - an oversized body is rejected with 413 and the server stays responsive
 *  - the cap is enforced on ACTUAL streamed bytes, so a chunked request that
 *    omits Content-Length is rejected too (Content-Length cannot be trusted)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { hashPasswordSync } from "../../src/server/password.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "..", "src", "server.mjs");
const HEALTH_TIMEOUT_MS = 10_000;

const PLAIN_PASSWORD = "e2e-body-limit-pw";
// Mirrors MAX_BODY_BYTES in src/server.mjs; kept as a literal so cap drift in
// production surfaces as a failing test rather than a silent mismatch.
const OVERSIZE_KB = 128; // ≫ 64 KiB cap

const ACTIVE_CHILDREN = new Set();
process.on("exit", () => {
  for (const child of ACTIVE_CHILDREN) if (child.exitCode === null) child.kill("SIGKILL");
});

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

async function jsonReq(base, path, { method = "GET", body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, data, headers: res.headers };
}

/** Spawn an isolated gateway; returns { child, base, tmp, port }. */
async function startGateway(configOverrides = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "paaw-gw-body-"));
  const paawRoot = join(tmp, "paaw-root");
  const backupDir = join(tmp, "backups");
  const port = await getFreePort();

  mkdirSync(join(paawRoot, "data"), { recursive: true });
  mkdirSync(join(paawRoot, ".paaw"), { recursive: true });
  writeFileSync(join(paawRoot, "data", "db.json"), '{"e2e":"seed"}');

  const configPath = join(tmp, "config.json");
  writeFileSync(configPath, JSON.stringify({
    port,
    host: "127.0.0.1",
    paawRoot,
    paawServerCmd: "node e2e-no-such-file.mjs",
    paawServerPort: await getFreePort(),
    backupDir,
    autoStartPaaw: false,
    users: [{ id: "admin", name: "Admin", role: "admin", passwordHash: hashPasswordSync(PLAIN_PASSWORD) }],
    sessionSecret: "e2e-secret",
    sessionMaxAge: 86_400_000,
    ...configOverrides,
  }));

  const child = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      PAAW_CONFIG: configPath,
      PAAW_ROOT: paawRoot,
      PAAW_BACKUP_DIR: backupDir,
      PAAW_EVENT_LOG: join(tmp, "events.jsonl"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  ACTIVE_CHILDREN.add(child);
  child.once("exit", () => ACTIVE_CHILDREN.delete(child));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    try {
      const res = await fetch(base + "/api/health");
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("gateway did not become healthy in time");
    await new Promise((r) => setTimeout(r, 100));
  }
  return { child, base, tmp, port };
}

async function stopGateway(g) {
  if (!g) return;
  if (g.child.exitCode === null) {
    await new Promise((done) => {
      g.child.once("exit", done);
      g.child.kill();
      setTimeout(done, 3000);
    });
  }
  rmSync(g.tmp, { recursive: true, force: true });
}

/**
 * POST a deliberately chunked body with NO Content-Length header, streaming the
 * payload in pieces. Models a hostile client that tries to bypass a header-only
 * limit. Returns the response status code.
 */
function chunkedPost(port, path, chunks) {
  return new Promise((resolveStatus, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        res.resume();
        res.on("end", () => resolveStatus(res.statusCode));
      },
    );
    req.on("error", reject);
    for (const c of chunks) req.write(c);
    req.end();
  });
}

describe("E2E · Gateway admin body limit (ISS-008)", () => {
  let g;
  let base;

  before(async () => {
    g = await startGateway();
    base = g.base;
  });
  after(() => stopGateway(g));

  it("normal (small) login body still succeeds → 200 { token }", async () => {
    const { status, data } = await jsonReq(base, "/api/auth/login", {
      method: "POST",
      body: { userId: "admin", password: PLAIN_PASSWORD },
    });
    assert.equal(status, 200, JSON.stringify(data));
    assert.ok(data.token, "a token must be issued for a valid small body");
  });

  it("oversized body (declared Content-Length) → 413, then server still healthy", async () => {
    const huge = "x".repeat(OVERSIZE_KB * 1024);
    const res = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "admin", password: PLAIN_PASSWORD, pad: huge }),
    });
    assert.equal(res.status, 413, `expected 413, got ${res.status}`);
    const data = await res.json();
    assert.deepEqual(data, { error: "Payload Too Large" });

    // Regression guard: the server must not have crashed / leaked the stream.
    const health = await jsonReq(base, "/api/health");
    assert.equal(health.status, 200, "server must stay responsive after a 413");
  });

  it("oversized chunked body with NO Content-Length → 413 (byte-count defence)", async () => {
    const chunk = "y".repeat(16 * 1024);
    const chunks = Array.from({ length: 8 }, () => chunk); // 128 KiB total
    const status = await chunkedPost(g.port, "/api/auth/login", chunks);
    assert.equal(status, 413, "a chunked over-limit body must be rejected too");

    const health = await jsonReq(base, "/api/health");
    assert.equal(health.status, 200, "server must stay responsive after a chunked 413");
  });
});
