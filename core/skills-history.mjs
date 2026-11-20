/**
 * Safe filesystem staging, atomic directory swap, content-addressed snapshot history,
 * and rollback gate verification extracted from core/skills-lifecycle.mjs.
 * Zero external dependencies, zero network calls.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml, serializeYaml } from "./yaml-subset.mjs";
import {
  WINDOWS_RESERVED_NAME_REGEX,
  assertSafeWithinRoot,
  atomicWriteFile,
  deriveSlug,
  hasSecretContent,
  isForbiddenSecretPath,
  isSameOrInside,
} from "./path-safety.mjs";
import { loadProjectManifestAndState } from "./project-locator.mjs";
import {
  MAX_SKILL_BYTES,
  MAX_SKILL_TEXT_RESOURCE_BYTES,
  SKILL_NAME_REGEX,
  computeSkillPackageDigest,
  inspectSkillPackage,
  isOversizedTextFile,
} from "./skills.mjs";
import { lintSkill } from "./skills-lint.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_HARNESS_DIR = path.resolve(__dirname, "..");

export const SHA256_PREFIX_REGEX = /^sha256:[a-f0-9]{64}$/;
export const REVISION_REGEX = /^rev-\d{4}$/;

export function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function sha256Tag(input) {
  return `sha256:${sha256Hex(input)}`;
}

export function assertSafeDirNonSymlink(absDir, label) {
  if (!fs.existsSync(absDir)) return false;
  const st = fs.lstatSync(absDir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`Refusing symbolic link or non-directory ${label}: ${absDir}`);
  }
  return true;
}

export function assertSafeAncestorChain(absTarget, stopAtRoot, label) {
  const resolvedStop = path.resolve(stopAtRoot);
  let cursor = path.dirname(path.resolve(absTarget));
  while (cursor && isSameOrInside(cursor, resolvedStop)) {
    if (fs.existsSync(cursor)) {
      const st = fs.lstatSync(cursor);
      if (st.isSymbolicLink()) {
        throw new Error(`Refusing symbolic link/junction ancestor for ${label}: ${cursor}`);
      }
    }
    if (cursor === resolvedStop) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

export function readSafeYamlWithinProject(projectDir, relPath) {
  if (isForbiddenSecretPath(relPath)) {
    throw new Error(`Forbidden secret path: ${relPath}`);
  }
  const full = assertSafeWithinRoot(projectDir, relPath);
  if (!fs.existsSync(full)) {
    return null;
  }
  const st = fs.lstatSync(full);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`Refusing symbolic link or non-regular file: ${relPath}`);
  }
  if (st.size > MAX_SKILL_BYTES) {
    throw new Error(`File exceeds maximum safe record size (${MAX_SKILL_BYTES} bytes): ${relPath}`);
  }
  const raw = fs.readFileSync(full, "utf8");
  if (hasSecretContent(raw)) {
    throw new Error(`Blocked file containing credential-like pattern: ${relPath}`);
  }
  return {
    relPath: relPath.replace(/\\/g, "/"),
    fullPath: full,
    raw,
    sha256: sha256Tag(raw),
    data: parseYaml(raw, relPath),
  };
}

export function copyTreeSafe(srcDir, destDir, rootSrc = srcDir) {
  const srcResolved = path.resolve(srcDir);
  const rootResolved = path.resolve(rootSrc);
  const srcStat = fs.lstatSync(srcResolved);
  if (srcStat.isSymbolicLink() || !srcStat.isDirectory()) {
    throw new Error(`Refusing symbolic link or non-directory source tree: ${srcDir}`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcResolved, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const srcEntry = path.join(srcResolved, entry.name);
    const destEntry = path.join(destDir, entry.name);
    const relFromRoot = path.relative(rootResolved, srcEntry).replace(/\\/g, "/");
    const st = fs.lstatSync(srcEntry);
    if (st.isSymbolicLink()) {
      throw new Error(`Blocked symbolic link/junction during copy: ${srcEntry}`);
    }
    if (isForbiddenSecretPath(relFromRoot)) {
      throw new Error(`Blocked forbidden secret path during copy: ${relFromRoot}`);
    }
    if (st.isDirectory()) {
      copyTreeSafe(srcEntry, destEntry, rootResolved);
    } else if (st.isFile()) {
      if (st.size > MAX_SKILL_TEXT_RESOURCE_BYTES && isOversizedTextFile(srcEntry)) {
        throw new Error(
          `Text resource exceeds maximum safe scannable size (${MAX_SKILL_TEXT_RESOURCE_BYTES} bytes) during copy: ${relFromRoot}`
        );
      }
      const buf = fs.readFileSync(srcEntry);
      if (!buf.includes(0) && hasSecretContent(buf.toString("utf8"))) {
        throw new Error(`Blocked secret literal in file during copy: ${entry.name}`);
      }
      fs.writeFileSync(destEntry, buf, { flag: "wx" });
    } else {
      throw new Error(`Blocked unsupported special file during copy: ${srcEntry}`);
    }
  }
}

export function removeDirSafe(absDir) {
  if (fs.existsSync(absDir)) {
    fs.rmSync(absDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
}

export function renameSyncRetry(fromPath, toPath) {
  let lastErr;
  for (let i = 0; i < 4; i += 1) {
    try {
      fs.renameSync(fromPath, toPath);
      return;
    } catch (err) {
      lastErr = err;
      if (err.code !== "EPERM" && err.code !== "EBUSY") {
        throw err;
      }
    }
  }
  throw lastErr;
}

/**
 * Stages an atomic directory replacement over `targetDir` with explicit commit/rollback handles.
 * Uses lstatSync (not existsSync) so broken symlinks at `targetDir` fail closed immediately.
 */
