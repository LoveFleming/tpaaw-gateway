# TASK-009 收尾：跑全套測試確認 52 案全綠。

背景：你先前新增了 tests/e2e/gateway-restart-rbac.test.mjs（10 案例：F-01 restart race 4 案 + F-02 備份端點 admin check 6 案），測試檔已完成但全套尚未確認執行。

工作內容：
1. 在專案根 /Users/steward/App/tpaaw-gateway

**日期**: 2026-09-19
**耗時**: 151s
**結果**: ✅ 成功
**分支**: `main`

## 任務

TASK-009 收尾：跑全套測試確認 52 案全綠。

背景：你先前新增了 tests/e2e/gateway-restart-rbac.test.mjs（10 案例：F-01 restart race 4 案 + F-02 備份端點 admin check 6 案），測試檔已完成但全套尚未確認執行。

工作內容：
1. 在專案根 /Users/steward/App/tpaaw-gateway 執行 `npm test`（test script 已釘 TAP reporter，glob 會自動納入新測試檔）
2. 確認 TAP 官方總計：預期 unit 13 + backup-auth 13 + ui-csrf 16 + restart-rbac 10 = 52/52 pass、exit 0
3. 若有 fail：分析原因、修測試或回報產品碼問題（不要自行改 src/server.mjs — 產品碼問題回報給我）
4. 全綠後記錄 test run（會產生 RUN-YYYYMMDD-NNN ID）

回報：TAP 總計數字、RUN ID、任何異常。

⚠️ 鐵律：絕對禁止 git commit / git add — 上次你自行 commit 違反規則，這次任何 git 寫入操作都不允許。測試跑完回報即可。

## AI 操作步驟

9× bash
1× glob
1× git
2× read_file
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
?? .paaw/features/backups/FEATURES-1789784266129.json
?? .paaw/features/backups/FEATURES-1789784903039.json
?? .paaw/sessions/2026-09-19-task-007f20260918-002review-code-review-srcservermjsgateway-.md
?? .paaw/sessions/2026-09-19-task-008criticalf20260918-002-srcservermjs-qa-review-finding.md
?? .paaw/sessions/2026-09-19-task-009criticalf20260918-002-task-008-srcservermjs-f-01-res.md
?? .paaw/test-runs/runs/RUN-20260919-002.json
?? .paaw/tmp/
?? tests/e2e/gateway-restart-rbac.test.mjs
```

### Diff Stat
```
.paaw/changelog/CHANGELOG.md                       |   15 +
 .paaw/changes/change-intelligence.json             | 2400 +++++++++++++++++---
 .paaw/coding-memory/actions.jsonl                  |    2 +
 .../conversations/coding.em/active.json            |   19 +-
 .paaw/coding-memory/dispatch-log.jsonl             |  164 ++
 .paaw/features/FEATURES.json                       |    4 +-
 .paaw/features/backups/FEATURES-1789728003670.json |  195 --
 .paaw/features/backups/FEATURES-1789728003675.json |  195 --
 .paaw/issues/ISSUES.json                           |   13 +-
 .paaw/release-requests/RR-20260918-1242-bd43.json  |  364 +--
 .paaw/release-unit-model.json                      |   26 +-
 .paaw/tasks/TASKS.json                             |  288 ++-
 .paaw/test-runs/last.json                          |   46 +-
 public/index.html                                  |    8 +-
 src/server.mjs                                     |  153 +-
 15 files changed, 3022 insertions(+), 870 deletions(-)
```

## AI 回覆

TASK-009 收尾完成。測試報告如下：

---

## 📋 測試報告 — TASK-009（F20260918-002）

### 範圍
全套 `npm test`（`node --test --test-reporter=tap "tests/**/*.test.mjs"`），glob 自動納入新檔 `tests/e2e/gateway-restart-rbac.test.mjs`。驗證對象：working tree 中 TASK-008 的 `src/server.mjs` 修復（未 commit）+ 新測試檔（未追蹤）。

### 結果 ✅ 全綠

**TAP 官方總計（原始輸出）：**
```
# tests 52
# suites 6
# pass 52
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 12501.23575
EXIT_CODE=0
```

**分佈（與預期完全一致）：**

| 測試檔 | 案例數 | 結果 |
|---|---|---|
| tests/unit/backup.test.mjs | 13 | ✅ |
| tests/e2e/gateway-backup-auth.test.mjs | 13 | ✅ |
| tests/e2e/gateway-ui-csrf.test.mjs | 16 | ✅ |
| tests/e2e/gateway-restart-rbac.test.mjs（新） | 10 | ✅ |
| **合計** | **52** | **52/52 pass** |

**新 10 案單檔重跑證據：**
```
ok 1 - F-01 /api/server/* exit-confirmed lifecycle (spawned gateway + controllable stub child)
ok 2 - F-02 RBAC: backup/restore/upgrade/server endpoints are admin-only (case 3)
# tests 10  # pass 10  # fail 0  EXIT_CODE=0
```

### 穩定性
全套跑了 **2 次**（第二次為擷取完整 TAP tail），兩次皆 52/52、exit 0，無 flaky。

### RUN ID
**`RUN-20260919-002`** — 已寫入 `.paaw/test-runs/runs/RUN-20260919-002.json` 並同步 `last.json`（JSON 已驗證合法）。

### 異常與備註
1. **計數器假象已修正**：前次 RUN-20260919-001 記錄 `passed: 17`（實際 TAP 官方總計 42）— 即 ADR-001 記載的「計數器只數 TAP 頂層條目」工具問題。本次記錄改用 TAP leaf-test 官方總計 **52**，並在 note 欄位註明差異原因，避免再產生假訊號。
2. **HEAD 已移動**：當前 HEAD 為 `db2671c`（ADR 中 0.2.1 評估的 target 是 `12ae4b8`），本次 run 的 headSha 如實記錄 `db2671c` + working tree 狀態。
3. `NO_COLOR/FORCE_COLOR` env 警告：環境變數衝突的 cosmetic 訊息，與測試無關，不影響結果。
4. **無產品碼問題**：F-01/F-02 針對的 TASK-008 修復全數通過，無需回報 Developer。

### Git 狀態
⚠️ 依鐵律：本次**零 git 寫入操作**（僅 `status --short` / `rev-parse` 唯讀查詢）。新測試檔與 RUN 紀錄都留在 working tree，commit 由你在 Git tab 決定。
