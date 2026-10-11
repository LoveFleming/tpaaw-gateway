#!/usr/bin/env node
/**
 * PAAW Gateway — 使用者機器上的 bootloader
 *
 * 用法（在使用者自己的目錄）:
 *   npx paaw-gateway           # 或 npm start —— 檢查更新 → 安裝 → 啟動 PAAW
 *   npx paaw-gateway update    # 只更新不啟動
 *   npx paaw-gateway status    # 看現況
 *
 * 目錄佈局（都長在 process.cwd()，物理隔離）:
 *   ./versions/<x.y.z>/    PAAW code（舊版保留 = 天然 rollback）
 *   ./data/                使用者資料（首次從 data-seed 播種，更新永不覆蓋）
 *   ./current.json         指向「驗證過」的版本（最後才寫）
 *   ./logs/                gateway 自己的 log
 *
 * 更新流程（staged install，偷 OpenClaw 模式）:
 *   GET stable.json → semver 比對 → 下載(串流算 sha256) → 解壓 versions/<v>.tmp
 *   → 驗關鍵檔存在 → rename 定版 → npm install（失敗 retry --omit=optional）
 *   → 播種 data（若無）→ 啟動 → verify GET / 200 → 成功才寫 current.json
 *   任何一步失敗：current.json 不動 → 啟動上一版；壞版本目錄保留現場
 *
 * Env:
 *   PAAW_PACKAGE_URL  package server（優先於 gateway.json）
 *   PAAW_HOME         佈局根目錄（預設 process.cwd()）
 *   PAAW_PORT         PAAW port（預設 4097）
 *   PAAW_WS_PORT      PTY-WS port（預設 4098）
 *   PAAW_AUTO_UPDATE  =1 開啟自動更新（預設關：start 只跑 current，要更新手動跑 npm run update）
 *   PAAW_HOME         佈局根目錄（預設 process.cwd()，也可寫 gateway.json 的 paawHome）
 *   PAAW_SKIP_NPM_I   =1 跳過 npm install（debug 用）
 *
 * 模組化（ADR-003 P2）：核心職責已拆至 src/lib/
 *   - src/lib/config.mjs   佈局路徑 / gateway.json / logger / semver / current.json（leaf）
 *   - src/lib/install.mjs  下載驗證 / 解壓 / 安裝 / 更新決策（依賴 config）
 *   - src/lib/process.mjs  PAAW 子進程生命週期 / 健康檢查（依賴 config）
 *   本檔保留：CLI 分派 + cmdStatus/cmdStart/cmdUpdate/safeUpdate + UI 模式（semgrep / cmdUI）。
 *   共享可變狀態（GATEWAY_CFG、佈局路徑、paawChild）各自收斂到單一 owner 模組，
 *   跨模組一律以 getter / setter 存取，不 export 可寫 binding。
 */

import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve, delimiter, basename } from "node:path";
import { fileURLToPath } from "node:url";

import {
  L, PORT, AUTO_UPDATE,
  getCfg, setCfgField, deleteCfgField, applyHome, saveGatewayCfg,
  getHome, getVersionsDir, getDataDir,
  semverGt, readCurrent, writeCurrentAtomic, listInstalledVersions,
  loadPackageServerUrl, logFile, augmentedPath,
} from "./src/lib/config.mjs";
import {
  updateLogic, installUploadedZip, installDeps, ensureData,
} from "./src/lib/install.mjs";
import {
  startAndVerify, killChild, paawRunning, hangAround,
  getPaawChild, setPaawChild, setPaawChildVersion,
  getLastStartFail, setSemgrepDetectedProvider, openBrowserTab, OPEN_BROWSER,
} from "./src/lib/process.mjs";

// ---------- 指令 ----------

async function cmdStatus() {
  const server = await loadPackageServerUrl();
  const current = await readCurrent();
  const installed = await listInstalledVersions();
  let stable = null;
  try {
    stable = (await (await fetch(`${server}/stable.json`, { signal: AbortSignal.timeout(4000) })).json()).version;
  } catch {}
  console.log(`PAAW_HOME       ${getHome()}`);
  console.log(`package server  ${server}`);
  console.log(`current         ${current ? current.version : "（未安裝）"}`);
  console.log(`installed       ${installed.join(", ") || "none"}`);
  console.log(`stable latest   ${stable || "（無法連線）"}`);
  console.log(`data/           ${existsSync(getDataDir()) ? "已存在（更新永不覆蓋）" : "未播種"}`);
  console.log(`auto update     ${AUTO_UPDATE ? "on（PAAW_AUTO_UPDATE=1 或 gateway.json autoUpdate）" : "off（預設；更新手動跑 npm run update）"}`);
  if (current && stable && semverGt(stable, current.version) && !AUTO_UPDATE) {
    console.log(`
  ⬆ 有新版 ${stable} 可用 — npm run update 更新`);
  }
}

