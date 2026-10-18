# tpaaw-gateway

> 📄 Schema v2 · AI 區每次 CU 重寫 · 上次生成 2026-10-18 03:22 · User Remarks 由人維護

<!-- USER:START — 人的區（AI 絕不覆蓋） -->
## 📌 User Remarks

## 📌 User Remarks

## 📌 User Remarks

## 📌 User Remarks

## 📌 User Remarks

## 📌 User Remarks

# Project Overview

> 由 PAAW AI-Native IDE 自動生成。點擊「Initialize」掃描專案，或手動填寫。

**Name**: (auto-detect)
**Path**: (project root)

## 技術棧

(待補充)

## 啟動方式

(待補充)

## 專案結構

(待補充)

<!-- USER:END -->

<!-- AI:START — CU 自動生成區（每次重寫，人改會被覆蓋） -->
## 🤖 AI Overview
### 一句話定位
PAAW Gateway 是 PAAW 的自舉入口（bootloader），負責安裝、更新與執行 PAAW，並提供本機控制台與獨立於 PAAW Server 的維運管理平台，供使用者與維運人員操作。

### 架構與模組
- 框架：frameworks 欄位為空，未偵測到框架（資料待補）。
- 程式規模：147 functions、258 symbols、14 個測試檔、17 個 error codes。
- 模組分佈（由 features 推導）：
  - F20261009-002：獨立 PAAW 管理主控台，運行於 :4199，不依賴 PAAW Server（:4097）。薄入口 `src/server.mjs` 做 HTTP 路由分派與 auth guard，其餘職責委派給五個模組：config、events、auth+password、paaw-control、backup。提供登入、儀表板、健康檢查、版本、進程啟停/重啟、升級、備份管理、事件查詢與使用者列表等 API（7 檔案、13 APIs）。
  - F20261011-002：本機 :4290（PAAW_GW_PORT）控制台 HTTP server，入口 `src/ui/server.mjs`，前端為靜態 `ui/index.html`。五個模組：config、install、process、semgrep，彼此單向依賴、無循環；對外提供 `/api/*` 控制與查詢端點（5 檔案、12 APIs）。
  - F20261009-001：使用者機器上的 PAAW 自舉入口程式（bootloader），提供 status / update / upload / start / ui 等 CLI 指令，管理 `process.cwd()` 下的 `versions/`、`data/`、`current.json`、`logs/` 佈局，並以組合根（composition root）接線 config / install / process / semgrep / ui 等模組（1 檔案、0 APIs）。

### 如何建置/跑/測
建置：未提供 build script（資料待補）。

bash
# 開發 / 啟動（兩者相同）
npm run dev
npm start
# 實際指令：node gateway.mjs ui

# 測試
npm test
# 實際指令：node --test --test-reporter=tap --test-reporter-destination=stdout "tests/**/*.test.mjs"
### Feature 清單（表格：| Feature | 說明 | 檔案數 |）
| Feature | 說明 | 檔案數 |
|---|---|---|
| F20261009-002 PAAW Gateway 系統維運管理平台（認證・進程守護・備份・升級） | 獨立 PAAW 管理主控台，運行於 :4199，不依賴 PAAW Server（:4097）；薄入口 `src/server.mjs` 做 HTTP 路由分派與 auth guard，委派五模組：config、events、auth+password、paaw-control、backup。提供登入、儀表板、健康檢查、版本、進程啟停/重啟、升級、備份管理、事件查詢與使用者列表等 API（13 APIs）。 | 7 |
| F20261011-002 PAAW 本機控制台（安裝更新・啟停・設定・semgrep・日誌） | 本機 :4290（PAAW_GW_PORT）的 PAAW 控制台 HTTP server，入口 `src/ui/server.mjs`，前端為靜態 `ui/index.html`；五模組 config、install、process、semgrep，彼此單向依賴、無循環；提供 `/api/*` 控制與查詢端點（12 APIs）。 | 5 |
| F20261009-001 PAAW Gateway 啟動器 CLI（安裝・更新・啟動） | 使用者機器上的 PAAW 自舉入口程式（bootloader）：提供 status / update / upload / start / ui 等 CLI 指令，負責檢查並安裝 PAAW 版本、啟動或回滾 PAAW Server 子進程，並以組合根接線 config / install / process / semgrep / ui 等模組；管理 `process.cwd()` 下 `versions/`、`data/`、`current.json`、`logs/` 佈局。 | 1 |

### 維運要點
- 測試現況：共 14 個測試檔；unit 10、integration 0、contract 0、e2e 4。
- Error codes 現況：共 17 個。
- 給維運工程師的提醒：integration 與 contract 測試目前為 0，覆蓋狀態待補；e2e 測試為 4 個。另有 ADR-002 指出 gates 改判 fail、F-01/F-02 修復未 commit，tag db2671c 會發佈未修版本，部署前需留意版本與 tag 對應。

### 最新決策
- ADR-003: ADR-003: gateway.mjs / server.mjs 模組化重構（模組層拆分，入口檔名保留）
- ADR-002: RR-20260918-1242-bd43 複審：gates 改判 fail — F-01/F-02 修復未 commit，tag db2671c 會發佈未修版本
- ADR-001: Release 0.2.1（#2026.09.19）就緒評估：附條件上線（conditional GO）

<!-- AI:END -->
