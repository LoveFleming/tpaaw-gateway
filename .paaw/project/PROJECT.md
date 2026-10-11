# tpaaw-gateway

> 📄 Schema v2 · AI 區每次 CU 重寫 · 上次生成 2026-10-10 14:41 · User Remarks 由人維護

<!-- USER:START — 人的區（AI 絕不覆蓋） -->
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
PAAW Gateway — install / update / run PAAW (bootloader)

### 架構與模組
框架：—
程式規模：93 functions / 128 symbols

### 如何建置/跑/測
- `npm run dev` — node gateway.mjs ui
- `npm run start` — node gateway.mjs ui
- `npm run test`

### Feature 清單
| Feature | 說明 | 檔案數 |
|---|---|---|
| [F20261009-001] PAAW 套包安裝更新與本機啟動控制台 | 這個 feature 是使用者機器上的 PAAW bootloader 與本機操作控制台（gateway.mjs）：負責 | 1 |
| [F20261009-002] PAAW Gateway 系統維運管理平台（認證・進程守護・備份・升級） | 獨立在 :4199 的 PAAW 守護管理平台（不依賴 PAAW Server :4097 運行），由單一 src/se | 1 |

### 維運要點
- 測試：4 檔（unit 1 / e2e 3）coverage —
- Error codes：15 個

### 最新決策
- ADR-002: RR-20260918-1242-bd43 複審：gates 改判 fail — F-01/F-02 修復未 commit，tag db2671c 會發佈未修版本
- ADR-001: Release 0.2.1（#2026.09.19）就緒評估：附條件上線（conditional GO）

<!-- AI:END -->
