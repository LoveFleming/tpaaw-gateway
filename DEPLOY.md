# DEPLOY — tpaaw-gateway 部署與回滾

> 維運文檔（Release Request `ops` 項證據）｜ 2026-09-18 起草

## 元件與埠

- **Bootloader**（`gateway.mjs`）— port **4290**：安裝/更新/啟停 PAAW app
- **Gateway Admin**（`src/server.mjs`）— port **4199**：DevOps 管理平台（進程/git/備份/日誌）

## 部署方式（二選一）

### A. 手動 zip 上傳（2026-09-07 起，不需要 package server）

```bash
# 在 gateway 執行目錄（有 current.json 的目錄）
npm run upload -- paaw-x.y.z.zip   # zip 內 paaw-manifest.json 帶版本
```

### B. Package server 下載

```bash
PAAW_PACKAGE_URL=http://<package-server>:4180 npm run update
```

## 更新流程（內建防護）

1. 下載 → 串流算 sha256 驗證 → 解壓到 `versions/<v>.tmp` → 驗證後轉正
2. `data/` 播種只在首次，更新**永不覆蓋**使用者資料
3. `current.json` 原子寫入 — 只有新版本**健康檢查通過**才切換（啟動成功才寫）
4. ISS-001（2026-09-18）：啟動前偵測 port 佔用（防 EADDRINUSE 誤報上線）+ 通過健康檢查後 2.5s 夭折期複查

## 回滾（Rollback）

**舊版天然保留在 `versions/` — 回滾 = 改 current.json 指回舊版：**

```bash
# 1. 停掉目前 PAAW（gateway 管）
# 2. 把 current.json 的 version 指回上一版，例如：
#    { "version": "0.1.0", "switchedAt": "<now>" }
# 3. 重新 npm start — 舊版目錄還在，不用重下載
```

**資料回滾**（更新弄壞資料時）：Gateway Admin（4199）→ 備份頁 → 選備份還原
（restore 前自動建立 pre-restore 安全備份；API 見 `docs/api.md`）

## 緊急停機

```bash
# bootloader 管的 child：kill gateway 主進程即可（child 一併收）
# 完整停：停 gateway.mjs（4290）+ src/server.mjs（4199）兩個進程
```

## 健康檢查

- Bootloader 啟動驗證：`http://127.0.0.1:<PAAW_PORT>/` 健康回應 + child 存活
- Admin：`GET :4199/`（登入頁回應即活）

## 已知安全債（未修前列管）

- 6 個 semgrep WARNING（CWE-22 path traversal 類 audit）— 列管於 TASK-001 / TASK-002
  （人工 code review + F1/F10 版本驗證 + F7 CSRF 修復）
