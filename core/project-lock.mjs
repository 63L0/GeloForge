/**
 * Cross-platform local filesystem lock (.geloforge/.state.lock), concurrent-safe stale-lock
 * reclamation, pre-image rollback journal (.geloforge/.tx-journal.json), and multi-file
 * transaction helper.
 *
 * Security & durability boundary:
 * - `.geloforge/.state.lock` serializes cooperative local GeloForge processes only (it is NOT
 *   an OS mandatory file lock preventing external editors from touching files).
 * - A lock owned by a living OS PID (`process.kill(pid, 0)`) is NEVER stolen regardless of TTL.
 * - `runMultiFileTransaction` performs caught-exception rollback immediately in-process and writes
 *   a pre-image journal (`.geloforge/.tx-journal.json`) so subsequent locked GeloForge operations
 *   roll back interrupted partial writes after a process crash/kill. It is NOT a kernel-level
 *   or fsync-backed ACID database across power loss or unsynchronized external readers.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertSafeWithinRoot, atomicWriteFile } from "./path-safety.mjs";

const ACTIVE_LOCKS = new Set();
const SLEEP_VIEW = new Int32Array(new SharedArrayBuffer(4));
const TRANSIENT_LOCK_FS_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function isTransientLockFsError(err) {
  return Boolean(err && TRANSIENT_LOCK_FS_CODES.has(err.code));
}

function sleepSyncMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(SLEEP_VIEW, 0, 0, Math.ceil(ms));
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === "EPERM") return true;
    return false;
  }
}

function parseLockMeta(lockAbs) {
  const st = fs.lstatSync(lockAbs);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`Refusing symbolic link or non-regular project lock file: ${lockAbs}`);
  }
  const raw = fs.readFileSync(lockAbs, "utf8");
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  return { st, parsed };
}

function isLockStale({ st, parsed }, staleLockMs, nowMs) {
  if (!parsed || typeof parsed !== "object") {
    // Allow brief grace window for another process still flushing JSON after openSync("wx")
    return nowMs - st.mtimeMs >= Math.min(250, staleLockMs);
  }
  // Never expire or steal a lock while its owning OS PID remains alive.
  if (Number.isInteger(parsed.pid) && parsed.pid > 0) {
    if (parsed.pid === process.pid || isPidAlive(parsed.pid)) {
      return false;
    }
    return true;
  }
  // Fallback only when lock metadata lacks a valid positive integer pid
  const expMs = Date.parse(String(parsed.expires_at || ""));
  if (Number.isFinite(expMs) && nowMs > expMs) {
    return true;
  }
  if (nowMs - st.mtimeMs > staleLockMs) {
    return true;
  }
  return false;
}

function isExpectedSameLock(currentMeta, expectedMeta) {
  const expToken = expectedMeta?.parsed?.token;
  if (typeof expToken === "string" && expToken.length > 0) {
    return currentMeta?.parsed?.token === expToken;
  }
  return !currentMeta?.parsed && currentMeta?.st?.mtimeMs === expectedMeta?.st?.mtimeMs;
}

function releaseLockSafe(lockAbs, token) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      if (!fs.existsSync(lockAbs)) return;
      const st = fs.lstatSync(lockAbs);
      if (st.isSymbolicLink() || !st.isFile()) return;
      const parsed = JSON.parse(fs.readFileSync(lockAbs, "utf8"));
      if (parsed && parsed.token === token) {
        fs.unlinkSync(lockAbs);
      }
      return;
    } catch (err) {
      if (isTransientLockFsError(err) && attempt < 4) {
        sleepSyncMs(10);
        continue;
      }
      // Do not unlink lock owned by another process or already removed
      return;
    }
  }
}

function acquireReclaimGuard(reclaimAbs, staleLockMs) {
  const guardToken = crypto.randomBytes(8).toString("hex");
  const guardTtlMs = Math.max(1000, staleLockMs);
  try {
    const fd = fs.openSync(reclaimAbs, "wx", 0o600);
    try {
      const now = Date.now();
      fs.writeFileSync(
        fd,
        `${JSON.stringify({ pid: process.pid, token: guardToken, created_at: new Date(now).toISOString() })}\n`,
        "utf8"
      );
    } finally {
      fs.closeSync(fd);
    }
    return guardToken;
  } catch (err) {
    if (!err || (err.code !== "EEXIST" && !isTransientLockFsError(err))) {
      throw err;
    }
    // Check if an abandoned reclaim guard was left by a dead process
    try {
      const meta = parseLockMeta(reclaimAbs);
      if (isLockStale(meta, guardTtlMs, Date.now())) {
        const tmp = `${reclaimAbs}.dead-${crypto.randomBytes(4).toString("hex")}`;
        try {
          fs.renameSync(reclaimAbs, tmp);
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        } catch {
          // Another process cleared or replaced it
        }
      }
    } catch {
      // Ignore transient ENOENT / busy races on guard check
    }
    return null;
  }
}

function tryReclaimStaleLock(lockAbs, expectedMeta, staleLockMs) {
  const reclaimAbs = `${lockAbs}.reclaim`;
  const guardToken = acquireReclaimGuard(reclaimAbs, staleLockMs);
  if (!guardToken) {
    return false;
  }

  try {
    let currentMeta;
    try {
      currentMeta = parseLockMeta(lockAbs);
    } catch (err) {
      if (err && (err.code === "ENOENT" || isTransientLockFsError(err))) {
        return false;
      }
      throw err;
    }

    // Re-verify identity and staleness so concurrent reclaimers never delete a winner's fresh live lock
    if (!isExpectedSameLock(currentMeta, expectedMeta) || !isLockStale(currentMeta, staleLockMs, Date.now())) {
      return false;
    }

    const staleTmp = `${lockAbs}.stale-${crypto.randomBytes(6).toString("hex")}`;
    try {
      fs.renameSync(lockAbs, staleTmp);
    } catch (err) {
      if (err && (err.code === "ENOENT" || isTransientLockFsError(err))) {
        return false;
      }
      throw err;
    }
    try {
      if (fs.existsSync(staleTmp)) {
        fs.unlinkSync(staleTmp);
      }
    } catch {
      // Ignore cleanup error on reclaimed stale lock temp file
    }
    return true;
  } finally {
    releaseLockSafe(reclaimAbs, guardToken);
  }
}

/**
 * Replays and clears any pending rollback journal (`.geloforge/.tx-journal.json`) left by an
 * interrupted process before executing new locked work. Caller must hold `.geloforge/.state.lock`.
 */
