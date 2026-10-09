# HANDOVER — 交接文件

> 生成時間：2026-10-09T01:54:38.561Z
> 這份文件是給下一位工程師（或 AI agent）的最小接手上下文。

## 1. 這是什麼專案？

# tpaaw-gateway

> 📄 Schema v2 · AI 區每次 CU 重寫 · 上次生成 2026-10-09 01:28 · User Remarks 由人維護

<!-- USER:START — 人的區（AI 絕不覆蓋） -->
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

## 2. 最近變更

### Git 歷史（最近 15 筆）
```
05eb862 release unit data
26f996d feat(ui): 全螢幕雙欄各半 — 左右各 50%，右欄活動記錄/server log 上下各半併滿視窗高
5482d71 feat(ui): 雙欄布局 — 活動記錄/PAAW log 移右側常駐側欄（sticky），操作不捲動就能看執行狀況
78ffe41 feat(semgrep): 偵測改存在檢查（瞬回）— 路徑有 semgrep 即綠燈，版本/實跑驗證背景補
1d7fa51 perf(semgrep): 偵測改背景執行 + UI 輪詢 — API 立即回 checking，慢機不再卡「檢查中」凍結整卡
876a8d8 perf(semgrep): 偵測不再卡線上版本檢查 — --disable-version-check 快取版 + 10 分鐘結果快取
163b367 fix(diag): semgrep 偵測失敗回應附 gateway process HOME/PATH — nohup/systemd 啟動環境不一致直接現形
8ec043f feat(semgrep): pipx venv 直擊候選（~/.local/pipx/venvs/semgrep/bin）+ 偵測結果快取注入 PAAW
b739bbf fix(diag): semgrep 偵測失敗必須帶原因 — diagnostics 逐候選交代（找不到/exit code+stderr tail/timeout）
1d209de fix(root-cause): 啟動改純 node 直跑 paaw-server.mjs — tsx 在 devDependencies，--omit=dev 裝不到導致 Cannot find module .bin/tsx
12b65fd fix(win): Windows 啟動/安裝地雷 — tsx 改走 dist/cli.mjs（node 直跑 JS entry，不碰 .bin/tsx.cmd）；npm install 走 cmd.exe /c（避 Node 2024 EINVAL）；zip entry 反斜線正規化（Windows 打包工具相容）
20fb995 fix(diag): 啟動失敗必須帶死因 — child stdio pipe+tee，exit code/spawn error/stderr tail 進 console+gateway.log+UI 活動記錄
621ac19 fix(ux): 安裝/上傳成功訊息印絕對路徑 + PAAW_HOME — home 指錯邊時看得出套件裝到哪
afa06d3 feat(semgrep): gateway UI 新增 semgrep 檢查/一鍵安裝/SEMGREP_PATH 設定
bebd0b4 chore(release): 結案 0.2.2 收編 — REL 台帳（baseline 錨點）+ RR 記錄 + coding-memory
```

## 3. 進行中的工作

_(沒有進行中的 task)_

## 4. 怎麼跑起來

```bash
npm run dev    # node gateway.mjs ui
npm run start    # node gateway.mjs ui
npm run test    # node --test --test-reporter=tap --test-reporter-destination=
```

## 5. Release 歷史（最近 5 筆）

- 2026-09-19T12:04:17.700Z — REL-20260919-2004-rrc23f — tpaaw-gateway 0.2.2 — 品質補強（F-01/F-02 安全修復）+ 證據收編

## 7. 接手指引

1. 讀完 1–3 節建立全貌
2. `git log` 看最近改動方向
3. 檢查第 5 節進行中 task，跟 EM 確認優先序
4. 有問題問 Handover AI 助理（它讀得到這份知識庫）