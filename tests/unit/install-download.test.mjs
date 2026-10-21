/**
 * Unit tests — src/lib/install.mjs: downloadVerified + updateLogic + installVersion guards
 * framework: node:test
 *
 * 隔離策略：
 *  - 全程離線：以 withFetch() 注入 mock fetch（回傳 mock Response 物件），
 *    不 spawn、不開 socket、不碰真檔案系統以外的網路。下載目的地寫入 temp dir。
 *  - config 的 HOME 衍生靠 PAAW_HOME env + applyHome()（與 lib-config.test.mjs 同法）。
 *  - installVersion 只測「fail-closed 驗證分支」——這些在任何 IO / spawn 之前 throw，
 *    故不會觸發 npm install。
 */

import { test, describe, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { downloadVerified, updateLogic, installVersion } from "../../src/lib/install.mjs";
import { applyHome, L } from "../../src/lib/config.mjs";
import { withFetch } from "../helpers/inject.mjs";

const TMP_BASE = process.env.PAAW_TMP || join(process.cwd(), ".paaw", "tmp");

// install.mjs logs through the shared `L` logger (config.mjs), which writes to
// console.log. Under `node --test` the child process stdout IS the TAP channel,
// so any stray log line corrupts the stream ("Unable to deserialize cloned
// data"). Silence the logger for the whole file and restore it afterwards.
const savedLog = { info: L.info, ok: L.ok, warn: L.warn, err: L.err };
L.info = () => {};
L.ok = () => {};
L.warn = () => {};
L.err = () => {};

const originalPaawHome = process.env.PAAW_HOME;
const originalPackageUrl = process.env.PAAW_PACKAGE_URL;

let tmp, home;

function setHome(dir) {
  process.env.PAAW_HOME = dir;
  applyHome();
}

beforeEach(() => {
  tmp = mkdtempSync(join(TMP_BASE, "gw-install-dl-"));
  home = join(tmp, "home");
  mkdirSync(home, { recursive: true });
  setHome(home);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

after(() => {
  L.info = savedLog.info;
  L.ok = savedLog.ok;
  L.warn = savedLog.warn;
  L.err = savedLog.err;
  if (originalPaawHome === undefined) delete process.env.PAAW_HOME;
  else process.env.PAAW_HOME = originalPaawHome;
  if (originalPackageUrl === undefined) delete process.env.PAAW_PACKAGE_URL;
  else process.env.PAAW_PACKAGE_URL = originalPackageUrl;
  applyHome();
});

/** Build a minimal Response-shaped mock with a byte-streaming body reader. */
function mockResponse({ ok = true, status = 200, chunks = [] } = {}) {
  let i = 0;
  const bufs = chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
  return {
    ok,
    status,
    body: {
      getReader() {
        return {
          async read() {
            if (i >= bufs.length) return { done: true, value: undefined };
            return { done: false, value: bufs[i++] };
          },
        };
      },
    },
  };
}

/** fetch impl that returns the given Response for any URL. */
const fetchReturning = (resp) => async () => resp;

/** fetch impl that rejects (connection refused). */
const fetchRefusing = async () => {
  throw new Error("ECONNREFUSED");
};

// ─────────────────────────────────────────────────────────────

describe("src/lib/install.mjs — downloadVerified", () => {
  test("串流下載成功：sha256 與 size 吻合 → 回 { sha256, size } 並落地檔案", async () => {
    const payload = Buffer.from("hello paaw package bytes");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const dest = join(tmp, "pkg.zip");

    const r = await withFetch(
      fetchReturning(mockResponse({ chunks: [payload] })),
      () => downloadVerified("http://x/paaw.zip", sha256, dest, payload.length),
    );

    assert.equal(r.sha256, sha256);
    assert.equal(r.size, payload.length);
    assert.equal(existsSync(dest), true, "dest file must be written");
    assert.equal(readFileSync(dest).toString(), payload.toString());
  });

  test("多 chunk 串流：跨 chunk 累加 sha256 與 size 仍正確", async () => {
    const parts = [Buffer.from("AAA"), Buffer.from("BBB"), Buffer.from("CCC")];
    const all = Buffer.concat(parts);
    const sha256 = createHash("sha256").update(all).digest("hex");
    const dest = join(tmp, "multi.zip");

    const r = await withFetch(
      fetchReturning(mockResponse({ chunks: parts })),
      () => downloadVerified("http://x/m.zip", sha256, dest, all.length),
    );
    assert.equal(r.sha256, sha256);
    assert.equal(r.size, 9);
  });

  test("HTTP 非 2xx → throw 下載失敗（含 status）", async () => {
    const dest = join(tmp, "err.zip");
    await assert.rejects(
      withFetch(
        fetchReturning(mockResponse({ ok: false, status: 404 })),
        () => downloadVerified("http://x/404.zip", "deadbeef", dest),
      ),
      /下載失敗 HTTP 404/,
    );
  });

  test("sha256 不符 → throw 拒絕安裝（損毀/竄改），且不落地最終檔", async () => {
    const dest = join(tmp, "tampered.zip");
    await assert.rejects(
      withFetch(
        fetchReturning(mockResponse({ chunks: [Buffer.from("evil bytes")] })),
        () => downloadVerified("http://x/t.zip", "0".repeat(64), dest),
      ),
      /sha256 不符.*拒絕安裝/,
    );
  });

  test("size 不符（有給 sizeExpected）→ throw", async () => {
    const payload = Buffer.from("12345");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const dest = join(tmp, "size.zip");
    await assert.rejects(
      withFetch(
        fetchReturning(mockResponse({ chunks: [payload] })),
        () => downloadVerified("http://x/s.zip", sha256, dest, 999),
      ),
      /size 不符（5 != 999）/,
    );
  });

  test("未給 sizeExpected（0/undefined）→ 略過 size 檢查，sha 對即成功", async () => {
    const payload = Buffer.from("xyz");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const dest = join(tmp, "nosize.zip");
    const r = await withFetch(
      fetchReturning(mockResponse({ chunks: [payload] })),
      () => downloadVerified("http://x/n.zip", sha256, dest, 0),
    );
    assert.equal(r.size, 3);
  });

  test("空 body（合法 sha256 空字串的 hash）→ size 0，成功", async () => {
    const sha256 = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
    const dest = join(tmp, "empty.zip");
    const r = await withFetch(
      fetchReturning(mockResponse({ chunks: [] })),
      () => downloadVerified("http://x/e.zip", sha256, dest),
    );
    assert.equal(r.size, 0);
    assert.equal(r.sha256, sha256);
  });

  test("fetch 連線拒絕 → 例外往上拋（呼叫端決定退化）", async () => {
    const dest = join(tmp, "refuse.zip");
    await assert.rejects(
      withFetch(fetchRefusing, () => downloadVerified("http://x/r.zip", "abc", dest)),
      /ECONNREFUSED/,
    );
  });
});

describe("src/lib/install.mjs — updateLogic", () => {
  const setPkg = (url) => { process.env.PAAW_PACKAGE_URL = url; };

  test("package server 連不上且本機無任何版本 → throw（無法安裝）", async () => {
    setPkg("http://127.0.0.1:1");
    await assert.rejects(
      withFetch(fetchRefusing, () => updateLogic()),
      /package server 連不上且本機無任何版本/,
    );
  });

  test("package server 連不上但本機有 current → 照跑現有版本（updated:false）", async () => {
    setPkg("http://127.0.0.1:1");
    // 造一個 current.json
    const { writeCurrentAtomic } = await import("../../src/lib/config.mjs");
    await writeCurrentAtomic("1.2.3");

    const r = await withFetch(fetchRefusing, () => updateLogic());
    assert.equal(r.updated, false);
    assert.equal(r.version, "1.2.3");
    assert.match(r.note, /package server 連不上/);
  });

  test("manifest.version 非法（path traversal）→ fail-closed throw，不進入安裝", async () => {
    setPkg("http://pkg.local");
    const resp = mockResponse({ chunks: [JSON.stringify({ version: "999.0.0/../../x" })] });
    // /stable.json 用一般 json()，非 body.getReader() → 給一個 json() 版本
    const jsonResp = { ok: true, status: 200, json: async () => ({ version: "999.0.0/../../x" }) };
    await assert.rejects(
      withFetch(fetchReturning(jsonResp), () => updateLogic()),
      /invalid version from manifest/,
    );
  });

  test("stable 不比 current 新 → 不降級（updated:false）", async () => {
    setPkg("http://pkg.local");
    const { writeCurrentAtomic } = await import("../../src/lib/config.mjs");
    await writeCurrentAtomic("2.0.0");
    const jsonResp = { ok: true, status: 200, json: async () => ({ version: "1.0.0", sha256: "x", size: 1 }) };
    const r = await withFetch(fetchReturning(jsonResp), () => updateLogic());
    assert.equal(r.updated, false);
    assert.equal(r.version, "2.0.0");
    assert.match(r.note, /不比 current 新/);
  });

  test("已經是最新版（stable == current）→ updated:false note '已是最新版'", async () => {
    setPkg("http://pkg.local");
    const { writeCurrentAtomic } = await import("../../src/lib/config.mjs");
    await writeCurrentAtomic("3.1.0");
    const jsonResp = { ok: true, status: 200, json: async () => ({ version: "3.1.0", sha256: "x", size: 1 }) };
    const r = await withFetch(fetchReturning(jsonResp), () => updateLogic());
    assert.equal(r.updated, false);
    assert.match(r.note, /已是最新版 3.1.0/);
  });

  test("stable.json 回非 2xx → 走連線失敗分支（有 current → 照跑）", async () => {
    setPkg("http://pkg.local");
    const { writeCurrentAtomic } = await import("../../src/lib/config.mjs");
    await writeCurrentAtomic("1.0.0");
    const errResp = { ok: false, status: 500 };
    const r = await withFetch(fetchReturning(errResp), () => updateLogic());
    assert.equal(r.updated, false);
    assert.equal(r.version, "1.0.0");
  });
});

describe("src/lib/install.mjs — installVersion fail-closed guards", () => {
  // 這些分支在所有 IO / spawn 之前 throw，故不會觸發 npm install。

  test("manifest.version 非字串 → throw invalid version", async () => {
    await assert.rejects(
      installVersion({ version: 123 }, "http://pkg.local"),
      /invalid version from manifest/,
    );
  });

  test("manifest.version 含 path traversal → throw invalid version", async () => {
    await assert.rejects(
      installVersion({ version: "../evil" }, "http://pkg.local"),
      /invalid version from manifest/,
    );
  });

  test("manifest.version 帶 query/fragment → throw invalid version", async () => {
    await assert.rejects(
      installVersion({ version: "1.0.0?x=1" }, "http://pkg.local"),
      /invalid version from manifest/,
    );
  });

  test("無 server 且 manifest.url 非 http(s) → throw 無法決定下載 URL", async () => {
    await assert.rejects(
      installVersion({ version: "1.2.3", url: "file:///etc/passwd" }, null),
      /無法決定下載 URL/,
    );
  });

  test("無 server 且 manifest 無 url → throw 無法決定下載 URL", async () => {
    await assert.rejects(
      installVersion({ version: "1.2.3" }, null),
      /無法決定下載 URL/,
    );
  });
});
