/**
 * PAAW Gateway — UI server
 *
 * Owns the local control console served on :4290 (PAAW_GW_PORT): the HTTP server,
 * the F7 CSRF/Host gate, static ui/index.html serving, the async job runner
 * (update / upload / start / stop / restart / semgrep install), and the /api/*
 * handlers that drive PAAW from the UI.
 *
 * Dependency direction (strictly one-way, no cycles):
 *   config ← install, process, semgrep ← ui/server ← gateway.mjs
 * This module imports config/install/process/semgrep, but nothing imports it back
 * except the entry (gateway.mjs), which merely wires the two together.
 *
 * Path note (ADR-003 P3): this file lives one level deeper than the old cmdUI
 * (gateway.mjs at root → src/ui/), so the static UI dir moves from `<root>/ui`
 * to `<root>/../../ui` — resolved via fileURLToPath, no manual path arithmetic.
 *
 * Semgrep coupling is broken both ways: jobLog is passed INTO installSemgrep as a
 * parameter, and the detected semgrep path reaches process.mjs through its
 * injected provider (wired by the entry) rather than a direct import.
 */

import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PORT, AUTO_UPDATE,
  getCfg, setCfgField, deleteCfgField, applyHome, saveGatewayCfg,
  getHome, getVersionsDir, getDataDir,
  semverGt, readCurrent, listInstalledVersions,
  loadPackageServerUrl,
} from "../lib/config.mjs";
import {
  updateLogic, installUploadedZip, installDeps, ensureData,
} from "../lib/install.mjs";
import {
  startAndVerify, killChild, paawRunning,
  getPaawChild, setPaawChild, setPaawChildVersion,
  getLastStartFail, openBrowserTab, OPEN_BROWSER,
} from "../lib/process.mjs";
import {
  semgrepPresence, installSemgrep, semgrepCheckKick, getCheckState,
} from "../lib/semgrep.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, "..", "..", "ui"); // src/ui/ → project root → ui/

// ---------- UI job（非同步操作：更新 / 上傳 / 啟動 / 停止 / semgrep 安裝）----------

const job = { active: false, kind: null, lines: [], error: null, message: null, startedAt: null, finishedAt: null };

function jobLog(line) {
  job.lines.push(`[${new Date().toLocaleTimeString()}] ${line}`);
  if (job.lines.length > 200) job.lines.splice(0, job.lines.length - 200);
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

// ---------- UI server ----------

// cmdUI：起本機控制台（:4290）。所有請求先過 Host 白名單（防 DNS rebinding），
// POST 再驗非空 Origin（CSRF）。此為 refactor-only 搬遷，安全邏輯與原 gateway.mjs 等價。
export async function cmdUI() {
  const UI_PORT = parseInt(process.env.PAAW_GW_PORT || "4290", 10);
  const UI_HOST = process.env.PAAW_GW_HOST || "127.0.0.1";

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
        const deep = getCheckState().status === "done" ? getCheckState().result : null;
        return jsonOut(200, {
          checking: false,
          ...p,
          version: deep && deep.installed && deep.path === p.path ? deep.version : null,
          deepChecking: getCheckState().status === "checking",
          diagnostics: !p.installed && deep && deep.diagnostics ? deep.diagnostics : null,
          processEnv: !p.installed && deep && deep.processEnv ? deep.processEnv : null,
          hint: p.installed ? null : "按「安裝 semgrep」一鍵安裝，或在設定填 SEMGREP_PATH 指向現有執行檔",
        });
      }
      if (method === "POST" && url === "/api/semgrep/install") {
        if (job.active) return jsonOut(409, { ok: false, message: `正在執行「${job.kind}」中` });
        runJob("semgrep-install", () => installSemgrep(jobLog));
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
