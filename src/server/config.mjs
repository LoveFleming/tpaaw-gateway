/**
 * PAAW Gateway — Config module (leaf)
 *
 * Owns config.json loading/saving and the env-derived paths that the rest of
 * the Gateway server depends on.
 *
 * IMPORTANT (test contract): the unit test re-imports the entry module with a
 * cache-busting query string (`src/server.mjs?case=N`) to make fresh env
 * (PAAW_ROOT / PAAW_BACKUP_DIR / PAAW_EVENT_LOG / PAAW_MAX_BACKUPS) take
 * effect. Static sub-module imports are NOT cache-busted, so this module MUST
 * NOT compute env-derived state at module top level — instead `createConfig()`
 * recomputes everything on every call, invoked by the entry at load time.
 *
 * All relative paths are resolved against `baseDir` (the entry's own
 * directory, i.e. `<root>/src`) so that moving this file one level deeper
 * (src/ -> src/server/) does not shift path depth.
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync } from "fs";
import { join, resolve } from "path";

import { applyPasswordOverride, isWeakDefaultPassword } from "./password.mjs";

/** Default bind host — loopback only, so :4199 is never exposed to the network. */
export const DEFAULT_HOST = "127.0.0.1";

/**
 * Load config.json; fall back to sane defaults when missing/unparseable.
 *
 * Security note (TASK-018): the fallback deliberately ships NO default user /
 * credential. Previously it defaulted to `admin` / `change_me`, which meant a
 * mis-configured install was trivially taken over. Now an install with no
 * configured credential fails the startup check in `validateAuthConfig`.
 *
 * @param {string} configPath absolute path to config.json
 * @returns {object} parsed config
 */
export function loadConfig(configPath, baseDir) {
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return {
      host: DEFAULT_HOST,
      port: 4199,
      paawRoot: resolve(baseDir, "..", "..", ".."),
      paawServerCmd: "node packages/server/src/index.mjs",
      paawServerPort: 4097,
      backupDir: resolve(baseDir, "..", "..", "..", "backups"),
      backupSchedule: "0 3 * * *",
      maxBackups: 7,
      users: [], // no default credential — must be configured (config.json or env)
      sessionMaxAge: 86400000,
      // NOTE: there is deliberately NO sessionSecret here. Sessions are opaque
      // randomUUID tokens held in an in-memory Map (see auth.mjs) — no HMAC
      // signing key is used or read anywhere, so a secret field would be dead
      // config. (Review board minor#1 was a false positive: no consumer reads
      // cfg.sessionSecret.)
    };
  }
}

/**
 * Fail-closed startup check for the auth configuration.
 *
 * Rejects (returns { ok:false, error }) when:
 *  - there are no users, or
 *  - no user has any credential, or
 *  - a user still carries an obvious shipped default password in plaintext.
 *
 * Callers (the entry's main guard) must refuse to start on failure.
 *
 * @param {object} config parsed config
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateAuthConfig(config) {
  const users = Array.isArray(config.users) ? config.users : [];
  if (users.length === 0) {
    return { ok: false, error: "no users configured" };
  }
  const withCredential = users.filter(
    (u) => typeof u?.passwordHash === "string" && u.passwordHash.length > 0,
  );
  if (withCredential.length === 0) {
    return { ok: false, error: "no user has a password configured" };
  }
  for (const u of withCredential) {
    if (isWeakDefaultPassword(u.passwordHash)) {
      return {
        ok: false,
        error: `user "${u.id}" still uses a default password — set a real one`,
      };
    }
  }
  return { ok: true };
}

/**
 * Persist config back to config.json.
 *
 * WARNING: serialises the given object verbatim. Do NOT pass the runtime config
 * built by createConfig() — it carries env-derived fields (host/port/password
 * override). Use saveCredentialUpgrades() / updateConfigOnDisk() instead when
 * persisting from the request path.
 *
 * @param {string} configPath absolute path to config.json
 * @param {object} config config object
 */
export function saveConfig(configPath, config) {
  atomicWriteJson(configPath, config);
}

