/**
 * Unit tests — src/lib/semgrep.mjs
 * TASK-021 / framework: node:test
 *
 * 隔離策略：
 *  - semgrepPresence 是同步純 fs 偵測（statSync），不 spawn — 用 temp HOME/PATH 控制。
 *  - semgrep 由 PAAW_HOME 重載的 config 提供 getCfg（semgrepPath）；測試前設好 env。
 *  - 不測 installSemgrep / checkSemgrep（需真的 spawn semgrep + 網路）— 屬 e2e 範疇。
 */

import { test, describe, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// ── Env 快照 / 還原（測試衛生）─────────────────────────────────────────────
// 這些測試會覆寫 process.env 的 HOME / PATH / SEMGREP_PATH / PIPX_HOME，並在
// module top-level 就動 HOME 與 SEMGREP_PATH。若跑在共用 process（--test 或自訂
// runner），不還原會污染同 process 的其他測試檔。故在動任何 env 之前先記下原值，
// 全套跑完（after）還原；_setEnv 記錄「原本不存在」的情形，還原時用 delete。
//
// 被覆寫的 env 白名單（after 一律還原）：
const MANAGED_ENV = ["HOME", "PATH", "SEMGREP_PATH", "PIPX_HOME", "PAAW_PACKAGE_URL"];
const _envSnapshot = new Map();
for (const k of MANAGED_ENV) {
  _envSnapshot.set(k, Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined);
}
function restoreManagedEnv() {
  for (const [k, original] of _envSnapshot) {
    if (original === undefined) delete process.env[k];
    else process.env[k] = original;
  }
}

// 先設好 HOME（semgrepPresence 讀 process.env.HOME）再 import
let tmpHome = mkdtempSync(join(tmpdir(), "gw-semgrep-home-"));
process.env.HOME = tmpHome;
delete process.env.SEMGREP_PATH;

const { semgrepPresence, getDetectedPath, getCheckState } = await import("../../src/lib/semgrep.mjs");

const EXE = process.platform === "win32" ? "semgrep.exe" : "semgrep";

// PATH 覆寫時至少保留系統可執行路徑，否則同 process 內後續 execFile/spawn（如 node）
// 會找不到執行檔。POSIX 用 /usr/bin:/bin；Windows 用 SystemRoot\System32。
const SYSTEM_PATH = process.platform === "win32"
  ? join(process.env.SystemRoot || "C:\\Windows", "System32")
  : ["/usr/bin", "/bin"].join(delimiter);
function emptyPathUnder(dir) {
  return join(dir, "empty-bin") + delimiter + SYSTEM_PATH;
}

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gw-semgrep-"));
  // 每個案例把 HOME 指到乾淨空目錄、清空 SEMGREP_PATH / PAAW 設定
  process.env.HOME = tmp;
  delete process.env.SEMGREP_PATH;
  delete process.env.PIPX_HOME;
  delete process.env.PAAW_PACKAGE_URL;
  process.env.PATH = emptyPathUnder(tmp);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// 全套跑完：清掉 top-level tmpHome、還原所有被覆寫的 env，並自我驗證已還原。
after(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  restoreManagedEnv();
  for (const k of MANAGED_ENV) {
    const original = _envSnapshot.get(k);
    if (original === undefined) assert.equal(Object.prototype.hasOwnProperty.call(process.env, k), false, `${k} 應還原為不存在`);
    else assert.equal(process.env[k], original, `${k} 應還原為原值`);
  }
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
    // 隔離到 toolbin，但保留系統路徑以免同 process 的 subprocess 找不到 node
    process.env.PATH = bindir + delimiter + SYSTEM_PATH;
    const r = semgrepPresence();
    assert.equal(r.installed, true);
    assert.equal(r.path, bin);
    assert.match(r.source, /PATH/);
  });

  test("PATH 目錄存在但該檔不存在 → 不誤判", () => {
    mkdirSync(join(tmp, "toolbin"), { recursive: true });
    process.env.PATH = join(tmp, "toolbin") + delimiter + SYSTEM_PATH;
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

// ── review board minor#1（RR-20261018-1738-6f2e）──
// 落點候選（~/.local/bin、pipx venv）與 PATH 自動偵測都必須使用平台對應的
// 執行檔名（Windows 為 semgrep.exe）。以 platform stub 驗證不依賴當下平台。
describe("src/lib/semgrep.mjs — 執行檔名（跨平台）", () => {
  let realPlatform;

  function withPlatform(name, fn) {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: name, configurable: true });
    try {
      return fn();
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  }

  beforeEach(() => {
    realPlatform = process.platform;
    process.env.HOME = tmp;
    delete process.env.SEMGREP_PATH;
    delete process.env.PIPX_HOME;
    process.env.PATH = emptyPathUnder(tmp);
  });

  afterEach(() => {
    assert.equal(process.platform, realPlatform, "platform stub 必須被還原");
  });

  test("win32：~/.local/bin/semgrep.exe 會被直擊命中（不是寫死 semgrep）", () => {
    withPlatform("win32", () => {
      const bin = makeExecutable(join(tmp, ".local", "bin", "semgrep.exe"));
      const r = semgrepPresence();
      assert.equal(r.installed, true, `win32 必須命中 semgrep.exe（path=${r.path}）`);
      assert.equal(r.path, bin);
      assert.match(r.source, /~\/\.local\/bin/);
    });
  });

  test("win32：pipx venv 落點同樣使用 semgrep.exe", () => {
    withPlatform("win32", () => {
      const bin = makeExecutable(join(tmp, ".local", "pipx", "venvs", "semgrep", "bin", "semgrep.exe"));
      const r = semgrepPresence();
      assert.equal(r.installed, true);
      assert.equal(r.path, bin);
    });
  });

  test("win32：PATH 目錄內只有 semgrep.exe 時也能偵測到", () => {
    withPlatform("win32", () => {
      const bindir = join(tmp, "winbin");
      const bin = makeExecutable(join(bindir, "semgrep.exe"));
      process.env.PATH = bindir + delimiter + SYSTEM_PATH;
      const r = semgrepPresence();
      assert.equal(r.installed, true);
      assert.equal(r.path, bin);
      assert.match(r.source, /PATH/);
    });
  });

  test("posix：仍使用無副檔名的 semgrep（不回歸）", () => {
    withPlatform("linux", () => {
      const bin = makeExecutable(join(tmp, ".local", "bin", "semgrep"));
      // 同時放一個 .exe 假檔，證明 posix 不會誤命中它
      makeExecutable(join(tmp, ".local", "bin", "semgrep.exe"));
      const r = semgrepPresence();
      assert.equal(r.installed, true);
      assert.equal(r.path, bin, "posix 必須命中 semgrep 而非 semgrep.exe");
    });
  });
});
