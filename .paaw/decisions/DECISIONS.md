# Technical Decisions

> 記錄架構和技術決策 (ADR format)。AI 在做決策時會自動追加。

## ADR-001: Release 0.2.1（#2026.09.19）就緒評估：附條件上線（conditional GO）
- **日期**: 2026-09-19
- **狀態**: Proposed
- **背景**: Release #2026.09.19（首發 baseline 起 26 commits）工具判定 NOT READY / HIGH risk，三訊號：changed feature no tests、test run stale 1 commit、234 files 變更。正式批次走 RR-20260918-1242-bd43（0.2.1，dc9c1a5→12ae4b8，reviewing）。
- **決定**: 建議「附條件上」（conditional GO）：(1) 工具 NOT READY 三訊號經交叉查證，兩項為假訊號 — 「gateway.mjs 無測試」是靜態分析盲區（tests/e2e/gateway-ui-csrf.test.mjs 以 spawn 真 gateway 覆蓋 16 案，feature map 已 mapping）；「stale 1 commit」的那個 commit 正是測試證據本身（12ae4b8 = RUN-20260918-005 落檔）。(2) 我於 2026-09-19 在 target commit 12ae4b8 重跑全套：RUN-20260919-001 TAP 官方總計 42/42 pass、exit 0；semgrep 重掃 ERROR 0 / WARNING 6（已全數 triage）；handover 已刷新至 HEAD。(3) 放行條件：人工 commit+push 13 個 .paaw 證據檔（含 1 未推 commit）→ UI 確認 RR checklist（建議已寫入：tests=pass / gates=waived / qa-records=pass / risk=waived）→ tag 0.2.1 → 24h 觀察窗（health + dashboard + 一次 update 演練）。
- **後果**: 老闆/人類最終決定。若放行：條件 C1–C3 須在 tag 0.2.1 前完成；24h 觀察窗內異常即按 DEPLOY.md 回滾。附帶發現兩個流程工具問題待 EM 開 issue：①release 證據產生器 risk gate 看不見 spawn-based e2e（險些造成假 NOT READY）；②test_run 計數器只數 TAP 頂層條目（42→17 假象）。

## ADR-002: RR-20260918-1242-bd43 複審：gates 改判 fail — F-01/F-02 修復未 commit，tag db2671c 會發佈未修版本
- **日期**: 2026-09-19
- **狀態**: Proposed
- **背景**: 01:04 複審（ADR-001）時 target=12ae4b8、未 commit 檔案全為 .paaw 證據，故 gates 給 waived。其後 TASK-006~009 品質補強（03:23 結案）與 QA 複審（03:17 NO-GO 解除）改動了 src/server.mjs（F-01/F-02）與新增 gateway-restart-rbac.test.mjs，但這些變更停留在 working tree；平台自動產生 2 個「release unit paaw save」commits（3d31aef、db2671c）把 target 推進至 db2671c，造成「測試/掃描證據指向的內容」與「target commit 內容」錯位。
- **決定**: RR-20260918-1242-bd43 複審後，gates 由 waived 改判 fail：diff（working tree vs HEAD）證實 src/server.mjs 的 F-01/F-02 安全修復（~180 行）與驗證它的 tests/e2e/gateway-restart-rbac.test.mjs 均未納入版控。tag 現在的 db2671c 會發佈不含 QA 已驗證修復的 0.2.1（即 TASK-007 曾判 NO-GO 的 1 blocker + 2 major 未修版本）。放行條件：人工 commit 修復與測試檔及 .paaw 證據 → RR target 前進至新 commit → gates 重驗（樹內容與被測/被掃對象一致，52/52 與 ERROR 0 證據隨即有效）→ tag 0.2.1。其餘三項建議：tests=pass（附錯位揭露）、qa-records=pass（掛 commit 條件）、risk=waived（auto=fail 三訊號經查證為靜態分析盲區/快照體積/同批 e2e 覆蓋，且有 DEPLOY.md 回滾程序）。
- **後果**: 人類最終決定。放行條件由「commit 證據檔」加嚴為「commit 修復本體 + target 更新 + gates 重驗」；測試 52/52 與掃描 ERROR 0 無需重跑（樹內容不變），但 tag 前建議重掃一次使掃描時間戳晚於最終 commit。若人類仍選擇直接 tag db2671c，等於 knowingly 發佈含 TASK-007 已知 blocker 的版本 — 建議明確拒絕此路徑。