/**
 * Write `data` to `filePath` atomically: serialise to a sibling temp file, then
 * renameSync over the target (rename on the same filesystem is atomic on POSIX
 * and ReplaceFile-backed on Windows).
 *
 * Why: the previous `writeFileSync(target)` truncated the target first, so a
 * concurrent reader (or a crash mid-write) could observe a truncated / empty
 * config.json. With temp+rename a reader always sees either the old or the new
 * complete document (review board round-2, config.mjs:135).
 *
 * The temp name carries pid + a counter + randomness so two writers in the same
 * process (serialised by the queue below) and any cross-process writer never
 * collide on the temp path. On failure the temp file is removed so a half-write
 * never lingers on disk.
 *
 * @param {string} filePath absolute path of the target file
 * @param {unknown} data JSON-serialisable value
 */
function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.${tempSeq++}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best effort — the original error is the one worth reporting */
    }
    throw err;
  }
}

/** Monotonic counter for temp-file uniqueness within one process. */
let tempSeq = 0;

/**
 * Per-file in-process write queue (tail promise per config path).
 *
 * Why (review board round-2, config.mjs:135): updateConfigOnDisk() is a
 * read-merge-write; two writers overlapping (login hash upgrade vs settings
 * save) would each read the OLD document and the last writer would silently
 * drop the other's patch. The Gateway is a single process, so serialising the
 * read-merge-write critical section on a promise chain per config path is
 * sufficient. The chain advances with `.then(run, run)` so one failure never
 * stalls the queue for later writers.
 *
 * @type {Map<string, Promise<void>>}
 */
const writeQueues = new Map();

/**
 * Run the synchronous critical section `fn` in FIFO order per config path.
 *
 * `fn` MUST be synchronous: it reads and writes the file inside one turn of
 * the event loop, so the promise chain is the only concurrency boundary that
 * needs to be respected. A rejection from `fn` is rethrown to the caller and
 * does not poison the queue.
 *
 * @template T
 * @param {string} configPath queue key (the config file being mutated)
 * @param {() => T} fn critical section (read-merge-write)
 * @returns {Promise<T>} resolves with fn's return value
 */
async function withConfigWriteLock(configPath, fn) {
  const key = resolve(configPath);
  const previous = writeQueues.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((r) => { release = r; });
  const tail = previous.then(() => gate, () => gate); // ignore a prior failure
  writeQueues.set(key, tail);
  try {
    await previous.catch(() => {}); // wait our turn (prior failure is not ours)
    return fn();
  } finally {
    release();
    // Drop the entry once no one is queued behind us (bounded: ~1 config file).
    tail.then(() => {
      if (writeQueues.get(key) === tail) writeQueues.delete(key);
    });
  }
}

/**
 * Overlay `patch` onto the config currently on disk (read-merge-write) instead
 * of serialising an in-memory config wholesale.
 *
 * Why (review board RR-20261018-1738-6f2e, src/server.mjs:205 / config.mjs:133):
 * the runtime `config` object is NOT a faithful copy of config.json — env
 * overrides (PAAW_GATEWAY_HOST / PAAW_GATEWAY_PORT) and the boot-time credential
 * override (PAAW_GATEWAY_PASSWORD* via applyPasswordOverride) are merged into it
 * in place. Writing that object back would turn a one-shot env override into a
 * permanent setting (and, for the password case, freeze the env-derived
 * credential into the file). Merging the patch into the on-disk document keeps
 * env-derived values out of the file by construction — the caller never has to
 * know which fields are env-derived.
 *
 * The file is re-read immediately before the write so fields changed by other
 * writer paths (e.g. POST /api/settings) are preserved. That read-merge-write
 * runs inside a per-path write queue AND the write itself is a temp+rename
 * atomic replace, so concurrent writers can neither lose each other's patch nor
 * expose a truncated document to a reader (review board round-2, config.mjs:135).
 *
 * @param {string} configPath absolute path to config.json
 * @param {object} patch partial config to merge onto the on-disk document
 * @param {string} baseDir base directory used for fallback defaults (see loadConfig)
 * @returns {Promise<void>} resolves after the atomic write completed
 */
export async function updateConfigOnDisk(configPath, patch, baseDir) {
  await withConfigWriteLock(configPath, () => {
    const current = loadConfig(configPath, baseDir);
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      throw new Error("config.json is not a JSON object");
    }
    saveConfig(configPath, { ...current, ...patch });
  });
}

