/** Opt-in disk cache for query packets. Unsafe or dynamic inputs use the normal compiler. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { compileContext } from "./context-compiler.mjs";
import { getGitRepoInfo } from "./git-utils.mjs";
import { assertSafeWithinRoot, hasSecretContent, isForbiddenSecretPath, walkNonSymlinkFiles } from "./path-safety.mjs";
import { parseYaml } from "./yaml-subset.mjs";
import { TASK_LEASES_PATH } from "./task-manager.mjs";
import { resolveProjectPaths } from "./project-locator.mjs";
import { readRegularFile, readRuntimeJson, sha256, writeRuntimeJson } from "./runtime-files.mjs";

const CACHE = "local-runtime/context-cache/packet.json";
const MAX_BYTES = 512 * 1024;
const DEFAULT_HARNESS_DIR = fileURLToPath(new URL("../", import.meta.url));
const BUILD_DIGESTS = new Map();

function buildDigest(harnessDir) {
  if (!BUILD_DIGESTS.has(harnessDir)) {
    const hash = createHash("sha256");
    const core = path.join(harnessDir, "core");
    for (const name of fs.readdirSync(core).filter((name) => /\.(mjs|json)$/.test(name)).sort()) {
      hash.update(name).update(sha256(fs.readFileSync(path.join(core, name))));
    }
    BUILD_DIGESTS.set(harnessDir, hash.digest("hex"));
  }
  return BUILD_DIGESTS.get(harnessDir);
}

function fingerprint(options) {
  const root = path.resolve(options.projectDir);
  const harnessDir = path.resolve(options.harnessDir ?? DEFAULT_HARNESS_DIR);
  const manifestFile = assertSafeWithinRoot(root, "brain/manifest.yaml");
  const rawManifest = readRegularFile(manifestFile);
  if (!rawManifest || fs.lstatSync(root).isSymbolicLink() ||
      fs.existsSync(assertSafeWithinRoot(root, TASK_LEASES_PATH))) return null;
  const manifest = parseYaml(rawManifest.toString("utf8"), "brain/manifest.yaml");
  const projectPaths = resolveProjectPaths(manifest);
  const git = getGitRepoInfo(root);
  const hash = createHash("sha256").update(JSON.stringify([
    "context-cache-v1", buildDigest(harnessDir), root, harnessDir, git.available, git.head, git.unborn,
    options.query, options.profile, options.budget, options.excludeUnverified, options.includeCompleted, options.referenceDate,
  ]));
  let total = 0;
  let count = 0;
  const hashFile = (base, relativePath) => {
    if (isForbiddenSecretPath(relativePath)) return;
    const bytes = readRegularFile(assertSafeWithinRoot(base, relativePath), MAX_BYTES);
    total += bytes?.length ?? 0;
    count += 1;
    if (total > 16 * 1024 * 1024 || count > 1000) throw new Error("Context cache limits exceeded.");
    hash.update(JSON.stringify([base, relativePath, bytes ? sha256(bytes) : null]));
  };
  const hashTree = (base, dir) => {
    const absolute = assertSafeWithinRoot(base, dir);
    const files = walkNonSymlinkFiles(base, absolute, (file) => /\.(md|ya?ml|json)$/i.test(file), null, {
      onSymlink: () => { throw new Error("Context cache excludes symlinked inputs."); },
      ignoreDirs: new Set([".git", "node_modules", "secrets"]),
    });
    for (const file of files) hashFile(base, path.relative(base, file));
  };
  hashTree(harnessDir, "policies");
  hashTree(harnessDir, "schemas");
  hashFile(root, "brain/manifest.yaml");
  hashFile(root, "brain/profile.md");
  hashTree(root, "brain/lessons");
  for (const [key, file] of Object.entries(projectPaths)) {
    if (key.endsWith("_dir")) hashTree(root, file);
    else hashFile(root, file);
  }
  return hash.digest("hex");
}

export function compileCachedContext(options) {
  const compile = () => ({ ...compileContext(options), diskCache: "bypassed" });
  if (!options.query || options.taskId || options.includeMap || options.fromDiff || options.includeSkills ||
      options.pinnedSkills?.length || options.compiledAt || options.compatibilityConfig ||
      options.mapBudget !== undefined || options.skillsBudget !== undefined) return compile();

  const prepared = { ...options, referenceDate: options.referenceDate ?? new Date().toISOString().slice(0, 10) };
  let key;
  try {
    key = fingerprint(prepared);
  } catch {
    return compile();
  }
  if (!key) return compile();
  const { projectDir } = options;
  try {
    const entry = readRuntimeJson(projectDir, CACHE, { maxBytes: MAX_BYTES });
    if (entry?.key === key && entry.packet?.manifest?.status === "compiled" && typeof entry.packet.markdown === "string") {
      const saved = JSON.stringify(entry.packet);
      if (sha256(saved) === entry.digest && !hasSecretContent(saved)) {
        return { ...entry.packet, diskCache: "hit" };
      }
    }
  } catch {
    // The compiler still works when a local cache file is unreadable or corrupt.
  }

  const packet = compileContext(prepared);
  const packetJson = JSON.stringify(packet);
  try {
    if (!hasSecretContent(packetJson) && fingerprint(prepared) === key) {
      const entry = { key, digest: sha256(packetJson), packet };
      if (Buffer.byteLength(JSON.stringify(entry, null, 2), "utf8") < MAX_BYTES) writeRuntimeJson(projectDir, CACHE, entry);
    }
  } catch {
    // Unstable sources and cache-write failures do not change the compiled packet.
  }
  return { ...packet, diskCache: "miss" };
}
