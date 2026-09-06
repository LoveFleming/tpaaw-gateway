---
id: logging-error-codes
category: coding
name: Logging & Error Codes
description: "AI Software Factory 統一的 logging 與 error code 寫碼標準。所有 Orchestrator / Node / Framework / service 層級的新 code 皆須遵循：結構化 log key-value、分級 log level、PAAW Error Code Rules v1（{CODE_CLASS}_{AREA}_{FAMILY}_{DETAIL}）、Exception Flow 保留原則。適用任何語言/框架。"
license: internal
metadata:
  version: 1.1.0
  author: AI Software Factory / Fleming
  source: data/factory-standards/error-code-rules-v1.json (2026-04-03) + secondsky/claude-skills api-error-handling (MIT) + industry structured-logging standards
  keywords:
    - logging
    - structured logging
    - error code
    - error handling
    - errorType
    - http status mapping
    - exception flow
allowed-tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
---

# Logging & Error Codes

## Purpose

**讓每一行程式碼的 log 與 error code 具有「可被定位、可被聚合、可被自動處理」的品質。**
這不是寫給人看的排版規則，而是寫給「未來的維護者（含 AI）」的營運接口：
- 好的 **error code** → 錯誤可以跨 service 被唯一識別、查 runbook、自動統計
- 好的 **log** → 錯誤發生時，靠 log 就能還原現場，不用盲猜

> 原則：**不要想「log 是給人看的」，要想「log 是給未來的 ops 跟 AI 讀的」。**

## When to Use This Skill

套用在**任何**新寫 / 修改的 code，所有語言框架皆適用：
- API route / controller / middleware
- Orchestrator 流程協調
- Node 本體
- Framework / boot / startup
- service / 資料庫層

## Error Code Rules（PAAW Error Code Rules v1）

PAAW 已定稿的自家標準（`data/factory-standards/error-code-rules-v1.json`）。**新 code 一律遵循，不要自創另一套。**

### 1. ErrorType → HTTP status 對應

決定 HTTP status 與 runtime 行為：

| ErrorType | HTTP |
|-----------|------|
| VALIDATION | 400 |
| UNAUTHENTICATED | 401 |
| FORBIDDEN | 403 |
| NOT_FOUND | 404 |
| BIZ | 409 |
| DEPENDENCY | 502 |
| TIMEOUT | 504 |
| SYSTEM | 500 |

### 2. ErrorCode 命名格式

統一：`{CODE_CLASS}_{AREA}_{FAMILY}_{DETAIL}`

範例：
- `BIZ_NODE_LOT_TOOL_MATCH_LOT_TOOL_MISMATCH`
- `EXT_NODE_MES_QUERY_TIMEOUT`
- `SYS_ORCH_STEP_RESULT_MISSING`
- `SYS_FW_BOOT_CONFIG_MISSING`
- `SYS_CTRL_AUTH_TOKEN_MISSING`

### 3. CODE_CLASS（診斷分類）

只能 `SYS | BIZ | EXT`：
- **SYS**：內部系統、framework、config、mapping、boot/startup 問題
- **BIZ**：已內化成業務語意的拒絕
- **EXT**：外部依賴的非商業邏輯問題

### 4. AREA（錯誤發生層）

只能 `CTRL | ORCH | NODE | FW`（**service 不列入 AREA**）：
- **CTRL**：API boundary / controller
- **ORCH**：orchestrator 流程協調
- **NODE**：node 本體
- **FW**：framework / boot / startup

### 5. FAMILY（能力族群）

穩定、可聚合，**不是 class 名**：

| AREA | FAMILY |
|------|--------|
| CTRL | REQUEST / AUTH / QUERY / HEADER / IDEMPOTENCY |
| ORCH | PRECHECK / FLOW / STATE / COMPENSATION / APPROVAL |
| NODE | LOT_QUERY / LOT_TOOL_MATCH / RECIPE_CHECK / MES_QUERY / RESPONSE_MAP |
| FW | BOOT / INIT / STARTUP / CONTRACT / CONFIG / REGISTRY / OBSERVABILITY |

### 6. DETAIL（核心原因）

