# Changelog

## 2026-10-22


### fixed
- 【目標】修復 review 委員會 major：login 的 hash 升級持久化會把 env 衍生欄位寫回 config.json。

- 【目標】修復 review 委員會 major：stopPaaw 完成/失敗不再寫 audit event，遺失 stop 稽核契約。
### changed
- 【目標】收斂 review 委員會全 scope 的 9 個 minor（跨三 feature），逐一修掉。

- 【目標】修 review 委員會第二輪 triage 出的 2 major + 3 minor（全在 TASK-041/043 引入的 config.
- 【目標】修全 scope 委員會標記的 3 個 major（皆屬 F20261009-002），一次到位修完，不逐項、不動 scope 外。
## 2026-10-21


### changed
- 【目標】修 review 委員會第七輪 triage 出的 3 真 major（全部在 src/server/paaw-control.

- 【目標】修 review 委員會第八輪 triage 出的 2 真 major + 3 minor（全部在 src/server/paaw-control.
- 【目標】修 review 委員會第九輪 triage 出的 1 major + 4 minor（src/server/paaw-control.
- 【目標】把你已完成但**尚未 commit** 的 TASK-040 改動收尾，產生一個新 commit（source + test，不含 .
## 2026-10-20


### fixed
- 【目標】修復 `src/server/paaw-control.

- 【目標】補完 `src/server/paaw-control.
- 【目標】把你已完成但**尚未 commit** 的 TASK-032 改動收尾，產生一個新 commit。
### removed
- 【目標】清理 review 委員會 code review 標記的 4 個 minor 問題（殘留 unused import + 過時錯誤訊息 + 稽核…

### changed
- 【目標】收斂 review 委員會第三輪的 4 個 minor（來源 report：.

- 【目標】TASK-033 未完成：你只改了 src/server.
- 【目標】收斂 review 委員會第四輪：1 major + 5 minor（來源 .
- 【目標】依 ADR-005（Architect 已寫入 .paaw/DECISIONS.
### added
- 【目標】收斂 review 委員會第六輪：1 major + 4 minor（來源 .

## 2026-10-19
### fixed
- ISS-008：管理平台（src/server.mjs，:4199）的 readBody 對 request body 無大小上限，遠端（已登入）可藉超大 body 造成 DoS。已將 admin API 的 readBody 上限釘在 64KB，超限即回 413 並中止讀取；新增 tests/e2e/gateway-body-limit.test.mjs 覆蓋（commit 91a4fee）。