## ADR-003: ADR-003: gateway.mjs / server.mjs 模組化重構（模組層拆分，入口檔名保留）
- **日期**: 2026-10-11
- **狀態**: Proposed
- **背景**: 現況兩個 source file 各自承擔多重職責：gateway.mjs（~1166 行）含 CLI 入口、套包安裝、進程管理、semgrep、內嵌 UI server；src/server.mjs（~1015 行，含 ~300 行已註解死碼）含 HTTP server、認證、進程生命週期、備份、升級、事件稽核。可維護性與可測試性差，模組邊界不清。使用者要求「適當拆一拆，不要全擠在一團」，並指定模組層顆粒度、開 TASK 給 Developer (Priya)。
- **決定**: 採模組層拆分，共 12 檔：gateway.mjs → 薄入口 + src/gateway/{config,install,process,semgrep,ui-server}.mjs；src/server.mjs → 薄入口 + src/server/{config,events,auth,paaw-control,backup}.mjs，並刪除 server.mjs 698–1016 已註解死碼（buildFallbackUI）。關鍵約束：(1) 入口檔名 gateway.mjs / src/server.mjs 一律保留（package.json bin + 3 個 e2e spawn target 綁定）；(2) 依賴嚴格單向（config 為 leaf，ui-server 依賴其餘 gateway 模組，backup → paaw-control）；(3) 共享可變狀態收斂到單一 owner 並以 getter 跨模組存取；(4) installSemgrep/runCapture 的 jobLog 以參數注入，切斷 semgrep↔ui 循環依賴；(5) 性質為 refactor-only，不改行為/API/CLI。分三期（P1 server、P2 gateway 核心、P3 gateway 周邊），每期以 npm test 52 案全綠為門檻。
- **後果**: 正面：模組邊界明確、可單獨測試、降低認知負載、消除 300 行死碼。負面/成本：跨模組重構期間若共享狀態 owner 收斂錯誤，會造成 3 個 e2e 全紅；需逐步驗證、每期跑測試。風險緩解見 ARCHITECTURE.md §8。實作由 Developer (Priya) 執行，Architect 提供施工圖與驗收條件。

