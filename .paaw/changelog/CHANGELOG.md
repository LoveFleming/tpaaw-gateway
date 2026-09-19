# Changelog

## 2026-09-19
### fixed
- 品質補強（TASK-008/009，F20260918-002）：src/server.mjs F-01 restart race（blocker，exit-confirmed stop 序列）+ F-02 備份端點 admin check 修復，QA 複審 NO-GO 解除；新增 gateway-restart-rbac e2e 10 案，全套 52/52（RUN-20260919-002）；兩 feature docs 與 mapping 更新（restore 端點補齊，實為 14 端點）

### fixed
- TASK-010（F20260918-002，CWE-22 縱深防禦重構，commit 114bfb2）：src/server.mjs 新增並 export `backupPath(name)` 統一安全出口 — BACKUP_REGEX 白名單 + `resolve(BACKUP_DIR, name)` 後目錄 containment check（startsWith root），非法／非字串一律回 null fail-closed；listBackups / createBackup / restoreBackup 的 statSync/join/unlinkSync 全數改走 backupPath（非法名稱 skip 或原錯誤訊息拒絕）；BACKUP_SOURCE_DIRS 模組頂層常數化（~L64）+ tar 改傳 relative(PAAW_ROOT, d)。API 回應結構與錯誤訊息不變，全套 pass。

### added
- TASK-011（F20260918-002，commit 599b8d5）：backupPath 攻擊測試 +12 案 — unit +8（tests/unit/backup.test.mjs：traversal payload、絕對路徑注入、非字串輸入、BACKUP_REGEX 格式違規、restoreBackup fail-closed）+ e2e +4（tests/e2e/gateway-backup-auth.test.mjs：restore 路由攻擊檔名兩層防禦 — literal `../` 於 URL 正規化即 404、percent-encoded 逃逸／絕對路徑／格式非法 → 200 {ok:false}、零副作用、合法 restore 不回歸），全套 52+ 綠。

### fixed
- TASK-013（F20260918-002，commit 742c7c4）：semgrep 殘留 4 筆 CWE-22 誤報以 nosemgrep 標註歸零（backupPath 內部 resolve 為 validator 本體、下游 fs 呼叫收的是驗證後輸出）。歸零記錄：2026-09-19T09:17:46Z 重掃 ERROR 0 / WARNING 0 / INFO 0（filesScanned 含 src/server.mjs，證據 .paaw/security/scan-results.json）。

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
