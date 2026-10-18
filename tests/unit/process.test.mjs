/**
 * Unit tests — src/lib/process.mjs
 * TASK-021 / framework: node:test
 *
 * 隔離策略：
 *  - 這支只測「不真的啟動 PAAW」的路徑：狀態 getter/setter、paawRunning、
 *    childFailReason（餵 fake child 物件）、killChild 對已退出 child 的 no-op。
 *  - 需要真子行程的案例用 process.execPath 跑一個立即結束的 node -e，屬無害指令。
 *  - isPortOccupied / waitForHealthy 依賴網路，不在此測（屬 e2e 範疇）。
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  getPaawChild, setPaawChild,
  getPaawChildVersion, setPaawChildVersion,
  getLastStartFail, setLastStartFail,
  paawRunning,
  setSemgrepDetectedProvider,
  childFailReason,
  killChild,
} from "../../src/lib/process.mjs";

beforeEach(() => {
  // 每個案例前重置共享狀態，確保隔離
  setPaawChild(null);
  setPaawChildVersion(null);
  setLastStartFail(null);
});

// ---------- 狀態 getter / setter ----------
describe("src/lib/process.mjs — child state", () => {
  test("paawChild 預設 null，set 後可讀回", () => {
    assert.equal(getPaawChild(), null);
    const fake = { exitCode: null };
    setPaawChild(fake);
    assert.equal(getPaawChild(), fake);
  });

  test("paawChildVersion 預設 null，set 後可讀回", () => {
    assert.equal(getPaawChildVersion(), null);
    setPaawChildVersion("1.2.3");
    assert.equal(getPaawChildVersion(), "1.2.3");
  });

  test("LAST_START_FAIL 預設 null，set 後可讀回", () => {
    assert.equal(getLastStartFail(), null);
    setLastStartFail("boom");
    assert.equal(getLastStartFail(), "boom");
  });
});

// ---------- paawRunning ----------
describe("src/lib/process.mjs — paawRunning", () => {
  test("child 為 null → false", () => {
    assert.equal(paawRunning(), false);
  });

  test("child.exitCode 為 null（存活）→ true", () => {
    setPaawChild({ exitCode: null });
    assert.equal(paawRunning(), true);
  });

  test("child.exitCode 為數字（已退出）→ false", () => {
    setPaawChild({ exitCode: 0 });
    assert.equal(paawRunning(), false);
  });

  test("child.exitCode 為 1（異常退出）→ false", () => {
    setPaawChild({ exitCode: 1 });
    assert.equal(paawRunning(), false);
  });
});

// ---------- setSemgrepDetectedProvider ----------
describe("src/lib/process.mjs — setSemgrepDetectedProvider", () => {
  test("可注入 provider 且不丟例外（純賦值）", () => {
    assert.doesNotThrow(() => setSemgrepDetectedProvider(() => "/usr/local/bin/semgrep"));
    // 還原成預設，避免影響其他案例
    setSemgrepDetectedProvider(() => "");
  });
});

// ---------- childFailReason ----------
describe("src/lib/process.mjs — childFailReason", () => {
  test("spawn error → 訊息含 'spawn 失敗' 與 error code", () => {
    const child = { __spawnError: "ENOENT", exitCode: null, signalCode: null, __tail: "" };
    const r = childFailReason(child);
    assert.match(r, /spawn 失敗/);
    assert.match(r, /ENOENT/);
  });

  test("一般退出 → 含 exitCode", () => {
    const child = { __spawnError: null, exitCode: 1, signalCode: null, __tail: "" };
    const r = childFailReason(child);
    assert.match(r, /exitCode=1/);
  });

  test("被 signal 殺 → 含 signal 名稱", () => {
    const child = { __spawnError: null, exitCode: null, signalCode: "SIGKILL", __tail: "" };
    const r = childFailReason(child);
    assert.match(r, /signal=SIGKILL/);
  });

  test("exitCode 為 null 且無 signal → exitCode=? placeholder", () => {
    const child = { __spawnError: null, exitCode: null, signalCode: null, __tail: "" };
    assert.match(childFailReason(child), /exitCode=\?/);
  });

  test("有 __tail → 附上『child 輸出最後幾行』與內容", () => {
    const child = { __spawnError: null, exitCode: 1, signalCode: null, __tail: "Cannot find module tsx\nat line 1" };
    const r = childFailReason(child);
    assert.match(r, /child 輸出最後幾行/);
    assert.match(r, /Cannot find module tsx/);
  });

  test("__tail 只有空白行 → 不附輸出區塊（避免噪音）", () => {
    const child = { __spawnError: null, exitCode: 1, signalCode: null, __tail: "\n  \n\n" };
    const r = childFailReason(child);
    assert.equal(r.includes("child 輸出最後幾行"), false);
  });
});

// ---------- killChild ----------
describe("src/lib/process.mjs — killChild", () => {
  test("child 為 null → 立即 resolve（no-op）", async () => {
    await assert.doesNotReject(() => killChild(null));
  });

  test("child 已退出（exitCode !== null）→ 立即 resolve，不送訊號", async () => {
    let killed = false;
    const child = { exitCode: 0, kill: () => { killed = true; } };
    await killChild(child);
    assert.equal(killed, false);
  });

  test("存活的 child 會被送 SIGTERM，並在 exit 後 resolve", async () => {
    // fake live child：exitCode=null，once/kill 可觀察
    const handlers = {};
    const signals = [];
    const child = {
      exitCode: null,
      once: (ev, cb) => { handlers[ev] = cb; return child; },
      kill: (sig) => { signals.push(sig); return true; },
    };
    const p = killChild(child);
    // killChild 可能同步或非同步送出 SIGTERM（例如內部先 await 前置步驟）。
    // 先讓出一個 microtask，使斷言對兩種實作都穩定，仍驗證 SIGTERM 已送出。
    await Promise.resolve();
    assert.ok(signals.includes("SIGTERM"));
    // 模擬 child 退出 → resolve
    child.exitCode = 0;
    handlers.exit?.();
    await assert.doesNotReject(() => p);
  });
});
