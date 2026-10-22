/**
 * Unit tests — src/server/config.mjs (management-platform config)
 * TASK-021 / framework: node:test
 *
 * 這支測純函式 loadConfig / validateAuthConfig / saveConfig 與 createConfig 的
 * env 衍生路徑。loadConfig 直接吃 configPath + baseDir，不依賴 module top-level env，
 * 所以可同步測；createConfig 讀 process.env，逐案例直接呼叫（每次 fresh 計算）。
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  DEFAULT_HOST,
  loadConfig,
  validateAuthConfig,
  saveConfig,
  updateConfigOnDisk,
  createConfig,
} from "../../src/server/config.mjs";

const BASE_DIR = resolve("src"); // 模擬 entry 的 __dirname (<root>/src)

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gw-srvcfg-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of ["PAAW_CONFIG", "PAAW_ROOT", "PAAW_BACKUP_DIR", "PAAW_EVENT_LOG", "PAAW_MAX_BACKUPS", "PAAW_GATEWAY_HOST", "PAAW_GATEWAY_PORT", "PAAW_GATEWAY_PASSWORD", "PAAW_GATEWAY_PASSWORD_HASH", "PAAW_GATEWAY_ADMIN_ID"]) {
    delete process.env[k];
  }
});

// ---------- DEFAULT_HOST ----------
describe("src/server/config.mjs — DEFAULT_HOST", () => {
  test("預設綁 loopback，不外洩到網路", () => {
    assert.equal(DEFAULT_HOST, "127.0.0.1");
  });
});

// ---------- loadConfig ----------
describe("loadConfig", () => {
  test("config 檔存在且合法 → 回傳解析後的內容", () => {
    const file = join(tmp, "config.json");
    writeFileSync(file, JSON.stringify({ host: "10.0.0.1", port: 5000, users: [{ id: "a", passwordHash: "$2b$x" }] }));
    const cfg = loadConfig(file, BASE_DIR);
    assert.equal(cfg.host, "10.0.0.1");
    assert.equal(cfg.port, 5000);
    assert.equal(cfg.users.length, 1);
  });

  test("檔不存在 → fallback 預設，且 users 為空（無預設憑證）", () => {
    const cfg = loadConfig(join(tmp, "nope.json"), BASE_DIR);
    assert.equal(cfg.host, DEFAULT_HOST);
    assert.equal(cfg.port, 4199);
    assert.deepEqual(cfg.users, []);
  });

  test("檔內容非合法 JSON → fallback 預設", () => {
    const file = join(tmp, "bad.json");
    writeFileSync(file, "{ this is not json ");
    const cfg = loadConfig(file, BASE_DIR);
    assert.equal(cfg.port, 4199);
    assert.deepEqual(cfg.users, []);
  });

  test("fallback 的預設不含明文預設密碼（security）", () => {
    const cfg = loadConfig(join(tmp, "nope.json"), BASE_DIR);
    assert.equal(JSON.stringify(cfg).includes("change_me"), false);
    // sessionSecret 為 dead config（session 走 randomUUID + in-memory Map），
    // 已從 fallback 移除；確認不再回傳此欄位。
    assert.equal("sessionSecret" in cfg, false);
  });
});

// ---------- validateAuthConfig ----------
describe("validateAuthConfig", () => {
  test("無 users → fail", () => {
    assert.equal(validateAuthConfig({ users: [] }).ok, false);
  });

  test("users 非陣列（undefined）→ fail", () => {
    assert.equal(validateAuthConfig({}).ok, false);
  });

  test("有 user 但無 passwordHash → fail", () => {
    const r = validateAuthConfig({ users: [{ id: "a" }] });
    assert.equal(r.ok, false);
    assert.match(r.error, /no user has a password/);
  });

  test("所有 user 的 passwordHash 為空字串 → fail", () => {
    const r = validateAuthConfig({ users: [{ id: "a", passwordHash: "" }] });
    assert.equal(r.ok, false);
  });

  test("有合法 hash 的 user → pass", () => {
    const r = validateAuthConfig({ users: [{ id: "a", passwordHash: "$2b$10$abcdefghijklmnopqrstuv" }] });
    assert.equal(r.ok, true);
  });

  test("passwordHash 非字串 → 視為無憑證 fail", () => {
    const r = validateAuthConfig({ users: [{ id: "a", passwordHash: 12345 }] });
    assert.equal(r.ok, false);
  });
});

// ---------- saveConfig ----------
describe("saveConfig", () => {
  test("寫回 config.json，內容為格式化 JSON 且可 round-trip", () => {
    const file = join(tmp, "config.json");
    const cfg = { host: DEFAULT_HOST, port: 4199, users: [{ id: "x", passwordHash: "$2b$h" }] };
    saveConfig(file, cfg);
    assert.equal(existsSync(file), true);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf-8")), cfg);
  });
});

// ---------- createConfig ----------
describe("createConfig", () => {
  test("PAAW_CONFIG 覆寫 config 路徑", () => {
    const file = join(tmp, "custom.json");
    writeFileSync(file, JSON.stringify({ users: [] }));
    process.env.PAAW_CONFIG = file;
    const c = createConfig(BASE_DIR);
    assert.equal(c.CONFIG_PATH, file);
  });

  test("預設 config 路徑為 baseDir/../config.json", () => {
    const c = createConfig(BASE_DIR);
    assert.equal(c.CONFIG_PATH, join(BASE_DIR, "..", "config.json"));
  });

  test("PAAW_GATEWAY_HOST 覆寫 bind host", () => {
    process.env.PAAW_GATEWAY_HOST = "0.0.0.0";
    const c = createConfig(BASE_DIR);
    assert.equal(c.config.host, "0.0.0.0");
  });

  test("無 host env / 無 config.host → 用 DEFAULT_HOST（loopback）", () => {
    process.env.PAAW_CONFIG = join(tmp, "empty.json");
    writeFileSync(process.env.PAAW_CONFIG, JSON.stringify({}));
    const c = createConfig(BASE_DIR);
    assert.equal(c.config.host, DEFAULT_HOST);
  });

  test("PAAW_GATEWAY_PORT 覆寫 port 且轉為 number", () => {
    process.env.PAAW_GATEWAY_PORT = "5555";
    const c = createConfig(BASE_DIR);
    assert.equal(c.config.port, 5555);
    assert.equal(typeof c.config.port, "number");
  });

  test("PAAW_ROOT env 覆寫 paawRoot（絕對路徑原樣）", () => {
    process.env.PAAW_ROOT = tmp;
    const c = createConfig(BASE_DIR);
    assert.equal(c.PAAW_ROOT, tmp);
  });

  test("PAAW_BACKUP_DIR env 覆寫 backup dir", () => {
    const bdir = join(tmp, "bk");
    process.env.PAAW_BACKUP_DIR = bdir;
    const c = createConfig(BASE_DIR);
    assert.equal(c.BACKUP_DIR, bdir);
  });

  test("BACKUP_SOURCE_DIRS 為 PAAW_ROOT 下的 data 與 .paaw", () => {
    process.env.PAAW_ROOT = tmp;
    const c = createConfig(BASE_DIR);
    assert.deepEqual(c.BACKUP_SOURCE_DIRS, [join(tmp, "data"), join(tmp, ".paaw")]);
  });

  test("PAAW_MAX_BACKUPS 覆寫 maxBackups 且轉 number", () => {
    process.env.PAAW_MAX_BACKUPS = "3";
    const c = createConfig(BASE_DIR);
    assert.equal(c.MAX_BACKUPS, 3);
    assert.equal(typeof c.MAX_BACKUPS, "number");
  });

  test("預設 MAX_BACKUPS 為 7", () => {
    process.env.PAAW_CONFIG = join(tmp, "empty.json");
    writeFileSync(process.env.PAAW_CONFIG, JSON.stringify({}));
    const c = createConfig(BASE_DIR);
    assert.equal(c.MAX_BACKUPS, 7);
  });

  test("PAAW_EVENT_LOG 覆寫事件檔路徑", () => {
    const ev = join(tmp, "events.jsonl");
    process.env.PAAW_EVENT_LOG = ev;
    const c = createConfig(BASE_DIR);
    assert.equal(c.EVENT_LOG_PATH, ev);
  });

  test("saveConfig() 綁定，呼叫後 config.json 落地當前 config", () => {
    const file = join(tmp, "bound.json");
    writeFileSync(file, JSON.stringify({ users: [] }));
    process.env.PAAW_CONFIG = file;
    const c = createConfig(BASE_DIR);
    c.config.customFlag = "yes";
    c.saveConfig();
    assert.equal(JSON.parse(readFileSync(file, "utf-8")).customFlag, "yes");
  });

  // review board minor#7（RR-20261018-1738-6f2e, config.mjs:133）
  test("createConfig().saveConfig()：env 衍生的 host / port / users 不得寫回 config.json", () => {
    const file = join(tmp, "envnoleak.json");
    writeFileSync(file, JSON.stringify({ host: "127.0.0.1", port: 4199, users: [] }));
    process.env.PAAW_CONFIG = file;
    process.env.PAAW_GATEWAY_HOST = "0.0.0.0";
    process.env.PAAW_GATEWAY_PORT = "5555";
    process.env.PAAW_GATEWAY_PASSWORD = "env-only-strong-pw";
    const c = createConfig(BASE_DIR);
    // runtime config 確實帶 env 值（覆寫生效）
    assert.equal(c.config.host, "0.0.0.0");
    assert.equal(c.config.port, 5555);
    assert.equal(c.config.users.length, 1, "env override 在記憶體中建立了 user");

    c.config.customFlag = "yes"; // 真正屬於檔案的變更
    c.saveConfig();

    const written = JSON.parse(readFileSync(file, "utf-8"));
    assert.equal(written.customFlag, "yes", "真正的變更仍要落盤");
    assert.equal(written.host, "127.0.0.1", "env 衍生的 host 不得寫回 config.json");
    assert.equal(written.port, 4199, "env 衍生的 port 不得寫回 config.json");
    assert.deepEqual(written.users, [], "env 建立的 credential 不得凍結進 config.json");
  });

  test("createConfig().saveConfig(patch)：明確 patch 原樣合併到磁碟文件", () => {
    const file = join(tmp, "explicitpatch.json");
    writeFileSync(file, JSON.stringify({ host: "127.0.0.1", port: 4199, users: [] }));
    process.env.PAAW_CONFIG = file;
    const c = createConfig(BASE_DIR);
    // 明確 patch 由呼叫端決定要寫什麼（此處的 env 覆寫不影響 patch 內容）
    c.saveConfig({ backupSchedule: "0 4 * * *" });
    const written = JSON.parse(readFileSync(file, "utf-8"));
    assert.equal(written.backupSchedule, "0 4 * * *");
    assert.equal(written.port, 4199, "未提及的欄位保留");
  });

  test("createConfig().saveConfig()：無變更時檔案內容不變", () => {
    const file = join(tmp, "noop.json");
    const before = JSON.stringify({ host: "127.0.0.1", port: 4199, users: [] });
    writeFileSync(file, before);
    process.env.PAAW_CONFIG = file;
    const c = createConfig(BASE_DIR);
    c.saveConfig();
    assert.equal(readFileSync(file, "utf-8"), before);
  });

  // ---------- saveCredentialUpgrades（review board RR-20261018-1738-6f2e） ----------
  test("saveCredentialUpgrades：只把 users[].passwordHash 寫回，不落地 env 衍生的 host / port", () => {
    const file = join(tmp, "upgrade.json");
    writeFileSync(file, JSON.stringify({
      host: "127.0.0.1",
      port: 4199,
      users: [{ id: "admin", name: "Admin", role: "admin", passwordHash: "legacy-plain" }],
    }));
    process.env.PAAW_CONFIG = file;
    process.env.PAAW_GATEWAY_HOST = "0.0.0.0";
    process.env.PAAW_GATEWAY_PORT = "5555";
    const c = createConfig(BASE_DIR);
    // 模擬 login 的 lazy rehash：只改記憶體中的 passwordHash
    assert.equal(c.config.host, "0.0.0.0", "env 覆寫確實生效於 runtime config");
    c.config.users[0].passwordHash = "$2b$12$upgraded-hash-value";

    const patched = c.saveCredentialUpgrades();
    assert.equal(patched, 1);

    const written = JSON.parse(readFileSync(file, "utf-8"));
    assert.equal(written.users[0].passwordHash, "$2b$12$upgraded-hash-value");
    assert.equal(written.host, "127.0.0.1", "env 衍生的 host 不得寫回 config.json");
    assert.equal(written.port, 4199, "env 衍生的 port 不得寫回 config.json");
  });

  test("saveCredentialUpgrades：無變更 → 不動檔案", () => {
    const file = join(tmp, "nochange.json");
    const before = JSON.stringify({ users: [{ id: "admin", passwordHash: "$2b$12$same" }] });
    writeFileSync(file, before);
    process.env.PAAW_CONFIG = file;
    const c = createConfig(BASE_DIR);
    assert.equal(c.saveCredentialUpgrades(), 0);
    assert.equal(readFileSync(file, "utf-8"), before);
  });

  test("saveCredentialUpgrades：env 才有的 user（磁碟上不存在）不被建立 → env 密碼不會被凍結進檔", () => {
    const file = join(tmp, "envuser.json");
    writeFileSync(file, JSON.stringify({ users: [] }));
    process.env.PAAW_CONFIG = file;
    process.env.PAAW_GATEWAY_PASSWORD = "env-only-strong-pw";
    const c = createConfig(BASE_DIR);
    assert.equal(c.config.users.length, 1, "env override 在記憶體中建立了 user");
    assert.equal(c.saveCredentialUpgrades(), 0);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf-8")).users, []);
  });

  test("saveCredentialUpgrades：保留磁碟上其他 user 的欄位（by id merge，不是整份覆寫）", () => {
    const file = join(tmp, "merge.json");
    writeFileSync(file, JSON.stringify({
      backupSchedule: "0 3 * * *",
      users: [
        { id: "a", name: "A", role: "admin", passwordHash: "legacy-a" },
        { id: "b", name: "B", role: "viewer", passwordHash: "$2b$12$keep-b" },
      ],
    }));
    process.env.PAAW_CONFIG = file;
    const c = createConfig(BASE_DIR);
    c.config.users[0].passwordHash = "$2b$12$upgraded-a";
    assert.equal(c.saveCredentialUpgrades(), 1);
    const written = JSON.parse(readFileSync(file, "utf-8"));
    assert.equal(written.backupSchedule, "0 3 * * *", "非 user 欄位原樣保留");
    assert.deepEqual(written.users[0], { id: "a", name: "A", role: "admin", passwordHash: "$2b$12$upgraded-a" });
    assert.deepEqual(written.users[1], { id: "b", name: "B", role: "viewer", passwordHash: "$2b$12$keep-b" });
  });
});

// ---------- updateConfigOnDisk（config.mjs:133 同根因的 merge 接縫） ----------
describe("updateConfigOnDisk", () => {
  test("patch 合併到磁碟既有文件上，未提及的欄位保留", () => {
    const file = join(tmp, "patch.json");
    writeFileSync(file, JSON.stringify({ host: "127.0.0.1", port: 4199, users: [] }));
    updateConfigOnDisk(file, { port: 4300 }, BASE_DIR);
    const written = JSON.parse(readFileSync(file, "utf-8"));
    assert.equal(written.port, 4300);
    assert.equal(written.host, "127.0.0.1");
  });
});
