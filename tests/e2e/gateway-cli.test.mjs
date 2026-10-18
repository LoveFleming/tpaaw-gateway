/**
 * E2E tests — Gateway CLI (gateway.mjs): F20261009-001 啟動器 CLI 覆蓋
 *
 * 背景：gateway.mjs 是 composition root + CLI 入口，頂層 `if/else` 直接分派 argv
 * 並在錯誤路徑呼叫 process.exit → 無法 in-process unit 測（import 即執行）。
 * 因此沿用 tests/e2e/gateway-ui-csrf.test.mjs 的「spawn 真 gateway」模式，
 * 以子進程的 stdout / stderr / exit code 為可觀察介面。
 *
 * 對象（皆不需 listen TCP，避開沙箱 EPERM 限制）：
 *   1. status  — 空 PAAW_HOME + 不可達 package server → exit 0，輸出含 PAAW_HOME / package server
 *   2. 未知指令 — `bogus-cmd` → exit 1，stderr 含「未知指令」+ 可用指令清單
 *   3. upload 缺參數 — `upload` → exit 1，stderr 含用法提示
 *   4. upload 不存在的檔 — `upload /nonexistent.zip` → exit != 0（readFile ENOENT）
 *
 * 隔離策略（比照 TASK-033~036 測試衛生標準）：
 *  - spawn(process.execPath) — 跨平台，不依賴 "node" 在 PATH
 *  - cwd = mkdtemp temp dir → 讀不到專案目錄的 gateway.json（GATEWAY_CFG 以 cwd 找）
 *  - PAAW_HOME → temp dir（versions/ data/ logs/ current.json 全長在 temp，不污染專案）
 *  - PAAW_PACKAGE_URL=http://127.0.0.1:1 → status 的 stable.json fetch 瞬間 ECONNREFUSED
 *    （本機無 root 不可能有人聽 port 1）→ stable 顯示「無法連線」但不 crash（catch 吞掉）。
 *    若該分支改走 4s timeout，測試 timeout 已放大到 20s 容忍。
 *  - 子進程一律帶 timeout kill + exit kill-switch，防孤兒進程卡死 test runner
 *  - 每個案例結束清 temp dir
 *
 * 不測 `ui` 指令（需要 listen 127.0.0.1，本沙箱 EPERM）— 該路徑由既有
 * gateway-ui-csrf.test.mjs 覆蓋。
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATEWAY_PATH = join(__dirname, "..", "..", "gateway.mjs");

// 保證連不上且「瞬間」失敗的 package server（port 1 無 root 不可能有人聽）
const DEAD_PACKAGE_URL = "http://127.0.0.1:1";
// status 的 fetch 用 4000ms timeout；放大到 20s 讓「走 timeout 分支」也能安全通過
const CHILD_TIMEOUT_MS = 20_000;

// ── 孤兒進程保險：不論測試怎麼失敗，退出前把所有子進程斷電 ──
const ACTIVE_CHILDREN = new Set();
process.on("exit", () => {
  for (const child of ACTIVE_CHILDREN) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

/**
 * 跑一次 gateway CLI，收集 stdout / stderr / exit code。
 * @param {string[]} args argv 傳給 gateway.mjs（如 ["status"]）
 * @param {object}   [opts]
 * @param {string}   [opts.home] 注入 PAAW_HOME（預設呼叫端提供的 temp）
 * @param {string}   [opts.packageUrl] 注入 PAAW_PACKAGE_URL（預設 DEAD_PACKAGE_URL；null = 不設）
 * @param {string}   [opts.cwd] 子進程工作目錄（預設 temp）
 * @returns {Promise<{code:number|null, signal:string|null, stdout:string, stderr:string, timedOut:boolean}>}
 */
function runGateway(args, { home, packageUrl = DEAD_PACKAGE_URL, cwd } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [GATEWAY_PATH, ...args], {
      cwd,
      env: {
        ...process.env,
        ...(home ? { PAAW_HOME: home } : {}),
        ...(packageUrl ? { PAAW_PACKAGE_URL: packageUrl } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    ACTIVE_CHILDREN.add(child);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));

    // 硬 timeoute：程序若卡住（例如意外走了慢路徑）強制斷電，避免拖垮 test runner
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, CHILD_TIMEOUT_MS);

    child.on("close", (code, signal) => {
      clearTimeout(killer);
      ACTIVE_CHILDREN.delete(child);
      resolvePromise({ code, signal, stdout, stderr, timedOut });
    });
  });
}

