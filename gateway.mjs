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
 */

import http from "node:http";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

// ---------- 常數 / 工具 ----------

const VERSION_RE = /^\d+\.\d+\.\d+$/;
// gateway.json（執行目錄下）：{ packageServer, paawHome, autoUpdate }
let GATEWAY_CFG = {};
try {
  GATEWAY_CFG = JSON.parse(await readFile(join(process.cwd(), "gateway.json"), "utf-8"));
} catch {}

// 佈局根目錄優先序：PAAW_HOME env > gateway.json.paawHome > cwd
// （let + applyHome — UI 改 paawHome 可即時重算，不必重啟 gateway）
let HOME, VERSIONS_DIR, DATA_DIR, CURRENT_FILE, LOGS_DIR;
function applyHome() {
  HOME = resolve(process.env.PAAW_HOME || GATEWAY_CFG.paawHome || process.cwd());
  VERSIONS_DIR = join(HOME, "versions");
  DATA_DIR = join(HOME, "data");
  CURRENT_FILE = join(HOME, "current.json");
  LOGS_DIR = join(HOME, "logs");
}
applyHome();

async function saveGatewayCfg() {
  const file = join(process.cwd(), "gateway.json");
  const tmp = file + ".tmp";
  await writeFile(tmp, JSON.stringify(GATEWAY_CFG, null, 2) + "\n", "utf-8");
  await rename(tmp, file);
}
const PORT = process.env.PAAW_PORT || "4097";
// 自動更新預設關（start 只跑 current；首裝仍會安裝）：PAAW_AUTO_UPDATE=1 或 gateway.json autoUpdate:true 才開
const AUTO_UPDATE = process.env.PAAW_AUTO_UPDATE === "1" || GATEWAY_CFG.autoUpdate === true;

// emoji 降級：非 TTY / dumb terminal / Windows 舊 console → ASCII
const EMOJI_OK =
  process.stdout.isTTY &&
  process.env.TERM !== "dumb" &&
  (process.platform !== "win32" || Boolean(process.env.WT_SESSION));

const L = {
  info: (msg) => console.log(`${EMOJI_OK ? "▸" : "-"} ${msg}`),
  ok: (msg) => console.log(`${EMOJI_OK ? "✓" : "[OK]"} ${msg}`),
  warn: (msg) => console.log(`${EMOJI_OK ? "⚠️ " : "[WARN]"} ${msg}`),
  err: (msg) => console.error(`${EMOJI_OK ? "✗" : "[ERR]"} ${msg}`),
};

function logFile(line) {
  const stamp = new Date().toISOString();
  mkdir(LOGS_DIR, { recursive: true }).then(() =>
    writeFile(join(LOGS_DIR, "gateway.log"), `[${stamp}] ${line}\n`, { flag: "a" }).catch(() => {})
  );
}

function semverGt(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}

async function loadPackageServerUrl() {
  if (process.env.PAAW_PACKAGE_URL) return process.env.PAAW_PACKAGE_URL.replace(/\/$/, "");
  if (GATEWAY_CFG.packageServer) return GATEWAY_CFG.packageServer.replace(/\/$/, "");
  return "http://localhost:4180";
}

async function readCurrent() {
  try {
    return JSON.parse(await readFile(CURRENT_FILE, "utf-8"));
  } catch {
    return null;
  }
}

async function writeCurrentAtomic(version) {
  const tmp = join(HOME, "current.json.tmp");
  await writeFile(tmp, JSON.stringify({ version, switchedAt: new Date().toISOString() }, null, 2));
  await rename(tmp, CURRENT_FILE);
}

async function listInstalledVersions() {
  try {
    const entries = await readdir(VERSIONS_DIR);
    return entries.filter((e) => VERSION_RE.test(e)).sort((a, b) => (semverGt(a, b) ? -1 : 1));
  } catch {
    return [];
  }
}

// ---------- 下載（串流 + 邊算 sha256）----------

