# Technical Decisions

> 記錄架構和技術決策 (ADR format)。AI 在做決策時會自動追加。

## ADR-001: Release 0.2.1（#2026.09.19）就緒評估：附條件上線（conditional GO）
- **日期**: 2026-09-19
- **狀態**: Proposed
- **背景**: Release #2026.09.19（首發 baseline 起 26 commits）工具判定 NOT READY / HIGH risk，三訊號：changed feature no tests、test run stale 1 commit、234 files 變更。正式批次走 RR-20260918-1242-bd43（0.2.1，dc9c1a5→12ae4b8，reviewing）。
- **決定**: 建議「附條件上」（conditional GO）：(1) 工具 NOT READY 三訊號經交叉查證，兩項為假訊號 — 「gateway.mjs 無測試」是靜態分析盲區（tests/e2e/gateway-ui-csrf.test.mjs 以 spawn 真 gateway 覆蓋 16 案，feature map 已 mapping）；「stale 1 commit」的那個 commit 正是測試證據本身（12ae4b8 = RUN-20260918-005 落檔）。(2) 我於 2026-09-19 在 target commit 12ae4b8 重跑全套：RUN-20260919-001 TAP 官方總計 42/42 pass、exit 0；semgrep 重掃 ERROR 0 / WARNING 6（已全數 triage）；handover 已刷新至 HEAD。(3) 放行條件：人工 commit+push 13 個 .paaw 證據檔（含 1 未推 commit）→ UI 確認 RR checklist（建議已寫入：tests=pass / gates=waived / qa-records=pass / risk=waived）→ tag 0.2.1 → 24h 觀察窗（health + dashboard + 一次 update 演練）。
- **後果**: 老闆/人類最終決定。若放行：條件 C1–C3 須在 tag 0.2.1 前完成；24h 觀察窗內異常即按 DEPLOY.md 回滾。附帶發現兩個流程工具問題待 EM 開 issue：①release 證據產生器 risk gate 看不見 spawn-based e2e（險些造成假 NOT READY）；②test_run 計數器只數 TAP 頂層條目（42→17 假象）。

