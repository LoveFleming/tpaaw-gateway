/**
 * E2E tests — Gateway UI (src/ui/server.mjs createUIHandler): /api/* endpoint coverage
 * framework: node:test
 *
 * ADR-004 (2026-10-19) — de-socketed, in-process:
 *  No spawn, no `listen`. The seam `createUIHandler(deps)` is imported and the
 *  handler is driven directly with mock req/res (tests/helpers/inject.mjs).
 *  Outbound HTTP (the /api/status stable probe, /api/update) is removed via
 *  `withFetch`.
 *
 * This file closes the endpoint-level gaps left by gateway-ui-csrf.test.mjs
 * (which covers the F7 CSRF/Host gate + a few smoke cases). It exercises the
 * remaining read/guard/validation branches of the console that had ZERO e2e
 * coverage, asserting the HTTP contract (status + response shape) of:
 *   - GET /  and /index.html      → static HTML served, text/html Content-Type
 *   - GET /api/settings           → field source classification (env)
 *   - POST /api/settings          → invalid JSON 400, non-http(s) 400, relative path 400, job-active 409, valid persist 200
 *   - GET /api/semgrep            → presence JSON shape + hint
 *   - GET /api/status             → field assembly, stable=null on a dead server
 *   - GET /api/log                → returns accumulated job lines
 *   - GET /api/paaw-log           → exists:false when absent; tail-read with offset when present
 *   - POST /api/start|stop|restart→ 202 accepted guard branches / 409 while active
 *   - POST /api/update            → 202 accepted / 409 while active
 *   - POST /api/upload            → 415 wrong type / 400 empty / 409 while active / 202 valid type
 *   - unknown route               → 404
 *
 * NOTE (reported, not fixed here — out of Tester scope):
 *  `createUIHandler(deps)` accepts `deps.job`/`deps.jobLog`, but the module-level
 *  `runJob`/`uiStart`/`uiStop`/`uiUpdate` closures capture the MODULE-LEVEL `job`
 *  (src/ui/server.mjs:53), not the injected one. So a POST that starts a job
 *  mutates the module-level job, invisible through `deps.job`. These tests
 *  therefore assert the HTTP contract (202/409 + response body) rather than the
 *  job's terminal state; a full injection seam would let us assert the latter.
 *  Also: POST /api/semgrep/install really spawns pipx/pip/pip3 (`installSemgrep`),
 *  so it is deliberately NOT exercised here (no spawn in tests) — only its
 *  409-while-active guard is covered. A seam to stub the installer is recommended.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createUIHandler } from "../../src/ui/server.mjs";
import { applyHome, getDataDir } from "../../src/lib/config.mjs";
import { call, withFetch, refusingFetch } from "../helpers/inject.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Instant-failing package server (status probe / update swallow the error). */
const DEAD_PACKAGE_URL = "http://127.0.0.1:1";

/** Fallback temp base: PAAW_TMP first, else the project .paaw/tmp. */
const TMP_BASE = process.env.PAAW_TMP || join(__dirname, "..", "..", ".paaw", "tmp");

/**
 * Build a fresh in-process UI handler (no listen) against a throwaway env.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.packageUrl] PAAW_PACKAGE_URL (default: DEAD_PACKAGE_URL; null omits it).
 * @param {boolean} [opts.setHome] set PAAW_HOME to the temp home (default true). Pass false to
 *   leave PAAW_HOME unset — required to exercise the paawHome POST validation branch (an env-locked
 *   paawHome is ignored by the handler).
 * @param {string} [opts.semgrepPath] SEMGREP_PATH env value.
 */
