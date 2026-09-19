# TASK-008（critical，F20260918-002）：修復 src/server.mjs 兩個 QA review findings（2026-09-19 02:16 review，NO-GO）。

流程要求：先 read_file src/server.mjs 全文確認現況，再動手。只修以下兩項，不大重構。

F-01（blocker）restart race — POST /api

**日期**: 2026-09-19
**耗時**: 589s
**結果**: ✅ 成功
**分支**: `main`

## 任務

TASK-008（critical，F20260918-002）：修復 src/server.mjs 兩個 QA review findings（2026-09-19 02:16 review，NO-GO）。

流程要求：先 read_file src/server.mjs 全文確認現況，再動手。只修以下兩項，不大重構。

F-01（blocker）restart race — POST /api/server/restart：
- 現況：stop 尚未完成就 start、或 stop 失敗仍回 ok:true（謊報成功）
- 修法：restart 必須確實等 stop 完成（進程 exit / 埠釋放）才 start；stop 失敗要如實回報 fail（fail-closed 原則：寧可回 error 也不謊報 ok）

F-02（major）備份端點缺 admin check：
- 現況：非 admin（viewer）可呼叫備份相關端點，含覆寫 PAAW_ROOT 並重啟進程的路徑（權限提升）
- 修法：備份/還原/升級/進程管理端點（POST /api/backups/*、/api/upgrade、/api/server/*）補 admin 角色檢查，非 admin 回 403；viewer 僅可讀（GET）

明確禁令（上一位 agent 因此違規記點）：
1. 絕對禁止 git commit / git push / git add — 修完留在 working tree，commit 由人類觸發
2. 只改 src/server.mjs（若 UI 需要 403 顯示可小改 public/index.html，先說明再改）
3. 不改 F-03 相關（明文密碼），那已另開 issue
4. 暫存/測試腳本只寫 $PAAW_TMP/，不留 src/

完成後回報：改動摘要（file:line 級）、自測結果（node --check 至少過）。測試補齊由 tester 下一輪做，你不用寫測試。

## AI 操作步驟

1× task_list
1× project_info
12× read_file
6× grep
9× edit_file
4× bash
2× write_file

### 變更檔案
- `.paaw/tmp/task008-verify.mjs`
- `/Users/steward/App/tPAAW/log/tmp/tpaaw-gateway/task008-verify.mjs`
- `public/index.html`
- `src/server.mjs`

## Git 變更分析

### Status
```
M .paaw/changes/change-intelligence.json
 M .paaw/coding-memory/actions.jsonl
 M .paaw/coding-memory/conversations/coding.em/active.json
 M .paaw/coding-memory/dispatch-log.jsonl
 M .paaw/features/FEATURES.json
 D .paaw/features/backups/FEATURES-1789728003670.json
 M .paaw/issues/ISSUES.json
 M .paaw/release-requests/RR-20260918-1242-bd43.json
 M .paaw/release-unit-model.json
 M .paaw/tasks/TASKS.json
 M public/index.html
 M src/server.mjs
?? .paaw/coding-memory/dispatch-outputs/2026-09-19-02-17--qa.md
?? .paaw/features/backups/FEATURES-1789784266129.json
?? .paaw/sessions/2026-09-19-task-007f20260918-002review-code-review-srcservermjsgateway-.md
?? .paaw/tmp/
```

### Diff Stat
```
.paaw/changes/change-intelligence.json             | 2400 +++++++++++++++++---
 .paaw/coding-memory/actions.jsonl                  |    1 +
 .../conversations/coding.em/active.json            |    9 +-
 .paaw/coding-memory/dispatch-log.jsonl             |   77 +
 .paaw/features/FEATURES.json                       |    4 +-
 .paaw/features/backups/FEATURES-1789728003670.json |  195 --
 .paaw/issues/ISSUES.json                           |   13 +-
 .paaw/release-requests/RR-20260918-1242-bd43.json  |  364 +--
 .paaw/release-unit-model.json                      |   26 +-
 .paaw/tasks/TASKS.json                             |  256 ++-
 public/index.html                                  |    8 +-
 src/server.mjs                                     |  153 +-
 12 files changed, 2845 insertions(+), 661 deletions(-)
```