async function downloadVerified(url, sha256Expected, destPath, sizeExpected) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下載失敗 HTTP ${res.status}`);
  const hash = createHash("sha256");
  const out = createWriteStream(destPath);
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    hash.update(value);
    if (!out.write(Buffer.from(value))) {
      await new Promise((r) => out.once("drain", r));
    }
  }
  await new Promise((r) => out.end(r));
  const sha256 = hash.digest("hex");
  if (sha256 !== sha256Expected) throw new Error(`sha256 不符（下載=${sha256.slice(0, 16)}… manifest=${sha256Expected.slice(0, 16)}…）— 套包損毀或被竄改，拒絕安裝`);
  if (sizeExpected && size !== sizeExpected) throw new Error(`size 不符（${size} != ${sizeExpected}）`);
  return { sha256, size };
}

// ---------- 解壓（zip-slip 防護）----------

async function extractZip(zipPath, destDir) {
  const buf = await readFile(zipPath);
  const entries = unzipSync(new Uint8Array(buf));
  await mkdir(destDir, { recursive: true });
  const destRoot = resolve(destDir) + sep;
  for (const [name, data] of Object.entries(entries)) {
    const target = resolve(destDir, name);
    if (!target.startsWith(destRoot)) throw new Error(`zip-slip 偵測：${name}`);
    if (name.endsWith("/")) {
      await mkdir(target, { recursive: true });
    } else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    }
  }
}

// 關鍵檔存在性驗證（缺了 = 壞包，abort）
async function verifySkeleton(dir) {
  const REQUIRED = [
    "packages/server/src/paaw-server.mjs",
    "packages/ui/dist/index.html",
    "package.json",
    "data-seed",
  ];
  for (const rel of REQUIRED) {
    if (!existsSync(join(dir, rel))) throw new Error(`壞包：缺 ${rel}（abort，不切版）`);
  }
}

// ---------- npm install（失敗 retry --omit=optional，偷 OpenClaw）----------

function run(cmd, args, cwd) {
  return new Promise((resolvePromise) => {
    // shell:false + 平台對應 cmd（npm / npm.cmd），避免 DEP0190；args 全為固定常數
    const bin = process.platform === "win32" && cmd === "npm" ? "npm.cmd" : cmd;
    const child = spawn(bin, args, { cwd, stdio: "inherit" });
    child.on("exit", (code) => resolvePromise(code ?? 1));
    child.on("error", () => resolvePromise(1));
  });
}

async function installDeps(versionDir) {
  if (process.env.PAAW_SKIP_NPM_I === "1") return true;
  if (existsSync(join(versionDir, "node_modules"))) return true; // 已裝
  L.info("npm install --omit=dev …（首次需 1-3 分鐘）");
  let code = await run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], versionDir);
  if (code !== 0) {
    L.warn("npm install 失敗，retry（--omit=optional）…");
    code = await run("npm", ["install", "--omit=dev", "--omit=optional", "--no-audit", "--no-fund"], versionDir);
  }
  if (code !== 0) throw new Error("npm install 兩次都失敗");
  return true;
}

// ---------- data 播種（只在沒有 data/ 時；更新永不覆蓋）----------

async function ensureData(versionDir) {
  if (existsSync(DATA_DIR)) return false;
  L.info("首次安裝：data-seed 播種 → data/ …");
  await cp(join(versionDir, "data-seed"), DATA_DIR, { recursive: true });
  return true;
}

// ---------- 啟動 + verify（GET / 200 才算活）----------

function startPaaw(versionDir) {
  const env = { ...process.env, PAAW_PORT: PORT, PAAW_DATA_HOME: DATA_DIR };
  if (process.env.PAAW_WS_PORT) env.PAAW_WS_PORT = process.env.PAAW_WS_PORT;
  const tsxBin = join(versionDir, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  const child = spawn(process.execPath, [tsxBin, "packages/server/src/paaw-server.mjs"], {
    cwd: versionDir,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  return child;
}

async function waitForHealthy(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

function killChild(child) {
  return new Promise((resolvePromise) => {
    if (!child || child.exitCode !== null) return resolvePromise();
    child.once("exit", () => resolvePromise());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 5000).unref();
  });
}

async function startAndVerify(versionDir, version) {
  L.info(`啟動 PAAW ${version}（port ${PORT}）…`);
  const child = startPaaw(versionDir);
  // child 提前炸掉就不用傻等 90 秒
  const dead = new Promise((r) => child.on("exit", () => r("dead")));
  const healthy = await Promise.race([waitForHealthy().then(() => "up"), dead]);
  if (healthy !== "up") {
    L.err(`PAAW ${version} 啟動失敗（process 已退出或 90 秒無 HTTP 回應）`);
    await killChild(child);
    return null;
  }
  L.ok(`PAAW ${version} 已上線 → http://127.0.0.1:${PORT}/`);
  return child;
}

