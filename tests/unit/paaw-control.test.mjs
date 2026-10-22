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
import { setTimeout as sleep } from "node:timers/promises";

import { createPaawControl, resolveServerCmd } from "../../src/server/paaw-control.mjs";

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
  // stashStore() uses the argv (no-shell) seam; createPaawControl derives it
  // from an injected `exec` automatically, so a single fake covers every
  // command. No extra wiring needed here.
  return { control: createPaawControl(deps), logged };
}

// ── review board minor#9（RR-20261018-1738-6f2e）──
// paawServerCmd 支援陣列形態：路徑含空白不再被 split(" ") 拆壞。
describe("src/server/paaw-control.mjs — resolveServerCmd", () => {
  test("陣列形態原樣使用（含空白路徑不被拆解）", () => {
    const cmd = ["/opt/Program Files/node", "packages/server/src/index.mjs", "--port", "4097"];
    assert.deepEqual(resolveServerCmd(cmd), cmd);
  });

  test("陣列形態回傳副本（呼叫端事後改自己的陣列不影響 spawn 參數）", () => {
    const cmd = ["node", "index.mjs"];
    const out = resolveServerCmd(cmd);
    assert.notEqual(out, cmd);
    cmd.push("--mutated");
    assert.deepEqual(out, ["node", "index.mjs"]);
  });

  test("陣列元素轉字串", () => {
    assert.deepEqual(resolveServerCmd(["node", 4097]), ["node", "4097"]);
  });

  test("字串形態維持舊行為（單一空白分割）— 文件已標明含空白路徑的限制", () => {
    assert.deepEqual(resolveServerCmd("node packages/server/src/index.mjs"), [
      "node",
      "packages/server/src/index.mjs",
    ]);
    // 舊行為的已知限制：字串形態無法表達含空白的可執行檔路徑
    assert.deepEqual(resolveServerCmd("C:\\Program Files\\node.exe x.mjs"), [
      "C:\\Program",
      "Files\\node.exe",
      "x.mjs",
    ]);
  });

  test("空 / 未定義 → 單一空字串（spawn 會以 ENOENT 的 error 事件回報，與舊行為一致）", () => {
    assert.deepEqual(resolveServerCmd(""), [""]);
    assert.deepEqual(resolveServerCmd(undefined), [""]);
  });

  test("startPaaw 使用陣列形態指令時，以第一個元素為執行檔（真的 spawn 得起來）", async () => {
    const { control } = makeControl({
      config: { paawServerCmd: [process.execPath, "-e", "setTimeout(()=>{},300000)"] },
    });
    const r = control.startPaaw();
    try {
      assert.equal(r.ok, true);
      assert.equal(typeof r.pid, "number");
    } finally {
      await control.stopPaaw();
    }
  });
});

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

