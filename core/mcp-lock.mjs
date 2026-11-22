/**
 * Deterministic MCP tool-surface pinning (`.geloforge/mcp-lock.json`).
 * Probes configured stdio MCP servers via JSON-RPC 2.0 (zero network calls),
 * hashes canonical tool definitions, and detects tool-surface drift.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildProviderEnv } from "./audit-provider.mjs";
import { MCP_CLIENTS, parseConfig } from "./mcp-init.mjs";
import {
  findHeaderSeparator,
  MAX_MCP_HEADER_BYTES,
  MAX_MCP_MESSAGE_BYTES,
  parseLspContentLength,
} from "./mcp-server.mjs";
import { assertSafeWithinRoot, atomicWriteFile, hasSecretContent, redactSecretContent } from "./path-safety.mjs";
import { loadProjectManifestAndState } from "./project-locator.mjs";
import { withProjectLock } from "./project-lock.mjs";
import { readRegularFile, sha256 } from "./runtime-files.mjs";

export const MCP_LOCK_PATH = ".geloforge/mcp-lock.json";
const DEFAULT_PROBE_TIMEOUT_MS = 8000;
const MAX_TOOL_PAGES = 50;

function compareCodepoints(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalSort(value) {
  if (Array.isArray(value)) return value.map(canonicalSort);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort(compareCodepoints)) {
      if (value[key] !== undefined) out[key] = canonicalSort(value[key]);
    }
    return out;
  }
  return value;
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalSort(value));
}

function resolveTargetClients(clients) {
  const list = clients?.length ? [...new Set(clients)] : Object.keys(MCP_CLIENTS);
  for (const name of list) {
    if (!Object.hasOwn(MCP_CLIENTS, name)) {
      throw new Error(`Unknown MCP client "${name}". Use ${Object.keys(MCP_CLIENTS).join(", ")}.`);
    }
  }
  return list;
}

function discoverConfiguredServers(projectDir, clients) {
  const clientNames = resolveTargetClients(clients);
  const stdio = [];
  const skipped = [];

  for (const clientName of clientNames) {
    const client = MCP_CLIENTS[clientName];
    const absPath = assertSafeWithinRoot(projectDir, client.config);
    const stat = fs.lstatSync(absPath, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isFile()) {
      throw new Error(`Expected a regular MCP config file at ${client.config}.`);
    }
    const raw = fs.readFileSync(absPath, "utf8");
    const { data } = parseConfig(raw, client.config);
    if (!Object.hasOwn(data, client.key) || data[client.key] == null) continue;
    const servers = data[client.key];
    if (Array.isArray(servers) || typeof servers !== "object") {
      throw new Error(`Expected ${client.key} to be an object in ${client.config}.`);
    }
    for (const name of Object.keys(servers).sort(compareCodepoints)) {
      const entry = servers[name];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        skipped.push({ configPath: client.config, name, reason: "invalid_entry" });
        continue;
      }
      const isNonStdio =
        Boolean(entry.url || entry.httpUrl || entry.serverUrl) ||
        (entry.type && entry.type !== "stdio") ||
        typeof entry.command !== "string" ||
        !entry.command.trim();
      if (isNonStdio) {
        skipped.push({ configPath: client.config, name, reason: "non_stdio_skipped" });
        continue;
      }
      if (entry.args !== undefined && !Array.isArray(entry.args)) {
        throw new Error(`Expected args array for MCP server "${name}" in ${client.config}.`);
      }
      if (entry.env !== undefined && (!entry.env || Array.isArray(entry.env) || typeof entry.env !== "object")) {
        throw new Error(`Expected env object for MCP server "${name}" in ${client.config}.`);
      }
      stdio.push({
        client: clientName,
        configPath: client.config,
        name,
        command: entry.command,
        args: (entry.args ?? []).map(String),
        env: entry.env ?? null,
      });
    }
  }
  return { stdio, skipped };
}

function createRpcFramer(onMessage, onError) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    if (buffer.length > MAX_MCP_MESSAGE_BYTES * 2) {
      onError(new Error("MCP server stdout exceeded bounded buffer limit."));
      return;
    }
    while (buffer.length > 0) {
      let skip = 0;
      while (skip < buffer.length && [0x20, 0x09, 0x0d, 0x0a].includes(buffer[skip])) skip += 1;
      if (skip > 0) buffer = buffer.subarray(skip);
      if (buffer.length === 0) break;

      const preview = buffer.subarray(0, Math.min(32, buffer.length)).toString("utf8");
      if (/^content-(?:length|type)\s*:/i.test(preview)) {
        const sep = findHeaderSeparator(buffer);
        if (sep.index === -1) {
          if (buffer.length > MAX_MCP_HEADER_BYTES) onError(new Error("MCP response header exceeded limit."));
          break;
        }
        const parsed = parseLspContentLength(buffer.subarray(0, sep.index).toString("utf8"), MAX_MCP_MESSAGE_BYTES);
        if (!parsed.ok) {
          onError(new Error(parsed.error));
          return;
        }
        const bodyStart = sep.index + sep.len;
        if (buffer.length < bodyStart + parsed.contentLength) break;
        const body = buffer.subarray(bodyStart, bodyStart + parsed.contentLength).toString("utf8");
        buffer = buffer.subarray(bodyStart + parsed.contentLength);
        onMessage(body);
      } else {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const line = buffer.subarray(0, nl).toString("utf8").trim();
        buffer = buffer.subarray(nl + 1);
        if (line) onMessage(line);
      }
    }
  };
}

async function probeStdioServer(server, projectDir, timeoutMs) {
  const child = spawn(server.command, server.args, {
    cwd: projectDir,
    env: buildProviderEnv(null, server.env),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pending = new Map();
  let stderrTail = "";
  let fatal = null;
  let timer = null;

  const failPending = (err) => {
    fatal = fatal ?? err;
    for (const { reject } of pending.values()) reject(fatal);
    pending.clear();
  };

  const closePromise = new Promise((resolve) => child.once("close", (code) => resolve(code)));
  child.stdin?.on("error", () => {});
  child.on("error", (err) => failPending(new Error(`Failed to start "${server.name}": ${redactSecretContent(err.message)}`)));
  child.stderr?.on("data", (chunk) => {
    stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-4096);
  });
  child.on("close", (code) => {
    if (pending.size > 0) {
      const detail = stderrTail ? ` (${redactSecretContent(stderrTail.trim()).slice(0, 200)})` : "";
      failPending(new Error(`MCP server "${server.name}" exited (code ${code ?? "null"}) before responding${detail}.`));
    }
  });

  const feed = createRpcFramer(
    (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg && msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) {
          entry.reject(new Error(`MCP server "${server.name}" error: ${redactSecretContent(String(msg.error.message ?? msg.error.code))}`));
        } else {
          entry.resolve(msg.result ?? {});
        }
      }
    },
    (err) => failPending(err)
  );
  child.stdout?.on("data", feed);

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`MCP probe for "${server.name}" timed out after ${timeoutMs}ms.`);
      failPending(err);
      reject(err);
    }, timeoutMs);
  });

  let nextId = 0;
  const rpcRequest = (method, params = {}) => {
    if (fatal) return Promise.reject(fatal);
    const id = ++nextId;
    const responsePromise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return Promise.race([responsePromise, timeoutPromise]);
  };

  try {
    const initResult = await rpcRequest("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "geloforge-mcp-lock", version: "1.0.0" },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const rawTools = [];
    let cursor = undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const listResult = await rpcRequest("tools/list", cursor ? { cursor } : {});
      if (Array.isArray(listResult.tools)) rawTools.push(...listResult.tools);
      if (!listResult.nextCursor) break;
      cursor = String(listResult.nextCursor);
      if (page === MAX_TOOL_PAGES - 1) {
        throw new Error(`MCP server "${server.name}" exceeded maximum tools/list pagination depth.`);
      }
    }

    const canonicalTools = rawTools
      .map((tool) => {
        if (!tool || typeof tool !== "object" || typeof tool.name !== "string" || !tool.name) {
          throw new Error(`MCP server "${server.name}" returned a tool entry without a valid name.`);
        }
        return {
          name: tool.name,
          description: typeof tool.description === "string" ? tool.description : "",
          inputSchema: tool.inputSchema ?? null,
          ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
          ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
          ...(tool.input_examples !== undefined ? { input_examples: tool.input_examples } : {}),
        };
      })
      .sort((a, b) => compareCodepoints(a.name, b.name));

    const canonicalJson = canonicalStringify(canonicalTools);
    if (hasSecretContent(canonicalJson)) {
      throw new Error(`Refusing credential-like content in MCP tool definitions for "${server.name}".`);
    }
    const pinnedTools = canonicalTools.map((tool) => ({
      name: tool.name,
      digest: sha256(canonicalStringify(tool)),
    }));
    const serverInfo = initResult?.serverInfo && typeof initResult.serverInfo === "object"
      ? {
        name: typeof initResult.serverInfo.name === "string" ? initResult.serverInfo.name : null,
        version: typeof initResult.serverInfo.version === "string" ? initResult.serverInfo.version : null,
      }
      : null;

    return {
      configPath: server.configPath,
      name: server.name,
      transport: "stdio",
      commandBasename: path.basename(server.command),
      serverInfo,
      toolCount: pinnedTools.length,
      surfaceDigest: sha256(canonicalJson),
      tools: pinnedTools,
    };
  } finally {
    clearTimeout(timer);
    pending.clear();
    try {
      child.stdin?.end();
    } catch {
      // Ignore stdin shutdown failures on exited processes.
    }
    const cleanWait = Promise.race([
      closePromise,
      new Promise((resolve) => setTimeout(resolve, 250)),
    ]);
    await cleanWait;
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Process already exited.
      }
      await Promise.race([closePromise, new Promise((resolve) => setTimeout(resolve, 200))]);
    }
  }
}

function validateTimeoutMs(timeoutMs) {
  if (timeoutMs === undefined || timeoutMs === null) return DEFAULT_PROBE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error("--timeout-ms must be an integer between 100 and 60000.");
  }
  return timeoutMs;
}

function serverKey(entry) {
  return `${entry.configPath}::${entry.name}`;
}

function diffPinnedToolSurface(expected, actual) {
  const expMap = new Map((expected.tools ?? []).map((t) => [t.name, t.digest]));
  const actMap = new Map((actual.tools ?? []).map((t) => [t.name, t.digest]));
  const addedTools = [];
  const removedTools = [];
  const changedTools = [];

  for (const [name, digest] of actMap) {
    if (!expMap.has(name)) addedTools.push(name);
    else if (expMap.get(name) !== digest) changedTools.push(name);
  }
  for (const name of expMap.keys()) {
    if (!actMap.has(name)) removedTools.push(name);
  }
  addedTools.sort(compareCodepoints);
  removedTools.sort(compareCodepoints);
  changedTools.sort(compareCodepoints);

  const hasDrift =
    expected.surfaceDigest !== actual.surfaceDigest ||
    addedTools.length > 0 ||
    removedTools.length > 0 ||
    changedTools.length > 0;
  if (!hasDrift) return null;

  return {
    configPath: actual.configPath,
    name: actual.name,
    expectedDigest: expected.surfaceDigest,
    actualDigest: actual.surfaceDigest,
    addedTools,
    removedTools,
    changedTools,
  };
}

/**
 * Probes configured stdio MCP servers and pins their canonical tool digests to `.geloforge/mcp-lock.json`.
 */