- 【目標】修復 login 帳號鎖死 DoS：per-IP 與 per-user rate limiter 門檻分離，且鎖定期不得阻斷合法憑證流程。
- 【目標】修復 upgradePaaw 的正式機升級安裝了 devDependencies：把 npm install 改為生產安裝 flags，與…
- 【目標】修復 src/server.mjs 的 readBody：把「client abort / 網路錯誤」與「body 超過上限 (413 Payload…
### added
- ADR-004 施工圖 A 節改動 1：把 src/server.mjs 的 module 頂層組裝（createConfig/EventLog/Auth/PaawControl/BackupManager + async handler 閉包）抽進 `export function createApp(overrides = {})`，回傳 handler 與各 dep 供測試直接注入；入口改為 `const app = createApp()`，行為/API/CLI 不變（refactor-only）。
- ADR-004 施工圖 A 節改動 2：把 src/ui/server.mjs 中 cmdUI() 內的 `http.createServer` handler 主體抽成 `export function createUIHandler(deps)`，cmdUI() 只負責建 deps 與 `createServer(createUIHandler(deps))` + listen；F7 CSRF Host 白名單與 Origin 檢查逐字保留，HOST_WHITELIST 改由 deps.UI_HOST 推導以便測試注入不同 host（commit 580a017，純重構）。
- ADR-004 施工圖 B/C 節：新增零依賴 in-process 測試 harness（tests/helpers/inject.mjs，以 EventEmitter 造 mock req/res 直接驅動 handler），並把 5 檔 spawn-server e2e 改寫為 in-process（不 spawn、不 bind socket）：gateway-backup-auth.test.mjs、gateway-body-limit、gateway-login-hardening、gateway-restart-rbac、gateway-ui-csrf；另新增 opt-in 網路套件 gateway bind host 測試（真 socket，預設 skip，PAAW_E2E_ALLOW_LISTEN=1 才跑）以保留 loopback 綁定保證（commit 424be84、ab38683、014c71f）。

### changed
- 把 tests/e2e/gateway-ui-csrf.test.mjs 從「spawn 真 gateway + net.listen + fake package server listen + 系統 temp」改為 in-process（不 spawn、不 listen）：改以 createUIHandler(deps) / createApp() 注入 handler，並以 monkeypatch globalThis.fetch 取代 fake package server，使該檔在禁 socket 沙箱內全綠（commit ab38683）。

### changed
- 【目標】清除 .paaw/changelog/CHANGELOG.md 的 review board major 污染，整理成乾淨可讀的 changelog。
 (1 new file)

### changed
- +385 −5 lines across 5 files

## 2026-10-18
### fixed
- 修復 tests/unit/install.test.mjs 的 env 污染 / temp 殘留 / 清理斷言不足問題：記錄 PAAW_HOME 原始值（可能 undefined）並以 module 級 after() 還原（不存在則 delete，不還原成字串 "undefined"），跑完移除 top-level host temp dir；另補上骨架驗證失敗時半成品留在 versions/<ver>.tmp 的實際狀態斷言（commit 670b14f，來源 review board）。
- 修復 tests/unit/lib-config.test.mjs 的 realpath 正規化、ESM cache 累積、process.chdir 未還原問題：getHome 斷言改以 realpath 正規化，afterEach 還原 cwd（commit 2771c40）。
- 修復 tests/unit/semgrep.test.mjs 的 HOME/PATH/SEMGREP_PATH/PIPX_HOME env 覆寫不還原問題：測試內 snapshot 並於收尾還原被覆寫的環境變數（commit 8980569，來源 review MAJOR-3）。
- 修復 tests/unit/paaw-control.test.mjs 的 sleep 300 跨平台 flake 問題：paawServerCmd 原指向外部 "sleep 300"（Windows 無此指令），改用 process.execPath + '-e setTimeout(()=>{},300000)'，跨平台一致且 script 不含空白（符合 startPaaw 的 split(" ") 拆解），不改斷言語意（commit e2a1144，來源 review board 20261018-114641 MINOR）。

### added
- 補 F20261009-001（PAAW Gateway 啟動器 CLI，gateway.mjs）的測試覆蓋 — 該 feature 先前唯一無測試者：新增 tests/e2e/gateway-cli.test.mjs，以 spawn(process.execPath) 子進程觀察 stdout/stderr/exit code，覆蓋 status（空 PAAW_HOME + 不可達 package server）、未知指令、upload 缺參、upload 不存在檔等不需 listen TCP 的路徑，全程 temp dir 隔離並帶 timeout kill 防孤兒進程（commit 9f71bc9）。
- 修掉 review board 報告 `.paaw/review-board/20261018-114641-HEAD_1..HEAD.md` 中剩餘的 minor findings：tests/unit/lib-config.test.mjs 與 tests/unit/process.test.mjs 修補（commit 5e214d4）。

## 2026-10-11
### changed
- refactor(server): split `src/server.mjs` into thin entry + 5 modules（ADR-003 P1）— 抽出 `src/server/{auth,backup,config,events,paaw-control}.mjs`，`server.mjs` 由 841 行瘦身為薄入口；行為與 API 不變，測試全綠（+734 −792，7 檔）。
- refactor(gateway): ADR-003 P2 — 將 gateway.mjs 核心職責拆出為 src/lib/{config,install,process}.mjs 三個模組；gateway.mjs 保留原檔名與 CLI 行為（package.json bin），純重構不改外部行為。
- refactor(gateway): ADR-003 P3（最後一期）— 將 gateway.mjs 周邊職責拆出：`src/lib/semgrep.mjs`（semgrep 偵測／一鍵安裝，jobLog 以參數注入切斷循環依賴）與 `src/ui/server.mjs`（本機控制台 HTTP server，CSRF/Host gate + 靜態 UI + job 執行）。gateway.mjs 由 721 行瘦身為 181 行純 CLI 入口（argv 分派 + cmdStatus/cmdStart/cmdUpdate/safeUpdate）；純重構不改行為／CLI／API，npm test 65/65 全綠。
- TASK-012 結案（docs，F20261009-002 前身 F20260918-002）：CWE-22 防護文件三方同步，並修復 ADR-003 P1 造成的文件過時。(1) feature docs：F20261009-002 補上 backupPath 防護語義（BACKUP_REGEX 白名單 + resolve containment、fail-closed 回 null）、修復動機（6 筆 CWE-22 confidence LOW → 以縱深防禦取代 nosemgrep 降噪）、測試清單與歸零記錄（findings 空陣列，scannedAt 2026-09-19T10:41:13.970Z）。(2) feature mapping：tests 補 tests/unit/backup.test.mjs、apis 補 POST /api/backups/restore/&lt;filename&gt;（13→14）、runbooks 掛 backup-path-protection.md、codeFiles 對齊 ADR-003 模組拆分（server.mjs + 5 子模組）。(3) runbook：程式碼位置由 src/server.mjs（:79/:358/:415/:649）更正為 src/server/backup.mjs（:55/:62/:119）+ 入口 route :205，並記錄 ADR-003 P1 模組搬遷與 feature ID 重生成（F20260918-002 → F20261009-002）。npm test 65/65 全綠（commit 460fc6c）。

### fixed
- fix(security): gateway auth 硬化 — bcryptjs 雜湊密碼、以 dummy-hash 對未知帳號做 timing-safe 驗證、per-user + per-IP 登入 rate limit/lockout（429 + Retry-After）、登入一律統一 401（避免帳號列舉）、fail-closed 啟動檢查、移除預設 change_me 憑證；server.listen 預設綁 127.0.0.1（可經 config.host / PAAW_GATEWAY_HOST 覆寫）（commit 4fc5e58，TASK-018/ISS-002、TASK-019/ISS-006）。
- fix(semgrep): 將 timeoutMs/extraArgs 傳入 semgrepVersion，使版本偵測的 fast path 得以生效（commit bed7571）。

### added
- test(unit): 為 lib 與 server 的 config/install/process/semgrep/events/paaw-control 補齊 unit 測試（commit de7b7ce）。

## 2026-09-19
### fixed
- 品質補強（TASK-008/009，F20260918-002）：src/server.mjs F-01 restart race（blocker，exit-confirmed stop 序列）+ F-02 備份端點 admin check 修復，QA 複審 NO-GO 解除；新增 gateway-restart-rbac e2e 10 案，全套 52/52（RUN-20260919-002）；兩 feature docs 與 mapping 更新（restore 端點補齊，實為 14 端點）。
- TASK-010（F20260918-002，CWE-22 縱深防禦重構，commit 114bfb2）：src/server.mjs 新增並 export `backupPath(name)` 統一安全出口 — BACKUP_REGEX 白名單 + `resolve(BACKUP_DIR, name)` 後目錄 containment check（startsWith root），非法／非字串一律回 null fail-closed；listBackups / createBackup / restoreBackup 的 statSync/join/unlinkSync 全數改走 backupPath（非法名稱 skip 或原錯誤訊息拒絕）；BACKUP_SOURCE_DIRS 模組頂層常數化（~L64）+ tar 改傳 relative(PAAW_ROOT, d)。API 回應結構與錯誤訊息不變，全套 pass。
- TASK-013（F20260918-002，commit 742c7c4）：semgrep 殘留 4 筆 CWE-22 誤報以 nosemgrep 標註歸零（backupPath 內部 resolve 為 validator 本體、下游 fs 呼叫收的是驗證後輸出）。歸零記錄：2026-09-19T09:17:46Z 重掃 ERROR 0 / WARNING 0 / INFO 0（filesScanned 含 src/server.mjs，證據 .paaw/security/scan-results.json）。

### added
- TASK-011（F20260918-002，commit 599b8d5）：backupPath 攻擊測試 +12 案 — unit +8（tests/unit/backup.test.mjs：traversal payload、絕對路徑注入、非字串輸入、BACKUP_REGEX 格式違規、restoreBackup fail-closed）+ e2e +4（tests/e2e/gateway-backup-auth.test.mjs：restore 路由攻擊檔名兩層防禦 — literal `../` 於 URL 正規化即 404、percent-encoded 逃逸／絕對路徑／格式非法 → 200 {ok:false}、零副作用、合法 restore 不回歸），全套 52+ 綠。
- TASK-012 重派（前次派工回報成功但零產出 — 這次交付清單逐項可驗）。專案 root：/Users/steward/App/tpaaw-gateway。

## 2026-09-18
### fixed
- 修復 gateway.mjs F7 CSRF 防護（TASK-002 剩餘部分）：背景為 TASK-002 原本含 F1/F10 版本驗證 + F7 CSRF 防護，本次補齊 F7 部分。

---

> 由 PAAW AI-Native IDE 自動維護。每次 AI 完成任務後自動追加變更記錄。
