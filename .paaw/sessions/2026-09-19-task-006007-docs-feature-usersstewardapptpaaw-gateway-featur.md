# TASK-006/007 docs 階段：更新兩個 feature 的文件，反映本輪安全修復與品質補強。專案根：/Users/steward/App/tpaaw-gateway

## Feature 1：F20260918-001 PAAW Gateway 控制台（gateway.mjs + ui/index.html）
本輪變更需入文件：
1. F7 CSRF 防護：cmdUI() POST 

**日期**: 2026-09-19
**耗時**: 260s
**結果**: ✅ 成功
**分支**: `main`

## 任務

TASK-006/007 docs 階段：更新兩個 feature 的文件，反映本輪安全修復與品質補強。專案根：/Users/steward/App/tpaaw-gateway

## Feature 1：F20260918-001 PAAW Gateway 控制台（gateway.mjs + ui/index.html）
本輪變更需入文件：
1. F7 CSRF 防護：cmdUI() POST handler 加 Host 白名單 + Origin 驗證（防 DNS rebinding / 惡意網頁對 localhost）
2. MAJ-001：update 路徑 manifest.version 經 VERSION_RE 驗證，fail-closed（installVersion/updateLogic 入口）
3. MED-001：Host gate 擴及所有請求（含 GET）
4. MIN-001：POST /api/settings body 上限 1MB，超限回 413
5. MAJ-001b：UI stable 版本字串 XSS 防護（esc()）
6. 測試：tests/e2e/gateway-ui-csrf.test.mjs 16 案例（spawn 真 gateway）
7. 版本：0.2.1

