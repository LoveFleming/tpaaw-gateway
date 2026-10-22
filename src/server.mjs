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
import { createEventLog, sanitizeAuditField, AUDIT_FIELD_MAX } from "./server/events.mjs";
import { createAuth } from "./server/auth.mjs";
import { createPaawControl } from "./server/paaw-control.mjs";
import { createBackupManager } from "./server/backup.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Assemble the management platform: config + derived paths, event log, auth,
 * PAAW control, backup manager and the HTTP request handler.
 *
 * Exported so in-process e2e tests can drive the handler without binding a
 * socket (ADR-004 — the sandbox forbids `listen`). Refactor-only: the default
 * path (no overrides) reproduces the previous module-top-level assembly exactly,
 * reading env-derived state via `createConfig(__dirname)` on every call.
 *
 * @param {object} [overrides] - per-case injection points; anything omitted
 *   falls back to today's env-derived default. Do NOT move env reads here.
 * @param {object} [overrides.cfg]         - result of createConfig() (config, paths, saveConfig, …)
 * @param {object} [overrides.events]      - createEventLog() result ({ events, logEvent })
 * @param {object} [overrides.auth]        - createAuth() result ({ createSession, validateSession, login })
 * @param {object} [overrides.paawControl] - createPaawControl() result
 * @param {object} [overrides.backup]      - createBackupManager() result
 * @returns {object} handler + every existing binding.
 */
