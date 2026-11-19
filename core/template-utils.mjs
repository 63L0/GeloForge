/**
 * Shared template rendering, compatibility profile loading, timestamp validation,
 * and lightweight read-only project discovery helpers.
 * Zero external dependencies.
 */

import fs from "node:fs";
import path from "node:path";
import { parseSemver } from "./compatibility.mjs";
import { assertNoSymlinkInTree, validateProjectName } from "./path-safety.mjs";

const PROFILE_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;

export function escapeYamlScalarText(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function renderSinglePass(rawContent, tokens, isYaml, sourceLabel) {
  return rawContent.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key) => {
    if (!Object.hasOwn(tokens, key)) {
      throw new Error(`Unsupported template placeholder "{{${key}}}" in ${sourceLabel}`);
    }
    const val = tokens[key];
    return isYaml ? escapeYamlScalarText(val) : val;
  });
}

export function validateCreatedAt(rawCreatedAt) {
  if (rawCreatedAt === undefined || rawCreatedAt === null) {
    return new Date().toISOString();
  }
  const trimmed = String(rawCreatedAt).trim();
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed) || trimmed.length < 10) {
    throw new Error(`Invalid --created-at ISO timestamp "${rawCreatedAt}".`);
  }
  return trimmed;
}

export function resolveProfile(profileName, compatConfig, profilesDir) {
  if (!profileName) {
    return null;
  }
  const clean = profileName.trim();
  if (!PROFILE_NAME_REGEX.test(clean)) {
    throw new Error(`Invalid profile name "${profileName}".`);
  }
  if (!Object.hasOwn(compatConfig.profiles, clean)) {
    const allowed = Object.keys(compatConfig.profiles).join(", ");
    throw new Error(`Unknown project profile "${clean}". Available profiles: ${allowed}`);
  }
  const profileDir = path.join(profilesDir, clean);
  if (!fs.existsSync(profileDir) || !fs.statSync(profileDir).isDirectory()) {
    throw new Error(`Profile directory missing for "${clean}": ${profileDir}`);
  }
  assertNoSymlinkInTree(profileDir);

  const metaPath = path.join(profileDir, "profile.json");
  if (!fs.existsSync(metaPath)) {
    throw new Error(`Profile metadata missing: ${metaPath}`);
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  if (meta.name !== clean) {
    throw new Error(`Profile metadata mismatch in ${metaPath}: expected "${clean}", got "${meta.name}".`);
  }
  if (meta.compatible_template_major !== compatConfig.supported_template_major) {
    throw new Error(
      `Profile "${clean}" requires template major ${meta.compatible_template_major}, harness uses ${compatConfig.supported_template_major}.`
    );
  }
  const parsedProfVer = parseSemver(meta.version);
  if (!parsedProfVer || parsedProfVer.major !== compatConfig.supported_profile_major) {
    throw new Error(`Profile "${clean}" has incompatible version "${meta.version}".`);
  }
  return { meta, profileDir };
}

function sanitizeInferredName(candidate) {
  if (typeof candidate !== "string") return null;
  let cleaned = candidate.trim();
  if (cleaned.startsWith("@") && cleaned.includes("/")) {
    cleaned = cleaned.split("/").slice(1).join("-");
  }
  cleaned = cleaned
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]+/g, " ")
    .replace(/\.\.+/g, " ")
    .replace(/\.+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  if (cleaned.length < 3) {
    return null;
  }
  try {
    return validateProjectName(cleaned);
  } catch {
    return null;
  }
}

/**
 * Infers a display name read-only from common project manifests or directory basename.
 */
export function inferProjectName(destDir) {
  const tryReadSafe = (fileName) => {
    const full = path.join(destDir, fileName);
    if (!fs.existsSync(full)) return null;
    try {
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink() || !st.isFile() || st.size > 256 * 1024) return null;
      return fs.readFileSync(full, "utf8");
    } catch {
      return null;
    }
  };

  const pkgRaw = tryReadSafe("package.json");
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw);
      const inferred = sanitizeInferredName(pkg?.name);
      if (inferred) return inferred;
    } catch {
      // Ignore malformed package.json
    }
  }

  const pyRaw = tryReadSafe("pyproject.toml");
  if (pyRaw) {
    const match = pyRaw.match(/^\s*name\s*=\s*["']([^"'\r\n]+)["']/m);
    const inferred = sanitizeInferredName(match?.[1]);
    if (inferred) return inferred;
  }

  const cargoRaw = tryReadSafe("Cargo.toml");
  if (cargoRaw) {
    const match = cargoRaw.match(/^\s*name\s*=\s*["']([^"'\r\n]+)["']/m);
    const inferred = sanitizeInferredName(match?.[1]);
    if (inferred) return inferred;
  }

  const goModRaw = tryReadSafe("go.mod");
  if (goModRaw) {
    const match = goModRaw.match(/^\s*module\s+([^\s\r\n]+)/m);
    if (match?.[1]) {
      const tail = match[1].split("/").filter(Boolean).pop();
      const inferred = sanitizeInferredName(tail);
      if (inferred) return inferred;
    }
  }

  return sanitizeInferredName(path.basename(destDir)) || "Adopted Project";
}

/**
 * Performs read-only filename-based stack detection (marked as unverified draft hints).
 */
export function detectStackHints(destDir) {
  const hints = [];
  let rootEntries = [];
  try {
    rootEntries = fs.readdirSync(destDir, { withFileTypes: true }).map((e) => e.name);
  } catch {
    return hints;
  }
  const entrySet = new Set(rootEntries);
  const addIfPresent = (file, label) => {
    if (entrySet.has(file)) {
      hints.push({ marker: file, label });
    }
  };

  addIfPresent("package.json", "Node.js / JavaScript (`package.json`)");
  addIfPresent("tsconfig.json", "TypeScript (`tsconfig.json`)");
  addIfPresent("pyproject.toml", "Python (`pyproject.toml`)");
  addIfPresent("requirements.txt", "Python dependencies (`requirements.txt`)");
  addIfPresent("go.mod", "Go module (`go.mod`)");
  addIfPresent("Cargo.toml", "Rust crate (`Cargo.toml`)");
  addIfPresent("pom.xml", "Java Maven (`pom.xml`)");
  addIfPresent("build.gradle", "Gradle (`build.gradle`)");
  addIfPresent("build.gradle.kts", "Gradle Kotlin (`build.gradle.kts`)");
  addIfPresent("Makefile", "Make (`Makefile`)");
  addIfPresent("Dockerfile", "Docker (`Dockerfile`)");

  const csproj = rootEntries.find((name) => name.endsWith(".csproj") || name.endsWith(".sln"));
  if (csproj) {
    hints.push({ marker: csproj, label: `.NET / C# (\`${csproj}\`)` });
  }
  return hints;
}
