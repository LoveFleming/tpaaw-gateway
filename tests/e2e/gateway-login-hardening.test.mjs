/**
 * E2E tests — Gateway Admin: login hardening + bind host
 * TASK-018 (ISS-002) + TASK-019 (ISS-006) / framework: node:test
 *
 * Isolation (identical to gateway-backup-auth.test.mjs):
 *  - spawn the real src/server.mjs against a throwaway config (PAAW_CONFIG knob)
 *    on a random free port → never touches the dev gateway on :4199
 *  - PAAW_ROOT / PAAW_BACKUP_DIR / PAAW_EVENT_LOG → mkdtemp temp dir
 *  - autoStartPaaw: false → no PAAW child, no outbound fetch
 *  - process-exit kill-switch so a mid-hook failure cannot orphan the child
 *
 * What this locks down:
 *  - successful login returns { token, user } (bcrypt credential)
 *  - wrong password / unknown user → identical 401 { error: "Invalid credentials" }
 *  - repeated failures → 429 lockout with Retry-After
 *  - the server binds loopback only (127.0.0.1), NOT 0.0.0.0
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync,
} from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { hashPasswordSync } from "../../src/server/password.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "..", "src", "server.mjs");
const HEALTH_TIMEOUT_MS = 10_000;

const PLAIN_PASSWORD = "e2e-hardened-pw";

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

/** Spawn an isolated gateway; returns { child, base, tmp } (plus the config it wrote). */
async function startGateway(configOverrides = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "paaw-gw-auth-"));
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

describe("E2E · Gateway login hardening (TASK-018)", () => {
  let g;
  let base;

  before(async () => {
    g = await startGateway();
    base = g.base;
  });
  after(() => stopGateway(g));

  it("correct password (bcrypt-stored) → 200 { token, user }", async () => {
    const { status, data } = await jsonReq(base, "/api/auth/login", {
      method: "POST",
      body: { userId: "admin", password: PLAIN_PASSWORD },
    });
    assert.equal(status, 200, JSON.stringify(data));
    assert.ok(data.token, "a token must be issued");
    assert.deepEqual(data.user, { id: "admin", name: "Admin", role: "admin" });
    assert.equal("passwordHash" in data.user, false, "must not echo the credential");
  });

  it("wrong password and unknown user return the SAME 401 (no enumeration)", async () => {
    const wrong = await jsonReq(base, "/api/auth/login", {
      method: "POST", body: { userId: "admin", password: "nope" },
    });
    const ghost = await jsonReq(base, "/api/auth/login", {
      method: "POST", body: { userId: "ghost", password: "nope" },
    });
    assert.equal(wrong.status, 401);
    assert.equal(ghost.status, 401);
    assert.deepEqual(wrong.data, { error: "Invalid credentials" });
    assert.deepEqual(ghost.data, wrong.data, "responses must be byte-identical");
  });
});

describe("E2E · Gateway login lockout (TASK-018)", () => {
  let g;
  let base;

  before(async () => {
    g = await startGateway();
    base = g.base;
  });
  after(() => stopGateway(g));

  it("repeated failures → 429 with Retry-After, even for the correct password", async () => {
    for (let i = 0; i < 5; i++) {
      const { status } = await jsonReq(base, "/api/auth/login", {
        method: "POST", body: { userId: "admin", password: "wrong" },
      });
      assert.equal(status, 401, `failure #${i + 1} should be 401`);
    }
    const locked = await jsonReq(base, "/api/auth/login", {
      method: "POST", body: { userId: "admin", password: PLAIN_PASSWORD },
    });
    assert.equal(locked.status, 429, "after the limit, login must be refused");
    assert.ok(locked.headers.get("retry-after"), "a Retry-After header must be set");
    assert.match(locked.data.error, /too many/i);
  });
});

/** Try a raw TCP connect; resolves true if the port accepts the connection. */
function canConnect(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

describe("E2E · Gateway bind host (TASK-019)", () => {
  let g;

  before(async () => { g = await startGateway(); });
  after(() => stopGateway(g));

  it("listens on loopback only, not 0.0.0.0", async () => {
    // Reachable via 127.0.0.1 (proves it is up)…
    const local = await fetch(`http://127.0.0.1:${g.port}/api/health`);
    assert.equal(local.status, 200);

    // …and NOT reachable via any non-internal interface address. A wildcard
    // (0.0.0.0) bind would accept connections on the host's LAN IPs; a
    // 127.0.0.1 bind refuses them. Skip the negative check only when the host
    // genuinely has no external interface (e.g. a bare CI container).
    const external = Object.values(os.networkInterfaces())
      .flat()
      .filter((ni) => ni && ni.family === "IPv4" && !ni.internal)
      .map((ni) => ni.address);

    if (external.length === 0) {
      console.log("# no external IPv4 interface on this host — skipping wildcard probe");
      return;
    }
    for (const ip of external) {
      assert.equal(
        await canConnect(ip, g.port),
        false,
        `server must not be reachable on external interface ${ip} (would mean a 0.0.0.0 bind)`,
      );
    }
  });
});
