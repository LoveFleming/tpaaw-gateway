/**
 * PAAW Gateway — PAAW control module
 *
 * Owns the PAAW Server child-process lifecycle (start/stop/restart), health
 * checks, version/git introspection and the upgrade flow.
 *
 * Depends on config (paths + config.paawServerCmd/Port) and events (logEvent).
 * The paawProcess/paawStatus/... state is private to the closure and exposed
 * only via read getters (getPaawProcess / isRunning) — never as a writable
 * export.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { execSync, spawn } from "child_process";

/**
 * Create the PAAW control surface for one server instance.
 *
 * @param {object} deps
 * @param {object} deps.config parsed config (paawServerCmd / paawServerPort)
 * @param {string} deps.PAAW_ROOT PAAW data root
 * @param {(type: string, detail: string, userId?: string) => void} deps.logEvent
 * @param {typeof execSync} [deps.exec] optional execSync override (test seam);
 *   defaults to node:child_process execSync. Drives the upgrade flow's
 *   git/npm commands. Used only by upgradePaaw.
 * @returns {object} control API (see exported functions below)
 */
export function createPaawControl(deps) {
  const { config, PAAW_ROOT, logEvent } = deps;
  // Test seam: upgradePaaw shells out to *commands* — git AND npm — so the seam
  // is named execCmd to reflect that it is not git-specific. Injecting a fake
  // exec lets us drive success/failure paths deterministically without touching
  // the FS/git.
  const execCmd = deps.exec ?? execSync;

  // ── Process state (private to this closure) ──
  let paawProcess = null;
  let paawStatus = "stopped"; // stopped | starting | running | crashed
  let paawPid = null;
  let paawStartTime = null;
  let paawRestartCount = 0;

  /**
   * Start the PAAW Server child process.
   * @returns {{ ok: boolean, pid?: number, error?: string }}
   */
  function startPaaw() {
    if (paawProcess) return { ok: false, error: "Already running" };

    paawStatus = "starting";
    logEvent("server_starting", "PAAW Server starting...");

    const [cmd, ...args] = config.paawServerCmd.split(" ");
    paawProcess = spawn(cmd, args, {
      cwd: PAAW_ROOT,
      env: { ...process.env, PORT: String(config.paawServerPort || 4097) },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    paawPid = paawProcess.pid;
    paawStartTime = Date.now();
    paawStatus = "running";

    paawProcess.stdout.on("data", (data) => {
      // Could log to file if needed
    });

    paawProcess.stderr.on("data", (data) => {
      // Could log errors
    });

    paawProcess.on("exit", (code, signal) => {
      paawStatus = code === 0 ? "stopped" : "crashed";
      paawProcess = null;
      paawPid = null;
      logEvent("server_exited", `PAAW Server exited (code=${code}, signal=${signal})`);
      if (code !== 0 && code !== null) {
        paawRestartCount++;
      }
    });

    paawProcess.on("error", (err) => {
      paawStatus = "crashed";
      paawProcess = null;
      paawPid = null;
      logEvent("server_error", `PAAW Server error: ${err.message}`);
    });

    logEvent("server_started", `PAAW Server started (PID: ${paawPid})`);
    return { ok: true, pid: paawPid };
  }

  // In-flight stop dedupe: concurrent callers (restart / upgrade / restore) share one stop sequence
  let stoppingPromise = null;

  /**
   * Stop PAAW Server. Resolves ONLY when the process has actually exited
   * (exit event fired = PID reaped), not when SIGTERM was merely sent — F-01 fix.
   *
   * Sequence: SIGTERM → (still alive after 5s) SIGKILL → (still no exit event
   * after 10s) resolve { ok:false } honestly. Fail-closed: callers must NOT
   * start a new process on top of a live one; a reported failure means failure.
   */
  function stopPaaw() {
    if (!paawProcess) return Promise.resolve({ ok: false, error: "Not running" });
    if (stoppingPromise) return stoppingPromise;

    const proc = paawProcess;
    logEvent("server_stopping", "PAAW Server stopping...");

    stoppingPromise = new Promise((resolve) => {
      let settled = false;
      const finish = (ok, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(sigkillTimer);
        clearTimeout(failsafeTimer);
        stoppingPromise = null;
        if (ok) {
          paawStatus = "stopped"; // intentional stop overrides the "crashed-by-signal" mark from the generic exit handler
        } else {
          paawStatus = "crashed"; // process refused to die — surface it, don't paper over it
        }
        resolve(ok ? { ok: true } : { ok: false, error });
      };

      const onExit = (code, signal) => {
        proc.removeListener("exit", onExit);
        finish(true);
      };
      proc.on("exit", onExit);

      // Escalation: still alive after 5s grace period → SIGKILL
      const sigkillTimer = setTimeout(() => {
        try {
          if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        } catch (err) {
          finish(false, `SIGKILL failed: ${err.message}`);
        }
      }, 5000);

      // Failsafe: even SIGKILL produced no exit event → report failure honestly (F-01)
      const failsafeTimer = setTimeout(() => {
        finish(false, "process did not exit after SIGKILL");
      }, 10000);

      // Initiate graceful shutdown
      try {
        proc.kill("SIGTERM");
      } catch (err) {
        finish(false, `SIGTERM failed: ${err.message}`);
      }
    });

    return stoppingPromise;
  }

  /**
   * Restart = stop (fully awaited, exit-confirmed) THEN start — F-01 fix.
   * If the stop fails we abort and report it; never start a second process
   * while the old one may still hold the port.
   */
  async function restartPaaw() {
    if (paawProcess) {
      const stopResult = await stopPaaw();
      if (!stopResult.ok) {
        logEvent("server_restart_failed", `Restart aborted: stop failed (${stopResult.error})`);
        return { ok: false, error: `Restart aborted: stop failed — ${stopResult.error}` };
      }
    }
    const result = startPaaw();
    logEvent(
      result.ok ? "server_restarted" : "server_restart_failed",
      result.ok ? `PAAW Server restarted (PID: ${result.pid})` : `Restart failed at start phase: ${result.error}`,
    );
    return result;
  }

  // ── Version Manager ──
  function getCurrentVersion() {
    try {
      const pkg = JSON.parse(readFileSync(join(PAAW_ROOT, "package.json"), "utf-8"));
      return pkg.version || "unknown";
    } catch {
      return "unknown";
    }
  }

  function getGitInfo() {
    try {
      const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: PAAW_ROOT, encoding: "utf-8" }).trim();
      const commit = execSync("git rev-parse --short HEAD", { cwd: PAAW_ROOT, encoding: "utf-8" }).trim();
      const date = execSync("git log -1 --format=%ci", { cwd: PAAW_ROOT, encoding: "utf-8" }).trim();
      const status = execSync("git status --porcelain", { cwd: PAAW_ROOT, encoding: "utf-8" }).trim();
      const behind = execSync("git rev-list HEAD..origin/" + branch + " --count", { cwd: PAAW_ROOT, encoding: "utf-8" }).trim();
      return {
        branch,
        commit,
        date,
        dirty: status.length > 0,
        behind: parseInt(behind) || 0,
        statusLines: status.split("\n").filter(Boolean).slice(0, 20),
      };
    } catch (err) {
      return { branch: "unknown", commit: "?", date: "?", dirty: false, behind: 0, error: err.message };
    }
  }

  function getLatestVersion() {
    try {
      // Check remote tags
      execSync("git fetch --tags", { cwd: PAAW_ROOT, encoding: "utf-8", timeout: 15000 });
      const tags = execSync("git tag --sort=-v:refname", { cwd: PAAW_ROOT, encoding: "utf-8" }).trim().split("\n");
      const latestTag = tags.find(t => t.startsWith("v")) || tags[0] || "none";
      return latestTag;
    } catch {
      return "unknown";
    }
  }

  /**
   * Count entries in the git stash stack (read-only probe).
   *
   * Used by upgradePaaw to detect whether THIS run created a new stash entry
   * (compare before/after counts) rather than trusting "stash list non-empty",
   * which conflates pre-existing stashes with our own. On any error we return 0:
   * a failed probe must not abort the upgrade, and treating "unknown" as "no
   * new stash" keeps us from popping a stash we did not create.
   *
   * @returns {number} number of stash entries (0 on error/empty)
   */
  function countStashEntries() {
    try {
      const out = execCmd("git stash list", { cwd: PAAW_ROOT, encoding: "utf-8" });
      return String(out ?? "")
        .split("\n")
        .filter((line) => line.trim().length > 0).length;
    } catch {
      return 0;
    }
  }

  /**
   * Bring the (previously stopped) server back up after an upgrade failure.
   *
   * Shared by the npm-install failure branch and the outer catch so the
   * "upgrade failure must NOT leave the server down" guarantee (major#1) holds
   * on *every* failure path, not just npm install. Records the restart step,
   * pushes a warning + logs `upgrade_recover_failed` when recovery itself
   * fails (never pretend success), and logs `upgrade_recovered` on success.
   *
   * Idempotent: startPaaw() owns the guard and returns
   * { ok:false, error:"Already running" } if a process is still up. That is a
   * SUCCESS for recovery, not a failure (committee minor, 2026-10-20): the
   * operator's actual goal is "the server is running" — a live process means
   * we got there, regardless of which call path started it. In particular the
   * outer-catch path can reach here when stopPaaw() never actually stopped the
   * old server (e.g. the failure happened before any stop), so "Already
   * running" is the *expected* outcome there and must be reported as recovered.
   *
   * @param {string} userId audit actor
   * @param {Array<object>} steps upgrade step log to append to
   * @param {string[]} warnings operator-facing non-fatal warnings to append to
   * @returns {boolean} true if the server was recovered (running), else false
   */
  function attemptRecover(userId, steps, warnings) {
    let recoverResult;
    try {
      recoverResult = startPaaw();
    } catch (startErr) {
      // Synchronous spawn failure (e.g. empty/invalid paawServerCmd) — treat as
      // a failed recovery, not a crash of the whole upgrade response.
      recoverResult = { ok: false, error: startErr.message };
    }

    // "Already running" (or a live handle) means the server is up — the goal of
    // recovery is met even though startPaaw() refused to spawn a second process.
    const alreadyRunning = !recoverResult.ok
      && (recoverResult.error === "Already running" || isRunning());
    const recovered = recoverResult.ok || alreadyRunning;

    steps.push({
      step: "restart server",
      ok: recovered,
      detail: recoverResult.ok
        ? `PID ${recoverResult.pid}`
        : alreadyRunning
          ? "already running"
          : recoverResult.error,
    });

    if (!recovered) {
      // Recovery itself failed — fail loud, never pretend success.
      const warning = `Server recovery failed after upgrade error: ${recoverResult.error}`;
      warnings.push(warning);
      logEvent("upgrade_recover_failed", warning, userId);
      return false;
    }

    if (alreadyRunning) {
      logEvent("upgrade_recovered", "Server already running after upgrade failure", userId);
    } else {
      logEvent("upgrade_recovered", `Server restarted after upgrade failure (PID ${recoverResult.pid})`, userId);
    }
    return true;
  }

  async function upgradePaaw(userId = "system") {
    if (paawProcess) {
      // Stop first — exit-confirmed, no fixed sleep. Fail-closed (F-01):
      // never git-pull / npm-install under a live server process.
      const stopResult = await stopPaaw();
      if (!stopResult.ok) {
        logEvent("upgrade_failed", `Upgrade aborted: stop failed (${stopResult.error})`, userId);
        return { ok: false, error: `Upgrade aborted: stop failed — ${stopResult.error}` };
      }
    }

    logEvent("upgrade_start", "Starting upgrade...", userId);

    const steps = [];
    // Non-fatal issues the caller must surface to the operator (major#2):
    // e.g. a failed `git stash pop` means local changes may still be in the
    // stash / conflict — silently reporting ok would hide data-loss risk.
    const warnings = [];

    try {
      // Step 1: git stash (preserve local changes)
      // Per-operation stash detection (committee major, 2026-10-20): the previous
      // "git stash list non-empty ⇒ stashed" probe was WRONG — a pre-existing stash
      // from a prior session made every upgrade think *this* run had stashed, so a
      // later pop could pop someone else's old stash or misreport a conflict.
      // We now compare the stash COUNT before vs. after our own push: only a net
      // +1 means THIS operation created a new entry. `stashed` is the single source
      // of truth and gates the pop — we never pop a stash we did not create.
      const stashCountBefore = countStashEntries();
      try {
        execCmd("git stash", { cwd: PAAW_ROOT, encoding: "utf-8" });
      } catch {
        // "nothing to stash" is a normal, non-error outcome — the count probe
        // below will confirm no new entry was created (stashed=false).
      }
      const stashCountAfter = countStashEntries();
      const stashed = stashCountAfter > stashCountBefore;
      steps.push({ step: "git stash", ok: true, note: stashed ? "stashed" : "nothing to stash" });

      // Step 2: git pull
      const gitInfo = getGitInfo();
      const pullResult = execCmd(`git pull origin ${gitInfo.branch}`, { cwd: PAAW_ROOT, encoding: "utf-8", timeout: 60000 });
      steps.push({ step: "git pull", ok: true, output: pullResult.trim().slice(0, 200) });

      // Step 3: git stash pop (restore local changes)
      // Only pop when WE created a stash this run. When `stashed` is false we must
      // NOT run `git stash pop` at all — a bare pop would restore whatever stash
      // already existed on the machine (possibly another operator's work).
      if (!stashed) {
        steps.push({ step: "git stash pop", ok: true, note: "no stash entries" });
      } else {
        try {
          execCmd("git stash pop", { cwd: PAAW_ROOT, encoding: "utf-8" });
          steps.push({ step: "git stash pop", ok: true });
        } catch (stashErr) {
          const msg = String(stashErr?.message ?? "");
          // We DID stash, yet the pop failed — almost always a merge conflict.
          // We must NOT discard local changes, and we must NOT continue on top
          // of a dirty/conflicted tree (major#2).
          //
          // minor#3: a conflicted working tree is exactly the state we must NOT
          // boot from — starting the server here could load half-merged modules
          // with conflict markers. So we deliberately do NOT attemptRecover();
          // we keep the server STOPPED and emit a loud, actionable warning for a
          // human to resolve the conflict manually. This is an intentional
          // exception to the "never leave the server down" guarantee (major#1):
          // leaving it down is strictly safer than starting on a broken tree.
          const warning = "git stash pop failed (conflict) — server left STOPPED. "
            + "Resolve the merge conflict manually, then start the server.";
          warnings.push(warning);
          steps.push({ step: "git stash pop", ok: false, warning: true, note: "conflict", detail: msg });
          logEvent("upgrade_failed", `Upgrade aborted at git stash pop (conflict): ${msg}`, userId);

          return {
            ok: false,
            steps,
            warnings,
            recovered: false,
            error: `Upgrade aborted at git stash pop (conflict): ${msg} — server left stopped for manual conflict resolution.`,
          };
        }
      }

      // Step 4: npm install — 正式機只裝 production deps（--omit=dev），
      // 與 src/lib/install.mjs 的 installDeps 一致，避免升級時把 devDependencies 帶上正式機。
      // Upgrade failure must NOT leave the server down (major#1): on failure we
      // still try to bring the server back up and reflect that in the response.
      try {
        const installResult = execCmd("npm install --omit=dev --no-audit --no-fund", { cwd: PAAW_ROOT, encoding: "utf-8", timeout: 300000 });
        steps.push({ step: "npm install", ok: true, output: installResult.trim().split("\n").slice(-3).join(" | ").slice(0, 200) });
      } catch (installErr) {
        steps.push({ step: "npm install", ok: false, detail: installErr.message });
        logEvent("upgrade_failed", `Upgrade failed at npm install: ${installErr.message}`, userId);

        // Attempt recovery: bring the (previously stopped) server back up.
        const recovered = attemptRecover(userId, steps, warnings);
        return {
          ok: false,
          steps,
          warnings,
          recovered,
          error: `Upgrade failed: ${installErr.message} — server ${recovered ? "running (recovered)" : "not running — restart FAILED"}.`,
        };
      }

      // Step 5: Start server again
      const startResult = startPaaw();
      steps.push({ step: "restart server", ok: startResult.ok, detail: startResult.ok ? `PID ${startResult.pid}` : startResult.error });

      // Step 6: Verify
      await new Promise(r => setTimeout(r, 3000));
      const healthCheck = await healthCheckPaaw();
      steps.push({ step: "health check", ok: healthCheck.ok, detail: healthCheck.detail });

      const newVersion = getCurrentVersion();
      const newGit = getGitInfo();
      logEvent("upgrade_done", `Upgraded to ${newVersion} (${newGit.commit})`, userId);

      return { ok: true, steps, warnings, version: newVersion, git: newGit };
    } catch (err) {
      // Any step *outside* the handled branches (most commonly Step 2 `git pull`
      // — remote conflict / no network) can throw here. By this point we have
      // already tried to stop the server (the stop is the first action and a
      // stop failure returns early, above), so we must still attempt recovery or
      // a failed upgrade leaves the production machine down (major#1 — same
      // guarantee as the npm install branch, previously a hole).
      //
      // minor#4 (committee, 2026-10-20): this path does NOT strictly guarantee
      // "the old server was stopped" — attemptRecover() therefore treats a live
      // process ("Already running") as a successful recovery rather than a
      // failure, and the wording below reflects the actual end state instead of
      // asserting a restart that may not have happened.
      logEvent("upgrade_failed", `Upgrade failed: ${err.message}`, userId);
      const recovered = attemptRecover(userId, steps, warnings);
      return {
        ok: false,
        steps,
        warnings,
        recovered,
        error: `Upgrade failed: ${err.message} — server ${recovered ? "running (recovered)" : "not running — restart FAILED"}.`,
      };
    }
  }

  // ── Health Check ──
  async function healthCheckPaaw() {
    if (paawStatus !== "running") return { ok: false, detail: "Server not running" };

    try {
      const res = await fetch(`http://127.0.0.1:${config.paawServerPort || 4097}/api/health`);
      if (res.ok) {
        const data = await res.json();
        return { ok: true, detail: "Healthy", ...data };
      }
      return { ok: false, detail: `HTTP ${res.status}` };
    } catch {
      return { ok: false, detail: "Connection refused" };
    }
  }

  function getSystemHealth() {
    const memUsage = process.memoryUsage();
    const uptime = process.uptime();

    return {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      uptime: Math.floor(uptime),
      memory: {
        rss: (memUsage.rss / 1024 / 1024).toFixed(0) + " MB",
        heapUsed: (memUsage.heapUsed / 1024 / 1024).toFixed(0) + " MB",
        heapTotal: (memUsage.heapTotal / 1024 / 1024).toFixed(0) + " MB",
      },
      paawServer: {
        status: paawStatus,
        pid: paawPid,
        uptime: paawStartTime ? Math.floor((Date.now() - paawStartTime) / 1000) : 0,
        restartCount: paawRestartCount,
      },
      version: getCurrentVersion(),
      git: getGitInfo(),
    };
  }

  // ── Read-only state getters (no writable exports) ──
  /** @returns {object | null} current PAAW child-process handle, or null */
  function getPaawProcess() {
    return paawProcess;
  }

  /** @returns {boolean} whether the PAAW Server is considered running */
  function isRunning() {
    return !!paawProcess;
  }

  return {
    startPaaw,
    stopPaaw,
    restartPaaw,
    healthCheckPaaw,
    upgradePaaw,
    getSystemHealth,
    getCurrentVersion,
    getGitInfo,
    getLatestVersion,
    getPaawProcess,
    isRunning,
  };
}