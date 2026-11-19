/**
 * Portable path, naming, symlink/junction, and boundary safety helpers.
 * Zero external dependencies and zero hardcoded drive letters or usernames.
 */

import fs from "node:fs";
import path from "node:path";

export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
export const WINDOWS_RESERVED_NAME_REGEX = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
export const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/;
export const INVALID_SEGMENT_CHARS_REGEX = /[<>:"/\\|?*]/;

export function isWindowsPlatform() {
  return process.platform === "win32";
}

function normalizeForCompare(targetPath) {
  const resolved = path.resolve(targetPath);
  return isWindowsPlatform() ? resolved.toLowerCase() : resolved;
}

export function isSameOrInside(candidatePath, parentPath) {
  const normCandidate = normalizeForCompare(candidatePath);
  const normParent = normalizeForCompare(parentPath);
  if (normCandidate === normParent) {
    return true;
  }
  const prefix = normParent.endsWith(path.sep) ? normParent : normParent + path.sep;
  return normCandidate.startsWith(prefix);
}

export function validateProjectName(rawName) {
  if (typeof rawName !== "string" || rawName.trim().length === 0) {
    throw new Error("Missing required project name (--name).");
  }
  const name = rawName.trim();
  if (name.length < 3 || name.length > 80) {
    throw new Error("--name must be between 3 and 80 characters after trimming.");
  }
  if (CONTROL_CHAR_REGEX.test(name)) {
    throw new Error("--name must not contain control characters or newlines.");
  }
  if (INVALID_SEGMENT_CHARS_REGEX.test(name) || name.includes("..")) {
    throw new Error('--name must not contain path separators, "..", colons, or reserved characters (< > : " / \\ | ? *).');
  }
  if (name.endsWith(".")) {
    throw new Error("--name must not end with a trailing dot.");
  }
  if (WINDOWS_RESERVED_NAME_REGEX.test(name)) {
    throw new Error(`--name "${name}" conflicts with a reserved Windows device name.`);
  }
  return name;
}

export function deriveSlug(name) {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function validateSlug(slug) {
  if (typeof slug !== "string" || !SLUG_REGEX.test(slug)) {
    throw new Error(
      `Invalid slug "${slug}". Must match ${SLUG_REGEX} (3-50 chars, lowercase ASCII letters, digits, hyphens).`
    );
  }
  if (WINDOWS_RESERVED_NAME_REGEX.test(slug)) {
    throw new Error(`Slug "${slug}" is a reserved Windows device name.`);
  }
  return slug;
}

export function validateScalarText(label, value) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
  if (CONTROL_CHAR_REGEX.test(trimmed)) {
    throw new Error(`${label} must not contain control characters or newlines.`);
  }
  return trimmed;
}

function validateWindowsCompatibleSegments(resolvedPath) {
  const parsed = path.parse(resolvedPath);
  const remainder = resolvedPath.slice(parsed.root.length);
  const segments = remainder.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) {
    throw new Error(`Invalid destination path "${resolvedPath}".`);
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error(`Destination path "${resolvedPath}" contains invalid relative segment "${segment}".`);
    }
    if (INVALID_SEGMENT_CHARS_REGEX.test(segment)) {
      throw new Error(`Destination path segment "${segment}" contains illegal filename characters.`);
    }
    if (WINDOWS_RESERVED_NAME_REGEX.test(segment)) {
      throw new Error(`Destination path segment "${segment}" is a reserved Windows device name.`);
    }
    if (segment.endsWith(".") || segment.endsWith(" ")) {
      throw new Error(`Destination path segment "${segment}" must not end with a dot or trailing space.`);
    }
  }
}

