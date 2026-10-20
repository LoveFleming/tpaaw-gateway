/**
 * PAAW Gateway — Events module (leaf)
 *
 * In-memory audit-trail buffer (last 500 entries) plus JSONL append.
 * No dependencies on other Gateway modules.
 */

import { appendFileSync } from "fs";
import { randomUUID } from "crypto";

/**
 * Default audit-field sanitizer (write-layer guard).
 *
 * Strips control characters (incl. CR/LF, which could forge extra log lines)
 * and caps the length. Applied to every free-text field at the WRITE layer so
 * that ANY call site — including a future one that forgets to pre-sanitize —
 * cannot inject control chars into the audit trail (committee minor: removed
 * the "every new call site must remember to sanitize" human convention).
 *
 * @param {unknown} value
 * @returns {string}
 */
export const AUDIT_FIELD_MAX = 128;
export function sanitizeAuditField(value) {
  let out = "";
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    // Drop C0 controls (0x00–0x1F), DEL (0x7F), C1 controls (0x80–0x9F) and the
    // Unicode line/paragraph separators U+2028/U+2029 (log-break vectors).
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) continue;
    // Cap on UTF-16 code units, checked BEFORE appending so the result never
    // exceeds AUDIT_FIELD_MAX code units and a surrogate pair is never split.
    if (out.length + ch.length > AUDIT_FIELD_MAX) break;
    out += ch;
  }
  return out;
}

/**
 * Create the event buffer + logEvent for one server instance.
 *
 * @param {string} eventLogPath absolute path to the append-only JSONL log
 * @returns {{ events: object[], logEvent: (type: string, detail: string, userId?: string) => void }}
 */
export function createEventLog(eventLogPath) {
  const events = [];

  /**
   * Append an audit event to the in-memory ring buffer and the JSONL file.
   *
   * `detail` and `userId` are sanitized HERE (single choke point) — call sites
   * no longer need to remember to pre-sanitize attacker-controlled values.
   *
   * @param {string} type event type (e.g. "server_started")
   * @param {string} detail human-readable detail
   * @param {string} [userId="system"] acting user id
   */
  function logEvent(type, detail, userId = "system") {
    const entry = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      type,
      detail: sanitizeAuditField(detail),
      userId: sanitizeAuditField(userId),
    };
    events.push(entry);
    // Keep last 500 in memory
    if (events.length > 500) events.splice(0, events.length - 500);
    // Append to file
    try {
      appendFileSync(eventLogPath, JSON.stringify(entry) + "\n");
    } catch {}
  }

  return { events, logEvent };
}