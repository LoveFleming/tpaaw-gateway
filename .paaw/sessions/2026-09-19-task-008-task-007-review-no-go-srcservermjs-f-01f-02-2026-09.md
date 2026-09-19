# TASK-008 複審（TASK-007 review 的 NO-GO 解除判定）：重審 src/server.mjs 的 F-01/F-02 修復。

背景：你 2026-09-19 02:16 對 src/server.mjs 判 NO-GO（F-01 blocker restart race + F-02 major 備份端點缺 admin check + 其他）。Developer Pri

**日期**: 2026-09-19
**耗時**: 156s
**結果**: ✅ 成功
**分支**: `main`

## 任務

TASK-008 複審（TASK-007 review 的 NO-GO 解除判定）：重審 src/server.mjs 的 F-01/F-02 修復。

背景：你 2026-09-19 02:16 對 src/server.mjs 判 NO-GO（F-01 blocker restart race + F-02 major 備份端點缺 admin check + 其他）。Developer Priya 已完成修復（working tree，未 commit）：

**F-01（blocker）修復**：stopPaaw() 改為 exit-confirmed Promise — SIGTERM → 5s 後 SIGKILL → 10s failsafe 誠實回報 timeout；restartPaaw / upgradePaaw / restoreBackup 全部 await 確認 stop 成功才續行，stop 失敗不再謊報 ok:true。

