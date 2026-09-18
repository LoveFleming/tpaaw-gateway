# TASK-001（範圍限縮版，RR-20260918-1242 release 前）：人工安全 code review — 本次只審 gateway.mjs（release scope 內唯一變更的 code file）；src/server.mjs 已排下週期，不用審。

背景：gateway.mjs 是單檔雙角色（CLI：start/update/status；本地管理 UI：HTTP ser

**日期**: 2026-09-18
**耗時**: 682s
**結果**: ✅ 成功
**分支**: `main`

## 任務

TASK-001（範圍限縮版，RR-20260918-1242 release 前）：人工安全 code review — 本次只審 gateway.mjs（release scope 內唯一變更的 code file）；src/server.mjs 已排下週期，不用審。

背景：gateway.mjs 是單檔雙角色（CLI：start/update/status；本地管理 UI：HTTP server 綁 127.0.0.1:4290，9 個 API）。本次 release 變更含：1) F7 CSRF 防護新上線（gateway.mjs:653-681，Host 白名單 + Origin 驗證）；2) F1/F10 版本驗證（VERSION_RE，installVersion/updateLogic）；3) ISS-001 port 佔用偵測。自動掃描 scope 內 0 findings；全庫 6 筆 WARNING 都在 src/server.mjs 且你已 triage 過（誤報/已緩解）。已有 12 個 CSRF 直測全綠（tests/e2e/gateway-ui-csrf.test.mjs）。

審查重點（獨立重找，不依賴掃描器）：
1. CSRF 防護完整性 — Host/Origin 檢查是否涵蓋所有 POST handler 入口、GET 端點是否有狀態改變副作用（若有，GET 不檢查 Origin 就是洞）
2. Command injection — child process 呼叫（spawn/exec）參數是否可控
3. Path traversal — 版本路徑、backup、上傳 zip 安裝（手動上傳 zip 是 9/7 新功能）的檔案路徑驗證
4. DNS rebinding 殘餘風險 — Host 白名單之外還有什麼能繞
5. 其他你認為該看的（secrets、DoS、upstream fetch 的 SSRF）

產出：每個 finding 給 file:line、severity、exploit path；無 finding 也要明確說「審過哪些面、為何放行」。結論給 release verdict：GO / GO with notes / NO-GO。不修碼、不 commit。

## AI 操作步驟

9× read_file
1× project_info
1× grep
1× glob
1× task_create
1× action_log_add

## Git 變更分析

### Status
```
M .paaw/HANDOVER.md
 M .paaw/agents/coding.rm.json
 M .paaw/changelog/CHANGELOG.md
 M .paaw/changes/change-intelligence.json
 M .paaw/coding-memory/actions.jsonl
 M .paaw/coding-memory/conversations/coding.developer/active.json
 M .paaw/coding-memory/conversations/coding.em/active.json
 M .paaw/coding-memory/conversations/coding.tester/active.json
 M .paaw/coding-memory/dispatch-log.jsonl
 M .paaw/features/FEATURES.json
 D .paaw/features/backups/FEATURES-1788775413096.json
 D .paaw/features/backups/FEATURES-1788786779558.json
 M .paaw/handover-state.json
 M .paaw/release-requests/RR-20260918-1237-1d49.json
 M .paaw/release-unit-model.json
 M .paaw/security/scan-results.json
 M .paaw/tasks/TASKS.json
 M .paaw/test-runs/last.json
 M .paaw/verify-last.json
M  gateway.mjs
 M package.json
?? .paaw/coding-memory/conversations/coding.em/s-2026-09-18T08-36-10.json
?? .paaw/coding-memory/dispatch-outputs/
?? .paaw/features/backups/FEATURES-1789728003670.json
?? .paaw/features/backups/FEATURES-1789728003675.json
?? .paaw/features/backups/FEATURES-1789728644590.json
?? .paaw/features/backups/FEATURES-1789729078050.json
?? .paaw/features/backups/FEATURES-1789729693243.json
?? .paaw/release-requests/RR-20260918-1242-bd43.json
?? .paaw/sessions/2026-09-18-gatewaymjs-f7-csrf-task-002-task-002-f1f10-f7-csrf-em-f1f10-.md
?? .paaw/sessions/2026-09-18-task-003release-rr-20260918-1242-1f7-csrf-gatewaymjs-cmdui-p.md
?? .paaw/sessions/2026-09-18-task-004-gatewaymjs-rr-20260918-1242-risk-gate-failhighapi-f.md
?? .paaw/staged-changes.json
?? .paaw/test-runs/runs/RUN-20260918-004.json
?? .paaw/tmp/
?? tests/e2e/gateway-ui-csrf.test.mjs
```

