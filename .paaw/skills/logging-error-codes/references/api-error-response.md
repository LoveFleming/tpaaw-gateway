# Standard API Error Response & Handling

> 來源：secondsky/claude-skills `api-error-handling`（MIT）。適用於所有 HTTP API boundary（Express / Fastify / Flask / Koa 等），與 SKILL.md 的 PAAW Error Code Rules v1 併用：**本檔定義 error response 的「外殼形狀」，SKILL.md 定義 error code 的「命名」。**

## 標準 Error Response 格式

所有 endpoint 一律回傳一致的 error payload 形狀（`error` 物件 + 標準欄位）：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request parameters",
    "status": 400,
    "requestId": "req_abc123",
    "timestamp": "2025-01-15T10:30:00Z",
    "details": [
      { "field": "email", "message": "Invalid email format" }
    ]
  }
}
```

欄位規則：
- `code` — 用 SKILL.md 的 PAAW error code（`{CODE_CLASS}_{AREA}_{FAMILY}_{DETAIL}`），不要再自創另一套字串
- `message` — 人讀的簡短訊息（4xx 可直接給 client；5xx 給通用訊息避免洩漏內部）
- `status` — HTTP status（對應 SKILL.md 的 ErrorType→HTTP 表）
- `requestId` — 讓 client 回報時可追蹤（同 logging 的 correlation id）
- `timestamp` — ISO 8601
- `details` — 選用，欄位級錯誤（validation 最常用）

## ApiError Class（Node.js 範例）

```javascript
class ApiError extends Error {
  constructor(code, message, status = 500, details = null) {
    super(message);
    this.code = code;      // PAAW error code，如 SYS_CTRL_REQUEST_BODY_INVALID
    this.errorType = /* 依 SKILL.md ErrorType */.system;
    this.status = status;
    this.details = details;
  }
}

// 全域 error handler — 只做 ErrorType → HttpStatus mapping（Exception Flow 原則）
app.use((err, req, res, next) => {
  const status = err.status || 500;
  const response = {
    error: {
      code: err.code || "SYS_CTRL_REQUEST_INTERNAL",
      message: status === 500 ? "Internal server error" : err.message,
      status,
      requestId: req.id
    }
  };
  if (err.details) response.error.details = err.details;
  if (status >= 500) logger.error(err);   // 5xx 才 log error，4xx 是 client 問題
  res.status(status).json(response);
});
```

## Circuit Breaker（外部依賴護欄）

對外部依賴（MES / DB / 第三方 API）的連續失敗，用 circuit breaker 避免雪崩。對應 SKILL.md 的 `EXT_*` 錯誤情境：

```javascript
class CircuitBreaker {
  constructor(threshold = 5, timeout = 30000) {
    this.failures = 0;
    this.threshold = threshold;
    this.timeout = timeout;
    this.state = "CLOSED";   // CLOSED → OPEN（連續失敗）→ HALF_OPEN（逾時重試）
  }
  async call(fn) {
    if (this.state === "OPEN") throw new Error("EXT_NODE_DEPENDENCY_CIRCUIT_OPEN");
    try {
      const result = await fn();
      this.failures = 0;
      return result;
    } catch (err) {
      this.failures++;
      if (this.failures >= this.threshold) {
        this.state = "OPEN";
        setTimeout(() => (this.state = "HALF_OPEN"), this.timeout);
      }
      throw err;
    }
  }
}
```

## Best Practices

1. 所有 endpoint 用一致的 error 格式（不要每個 handler 各寫一套）
2. 必帶 `requestId`（跟 logging 的 correlation id 同源，端到端可追蹤）
3. error log 依嚴重度分級；**5xx 才 log error，4xx 是 client 端問題不必 error**
4. **永不向 client 洩漏 stack trace** — 5xx 回通用訊息，詳細 stack 進 server log
5. 區分 **4xx（client 錯）vs 5xx（server 錯）** — 決定 error 該不該告警
6. 提供可執行的 error message（「email 格式錯誤」>「error」）

## 語言對照

- **Node/Express**：見上方 ApiError + handler
- **Python/Flask**：`references/api-error-python-flask.md`（Flask 完整錯誤處理 + 例外類 + retry + Sentry）