export function stageAtomicSwap(stageDir, targetDir) {
  const parent = path.dirname(targetDir);
  fs.mkdirSync(parent, { recursive: true });
  const backupDir = path.join(parent, `.geloforge-backup-${crypto.randomBytes(6).toString("hex")}`);
  let hadExisting = false;
  let targetStat = null;

  try {
    targetStat = fs.lstatSync(targetDir);
    hadExisting = true;
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }

  if (targetStat && (targetStat.isSymbolicLink() || !targetStat.isDirectory())) {
    throw new Error(`Refusing symbolic link or non-directory at active destination: ${targetDir}`);
  }

  try {
    if (hadExisting) {
      renameSyncRetry(targetDir, backupDir);
    }
    renameSyncRetry(stageDir, targetDir);
  } catch (err) {
    if (hadExisting && !fs.existsSync(targetDir) && fs.existsSync(backupDir)) {
      try {
        renameSyncRetry(backupDir, targetDir);
      } catch {
        // Best-effort restore
      }
    }
    removeDirSafe(stageDir);
    throw err;
  }

  return {
    commit() {
      if (hadExisting) {
        removeDirSafe(backupDir);
      }
    },
    rollback() {
      try {
        if (fs.existsSync(targetDir)) {
          removeDirSafe(targetDir);
        }
        if (hadExisting && fs.existsSync(backupDir)) {
          renameSyncRetry(backupDir, targetDir);
        }
      } catch {
        // Best-effort restore
      }
      removeDirSafe(stageDir);
    },
  };
}

export function validateSkillSlugName(rawName, fallbackTitle = null) {
  const candidate = rawName ? String(rawName).trim() : deriveSlug(fallbackTitle || "");
  if (!candidate || !SKILL_NAME_REGEX.test(candidate) || candidate.includes("--")) {
    throw new Error(
      `Invalid skill name "${candidate}". Use lowercase kebab-case ASCII letters, digits, and single hyphens (e.g. "verify-webhook-tests").`
    );
  }
  if (WINDOWS_RESERVED_NAME_REGEX.test(candidate)) {
    throw new Error(`Skill name "${candidate}" conflicts with a reserved Windows device name.`);
  }
  return candidate;
}

export function validateAndLintSkillStaging({ stageDir, skillName, displayRoot }) {
  const pkg = inspectSkillPackage({
    skillDir: stageDir,
    folderName: skillName,
    source: "quarantined_draft",
    trustTier: "quarantined_draft",
    displayRoot,
  });
  const lint = lintSkill(pkg);
  if (!pkg.valid || lint.counts.critical > 0 || lint.counts.error > 0 || lint.counts.high > 0 || lint.counts.warning > 0) {
    const details = lint.findings.map((f) => `[${f.severity} ${f.ruleId}] ${f.message}`).join("; ");
    throw new Error(`Candidate skill "${skillName}" failed strict validation/security lint: ${details}`);
  }
  const digestInfo = computeSkillPackageDigest(stageDir);
  return { pkg, lint, digestInfo };
}

