---
id: handover-pack
name: 交接包產出
version: 1.0.0
description: 產出或更新 .paaw/HANDOVER.md 完整交接包 — 對照 2026 handover checklist 逐項盤點，缺什麼補什麼。要產交接文件或交接審計時使用。
category: handover
tags:
  - handover
  - documentation
  - audit
userInputs:
  - id: mode
    label: 產出模式
    description: "full = 完整產出/覆寫 HANDOVER.md；audit = 只盤點缺漏不寫檔"
    placeholder: "full / audit（留空 = audit）"
    required: false
    type: text
    multiline: false
---

# 交接包產出

## Purpose
產出讓接手者達成 **operational independence（營運自主）** 的交接文件。標準：接手者不需要回頭問任何人就能維運與開發。依 2026 業界 handover checklist 九大項逐項盤點。

## Inputs
- **產出模式** (`mode`, optional)：`full` = 產出/更新 `.paaw/HANDOVER.md`；`audit`（預設）= 只產盤點報告不寫檔

## Deterministic Script

### Tool Access
- `read_file` — 既有 `.paaw/` 四大文件 + HANDOVER.md
- `bash` — `git log`（最近活躍度）、manifest 讀取
- `project_info` — feature map、tech stack
- `/api/workspace/write` — full 模式寫入 `.paaw/HANDOVER.md`

### Execution Steps — 九大項盤點
1. **專案概覽**：定位、使用者、核心 use case（來源：PROJECT.md）
2. **架構與技術棧**：模組圖、目錄結構導覽、關鍵依賴（來源：ARCHITECTURE.md + manifest）
3. **現況與進行中**：active features、進行中 task、最近開發方向（來源：feature map + git log）
4. **決策記錄**：DECISIONS.md 條目數 + 最近 3 條摘要；缺漏標紅
5. **部署與環境**：怎麼 build/deploy、env vars 清單（只列名稱不列值）、CI/CD 位置
6. **資料層**：schema 位置、migration 機制、備份方式
7. **安全相關**：認證機制位置、權限模型 — 指位置不貼 secret
8. **測試與品質**：測試怎麼跑、覆蓋狀況、已知技術債
9. **知識轉移**：上手指引連結、常見問題、escalation 對象（EM/Developer/Architect）

### Business Rules
- 每項標狀態：`✅ 文件齊` / `⚠️ 部分` / `❌ 缺` — audit 模式只產這張表 + 缺項補法建議
- full 模式：缺的項目寫「**❌ 尚未記錄 — 補法：...**」而不是留空或編造
- Secret（金鑰、密碼、token）**永不寫入** HANDOVER.md — 只寫「在哪裡取得」
- HANDOVER.md 開頭標記產生時間 + 依據的 commit hash（文件新鮮度可追蹤）

## Guardrails
- audit 模式絕不寫檔
- 不刪除 HANDOVER.md 既有內容 — 只增補與標注過時
- 涉及部署憑證的內容一律指位置，不貼值

## Output Contract
- audit 模式：九項狀態表 + Top 3 缺漏與補法 — 不寫檔
- full 模式：完整 HANDOVER.md（結構 = 九大項）+ 寫入確認 + bytes 數

## Validation
- 九大項每一項都有狀態標記（不可漏項）
- 全文 grep 無 secret 值（只有變數名與位置指引）
- 開頭有產生時間與 commit hash
