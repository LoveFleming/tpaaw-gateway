/**
 * PAAW Gateway — Semgrep module
 *
 * Owns semgrep detection (a fast synchronous presence probe plus a background
 * deep check that actually runs `semgrep --version`) and the one-click
 * installer (pipx / pip / pip3 fallback chain).
 *
 * Dependency direction: config.mjs only (imports getCfg / augmentedPath, plus
 * node:path delimiter). The UI activity logger (`jobLog`) is injected as a
 * PARAMETER — never imported — so this module does not depend on the UI server,
 * keeping the graph acyclic: config ← semgrep ← ui/server ← gateway.mjs.
 *
 * The detected absolute path is exposed via getDetectedPath() and wired into
 * process.mjs through setSemgrepDetectedProvider() at the composition root
 * (gateway.mjs), so startPaaw() can fall back to it when SEMGREP_PATH is unset.
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, delimiter } from "node:path";

import { getCfg, augmentedPath } from "./config.mjs";

// Detected absolute path — startPaaw's fallback SEMGREP_PATH when none is set.
let SEMGREP_DETECTED = null;
// Deep-check result cache (10 min): UI loads return instantly instead of cold-starting semgrep.
let SEMGREP_CHECK_CACHE = { at: 0, result: null };
// Background deep-check state machine: idle → checking → done.
const SEMGREP_CHECK_STATE = { status: "idle", result: null, startedAt: 0 };

export function getDetectedPath() { return SEMGREP_DETECTED; }
export function getCheckState() { return SEMGREP_CHECK_STATE; }

// 跑 `<bin> --version`，解析版本；回 { ok, version, reason }——失敗原因必須帶出（2026-10-08：
// 公司 Linux 「已安裝但未偵測到」沒線索可查，跟啟動死因同病根）。
// 冷啟動會做線上版本檢查，timeout 60s（對齊 tPAAW semgrep-runner 2026-08-28 的觀察）。
// 註（pre-existing，非本重構所改）：下方 checkSemgrep 呼叫端傳了 (timeoutMs, extraArgs)，
// 但此簽名只收 (bin, env)，多餘引數向來被忽略 —— 故實際一律 `--version` + 60s。此行為
// 在 P3 refactor 中「逐字保留」，不趁拆檔順手修掉（改行為屬 scope 外，另開 issue 追蹤）。
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
export function semgrepPresence() {
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
export function semgrepCheckKick(force = false) {
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

// 串流執行 shell 指令，輸出邊跑邊進活動記錄（jobLog — 由 UI 注入，避免 semgrep ↔ ui 依賴）
function runCapture(cmdLine, timeoutMs, jobLog) {
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

export async function installSemgrep(jobLog) {
  jobLog("安裝 semgrep（相依套件約 100MB，可能需數分鐘）…");
  // 2026-10-08：補 python3 -m pip --user（裸 pip3 可能連到怪環境）與 --break-system-packages
  // （公司管控 Linux 的 PEP 668 externally-managed，沒這旗 pip 會直接拒裝）
  const attempts = process.platform === "win32"
    ? ["pip install --upgrade semgrep", "py -3 -m pip install --upgrade semgrep"]
    : ["pipx install semgrep", "python3 -m pip install --user --upgrade semgrep", "pip3 install --user --upgrade semgrep", "pip3 install --user --break-system-packages --upgrade semgrep", "pip install --upgrade semgrep"];
  for (const cmd of attempts) {
    jobLog(`$ ${cmd}`);
    const r = await runCapture(cmd, 600000, jobLog);
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
