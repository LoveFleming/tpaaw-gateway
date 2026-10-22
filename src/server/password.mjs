/**
 * PAAW Gateway — Password module (leaf)
 *
 * Owns password hashing / verification for the admin platform. Uses bcrypt
 * (via the pure-JS `bcryptjs` package so it runs everywhere without native
 * build tooling). Depends only on Node built-ins + bcryptjs — no other Gateway
 * module — so it can be imported by the entry, config and tests alike.
 *
 * Threat model (ISS-002 / TASK-018):
 *  - Stored credentials MUST NOT be plaintext, and login MUST NOT leak whether
 *    an account exists (uniform 401 + constant-time work on both paths).
 *  - Legacy plaintext credentials written by older versions are still accepted
 *    (backward compatibility) but the caller is told to re-hash them on a
 *    successful login (`needsRehash` → lazy upgrade), so existing installs
 *    migrate to bcrypt without an admin-side migration step.
 */

import bcrypt from "bcryptjs";
import { createHash, timingSafeEqual } from "crypto";

/** bcrypt cost factor. 12 ≈ 200ms on a modern laptop — a sane online-login cost. */
export const BCRYPT_ROUNDS = 12;

/** Matches `$2a$` / `$2b$` / `$2y$` bcrypt strings with a 2-digit cost. */
const BCRYPT_RE = /^\$2[aby]?\$\d{2}\$/;

/**
 * A fixed bcrypt hash of a random, unknowable string. Used to spend the same
 * CPU on "user not found" as on a real verify, so response timing cannot be
 * used to enumerate accounts. It is NOT a credential — nobody knows its
 * pre-image, so it can never authenticate.
 */
const DUMMY_HASH = "$2b$12$r7PoHG3R5pskdUBuwcH0H.6/03UQGjhBTKaEPACo8sOtqtECSU8fG";

/**
 * Obvious shipped/default passwords that must never authenticate. `change_me`
 * is the literal default the code used to ship; the rest are the usual
 * copy-paste defaults. Blocking these enforces "remove the default password"
 * without requiring an admin-side migration.
 */
const WEAK_DEFAULT_PASSWORDS = new Set([
  "change_me",
  "changeme",
  "change-me",
  "password",
  "admin",
  "paaw",
]);

/** Is `stored` already a bcrypt hash (vs. a legacy plaintext value)? */
export function isHashed(stored) {
  return typeof stored === "string" && BCRYPT_RE.test(stored);
}

/** Does `stored` need (re-)hashing? true for plaintext or an under-cost hash. */
export function needsRehash(stored) {
  if (!isHashed(stored)) return true;
  const rounds = parseInt(stored.split("$")[2], 10);
  return !Number.isFinite(rounds) || rounds < BCRYPT_ROUNDS;
}

/**
 * Is this legacy plaintext value an obvious default that must be rejected?
 * Hashed values are never "weak" (the plaintext is not visible).
 */
export function isWeakDefaultPassword(stored) {
  return (
    typeof stored === "string" &&
    !isHashed(stored) &&
    WEAK_DEFAULT_PASSWORDS.has(stored.toLowerCase())
  );
}

/** Hash a plaintext password (async — preferred; does not block the loop long). */
export async function hashPassword(plain) {
  if (typeof plain !== "string" || plain.length === 0) {
    throw new TypeError("password must be a non-empty string");
  }
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/** Synchronous hash — only for boot-time config wiring, never in a request. */
export function hashPasswordSync(plain) {
  if (typeof plain !== "string" || plain.length === 0) {
    throw new TypeError("password must be a non-empty string");
  }
  return bcrypt.hashSync(plain, BCRYPT_ROUNDS);
}

/**
 * Constant-time string equality that does not leak length. Both sides are
 * folded through SHA-256 first so `timingSafeEqual` always sees equal-length
 * buffers (it throws on mismatched lengths).
 */
function constantTimeEqual(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Verify a plaintext password against a stored credential.
 * Supports bcrypt hashes and legacy plaintext (constant-time compare).
 *
 * @returns {Promise<boolean>} true only on an exact match.
 */
export async function verifyPassword(plain, stored) {
  if (typeof plain !== "string" || typeof stored !== "string" || stored.length === 0) {
    return false;
  }
  if (isHashed(stored)) return bcrypt.compare(plain, stored);
  // Legacy plaintext path — constant-time to avoid a timing oracle.
  return constantTimeEqual(plain, stored);
}

/**
 * Spend one bcrypt comparison against a non-credential hash, for the
 * "user not found / weak default" branch, so both branches cost the same.
 * Always returns false.
 */
export async function consumeDummyVerify(plain) {
  try {
    await bcrypt.compare(typeof plain === "string" ? plain : "", DUMMY_HASH);
  } catch {
    /* a failed compare is fine — we only wanted to spend the time */
  }
  return false;
}

/**
 * Apply a boot-time password override from the environment, so an operator can
 * set a strong credential without hand-editing config.json.
 *
 * Precedence (highest first):
 *   PAAW_GATEWAY_PASSWORD_HASH  (a ready-made bcrypt hash)
 *   PAAW_GATEWAY_PASSWORD       (plaintext, hashed here at boot)
 * The target user id is PAAW_GATEWAY_ADMIN_ID, else the first configured user,
 * else "admin" (created if missing). No-op when neither env var is set.
 *
 * @param {object} config parsed config (mutated in place)
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean} true when an override was actually applied to `config`;
 *   false when neither env var was set (no-op). Callers use this to know that
 *   `config.users` now carries an env-derived credential which must not be
 *   persisted back to config.json (review board round-2, config.mjs:235).
 */
export function applyPasswordOverride(config, env = process.env) {
  const hash = env.PAAW_GATEWAY_PASSWORD_HASH;
  const plain = env.PAAW_GATEWAY_PASSWORD;
  if (!hash && !plain) return false;
  if (hash && !isHashed(hash)) {
    throw new Error("PAAW_GATEWAY_PASSWORD_HASH must be a bcrypt hash");
  }

  const credential = hash || hashPasswordSync(plain);
  if (!Array.isArray(config.users)) config.users = [];
  const adminId = env.PAAW_GATEWAY_ADMIN_ID || config.users[0]?.id || "admin";
  let user = config.users.find((u) => u.id === adminId);
  if (!user) {
    user = { id: adminId, name: "Admin", role: "admin" };
    config.users.push(user);
  }
  user.passwordHash = credential;
  return true;
}