// ---------- 安裝一個版本（staged）----------

async function installVersion(manifest, server) {
  const v = manifest.version;
  const versionDir = join(VERSIONS_DIR, v);
  const tmpDir = join(VERSIONS_DIR, `${v}.tmp`);
  const zipPath = join(HOME, "logs", `paaw-${v}.zip`);

  // 下載 URL：優先用「剛 fetch stable.json 成功的同一台 server」組（同源保證，
  // 不受 manifest.url 缺失/寫死舊位址影響）；manifest.url 只當無 server 時的 fallback
  const dlUrl = server
    ? `${server}/packages/${v}/paaw.zip`
    : (manifest.url && /^https?:\/\//.test(manifest.url) ? manifest.url : null);
  if (!dlUrl) throw new Error("無法決定下載 URL（manifest 無 url 且未傳 server）");

  L.info(`下載 ${dlUrl} …`);
  await mkdir(LOGS_DIR, { recursive: true });
  const { size } = await downloadVerified(dlUrl, manifest.sha256, zipPath, manifest.size);
  L.ok(`sha256 驗證通過（${(size / 1048576).toFixed(1)} MB）`);

  L.info(`解壓 → versions/${v}.tmp …`);
  await rm(tmpDir, { recursive: true, force: true });
  await extractZip(zipPath, tmpDir);
  await verifySkeleton(tmpDir);

  await rm(versionDir, { recursive: true, force: true });
  await rename(tmpDir, versionDir);
  L.ok(`versions/${v}/ 定版`);

  await installDeps(versionDir);
  await rm(zipPath, { force: true });
  return versionDir;
}

// ---------- 指令 ----------

async function cmdStatus() {
  const server = await loadPackageServerUrl();
  const current = await readCurrent();
  const installed = await listInstalledVersions();
  let stable = null;
  try {
    stable = (await (await fetch(`${server}/stable.json`, { signal: AbortSignal.timeout(4000) })).json()).version;
  } catch {}
  console.log(`PAAW_HOME       ${HOME}`);
  console.log(`package server  ${server}`);
  console.log(`current         ${current ? current.version : "（未安裝）"}`);
  console.log(`installed       ${installed.join(", ") || "none"}`);
  console.log(`stable latest   ${stable || "（無法連線）"}`);
  console.log(`data/           ${existsSync(DATA_DIR) ? "已存在（更新永不覆蓋）" : "未播種"}`);
  console.log(`auto update     ${AUTO_UPDATE ? "on（PAAW_AUTO_UPDATE=1 或 gateway.json autoUpdate）" : "off（預設；更新手動跑 npm run update）"}`);
  if (current && stable && semverGt(stable, current.version) && !AUTO_UPDATE) {
    console.log(`
  ⬆ 有新版 ${stable} 可用 — npm run update 更新`);
  }
}

// 更新核心邏輯（CLI 與 UI 共用；失敗 throw，不 process.exit）
async function updateLogic() {
  const server = await loadPackageServerUrl();
  const current = await readCurrent();

  let manifest;
  try {
    const res = await fetch(`${server}/stable.json`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (e) {
    if (current) {
      L.warn(`package server 連不上（${e.message}）— 照跑現有版本 ${current.version}`);
      return { versionDir: join(VERSIONS_DIR, current.version), version: current.version, updated: false, note: `package server 連不上，照跑 ${current.version}` };
    }
    throw new Error(`package server 連不上且本機無任何版本 — 無法安裝（${e.message}）`);
  }

  const haveVersion = current && current.version === manifest.version;
  const newer = !current || semverGt(manifest.version, current.version);

  if (haveVersion) {
    L.info(`已是最新版 ${current.version}`);
    return { versionDir: join(VERSIONS_DIR, current.version), version: current.version, updated: false, note: `已是最新版 ${current.version}` };
  }
  if (!newer) {
    L.warn(`stable ${manifest.version} 不比 current ${current?.version || "none"} 新 — 不降級（要指定版請手動）`);
    return { versionDir: join(VERSIONS_DIR, current.version), version: current.version, updated: false, note: `stable ${manifest.version} 不比 current 新，不降級` };
  }

  L.info(`發現新版 ${manifest.version}${current ? `（current ${current.version}）` : "（首次安裝）"}`);
  const versionDir = await installVersion(manifest, server);
  // 安裝成功即切 current（staged 已驗 sha+骨架+npm install；
  // 若之後 start 啟動失敗，回滾分支會把 current 寫回舊版 — 鏈條仍閉合）
  await writeCurrentAtomic(manifest.version);
  return { versionDir, version: manifest.version, updated: true, note: `已安裝並切到 ${manifest.version}` };
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
    if (current && existsSync(join(VERSIONS_DIR, current.version))) {
      L.warn(`更新失敗（${e.message}）— 照跑現有版本 ${current.version}`);
      return { versionDir: join(VERSIONS_DIR, current.version), version: current.version, updated: false };
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
    versionDir = join(VERSIONS_DIR, version);
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
    if (prev && existsSync(join(VERSIONS_DIR, prev))) {
      L.warn(`自動回滾 → ${prev}（壞的 ${version} 目錄保留現場）`);
      const child2 = await startAndVerify(join(VERSIONS_DIR, prev), prev);
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

function hangAround(child) {
  const bye = () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
  child.on("exit", (code) => process.exit(code ?? 0));
}

// ---------- UI 模式（dashboard：看資訊、決定更新/啟動）----------

let paawChild = null; // 受監管的 PAAW process
let paawChildVersion = null; // 實際啟動的版本（update 切 current 後、重啟前會與 current 不同）
const job = { active: false, kind: null, lines: [], error: null, message: null, startedAt: null, finishedAt: null };

function jobLog(line) {
  job.lines.push(`[${new Date().toLocaleTimeString()}] ${line}`);
  if (job.lines.length > 200) job.lines.splice(0, job.lines.length - 200);
}

function paawRunning() {
  return !!(paawChild && paawChild.exitCode === null);
}

// 啟動成功後自動開瀏覽器（預設開；PAAW_OPEN_BROWSER=0 或 gateway.json openBrowser:false 關）
const OPEN_BROWSER = process.env.PAAW_OPEN_BROWSER !== "0" && GATEWAY_CFG.openBrowser !== false;

function openBrowserTab(url) {
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
    }
  } catch {}
}

async function uiStart() {
  if (paawRunning()) return { ok: false, message: "PAAW 已在執行中" };
  const current = await readCurrent();
  if (!current) return { ok: false, message: "尚未安裝任何版本 — 先接「更新」" };
  const versionDir = join(VERSIONS_DIR, current.version);
  if (!existsSync(versionDir)) return { ok: false, message: `versions/${current.version}/ 不存在 — 先跑更新` };
  jobLog(`檢查 data / 依賴…`);
  await ensureData(versionDir);
  await installDeps(versionDir);
  jobLog(`啟動 PAAW ${current.version}（port ${PORT}）…`);
  const child = await startAndVerify(versionDir, current.version);
  if (!child) return { ok: false, message: `PAAW ${current.version} 啟動失敗（詳情見 gateway 終端機輸出）` };
  paawChild = child;
  paawChildVersion = current.version;
  child.on("exit", () => {
    if (paawChild === child) {
      paawChild = null;
      paawChildVersion = null;
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
  await killChild(paawChild);
  paawChild = null;
  paawChildVersion = null;
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
    home: HOME,
    packageServer: server,
    current: current ? current.version : null,
    installed,
    stable: stable ? stable.version : null,
    stableSize: stable ? stable.size : null,
    stableNewer: !!(stable && (!current || semverGt(stable.version, current.version))),
    dataSeeded: existsSync(DATA_DIR),
    autoUpdate: AUTO_UPDATE,
    running: paawRunning(),
    runningVersion: paawRunning() ? paawChildVersion : null,
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
            source: envPs ? "env" : GATEWAY_CFG.packageServer ? "config" : "default",
            envLocked: envPs,
          },
          paawHome: {
            value: HOME,
            source: envHome ? "env" : GATEWAY_CFG.paawHome ? "config" : "cwd",
            envLocked: envHome,
          },
        });
      }
      if (method === "POST" && url === "/api/settings") {
        if (job.active) return jsonOut(409, { ok: false, message: `正在執行「${job.kind}」中` });
        let body = "";
        req.on("data", (c) => (body += c));
        await new Promise((r) => req.on("end", r));
        let parsed = {};
        try { parsed = body ? JSON.parse(body) : {}; } catch { return jsonOut(400, { ok: false, message: "body 不是合法 JSON" }); }
        const changed = [];
        const ignored = [];
        if (parsed.packageServer !== undefined && process.env.PAAW_PACKAGE_URL) ignored.push("packageServer（環境變數 PAAW_PACKAGE_URL 優先）");
        if (typeof parsed.packageServer === "string" && !process.env.PAAW_PACKAGE_URL) {
          const v = parsed.packageServer.trim().replace(/\/$/, "");
          if (v) {
            if (!/^https?:\/\//.test(v)) return jsonOut(400, { ok: false, message: "package server 必須是 http(s):// 開頭" });
            GATEWAY_CFG.packageServer = v;
          } else {
            delete GATEWAY_CFG.packageServer;
          }
          changed.push("packageServer");
        }
        if (parsed.paawHome !== undefined && process.env.PAAW_HOME) ignored.push("paawHome（環境變數 PAAW_HOME 優先）");
        if (typeof parsed.paawHome === "string" && !process.env.PAAW_HOME) {
          if (paawRunning()) return jsonOut(409, { ok: false, message: "PAAW 執行中 — 先停止再改安裝路徑" });
          const v = parsed.paawHome.trim();
          if (v) {
            if (!v.startsWith("/") && !/^[A-Za-z]:[\\\/]/.test(v)) return jsonOut(400, { ok: false, message: "安裝路徑必須是絕對路徑" });
            GATEWAY_CFG.paawHome = resolve(v);
          } else {
            delete GATEWAY_CFG.paawHome;
          }
          applyHome();
          changed.push("paawHome");
        }
        if (changed.length) {
          await saveGatewayCfg();
          jobLog(`設定已更新：${changed.join(", ")}（寫入 gateway.json）`);
        }
        return jsonOut(200, { ok: true, changed, ignored, home: HOME, packageServer: await loadPackageServerUrl() });
      }
      if (method === "GET" && url === "/api/status") return jsonOut(200, await uiStatus());
      if (method === "GET" && url === "/api/log") return jsonOut(200, { lines: job.lines });
      if (method === "POST" && url === "/api/update") {
        if (job.active) return jsonOut(409, { ok: false, message: `正在執行「${job.kind}」中` });
        runJob("update", uiUpdate);
        return jsonOut(202, { ok: true, message: "更新已開始" });
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
  console.log(`    home:  ${HOME}`);
  console.log(`    PAAW:  http://127.0.0.1:${PORT}/ （由 UI 決定何時啟動）`);
  console.log(`    離開：Ctrl+C（會一併停止 PAAW）\n`);

  const bye = async () => {
    if (paawRunning()) await killChild(paawChild);
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
  process.on("exit", () => {
    if (paawChild && paawChild.exitCode === null) paawChild.kill("SIGTERM");
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
else if (cmd === "start") await cmdStart();
else if (cmd === "ui") await cmdUI();
else {
  console.error(`未知指令：${cmd}（可用：ui | start | update | status）`);
  process.exit(1);
}
