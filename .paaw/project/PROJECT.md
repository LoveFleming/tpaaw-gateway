# tpaaw-gateway

> 📄 Schema v2 · AI 區每次 CU 重寫 · 上次生成 2026-10-09 01:02 · User Remarks 由人維護

<!-- USER:START — 人的區（AI 絕不覆蓋） -->
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

PAAW Gateway 是一套以 Node.js 撰寫的 PAAW bootloader 與維運控制平面，負責在使用者機器上安裝、更新、啟停與守護 PAAW，適合需要本機／伺服器端管理 PAAW 生命週期的開發者與維運人員使用。

### 架構與模組

- 語言/框架：Node.js（單檔腳本導向，frameworks 欄位為空，無外部框架紀錄）
- 程式規模：約 93 個 functions、128 個 symbols
- 模組分佈（由 features 推導）：
  - `gateway.mjs`：單檔 bootloader，CLI（ui/start/update/upload/status）+ 本機網頁控制台（127.0.0.1:4290，12 條 API 路由）
    - staged 安裝管線（下載→驗證→解壓→定版）
    - PAAW 子程序監管（start/stop/restart + 健康檢查 + 自動回滾）
    - settings/semgrep 管理、log 查看
  - `src/server.mjs`：獨立守護者 HTTP server（port 4199，與 PAAW Server :4097 分離），含 Bearer token 認證與 RBAC、備份排程/還原、git pull 升級、JSONL 稽核軌跡、dashboard/version/users 等 13 支 API 與內嵌管理 UI

### 如何建置/跑/測

bash
npm run dev    # node gateway.mjs ui
npm start      # node gateway.mjs ui
npm test       # node --test --test-reporter=tap --test-reporter-destination=stdout "tests/**/*.test.mjs"
（其他建置步驟：資料待補）

### Feature 清單（表格：| Feature | 說明 | 檔案數 |）

| Feature | 說明 | 檔案數 |
| --- | --- | --- |
| F20261009-001 PAAW Gateway 啟動器與本機控制台：套包安裝更新、版本回滾與 PAAW 生命週期管理 | 單檔 Node bootloader（gateway.mjs），CLI + 本機網頁控制台（127.0.0.1:4290，12 條 API），負責安裝、更新、啟停 PAAW；含 staged 安裝管線、子程序監管與自動回滾、settings/semgrep 管理與 log 查看 | 1 |
| F20261009-002 PAAW Gateway 系統維運管理平台（認證・進程守護・備份・升級） | 單檔 Node HTTP server（src/server.mjs，port 4199），Bearer token 認證與 RBAC、PAAW Server 生命週期管理、tar.gz 備份排程與還原、git pull 升級流水線、JSONL 稽核軌跡、13 支 API 與內嵌管理 UI | 1 |

### 維運要點

- 測試現況：共 4 個測試檔（unit 1、e2e 3、integration 0），覆蓋率 50.0%
- 已定義 14 個 error codes
- 提醒：
  - 覆蓋率僅 50%，整合測試為 0，變更 staged 安裝管線或回滾邏輯時建議先補測試
  - 兩個服務埠需分開監看：Gateway 控制台 :4290、維運 server :4199、PAAW Server :4097
  - 維運平面（:4199）具有認證/RBAC 與備份/升級權限，需妥善保管 Bearer token；相關操作會記錄於 JSONL 稽核軌跡，可作為事件追查依據

### 最新決策

- ADR-002: RR-20260918-1242-bd43 複審：gates 改判 fail — F-01/F-02 修復未 commit，tag db2671c 會發佈未修版本
- ADR-001: Release 0.2.1（#2026.09.19）就緒評估：附條件上線（conditional GO）

<!-- AI:END -->
