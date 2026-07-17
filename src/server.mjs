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
 */

import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { join, resolve, basename } from "path";
import { execSync, spawn } from "child_process";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { dirname } from "path";

// ── Config ──
const CONFIG_PATH = join(__dirname, "..", "config.json");
let config = loadConfig();

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {
      port: 4199,
      paawRoot: resolve(__dirname, "..", "..", ".."),
      paawServerCmd: "node packages/server/src/index.mjs",
      paawServerPort: 4097,
      backupDir: resolve(__dirname, "..", "..", "..", "backups"),
      backupSchedule: "0 3 * * *",
      maxBackups: 7,
      users: [{ id: "admin", name: "Admin", role: "admin", passwordHash: "change_me" }],
      sessionSecret: "paaw-gw-default",
      sessionMaxAge: 86400000,
    };
  }
}

function saveConfig() {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

const PAAW_ROOT = resolve(__dirname, config.paawRoot || "../../..");
const BACKUP_DIR = resolve(__dirname, config.backupDir || "../../../backups");

// ── Event Log ──
const EVENT_LOG_PATH = join(__dirname, "..", "events.jsonl");
const events = [];

function logEvent(type, detail, userId = "system") {
  const entry = { id: randomUUID(), ts: new Date().toISOString(), type, detail, userId };
  events.push(entry);
  // Keep last 500 in memory
  if (events.length > 500) events.splice(0, events.length - 500);
  // Append to file
  try {
    appendFileSync(EVENT_LOG_PATH, JSON.stringify(entry) + "\n");
  } catch {}
}

import { appendFileSync } from "fs";

// ── Process Manager ──
let paawProcess = null;
let paawStatus = "stopped"; // stopped | starting | running | crashed
let paawPid = null;
let paawStartTime = null;
let paawRestartCount = 0;

function startPaaw() {
  if (paawProcess) return { ok: false, error: "Already running" };

  paawStatus = "starting";
  logEvent("server_starting", "PAAW Server starting...");

  const [cmd, ...args] = config.paawServerCmd.split(" ");
  paawProcess = spawn(cmd, args, {
    cwd: PAAW_ROOT,
    env: { ...process.env, PORT: String(config.paawServerPort || 4097) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  paawPid = paawProcess.pid;
  paawStartTime = Date.now();
  paawStatus = "running";

  paawProcess.stdout.on("data", (data) => {
    // Could log to file if needed
  });

  paawProcess.stderr.on("data", (data) => {
    // Could log errors
  });

  paawProcess.on("exit", (code, signal) => {
    paawStatus = code === 0 ? "stopped" : "crashed";
    paawProcess = null;
    paawPid = null;
    logEvent("server_exited", `PAAW Server exited (code=${code}, signal=${signal})`);
    if (code !== 0 && code !== null) {
      paawRestartCount++;
    }
  });

  paawProcess.on("error", (err) => {
    paawStatus = "crashed";
    paawProcess = null;
    paawPid = null;
    logEvent("server_error", `PAAW Server error: ${err.message}`);
  });

  logEvent("server_started", `PAAW Server started (PID: ${paawPid})`);
  return { ok: true, pid: paawPid };
}

function stopPaaw() {
  if (!paawProcess) return { ok: false, error: "Not running" };

  logEvent("server_stopping", "PAAW Server stopping...");
  paawProcess.kill("SIGTERM");
  paawStatus = "stopped";

  // Give it 5 seconds, then force kill
  setTimeout(() => {
    if (paawProcess) {
      paawProcess.kill("SIGKILL");
      paawProcess = null;
      paawPid = null;
    }
  }, 5000);

  return { ok: true };
}

function restartPaaw() {
  stopPaaw();
  return new Promise((resolve) => {
    setTimeout(() => {
      const result = startPaaw();
      logEvent("server_restarted", "PAAW Server restarted");
      resolve(result);
    }, 2000);
  });
}

// ── Version Manager ──
function getCurrentVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(PAAW_ROOT, "package.json"), "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

function getGitInfo() {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: PAAW_ROOT, encoding: "utf-8" }).trim();
    const commit = execSync("git rev-parse --short HEAD", { cwd: PAAW_ROOT, encoding: "utf-8" }).trim();
    const date = execSync("git log -1 --format=%ci", { cwd: PAAW_ROOT, encoding: "utf-8" }).trim();
    const status = execSync("git status --porcelain", { cwd: PAAW_ROOT, encoding: "utf-8" }).trim();
    const behind = execSync("git rev-list HEAD..origin/" + branch + " --count", { cwd: PAAW_ROOT, encoding: "utf-8" }).trim();
    return {
      branch,
      commit,
      date,
      dirty: status.length > 0,
      behind: parseInt(behind) || 0,
      statusLines: status.split("\n").filter(Boolean).slice(0, 20),
    };
  } catch (err) {
    return { branch: "unknown", commit: "?", date: "?", dirty: false, behind: 0, error: err.message };
  }
}

function getLatestVersion() {
  try {
    // Check remote tags
    execSync("git fetch --tags", { cwd: PAAW_ROOT, encoding: "utf-8", timeout: 15000 });
    const tags = execSync("git tag --sort=-v:refname", { cwd: PAAW_ROOT, encoding: "utf-8" }).trim().split("\n");
    const latestTag = tags.find(t => t.startsWith("v")) || tags[0] || "none";
    return latestTag;
  } catch {
    return "unknown";
  }
}

async function upgradePaaw(userId = "system") {
  if (paawStatus === "running") {
    // Stop first
    stopPaaw();
    await new Promise(r => setTimeout(r, 3000));
  }

  logEvent("upgrade_start", "Starting upgrade...", userId);

  const steps = [];

  try {
    // Step 1: git stash (preserve local changes)
    try {
      execSync("git stash", { cwd: PAAW_ROOT, encoding: "utf-8" });
      steps.push({ step: "git stash", ok: true });
    } catch {
      steps.push({ step: "git stash", ok: true, note: "nothing to stash" });
    }

    // Step 2: git pull
    const gitInfo = getGitInfo();
    const pullResult = execSync(`git pull origin ${gitInfo.branch}`, { cwd: PAAW_ROOT, encoding: "utf-8", timeout: 60000 });
    steps.push({ step: "git pull", ok: true, output: pullResult.trim().slice(0, 200) });

    // Step 3: git stash pop (restore local changes)
    try {
      execSync("git stash pop", { cwd: PAAW_ROOT, encoding: "utf-8" });
      steps.push({ step: "git stash pop", ok: true });
    } catch {
      steps.push({ step: "git stash pop", ok: true, note: "nothing to restore" });
    }

    // Step 4: npm install
    try {
      const npmResult = execSync("npm install --production", { cwd: PAAW_ROOT, encoding: "utf-8", timeout: 120000 });
      steps.push({ step: "npm install", ok: true, output: npmResult.trim().slice(0, 200) });
    } catch (npmErr) {
      steps.push({ step: "npm install", ok: false, error: npmErr.message.slice(0, 200) });
    }

    // Step 5: Restart PAAW Server
    const startResult = startPaaw();
    steps.push({ step: "restart", ok: startResult.ok });

    // Step 6: Verify
    await new Promise(r => setTimeout(r, 3000));
    const healthCheck = await healthCheckPaaw();
    steps.push({ step: "health check", ok: healthCheck.ok, detail: healthCheck.detail });

    const newVersion = getCurrentVersion();
    const newGit = getGitInfo();
    logEvent("upgrade_done", `Upgraded to ${newVersion} (${newGit.commit})`, userId);

    return { ok: true, steps, version: newVersion, git: newGit };
  } catch (err) {
    logEvent("upgrade_failed", `Upgrade failed: ${err.message}`, userId);
    return { ok: false, steps, error: err.message };
  }
}

// ── Backup Manager ──
function listBackups() {
  if (!existsSync(BACKUP_DIR)) return [];
  return readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith("paaw-backup-") && f.endsWith(".tar.gz"))
    .map(f => {
      const stat = statSync(join(BACKUP_DIR, f));
      const dateMatch = f.match(/paaw-backup-(\d{8}-\d{4})/);
      return {
        filename: f,
        date: dateMatch ? dateMatch[1] : "unknown",
        size: stat.size,
        sizeMB: (stat.size / 1024 / 1024).toFixed(1),
        created: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.created.localeCompare(a.created));
}

function createBackup(userId = "system") {
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });

  const dateStr = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19).replace("T", "-");
  const filename = `paaw-backup-${dateStr.slice(0, 13)}.tar.gz`;
  const filepath = join(BACKUP_DIR, filename);

  logEvent("backup_start", "Creating backup...", userId);

  try {
    // Backup data/ and .paaw/ directories
    const dirs = ["data", ".paaw"].filter(d => existsSync(join(PAAW_ROOT, d)));
    const tarCmd = `tar czf "${filepath}" ${dirs.join(" ")}`;
    execSync(tarCmd, { cwd: PAAW_ROOT, encoding: "utf-8", timeout: 300000 });

    // Clean up old backups
    const backups = listBackups();
    if (backups.length > config.maxBackups) {
      const toDelete = backups.slice(config.maxBackups);
      for (const old of toDelete) {
        try { unlinkSync(join(BACKUP_DIR, old.filename)); } catch {}
      }
    }

    logEvent("backup_done", `Backup created: ${filename}`, userId);
    return { ok: true, filename, size: statSync(filepath).size };
  } catch (err) {
    logEvent("backup_failed", `Backup failed: ${err.message}`, userId);
    return { ok: false, error: err.message };
  }
}