async function cmdUpdate() {
  return updateLogic();
}

// 更新失敗（下載/sha/解壓/驗證/npm install）不該讓使用者沒東西可跑 —— fallback current
async function safeUpdate() {
  try {
    return await cmdUpdate();
  } catch (e) {
    const current = await readCurrent();
    if (current && existsSync(join(getVersionsDir(), current.version))) {
      L.warn(`更新失敗（${e.message}）— 照跑現有版本 ${current.version}`);
      return { versionDir: join(getVersionsDir(), current.version), version: current.version, updated: false };
    }
    throw e;
  }
}

async function cmdStart() {
  const current = await readCurrent();

  // 預設行為：有 current 就直接跑（不碰 package server、不檢查更新）
  // 更新永遠手動：npm run update；除非 PAAW_AUTO_UPDATE=1 / gateway.json autoUpdate:true
  let versionDir, version, updated = false;
  if (!current || AUTO_UPDATE) {
    ({ versionDir, version, updated } = await safeUpdate());
  } else {
    version = current.version;
    versionDir = join(getVersionsDir(), version);
    if (!existsSync(versionDir)) {
      L.err(`current 指向 ${version} 但 versions/${version}/ 不存在 — 跑 npm run update 修復`);
      process.exit(1);
    }
    L.info(`自動更新關閉 — 直接跑 current ${version}（要更新：npm run update）`);
  }

  if (!existsSync(versionDir)) {
    L.err(`versions/${version}/ 不存在 — 先跑 update`);
    process.exit(1);
  }

  await ensureData(versionDir);
  await installDeps(versionDir);

  const child = await startAndVerify(versionDir, version);
  if (!child) {
    // 啟動失敗 → 回滾：目標 = current.json 指向的版本（最後一個「驗證過」的），
    // 不是 versions/ 裡最大其他版（那可能是另一個沒驗證過的壞版）
    const current = await readCurrent();
    const prev = current && current.version !== version ? current.version : null;
    if (prev && existsSync(join(getVersionsDir(), prev))) {
      L.warn(`自動回滾 → ${prev}（壞的 ${version} 目錄保留現場）`);
      const child2 = await startAndVerify(join(getVersionsDir(), prev), prev);
      if (child2) {
        await writeCurrentAtomic(prev); // current 維持驗證過的版本
        hangAround(child2);
        return;
      }
    }
    L.err("啟動失敗且無可回滾版本 — 看 logs/paaw 輸出除錯");
    process.exit(1);
  }

  if (updated) await writeCurrentAtomic(version);
  logFile(`started ${version} updated=${updated}`);
  hangAround(child);
}

// ---------- UI 模式（dashboard：看資訊、決定更新/啟動）----------

// paawChild / paawChildVersion 狀態由 src/lib/process.mjs 單一 owner 持有（getter/setter 存取）

// ---------- semgrep（2026-09-20 Fleming：UI 檢查 + 一鍵安裝 + SEMGREP_PATH 設定）----------

let SEMGREP_DETECTED = null; // checkSemgrep 偵測到的絕對路徑（未明確設定時 startPaaw 兜底注入用）
let SEMGREP_CHECK_CACHE = { at: 0, result: null }; // 偵測結果快取（10 分鐘）— UI 載入即回，不再每次冷啟
const job = { active: false, kind: null, lines: [], error: null, message: null, startedAt: null, finishedAt: null };

// 把偵測到的路徑注入 process 模組（切斷 process ↔ semgrep 的模組依賴；P3 會把 semgrep 搬成獨立模組）
setSemgrepDetectedProvider(() => SEMGREP_DETECTED);

function jobLog(line) {
  job.lines.push(`[${new Date().toLocaleTimeString()}] ${line}`);
  if (job.lines.length > 200) job.lines.splice(0, job.lines.length - 200);
}

// 跑 `<bin> --version`，解析版本；回 { ok, version, reason }——失敗原因必須帶出（2026-10-08：
// 公司 Linux 「已安裝但未偵測到」沒線索可查，跟啟動死因同病根）。
// 冷啟動會做線上版本檢查，timeout 60s（對齊 tPAAW semgrep-runner 2026-08-28 的觀察）
function semgrepVersion(bin, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, ["--version"], {
      env, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let out = "", settled = false;
    const done = (r) => { if (!settled) { settled = true; resolvePromise(r); } };
    const timer = setTimeout(() => { try { child.kill(); } catch {} done({ ok: false, reason: "timeout 60s（冷啟動線上檢查？網路不通？）" }); }, 60000);
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { out += c; });
    child.on("error", (e) => { clearTimeout(timer); done({ ok: false, reason: `找不到執行檔（${(e && e.code) || e}）` }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const tail = String(out).trim().split(/\r?\n/).filter((l) => l.trim()).slice(-3).join(" ⏎ ").slice(0, 200);
      if (code !== 0) return done({ ok: false, reason: `exit ${code}${tail ? "：" + tail : "（無輸出）"}` });
      const m = String(out).match(/\d+\.\d+\.\d+/);
      done({ ok: true, version: m ? m[0] : (String(out).trim().slice(0, 40) || "unknown") });
    });
  });
}

