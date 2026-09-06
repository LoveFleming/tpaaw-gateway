# Logging Practices

> 寫給未來的 ops 跟 AI 讀的 log。結構化、可分級、可串接、不含機密。
> 核心哲學（來源：industry structured-logging standards）：**每一行 log 都要能回答——什麼事發生（what）、何時（when）、在哪個 request（which request）、帶著什麼 context（what context）。** 做不到這四問的 log，就是廢 log。

## 0. Log Level 標準定義（五級）

全專案統一採用五級語意，不當成裝飾：

| Level | 何時用 | 是否要告警 |
|-------|--------|-----------|
| `ERROR` | 確定出錯、需要人介入 | ✅ |
| `WARN` | 意外但系統已恢復/可自理 | ⚠️ 達門檻才告警 |
| `INFO` | 業務事件、服務生命週期、顯著狀態變更 | ❌ |
| `DEBUG` | 開發細節（**預設 prod 不開**） | ❌ |
| `TRACE` | 逐步執行流程，深層除錯 | ❌ |

**鐵律：別把非 error 塞成 error。** 全都 ERROR = 告警疲勞 = 真的問題被忽略。判斷標準：
- 使用者登入成功 → `INFO`，不是 `ERROR`
- cache miss → `DEBUG`，不是 `ERROR`
- rate limit 到 95% → `WARN`，不是 `ERROR`

## 0b. correlation ID — 在邊界掛載、往下傳播

**每一條 log 都要帶 correlation ID（requestId），否則在分散系統裡根本串不起一次 request。**

- 在 **request boundary**（API entry / job start）產生 `requestId`
- 往下傳給所有內部呼叫，log 每條都帶
- 錯誤 response 也回傳同一個 `requestId`（見 `references/api-error-response.md`），讓使用者的報錯可直接對 log

```javascript
// boundary 掛載
const requestId = req.id = crypto.randomUUID();
logger = logger.bind({ requestId }); // structlog/pino 風格

// 內部任何 log 自動帶 requestId
logger.error({ event: "mes_query_failed", errorCode: "...", ... }); // 自動含 requestId
```

**反模式**：log 裡沒有 requestId/correlation id → 無法追蹤一次 request 跨 service 的路徑 → observability 根本建立不起來，直接 reject。

## 1. 結構化 log（JSON key-value）

不要只寫自由文字。用結構化欄位，AI 跟 grep 才 parse 得動：

```javascript
// ❌ 自由文字 — 難 parse、難聚合
console.error("Failed to get lot " + lotId + " from MES");

// ✅ 結構化 key-value — 可 grep、可聚合、可自動統計
logger.error({
  event: "mes_query_failed",
  errorCode: "EXT_NODE_MES_QUERY_TIMEOUT",
  errorType: "TIMEOUT",
  lotId,
  mesHost,
  tookMs: 1250,
});
```

自由文字只能當「人讀的 summary」，**結構化欄位才是給系統讀的本體**。

## 2. log level 分級

不要全塞 error。分級讓 noise 可過濾、告警可設定：

| Level | 用途 | 範例 |
|-------|------|------|
| `debug` | 開發/除錯詳細 | 每個 step 的 inputs/outputs |
| `info` | 正常營運事件 | request 完成、job 開始/結束 |
| `warn` | 可恢復、需留意 | retry、rate limit 接近、deprecated |
| `error` | 真的失敗、需處理 | exception、外部依賴失敗 |

規則：
- **一次 request 不要打一堆 error** — 打「最能代表這次失敗的那一條」
- warn 不是 error 的垃圾桶，error 不是 warn 的升級版 — 兩者語意不同
- 高頻路徑（超多 request）盡量 debug/info，避免灌爆 log

## 3. 必帶 context（把同一次請求串起來）

錯誤發生時要知道「這是哪一次操作」。必帶：

- `requestId` / `traceId` — 同一請求端到端可追蹤
- `trace` — 產線/流程 trace id（如有）
- 業務 key — `lotId`、`equipmentId`、`jobId` 等
- `userId` / `operator`（如有）

同一次失敗的 error log，context 欄位必須一致，否則串不起來。

## 4. error log 必帶 errorCode + errorType

每次 error log，都要附 `errorCode` + `errorType`（見 SKILL.md 的 Error Code Rules v1）：

```javascript
logger.error({
  event: "lot_tool_mismatch",
  errorCode: "BIZ_NODE_LOT_TOOL_MATCH_LOT_TOOL_MISMATCH",
  errorType: "BIZ",
  lotId,
  toolId,
  message: "lot 綁定的 tool 與實際 tool 不符",
});
```

