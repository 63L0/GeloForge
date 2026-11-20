/**
 * Cross-platform local filesystem lock (.geloforge/.state.lock) and multi-file rollback transaction helper.
 * Serializes concurrent local GeloForge CLI/MCP mutations with bounded timeouts and stale-lock recovery.
 * Note: This lock serializes cooperative local GeloForge processes — it does NOT prevent non-harness
 * processes or external editors from modifying workspace files directly.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertSafeWithinRoot, atomicWriteFile } from "./path-safety.mjs";

const ACTIVE_LOCKS = new Set();
const SLEEP_VIEW = new Int32Array(new SharedArrayBuffer(4));

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
  const expMs = Date.parse(String(parsed.expires_at || ""));
  if (Number.isFinite(expMs) && nowMs > expMs) {
    return true;
  }
  if (nowMs - st.mtimeMs > staleLockMs) {
    return true;
  }
  if (Number.isInteger(parsed.pid) && parsed.pid > 0 && parsed.pid !== process.pid && !isPidAlive(parsed.pid)) {
    return true;
  }
  return false;
}

function tryReclaimStaleLock(lockAbs) {
  const staleTmp = `${lockAbs}.stale-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.renameSync(lockAbs, staleTmp);
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "EPERM" || err.code === "EACCES")) {
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
}

function releaseLockSafe(lockAbs, token) {
  try {
    if (!fs.existsSync(lockAbs)) return;
    const st = fs.lstatSync(lockAbs);
    if (st.isSymbolicLink() || !st.isFile()) return;
    const parsed = JSON.parse(fs.readFileSync(lockAbs, "utf8"));
    if (parsed && parsed.token === token) {
      fs.unlinkSync(lockAbs);
    }
  } catch {
    // Do not unlink lock owned by another process or already removed
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

  const lockAbs = assertSafeWithinRoot(resolvedDir, ".geloforge/.state.lock");
  const token = crypto.randomBytes(12).toString("hex");
  const startMs = Date.now();

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
      if (!err || (err.code !== "EEXIST" && err.code !== "EPERM")) {
        throw err;
      }

      // Inspect existing lock (if present) for staleness or symlink violation
      let metaInfo = null;
      try {
        metaInfo = parseLockMeta(lockAbs);
      } catch (inspectErr) {
        if (inspectErr && inspectErr.code === "ENOENT") {
          continue;
        }
        throw inspectErr;
      }

      const nowMs = Date.now();
      if (isLockStale(metaInfo, staleMs, nowMs)) {
        if (tryReclaimStaleLock(lockAbs)) {
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
    return fn();
  } finally {
    ACTIVE_LOCKS.delete(canonicalDir);
    releaseLockSafe(lockAbs, token);
  }
}

/**
 * Executes a sequence of file mutations atomically per file and rolls back every touched file
 * to its exact pre-transaction state if any step or faultHook throws.
 */
export function runMultiFileTransaction(steps, { faultHook = null } = {}) {
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
      });
    } else {
      snapshots.set(step.filePath, {
        filePath: step.filePath,
        existed: false,
        previousContent: null,
      });
    }
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
        atomicWriteFile(step.filePath, step.content, { allowOverwrite: step.allowOverwrite !== false });
      }
      if (typeof faultHook === "function") {
        faultHook(`after:${step.label}`, i);
      }
    }
  } catch (err) {
    const rollbackErrors = [];
    for (const snap of Array.from(snapshots.values()).reverse()) {
      try {
        if (snap.existed) {
          atomicWriteFile(snap.filePath, snap.previousContent, { allowOverwrite: true });
        } else if (fs.existsSync(snap.filePath)) {
          fs.unlinkSync(snap.filePath);
        }
      } catch (rbErr) {
        rollbackErrors.push(`${snap.filePath}: ${rbErr.message}`);
      }
    }
    if (rollbackErrors.length > 0) {
      err.message = `${err.message} (rollback warnings: ${rollbackErrors.join("; ")})`;
    }
    throw err;
  }
}

export { sleepSyncMs };
