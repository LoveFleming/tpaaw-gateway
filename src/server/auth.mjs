/**
 * PAAW Gateway — Auth module
 *
 * Session store + user lookup. Depends only on `config` (for sessionMaxAge
 * and the users list) — it never imports paaw-control / backup.
 */

import { randomUUID } from "crypto";

/**
 * Create the session store for one server instance.
 *
 * @param {object} config parsed config (uses sessionMaxAge + users)
 * @returns {{
 *   sessions: Map<string, { userId: string, created: number }>,
 *   users: object[],
 *   createSession: (userId: string) => string,
 *   validateSession: (token: string) => { userId: string, created: number } | null
 * }}
 */
export function createAuth(config) {
  const sessions = new Map();

  /** Create a session token for a user id. */
  function createSession(userId) {
    const token = randomUUID();
    sessions.set(token, { userId, created: Date.now() });
    return token;
  }

  /** Validate a session token; returns the session or null (expired/unknown). */
  function validateSession(token) {
    const s = sessions.get(token);
    if (!s) return null;
    if (Date.now() - s.created > (config.sessionMaxAge || 86400000)) {
      sessions.delete(token);
      return null;
    }
    return s;
  }

  return { sessions, users: config.users, createSession, validateSession };
}