/**
 * Build the full runtime config + derived paths for one server instance.
 *
 * Invoked by the entry at load time so env-derived state is fresh on every
 * (cache-busted) import.
 *
 * @param {string} baseDir the entry's __dirname (`<root>/src`)
 * @returns {{
 *   CONFIG_PATH: string, config: object,
 *   saveConfig: (patch?: object) => void,
 *   saveCredentialUpgrades: () => void,
 *   PAAW_ROOT: string, BACKUP_DIR: string, EVENT_LOG_PATH: string,
 *   MAX_BACKUPS: number, BACKUP_SOURCE_DIRS: string[]
 * }}
 */
export function createConfig(baseDir) {
  return createConfigImpl(baseDir);
}

/**
 * Comparative deep equality for JSON-shaped config values (avoids a full
 * serialise-and-stringify round trip on every key).
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function jsonEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k], b[k]));
}

/**
 * Keys of the runtime `config` that createConfig() derives from the
 * environment (or fallback defaults) rather than reading verbatim from
 * config.json. createConfig().saveConfig() must never write them back.
 */
const ENV_DERIVED_KEYS = new Set(["host", "port"]);

/**
 * Read the on-disk config as raw JSON (no defaults applied), or null when the
 * file is missing / unparseable.
 *
 * Why (review board round-2, config.mjs:240): createConfig().saveConfig() diffs
 * the runtime config against a "pristine" baseline. Using loadConfig() for that
 * baseline is wrong — loadConfig() layers fallback defaults on top, so a field
 * absent from the file but defaulted in memory (e.g. `maxBackups`) would look
 * "changed" and be eagerly written back. The true baseline is the verbatim
 * document.
 *
 * @param {string} configPath absolute path to config.json
 * @returns {object | null}
 */
