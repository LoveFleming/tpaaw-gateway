---
id: decision-archaeology
name: 決策考古
version: 1.0.0
description: 回答「為什麼當初這樣設計」。交叉對照 DECISIONS.md、git log、code 現狀，重建決策時間線，找出決策背後的約束條件。被問設計緣由時使用。
category: handover
tags:
  - handover
  - decisions
  - git-history
userInputs:
  - id: _
    label: 你想考古的設計決策
    description: 描述你想了解的設計，越具體越好
    placeholder: "例：為什麼 tasks 用 JSON 檔而不是 SQLite？"
    required: true
    type: textarea
    multiline: true
---

# 決策考古

## Purpose
重建「當初為什麼這樣設計」的完整脈絡。設計決策的價值不在結論，在**當時的約束條件** — 不知道約束，新人會重複踩坑或誤改壞關鍵前提。

## Inputs
- **你想考古的設計決策** (`_`, required)：要追溯的設計/機制/選型

## Deterministic Script

### Tool Access
- `grep` / `glob` — 找相關 code 與文件段落
- `read_file` — `.paaw/DECISIONS.md`、`.paaw/ARCHITECTURE.md`
- `bash` — `git log --follow`、`git log -S "<關鍵字>"`（pickaxe 找引入點）
- `agent_memory_save` — 記住考古結果，下一代新人受益

### Execution Steps
1. **定位證據來源**（依可信度排序）
   - `DECISIONS.md` 有編號的決策記錄（最高：有人寫下理由）
   - `git log -S` 找該機制被引入的 commit + commit message + 當時的 issue/task 標題
   - code 註釋中的 TODO/FIXME/為什麼註解
2. **重建時間線**：什麼時候引入 → 中途改過幾次 → 每次改動的 trigger 是什麼
3. **萃取約束條件**：從證據歸納當時面對的限制（時間、相容性、效能、既有 bug）
4. **評估現狀**：這個決策的前提現在還成立嗎？（誠實說，不替舊決策護短）
5. **存檔**：把結論 `agent_memory_save`，格式 `decision-archaeology: <主題> → <一句話結論 + 證據位置>`

### Business Rules
- 證據分級：`[文件]` > `[commit]` > `[code 推斷]` — 推斷必須標明是推斷
- 找不到決策記錄時，明確說「沒有書面記錄，以下是從 git 歷史重建的最可能原因」

## Guardrails
- 只解釋既有決策，不建議要不要改
- 不修改 DECISIONS.md — 補記錄請走正式決策流程

## Output Contract
Markdown：`## 結論一句話` → `## 時間線`（表格：日期 | commit | 事件 | 證據等級）→ `## 當時的約束` → `## 前提現在還成立嗎` → `## 證據清單`。

## Validation
- 時間線每列都有 commit hash 或文件段落出處
- 「前提還成立嗎」區塊必須存在（不可省略）
