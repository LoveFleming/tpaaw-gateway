/**
 * Unit tests — review board RR-20261018-1738-6f2e 全 scope minor 收斂
 * （TASK-043）/ framework: node:test
 *
 * 每個 case 對應一個 review minor，逐一鎖定行為。原本恆真 / 缺失的斷言在
 * 各模組既有測試檔補齊或修正，這裡集中放「跨模組、以真實 handler 驅動」的
 * 幾項：
 *   - minor#2  login 的 hash 升級持久化失敗必須留下 audit event（不得靜默）
 *   - minor#3  restore 前置 stop 失敗 → HTTP 409（body 仍為 { ok:false, stage }）
 *   - minor#8  event log append 失敗 → console.warn（去重，不洗版）
 *
 * In-process only（ADR-004）：不 spawn、不 bind socket。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "../../src/server.mjs";
import { createConfig } from "../../src/server/config.mjs";
import { createEventLog } from "../../src/server/events.mjs";
import { call } from "../helpers/inject.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(__dirname, "..", "..", "src");

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gw-minors-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** 建立一個隔離環境（temp config/event log/backup dir），回傳 createApp 注入物 */
function makeEnv({ overrides = {}, configOverrides = {} } = {}) {
  const paawRoot = join(tmp, "paaw-root");
  const backupDir = join(tmp, "backups");
  const eventLogPath = join(tmp, "events.jsonl");
  mkdirSync(join(paawRoot, "data"), { recursive: true });
  mkdirSync(join(paawRoot, ".paaw"), { recursive: true });
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(paawRoot, "data", "db.json"), '{"seed":1}');

  const configPath = join(tmp, "config.json");
  writeFileSync(configPath, JSON.stringify({
    host: "127.0.0.1",
    port: 4199,
    paawRoot,
    paawServerCmd: "node no-such-file.mjs",
    paawServerPort: 4990,
    backupDir,
    autoStartPaaw: false,
    users: [{ id: "admin", name: "Admin", role: "admin", passwordHash: "legacy-plain-pw" }],
    sessionMaxAge: 86_400_000,
    ...configOverrides,
  }));

  const saved = new Map();
  const envVars = {
    PAAW_CONFIG: configPath,
    PAAW_ROOT: paawRoot,
    PAAW_BACKUP_DIR: backupDir,
    PAAW_EVENT_LOG: eventLogPath,
  };
  for (const [k, v] of Object.entries(envVars)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  let cfg;
  try {
    cfg = createConfig(SRC_DIR);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const app = createApp({ cfg, ...overrides });
  return { app, cfg, paawRoot, backupDir, eventLogPath };
}

const loginBody = { userId: "admin", password: "legacy-plain-pw" };

// ══════════════════════════════════════════════════════════════
// minor#2 — saveCredentialUpgrades 失敗不得被空 catch 吞掉
// ══════════════════════════════════════════════════════════════
describe("minor#2 — hash 升級持久化失敗留下 audit event（不再靜默）", () => {
  test("持久化拋錯 → login 仍 200，但 events 有 password_upgrade_persist_failed", async () => {
    const cfg = {
      config: { port: 4199, sessionMaxAge: 86_400_000, users: [{ id: "admin", name: "Admin", role: "admin", passwordHash: "legacy-plain-pw" }] },
      saveCredentialUpgrades: () => { throw new Error("EACCES: config.json read-only"); },
      PAAW_ROOT: tmp,
      BACKUP_DIR: join(tmp, "bk"),
      EVENT_LOG_PATH: join(tmp, "ev.jsonl"),
      MAX_BACKUPS: 1,
      BACKUP_SOURCE_DIRS: [],
    };
    const app = createApp({ cfg });

    const res = await call(app, {
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(loginBody),
    });

    assert.equal(res.status, 200, "持久化失敗不得讓登入失敗");
    assert.ok(res.data.token, "login 仍要回 token");
    const failed = app.events.filter((e) => e.type === "password_upgrade_persist_failed");
    assert.equal(failed.length, 1, `must log exactly one failure event, got: ${app.events.map((e) => e.type)}`);
    assert.match(failed[0].detail, /EACCES/, "detail 必須帶出失敗原因");
    assert.equal(failed[0].userId, "admin", "事件要歸屬到登入的使用者");
  });

  test("持久化成功 → 不寫失敗事件", async () => {
    const env = makeEnv();
    const res = await call(env.app, {
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(loginBody),
    });
    assert.equal(res.status, 200);
    assert.equal(
      env.app.events.some((e) => e.type === "password_upgrade_persist_failed"),
      false,
      "成功路徑不得出現失敗事件",
    );
  });
});

// ══════════════════════════════════════════════════════════════
// minor#3 — restore 前置 stop 失敗 → 409（不是成功語意的 200）
// ══════════════════════════════════════════════════════════════
describe("minor#3 — restore 前置 stop 失敗回 409", () => {
  test("stopPaaw 回 ok:false → HTTP 409，body 保留 { ok:false, stage:'stop' }", async () => {
    const loginOk = { createSession: () => "t", validateSession: () => ({ userId: "admin", created: Date.now() }) };
    const paawControl = {
      getPaawProcess: () => ({ pid: 999999 }), // 「有行程在跑」 → 走 stop 前置
      stopPaaw: async () => ({ ok: false, error: "SIGTERM failed: kill EPERM" }),
      startPaaw: () => ({ ok: true }),
      restartPaaw: async () => ({ ok: true }),
      healthCheckPaaw: async () => ({ status: "ok" }),
      upgradePaaw: async () => ({ ok: true }),
      getSystemHealth: () => ({}),
      getCurrentVersion: () => "unknown",
      getGitInfo: () => ({ branch: "unknown", behind: 0 }),
      getLatestVersion: async () => null,
    };
    let restoreCalled = false;
    const backup = {
      backupPath: () => "",
      listBackups: () => [],
      createBackup: () => ({ ok: true }),
      restoreBackup: () => { restoreCalled = true; return { ok: true }; },
    };
    const env = makeEnv();
    const app = createApp({ cfg: env.cfg, auth: loginOk, paawControl, backup });

    const res = await call(app, {
      method: "POST",
      url: "/api/backups/restore/paaw-backup-2026-10-22-10.tar.gz",
      token: "t",
    });

    assert.equal(res.status, 409, `stop 失敗必須回 409，實得 ${res.status}`);
    assert.equal(res.data.ok, false, "body.ok 必須是 false（UI 消費 ok 決定是否顯示錯誤）");
    assert.equal(res.data.stage, "stop");
    assert.match(res.data.error, /Stop failed before restore/);
    assert.equal(restoreCalled, false, "stop 失敗時絕不可執行 restore");
  });
});

// ══════════════════════════════════════════════════════════════
// minor#8 — event log append 失敗：warn 一次（去重）
// ══════════════════════════════════════════════════════════════
describe("minor#8 — appendFileSync 失敗不以空 catch 吞掉", () => {
  test("寫入失敗 → console.warn 一次；連續同樣失敗不洗版；成功後重置", () => {
    // 用「路徑本身是目錄」製造 appendFileSync 的 EISDIR，穩定且跨平台。
    const dirAsLog = join(tmp, "log-is-a-dir");
    mkdirSync(dirAsLog, { recursive: true });

    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(" ")); };
    try {
      const { events, logEvent } = createEventLog(dirAsLog);
      logEvent("a", "first");
      logEvent("b", "second");
      logEvent("c", "third");

      assert.equal(events.length, 3, "記憶體 ring buffer 仍要收下所有事件");
      assert.equal(warnings.length, 1, `相同失敗只能 warn 一次，實得 ${warnings.length}: ${warnings}`);
      assert.match(warnings[0], /audit log append failed/);
      assert.match(warnings[0], /events continue in memory only/);
      assert.doesNotMatch(warnings[0], /first|second|third/, "warn 不得把事件內容外洩成噪音");
    } finally {
      console.warn = origWarn;
    }
  });

  test("寫入成功 → 不產生任何 warning", () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(" ")); };
    try {
      const { logEvent } = createEventLog(join(tmp, "ok.jsonl"));
      logEvent("a", "fine");
      assert.equal(warnings.length, 0);
    } finally {
      console.warn = origWarn;
    }
  });
});