export function createApp(overrides = {}) {
  // ── Config + derived paths (recomputed per load for cache-busted imports) ──
  const cfg = overrides.cfg ?? createConfig(__dirname);
  const { config, saveConfig, saveCredentialUpgrades, PAAW_ROOT, BACKUP_DIR, EVENT_LOG_PATH, MAX_BACKUPS, BACKUP_SOURCE_DIRS } = cfg;

  // ── Events ──
  const { events, logEvent } = overrides.events ?? createEventLog(EVENT_LOG_PATH);

  // ── Auth (per-createApp instance — never a module singleton, so login
  //    lockout state does not leak across cache-busted test cases) ──
  const { createSession, validateSession, login } = overrides.auth ?? createAuth(config);

  // ── PAAW control (child-process lifecycle) ──
  const paawControl = overrides.paawControl ?? createPaawControl({ config, PAAW_ROOT, logEvent });
  const {
    startPaaw, stopPaaw, restartPaaw, healthCheckPaaw,
    upgradePaaw, getSystemHealth, getCurrentVersion, getGitInfo, getLatestVersion,
    getPaawProcess,
  } = paawControl;

  // ── Backup manager (depends on paaw-control, one-way) ──
  const backupManager = overrides.backup ?? createBackupManager({
    BACKUP_DIR,
    MAX_BACKUPS,
    BACKUP_SOURCE_DIRS,
    PAAW_ROOT,
    logEvent,
    startPaaw,
    getPaawProcess,
  });
  const { backupPath, listBackups, createBackup, restoreBackup } = backupManager;

  // ── Audit-log field sanitizer ──
  // The sanitizer now lives in the events module and is applied at the WRITE
  // layer (createEventLog's logEvent), so EVERY audit entry is guarded — not
  // just the ones whose call site remembered to call it. This removes the
  // per-call-site human convention the old comment relied on: a failing login
  // path (or any future call site) that logs a client-supplied `userId` /
  // `clientIp` is sanitized unconditionally. `sanitizeAuditField` /
  // `AUDIT_FIELD_MAX` are re-exported from events.mjs for backward-compatible
  // unit testing (imported at the top of this file).

  // ── HTTP request handler (moved verbatim from the old createServer callback) ──
  const handler = async (req, res) => {
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

  // ISS-008: cap admin API request bodies. All admin endpoints that read a body
  // (currently only /api/auth/login, carrying { userId, password }) are tiny, so
  // 64 KiB is far above any legitimate payload — no normal request is affected.
  const MAX_BODY_BYTES = 64 * 1024;
  // readBody resolves { ok:false, status:413 } when the body exceeds the cap; the
  // caller must short-circuit on that (no 500). Existing semantics are preserved:
  // empty body or invalid JSON still resolves to a parsed value ({}) on success.
  const readBody = () => new Promise(resolve => {
    let bytes = 0;
    let settled = false;
    const chunks = [];
    const settle = (result) => { if (!settled) { settled = true; resolve(result); } };
    // Over-limit (declared or streamed) → 413. Distinct from a stream error so
    // the caller never reports a client reset as "Payload Too Large".
    const overLimit = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.destroy();
      settle({ ok: false, status: 413 });
    };
    const onData = (chunk) => {
      // Defence line 2: count actual streamed bytes (Buffer length), never trust
      // a possibly absent/forged Content-Length header.
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) return overLimit();
      chunks.push(chunk);
    };
    const onEnd = () => {
      let parsed = {};
      try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8")); } catch { parsed = {}; }
      settle({ ok: true, value: parsed });
    };
    // A stream error (client abort / reset) is NOT an over-limit condition. It is
    // surfaced as a distinct { aborted:true, status:400 } so the caller can
    // short-circuit without mislabelling it as "Payload Too Large"; the caller
    // must not 500 on it either way.
    const onError = () => settle({ ok: false, aborted: true, status: 400 });

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);

    // Defence line 1: reject early from the declared Content-Length, without
    // reading the stream at all.
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) overLimit();
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
    const parsed = await readBody();
    // Two distinct failure modes from readBody must not be conflated:
    //   - over-limit body          → 413 "Payload Too Large" (ISS-008 cap)
    //   - stream error (abort/reset) → 400 "Bad Request"; reporting a client
    //     reset as "Payload Too Large" would be misleading.
    if (!parsed.ok) {
      if (parsed.aborted) { sendJSON(400, { error: "Bad Request" }); return; }
      sendJSON(parsed.status, { error: "Payload Too Large" });
      return;
    }
    const body = parsed.value;
    // Per-IP throttling key: the socket address (no proxy trust configured).
    const clientIp = req.socket?.remoteAddress || "unknown";
    const result = await login(body.userId, body.password, clientIp);
    if (result.ok) {
      // Persist the re-hashed credential if the stored one was legacy/weak.
      // ONLY users[].passwordHash is merged into the on-disk config.json — the
      // in-memory config also carries env-derived host/port/credential
      // overrides, which must not become permanent file settings (review board
      // RR-20261018-1738-6f2e — src/server.mjs:205).
      if (result.upgraded) {
        // Persistence is best-effort (login must still succeed), but a failure
        // must not be silent: the in-memory credential is now bcrypt while disk
        // stays legacy, so every future login re-hashes and re-attempts the
        // write. Record it in the audit trail (review board minor#2).
        try {
          saveCredentialUpgrades();
        } catch (err) {
          logEvent(
            "password_upgrade_persist_failed",
            `Failed to persist re-hashed credential: ${err?.message || err}`,
            result.user.id,
          );
        }
      }
      logEvent("login", `User ${result.user.name} logged in`, result.user.id);
      sendJSON(200, {
        token: result.token,
        user: { id: result.user.id, name: result.user.name, role: result.user.role },
      });
    } else if (result.locked) {
      const retryAfterSec = Math.max(1, Math.ceil((result.retryAfterMs || 0) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      // detail is sanitized at the logEvent write layer (events.mjs), so the
      // attacker-controlled userId / clientIp cannot inject control chars even
      // without an explicit call here.
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
    // userId is passed so the stop audit events (server_stopped /
    // server_stop_failed) attribute the action to the requesting admin.
    sendJSON(200, await stopPaaw(currentUser.id)); // F-01: resolve only after confirmed exit
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
        // NOT 200: the request was refused because the server could not be
        // stopped — a conflict with the current (running) state, not a
        // successful business rejection. The body keeps the { ok:false, stage,
        // error } envelope the UI consumes (public/index.html doRestore),
        // so the 409 only adds the transport-level signal (review board minor#3).
        sendJSON(409, { ok: false, stage: "stop", error: `Stop failed before restore — ${stopResult.error}` });
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
  };

  // ── Public surface: handler + every existing binding (ADR-004) ──
  return {
    handler,
    // Exposed for unit testing the audit-field sanitizer contract (boundary +
    // control-char stripping) without driving the full login/lockout flow.
    sanitizeAuditField,
    AUDIT_FIELD_MAX,
    config,
    saveConfig,
    saveCredentialUpgrades,
    PAAW_ROOT,
    BACKUP_DIR,
    EVENT_LOG_PATH,
    MAX_BACKUPS,
    BACKUP_SOURCE_DIRS,
    events,
    logEvent,
    createSession,
    validateSession,
    login,
    startPaaw,
    stopPaaw,
    restartPaaw,
    healthCheckPaaw,
    upgradePaaw,
    getSystemHealth,
    getCurrentVersion,
    getGitInfo,
    getLatestVersion,
    getPaawProcess,
    backupPath,
    listBackups,
    createBackup,
    restoreBackup,
  };
}

// ── Module-level app instance ──
// Built once per module load so the default (no-override) behavior is identical
// to the old top-level assembly. `?case=N` cache-busting re-runs this module
// body → a fresh createApp → a fresh createConfig reading env.
const app = createApp();

// ── Re-exports (external test contract — unchanged) ──
export { BACKUP_REGEX, BACKUP_DATE_REGEX } from "./server/backup.mjs";
export const { backupPath, listBackups, createBackup, restoreBackup } = app;

// ── Start Gateway ──
// Main guard: only auto-listen when executed directly (node src/server.mjs).
// Being imported (e.g. by unit tests) must not bind the port or spawn anything.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = createServer(app.handler);

  // Fail-closed (TASK-018): refuse to start the admin platform without a real
  // credential — a missing/default password must never expose :4199.
  const authCheck = validateAuthConfig(app.config);
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
  server.listen(app.config.port, app.config.host, () => {
    console.log(`[PAAW Gateway] ⚙️ Running on http://${app.config.host}:${app.config.port}`);
    console.log(`[PAAW Gateway] PAAW root: ${app.PAAW_ROOT}`);
    app.logEvent("gateway_started", `PAAW Gateway started on ${app.config.host}:${app.config.port}`);

    // Auto-start PAAW Server
    if (app.config.autoStartPaaw !== false) {
      setTimeout(() => {
        console.log("[PAAW Gateway] Auto-starting PAAW Server...");
        app.startPaaw();
      }, 1000);
    }
  });
}