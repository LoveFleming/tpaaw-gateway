/**
 * E2E tests — Gateway Admin: auth + backup API (TASK-003, framework: node:test / ADR-001)
 *
 * 隔離策略（測試絕不碰開發者本機正在跑的 gateway :4199）：
 *  - spawn 真 src/server.mjs 子進程，讀 throwaway config（PAAW_CONFIG knob）
 *  - 隨機可用 port（getFreePort），獨立於 :4199 / :4097
 *  - PAAW_ROOT / PAAW_BACKUP_DIR / PAAW_EVENT_LOG 全指到 mkdtemp temp dir
 *  - autoStartPaaw: false → 不會 spawn PAAW、不對外 fetch
 *  - cleanup：after hook 溫和 kill + 等待退出 + rm temp dir；
 *    另掛 process exit kill-switch，before hook 中途丟例外也不會漏孤兒進程
 *    （孤兒進程的 stdio pipe 會讓 test runner 永遠不退出 —— 曾經發生過）
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
// 只取純 regex 常數（import 不會 listen / spawn —— server.mjs 有 main guard）
import { BACKUP_REGEX, BACKUP_DATE_REGEX } from "../../src/server.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "..", "src", "server.mjs");

const TEST_USER = { id: "admin", name: "E2E Tester", role: "admin", passwordHash: "e2e-pass-123" };
const HEALTH_TIMEOUT_MS = 10_000;

// ── 孤兒進程保險：不論測試怎麼失敗，退出前把所有子進程斷電 ──
const ACTIVE_CHILDREN = new Set();
process.on("exit", () => {
  for (const child of ACTIVE_CHILDREN) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

/** 向 OS 要一個目前沒人用的 port（bind :0 後馬上釋放） */
function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jsonReq(base, path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON 回應 */ }
  return { status: res.status, data };
}

/**
 * Spawn 一個隔離的 gateway 子進程，等到 /api/health 可用。
 * 回傳 { child, base, tmp, paawRoot, backupDir }。
 * 清理由呼叫端的 after hook 呼 stopGateway()（見下方）。
 */
async function startGateway(configOverrides = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "paaw-gw-e2e-"));
  const paawRoot = join(tmp, "paaw-root");
  const backupDir = join(tmp, "backups");
  const port = await getFreePort();

  // 模擬可備份的 PAAW 資料（data/ + .paaw/）
  mkdirSync(join(paawRoot, "data"), { recursive: true });
  mkdirSync(join(paawRoot, ".paaw"), { recursive: true });
  writeFileSync(join(paawRoot, "data", "db.json"), '{"e2e":"seed-v1"}');
  writeFileSync(join(paawRoot, ".paaw", "state.json"), '{"e2e":true}');

  const configPath = join(tmp, "config.json");
  writeFileSync(configPath, JSON.stringify({
    port,
    paawRoot,
    paawServerCmd: "node e2e-no-such-file.mjs", // 不會被執行（autoStartPaaw: false）
    paawServerPort: await getFreePort(),        // 雙保險：即使被觸發也指到空 port
    backupDir,
    backupSchedule: "0 3 * * *",
    maxBackups: 7,
    autoStartPaaw: false,
    users: [TEST_USER],
    sessionSecret: "e2e-secret",
    sessionMaxAge: 86_400_000,
    ...configOverrides,
  }));

  const child = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      PAAW_CONFIG: configPath,
      PAAW_ROOT: paawRoot,
      PAAW_BACKUP_DIR: backupDir,
      PAAW_EVENT_LOG: join(tmp, "events.jsonl"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  ACTIVE_CHILDREN.add(child);
  child.once("exit", () => ACTIVE_CHILDREN.delete(child));
  let childLog = "";
  child.stdout.on("data", (c) => { childLog += c; });
  child.stderr.on("data", (c) => { childLog += c; });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`gateway 子進程提前退出 (code=${child.exitCode})\n${childLog}`);
    }
    try {
      const r = await fetch(base + "/api/health");
      if (r.ok) break;
    } catch { /* 尚未起來，繼續輪詢 */ }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`gateway 在 ${HEALTH_TIMEOUT_MS}ms 內沒起來\n${childLog}`);
    }
    await sleep(100);
  }
  return { child, base, tmp, paawRoot, backupDir };
}