### Diff Stat
```
.paaw/HANDOVER.md                                  |  39 ++-
 .paaw/agents/coding.rm.json                        |   7 +-
 .paaw/changelog/CHANGELOG.md                       |  26 ++
 .paaw/changes/change-intelligence.json             | 284 +++++++++++++++++++--
 .paaw/coding-memory/actions.jsonl                  |   4 +
 .../conversations/coding.developer/active.json     |   2 +-
 .../conversations/coding.em/active.json            |  70 +----
 .../conversations/coding.tester/active.json        |   2 +-
 .paaw/coding-memory/dispatch-log.jsonl             |  84 ++++++
 .paaw/features/FEATURES.json                       |   8 +-
 .paaw/features/backups/FEATURES-1788775413096.json | 195 --------------
 .paaw/features/backups/FEATURES-1788786779558.json | 195 --------------
 .paaw/handover-state.json                          |  72 ++----
 .paaw/release-requests/RR-20260918-1237-1d49.json  | 279 ++++++++++++++++++--
 .paaw/release-unit-model.json                      |  62 ++++-
 .paaw/security/scan-results.json                   |   2 +-
 .paaw/tasks/TASKS.json                             |  97 ++++++-
 .paaw/test-runs/last.json                          |  12 +-
 .paaw/verify-last.json                             |   8 +-
 package.json                                       |   2 +-
 20 files changed, 860 insertions(+), 590 deletions(-)
 gateway.mjs | 32 ++++++++++++++++++++++++++++++++
 1 file changed, 32 insertions(+)
```

## AI 回覆

TASK-005 已開給 Priya。以下是正式報告。

---

# 人工安全 Code Review 報告 — gateway.mjs

**Task**: TASK-001（RR-20260918-1242 release 前，範圍限縮版）
**對象**: `gateway.mjs`（單檔雙角色：CLI + 本地管理 UI @127.0.0.1:4290）
**方法**: 全檔逐讀 + `ui/index.html` 渲染層交叉驗證 + 攻擊鏈手動推導，不依賴掃描器
**修復 task**: TASK-005（掛 F20260906-001，high）

---

## Findings（3 筆）

### 🔴 MAJ-001｜Major｜`manifest.version` 未驗證 — F1/F10 只上了一半，update 路徑是洞

**證據**：
- `gateway.mjs:44` — `VERSION_RE` 已定義，但全檔只有 3 個使用點：L123（`listInstalledVersions`）、L355（`installUploadedZip`）。**`installVersion` 與 `updateLogic` 完全沒用**。
- `gateway.mjs:318` — `const v = manifest.version;` 未經任何驗證，直接組三條路徑：
  - L318-319：`zipPath = join(HOME, "logs", \`paaw-${v}.zip\`)`
  - L321-326：`dlUrl = \`${server}/packages/${v}/paaw.zip\``（`v` 可注入 `../`、`?`、`#`）
  - `stageInstall` → `gateway.mjs:294` `join(VERSIONS_DIR, v)` → `"999.0.0/../../.."` resolve 後**寫出 HOME 目錄白名單**
- `gateway.mjs:431` — `writeCurrentAtomic(manifest.version)` 把未驗字串寫進 `current.json`（污染後續所有啟動路徑）
- `gateway.mjs:90-96` — `semverGt` 在**首個差異段**即 return：`"999.0.0/../../x"` 對 `"1.2.3"` 首段 `999 > 1` 直接 `newer=true`，NaN 後段根本不參與比較。我原本預期只有「首次安裝」（`newer = !current` 無檢查）可達，實際上**任何 update 都可觸發**。
- `ui/index.html:280` — `stableVersion.innerHTML = st`，`s.stable` 即 `stable.json` 的 `version` 欄（任意字串）未 escape → stored XSS（同源注入，可再以 UI origin 發合法 POST 繞過 CSRF gate）。

**Exploit path**：攻陷 package server 或 MITM（`POST /api/settings` 允許 `http://` package server，明文可攔）→ `stable.json = {"version":"999.0.0/../../..", "sha256":"<配對自己包>"}` → 使用者按更新 → gateway 寫任意路徑 + `current.json` 污染 + `/api/status` 回傳 payload → UI innerHTML 執行。

**嚴重度權衡（為何是 major 不是 blocker）**：前提是 package server 信任邊界被突破，而該前提下 `sha256` 也來自同一個被污染的 manifest —— 攻擊者本來就有 RCE 等價能力（`npm install` 會跑 package scripts）。此 finding 的真實增量是 **MITM 場景的單點污染 + traversal 寫出白名單 + UI 注入**，屬縱深缺失。但 **spec 一致性問題必須單獨對待**：本次 release 宣稱「F1/F10 已上」與實碼不符 —— 若不改措辭，下週期會以為 update 路徑已有防護。

**修復**（已寫入 TASK-005）：`updateLogic`/`installVersion` 入口 `VERSION_RE.test()` fail-closed（一行）+ `ui/index.html` `s.stable` 過 `es

... (truncated)