export function validateDestinationPath(rawDest, { harnessDir, workspaceRoot }) {
  if (typeof rawDest !== "string" || rawDest.trim().length === 0) {
    throw new Error("Destination path must not be empty.");
  }
  if (CONTROL_CHAR_REGEX.test(rawDest)) {
    throw new Error("Destination path contains illegal control characters.");
  }
  if (/^(\\\\|\/\/)/.test(rawDest)) {
    throw new Error(`Refusing UNC or device network path as destination: "${rawDest}".`);
  }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(rawDest)) {
    throw new Error(`Refusing destination path containing traversal segment "..": "${rawDest}".`);
  }

  const resolved = path.resolve(rawDest);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) {
    throw new Error(`Refusing to initialize project at filesystem root "${resolved}".`);
  }

  validateWindowsCompatibleSegments(resolved);

  const protectedDirs = [
    path.resolve(harnessDir),
    path.resolve(workspaceRoot, "local-runtime"),
    path.resolve(workspaceRoot, "worktrees"),
  ];
  const exactForbidden = [
    path.resolve(workspaceRoot),
    path.resolve(workspaceRoot, "projects"),
  ];

  for (const dir of protectedDirs) {
    if (isSameOrInside(resolved, dir)) {
      throw new Error(`Refusing to write inside protected workspace directory: ${dir}`);
    }
  }
  for (const dir of exactForbidden) {
    if (normalizeForCompare(resolved) === normalizeForCompare(dir)) {
      throw new Error(`Refusing to initialize project directly at container directory: ${dir}`);
    }
  }

  // Reject if destination already exists (including broken symlinks).
  if (fs.existsSync(resolved)) {
    throw new Error(`Refusing to overwrite existing destination: ${resolved}`);
  }
  try {
    fs.lstatSync(resolved);
    throw new Error(`Refusing to overwrite existing destination entry: ${resolved}`);
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }

  // Walk existing ancestors to detect symbolic links / NTFS junctions and symlink-mediated escapes.
  let cursor = path.dirname(resolved);
  const visited = new Set();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing destination with symbolic link or junction ancestor: ${cursor}`);
      }
      const realAnc = fs.realpathSync(cursor);
      const relTail = path.relative(cursor, resolved);
      const effectiveTarget = path.resolve(realAnc, relTail);
      for (const dir of protectedDirs) {
        const realProtected = fs.existsSync(dir) ? fs.realpathSync(dir) : dir;
        if (isSameOrInside(realAnc, realProtected) || isSameOrInside(effectiveTarget, realProtected)) {
          throw new Error(`Refusing destination resolving inside protected directory via ${cursor} -> ${realAnc}`);
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }

  return resolved;
}

export function assertSafeWithinRoot(baseDir, relativeOrTargetPath) {
  if (typeof relativeOrTargetPath !== "string" || relativeOrTargetPath.trim().length === 0) {
    throw new Error("Path must be a non-empty string.");
  }
  if (CONTROL_CHAR_REGEX.test(relativeOrTargetPath)) {
    throw new Error(`Path contains illegal control characters: ${relativeOrTargetPath}`);
  }
  if (path.isAbsolute(relativeOrTargetPath)) {
    throw new Error(`Absolute path is not allowed inside project metadata: ${relativeOrTargetPath}`);
  }
  const baseResolved = path.resolve(baseDir);
  const resolved = path.resolve(baseResolved, relativeOrTargetPath);
  const rel = path.relative(baseResolved, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes project root: ${relativeOrTargetPath}`);
  }
  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed inside project metadata paths: ${relativeOrTargetPath}`);
    }
  }
  return resolved;
}

export function assertNoSymlinkInTree(rootDir) {
  const rootStat = fs.lstatSync(rootDir);
  if (rootStat.isSymbolicLink()) {
    throw new Error(`Refusing symbolic link / junction template root: ${rootDir}`);
  }
  if (!rootStat.isDirectory()) {
    return;
  }
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    const stat = fs.lstatSync(fullPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link / junction inside template tree: ${fullPath}`);
    }
    if (stat.isDirectory()) {
      assertNoSymlinkInTree(fullPath);
    }
  }
}
