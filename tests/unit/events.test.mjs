/**
 * Unit tests — src/server/events.mjs (audit-trail buffer)
 * TASK-021 / framework: node:test
 *
 * 純 in-memory + appendFileSync，無外部依賴。用 temp dir 隔離 JSONL 檔。
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEventLog } from "../../src/server/events.mjs";

let tmp, logPath;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gw-events-"));
  logPath = join(tmp, "events.jsonl");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("src/server/events.mjs — createEventLog", () => {
  test("logEvent 產生含 id / ts / type / detail / userId 的 entry", () => {
    const { events, logEvent } = createEventLog(logPath);
    logEvent("server_started", "PAAW 已啟動", "admin");
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(typeof e.id, "string");
    assert.ok(e.id.length > 0);
    assert.equal(e.type, "server_started");
    assert.equal(e.detail, "PAAW 已啟動");
    assert.equal(e.userId, "admin");
    assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T/); // ISO 8601
  });

  test("userId 預設為 system", () => {
    const { events, logEvent } = createEventLog(logPath);
    logEvent("upgrade", "check");
    assert.equal(events[0].userId, "system");
  });

  test("每筆 entry 有唯一 id", () => {
    const { events, logEvent } = createEventLog(logPath);
    logEvent("a", "1");
    logEvent("a", "2");
    logEvent("a", "3");
    const ids = new Set(events.map((e) => e.id));
    assert.equal(ids.size, 3);
  });

  test("events 保持插入順序", () => {
    const { events, logEvent } = createEventLog(logPath);
    logEvent("t1", "first");
    logEvent("t2", "second");
    assert.deepEqual(events.map((e) => e.detail), ["first", "second"]);
  });

  test("同步 append 到 JSONL 檔（每行一筆合法 JSON）", () => {
    const { logEvent } = createEventLog(logPath);
    logEvent("server_stopped", "bye");
    logEvent("upgrade", "v2");
    assert.equal(existsSync(logPath), true);
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    assert.equal(lines.length, 2);
    const parsed = lines.map((l) => JSON.parse(l));
    assert.equal(parsed[0].type, "server_stopped");
    assert.equal(parsed[1].detail, "v2");
  });

  test("ring buffer 上限 500：超過時丟最舊、保留最新 500", () => {
    const { events, logEvent } = createEventLog(logPath);
    for (let i = 0; i < 520; i++) logEvent("tick", String(i));
    assert.equal(events.length, 500);
    assert.equal(events[0].detail, "20"); // 0..19 被丟掉
    assert.equal(events[499].detail, "519");
  });

  test("file append 失敗（路徑不可寫）不丟例外", () => {
    // 指向一個不存在的深層目錄下的檔案 → appendFileSync 會 throw，但被 catch
    const bad = join(tmp, "no-such-dir", "x.jsonl");
    const { events, logEvent } = createEventLog(bad);
    assert.doesNotThrow(() => logEvent("t", "d"));
    // in-memory 仍記錄成功
    assert.equal(events.length, 1);
  });

  test("多次呼叫 createEventLog 各自獨立（不共用 buffer）", () => {
    const logPath2 = join(tmp, "events2.jsonl");
    const a = createEventLog(logPath);
    const b = createEventLog(logPath2);
    a.logEvent("x", "in-a");
    assert.equal(a.events.length, 1);
    assert.equal(b.events.length, 0);
  });
});
