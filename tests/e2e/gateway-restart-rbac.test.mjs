/**
 * E2E tests — TASK-009：驗證 TASK-008 的 F-01（restart/stop exit-confirmed）
 * 與 F-02（備份/進程端點 admin check）修復（feature F20260918-002）。
 *
 * 隔離策略（與 gateway-backup-auth.test.mjs 同款）：
 *  - spawn 真 src/server.mjs（PAAW_CONFIG knob → throwaway config / 隨機 port）
 *  - PAAW_ROOT / PAAW_BACKUP_DIR / PAAW_EVENT_LOG 全指到 mkdtemp temp dir
 *  - PAAW Server 以「可控 stub child」取代：SIGTERM 行為由 mode file 切換
 *      fast     → 立即 exit（正常路徑）
 *      delayed  → 800ms 後 exit（驗證回應等的是 exit 事件，不是訊號送達）
 *      stubborn → 忽視 SIGTERM（驗證 5s SIGKILL 升級 + 誠實回報）
 *  - stub 註冊 handler 後寫 ready 檔；每個發訊號的斷言前都先等 ready
 *    （probe 實測：不等 ready 會在 stub 註冊 handler 前送 SIGTERM，走 default
 *     disposition 秒退 — 那是測試設計 race，不是產品行為）
 *
 * ⚠️ 與 QA review 建議 case 2 的差異（probe 實證 2026-09-19，見 TASK-009 報告）：
 *    QA 期望「stubborn child → 10s failsafe → restart ok:false」，實測不可達 —
 *    stopPaaw 在 5s 升級 SIGKILL，SIGKILL 無法被 user-space 忽視 → 必產生 exit
 *    事件 → stop 誠實回 ok:true（~5s）→ restart ok:true。10s failsafe 是
 *    defense-in-depth（僅在 Node 事件迴圈卡死等異常下觸發），E2E 無法到達。
 *    因此本測試改驗「誠實合約」：elapsed ≥ 4.5s（證明等到升級+真退出，不是
 *    謊報）+ 舊 pid 真死 + 新 pid 真活。舊版 fire-and-forget bug（秒回 ok:true
 *    且舊進程還活著）會被本斷言抓到。
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "..", "src", "server.mjs");

const ADMIN = { id: "admin", name: "Admin", role: "admin", passwordHash: "e2e-admin-pw" };
const VIEWER = { id: "viewer", name: "Viewer", role: "viewer", passwordHash: "e2e-viewer-pw" };
const HEALTH_TIMEOUT_MS = 10_000;

// ── 孤兒進程保險：不論測試怎麼失敗，退出前把所有子進程斷電 ──
const ACTIVE_CHILDREN = new Set();
process.on("exit", () => {
  for (const child of ACTIVE_CHILDREN) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

/** 向 OS 要一個目前沒人用的 port（bind :0 後馬上釋放） */
function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

const pidAlive = pid => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

/**
 * 測試環境：一個 gateway 子進程 + 一個可控的 PAAW stub child script。
 * stub 的 SIGTERM 行為由 mode file（"fast" / "delayed" / "stubborn"）控制，
 * 並在 handler 註冊完成後寫 stub-ready-<pid> 檔供測試等待。
 */
class TestEnv {
  constructor() {
    this.tmp = null;
    this.gateway = null;
    this.base = null;
    this.tokens = {};
    this.stubPath = null;
    this.modeFile = null;
  }