只放最核心原因，短、準、穩定。例如：`REQUEST_BODY_INVALID`、`AUTH_TOKEN_MISSING`、`LOT_NOT_FOUND`、`LOT_TOOL_MISMATCH`、`PRECHECK_FAILED`、`TIMEOUT`、`BAD_RESPONSE`、`CONFIG_MISSING`、`CONTRACT_VALIDATION_FAILED`

### 7. 判定順序

1. 先決定 ErrorType
2. 再決定 CODE_CLASS
3. 再決定 AREA
4. 再選 FAMILY
5. 最後填 DETAIL

### 8. 命名風格

- 一律**大寫 snake case**
- FAMILY 要穩定，不可亂取長句
- DETAIL 只放核心原因
- 不是這層造成的錯，**不要亂改 AREA**
- 工具型 node 通常不是 BIZ，多半是 `SYS_NODE_*` 或 `EXT_NODE_*`

### 9. Boot / Init / Startup 固定規則

framework 啟動期固定用 `SYS_FW_BOOT_*`、`SYS_FW_INIT_*`、`SYS_FW_STARTUP_*`：
- `SYS_FW_BOOT_CONFIG_MISSING`
- `SYS_FW_INIT_NODE_REGISTRY_FAILED`
- `SYS_FW_STARTUP_HEALTHCHECK_REGISTRATION_FAILED`

### 10. Exception Flow 最重要原則

**不是你這層造成的錯，就保留原本的 errorType 和 errorCode。**
- node 丟最準的錯
- orchestrator 只在自己真的出錯時才產生 ORCH 錯
- controller advice 只做 `ErrorType → HttpStatus` mapping

## Logging Practices

如何寫 log（詳細範例見 `references/logging-practices.md`）。摘要：

- **核心哲學**：每一行 log 要能回答「what / when / which request / what context」四問
- **五級標準**：`ERROR / WARN / INFO / DEBUG / TRACE`，別把非 error 塞成 error（告警疲勞）
- **結構化 key-value**（JSON），不要只有自由文字 — AI 才 parse 得動
- **correlation ID 必帶**：requestId 在 boundary 產生、往下傳，log 每條都要有（沒有 = 無法跨 service 追蹤 = reject）
- **log level 分級**：debug / info / warn / error，別全塞 error
- **必帶 context**：requestId / traceId / 業務 key，讓同一次請求可串起來
- **error log 必帶 errorCode + errorType + 可補救方向**
- **不要 log 機密**：密碼、token、個人資料 — 只 log 必要欄位
- **error path 也要 log**：錯誤「在哪一層、從哪來」比「最後長什麼樣」更關鍵
- **反模式即 reject**：log 密碼/token、field 命名不一致、熱路徑 over-logging、沒 correlation id、純 txt、console.log 當 prod logging、同 exception 重打 5 遍

## API Error Response

HTTP API boundary 的 error response 統一形狀（詳細見 `references/api-error-response.md`）：

```json
{
  "error": {
    "code": "SYS_CTRL_REQUEST_BODY_INVALID",
    "message": "Invalid request parameters",
    "status": 400,
    "requestId": "req_abc123",
    "timestamp": "2026-09-02T12:00:00Z",
    "details": [{ "field": "email", "message": "Invalid email format" }]
  }
}
```

- `code` 用 **PAAW error code**（不自創另一套）
- 5xx 回通用訊息不洩 stack；stack 只進 server log
- 5xx 才 log error，4xx 是 client 問題
- 對外部依賴可用 circuit breaker（見 reference）
- 多語言實作：`references/api-error-python-flask.md`（Flask 完整錯誤處理 + retry + Sentry）

## Output Contract

新 code 交付前，self-check：
- [ ] 每個會影響營運的 failure 都有唯一 error code（不是任意的 `Error("xxx")`）
- [ ] error code 遵循 `{CODE_CLASS}_{AREA}_{FAMILY}_{DETAIL}`
- [ ] log 是結構化 key-value，含 level + context + errorCode
- [ ] error log 不含機密
- [ ] 不是自己層的錯 → 保留了原本 errorType/errorCode

## Validation

- 不符合 Error Code Rules v1 → 退回重寫
- 純文字 log 無結構化 → 退回
- log 含 token/密碼/個資 → 退回