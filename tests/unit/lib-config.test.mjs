/**
 * Unit tests — src/lib/config.mjs (Gateway config leaf)
 * TASK-021 / framework: node:test (ADR-001)
 *
 * 隔離策略：
 *  - config.mjs 在 import 時就讀 gateway.json / PAAW_HOME（module top-level），
 *    所以需要「不同 env」的案例用 unique query string 重新 dynamic import。
 *  - 純函式（VERSION_RE / semverGt / augmentedPath）不需重載，直接測。
 *  - 需要真實檔案系統的案例在 mkdtempSync 的 temp dir 裡做，用 PAAW_HOME 導向。
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CONFIG_URL = new URL("../../src/lib/config.mjs", import.meta.url).href;

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gw-libcfg-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.PAAW_HOME;
});

// 每次以 cache-busting query 重新載入，讓 top-level 的 env 讀取生效
async function reload(caseId) {
  return import(`${CONFIG_URL}?case=${caseId}`);
}

describe("src/lib/config.mjs — VERSION_RE", () => {
  test("接受標準語意版本 x.y.z", async () => {
    const { VERSION_RE } = await reload("vr-1");
    assert.equal(VERSION_RE.test("0.2.1"), true);
    assert.equal(VERSION_RE.test("10.20.30"), true);
  });

  test("拒絕非三段、含前綴、字母或空字串", async () => {
    const { VERSION_RE } = await reload("vr-2");
    assert.equal(VERSION_RE.test("v0.2.1"), false);
    assert.equal(VERSION_RE.test("0.2"), false);
    assert.equal(VERSION_RE.test("0.2.1-beta"), false);
    assert.equal(VERSION_RE.test(""), false);
    assert.equal(VERSION_RE.test("a.b.c"), false);
  });
});

describe("src/lib/config.mjs — semverGt", () => {
  test("major 較大回 true", async () => {
    const { semverGt } = await reload("sg-1");
    assert.equal(semverGt("2.0.0", "1.9.9"), true);
  });

  test("minor 較大回 true（patch 不影響）", async () => {
    const { semverGt } = await reload("sg-2");
    assert.equal(semverGt("1.5.0", "1.4.99"), true);
  });

  test("patch 較大回 true", async () => {
    const { semverGt } = await reload("sg-3");
    assert.equal(semverGt("1.4.2", "1.4.1"), true);
  });

  test("相等回 false（嚴格大於）", async () => {
    const { semverGt } = await reload("sg-4");
    assert.equal(semverGt("1.4.1", "1.4.1"), false);
  });

  test("較小回 false", async () => {
    const { semverGt } = await reload("sg-5");
    assert.equal(semverGt("1.0.0", "1.0.1"), false);
    assert.equal(semverGt("1.0.0", "2.0.0"), false);
  });

  test("邊界：0.0.0 不大於任何非 0 版本", async () => {
    const { semverGt } = await reload("sg-6");
    assert.equal(semverGt("0.0.0", "0.0.1"), false);
    assert.equal(semverGt("0.0.1", "0.0.0"), true);
  });
});

describe("src/lib/config.mjs — applyHome / getters", () => {
  test("PAAW_HOME 優先於 gateway.json，衍生 versions/data/current/logs 路徑", async () => {
    process.env.PAAW_HOME = tmp;
    const m = await reload("home-1");
    assert.equal(m.getHome(), tmp);
    assert.equal(m.getVersionsDir(), join(tmp, "versions"));
    assert.equal(m.getDataDir(), join(tmp, "data"));
    assert.equal(m.getCurrentFile(), join(tmp, "current.json"));
    assert.equal(m.getLogsDir(), join(tmp, "logs"));
  });

  test("未設 PAAW_HOME 且無 gateway.json → fallback 到 process.cwd()", async () => {
    delete process.env.PAAW_HOME;
    const cwdTmp = mkdtempSync(join(tmpdir(), "gw-homecwd-"));
    const orig = process.cwd();
    try {
      process.chdir(cwdTmp);
      const m = await reload("home-2");
      assert.equal(m.getHome(), realpathSync(cwdTmp));
    } finally {
      process.chdir(orig);
      rmSync(cwdTmp, { recursive: true, force: true });
    }
  });

  test("未設 PAAW_HOME 但有 gateway.json.paawHome → 用 paawHome（優先於 cwd）", async () => {
    delete process.env.PAAW_HOME;
    const cwdTmp = mkdtempSync(join(tmpdir(), "gw-homecfg-"));
    const paawHome = mkdtempSync(join(tmpdir(), "gw-paawhome-"));
    const orig = process.cwd();
    try {
      process.chdir(cwdTmp);
      writeFileSync(join(cwdTmp, "gateway.json"), JSON.stringify({ paawHome }));
      const m = await reload("home-2b");
      assert.equal(m.getHome(), paawHome);
    } finally {
      process.chdir(orig);
      rmSync(cwdTmp, { recursive: true, force: true });
      rmSync(paawHome, { recursive: true, force: true });
    }
  });

  test("applyHome 可重算：改 PAAW_HOME 後再呼叫即時生效", async () => {
    process.env.PAAW_HOME = tmp;
    const m = await reload("home-3");
    assert.equal(m.getHome(), tmp);
    const tmp2 = mkdtempSync(join(tmpdir(), "gw-libcfg2-"));
    try {
      process.env.PAAW_HOME = tmp2;
      m.applyHome();
      assert.equal(m.getHome(), tmp2);
      assert.equal(m.getVersionsDir(), join(tmp2, "versions"));
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });
});

describe("src/lib/config.mjs — setCfgField / deleteCfgField / getCfg", () => {
  test("setCfgField 寫入、getCfg 回傳 live reference", async () => {
    const m = await reload("cfg-1");
    m.setCfgField("autoUpdate", true);
    assert.equal(m.getCfg().autoUpdate, true);
  });

  test("deleteCfgField 移除欄位", async () => {
    const m = await reload("cfg-2");
    m.setCfgField("semgrepPath", "/x/y");
    m.deleteCfgField("semgrepPath");
    assert.equal("semgrepPath" in m.getCfg(), false);
  });
});

describe("src/lib/config.mjs — saveGatewayCfg", () => {
  test("原子寫入 gateway.json（tmp + rename），內容為格式化 JSON", async () => {
    // saveGatewayCfg 固定寫 process.cwd()/gateway.json；用一個乾淨的 cwd 隔離
    const cwdTmp = mkdtempSync(join(tmpdir(), "gw-cwd-"));
    const orig = process.cwd();
    try {
      process.chdir(cwdTmp);
      const m = await reload("save-1");
      m.setCfgField("packageServer", "http://example.test:4180");
      await m.saveGatewayCfg();

      const file = join(cwdTmp, "gateway.json");
      assert.equal(existsSync(file), true);
      const parsed = JSON.parse(readFileSync(file, "utf-8"));
      assert.equal(parsed.packageServer, "http://example.test:4180");
      // tmp 檔應已被 rename 掉
      assert.equal(existsSync(file + ".tmp"), false);
    } finally {
      process.chdir(orig);
      rmSync(cwdTmp, { recursive: true, force: true });
    }
  });
});

describe("src/lib/config.mjs — loadPackageServerUrl", () => {
  test("PAAW_PACKAGE_URL env 優先，且去除結尾斜線", async () => {
    process.env.PAAW_PACKAGE_URL = "http://pkg.test:9000/";
    const m = await reload("pkg-1");
    assert.equal(await m.loadPackageServerUrl(), "http://pkg.test:9000");
    delete process.env.PAAW_PACKAGE_URL;
  });

  test("無 env / 無 gateway.json 時回預設 localhost:4180", async () => {
    delete process.env.PAAW_PACKAGE_URL;
    const cwdTmp = mkdtempSync(join(tmpdir(), "gw-cwd2-"));
    const orig = process.cwd();
    try {
      process.chdir(cwdTmp);
      const m = await reload("pkg-2");
      assert.equal(await m.loadPackageServerUrl(), "http://localhost:4180");
    } finally {
      process.chdir(orig);
      rmSync(cwdTmp, { recursive: true, force: true });
    }
  });
});

describe("src/lib/config.mjs — readCurrent / writeCurrentAtomic / listInstalledVersions", () => {
  test("readCurrent 檔不存在回 null", async () => {
    process.env.PAAW_HOME = tmp;
    const m = await reload("cur-1");
    assert.equal(await m.readCurrent(), null);
  });

  test("writeCurrentAtomic 後 readCurrent 可讀回，含 version 與 switchedAt", async () => {
    process.env.PAAW_HOME = tmp;
    const m = await reload("cur-2");
    await m.writeCurrentAtomic("1.2.3");
    const cur = await m.readCurrent();
    assert.equal(cur.version, "1.2.3");
    assert.equal(typeof cur.switchedAt, "string");
    // tmp 檔應已清掉
    assert.equal(existsSync(join(tmp, "current.json.tmp")), false);
  });

  test("writeCurrentAtomic 覆寫既有版本", async () => {
    process.env.PAAW_HOME = tmp;
    const m = await reload("cur-3");
    await m.writeCurrentAtomic("1.0.0");
    await m.writeCurrentAtomic("2.0.0");
    assert.equal((await m.readCurrent()).version, "2.0.0");
  });

  test("listInstalledVersions：versions 目錄不存在回 []", async () => {
    process.env.PAAW_HOME = tmp;
    const m = await reload("lv-1");
    assert.deepEqual(await m.listInstalledVersions(), []);
  });

  test("listInstalledVersions：只列 x.y.z，過濾非版本目錄，並由新到舊排序", async () => {
    process.env.PAAW_HOME = tmp;
    mkdirSync(join(tmp, "versions"), { recursive: true });
    for (const d of ["1.0.0", "2.1.0", "0.9.9", "backup", "1.0.0-beta", ".hidden"]) {
      mkdirSync(join(tmp, "versions", d), { recursive: true });
    }
    const m = await reload("lv-2");
    const list = await m.listInstalledVersions();
    assert.deepEqual(list, ["2.1.0", "1.0.0", "0.9.9"]);
  });
});

describe("src/lib/config.mjs — augmentedPath", () => {
  test("prependDir 置於最前且不重複", async () => {
    const m = await reload("ap-1");
    const out = m.augmentedPath("/semgrep/bin", "/usr/bin:/bin");
    const parts = out.split(m.PATH_SEP);
    assert.equal(parts[0], "/semgrep/bin");
    assert.deepEqual(parts.slice(1), ["/usr/bin", "/bin"]);
  });

  test("prependDir 已存在於 basePath 時不重複加入", async () => {
    const m = await reload("ap-2");
    const out = m.augmentedPath("/usr/bin", "/usr/bin:/bin");
    const parts = out.split(m.PATH_SEP);
    assert.equal(parts.filter((p) => p === "/usr/bin").length, 1);
  });

  test("prependDir 為空字串時只保留 basePath", async () => {
    const m = await reload("ap-3");
    const out = m.augmentedPath("", "/usr/bin:/bin");
    assert.deepEqual(out.split(m.PATH_SEP), ["/usr/bin", "/bin"]);
  });

  test("basePath 為 undefined 時不爆，回字串", async () => {
    const m = await reload("ap-4");
    const out = m.augmentedPath("/x", undefined);
    assert.equal(typeof out, "string");
    assert.equal(out.split(m.PATH_SEP).includes("/x"), true);
  });

  test("過濾 basePath 中的空片段", async () => {
    const m = await reload("ap-5");
    const out = m.augmentedPath("/x", ":/usr/bin::/bin:");
    assert.equal(out.split(m.PATH_SEP).includes(""), false);
  });
});