  async setup() {
    this.tmp = mkdtempSync(join(tmpdir(), "task009-gw-"));
    const root = join(this.tmp, "root");
    mkdirSync(join(root, "data"), { recursive: true });
    this.modeFile = join(this.tmp, "stub-mode");
    writeFileSync(this.modeFile, "fast");

    // 可控 stub child（讀 mode file 決定 SIGTERM 行為；孤兒時自我退出）
    this.stubPath = join(this.tmp, "stub-child.mjs");
    writeFileSync(this.stubPath, `
import { readFileSync, writeFileSync } from "node:fs";
const MODE_FILE = ${JSON.stringify(this.modeFile)};
const READY_DIR = ${JSON.stringify(this.tmp)};
process.on("SIGTERM", () => {
  let mode = "fast";
  try { mode = readFileSync(MODE_FILE, "utf8").trim(); } catch {}
  if (mode === "stubborn") return; // ignore SIGTERM → gateway escalates to SIGKILL
  if (mode === "delayed") { setTimeout(() => process.exit(0), 800); return; }
  process.exit(0);
});
setInterval(() => { if (process.ppid === 1) process.exit(0); }, 500);
writeFileSync(READY_DIR + "/stub-ready-" + process.pid, "ready");
`);

    const port = await getFreePort();
    const configFile = join(this.tmp, "config.json");
    writeFileSync(configFile, JSON.stringify({
      port,
      paawRoot: root,
      paawServerCmd: `node ${this.stubPath}`,
      paawServerPort: 4990, // 佔位，stub 不 listen
      backupDir: join(this.tmp, "backups"),
      users: [ADMIN, VIEWER],
      sessionSecret: "task009-e2e",
      sessionMaxAge: 60000,
      autoStartPaaw: false, // 測試自己控制 start/stop/restart
    }, null, 2));

    this.gateway = spawn(process.execPath, [SERVER_PATH], {
      env: {
        ...process.env,
        PAAW_CONFIG: configFile,
        PAAW_ROOT: root,
        PAAW_BACKUP_DIR: join(this.tmp, "backups"),
        PAAW_EVENT_LOG: join(this.tmp, "events.jsonl"),
        STUB_MODE_FILE: this.modeFile,
      },
      stdio: ["ignore", "ignore", "ignore"],
    });
    ACTIVE_CHILDREN.add(this.gateway);
    this.gateway.once("exit", () => ACTIVE_CHILDREN.delete(this.gateway));
    this.base = `http://127.0.0.1:${port}`;

    // 等 gateway 起來
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    for (;;) {
      try {
        const res = await fetch(`${this.base}/api/health`);
        if (res.ok) break;
      } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error("gateway did not become healthy in time");
      await sleep(100);
    }

    for (const u of [ADMIN, VIEWER]) {
      const res = await this.api("POST", "/api/auth/login", { userId: u.id, password: u.passwordHash });
      assert.equal(res.status, 200, `login failed for ${u.id}: ${JSON.stringify(res.body)}`);
      this.tokens[u.id] = res.body.token;
    }
  }