describe("E2E · gateway.mjs CLI（F20261009-001）", () => {
  let tmp;
  let home;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "paaw-gwcli-e2e-"));
    home = join(tmp, "home"); // 空目錄 → status 顯示「未安裝 / 未播種」
    mkdirSync(home, { recursive: true });
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("status：空 PAAW_HOME + 不可達 package server → exit 0，輸出含 PAAW_HOME 與 package server", async () => {
    const r = await runGateway(["status"], { home, cwd: tmp });

    assert.equal(r.timedOut, false, "status 不應超時（package server 未連上走 catch 分支）");
    assert.equal(r.code, 0, `status 應 exit 0，實測 code=${r.code} signal=${r.signal}\nstderr: ${r.stderr}`);

    // 核心輸出欄位（依 cmdStatus 實作格式）
    assert.match(r.stdout, /^PAAW_HOME\s/m, "輸出需含 PAAW_HOME 欄位");
    assert.match(r.stdout, /^package server\s/m, "輸出需含 package server 欄位");
    assert.match(r.stdout, /^current\s/m, "輸出需含 current 欄位");
    assert.match(r.stdout, /^installed\s/m, "輸出需含 installed 欄位");
    assert.match(r.stdout, /^stable latest\s/m, "輸出需含 stable latest 欄位");

    // PAAW_HOME 值應等於注入的 temp home（證明 env 有生效）
    assert.ok(r.stdout.includes(home), `輸出應含注入的 PAAW_HOME 路徑 ${home}`);

    // package server 指向注入的不可達位址 → fetch 失敗被 catch 吞掉，stable 顯示未知但「不 crash」
    assert.ok(
      r.stdout.includes(DEAD_PACKAGE_URL),
      `輸出應反映注入的 package server ${DEAD_PACKAGE_URL}`,
    );
    // ⚠️ 刻意不斷言 stable 的具體值（避免 timeout 分支變動造成 flake）；
    //    只確認進程正常結束、stable 欄位存在即符合「不 crash」的驗收。

    // 空 home → 現況欄位可見（不依賴網路）
    assert.match(r.stdout, /current\s+（未安裝）/, "空 home 應顯示未安裝");
    assert.match(r.stdout, /installed\s+none/, "空 home 應顯示 none");
  });

  it("未知指令：`bogus-cmd` → exit 1，stderr 含「未知指令」與可用指令清單", async () => {
    const r = await runGateway(["bogus-cmd"], { home, cwd: tmp });

    assert.equal(r.timedOut, false, "未知指令應立即結束，不超時");
    assert.equal(r.code, 1, `未知指令應 exit 1，實測 code=${r.code}`);
    assert.match(r.stderr, /未知指令/, "stderr 應含「未知指令」");
    // 可用指令清單（ui | start | update | upload | status）
    for (const c of ["ui", "start", "update", "upload", "status"]) {
      assert.ok(r.stderr.includes(c), `stderr 清單應列出可用指令「${c}」`);
    }
  });

  it("upload 缺參數：`upload` → exit 1，stderr 含用法提示", async () => {
    const r = await runGateway(["upload"], { home, cwd: tmp });

    assert.equal(r.timedOut, false, "缺參數應立即結束，不超時");
    assert.equal(r.code, 1, `upload 缺參數應 exit 1，實測 code=${r.code}`);
    assert.match(r.stderr, /用法/, "stderr 應含用法提示");
    assert.match(r.stderr, /upload/, "用法提示應提及 upload");
  });

  it("upload 指向不存在的檔：`upload /nonexistent.zip` → 非 0 退出（readFile ENOENT）", async () => {
    const r = await runGateway(["upload", "/nonexistent.zip"], { home, cwd: tmp });

    assert.equal(r.timedOut, false, "不存在的檔應立即失敗，不超時");
    assert.notEqual(r.code, 0, "readFile ENOENT 應以非 0 退出（uncaught error）");
    // Node 未捕捉例外 → exit 1 且 stderr 帶 ENOENT 堆疊
    assert.match(r.stderr, /ENOENT/, "stderr 應含 ENOENT 錯誤");
  });
});
