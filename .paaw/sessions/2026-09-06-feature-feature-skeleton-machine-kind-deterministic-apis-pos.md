# 請長肉這一個 feature（檔案歸屬數學已定，不可更改）。

--- FEATURE SKELETON (machine) ---
{
 "kind": "deterministic",
 "apis": [
  "POST /api/auth/login",
  "GET /api/auth/me",
  "POST /api/backups/create",
  "GET /api/back

**日期**: 2026-09-06
**耗時**: 44s
**結果**: ✅ 成功
**分支**: `main`

## 任務

請長肉這一個 feature（檔案歸屬數學已定，不可更改）。

--- FEATURE SKELETON (machine) ---
{
 "kind": "deterministic",
 "apis": [
  "POST /api/auth/login",
  "GET /api/auth/me",
  "POST /api/backups/create",
  "GET /api/backups",
  "GET /api/dashboard",
  "GET /api/events",
  "GET /api/health",
  "POST /api/server/restart",
  "POST /api/server/start",
  "POST /api/server/stop",
  "POST /api/upgrade",
  "GET /api/users",
  "GET /api/version"
 ],
 "entryCount": 13,
 "fileCount": 1,
 "FILE_LIST": [
  "src/server.mjs"
 ],
 "TESTS": [
  "tests/e2e/gateway-backup-auth.test.mjs"
 ],
 "note": "TESTS 是此 feature 的測試檔（機器映射）— 讀它們幫助寫 bizLogic，但它們不是 feature 的 code 檔",
 "SHARED_LAYER": []
}

用 read_file 實際讀程式碼（至少進入點檔 + 1-3 個核心檔），最後一輪輸出 JSON（name/description/bizLogic/tags）。

## AI 操作步驟

2× read_file

## Git 變更分析

### Status
```
M  README.md
A  docs/api.md
```

### Diff Stat
```
README.md   |  87 ++++++++++++++++++++
 docs/api.md | 270 ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
 2 files changed, 357 insertions(+)
```

## AI 回覆

```json
{
  "name": "PAAW Gateway 系統維運管理平台（認證・備份・升級・進程守護）",
  "description": "單檔 HTTP 伺服器（src/server.mjs，port 4199）構成的獨立管理平台，獨立於 PAAW Server（:4097）運行、扮演守護者角色。涵蓋 Bearer token 認證、PAAW Server 進程 start/stop/restart、tar.gz 備份與還原、git 升級流程、健康監控 dashboard、用戶列表與事件稽核日誌，並附帶管理 UI（public/index.html）。",
  "bizLogic": "認證：POST /api/auth/login 以 userId+password 明文比對 config.users 的 passwordHash 欄位，成功後發 randomUUID token 存 in-memory Map，超過 sessionMaxAge（預設 24h）自動失效；除 /api/auth/login、/api/health、/ 外所有路由都要求 Authorization: Bearer <token>（缺 'Bearer ' 前綴一律 401），admin-only 路由為 /api/upgrade、/api/server/start|stop|restart、/api/users（回 403 'Admin only'），其餘（backup、dashboard、events、version）只需合法 session。備份：以 execFileSync('tar', czf) 打包 PAAW_ROOT 下的 data/ 與 .paaw/，檔名強制符合 /^paaw-backup-\\d{4}-\\d{2}-\\d{2}-\\d{2}\\.tar\\.gz$/（BACKUP_REGEX 白名單，同時防還原時的路徑注入），保留 maxBackups（預設 7，env PAAW_MAX_BACKUPS 可覆蓋）筆、超出刪最舊；還原流程為停 PAAW → 先建 safety backup → tar xzf → 重啟。升級：固定六步 git stash → git pull origin <branch> → git stash pop → npm install --production → startPaaw → health check（fetch 127.0.0.1:4097/api/health），逐步結果回傳 steps 陣列。進程守護：spawn config.paawServerCmd（cwd=PAAW_ROOT、PORT=paawServerPort），stop 用 SIGTERM、5 秒後 SIGKILL 強殺，exit code≠0 標記 crashed 並累加 restartCount，Gateway 啟動時 autoStartPaaw≠false 會自動拉起 PAAW。稽核：logEvent 將 login/backup/upgrade/server 生命週期事件以 JSONL append 到 events.jsonl 並在記憶體保留最後 500 筆，GET /api/events?limit= 回尾端 N 筆（預設 50）。測試隔離慣例：PAAW_CONFIG/PAAW_ROOT/PAAW_BACKUP_DIR/PAAW_EVENT_LOG/PAAW_MAX_BACKUPS 環境 knob + main guard（import 時不 listen、不 spawn），E2E 據此對 throwaway config 與 temp dir 跑真子進程。",
  "tags": ["gateway", "auth", "session", "bearer-token", "backup", "restore", "tar-gz", "rotation", "upgrade", "git-pull", "process-management", "health-check", "audit-log", "admin", "ops", "dashboard", "node-http"]
}
```