function restoreBackup(filename, userId = "system") {
  const filepath = join(BACKUP_DIR, filename);
  if (!existsSync(filepath)) return { ok: false, error: "Backup file not found" };

  logEvent("restore_start", `Restoring from ${filename}...`, userId);

  try {
    // Stop PAAW Server first
    if (paawStatus === "running") stopPaaw();

    // Create a pre-restore backup just in case
    createBackup("system-restore-safety");

    // Extract
    execSync(`tar xzf "${filepath}"`, { cwd: PAAW_ROOT, encoding: "utf-8", timeout: 300000 });

    // Restart
    startPaaw();

    logEvent("restore_done", `Restored from ${filename}`, userId);
    return { ok: true };
  } catch (err) {
    logEvent("restore_failed", `Restore failed: ${err.message}`, userId);
    return { ok: false, error: err.message };
  }
}

// ── Health Check ──
async function healthCheckPaaw() {
  if (paawStatus !== "running") return { ok: false, detail: "Server not running" };

  try {
    const res = await fetch(`http://127.0.0.1:${config.paawServerPort || 4097}/api/health`);
    if (res.ok) {
      const data = await res.json();
      return { ok: true, detail: "Healthy", ...data };
    }
    return { ok: false, detail: `HTTP ${res.status}` };
  } catch {
    return { ok: false, detail: "Connection refused" };
  }
}

