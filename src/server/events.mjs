/**
 * PAAW Gateway — Events module (leaf)
 *
 * In-memory audit-trail buffer (last 500 entries) plus JSONL append.
 * No dependencies on other Gateway modules.
 */

import { appendFileSync } from "fs";
import { randomUUID } from "crypto";

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
   * @param {string} type event type (e.g. "server_started")
   * @param {string} detail human-readable detail
   * @param {string} [userId="system"] acting user id
   */
  function logEvent(type, detail, userId = "system") {
    const entry = { id: randomUUID(), ts: new Date().toISOString(), type, detail, userId };
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