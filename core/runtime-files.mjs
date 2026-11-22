import fs from "node:fs";
import { createHash } from "node:crypto";
import { assertSafeWithinRoot, atomicWriteFile } from "./path-safety.mjs";

export function readRegularFile(file, maxBytes = 256 * 1024) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  if (!stat.isFile() || stat.size > maxBytes) throw new Error("Expected a regular file within the size limit.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > maxBytes) throw new Error("Expected a regular file within the size limit.");
    const bytes = Buffer.alloc(opened.size + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count !== opened.size) throw new Error("File changed while being read. Retry with a stable copy.");
    return bytes.subarray(0, count);
  } finally {
    fs.closeSync(fd);
  }
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function readRuntimeJson(projectDir, relativePath, { maxBytes } = {}) {
  const raw = readRegularFile(assertSafeWithinRoot(projectDir, relativePath), maxBytes);
  return raw === null ? null : JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
}

export function writeRuntimeJson(projectDir, relativePath, value, { allowOverwrite = true } = {}) {
  atomicWriteFile(assertSafeWithinRoot(projectDir, relativePath), `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600, allowOverwrite,
  });
}