// 同步存在檢查（瞬回，不 spawn）：路徑有 semgrep 就算偵測到 — 2026-10-08 Fleming 定調：
// 首次使用體驗優先，實跑驗證/版本號另走背景深查（checkSemgrep），不得擋在偵測路上。
function semgrepPresence() {
  const explicit = (getCfg().semgrepPath || "").trim();
  const fromEnv = (process.env.SEMGREP_PATH || "").trim();
  const exe = process.platform === "win32" ? "semgrep.exe" : "semgrep";
  const cands = [];
  if (fromEnv) cands.push({ bin: fromEnv, source: "環境變數 SEMGREP_PATH" });
  if (explicit) cands.push({ bin: explicit, source: "gateway 設定（啟動 PAAW 時注入）" });
  const home = process.env.HOME;
  if (home) {
    cands.push({ bin: join(home, ".local", "bin", exe), source: "~/.local/bin 直擊（pipx/pip --user 落點）" });
    cands.push({ bin: join(process.env.PIPX_HOME || join(home, ".local", "pipx"), "venvs", "semgrep", "bin", exe), source: "pipx venv 直擊（~/.local/pipx/venvs/semgrep/bin）" });
  }
  // PATH 掃描：純 fs stat，不 spawn — 即便 PATH 很長也是微秒級
  for (const d of String(augmentedPath(null, process.env.PATH) || "").split(delimiter).filter(Boolean)) {
    cands.push({ bin: join(d, exe), source: "PATH 自動偵測（含 ~/.local/bin）" });
  }
  for (const c of cands) {
    try {
      const st = statSync(c.bin);
      if (st.isFile() || st.isSymbolicLink()) {
        SEMGREP_DETECTED = c.bin; // 未明確設定時 startPaaw 兜底注入用
        return { installed: true, path: c.bin, source: c.source, configured: explicit || fromEnv || null };
      }
    } catch {}
  }
  return { installed: false, path: null, source: null, configured: explicit || fromEnv || null };
}

async function checkSemgrep(force = false) {
  // 2026-10-08：10 分鐘快取 — UI 每次載入不再冷啟 semgrep；「🔄 檢查」帶 ?refresh=1 強制重查
  if (!force && SEMGREP_CHECK_CACHE.result && Date.now() - SEMGREP_CHECK_CACHE.at < 10 * 60 * 1000) {
    return SEMGREP_CHECK_CACHE.result;
  }
  const explicit = (getCfg().semgrepPath || "").trim();
  const fromEnv = (process.env.SEMGREP_PATH || "").trim();
  const env = { ...process.env, PATH: augmentedPath(null, process.env.PATH) };
  const candidates = [];
  if (fromEnv) candidates.push({ bin: fromEnv, source: "環境變數 SEMGREP_PATH" });
  if (explicit) candidates.push({ bin: explicit, source: "gateway 設定（啟動 PAAW 時注入）" });
  // 2026-10-08：pipx 落點直擊 — ~/.local/bin（symlink）與 venv 內 bin（公司 Linux pipx 裝法，
  // symlink 缺失/損壞時 venv 本體仍在；尊重 PIPX_HOME/PIPX_BIN_DIR 自訂位置）
  const localSemgrep = process.env.HOME ? join(process.env.HOME, ".local", "bin", "semgrep") : null;
  const pxVenvSemgrep = (process.env.PIPX_HOME || (process.env.HOME ? join(process.env.HOME, ".local", "pipx") : null))
    ? join(process.env.PIPX_HOME || join(process.env.HOME, ".local", "pipx"), "venvs", "semgrep", "bin", "semgrep")
    : null;
  const directHits = [
    localSemgrep && { bin: localSemgrep, source: "~/.local/bin 直擊（pipx/pip --user 落點）" },
    pxVenvSemgrep && { bin: pxVenvSemgrep, source: "pipx venv 直擊（~/.local/pipx/venvs/semgrep/bin）" },
  ];
  for (const c of directHits) if (c && existsSync(c.bin)) candidates.push(c);
  candidates.push({ bin: "semgrep", source: "PATH 自動偵測（含 ~/.local/bin）" });
  const diagnostics = [];
  for (const c of candidates) {
    // 2026-10-08：先帶 --disable-version-check（~1s 出答案；公司網路擋 semgrep.dev 時純 --version
    // 會掛在線上檢查等到 timeout——「檢查中很久」與「已安裝但偵測不到」都是它）。
    // 舊版 semgrep 不認旗標（unrecognized）才退回純 --version（60s）。
    let r = await semgrepVersion(c.bin, env, 30000, ["--disable-version-check"]);
    if (!r.ok && /unrecognized|unknown|invalid choice/i.test(r.reason || "")) {
      r = await semgrepVersion(c.bin, env, 60000);
    }
    if (r.ok) {
      // 快取給 startPaaw 注入：沒明確設定時，偵測到的絕對路徑也注入 SEMGREP_PATH（venv 直擊情境）
      SEMGREP_DETECTED = c.bin;
      const result = { installed: true, version: r.version, path: c.bin, source: c.source, configured: explicit || fromEnv || null, diagnostics };
      SEMGREP_CHECK_CACHE = { at: Date.now(), result };
      return result;
    }
    diagnostics.push(`「${c.source}」${c.bin} → ${r.reason}`);
  }
  const result = {
    installed: false, version: null, path: null, source: null,
    configured: explicit || fromEnv || null,
    diagnostics,
    // gateway process 眼中的環境（偵測不到時自我招供：HOME 跟登入 shell 不同就是它）
    processEnv: { HOME: process.env.HOME || null, PATH: String(process.env.PATH || "").slice(0, 400) },
    hint: "按「安裝 semgrep」一鍵安裝，或在設定填 SEMGREP_PATH 指向現有執行檔；偵測失敗原因見 diagnostics",
  };
  return result;
}

