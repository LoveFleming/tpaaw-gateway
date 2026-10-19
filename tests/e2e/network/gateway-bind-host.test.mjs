/**
 * E2E tests (opt-in NETWORK suite) — Gateway bind host (TASK-019)
 * framework: node:test
 *
 * ADR-004 (2026-10-19): the loopback-bind guarantee is intrinsically a real
 * socket-level fact ("the OS refused connections on non-loopback interfaces"),
 * which cannot be expressed in-process. It was therefore moved OUT of
 * gateway-login-hardening.test.mjs into this dedicated, OPT-IN suite.
 *
 * This suite spawns a real server and binds a real port, so it is SKIPPED by
 * default (the sandbox forbids `listen`). Enable it deliberately with:
 *
 *     PAAW_E2E_ALLOW_LISTEN=1 npm test
 *
 * The corresponding config-level guarantee (DEFAULT_HOST / config.host =
 * 127.0.0.1) is asserted in-process by the unit tests, so dropping this suite
 * in a restricted environment does not lose coverage of the *decision*.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { hashPasswordSync } from "../../../src/server/password.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "..", "..", "src", "server.mjs");
const HEALTH_TIMEOUT_MS = 10_000;

const ALLOW_LISTEN = process.env.PAAW_E2E_ALLOW_LISTEN === "1";
const SKIP_REASON = "requires real listen; set PAAW_E2E_ALLOW_LISTEN=1";

const ACTIVE_CHILDREN = new Set();
process.on("exit", () => {
  for (const child of ACTIVE_CHILDREN) if (child.exitCode === null) child.kill("SIGKILL");
});

/** Ask the OS for a currently-free port (bind :0 then release). */
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

/** Try a raw TCP connect; resolves true if the port accepts the connection. */
function canConnect(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

async function startGateway() {
  const tmp = mkdtempSync(join(tmpdir(), "paaw-gw-bind-"));
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
    users: [{ id: "admin", name: "Admin", role: "admin", passwordHash: hashPasswordSync("e2e-bind-pw") }],
    sessionSecret: "e2e-secret",
    sessionMaxAge: 86_400_000,
  }));

  const child = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      PAAW_CONFIG: configPath,
      PAAW_ROOT: paawRoot,
      PAAW_BACKUP_DIR: backupDir,
      PAAW_EVENT_LOG: join(tmp, "events.jsonl"),
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  ACTIVE_CHILDREN.add(child);
  child.once("exit", () => ACTIVE_CHILDREN.delete(child));

  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("gateway did not become healthy in time");
    await new Promise((r) => setTimeout(r, 100));
  }
  return { child, port, tmp };
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

describe("E2E · Gateway bind host (TASK-019) [opt-in network]", () => {
  let g;
  before(async () => { if (ALLOW_LISTEN) g = await startGateway(); });
  after(async () => { if (ALLOW_LISTEN) await stopGateway(g); });

  it("listens on loopback only, not 0.0.0.0", { skip: ALLOW_LISTEN ? false : SKIP_REASON }, async () => {
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