function getSystemHealth() {
  const memUsage = process.memoryUsage();
  const uptime = process.uptime();

  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    uptime: Math.floor(uptime),
    memory: {
      rss: (memUsage.rss / 1024 / 1024).toFixed(0) + " MB",
      heapUsed: (memUsage.heapUsed / 1024 / 1024).toFixed(0) + " MB",
      heapTotal: (memUsage.heapTotal / 1024 / 1024).toFixed(0) + " MB",
    },
    paawServer: {
      status: paawStatus,
      pid: paawPid,
      uptime: paawStartTime ? Math.floor((Date.now() - paawStartTime) / 1000) : 0,
      restartCount: paawRestartCount,
    },
    version: getCurrentVersion(),
    git: getGitInfo(),
  };
}

// ── Simple Auth ──
const sessions = new Map();

function createSession(userId) {
  const token = randomUUID();
  sessions.set(token, { userId, created: Date.now() });
  return token;
}

function validateSession(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.created > (config.sessionMaxAge || 86400000)) {
    sessions.delete(token);
    return null;
  }
  return s;
}

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
    const user = config.users.find(u => u.id === body.userId && u.passwordHash === body.password);
    if (user) {
      const token = createSession(user.id);
      logEvent("login", `User ${user.name} logged in`, user.id);
      sendJSON(200, { token, user: { id: user.id, name: user.name, role: user.role } });
    } else {
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
    sendJSON(200, stopPaaw());
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
    sendJSON(200, createBackup(currentUser.id));
    return;
  }

  if (url.pathname.startsWith("/api/backups/restore/") && method === "POST") {
    const filename = url.pathname.split("/api/backups/restore/")[1];
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

// ── (inline UI removed — now served from public/index.html) ──
/* function buildFallbackUI() {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PAAW Gateway</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root { --bg: #0f0f1a; --card: #1a1a2e; --border: #2d2d44; --text: #e0e0e0; --dim: #888; --accent: #f59e0b; --green: #10b981; --red: #ef4444; --blue: #3b82f6; }
  body { font-family: -apple-system, system-ui, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
  .app { max-width: 960px; margin: 0 auto; padding: 20px; }
  h1 { font-size: 1.5rem; margin-bottom: 20px; color: var(--accent); }
  .nav { display: flex; gap: 8px; margin-bottom: 24px; flex-wrap: wrap; }
  .nav button { padding: 8px 16px; border-radius: 8px; border: 1px solid var(--border); background: var(--card); color: var(--text); cursor: pointer; font-size: 0.85rem; }
  .nav button.active { background: var(--accent); color: #000; border-color: var(--accent); font-weight: 700; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  .card h2 { font-size: 1rem; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
  .row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border); }
  .row:last-child { border: none; }
  .label { color: var(--dim); font-size: 0.85rem; }
  .value { font-weight: 600; font-size: 0.9rem; }
  .badge { padding: 2px 8px; border-radius: 6px; font-size: 0.75rem; font-weight: 700; }
  .badge.green { background: #065f46; color: #6ee7b7; }
  .badge.red { background: #7f1d1d; color: #fca5a5; }
  .badge.yellow { background: #78350f; color: #fcd34d; }
  .badge.blue { background: #1e3a5f; color: #93c5fd; }
  .btn { padding: 8px 20px; border-radius: 8px; border: none; cursor: pointer; font-size: 0.85rem; font-weight: 600; }
  .btn.primary { background: var(--accent); color: #000; }
  .btn.danger { background: var(--red); color: #fff; }
  .btn.success { background: var(--green); color: #fff; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-row { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .event { font-size: 0.8rem; padding: 6px 0; border-bottom: 1px solid var(--border); }
  .event .ts { color: var(--dim); margin-right: 8px; }
  .event .type { font-weight: 600; margin-right: 8px; }
  .login-form { max-width: 360px; margin: 80px auto; }
  .login-form input { width: 100%; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border); background: var(--card); color: var(--text); font-size: 0.9rem; margin-bottom: 12px; }
  .login-form .btn { width: 100%; }
  .hidden { display: none; }
  .progress { color: var(--accent); animation: pulse 1.5s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
</style>
</head>
<body>
<div class="app" id="app"></div>
<script>
const API = "";  // same origin
let token = localStorage.getItem("paaw-gw-token");
let currentUser = null;
let currentPage = "dashboard";
let data = {};
let upgrading = false;

// ── API helper ──
async function api(path, method = "GET", body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (token) opts.headers.Authorization = "Bearer " + token;
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API + path, opts);
  if (res.status === 401) { token = null; localStorage.removeItem("paaw-gw-token"); render(); return null; }
  return res.json();
}

// ── Pages ──
function render() {
  const app = document.getElementById("app");
  if (!token || !currentUser) {
    app.innerHTML = renderLogin();
    return;
  }
  app.innerHTML = renderShell();
  refresh();
}

function renderLogin() {
  return \`
  <div class="login-form card">
    <h2>🔐 PAAW Gateway Login</h2>
    <input id="gw-user" placeholder="User ID" autocomplete="username">
    <input id="gw-pass" type="password" placeholder="Password" autocomplete="current-password">
    <button class="btn primary" onclick="doLogin()">Login</button>
  </div>\`;
}

async function doLogin() {
  const userId = document.getElementById("gw-user").value;
  const password = document.getElementById("gw-pass").value;
  const result = await api("/api/auth/login", "POST", { userId, password });
  if (result?.token) {
    token = result.token;
    currentUser = result.user;
    localStorage.setItem("paaw-gw-token", token);
    render();
  } else {
    alert("Login failed");
  }
}

function renderShell() {
  const pages = [
    { id: "dashboard", icon: "📊", label: "Dashboard" },
    { id: "version", icon: "📦", label: "Version" },
    { id: "backup", icon: "💾", label: "Backup" },
    { id: "events", icon: "📋", label: "Event Log" },
  ];
  if (currentUser.role === "admin") {
    pages.push({ id: "users", icon: "👥", label: "Users" });
  }
  return \`
  <h1>⚙️ PAAW Gateway</h1>
  <div class="nav">
    \${pages.map(p => \`<button onclick="switchPage('\${p.id}')" class="\${currentPage === p.id ? "active" : ""}">\${p.icon} \${p.label}</button>\`).join("")}
    <button onclick="doLogout()" style="margin-left:auto">🚪 Logout</button>
  </div>
  <div id="page-content"><div class="progress">Loading...</div></div>\`;
}

function switchPage(page) {
  currentPage = page;
  document.querySelectorAll(".nav button").forEach(b => b.classList.toggle("active", b.textContent.includes(page)));
  refresh();
}

async function refresh() {
  if (!token) return;
  const d = await api("/api/dashboard");
  if (!d) return;
  data = d;
  // Also load full backup list for backup page
  if (currentPage === "backup") {
    const bk = await api("/api/backups");
    if (bk) data.backupsAll = bk.backups;
  }
  renderPage();
}

function renderPage() {
  const el = document.getElementById("page-content");
  if (!el) return;
  switch (currentPage) {
    case "dashboard": el.innerHTML = renderDashboard(); break;
    case "version": el.innerHTML = renderVersion(); break;
    case "backup": el.innerHTML = renderBackup(); break;
    case "events": el.innerHTML = renderEvents(); break;
    case "users": el.innerHTML = renderUsers(); break;
  }
}

function renderDashboard() {
  const d = data;
  const s = d.system;
  const h = d.health;
  const srv = s.paawServer;
  const fmt = (sec) => sec > 86400 ? Math.floor(sec/86400) + "d " + Math.floor((sec%86400)/3600) + "h" : sec > 3600 ? Math.floor(sec/3600) + "h " + Math.floor((sec%3600)/60) + "m" : Math.floor(sec/60) + "m";
  const statusBadge = (st) => st === "running" ? '<span class="badge green">Running</span>' : st === "crashed" ? '<span class="badge red">Crashed</span>' : '<span class="badge yellow">Stopped</span>';

  return \`
  <div class="card"><h2>🖥️ System</h2>
    <div class="row"><span class="label">PAAW Version</span><span class="value">\${s.version}</span></div>
    <div class="row"><span class="label">Node</span><span class="value">\${s.nodeVersion}</span></div>
    <div class="row"><span class="label">Platform</span><span class="value">\${s.platform} \${s.arch}</span></div>
    <div class="row"><span class="label">Gateway Uptime</span><span class="value">\${fmt(s.uptime)}</span></div>
    <div class="row"><span class="label">Memory</span><span class="value">RSS \${s.memory.rss} | Heap \${s.memory.heapUsed}/\${s.memory.heapTotal}</span></div>
  </div>
  <div class="card"><h2>⚡ PAAW Server</h2>
    <div class="row"><span class="label">Status</span><span class="value">\${statusBadge(srv.status)}</span></div>
    <div class="row"><span class="label">PID</span><span class="value">\${srv.pid || "—"}</span></div>
    <div class="row"><span class="label">Uptime</span><span class="value">\${srv.uptime > 0 ? fmt(srv.uptime) : "—"}</span></div>
    <div class="row"><span class="label">Health</span><span class="value">\${h.ok ? '<span class="badge green">Healthy</span>' : '<span class="badge red">' + h.detail + '</span>'}</span></div>
    <div class="row"><span class="label">Restart Count</span><span class="value">\${srv.restartCount}</span></div>
    <div class="btn-row">
      \${srv.status === "running" ? '<button class="btn danger" onclick="doServerAction(\'stop\')">⏹ Stop</button>' : '<button class="btn success" onclick="doServerAction(\'start\')">▶ Start</button>'}
      <button class="btn primary" onclick="doServerAction('restart')">🔄 Restart</button>
    </div>
  </div>
  <div class="card"><h2>📂 Git</h2>
    <div class="row"><span class="label">Branch</span><span class="value">\${s.git.branch}</span></div>
    <div class="row"><span class="label">Commit</span><span class="value">\${s.git.commit} (\${s.git.date?.slice(0,19)})</span></div>
    <div class="row"><span class="label">Behind</span><span class="value">\${s.git.behind > 0 ? '<span class="badge yellow">' + s.git.behind + ' commits behind</span>' : '<span class="badge green">Up to date</span>'}</span></div>
    <div class="row"><span class="label">Dirty</span><span class="value">\${s.git.dirty ? '<span class="badge yellow">Yes</span>' : '<span class="badge green">Clean</span>'}</span></div>
  </div>
  <div class="card"><h2>💾 Backups</h2>
    <div class="row"><span class="label">Total</span><span class="value">\${d.backups.total} backups</span></div>
    <div class="row"><span class="label">Latest</span><span class="value">\${d.backups.latest ? d.backups.latest.date + " (" + d.backups.latest.sizeMB + " MB)" : "—"}</span></div>
  </div>\`;
}

function renderVersion() {
  const g = data.system?.git || {};
  return \`
  <div class="card"><h2>📦 Current Version</h2>
    <div class="row"><span class="label">Version</span><span class="value">\${data.version || "?"}</span></div>
    <div class="row"><span class="label">Branch</span><span class="value">\${g.branch}</span></div>
    <div class="row"><span class="label">Commit</span><span class="value">\${g.commit}</span></div>
    <div class="row"><span class="label">Date</span><span class="value">\${g.date?.slice(0,19)}</span></div>
    <div class="row"><span class="label">Behind remote</span><span class="value">\${g.behind > 0 ? g.behind + " commits" : "Up to date"}</span></div>
  </div>
  \${currentUser.role === "admin" ? \`
  <div class="card"><h2>🔄 Upgrade</h2>
    \${upgrading ? '<div class="progress">⏳ Upgrading... do not close this page</div>' : \`
    <p style="font-size:0.85rem;color:var(--dim);margin-bottom:12px">This will: git stash → git pull → npm install → restart PAAW Server</p>
    <div class="btn-row">
      <button class="btn primary" onclick="doUpgrade()" \${upgrading ? "disabled" : ""}>🔄 Upgrade Now</button>
    </div>\`}
  </div>\` : ""}
  \${g.dirty ? \`
  <div class="card"><h2>⚠️ Uncommitted Changes</h2>
    <pre style="font-size:0.75rem;color:var(--dim);overflow-x:auto">\${(g.statusLines || []).join("\\n")}</pre>
  </div>\` : ""}\`;
}

function renderBackup() {
  const backups = data.backupsAll || [];
  return \`
  <div class="card"><h2>💾 Backups</h2>
    <div class="btn-row" style="margin-bottom:12px">
      <button class="btn success" onclick="doBackup()">🔄 Create Backup Now</button>
    </div>
    \${backups.length === 0 ? '<p style="color:var(--dim)">No backups yet</p>' : backups.map(b => \`
    <div class="row">
      <span class="label">\${b.date} (\${b.sizeMB} MB)</span>
      <div>
        \${currentUser.role === "admin" ? \`<button class="btn primary" style="font-size:0.75rem;padding:4px 12px" onclick="doRestore('\${b.filename}')">📂 Restore</button>\` : ""}
      </div>
    </div>\`).join("")}
  </div>\`;
}

function renderEvents() {
  const evts = data.events || [];
  return \`
  <div class="card"><h2>📋 Recent Events</h2>
    \${evts.map(e => \`<div class="event"><span class="ts">\${e.ts.slice(11,19)}</span><span class="type">\${e.type}</span>\${e.detail}</div>\`).join("")}
  </div>\`;
}

function renderUsers() {
  const users = data.users || config?.users || [];
  return \`
  <div class="card"><h2>👥 Users</h2>
    \${(users || []).map(u => \`<div class="row"><span class="label">\${u.name}</span><span class="value"><span class="badge \${u.role === 'admin' ? 'yellow' : 'blue'}">\${u.role}</span></span></div>\`).join("")}
  </div>\`;
}

// ── Actions ──
async function doServerAction(action) {
  await api("/api/server/" + action, "POST");
  setTimeout(refresh, 2000);
}

async function doUpgrade() {
  if (!confirm("Upgrade PAAW? This will restart the server.")) return;
  upgrading = true;
  renderPage();
  const result = await api("/api/upgrade", "POST");
  upgrading = false;
  if (result?.ok) {
    alert("✅ Upgrade successful! Version: " + (result.version || "?"));
  } else {
    alert("❌ Upgrade failed: " + (result?.error || "unknown"));
  }
  refresh();
}

async function doBackup() {
  const result = await api("/api/backups/create", "POST");
  if (result?.ok) alert("✅ Backup created: " + result.filename);
  else alert("❌ Backup failed: " + (result?.error || "?"));
  refresh();
}

async function doRestore(filename) {
  if (!confirm("Restore from " + filename + "? This will replace current data and restart the server.")) return;
  const result = await api("/api/backups/restore/" + filename, "POST");
  if (result?.ok) alert("✅ Restored from " + filename);
  else alert("❌ Restore failed: " + (result?.error || "?"));
  refresh();
}

function doLogout() {
  token = null; currentUser = null;
  localStorage.removeItem("paaw-gw-token");
  render();
}

// ── Init ──
render();
// Auto-refresh every 15s
setInterval(() => { if (token) refresh(); }, 15000);
</script>
</body>
</html>`;
}

`;
}
*/
// ── Start Gateway ──
server.listen(config.port, () => {
  console.log(`[PAAW Gateway] ⚙️ Running on http://localhost:${config.port}`);
  console.log(`[PAAW Gateway] PAAW root: ${PAAW_ROOT}`);
  logEvent("gateway_started", `PAAW Gateway started on :${config.port}`);

  // Auto-start PAAW Server
  if (config.autoStartPaaw !== false) {
    setTimeout(() => {
      console.log("[PAAW Gateway] Auto-starting PAAW Server...");
      startPaaw();
    }, 1000);
  }
});
