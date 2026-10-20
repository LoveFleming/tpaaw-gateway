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
import { execSync, execFileSync, spawn } from "child_process";

/**
 * Create the PAAW control surface for one server instance.
 *
 * @param {object} deps
 * @param {object} deps.config parsed config (paawServerCmd / paawServerPort)
 * @param {string} deps.PAAW_ROOT PAAW data root
 * @param {(type: string, detail: string, userId?: string) => void} deps.logEvent
 * @param {typeof execSync} [deps.exec] optional execSync override (test seam);
 *   defaults to node:child_process execSync. Drives the upgrade flow's
 *   git/npm commands that are passed as a SHELL STRING. Used only by upgradePaaw.
 * @param {typeof execFileSync} [deps.execFile] optional execFileSync override
 *   (test seam); defaults to node:child_process execFileSync. Used for commands
 *   whose arguments must NOT pass through a shell (argv array → no quoting /
 *   injection surface).
 * @returns {object} control API (see exported functions below)
 */
export function createPaawControl(deps) {
  const { config, PAAW_ROOT, logEvent } = deps;
  // Test seam: upgradePaaw shells out to *commands* — git AND npm — so the seam
  // is named execCmd to reflect that it is not git-specific. Injecting a fake
  // exec lets us drive success/failure paths deterministically without touching
  // the FS/git.
  const execCmd = deps.exec ?? execSync;
  // Second seam for the argv form (no shell). Kept separate from execCmd so a
  // command can pass untrusted-ish args without ever building a shell string.
  //
  // When a test injects only `exec` (the historical single seam), derive the
  // argv form from it by flattening argv back into a shell-like string — so the
  // one fake keeps covering every command without callers having to wire two
  // seams. In production (no `exec` override) we use the real execFileSync.
  const execFileCmd = deps.execFile
    ?? (deps.exec
      ? (file, args, opts) => deps.exec(`${file} ${args.join(" ")}`, opts)
      : execFileSync);

  // Sibling stash ops share one timeout so a hung git never blocks the upgrade
  // indefinitely (committee minor#2: stashCreate previously had no timeout while
  // store/drop used 15s and apply used 30s — now all point at one constant).
  const STASH_OP_TIMEOUT_MS = 15000;

  // ── Process state (private to this closure) ──
  let paawProcess = null;
  let paawStatus = "stopped"; // stopped | starting | running | crashed
  let paawPid = null;
  let paawStartTime = null;
  let paawRestartCount = 0;

  /**
   * Start the PAAW Server child process.
   *
   * Additive contract (ADR-005): besides { ok, pid?, error? } the result also
   * carries a machine-readable `code` (stable identifier) and, when refused
   * because a process is already live, `alreadyRunning: true`. Callers must key
   * off these fields — never the human-facing `error` string, which may change
   * wording/locale at any time.
   *
   *   { ok:true,  pid }
   *   { ok:false, code:"ALREADY_RUNNING", alreadyRunning:true, error:"Already running" }
   *
   * @returns {{ ok: boolean, pid?: number, error?: string, code?: string, alreadyRunning?: boolean }}
   */
  function startPaaw() {
    if (paawProcess) {
      return { ok: false, code: "ALREADY_RUNNING", alreadyRunning: true, error: "Already running" };
    }

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
   * Create a stash commit WITHOUT touching the stash list, returning its sha.
   *
   * ADR-005: `git stash create` is the single stable seam for "did THIS run
   * stash anything". It does not push onto the shared stash stack, it returns a
   * commit sha on success and an EMPTY string when there is nothing to stash.
   * The sha is the single source of truth for whether we own a stash — we never
   * infer from a non-empty `git stash list` or a before/after count delta (both
   * were proven fragile: pre-existing stashes shift the baseline, and a failed
   * probe read as 0 can flip the comparison).
   *
   * Error policy (ADR-005 edge table): a REAL failure (corrupt repo, permission
   * denied, git missing) must NOT be swallowed into "nothing to stash" — that is
   * audit false-success. We rethrow so the caller marks the step failed and the
   * outer catch restores the server. `git stash create` simply returning "" is
   * the only "nothing to stash" signal.
   *
   * @returns {string} the stash commit sha, or "" when there is nothing to stash
   * @throws {Error} on any real git failure
   */
  function stashCreate() {
    // Timeout parity with the sibling stash ops (store/drop 15s, apply 30s): a
    // hung git (index lock, huge repo scan) must not block the upgrade forever.
    const out = execCmd("git stash create", { cwd: PAAW_ROOT, encoding: "utf-8", timeout: STASH_OP_TIMEOUT_MS });
    return String(out ?? "").trim();
  }

  /**
   * Classify a `git stash apply` failure message as a MERGE CONFLICT or not.
   *
   * `git stash apply` reports conflicts on stderr with stable phrasing, and the
   * node child_process error message carries that stderr verbatim. We match the
   * git conflict signatures (not generic words like "error" / "failed") so that
   * non-conflict failures (timeout, EACCES, ENOSPC, corrupt repo, "unable to
   * read tree") are NOT misdiagnosed as conflicts (committee major#1).
   *
   * @param {string} msg the raw error message from the failed apply
   * @returns {boolean} true only when the message evidences a real conflict
   */
  function isStashApplyConflict(msg) {
    return /CONFLICT\b|Automatic merge failed|merge conflict|fix conflicts/i.test(msg);
  }

  /**
   * Register a dangling stash commit (from `git stash create`) into the stash
   * list so it survives across subsequent git commands (a dangling commit can
   * be lost to gc). The -m message carries an ISO timestamp for human
   * inspection only; it is never parsed for logic (locale/format independent).
   *
   * @param {string} sha stash commit sha returned by stashCreate()
   * @returns {string} the message used
   */
  function stashStore(sha) {
    const message = `paaw-upgrade-${new Date().toISOString()}`;
    // argv form (no shell): the message / sha are passed as separate arguments,
    // so a future message containing quotes or backticks can never break out of
    // the command (command-injection hardening — committee minor).
    execFileCmd("git", ["stash", "store", "-m", message, sha], {
      cwd: PAAW_ROOT,
      encoding: "utf-8",
      timeout: STASH_OP_TIMEOUT_MS,
    });
    return message;
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
   * { ok:false, code:"ALREADY_RUNNING", alreadyRunning:true } if a process is
   * still up. That is a SUCCESS for recovery, not a failure (committee minor,
   * 2026-10-20): the operator's actual goal is "the server is running" — a live
   * process means we got there, regardless of which call path started it. In
   * particular the outer-catch path can reach here when stopPaaw() never
   * actually stopped the old server (e.g. the failure happened before any stop),
   * so "already running" is the *expected* outcome there and must be reported
   * as recovered.
   *
   * ADR-005: the check is STRUCTURAL (`alreadyRunning` flag / `code`), never
   * `error === "Already running"` — the error string is human-facing and may
   * change wording, which would silently break the recovery decision.
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

    // A live server (structured flag, or a handle that is up regardless of which
    // call path started it) means the goal of recovery is met even though
    // startPaaw() refused to spawn a second process.
    const alreadyRunning = !recoverResult.ok
      && (recoverResult.alreadyRunning === true || recoverResult.code === "ALREADY_RUNNING" || isRunning());
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
    // e.g. a failed stash restore means local changes may still be in the
    // stash / conflict — silently reporting ok would hide data-loss risk.
    const warnings = [];

    try {
      // Step 1: stash local changes (if any) — ADR-005.
      //
      // Identification uses `git stash create`, which returns a commit sha when
      // it stashes and an EMPTY string when there is nothing to stash. It does
      // NOT touch the shared stash stack, so the sha is the single source of
      // truth for "we own this stash" — no `git stash list` non-empty probe and
      // no before/after count delta (both proven fragile: old stashes shift the
      // baseline, and a failed probe read as 0 flips the comparison).
      //
      // A REAL error (corrupt repo, permission, git missing) from stashCreate()
      // / stashStore() propagates to the outer catch: the step is marked failed
      // and the server is restored — it must never be swallowed into a fake
      // "nothing to stash" success.
      const stashSha = stashCreate();
      const stashed = stashSha.length > 0;
      if (stashed) {
        // The create-commit is dangling (no ref) and can be gc'd, so register
        // it in the stash list to keep it alive across the pull below and to
        // make it visible to a human via `git stash list`.
        stashStore(stashSha);
        steps.push({ step: "git stash", ok: true, note: `stashed ${stashSha.slice(0, 12)}` });
      } else {
        steps.push({ step: "git stash", ok: true, note: "nothing to stash" });
      }

      // Step 2: git pull
      const gitInfo = getGitInfo();
      const pullResult = execCmd(`git pull origin ${gitInfo.branch}`, { cwd: PAAW_ROOT, encoding: "utf-8", timeout: 60000 });
      steps.push({ step: "git pull", ok: true, output: pullResult.trim().slice(0, 200) });

      // Step 3: restore local changes — only for the sha WE created.
      //
      // We apply the exact sha (never a bare `git stash pop`, which would grab
      // whatever is on top of the shared stack — possibly another operator's
      // work). `apply` is non-destructive: if it fails the stash entry survives,
      // so no data is lost; only a CLEAN apply is followed by `drop` to clean up
      // our own entry.
      if (!stashed) {
        steps.push({ step: "git stash restore", ok: true, note: "no stash entries" });
      } else {
        try {
          execCmd(`git stash apply ${stashSha}`, { cwd: PAAW_ROOT, encoding: "utf-8", timeout: 30000 });
        } catch (stashErr) {
          const msg = String(stashErr?.message ?? "");
          // An apply failure is NOT always a conflict: it can also be a timeout
          // (30s), a permission error, a full disk, a corrupt repo, etc.
          // Conflating all of them as "conflict" (committee major#1) misleads the
          // operator into hand-resolving a conflict that does not exist AND
          // routes them into the higher-risk "server stays STOPPED" branch. Only
          // a REAL conflict justifies that. So we classify first:
          const conflict = isStashApplyConflict(msg);
          // Local changes are preserved in both cases (apply never drops), so no
          // data is lost regardless of the failure kind.
          if (conflict) {
            // A conflicted working tree is exactly the state we must NOT boot
            // from (starting the server here could load half-merged modules with
            // conflict markers). Deliberately do NOT attemptRecover(): keep the
            // server STOPPED and emit a loud, actionable warning. This is an
            // intentional exception to the "never leave the server down"
            // guarantee — leaving it down is strictly safer than starting broken.
            const warning = "git stash apply failed (merge conflict) — server left STOPPED. "
              + "Your local changes are preserved in the stash; resolve the conflict manually, then start the server.";
            warnings.push(warning);
            steps.push({ step: "git stash restore", ok: false, warning: true, note: "conflict", detail: msg });
            logEvent("upgrade_failed", `Upgrade aborted at git stash apply (conflict): ${msg}`, userId);

            return {
              ok: false,
              steps,
              warnings,
              recovered: false,
              error: `Upgrade aborted at git stash apply (conflict): ${msg} — server left stopped for manual conflict resolution.`,
            };
          }

          // NON-conflict failure (timeout / permission / disk / corrupt repo / …):
          // nothing is half-merged, so booting the restored server is safe. Route
          // through the standard recovery path (like the other failure branches)
          // so a transient/non-conflict git failure does NOT needlessly leave the
          // server down, and surface the raw error so the operator sees the real
          // cause instead of a misleading "conflict" diagnosis.
          const warning = `git stash apply failed (non-conflict) — your local changes remain in the stash; `
            + `cause: ${msg}`;
          warnings.push(warning);
          steps.push({ step: "git stash restore", ok: false, warning: true, note: "apply failed", detail: msg });
          logEvent("upgrade_failed", `Upgrade failed at git stash apply (non-conflict): ${msg}`, userId);
          const recovered = attemptRecover(userId, steps, warnings);
          return {
            ok: false,
            steps,
            warnings,
            recovered,
            error: `Upgrade failed at git stash apply (non-conflict): ${msg} — server ${recovered ? "running (recovered)" : "not running — restart FAILED"}.`,
          };
        }

        // Apply succeeded → our entry is now redundant; drop it. A drop failure
        // loses no data (the entry simply remains) — warn so a human can clean
        // up manually, but the upgrade itself proceeds.
        try {
          execCmd(`git stash drop ${stashSha}`, { cwd: PAAW_ROOT, encoding: "utf-8", timeout: 15000 });
          steps.push({ step: "git stash restore", ok: true, note: "applied + dropped" });
        } catch (dropErr) {
          const msg = String(dropErr?.message ?? "");
          warnings.push(`git stash dropped failed: ${msg} — local changes were applied; a redundant stash entry may remain (git stash list).`);
          steps.push({ step: "git stash restore", ok: true, warning: true, note: "applied, drop failed", detail: msg });
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
      // process (structured alreadyRunning flag) as a successful recovery rather
      // than a failure, and the wording below reflects the actual end state
      // instead of asserting a restart that may not have happened.
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