function makeEnv({ packageUrl = DEAD_PACKAGE_URL, setHome = true, semgrepPath } = {}) {
  mkdirSync(TMP_BASE, { recursive: true });
  const tmp = mkdtempSync(join(TMP_BASE, "paaw-gwui-ep-"));
  const home = join(tmp, "home");
  mkdirSync(home, { recursive: true });

  const savedEnv = {
    PAAW_PACKAGE_URL: process.env.PAAW_PACKAGE_URL,
    PAAW_HOME: process.env.PAAW_HOME,
    PAAW_OPEN_BROWSER: process.env.PAAW_OPEN_BROWSER,
    SEMGREP_PATH: process.env.SEMGREP_PATH,
  };

  if (packageUrl) process.env.PAAW_PACKAGE_URL = packageUrl;
  else delete process.env.PAAW_PACKAGE_URL;
  if (setHome) process.env.PAAW_HOME = home;
  else delete process.env.PAAW_HOME;
  process.env.PAAW_OPEN_BROWSER = "0";
  if (semgrepPath !== undefined) process.env.SEMGREP_PATH = semgrepPath;
  else delete process.env.SEMGREP_PATH;

  // saveGatewayCfg() writes gateway.json to process.cwd() (NOT PAAW_HOME), so a
  // POST /api/settings would scribble on the real project root and race other
  // parallel workers on that file. Isolate by running with cwd inside tmp.
  const savedCwd = process.cwd();
  process.chdir(tmp);

  applyHome();

  const job = { active: false, kind: null, lines: [], error: null, message: null, startedAt: null, finishedAt: null };
  const jobLog = (line) => {
    job.lines.push(`[${new Date().toLocaleTimeString()}] ${line}`);
    if (job.lines.length > 200) job.lines.splice(0, job.lines.length - 200);
  };

  const handler = createUIHandler({ UI_HOST: "127.0.0.1", job, jobLog });
  return { handler, job, home, tmp, savedEnv, savedCwd };
}

/** Restore env keys saved by makeEnv and re-derive HOME. */
function cleanupEnv(savedEnv, savedCwd, tmp) {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (savedCwd) process.chdir(savedCwd); // restore cwd BEFORE applyHome
  applyHome();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}

/** Call the handler with a trusted Host default (mirrors real HTTP always sending Host). */
async function req(handler, url, { method = "GET", headers = {}, body, chunks } = {}) {
  const hdrs = { host: "127.0.0.1:4290", ...headers };
  return call(handler, { method, url, headers: hdrs, body, chunks });
}

// ─────────────────────────────────────────────────────────────

