# tpaaw-gateway — PAAW bootloader

像 OpenClaw 一樣安裝/更新 PAAW：`npm start` 一條命令 → 檢查版本 → 下載驗證 → 安裝 → 啟動。

## Feature 對照

| Feature | 說明 | 相關章節 |
|---------|------|----------|
| **F20260904-001 Gateway CLI Bootloader** | npm-start CLI：安裝、更新、啟動 bundle | 快速開始、更新流程 |
| **F20260904-002 Gateway Dashboard Server** | Web dashboard（src/server.mjs）：登入/session、config 管理 | UI 模式、docs/api.md |
| **F20260904-003 Gateway Backup & Restore** | 備份列表 / 建立 / 還原 | 備份還原 |

## 這個 repo 有兩個角色

| 角色 | 檔案 | Port | 用途 |
|---|---|---|---|
| **Bootloader**（本 README 主體） | `gateway.mjs` | UI 4290 | 安裝 / 更新 / 啟停 PAAW app（zip 發佈流程） |
| **Gateway Admin**（見[下方章節](#gateway-admin-管理平台4199)） | `src/server.mjs` | 4199 | 開發實例的 DevOps 管理平台：進程管理、git 升級、備份還原、事件日誌 |

完整 API 文件：[`docs/api.md`](docs/api.md)（22 個 endpoint，含 request/response 範例）。

## 快速開始（使用者視角）

```bash
mkdir my-paaw && cd my-paaw
npm install <tpaaw-gateway 來源>     # 或 git clone 後 npm install
PAAW_PACKAGE_URL=http://192.168.8.189:4180 npm start
```

之後每天 `npm start` 就是「有新版自動更新，沒有就直接跑」。

## 指令

| 指令 | 行為 |
|---|---|
| `npm start`（= `paaw-gateway start`） | 有 current 直接跑（**不檢查更新**）；首次無 current 才安裝 stable |
| `npm run update` | 手動更新到 stable 最新（安裝+驗證，不啟動） |
| `npm run status` | current / installed / stable / data 現況；有新版會提示 |

**自動更新預設關**（同 OpenClaw 安全預設）。要開：`PAAW_AUTO_UPDATE=1 npm start`，或在 gateway.json 寫 `"autoUpdate": true`。

## 目錄佈局（長在執行目錄，物理隔離）

```
my-paaw/
├─ versions/0.1.0/   PAAW code（舊版保留 = 天然 rollback）
├─ versions/0.2.0/
├─ data/             使用者資料 — 首次從 data-seed 播種，更新永不覆蓋
├─ current.json      指向「驗證過」的版本（啟動成功才寫）
└─ logs/             gateway.log
```

## 更新流程（staged install）

```
GET stable.json → semver 比對 → 下載（串流算 sha256）
→ 解壓 versions/<v>.tmp → 驗關鍵檔 → rename 定版
→ npm install --omit=dev（失敗 retry --omit=optional）
→ data/ 不存在才播種 data-seed
→ 啟動 → GET / 200 verify → 成功才寫 current.json
```

任何一步失敗：current.json 不動 → 自動回滾啟動上一版；壞版本目錄保留現場。

## 環境變數 / gateway.json

環境變數（優先）或執行目錄下的 `gateway.json`：

```json
{
  "packageServer": "http://192.168.8.189:4180",
  "paawHome": "/Users/me/my-paaw-data",
  "autoUpdate": false
}
```

| 來源 | 預設 | 說明 |
|---|---|---|
| `PAAW_PACKAGE_URL` / `packageServer` | `http://localhost:4180` | package server 位址 |
| `PAAW_HOME` / `paawHome` | process.cwd() | **安裝路徑**（versions/data/logs 長逼） |
| `PAAW_PORT` | 4097 | PAAW port |
| `PAAW_WS_PORT` | 4098 | PTY-WS port |
| `PAAW_AUTO_UPDATE=1` / `"autoUpdate": true` | off | 開啟自動更新 |
| `PAAW_SKIP_NPM_I=1` | - | 跳過 npm install（debug） |

Windows：不需要 symlink（current.json 是 pointer file）；emoji 自動降級 ASCII（WT_SESSION 偵測）。

## UI 模式（dashboard）

```bash
npm start        # = gateway ui → http://127.0.0.1:4290/
npm run run      # 直接跑 PAAW（不開 UI）
```

UI 可以：
- 看 PAAW 狀態（執行中/版本/開啟連結）、current / stable / 已安裝版本、data 播種狀態
- **自己決定**何時 ▶️啟動 / ⏹停止 / 🔁重啟 / 🔄更新（有新版會亮黃色徽章；更新裝完按重啟生效）
- 活動記錄面板（每 2 秒輪詢）

API（UI 同款，可 script 化）：`GET /api/status` `GET /api/log`、`POST /api/{start,stop,restart,update}`
Env：`PAAW_GW_PORT`（4290）、`PAAW_GW_HOST`（預設 127.0.0.1 僅本機）

注意：UI 模式下 PAAW 是 gateway 的 child — Ctrl+C gateway 會一併停 PAAW。

### 設定（UI 內建）

Dashboard「設定」卡可直接改這兩個值（存 `gateway.json`，即時生效、不必重啟 gateway）：
- **Package Server URL** — 清空回到預設 `http://localhost:4180`
- **PAAW Home 路徑** — 絕對路徑；改了之後 versions/data/logs 全部改長在新路徑（PAAW 執行中會要求先停止）

環境變數 `PAAW_PACKAGE_URL` / `PAAW_HOME` 仍優先；被 env 蓋過時 UI 顯示 🔒 提示。
API：`GET/POST /api/settings`（body `{"packageServer":"…","paawHome":"…"}`，空字串 = 清除）。

### 啟動後自動開瀏覽器

PAAW 啟動成功（UI 按 ▶️/🔁）自動開瀏覽器 tab 顯示 PAAW。
關閉：`PAAW_OPEN_BROWSER=0` 或 gateway.json `"openBrowser": false`。
跨平台：macOS `open` / Windows `start` / Linux `xdg-open`（headless 環境靜默跳過）。

---

## Gateway Admin 管理平台（:4199）

`src/server.mjs` 是**獨立於 bootloader 的 DevOps 管理平台**，管理的是「開發實例」（git repo 形態的 PAAW，即 `config.json` 的 `paawRoot`），與 bootloader 的 zip 安裝流程是兩條不同的路。

### 啟動

```bash
node src/server.mjs        # http://127.0.0.1:4199/
```

守護者角色：gateway 不依賴 PAAW Server 運行 —— PAAW 掛了它還活著，可以看事件、還原備份、重啟。`autoStartPaaw: true` 可在啟動時自動帶起 PAAW。

### 功能

- **登入認證** — 帳號在 `config.json` 的 `users[]`，登入換 Bearer token（24h 效期，記憶體 session）
- **進程管理** — start / stop / restart PAAW Server（health check 輪詢、crash 自動偵測）
- **版本升級** — `git stash → git pull → npm install → restart`，dashboard 可看 branch / commit / dirty / 落後數
- **備份 & 還原** — 見下節
- **事件日誌** — 所有操作（login、backup、restore、upgrade、crash）寫 JSONL audit trail
- **系統健康** — Node 記憶體、uptime、PAAW 進程狀態

### 備份 & 還原

- **備份內容**：`paawRoot` 下的 `data/` 與 `.paaw/` 兩個目錄，`tar czf` 打包
- **檔名固定格式**：`paaw-backup-YYYY-MM-DD-HH.tar.gz`（regex 驗證，防 path traversal）
- **排程**：`backupSchedule`（cron 語法，預設每天 03:00）；dashboard 也可手動建立
- **輪替**：保留 `maxBackups` 份（預設 7），超過自動刪最舊
- **還原**：停止 PAAW → **先自動建一份 safety 備份** → 解開 tar → 重啟 PAAW

### config.json

```json
{
  "port": 4199,
  "paawRoot": "../tPAAW",
  "paawServerCmd": "node packages/server/src/index.mjs",
  "paawServerPort": 4097,
  "backupDir": "../tPAAW/backups",
  "backupSchedule": "0 3 * * *",
  "maxBackups": 7,
  "autoStartPaaw": false,
  "users": [{ "id": "admin", "name": "Fleming", "role": "admin", "passwordHash": "changeme" }],
  "sessionSecret": "paaw-gateway-secret-change-me",
  "sessionMaxAge": 86400000
}
```

環境變數 `PAAW_CONFIG` / `PAAW_ROOT` / `PAAW_BACKUP_DIR` / `PAAW_EVENT_LOG` / `PAAW_MAX_BACKUPS` 可覆蓋（主要供測試隔離用）。完整欄位說明見 [`docs/api.md`](docs/api.md#3-configjson-admin-server-設定)。

## 測試

```bash
npm test    # node --test tests/**/*.test.mjs
```

| 類型 | 檔案 | 涵蓋 |
|---|---|---|
| Unit | `tests/unit/backup.test.mjs` | 備份建立 / 輪替 / 還原 / 檔名 regex 驗證 |
| E2E | `tests/e2e/gateway-backup-auth.test.mjs` | 登入認證流程、backup API、401 未授權防護 |

測試以 temp dir + 隨機 port 隔離，不會碰到開發者本機正在跑的 gateway（:4199）或 PAAW（:4097）。

## 安全注意事項

- `config.json` 目前**未進版控**（.gitignore 已排除），但仍請確認 repo 內不含真實密碼
- `users[].passwordHash` 欄位目前為**明文比對**（login 直接 `===` 比對）—— 若要對外開放 port，應先改為 hash + salt（已知技術債，見 issue tracker）
- Admin server 預設只聽本機；`sessionSecret` 部署前請換掉預設值