export async function lockMcpServers({
  projectDir,
  harnessDir,
  clients = null,
  timeoutMs,
  dryRun = false,
} = {}) {
  const loaded = loadProjectManifestAndState(projectDir, harnessDir);
  const safeTimeout = validateTimeoutMs(timeoutMs);
  const { stdio, skipped } = discoverConfiguredServers(loaded.projectDir, clients);
  const servers = [];
  for (const target of stdio) {
    servers.push(await probeStdioServer(target, loaded.projectDir, safeTimeout));
  }
  servers.sort((a, b) => compareCodepoints(serverKey(a), serverKey(b)));
  const lockPayload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    servers,
    skipped,
  };
  if (!dryRun) {
    withProjectLock(loaded.projectDir, () => {
      const lockAbs = assertSafeWithinRoot(loaded.projectDir, MCP_LOCK_PATH);
      const stat = fs.lstatSync(lockAbs, { throwIfNoEntry: false });
      if (stat && !stat.isFile()) {
        throw new Error(`Refusing symbolic link or non-regular lock file: ${MCP_LOCK_PATH}`);
      }
      atomicWriteFile(lockAbs, `${JSON.stringify(lockPayload, null, 2)}\n`, { allowOverwrite: true, mode: 0o600 });
    });
  }
  return {
    action: "locked",
    projectDir: loaded.projectDir,
    lockPath: MCP_LOCK_PATH,
    dryRun: Boolean(dryRun),
    serverCount: servers.length,
    skippedCount: skipped.length,
    servers,
    skipped,
  };
}

