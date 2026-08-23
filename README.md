# tpaaw-gateway — PAAW bootloader

像 OpenClaw 一樣安裝/更新 PAAW：`npm start` 一條命令 → 檢查版本 → 下載驗證 → 安裝 → 啟動。

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
