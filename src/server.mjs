/**
 * PAAW Gateway Server — 獨立的 PAAW 管理平台
 *
 * 職責：
 *  - 管理 PAAW Server 進程（start/stop/restart）
 *  - 版本檢查 & 升級（git pull + npm install + restart）
 *  - 資料備份（排程 + 手動 + 還原）
 *  - 系統健康監控
 *  - 用戶管理 & 認證
 *  - 事件紀錄（audit trail）
 *  - Dev UI（Coding App 開 PAAW repo）
 *
 * Port: 4199（獨立於 PAAW Server :4097）
 * 不依賴 PAAW Server 運行 — Gateway 是守護者
 *
 * 本檔為薄入口（ADR-003 P1 重構，refactor-only）：
 *  - 建立 createServer、路由分派、auth guard、sendJSON/readBody、main guard
 *  - 其餘職責委派給 src/server/{config,events,auth,paaw-control,backup}.mjs
 *
 * 測試契約：unit test 以 `import("../../src/server.mjs?case=N")` cache-bust
 * 重讀 env（PAAW_ROOT / PAAW_BACKUP_DIR / PAAW_EVENT_LOG / PAAW_MAX_BACKUPS）。
 * 子模組是靜態 import、不會被 cache-bust，因此 env 衍生狀態一律在「本入口
 * 每次載入時」用 factory 重算（見 createConfig / createBackupManager）。
 */

import { createServer } from "http";
import { readFileSync } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath, pathToFileURL } from "url";

import { createConfig, validateAuthConfig } from "./server/config.mjs";
import { createEventLog } from "./server/events.mjs";
import { createAuth } from "./server/auth.mjs";
import { createPaawControl } from "./server/paaw-control.mjs";
import { createBackupManager } from "./server/backup.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config + derived paths (recomputed per load for cache-busted imports) ──
const cfg = createConfig(__dirname);
const { config, saveConfig, PAAW_ROOT, BACKUP_DIR, EVENT_LOG_PATH, MAX_BACKUPS, BACKUP_SOURCE_DIRS } = cfg;

// ── Events ──
const { events, logEvent } = createEventLog(EVENT_LOG_PATH);

// ── Auth ──
const { createSession, validateSession, login } = createAuth(config);

// ── PAAW control (child-process lifecycle) ──
const {
  startPaaw, stopPaaw, restartPaaw, healthCheckPaaw,
  upgradePaaw, getSystemHealth, getCurrentVersion, getGitInfo, getLatestVersion,
  getPaawProcess,
} = createPaawControl({ config, PAAW_ROOT, logEvent });

// ── Backup manager (depends on paaw-control, one-way) ──
const { backupPath, listBackups, createBackup, restoreBackup } = createBackupManager({
  BACKUP_DIR,
  MAX_BACKUPS,
  BACKUP_SOURCE_DIRS,
  PAAW_ROOT,
  logEvent,
  startPaaw,
  getPaawProcess,
});

// ── Re-exports (external test contract — unchanged) ──
export { BACKUP_REGEX, BACKUP_DATE_REGEX } from "./server/backup.mjs";
export { backupPath, listBackups, createBackup, restoreBackup };

