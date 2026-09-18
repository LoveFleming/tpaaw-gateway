# 請長肉這一個 feature（檔案歸屬數學已定，不可更改）。

--- FEATURE SKELETON (machine) ---
{
 "kind": "deterministic",
 "apis": [
  "POST /api/auth/login",
  "GET /api/auth/me",
  "POST /api/backups/create",
  "GET /api/back

**日期**: 2026-09-18
**耗時**: 56s
**結果**: ✅ 成功
**分支**: `main`

## 任務

請長肉這一個 feature（檔案歸屬數學已定，不可更改）。

--- FEATURE SKELETON (machine) ---
{
 "kind": "deterministic",
 "apis": [
  "POST /api/auth/login",
  "GET /api/auth/me",
  "POST /api/backups/create",
  "GET /api/backups",
  "GET /api/dashboard",
  "GET /api/events",
  "GET /api/health",
  "POST /api/server/restart",
  "POST /api/server/start",
  "POST /api/server/stop",
  "POST /api/upgrade",
  "GET /api/users",
  "GET /api/version"
 ],
 "entryCount": 13,
 "fileCount": 1,
 "FILE_LIST": [
  "src/server.mjs"
 ],
 "TESTS": [
  "tests/e2e/gateway-backup-auth.test.mjs"
 ],
 "note": "TESTS 是此 feature 的測試檔（機器映射）— 讀它們幫助寫 bizLogic，但它們不是 feature 的 code 檔",
 "SHARED_LAYER": []
}

用 read_file 實際讀程式碼（至少進入點檔 + 1-3 個核心檔），最後一輪輸出 JSON（name/description/bizLogic/tags）。

## AI 操作步驟

2× read_file

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
?? .paaw/features/parts/
?? .paaw/release-requests/RR-20260918-1242-bd43.json
?? .paaw/sessions/2026-09-18-feature-feature-skeleton-machine-kind-deterministic-apis-get.md
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

我已完整讀完進入點 `src/server.mjs`（此 feature 唯一 code 檔，含全部 13 個 API 路由、進程管理器、備份/升級管理器、認證中間層）與測試檔 `tests/e2e/gateway-backup-auth.test.mjs`（鎖定 auth 契約、備份落地行為與 session 過期）。證據充分，直接輸出結論。

```json
{
  "name": "PAAW Gateway 系統維運管理平台（認證・進程守護・備份・升級）",
  "description": "獨立於 PAAW Server（:4097）運行的管理平台（:4199），由單一檔案 src/server.mjs 構成：以 node:http 原生路由提供 13 個 /api/* 端點，涵蓋登入認證、PAAW Server 進程 start/stop/restart、tar.gz 備份建立與還原、git pull 升級、健康監控 dashboard、事件 audit log 與用戶列表，並在 / 提供管理 UI（public/index.html）。Gateway 不依賴 PAAW Server 運行 — 它是守護者，可管理對方生命週期。",
  "bizLogic": "認證：POST /api/auth/login 以 body 的 userId+password 對 config.json 的 users（含 passwordHash 欄位）比對，成功核發 randomUUID session token（in-memory Map，預設 sessionMaxAge 24h 過期即刪），其餘路由一律要求 Authorization: Bearer <token>（缺前綴視同未授權回 401），僅 /api/auth/login、/api/health、/ 及靜態資產為 public；upgrade 與 server start/stop/restart、/api/users 另要求 role=admin 否則 403。進程守護：startPaaw 以 config.paawServerCmd 在 PAAW_ROOT spawn 子進程（PORT env 指向 paawServerPort），追蹤狀態機 stopped/starting/running/crashed 與 restartCount，stop 先 SIGTERM、5 秒後 SIGKILL，gateway 啟動時 autoStartPaaw!==false 會自動拉起 PAAW。備份：createBackup 用 tar czf 打包 PAAW_ROOT 下 data/ 與 .paaw/ 成 paaw-backup-YYYY-MM-DD-HH.tar.gz 寫入 backupDir，超過 maxBackups（預設 7）刪最舊；restoreBackup 以 BACKUP_REGEX 白名單驗譑檔名（防路徑穿越）後，先停服務、自動建一份安全備份、tar xzf 解回、再重啟。升級：upgradePaaw 依序 git stash → git pull → git stash pop → npm install --production → 重啟 → 3 秒後打 PAAW 的 /api/health 驗證，逐步回報 steps；版本資訊取自 PAAW_ROOT/package.json 與 git（branch/commit/dirty/behind/最新 tag）。所有操作經 logEvent 寫入 events.jsonl 與記憶體（保留 500 筆），供 /api/events 與 dashboard 審計。關鍵資料形態：config（users[]、paawServerCmd、backupDir、sessionMaxAge）、event entry {id,ts,type,detail,userId}、backup entry {filename,date,sizeMB,created}；測試隔離靠 PAAW_CONFIG/PAAW_ROOT/PAAW_BACKUP_DIR/PAAW_EVENT_LOG/PAAW_MAX_BACKUPS 環境 knob，檔案有 main guard（被 import 不 listen 不 spawn）。",
  "tags": ["gateway", "auth", "session", "bearer-token", "rbac", "process-management", "daemon", "backup", "restore", "upgrade", "health-check", "dashboard", "

... (truncated)
