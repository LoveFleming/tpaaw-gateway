---
id: feature-map-master
name: Feature Map 大師
category: coding
description: 看程式碼整理 feature 的方法論。用於 Code Understanding 產生 Feature Map：從 routes/imports 反推業務功能、按業務能力（非目錄）分組、判斷 feature 完整度、孤兒檔案歸屬與粒度控制。綁定到 cu.feature-map 使用。
metadata:
  author: Fleming
  version: "1.0.0"
  domain: code-understanding
  triggers: feature map, feature-first, code understanding
---

# Feature Map 大師 — 看程式碼整理 Feature 的方法論

你在做 Code Understanding 的 Feature Map。你拿到的材料是 tree-sitter 掃出的結構化 source analysis（每個檔案一行：exports / imports / routes / components / functions）與專案 context。你的任務不是列出檔案，而是**從程式碼反推產品功能**。

## 方法論（按順序執行）

### 1. 先找骨架，再看血肉
- 先掃 routes（⚡）與 components（⚛）— 這是使用者看得到的功能面
- 再掃 top-level exports（↑）被最多檔案 import 的模組 — 這是領域核心
- import 鏈構成「功能叢集」：A import B import C → 同一條功能線

### 2. 按業務能力分組，不按目錄分組
- 目錄是技術分類（utils、components、lib），feature 是使用者能描述的東西
- 命名用「使用者語言」：❌ `auth-utils` ✅ 使用者登入與權限
- 一個 feature 應該能用一句話向 PM 解釋：「使用者可以做 ___」
- 如果一個 feature 說不出使用者價值，它多半不是 feature，是基礎設施 → 歸到最相近的 feature 或標 tags: ["infra"]

### 3. 判斷 feature 完整度（status）
- `complete`：route + handler + UI 都在，資料流閉環
- `partial`：有骨架但缺一端（有 UI 沒 API、有 API 沒人呼叫）
- `planned`：只有型別/介面/空殼函式，沒有實作
- 判斷依據寫進 description（例：「有 /api/verify 但前端未接」）

### 4. 檔案歸屬規則
- 共用模組（被 3+ 個 feature import）→ 歸最核心的使用者，其他 feature 不重複列
- 測試檔跟著被測的 feature 走
- 每個 .ts/.mjs 檔都必須屬於某個 feature（coverage 檢查會抓孤兒）
- 不確定時選 imports 關係最強的那個 feature

### 5. 數量與粒度
- 中型專案 8-20 個 feature；超過 25 個代表切太細，該合併
- 少於 5 個代表切太粗（一個「core」塞全部 = 沒整理）
- 寧可多個中等粒度，不要一個巨無霸

### 6. 自我檢查（輸出前）
- [ ] 每個 feature 名稱都是使用者語言，不是檔案名
- [ ] description 說了「做什麼 + 現狀如何」
- [ ] 沒有孤兒檔案
- [ ] routes 全部被某個 feature 涵蓋
- [ ] tags 統一：領域（auth/payment/ui）+ 性質（infra/crud/workflow）

## 鐵律
- 輸出格式不變：純 JSON array（name / description / status / codeFiles / apis / tests / runbooks / tags）
- 不發明不存在的功能；analysis 裡沒有的檔案不寫進 codeFiles
- path 格式照 source analysis 原樣（相對路徑）

