/**
 * PAAW Gateway — Install module
 *
 * Owns everything about acquiring and laying down a PAAW version: streaming
 * download + sha256 verification, zip-slip-safe extraction, skeleton
 * validation, staged install (extract → verify → rename → npm install),
 * the manual-upload path, and the update decision logic (semver compare).
 *
 * Dependency direction: depends on config.mjs (paths, logger, semverGt,
 * VERSION_RE, current.json helpers) only. It must NOT import process.mjs —
 * the entry wires the two together.
 *
 * Layout paths are read through config's getters (not captured as module-load
 * snapshots): applyHome() recomputes them when the user changes paawHome in the
 * UI, so every access must observe the current value.
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import { unzipSync, strFromU8 } from "fflate";

import {
  VERSION_RE, L,
  getHome, getVersionsDir, getDataDir, getLogsDir,
  semverGt, loadPackageServerUrl, readCurrent, writeCurrentAtomic,
} from "./config.mjs";

// ---------- 下載（串流 + 邊算 sha256）----------

export async function downloadVerified(url, sha256Expected, destPath, sizeExpected) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下載失敗 HTTP ${res.status}`);
  const hash = createHash("sha256");
  const out = createWriteStream(destPath);
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    hash.update(value);
    if (!out.write(Buffer.from(value))) {
      await new Promise((r) => out.once("drain", r));
    }
  }
  await new Promise((r) => out.end(r));
  const sha256 = hash.digest("hex");
  if (sha256 !== sha256Expected) throw new Error(`sha256 不符（下載=${sha256.slice(0, 16)}… manifest=${sha256Expected.slice(0, 16)}…）— 套包損毀或被竄改，拒絕安裝`);
  if (sizeExpected && size !== sizeExpected) throw new Error(`size 不符（${size} != ${sizeExpected}）`);
  return { sha256, size };
}

// ---------- 解壓（zip-slip 防護）----------

export async function extractZip(zipPath, destDir) {
  const buf = await readFile(zipPath);
  const entries = unzipSync(new Uint8Array(buf));
  await mkdir(destDir, { recursive: true });
  const destRoot = resolve(destDir) + sep;
  for (const [name, data] of Object.entries(entries)) {
    // Windows 打包工具可能寫入反斜線 entry name — 統一轉 / 再解析（跨平台一致，zip-slip 檢查也在正規化後做）
    const safeName = name.replace(/\\/g, "/");
    const target = resolve(destDir, safeName);
    if (!target.startsWith(destRoot)) throw new Error(`zip-slip 偵測：${safeName}`);
    if (safeName.endsWith("/")) {
      await mkdir(target, { recursive: true });
    } else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    }
  }
}

// 關鍵檔存在性驗證（缺了 = 壞包，abort）
export async function verifySkeleton(dir) {
  const REQUIRED = [
    "packages/server/src/paaw-server.mjs",
    "packages/ui/dist/index.html",
    "package.json",
    "data-seed",
  ];
  for (const rel of REQUIRED) {
    if (!existsSync(join(dir, rel))) throw new Error(`壞包：缺 ${rel}（abort，不切版）`);
  }
}

// ---------- npm install（失敗 retry --omit=optional，偷 OpenClaw）----------

function run(cmd, args, cwd) {
  return new Promise((resolvePromise) => {
    // Windows：Node 2024 安全 patch 後 shell:false 直接 spawn .cmd/.bat 會 EINVAL。
    // 走 cmd.exe /c（不用 shell:true，避 DEP0190 帶 args 的 deprecation）。
    let bin = cmd;
    let finalArgs = args;
    if (process.platform === "win32" && cmd === "npm") {
      bin = "cmd.exe";
      finalArgs = ["/d", "/s", "/c", "npm", ...args];
    }
    const child = spawn(bin, finalArgs, { cwd, stdio: "inherit" });
    child.on("exit", (code) => resolvePromise(code ?? 1));
    child.on("error", () => resolvePromise(1));
  });
}

export async function installDeps(versionDir) {
  if (process.env.PAAW_SKIP_NPM_I === "1") return true;
  if (existsSync(join(versionDir, "node_modules"))) return true; // 已裝
  L.info("npm install --omit=dev …（首次需 1-3 分鐘）");
  let code = await run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], versionDir);
  if (code !== 0) {
    L.warn("npm install 失敗，retry（--omit=optional）…");
    code = await run("npm", ["install", "--omit=dev", "--omit=optional", "--no-audit", "--no-fund"], versionDir);
  }
  if (code !== 0) throw new Error("npm install 兩次都失敗");
  return true;
}

// ---------- data 播種（只在沒有 data/ 時；更新永不覆蓋）----------

export async function ensureData(versionDir) {
  if (existsSync(getDataDir())) return false;
  L.info("首次安裝：data-seed 播種 → data/ …");
  await cp(join(versionDir, "data-seed"), getDataDir(), { recursive: true });
  return true;
}

// ---------- 安裝一個版本（staged）----------

// 共用尾段：解壓 tmp → 驗骨架 → rename 定版 → npm install（下載流程與手動上傳共用）
export async function stageInstall(zipPath, v) {
  const versionDir = join(getVersionsDir(), v);
  const tmpDir = join(getVersionsDir(), `${v}.tmp`);
  L.info(`解壓 → versions/${v}.tmp …`);
  await rm(tmpDir, { recursive: true, force: true });
  await extractZip(zipPath, tmpDir);
  await verifySkeleton(tmpDir);

  await rm(versionDir, { recursive: true, force: true });
  await rename(tmpDir, versionDir);
  L.ok(`versions/${v}/ 定版 → ${versionDir}`);

  await installDeps(versionDir);
  await rm(zipPath, { force: true });
  return versionDir;
}

export async function installVersion(manifest, server) {
  // MAJ-001（2026-09-18）：manifest.version 來自遠端 stable.json，是不可信輸入 —
  // 在任何路徑拼接（zipPath、stageInstall 的 versions/<v>）與 dlUrl 組合之前，
  // 先用 VERSION_RE 做 fail-closed 驗證（擋 "../"、query、fragment 等注入）。
  const v = manifest.version;
  if (typeof v !== "string" || !VERSION_RE.test(v)) {
    throw new Error(`invalid version from manifest: ${JSON.stringify(v)}`);
  }
  const zipPath = join(getHome(), "logs", `paaw-${v}.zip`);

  // 下載 URL：優先用「剛 fetch stable.json 成功的同一台 server」組（同源保證，
  // 不受 manifest.url 缺失/寫死舊位址影響）；manifest.url 只當無 server 時的 fallback
  const dlUrl = server
    ? `${server}/packages/${v}/paaw.zip`
    : (manifest.url && /^https?:\/\//.test(manifest.url) ? manifest.url : null);
  if (!dlUrl) throw new Error("無法決定下載 URL（manifest 無 url 且未傳 server）");

  L.info(`下載 ${dlUrl} …`);
  await mkdir(getLogsDir(), { recursive: true });
  const { size } = await downloadVerified(dlUrl, manifest.sha256, zipPath, manifest.size);
  L.ok(`sha256 驗證通過（${(size / 1048576).toFixed(1)} MB）`);

  return await stageInstall(zipPath, v);
}

// ---------- 手動上傳 zip 安裝（2026-09-07 Fleming：不依賴 paaw-package 也能裝）----------

// 讀 zip 內建的 paaw-manifest.json（只解這一個 entry，不用全解）
export function readZipManifest(buf) {
  try {
    const entries = unzipSync(new Uint8Array(buf), { filter: (f) => f.name === "paaw-manifest.json" });
    const e = entries["paaw-manifest.json"];
    return e ? JSON.parse(strFromU8(e)) : null;
  } catch {
    return null;
  }
}

export async function installUploadedZip(zipBuf, label) {
  const sha256 = createHash("sha256").update(zipBuf).digest("hex");
  L.info(`收到上傳包 ${label}（${(zipBuf.length / 1048576).toFixed(1)} MB，sha256=${sha256.slice(0, 16)}…）`);

  // 版本來源：zip 內 paaw-manifest.json 優先；没帶就從檔名 paaw-x.y.z.zip 兄弟拿
  const m = readZipManifest(zipBuf);
  let v = m && typeof m.version === "string" && VERSION_RE.test(m.version) ? m.version : null;
  if (!v) {
    const base = String(label || "").replace(/^.*[\\/]/, "");
    const fm = base.match(/^paaw-(\d+\.\d+\.\d+)\.zip$/i);
    if (fm) v = fm[1];
  }
  if (!v) throw new Error("zip 內無 paaw-manifest.json、檔名也不符 paaw-x.y.z.zip — 無法判斷版本（拒裝）");
  if (m && m.product && m.product !== "paaw") throw new Error(`paaw-manifest.json product=${m.product} 不是 paaw 包`);

  await mkdir(getLogsDir(), { recursive: true });
  const zipPath = join(getHome(), "logs", `paaw-${v}.upload.zip`);
  await writeFile(zipPath, zipBuf);

  const versionDir = await stageInstall(zipPath, v);
  await writeCurrentAtomic(v);
  L.ok(`手動安裝完成：${versionDir} 已定版並切 current（重啟後生效）`);
  L.info(`PAAW_HOME = ${getHome()}（找套件/資料都從這裡看）`);
  return { ok: true, version: v, versionDir, message: `已上傳安裝 ${v} → ${versionDir}（按「重啟」生效）` };
}

// ---------- 更新決策（CLI 與 UI 共用；失敗 throw，不 process.exit）----------

export async function updateLogic() {
  const server = await loadPackageServerUrl();
  const current = await readCurrent();

  let manifest;
  try {
    const res = await fetch(`${server}/stable.json`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (e) {
    if (current) {
      L.warn(`package server 連不上（${e.message}）— 照跑現有版本 ${current.version}`);
      return { versionDir: join(getVersionsDir(), current.version), version: current.version, updated: false, note: `package server 連不上，照跑 ${current.version}` };
    }
    throw new Error(`package server 連不上且本機無任何版本 — 無法安裝（${e.message}）`);
  }

  // MAJ-001（2026-09-18）：manifest.version 是遠端不可信輸入 — 必須在 semverGt /
  // writeCurrentAtomic / installVersion 之前 fail-closed 驗證（semverGt 在首個差異段
  // 即 return，"999.0.0/../../x" 首段 999>N 會通過 newer 判斷，故不能依賴它擋）
  if (typeof manifest.version !== "string" || !VERSION_RE.test(manifest.version)) {
    throw new Error(`invalid version from manifest: ${JSON.stringify(manifest.version)}`);
  }

  const haveVersion = current && current.version === manifest.version;
  const newer = !current || semverGt(manifest.version, current.version);

  if (haveVersion) {
    L.info(`已是最新版 ${current.version}`);
    return { versionDir: join(getVersionsDir(), current.version), version: current.version, updated: false, note: `已是最新版 ${current.version}` };
  }
  if (!newer) {
    L.warn(`stable ${manifest.version} 不比 current ${current?.version || "none"} 新 — 不降級（要指定版請手動）`);
    return { versionDir: join(getVersionsDir(), current.version), version: current.version, updated: false, note: `stable ${manifest.version} 不比 current 新，不降級` };
  }

  L.info(`發現新版 ${manifest.version}${current ? `（current ${current.version}）` : "（首次安裝）"}`);
  const versionDir = await installVersion(manifest, server);
  // 安裝成功即切 current（staged 已驗 sha+骨架+npm install；
  // 若之後 start 啟動失敗，回滾分支會把 current 寫回舊版 — 鏈條仍閉合）
  await writeCurrentAtomic(manifest.version);
  return { versionDir, version: manifest.version, updated: true, note: `已安裝並切到 ${manifest.version}` };
}
