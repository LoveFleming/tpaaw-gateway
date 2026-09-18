/**
 * E2E tests — Gateway UI (gateway.mjs cmdUI): F7 CSRF/Host 防護 + GET 煙霧 + 安全修復回歸
 * （TASK-004 建立；TASK-005 更新 GET Host 案例並新增 settings body 上限 / update fail-closed 案例）
 *
 * 對象：gateway.mjs cmdUI — 所有請求（GET+POST）先驗 Host 白名單（HOST_WHITELIST =
 * 127.0.0.1 / localhost / ::1 + UI_HOST；TASK-005 起從 POST-only 放寬為全部請求），
 * POST 再驗非空 Origin 的主機也須在白名單，違者 403。GET 為讀取操作，仍不驗 Origin。
 *
 * TASK-005 新增對象（見檔尾第二個 describe）：
 *  - POST /api/settings body 上限 1MB（MAX_SETTINGS_BODY）：超限即 destroy 連線不處理
 *  - POST /api/update → updateLogic 對 manifest.version 做 VERSION_RE fail-closed
 *    （惡意 version 不得觸發任何路徑拼接 / 寫入）
 *
 * 隔離策略（絕不碰開發者本機正在跑的 gateway :4290）：
 *  - spawn 真 gateway.mjs "ui" 子進程，PAAW_GW_PORT 注入隨機可用 port（getFreePort）
 *  - cwd = mkdtemp temp dir → 讀不到專案目錄的 gateway.json（GATEWAY_CFG 以 cwd 找）
 *  - PAAW_HOME → temp dir（versions/ data/ logs/ current.json 全長在 temp）
 *  - PAAW_PACKAGE_URL=http://127.0.0.1:1 → uiStatus() 的 stable.json fetch 瞬間
 *    ECONNREFUSED（而非 3 秒 timeout），GET /api/status 快速回應且 stable 恆為 null
 *  - PAAW_OPEN_BROWSER=0、PAAW_PORT=另一隨機 port（雙保險：測試不觸發 /api/start，
 *    即使被觸發也不會 spawn 撞 4097 的 PAAW）
 *  - Host / Origin header 用 node:http.request 精準控制（含「無 Origin」確定性），
 *    因 fetch(undici) 對 Host 這類 forbidden header 的覆寫行為不可靠
 *  - cleanup：SIGTERM（觸發 gateway 的 bye handler）→ 等退出 → rm temp dir；
 *    另掛 process exit kill-switch 防孤兒進程卡死 test runner
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATEWAY_PATH = join(__dirname, "..", "..", "gateway.mjs");

// 保證連不上且「瞬間」失敗的 package server（port 1 無 root 不可能有人聽）
const DEAD_PACKAGE_URL = "http://127.0.0.1:1";
const READY_TIMEOUT_MS = 10_000;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 低階 HTTP 請求（node:http）— 精準控制 Host / Origin header 的出現與內容。
 * 連線目標永遠是 127.0.0.1:<port>（TCP 層），Host/Origin 只是 header 字串，
 * 藉此模擬「DNS rebinding / 惡意網頁帶偽造 Host」的攻擊情境。
 *
 * 連線層錯誤（server destroy 造成的 ECONNRESET / socket hang up）不 reject，
 * 改為 resolve { status: null, data: null, error } — 413+destroy 案例需要觀測這個。
 */
function rawReq(base, path, { method = "GET", headers = {}, body } = {}) {
  const url = new URL(base + path);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers, // 傳什麼就是什麼：不帶 origin 就真的沒有 Origin header
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let data = null;
          try { data = JSON.parse(buf); } catch { /* 非 JSON 回應 */ }
          resolve({ status: res.statusCode, data, error: null });
        });
        res.on("aborted", () => resolve({ status: res.statusCode, data: null, error: "aborted" }));
        res.on("error", (e) => resolve({ status: null, data: null, error: e.code || e.message }));
      },
    );
    req.on("error", (e) => resolve({ status: null, data: null, error: e.code || e.message }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Spawn 一個隔離的 gateway UI 子進程，等到 GET /api/settings 可用（gateway.mjs
 * 沒有 /api/health；/api/settings 是純讀、無網路副作用，最適合當 readiness probe）。
 * 回傳 { child, base, tmp, home, port }。
 *
 * @param {object} [opts]
 * @param {string|null} [opts.packageUrl] 注入 PAAW_PACKAGE_URL（預設 DEAD_PACKAGE_URL，
 *   讓 uiStatus 的 stable.json fetch 瞬間失敗）。傳 null 則「不設」此 env —
 *   測試才可經 POST /api/settings 動態改 packageServer（TASK-005 update 案例）。
 */
async function startGatewayUi({ packageUrl = DEAD_PACKAGE_URL } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "paaw-gwui-e2e-"));
  const home = join(tmp, "home");
  mkdirSync(home, { recursive: true });
  const port = await getFreePort();

  const child = spawn(process.execPath, [GATEWAY_PATH, "ui"], {
    cwd: tmp, // 不讀專案目錄的 gateway.json
    env: {
      ...process.env,
      ...(packageUrl ? { PAAW_PACKAGE_URL: packageUrl } : {}),
      PAAW_GW_PORT: String(port),
      PAAW_HOME: home,
      PAAW_OPEN_BROWSER: "0",
      PAAW_PORT: String(await getFreePort()), // 雙保險：測試不會 spawn PAAW 撞 4097
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  ACTIVE_CHILDREN.add(child);
  child.once("exit", () => ACTIVE_CHILDREN.delete(child));
  let childLog = "";
  child.stdout.on("data", (c) => { childLog += c; });
  child.stderr.on("data", (c) => { childLog += c; });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`gateway ui 子進程提前退出 (code=${child.exitCode})\n${childLog}`);
    }
    try {
      const r = await fetch(base + "/api/settings");
      if (r.ok) break;
    } catch { /* 尚未起來，繼續輪詢 */ }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`gateway ui 在 ${READY_TIMEOUT_MS}ms 內沒起來\n${childLog}`);
    }
    await sleep(100);
  }
  return { child, base, tmp, home, port };
}

