---
id: newcomer-onboarding
name: 新人上手指引
version: 1.0.0
description: 產出新人第一天到第一週的具體行動清單 — 環境建置、跑起來、驗證點、第一個切入 task。新工程師或新 AI agent 接手時使用。
category: handover
tags:
  - handover
  - onboarding
  - first-day
userInputs:
  - id: role
    label: 接手者角色
    description: 依角色調整指引深度
    placeholder: "human-engineer / ai-agent（留空 = 兩種都給）"
    required: false
    type: text
    multiline: false
---

# 新人上手指引

## Purpose
把「接手」從模糊的焦慮變成可執行的 checklist。目標：新人**第一天結束時能把專案跑起來並改一行 code 驗證**，第一週結束時能獨立接第一個 task。

## Inputs
- **接手者角色** (`role`, optional)：`human-engineer`（含 UI/權限指引）或 `ai-agent`（含 API/context 指引）；留空 = 兩種都給

## Deterministic Script

### Tool Access
- `read_file` — 讀 `.paaw/HANDOVER.md`、`.paaw/PROJECT.md`、README、package.json / requirements.txt 等 manifest
- `bash` — 驗證建置指令是否存在且可執行（`npm run build` 乾跑檢查 script 定義，不實際建置）
- `project_info` — feature map 找適合切入的 feature
- `agent_memory_save` — 記錄新人卡點

### Execution Steps
1. **環境建置清單**：從 manifest 抽出必要 steps（安裝、env vars、DB init、外部服務帳號）— 每項標注「文件有寫 / 要問人 / 沒文件」
2. **跑起來 + 驗證點**：不只給指令，還給「跑成功長什麼樣」（哪個 URL、哪個 log 行、哪個畫面）
3. **30 分鐘熟悉路線**：3-5 個關鍵檔案閱讀順序（entry point → config → 核心邏輯 → 測試），依賴關係排序
4. **第一個切入 task**：從 feature map 找出**範圍小、有測試、低風險**的 feature/task 作為起手式，說明為什麼選它
5. **AI agent 附加路線**（若含 ai-agent）：`.paaw/` 文件清單、可用的 API 端點、context 注入機制、guardrails 邊界
6. **卡點記錄**：提醒新人遇到文件沒寫的卡點就回報，存入 agent memory 供下一代新人

### Business Rules
- 驗證點必須可觀察（URL / log / 指令輸出），不接受「跑起來就對了」
- 文件沒寫的步驟如實標「沒文件」，不編造

## Guardrails
- 不實際執行建置/部署 — 只產出指引（建置交給新人自己跑，環境問題才能被發現）
- 不建議重構或改善 — 上手優先，改進之後再說

## Output Contract
Markdown checklist，`## 第一天` → `## 第一週` → `## 起手 task` → `## 已知卡點`。每項有 `[ ]` 可勾選格式與驗證方式。

## Validation
- 每個 setup step 都有驗證點或標注「沒文件」
- 起手 task 有具體的選擇理由