export function recoverPendingTransactionJournal(projectDir) {
  const resolvedDir = path.resolve(projectDir);
  const journalAbs = assertSafeWithinRoot(resolvedDir, ".geloforge/.tx-journal.json");
  if (!fs.existsSync(journalAbs)) {
    return { recovered: false, restoredFiles: 0 };
  }
  const st = fs.lstatSync(journalAbs);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`Refusing symbolic link or non-regular transaction journal: ${journalAbs}`);
  }

  const parsed = JSON.parse(fs.readFileSync(journalAbs, "utf8"));
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  let restoredFiles = 0;

  for (const entry of [...entries].reverse()) {
    if (!entry || typeof entry.relPath !== "string") continue;
    const targetAbs = assertSafeWithinRoot(resolvedDir, entry.relPath);
    if (fs.existsSync(targetAbs)) {
      const targetSt = fs.lstatSync(targetAbs);
      if (targetSt.isSymbolicLink() || !targetSt.isFile()) {
        throw new Error(`Refusing journal recovery onto symlink or non-regular path: ${entry.relPath}`);
      }
    }
    if (entry.existed) {
      atomicWriteFile(targetAbs, String(entry.previousContent ?? ""), { allowOverwrite: true });
    } else if (fs.existsSync(targetAbs)) {
      fs.unlinkSync(targetAbs);
    }
    restoredFiles += 1;
  }

  if (fs.existsSync(journalAbs)) {
    fs.unlinkSync(journalAbs);
  }

  return { recovered: true, restoredFiles };
}

