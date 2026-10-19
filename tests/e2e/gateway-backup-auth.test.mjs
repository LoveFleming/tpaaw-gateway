/**
 * E2E tests — Gateway Admin: auth + backup API (TASK-003, framework: node:test / ADR-001)
 *
 * ADR-004 (2026-10-19) — de-socketed, in-process:
 *  The sandbox forbids `listen` (listen EPERM: 127.0.0.1), so this file no longer
 *  spawns `src/server.mjs` nor binds a port. Instead it imports the production
 *  seam `createApp({ cfg })` and drives its request handler directly with mock
 *  req/res (see tests/helpers/inject.mjs). No child server, no socket, no orphan
 *  kill-switch needed.
 *
 *  Isolation is now per-case and explicit:
 *   - each case builds a fresh `cfg` via createConfig(srcDir) under a temp env
 *     (PAAW_CONFIG / PAAW_ROOT / PAAW_BACKUP_DIR / PAAW_EVENT_LOG → mkdtemp)
 *   - createApp({ cfg }) → a fresh auth/session store (no ?case=N bookkeeping,
 *     no state leaking across cases)
 *   - backup/restore still exercise the REAL filesystem in the temp dir
 *   - audit assertions read app.events (the in-memory ring buffer) directly
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync, cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "../../src/server.mjs";
import { createConfig } from "../../src/server/config.mjs";
import { call, sleep } from "../helpers/inject.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, "..", "..", "src");

const TEST_USER = { id: "admin", name: "E2E Tester", role: "admin", passwordHash: "e2e-pass-123" };

/**
 * Build a fresh isolated gateway instance (config + app + temp root).
 * Never binds a socket; the caller drives app.handler via call().
 *
 * @param {object} [configOverrides] merged over the base throwaway config
 * @returns {object} env — { app, cfg, tmp, root, backupDir, eventLogPath, api, login, dispose }
 */