// 背景偵測狀態機（2026-10-08）：API 立即回應，偵測背景跑——公司慢機/慢網不再把 UI 卡在「檢查中」
// idle → checking → done（result 帶結果；10 分鐘内直用，refresh=1 或安裝完重跑）
const SEMGREP_CHECK_STATE = { status: "idle", result: null, startedAt: 0 };

function semgrepCheckKick(force = false) {
  if (SEMGREP_CHECK_STATE.status === "checking") return; // 跑中不重入
  const fresh = SEMGREP_CHECK_STATE.status === "done" && Date.now() - SEMGREP_CHECK_STATE.startedAt < 10 * 60 * 1000;
  if (!force && fresh) return;
  SEMGREP_CHECK_STATE.status = "checking";
  SEMGREP_CHECK_STATE.startedAt = Date.now();
  checkSemgrep(true)
    .then((result) => { SEMGREP_CHECK_STATE.result = result; })
    .catch((e) => { SEMGREP_CHECK_STATE.result = { installed: false, version: null, path: null, source: null, configured: null, diagnostics: [`偵測程序異常：${String((e && e.message) || e)}`] }; })
    .finally(() => { SEMGREP_CHECK_STATE.status = "done"; SEMGREP_CHECK_STATE.startedAt = Date.now(); });
}

// 串流執行 shell 指令，輸出邊跑邊進活動記錄（jobLog）
function runCapture(cmdLine, timeoutMs = 600000) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmdLine, { shell: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let settled = false;
    const done = (code, err) => { if (!settled) { settled = true; resolvePromise({ code, err }); } };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} done(-1, "timeout"); }, timeoutMs);
    const pump = (c) => {
      for (const line of String(c).split(/\r?\n/)) {
        const s = line.trim();
        if (s) jobLog(`  ${s.slice(0, 200)}`);
      }
    };
    child.stdout.on("data", pump);
    child.stderr.on("data", pump);
    child.on("error", (e) => { clearTimeout(timer); done(-1, String(e)); });
    child.on("close", (code) => { clearTimeout(timer); done(code); });
  });
}

async function installSemgrep() {
  jobLog("安裝 semgrep（相依套件約 100MB，可能需數分鐘）…");
  // 2026-10-08：補 python3 -m pip --user（裸 pip3 可能連到怪環境）與 --break-system-packages
  // （公司管控 Linux 的 PEP 668 externally-managed，沒這旗 pip 會直接拒裝）
  const attempts = process.platform === "win32"
    ? ["pip install --upgrade semgrep", "py -3 -m pip install --upgrade semgrep"]
    : ["pipx install semgrep", "python3 -m pip install --user --upgrade semgrep", "pip3 install --user --upgrade semgrep", "pip3 install --user --break-system-packages --upgrade semgrep", "pip install --upgrade semgrep"];
  for (const cmd of attempts) {
    jobLog(`$ ${cmd}`);
    const r = await runCapture(cmd, 600000);
    if (r.code === 0) {
      const chk = await checkSemgrep(true);
      if (chk.installed) return { ok: true, message: `semgrep ${chk.version} 安裝成功（${chk.path}）` };
      const why = (chk.diagnostics || []).join("｜").slice(0, 300);
      return { ok: false, message: `pip 回報成功但偵測不到 semgrep — ${why || "原因不明"} — 在設定填 SEMGREP_PATH 指向執行檔可繞過` };
    }
    jobLog(`  指令失敗（exit ${r.code}${r.err ? "：" + r.err : ""}），嘗試下一個…`);
  }
  return { ok: false, message: "semgrep 安裝失敗 — 請看活動記錄的 pip 訊息；或手動安裝後在設定填 SEMGREP_PATH" };
}

