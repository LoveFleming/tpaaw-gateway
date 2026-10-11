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

import { readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";

/**
 * Load config.json; fall back to sane defaults when missing/unparseable.
 * @param {string} configPath absolute path to config.json
 * @returns {object} parsed config
 */
export function loadConfig(configPath, baseDir) {
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return {
      port: 4199,
      paawRoot: resolve(baseDir, "..", "..", ".."),
      paawServerCmd: "node packages/server/src/index.mjs",
      paawServerPort: 4097,
      backupDir: resolve(baseDir, "..", "..", "..", "backups"),
      backupSchedule: "0 3 * * *",
      maxBackups: 7,
      users: [{ id: "admin", name: "Admin", role: "admin", passwordHash: "change_me" }],
      sessionSecret: "paaw-gw-default",
      sessionMaxAge: 86400000,
    };
  }
}

/**
 * Persist config back to config.json.
 * @param {string} configPath absolute path to config.json
 * @param {object} config config object
 */
export function saveConfig(configPath, config) {
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Build the full runtime config + derived paths for one server instance.
 *
 * Invoked by the entry at load time so env-derived state is fresh on every
 * (cache-busted) import.
 *
 * @param {string} baseDir the entry's __dirname (`<root>/src`)
 * @returns {{
 *   CONFIG_PATH: string, config: object, saveConfig: () => void,
 *   PAAW_ROOT: string, BACKUP_DIR: string, EVENT_LOG_PATH: string,
 *   MAX_BACKUPS: number, BACKUP_SOURCE_DIRS: string[]
 * }}
 */
export function createConfig(baseDir) {
  // Test-only knob: PAAW_CONFIG overrides the config path (same isolation
  // pattern as PAAW_ROOT / PAAW_BACKUP_DIR / PAAW_EVENT_LOG / PAAW_MAX_BACKUPS).
  // E2E tests use this to spawn the server against a throwaway config and
  // never touch the developer's real gateway on :4199.
  const CONFIG_PATH = process.env.PAAW_CONFIG || join(baseDir, "..", "config.json");
  const config = loadConfig(CONFIG_PATH, baseDir);

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
    saveConfig: () => saveConfig(CONFIG_PATH, config),
    PAAW_ROOT,
    BACKUP_DIR,
    EVENT_LOG_PATH,
    MAX_BACKUPS,
    BACKUP_SOURCE_DIRS,
  };
}