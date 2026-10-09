# HANDOVER — 交接狀態

> 生成：2026-10-08T23:28:54.526Z · 自動保鮮（task 變動即更新）· 下一步：**commit** — 9 個未提交檔案

## 1. 現在的狀態（currentState）

- Branch: `main` @ `26f996d`
- 未提交檔案: **9** ⚠️
  - M .paaw/HANDOVER.md
  -  M .paaw/coding-memory/conversations/coding.developer/active.json
  -  M .paaw/coding-memory/conversations/coding.em/active.json
  -  M .paaw/coding-memory/conversations/coding.handover/active.json
  -  D .paaw/coding-memory/conversations/coding.tester/active.json
  -  M .paaw/coding-memory/dispatch-log.jsonl
  -  M .paaw/handover-state.json
  -  M .paaw/release-unit-model.json
  - ?? .paaw/uploads/1791292477633-slferx.jpg
- 未 push commits: **0** ✅

## 2. 進行中的工作（workingPlan）

- **TASK-012** [pending] 更新 F20260918-002 文件：backupPath 防護重構後的 feature docs + mapping + runbook
  - pipeline: spec（pending）→ 下一動：run spec

## 3. 最近變更（changes）

- `26f996d` 2026-10-08 feat(ui): 全螢幕雙欄各半 — 左右各 50%，右欄活動記錄/server log 上下各半併滿視窗高
- `5482d71` 2026-10-08 feat(ui): 雙欄布局 — 活動記錄/PAAW log 移右側常駐側欄（sticky），操作不捲動就能看執行狀況
- `78ffe41` 2026-10-08 feat(semgrep): 偵測改存在檢查（瞬回）— 路徑有 semgrep 即綠燈，版本/實跑驗證背景補
- `1d7fa51` 2026-10-08 perf(semgrep): 偵測改背景執行 + UI 輪詢 — API 立即回 checking，慢機不再卡「檢查中」凍結整卡
- `876a8d8` 2026-10-08 perf(semgrep): 偵測不再卡線上版本檢查 — --disable-version-check 快取版 + 10 分鐘結果快取
- `163b367` 2026-10-08 fix(diag): semgrep 偵測失敗回應附 gateway process HOME/PATH — nohup/systemd 啟動環境不一致直接現形
- `8ec043f` 2026-10-08 feat(semgrep): pipx venv 直擊候選（~/.local/pipx/venvs/semgrep/bin）+ 偵測結果快取注入 PAAW
- `b739bbf` 2026-10-08 fix(diag): semgrep 偵測失敗必須帶原因 — diagnostics 逐候選交代（找不到/exit code+stderr tail/timeout）
- `1d209de` 2026-10-08 fix(root-cause): 啟動改純 node 直跑 paaw-server.mjs — tsx 在 devDependencies，--omit=dev 裝不到導致 Cannot find module .bin/tsx
- `12b65fd` 2026-10-08 fix(win): Windows 啟動/安裝地雷 — tsx 改走 dist/cli.mjs（node 直跑 JS entry，不碰 .bin/tsx.cmd）；npm install 走 cmd.exe /c（避 Node 2024 E

## 4. 待處理問題（issues）

✅ _無卡關_

## 5. 最近決策（decisions）

_(尚未有 ADR 記錄)_

## 6. 下一步（nextAction）

> **commit** — 9 個未提交檔案
```
M .paaw/HANDOVER.md
 M .paaw/coding-memory/conversations/coding.developer/active.json
 M .paaw/coding-memory/conversations/coding.em/active.json
 M .paaw/coding-memory/conversations/coding.handover/active.json
 D .paaw/coding-memory/conversations/coding.tester/active.json
```