function makeEnv(configOverrides = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "paaw-gw-backup-"));
  const paawRoot = join(tmp, "paaw-root");
  const backupDir = join(tmp, "backups");
  const eventLogPath = join(tmp, "events.jsonl");
  mkdirSync(join(paawRoot, "data"), { recursive: true });
  mkdirSync(join(paawRoot, ".paaw"), { recursive: true });
  writeFileSync(join(paawRoot, "data", "db.json"), '{"e2e":"seed"}');

  const configPath = join(tmp, "config.json");
  writeFileSync(configPath, JSON.stringify({
    host: "127.0.0.1",
    port: 4199,
    paawRoot,
    paawServerCmd: "node e2e-no-such-file.mjs",
    paawServerPort: 4990,
    backupDir,
    autoStartPaaw: false,
    users: [TEST_USER],
    sessionSecret: "e2e-secret",
    sessionMaxAge: 86_400_000,
    ...configOverrides,
  }));

  const built = withEnvSync({
    PAAW_CONFIG: configPath,
    PAAW_ROOT: paawRoot,
    PAAW_BACKUP_DIR: backupDir,
    PAAW_EVENT_LOG: eventLogPath,
  });
  const app = createApp({ cfg: built });

  /** POST/GET helper that drives the handler in-process. */
  const api = (method, path, { body, token } = {}) =>
    call(app, {
      method,
      url: path,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      token,
    }).then((r) => ({ status: r.status, data: r.data, headers: r.headers, raw: r }));

  const login = async (userId = TEST_USER.id, password = TEST_USER.passwordHash) => {
    const r = await api("POST", "/api/auth/login", { body: { userId, password } });
    assert.equal(r.status, 200, `login failed: ${JSON.stringify(r.data)}`);
    return r.data.token;
  };

  return {
    app, cfg: built, tmp, root: paawRoot, backupDir, eventLogPath, api, login,
    dispose: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

/** createConfig reads env synchronously — mirror withEnv without async ceremony. */
function withEnvSync(env) {
  const saved = new Map();
  for (const [k, v] of Object.entries(env)) {
    saved.set(k, Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined);
    process.env[k] = v;
  }
  try {
    return createConfig(SRC_DIR);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Auth + backup happy/error paths + audit trail
// ═══════════════════════════════════════════════════════════════════
describe("E2E · auth + backup（in-process）", () => {
  let env;
  let token = null;

  before(() => { env = makeEnv(); });
  after(() => env.dispose());

  // ── 1. Auth：缺 Authorization → 401 ──
  it("GET /api/backups 無認證 → 401", async () => {
    const { status, data } = await env.api("GET", "/api/backups");
    assert.equal(status, 401);
    assert.equal(data.error, "Unauthorized");
  });

  // ── 2. Auth：正確憑證 ──
  it("POST /api/auth/login 正確憑證 → 200 { token, user }", async () => {
    const { status, data } = await env.api("POST", "/api/auth/login", {
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
      const { status, data } = await env.api("POST", "/api/auth/login", { body });
      assert.equal(status, 401, `body=${JSON.stringify(body)} 應該 401`);
      assert.equal(data.error, "Invalid credentials");
    }
  });

  // ── 4. Auth：/me 帶合法 token ──
  it("GET /api/auth/me 帶合法 token → 200 回登入用戶", async () => {
    const { status, data } = await env.api("GET", "/api/auth/me", { token });
    assert.equal(status, 200);
    assert.equal(data.id, TEST_USER.id);
    assert.equal(data.role, "admin");
  });

  // ── 5. Auth：無效 token（安全回歸）──
  it("GET /api/auth/me 無 token / 偽造 token / 亂數 UUID → 401", async () => {
    assert.equal((await env.api("GET", "/api/auth/me")).status, 401);
    assert.equal((await env.api("GET", "/api/auth/me", { token: "not-a-real-token" })).status, 401);
    assert.equal(
      (await env.api("GET", "/api/auth/me", { token: "00000000-0000-4000-8000-000000000000" })).status,
      401,
    );
  });

  // ── 5b. Auth：Bearer 前綴是強制的（鎖定契約）──
  it("Authorization 帶 raw token（無 Bearer 前綴）→ 401", async () => {
    // server 端 auth middleware 用 startsWith("Bearer ") 判斷，
    // 缺前綴一律當未授權 —— 鎖定此行為，避免日後改成寬鬆解析造成安全弱化
    const res = await call(env.app, {
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: token }, // 無 "Bearer " 前綴
    });
    assert.equal(res.status, 401);
  });

  // ── 5c. Auth：Bearer 後空字串 → 401 ──
  it("Authorization: 'Bearer ' (空 token) → 401", async () => {
    const res = await call(env.app, {
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: "Bearer " },
    });
    assert.equal(res.status, 401);
  });

  // ── 6. Backups：列出（空） ──
  it("GET /api/backups 帶 token → 200 { backups: [] }（尚無備份）", async () => {
    const { status, data } = await env.api("GET", "/api/backups", { token });
    assert.equal(status, 200);
    assert.deepEqual(data.backups, []);
  });

  // ── 7. Backups：建立 ──
  it("POST /api/backups/create → 200 { ok:true, filename } 且檔案真的落地", async () => {
    const { status, data } = await env.api("POST", "/api/backups/create", { token });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.ok, true);
    assert.ok(data.filename, "要回 filename");
    assert.ok(existsSync(join(env.backupDir, data.filename)), "備份檔要真的存在 BACKUP_DIR");
  });

  // ── 7b. Backups：列表含剛建立的備份 ──
  it("GET /api/backups → 列出的檔名都符合 BACKUP_REGEX", async () => {
    const { status, data } = await env.api("GET", "/api/backups", { token });
    assert.equal(status, 200);
    assert.ok(data.backups.length >= 1, "至少要有一個剛建立的備份");
    for (const b of data.backups) {
      assert.match(b.filename, /^paaw-backup-\d{4}-\d{2}-\d{2}-\d{2}\.tar\.gz$/);
    }
  });

  // ── 8. Audit：login / backup 事件有落 log ──
  it("audit trail：login 與 backup 事件寫入 events", async () => {
    const types = env.app.events.map((e) => e.type);
    assert.ok(types.includes("login"), `events 應含 login，實得: ${types.join(",")}`);
    assert.ok(
      types.some((t) => /backup/.test(t)),
      `events 應含 backup 相關事件，實得: ${types.join(",")}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Session expiry
// ═══════════════════════════════════════════════════════════════════
describe("E2E · session 過期行為（in-process）", () => {
  // 600ms：夠短能快速過期，但對「登入後立即用 token」留足緩衝（慢機器/CI 不會誤判）
  const SESSION_MAX_AGE_MS = 600;
  let env;
  let token;

  before(async () => {
    env = makeEnv({ sessionMaxAge: SESSION_MAX_AGE_MS });
    token = await env.login();
  });
  after(() => env.dispose());

  it("剛登入的 token 立即可用", async () => {
    assert.equal((await env.api("GET", "/api/auth/me", { token })).status, 200);
  });

  it(`超過 sessionMaxAge(${SESSION_MAX_AGE_MS}ms) 後 token 失效 → 401`, async () => {
    await sleep(SESSION_MAX_AGE_MS + 450);
    assert.equal((await env.api("GET", "/api/auth/me", { token })).status, 401);
    assert.equal((await env.api("GET", "/api/backups", { token })).status, 401, "過期 token 打 backup API 也要 401");
  });
});

// ─────────────────────────────────────────────────────────────
// TASK-011：restore 路由攻擊檔名防護（backupPath CWE-22 hardening e2e）
//
// 兩層防禦的實際行為（WHATWG URL 語意已 probe 驗證）：
//   Layer 1 — URL 正規化：literal `../`、`..\` 在 new URL() 就被正規化掉，
//             pathname 變成 /api/etc/... → 路由 startsWith 不符 → 404
//   Layer 2 — backupPath 白名單：percent-encoded 逃逸（路由不做
//             decodeURIComponent）與絕對路徑注入原樣抵達 restoreBackup
//             → { ok:false } 拒絕
//   注意：本 server 的業務拒絕信封是 HTTP 200 { ok:false, error }，不是 400。
// ─────────────────────────────────────────────────────────────
describe("E2E · restore 攻擊檔名防護（TASK-011 backupPath，in-process）", () => {
  let env;
  let token;
  const SEED_DB = '{"e2e":"seed"}';

  before(async () => {
    env = makeEnv();
    token = await env.login();
  });
  after(() => env.dispose());

  const backupFilesOnDisk = () => (existsSync(env.backupDir) ? readdirSync(env.backupDir) : []).sort();
  const restoreEvents = () => env.app.events.filter((e) => /restore_/.test(e.type));

  it("percent-encoded 逃逸 / 絕對路徑注入 / 格式非法 / 空檔名 → 200 {ok:false} 拒絕（admin 身分下仍拒絕）", async () => {
    const vectors = [
      { label: "percent-encoded ../../etc/passwd", path: "/api/backups/restore/..%2f..%2fetc%2fpasswd" },
      { label: "percent-encoded dots config.json", path: "/api/backups/restore/%2e%2e%2fconfig.json" },
      { label: "絕對路徑注入（格式合法的 /etc 檔名）", path: "/api/backups/restore//etc/paaw-backup-2026-09-19-10.tar.gz" },
      { label: "缺 -HH 的格式非法檔名", path: "/api/backups/restore/paaw-backup-2026-09-19.tar.gz" },
      { label: "緊湊日期格式", path: "/api/backups/restore/paaw-backup-20260919-10.tar.gz" },
      { label: "雙副檔名", path: "/api/backups/restore/paaw-backup-2026-09-19-10.tar.gz.exe" },
      { label: "空檔名（尾斜線後無內容）", path: "/api/backups/restore/" },
    ];
    for (const v of vectors) {
      const { status, data } = await env.api("POST", v.path, { token });
      assert.equal(status, 200, `[${v.label}] HTTP 狀態`);
      assert.equal(data.ok, false, `[${v.label}] 必須 ok:false（admin 打攻擊檔名照樣拒絕）: ${JSON.stringify(data)}`);
      assert.match(data.error, /invalid/i, `[${v.label}] 錯誤訊息標明 invalid: ${data.error}`);
    }
  });

  it("literal ../ 與 ..\\ 被 URL 正規化吃掉 → 404，不進 restore 邏輯", async () => {
    // new URL() 用與舊 client（fetch/undici）相同的 WHATWG URL 解析 →
    // pathname 在解析時就正規化成 /api/etc/... 等非 restore 路由 → 404
    const vectors = [
      "/api/backups/restore/../../etc/passwd",
      "/api/backups/restore/..\\..\\windows\\win.ini",
    ];
    for (const path of vectors) {
      const { status, data } = await env.api("POST", path, { token });
      assert.equal(status, 404, `[${path}] 正規化後不應命中任何路由`);
      assert.equal(data.ok, undefined, `[${path}] 404 回應不得有 restore 結果信封`);
    }
  });

  it("攻擊階段零副作用：PAAW_ROOT 未動、備份集未動、audit log 零 restore 事件", async () => {
    assert.equal(
      readFileSync(join(env.root, "data", "db.json"), "utf-8"),
      SEED_DB,
      "攻擊不得覆寫 PAAW_ROOT 資料",
    );
    assert.deepEqual(backupFilesOnDisk(), [], "攻擊不得建立 BACKUP_DIR 內任何檔案（含 safety backup）");
    assert.equal(restoreEvents().length, 0, "audit log 不得有 restore 事件");
  });

  it("合法 admin restore 不回歸：ok:true、資料真還原、safety backup 出現、事件落 log", async () => {
    const created = await env.api("POST", "/api/backups/create", { token });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    assert.equal(created.data.ok, true);
    const filename = created.data.filename;

    // 備份後「加料」：新增一個備份後才存在的檔案。
    // 注意①：createBackup 檔名時間戳只到「小時」粒度，且 restoreBackup 是
    // 「先建 safety backup、後解包目標」—— 若同小時內直接 restore 剛才 create
    // 的備份，safety backup 會以「同名」覆蓋該檔，解包出的其實是現況。因此把
    // 封存複製成「另一個合法檔名」（小時 +5 mod 24）再 restore 那個名字。
    const m = filename.match(/^paaw-backup-(\d{4})-(\d{2})-(\d{2})-(\d{2})\.tar\.gz$/);
    assert.ok(m, `created filename 應符合 BACKUP_REGEX: ${filename}`);
    const renamedHour = (Number(m[4]) + 5) % 24;
    const restoreName = `paaw-backup-${m[1]}-${m[2]}-${m[3]}-${String(renamedHour).padStart(2, "0")}.tar.gz`;
    assert.notEqual(restoreName, filename, "改名後不得與原備份同名");
    cpSync(join(env.backupDir, filename), join(env.backupDir, restoreName));
    // 注意②：tar 解包是 overwrite-in-place，不會刪除封存裡沒有的額外檔案 ——
    // 所以用「改動既有檔案內容、還原後應回復」斷言。
    writeFileSync(join(env.root, "data", "db.json"), "tampered-after-backup");
    const res = await env.api("POST", `/api/backups/restore/${restoreName}`, { token });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.ok, true, `合法 restore 必須成功: ${JSON.stringify(res.data)}`);

    assert.equal(
      readFileSync(join(env.root, "data", "db.json"), "utf-8"),
      SEED_DB,
      "被改壞的 db.json 必須被覆寫回備份時內容（資料真的被還原）",
    );

    const list = await env.api("GET", "/api/backups", { token });
    assert.equal(list.status, 200);
    assert.ok(list.data.backups.length >= 1, "restore 後備份清單不得為空（safety backup）");
    for (const b of list.data.backups) {
      assert.match(b.filename, /^paaw-backup-\d{4}-\d{2}-\d{2}-\d{2}\.tar\.gz$/);
    }

    const evts = restoreEvents();
    assert.ok(evts.length >= 2, "合法 restore 應留下 restore_start/restore_done 事件");
    assert.ok(evts.some((e) => e.detail.includes(restoreName)), "事件要記錄被還原的檔名");
  });
});
