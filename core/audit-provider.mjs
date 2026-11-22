/** Headless audit adapters run outside the project and receive a bounded context packet. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { hasSecretContent, isForbiddenSecretPath, isSameOrInside } from "./path-safety.mjs";
import { readRegularFile, sha256 } from "./runtime-files.mjs";

const ENV_KEYS = new Set([
  "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "WINDIR",
  "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL",
]);

export function executableIdentity(executable) {
  const stat = fs.lstatSync(executable);
  if (!stat.isFile()) throw new Error("Audit provider must be a regular executable file.");
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

export function buildProviderEnv(provider, extraEnv = null) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ENV_KEYS.has(key.toUpperCase())));
  if (provider === "gemini") env.GEMINI_CLI_TRUST_WORKSPACE = "true";
  if (extraEnv && typeof extraEnv === "object") {
    for (const [k, v] of Object.entries(extraEnv)) {
      if (typeof v === "string") env[k] = v;
    }
  }
  return env;
}

export function resolveAuditProvider(spec, projectDir) {
  if (!spec || !["codex", "gemini", "antigravity"].includes(spec.provider) ||
      typeof spec.executable !== "string" || !path.isAbsolute(spec.executable) ||
      hasSecretContent(spec.executable) || isForbiddenSecretPath(spec.executable)) {
    throw new Error("Supply a provider and absolute CLI executable path.");
  }
  const executable = fs.realpathSync(spec.executable);
  if (isSameOrInside(executable, fs.realpathSync(projectDir)) || /\.(cmd|bat|ps1)$/i.test(executable)) {
    throw new Error("Use a native provider executable or Node.js entry point outside the project.");
  }
  const identity = executableIdentity(executable);
  const bytes = readRegularFile(executable, 384 * 1024 * 1024);
  if (!bytes || executableIdentity(executable) !== identity) {
    throw new Error("Configured provider executable is unavailable or changed during authorization.");
  }
  const runner = { provider: spec.provider, executable, digest: sha256(bytes) };
  return { runner, identity };
}

/**
 * Spawns an approved provider CLI executable with filtered environment, closed stdin payload,
 * and automatic private temp-dir cleanup.
 */
export function runProviderProcess({
  runner: { provider, executable },
  identity,
  prompt,
  cwd = null,
  inputFile = "audit-input.txt",
  buildArgs,
  timeoutMs,
  signal,
  requireJson = true,
}) {
  if (signal?.aborted) throw new Error("Audit worker is stopping.");
  if (executableIdentity(executable) !== identity) {
    throw new Error("Audit provider executable changed. Restart with the approved executable.");
  }
  if (hasSecretContent(prompt)) throw new Error("Audit inputs contain credential-like content.");
  const tempDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "geloforge-audit-"));
  const finalPath = path.join(tempDir, "response.json");
  const promptPath = path.join(tempDir, inputFile);
  const workCwd = cwd ? fs.realpathSync(cwd) : tempDir;
  let child;
  const args = buildArgs({ finalPath, promptPath, provider });
  const env = buildProviderEnv(provider);
  const stop = () => child?.kill("SIGKILL");
  const promise = new Promise((resolve, reject) => {
    try {
      fs.writeFileSync(promptPath, prompt, { mode: 0o600, flag: "wx" });
      const isNodeEntry = /\.[cm]?js$/i.test(executable);
      child = execFile(isNodeEntry ? process.execPath : executable, isNodeEntry ? [executable, ...args] : args, {
        cwd: workCwd, env, timeout: timeoutMs, maxBuffer: 512 * 1024, killSignal: "SIGKILL", windowsHide: true,
      }, (err, stdout) => {
        try {
          if (err) {
            throw new Error(err.killed ? "Audit provider stopped or exceeded its timeout." :
              "Audit provider failed to start or returned an unsuccessful response.");
          }
          const text = provider === "codex" ? (readRegularFile(finalPath)?.toString("utf8") ?? "") : String(stdout ?? "");
          if (provider === "codex") {
            let parsed = null;
            try {
              parsed = JSON.parse(text);
            } catch {
              if (requireJson) throw new Error("Audit provider returned invalid JSON.");
              resolve({ parsed: null, rawText: text });
              return;
            }
            if (parsed?.error) throw new Error("Unsuccessful response envelope.");
            resolve(requireJson ? parsed : { parsed, rawText: text });
            return;
          }
          let envelope = null;
          try {
            envelope = JSON.parse(text);
          } catch {
            if (requireJson) throw new Error("Audit provider returned invalid JSON.");
            resolve({ parsed: null, rawText: text });
            return;
          }
          if (envelope?.error || (provider === "antigravity" && envelope?.status !== "SUCCESS")) {
            throw new Error("Unsuccessful response envelope.");
          }
          const innerRaw = typeof envelope.response === "string" ? envelope.response : JSON.stringify(envelope.response ?? "");
          try {
            const innerParsed = JSON.parse(innerRaw);
            resolve(requireJson ? innerParsed : { parsed: innerParsed, rawText: innerRaw });
          } catch {
            if (requireJson) throw new Error("Audit provider returned invalid JSON.");
            resolve({ parsed: null, rawText: innerRaw });
          }
        } catch (error) {
          reject(err ? error : error);
        }
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(prompt, "utf8");
      signal?.addEventListener("abort", stop, { once: true });
    } catch (err) {
      reject(err);
    }
  }).finally(() => {
    signal?.removeEventListener("abort", stop);
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 2 });
  });
  return { pid: child?.pid, promise, stop };
}

export function startAuditProvider(resolvedProvider, prompt, { timeoutMs, signal } = {}) {
  const request = "Follow the reporting format in the audit input provided on stdin (also saved in audit-input.txt) and return only the requested JSON. Do not run shell commands or modify files.";
  return runProviderProcess({
    ...resolvedProvider,
    prompt,
    cwd: null,
    inputFile: "audit-input.txt",
    timeoutMs,
    signal,
    requireJson: true,
    buildArgs: ({ finalPath, provider }) => ({
      codex: ["--ask-for-approval", "never", "exec", "--sandbox", "read-only", "--skip-git-repo-check",
        "--ephemeral", "--ignore-user-config", "--output-last-message", finalPath, request],
      gemini: ["--approval-mode=plan", "--output-format=json", "--prompt", request],
      antigravity: ["--mode=plan", "--sandbox", "--output-format=json", "--print", request],
    }[provider]),
  });
}
