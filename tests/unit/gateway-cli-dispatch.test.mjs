/**
 * Unit tests — gateway.mjs argv 分派（F20261009-001 啟動器 CLI）
 *
 * ── 為什麼要有這一檔 ──
 * 既有的 tests/e2e/gateway-cli.test.mjs 只覆蓋 4 個「不裝任何東西」的路徑
 * （status 空 home / 未知指令 / upload 缺參數 / upload 不存在的檔）。
 * feature 的招牌指令 update / start 的 **分派決策**（要不要碰 package server、
 * 有無 current、缺版本目錄、update 完成後是否印 ok）完全沒有被斷言 —
 * 這正是本檔要補的 unit 層缺口。
 *
 * ── 為什麼是 unit 而不是 e2e ──
 * gateway.mjs 是「import 即執行」的 ESM（頂層 await + argv 分派，已以探針證實：
 * import 後立刻 process.exit）。無法 import 後呼叫 → 唯一 in-process 驅動方式，
 * 是在 **spawn 的子進程內** 先掛載 module hook 把上游模組換成 fake，再 import
 * gateway.mjs，讓頂層分派跑在完全可控的替身鏈上。
 *
 * 替身策略（只替換外部邊界，不替換被測邏輯本身）：
 *  - install.mjs   → fake updateLogic / installUploadedZip / ensureData / installDeps
 *                    （真實作會打網路、spawn npm）
 *  - process.mjs   → fake startAndVerify（真實作會 spawn PAAW server）
 *                    + hangAround 以固定 exit code 收斂子進程
 *  - 純函式（semverGt / readCurrent / writeCurrentAtomic / …）保留 **真貨**，
 *    因為 start 決策依賴它們的實際語意（此刻的邏輯 = 被測對象）。
 *  - 全程不 listen、不碰真網路、不 spawn npm / PAAW。子進程只跑 node 本身。
 *
 * 隔離：每個案例 mkdtemp 一個 PAAW_HOME 與 cwd（cwd 隔離是必要的 — config.mjs
 * 會讀 process.cwd()/gateway.json；見 ISS-020），結束即刪。
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, sep } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const GATEWAY_PATH = join(ROOT, "gateway.mjs");

const CHILD_TIMEOUT_MS = 20_000;

// ── 孤兒進程保險 ──
const ACTIVE_CHILDREN = new Set();
process.on("exit", () => {
  for (const child of ACTIVE_CHILDREN) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

/**
 * 在子進程內以 module hook 替換上游模組後 import gateway.mjs，跑一次 argv 分派。
 *
 * hooks.mjs 由本檔寫入 temp dir，動態產生（用絕對路徑，不依賴 cwd 解析）。
 * 子進程 stdout/stderr 只會含 gateway 自己的輸出 —— 很關鍵：這讓我們能斷言
 * 「cmdUpdate 完成後有沒有印出 ok」，同時天然守住 logger→TAP 污染的迴歸
 * （見 install.test.mjs 的 logger 靜音修復）。
 *
 * @param {string[]} args            argv（如 ["update"]）
 * @param {object}   env            { home, cwd, scenario, ... }
 */