export function validateSkillHistoryLedger(data, skillName, histRel) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${histRel}: history ledger must be a YAML object.`);
  }
  if (data.skill_name !== skillName) {
    throw new Error(`${histRel}: history skill_name "${data.skill_name}" mismatches "${skillName}".`);
  }
  if (!Array.isArray(data.revisions)) {
    throw new Error(`${histRel}: history ledger missing "revisions" list.`);
  }
  const seenRevs = new Set();
  for (const entry of data.revisions) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${histRel}: invalid revision entry.`);
    }
    if (typeof entry.revision !== "string" || !REVISION_REGEX.test(entry.revision)) {
      throw new Error(`${histRel}: invalid revision ID "${entry.revision}".`);
    }
    if (seenRevs.has(entry.revision)) {
      throw new Error(`${histRel}: duplicate revision ID "${entry.revision}" in history ledger.`);
    }
    seenRevs.add(entry.revision);
    if (typeof entry.package_sha256 !== "string" || !SHA256_PREFIX_REGEX.test(entry.package_sha256)) {
      throw new Error(`${histRel}: invalid package_sha256 for ${entry.revision}.`);
    }
    const expectedSnapRel = `.geloforge/skill-history/${skillName}/snapshots/${entry.revision}`;
    const normSnap =
      typeof entry.snapshot_path === "string"
        ? entry.snapshot_path.replace(/\\/g, "/").replace(/^\.\//, "")
        : "";
    if (normSnap !== expectedSnapRel) {
      throw new Error(
        `${histRel}: forged or out-of-confinement snapshot_path "${entry.snapshot_path}" for ${entry.revision} (expected "${expectedSnapRel}").`
      );
    }
  }
}

export function readSkillHistoryData(projectDir, skillName) {
  const histRel = `.geloforge/skill-history/${skillName}/history.yaml`;
  const loaded = readSafeYamlWithinProject(projectDir, histRel);
  if (!loaded || !loaded.data) {
    return { histRel, exists: false, data: { schema_version: "1.0", skill_name: skillName, revisions: [] } };
  }
  validateSkillHistoryLedger(loaded.data, skillName, histRel);
  return { histRel, exists: true, data: loaded.data };
}