## ADR-004: ADR-004: e2e 去 socket 化 — in-process handler 注入（export handler factory），loopback 綁定保證移入 opt-in 網路套件
- **日期**: 2026-10-19
- **狀態**: Proposed
- **背景**: 沙箱政策禁止 listen 綁 socket（listen EPERM: 127.0.0.1），使 5 個 spawn-真-server + fetch-打-socket 的 e2e（backup-auth / body-limit ISS-008 / login-hardening / restart-rbac / ui-csrf）全紅。此為環境阻擋、非程式缺陷。使用者裁定：不放行 listen，e2e 一律改走 in-process（不 spawn、不 bind 真 socket）。技術事實：Node 沒有 socketless HTTP server——http.Server 的派發只能經由真 socket，http.request 也無法在無 socket 下產生 IncomingMessage；唯一無 socket 的驅動方式是「直接呼叫 request handler (req,res)」並自建 req/res，因此 handler 必須可被測試 import。
- **決定**: 採「匯出 handler factory」接縫（方案 1），純測試端方案（方案 2）技術上不可行故排除。最小 production 改動（refactor-only、不改行為/API/CLI）：
(1) src/server.mjs：把現有 module 頂層（createConfig/EventLog/Auth/PaawControl/BackupManager + async handler 閉包）整段收進 `export function createApp(overrides = {})`，回傳 { handler, config, saveConfig, PAAW_ROOT, BACKUP_DIR, EVENT_LOG_PATH, MAX_BACKUPS, events, logEvent, createSession, validateSession, login, startPaaw, stopPaaw, restartPaaw, healthCheckPaaw, upgradePaaw, getSystemHealth, getCurrentVersion, getGitInfo, getLatestVersion, getPaawProcess, listBackups, createBackup, restoreBackup, backupPath }。每個 dep 皆為既有 factory 形狀（ADR-003 的紅利），overrides 為選配注入（cfg/events/…）；省略即今日 env 衍生行為。入口改為 `const app = createApp();`，main guard 對 `app.handler` 建 createServer 並維持 `server.listen(config.host, …)` 原樣。保留既有 `export { BACKUP_REGEX… }` 與 cache-bust 契約（?case=N 重跑 entry → 重新執行 createApp，仍取得乾淨狀態）。
(2) src/ui/server.mjs：把 cmdUI 內 `(req,res)=>…` 主體抽成 `export function createUIHandler(deps)`，cmdUI() 只負責建 deps 與 `createServer(createUIHandler(deps))` + listen。pure refactor。
(3) 測試側：新增零依賴 harness（tests/helpers/inject.mjs）——以 EventEmitter 造 mock req（url/method/headers/socket.remoteAddress/on/removeListener/destroy）與 mock res（setHeader/writeHead/end 記錄，end 觸發 promise resolve），直接 `await app.handler(req,res)`；以 monkeypatch globalThis.fetch 取代「fake package server listen」。
(4) loopback 綁定保證（login-hardening 的 'listens on loopback only, not 0.0.0.0'）本質需真 listen，無法 in-process 化：移入 opt-in 網路套件，預設 skip（PAAW_E2E_ALLOW_LISTEN=1 才跑）；對應的設定面保證由 unit 的 DEFAULT_HOST / config.host 斷言承接。
- **後果**: 正面：5 檔 e2e 在禁 listen 沙箱全綠；不 spawn server 使測試更快且無孤兒進程 kill-switch 需求；handler 可被單獨驅動、斷言更確定（可精準注入 chunked/no-Content-Length 等）。負面/風險：去 socket 化弱化「真 binding loopback」網路層事實、真 HTTP 序列化/framing、EADDRINUSE、TCP backpressure 等保證——以 opt-in 網路套件 + unit config 斷言緩解；mock req/res 保真度差異以最小 mock + 斷言 raw 參數緩解。實作由 Developer (Priya) 執行，測試改寫由 Tester (Divya) 執行；Architect 提供施工圖與驗收條件。

