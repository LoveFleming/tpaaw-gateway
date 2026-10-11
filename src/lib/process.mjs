/**
 * PAAW Gateway — Process module
 *
 * Owns the PAAW Server child-process lifecycle: spawn, health verification,
 * graceful kill, port-occupancy pre-check, and the supervised-child state
 * (paawChild / paawChildVersion / LAST_START_FAIL).
 *
 * Dependency direction: depends on config.mjs only. To avoid a cycle with the
 * semgrep code (which is still in the entry during P2, and moves to its own
 * module in P3), the detected-semgrep probe is injected via
 * setSemgrepDetectedProvider() — this module never imports semgrep.
 *
 * The supervised-child state lives ONLY in this closure; consumers read it
 * through getters/isRunning() and mutate it through explicit setters. We never
 * `export let` a writable binding.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

import { PORT, L, logFile, getCfg, getDataDir, augmentedPath } from "./config.mjs";

// ── Supervised PAAW child state (private to this module) ──
let paawChild = null; // 受監管的 PAAW process
let paawChildVersion = null; // 實際啟動的版本（update 切 current 後、重啟前會與 current 不同）
let LAST_START_FAIL = null; // 最近一次啟動失敗的死因（startAndVerify 寫入，uiStart 帶給 UI）

export function getPaawChild() { return paawChild; }
export function setPaawChild(child) { paawChild = child; }
export function getPaawChildVersion() { return paawChildVersion; }
export function setPaawChildVersion(v) { paawChildVersion = v; }
export function getLastStartFail() { return LAST_START_FAIL; }
export function setLastStartFail(msg) { LAST_START_FAIL = msg; }

export function paawRunning() {
  return !!(paawChild && paawChild.exitCode === null);
}

// ── Semgrep probe (injected — this module must not depend on semgrep) ──
let semgrepDetectedProvider = () => "";
export function setSemgrepDetectedProvider(fn) { semgrepDetectedProvider = fn; }

// 啟動成功後自動開瀏覽器（預設開；PAAW_OPEN_BROWSER=0 或 gateway.json openBrowser:false 關）
export const OPEN_BROWSER = process.env.PAAW_OPEN_BROWSER !== "0" && getCfg().openBrowser !== false;

export function openBrowserTab(url) {
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

// ---------- 啟動 + verify（GET / 200 才算活）----------

export function startPaaw(versionDir) {
  // 2026-09-12：PAAW_LOG_HOME 指 data/log — log 跨版本持久（gateway 更新換 version dir 不歸零），
  // gateway UI 的 /api/paaw-log 讀固定路徑就能看完整歷史
  const dataDir = getDataDir();
  const env = { ...process.env, PAAW_PORT: PORT, PAAW_DATA_HOME: dataDir, PAAW_LOG_HOME: join(dataDir, "log") };
  // 2026-09-20 Fleming：semgrep 環境注入 — gateway 設定的 SEMGREP_PATH（env var 優先）
  // 直接傳給 PAAW server process，並把所在目錄 + ~/.local/bin 補進 PATH。
  // 公司 Linux 不必再改 PAAW 的 .env，gateway 這裡統一管理。
  const semgrepPath = (getCfg().semgrepPath || "").trim() || (process.env.SEMGREP_PATH || "").trim() || (semgrepDetectedProvider() || "").trim();
  if (semgrepPath) env.SEMGREP_PATH = semgrepPath;
  env.PATH = augmentedPath(semgrepPath ? dirname(semgrepPath) : null, env.PATH);
  if (process.env.PAAW_WS_PORT) env.PAAW_WS_PORT = process.env.PAAW_WS_PORT;
  // 2026-10-08 根因修：tsx 在 tPAAW devDependencies，--omit=dev 裝不到 → Cannot find module .bin/tsx。
  // PAAW 官方啟動就是純 node（packages/server "start": "node src/paaw-server.mjs"，src 無 .ts import）。
  // gateway 對齊：直接 node 跑，不再依賴 tsx / .bin wrapper（跨平台問題一併消失）。
  const child = spawn(process.execPath, ["packages/server/src/paaw-server.mjs"], {
    cwd: versionDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const TAIL_MAX = 64 * 1024;
  child.__tail = "";
  const pump = (stream, mirror) => {
    stream.on("data", (c) => {
      try { mirror.write(c); } catch {}
      child.__tail = (child.__tail + c).slice(-TAIL_MAX);
    });
  };
  pump(child.stdout, process.stdout);
  pump(child.stderr, process.stderr);
  child.__spawnError = null;
  child.on("error", (e) => { child.__spawnError = String((e && e.code) || e); });
  return child;
}

// 失敗原因摘要：spawn error / exit code + child 輸出最後幾行
export function childFailReason(child) {
  const tail = (child.__tail || "").split(/\r?\n/).filter((l) => l.trim()).slice(-15).join("\n");
  const head = child.__spawnError
    ? `spawn 失敗（${child.__spawnError}）— tsx/bin 不存在或不可執行`
    : `exitCode=${child.exitCode ?? "?"}${child.signalCode ? ` signal=${child.signalCode}` : ""}`;
  return tail ? `${head}\n── child 輸出最後幾行 ──\n${tail}` : head;
}

export async function waitForHealthy(timeoutMs = 90000) {
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

export function killChild(child) {
  return new Promise((resolvePromise) => {
    if (!child || child.exitCode !== null) return resolvePromise();
    child.once("exit", () => resolvePromise());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 5000).unref();
  });
}

// port 佔用偵測（ISS-001）：port 上有任何 HTTP 回應（不論狀態碼）都代表有人佔著
export async function isPortOccupied() {
  try {
    await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

export async function startAndVerify(versionDir, version) {
  // pre-check（ISS-001）：先確認 port 沒被外部實體佔用，避免 spawn 的 child
  // 因 EADDRINUSE 退出、健康檢查卻被「別人」的 200 回應騙過而誤報上線
  if (await isPortOccupied()) {
    L.err(`port ${PORT} 已被其他程序佔用（不是 gateway 管理的 PAAW）— 請先停掉佔用者，或確認 PAAW 是否已在別處執行`);
    return null;
  }
  L.info(`啟動 PAAW ${version}（port ${PORT}）…`);
  const child = startPaaw(versionDir);
  // child 提前炸掉就不用傻等 90 秒（spawn error 與 exit 都算死）
  const dead = new Promise((r) => {
    child.on("exit", () => r("dead"));
    child.on("error", () => r("dead"));
  });
  const healthy = await Promise.race([waitForHealthy().then(() => "up"), dead]);
  if (healthy !== "up") {
    const reason = childFailReason(child);
    LAST_START_FAIL = `PAAW ${version} 啟動失敗 — ${reason}`;
    L.err(`${LAST_START_FAIL}`);
    logFile(`start-fail ${version}: ${reason.replace(/\n/g, " | ")}`);
    await killChild(child);
    return null;
  }
  // 穩定窗口（ISS-001）：健康回應與 child 存活可能是時間差交錯 — 等 2.5 秒過
  // 夭折期再確認 child 還活著，才算真的上線（防 child 通過檢查後晚死的 race）
  await new Promise((r) => setTimeout(r, 2500));
  if (child.exitCode !== null) {
    const reason = childFailReason(child);
    LAST_START_FAIL = `PAAW ${version} 通過健康檢查後隨即退出 — ${reason}`;
    L.err(`${LAST_START_FAIL}（不視為已上線）`);
    logFile(`start-fail-post ${version}: ${reason.replace(/\n/g, " | ")}`);
    return null;
  }
  L.ok(`PAAW ${version} 已上線 → http://127.0.0.1:${PORT}/`);
  return child;
}

// 前景啟動（cmdStart）：收到訊號時一併停 PAAW，child 退出即跟著退出
export function hangAround(child) {
  const bye = () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
  child.on("exit", (code) => process.exit(code ?? 0));
}