/** 溫和關閉：kill → 等子進程真的退出（避免 rm temp dir 時它還在寫檔）→ 清 temp dir */
async function stopGateway(g) {
  if (!g) return;
  if (g.child.exitCode === null) {
    await new Promise((done) => {
      g.child.once("exit", done);
      g.child.kill();
      setTimeout(done, 3000); // 等不到就用 exit kill-script 兜底，不讓 runner 卡死
    });
  }
  rmSync(g.tmp, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────
// 主流程：auth + backup（單一子進程，測案例之間有順序依賴：
// test 8 的列表斷言依賴 test 7 建立的檔案 —— node:test 同 describe 內依序執行）
// ─────────────────────────────────────────────────────────────
describe("E2E · Gateway Admin — auth & backup API", () => {
  let g;
  let base;
  let backupDirRef;     // 隔離 temp backup dir（斷言檔案落地用）
  let token;            // login 拿到的 session token
  let createdFilename;  // create API 回傳的備份檔名

  before(async () => {
    g = await startGateway();
    base = g.base;
    backupDirRef = g.backupDir;
  });

  after(() => stopGateway(g));

  // ── 1. Health（public）──
  it("GET /api/health 是 public，回 200 + gateway 存活資訊", async () => {
    const { status, data } = await jsonReq(base, "/api/health");
    assert.equal(status, 200);
    assert.equal(data.status, "ok");
    assert.equal(data.gateway, true);
  });

  // ── 2. Auth：正確憑證 ──
  it("POST /api/auth/login 正確憑證 → 200 { token, user }", async () => {
    const { status, data } = await jsonReq(base, "/api/auth/login", {
      method: "POST",
      body: { userId: TEST_USER.id, password: TEST_USER.passwordHash },
    });
    assert.equal(status, 200);
    assert.ok(data.token, "要有 token");
    assert.match(data.token, /^[0-9a-f-]{36}$/); // randomUUID 格式
    assert.deepEqual(data.user, { id: TEST_USER.id, name: TEST_USER.name, role: TEST_USER.role });
    token = data.token;
  });

  // ── 3. Auth：錯誤憑證 ──
  it("POST /api/auth/login 錯誤密碼 / 不存在用戶 / 空 body → 401", async () => {
    for (const body of [
      { userId: TEST_USER.id, password: "wrong-password" },
      { userId: "nobody", password: TEST_USER.passwordHash },
      {},
    ]) {
      const { status, data } = await jsonReq(base, "/api/auth/login", { method: "POST", body });
      assert.equal(status, 401, `body=${JSON.stringify(body)} 應該 401`);
      assert.equal(data.error, "Invalid credentials");
    }
  });

  // ── 4. Auth：/me 帶合法 token ──
  it("GET /api/auth/me 帶合法 token → 200 回登入用戶", async () => {
    const { status, data } = await jsonReq(base, "/api/auth/me", { token });
    assert.equal(status, 200);
    assert.equal(data.id, TEST_USER.id);
    assert.equal(data.role, "admin");
  });

  // ── 5. Auth：無效 token（安全回歸）──
  it("GET /api/auth/me 無 token / 偽造 token / 亂數 UUID → 401", async () => {
    // 無 Authorization header
    assert.equal((await jsonReq(base, "/api/auth/me")).status, 401);
    // 偽造字串
    assert.equal((await jsonReq(base, "/api/auth/me", { token: "not-a-real-token" })).status, 401);
    // 格式正確但不在 sessions 裡的 UUID
    assert.equal(
      (await jsonReq(base, "/api/auth/me", { token: "00000000-0000-4000-8000-000000000000" })).status,
      401,
    );
  });

  // ── 5b. Auth：Bearer 前綴是強制的（鎖定契約）──
  it("Authorization 帶 raw token（無 Bearer 前綴）→ 401", async () => {
    // server 端 auth middleware 用 startsWith("Bearer ") 判斷，
    // 缺前綴一律當未授權 —— 鎖定此行為，避免日後改成寬鬆解析造成安全弱化
    const res = await fetch(base + "/api/auth/me", { headers: { Authorization: token } });
    assert.equal(res.status, 401);
  });

  // ── 6. Backup API：未授權存取（安全回歸）──
  it("GET /api/backups 未授權 → 401 且不洩漏任何備份資料", async () => {
    const { status, data } = await jsonReq(base, "/api/backups");
    assert.equal(status, 401);
    assert.equal(data.error, "Unauthorized");
    assert.equal("backups" in data, false, "401 回應不可以帶 backups 內容");
  });

  it("POST /api/backups/create 未授權 → 401 且不建立任何檔案", async () => {
    const { status, data } = await jsonReq(base, "/api/backups/create", { method: "POST" });
    assert.equal(status, 401);
    assert.equal(data.error, "Unauthorized");
    assert.equal(existsSync(backupDirRef), false, "未授權請求不應建立 backup 目錄/檔案");
  });

  // ── 7. Backup：建立（真實 tar.gz 落地 temp dir）──
  it("POST /api/backups/create（合法 session）→ 200，temp dir 出現真實 gzip tar", async () => {
    const { status, data } = await jsonReq(base, "/api/backups/create", { method: "POST", token });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.match(data.filename, BACKUP_REGEX, "檔名要符合 BACKUP_REGEX（YYYY-MM-DD-HH）");
    assert.ok(data.size > 0);
    createdFilename = data.filename;

    // 檔案真實存在於「隔離的 temp backup dir」
    const filepath = join(backupDirRef, createdFilename);
    assert.equal(existsSync(filepath), true, `備份檔要落地 temp dir：${filepath}`);
    const buf = readFileSync(filepath);
    assert.equal(buf[0], 0x1f, "gzip magic byte 0x1f");
    assert.equal(buf[1], 0x8b, "gzip magic byte 0x8b");
    assert.equal(buf.length, data.size, "API 回報 size === 實際檔案大小");
  });

  // ── 8. Backup：列表 ──
  it("GET /api/backups（合法 session）→ 列表含剛建立的備份，date 為 YYYY-MM-DD-HH", async () => {
    const { status, data } = await jsonReq(base, "/api/backups", { token });
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.backups));

    const entry = data.backups.find((b) => b.filename === createdFilename);
    assert.ok(entry, `列表要包含 ${createdFilename}`);
    // BACKUP_DATE_REGEX 是「抽取器」（帶檔名前綴 + capture group），
    // 這裡直接驗 date 欄位格式 YYYY-MM-DD-HH，並確認與檔名一致
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}-\d{2}$/, "date 欄位格式 YYYY-MM-DD-HH");
    assert.equal(entry.date, createdFilename.match(BACKUP_DATE_REGEX)?.[1], "date 要等於檔名中的日期段");
    assert.ok(entry.size > 0);
    assert.ok(entry.created, "created (mtime ISO) 要有值");

    // temp dir 裡的實體檔案與 API 列表一致
    const onDisk = readdirSync(backupDirRef).filter((f) => BACKUP_REGEX.test(f));
    assert.equal(onDisk.length, data.backups.length, "API 列表數 === temp dir 實際檔案數");
  });

  // ── 9. Dashboard 整合 ──
  it("GET /api/dashboard（合法 session）→ backups.total >= 1 且 latest 正確", async () => {
    const { status, data } = await jsonReq(base, "/api/dashboard", { token });
    assert.equal(status, 200);
    assert.ok(data.backups.total >= 1);
    assert.equal(data.backups.latest?.filename, createdFilename);
    assert.ok(Array.isArray(data.events), "events audit log 要存在");

    // 未授權 dashboard 一樣要 401
    assert.equal((await jsonReq(base, "/api/dashboard")).status, 401);
  });
});