function readRawConfig(configPath) {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function createConfigImpl(baseDir) {
  // Test-only knob: PAAW_CONFIG overrides the config path (same isolation
  // pattern as PAAW_ROOT / PAAW_BACKUP_DIR / PAAW_EVENT_LOG / PAAW_MAX_BACKUPS).
  // E2E tests use this to spawn the server against a throwaway config and
  // never touch the developer's real gateway on :4199.
  const CONFIG_PATH = process.env.PAAW_CONFIG || join(baseDir, "..", "config.json");
  const config = loadConfig(CONFIG_PATH, baseDir);

  // ── Bind host / port (TASK-019) ──
  // Default to loopback only; an operator must explicitly opt in to a wider
  // bind via config.host or PAAW_GATEWAY_HOST. Empty string would let Node bind
  // all interfaces, so treat blank as "use the safe default".
  config.host = process.env.PAAW_GATEWAY_HOST || config.host || DEFAULT_HOST;
  if (process.env.PAAW_GATEWAY_PORT) config.port = Number(process.env.PAAW_GATEWAY_PORT);

  // ── Credential override from env (TASK-018) ──
  // Lets an operator set a strong password without editing config.json.
  //
  // `users` is env-derived ONLY on this path: once an override is active, any
  // users[] difference between memory and disk is (at least partly) the env
  // credential, which must never be frozen into the file. Without an override,
  // users[] is ordinary file data and its changes MUST be persisted — a blanket
  // exclusion silently dropped legitimate admin changes (review board round-2,
  // config.mjs:235 = TASK-041 over-correction).
  const passwordOverrideApplied = applyPasswordOverride(config, process.env) === true;

  const PAAW_ROOT = resolve(baseDir, process.env.PAAW_ROOT || config.paawRoot || "../../..");
  const BACKUP_DIR = resolve(baseDir, process.env.PAAW_BACKUP_DIR || config.backupDir || "../../../backups");

  // Test-only knob: PAAW_MAX_BACKUPS overrides config.maxBackups when set
  const MAX_BACKUPS = Number(process.env.PAAW_MAX_BACKUPS ?? config.maxBackups ?? 7);

  // ── Event Log ──
  const EVENT_LOG_PATH = process.env.PAAW_EVENT_LOG || join(baseDir, "..", "events.jsonl");

  // Source directories archived by createBackup — computed ONCE per instance
  // so no path assembly happens inside request/backup flows (CWE-22 hardening).
  const BACKUP_SOURCE_DIRS = [join(PAAW_ROOT, "data"), join(PAAW_ROOT, ".paaw")];

  return {
    CONFIG_PATH,
    config,
    /**
     * Persist the current in-memory config to config.json.
     *
     * Review board minor#7 (RR-20261018-1738-6f2e, config.mjs:133): the runtime
     * `config` is NOT a faithful copy of the file — `createConfig` merges env
     * overrides into it in place (PAAW_GATEWAY_HOST / PAAW_GATEWAY_PORT /
     * PAAW_GATEWAY_PASSWORD*, see §host/port and applyPasswordOverride above).
     * Serialising it verbatim would freeze a one-shot env override into the
     * file, so we merge the DIFF against the pristine on-disk document through
     * the same read-merge-write seam used by updateConfigOnDisk() (no second
     * persistence mechanism).
     *
     * @param {object} [patch] partial config to merge (defaults to the whole
     *   in-memory config, with env-derived fields filtered out)
     * @returns {Promise<void>} resolves after the write (if any) completed
     */
    saveConfig: async (patch) => {
      if (patch) {
        // Explicit patch → caller decides which fields are persisted verbatim.
        return updateConfigOnDisk(CONFIG_PATH, patch, baseDir);
      }
      // No patch → persist the difference against the VERBATIM on-disk document.
      //
      // Baseline is readRawConfig (raw JSON), not loadConfig: loadConfig layers
      // fallback defaults, which would make a merely-defaulted field look
      // "changed" and be written back (review board round-2, config.mjs:240).
      const pristine = readRawConfig(CONFIG_PATH);
      const changed = {};
      for (const key of Object.keys(config)) {
        // host/port are always env-derived (merged in place above) → never write.
        if (ENV_DERIVED_KEYS.has(key)) continue;
        // users is env-derived only while the credential override is active
        // (TASK-041 original intent). Without an override it is ordinary file
        // data — an admin change must persist (review board round-2, major#1).
        if (key === "users" && passwordOverrideApplied) continue;
        // A file that is missing/unparseable is not a baseline: persisting the
        // whole in-memory config there would freeze every default onto disk.
        if (pristine === null) continue;
        if (!jsonEqual(config[key], pristine[key])) changed[key] = config[key];
      }
      // Nothing to persist → leave the file untouched (no needless rewrite).
      if (Object.keys(changed).length === 0) return;
      return updateConfigOnDisk(CONFIG_PATH, changed, baseDir);
    },
    /**
     * Persist ONLY the lazily re-hashed credentials (login-time upgrade) by
     * merging `users[].passwordHash` into the on-disk config.json.
     *
     * Never serialise the whole in-memory `config`: it carries env-derived
     * fields (PAAW_GATEWAY_HOST / PAAW_GATEWAY_PORT / PAAW_GATEWAY_PASSWORD*
     * override) that must not become permanent file settings — same root cause
     * as the env-override persistence issue at this file's env merge (§host/port
     * above) and at the login handler.
     *
     * Merge granularity: users are matched by `id`; a patched user replaces the
     * on-disk user object wholesale (so a stale legacy hash is never kept
     * alongside the upgraded one). A user absent from disk is NOT created here —
     * its credential came from the env override, and persisting it would freeze
     * that override into the file.
     *
     * @returns {number} how many persisted users carried a patched hash
     */
    saveCredentialUpgrades: () => {
      const current = loadConfig(CONFIG_PATH, baseDir);
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        throw new Error("config.json is not a JSON object");
      }
      const onDiskUsers = Array.isArray(current.users) ? current.users : [];
      const liveUsers = Array.isArray(config.users) ? config.users : [];
      let patched = 0;
      const users = onDiskUsers.map((diskUser) => {
        const live = liveUsers.find((u) => u && diskUser && u.id === diskUser.id);
        if (!live || typeof live.passwordHash !== "string") return diskUser;
        if (live.passwordHash === diskUser.passwordHash) return diskUser;
        patched += 1;
        return { ...diskUser, passwordHash: live.passwordHash };
      });
      if (patched > 0) saveConfig(CONFIG_PATH, { ...current, users });
      return patched;
    },
    PAAW_ROOT,
    BACKUP_DIR,
    EVENT_LOG_PATH,
    MAX_BACKUPS,
    BACKUP_SOURCE_DIRS,
  };
}