function resolveSafeLockPath(resolvedDir, relPath, timeoutMs, delayMs, startMs) {
  while (true) {
    try {
      return assertSafeWithinRoot(resolvedDir, relPath);
    } catch (err) {
      const elapsed = Date.now() - startMs;
      if (!isTransientLockFsError(err) || elapsed >= timeoutMs) {
        throw err;
      }
      sleepSyncMs(Math.min(delayMs, timeoutMs - elapsed));
    }
  }
}

/**
 * Executes `fn` while holding an exclusive atomic lockfile at `<projectDir>/.geloforge/.state.lock`.
 */
export function withProjectLock(
  projectDir,
  fn,
  { lockTimeoutMs = 5000, staleLockMs = 30000, retryDelayMs = 15 } = {}
) {
  if (typeof projectDir !== "string" || projectDir.trim().length === 0) {
    throw new Error("Missing required project directory (--project <path>).");
  }
  const resolvedDir = path.resolve(projectDir);
  if (!fs.existsSync(resolvedDir)) {
    throw new Error(`Project directory does not exist: ${resolvedDir}`);
  }
  const rootStat = fs.lstatSync(resolvedDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Project root must be a real non-symlink directory: ${resolvedDir}`);
  }
  const manifestAbs = assertSafeWithinRoot(resolvedDir, "brain/manifest.yaml");
  if (!fs.existsSync(manifestAbs) || fs.lstatSync(manifestAbs).isSymbolicLink()) {
    throw new Error(`Missing or unsafe brain/manifest.yaml in ${resolvedDir}`);
  }
  const canonicalDir = fs.realpathSync(resolvedDir);
  if (ACTIVE_LOCKS.has(canonicalDir)) {
    return fn();
  }

  const timeout = Number.isFinite(Number(lockTimeoutMs)) && Number(lockTimeoutMs) > 0 ? Number(lockTimeoutMs) : 5000;
  const staleMs = Number.isFinite(Number(staleLockMs)) && Number(staleLockMs) > 0 ? Number(staleLockMs) : 30000;
  const delay = Number.isFinite(Number(retryDelayMs)) && Number(retryDelayMs) > 0 ? Number(retryDelayMs) : 15;

  const gfDirAbs = assertSafeWithinRoot(resolvedDir, ".geloforge");
  if (fs.existsSync(gfDirAbs)) {
    const dirSt = fs.lstatSync(gfDirAbs);
    if (dirSt.isSymbolicLink() || !dirSt.isDirectory()) {
      throw new Error(`Refusing symbolic link or non-directory .geloforge path: ${gfDirAbs}`);
    }
  } else {
    fs.mkdirSync(gfDirAbs, { recursive: true });
  }

  const startMs = Date.now();
  const lockAbs = resolveSafeLockPath(resolvedDir, ".geloforge/.state.lock", timeout, delay, startMs);
  const token = crypto.randomBytes(12).toString("hex");

  let acquired = false;
  while (!acquired) {
    try {
      const fd = fs.openSync(lockAbs, "wx", 0o600);
      try {
        const now = Date.now();
        const meta = {
          pid: process.pid,
          token,
          created_at: new Date(now).toISOString(),
          expires_at: new Date(now + staleMs).toISOString(),
        };
        fs.writeFileSync(fd, `${JSON.stringify(meta)}\n`, "utf8");
      } finally {
        fs.closeSync(fd);
      }
      acquired = true;
    } catch (err) {
      if (!err || (err.code !== "EEXIST" && !isTransientLockFsError(err))) {
        throw err;
      }

      // Inspect existing lock (if present) for staleness or symlink violation
      let metaInfo = null;
      let transientInspectError = false;
      try {
        metaInfo = parseLockMeta(lockAbs);
      } catch (inspectErr) {
        if (inspectErr && inspectErr.code === "ENOENT") {
          continue;
        }
        if (isTransientLockFsError(inspectErr)) {
          transientInspectError = true;
        } else {
          throw inspectErr;
        }
      }

      const nowMs = Date.now();
      if (!transientInspectError && isLockStale(metaInfo, staleMs, nowMs)) {
        if (tryReclaimStaleLock(lockAbs, metaInfo, staleMs)) {
          continue;
        }
      }

      const elapsed = nowMs - startMs;
      if (elapsed >= timeout) {
        throw new Error(
          `Timed out waiting for project state lock (.geloforge/.state.lock) after ${timeout}ms.`
        );
      }
      sleepSyncMs(Math.min(delay, timeout - elapsed));
    }
  }

  ACTIVE_LOCKS.add(canonicalDir);
  try {
    recoverPendingTransactionJournal(resolvedDir);
    return fn();
  } finally {
    ACTIVE_LOCKS.delete(canonicalDir);
    releaseLockSafe(lockAbs, token);
  }
}

/**
 * Executes a sequence of file mutations atomically per file with a pre-image rollback journal
 * (when `projectDir` is supplied). Restores pre-transaction state immediately on caught
 * exceptions and allows future locked processes to recover from interrupted runs via `.tx-journal.json`.
 */
export function runMultiFileTransaction(steps, { projectDir = null, faultHook = null } = {}) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return;
  }

  const snapshots = new Map();
  for (const step of steps) {
    if (!step || typeof step.filePath !== "string") {
      throw new Error("Invalid transaction step: missing filePath.");
    }
    if (snapshots.has(step.filePath)) continue;
    if (fs.existsSync(step.filePath)) {
      const st = fs.lstatSync(step.filePath);
      if (st.isSymbolicLink() || !st.isFile()) {
        throw new Error(`Refusing transaction target symlink or non-regular file: ${step.filePath}`);
      }
      snapshots.set(step.filePath, {
        filePath: step.filePath,
        existed: true,
        previousContent: fs.readFileSync(step.filePath, "utf8"),
        mode: step.mode,
      });
    } else {
      snapshots.set(step.filePath, {
        filePath: step.filePath,
        existed: false,
        previousContent: null,
      });
    }
  }

  let journalAbs = null;
  if (typeof projectDir === "string" && projectDir.trim().length > 0) {
    const resolvedProject = path.resolve(projectDir);
    journalAbs = assertSafeWithinRoot(resolvedProject, ".geloforge/.tx-journal.json");
    const entries = Array.from(snapshots.values()).map((snap) => {
      const relPath = path.relative(resolvedProject, path.resolve(snap.filePath)).replace(/\\/g, "/");
      if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) {
        throw new Error(`Refusing transaction journal entry outside project root: ${snap.filePath}`);
      }
      return {
        relPath,
        existed: snap.existed,
        previousContent: snap.previousContent,
      };
    });
    atomicWriteFile(
      journalAbs,
      `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString(), entries }, null, 2)}\n`,
      { allowOverwrite: true }
    );
  }

  try {
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      if (typeof faultHook === "function") {
        faultHook(step.label, i);
      }
      if (step.deleteIfExists) {
        if (fs.existsSync(step.filePath)) {
          fs.unlinkSync(step.filePath);
        }
      } else {
        atomicWriteFile(step.filePath, step.content, { allowOverwrite: step.allowOverwrite !== false, mode: step.mode });
      }
      if (typeof faultHook === "function") {
        faultHook(`after:${step.label}`, i);
      }
    }
    if (journalAbs && fs.existsSync(journalAbs)) {
      fs.unlinkSync(journalAbs);
    }
  } catch (err) {
    const rollbackErrors = [];
    for (const snap of Array.from(snapshots.values()).reverse()) {
      try {
        if (snap.existed) {
          atomicWriteFile(snap.filePath, snap.previousContent, { allowOverwrite: true, mode: snap.mode });
        } else if (fs.existsSync(snap.filePath)) {
          fs.unlinkSync(snap.filePath);
        }
      } catch (rbErr) {
        rollbackErrors.push(`${snap.filePath}: ${rbErr.message}`);
      }
    }
    if (rollbackErrors.length === 0 && journalAbs && fs.existsSync(journalAbs)) {
      try {
        fs.unlinkSync(journalAbs);
      } catch {
        // Leave journal for next lock acquisition if cleanup failed
      }
    }
    if (rollbackErrors.length > 0) {
      err.message = `${err.message} (rollback warnings: ${rollbackErrors.join("; ")})`;
    }
    throw err;
  }
}

export { sleepSyncMs };
