---
name: 備份檔名路徑防護（backupPath CWE-22 hardening）
category: security
severity: info
tags: [backup, path-traversal, cwe-22, fail-closed]
summary: restore/backup 收到非法 filename 時的兩層防禦行為與預期回應 — literal ../ 在 URL 正規化即 404；percent-encoded/絕對路徑/非字串被 backupPath 白名單攔下回 200 {ok:false}，零副作用，管理介面行為不變
---

# 備份檔名路徑防護（backupPath）

**Feature**: F20260918-002（PAAW Gateway 系統維運管理平台）
**Code**: `src/server.mjs` — `backupPath()` :79、`listBackups()` :358、`createBackup()` :378、`restoreBackup()` :415、route `POST /api/backups/restore/<filename>` :649
**測試**: `tests/unit/backup.test.mjs`（backupPath 攻擊案例）、`tests/e2e/gateway-backup-auth.test.mjs`（restore 路由攻擊 e2e，TASK-011）

## 防護語義

所有備份檔名（來自 `readdir` 或 API）進入任何 fs 呼叫前，**必須**通過唯一出口 `backupPath(name)`：

1. **白名單**：`name` 非字串或不符合 `BACKUP_REGEX`（`^paaw-backup-\d{4}-\d{2}-\d{2}-\d{2}\.tar\.gz$`，YYYY-MM-DD-HH）→ 回 `null`（fail-closed，不 throw）
2. **Containment**：`resolve(BACKUP_DIR, name)` 後檢查 `p.startsWith(resolve(BACKUP_DIR) + sep)` → 逃出 BACKUP_DIR 回 `null`

`listBackups` / `createBackup` / `restoreBackup` 的 statSync / unlinkSync / tar 路徑全數走 `backupPath`；非法名稱在 list 被靜默 skip，在 create/restore 被原錯誤訊息拒絕。

## 症狀／預期行為（不要誤判為故障）

對 `POST /api/backups/restore/<filename>` 打入攻擊檔名時，**兩層防禦**的實際回應：

| 攻擊 payload | 行為 | 回應 |
|---|---|---|
| literal `../`、`..\`（如 `/api/backups/restore/../../etc/passwd`） | WHATWG URL 正規化把 pathname 改寫，**根本不命中 restore 路由** | **404** |
| percent-encoded 逃逸（`..%2f..%2fetc%2fpasswd`、`%2e%2e%2fconfig.json`） | 原樣抵達 `restoreBackup`，被 `backupPath` 白名單攔下 | **HTTP 200 + `{ok:false, error:"Invalid backup filename..."}`** |
| 絕對路徑注入（`//etc/paaw-backup-....tar.gz`） | 同上，格式合法但 containment/路由層攔下 | **200 `{ok:false}`** |
| 格式非法（缺 `-HH`、緊湊日期、雙副檔名、空檔名） | `BACKUP_REGEX` 不符 → `null` | **200 `{ok:false}`** |
| 非字串 filename（防禦深度：函式層被餵非字串） | `typeof` 檢查 → `null` | **200 `{ok:false}`** |

> 注意：本 server 的業務拒絕信封是 **HTTP 200 `{ok:false, error}`，不是 400**。admin 身分下攻擊檔名照樣被拒（防護與 RBAC 獨立）。

## 零副作用驗證（攻擊被拒後檢查）

- PAAW_ROOT 資料（`data/db.json`）未被覆寫
- BACKUP_DIR 內無任何新增檔案（含 safety backup）
- audit log（events.jsonl）零 `restore_*` 事件

## 合法流程不受影響

合法 admin restore：`ok:true`、資料真還原、safety backup 出現、事件落 log — 管理介面行為不變。

## 背景

- 修復脈絡：6 筆 CWE-22 findings（confidence LOW）→ TASK-010 縱深防禦重構（commit 114bfb2）→ TASK-011 攻擊測試 unit +8 / e2e +4（commit 599b8d5）→ TASK-013 殘留 4 筆誤報 nosemgrep 標註（commit 742c7c4）
- 歸零記錄：2026-09-19T09:17:46Z 重掃 ERROR 0 / WARNING 0 / INFO 0（`.paaw/security/scan-results.json`，filesScanned 含 src/server.mjs）
