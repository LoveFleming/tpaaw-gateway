# Changelog

## 2026-09-19
### fixed
- TASK-008（critical，F20260918-002）：修復 src/server.mjs 兩個 QA review findings（2026-09 (1 new file) (3 modified)



### changed
- +2845 −661 lines across 12 files

### fixed
- TASK-009（critical，F20260918-002）：驗證 TASK-008 的 src/server.mjs 修復（F-01 restart ra (1 new file) (2 modified)

### changed
- +2886 −856 lines across 14 files

### fixed
- 品質補強：src/server.mjs F-01 restart race（blocker，exit-confirmed stop 序列）+ F-02 備份端點 admin check 修復，QA 複審 NO-GO 解除；新增 gateway-restart-rbac e2e 10 案，全套 52/52（RUN-20260919-002）；兩 feature docs 與 mapping 更新（restore 端點補齊，實為 14 端點）

## 2026-09-18
### fixed
- 修復 gateway.mjs F7 CSRF 防護（TASK-002 剩餘部分）：

背景：TASK-002 原本含 F1/F10 版本驗證 + F7 CSRF (1 modified)



> 由 PAAW AI-Native IDE 自動維護。每次 AI 完成任務後自動追加變更記錄。


### changed
- +696 −198 lines across 15 files

### fixed
- TASK-003：Release 前驗證（RR-20260918-1242），兩個目標：

【目標 1：F7 CSRF 修復無回歸】
gateway.mjs 工 (1 modified)

### changed
- +813 −199 lines across 18 files

### changed
- TASK-004：補 gateway.mjs 自動化測試（解 RR-20260918-1242 risk gate fail「HIGH：API 變更的 feat (1 new file)

### changed
- +826 −200 lines across 18 files

### fixed
- TASK-005：修 gateway.mjs 三個安全點（QA 人工審查 findings，release RR-20260918-1242 前）。先 read (1 new file) (5 modified)

### changed
- +902 −600 lines across 22 files

### fixed
- TASK-005 驗證輪：developer 已完成 4 個安全修復（gateway.mjs + ui/index.html working tree 未提交） (1 new file) (1 modified)

### changed
- +909 −600 lines across 22 files

### added
- Release 0.2.1 收尾（TASK-002 相關，專案 root /Users/steward/App/tpaaw-gateway）：
1. packa (1 modified)

### changed
- +29 −7 lines across 3 files

### changed
- Release RR-20260918-1242 最終驗證輪（0.2.1，專案 root /Users/steward/App/tpaaw-gateway）：
 (1 new file)

### changed
- +26 −9 lines across 4 files

### added
- Release 0.2.1（RR-20260918-1242）：security hardening（MAJ-001 manifest.version fail-closed、F7 CSRF Host/Origin gate、MED-001 GET Host gate、MIN-001 settings 1MB cap、UI esc 前移）、CSRF e2e 16 案新增、test script 釘 TAP reporter、版本 0.2.1。簽核證據 RUN-20260918-005：42/42。
