/**
 * Unit tests — restore 前置 stop 的稽核歸因（review board round-2, src/server.mjs:331）
 *
 * 問題：POST /api/backups/restore/<file> 在 restore 前呼叫 stopPaaw() 未傳 userId
 *       → server_stopping / server_stopped / server_stop_failed 被歸因為 "system"，
 *       而不是發起操作的管理員。
 * 修法：restore handler 改傳 currentUser.id（TASK-042 已為 stopPaaw 加上可選
 *       userId 參數，直接沿用）。
 *
 * 測試策略（ADR-004：不 listen、不 spawn gateway）：
 *   - createApp({ cfg, events, paawControl, backup }) 注入完全可控的替身，
 *     只驗證「route 是否把 currentUser.id 傳給 stopPaaw」這一個契約。
 *   - 稽核歸因以假的 logEvent 收集（不必碰檔案）。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createApp } from "../../src/server.mjs";
import { createConfig } from "../../src/server/config.mjs";
import { call } from "../helpers/inject.mjs";

const SRC_DIR = resolve("src");
const ADMIN = { id: "admin1", name: "Admin", role: "admin", passwordHash: "plain-admin-pw" };

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gw-restore-attr-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of ["PAAW_CONFIG", "PAAW_GATEWAY_PASSWORD", "PAAW_GATEWAY_PASSWORD_HASH"]) {
    delete process.env[k];
  }
});

/**
 * Build an app whose paaw-control / backup are fakes, so the restore route can be
 * driven deterministically. Returns helpers to inspect what the route did.
 *
 * @param {object} opts
 * @param {boolean} opts.processRunning whether getPaawProcess() reports a live child
 * @param {boolean} opts.stopOk       whether the fake stopPaaw resolves ok
 */
function buildApp({ processRunning = true, stopOk = true } = {}) {
  const configPath = join(tmp, "config.json");
  writeFileSync(configPath, JSON.stringify({
    host: "127.0.0.1",
    port: 4199,
    users: [ADMIN],
    sessionMaxAge: 60000,
  }), "utf-8");
  process.env.PAAW_CONFIG = configPath;

  const cfg = createConfig(SRC_DIR);

  const audit = [];
  const logEvent = (type, detail, userId) => audit.push({ type, detail, userId });
  const events = { events: [], logEvent };

  const stopCalls = [];
  const restoreCalls = [];
  const paawControl = {
    startPaaw: () => ({ ok: true, pid: 1111 }),
    // Only the userId argument matters for this contract.
    stopPaaw: async (userId) => {
      stopCalls.push({ userId });
      return stopOk ? { ok: true } : { ok: false, error: "stop refused" };
    },
    restartPaaw: async () => ({ ok: true, pid: 2222 }),
    healthCheckPaaw: async () => ({ ok: true, detail: "Healthy" }),
    upgradePaaw: async () => ({ ok: true }),
    getSystemHealth: () => ({}),
    getCurrentVersion: () => "1.0.0",
    getGitInfo: () => ({ branch: "main", commit: "abc1234", date: "?", dirty: false, behind: 0 }),
    getLatestVersion: () => "v1.0.0",
    getPaawProcess: () => (processRunning ? { pid: 999 } : null),
    isRunning: () => processRunning,
  };

  const backup = {
    backupPath: () => null,
    listBackups: () => [],
    createBackup: () => ({ ok: true }),
    restoreBackup: (filename, userId) => {
      restoreCalls.push({ filename, userId });
      return { ok: true, pid: 3333 };
    },
  };

  // auth is the real one (it only needs cfg.config.users) so we get a real token.
  const app = createApp({ cfg, events, paawControl, backup });
  return { app, audit, stopCalls, restoreCalls };
}

async function login(app, user) {
  const res = await call(app, {
    method: "POST",
    url: "/api/auth/login",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: user.id, password: user.passwordHash }),
  });
  assert.equal(res.status, 200, `login failed: ${JSON.stringify(res.data)}`);
  return res.data.token;
}

describe("restore 前置 stop 的稽核歸因（src/server.mjs:331）", () => {
  test("(d) restore 觸發的 stopPaaw 帶 admin userId（不是 'system'）", async () => {
    const { app, stopCalls, restoreCalls } = buildApp({ processRunning: true, stopOk: true });
    const token = await login(app, ADMIN);

    const res = await call(app, {
      method: "POST",
      url: "/api/backups/restore/paaw-backup-2026-01-01-00.tar.gz",
      token,
    });

    assert.equal(res.status, 200, `restore should succeed: ${JSON.stringify(res.data)}`);
    assert.equal(stopCalls.length, 1, "restore must stop the running server exactly once");
    assert.equal(stopCalls[0].userId, ADMIN.id,
      "restore 前置 stop 必須歸因到發起的管理員，而非 'system'");
    // restore 本身同樣帶 userId（既有行為 + 委員建議）
    assert.equal(restoreCalls.length, 1);
    assert.equal(restoreCalls[0].userId, ADMIN.id);
  });

  test("stop 失敗時稽核歸因仍為 admin（409 分支）", async () => {
    const { app, stopCalls, restoreCalls } = buildApp({ processRunning: true, stopOk: false });
    const token = await login(app, ADMIN);

    const res = await call(app, {
      method: "POST",
      url: "/api/backups/restore/paaw-backup-2026-01-01-00.tar.gz",
      token,
    });

    assert.equal(res.status, 409, "stop failure must be a fail-closed 409");
    assert.equal(stopCalls[0].userId, ADMIN.id, "失敗的 stop 也必須歸因到 admin");
    assert.equal(restoreCalls.length, 0, "stop 失敗時不得進入 restore");
  });
});