// ── HTTP Server ──
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${config.port}`);
  const method = req.method;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Helper
  const sendJSON = (code, data) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  const readBody = () => new Promise(resolve => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });

  // Auth check (skip login & public routes)
  const publicRoutes = ["/api/auth/login", "/api/health", "/"];
  const isPublic = publicRoutes.some(r => url.pathname === r || url.pathname.startsWith("/assets") || url.pathname.startsWith("/__"));

  let currentUser = null;
  if (!isPublic) {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith("Bearer ")) {
      const session = validateSession(auth.slice(7));
      if (session) {
        currentUser = config.users.find(u => u.id === session.userId);
      }
    }
    if (!currentUser) {
      sendJSON(401, { error: "Unauthorized" });
      return;
    }
  }

  // ── Routes ──

  // Auth
  if (url.pathname === "/api/auth/login" && method === "POST") {
    const body = await readBody();
    // Per-IP throttling key: the socket address (no proxy trust configured).
    const clientIp = req.socket?.remoteAddress || "unknown";
    const result = await login(body.userId, body.password, clientIp);
    if (result.ok) {
      // Persist the re-hashed credential if the stored one was legacy/weak.
      if (result.upgraded) {
        try { saveConfig(config); } catch { /* non-fatal: login still succeeds */ }
      }
      logEvent("login", `User ${result.user.name} logged in`, result.user.id);
      sendJSON(200, {
        token: result.token,
        user: { id: result.user.id, name: result.user.name, role: result.user.role },
      });
    } else if (result.locked) {
      const retryAfterSec = Math.max(1, Math.ceil((result.retryAfterMs || 0) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      logEvent("login_locked", `Login locked for "${body.userId}" from ${clientIp}`);
      sendJSON(429, { error: "Too many failed attempts, try again later" });
    } else {
      // Uniform failure — never reveal whether the account exists.
      sendJSON(401, { error: "Invalid credentials" });
    }
    return;
  }

  if (url.pathname === "/api/auth/me" && method === "GET") {
    sendJSON(200, { id: currentUser.id, name: currentUser.name, role: currentUser.role });
    return;
  }

  // Health
  if (url.pathname === "/api/health" && method === "GET") {
    sendJSON(200, { status: "ok", gateway: true, uptime: process.uptime(), version: "0.1.0" });
    return;
  }

  // Dashboard
  if (url.pathname === "/api/dashboard" && method === "GET") {
    const health = await healthCheckPaaw();
    sendJSON(200, {
      system: getSystemHealth(),
      health,
      version: getCurrentVersion(),
      git: getGitInfo(),
      backups: { total: listBackups().length, latest: listBackups()[0] || null },
      events: events.slice(-20),
    });
    return;
  }

  // Version
  if (url.pathname === "/api/version" && method === "GET") {
    sendJSON(200, {
      current: getCurrentVersion(),
      git: getGitInfo(),
      latest: getLatestVersion(),
    });
    return;
  }

  // Upgrade
  if (url.pathname === "/api/upgrade" && method === "POST") {
    if (currentUser.role !== "admin") { sendJSON(403, { error: "Admin only" }); return; }
    const result = await upgradePaaw(currentUser.id);
    sendJSON(200, result);
    return;
  }

  // Process management
  if (url.pathname === "/api/server/start" && method === "POST") {
    if (currentUser.role !== "admin") { sendJSON(403, { error: "Admin only" }); return; }
    sendJSON(200, startPaaw());
    return;
  }

  if (url.pathname === "/api/server/stop" && method === "POST") {
    if (currentUser.role !== "admin") { sendJSON(403, { error: "Admin only" }); return; }
    sendJSON(200, await stopPaaw()); // F-01: resolve only after confirmed exit
    return;
  }

  if (url.pathname === "/api/server/restart" && method === "POST") {
    if (currentUser.role !== "admin") { sendJSON(403, { error: "Admin only" }); return; }
    const result = await restartPaaw();
    sendJSON(200, result);
    return;
  }

  // Backups
  if (url.pathname === "/api/backups" && method === "GET") {
    sendJSON(200, { backups: listBackups() });
    return;
  }

  if (url.pathname === "/api/backups/create" && method === "POST") {
    // F-02: backups are admin-only writes; viewers keep GET read access
    if (currentUser.role !== "admin") { sendJSON(403, { error: "Admin only" }); return; }
    sendJSON(200, createBackup(currentUser.id));
    return;
  }

  if (url.pathname.startsWith("/api/backups/restore/") && method === "POST") {
    // F-02: restore overwrites PAAW_ROOT data — admin only
    if (currentUser.role !== "admin") { sendJSON(403, { error: "Admin only" }); return; }
    const filename = url.pathname.split("/api/backups/restore/")[1];

    // F-01: exit-confirmed stop BEFORE restore; fail-closed — if the stop
    // fails we refuse to extract over a possibly-live server.
    if (getPaawProcess()) {
      const stopResult = await stopPaaw();
      if (!stopResult.ok) {
        sendJSON(200, { ok: false, stage: "stop", error: `Stop failed before restore — ${stopResult.error}` });
        return;
      }
    }
    sendJSON(200, restoreBackup(filename, currentUser.id));
    return;
  }

  // Events
  if (url.pathname === "/api/events" && method === "GET") {
    const limit = parseInt(url.searchParams.get("limit") || "50");
    sendJSON(200, { events: events.slice(-limit) });
    return;
  }

  // Users (admin only)
  if (url.pathname === "/api/users" && method === "GET") {
    if (currentUser.role !== "admin") { sendJSON(403, { error: "Admin only" }); return; }
    sendJSON(200, { users: config.users.map(u => ({ id: u.id, name: u.name, role: u.role })) });
    return;
  }

  // Static files (UI)
  if (url.pathname === "/" || url.pathname === "/index.html") {
    try {
      const html = readFileSync(join(__dirname, "..", "public", "index.html"), "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("UI file missing: " + err.message);
    }
    return;
  }

  // 404
  sendJSON(404, { error: "Not found" });
});

// ── Start Gateway ──
// Main guard: only auto-listen when executed directly (node src/server.mjs).
// Being imported (e.g. by unit tests) must not bind the port or spawn anything.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // Fail-closed (TASK-018): refuse to start the admin platform without a real
  // credential — a missing/default password must never expose :4199.
  const authCheck = validateAuthConfig(config);
  if (!authCheck.ok) {
    console.error(`[PAAW Gateway] ✖ Refusing to start: ${authCheck.error}.`);
    console.error(
      "[PAAW Gateway]   Set users[].passwordHash (bcrypt) in config.json, or provide " +
      "PAAW_GATEWAY_PASSWORD / PAAW_GATEWAY_PASSWORD_HASH.",
    );
    process.exit(1);
  }

  // Bind host (TASK-019): default loopback only; widen explicitly via config.host
  // or PAAW_GATEWAY_HOST. Never rely on Node's all-interfaces default.
  server.listen(config.port, config.host, () => {
    console.log(`[PAAW Gateway] ⚙️ Running on http://${config.host}:${config.port}`);
    console.log(`[PAAW Gateway] PAAW root: ${PAAW_ROOT}`);
    logEvent("gateway_started", `PAAW Gateway started on ${config.host}:${config.port}`);

    // Auto-start PAAW Server
    if (config.autoStartPaaw !== false) {
      setTimeout(() => {
        console.log("[PAAW Gateway] Auto-starting PAAW Server...");
        startPaaw();
      }, 1000);
    }
  });
}