describe("E2E · Gateway UI endpoints (createUIHandler /api/*)", () => {
  let env;

  before(() => {
    env = makeEnv();
  });

  after(() => {
    if (env) cleanupEnv(env.savedEnv, env.savedCwd, env.tmp);
  });

  beforeEach(() => {
    // Keep the injected job object quiet between cases. (Job state is module-level
    // for runJob paths — see file header — so tests assert the HTTP contract.)
    env.job.active = false;
    env.job.kind = null;
    env.job.lines = [];
    env.job.error = null;
    env.job.message = null;
  });

  // ── 1. Static UI ──
  describe("GET / and /index.html", () => {
    it("serves the console HTML with text/html Content-Type", async () => {
      for (const path of ["/", "/index.html"]) {
        const { status, headers, body } = await req(env.handler, path);
        assert.equal(status, 200, `GET ${path} should be 200`);
        assert.match(headers["content-type"] || "", /text\/html/, "must be served as text/html");
        assert.ok(body.length > 0, "HTML body must not be empty");
      }
    });
  });

  // ── 2. GET /api/settings — field source classification ──
  describe("GET /api/settings", () => {
    it("classifies packageServer/paawHome sources; env-locked flags reflected", async () => {
      const { status, data } = await req(env.handler, "/api/settings");
      assert.equal(status, 200);
      assert.equal(data.packageServer.source, "env", "PAAW_PACKAGE_URL is set → source=env");
      assert.equal(data.packageServer.envLocked, true, "env var locks the field");
      assert.equal(data.paawHome.source, "env", "PAAW_HOME is set → source=env");
      assert.equal(data.paawHome.envLocked, true);
      assert.equal(typeof data.semgrepPath.value, "string");
      assert.ok(["env", "config", "auto"].includes(data.semgrepPath.source));
    });

    it("semgrepPath reports source=env when SEMGREP_PATH is set", async () => {
      const e = makeEnv({ semgrepPath: "/usr/local/bin/semgrep" });
      try {
        const { data } = await req(e.handler, "/api/settings");
        assert.equal(data.semgrepPath.value, "/usr/local/bin/semgrep");
        assert.equal(data.semgrepPath.source, "env");
        assert.equal(data.semgrepPath.envLocked, true);
      } finally {
        cleanupEnv(e.savedEnv, e.savedCwd, e.tmp);
      }
    });
  });

  // ── 3. POST /api/settings — validation branches ──
  describe("POST /api/settings — input validation", () => {
    it("rejects a non-JSON body with 400", async () => {
      const { status, data } = await req(env.handler, "/api/settings", {
        method: "POST",
        headers: { origin: "http://127.0.0.1:4290" },
        body: "{ not json",
      });
      assert.equal(status, 400);
      assert.equal(data.ok, false);
      assert.match(data.message, /JSON/);
    });

    it("rejects a non-http(s) packageServer with 400", async () => {
      const e = makeEnv({ packageUrl: null }); // no env lock → field is writable
      try {
        const { status, data } = await req(e.handler, "/api/settings", {
          method: "POST",
          headers: { origin: "http://127.0.0.1:4290" },
          body: JSON.stringify({ packageServer: "ftp://nope" }),
        });
        assert.equal(status, 400);
        assert.match(data.message, /http\(s\)/);
      } finally {
        cleanupEnv(e.savedEnv, e.savedCwd, e.tmp);
      }
    });

    it("rejects a relative paawHome with 400 (must be absolute)", async () => {
      // PAAW_HOME unset → paawHome field is NOT env-locked, so validation runs.
      const e = makeEnv({ packageUrl: null, setHome: false });
      try {
        const { status, data } = await req(e.handler, "/api/settings", {
          method: "POST",
          headers: { origin: "http://127.0.0.1:4290" },
          body: JSON.stringify({ paawHome: "relative/path" }),
        });
        assert.equal(status, 400);
        assert.match(data.message, /絕對路徑/);
      } finally {
        cleanupEnv(e.savedEnv, e.savedCwd, e.tmp);
      }
    });

    it("rejects a relative semgrepPath with 400 when SEMGREP_PATH is unset", async () => {
      const e = makeEnv({ packageUrl: null });
      try {
        const { status, data } = await req(e.handler, "/api/settings", {
          method: "POST",
          headers: { origin: "http://127.0.0.1:4290" },
          body: JSON.stringify({ semgrepPath: "bin/semgrep" }),
        });
        assert.equal(status, 400);
        assert.match(data.message, /絕對路徑/);
      } finally {
        cleanupEnv(e.savedEnv, e.savedCwd, e.tmp);
      }
    });

    it("returns 409 when a job is already active", async () => {
      env.job.active = true;
      env.job.kind = "update";
      const { status, data } = await req(env.handler, "/api/settings", {
        method: "POST",
        headers: { origin: "http://127.0.0.1:4290" },
        body: "{}",
      });
      assert.equal(status, 409);
      assert.equal(data.ok, false);
      assert.match(data.message, /update/);
    });

    it("accepts a valid packageServer and persists it (200 ok, changed listed)", async () => {
      const e = makeEnv({ packageUrl: null });
      try {
        const { status, data } = await req(e.handler, "/api/settings", {
          method: "POST",
          headers: { origin: "http://127.0.0.1:4290" },
          body: JSON.stringify({ packageServer: "http://127.0.0.1:9/pkg/" }),
        });
        assert.equal(status, 200);
        assert.equal(data.ok, true);
        assert.ok(data.changed.includes("packageServer"), "packageServer must be reported changed");
        assert.equal(data.packageServer, "http://127.0.0.1:9/pkg", "trailing slash trimmed");
      } finally {
        cleanupEnv(e.savedEnv, e.savedCwd, e.tmp);
      }
    });
  });

  // ── 4. GET /api/semgrep ──
  describe("GET /api/semgrep", () => {
    it("returns the presence JSON shape with a hint when not installed", async () => {
      const { status, data } = await req(env.handler, "/api/semgrep");
      assert.equal(status, 200);
      assert.equal(data.checking, false);
      assert.equal(typeof data.installed, "boolean");
      assert.ok("path" in data, "presence object carries a path field");
      assert.equal(typeof data.deepChecking, "boolean");
      if (!data.installed) {
        assert.match(data.hint || "", /semgrep/, "uninstalled state must carry a hint");
      }
    });

    it("refresh=1 is accepted without error", async () => {
      const { status, data } = await req(env.handler, "/api/semgrep?refresh=1");
      assert.equal(status, 200);
      assert.equal(typeof data.installed, "boolean");
    });
  });

  // ── 5. POST /api/semgrep/install — guard only ──
  describe("POST /api/semgrep/install", () => {
    it("returns 409 while a job is active", async () => {
      env.job.active = true;
      env.job.kind = "update";
      const { status, data } = await req(env.handler, "/api/semgrep/install", {
        method: "POST",
        headers: { origin: "http://127.0.0.1:4290" },
      });
      assert.equal(status, 409);
      assert.equal(data.ok, false);
      // NOTE: the 202 path is intentionally NOT covered — it really spawns pipx/pip/pip3.
    });
  });

  // ── 6. GET /api/status ──
  describe("GET /api/status", () => {
    it("assembles the status document with stable=null when the package server is dead", async () => {
      const e = makeEnv();
      try {
        await withFetch(refusingFetch, async () => {
          const { status, data } = await req(e.handler, "/api/status");
          assert.equal(status, 200);
          assert.equal(data.home, e.home, "home reflects PAAW_HOME");
          assert.equal(data.current, null, "nothing installed yet");
          assert.deepEqual(data.installed, [], "no versions installed");
          assert.equal(data.stable, null, "dead package server → stable falls back to null");
          assert.equal(data.stableNewer, false);
          assert.equal(data.running, false, "no PAAW child in-process");
          assert.equal(data.runningVersion, null);
          assert.equal(data.dataSeeded, false);
          assert.equal(typeof data.job, "object");
        });
      } finally {
        cleanupEnv(e.savedEnv, e.savedCwd, e.tmp);
      }
    });
  });

  // ── 7. GET /api/log ──
  describe("GET /api/log", () => {
    it("returns the accumulated job lines", async () => {
      env.job.lines = ["[t] line one", "[t] line two"];
      const { status, data } = await req(env.handler, "/api/log");
      assert.equal(status, 200);
      assert.deepEqual(data.lines, ["[t] line one", "[t] line two"]);
    });
  });

  // ── 8. GET /api/paaw-log ──
  describe("GET /api/paaw-log", () => {
    it("reports exists:false when no server-console.log exists", async () => {
      const e = makeEnv();
      try {
        const { status, data } = await req(e.handler, "/api/paaw-log");
        assert.equal(status, 200);
        assert.equal(data.exists, false);
        assert.equal(data.size, 0);
        assert.equal(data.nextOffset, 0);
        assert.equal(data.data, "");
      } finally {
        cleanupEnv(e.savedEnv, e.savedCwd, e.tmp);
      }
    });

    it("reads the log from data/log with offset support", async () => {
      const e = makeEnv();
      try {
        const logDir = join(getDataDir(), "log");
        mkdirSync(logDir, { recursive: true });
        const content = "hello paaw console\nsecond line\n";
        writeFileSync(join(logDir, "server-console.log"), content, "utf-8");

        const first = await req(e.handler, "/api/paaw-log");
        assert.equal(first.status, 200);
        assert.equal(first.data.exists, true);
        assert.equal(first.data.data, content, "full read from offset 0");
        assert.equal(first.data.size, Buffer.byteLength(content, "utf-8"));
        assert.equal(first.data.nextOffset, Buffer.byteLength(content, "utf-8"));

        // Re-poll from the returned offset → no new bytes.
        const second = await req(e.handler, `/api/paaw-log?offset=${first.data.nextOffset}`);
        assert.equal(second.status, 200);
        assert.equal(second.data.data, "", "offset at EOF → empty tail");
        assert.equal(second.data.nextOffset, Buffer.byteLength(content, "utf-8"));
      } finally {
        cleanupEnv(e.savedEnv, e.savedCwd, e.tmp);
      }
    });

    it("clamps an out-of-range offset to EOF rather than throwing", async () => {
      const e = makeEnv();
      try {
        const logDir = join(getDataDir(), "log");
        mkdirSync(logDir, { recursive: true });
        writeFileSync(join(logDir, "server-console.log"), "abc", "utf-8");
        const { status, data } = await req(e.handler, "/api/paaw-log?offset=99999");
        assert.equal(status, 200);
        assert.equal(data.data, "", "offset beyond EOF clamps → empty");
        assert.equal(data.nextOffset, 3);
      } finally {
        cleanupEnv(e.savedEnv, e.savedCwd, e.tmp);
      }
    });
  });

  // ── 9. POST /api/start | stop | restart — HTTP contract + guards ──
  describe("POST /api/start|stop|restart guards", () => {
    it("start with nothing installed → 202 accepted (async job kicked off)", async () => {
      const e = makeEnv();
      try {
        const { status, data } = await req(e.handler, "/api/start", {
          method: "POST",
          headers: { origin: "http://127.0.0.1:4290" },
        });
        assert.equal(status, 202);
        assert.equal(data.ok, true);
        // uiStart returns { ok:false, message:"尚未安裝任何版本" } before any spawn
        // (no current.json → early return), so nothing is launched.
      } finally {
        cleanupEnv(e.savedEnv, e.savedCwd, e.tmp);
      }
    });

    it("stop when not running → 202 accepted (no-op job)", async () => {
      const e = makeEnv();
      try {
        const { status, data } = await req(e.handler, "/api/stop", {
          method: "POST",
          headers: { origin: "http://127.0.0.1:4290" },
        });
        assert.equal(status, 202);
        assert.equal(data.ok, true);
      } finally {
        cleanupEnv(e.savedEnv, e.savedCwd, e.tmp);
      }
    });

    it("restart when not running and nothing installed → 202 accepted (no spawn)", async () => {
      const e = makeEnv();
      try {
        const { status, data } = await req(e.handler, "/api/restart", {
          method: "POST",
          headers: { origin: "http://127.0.0.1:4290" },
        });
        assert.equal(status, 202);
        assert.equal(data.ok, true);
      } finally {
        cleanupEnv(e.savedEnv, e.savedCwd, e.tmp);
      }
    });

    it("start returns 409 while a job is active", async () => {
      env.job.active = true;
      env.job.kind = "update";
      const { status, data } = await req(env.handler, "/api/start", {
        method: "POST",
        headers: { origin: "http://127.0.0.1:4290" },
      });
      assert.equal(status, 409);
      assert.equal(data.ok, false);
    });
  });

  // ── 10. POST /api/update ──
  describe("POST /api/update", () => {
    it("returns 409 while a job is active", async () => {
      env.job.active = true;
      env.job.kind = "upload";
      const { status, data } = await req(env.handler, "/api/update", {
        method: "POST",
        headers: { origin: "http://127.0.0.1:4290" },
      });
      assert.equal(status, 409);
      assert.equal(data.ok, false);
      assert.match(data.message, /upload/);
    });

    it("accepts with 202 against a dead package server (update job kicked off)", async () => {
      const e = makeEnv();
      try {
        await withFetch(refusingFetch, async () => {
          const { status, data } = await req(e.handler, "/api/update", {
            method: "POST",
            headers: { origin: "http://127.0.0.1:4290" },
          });
          assert.equal(status, 202);
          assert.equal(data.ok, true);
        });
      } finally {
        cleanupEnv(e.savedEnv, e.savedCwd, e.tmp);
      }
    });
  });

  // ── 11. POST /api/upload ──
  describe("POST /api/upload", () => {
    it("rejects a wrong Content-Type with 415", async () => {
      const { status, data } = await req(env.handler, "/api/upload", {
        method: "POST",
        headers: { origin: "http://127.0.0.1:4290", "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(status, 415);
      assert.equal(data.ok, false);
      assert.match(data.message, /Content-Type/);
    });

    it("rejects an empty body (correct Content-Type) with 400", async () => {
      const { status, data } = await req(env.handler, "/api/upload", {
        method: "POST",
        headers: { origin: "http://127.0.0.1:4290", "content-type": "application/zip" },
      });
      assert.equal(status, 400);
      assert.equal(data.ok, false);
      assert.match(data.message, /空 body/);
    });

    it("accepts application/x-zip variant with 202 (job kicked off; fake zip fails before npm)", async () => {
      const e = makeEnv();
      try {
        const { status, data } = await req(e.handler, "/api/upload", {
          method: "POST",
          headers: { origin: "http://127.0.0.1:4290", "content-type": "application/x-zip" },
          body: Buffer.from("PK\u0003\u0004 not a real zip"),
        });
        assert.equal(status, 202);
        assert.equal(data.ok, true);
        // installUploadedZip rejects a zip with no paaw-manifest.json and a
        // non paaw-x.y.z.zip label BEFORE stageInstall/npm install, so no spawn.
      } finally {
        cleanupEnv(e.savedEnv, e.savedCwd, e.tmp);
      }
    });

    it("returns 409 while a job is active", async () => {
      env.job.active = true;
      env.job.kind = "update";
      const { status, data } = await req(env.handler, "/api/upload", {
        method: "POST",
        headers: { origin: "http://127.0.0.1:4290", "content-type": "application/zip" },
        body: "x",
      });
      assert.equal(status, 409);
      assert.equal(data.ok, false);
    });
  });

  // ── 12. Unknown route ──
  describe("unknown routes", () => {
    it("returns 404 for an unmapped GET path", async () => {
      const { status, data } = await req(env.handler, "/api/nope");
      assert.equal(status, 404);
      assert.match(data.error || "", /not found/);
    });
  });
});
