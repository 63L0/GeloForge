import { readRegularFile, sha256 } from "./runtime-files.mjs";
import { assertSafeWithinRoot, isForbiddenSecretPath } from "./path-safety.mjs";

export function fileDigest(root, name) {
  if (isForbiddenSecretPath(name)) throw new Error("Cannot track a sensitive path.");
  const file = assertSafeWithinRoot(root, name);
  const bytes = readRegularFile(file);
  if (!bytes) throw Object.assign(new Error("Tracked file is missing."), { code: "ENOENT" });
  return sha256(bytes);
}

export function fileFreshness(root, file) {
  if (!file.sha256) return "unknown";
  try {
    return fileDigest(root, file.path) === file.sha256 ? "unchanged" : "changed";
  } catch (err) {
    return err.code === "ENOENT" ? "removed" : "unknown";
  }
}
