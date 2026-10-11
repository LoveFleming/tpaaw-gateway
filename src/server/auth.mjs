/**
 * PAAW Gateway — Auth module
 *
 * Session store + credential verification + login rate limiting. Depends only
 * on `config` (sessionMaxAge + users) and the password module — it never
 * imports paaw-control / backup.
 *
 * Hardening (ISS-002 / TASK-018):
 *  - Login verifies against a bcrypt hash (or legacy plaintext, constant-time)
 *    and NEVER reveals whether an account exists — unknown users still pay one
 *    bcrypt comparison and receive the same generic failure.
 *  - Repeated failures are rate-limited per user AND per client IP with a
 *    fixed-window counter that self-recycles (no unbounded growth).
 *  - Successful login with a legacy / under-cost credential returns
 *    `upgraded:true` so the caller can persist the re-hashed value.
 */

import { randomUUID } from "crypto";

import {
  verifyPassword,
  hashPassword,
  needsRehash,
  consumeDummyVerify,
} from "./password.mjs";

/** Max failures per user (and per IP) before lockout. */
export const LOGIN_MAX_FAILURES = 5;
/** Lockout / counting window. */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/**
 * Fixed-window counter with opportunistic TTL recycling. Keyed by an opaque
 * string (e.g. `u:admin` / `ip:127.0.0.1`).
 *
 * @param {{ limit: number, windowMs: number }} opts
 */
function createRateLimiter({ limit, windowMs }) {
  const hits = new Map(); // key -> { count, resetAt }

  /** Drop entries whose window has elapsed (bounds memory). */
  function prune(now) {
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }

  return {
    check(key, now = Date.now()) {
      const e = hits.get(key);
      if (!e || e.resetAt <= now) return { limited: false, retryAfterMs: 0 };
      if (e.count >= limit) return { limited: true, retryAfterMs: e.resetAt - now };
      return { limited: false, retryAfterMs: 0 };
    },
    fail(key, now = Date.now()) {
      prune(now);
      const e = hits.get(key);
      if (!e || e.resetAt <= now) hits.set(key, { count: 1, resetAt: now + windowMs });
      else e.count += 1;
    },
    reset(key) {
      hits.delete(key);
    },
    get size() {
      return hits.size;
    },
  };
}

/**
 * Create the session store + login surface for one server instance.
 *
 * @param {object} config parsed config (uses sessionMaxAge + users)
 * @returns {{
 *   sessions: Map<string, { userId: string, created: number }>,
 *   users: object[],
 *   createSession: (userId: string) => string,
 *   validateSession: (token: string) => { userId: string, created: number } | null,
 *   login: (userId: unknown, password: unknown, ip?: string) =>
 *     Promise<{ ok: true, token: string, user: object, upgraded: boolean }
 *            | { ok: false, locked?: boolean, retryAfterMs?: number }>
 * }}
 */
export function createAuth(config) {
  const sessions = new Map();
  const userLimiter = createRateLimiter({ limit: LOGIN_MAX_FAILURES, windowMs: LOGIN_WINDOW_MS });
  const ipLimiter = createRateLimiter({ limit: LOGIN_MAX_FAILURES, windowMs: LOGIN_WINDOW_MS });

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

  /**
   * Authenticate a login attempt.
   *
   * @param {unknown} userId
   * @param {unknown} password
   * @param {string} [ip] client IP (for per-IP throttling)
   */
  async function login(userId, password, ip = "unknown") {
    const now = Date.now();
    const userKey = `u:${String(userId)}`;
    const ipKey = `ip:${String(ip)}`;

    // 1. Lockout check — refuse before doing any hashing work.
    const userLock = userLimiter.check(userKey, now);
    const ipLock = ipLimiter.check(ipKey, now);
    if (userLock.limited || ipLock.limited) {
      return {
        ok: false,
        locked: true,
        retryAfterMs: Math.max(userLock.retryAfterMs, ipLock.retryAfterMs),
      };
    }

    // 2. Verify — constant work whether or not the user exists.
    const user = Array.isArray(config.users)
      ? config.users.find((u) => u && u.id === userId)
      : undefined;
    let valid = false;
    if (user && typeof user.passwordHash === "string" && user.passwordHash.length > 0) {
      valid = await verifyPassword(password, user.passwordHash);
    } else {
      await consumeDummyVerify(password); // spend the same CPU; never authenticate
    }

    if (!valid) {
      userLimiter.fail(userKey, now);
      ipLimiter.fail(ipKey, now);
      return { ok: false };
    }

    // 3. Success — clear the counters, upgrade a legacy/under-cost hash.
    userLimiter.reset(userKey);
    ipLimiter.reset(ipKey);
    let upgraded = false;
    if (needsRehash(user.passwordHash)) {
      user.passwordHash = await hashPassword(password);
      upgraded = true;
    }
    const token = createSession(user.id);
    return { ok: true, token, user, upgraded };
  }

  return { sessions, users: config.users, createSession, validateSession, login };
}
