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
| `npm start`（= `paaw-gateway start`） | 檢查更新 → 安裝 → 播種 → 啟動 → verify |
| `npm run update` | 只更新不啟動 |
| `npm run status` | current / installed / stable / data 現況 |

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

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `PAAW_PACKAGE_URL` | `http://localhost:4180` | package server（或寫 `gateway.json` 的 `packageServer`） |
| `PAAW_HOME` | process.cwd() | 佈局根目錄 |
| `PAAW_PORT` | 4097 | PAAW port |
| `PAAW_WS_PORT` | 4098 | PTY-WS port |
| `PAAW_AUTO_UPDATE=0` | on | 關閉自動更新（只跑 current） |
| `PAAW_SKIP_NPM_I=1` | - | 跳過 npm install（debug） |

Windows：不需要 symlink（current.json 是 pointer file）；emoji 自動降級 ASCII（WT_SESSION 偵測）。
