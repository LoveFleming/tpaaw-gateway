# 請長肉這一個 feature（檔案歸屬數學已定，不可更改）。

--- FEATURE SKELETON (machine) ---
{
 "kind": "deterministic",
 "apis": [
  "GET /api/log",
  "POST /api/restart",
  "GET /api/settings",
  "POST /api/settings",
  "POS

**日期**: 2026-09-06
**耗時**: 48s
**結果**: ✅ 成功
**分支**: `main`

## 任務

請長肉這一個 feature（檔案歸屬數學已定，不可更改）。

--- FEATURE SKELETON (machine) ---
{
 "kind": "deterministic",
 "apis": [
  "GET /api/log",
  "POST /api/restart",
  "GET /api/settings",
  "POST /api/settings",
  "POST /api/start",
  "GET /api/status",
  "POST /api/stop",
  "POST /api/update",
  "GET /index.html"
 ],
 "entryCount": 9,
 "fileCount": 1,
 "FILE_LIST": [
  "gateway.mjs"
 ],
 "SHARED_LAYER": []
}

用 read_file 實際讀程式碼（至少進入點檔 + 1-3 個核心檔），最後一輪輸出 JSON（name/description/bizLogic/tags）。

## AI 操作步驟

1× read_file

## Git 變更分析

### Status
```
M  README.md
A  docs/api.md
```

### Diff Stat
```
README.md   |  87 ++++++++++++++++++++
 docs/api.md | 270 ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
 2 files changed, 357 insertions(+)
```

## AI 回覆

我已完整讀取 `gateway.mjs`（FILE_LIST 唯一檔案，SHARED_LAYER 為空，無其他檔案需讀）。9 個 API 進入點全部對應到 `cmdUI()` 內的 HTTP server（port 4290），與檔案內容完全吻合，證據充分，輸出結果：

```json
{
  "name": "PAAW Gateway 控制台：安裝更新與 PAAW 生命週期管理",
  "description": "單檔 gateway.mjs 同時承擔兩種角色：CLI（start / update / status）與本地管理儀表板（ui，HTTP server 綁 127.0.0.1:4290，即 skeleton 中的 9 個 API）。管 PAAW 在使用者機器上的完整生命週期 — 套包下載安裝、版本切換、data 播種、PAAW 子程序的啟動/停止/重啟，以及 gateway 自身設定（package server、paawHome）的讀寫。UI 模式下 PAAW 以 child process 受 gateway 監管，gateway 退出會一併帶走 PAAW。",
  "bizLogic": "更新走 staged install：GET {server}/stable.json → semver 比對（只升級不降級）→ 串流下載 zip 邊算 sha256（不符即拒裝，防竄改/損毀）→ 解壓含 zip-slip 防護 → 驗證關鍵檔骨架（packages/server/src/paaw-server.mjs、packages/ui/dist/index.html、package.json、data-seed）→ rename 定版到 versions/<x.y.z>/ → npm install（失敗 retry --omit=optional）。使用者資料隔離：data/ 只在首次安裝從 data-seed 播種，之後任何更新永不覆蓋。current.json 是版本唯一真實來源（tmp+rename 原子寫入），指向最後驗證過的版本；啟動以 GET / 200（90 秒逾時）為健康判準，啟動失敗自動回滾到 current 指向的舊版且壞版目錄保留現場。UI 的操作走單一 job 互斥模型：同一時間只允許一個 update/start/stop/restart job，執行中再打 API 回 409；job log 為 200 行 ring buffer，GET /api/log 取回。設定優先序固定為 env（PAAW_PACKAGE_URL / PAAW_HOME）> gateway.json > 預設值，env 存在時 UI 的改動會被列入 ignored；改 paawHome 必須先停 PAAW 且限絕對路徑，改完即時 applyHome() 重算佈局、原子寫回 gateway.json。自動更新預設關閉（PAAW_AUTO_UPDATE=1 或 gateway.json autoUpdate:true 才開）：start 預設只跑 current 不碰 package server，更新一律手動觸發。",
  "tags": ["bootloader", "staged-install", "auto-update", "version-management", "process-supervisor", "local-dashboard", "rollback", "atomic-config"]
}
```