  async api(method, path, body, userId = ADMIN.id) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(this.tokens[userId] ? { Authorization: `Bearer ${this.tokens[userId]}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  /** 等 stub child（pid）註冊好 SIGTERM handler（ready 檔出現） */
  async waitStubReady(pid, timeoutMs = 10_000) {
    const readyPath = join(this.tmp, `stub-ready-${pid}`);
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(readyPath)) {
      if (Date.now() > deadline) return false;
      await sleep(50);
    }
    return true;
  }

  setStubMode(mode) { writeFileSync(this.modeFile, mode); }

  async teardown() {
    // 先把還在跑的 PAAW stub 溫和收掉（走 fast 模式；最長 ~6s 含 SIGKILL 升級）
    this.setStubMode("fast");
    try { await this.api("POST", "/api/server/stop", undefined); } catch { /* gateway 可能已死 */ }

    if (this.gateway.exitCode === null) {
      this.gateway.kill("SIGTERM");
      const deadline = Date.now() + 3000;
      while (this.gateway.exitCode === null && Date.now() < deadline) await sleep(50);
      if (this.gateway.exitCode === null) this.gateway.kill("SIGKILL");
    }
    ACTIVE_CHILDREN.delete(this.gateway);
    rmSync(this.tmp, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════
// F-01 — restart / stop 必須 exit-confirmed（TASK-008 修復驗證）
// ═══════════════════════════════════════════════════════════════════
describe("F-01 /api/server/* exit-confirmed lifecycle (spawned gateway + controllable stub child)", () => {
  const env = new TestEnv();
  /** lifecycle 情境有狀態（stop/restart 的是同一個進程），由前一案例接手；
   *  沒接手到（前案失敗）就自己 start 一個，保持可獨立重跑 */
  let currentPid = null;

  before(async () => { await env.setup(); });
  after(async () => { await env.teardown(); });

  it("stop/restart with nothing running report honestly (no child yet)", async () => {
    const stop = await env.api("POST", "/api/server/stop");
    assert.equal(stop.status, 200);
    assert.deepEqual(stop.body, { ok: false, error: "Not running" },
      "stop with no child must fail honestly, not fabricate ok:true");

    const restart = await env.api("POST", "/api/server/restart");
    assert.equal(restart.status, 200);
    assert.equal(restart.body.ok, true, `restart on idle should fresh-start: ${JSON.stringify(restart.body)}`);
    assert.ok(restart.body.pid > 0);
    assert.ok(await env.waitStubReady(restart.body.pid), "stub child never became ready");
    currentPid = restart.body.pid;
  });

  it("restart fast-exit child: ok:true, old pid dead, NEW process up (case 1)", async () => {
    assert.ok(currentPid && pidAlive(currentPid), "precondition: a running child (from previous case)");
    env.setStubMode("fast");

    const t0 = Date.now();
    const res = await env.api("POST", "/api/server/restart");
    const elapsed = Date.now() - t0;

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true, `fast restart must succeed: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.pid > 0 && res.body.pid !== currentPid, "restart must produce a NEW pid");
    assert.ok(elapsed < 4500, `fast-exit restart should not need the 5s escalation (took ${elapsed}ms)`);
    assert.equal(pidAlive(currentPid), false, "old process must REALLY be dead (pid reaped)");
    assert.ok(pidAlive(res.body.pid), "new process must be alive");
    assert.ok(await env.waitStubReady(res.body.pid), "new stub child never became ready");
    currentPid = res.body.pid;
  });

  it("restart stubborn child (ignores SIGTERM): response only after SIGKILL-confirmed exit — never an instant ok:true (case 2, honest-contract)", async () => {
    assert.ok(currentPid && pidAlive(currentPid), "precondition: a running child");
    assert.ok(await env.waitStubReady(currentPid), "stub must have its SIGTERM handler registered before we signal");
    env.setStubMode("stubborn");

    const t0 = Date.now();
    const res = await env.api("POST", "/api/server/restart");
    const elapsed = Date.now() - t0;

    assert.equal(res.status, 200);
    // 誠實合約：訊號被忽視時，5s SIGKILL 升級 + exit 事件確認後才回應。
    // 舊版 fire-and-forget bug 會在這裡秒回 ok:true（elapsed ≪ 1000）而被抓到。
    assert.ok(elapsed >= 4500,
      `stubborn child: restart resolved in ${elapsed}ms — must have waited for the 5s SIGKILL escalation, an instant ok:true would be the old race bug`);
    assert.equal(res.body.ok, true,
      `after SIGKILL the stop legitimately succeeded, so restart must report ok:true honestly: ${JSON.stringify(res.body)}`);
    assert.equal(pidAlive(currentPid), false, "stubborn old process must be dead after SIGKILL");
    assert.ok(res.body.pid && res.body.pid !== currentPid, "restart must produce a NEW pid");
    assert.ok(pidAlive(res.body.pid), "new process must be alive (no double-start on a live port holder)");
    assert.ok(await env.waitStubReady(res.body.pid), "new stub child never became ready");
    currentPid = res.body.pid;
  });

  it("stop delayed-exit child: response arrives only AFTER the exit event (case 4, timing assertion)", async () => {
    assert.ok(currentPid && pidAlive(currentPid), "precondition: a running child");
    assert.ok(await env.waitStubReady(currentPid), "stub must have its SIGTERM handler registered");
    env.setStubMode("delayed"); // SIGTERM → 800ms 後才 exit

    const t0 = Date.now();
    const res = await env.api("POST", "/api/server/stop");
    const elapsed = Date.now() - t0;

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    // 回應必須晚於 child 的實際退出（800ms）——證明等的是 exit 事件，不是訊號送達。
    // 上界 4600ms：低於 5s SIGKILL 升級（若走到升級代表 delayed 模式失效，測試會抓到）。
    assert.ok(elapsed >= 800, `stop resolved in ${elapsed}ms — before the child's 800ms delayed exit (responded on signal-dispatch, not exit-confirm)`);
    assert.ok(elapsed < 4600, `stop took ${elapsed}ms — delayed child should exit on its own, not need SIGKILL`);
    assert.equal(pidAlive(currentPid), false, "process must be dead when stop responds");
    currentPid = null;
  });
});