## ADR-005: ADR-005: upgradePaaw stash 識別改用 git stash create sha（取代 list count 差值）；attemptRecover 改結構化判定
- **日期**: 2026-10-20
- **狀態**: Proposed
- **背景**: review 委員會連續三輪（HEAD~4..HEAD、HEAD~5..HEAD）對 src/server/paaw-control.mjs 的 stash 邏輯抓缺陷。根因：以「git 訊息字串比對 / stash list count 差值」推斷本次是否 stash，本質脆弱。具體缺陷：(1) 舊 stash 造成 count 基線偏移；(2) probe 失敗當 0，第一次失敗/第二次成功會誤判本次有 stash，可能 pop 掉別人的 stash；(3) 真實 git 錯誤（目錄壞掉/權限）被吞成「nothing to stash」→ audit 偽成功；(4) stash 成功但 list probe 失敗 → 本次 local changes 被隱性留在 stash；(5) attemptRecover 以 error === "Already running" 字串比對判定，訊息一改即壞。TASK-032/033/034 三輪未收斂，需一次定調。
- **決定**: 採 `git stash create` 為唯一 stash 識別接縫：
(1) 識別：執行 `git stash create` — 不進 stash list、成功時回傳 commit sha、無事可 stash 時回傳空字串。以 sha 非空作為「本次確實 stash」的唯一真實來源（single source of truth），完全取代 stash list 非空 / count 差值推斷。sha 為空 = 本次無 stash，直接略過還原。
(2) store：`git stash create` 產生的 commit 是 dangling（無 ref 指向，可能在 gc 後消失）。因此當 sha 非空時，緊接執行 `git stash store -m "paaw-upgrade-<ISO-TS>" <sha>` 把該 commit 登記進 stash list，保證跨 git pull 指令期間存活、且可供人工 `git stash list` 檢視。
(3) 還原：只針對該 sha — 優先用 `git stash apply <sha>`（非破壞性：apply 失敗或衝突時 stash entry 仍在、資料不遺失），成功且 apply 乾淨後才 `git stash drop <sha>` 清掉自己建的 entry；若 apply 回報衝突，保留 stash entry、server 保持 STOPPED 並大聲示警（安全優先於可用性）。
(4) 不採 `git stash push -m <unique-tag>`：push 會把本次變更直接推入共享 stash stack 頂端，辨識仍需解析 `git stash list` 找 tag（回到字串解析），且 push 失敗與 no-op 都以 throw/exit 表達、仍需訊息比對；create+store 提供 sha 這個穩定 handle，優於 tag 的字串匹配。
邊界處理：見 ADR 後果段的四情境表（無事可 stash / probe 失敗 / 衝突 / 還原失敗）。
attemptRecover 結構化：startPaaw 回傳物件新增 ok 之外的結構化欄位（已運行狀態以 boolean 旗標 + 穩定 error code 表達，而非靠字串），attemptRecover 改讀旗標/code 判定，杜絕 "Already running" 字串一改即壞。
refactor-only：不改對外 API/CLI、不改 upgradePaaw 回傳結構（仍 { ok, steps, warnings, recovered?, version?, git?, error? }），只換內部探測/判定機制。
- **後果**: 正面：(1) 徹底移除「list count 差值」與訊息字串推斷兩個脆弱點，舊 stash 基線偏移、probe 假 0、locale/git 版本差異皆不再誤判；(2) sha 為穩定 handle，apply/drop 精準作用於本次 commit，不可能誤 pop 他人 stash；(3) probe 失敗改為顯性 not-stashed（保守不還原）或 fail-loud，不再偽成功；(4) attemptRecover 不再依賴字串。
邊界四情境表：
- 無事可 stash：`git stash create` 回空字串 → stashed=false → 略過 apply/store，step note "nothing to stash"，ok:true。
- probe/create 本身失敗（真錯誤）：不再吞掉 → step ok:false，走既有外層 catch 復原路徑（server 拉回），或若發生在 pull 前則 abort+復原；不得標為 nothing to stash。
- store 成功但後續 pull 失敗：stash entry 已登記、sha 仍存活；走外層 catch 復原；還原步驟仍需在最終狀態嘗試 apply（或至少示警 local changes 留存於 stash@{N}）。
- 衝突（apply 回報 conflict）：保留 stash entry、server 保持 STOPPED、push warning + logEvent upgrade_failed，不 attemptRecover（不在 conflict marker 樹上開機）。
- 還原（drop）失敗：資料無損（entry 仍在），push warning 提示手動清理，回 ok:true 或 ok:false 依主流程成敗而定但必帶 warning。
成本/風險：`git stash create` 在極舊 git（<1.7.7）不存在 → 以 feature-detect（create 若 unavailable 則 fail-loud 而非靜默 fallback 到脆弱邏輯）。stash store 的 -m 訊息含時間戳，不參與比對，故 locale/格式無關。實作由 Developer (Priya) 執行，測試由 Tester (Divya) 補；Architect 提供施工圖。

