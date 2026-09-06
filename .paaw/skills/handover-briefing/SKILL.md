---
id: handover-briefing
name: 交接電梯簡報
version: 1.0.0
description: 產出 release unit 的分層交接簡報 — 30 秒電梯簡報、3 分鐘架構全貌、10 分鐘深入版。被問「這個專案是做什麼的」時使用。
category: handover
tags:
  - handover
  - briefing
  - onboarding
userInputs:
  - id: _
    label: 想了解的範圍（留空 = 完整簡報）
    description: 可指定只講某一部分，例如「只講資料流」或「只講前端」
    placeholder: "例：只講 API 層怎麼運作"
    required: false
    type: textarea
    multiline: true
---

# 交接電梯簡報

## Purpose
讓新工程師或新 AI agent 在最短時間建立專案全貌心智模型。依「由大到小」三層深度產出簡報，每個說法必須附證據出處。

## Inputs
- **想了解的範圍** (`_`, optional)：留空 = 完整三層簡報；有填 = 聚焦該範圍

## Deterministic Script

### Tool Access
- `read_file` — 讀 `.paaw/PROJECT.md`、`.paaw/ARCHITECTURE.md`、`.paaw/DECISIONS.md`
- `project_info` — feature map、檔案結構、tech stack
- `bash` — `git log --oneline -20` 確認最近開發方向

### Execution Steps
1. **收集事實**（先讀再講，不猜）
   - 讀 `.paaw/PROJECT.md` 取產品定位與使用者
   - 讀 `.paaw/ARCHITECTURE.md` 取系統邊界與資料流
   - 讀 feature map 取 active features 清單
   - `git log` 確認最近 20 個 commit 的實際開發方向
2. **組三層簡報**
   - **30 秒版**：一句話定位（這是什麼、給誰用、解決什麼）+ 技術棧一覧
   - **3 分鐘版**：架構全貌圖（文字版：模組 → 職責 → 資料流方向）+ top 5 active features
   - **10 分鐘版**：深入主題（依 `_` 指定或預設：資料流、認證、部署、對外整合）
3. **附證據**：每段標註來源（`PROJECT.md`、`DECISIONS.md #12`、`git log abc1234`）
4. **標註文件新鮮度**：文件最後更新時間 vs 最近 commit 時間 — 若文件落後超過 2 週，明確警告「文件可能過時，以 code 為準」

### Business Rules
- 文件和 code 矛盾時：**以 code 為準**，並把矛盾點列出來回報
- 缺文件的部分直接說「沒有文件，以下是從 code 推斷」— 不假裝有根據

## Guardrails
- 只讀不寫 — 不修改任何 `.paaw/` 文件或 code
- 不做推測性架構建議 — 簡報只描述現狀

## Output Contract
Markdown，結構固定：`## 30 秒版` → `## 3 分鐘版` → `## 10 分鐘版` → `## 證據與新鮮度`。每個段落尾端附 `[來源: ...]`。

## Validation
- 每一層至少 1 個來源標註
- 有明確的文件新鮮度判斷（不會漏掉過時警告）