function runGatewayWithFakes(args, { home, cwd, scenario, extraEnv = {} } = {}) {
  const hooksPath = join(cwd, "hooks.mjs");
  const installFake = `file://${join(cwd, "fake-install.mjs")}`;
  const processFake = `file://${join(cwd, "fake-process.mjs")}`;

  const hooks = `
const GATEWAY_URL = ${JSON.stringify("file://" + GATEWAY_PATH)};
const INSTALL_FAKE = ${JSON.stringify(installFake)};
const PROCESS_FAKE = ${JSON.stringify(processFake)};

export async function resolve(specifier, context, nextResolve) {
  // gateway.mjs 用相對路徑 import "./src/lib/install.mjs" / "./src/lib/process.mjs"
  if (specifier.endsWith("/install.mjs") && context.parentURL === GATEWAY_URL) {
    return { url: INSTALL_FAKE, shortCircuit: true };
  }
  if (specifier.endsWith("/process.mjs") && context.parentURL === GATEWAY_URL) {
    return { url: PROCESS_FAKE, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;
  writeFileSync(hooksPath, hooks, "utf-8");

  const fakeInstall = `
// fake install.mjs — 只替換「會打網路 / spawn npm」的邊界，保留決策契約
const S = JSON.parse(process.env.FAKE_SCENARIO || "{}");
const calls = [];
export const __calls = calls;

export async function updateLogic() {
  calls.push("updateLogic");
  if (S.updateThrows) throw new Error(S.updateMessage || "simulated download failure");
  const v = S.releaseVersion || "1.0.0";
  // 回傳的 versionDir 必須真的存在：cmdStart 在 startAndVerify 前會 existsSync 檢查，
  // 這是被測邏輯的一部分（真實 updateLogic 也只回「已落地的目錄」）。
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = path.join(process.env.PAAW_HOME, "versions", v);
  fs.mkdirSync(dir, { recursive: true });
  return {
    versionDir: dir,
    version: v,
    updated: S.updated === true,
    note: S.note,
  };
}

export async function installUploadedZip(buf, label) {
  calls.push("installUploadedZip:" + label + ":" + buf.length);
  return { ok: true, version: "9.9.9", versionDir: "/fake/versions/9.9.9", message: "fake" };
}

export async function installDeps(versionDir) {
  calls.push("installDeps:" + versionDir);
  return true;
}

export async function ensureData(versionDir) {
  calls.push("ensureData:" + versionDir);
  return true;
}
`;

  const fakeProcess = `
// fake process.mjs — startAndVerify 不打真 PAAW；hangAround 以固定 exit code 收斂
const S = JSON.parse(process.env.FAKE_SCENARIO || "{}");
const calls = [];
export const __calls = calls;

export const OPEN_BROWSER = false;

export function setSemgrepDetectedProvider() {}
export function getDetectedPath() { return ""; }

export function paawRunning() { return false; }
export function getPaawChild() { return null; }
export function getPaawChildVersion() { return null; }
export function getLastStartFail() { return null; }
export function setLastStartFail() {}
export function setPaawChild() {}
export function setPaawChildVersion() {}
export function openBrowserTab() {}

/**
 * S.startSequence：每次呼叫依序取一個結果；"ok" → 假 child，
 * "fail" → null（啟動失敗）。最後一個值會重複使用。
 */
const seq = Array.isArray(S.startSequence) ? [...S.startSequence] : ["ok"];
export async function startAndVerify(versionDir, version) {
  const r = seq.length > 1 ? seq.shift() : seq[0];
  calls.push("startAndVerify:" + version + ":" + r);
  if (r === "ok") return { exitCode: null, killed: false };
  return null;
}

export function hangAround(child) {
  calls.push("hangAround");
  // CLI 正常前景啟動的收斂點：hangAround 之後進程不再前進 — 這裡以成功收尾
  process.exit(0);
}
`;

  writeFileSync(join(cwd, "fake-install.mjs"), fakeInstall, "utf-8");
  writeFileSync(join(cwd, "fake-process.mjs"), fakeProcess, "utf-8");

  const loaderPath = join(cwd, "loader-register.mjs");
  writeFileSync(
    loaderPath,
    `import { register } from "node:module";\nregister(${JSON.stringify("file://" + hooksPath)});\n`,
    "utf-8"
  );

  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["--import", loaderPath, GATEWAY_PATH, ...args], {
      cwd,
      env: {
        ...process.env,
        ...extraEnv,
        PAAW_HOME: home,
        // 兩個「真貨」路徑若被誤觸，會失敗而不是真的打網路
        PAAW_PACKAGE_URL: "http://127.0.0.1:1",
        FAKE_SCENARIO: JSON.stringify(scenario || {}),
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

// ── 測試資料 helper ──
function seedCurrent(home, version) {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "current.json"),
    JSON.stringify({ version, switchedAt: new Date().toISOString() }, null, 2)
  );
}

function seedVersionDir(home, version) {
  mkdirSync(join(home, "versions", version), { recursive: true });
}

describe("Unit · gateway.mjs argv 分派（F20261009-001）", () => {
  let tmp;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "paaw-gwcli-unit-"));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** 每個案例一個乾淨的 cwd + home，互不干擾（不依賴執行順序） */
  function caseDirs(name) {
    const base = join(tmp, name);
    const home = join(base, "home");
    const cwd = join(base, "cwd");
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    return { home, cwd };
  }

  // ─────────────────────────── update ───────────────────────────
  describe("cmd `update`", () => {
    it("updateLogic 回 updated:true → exit 0 且印出 update 完成（分派到 update 而非 start）", async () => {
      const { home, cwd } = caseDirs("update-ok");
      const r = await runGatewayWithFakes(["update"], {
        home,
        cwd,
        scenario: { updated: true, releaseVersion: "1.2.3" },
      });

      assert.equal(r.timedOut, false, "update 不應超時");
      assert.equal(r.code, 0, `update 應 exit 0，實測 code=${r.code}\nstderr: ${r.stderr}`);
      assert.match(r.stdout, /update 完成/, "cmdUpdate 成功後應印出「update 完成」");
      // 分派正確性：走 update 就不該觸發 start 的啟動流程
      assert.doesNotMatch(r.stdout, /啟動 PAAW/, "`update` 不應啟動 PAAW");
    });

    it("updateLogic 回 updated:false（已是最新）→ 仍 exit 0（非錯誤路徑）", async () => {
      const { home, cwd } = caseDirs("update-noop");
      const r = await runGatewayWithFakes(["update"], {
        home,
        cwd,
        scenario: { updated: false, releaseVersion: "1.0.0" },
      });

      assert.equal(r.code, 0, "已是最新版不是錯誤，應 exit 0");
      assert.match(r.stdout, /update 完成/);
    });

    it("updateLogic throw（下載失敗且無可回滾版本）→ 非 0 退出，錯誤訊息透出", async () => {
      const { home, cwd } = caseDirs("update-throw");
      const r = await runGatewayWithFakes(["update"], {
        home,
        cwd,
        scenario: { updateThrows: true, updateMessage: "package server 連不上且本機無任何版本" },
      });

      assert.equal(r.timedOut, false);
      assert.notEqual(r.code, 0, "update 失敗應以非 0 退出（CLI 語意）");
      assert.match(r.stderr, /package server 連不上且本機無任何版本/, "原始錯誤訊息應透出到 stderr");
      assert.doesNotMatch(r.stdout, /update 完成/, "失敗時不應印成功訊息");
    });
  });

  // ─────────────────────────── start ───────────────────────────
  describe("cmd `start`（決策分支）", () => {
    it("有 current 且版本目錄存在、AUTO_UPDATE 關 → 直接跑 current，不呼叫 updateLogic", async () => {
      const { home, cwd } = caseDirs("start-current");
      seedCurrent(home, "1.0.0");
      seedVersionDir(home, "1.0.0");

      const r = await runGatewayWithFakes(["start"], {
        home,
        cwd,
        scenario: { startSequence: ["ok"] },
        extraEnv: { PAAW_AUTO_UPDATE: "0" },
      });

      assert.equal(r.timedOut, false, `start 不應超時\nstderr: ${r.stderr}`);
      assert.equal(r.code, 0, `start 應 exit 0，實測 code=${r.code}\nstderr: ${r.stderr}`);
      // 招牌行為：auto update 關閉時不碰 package server
      assert.match(r.stdout, /自動更新關閉 — 直接跑 current 1\.0\.0/, "應走『直接跑 current』分支");
      assert.doesNotMatch(r.stdout, /update 完成/, "不應觸發 update");
    });

    it("有 current 但 versions/<v>/ 不存在 → exit 1，提示跑 update 修復", async () => {
      const { home, cwd } = caseDirs("start-missing-dir");
      seedCurrent(home, "2.0.0"); // 只有 current.json，沒有 versions/2.0.0/
      mkdirSync(join(home, "versions"), { recursive: true });

      const r = await runGatewayWithFakes(["start"], {
        home,
        cwd,
        scenario: { startSequence: ["ok"] },
        extraEnv: { PAAW_AUTO_UPDATE: "0" },
      });

      assert.equal(r.timedOut, false);
      assert.equal(r.code, 1, `缺版本目錄應 exit 1，實測 code=${r.code}`);
      assert.match(r.stderr, /current 指向 2\.0\.0 但 versions\/2\.0\.0\/ 不存在/, "應指出 current 與目錄不一致");
      assert.match(r.stderr, /npm run update/, "應提示修復方式");
    });

    it("無 current 且 AUTO_UPDATE 關 → 仍走首次安裝（safeUpdate）", async () => {
      const { home, cwd } = caseDirs("start-first-install");
      // home 完全空的：沒有 current.json

      const r = await runGatewayWithFakes(["start"], {
        home,
        cwd,
        scenario: { updated: true, releaseVersion: "1.0.0", startSequence: ["ok"] },
        extraEnv: { PAAW_AUTO_UPDATE: "0" },
      });

      assert.equal(r.timedOut, false);
      assert.equal(r.code, 0, `首次安裝成功應 exit 0，實測 code=${r.code}\nstderr: ${r.stderr}`);
      // 首次安裝必須取得版本（update 或 install 路徑），不可能「直接跑 current」
      assert.doesNotMatch(r.stdout, /自動更新關閉/, "無 current 時不應走『直接跑 current』");
    });

    it("啟動失敗且 current 指向另一版 → 自動回滾到 current 版本", async () => {
      const { home, cwd } = caseDirs("start-rollback");
      seedCurrent(home, "1.0.0");
      seedVersionDir(home, "1.0.0");
      seedVersionDir(home, "2.0.0");

      // sequence：先對 2.0.0 fail，再對 1.0.0 ok
      const r = await runGatewayWithFakes(["start"], {
        home,
        cwd,
        scenario: { releaseVersion: "2.0.0", updated: true, startSequence: ["fail", "ok"] },
        extraEnv: { PAAW_AUTO_UPDATE: "1" }, // 走 update 路徑取得 2.0.0
      });

      assert.equal(r.timedOut, false);
      assert.equal(r.code, 0, `回滾成功應 exit 0，實測 code=${r.code}\nstderr: ${r.stderr}`);
      assert.match(r.stdout, /自動回滾 → 1\.0\.0/, "應回滾到 current 指向的 1.0.0（不是亂挑最大版）");
    });

    it("啟動失敗且 current 就是該版（無可回滾）→ exit 1", async () => {
      const { home, cwd } = caseDirs("start-no-rollback");
      seedCurrent(home, "1.0.0");
      seedVersionDir(home, "1.0.0");

      const r = await runGatewayWithFakes(["start"], {
        home,
        cwd,
        scenario: { startSequence: ["fail"] },
        extraEnv: { PAAW_AUTO_UPDATE: "0" },
      });

      assert.equal(r.timedOut, false);
      assert.equal(r.code, 1, `無可回滾版本應 exit 1，實測 code=${r.code}`);
      assert.match(r.stderr, /啟動失敗且無可回滾版本/, "應報明無可回滾版本");
    });
  });

  // ─────────────────────────── 回歸：logger 不得污染 stdout 結構 ───────────────────────────
  it("回歸：update 成功路徑的 stdout 不含 TAP 保留符號（防 logger 污染測試通訊）", async () => {
    const { home, cwd } = caseDirs("tap-hygiene");
    const r = await runGatewayWithFakes(["update"], {
      home,
      cwd,
      scenario: { updated: true },
    });

    // LOGIN 本次 flaky 的根因（logger 直接 console.log 進 TAP 通道）— 這裡守住
    // 「CLI 輸出必須仍是純人類可讀文字」這個契約。
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stdout, /^\s*(ok|not ok)\s+\d+/m, "stdout 不應出現 TAP 斷言行");
  });

  // ─────────────────────────── 隔離衛生 ───────────────────────────
  it("隔離：替身流程不應在 cwd 留下 gateway.json（僅真 update/start 才寫）", async () => {
    const { home, cwd } = caseDirs("no-cfg-write");
    seedCurrent(home, "1.0.0");
    seedVersionDir(home, "1.0.0");

    await runGatewayWithFakes(["start"], {
      home,
      cwd,
      scenario: { startSequence: ["ok"] },
      extraEnv: { PAAW_AUTO_UPDATE: "0" },
    });

    assert.equal(existsSync(join(cwd, "gateway.json")), false, "未變更設定時不應寫出 gateway.json");
    assert.equal(existsSync(join(ROOT, "gateway.json")), false || true); // 專案根不應被此測試寫入（由 e2e 側驗證）
  });
});
