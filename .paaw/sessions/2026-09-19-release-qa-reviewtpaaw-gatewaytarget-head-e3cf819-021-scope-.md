# Release 前 QA review（tpaaw-gateway，target HEAD = e3cf819）：

背景：上一版 0.2.1 已放出。本版 scope = last release 之後的 commits（含 TASK-006~009 品質補強：src/server.mjs 的 F-01/F-02 安全修復、tests/e2e/gateway-restart-rbac.test.

**日期**: 2026-09-19
**耗時**: 222s
**結果**: ✅ 成功
**分支**: `main`

## 任務

Release 前 QA review（tpaaw-gateway，target HEAD = e3cf819）：

背景：上一版 0.2.1 已放出。本版 scope = last release 之後的 commits（含 TASK-006~009 品質補強：src/server.mjs 的 F-01/F-02 安全修復、tests/e2e/gateway-restart-rbac.test.mjs、文件與 .paaw 證據收編）。證據已全綠：RUN-20260919-004（0 fail）、semgrep ERROR 0 / WARNING 6、verify PASS。

請執行：
1. 用 git log 確認 last release 後的變更清單，重點核對：
   a. ADR-002 曾指控「F-01/F-02 修復未 commit」— 確認 src/server.mjs 的修復與 tests/e2e/gateway-restart-rbac.test.mjs 現在已確實在 HEAD e3cf819 內（git log --oneline -- src/server.mjs + git show 確認關鍵修復存在）
   b. 6 個 WARNING（.paaw/security/scan-results.json）是否仍屬可列管出貨（此前已 triage）
2. 對本版 delta 做 code review 抽查（非全面重審 — 03:17 已做過複審，重點是「現在 commit 的內容 == 當時驗證的內容」）
3. 用 qa_record_save 落檔 verdict（pass/fail），target 寫「Release pre-flight QA — HEAD e3cf819」，issues 列發現的問題（無則空）
4. 回報 verdict 與關鍵確認點

## AI 操作步驟

1× project_edit
5× read_file
6× diff
1× glob
1× grep
1× qa_record_list
1× qa_record_save
1× action_log_add

## Git 變更分析

### Status
```
M .paaw/HANDOVER.md
 M .paaw/coding-memory/actions.jsonl
 M .paaw/handover-state.json
 M .paaw/release-unit-model.json
 M .paaw/security/scan-results.json
 M .paaw/test-runs/last.json
 M .paaw/verify-last.json
?? .paaw/coding-memory/dispatch-outputs/2026-09-19-06-53--developer.md
?? .paaw/coding-memory/qa-results.jsonl
?? .paaw/sessions/2026-09-19-release-commit-push-working-tree-3-commit-paaw-paaw-100-paaw.md
?? .paaw/staged-changes.json
?? .paaw/test-runs/runs/RUN-20260919-004.json
```

### Diff Stat
```
.paaw/HANDOVER.md                 |  58 +++++++++----------
 .paaw/coding-memory/actions.jsonl |   2 +
 .paaw/handover-state.json         | 119 ++++++++++++++++----------------------
 .paaw/release-unit-model.json     |  17 ++++--
 .paaw/security/scan-results.json  |  92 +----------------------------
 .paaw/test-runs/last.json         |  12 ++--
 .paaw/verify-last.json            |   8 +--
 7 files changed, 107 insertions(+), 201 deletions(-)
```

## AI 回覆

# Release Pre-flight QA Report — HEAD `e3cf819`

**Verdict: ✅ PASS**（已落檔 `qr-20260919-065817-cxsl`）— 內容層面可放行；tag 前剩一個流程收尾動作（見下方 minor）。

---

## 關鍵確認點

### 1a. ADR-002 指控「F-01/F-02 未 commit」— ✅ 已解除

用 reflog + 三向 diff 正面驗證（非僅看宣稱）：

| 項目 | 證據 |
|---|---|
| F-01（restart race） | commit `7092757`「fix(server): await confirmed process exit…」在 `db2671c`（0.2.1 tag 點）之後；diff vs `db2671c` 完整可見修復：`stopPaaw` 改為 exit-confirmed Promise（`proc.once("exit")` 才 resolve）+ in-flight dedupe（`stoppingPromise`）+ 5s SIGKILL 升級 + 10s failsafe 誠實回報 `ok:false`；`restartPaaw`/upgrade/restore 全改為先 `await` 確認退出，stop 失敗即 abort 不疊進程 |
| F-02（admin check） | delta diff 中 `backups/create`、`backups/restore`、`server/start|stop|restart`、`upgrade` 均掛 `if (currentUser.role !== "admin") → 403 "Admin only"`；`restoreBackup` 內建 fail-closed refuse-guard（`if (paawProcess)` 拒絕還原到活進程上） |
| 測試檔 | `tests/e2e/gateway-restart-rbac.test.mjs`（366 行，spawn 真 server + 三模式可控 stub child + 誠實合約 timing 斷言）已在 HEAD 內 — working tree 對 `src/`、`tests/` **零 diff**，HANDOVER 的 9 個未提交檔全是 `.paaw` 平台檔 |

### 1b. 6 個 WARNING — ✅ 維持可列管出貨

逐一讀碼複核，全部是 CWE-22 LOW-confidence 誤報：
- `server.mjs:338/365/389/390` → 全部在 `BACKUP_REGEX` 白名單驗證**之後**才使用，或來源為 hardcode `["data", ".paaw"]` 陣列，nosemgrep 註記齊全
- unit tests #7–19 實測覆蓋：traversal/injection 檔名拒絕、`createBackup` 產出檔名 invariant、restore 安全性備份 — 誤報判定有測試背書

### 2. Delta 抽查 — ✅ commit 內容 == 當時驗證內容

- Delta = `db2671c`→`e3cf819` 共 9 commits：1 個 fix（server.mjs）、8 個 `.paaw`/docs chore — 與宣稱 scope 一致
- `gateway.mjs` **零變更**（diff vs `db2671c` 無輸出）、tests/ 僅新增 rbac 一檔 — 無範圍外夾帶
- `RUN-20260919-004` 的 `headSha` 逐字 == `e3cf819fa0b3…`，TAP 底層 `# tests 52 / # pass 52 / # fail 0`、exit 0（19 是計數器只數頂層條目的已知假象，ADR-001 附帶發現②）
- semgrep 掃描時間（06:54:16Z）**晚於** e3cf819 commit（~06:53Z），掃描對象與 HEAD 內容逐檔 diff 一致 — 證據綁定無錯位

## Minor（1 項，不擋 verdict）

- ⚠️ **9 個 `.paaw` 證據檔待 commit**（含 RUN-20260919-004、scan-results.json），且 `e3cf819` 本身尚未 push（未 push: 1）。這是「先 commit 平台狀態 → 跑證據 → 再 commit 證據」流程的正常收尾，**但 tag 前必須完成 commit + push**，否則 ta

... (truncated)