## Feature 2：F20260918-002 PAAW Gateway 維運平台（src/server.mjs）
本輪變更需入文件：
1. F-01（原 blocker）：stopPaaw() 改 exit-confirmed Promise — SIGTERM → 5s SIGKILL → 10s failsafe 誠實回報 timeout；restartPaaw/upgradePaaw/restoreBackup 全 await 確認 stop 成功才續行，stop 失敗 fail-closed 回 ok:false（不再謊報）
2. F-02（原 major）：POST /api/backups/create 與 /api/backups/restore/* 加 admin check（handler 開頭、副作用前），viewer 鎖唯讀（GET /api/backups 放行）
3. 併發行為：併發 restart 共享 stop 序列，第二個收 ok:false "Already running"（誠實拒絕）
4. 測試：tests/e2e/gateway-restart-rbac.test.mjs 10 案例（spawn 真 gateway + 可控 stub child fast/delayed/stubborn 三模式）
5. 已知未修（排隊 ISS-002，medium）：F-03 明文密碼、無 rate limit — 文件如實標註為已知限制
6. 測試證據：RUN-20260919-002 全套 52/52

## 工作方式
1. 先 project_info(category="feature_detail", id="F20260918-001") 和 id="F20260918-002" 看現有文件結構
2. 用 project_edit(action="feature_update_docs") 更新兩個 feature 的 docs — 在現有內容基礎上增補，不要砍掉既有內容
3. 更新時把測試檔 mapping（tests/e2e/gateway-restart-rbac.test.mjs → F20260918-002）一併確認 — 若 mapping 缺漏用 project_edit(action="feature_update_mapping")

⚠️ 鐵律：絕對禁止 git commit / git add / 任何 git 寫入。只透過 project_edit 更新文件。

## AI 操作步驟

15× project_info
2× glob
14× grep
4× read_file
7× project_edit
1× action_log_add
1× cu_refresh

## Git 變更分析

### Status
```
M .paaw/changelog/CHANGELOG.md
 M .paaw/changes/change-intelligence.json
 M .paaw/code-intelligence/call-graph.json
 M .paaw/code-intelligence/dependency-graph.json
 M .paaw/code-intelligence/file-map.json
 M .paaw/code-intelligence/summary.json
 M .paaw/code-intelligence/symbol-index.json
 M .paaw/code-intelligence/test-code-map.json
 M .paaw/code-intelligence/test-intelligence.json
 M .paaw/coding-memory/actions.jsonl
 M .paaw/coding-memory/conversations/coding.em/active.json
 M .paaw/coding-memory/dispatch-log.jsonl
 M .paaw/features/FEATURES.json
 D .paaw/features/backups/FEATURES-1789728003670.json
 D .paaw/features/backups/FEATURES-1789728003675.json
 D .paaw/features/backups/FEATURES-1789728644590.json
 D .paaw/features/backups/FEATURES-1789729078050.json
 M .paaw/issues/ISSUES.json
 M .paaw/release-requests/RR-20260918-1242-bd43.json
 M .paaw/release-unit-model.json
 M .paaw/tasks/TASKS.json
 M .paaw/test-runs/last.json
 M public/index.html
 M src/server.mjs
?? .paaw/coding-memory/dispatch-outputs/2026-09-19-02-17--qa.md
?? .paaw/coding-memory/dispatch-outputs/2026-09-19-03-15--tester.md
?? .paaw/coding-memory/dispatch-outputs/2026-09-19-03-17--qa.md
?? .paaw/features/backups/FEATURES-1789784266129.json
?? .paaw/features/backups/FEATURES-1789784903039.json
?? .paaw/features/backups/FEATURES-1789787914891.json
?? .paaw/features/backups/FEATURES-1789787914894.json
?? .paaw/sessions/2026-09-19-task-007f20260918-002review-code-review-srcservermjsgateway-.md
?? .paaw/sessions/2026-09-19-task-008-task-007-review-no-go-srcservermjs-f-01f-02-2026-09.md
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
 .paaw/code-intelligence/call-graph.json            |   87 +-
 .paaw/code-intelligence/dependency-graph.json      |   66 +-
 .paaw/code-intelligence/file-map.json              |   99 +-
 .paaw/code-intelligence/summary.json               |   28 +-
 .paaw/code-intelligence/symbol-index.json          |   96 +-
 .paaw/code-intelligence/test-code-map.json         |    2 +-
 .paaw/code-intelligence/test-intelligence.json     |   31 +-
 .paaw/coding-memory/actions.jsonl                  |    4 +
 .../conversations/coding.em/active.json            |   19 +-
 .paaw/coding-memory/dispatch-log.jsonl             |  164 ++
 .paaw/features/FEATURES.json                       |  128 +-
 .paaw/features/backups/FEATURES-1789728003670.json |  195 --
 .paaw/features/backups/FEATURES-1789728003675.json |  195 --
 .paaw/features/backups/FEATURES-1789728644590.json |  195 --
 .paaw/features/backups/FEATURES-1789729078050.json |  197 --
 .paaw/issues/ISSUES.json                           |   13 +-
 .paaw/release-requests/RR-20260918-1242-bd43.json  |  364 +--
 .paaw/release-unit-model.json                      |   26 +-
 .paaw/tasks/TASKS.json                             |  293 ++-
 .paaw/test-runs/last.json                          |   46 +-
 public/index.html                                  |    8 +-
 src/server.mjs                                     |  153 +-
 24 files changed, 3464 insertions(+), 1360 deletions(-)
```

## AI 回覆

TASK-006/007 docs 階段完成。總結如下：

## 完成內容

### 📄 F20260918-001（gateway.mjs + ui/index.html）文件增補
全部 6 項變更入文件，**逐項經 read_file/grep 對程式碼驗證**後才寫：

| 項目 | 文件記載（已對照 code） |
|---|---|
| F7 CSRF | `HOST_WHITELIST`（127.0.0.1/localhost/::1 + UI_HOST）+ `hostOf()` 拆 hostname 防 port/後綴繞過；POST 驗 Origin（`new URL` 解析失敗一律拒）；403 訊息精確文字 `"Forbidden: untrusted Host/Origin"` |
| MED-001 | Host gate 擴及全部請求（GET+POST），GET 不驗 Origin |
| MAJ-001 | `VERSION_RE = /^\d+\.\d+\.\d+$/` 三道入口 fail-closed（installVersion / updateLogic / manifest.version） |
| MIN-001 | `MAX_SETTINGS_BODY = 1MB`、超限 destroy + 413「body 超過 1MB 上限」 |
| MAJ-001b | `esc()` 定義於 ui/index.html:159，stable 字串過 esc、newBadge 走 textContent |
| 測試/版本 | ui-csrf 16 案（spawn 真 gateway）、v0.2.1（package.json） |

### 📄 F20260918-002（src/server.mjs）文件增補
- **F-01**：exit-confirmed 序列 SIGTERM → 5s SIGKILL → 10s failsafe 誠實 `ok:false`；restart/upgrade/restore 全 `await` fail-closed；`paawStatus="crashed"` 如實浮現
- **F-02**：create/restore admin check 於 handler 開頭副作用前；viewer 保留 `GET /api/backups` 唯讀
- **併發**：`stoppingPromise` dedupe 共享 stop 序列；`"Already running"` 誠實拒絕
- **測試**：restart-rbac 10 案 + fast/delayed/stubborn stub 設計 + QA case-2 差異註記（10s failsafe 為 defense-in-depth，E2E 不可達）
- **已知限制如實標註**：ISS-002（明文密碼 + 無 rate limit，medium）
- 測試證據 RUN-20260919-002（52/52）

### 🔧 Mapping 補齊（三處缺漏）
1. `tests/e2e/gateway-restart-rbac.test.mjs` → F20260918-002 ✅
2. `tests/unit/backup.test.mjs` → F20260918-002 ✅
3. `POST /api/backups/restore/<filename>` 補入端點清單（原掃描器漏萬用路徑，實為 14 端點）✅；`ui/index.html` 補入 F20260918-001 Code Files ✅

跑 `cu_refresh`（code-intelligence + test-intelligence）後 test_map 已同步兩個 feature 的全部測試檔。

## ⚠️ 兩點備忘（已記 action log）
1. F20260918-002 的 **Description 欄仍寫「13 個端點」**（實為 14）— 該欄位由 CU pipeline 管理，`feature_update_docs` 的 description 參數改不動；endpoint list 與 docs 已是正確的 14 端點，若要動 Description 需重跑 feature-map（耗 LLM，本輪未動以免覆蓋剛寫入的文件）
2. 過程中我第一次傳 apis 用字串格式弄壞了端點列表（顯示 undefined），已即時用結構化物件 `{method, path, file}` 修復並驗證

依任務鐵律，**全程零 git 操作** — 僅透過 `project_edit` 更新，無 com

... (truncated)