/**
 * Verifies currently configured stdio MCP servers against the saved `.geloforge/mcp-lock.json`.
 */
export async function checkMcpLock({
  projectDir,
  harnessDir,
  clients = null,
  timeoutMs,
} = {}) {
  const loaded = loadProjectManifestAndState(projectDir, harnessDir);
  const safeTimeout = validateTimeoutMs(timeoutMs);
  const lockAbs = assertSafeWithinRoot(loaded.projectDir, MCP_LOCK_PATH);
  const raw = readRegularFile(lockAbs, MAX_MCP_MESSAGE_BYTES);
  if (!raw) {
    throw new Error(`MCP lock file not found at ${MCP_LOCK_PATH}. Run "geloforge mcp lock" first.`);
  }
  let lockData;
  try {
    lockData = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`Invalid JSON in ${MCP_LOCK_PATH}. Re-generate with "geloforge mcp lock".`);
  }
  if (!lockData || lockData.version !== 1 || !Array.isArray(lockData.servers)) {
    throw new Error(`Unsupported or corrupt MCP lock schema in ${MCP_LOCK_PATH}.`);
  }

  const targetClientConfigs = new Set(resolveTargetClients(clients).map((name) => MCP_CLIENTS[name].config));
  const pinnedMap = new Map(
    lockData.servers
      .filter((entry) => entry && typeof entry.configPath === "string" && typeof entry.name === "string")
      .filter((entry) => targetClientConfigs.has(entry.configPath))
      .map((entry) => [serverKey(entry), entry])
  );

  const { stdio, skipped } = discoverConfiguredServers(loaded.projectDir, clients);
  const actualMap = new Map();
  const errors = [];
  for (const target of stdio) {
    try {
      const probed = await probeStdioServer(target, loaded.projectDir, safeTimeout);
      actualMap.set(serverKey(probed), probed);
    } catch (err) {
      errors.push({
        configPath: target.configPath,
        name: target.name,
        error: redactSecretContent(err.message),
      });
    }
  }

  const addedServers = [];
  const removedServers = [];
  const driftedServers = [];

  for (const [key, actual] of actualMap) {
    if (!pinnedMap.has(key)) {
      addedServers.push({ configPath: actual.configPath, name: actual.name, actualDigest: actual.surfaceDigest });
      continue;
    }
    const diff = diffPinnedToolSurface(pinnedMap.get(key), actual);
    if (diff) driftedServers.push(diff);
  }
  const errorKeys = new Set(errors.map((e) => `${e.configPath}::${e.name}`));
  for (const [key, expected] of pinnedMap) {
    if (!actualMap.has(key) && !errorKeys.has(key)) {
      removedServers.push({ configPath: expected.configPath, name: expected.name, expectedDigest: expected.surfaceDigest });
    }
  }

  const passed =
    addedServers.length === 0 &&
    removedServers.length === 0 &&
    driftedServers.length === 0 &&
    errors.length === 0;

  return {
    action: "check",
    projectDir: loaded.projectDir,
    lockPath: MCP_LOCK_PATH,
    passed,
    checkedCount: actualMap.size,
    addedServers,
    removedServers,
    driftedServers,
    skipped,
    errors,
  };
}
