/**
 * Unit tests — src/server/paaw-control.mjs (PAAW child-process lifecycle)
 * TASK-021 / framework: node:test
 *
 * 隔離策略：createPaawControl(deps) 以依賴注入建立，所有外部依賴都用 fake：
 *  - config.paawServerCmd 指向一個「絕對不會真的啟動」的無害指令：
 *    以 process.execPath（當前 node）+ `-e "setTimeout(()=>{},300000)"` 組合，
 *    跨平台（不依賴外部 sleep 指令 / shell），且只在「真的呼叫 startPaaw」
 *    的案例使用，其他案例用 guard / 純邏輯。
 *    注意：startPaaw 以 split(" ") 拆解指令，故 -e 的 script 不可含空白。
 *  - 需要避免殘留子行程：呼叫 startPaaw 的案例一定在 afterEach 收掉，
 *    或改用「已 running 的 guard」路徑（不真的 spawn）。
 *  - healthCheckPaaw 依賴 fetch：用 paawStatus 非 running 的早期 return 測，不碰網路。
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPaawControl } from "../../src/server/paaw-control.mjs";

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gw-paawctl-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// 建立一個不會真的做事的 control（cmd 指向一個跨平台無害的 node 長睡 script，
// 只有在明確啟動時才 spawn）。
// 使用 process.execPath + `-e` 而非外部 `sleep` 指令：sleep 在 Windows 不存在，
// 會造成跨平台 flake；node -e 則跨平台一致。script 不含空白，符合 startPaaw 的
// split(" ") 拆解方式（cmd=node, args=["-e", "setTimeout(()=>{},300000)"]）。
const NOOP_SERVER_CMD = `${process.execPath} -e "setTimeout(()=>{},300000)"`;

function makeControl(overrides = {}) {
  const logged = [];
  const deps = {
    config: { paawServerCmd: NOOP_SERVER_CMD, paawServerPort: 4097, ...(overrides.config || {}) },
    PAAW_ROOT: tmp,
    logEvent: (type, detail, userId) => logged.push({ type, detail, userId }),
    ...overrides,
  };
  return { control: createPaawControl(deps), logged };
}

describe("src/server/paaw-control.mjs — 初始狀態", () => {
  test("初始 isRunning 為 false，getPaawProcess 為 null", () => {
    const { control } = makeControl();
    assert.equal(control.isRunning(), false);
    assert.equal(control.getPaawProcess(), null);
  });

  test("getSystemHealth 回傳 paawServer.status=stopped 且無 pid", () => {
    const { control } = makeControl();
    const h = control.getSystemHealth();
    assert.equal(h.paawServer.status, "stopped");
    assert.equal(h.paawServer.pid, null);
    assert.equal(h.paawServer.restartCount, 0);
    assert.equal(typeof h.nodeVersion, "string");
    assert.match(h.memory.rss, / MB$/);
  });

  test("stopPaaw 對未執行的服務回 { ok:false, error:'Not running' }", async () => {
    const { control } = makeControl();
    const r = await control.stopPaaw();
    assert.equal(r.ok, false);
    assert.match(r.error, /Not running/);
  });
});

describe("src/server/paaw-control.mjs — getCurrentVersion", () => {
  test("讀 PAAW_ROOT/package.json 的 version", () => {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ version: "9.8.7" }));
    const { control } = makeControl();
    assert.equal(control.getCurrentVersion(), "9.8.7");
  });

  test("package.json 不存在 → 'unknown'", () => {
    const { control } = makeControl();
    assert.equal(control.getCurrentVersion(), "unknown");
  });

  test("package.json 無 version 欄位 → 'unknown'", () => {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));
    const { control } = makeControl();
    assert.equal(control.getCurrentVersion(), "unknown");
  });

  test("package.json 非法 JSON → 'unknown'（不丟例外）", () => {
    writeFileSync(join(tmp, "package.json"), "{ broken");
    const { control } = makeControl();
    assert.equal(control.getCurrentVersion(), "unknown");
  });
});

describe("src/server/paaw-control.mjs — getGitInfo（非 git 目錄）", () => {
  test("PAAW_ROOT 非 git repo → 回 fallback 物件且不丟例外", () => {
    const { control } = makeControl();
    const info = control.getGitInfo();
    // 在 temp dir 執行 git 會失敗 → fallback
    assert.equal(typeof info, "object");
    assert.equal(info.branch, "unknown");
    assert.equal(info.behind, 0);
    assert.ok("error" in info);
  });
});

describe("src/server/paaw-control.mjs — startPaaw / logEvent", () => {
  test("startPaaw 回 ok:true + pid，並發 server_starting/server_started 事件", async () => {
    const { control, logged } = makeControl();
    const r = control.startPaaw();
    try {
      assert.equal(r.ok, true);
      assert.equal(typeof r.pid, "number");
      assert.equal(control.isRunning(), true);
      const types = logged.map((l) => l.type);
      assert.ok(types.includes("server_starting"));
      assert.ok(types.includes("server_started"));
    } finally {
      await control.stopPaaw();
    }
  });

  test("重複 startPaaw（已在執行）→ { ok:false, error:'Already running' }", async () => {
    const { control } = makeControl();
    const first = control.startPaaw();
    try {
      const second = control.startPaaw();
      assert.equal(second.ok, false);
      assert.match(second.error, /Already running/);
    } finally {
      await control.stopPaaw();
    }
  });

  test("startPaaw 後 getSystemHealth 反映 running + pid + 遞增 uptime 欄位", async () => {
    const { control } = makeControl();
    control.startPaaw();
    try {
      const h = control.getSystemHealth();
      assert.equal(h.paawServer.status, "running");
      assert.equal(typeof h.paawServer.pid, "number");
      assert.equal(typeof h.paawServer.uptime, "number");
    } finally {
      await control.stopPaaw();
    }
  });

  test("restartPaaw 在未執行時等同 start", async () => {
    const { control, logged } = makeControl();
    const r = await control.restartPaaw();
    try {
      assert.equal(r.ok, true);
      assert.ok(logged.map((l) => l.type).includes("server_restarted"));
    } finally {
      await control.stopPaaw();
    }
  });
});

describe("src/server/paaw-control.mjs — healthCheckPaaw（未執行）", () => {
  test("status !== running → { ok:false, detail:'Server not running' }（不呼叫 fetch）", async () => {
    const { control } = makeControl();
    const r = await control.healthCheckPaaw();
    assert.equal(r.ok, false);
    assert.equal(r.detail, "Server not running");
  });
});

// ── upgradePaaw：失敗仍嘗試把 server 拉回 / stash pop 失敗要示警 ──
// exec 以 deps.exec 注入 fake，避免真的跑 git / npm；startPaaw 仍走真 spawn
// （NOOP_SERVER_CMD 為無害長睡 node script，afterEach 由 control.stopPaaw 收掉）。
describe("src/server/paaw-control.mjs — upgradePaaw（npm install 失敗仍重啟）", () => {
  test("npm install throw → 仍呼叫 startPaaw 拉回 server，回傳 ok:false + recovered:true + 明確 error", async () => {
    const calls = [];
    // fake exec：所有 git / npm 指令都成功，唯獨 npm install 丟例外。
    const fakeExec = (cmd) => {
      calls.push(cmd);
      if (cmd.startsWith("npm install")) throw new Error("npm ERR! network timeout");
      return "ok";
    };
    const { control, logged } = makeControl({ exec: fakeExec });
    try {
      const r = await control.upgradePaaw("admin1");

      // 升級本身失敗
      assert.equal(r.ok, false);
      // 但 server 已被拉回（major#1 的核心要求）
      assert.equal(r.recovered, true);
      assert.equal(control.isRunning(), true, "server should be restarted after failed upgrade");

      // error 訊息要講清楚：升級失敗 + 已嘗試重啟（成功）
      assert.match(r.error, /Upgrade failed/);
      assert.match(r.error, /restarted/);

      // steps 內要有 npm install（失敗）與 restart server（成功）
      const npmStep = r.steps.find((s) => s.step === "npm install");
      const restartStep = r.steps.find((s) => s.step === "restart server");
      assert.equal(npmStep.ok, false);
      assert.equal(restartStep.ok, true);

      // events 應記錄 recover
      const types = logged.map((l) => l.type);
      assert.ok(types.includes("upgrade_recovered"), `expected upgrade_recovered, got ${types}`);
    } finally {
      await control.stopPaaw();
    }
  });

  test("成功路徑：回傳仍帶 warnings 陣列（additive，不破壞既有欄位）", async () => {
    const fakeExec = () => "ok";
    const { control } = makeControl({ exec: fakeExec });
    try {
      const r = await control.upgradePaaw("admin1");
      assert.equal(r.ok, true);
      assert.ok(Array.isArray(r.warnings), "warnings must be an array even when empty");
      assert.equal(r.warnings.length, 0);
      // 既有欄位維持
      assert.ok(Array.isArray(r.steps));
      assert.ok("version" in r);
      assert.ok("git" in r);
    } finally {
      await control.stopPaaw();
    }
  });
});

describe("src/server/paaw-control.mjs — upgradePaaw（git stash pop 失敗示警）", () => {
  test("git stash pop throw → 回傳含 warnings + step 標 warning:true，ok 不受影響", async () => {
    const fakeExec = (cmd) => {
      if (cmd === "git stash pop") throw new Error("CONFLICT (content): merge conflict");
      return "ok";
    };
    const { control } = makeControl({ exec: fakeExec });
    try {
      const r = await control.upgradePaaw("admin1");

      // stash pop 失敗不是致命錯誤，升級本身仍可完成
      assert.equal(r.ok, true);
      assert.ok(Array.isArray(r.warnings));
      assert.equal(r.warnings.length, 1, "should surface exactly one warning");
      assert.match(r.warnings[0], /stash pop failed/);

      // 對應 step 要標記 warning，讓前端能凸顯
      const step = r.steps.find((s) => s.step === "git stash pop");
      assert.equal(step.ok, false);
      assert.equal(step.warning, true);
    } finally {
      await control.stopPaaw();
    }
  });

  test("git stash 無 stash（throw）維持 ok:true，不產生 warning", async () => {
    const fakeExec = (cmd) => {
      if (cmd === "git stash") throw new Error("No local changes to save");
      return "ok";
    };
    const { control } = makeControl({ exec: fakeExec });
    try {
      const r = await control.upgradePaaw("admin1");
      assert.equal(r.ok, true);
      assert.equal(r.warnings.length, 0);
      const step = r.steps.find((s) => s.step === "git stash");
      assert.equal(step.ok, true);
      assert.equal(step.note, "nothing to stash");
    } finally {
      await control.stopPaaw();
    }
  });
});
