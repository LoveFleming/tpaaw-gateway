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
  // stashStore() uses the argv (no-shell) seam; createPaawControl derives it
  // from an injected `exec` automatically, so a single fake covers every
  // command. No extra wiring needed here.
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
  test("本次確實 stash（create 回 sha）且 apply 衝突 → ok:false + warning，不執行 npm install，server 保持停止（minor#3）", async () => {
    const calls = [];
    const fakeExec = (cmd) => {
      calls.push(cmd);
      if (cmd === "git stash create") return `${STASH_SHA}\n`;
      if (cmd.startsWith("git stash store")) return "ok";
      if (cmd.startsWith("git stash apply")) throw new Error("CONFLICT (content): merge conflict in foo.mjs");
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

  test("本次 stash 但 apply 為『非衝突』失敗（timeout/權限）→ 走一般失敗分支復原，不誤導為 conflict，server 拉回（committee major#1）", async () => {
    const calls = [];
    // 非衝突失敗：訊息不含 CONFLICT / merge conflict 等字樣（如 30s timeout）。
    const nonConflict = "Command failed: git stash apply <sha>\nspawnSync git ETIMEDOUT: operation timed out";
    const fakeExec = (cmd) => {
      calls.push(cmd);
      if (cmd === "git stash create") return `${STASH_SHA}\n`;
      if (cmd.startsWith("git stash store")) return "ok";
      if (cmd.startsWith("git stash apply")) throw new Error(nonConflict);
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