/** 溫和關閉：SIGTERM（觸發 bye handler）→ 等真的退出 → 清 temp dir */
async function stopGatewayUi(g) {
  if (!g) return;
  if (g.child.exitCode === null) {
    await new Promise((done) => {
      g.child.once("exit", done);
      g.child.kill("SIGTERM");
      setTimeout(done, 3000); // 等不到就用 exit kill-switch 兜底
    });
  }
  rmSync(g.tmp, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────

describe("E2E · Gateway UI CSRF 防護與 GET 煙霧（gateway.mjs F7）", () => {
  let g;
  let base, port;

  before(async () => {
    g = await startGatewayUi();
    base = g.base;
    port = g.port;
  });

  after(() => stopGatewayUi(g));

  // ── 1. POST：白名單外 Origin → 403 ──
  it("POST 帶白名單外 Origin（http://evil.example）→ 403 untrusted Origin", async () => {
    const { status, data } = await rawReq(base, "/api/settings", {
      method: "POST",
      headers: { origin: "http://evil.example" },
      body: "{}",
    });
    assert.equal(status, 403);
    assert.equal(data.ok, false);
    assert.match(data.message, /untrusted Origin/, "錯誤訊息要指明是 Origin 被拒");
  });

  it("POST 帶後綴偽裝 Origin（http://localhost.evil.example）→ 403（防白名單後綴繞過）", async () => {
    const { status, data } = await rawReq(base, "/api/settings", {
      method: "POST",
      headers: { origin: "http://localhost.evil.example" },
      body: "{}",
    });
    assert.equal(status, 403);
    assert.match(data.message, /untrusted Origin/);
  });

  // ── 2. POST：非法 Origin（"null"、非 URL 字串）→ 403 ──
  it("POST 帶非法 Origin（\"null\" 與非 URL 字串）→ 403（new URL 解析失敗一律拒絕）", async () => {
    for (const badOrigin of ["null", "not a url"]) {
      const { status, data } = await rawReq(base, "/api/settings", {
        method: "POST",
        headers: { origin: badOrigin },
        body: "{}",
      });
      assert.equal(status, 403, `Origin="${badOrigin}" 應該 403`);
      assert.match(data.message, /untrusted Origin/);
    }
  });

  // ── 3. POST：合法 Origin → 放行（非 403；POST /api/settings 空 body 為零副作用的 200）──
  it("POST 帶合法 Origin（127.0.0.1 / localhost / [::1] 帶 port）→ 200，不被 CSRF 擋下", async () => {
    for (const goodOrigin of [
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      `http://[::1]:${port}`,
    ]) {
      const { status, data } = await rawReq(base, "/api/settings", {
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
    const { status, data } = await rawReq(base, "/api/settings", {
      method: "POST",
      body: "{}",
    });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
  });

  it("POST 無 Origin 打不存在的 endpoint → 404（證明請求已通過 CSRF gate 到達 router）", async () => {
    const { status } = await rawReq(base, "/api/no-such-endpoint", { method: "POST" });
    assert.equal(status, 404, "通過 CSRF gate 的 POST 應由 router 回 404，而非 403");
  });

  // ── 5. POST：惡意 Host → 403 ──
  it("POST 帶惡意 Host（evil.example）→ 403 untrusted Host（DNS rebinding 防護）", async () => {
    const { status, data } = await rawReq(base, "/api/settings", {
      method: "POST",
      headers: { host: "evil.example" }, // 不帶 Origin — 單獨驗 Host 檢查
      body: "{}",
    });
    assert.equal(status, 403);
    assert.equal(data.ok, false);
    assert.match(data.message, /untrusted Host/, "錯誤訊息要指明是 Host 被拒");
  });

  it("POST 帶惡意 Host（evil.example:<port> 帶 port / 後綴偽裝）→ 403（hostOf 需拆 hostname 再比）", async () => {
    for (const badHost of ["evil.example:4290", "127.0.0.1.evil.example"]) {
      const { status } = await rawReq(base, "/api/settings", {
        method: "POST",
        headers: { host: badHost },
        body: "{}",
      });
      assert.equal(status, 403, `Host="${badHost}" 應該 403（拆 hostname 後仍不在白名單）`);
    }
  });

  // ── 6. POST：合法 Host（localhost 帶 port）→ 放行 ──
  it("POST Host 帶 port 的合法形式（localhost:<port>）→ 200（hostOf 去 port 正常路徑）", async () => {
    const { status, data } = await rawReq(base, "/api/settings", {
      method: "POST",
      headers: { host: `localhost:${port}` },
      body: "{}",
    });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
  });

  // ── 7. GET 煙霧：讀取路徑不受 CSRF 防護影響 ──
  it("GET /api/status → 200 + 合法 JSON（隔離環境：current null、stable null、running false）", async () => {
    const res = await fetch(base + "/api/status");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.home, g.home, "home 要指到測試的 PAAW_HOME temp dir");
    assert.equal(data.current, null, "temp home 無 current.json");
    assert.deepEqual(data.installed, [], "temp home 無任何版本");
    assert.equal(data.stable, null, "package server 指到死位址 → stable 恆 null（無外站依賴）");
    assert.equal(data.running, false, "測試從未啟動 PAAW");
    assert.equal(data.job.active, false);
  });

  it("GET /api/settings → 200 + 合法 JSON（env 鎖定：packageServer/paawHome 來源正確）", async () => {
    const res = await fetch(base + "/api/settings");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.packageServer.value, DEAD_PACKAGE_URL);
    assert.equal(data.packageServer.source, "env", "PAAW_PACKAGE_URL 有設 → source=env");
    assert.equal(data.packageServer.envLocked, true);
    assert.equal(data.paawHome.value, g.home);
    assert.equal(data.paawHome.source, "env", "PAAW_HOME 有設 → source=env");
    assert.equal(data.paawHome.envLocked, true);
  });

  // ── 7-2. GET：Host gate 已套用全部請求（TASK-005 / MED-001 行為變更）──
  // 舊斷言「GET 不驗 Host → 200」已隨修失效：Host 白名單現在 GET 也檢查（防 DNS
  // rebinding 讀取面）。GET 維持「不驗 Origin」— Origin 是瀏覽器 POST/form 專屬防護。
  it("GET 帶惡意 Origin 但合法 Host → 仍 200（GET 不驗 Origin 的設計不變）", async () => {
    const byOrigin = await rawReq(base, "/api/status", { headers: { origin: "http://evil.example" } });
    assert.equal(byOrigin.status, 200, "GET 是讀取操作，不做 Origin 檢查");
  });

  it("GET 帶惡意 Host（evil.example / 帶 port）→ 403 untrusted Host（TASK-005：Host gate 套用所有請求）", async () => {
    for (const badHost of ["evil.example", "evil.example:4290"]) {
      const { status, data } = await rawReq(base, "/api/status", { headers: { host: badHost } });
      assert.equal(status, 403, `Host="${badHost}" 的 GET 應被 Host gate 擋下（MED-001）`);
      assert.equal(data.ok, false);
      assert.match(data.message, /untrusted Host/);
    }
    // 拿回控制權：合法 Host 的 GET 立即恢復 200
    const ok = await rawReq(base, "/api/status");
    assert.equal(ok.status, 200);
  });
});

// ═══════════════════════════════════════════════════════════════
// TASK-005（2026-09-18）：安全修復回歸 — settings body 上限 + update fail-closed
// ═══════════════════════════════════════════════════════════════

/** 起 fake package server（node:http、隨機 port）— stable.json 回指定 manifest */
function startFakePackageServer(manifest) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      if ((req.url || "").split("?")[0] === "/stable.json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(manifest));
      } else {
        res.writeHead(404); // 含 /packages/<v>/paaw.zip — 攻擊若沒被擋，下載會走到這裡失敗
        res.end("nope");
      }
    });
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

describe("E2E · TASK-005 安全修復（settings body 上限 / update fail-closed）", () => {
  let g;
  let base;
  let fake;

  before(async () => {
    // 不設 PAAW_PACKAGE_URL（packageUrl: null）→ packageServer 可由 POST /api/settings 動態改
    g = await startGatewayUi({ packageUrl: null });
    base = g.base;
  });

  after(async () => {
    if (fake) fake.srv.close();
    await stopGatewayUi(g);
  });

  it("POST /api/settings body > 1MB → 連線被切（413/destroy），server 不處理且仍存活", async () => {
    const bigJson = JSON.stringify({ padding: "x".repeat(1536 * 1024) }); // 1.5MB，合法 JSON
    const outcome = await rawReq(base, "/api/settings", {
      method: "POST",
      headers: { "content-length": String(Buffer.byteLength(bigJson)) },
      body: bigJson,
    });
    // 實作順序是 tooBig → req.destroy() → jsonOut(413)：destroy 先斷 socket，
    // client 實測觀測到 ECONNRESET（413 回應來不及送達也視為拒絕成功）
    const rejected =
      outcome.status === 413 ||
      (outcome.status === null && /ECONNRESET|EPIPE|socket hang up|aborted/i.test(String(outcome.error)));
    assert.ok(rejected, `超限 body 應被 413/destroy 拒絕，實測：${JSON.stringify(outcome)}`);

    // 拒絕是連線級而非進程級：server 存活，緊接的小請求照常 200
    const alive = await rawReq(base, "/api/settings", { method: "POST", body: "{}" });
    assert.equal(alive.status, 200);
    assert.equal(alive.data.ok, true);
  });

  it("POST /api/settings body 正常大小（512KB 合法 JSON）→ 200（上限不誤擋正常設定）", async () => {
    const midJson = JSON.stringify({ padding: "x".repeat(512 * 1024) }); // 未知欄位 → 不改任何設定
    const { status, data } = await rawReq(base, "/api/settings", {
      method: "POST",
      headers: { "content-length": String(Buffer.byteLength(midJson)) },
      body: midJson,
    });
    assert.equal(status, 200, "未超上限的合法 JSON 要正常處理");
    assert.equal(data.ok, true);
    assert.deepEqual(data.changed, [], "未知欄位不觸發設定變更（純測 body 尺寸路徑）");
  });

  it("update：惡意 stable.version（999.0.0/../../x）→ job.error 含 invalid version，HOME 零寫入", async () => {
    // 1) fake package server 回帶 path-traversal version 的 stable.json
    fake = await startFakePackageServer({
      version: "999.0.0/../../x",
      sha256: "0".repeat(64), // 假 sha — 不該走到下載；就算走到也會失敗
      size: 1,
    });
    const fakeUrl = `http://127.0.0.1:${fake.port}`;

    // 2) 把 gateway 的 packageServer 指向 fake（無 env 鎖 → changed 生效，模擬 manifest 可控情境）
    const set = await rawReq(base, "/api/settings", {
      method: "POST",
      body: JSON.stringify({ packageServer: fakeUrl }),
    });
    assert.equal(set.status, 200);
    assert.deepEqual(set.data.changed, ["packageServer"], "無 PAAW_PACKAGE_URL env → 設定應生效");
    assert.equal(set.data.packageServer, fakeUrl.replace(/\/$/, ""));

    // 3) 觸發 update（非同步 job，回 202）
    const upd = await rawReq(base, "/api/update", { method: "POST" });
    assert.ok(upd.status === 202 || upd.status === 200, `update 應被受理（202/200），實測 ${upd.status}`);

    // 4) 輪詢 job 結果（fake server 本機 → 秒失敗，5 秒綽綽有餘）
    let job = null;
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      const st = await (await fetch(base + "/api/status")).json();
      job = st.job;
      if (!job.active) break;
    }
    assert.ok(job, "要輪詢得到 job 狀態");
    assert.equal(job.active, false, "update job 要在時間內結束");
    assert.match(
      job.error,
      /invalid version from manifest/,
      "VERSION_RE fail-closed 的錯誤要浮上 job.error（而非下載 404 之類的下游錯誤）",
    );

    // 5) 零寫入斷言：current.json 不存在、versions/ 不存在、若攻擊得手
    //    join(VERSIONS_DIR, "999.0.0/../../x") 的落點 HOME/x 也會不存在
    assert.equal(existsSync(join(g.home, "current.json")), false, "current.json 不可被污染");
    assert.equal(existsSync(join(g.home, "versions")), false, "versions/ 不可被建出任何目錄");
    assert.equal(existsSync(join(g.home, "x")), false, "path-traversal 落點 HOME/x 不可存在");

    // 6) 現況確認：current 仍 null（stable 照實反映 fake manifest，但 update 已 fail-closed）
    const st = await (await fetch(base + "/api/status")).json();
    assert.equal(st.current, null, "current 維持未安裝");
    assert.equal(st.stable, "999.0.0/../../x", "uiStatus 照實轉發 stable.version（顯示端靠 esc() 轉義，MAJ-001b）");
  });
});
