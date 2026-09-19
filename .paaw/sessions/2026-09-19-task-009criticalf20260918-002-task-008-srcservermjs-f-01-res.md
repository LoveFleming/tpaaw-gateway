# TASK-009（critical，F20260918-002）：驗證 TASK-008 的 src/server.mjs 修復（F-01 restart race blocker + F-02 備份端點 admin check）。修改已在 working tree、未 commit。

流程：先 read_file src/server.mjs（重點 stopPaaw/restartPaaw/u

**日期**: 2026-09-19
**耗時**: 954s
**結果**: ✅ 成功
**分支**: `main`

## 任務

TASK-009（critical，F20260918-002）：驗證 TASK-008 的 src/server.mjs 修復（F-01 restart race blocker + F-02 備份端點 admin check）。修改已在 working tree、未 commit。

流程：先 read_file src/server.mjs（重點 stopPaaw/restartPaaw/upgradePaaw/restoreBackup 與路由段）和 tests/e2e/gateway-backup-auth.test.mjs 現況，再補測試。

新增測試案例（QA review 建議）：
1. restart 快速退出案：child process 收 SIGTERM 立即 exit → /api/server/restart 回 ok:true 且新 process 起來
2. restart 拒絕退出案：child 忽視 SIGTERM → stopPaaw 走到 failsafe → restart 回 ok:false（不謊報 ok:true）
3. F-02：viewer token 呼叫 POST /api/backups/create → 403；POST /api/backups/restore/&lt;file&gt; → 403；admin token → 不被 403
4. /api/server/stop：回應只在 exit 事件確認後送達（時序斷言）

完成後跑全套 npm test（原 42 案含 gateway.mjs 系列 + 新案例），全部要綠、無回歸。

明確禁令（你上輪因此記點）：絕對禁止 git commit / git push / git add — 一律留在 working tree，commit 由人類觸發。暫存/probe 檔只寫 $PAAW_TMP/ 用完自刪。回報請附 test run 結果與案例清單。

## AI 操作步驟

1× project_info
14× read_file
12× bash
3× write_file
5× edit_file

### 變更檔案
- `.paaw/tmp/task009-probe.mjs`
- `/Users/steward/App/tPAAW/log/tmp/tpaaw-gateway/task009-probe.mjs`
- `tests/e2e/gateway-restart-rbac.test.mjs`

## Git 變更分析

### Status
```
M .paaw/changelog/CHANGELOG.md
 M .paaw/changes/change-intelligence.json
 M .paaw/coding-memory/actions.jsonl
 M .paaw/coding-memory/conversations/coding.em/active.json
 M .paaw/coding-memory/dispatch-log.jsonl
 M .paaw/features/FEATURES.json
 D .paaw/features/backups/FEATURES-1789728003670.json
 D .paaw/features/backups/FEATURES-1789728003675.json
 M .paaw/issues/ISSUES.json
 M .paaw/release-requests/RR-20260918-1242-bd43.json
 M .paaw/release-unit-model.json
 M .paaw/tasks/TASKS.json
 M public/index.html
 M src/server.mjs
?? .paaw/coding-memory/dispatch-outputs/2026-09-19-02-17--qa.md
?? .paaw/features/backups/FEATURES-1789784266129.json
?? .paaw/features/backups/FEATURES-1789784903039.json
?? .paaw/sessions/2026-09-19-task-007f20260918-002review-code-review-srcservermjsgateway-.md
?? .paaw/sessions/2026-09-19-task-008criticalf20260918-002-srcservermjs-qa-review-finding.md
?? .paaw/tmp/
?? tests/e2e/gateway-restart-rbac.test.mjs
```

### Diff Stat
```
.paaw/changelog/CHANGELOG.md                       |    9 +
 .paaw/changes/change-intelligence.json             | 2400 +++++++++++++++++---
 .paaw/coding-memory/actions.jsonl                  |    1 +
 .../conversations/coding.em/active.json            |    9 +-
 .paaw/coding-memory/dispatch-log.jsonl             |   77 +
 .paaw/features/FEATURES.json                       |    4 +-
 .paaw/features/backups/FEATURES-1789728003670.json |  195 --
 .paaw/features/backups/FEATURES-1789728003675.json |  195 --
 .paaw/issues/ISSUES.json                           |   13 +-
 .paaw/release-requests/RR-20260918-1242-bd43.json  |  364 +--
 .paaw/release-unit-model.json                      |   26 +-
 .paaw/tasks/TASKS.json                             |  288 ++-
 public/index.html                                  |    8 +-
 src/server.mjs                                     |  153 +-
 14 files changed, 2886 insertions(+), 856 deletions(-)
```
