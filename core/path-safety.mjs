/**
 * Portable path, naming, symlink/junction, and boundary safety helpers.
 * Zero external dependencies and zero hardcoded drive letters or usernames.
 */

import crypto from "node:crypto";
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

function isOsManagedDarwinSymlink(cursorPath) {
  return process.platform === "darwin" && (cursorPath === "/tmp" || cursorPath === "/var" || cursorPath === "/etc");
}

function assertSafeAncestors(resolvedTarget, protectedDirs, kindLabel) {
  let cursor = path.dirname(resolvedTarget);
  const visited = new Set();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() && !isOsManagedDarwinSymlink(cursor)) {
        throw new Error(`Refusing ${kindLabel} with symbolic link or junction ancestor: ${cursor}`);
      }
      const realAnc = fs.realpathSync(cursor);
      const relTail = path.relative(cursor, resolvedTarget);
      const effectiveTarget = path.resolve(realAnc, relTail);
      for (const dir of protectedDirs) {
        const realProtected = fs.existsSync(dir) ? fs.realpathSync(dir) : dir;
        if (isSameOrInside(realAnc, realProtected) || isSameOrInside(effectiveTarget, realProtected)) {
          throw new Error(`Refusing ${kindLabel} resolving inside protected directory via ${cursor} -> ${realAnc}`);
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

  assertSafeAncestors(resolved, protectedDirs, "destination");

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

  // Check every existing path component between baseResolved and resolved for symlinks/junctions.
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  let cursor = baseResolved;
  for (const seg of segments) {
    cursor = path.join(cursor, seg);
    if (fs.existsSync(cursor)) {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed inside project paths: ${relativeOrTargetPath}`);
      }
    } else {
      try {
        const brokenStat = fs.lstatSync(cursor);
        if (brokenStat.isSymbolicLink()) {
          throw new Error(`Symbolic links are not allowed inside project paths: ${relativeOrTargetPath}`);
        }
      } catch (err) {
        if (err.code !== "ENOENT") {
          throw err;
        }
      }
      break;
    }
  }
  return resolved;
}

export function isForbiddenSecretPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) {
    return false;
  }
  if (segments.includes(".git") || segments.includes("secrets") || segments.includes(".aws") || segments.includes(".ssh")) {
    return true;
  }
  const base = segments[segments.length - 1];
  if (
    base === ".env" ||
    base.startsWith(".env.") ||
    base === ".npmrc" ||
    base === ".pypirc" ||
    base === ".netrc" ||
    base === "credentials.json" ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\..+)?$/.test(base)
  ) {
    return true;
  }
  return /\.(pem|key|p12|pfx|jks|keystore|mobileprovision|kdbx)$/i.test(base);
}

export const SECRET_CONTENT_PATTERNS = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
];

export function hasSecretContent(text) {
  if (typeof text !== "string" || text.length === 0) {
    return false;
  }
  return SECRET_CONTENT_PATTERNS.some((pat) => pat.test(text));
}

export function atomicWriteFile(resolvedOutPath, content, { allowOverwrite = true, onBeforeCommit = null } = {}) {
  const parent = path.dirname(resolvedOutPath);
  fs.mkdirSync(parent, { recursive: true });
  if (!allowOverwrite && fs.existsSync(resolvedOutPath)) {
    throw new Error(`Refusing to overwrite existing file: ${resolvedOutPath}`);
  }
  const tempPath = path.join(parent, `.geloforge-tmp-${crypto.randomBytes(6).toString("hex")}`);
  try {
    fs.writeFileSync(tempPath, content, { encoding: "utf8", flag: "wx" });
    if (typeof onBeforeCommit === "function") {
      onBeforeCommit(tempPath);
    }
    if (!allowOverwrite && fs.existsSync(resolvedOutPath)) {
      throw new Error(`Refusing to overwrite existing file: ${resolvedOutPath}`);
    }
    fs.renameSync(tempPath, resolvedOutPath);
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Ignore cleanup failure
    }
    throw err;
  }
}

export function validateOutputFilePath(rawOutPath, { harnessDir, workspaceRoot }) {
  if (typeof rawOutPath !== "string" || rawOutPath.trim().length === 0) {
    throw new Error("Output path must not be empty.");
  }
  if (CONTROL_CHAR_REGEX.test(rawOutPath)) {
    throw new Error("Output path contains illegal control characters.");
  }
  if (/^(\\\\|\/\/)/.test(rawOutPath)) {
    throw new Error(`Refusing UNC or device network path as output target: "${rawOutPath}".`);
  }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(rawOutPath)) {
    throw new Error(`Refusing output path containing traversal segment "..": "${rawOutPath}".`);
  }

  const resolved = path.resolve(rawOutPath);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) {
    throw new Error(`Refusing to write output file at filesystem root "${resolved}".`);
  }
  validateWindowsCompatibleSegments(resolved);

  const relFromRoot = resolved.slice(parsed.root.length);
  if (isForbiddenSecretPath(relFromRoot)) {
    throw new Error(`Refusing to write output to sensitive secret/credential path: "${rawOutPath}".`);
  }

  const protectedDirs = [path.resolve(harnessDir)];
  if (workspaceRoot && fs.existsSync(path.join(workspaceRoot, "worktrees"))) {
    protectedDirs.push(path.resolve(workspaceRoot, "worktrees"));
  }
  for (const dir of protectedDirs) {
    if (isSameOrInside(resolved, dir)) {
      throw new Error(`Refusing to write output inside protected directory: ${dir}`);
    }
  }

  try {
    const targetStat = fs.lstatSync(resolved);
    if (targetStat.isSymbolicLink()) {
      throw new Error(`Refusing to write output to a symbolic link: ${resolved}`);
    }
    if (targetStat.isDirectory()) {
      throw new Error(`Output file path points to an existing directory: ${resolved}`);
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }

  assertSafeAncestors(resolved, protectedDirs, "output path");

  return resolved;
}

export function walkNonSymlinkFiles(rootDir, absDir, predicate = () => true, warnings = null, options = {}) {
  if (!fs.existsSync(absDir)) {
    return [];
  }
  const onSymlink = typeof options.onSymlink === "function" ? options.onSymlink : null;
  const dirStat = fs.lstatSync(absDir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    const relDir = path.relative(rootDir, absDir).replace(/\\/g, "/") || ".";
    const msg = `Blocked symbolic link directory inside project: ${relDir}`;
    if (onSymlink) onSymlink(relDir, msg);
    else if (Array.isArray(warnings)) warnings.push(msg);
    return [];
  }
  const results = [];
  const entries = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }
    const full = path.join(absDir, entry.name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) {
      const rel = path.relative(rootDir, full).replace(/\\/g, "/");
      const msg = `Blocked symbolic link inside project: ${rel}`;
      if (onSymlink) onSymlink(rel, msg);
      else if (Array.isArray(warnings)) warnings.push(msg);
      continue;
    }
    if (stat.isDirectory()) {
      results.push(...walkNonSymlinkFiles(rootDir, full, predicate, warnings, options));
    } else if (stat.isFile() && predicate(full)) {
      results.push(full);
    }
  }
  return results;
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
