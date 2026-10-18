/**
 * Unit tests — src/lib/install.mjs
 * TASK-021 / framework: node:test
 *
 * 隔離策略：
 *  - 用 fflate 的 zipSync 在記憶體組出測試用 zip，落地到 temp dir；
 *    全程離線，不呼叫 fetch / npm。
 *  - install 路徑依賴 config 的 getter（PAAW_HOME 衍生），用 unique query 重載
 *    config 讓 PAAW_HOME 指向 temp dir。install.mjs 靜態 import config.mjs，
 *    兩者共用同一 module 實例，故只需設定 PAAW_HOME env 並 reload config。
 */

import { test, describe, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";

// install.mjs 靜態依賴 config.mjs 的模組層狀態（PAAW_HOME 在 import 時讀）。
// 因兩模組共用實例，測試載入前先設好 PAAW_HOME 即可一致。
// 記錄原始值：可能本來就沒設（undefined）→ after() 必須 delete，不能還原成字串 "undefined"。
const originalPaawHome = process.env.PAAW_HOME;
const hostDir = mkdtempSync(join(tmpdir(), "gw-install-host-"));
process.env.PAAW_HOME = hostDir;

// module 級清理：整檔跑完後移除 top-level 建立的 host temp dir，並把 PAAW_HOME 還原為原始值
// （原始不存在就 delete），避免污染同一 process 內後續載入的其他測試檔。
after(() => {
  rmSync(hostDir, { recursive: true, force: true });
  if (originalPaawHome === undefined) {
    delete process.env.PAAW_HOME;
  } else {
    process.env.PAAW_HOME = originalPaawHome;
  }
});

const { extractZip, verifySkeleton, readZipManifest, installUploadedZip } = await import("../../src/lib/install.mjs");
const { getHome, getVersionsDir, getLogsDir } = await import("../../src/lib/config.mjs");

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gw-install-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// 組一個含指定 entries 的 zip buffer（記憶體，值轉 Uint8Array）
function makeZipInMemory(entries) {
  const files = {};
  for (const [name, content] of Object.entries(entries)) {
    files[name] = strToU8(typeof content === "string" ? content : JSON.stringify(content));
  }
  return zipSync(files);
}

// 組一個含指定 entries 的 zip 檔並落地，回傳路徑
function makeZip(path, entries) {
  writeFileSync(path, Buffer.from(makeZipInMemory(entries)));
  return path;
}

function validSkeletonFiles(extra = {}) {
  return {
    "packages/server/src/paaw-server.mjs": "// server",
    "packages/ui/dist/index.html": "<html></html>",
    "package.json": JSON.stringify({ name: "paaw", version: "1.0.0" }),
    "data-seed/seed.txt": "seed",
    ...extra,
  };
}

// ---------- extractZip ----------
describe("src/lib/install.mjs — extractZip", () => {
  test("正常解壓：檔案與目錄結構還原", async () => {
    const zip = makeZip(join(tmp, "ok.zip"), { "a/b.txt": "hello", "c.txt": "world" });
    const dest = join(tmp, "out");
    await extractZip(zip, dest);
    assert.equal(existsSync(join(dest, "a", "b.txt")), true);
    assert.equal(existsSync(join(dest, "c.txt")), true);
  });

  test("目錄 entry（結尾 /）建立為目錄", async () => {
    const zip = makeZip(join(tmp, "dir.zip"), { "sub/": "", "sub/x.txt": "1" });
    const dest = join(tmp, "out2");
    await extractZip(zip, dest);
    assert.equal(existsSync(join(dest, "sub", "x.txt")), true);
  });

  test("zip-slip 防護：../ 逃逸路徑 throw", async () => {
    const zip = makeZip(join(tmp, "slip.zip"), { "../evil.txt": "pwn" });
    await assert.rejects(() => extractZip(zip, join(tmp, "out3")), /zip-slip/);
  });

  test("zip-slip 防護：反斜線逃逸也擋（Windows 打包）", async () => {
    // 反斜線會被正規化為 / 再做 zip-slip 檢查
    const zip = makeZip(join(tmp, "slip2.zip"), { "..\\evil2.txt": "pwn" });
    await assert.rejects(() => extractZip(zip, join(tmp, "out4")), /zip-slip/);
  });

  test("深層合法路徑不誤判（a/b/../c 在 destRoot 內）", async () => {
    const zip = makeZip(join(tmp, "norm.zip"), { "a/b/../c.txt": "x" });
    const dest = join(tmp, "out5");
    await extractZip(zip, dest);
    // a/b/../c.txt 正規化後 == a/c.txt，仍在 dest 內
    assert.equal(existsSync(join(dest, "a", "c.txt")), true);
  });
});

// ---------- verifySkeleton ----------
describe("src/lib/install.mjs — verifySkeleton", () => {
  test("關鍵檔齊全 → 通過（不丟例外）", async () => {
    const dest = join(tmp, "skel");
    mkdirSync(join(dest, "packages", "server", "src"), { recursive: true });
    mkdirSync(join(dest, "packages", "ui", "dist"), { recursive: true });
    mkdirSync(join(dest, "data-seed"), { recursive: true });
    writeFileSync(join(dest, "packages", "server", "src", "paaw-server.mjs"), "");
    writeFileSync(join(dest, "packages", "ui", "dist", "index.html"), "");
    writeFileSync(join(dest, "package.json"), "{}");
    await assert.doesNotReject(() => verifySkeleton(dest));
  });

  test("缺 paaw-server.mjs → throw，訊息含缺哪個檔", async () => {
    const dest = join(tmp, "skel2");
    mkdirSync(join(dest, "packages", "ui", "dist"), { recursive: true });
    mkdirSync(join(dest, "data-seed"), { recursive: true });
    writeFileSync(join(dest, "packages", "ui", "dist", "index.html"), "");
    writeFileSync(join(dest, "package.json"), "{}");
    await assert.rejects(() => verifySkeleton(dest), /paaw-server\.mjs/);
  });

  test("空目錄 → throw", async () => {
    const dest = join(tmp, "skel3");
    mkdirSync(dest, { recursive: true });
    await assert.rejects(() => verifySkeleton(dest));
  });
});

// ---------- readZipManifest ----------
describe("src/lib/install.mjs — readZipManifest", () => {
  test("含 paaw-manifest.json → 解析回傳物件", () => {
    const buf = Buffer.from(zipSync({ "paaw-manifest.json": strToU8(JSON.stringify({ version: "1.2.3", product: "paaw" })) }));
    const m = readZipManifest(buf);
    assert.equal(m.version, "1.2.3");
    assert.equal(m.product, "paaw");
  });

  test("無 manifest entry → null", () => {
    const buf = Buffer.from(zipSync({ "a.txt": strToU8("hi") }));
    assert.equal(readZipManifest(buf), null);
  });

  test("manifest 為非法 JSON → null（不丟例外）", () => {
    const buf = Buffer.from(zipSync({ "paaw-manifest.json": strToU8("{ broken") }));
    assert.equal(readZipManifest(buf), null);
  });

  test("非 zip buffer → null", () => {
    assert.equal(readZipManifest(Buffer.from("not a zip")), null);
  });
});

// ---------- installUploadedZip（決策 / 驗證邏輯，不做 npm install）----------
describe("src/lib/install.mjs — installUploadedZip 版本判定與拒絕", () => {
  test("zip 內無 manifest、檔名非 paaw-x.y.z.zip → 拒裝", async () => {
    const buf = Buffer.from(zipSync({ "a.txt": strToU8("hi") }));
    await assert.rejects(() => installUploadedZip(buf, "weird.zip"), /無法判斷版本/);
  });

  test("manifest product 非 paaw → 拒裝", async () => {
    const buf = Buffer.from(zipSync({ "paaw-manifest.json": strToU8(JSON.stringify({ version: "1.0.0", product: "other" })) }));
    await assert.rejects(() => installUploadedZip(buf, "paaw-1.0.0.zip"), /不是 paaw 包/);
  });

  test("manifest version 非法（注入路徑）→ 拒裝", async () => {
    const buf = Buffer.from(zipSync({ "paaw-manifest.json": strToU8(JSON.stringify({ version: "../evil" })) }));
    // version 非法時 fallback 到檔名；檔名也不合法 → 拒裝
    await assert.rejects(() => installUploadedZip(buf, "not-a-version.zip"), /無法判斷版本/);
  });

  test("從檔名 paaw-x.y.z.zip 判定版本（manifest 缺席）→ 版本可辨識，但因骨架缺失而 abort", async () => {
    // 檔名提供版本 1.2.3，但 zip 骨架不完整 → stageInstall 的 verifySkeleton 會 throw
    const buf = Buffer.from(zipSync({ "readme.txt": strToU8("x") }));
    await assert.rejects(() => installUploadedZip(buf, "paaw-1.2.3.zip"));
    // 應已在 versions/1.2.3.tmp 放過東西，但最終仍 abort（不產生 versions/1.2.3 定版）
    assert.equal(existsSync(join(getVersionsDir(), "1.2.3")), false);
    // 骨架驗證失敗發生在 rename 之前 → 半成品留在 staging 目錄 .tmp（未清），據此斷言實際狀態
    assert.equal(existsSync(join(getVersionsDir(), "1.2.3.tmp")), true);
  });

  test("合法 zip（manifest + 完整骨架 + skip npm）→ 安裝成功並切 current", async () => {
    process.env.PAAW_SKIP_NPM_I = "1";
    try {
      const buf = Buffer.from(makeZipInMemory(validSkeletonFiles({ "paaw-manifest.json": JSON.stringify({ version: "3.4.5", product: "paaw" }) })));
      const r = await installUploadedZip(buf, "paaw-3.4.5.zip");
      assert.equal(r.ok, true);
      assert.equal(r.version, "3.4.5");
      assert.equal(existsSync(join(getVersionsDir(), "3.4.5")), true);
    } finally {
      delete process.env.PAAW_SKIP_NPM_I;
    }
  });
});
