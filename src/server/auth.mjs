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
 *
 * Lockout separation (login-DoS fix, review board 2026-10-19):
 *  - The two limiters use INDEPENDENT thresholds: the per-user limit stays
 *    strict, the per-IP limit is deliberately looser (it only needs to stop a
 *    real flood, not tolerate shared/NAT egress).
 *  - The per-IP limit is the ONLY gate that refuses before verification: an IP
 *    that is spraying is throttled without affecting any other IP.
 *  - The per-user limit does NOT refuse a correct credential. It only turns a
 *    FAILED attempt into a `locked` reply. This closes the account-lockout DoS
 *    where an attacker floods a victim's username from any IP and thereby locks
 *    the real user out: the victim's correct password still authenticates.
 *    Brute-force is still bounded because wrong attempts keep counting and are
 *    refused once the per-user limit is reached.
 *  - Because both known and unknown usernames accumulate a per-user counter and
 *    receive the exact same `{ ok:false }` / `{ ok:false, locked:true }` shapes,
 *    the separation does not re-introduce account enumeration.
 */

import { randomUUID } from "crypto";

import {
  verifyPassword,
  hashPassword,
  needsRehash,
  consumeDummyVerify,
} from "./password.mjs";

/** Max failures per user before that user's FAILED attempts are refused. */
export const LOGIN_MAX_FAILURES = 5;
/**
 * Max failures per client IP before the whole IP is refused. Deliberately
 * looser than the per-user limit: one IP may legitimately carry several users
 * (NAT / shared egress), so it only needs to stop a real flood.
 */
export const LOGIN_IP_MAX_FAILURES = 20;
/** Lockout / counting window (shared by both limiters). */
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
  const ipLimiter = createRateLimiter({ limit: LOGIN_IP_MAX_FAILURES, windowMs: LOGIN_WINDOW_MS });

  /**
   * Create a session token for a user id.
   *
   * Expired sessions were previously only evicted when their own token was
   * presented again (validateSession), so an abandoned-but-expired entry could
   * stay in the Map forever (review board minor#6). Sweep on creation — a
   * cheap O(n) scan, and one login per sweep is far below any login rate — so
   * the Map only ever holds live sessions plus those created since the last
   * login.
   */
  function createSession(userId) {
    const now = Date.now();
    // `??` (not `||`): a 0 maxAge is a legitimate "everything expires at once"
    // setting; `||` would silently fall back to the 1-day default.
    const maxAge = config.sessionMaxAge ?? 86400000;
    for (const [token, s] of sessions) {
      if (now - s.created > maxAge) sessions.delete(token);
    }
    const token = randomUUID();
    sessions.set(token, { userId, created: now });
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

    // 1. Per-IP gate — the only check that refuses BEFORE verification. A
    //    spraying IP is throttled here and nothing else is affected, so a
    //    flood from one IP can never lock out a legitimate user on another.
    const ipLock = ipLimiter.check(ipKey, now);
    if (ipLock.limited) {
      // Deliberately NO dummy bcrypt here (review board minor#4): this branch is
      // a rate-limiter reply, not a credential check, so its timing necessarily
      // differs from the verify path. Accepted trade-off — the only thing the
      // timing reveals is "this IP is already being throttled", which the 429
      // response tells the caller anyway. Spending ~200ms of bcrypt per request
      // on a spraying IP would hand the attacker the CPU-DoS it is trying to
      // cause; short-circuiting keeps the limiter cheap.
      return { ok: false, locked: true, retryAfterMs: ipLock.retryAfterMs };
    }

    // 2. Verify — constant work whether or not the user exists. Done before the
    //    per-user lockout check so a correct credential is never refused (the
    //    account-lockout DoS fix) and so timing stays uniform.
    const user = Array.isArray(config.users)
      ? config.users.find((u) => u && u.id === userId)
      : undefined;
    let valid = false;
    // A non-string password (number / object / null) can never be a credential.
    // It is routed to the SAME dummy-verify branch as an unknown user rather
    // than being passed to verifyPassword/hashPassword, so it keeps the uniform
    // response shape AND the constant bcrypt cost (review board minor#5) —
    // and hashPassword's TypeError can never surface from the login path.
    if (typeof password === "string" && password.length > 0
      && user && typeof user.passwordHash === "string" && user.passwordHash.length > 0) {
      valid = await verifyPassword(password, user.passwordHash);
    } else {
      await consumeDummyVerify(password); // spend the same CPU; never authenticate
    }

    if (!valid) {
      // Per-user limit turns a FAILED attempt into a lockout reply. Checked
      // BEFORE counting so the first `LOGIN_MAX_FAILURES` failures are allowed
      // and only the next one is refused (limit = allowed failures). The same
      // shape is returned for known and unknown usernames → no enumeration.
      const userLock = userLimiter.check(userKey, now);
      // The per-IP counter advances on EVERY failed verification — including
      // the per-user-locked reply (review board RR-20261018-1738-6f2e,
      // auth.mjs:186). Otherwise a sprayer that hammers one KNOWN account is
      // stopped only by the per-user limit while its IP counter never moves, so
      // the per-IP gate (the documented "only gate that refuses before
      // verification") would never trip — and unknown-account sprays would be
      // throttled at a different point than known-account ones, a symmetry leak
      // that hints at account existence.
      ipLimiter.fail(ipKey, now);
      if (userLock.limited) {
        return { ok: false, locked: true, retryAfterMs: userLock.retryAfterMs };
      }
      userLimiter.fail(userKey, now);
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
