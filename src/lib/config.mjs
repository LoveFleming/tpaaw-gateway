/**
 * PAAW Gateway — Config module (leaf)
 *
 * Owns gateway.json loading/saving, the env-derived layout paths, the console
 * logger, and the small pure helpers shared by every other Gateway module.
 *
 * Dependency direction: this is the LEAF — it must not import install/process
 * (or anything above it). install.mjs and process.mjs depend on this module;
 * never the reverse.
 *
 * Shared mutable state (GATEWAY_CFG, and the layout paths that applyHome()
 * recomputes when the user changes paawHome in the UI) lives ONLY here, inside
 * this module's closure. It is exposed through getters / explicit mutators —
 * we never `export let` a writable binding, so there is exactly one owner and
 * consumers cannot accidentally rebind it.
 */

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------- 常數 / 工具 ----------

export const VERSION_RE = /^\d+\.\d+\.\d+$/;

// gateway.json（執行目錄下）：{ packageServer, paawHome, autoUpdate, semgrepPath, openBrowser }
let GATEWAY_CFG = {};
try {
  GATEWAY_CFG = JSON.parse(await readFile(join(process.cwd(), "gateway.json"), "utf-8"));
} catch {}

/** Current gateway.json contents (live reference — write via setters below). */
export function getCfg() {
  return GATEWAY_CFG;
}

/** Set a gateway.json field (persisted only when saveGatewayCfg is called). */
export function setCfgField(key, value) {
  GATEWAY_CFG[key] = value;
}

/** Remove a gateway.json field (persisted only when saveGatewayCfg is called). */
export function deleteCfgField(key) {
  delete GATEWAY_CFG[key];
}

// 佈局根目錄優先序：PAAW_HOME env > gateway.json.paawHome > cwd
// （applyHome 可重算 — UI 改 paawHome 即時生效，不必重啟 gateway）
let HOME, VERSIONS_DIR, DATA_DIR, CURRENT_FILE, LOGS_DIR;
export function applyHome() {
  HOME = resolve(process.env.PAAW_HOME || GATEWAY_CFG.paawHome || process.cwd());
  VERSIONS_DIR = join(HOME, "versions");
  DATA_DIR = join(HOME, "data");
  CURRENT_FILE = join(HOME, "current.json");
  LOGS_DIR = join(HOME, "logs");
}
applyHome();

export function getHome() { return HOME; }
export function getVersionsDir() { return VERSIONS_DIR; }
export function getDataDir() { return DATA_DIR; }
export function getCurrentFile() { return CURRENT_FILE; }
export function getLogsDir() { return LOGS_DIR; }

export async function saveGatewayCfg() {
  const file = join(process.cwd(), "gateway.json");
  const tmp = file + ".tmp";
  await writeFile(tmp, JSON.stringify(GATEWAY_CFG, null, 2) + "\n", "utf-8");
  await rename(tmp, file);
}

export const PORT = process.env.PAAW_PORT || "4097";
// 自動更新預設關（start 只跑 current；首裝仍會安裝）：PAAW_AUTO_UPDATE=1 或 gateway.json autoUpdate:true 才開
export const AUTO_UPDATE = process.env.PAAW_AUTO_UPDATE === "1" || GATEWAY_CFG.autoUpdate === true;

// emoji 降級：非 TTY / dumb terminal / Windows 舊 console → ASCII
export const EMOJI_OK =
  process.stdout.isTTY &&
  process.env.TERM !== "dumb" &&
  (process.platform !== "win32" || Boolean(process.env.WT_SESSION));

export const L = {
  info: (msg) => console.log(`${EMOJI_OK ? "▸" : "-"} ${msg}`),
  ok: (msg) => console.log(`${EMOJI_OK ? "✓" : "[OK]"} ${msg}`),
  warn: (msg) => console.log(`${EMOJI_OK ? "⚠️ " : "[WARN]"} ${msg}`),
  err: (msg) => console.error(`${EMOJI_OK ? "✗" : "[ERR]"} ${msg}`),
};

export function logFile(line) {
  const stamp = new Date().toISOString();
  mkdir(LOGS_DIR, { recursive: true }).then(() =>
    writeFile(join(LOGS_DIR, "gateway.log"), `[${stamp}] ${line}\n`, { flag: "a" }).catch(() => {})
  );
}

export function semverGt(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}

export async function loadPackageServerUrl() {
  if (process.env.PAAW_PACKAGE_URL) return process.env.PAAW_PACKAGE_URL.replace(/\/$/, "");
  if (GATEWAY_CFG.packageServer) return GATEWAY_CFG.packageServer.replace(/\/$/, "");
  return "http://localhost:4180";
}

export async function readCurrent() {
  try {
    return JSON.parse(await readFile(CURRENT_FILE, "utf-8"));
  } catch {
    return null;
  }
}

export async function writeCurrentAtomic(version) {
  const tmp = join(HOME, "current.json.tmp");
  await writeFile(tmp, JSON.stringify({ version, switchedAt: new Date().toISOString() }, null, 2));
  await rename(tmp, CURRENT_FILE);
}

export async function listInstalledVersions() {
  try {
    const entries = await readdir(VERSIONS_DIR);
    return entries.filter((e) => VERSION_RE.test(e)).sort((a, b) => (semverGt(a, b) ? -1 : 1));
  } catch {
    return [];
  }
}

export const PATH_SEP = process.platform === "win32" ? ";" : ":";

// gateway 補強過的 PATH：semgrep 所在目錄（有設 SEMGREP_PATH 時）+ ~/.local/bin
// （pipx / pip --user 落點 — gateway 用 nohup/systemd 啟動時不吃 .bashrc，這裡統一補）
export function augmentedPath(prependDir, basePath) {
  const parts = String(basePath || "").split(PATH_SEP).filter(Boolean);
  if (prependDir && !parts.includes(prependDir)) parts.unshift(prependDir);
  const localBin = process.env.HOME ? join(process.env.HOME, ".local", "bin") : null;
  if (localBin && existsSync(localBin) && !parts.includes(localBin)) parts.unshift(localBin);
  return parts.join(PATH_SEP);
}