// ---------- 更新 / 啟動（UI 版）----------

async function uiStart() {
  if (paawRunning()) return { ok: false, message: "PAAW 已在執行中" };
  const current = await readCurrent();
  if (!current) return { ok: false, message: "尚未安裝任何版本 — 先接「更新」" };
  const versionDir = join(getVersionsDir(), current.version);
  if (!existsSync(versionDir)) return { ok: false, message: `versions/${current.version}/ 不存在 — 先跑更新` };
  jobLog(`檢查 data / 依賴…`);
  await ensureData(versionDir);
  await installDeps(versionDir);
  jobLog(`啟動 PAAW ${current.version}（port ${PORT}）…`);
  const child = await startAndVerify(versionDir, current.version);
  if (!child) {
    const reason = (getLastStartFail() || `PAAW ${current.version} 啟動失敗`).split("\n").filter((l) => l.trim()).slice(0, 6).join("\n");
    return { ok: false, message: reason };
  }
  setPaawChild(child);
  setPaawChildVersion(current.version);
  child.on("exit", () => {
    if (getPaawChild() === child) {
      setPaawChild(null);
      setPaawChildVersion(null);
    }
  });
  if (OPEN_BROWSER) {
    openBrowserTab(`http://127.0.0.1:${PORT}/`);
    jobLog(`已開瀏覽器 → http://127.0.0.1:${PORT}/`);
  }
  return { ok: true, message: `PAAW ${current.version} 已上線 → http://127.0.0.1:${PORT}/` };
}

async function uiStop() {
  if (!paawRunning()) return { ok: false, message: "PAAW 未在執行" };
  jobLog("停止 PAAW…");
  await killChild(getPaawChild());
  setPaawChild(null);
  setPaawChildVersion(null);
  return { ok: true, message: "PAAW 已停止" };
}

async function uiUpdate() {
  jobLog("檢查 package server stable …");
  const r = await updateLogic();
  if (r.updated) {
    jobLog(`已安裝 ${r.version}（重啟後生效）`);
    return { ok: true, message: `已更新到 ${r.version} — 按「重啟」生效` };
  }
  return { ok: true, message: r.note || `目前已是最新版 ${r.version}` };
}

async function runJob(kind, fn) {
  if (job.active) return false;
  job.active = true;
  job.kind = kind;
  job.lines = [];
  job.error = null;
  job.message = null;
  job.startedAt = Date.now();
  job.finishedAt = null;
  (async () => {
    try {
      const r = await fn();
      job.message = r.message;
      jobLog(r.ok === false ? `⚠ ${r.message}` : `✓ ${r.message}`);
    } catch (e) {
      job.error = String((e && e.message) || e);
      jobLog(`✗ ${job.error}`);
    } finally {
      job.active = false;
      job.finishedAt = Date.now();
    }
  })();
  return true;
}

async function uiStatus() {
  const current = await readCurrent();
  const installed = await listInstalledVersions();
  const server = await loadPackageServerUrl();
  let stable = null;
  try {
    const res = await fetch(`${server}/stable.json`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) stable = await res.json();
  } catch {}
  return {
    home: getHome(),
    packageServer: server,
    current: current ? current.version : null,
    installed,
    stable: stable ? stable.version : null,
    stableSize: stable ? stable.size : null,
    stableNewer: !!(stable && (!current || semverGt(stable.version, current.version))),
    dataSeeded: existsSync(getDataDir()),
    autoUpdate: AUTO_UPDATE,
    running: paawRunning(),
    runningVersion: paawRunning() ? getPaawChildVersion() : null,
    paawUrl: `http://127.0.0.1:${PORT}/`,
    job: { active: job.active, kind: job.kind, error: job.error, message: job.message },
  };
}