export function findConsumedApprovalInHistory(projectDir, approvalId) {
  const histRootRel = ".geloforge/skill-history";
  const histRootAbs = assertSafeWithinRoot(projectDir, histRootRel);
  if (!assertSafeDirNonSymlink(histRootAbs, histRootRel)) {
    return null;
  }
  const entries = fs.readdirSync(histRootAbs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const childAbs = path.join(histRootAbs, entry.name);
    const st = fs.lstatSync(childAbs);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link/junction inside ${histRootRel}/${entry.name}`);
    }
    if (!st.isDirectory()) continue;
    const histRel = `${histRootRel}/${entry.name}/history.yaml`;
    const histAbs = assertSafeWithinRoot(projectDir, histRel);
    if (!fs.existsSync(histAbs)) continue;
    const loaded = readSafeYamlWithinProject(projectDir, histRel);
    const revisions = Array.isArray(loaded?.data?.revisions) ? loaded.data.revisions : [];
    for (const rev of revisions) {
      if (typeof rev?.approval_ref === "string" && rev.approval_ref.toUpperCase() === approvalId) {
        return { skillName: entry.name, revision: rev.revision, histRel };
      }
    }
  }
  return null;
}

export function inspectRollbackSnapshotForGate(projectDir, skillName, targetRevision) {
  if (!REVISION_REGEX.test(String(targetRevision || "").trim())) {
    throw new Error(`Invalid target revision "${targetRevision}". Expected rev-NNNN (e.g. rev-0001).`);
  }
  const histInfo = readSkillHistoryData(projectDir, skillName);
  if (!histInfo.exists || !Array.isArray(histInfo.data.revisions)) {
    throw new Error(`No history ledger found for skill "${skillName}" at ${histInfo.histRel}.`);
  }
  const entry = histInfo.data.revisions.find((r) => r.revision === targetRevision);
  if (!entry) {
    throw new Error(`Revision "${targetRevision}" not found in history for skill "${skillName}".`);
  }

  const snapshotRel = entry.snapshot_path;
  const snapshotDir = assertSafeWithinRoot(projectDir, snapshotRel);
  if (!fs.existsSync(snapshotDir)) {
    throw new Error(`Snapshot directory missing on disk for ${targetRevision}: ${snapshotRel}`);
  }
  const verifiedSnap = validateAndLintSkillStaging({
    stageDir: snapshotDir,
    skillName,
    displayRoot: `.geloforge/skill-history/${skillName}/snapshots`,
  });
  if (verifiedSnap.digestInfo.digest !== entry.package_sha256) {
    throw new Error(
      `Snapshot integrity failure for ${targetRevision} (disk=${verifiedSnap.digestInfo.digest} vs ledger=${entry.package_sha256}). Refusing rollback.`
    );
  }

  const activeRel = `.agents/skills/${skillName}`;
  const activeDir = assertSafeWithinRoot(projectDir, activeRel);
  if (!fs.existsSync(activeDir)) {
    throw new Error(`Active skill "${skillName}" is not installed at ${activeRel}.`);
  }
  const currentBaseSha = computeSkillPackageDigest(activeDir).digest;
  if (currentBaseSha === verifiedSnap.digestInfo.digest) {
    throw new Error(`Active skill "${skillName}" already matches ${targetRevision} (${currentBaseSha}).`);
  }

  return {
    histInfo,
    entry,
    snapshotRel,
    snapshotDir,
    targetDigest: verifiedSnap.digestInfo.digest,
    currentBaseSha,
  };
}

export function stageSnapshotAtomic(srcDir, targetSnapAbs, expectedDigest, revLabel) {
  let exists = false;
  try {
    fs.lstatSync(targetSnapAbs);
    exists = true;
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }
  if (exists) {
    throw new Error(`Snapshot target already exists (refusing overwrite): ${targetSnapAbs}`);
  }
  const snapParent = path.dirname(targetSnapAbs);
  fs.mkdirSync(snapParent, { recursive: true });
  const tempSnap = path.join(snapParent, `.geloforge-snap-tmp-${crypto.randomBytes(6).toString("hex")}`);
  try {
    copyTreeSafe(srcDir, tempSnap);
    const writtenDigest = computeSkillPackageDigest(tempSnap).digest;
    if (writtenDigest !== expectedDigest) {
      throw new Error(`Snapshot verification failed after copy for ${revLabel}.`);
    }
    renameSyncRetry(tempSnap, targetSnapAbs);
  } catch (err) {
    removeDirSafe(tempSnap);
    throw err;
  }
}

export function recordHistoryRevision({
  projectDir,
  skillName,
  action,
  sourceDirToSnapshot,
  packageSha256,
  baseSha256,
  approvalId,
  authorizationTier,
  approverId,
  evidenceDigests,
  createdAt,
  restoredFromRevision = null,
  reason = null,
}) {
  const histBaseRel = `.geloforge/skill-history/${skillName}`;
  const histBaseAbs = assertSafeWithinRoot(projectDir, histBaseRel);
  assertSafeAncestorChain(histBaseAbs, projectDir, histBaseRel);
  assertSafeDirNonSymlink(histBaseAbs, histBaseRel);

  const histInfo = readSkillHistoryData(projectDir, skillName);
  const histAbs = assertSafeWithinRoot(projectDir, histInfo.histRel);
  const previousHistoryRaw = histInfo.exists ? fs.readFileSync(histAbs, "utf8") : null;
  const revisions = [...(histInfo.data.revisions || [])];
  const createdSnapshotDirs = [];

  try {
    // If upgrading a manually added active skill with no history yet, capture rev-0000 baseline first
    if (revisions.length === 0 && action === "promote_update" && baseSha256) {
      const activeAbs = assertSafeWithinRoot(projectDir, `.agents/skills/${skillName}`);
      const snap0Rel = `${histBaseRel}/snapshots/rev-0000`;
      const snap0Abs = assertSafeWithinRoot(projectDir, snap0Rel);
      stageSnapshotAtomic(activeAbs, snap0Abs, baseSha256, "rev-0000");
      createdSnapshotDirs.push(snap0Abs);
      revisions.push({
        revision: "rev-0000",
        action: "baseline_snapshot",
        package_sha256: baseSha256,
        base_sha256: null,
        snapshot_path: snap0Rel,
        approval_ref: null,
        authorization_tier: "preexisting_baseline",
        approver_id: null,
        evidence_digests: [],
        restored_from_revision: null,
        reason: "Captured preexisting .agents/skills baseline before first adaptive update.",
        recorded_at: createdAt,
      });
    }

    const nextNum =
      revisions.reduce((max, r) => {
        const m = /^rev-(\d{4})$/.exec(r.revision || "");
        return m ? Math.max(max, Number.parseInt(m[1], 10)) : max;
      }, 0) + 1;
    const revId = `rev-${String(nextNum).padStart(4, "0")}`;
    const snapRel = `${histBaseRel}/snapshots/${revId}`;
    const snapAbs = assertSafeWithinRoot(projectDir, snapRel);

    stageSnapshotAtomic(sourceDirToSnapshot, snapAbs, packageSha256, revId);
    createdSnapshotDirs.push(snapAbs);

    const entry = {
      revision: revId,
      action,
      package_sha256: packageSha256,
      base_sha256: baseSha256 || null,
      snapshot_path: snapRel,
      approval_ref: approvalId || null,
      authorization_tier: authorizationTier,
      approver_id: approverId || null,
      evidence_digests: [...(evidenceDigests || [])],
      restored_from_revision: restoredFromRevision,
      reason,
      recorded_at: createdAt,
    };
    revisions.push(entry);

    const ledger = {
      schema_version: "1.0",
      skill_name: skillName,
      revisions,
    };
    atomicWriteFile(histAbs, serializeYaml(ledger, { headerComment: "Append-only GeloForge skill revision ledger" }), {
      allowOverwrite: true,
    });

    return {
      revision: revId,
      snapshotRel: snapRel,
      snapshotAbs: snapAbs,
      historyRel: histInfo.histRel,
      historyAbs: histAbs,
      previousHistoryRaw,
      createdSnapshotDirs,
      entry,
    };
  } catch (err) {
    try {
      if (previousHistoryRaw !== null) {
        atomicWriteFile(histAbs, previousHistoryRaw, { allowOverwrite: true });
      } else if (fs.existsSync(histAbs)) {
        fs.rmSync(histAbs, { force: true });
      }
    } catch {
      // Best-effort restore
    }
    for (const sDir of createdSnapshotDirs) {
      removeDirSafe(sDir);
    }
    throw err;
  }
}

/**
 * Inspects append-only revision history, snapshot integrity, and active skill drift.
 */
export function getSkillHistory({ projectDir, skillName, harnessDir = DEFAULT_HARNESS_DIR }) {
  const loaded = loadProjectManifestAndState(projectDir, harnessDir);
  const cleanName = validateSkillSlugName(skillName);
  const histInfo = readSkillHistoryData(loaded.projectDir, cleanName);

  const activeRel = `.agents/skills/${cleanName}`;
  const activeAbs = assertSafeWithinRoot(loaded.projectDir, activeRel);
  const activeExists = fs.existsSync(activeAbs);
  const currentSha256 = activeExists ? computeSkillPackageDigest(activeAbs).digest : null;

  const revisions = (histInfo.data.revisions || []).map((entry) => {
    let snapshotValid = false;
    let snapshotError = null;
    try {
      const snapAbs = assertSafeWithinRoot(loaded.projectDir, entry.snapshot_path);
      if (fs.existsSync(snapAbs)) {
        const snapSha = computeSkillPackageDigest(snapAbs).digest;
        snapshotValid = snapSha === entry.package_sha256;
        if (!snapshotValid) snapshotError = `Digest mismatch (${snapSha} vs ${entry.package_sha256})`;
      } else {
        snapshotError = "Snapshot missing";
      }
    } catch (err) {
      snapshotError = err.message;
    }
    return {
      ...entry,
      snapshotValid,
      snapshotError,
    };
  });

  const latest = revisions.length > 0 ? revisions[revisions.length - 1] : null;
  const driftDetected = Boolean(activeExists && latest && currentSha256 !== latest.package_sha256);

  return {
    skillName: cleanName,
    historyExists: histInfo.exists,
    historyRel: histInfo.histRel,
    activeExists,
    currentSha256,
    latestRecordedSha256: latest ? latest.package_sha256 : null,
    driftDetected,
    revisions,
  };
}
