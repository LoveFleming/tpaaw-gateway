/**
 * E2E tests — Gateway UI (src/ui/server.mjs createUIHandler): F7 CSRF/Host 防護 + GET 煙霧 + 安全修復回歸
 * （TASK-004 建立；TASK-005 更新 GET Host 案例並新增 settings body 上限 / update fail-closed 案例）
 *
 * ADR-004 (2026-10-19) — de-socketed, in-process:
 *  No spawn, no `listen`. The seam `createUIHandler(deps)` is imported and its
 *  handler driven directly with mock req/res (tests/helpers/inject.mjs).
 *  Fake package server replaced by `withFetch`-injected mock fetch impl.
 *  Temp dirs use $PAAW_TMP (never os.tmpdir()).
 *
 * 對象：createUIHandler — 所有請求（GET+POST）先驗 Host 白名單（HOST_WHITELIST =
 * 127.0.0.1 / localhost / ::1 + UI_HOST；TASK-005 起從 POST-only 放寬為全部請求），
 * POST 再驗非空 Origin 的主機也須在白名單，違者 403。GET 為讀取操作，仍不驗 Origin。
 *
 * TASK-005 新增對象（見檔尾第二個 describe）：
 *  - POST /api/settings body 上限 1MB（MAX_SETTINGS_BODY）：超限即 destroy 連線不處理
 *  - POST /api/update → updateLogic 對 manifest.version 做 VERSION_RE fail-closed
 *    （惡意 version 不得觸發任何路徑拼接 / 寫入）
 *
 * 隔離策略（絕不碰開發者本機正在跑的 gateway :4290）：
 *  - 不 spawn、不 listen — createUIHandler 接縫直接驅動
 *  - PAAW_HOME → temp dir（versions/ data/ logs/ current.json 全長在 temp）
 *  - Fake fetch → uiStatus() 的 stable.json fetch 瞬間 ECONNREFUSED
 *    （GET /api/status 快速回應且 stable 恆為 null）
 *  - Host / Origin header 透過 mock req.headers 精準控制（含「無 Origin」確定性）
 *  - cleanup：rmSync temp dir；env 覆寫用 withEnv 還原
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createUIHandler } from "../../src/ui/server.mjs";
import { applyHome } from "../../src/lib/config.mjs";
import { call, withFetch, refusingFetch, sleep } from "../helpers/inject.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 保證連不上且「瞬間」失敗的 package server URL（用 refusingFetch 模擬） */
const DEAD_PACKAGE_URL = "http://127.0.0.1:1";

/** Fallback temp base：PAAW_TMP 優先，否則用專案 .paaw/tmp */
const TMP_BASE = process.env.PAAW_TMP || join(__dirname, "..", "..", ".paaw", "tmp");

/**
 * Build a fresh in-process UI handler (no listen) against a throwaway env.
 * Returns { handler, job, home, tmp, savedEnv }.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.packageUrl] PAAW_PACKAGE_URL env (default: DEAD_PACKAGE_URL).
 *   Pass null to omit (allows POST /api/settings to dynamically set packageServer).
 * @param {string} [opts.uiHost] UI_HOST for HOST_WHITELIST derivation (default "127.0.0.1").
 */
function makeEnv({ packageUrl = DEAD_PACKAGE_URL, uiHost = "127.0.0.1" } = {}) {
  // Ensure TMP_BASE exists (fallback .paaw/tmp may not pre-exist)
  mkdirSync(TMP_BASE, { recursive: true });
  const tmp = mkdtempSync(join(TMP_BASE, "paaw-gwui-e2e-"));
  const home = join(tmp, "home");
  mkdirSync(home, { recursive: true });

  // Snapshot env keys we'll touch so we can restore in cleanupEnv()
  const savedEnv = {
    PAAW_PACKAGE_URL: process.env.PAAW_PACKAGE_URL,
    PAAW_HOME: process.env.PAAW_HOME,
    PAAW_OPEN_BROWSER: process.env.PAAW_OPEN_BROWSER,
  };

  // saveGatewayCfg() writes gateway.json to process.cwd() (NOT to PAAW_HOME),
  // so a POST /api/settings here would scribble on the real project root and,
  // under parallel file execution, race other workers on that same file
  // (intermittent 500). Isolate by running with cwd inside the throwaway tmp.
  const savedCwd = process.cwd();
  process.chdir(tmp);

  // Set env before applyHome so getHome()/getVersionsDir() point into tmp
  if (packageUrl) process.env.PAAW_PACKAGE_URL = packageUrl;
  else delete process.env.PAAW_PACKAGE_URL;
  process.env.PAAW_HOME = home;
  process.env.PAAW_OPEN_BROWSER = "0";
  applyHome();

  const job = { active: false, kind: null, lines: [], error: null, message: null, startedAt: null, finishedAt: null };
  function jobLog(line) {
    job.lines.push(`[${new Date().toLocaleTimeString()}] ${line}`);
    if (job.lines.length > 200) job.lines.splice(0, job.lines.length - 200);
  }

  const handler = createUIHandler({ UI_HOST: uiHost, job, jobLog });
  return { handler, job, home, tmp, savedEnv, savedCwd };
}