// ─────────────────────────────────────────────────────────────
// Session 過期：獨立子進程（sessionMaxAge 極短）
// ─────────────────────────────────────────────────────────────
describe("E2E · session 過期行為", () => {
  // 600ms：夠短能快速過期，但對「登入後立即用 token」留足緩衝（慢機器/CI 不會誤判）
  const SESSION_MAX_AGE_MS = 600;
  let g;
  let base, token;

  before(async () => {
    g = await startGateway({ sessionMaxAge: SESSION_MAX_AGE_MS });
    base = g.base;
    const { status, data } = await jsonReq(base, "/api/auth/login", {
      method: "POST",
      body: { userId: TEST_USER.id, password: TEST_USER.passwordHash },
    });
    assert.equal(status, 200);
    token = data.token;
  });

  after(() => stopGateway(g));

  it("剛登入的 token 立即可用", async () => {
    const { status } = await jsonReq(base, "/api/auth/me", { token });
    assert.equal(status, 200);
  });

  it(`超過 sessionMaxAge(${SESSION_MAX_AGE_MS}ms) 後 token 失效 → 401`, async () => {
    await sleep(SESSION_MAX_AGE_MS + 450);
    assert.equal((await jsonReq(base, "/api/auth/me", { token })).status, 401);
    assert.equal((await jsonReq(base, "/api/backups", { token })).status, 401, "過期 token 打 backup API 也要 401");
  });
});
