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
 *   PAAW_AUTO_UPDATE  =0 關閉自動更新（只跑 current 版本）
 *   PAAW_SKIP_NPM_I   =1 跳過 npm install（debug 用）
 */

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
const HOME = resolve(process.env.PAAW_HOME || process.cwd());
const VERSIONS_DIR = join(HOME, "versions");
const DATA_DIR = join(HOME, "data");
const CURRENT_FILE = join(HOME, "current.json");
const LOGS_DIR = join(HOME, "logs");
const PORT = process.env.PAAW_PORT || "4097";
const AUTO_UPDATE = process.env.PAAW_AUTO_UPDATE !== "0";

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
  try {
    const cfg = JSON.parse(await readFile(join(HOME, "gateway.json"), "utf-8"));
    if (cfg.packageServer) return cfg.packageServer.replace(/\/$/, "");
  } catch {}
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
  const env = { ...process.env, PAAW_PORT: PORT };
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

async function installVersion(manifest) {
  const v = manifest.version;
  const versionDir = join(VERSIONS_DIR, v);
  const tmpDir = join(VERSIONS_DIR, `${v}.tmp`);
  const zipPath = join(HOME, "logs", `paaw-${v}.zip`);

  L.info(`下載 ${manifest.url} …`);
  await mkdir(LOGS_DIR, { recursive: true });
  const { size } = await downloadVerified(manifest.url, manifest.sha256, zipPath, manifest.size);
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
  console.log(`auto update     ${AUTO_UPDATE ? "on" : "off（PAAW_AUTO_UPDATE=0）"}`);
}

async function cmdUpdate() {
  const server = await loadPackageServerUrl();
  const current = await readCurrent();
  const installed = await listInstalledVersions();

  let manifest;
  try {
    const res = await fetch(`${server}/stable.json`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (e) {
    if (current) {
      L.warn(`package server 連不上（${e.message}）— 照跑現有版本 ${current.version}`);
      return { versionDir: join(VERSIONS_DIR, current.version), version: current.version, updated: false };
    }
    L.err(`package server 連不上且本機無任何版本 — 無法安裝`);
    process.exit(1);
  }

  const haveVersion = current && current.version === manifest.version;
  const newer = !current || semverGt(manifest.version, current.version);

  if (haveVersion) {
    L.info(`已是最新版 ${current.version}`);
    return { versionDir: join(VERSIONS_DIR, current.version), version: current.version, updated: false };
  }
  if (!newer) {
    L.warn(`stable ${manifest.version} 不比 current ${current?.version || "none"} 新 — 不降級（要指定版請手動）`);
    return { versionDir: join(VERSIONS_DIR, current.version), version: current.version, updated: false };
  }

  if (!AUTO_UPDATE && current) {
    L.info(`有新版 ${manifest.version} 但 auto update 關閉 — 照跑 ${current.version}`);
    return { versionDir: join(VERSIONS_DIR, current.version), version: current.version, updated: false };
  }

  L.info(`發現新版 ${manifest.version}${current ? `（current ${current.version}）` : "（首次安裝）"}`);
  const versionDir = await installVersion(manifest);
  return { versionDir, version: manifest.version, updated: true };
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
  const { versionDir, version, updated } = await safeUpdate();

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

// ---------- main ----------

const cmd = process.argv[2] || "start";
if (cmd === "status") await cmdStatus();
else if (cmd === "update") {
  await cmdUpdate();
  L.ok("update 完成");
}
else if (cmd === "start") await cmdStart();
else {
  console.error(`未知指令：${cmd}（可用：start | update | status）`);
  process.exit(1);
}
