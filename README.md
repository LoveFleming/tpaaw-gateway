# tpaaw-gateway

PAAW Gateway — 獨立的 PAAW DevOps 管理平台

## 功能

- 📊 **Dashboard** — 系統狀態、PAAW Server 管理（Start/Stop/Restart）
- 📦 **Version** — 版本檢查、一鍵升級（git pull + npm install + restart）
- 💾 **Backup** — 資料備份與還原
- 📋 **Event Log** — 所有操作的 audit trail
- 👥 **Users** — 用戶管理（admin/developer/viewer）

## 架構

```
:4199  PAAW Gateway（獨立 process，永遠活著）
:4097  PAAW Server（可以被 Gateway 管理：升級、重啟、備份）
```

Gateway 不依賴 PAAW Server 運行 — Gateway 是守護者。

## 安裝

```bash
cd tpaaw-gateway
npm install
node src/server.mjs
```

打開 http://localhost:4199

預設帳號：`admin` / `changeme`

## 設定

編輯 `config.json`：

| 欄位 | 說明 |
|------|------|
| `port` | Gateway port（預設 4199） |
| `paawRoot` | PAAW repo 的路徑 |
| `paawServerCmd` | 啟動 PAAW Server 的指令 |
| `paawServerPort` | PAAW Server 的 port |
| `backupDir` | 備份檔存放路徑 |
| `maxBackups` | 保留幾份備份 |
| `autoStartPaaw` | Gateway 啟動時是否自動啟動 PAAW Server |