- `errorCode` → 唯一定位問題、查 runbook、跨 service 去重統計
- `errorType` → 機器可直接對應策略（retry? / 拒絕? / 告警?）

## 5. log 出「錯誤在哪一層、從哪來」，不只是「最後長什麼樣」

Exception Flow 原則的 log 面向：**每層只 log 自己那層的判斷**，不是整條 stack 重打一遍。

- node：丟最準的錯 + log node 自己看到的細節
- orchestrator：真出錯才 log ORCH，否則只 log「step 失敗，保留 node errorCode」
- controller：log mapping 後的 HTTP status，不重新發明錯誤
- **不要**：每層都把同一個 exception 打 5 遍，造成「同一個失敗 5 條 error log」

```javascript
// orchestrator — 不是自己層的錯，保留 node 的 errorCode，別重打
catch (e) {
  if (e.errorCode) {
    logger.warn({ event: "step_failed", step, childErrorCode: e.errorCode, childErrorType: e.errorType });
    throw e; // 保留原 errorCode/errorType（Exception Flow 原則）
  }
  // 真的是 orchestrator 自己出錯才產生 ORCH 錯
  logger.error({ event: "orch_state_error", errorCode: "SYS_ORCH_STEP_RESULT_MISSING", errorType: "SYSTEM", step });
}
```

## 6. 不要 log 機密

以下**一律不進 log**，只有極少數 rollback/審計場景才考慮（且要 mask）：

- 密碼、API key、token、session secret
- 完整 JWT payload、authorization header
- 個人資料（身份證、電話、完整姓名）、完整信用卡
- DB connection string 的密碼部分

要 log 時只留必要欄位或 mask：`token: "sk-***"`、`password: "***"`。

## 7. log 格式建議（跨語言通用）

結構化時用一致欄位命名（camelCase / kebab-case 擇一，全專案一致）：

| 欄位 | 意涵 |
|------|------|
| `ts` | ISO 8601 時間戳 |
| `level` | debug/info/warn/error |
| `event` | 事件名（`mes_query_failed`） |
| `errorCode` | PAAW error code |
| `errorType` | PAAW error type |
| `message` | 人讀的簡短 summary |
| `requestId` | 追蹤 id |
| `<businessKey>` | lotId、jobId 等 |
| `tookMs` | 耗時 |

範例完整 log：

```json
{
  "ts": "2026-09-02T12:00:00.000Z",
  "level": "error",
  "event": "mes_query_failed",
  "errorCode": "EXT_NODE_MES_QUERY_TIMEOUT",
  "errorType": "TIMEOUT",
  "message": "MES query timed out after 1250ms",
  "requestId": "req-abc123",
  "lotId": "LOT-001",
  "tookMs": 1250
}
```

## 8. 每個 failure 都要「可被單獨定位」

自問：看到這條 log + errorCode，未來的 ops/AI 能不能**不問人、直接知道下一步**？
- 能不能靠 `grep errorCode logs/` 撈出所有同類錯誤統計頻率？
- 每個 errorCode 查得到 runbook / 解法嗎？
- 不能 → 就是還不夠好，回去補 errorCode 或補 log 欄位。

## 9. 反模式 — 看到直接 reject

- ❌ `log.info(f"password={password}")` / 任何 log 含 token、密碼、PII → **資安事件**，用結構化欄位 + 洗掉敏感資料
- ❌ 各 service field 命名不一致（A 用 `orderId`、B 用 `order_id`、C 用 `OrderID`）→ 定義共同 logging schema，用 lint 強制
- ❌ 熱路徑（100K req/s 的 loop）裡 `logger.info()` → 對 logging infra 的 DDoS；要 rate-limited / sampled
- ❌ 任何 log 沒 requestId / correlation id → 無法跨 service 追蹤，observability 從這斷掉
- ❌ prod log 存純 `.txt`（無結構化）→ 每次 query 都要 grep + regex + 運氣
- ❌ 用 `console.log` / `System.out.println` 當 prod 正式 logging → 沒有 level、結構化、路由
- ❌ 同一個 exception 每層重打 5 遍 → 同一個失敗 5 條 error log，違反 Exception Flow 原則

## 10. 審查時機

寫完 code 後，用這四問過一遍每條新增的 log：
1. **what** — 我 log 的是「發生的事」，不是「我心情」?
2. **when** — 有 timestamp?
3. **which request** — 有 requestId / correlation id?
4. **what context** — 有沒有足以還原現場的業務 key（lotId/orderId…），且**不含機密**?

四問全過 = log 合格。任一不過 = 回去改。