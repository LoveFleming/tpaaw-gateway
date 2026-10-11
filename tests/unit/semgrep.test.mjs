/**
 * Unit tests — src/lib/semgrep.mjs
 * TASK-021 / framework: node:test
 *
 * 隔離策略：
 *  - semgrepPresence 是同步純 fs 偵測（statSync），不 spawn — 用 temp HOME/PATH 控制。
 *  - semgrep 由 PAAW_HOME 重載的 config 提供 getCfg（semgrepPath）；測試前設好 env。
 *  - 不測 installSemgrep / checkSemgrep（需真的 spawn semgrep + 網路）— 屬 e2e 範疇。
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 先設好 HOME（semgrepPresence 讀 process.env.HOME）再 import
let tmpHome = mkdtempSync(join(tmpdir(), "gw-semgrep-home-"));
process.env.HOME = tmpHome;
delete process.env.SEMGREP_PATH;

const { semgrepPresence, getDetectedPath, getCheckState } = await import("../../src/lib/semgrep.mjs");

const EXE = process.platform === "win32" ? "semgrep.exe" : "semgrep";

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gw-semgrep-"));
  // 每個案例把 HOME 指到乾淨空目錄、清空 SEMGREP_PATH / PAAW 設定
  process.env.HOME = tmp;
  delete process.env.SEMGREP_PATH;
  delete process.env.PIPX_HOME;
  process.env.PATH = join(tmp, "empty-bin");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeExecutable(path) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n");
  try { chmodSync(path, 0o755); } catch {}
  return path;
}

describe("src/lib/semgrep.mjs — semgrepPresence（未安裝）", () => {
  test("全空環境 → installed:false，path/source 為 null", () => {
    const r = semgrepPresence();
    assert.equal(r.installed, false);
    assert.equal(r.path, null);
    assert.equal(r.source, null);
  });

  test("未安裝時 configured 為 null（無 explicit / env）", () => {
    const r = semgrepPresence();
    assert.equal(r.configured, null);
  });
});

describe("src/lib/semgrep.mjs — semgrepPresence（~/.local/bin 直擊）", () => {
  test("HOME/.local/bin/semgrep 存在 → 偵測到，source 提到 ~/.local/bin", () => {
    makeExecutable(join(tmp, ".local", "bin", EXE));
    const r = semgrepPresence();
    assert.equal(r.installed, true);
    assert.equal(r.path, join(tmp, ".local", "bin", EXE));
    assert.match(r.source, /\.local\/bin/);
  });

  test("偵測成功會更新 SEMGREP_DETECTED（getDetectedPath）", () => {
    const bin = makeExecutable(join(tmp, ".local", "bin", EXE));
    semgrepPresence();
    assert.equal(getDetectedPath(), bin);
  });

  test("pipx venv 落點：HOME/.local/pipx/venvs/semgrep/bin/semgrep", () => {
    const bin = makeExecutable(join(tmp, ".local", "pipx", "venvs", "semgrep", "bin", EXE));
    const r = semgrepPresence();
    assert.equal(r.installed, true);
    assert.equal(r.path, bin);
    assert.match(r.source, /pipx/);
  });

  test("PIPX_HOME 自訂位置 → venv 落點跟著改", () => {
    const px = join(tmp, "custom-pipx");
    process.env.PIPX_HOME = px;
    const bin = makeExecutable(join(px, "venvs", "semgrep", "bin", EXE));
    const r = semgrepPresence();
    assert.equal(r.installed, true);
    assert.equal(r.path, bin);
  });
});

describe("src/lib/semgrep.mjs — semgrepPresence（PATH 掃描）", () => {
  test("PATH 目錄內有 semgrep → 偵測到，source 提到 PATH", () => {
    const bindir = join(tmp, "toolbin");
    const bin = makeExecutable(join(bindir, EXE));
    process.env.PATH = bindir;
    const r = semgrepPresence();
    assert.equal(r.installed, true);
    assert.equal(r.path, bin);
    assert.match(r.source, /PATH/);
  });

  test("PATH 目錄存在但該檔不存在 → 不誤判", () => {
    mkdirSync(join(tmp, "toolbin"), { recursive: true });
    process.env.PATH = join(tmp, "toolbin");
    assert.equal(semgrepPresence().installed, false);
  });
});

describe("src/lib/semgrep.mjs — semgrepPresence（SEMGREP_PATH 環境變數）", () => {
  test("SEMGREP_PATH 指向存在的檔 → 優先命中，source 提到環境變數", () => {
    const bin = makeExecutable(join(tmp, "explicit-semgrep"));
    process.env.SEMGREP_PATH = bin;
    const r = semgrepPresence();
    assert.equal(r.installed, true);
    assert.equal(r.path, bin);
    assert.match(r.source, /環境變數/);
    assert.equal(r.configured, bin);
  });

  test("SEMGREP_PATH 指向不存在的檔 → 回落其他候選（此例無 → false）", () => {
    process.env.SEMGREP_PATH = join(tmp, "does-not-exist");
    const r = semgrepPresence();
    assert.equal(r.installed, false);
    // 但仍記錄 configured（使用者明確設了）
    assert.equal(r.configured, join(tmp, "does-not-exist"));
  });
});

describe("src/lib/semgrep.mjs — getCheckState（初始狀態機）", () => {
  test("初始 status 為 idle，result 為 null", () => {
    const s = getCheckState();
    assert.equal(s.status, "idle");
    assert.equal(s.result, null);
  });
});