/** Restore env vars saved by makeEnv */
function cleanupEnv(savedEnv, savedCwd) {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (savedCwd) process.chdir(savedCwd); // restore cwd BEFORE applyHome so cwd-fallback is correct
  applyHome(); // re-derive HOME from restored env
}

/**
 * Call the in-process handler via the harness.
 * Defaults host to a trusted value (127.0.0.1 with a fake port) so that
 * the Host gate passes — caller overrides `host` to test malicious values.
 */
async function req(handler, url, { method = "GET", headers = {}, body, chunks } = {}) {
  // Default Host to a trusted value if not explicitly set (mirrors how real
  // HTTP always sends Host; our mock req does not auto-add it)
  const hdrs = { host: "127.0.0.1:4290", ...headers };
  return call(handler, { method, url, headers: hdrs, body, chunks });
}

// ─────────────────────────────────────────────────────────────

describe("E2E · Gateway UI CSRF 防護與 GET 煙霧（createUIHandler F7）", () => {
  let env;
  let handler;

  before(async () => {
    env = makeEnv();
    handler = env.handler;
  });

  after(() => {
    if (env) {
      cleanupEnv(env.savedEnv, env.savedCwd);
      rmSync(env.tmp, { recursive: true, force: true });
    }
  });

  // ── 1. POST：白名單外 Origin → 403 ──
  it("POST 帶白名單外 Origin（http://evil.example）→ 403 untrusted Origin", async () => {
    const { status, data } = await req(handler, "/api/settings", {
      method: "POST",
      headers: { origin: "http://evil.example" },
      body: "{}",
    });
    assert.equal(status, 403);
    assert.equal(data.ok, false);
    assert.match(data.message, /untrusted Origin/, "錯誤訊息要指明是 Origin 被拒");
  });

  it("POST 帶後綴偽裝 Origin（http://localhost.evil.example）→ 403（防白名單後綴繞過）", async () => {
    const { status, data } = await req(handler, "/api/settings", {
      method: "POST",
      headers: { origin: "http://localhost.evil.example" },
      body: "{}",
    });
    assert.equal(status, 403);
    assert.match(data.message, /untrust/, "後綴偽裝也要擋");
  });

  // ── 2. POST：白名單內 Origin → 200 ──
  it("POST 帶合法 Origin（127.0.0.1 / localhost / [::1] 帶 port）→ 200，不被 CSRF 擋下", async () => {
    for (const goodOrigin of [
      "http://127.0.0.1:4290",
      "http://localhost:4290",
      "http://[::1]:4290",
    ]) {
      const { status, data } = await req(handler, "/api/settings", {
        method: "POST",
        headers: { origin: goodOrigin },
        body: "{}",
      });
      assert.equal(status, 200, `Origin="${goodOrigin}" 應放行（非 403）`);
      assert.equal(data.ok, true, `Origin="${goodOrigin}" 要真的進到 handler`);
      assert.deepEqual(data.changed, [], "空 body 不應改任何設定");
    }
  });

  // ── 4. POST：無 Origin header → 放行（curl / 同源 form 情境）──
  it("POST 無 Origin header → 200（curl / 同源 form 情境不誤擋）", async () => {
    const { status, data } = await req(handler, "/api/settings", {
      method: "POST",
      body: "{}",
    });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
  });

  it("POST 無 Origin 打不存在的 endpoint → 404（證明請求已通過 CSRF gate 到達 router）", async () => {
    const { status } = await req(handler, "/api/no-such-endpoint", { method: "POST" });
    assert.equal(status, 404, "通過 CSRF gate 的 POST 應由 router 回 404，而非 403");
  });

  // ── 5. POST：惡意 Host → 403 ──
  it("POST 帶惡意 Host（evil.example）→ 403 untrusted Host（DNS rebinding 防護）", async () => {
    const { status, data } = await req(handler, "/api/settings", {
      method: "POST",
      headers: { host: "evil.example" }, // 不帶 Origin — 單獨驗 Host 檢查
      body: "{}",
    });
    assert.equal(status, 403);
    assert.equal(data.ok, false);
    assert.match(data.message, /untrusted Host/, "錯誤訊息要指明是 Host 被拒");
  });

  it("POST 帶惡意 Host（evil.example:4290 帶 port / 後綴偽裝）→ 403（hostOf 需拆 hostname 再比）", async () => {
    for (const badHost of ["evil.example:4290", "127.0.0.1.evil.example"]) {
      const { status } = await req(handler, "/api/settings", {
        method: "POST",
        headers: { host: badHost },
        body: "{}",
      });
      assert.equal(status, 403, `Host="${badHost}" 要被拒`);
    }
  });

  // ── 6. POST：合法 Host + 合法 Origin → 200 ──
  it("POST 合法 Host（localhost）+ 合法 Origin（http://localhost:4290）→ 200", async () => {
    const { status, data } = await req(handler, "/api/settings", {
      method: "POST",
      headers: { host: "localhost:4290", origin: "http://localhost:4290" },
      body: "{}",
    });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
  });

  // ── 7. GET 煙霧：讀取路徑不受 CSRF 防護影響 ──
  it("GET /api/status → 200 + 合法 JSON（隔離環境：current null、stable null、running false）", async () => {
    const { status, data } = await withFetch(
      refusingFetch,
      async () => req(handler, "/api/status"),
    );
    assert.equal(status, 200);
    assert.equal(data.home, env.home, "home 要指到測試的 PAAW_HOME temp dir");
    assert.equal(data.current, null, "temp home 無 current.json");
    assert.deepEqual(data.installed, [], "temp home 無任何版本");
    assert.equal(data.stable, null, "package server 指到死位址 → stable 恆 null（無外站依賴）");
    assert.equal(data.running, false, "測試從未啟動 PAAW");
    assert.equal(data.job.active, false);
  });

  it("GET /api/settings → 200 + 合法 JSON（env 鎖定：packageServer/paawHome 來源正確）", async () => {
    const { status, data } = await req(handler, "/api/settings");
    assert.equal(status, 200);
    assert.equal(data.packageServer.value, DEAD_PACKAGE_URL);
    assert.equal(data.packageServer.source, "env", "PAAW_PACKAGE_URL 有設 → source=env");
    assert.equal(data.packageServer.envLocked, true);
    assert.equal(data.paawHome.value, env.home);
    assert.equal(data.paawHome.source, "env", "PAAW_HOME 有設 → source=env");
    assert.equal(data.paawHome.envLocked, true);
  });

  // ── 7-2. GET：Host gate 已套用全部請求（TASK-005 / MED-001 行為變更）──
  it("GET 帶惡意 Origin 但合法 Host → 仍 200（GET 不驗 Origin 的設計不變）", async () => {
    const { status } = await withFetch(
      refusingFetch,
      async () => req(handler, "/api/status", { headers: { origin: "http://evil.example" } }),
    );
    assert.equal(status, 200, "GET 是讀取操作，不做 Origin 檢查");
  });

  it("GET 帶惡意 Host（evil.example / 帶 port）→ 403 untrusted Host（TASK-005：Host gate 套用所有請求）", async () => {
    for (const badHost of ["evil.example", "evil.example:4290"]) {
      const { status } = await withFetch(
        refusingFetch,
        async () => req(handler, "/api/status", { headers: { host: badHost } }),
      );
      assert.equal(status, 403, `GET Host="${badHost}" 應被拒（TASK-005 全請求 Host gate）`);
    }
  });
});

