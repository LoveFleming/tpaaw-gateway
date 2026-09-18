# TASK-005：修 gateway.mjs 三個安全點（QA 人工審查 findings，release RR-20260918-1242 前）。先 read_file gateway.mjs 與 ui/index.html 相關段落再改。三個修復：

【1. MAJ-001 — update 路徑補 manifest.version 驗證（fail-closed）】
VERSION_RE（ga

**日期**: 2026-09-18
**耗時**: 849s
**結果**: ✅ 成功
**分支**: `main`

## 任務

TASK-005：修 gateway.mjs 三個安全點（QA 人工審查 findings，release RR-20260918-1242 前）。先 read_file gateway.mjs 與 ui/index.html 相關段落再改。三個修復：

【1. MAJ-001 — update 路徑補 manifest.version 驗證（fail-closed）】
VERSION_RE（gateway.mjs:44）已存在但 update 路徑沒用。兩個入口都加：
- installVersion（約 L316-335）：取得 manifest.version 後、任何路徑拼接/dlUrl 組合之前，VERSION_RE.test(manifest.version) 不符即 throw
- updateLogic（約 L414-432）：同樣在入口驗證，不符即 throw（注意 semverGt 首段即 return 的特性讓 "999.0.0/../../x" 通過 newer 判斷，所以必須在 semverGt 之前擋）
錯誤訊息寫清楚「invalid version from manifest」方便排查。

【2. MAJ-001b — ui/index.html stable XSS escape】
refresh() 裡 stableVersion.innerHTML = st（約 L280），st 來自 stable.json 的 version 欄（manifest 可控字串）。改用既有的 esc() 函式過（確認 ui/index.html 已有 esc()，若無就沿 paawLog 渲染用的同一套 &/</> escape 邏輯）。

【3. MED-001 — GET 也套 Host gate】
gateway.mjs:663-681 的 gate 目前只攔 method==="POST"。改成所有請求（GET+POST）都做 Host 白名單檢查；Origin 檢查維持只有 POST 需要（GET 不會帶有意義的 Origin，同源 GET 帶 Origin 也要放行以免誤擋 — 看現有結構怎麼最小改）。注意：browser 直連 127.0.0.1 Host 必合法不誤擋，這是 QA 驗證過的修法。

【4. MIN-001 — POST /api/settings body 上限】
gateway.mjs:712-714 body += c 無上限，補個合理上限（如 1MB，config json 用不到那麼大），超限即 413 destroy。

【重要已知影響】第 3 點會讓現有測試 tests/e2e/gateway-ui-csrf.test.mjs 案例 12（GET 帶惡意 Origin/Host → 預期 200）失效 — 這是預期行為變更，測試由 tester 接手更新，你不用改測試檔。

完成後跑 node --test tests/e2e/gateway-ui-csrf.test.mjs 看非案例12是否仍過（預期 11/12，案例 12 紅屬預期）。不 commit（EM 統一收）。回報：每個修復點的 diff 摘要與行號。

## AI 操作步驟

8× read_file
14× bash
1× task_list
9× edit_file
3× write_file

### 變更檔案
- `./gateway.mjs`
- `.paaw/tmp/patch-gateway.mjs`
- `.paaw/tmp/smoke-maj001.mjs`
- `.paaw/tmp/writetest.txt`
- `gateway.mjs`
- `ui/index.html`

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
 gateway.mjs                                        |  42 ++-
 package.json                                       |   2 +-
 ui/index.html                                      |  10 +-
 22 files changed, 902 insertions(+), 600 deletions(-)
 gateway.mjs | 32 ++++++++++++++++++++++++++++++++
 1 file changed, 32 insertions(+)
```
