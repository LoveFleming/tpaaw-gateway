/**
 * PAAW Gateway — Backup module
 *
 * Backup creation, listing and restore. Restore depends on paaw-control
 * (start/stop the PAAW Server) and must never be imported by it — the
 * dependency is strictly one-way (backup → paaw-control).
 *
 * The pure filename validators (BACKUP_REGEX / BACKUP_DATE_REGEX) are
 * exported as constants. `backupPath` is created per-instance via
 * `createBackupManager` because it is bound to BACKUP_DIR, which is
 * env-derived and must be recomputed on every (cache-busted) entry import.
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { join, resolve, sep, relative, basename } from "path";
import { execFileSync } from "child_process";

export const BACKUP_REGEX = /^paaw-backup-\d{4}-\d{2}-\d{2}-\d{2}\.tar\.gz$/; // YYYY-MM-DD-HH
export const BACKUP_DATE_REGEX = /paaw-backup-(\d{4}-\d{2}-\d{2}-\d{2})/;

/**
 * Build the backup manager for one server instance.
 *
 * @param {object} deps
 * @param {string} deps.BACKUP_DIR directory holding backup archives
 * @param {number} deps.MAX_BACKUPS retention count
 * @param {string[]} deps.BACKUP_SOURCE_DIRS absolute dirs archived by createBackup
 * @param {string} deps.PAAW_ROOT PAAW data root (cwd for tar)
 * @param {(type: string, detail: string, userId?: string) => void} deps.logEvent
 * @param {() => { ok: boolean, pid?: number, error?: string }} deps.startPaaw
 * @param {() => object | null} deps.getPaawProcess current PAAW child handle or null
 * @returns {{
 *   backupPath: (name: unknown) => string | null,
 *   listBackups: () => object[],
 *   createBackup: (userId?: string) => object,
 *   restoreBackup: (filename: string, userId?: string) => object
 * }}
 */
export function createBackupManager(deps) {
  const { BACKUP_DIR, MAX_BACKUPS, BACKUP_SOURCE_DIRS, PAAW_ROOT, logEvent, startPaaw, getPaawProcess } = deps;

  /**
   * Centralized safe-path resolver for backup archive names (CWE-22).
   *
   * Validates `name` against the BACKUP_REGEX whitelist, then resolves it
   * under BACKUP_DIR and verifies directory containment. Returns the absolute
   * path, or null when the name is illegal / escapes BACKUP_DIR.
   *
   * Exported (via the entry module) for attack-case unit tests (TASK-011):
   * every backup filename flowing into fs calls MUST come through here.
   *
   * @param {unknown} name - candidate backup filename (e.g. from readdir or API)
   * @returns {string | null} absolute path inside BACKUP_DIR, or null
   */
  function backupPath(name) {
    if (typeof name !== "string" || !BACKUP_REGEX.test(name)) return null;
    const root = resolve(BACKUP_DIR) + sep;
    const p = resolve(BACKUP_DIR, name); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — validator internals; result is immediately containment-checked below (startsWith root) — this line IS the CWE-22 defense
    return p.startsWith(root) ? p : null;
  }

  function listBackups() {
    if (!existsSync(BACKUP_DIR)) return [];
    return readdirSync(BACKUP_DIR)
      .map(f => backupPath(f))
      .filter(p => p !== null)
      .map(p => {
        const f = basename(p);
        const stat = statSync(p); // nosemgrep: javascript.lang.security.audit.detect-non-literal-fs-filename — p is validated output of backupPath() and null-filtered upstream
        const dateMatch = f.match(BACKUP_DATE_REGEX);
        return {
          filename: f,
          date: dateMatch ? dateMatch[1] : "unknown",
          size: stat.size,
          sizeMB: (stat.size / 1024 / 1024).toFixed(1),
          created: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => b.created.localeCompare(a.created));
  }

  function createBackup(userId = "system") {
    if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });

    const dateStr = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19).replace("T", "-");
    const filename = `paaw-backup-${dateStr.slice(0, 13)}.tar.gz`;
    const filepath = backupPath(filename);
    if (!filepath) {
      throw new Error("Invalid backup filename: " + filename);
    }

    logEvent("backup_start", "Creating backup...", userId);

    try {
      // Backup data/ and .paaw/ directories
      const dirs = BACKUP_SOURCE_DIRS.filter(d => existsSync(d)); // nosemgrep: javascript.lang.security.audit.detect-non-literal-fs-filename — d iterates from hardcoded constant BACKUP_SOURCE_DIRS, not user input
      const relDirs = dirs.map(d => relative(PAAW_ROOT, d));
      execFileSync("tar", ["czf", filepath, ...relDirs], { cwd: PAAW_ROOT, encoding: "utf-8", timeout: 300000 });

      // Clean up old backups
      const backups = listBackups();
      if (backups.length > MAX_BACKUPS) {
        const toDelete = backups.slice(MAX_BACKUPS);
        for (const old of toDelete) {
          const oldPath = backupPath(old.filename);
          if (!oldPath) continue; // skip illegal names (defense in depth — list is already filtered)
          try { unlinkSync(oldPath); } catch {}
        }
      }

      logEvent("backup_done", `Backup created: ${filename}`, userId);
      return { ok: true, filename, size: statSync(filepath).size };
    } catch (err) {
      logEvent("backup_failed", `Backup failed: ${err.message}`, userId);
      return { ok: false, error: err.message };
    }
  }

  function restoreBackup(filename, userId = "system") {
    const filepath = backupPath(filename);
    if (!filepath) {
      return { ok: false, error: "Invalid backup filename" };
    }
    if (!existsSync(filepath)) return { ok: false, error: "Backup file not found" }; // nosemgrep: javascript.lang.security.audit.detect-non-literal-fs-filename — filepath is validated output of backupPath(filename); illegal names fail-closed above

    logEvent("restore_start", `Restoring from ${filename}...`, userId);

    try {
      // Fail-closed (F-01): never extract over a live server. The HTTP route
      // awaits a confirmed exit (stopPaaw) BEFORE calling this function — if a
      // process handle is still present here, something raced us; refuse.
      if (getPaawProcess()) {
        logEvent("restore_failed", "Restore refused: PAAW Server still running", userId);
        return { ok: false, error: "PAAW Server is still running — stop it before restoring" };
      }

      // Create a pre-restore backup just in case
      createBackup("system-restore-safety");

      // Extract
      execFileSync("tar", ["xzf", filepath], { cwd: PAAW_ROOT, encoding: "utf-8", timeout: 300000 });

      // Restart — report the outcome honestly (F-01 principle)
      const startResult = startPaaw();
      if (!startResult.ok) {
        logEvent("restore_done", `Restored from ${filename}, but restart failed: ${startResult.error}`, userId);
        return { ok: false, error: `Data restored from ${filename}, but PAAW Server failed to start — ${startResult.error}` };
      }

      logEvent("restore_done", `Restored from ${filename} (PID: ${startResult.pid})`, userId);
      return { ok: true, pid: startResult.pid };
    } catch (err) {
      logEvent("restore_failed", `Restore failed: ${err.message}`, userId);
      return { ok: false, error: err.message };
    }
  }

  return { backupPath, listBackups, createBackup, restoreBackup };
}