// ─────────────────────────────────────────────────────────────

describe("E2E · TASK-005 安全修復（settings body 上限 / update fail-closed）", () => {
  let env;
  let handler;

  before(async () => {
    // No PAAW_PACKAGE_URL → packageServer can be set dynamically via POST /api/settings
    env = makeEnv({ packageUrl: null });
    handler = env.handler;
  });

  after(() => {
    if (env) {
      cleanupEnv(env.savedEnv, env.savedCwd);
      rmSync(env.tmp, { recursive: true, force: true });
    }
  });

  it("POST /api/settings body > 1MB → 連線被切（413/destroy），server 不處理且仍存活", async () => {
    const bigJson = JSON.stringify({ padding: "x".repeat(1536 * 1024) }); // 1.5MB，合法 JSON
    const outcome = await req(handler, "/api/settings", {
      method: "POST",
      headers: { "content-length": String(Buffer.byteLength(bigJson)) },
      body: bigJson,
    });
    // In-process: req.destroy() fires, handler returns 413, but the response
    // is still captured by mockRes (unlike real socket where destroy kills it).
    // Either 413 (response captured) or destroyed flag signals the cap worked.
    const rejected =
      outcome.status === 413 ||
      outcome.reqDestroyed;
    assert.ok(rejected, `超限 body 應被 413/destroy 拒絕，實測：status=${outcome.status}, reqDestroyed=${outcome.reqDestroyed}`);

    // 拒絕是連線級而非進程級：server 存活，緊接的小請求照常 200
    const alive = await req(handler, "/api/settings", { method: "POST", body: "{}" });
    assert.equal(alive.status, 200);
    assert.equal(alive.data.ok, true);
  });

  it("POST /api/settings body 正常大小（512KB 合法 JSON）→ 200（上限不誤擋正常設定）", async () => {
    const midJson = JSON.stringify({ padding: "x".repeat(512 * 1024) }); // 未知欄位 → 不改任何設定
    const { status, data } = await req(handler, "/api/settings", {
      method: "POST",
      headers: { "content-length": String(Buffer.byteLength(midJson)) },
      body: midJson,
    });
    assert.equal(status, 200, "未超上限的合法 JSON 要正常處理");
    assert.equal(data.ok, true);
    assert.deepEqual(data.changed, [], "未知欄位不觸發設定變更（純測 body 尺寸路徑）");
  });

  it("update：惡意 stable.version（999.0.0/../../x）→ job.error 含 invalid version，HOME 零寫入", async () => {
    // 1) Fake fetch that returns a manifest with path-traversal version
    const fakeManifest = {
      version: "999.0.0/../../x",
      sha256: "0".repeat(64), // 假 sha — 不該走到下載；就算走到也會失敗
      size: 1,
    };
    const fakeFetch = (url, _opts) => {
      // Only respond to stable.json; everything else 404
      if (String(url).endsWith("/stable.json")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => fakeManifest,
        });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    };
    // We need a packageServer URL that the handler will use when calling
    // loadPackageServerUrl → updateLogic. Since PAAW_PACKAGE_URL is unset,
    // setCfgField("packageServer", ...) determines the URL.
    const fakeUrl = "http://127.0.0.1:9999";

    // 2) 把 gateway 的 packageServer 指向 fake（無 env 鎖 → changed 生效，模擬 manifest 可控情境）
    const set = await req(handler, "/api/settings", {
      method: "POST",
      body: JSON.stringify({ packageServer: fakeUrl }),
    });
    assert.equal(set.status, 200);
    assert.deepEqual(set.data.changed, ["packageServer"], "無 PAAW_PACKAGE_URL env → 設定應生效");
    assert.equal(set.data.packageServer, fakeUrl.replace(/\/$/, ""));

    // 3) 觸發 update（非同步 job，回 202）— inject fake fetch so updateLogic
    //    hits our mock instead of a real server.
    //    runJob fires an IIFE (async () => { … })() WITHOUT awaiting, so the
    //    actual uiUpdate → updateLogic → fetch runs AFTER the handler returns.
    //    withFetch restores too early → we must manually manage the patch for
    //    the full trigger + poll window.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      const upd = await req(handler, "/api/update", { method: "POST" });
      assert.ok(upd.status === 202 || upd.status === 200, `update 應被受理（202/200），實測 ${upd.status}`);

      // 4) 輪詢 job 結果（fake fetch 本機 → 秒失敗，5 秒綽綽有餘）
      //    The job runs asynchronously (runJob → uiUpdate). Poll via /api/status
      //    because uiStatus() reads the module-level job (runJob also uses
      //    the module-level job; deps.job is only for the handler's own checks).
      let jobStatus = null;
      for (let i = 0; i < 50; i++) {
        await sleep(100);
        const { data: st } = await req(handler, "/api/status");
        jobStatus = st.job;
        if (!jobStatus.active) break;
      }
      assert.ok(jobStatus, "要輪詢得到 job 狀態");
      assert.equal(jobStatus.active, false, "update job 要在時間內結束");
      assert.match(
        jobStatus.error,
        /invalid version from manifest/,
        "VERSION_RE fail-closed 的錯誤要浮上 job.error（而非下載 404 之類的下游錯誤）",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    // 5) 零寫入斷言：current.json 不存在、versions/ 不存在、若攻擊得手
    //    join(VERSIONS_DIR, "999.0.0/../../x") 的落點 HOME/x 也會不存在
    assert.equal(existsSync(join(env.home, "current.json")), false, "current.json 不可被污染");
    assert.equal(existsSync(join(env.home, "versions")), false, "versions/ 不可被建出任何目錄");
    assert.equal(existsSync(join(env.home, "x")), false, "path-traversal 落點 HOME/x 不可存在");

    // 6) 現況確認：current 仍 null（stable 照實反映 fake manifest，但 update 已 fail-closed）
    //    Re-inject fake fetch so uiStatus's stable.json probe hits our mock
    const originalFetch2 = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      const { data: st } = await req(handler, "/api/status");
      assert.equal(st.current, null, "current 維持未安裝");
      assert.equal(st.stable, "999.0.0/../../x", "uiStatus 照實轉發 stable.version（顯示端靠 esc() 轉義，MAJ-001b）");
    } finally {
      globalThis.fetch = originalFetch2;
    }
  });
});