// ── stopPaaw：終態稽核契約（committee major, 2026-10-22）──
// 重構前 stopPaaw 完成時會寫 event；模組化重構後遺失。契約：
//   • 成功（exit 已確認）→ 恰一筆 "server_stopped"
//   • 失敗（SIGTERM/SIGKILL 失敗或逾時未退出）→ 恰一筆 "server_stop_failed"（含 error）
//   • 未執行（Not running）/ 併發重複呼叫 → 不寫任何終態事件
describe("src/server/paaw-control.mjs — stopPaaw 稽核事件", () => {
  // 測試策略：paawProcess 是 closure 私有狀態，無法直接注入假行程，
  // 因此一律用真 spawn（NOOP_SERVER_CMD，無害長睡 node script）取得 handle，
  // 再「monkeypatch 該 handle 的 kill()」製造失敗階梯；afterEach/ finally
  // 以原始 kill 收掉子行程，確保不殘留。

  test("成功停止 → 恰一筆 server_stopped（含 userId），不得有 server_stop_failed", async () => {
    const { control, logged } = makeControl();
    control.startPaaw();
    const r = await control.stopPaaw("admin1");
    assert.equal(r.ok, true);

    const types = logged.map((l) => l.type);
    assert.equal(types.filter((t) => t === "server_stopped").length, 1, `expected exactly one server_stopped, got ${types}`);
    assert.equal(types.includes("server_stop_failed"), false, "a successful stop must not log a failure event");
    assert.ok(types.includes("server_stopping"), "the starting event must still be logged");

    const stopped = logged.find((l) => l.type === "server_stopped");
    assert.equal(stopped.userId, "admin1", "stop events must carry the acting user");
    assert.match(stopped.detail, /stopped/i);
  });

  test("SIGTERM 送出即失敗（kill 拋錯）→ 恰一筆 server_stop_failed，含 error 原因，回傳 ok:false 且結構不變", async () => {
    const { control, logged } = makeControl();
    const proc = control.startPaaw();
    assert.equal(proc.ok, true);
    // 讓真正的 handle 拒絕 SIGTERM：模擬權限不足 / 行程已不是我們的子行程。
    const real = control.getPaawProcess();
    const originalKill = real.kill.bind(real);
    real.kill = () => { throw new Error("kill EPERM"); };

    try {
      const r = await control.stopPaaw("admin1");

      // 對外回傳結構不得改變（只補 audit 副作用）。
      assert.deepEqual(r, { ok: false, error: "SIGTERM failed: kill EPERM" });

      const stops = logged.filter((l) => l.type === "server_stop_failed");
      assert.equal(stops.length, 1, `expected exactly one server_stop_failed, got ${logged.map((l) => l.type)}`);
      assert.match(stops[0].detail, /stop failed/i);
      assert.match(stops[0].detail, /SIGTERM failed: kill EPERM/, "the error cause must be in the audit detail");
      assert.equal(stops[0].userId, "admin1");
      assert.equal(logged.some((l) => l.type === "server_stopped"), false, "a failed stop must not log a success event");
    } finally {
      // 收掉真的子行程（用原始 kill），避免殘留。
      real.kill = originalKill;
      try { real.kill("SIGKILL"); } catch { /* already gone */ }
    }
  });

  test("升級階梯：SIGTERM 拋錯後 SIGKILL 再拋錯 → 失敗事件仍只寫一筆（finish 去重）", async () => {
    // SIGTERM 立即失敗 → finish(false)（第一筆 server_stop_failed）；
    // 5s 後 sigkillTimer 觸發，SIGKILL 也失敗 → finish(false) 再次被呼叫，
    // 必須被 settled 去重擋掉，不得寫第二筆終態事件。
    const { control, logged } = makeControl();
    control.startPaaw();
    const real = control.getPaawProcess();
    const originalKill = real.kill.bind(real);
    real.kill = (signal) => { throw new Error(`kill ${signal} EPERM`); };
    try {
      const r = await control.stopPaaw("admin1");
      assert.equal(r.ok, false);
      assert.match(r.error, /SIGTERM failed: kill SIGTERM EPERM/, "the first failure wins (settled guard)");

      // 等 SIGKILL timer（5s）過去，證明第二個 finish 不會追加事件。
      await sleep(5200);
      const stops = logged.filter((l) => l.type === "server_stop_failed");
      assert.equal(stops.length, 1, `exactly one terminal failure event expected, got ${logged.map((l) => l.type)}`);
      assert.equal(logged.some((l) => l.type === "server_stopped"), false);
    } finally {
      real.kill = originalKill;
      try { real.kill("SIGKILL"); } catch { /* already gone */ }
    }
  });

  test("未執行時呼叫（Not running）→ 不寫任何終態稽核事件（拒絕不是停止結果）", async () => {
    const { control, logged } = makeControl();
    const r = await control.stopPaaw("admin1");
    assert.equal(r.ok, false);
    const types = logged.map((l) => l.type);
    assert.equal(types.includes("server_stopped"), false);
    assert.equal(types.includes("server_stop_failed"), false);
    assert.equal(types.includes("server_stopping"), false);
  });

  test("併發重複停止共用同一段流程 → 只寫一筆終態事件（不得兩筆）", async () => {
    const { control, logged } = makeControl();
    control.startPaaw();
    const [a, b] = await Promise.all([control.stopPaaw("admin1"), control.stopPaaw("admin1")]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true, "a joined in-flight stop resolves with the same outcome");

    const types = logged.map((l) => l.type);
    assert.equal(types.filter((t) => t === "server_stopping").length, 1, "only the owner of the sequence logs the start event");
    assert.equal(types.filter((t) => t === "server_stopped").length, 1, "exactly one terminal event per stop sequence");
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
      assert.match(r.error, /running \(recovered\)/);

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

// ── upgradePaaw：stash create/store/apply/drop（ADR-005 穩定 stash 處理）──
// 識別改採 `git stash create`（回 sha 或空字串），還原只作用於已知 sha
// （`git stash apply <sha>` → 成功才 `git stash drop <sha>`）。不再用
// `git stash list` 非空 / count 差值推斷本次是否 stash。
const STASH_SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

describe("src/server/paaw-control.mjs — upgradePaaw（stash create/apply 失敗即中止升級）", () => {
  test("本次確實 stash（create 回 sha）且 apply 衝突（結構化確認：git ls-files -u 有 unmerged）→ ok:false + warning，不執行 npm install，server 保持停止（minor#3 / round-7 major#3）", async () => {
    const calls = [];
    const fakeExec = (cmd) => {
      calls.push(cmd);
      if (cmd === "git stash create") return `${STASH_SHA}\n`;
      if (cmd.startsWith("git stash store")) return "ok";
      if (cmd.startsWith("git stash apply")) throw new Error("CONFLICT (content): merge conflict in foo.mjs");
      // 結構化衝突確認：git ls-files -u 需回報 unmerged path（非空）。
      if (cmd.startsWith("git ls-files -u")) return "100644 abcdef1234567890 1\tfoo.mjs\n";
      return "ok";
    };
    const { control, logged } = makeControl({ exec: fakeExec });
    try {
      const r = await control.upgradePaaw("admin1");

      // stash apply 失敗（衝突）= 中止升級（不能在一片 conflict marker 的樹上裝依賴）
      assert.equal(r.ok, false);
      assert.ok(Array.isArray(r.warnings));
      assert.equal(r.warnings.length, 1, "should surface exactly one warning");
      assert.match(r.warnings[0], /stash apply failed/);
      assert.match(r.warnings[0], /STOPPED/);

      // 關鍵：不得執行 npm install
      assert.equal(calls.some((c) => c.startsWith("npm install")), false, "npm install must NOT run after stash apply failure");

      // 對應 step 要標記 warning，讓前端能凸顯
      const step = r.steps.find((s) => s.step === "git stash restore");
      assert.equal(step.ok, false);
      assert.equal(step.warning, true);

      // minor#3：絕不在衝突中的髒樹上盲目重啟 —— server 必須保持停止。
      assert.equal(r.recovered, false);
      assert.equal(control.isRunning(), false, "server must stay stopped on conflict — do not boot a conflicted tree");
      // 也不得留下 "restart server" step（沒嘗試復原）。
      assert.equal(r.steps.some((s) => s.step === "restart server"), false, "must not attemptRecover on a conflicted tree");
      assert.ok(logged.map((l) => l.type).includes("upgrade_failed"));
    } finally {
      await control.stopPaaw();
    }
  });

  test("本次 stash 但 apply 為『非衝突』失敗（timeout/權限）且工作樹乾淨 → 走一般失敗分支復原，不誤導為 conflict，server 拉回（committee major#1）", async () => {
    const calls = [];
    // 非衝突失敗：訊息不含 CONFLICT / merge conflict 等字樣（如 30s timeout）。
    const nonConflict = "Command failed: git stash apply <sha>\nspawnSync git ETIMEDOUT: operation timed out";
    const fakeExec = (cmd) => {
      calls.push(cmd);
      if (cmd === "git stash create") return `${STASH_SHA}\n`;
      if (cmd.startsWith("git stash store")) return "ok";
      if (cmd.startsWith("git stash apply")) throw new Error(nonConflict);
      // 工作樹乾淨（git status --porcelain 空）→ 允許安全復原。
      if (cmd.startsWith("git status --porcelain")) return "";
      return "ok";
    };
    const { control, logged } = makeControl({ exec: fakeExec });
    try {
      const r = await control.upgradePaaw("admin1");

      assert.equal(r.ok, false, "upgrade itself still fails");
      // 非衝突 → 一般失敗分支：走 attemptRecover，server 被拉回。
      assert.equal(r.recovered, true, "a non-conflict apply failure must go through recovery");
      assert.equal(control.isRunning(), true, "server must be recovered on a non-conflict failure");

      // 不得把非衝突誤診為 conflict，也不得誤導 operator 去手動解衝突。
      const warning = r.warnings[0];
      assert.match(warning, /non-conflict/);
      assert.equal(/resolve the conflict manually/i.test(warning), false, "must NOT instruct manual conflict resolution");
      assert.equal(/failed \(merge conflict\)/i.test(warning), false, "must NOT label a non-conflict failure as a merge conflict");

      // step 應標記一般失敗（note: apply failed，而非 conflict），並帶原始原因。
      const step = r.steps.find((s) => s.step === "git stash restore");
      assert.equal(step.ok, false);
      assert.equal(step.note, "apply failed");
      assert.equal(step.detail, nonConflict, "raw cause must be surfaced for diagnosis");

      // 必須有 restart server step（已嘗試復原）。
      assert.ok(r.steps.some((s) => s.step === "restart server"), "must attemptRecover on a non-conflict failure");

      // npm install 仍不得執行（升級已中止）。
      assert.equal(calls.some((c) => c.startsWith("npm install")), false);
      assert.ok(logged.map((l) => l.type).includes("upgrade_failed"));
    } finally {
      await control.stopPaaw();
    }
  });

  test("非衝突失敗但工作樹『不乾淨』→ 保守保持 STOPPED（不回 attemptRecover），避免在 half-applied 髒樹上開機（round-7 major#3）", async () => {
    const calls = [];
    const nonConflict = "Command failed: git stash apply <sha>\nENOSPC: no space left on device";
    const fakeExec = (cmd) => {
      calls.push(cmd);
      if (cmd === "git stash create") return `${STASH_SHA}\n`;
      if (cmd.startsWith("git stash store")) return "ok";
      if (cmd.startsWith("git stash apply")) throw new Error(nonConflict);
      // 工作樹不乾淨（有殘留變更 / 部分套用）→ 不得開機。
      if (cmd.startsWith("git status --porcelain")) return " M src/partially-applied.mjs\n";
      return "ok";
    };
    const { control, logged } = makeControl({ exec: fakeExec });
    try {
      const r = await control.upgradePaaw("admin1");

      assert.equal(r.ok, false, "upgrade itself still fails");
      // 關鍵：不乾淨的樹 → 不得 attemptRecover，server 保持停止。
      assert.equal(r.recovered, false, "must NOT recover on a dirty tree after a non-conflict apply failure");
      assert.equal(control.isRunning(), false, "server must stay stopped — do not boot a half-applied tree");
      assert.equal(r.steps.some((s) => s.step === "restart server"), false, "must not attemptRecover on a dirty tree");

      // 訊息要明講工作樹不乾淨 + 人工介入，而非誤導為 conflict。
      const joined = r.warnings.join("\n");
      assert.match(joined, /non-conflict/);
      assert.match(joined, /working tree is NOT clean/);
      assert.equal(/resolve the conflict manually/i.test(joined), false, "must NOT instruct manual conflict resolution");
      assert.ok(logged.map((l) => l.type).includes("upgrade_failed"));
    } finally {
      await control.stopPaaw();
    }
  });

  test("非衝突失敗且工作樹只有『untracked 檔』（無 tracked/未合併變更）→ 仍視為乾淨並復原，不因 untracked 誤判為 dirty（round-8 major#1）", async () => {
    const nonConflict = "Command failed: git stash apply <sha>\nENOSPC: no space left on device";
    // 走 execFile seam：拿到真實 argv 陣列，斷言才是契約本身（round-9 minor#4
    // ——legacy exec seam 的 space-joined 字串僅供 prefix 匹配，非參數契約）。
    const seenArgv = [];
    const fakeExecFile = (file, args) => {
      seenArgv.push({ file, args });
      if (file === "git" && args[0] === "stash" && args[1] === "create") return `${STASH_SHA}\n`;
      if (file === "git" && args[0] === "stash" && args[1] === "apply") throw new Error(nonConflict);
      // 情境界定：工作樹的『髒』來自既有 untracked 檔（build artifact / scratch）。
      // 排除 untracked 後，tracked 端為乾淨。
      if (file === "git" && args[0] === "status") return "";
      return "ok";
    };
    const { control } = makeControl({ execFile: fakeExecFile });
    try {
      const r = await control.upgradePaaw("admin1");

      assert.equal(r.ok, false, "upgrade itself still fails (non-conflict apply error)");
      // 關鍵：untracked-only 不得判 dirty → 必須復原、server 拉回。
      assert.equal(r.recovered, true, "untracked-only tree must be treated as clean → recovery allowed");
      assert.equal(control.isRunning(), true, "server must be recovered — untracked file is not a half-applied tree");
      assert.ok(r.steps.some((s) => s.step === "restart server"), "must attemptRecover on an untracked-only tree");

      // 乾淨判準必須以 argv 明示排除 untracked（round-8 major#1 的契約本體）。
      const statusCall = seenArgv.find((c) => c.file === "git" && c.args[0] === "status");
      assert.ok(statusCall, "the clean check must probe git status");
      assert.ok(
        statusCall.args.includes("--untracked-files=no"),
        `clean check argv must exclude untracked files (round-8 major#1), got: ${JSON.stringify(statusCall.args)}`,
      );

      // 不得出現任何宣稱工作樹髒 / 需人工介入的訊息。
      const joined = r.warnings.join("\n");
      assert.equal(/working tree is NOT clean/i.test(joined), false, "untracked-only must NOT be reported as a dirty tree");
    } finally {
      await control.stopPaaw();
    }
  });

  test("非衝突失敗且工作樹探測本身拋錯（git status 故障）→ 走 unknown：保持 STOPPED 且訊息不得假稱 dirty tree（round-8 major#2）", async () => {
    const calls = [];
    const nonConflict = "Command failed: git stash apply <sha>\nspawnSync git ETIMEDOUT: operation timed out";
    const probeErr = "Command failed: git status --porcelain\nfatal: not a git repository (or any of the parent directories): .git";
    const fakeExec = (cmd) => {
      calls.push(cmd);
      if (cmd === "git stash create") return `${STASH_SHA}\n`;
      if (cmd.startsWith("git stash store")) return "ok";
      if (cmd.startsWith("git stash apply")) throw new Error(nonConflict);
      // 關鍵：探測本身失敗（git 本身故障）→ 必須顯性 unknown，不得折疊成 dirty。
      if (cmd.startsWith("git status --porcelain")) throw new Error(probeErr);
      return "ok";
    };
    const { control, logged } = makeControl({ exec: fakeExec });
    try {
      const r = await control.upgradePaaw("admin1");

      assert.equal(r.ok, false, "upgrade itself still fails");
      // 保守：無法驗證 → 不得開機。
      assert.equal(r.recovered, false, "an unverifiable tree must NOT be recovered (conservative)");
      assert.equal(control.isRunning(), false, "server must stay stopped when the tree cannot be verified");
      assert.equal(r.steps.some((s) => s.step === "restart server"), false, "must not attemptRecover when the probe failed");

      // 訊息必須誠實：明講是 git 探測失敗，絕不可宣稱工作樹髒。
      const joined = r.warnings.join("\n");
      assert.match(joined, /non-conflict/);
      assert.match(joined, /working-tree probe failed/i, "must explain the git probe itself failed");
      assert.equal(/working tree is NOT clean/i.test(joined), false, "must NOT falsely claim a dirty tree when the probe errored");

      // step note 也要區分 unknown 與 dirty。
      const step = r.steps.find((s) => s.step === "git stash restore");
      assert.equal(step.ok, false);
      assert.equal(step.note, "git probe failed — not recovered");

      // error 字串要標示 unverifiable（而非 dirty tree）。
      assert.match(r.error, /unverifiable tree/);
      assert.equal(/dirty tree/i.test(r.error), false, "error must not claim a dirty tree when git itself failed");
      assert.ok(logged.map((l) => l.type).includes("upgrade_failed"));
    } finally {
      await control.stopPaaw();
    }
  });

  test("hasUnmergedPaths 探測失敗但訊息含 conflict → 折為『非衝突』、不進 conflict 分支，改由工作樹檢查收斂（probe error path，round-9 major#1）", async () => {
    // 情境：stderr 有 conflict 字樣（正則 pre-filter 命中），但 `git ls-files -u`
    // 本身拋錯 → tri-state 回 null（unknown）。null 絕不可被讀成 true
    // （會誤判真衝突、把 server 丟進高風險 STOPPED 分支），也不可讀成 false
    // 的「確定乾淨」；只能一路保守收斂。
    const realConflict = "Command failed: git stash apply <sha>\nCONFLICT (content): Merge conflict in src/a.mjs\nAutomatic merge failed; fix conflicts and then commit the result.";
    const unmergedProbeErr = "Command failed: git ls-files -u\nfatal: not a git repository (or any of the parent directories): .git";
    const seenArgv = [];
    const fakeExecFile = (file, args) => {
      seenArgv.push({ file, args });
      if (file === "git" && args[0] === "stash" && args[1] === "create") return `${STASH_SHA}\n`;
      if (file === "git" && args[0] === "stash" && args[1] === "apply") throw new Error(realConflict);
      if (file === "git" && args[0] === "ls-files") throw new Error(unmergedProbeErr); // 探測失敗 → null
      if (file === "git" && args[0] === "status") return " M src/partially-applied.mjs\n"; // tracked 髒 → 不可開機
      return "ok";
    };
    const { control, logged } = makeControl({ execFile: fakeExecFile });
    try {
      const r = await control.upgradePaaw("admin1");

      // tri-state 契約：探測確實被呼叫過（證明這是決定性的一步）。
      assert.ok(
        seenArgv.some((c) => c.file === "git" && c.args[0] === "ls-files" && c.args[1] === "-u"),
        "the structural unmerged-path probe must have been attempted",
      );

      assert.equal(r.ok, false, "upgrade itself still fails");
      // 關鍵：不得折成 true（conflict）→ 不進 conflict 分支的專屬措辭。
      const joined = r.warnings.join("\n");
      assert.equal(/merge conflict\) — server left STOPPED/.test(joined), false, "probe failure must NOT route into the conflict branch");
      assert.equal(/resolve the conflict manually/i.test(joined), false, "must not instruct manual conflict resolution on an unconfirmed conflict");
      // 也不得折成「確定乾淨」——工作樹 tracked 髒 → 保守保持 STOPPED。
      assert.equal(r.recovered, false, "a dirty tracked tree must not be recovered");
      assert.equal(control.isRunning(), false, "server must stay stopped");
      assert.equal(r.steps.some((s) => s.step === "restart server"), false, "must not attemptRecover on a dirty tree");

      // 判定依據要誠實：明講 unmerged 探測失敗、僅靠 tracked-clean 判定。
      assert.match(joined, /unmerged-path probe failed/i);
      assert.match(joined, /tracked-clean/i);

      const step = r.steps.find((s) => s.step === "git stash restore");
      assert.equal(step.ok, false);
      assert.equal(step.note, "dirty tree — not recovered");
      assert.ok(logged.map((l) => l.type).includes("upgrade_failed"));
    } finally {
      await control.stopPaaw();
    }
  });

  test("混合探測（ls-files -u 失敗、status 成功且 tracked-clean）→ 可復原，但訊息/step note 必須揭露判定依據僅為 tracked-clean（round-9 minor#2）", async () => {
    // 情境：stderr 含 conflict 字樣，unmerged 探測失敗（null），但 tracked-clean
    // 探測成功且乾淨 → 安全上允許復原（不會在半套用樹上開機），但這比
    // 「結構上確認無衝突」弱，必須在 warning / step note 誠實標明。
    const maybeConflict = "Command failed: git stash apply <sha>\nwarning: clobbering conflict-prone file, fix conflicts later";
    const unmergedProbeErr = "Command failed: git ls-files -u\nspawnSync git ETIMEDOUT: operation timed out";
    const seenArgv = [];
    const fakeExecFile = (file, args) => {
      seenArgv.push({ file, args });
      if (file === "git" && args[0] === "stash" && args[1] === "create") return `${STASH_SHA}\n`;
      if (file === "git" && args[0] === "stash" && args[1] === "apply") throw new Error(maybeConflict);
      if (file === "git" && args[0] === "ls-files") throw new Error(unmergedProbeErr); // unknown
      if (file === "git" && args[0] === "status") return ""; // tracked 乾淨 → 可復原
      return "ok";
    };
    const { control } = makeControl({ execFile: fakeExecFile });
    try {
      const r = await control.upgradePaaw("admin1");

      assert.equal(r.ok, false, "upgrade itself still fails");
      // 安全保證未弱化：tracked-clean 明確可驗證時允許復原。
      assert.equal(r.recovered, true, "a verified tracked-clean tree may still be recovered");
      assert.equal(control.isRunning(), true, "server must be recovered on a verified clean tree");

      // 誠實性：必須揭露 unmerged 探測失敗、判定依據僅為 tracked-clean。
      const joined = r.warnings.join("\n");
      assert.match(joined, /unmerged-path probe failed/i);
      assert.match(joined, /tracked-clean/i);
      // 不得誤稱衝突（未經結構確認）。
      assert.equal(/resolve the conflict manually/i.test(joined), false, "an unconfirmed conflict must not be reported as one");

      const step = r.steps.find((s) => s.step === "git stash restore");
      assert.equal(step.ok, false);
      assert.match(step.note, /tracked-clean only/i, "step note must disclose the weaker verification basis");
      assert.match(step.note, /unmerged probe failed/i);
    } finally {
      await control.stopPaaw();
    }
  });

  test("stderr 提到 conflict 但工作樹結構上無 unmerged path → 不得誤判為 conflict（round-7 major#3：結構化判定勝過正則）", async () => {
    const calls = [];
    // 訊息含 "conflict" 字樣（可能來自無害的提示），但 ls-files -u 為空、
    // status 乾淨 → 結構化判定認定「非真衝突」→ 走一般復原。
    const maybeConflict = "warning: a previous conflict was noted; git stash apply returned non-zero";
    const fakeExec = (cmd) => {
      calls.push(cmd);
      if (cmd === "git stash create") return `${STASH_SHA}\n`;
      if (cmd.startsWith("git stash store")) return "ok";
      if (cmd.startsWith("git stash apply")) throw new Error(maybeConflict);
      if (cmd.startsWith("git ls-files -u")) return ""; // no unmerged paths — not a real conflict
      if (cmd.startsWith("git status --porcelain")) return "";
      return "ok";
    };
    const { control } = makeControl({ exec: fakeExec });
    try {
      const r = await control.upgradePaaw("admin1");
      assert.equal(r.ok, false);
      // 結構化確認無 unmerged → 不落入 conflict 分支 → 走復原。
      assert.equal(r.recovered, true, "a message-only 'conflict' must not route into the STOPPED branch");
      assert.equal(control.isRunning(), true, "server must be recovered when git reports no unmerged paths");
      assert.equal(r.steps.some((s) => s.step === "restart server"), true);
    } finally {
      await control.stopPaaw();
    }
  });

  test("isStashApplyConflict 邊界：timeout / EACCES / ENOSPC 皆不被誤判為 conflict（結構化探測不觸發）", async () => {
    for (const cause of [
      "spawnSync git ETIMEDOUT: operation timed out",
      "EACCES: permission denied, open '.git/index'",
      "ENOSPC: no space left on device, write",
    ]) {
      const calls = [];
      const fakeExec = (cmd) => {
        calls.push(cmd);
        if (cmd === "git stash create") return `${STASH_SHA}\n`;
        if (cmd.startsWith("git stash store")) return "ok";
        if (cmd.startsWith("git stash apply")) throw new Error(`Command failed: git stash apply <sha>\n${cause}`);
        if (cmd.startsWith("git status --porcelain")) return ""; // 乾淨樹 → 復原
        return "ok";
      };
      const { control } = makeControl({ exec: fakeExec });
      try {
        const r = await control.upgradePaaw("admin1");
        // 非衝突 → 一般失敗分支（能復原）。若誤判為 conflict，recovered 會是 false。
        assert.equal(r.recovered, true, `${cause} must NOT be treated as a conflict`);
        assert.equal(
          calls.some((c) => c.startsWith("git ls-files -u")),
          false,
          `${cause}: structural unmerged probe must not run when the message shows no conflict`,
        );
        const step = r.steps.find((s) => s.step === "git stash restore");
        assert.equal(step.note, "apply failed", `${cause}: must be a plain apply failure, not 'conflict'`);
      } finally {
        await control.stopPaaw();
      }
    }
  });

  test("command-injection 硬化：argv 形式（execFile）不經 shell，惡意 sha 被視為單一原樣參數；git pull 亦走 argv（round-7 major#1/#2/#4）", async () => {
    // 注入樣本：含分號 / 反引號 / $(...) / 空白 —— shell 拼接會爆開，argv 不會。
    const evilSha = "deadbeef; rm -rf /tmp/x`id`$(whoami) -- --all";
    const seenArgv = [];
    // execFile seam：真正拿到 argv 陣列（第 2 參數）。
    const fakeExecFile = (file, args, opts) => {
      seenArgv.push({ file, args, opts });
      if (file === "git" && args[0] === "stash" && args[1] === "create") return `${evilSha}\n`;
      if (file === "git" && args[0] === "stash" && args[1] === "apply") throw new Error("boom");
      if (file === "git" && args[0] === "status") return "";
      if (file === "git" && args[0] === "ls-files") return "";
      return "ok";
    };
    // getGitInfo 仍走 exec（真實 git 查詢）；stash create 亦走 exec seam。
    const fakeExec = (cmd) => {
      if (cmd === "git stash create") return `${evilSha}\n`;
      if (cmd.startsWith("git rev-parse")) return "main\n";
      if (cmd.startsWith("git log")) return "2026-01-01 00:00:00 +0000\n";
      if (cmd.startsWith("git status")) return "";
      if (cmd.startsWith("git rev-list")) return "0\n";
      return "ok";
    };
    const { control } = makeControl({ exec: fakeExec, execFile: fakeExecFile });
    try {
      const r = await control.upgradePaaw("admin1");

      // minor#3: assert the return shape, not just the argv wiring — so a
      // regression in the error path yields a precise failure message.
      assert.equal(r.ok, false, "upgrade must fail when stash apply throws");
      assert.equal(typeof r.error, "string", "failed upgrade must carry an error string");
      assert.ok(Array.isArray(r.steps) && Array.isArray(r.warnings), "return must keep the { steps, warnings } contract");

      const applyCall = seenArgv.find((c) => c.file === "git" && c.args[0] === "stash" && c.args[1] === "apply");
      assert.ok(applyCall, "stash apply must go through the argv seam");
      // 關鍵：惡意 payload 必須是「單一原樣參數」，不得被拆開或 shell 展開。
      assert.deepEqual(applyCall.args, ["stash", "apply", evilSha], "sha must be one verbatim argv element, not shell-split");

      const storeCall = seenArgv.find((c) => c.file === "git" && c.args[0] === "stash" && c.args[1] === "store");
      assert.ok(storeCall, "stash store must go through the argv seam");
      // store 的 sha 同樣是單一原樣參數（最後一個位置）。
      assert.equal(storeCall.args[storeCall.args.length - 1], evilSha, "store sha must be one verbatim argv element");

      // git pull 也必須走 argv seam（不再 shell 拼接 branch）。
      const pullCall = seenArgv.find((c) => c.file === "git" && c.args[0] === "pull");
      assert.ok(pullCall, "git pull must go through the argv seam");
      assert.deepEqual(pullCall.args.slice(0, 2), ["pull", "origin"], "pull base must be fixed literal args");
      assert.equal(typeof pullCall.args[2], "string", "branch must be a single argv element");
    } finally {
      await control.stopPaaw();
    }
  });

  test("stashCreate 帶 timeout（與 store/apply/drop 一致），避免 git 掛死時升級無限阻塞（committee minor#2）", async () => {
    let createOpts;
    const fakeExec = (cmd, opts) => {
      if (cmd === "git stash create") { createOpts = opts; return ""; }
      return "ok";
    };
    const { control } = makeControl({ exec: fakeExec });
    try {
      await control.upgradePaaw("admin1");
      assert.ok(createOpts, "git stash create must be invoked with options");
      assert.equal(typeof createOpts.timeout, "number", "stashCreate must set a timeout");
      assert.ok(createOpts.timeout > 0, "timeout must be a positive number");
      assert.equal(createOpts.timeout, 15000, "stashCreate timeout must match the sibling stash ops (15s)");
    } finally {
      await control.stopPaaw();
    }
  });

  test("無事可 stash（create 回空字串）→ 略過 store/apply/drop，維持 ok:true，不產生 warning", async () => {
    const calls = [];
    const fakeExec = (cmd) => {
      calls.push(cmd);
      // 沒有本次 stash：create 回空字串（非錯誤）。
      if (cmd === "git stash create") return "";
      // 若實作錯誤地去 apply/drop，這裡會 throw → 測試必須證明根本沒被呼叫。
      if (cmd.startsWith("git stash apply") || cmd.startsWith("git stash drop")) {
        throw new Error("no stash entry should be touched");
      }
      return "ok";
    };
    const { control } = makeControl({ exec: fakeExec });
    try {
      const r = await control.upgradePaaw("admin1");
      assert.equal(r.ok, true);
      assert.equal(r.warnings.length, 0);
      // 關鍵（ADR-005）：沒有本次 stash 就絕不 apply/drop（避免動到別人的舊 stash）。
      assert.equal(calls.some((c) => c.startsWith("git stash apply")), false, "must NOT apply when we stashed nothing");
      assert.equal(calls.some((c) => c.startsWith("git stash drop")), false, "must NOT drop when we stashed nothing");
      assert.equal(calls.some((c) => c.startsWith("git stash store")), false, "must NOT store an empty sha");
      const stashStep = r.steps.find((s) => s.step === "git stash");
      assert.equal(stashStep.ok, true);
      assert.equal(stashStep.note, "nothing to stash");
      const restoreStep = r.steps.find((s) => s.step === "git stash restore");
      assert.equal(restoreStep.ok, true);
      assert.equal(restoreStep.note, "no stash entries");
    } finally {
      await control.stopPaaw();
    }
  });

  test("機器已有舊 stash 且本次未 stash → 不誤判、絕不 apply/drop 舊 stash（committee major）", async () => {
    const calls = [];
    const fakeExec = (cmd) => {
      calls.push(cmd);
      // 機器上本來就有一個舊 stash；本次 create 回空字串（沒有本 run 的 stash）。
      // 若實作誤用「list 非空 / count 差值 → 動作」，會呼叫到 apply/drop 並 throw。
      if (cmd === "git stash create") return "";
      if (cmd.startsWith("git stash apply") || cmd.startsWith("git stash drop")) {
        throw new Error("must never touch a pre-existing stash we did not create");
      }
      return "ok";
    };
    const { control } = makeControl({ exec: fakeExec });
    try {
      const r = await control.upgradePaaw("admin1");
      assert.equal(r.ok, true, "pre-existing stash must not fail the upgrade");
      assert.equal(r.warnings.length, 0, "must not warn about a stash we did not create");
      assert.equal(calls.some((c) => c.startsWith("git stash apply")), false, "must NOT apply a pre-existing stash");
      assert.equal(calls.some((c) => c.startsWith("git stash drop")), false, "must NOT drop a pre-existing stash");
      const stashStep = r.steps.find((s) => s.step === "git stash");
      assert.equal(stashStep.note, "nothing to stash");
    } finally {
      await control.stopPaaw();
    }
  });

  test("probe 失敗不可吞成假成功：git stash create 丟真錯（目錄壞/權限）→ ok:false，不偽裝 nothing to stash", async () => {
    const fakeExec = (cmd) => {
      if (cmd === "git stash create") throw new Error("fatal: could not read from repository");
      return "ok";
    };
    const { control, logged } = makeControl({ exec: fakeExec });
    try {
      const r = await control.upgradePaaw("admin1");
      assert.equal(r.ok, false, "a real stash-create error must fail the upgrade, not fake success");
      assert.match(r.error, /Upgrade failed/);
      // 不得有任何 step 把失敗當 "nothing to stash" 成功回報。
      const stashStep = r.steps.find((s) => s.step === "git stash");
      assert.equal(stashStep, undefined, "no successful git stash step may be recorded on a real error");
      assert.ok(logged.map((l) => l.type).includes("upgrade_failed"));
    } finally {
      await control.stopPaaw();
    }
  });

  test("store 失敗（create 成功但後續失敗）→ 走外層 catch 復原，server 拉回（ADR-005 邊界）", async () => {
    const fakeExec = (cmd) => {
      if (cmd === "git stash create") return `${STASH_SHA}\n`;
      if (cmd.startsWith("git stash store")) throw new Error("fatal: cannot lock ref");
      return "ok";
    };
    const { control } = makeControl({ exec: fakeExec });
    try {
      const r = await control.upgradePaaw("admin1");
      assert.equal(r.ok, false);
      // store 失敗屬真實錯誤 → 外層 catch 走復原，server 被拉回。
      assert.equal(r.recovered, true);
      assert.equal(control.isRunning(), true, "server must be recovered after a real store failure");
    } finally {
      await control.stopPaaw();
    }
  });

  test("本次 stash 成功且 apply 成功但 drop 失敗 → ok:true + warning（資料無損，entry 殘留）", async () => {
    const calls = [];
    const fakeExec = (cmd) => {
      calls.push(cmd);
      if (cmd === "git stash create") return `${STASH_SHA}\n`;
      if (cmd.startsWith("git stash store")) return "ok";
      if (cmd.startsWith("git stash apply")) return "ok";
      if (cmd.startsWith("git stash drop")) throw new Error("fatal: cannot drop");
      return "ok";
    };
    const { control } = makeControl({ exec: fakeExec });
    try {
      const r = await control.upgradePaaw("admin1");
      assert.equal(r.ok, true, "drop failure must not fail the whole upgrade");
      assert.ok(calls.some((c) => c.startsWith(`git stash apply ${STASH_SHA}`)), "must apply the exact sha we created");
      assert.equal(r.warnings.length, 1);
      assert.match(r.warnings[0], /drop.*failed/i);
      const step = r.steps.find((s) => s.step === "git stash restore");
      assert.equal(step.ok, true);
      assert.equal(step.warning, true);
    } finally {
      await control.stopPaaw();
    }
  });

  test("happy path：stash create → store(sha) → apply(sha) → drop(sha)，全程作用於同一 sha", async () => {
    const calls = [];
    const fakeExec = (cmd) => {
      calls.push(cmd);
      if (cmd === "git stash create") return `${STASH_SHA}\n`;
      return "ok";
    };
    const { control } = makeControl({ exec: fakeExec });
    try {
      const r = await control.upgradePaaw("admin1");
      assert.equal(r.ok, true);
      assert.equal(r.warnings.length, 0);
      assert.ok(calls.some((c) => c.startsWith("git stash store") && c.includes(STASH_SHA)), "store must register our sha");
      assert.ok(calls.includes(`git stash apply ${STASH_SHA}`), "apply must target our sha");
      assert.ok(calls.includes(`git stash drop ${STASH_SHA}`), "drop must target our sha");
      const stashStep = r.steps.find((s) => s.step === "git stash");
      assert.equal(stashStep.ok, true);
      assert.match(stashStep.note, /stashed/);
    } finally {
      await control.stopPaaw();
    }
  });
});

// ── (E) 復原本身也失敗 + 外層 catch 復原路徑 ──
describe("src/server/paaw-control.mjs — upgradePaaw（復原失敗 / 外層 catch 復原）", () => {
  test("npm install 失敗且 startPaaw 也失敗 → recovered:false + warning + upgrade_recover_failed 事件", async () => {
    const fakeExec = (cmd) => {
      if (cmd.startsWith("npm install")) throw new Error("npm ERR! network timeout");
      return "ok";
    };
    // paawServerCmd 為空字串 → startPaaw 的 spawn("") 同步 throw → 復原失敗。
    const { control, logged } = makeControl({
      exec: fakeExec,
      config: { paawServerCmd: "", paawServerPort: 4097 },
    });

    const r = await control.upgradePaaw("admin1");

    assert.equal(r.ok, false);
    assert.equal(r.recovered, false, "recovery must report false when startPaaw fails");

    // warnings 要包含「recovery failed」
    assert.ok(r.warnings.some((w) => /recovery failed/i.test(w)), `expected recovery-failed warning, got ${JSON.stringify(r.warnings)}`);

    // 事件要含 upgrade_recover_failed（且不得含 upgrade_recovered）
    const types = logged.map((l) => l.type);
    assert.ok(types.includes("upgrade_recover_failed"), `expected upgrade_recover_failed, got ${types}`);
    assert.equal(types.includes("upgrade_recovered"), false, "must not claim recovered when it failed");

    // 訊息要誠實標示 restart FAILED
    assert.match(r.error, /restart FAILED/);
  });

  test("git pull 失敗（外層 catch）→ 仍嘗試 startPaaw，回傳反映 recovered:true", async () => {
    const calls = [];
    const fakeExec = (cmd) => {
      calls.push(cmd);
      if (cmd.startsWith("git pull")) throw new Error("fatal: could not read from remote repository");
      return "ok";
    };
    const { control, logged } = makeControl({ exec: fakeExec });
    try {
      const r = await control.upgradePaaw("admin1");

      // 升級失敗（git pull 掛）
      assert.equal(r.ok, false);
      assert.match(r.error, /Upgrade failed/);

      // 但 server 已透過 startPaaw 拉回
      assert.equal(r.recovered, true);
      assert.equal(control.isRunning(), true, "server should be restarted after git pull failure");

      // 不應執行到 npm install（pull 就爆了）
      assert.equal(calls.some((c) => c.startsWith("npm install")), false, "npm install must NOT run when git pull fails");

      const restartStep = r.steps.find((s) => s.step === "restart server");
      assert.equal(restartStep.ok, true);
      assert.ok(logged.map((l) => l.type).includes("upgrade_recovered"));
    } finally {
      await control.stopPaaw();
    }
  });

  test("recovery 時 server 仍在執行（startPaaw 回 alreadyRunning 旗標）→ 結構化判定為復原成功，不誤報 recovery failed（ADR-005 / minor#3）", async () => {
    // 讓 recovery 當下 paawProcess 仍為 truthy：在 git pull 步驟以 re-entrant 方式
    // 起一個 noop server，再讓 git pull 丟例外走外層 catch → attemptRecover。
    // 此時 startPaaw() 回 { ok:false, code:'ALREADY_RUNNING', alreadyRunning:true }。
    // ADR-005：判定改讀結構化旗標/code，不再靠 error 字串比對（字串一改即壞）。
    const logged = [];
    let control;
    const fakeExec = (cmd) => {
      if (cmd.startsWith("git pull")) {
        control.startPaaw(); // server 此刻已在跑
        throw new Error("fatal: could not read from remote repository");
      }
      return "ok";
    };
    control = createPaawControl({
      config: { paawServerCmd: NOOP_SERVER_CMD, paawServerPort: 4991 },
      PAAW_ROOT: tmp,
      logEvent: (type) => logged.push(type),
      exec: fakeExec,
    });
    try {
      const r = await control.upgradePaaw("admin1");

      assert.equal(r.ok, false, "upgrade itself still fails");
      assert.equal(r.recovered, true, "a live server means recovery succeeded");
      assert.equal(control.isRunning(), true);

      const restartStep = r.steps.find((s) => s.step === "restart server");
      assert.equal(restartStep.ok, true);
      assert.equal(restartStep.detail, "already running");

      // 不得把「本來就在跑」誤報為 recovery 失敗
      assert.equal(logged.includes("upgrade_recover_failed"), false);
      assert.equal(logged.includes("upgrade_recovered"), true);
    } finally {
      await control.stopPaaw();
    }
  });

  test("startPaaw 的 already-running 契約為結構化旗標（ADR-005）：回 { ok:false, code:'ALREADY_RUNNING', alreadyRunning:true }", async () => {
    const { control } = makeControl();
    try {
      const first = control.startPaaw();
      // 第二個 startPaaw 在已 running 時必須回結構化旗標，而非只靠 error 字串。
      const second = control.startPaaw();
      assert.equal(second.ok, false);
      assert.equal(second.alreadyRunning, true);
      assert.equal(second.code, "ALREADY_RUNNING");
      // 保留舊欄位以維持向後相容（routes 仍讀 error/ok）。
      assert.equal(typeof second.error, "string");
      assert.equal(first.ok, first.ok); // first may be ok:true (spawn) — not asserted on timing
    } finally {
      await control.stopPaaw();
    }
  });
});
