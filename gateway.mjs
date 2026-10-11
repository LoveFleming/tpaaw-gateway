#!/usr/bin/env node
/**
 * PAAW Gateway — 使用者機器上的 bootloader（CLI 入口）
 *
 * 用法（在使用者自己的目錄）:
 *   npx paaw-gateway           # 或 npm start —— 檢查更新 → 安裝 → 啟動 PAAW
 *   npx paaw-gateway update    # 只更新不啟動
 *   npx paaw-gateway status    # 看現況
 *
 * 目錄佈局（都長在 process.cwd()，物理隔離）:
 *   ./versions/<x.y.z>/    PAAW code（舊版保留 = 天然 rollback）
 *   ./data/                使用者資料（首次從 data-seed 播種，更新永不覆蓋）
 *   ./current.json         指向「驗證過」的版本（最後才寫）
 *   ./logs/                gateway 自己的 log
 *
 * 更新流程（staged install，偷 OpenClaw 模式）:
 *   GET stable.json → semver 比對 → 下載(串流算 sha256) → 解壓 versions/<v>.tmp
 *   → 驗關鍵檔存在 → rename 定版 → npm install（失敗 retry --omit=optional）
 *   → 播種 data（若無）→ 啟動 → verify GET / 200 → 成功才寫 current.json
 *   任何一步失敗：current.json 不動 → 啟動上一版；壞版本目錄保留現場
 *
 * Env:
 *   PAAW_PACKAGE_URL  package server（優先於 gateway.json）
 *   PAAW_HOME         佈局根目錄（預設 process.cwd()）
 *   PAAW_PORT         PAAW port（預設 4097）
 *   PAAW_WS_PORT      PTY-WS port（預設 4098）
 *   PAAW_AUTO_UPDATE  =1 開啟自動更新（預設關：start 只跑 current，要更新手動跑 npm run update）
 *   PAAW_HOME         佈局根目錄（預設 process.cwd()，也可寫 gateway.json 的 paawHome）
 *   PAAW_SKIP_NPM_I   =1 跳過 npm install（debug 用）
 *   PAAW_GW_PORT      UI 控制台 port（預設 4290）
 *   PAAW_GW_HOST      UI 控制台 bind host（預設 127.0.0.1）
 *
 * 模組化（ADR-003 P3）：本檔已收斂為純 CLI 入口 + 模組接線。
 *   - src/lib/config.mjs   佈局路徑 / gateway.json / logger / semver / current.json（leaf）
 *   - src/lib/install.mjs  下載驗證 / 解壓 / 安裝 / 更新決策（依賴 config）
 *   - src/lib/process.mjs  PAAW 子進程生命週期 / 健康檢查（依賴 config）
 *   - src/lib/semgrep.mjs  semgrep 偵測 / 一鍵安裝（依賴 config；jobLog 以參數注入）
 *   - src/ui/server.mjs    本機控制台 HTTP server（CSRF/Host gate + 靜態 UI + job 執行）
 *   本檔保留：argv 分派 + cmdStatus / cmdStart / cmdUpdate / safeUpdate，以及一處接線
 *   （把 semgrep 偵測到的路徑注入 process 模組，切斷 process ↔ semgrep 循環依賴）。
 *   共享可變狀態（GATEWAY_CFG、佈局路徑、paawChild、job、semgrep 快取）各自收斂到單一
 *   owner 模組，跨模組一律以 getter / setter 存取，不 export 可寫 binding。
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";

import {
  L, AUTO_UPDATE,
  getHome, getVersionsDir, getDataDir,
  semverGt, readCurrent, writeCurrentAtomic, listInstalledVersions,
  loadPackageServerUrl, logFile,
} from "./src/lib/config.mjs";
import {
  updateLogic, installUploadedZip, installDeps, ensureData,
} from "./src/lib/install.mjs";
import {
  startAndVerify, hangAround, setSemgrepDetectedProvider,
} from "./src/lib/process.mjs";
import { getDetectedPath } from "./src/lib/semgrep.mjs";
import { cmdUI } from "./src/ui/server.mjs";

// ── 接線（composition root）：把 semgrep 偵測到的絕對路徑注入 process 模組，
//    讓 startPaaw 在 SEMGREP_PATH 未明確設定時能兜底注入。把此接線放在入口，
//    process.mjs 就不必 import semgrep，維持 config ← semgrep/process ← entry 的單向依賴。 ──
setSemgrepDetectedProvider(() => getDetectedPath());

// ---------- 指令 ----------

async function cmdStatus() {
  const server = await loadPackageServerUrl();
  const current = await readCurrent();
  const installed = await listInstalledVersions();
  let stable = null;
  try {
    stable = (await (await fetch(`${server}/stable.json`, { signal: AbortSignal.timeout(4000) })).json()).version;
  } catch {}
  console.log(`PAAW_HOME       ${getHome()}`);
  console.log(`package server  ${server}`);
  console.log(`current         ${current ? current.version : "（未安裝）"}`);
  console.log(`installed       ${installed.join(", ") || "none"}`);
  console.log(`stable latest   ${stable || "（無法連線）"}`);
  console.log(`data/           ${existsSync(getDataDir()) ? "已存在（更新永不覆蓋）" : "未播種"}`);
  console.log(`auto update     ${AUTO_UPDATE ? "on（PAAW_AUTO_UPDATE=1 或 gateway.json autoUpdate）" : "off（預設；更新手動跑 npm run update）"}`);
  if (current && stable && semverGt(stable, current.version) && !AUTO_UPDATE) {
    console.log(`
  ⬆ 有新版 ${stable} 可用 — npm run update 更新`);
  }
}

async function cmdUpdate() {
  return updateLogic();
}

// 更新失敗（下載/sha/解壓/驗證/npm install）不該讓使用者沒東西可跑 —— fallback current
async function safeUpdate() {
  try {
    return await cmdUpdate();
  } catch (e) {
    const current = await readCurrent();
    if (current && existsSync(join(getVersionsDir(), current.version))) {
      L.warn(`更新失敗（${e.message}）— 照跑現有版本 ${current.version}`);
      return { versionDir: join(getVersionsDir(), current.version), version: current.version, updated: false };
    }
    throw e;
  }
}

async function cmdStart() {
  const current = await readCurrent();

  // 預設行為：有 current 就直接跑（不碰 package server、不檢查更新）
  // 更新永遠手動：npm run update；除非 PAAW_AUTO_UPDATE=1 / gateway.json autoUpdate:true
  let versionDir, version, updated = false;
  if (!current || AUTO_UPDATE) {
    ({ versionDir, version, updated } = await safeUpdate());
  } else {
    version = current.version;
    versionDir = join(getVersionsDir(), version);
    if (!existsSync(versionDir)) {
      L.err(`current 指向 ${version} 但 versions/${version}/ 不存在 — 跑 npm run update 修復`);
      process.exit(1);
    }
    L.info(`自動更新關閉 — 直接跑 current ${version}（要更新：npm run update）`);
  }

  if (!existsSync(versionDir)) {
    L.err(`versions/${version}/ 不存在 — 先跑 update`);
    process.exit(1);
  }

  await ensureData(versionDir);
  await installDeps(versionDir);

  const child = await startAndVerify(versionDir, version);
  if (!child) {
    // 啟動失敗 → 回滾：目標 = current.json 指向的版本（最後一個「驗證過」的），
    // 不是 versions/ 裡最大其他版（那可能是另一個沒驗證過的壞版）
    const current = await readCurrent();
    const prev = current && current.version !== version ? current.version : null;
    if (prev && existsSync(join(getVersionsDir(), prev))) {
      L.warn(`自動回滾 → ${prev}（壞的 ${version} 目錄保留現場）`);
      const child2 = await startAndVerify(join(getVersionsDir(), prev), prev);
      if (child2) {
        await writeCurrentAtomic(prev); // current 維持驗證過的版本
        hangAround(child2);
        return;
      }
    }
    L.err("啟動失敗且無可回滾版本 — 看 logs/paaw 輸出除錯");
    process.exit(1);
  }

  if (updated) await writeCurrentAtomic(version);
  logFile(`started ${version} updated=${updated}`);
  hangAround(child);
}

// ---------- main ----------

const cmd = process.argv[2] || "start";
if (cmd === "status") await cmdStatus();
else if (cmd === "update") {
  await cmdUpdate();
  L.ok("update 完成");
}
else if (cmd === "upload") {
  // 手動上傳 zip 安裝：paaw-gateway upload paaw-1.0.0.zip（不依賴 package server）
  const p = process.argv[3];
  if (!p) { console.error("用法：paaw-gateway upload <paaw-x.y.z.zip>"); process.exit(1); }
  const buf = await readFile(resolve(p));
  await installUploadedZip(buf, basename(p));
  L.ok("upload 完成");
}
else if (cmd === "start") await cmdStart();
else if (cmd === "ui") await cmdUI();
else {
  console.error(`未知指令：${cmd}（可用：ui | start | update | upload | status）`);
  process.exit(1);
}