// ═══════════════════════════════════════════════════════════════════
// F-02 — 備份/進程端點 admin check（TASK-008 修復驗證）
// ═══════════════════════════════════════════════════════════════════
describe("F-02 RBAC: backup/restore/upgrade/server endpoints are admin-only (case 3)", () => {
  const env = new TestEnv();
  const CRAFTED_BACKUP = "paaw-backup-2026-01-01-00.tar.gz";
  /** 受保護資料檔：restore 前後內容對比，驗證 403 時完全沒有副作用（before() 中初始化） */
  let DB_JSON;
  const MARKER = "restored-by-crafted-backup";
  const CURRENT = "current-data";

  before(async () => {
    await env.setup();
    DB_JSON = join(env.tmp, "root", "data/db.json");

    // 偽造一個合法備份檔（內含 data/db.json = MARKER），供 restore 測試
    mkdirSync(join(env.tmp, "backups"), { recursive: true });
    mkdirSync(join(env.tmp, "root/.paaw"), { recursive: true });
    writeFileSync(DB_JSON, MARKER);
    writeFileSync(join(env.tmp, "root/.paaw/flag"), "x");
    const { execFileSync } = await import("node:child_process");
    execFileSync("tar", ["czf", join(env.tmp, "backups", CRAFTED_BACKUP), "data", ".paaw"],
      { cwd: join(env.tmp, "root") });
    // 還原為「現行」內容 — 之後 admin restore 應把它變回 MARKER
    writeFileSync(DB_JSON, CURRENT);
  });

  after(async () => { await env.teardown(); });

  it("viewer POST /api/backups/create → 403, no backup side effect", async () => {
    const res = await env.api("POST", "/api/backups/create", undefined, VIEWER.id);
    assert.equal(res.status, 403, `viewer must be rejected: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "Admin only");
    const files = existsSync(join(env.tmp, "backups"))
      ? readdirSync(join(env.tmp, "backups")).filter(f => f !== CRAFTED_BACKUP)
      : [];
    assert.equal(files.length, 0, `403 must not create anything, found: ${files.join(", ")}`);
  });

  it("viewer POST /api/backups/restore/<file> → 403, PAAW_ROOT untouched (no privilege escalation)", async () => {
    const res = await env.api("POST", `/api/backups/restore/${CRAFTED_BACKUP}`, undefined, VIEWER.id);
    assert.equal(res.status, 403, `viewer must be rejected: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "Admin only");
    assert.equal(readFileSync(DB_JSON, "utf8"), CURRENT,
      "403 must not extract anything over PAAW_ROOT");
  });

  it("viewer keeps read access: GET /api/backups → 200 with listing", async () => {
    const res = await env.api("GET", "/api/backups", undefined, VIEWER.id);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.backups));
    assert.ok(res.body.backups.some(b => b.filename === CRAFTED_BACKUP),
      "crafted backup should be listed");
  });

  it("viewer is locked out of every process-mutating endpoint (start/stop/restart/upgrade)", async () => {
    for (const path of ["/api/server/start", "/api/server/stop", "/api/server/restart", "/api/upgrade"]) {
      const res = await env.api("POST", path, undefined, VIEWER.id);
      assert.equal(res.status, 403, `${path} must be admin-only`);
      assert.equal(res.body.error, "Admin only", `${path} error body`);
    }
  });

  it("admin POST /api/backups/create → NOT 403, real backup file appears", async () => {
    const res = await env.api("POST", "/api/backups/create", undefined, ADMIN.id);
    assert.notEqual(res.status, 403, "admin must not be rejected");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true, `admin createBackup: ${JSON.stringify(res.body)}`);
    const files = readdirSync(join(env.tmp, "backups"));
    assert.ok(files.some(f => /^paaw-backup-\d{4}-\d{2}-\d{2}-\d{2}\.tar\.gz$/.test(f)),
      `a real backup tarball should exist, found: ${files.join(", ")}`);
  });

  it("admin POST /api/backups/restore/<file> → NOT 403, data really restored", async () => {
    const res = await env.api("POST", `/api/backups/restore/${CRAFTED_BACKUP}`, undefined, ADMIN.id);
    assert.notEqual(res.status, 403, "admin must not be rejected");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true, `admin restore: ${JSON.stringify(res.body)}`);
    assert.equal(readFileSync(DB_JSON, "utf8"), MARKER, "crafted backup must be extracted over PAAW_ROOT");
    // restoreBackup 內含 pre-restore safety backup → 備份數應 ≥ 2（crafted + safety/created）
    const files = readdirSync(join(env.tmp, "backups"));
    assert.ok(files.length >= 2, `expected crafted + newly created backups, found: ${files.join(", ")}`);
  });
});
