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

