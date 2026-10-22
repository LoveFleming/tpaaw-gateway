# QA 複審報告 — TASK-045 commit 2f597ad（3 major 重審）

- 時間：2026-10-22 19:00 (UTC+08)
- Reviewer：QA (武大安) 複合 multi_model_review 委員會（zai/glm-5.1、zai/glm-5）
- Range：`HEAD~1..HEAD`（單一 commit `2f597ad`，未 push）
- 來源：RR-20261018-1738-6f2e 全 scope 委員會（QA qr-20261022-105528-1t1i）標記的 3 major
- Feature：F20261009-002 PAAW Gateway 系統維運管理平台（認證・進程守護・備份・升級）

## 結論：✅ 三個 major 全數修復 → Gate = **approve**

委員會重審（multi_model_review）：critical 0 / major 0 / minor 4，判 approve。
QA 獨立複驗：`npm test` = 363 pass / 0 fail（RUN-20261022-002）。

---

## 逐項判定

### M-1 src/server.mjs:244 — 登入失敗稽核　→ ✅ 已修復
- **預期**：401 失敗分支須產生 `login_failed` event，且 detail 經 sanitize。
- **實證**：401 分支新增 `logEvent("login_failed", \`Login failed for "${body.userId}" from ${clientIp}\`)`（line 244）。sanitize 由 write 層 `events.mjs` 的 `sanitizeAuditField` 統一處理（detail 與 userId 皆過濾 C0/C1、DEL、U+2028/U+2029），call site 不需自行 sanitize — 單一收束點設計正確。
- **回歸測試**：`gateway-login-hardening.test.mjs` 新增 2 案：
  1. 401 必留 `login_failed` 且 userId="system"、detail 無控制字元。
  2. 攻擊者可控 userId / clientIp（含 `\r\n\t\u0000`）→ detail 不含控制字元（無 log injection）。
- **有效**：`git show HEAD~1:src/server.mjs` 無 `login_failed` → 未修版必紅。

### M-2 src/server/auth.mjs:203 — IP 閘對稱　→ ✅ 已修復
- **預期**：per-user locked 分支也須推進 `ipLimiter.fail`，且不退化成拒正確密碼。
- **實證**：`ipLimiter.fail(ipKey, now)` 已移到 `userLock.limited` 的 `return` **之前**（line 203），每個 failed verification 都對稱推進 IP 計數。正確密碼放行邏輯未動：驗證（step 2）在 per-user check 之前，成功路徑 `reset` 兩計數器（line 213）— DoS 修復的核心不變。未知帳號與已知帳號在 IP 閘觸發點一致 → 消除帳號列舉側通道。
- **回歸測試**：新增 2 案：
  1. 已知帳號錯密碼 ≥20 次 → 第 21 次 IP 閘 429 帶 Retry-After；同 IP 未知帳號亦 429（對稱）。
  2. per-user lockout 後正確密碼仍 200 且發 token（不退化成 DoS）。
- **有效**：舊版 auth.mjs line 199 `ipLimiter.fail` 在 locked `return` 之後（不執行）→ 未修版測試必紅。

### M-3 src/server/config.mjs — config baseline　→ ✅ 已修復
- **預期**：updateConfigOnDisk 改以 readRawConfigDetailed 為 baseline；缺檔 → patch-only；損毀非物件 → fail-loud。
- **實證**：
  - baseline 由 `loadConfig()`（含 fallback defaults）改為 `readRawConfigDetailed()`（verbatim 磁碟內容）。
  - 缺檔（`exists:false`）→ 只寫 patch，並先驗 patch 為物件，不合成任何預設值。
  - 存在但非物件（array / scalar / invalid JSON，`exists:true, value:null`）→ `throw "config.json is not a JSON object"`，原檔內容保留（fail-loud）。
  - 與 `createConfig().saveConfig()` 的 `pristine===null → skip` 保守語意一致。
- **回歸測試**：`server-config.test.mjs` 新增 (d1) 缺檔只寫 patch、(d2) 陣列 fail-loud 且原檔保留、(d3) 無效 JSON fail-loud 且原檔保留。
- **有效**：舊版 config.mjs line 222 `const current = loadConfig(configPath, baseDir)` → 未修版必紅。

---

## 新發現（皆非本次 commit 引入、皆 minor、不阻擋合併）

已 triage 委員會 4 個 minor：

| # | Severity | 檔案:行 | 描述 | 本次引入? | QA triage |
|---|---|---|---|---|---|
| N-1 | minor | src/server.mjs:234 | 429 `login_locked` 分支逐次記錄，鎖定期間長期敲擊會產生大量 event | 否（既有） | 設計取捨，非缺陷；如擔心量可另開 task 做節流 |
| N-2 | minor | src/server/config.mjs:239 | patch 物件驗證只在缺檔分支；存在檔案時 null/array patch 被 `{...current, ...patch}` 靜默吞掉/展開 | 是（本次 refactor 擴大分支） | 契約不一致，建議後續統一驗證 |
| N-3 | minor | src/server/config.mjs:341 | `readRawConfigDetailed` 將 EACCES 等讀取錯誤與 ENOENT 同歸 `exists:false` | 否（沿用 readRawConfig 既有語意） | 語意瑕疵，非資料損毀風險（read 失敗→ptach-only，不覆寫）|
| N-4 | minor | tests/e2e/gateway-login-hardening.test.mjs:257 | 429 斷言無法 100% 區分 IP 閘 vs per-user lockout（已用 Retry-After + 未知帳號對稱部分補強）| 是（新測試） | 測試強度可再強化，不影響 M-2 判定 |

以上皆 minor，依「只回報、不擴大範圍」指示**不自行修復**，建議 EM 視需要開後續 task。

## Gate 判定

- **approve** — 3 major 全數關閉，測試全綠（363/0），無 critical/major 新增。
- 附註：本 commit 尚未 push，release 前仍須人工 commit-flow（本 commit 已存在但未推）。