**F-02（major）修復**：POST /api/backups/create 與 /api/backups/restore/* 補 admin check，viewer 鎖唯讀。

**測試證據**：RUN-20260919-002 — 52/52 pass、exit 0（含新 tests/e2e/gateway-restart-rbac.test.mjs 10 案例：F-01 4 案含 elapsed ≥ 4500ms 誠實合約斷言、F-02 6 案含 403 無副作用驗證；spawn 真 gateway + 可控 stub child fast/delayed/stubborn 三模式）。

複審工作：
1. read_file /Users/steward/App/tpaaw-gateway/src/server.mjs，針對 F-01/F-02 逐項確認修復真實在位且邏輯正確（不是只有測試過）
2. 檢查修復是否引入新問題（race、洩漏、錯誤處理、副作用）
3. 讀 tests/e2e/gateway-restart-rbac.test.mjs 確認測試真的鎖住 F-01/F-02（斷言強度夠，不是空殼）
4. 給 verdict：F-01/F-02 是否 resolved → NO-GO 是否可解除（其餘 findings 維持原判定不變）

⚠️ 鐵律：絕對禁止 git commit / git add / 任何 git 寫入。唯讀審查，回報 verdict 即可。

## AI 操作步驟

1× project_info
5× read_file
4× grep
1× diff
3× glob
1× task_list
1× task_update
1× action_log_add

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
 M .paaw/test-runs/last.json
 M public/index.html
 M src/server.mjs
?? .paaw/coding-memory/dispatch-outputs/2026-09-19-02-17--qa.md
?? .paaw/coding-memory/dispatch-outputs/2026-09-19-03-15--tester.md
?? .paaw/features/backups/FEATURES-1789784266129.json
?? .paaw/features/backups/FEATURES-1789784903039.json
?? .paaw/sessions/2026-09-19-task-007f20260918-002review-code-review-srcservermjsgateway-.md
?? .paaw/sessions/2026-09-19-task-008criticalf20260918-002-srcservermjs-qa-review-finding.md
?? .paaw/sessions/2026-09-19-task-009-52-testse2egateway-restart-rbactestmjs10-f-01-resta.md
?? .paaw/sessions/2026-09-19-task-009criticalf20260918-002-task-008-srcservermjs-f-01-res.md
?? .paaw/test-runs/runs/RUN-20260919-002.json
?? .paaw/tmp/
?? tests/e2e/gateway-restart-rbac.test.mjs
```

### Diff Stat
```
.paaw/changelog/CHANGELOG.md                       |   15 +
 .paaw/changes/change-intelligence.json             | 2400 +++++++++++++++++---
 .paaw/coding-memory/actions.jsonl                  |    3 +
 .../conversations/coding.em/active.json            |   19 +-
 .paaw/coding-memory/dispatch-log.jsonl             |  164 ++
 .paaw/features/FEATURES.json                       |    4 +-
 .paaw/features/backups/FEATURES-1789728003670.json |  195 --
 .paaw/features/backups/FEATURES-1789728003675.json |  195 --
 .paaw/issues/ISSUES.json                           |   13 +-
 .paaw/release-requests/RR-20260918-1242-bd43.json  |  364 +--
 .paaw/release-unit-model.json                      |   26 +-
 .paaw/tasks/TASKS.json                             |  293 ++-
 .paaw/test-runs/last.json                          |   46 +-
 public/index.html                                  |    8 +-
 src/server.mjs                                     |  153 +-
 15 files changed, 3028 insertions(+), 870 deletions(-)
```

## AI 回覆

# 複審報告 — TASK-008（F-01 / F-02 修復驗證）

**Verdict：✅ F-01 RESOLVED・✅ F-02 RESOLVED → TASK-007 的 NO-GO 判定解除。**

---

## F-01（blocker）restart race — 逐項確認修復真實在位

| 檢查項 | 證據 | 結果 |
|---|---|---|
| stopPaaw 改 exit-confirmed Promise | `src/server.mjs:146-194`：`proc.once("exit", () => finish(true))` 為唯一成功路徑，resolve 時 PID 已被 Node reap | ✅ 在位 |
| 5s SIGKILL 升級 | `:174-179` sigkillTimer + `exitCode/signalCode` 雙 null 檢查 + try/catch | ✅ 在位 |
| 10s failsafe 誠實回報 | `:182-184` `finish(false, "process did not exit after SIGKILL")` | ✅ 在位 |
| 呼叫端全數 await（async 轉換後最常見的白修就是漏 await） | `:581` upgrade、`:595` stop、`:601` restart、`:627` restore — **四處全對** | ✅ 無漏接 |
| stop 失敗 fail-closed | restart `:210-213` / upgrade `:269-271` / restore `:629-632` — 三處均 abort + `logEvent` + 誠實回傳 `ok:false`，不再謊報 | ✅ 在位 |
| 併發 dedupe | `:136` stoppingPromise 共享、settled flag 防重複 settle、finish 內清 null | ✅ 正確 |

我特別核對了一個 reviewer 容易放過的細節：**generic exit handler 先把 status 標 "crashed"，`finish(true)` 再覆寫 "stopped"** — `:160` 有註解標明 intentional，語義正確（意圖性停止不應顯示為 crash）。

## F-02（major）備份端點 admin check

- `POST /api/backups/create` 與 `POST /api/backups/restore/*` 的 `role !== "admin" → 403` 檢查都在 **handler 開頭、任何副作用之前** ✅
- `currentUser.role` 存取安全：非 public route 未過 Bearer auth 已在 `:523-526` 提前 401 return，到 handler 時必非 null ✅
- viewer 唯讀語義保留：`GET /api/backups` 無 admin check（讀取放行，符合「鎖唯讀」spec）✅
- **順帶確認 traversal 防護未被動到**：`restoreBackup` 開頭 `BACKUP_REGEX` 錨定驗證仍在 `:386` ✅

## 測試斷言強度（非空殼確認）

- **delayed 案**：斷言 `800 ≤ elapsed < 4600` — 這直接證明回應等的是 **exit 事件**而非 SIGTERM 送達（fire-and-forget 舊碼會秒回，抓得到）
- **stubborn 案**：`elapsed ≥ 4500ms` + 舊 pid 真死（`kill(pid,0)` 拋錯驗證）+ 新 pid 真活 — 誠實合約完整。⚠️ 與我原建議 case 2（走到 10s failsafe 收 `ok:false`）有偏離，但理由成立且已記錄在測試檔頭：**SIGKILL 無法被 user-space 忽視，failsafe 分支在 E2E 不可達**，probe 實證過。這是合理的工程判斷，不是偷工。
- **F-02 案**：403 之外驗證**零副作用**（備份目錄無新檔案、PAAW_ROOT db.json 內容未變）+ admin 正向路徑真建檔真還原 + 四個進程端點全數 403 ✅
- RUN-20260919-002：52/52 pass、exit 0、**跑兩次結果一致**，且 note 記載修正了上次 42→17 的計數假象（leaf-test 口徑）✅

## 修復引入的新問題

- **Blocker

... (truncated)
