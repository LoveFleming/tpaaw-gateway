# 請長肉這一個 feature（檔案歸屬數學已定，不可更改）。

--- FEATURE SKELETON (machine) ---
{
 "kind": "deterministic",
 "apis": [
  "GET /api/log",
  "GET /api/paaw-log",
  "POST /api/restart",
  "GET /api/settings",
  "POST

**日期**: 2026-09-18
**耗時**: 67s
**結果**: ✅ 成功
**分支**: `main`

## 任務

請長肉這一個 feature（檔案歸屬數學已定，不可更改）。

--- FEATURE SKELETON (machine) ---
{
 "kind": "deterministic",
 "apis": [
  "GET /api/log",
  "GET /api/paaw-log",
  "POST /api/restart",
  "GET /api/settings",
  "POST /api/settings",
  "POST /api/start",
  "GET /api/status",
  "POST /api/stop",
  "POST /api/update",
  "POST /api/upload",
  "GET /index.html"
 ],
 "entryCount": 11,
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
M .paaw/HANDOVER.md
 M .paaw/agents/coding.rm.json
 M .paaw/changelog/CHANGELOG.md
 M .paaw/changes/change-intelligence.json
 M .paaw/code-intelligence/api-function-map.json
 M .paaw/code-intelligence/call-graph.json
 M .paaw/code-intelligence/dependency-graph.json
 M .paaw/code-intelligence/file-map.json
 M .paaw/code-intelligence/summary.json
 M .paaw/code-intelligence/symbol-index.json
 M .paaw/code-intelligence/test-code-map.json
 M .paaw/code-intelligence/test-intelligence.json
 M .paaw/coding-memory/actions.jsonl
 M .paaw/coding-memory/conversations/coding.developer/active.json
 M .paaw/coding-memory/conversations/coding.em/active.json
 M .paaw/coding-memory/conversations/coding.tester/active.json
 M .paaw/coding-memory/dispatch-log.jsonl
 M .paaw/cu-status.json
 M .paaw/features/FEATURES.json
 D .paaw/features/backups/FEATURES-1788775413096.json
 D .paaw/features/backups/FEATURES-1788786779558.json
 M .paaw/handover-state.json
 M .paaw/release-requests/RR-20260918-1237-1d49.json
 M .paaw/release-unit-model.json
 M .paaw/scan.json
 M .paaw/security/scan-results.json
 M .paaw/tasks/TASKS.json
 M .paaw/test-runs/last.json
 M .paaw/verify-last.json
MM gateway.mjs
 M package.json
 M ui/index.html
?? .paaw/coding-memory/conversations/coding.em/s-2026-09-18T08-36-10.json
?? .paaw/coding-memory/dispatch-outputs/
?? .paaw/features/backups/FEATURES-1789728003670.json
?? .paaw/features/backups/FEATURES-1789728003675.json
?? .paaw/features/backups/FEATURES-1789728644590.json
?? .paaw/features/backups/FEATURES-1789729078050.json
?? .paaw/features/backups/FEATURES-1789729693243.json
?? .paaw/release-requests/RR-20260918-1242-bd43.json
?? .paaw/sessions/2026-09-18-gatewaymjs-f7-csrf-task-002-task-002-f1f10-f7-csrf-em-f1f10-.md
?? .paaw/sessions/2026-09-18-task-001rr-20260918-1242-release-code-review-gatewaymjsrelea.md
?? .paaw/sessions/2026-09-18-task-003release-rr-20260918-1242-1f7-csrf-gatewaymjs-cmdui-p.md
?? .paaw/sessions/2026-09-18-task-004-gatewaymjs-rr-20260918-1242-risk-gate-failhighapi-f.md
?? .paaw/sessions/2026-09-18-task-005-developer-4-gatewaymjs-uiindexhtml-working-tree-rea.md
?? .paaw/sessions/2026-09-18-task-005-gatewaymjs-qa-findingsrelease-rr-20260918-1242-read.md
?? .paaw/staged-changes.json
?? .paaw/test-runs/runs/RUN-20260918-004.json
?? .paaw/tmp/
?? tests/e2e/gateway-ui-csrf.test.mjs
```

### Diff Stat
```
.paaw/HANDOVER.md                                  |   39 +-
 .paaw/agents/coding.rm.json                        |    7 +-
 .paaw/changelog/CHANGELOG.md                       |   38 +
 .paaw/changes/change-intelligence.json             | 2213 +++++++++++++++++++-
 .paaw/code-intelligence/api-function-map.json      |   56 +-
 .paaw/code-intelligence/call-graph.json            |  217 +-
 .paaw/code-intelligence/dependency-graph.json      |   66 +-
 .paaw/code-intelligence/file-map.json              |  182 +-
 .paaw/code-intelligence/summary.json               |   32 +-
 .paaw/code-intelligence/symbol-index.json          |  294 ++-
 .paaw/code-intelligence/test-code-map.json         |    2 +-
 .paaw/code-intelligence/test-intelligence.json     |   34 +-
 .paaw/coding-memory/actions.jsonl                  |    6 +
 .../conversations/coding.developer/active.json     |    2 +-
 .../conversations/coding.em/active.json            |   67 +-
 .../conversations/coding.tester/active.json        |    2 +-
 .paaw/coding-memory/dispatch-log.jsonl             |  141 ++
 .paaw/cu-status.json                               |   24 +-
 .paaw/features/FEATURES.json                       |    8 +-
 .paaw/features/backups/FEATURES-1788775413096.json |  195 --
 .paaw/features/backups/FEATURES-1788786779558.json |  195 --
 .paaw/handover-state.json                          |   72 +-
 .paaw/release-requests/RR-20260918-1237-1d49.json  |  279 ++-
 .paaw/release-unit-model.json                      |   98 +-
 .paaw/scan.json                                    |  152 +-
 .paaw/security/scan-results.json                   |    2 +-
 .paaw/tasks/TASKS.json                             |   97 +-
 .paaw/test-runs/last.json                          |   12 +-
 .paaw/verify-last.json                             |    8 +-
 gateway.mjs                                        |   42 +-
 package.json                                       |    2 +-
 ui/index.html                                      |   10 +-
 32 files changed, 3867 insertions(+), 727 deletions(-)
 gateway.mjs | 32 ++++++++++++++++++++++++++++++++
 1 file changed, 32 insertions(+)
```

## AI 回覆

我已完整讀取 `gateway.mjs`（此 feature 唯一檔案，包含 CLI 與 UI console 兩種模式、staged install 流程、進程守護與全部 11 個 API handler）。證據充分，以下輸出長肉結果：

```json
{
  "name": "PAAW Gateway 控制台：套包安裝更新與 PAAW 生命週期管理",
  "description": "使用者機器上的單檔 bootloader（gateway.mjs），同時提供 CLI（start/update/upload/status/ui）與本機網頁控制台（GET /index.html + 10 個 /api/* endpoint），負責 PAAW 套包的安裝、更新、手動上傳，以及 PAAW 進程的啟動/停止/重啟與狀態/日誌監看。目錄佈局以 versions/<x.y.z>/ 做版本隔離、data/ 存使用者資料、current.json 指向最後驗證過的版本。",
  "bizLogic": "更新走 staged install：fetch package server 的 stable.json → semver 比對（永不降級，除非手動）→ 串流下載邊算 sha256 → 解壓到 versions/<v>.tmp（含 zip-slip 防護與關鍵檔骨架驗證）→ rename 定版 → npm install（失敗 retry --omit=optional）→ data-seed 播種（僅首次，更新永不覆蓄 data/）→ 啟動並健康檢查（GET / 200）成功才寫 current.json；任何一步失敗 current.json 不動、自動回滾跑上一版，壞版本目錄保留現場。除遠端更新外也支援手動上傳 zip（POST /api/upload 或 CLI upload），版本取自 zip 內建 paaw-manifest.json 或檔名 paaw-x.y.z.zip，不依賴 package server。安全規則：manifest.version 必須符合 /^\\d+\\.\\d+\\.\\d+$/（fail-closed 擋路徑注入，MAJ-001）、下載 URL 以提供 stable.json 的同一 server 組同源位址、UI 請求做 Host 白名單（127.0.0.1/localhost/::1 + 監聽 host）全攔 DNS rebinding、POST 另驗 Origin 防 CSRF（F7/MED-001）、settings body 上限 1MB、upload 上限 600MB。進程守護：spawn 前先探 port 佔用（防被別人的 200 騙過健康檢查）、健康檢查 90 秒逾時 + 2.5 秒穩定窗口、停止走 SIGTERM→5 秒後 SIGKILL 升級；UI 端以單一 job mutex 序化 update/upload/start/stop/restart（忙時回 409），POST 操作回 202 非同步執行、進度由 GET /api/log 輪詢。設定（packageServer、paawHome）存 gateway.json，env（PAAW_PACKAGE_URL/PAAW_HOME）優先且鎖死 UI 修改；PAAW 的 log 透過 PAAW_LOG_HOME=data/log 跨版本持久，GET /api/paaw-log 以 offset 輪詢讀取；自動更新預設關閉，start 只跑 current 版本。",
  "tags": ["bootloader", "staged-install", "version-management", "auto-rollback", "process-supervisor", "update", "local-console", "sha256-verify", "csrf-protection", "npm-lifecycle"]
}
```