async function cmdUI() {
  const UI_PORT = parseInt(process.env.PAAW_GW_PORT || "4290", 10);
  const UI_HOST = process.env.PAAW_GW_HOST || "127.0.0.1";
  const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "ui");

  const srv = http.createServer(async (req, res) => {
    const url = (req.url || "/").split("?")[0];
    const method = req.method;
    const jsonOut = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(obj, null, 2));
    };

    // ── F7 CSRF 防護（2026-09-18；MED-001 同日補強）：Host 白名單（全部請求）+ Origin 驗證（POST）──
    // UI 預設只綁 127.0.0.1，POST handler（/api/settings、/api/update、/api/upload、
    // /api/start、/api/stop、/api/restart）是狀態改變操作 —— 需防 DNS rebinding /
    // 惡意網頁對 localhost 發動 CSRF。MED-001：Host 白名單擴及 GET —— 防 DNS
    // rebinding 後的偽 Host 讀取 /api/paaw-log、/api/status 等本機資訊（瀏覽器
    // 直連 127.0.0.1 時 Host 必在白名單，不誤擋）。GET 不做 Origin 檢查。
    const HOST_WHITELIST = new Set(["127.0.0.1", "localhost", "::1"]);
    // PAAW_GW_HOST 若被設成 0.0.0.0 / 網卡 IP，把 UI_HOST 的 hostname 也列入白名單，
    // 避免防護誤擋合法使用（比對對象是 req.headers.host 拆出的 hostname，與實際監聽位址無關）
    const uiHostName = String(UI_HOST).replace(/^\[|\]$/g, "").toLowerCase();
    if (uiHostName) HOST_WHITELIST.add(uiHostName);
    // host header 可能帶 port（127.0.0.1:4290）或 IPv6 括號 → 一律拆成 hostname 再比
    const hostOf = (h) => {
      try { return new URL(`http://${h}`).hostname.replace(/^\[|\]$/g, "").toLowerCase(); }
      catch { return String(h).toLowerCase(); }
    };
    const isTrustedHost = (hostHeader) =>
      typeof hostHeader === "string" && hostHeader !== "" && HOST_WHITELIST.has(hostOf(hostHeader));
    const isTrustedOrigin = (originHeader) => {
      if (typeof originHeader !== "string" || originHeader === "") return false;
      try { return HOST_WHITELIST.has(new URL(originHeader).hostname.replace(/^\[|\]$/g, "").toLowerCase()); }
      catch { return false; } // 非法 Origin（如 sandbox 的 "null"）一律拒絕
    };
    // MED-001（2026-09-18）：Host 白名單檢查所有請求（GET+POST）— DNS rebinding 的
    // 偽 Host 連讀取也攔；Origin 驗證維持只有 POST（狀態改變操作）需要 — GET 不帶
    // 有意義的 Origin，同源 GET 帶 Origin 也放行以免誤擋。
    if (!isTrustedHost(req.headers.host)) {
      return jsonOut(403, { ok: false, message: "Forbidden: untrusted Host" });
    }
    if (method === "POST") {
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== "" && !isTrustedOrigin(origin)) {
        return jsonOut(403, { ok: false, message: "Forbidden: untrusted Origin" });
      }
    }
    try {
      if (method === "GET" && (url === "/" || url === "/index.html")) {
        const html = await readFile(join(UI_DIR, "index.html"), "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html);
      }
      if (method === "GET" && url === "/api/settings") {
        const envPs = !!process.env.PAAW_PACKAGE_URL;
        const envHome = !!process.env.PAAW_HOME;
        return jsonOut(200, {
          packageServer: {
            value: await loadPackageServerUrl(),
            source: envPs ? "env" : getCfg().packageServer ? "config" : "default",
            envLocked: envPs,
          },
          paawHome: {
            value: getHome(),
            source: envHome ? "env" : getCfg().paawHome ? "config" : "cwd",
            envLocked: envHome,
          },
          semgrepPath: {
            value: process.env.SEMGREP_PATH || getCfg().semgrepPath || "",
            source: process.env.SEMGREP_PATH ? "env" : getCfg().semgrepPath ? "config" : "auto",
            envLocked: !!process.env.SEMGREP_PATH,
          },
        });
      }
      if (method === "POST" && url === "/api/settings") {
        if (job.active) return jsonOut(409, { ok: false, message: `正在執行「${job.kind}」中` });
        // MIN-001（2026-09-18）：config json 遠用不到 1MB — 超限即 413 並斷線，
        // 避免無上限累積（與 /api/upload 的 600MB cap 對稱）
        const MAX_SETTINGS_BODY = 1024 * 1024;
        let body = "";
        let tooBig = false;
        req.on("data", (c) => {
          if (tooBig) return;
          body += c;
          if (body.length > MAX_SETTINGS_BODY) { tooBig = true; req.destroy(); }
        });
        await new Promise((r) => { req.on("end", r); req.on("close", r); req.on("error", r); });
        if (tooBig) return jsonOut(413, { ok: false, message: "body 超過 1MB 上限" });
        let parsed = {};
        try { parsed = body ? JSON.parse(body) : {}; } catch { return jsonOut(400, { ok: false, message: "body 不是合法 JSON" }); }
        const changed = [];
        const ignored = [];
        if (parsed.packageServer !== undefined && process.env.PAAW_PACKAGE_URL) ignored.push("packageServer（環境變數 PAAW_PACKAGE_URL 優先）");
        if (typeof parsed.packageServer === "string" && !process.env.PAAW_PACKAGE_URL) {
          const v = parsed.packageServer.trim().replace(/\/$/, "");
          if (v) {
            if (!/^https?:\/\//.test(v)) return jsonOut(400, { ok: false, message: "package server 必須是 http(s):// 開頭" });
            setCfgField("packageServer", v);
          } else {
            deleteCfgField("packageServer");
          }
          changed.push("packageServer");
        }
        if (parsed.paawHome !== undefined && process.env.PAAW_HOME) ignored.push("paawHome（環境變數 PAAW_HOME 優先）");
        if (typeof parsed.paawHome === "string" && !process.env.PAAW_HOME) {
          if (paawRunning()) return jsonOut(409, { ok: false, message: "PAAW 執行中 — 先停止再改安裝路徑" });
          const v = parsed.paawHome.trim();
          if (v) {
            if (!v.startsWith("/") && !/^[A-Za-z]:[\\\/]/.test(v)) return jsonOut(400, { ok: false, message: "安裝路徑必須是絕對路徑" });
            setCfgField("paawHome", resolve(v));
          } else {
            deleteCfgField("paawHome");
          }
          applyHome();
          changed.push("paawHome");
        }
        if (parsed.semgrepPath !== undefined && process.env.SEMGREP_PATH) ignored.push("semgrepPath（環境變數 SEMGREP_PATH 優先）");
        if (typeof parsed.semgrepPath === "string" && !process.env.SEMGREP_PATH) {
          const v = parsed.semgrepPath.trim();
          if (v) {
            if (!v.startsWith("/") && !/^[A-Za-z]:[\\\/]/.test(v)) return jsonOut(400, { ok: false, message: "SEMGREP_PATH 必須是絕對路徑" });
            setCfgField("semgrepPath", resolve(v));
          } else {
            deleteCfgField("semgrepPath");
          }
          changed.push("semgrepPath");
        }
        if (changed.length) {
          await saveGatewayCfg();
          jobLog(`設定已更新：${changed.join(", ")}（寫入 gateway.json）`);
        }
        return jsonOut(200, { ok: true, changed, ignored, home: getHome(), packageServer: await loadPackageServerUrl() });
      }
      if (method === "GET" && /^\/api\/semgrep(?:\?.*)?$/.test(req.url || "")) {
        // 存在即答案（瞬回）：路徑有 semgrep 就算偵測到；版本/可執行驗證背景補（deepChecking）
        const q = new URL(req.url, "http://localhost").searchParams;
        semgrepCheckKick(q.get("refresh") === "1");
        const p = semgrepPresence();
        const deep = SEMGREP_CHECK_STATE.status === "done" ? SEMGREP_CHECK_STATE.result : null;
        return jsonOut(200, {
          checking: false,
          ...p,
          version: deep && deep.installed && deep.path === p.path ? deep.version : null,
          deepChecking: SEMGREP_CHECK_STATE.status === "checking",
          diagnostics: !p.installed && deep && deep.diagnostics ? deep.diagnostics : null,
          processEnv: !p.installed && deep && deep.processEnv ? deep.processEnv : null,
          hint: p.installed ? null : "按「安裝 semgrep」一鍵安裝，或在設定填 SEMGREP_PATH 指向現有執行檔",
        });
      }
      if (method === "POST" && url === "/api/semgrep/install") {
        if (job.active) return jsonOut(409, { ok: false, message: `正在執行「${job.kind}」中` });
        runJob("semgrep-install", installSemgrep);
        return jsonOut(202, { ok: true, message: "semgrep 安裝已開始（進度見活動記錄）" });
      }
      if (method === "GET" && url === "/api/status") return jsonOut(200, await uiStatus());
      if (method === "GET" && url === "/api/log") return jsonOut(200, { lines: job.lines });
      // ── GET /api/paaw-log — PAAW server console（2026-09-12 Fleming：gateway UI 也要看得到 PAAW log）
      // 讀 PAAW 的 server-console.log：先 HOME/data/log（新 startPaaw 帶 PAAW_LOG_HOME，跨版本持久），
      // 沒有再 fallback current version dir 的 log/（舊版啟動留下的）。offset 輪詢同 PAAW /api/logs/console 模式。
      if (method === "GET" && url === "/api/paaw-log") {
        const q = new URL(req.url, "http://localhost").searchParams;
        const candidates = [join(getDataDir(), "log", "server-console.log")];
        try {
          const cur = await readCurrent();
          if (cur?.version) candidates.push(join(getVersionsDir(), cur.version, "log", "server-console.log"));
        } catch {}
        let file = null;
        for (const c of candidates) if (existsSync(c)) { file = c; break; }
        if (!file) return jsonOut(200, { exists: false, size: 0, nextOffset: 0, data: "" });
        try {
          const st = statSync(file);
          const offset = Math.max(0, Math.min(parseInt(q.get("offset") || "0", 10) || 0, st.size));
          const len = Math.min(st.size - offset, 512 * 1024);
          let data = "";
          if (len > 0) {
            const fd = openSync(file, "r");
            try {
              const buf = Buffer.alloc(len);
              readSync(fd, buf, 0, len, offset);
              data = buf.toString("utf-8");
            } finally { try { closeSync(fd); } catch {} }
          }
          return jsonOut(200, { exists: true, file, size: st.size, nextOffset: offset + Buffer.byteLength(data, "utf-8"), data });
        } catch (err) {
          return jsonOut(500, { error: err.message });
        }
      }
      if (method === "POST" && url === "/api/update") {
        if (job.active) return jsonOut(409, { ok: false, message: `正在執行「${job.kind}」中` });
        runJob("update", uiUpdate);
        return jsonOut(202, { ok: true, message: "更新已開始" });
      }
      if (method === "POST" && url === "/api/upload") {
        if (job.active) return jsonOut(409, { ok: false, message: `正在執行「${job.kind}」中` });
        // 手動上傳 zip 安裝（2026-09-07）：raw body = zip bytes，版本從 zip 內 paaw-manifest.json 讀
        const ct = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
        if (!/^(application\/(x-)?zip|application\/octet-stream)$/.test(ct)) {
          return jsonOut(415, { ok: false, message: `Content-Type「${ct}」不支援 — 上傳 zip 檔本身（application/zip）` });
        }
        const chunks = [];
        let size = 0;
        let tooBig = false;
        req.on("data", (c) => {
          size += c.length;
          if (size > 600 * 1024 * 1024) { tooBig = true; req.destroy(); return; }
          chunks.push(c);
        });
        await new Promise((r) => { req.on("end", r); req.on("close", r); req.on("error", r); });
        if (tooBig) return jsonOut(413, { ok: false, message: "包超過 600MB 上限" });
        if (!chunks.length) return jsonOut(400, { ok: false, message: "空 body（没收到 zip 內容）" });
        const buf = Buffer.concat(chunks);
        let fname = "upload.zip";
        try { if (req.headers["x-filename"]) fname = decodeURIComponent(req.headers["x-filename"]); } catch {}
        runJob("upload", async () => {
          jobLog(`⬆️ 上傳安裝 ${fname}（${(buf.length / 1048576).toFixed(1)} MB）… PAAW_HOME = ${getHome()}`);
          return await installUploadedZip(buf, fname);
        });
        return jsonOut(202, { ok: true, message: "上傳安裝已開始（進度見活動記錄）" });
      }
      if (method === "POST" && url === "/api/start") {
        if (job.active) return jsonOut(409, { ok: false, message: `正在執行「${job.kind}」中` });
        runJob("start", uiStart);
        return jsonOut(202, { ok: true, message: "啟動中" });
      }
      if (method === "POST" && url === "/api/stop") {
        if (job.active) return jsonOut(409, { ok: false, message: `正在執行「${job.kind}」中` });
        runJob("stop", uiStop);
        return jsonOut(202, { ok: true, message: "停止中" });
      }
      if (method === "POST" && url === "/api/restart") {
        if (job.active) return jsonOut(409, { ok: false, message: `正在執行「${job.kind}」中` });
        runJob("restart", async () => {
          if (paawRunning()) await uiStop();
          return uiStart();
        });
        return jsonOut(202, { ok: true, message: "重啟中" });
      }
      return jsonOut(404, { error: "not found" });
    } catch (e) {
      return jsonOut(500, { error: String((e && e.message) || e) });
    }
  });

  await new Promise((r) => srv.listen(UI_PORT, UI_HOST, r));
  console.log(`\n⚙️  PAAW Gateway UI → http://${UI_HOST}:${UI_PORT}/\n`);
  console.log(`    home:  ${getHome()}`);
  console.log(`    PAAW:  http://127.0.0.1:${PORT}/ （由 UI 決定何時啟動）`);
  console.log(`    離開：Ctrl+C（會一併停止 PAAW）\n`);

  const bye = async () => {
    if (paawRunning()) await killChild(getPaawChild());
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
  process.on("exit", () => {
    const child = getPaawChild();
    if (child && child.exitCode === null) child.kill("SIGTERM");
  });
  // UI server 本身 keeps process alive
}

// ---------- main ----------

const cmd = process.argv[2] || "start";
if (cmd === "status") await cmdStatus();
else if (cmd === "update") {
  await cmdUpdate();
  L.ok("update 完成");
}
else if (cmd === "upload") {
  // 手動上傳 zip 安裝：paaw-gateway upload paaw-1.0.0.zip（不依賴 package server）
  const p = process.argv[3];
  if (!p) { console.error("用法：paaw-gateway upload <paaw-x.y.z.zip>"); process.exit(1); }
  const buf = await readFile(resolve(p));
  await installUploadedZip(buf, basename(p));
  L.ok("upload 完成");
}
else if (cmd === "start") await cmdStart();
else if (cmd === "ui") await cmdUI();
else {
  console.error(`未知指令：${cmd}（可用：ui | start | update | upload | status）`);
  process.exit(1);
}
