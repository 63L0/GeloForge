/**
 * Zero-dependency JSON-RPC 2.0 MCP stdio server for GeloForge (v0.5).
 * Exposes read/advisory and explicitly disclosed bounded-mutating tools over stdin/stdout
 * (supporting newline-delimited JSON and Content-Length LSP framing with strict size bounds),
 * enforces pinned project-root confinement and optional --read-only mode, and strictly
 * refuses privileged skill promotion, rollback, or key-signing operations over MCP.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectDir } from "./project-locator.mjs";
import { getProjectStatus, getProjectRecommendations } from "./project-status.mjs";
import { compileContext } from "./context-compiler.mjs";
import {
  claimTaskLease,
  completeTask,
  createTask,
  getTask,
  listTaskLeases,
  listTasks,
  releaseTaskLease,
  updateTask,
} from "./task-manager.mjs";
import { createCheckpoint, getCheckpoint, listCheckpoints } from "./checkpoint.mjs";
import { discoverSkills, resolveProjectForSkills } from "./skills.mjs";
import { lintDiscoveredSkills, lintSkill } from "./skills-lint.mjs";
import { draftSkillFromExperience, getSkillHistory, proposeSkillUpdate } from "./skills-lifecycle.mjs";
import { redactSecretContent } from "./path-safety.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_HARNESS_DIR = path.resolve(__dirname, "..");

const MCP_PROTOCOL_VERSION = "2024-11-05";
const BLOCKED_SKILL_ACTIONS = new Set(["promote", "rollback", "keygen", "sign"]);
export const MAX_MCP_MESSAGE_BYTES = 1024 * 1024;
export const MAX_MCP_HEADER_BYTES = 4096;

const MUTATING_TASK_ACTIONS = new Set(["new", "update", "done", "claim", "release"]);
const MUTATING_CHECKPOINT_ACTIONS = new Set(["create"]);
const MUTATING_SKILLS_ACTIONS = new Set(["draft", "propose", "propose-update"]);

function getHarnessVersion(harnessDir) {
  try {
    return fs.readFileSync(path.join(harnessDir, "VERSION"), "utf8").trim();
  } catch {
    return "0.5.0";
  }
}

export const MCP_TOOLS = [
  {
    name: "geloforge_status",
    description:
      "[READ-ONLY] Inspect project validation health, operational state, active multi-IDE leases, pending human approvals inbox, and ranked next steps.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      readOnlyActions: ["status"],
      mutatingActions: [],
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        project: { type: "string", description: "Target project directory (must match trusted project root when pinned)." },
      },
    },
  },
  {
    name: "geloforge_recommend",
    description:
      "[READ-ONLY] Return ranked Human-in-the-Loop Co-Pilot recommendations, pending human approval items, and multi-IDE overlap warnings.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      readOnlyActions: ["recommend"],
      mutatingActions: [],
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        project: { type: "string" },
      },
    },
  },
  {
    name: "geloforge_context",
    description:
      "[READ-ONLY] Compile a deterministic, trust-tiered, token-budgeted context packet with automatic completed-task pruning and peer IDE lease awareness.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      readOnlyActions: ["context"],
      mutatingActions: [],
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        project: { type: "string" },
        task: { type: "string", description: "TASK-NNNN identifier." },
        query: { type: "string", description: "Search query / goal." },
        profile: { type: "string", enum: ["quick", "working", "deep"] },
        budget: { type: "integer", minimum: 100 },
        map: { type: "boolean" },
        skills: { type: "boolean" },
        pinnedSkills: { type: "array", items: { type: "string" } },
        fromDiff: { type: "boolean" },
        includeCompleted: { type: "boolean" },
        excludeUnverified: { type: "boolean" },
      },
    },
  },
  {
    name: "geloforge_task",
    description:
      "[READ + STATE-MUTATING] Manage scoped TASK-NNNN contracts and cooperative multi-IDE task/file-scope leases. Read-only actions: list, show, leases. Mutating actions (disabled in --read-only mode): new, update, done, claim, release.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      readOnlyActions: ["list", "show", "leases"],
      mutatingActions: ["new", "update", "done", "claim", "release"],
    },
    inputSchema: {
      type: "object",
      required: ["action"],
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["list", "show", "new", "update", "done", "claim", "release", "leases"],
        },
        project: { type: "string" },
        task: { type: "string" },
        title: { type: "string" },
        objective: { type: "string" },
        status: { type: "string" },
        priority: { type: "string" },
        role: { type: "string" },
        budget: { type: "string" },
        activate: { type: "boolean" },
        evidenceRefs: { type: "array", items: { type: "string" } },
        requireEvidence: { type: "boolean" },
        tool: { type: "string" },
        sessionId: { type: "string" },
        scopes: { type: "array", items: { type: "string" } },
        ttlMinutes: { type: "integer", minimum: 1, maximum: 1440 },
        force: { type: "boolean" },
        includeExpired: { type: "boolean" },
        dryRun: { type: "boolean" },
      },
    },
  },
  {
    name: "geloforge_checkpoint",
    description:
      "[READ + STATE-MUTATING] Create, list, or inspect CHKPT-NNNN session recovery checkpoints. Read-only actions: list, show. Mutating action (disabled in --read-only mode): create.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      readOnlyActions: ["list", "show"],
      mutatingActions: ["create"],
    },
    inputSchema: {
      type: "object",
      required: ["action"],
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["create", "list", "show"] },
        project: { type: "string" },
        checkpointId: { type: "string" },
        summary: { type: "string" },
        resumeInstructions: { type: "string" },
        evidenceRef: { type: "string" },
        createdBy: { type: "string" },
        status: { type: "string" },
        dryRun: { type: "boolean" },
      },
    },
  },
  {
    name: "geloforge_skills",
    description:
      "[READ + QUARANTINED-DRAFT ONLY] Inspect, lint, view history, or stage quarantined skill drafts/updates from verified evidence. Read-only actions: list, show, validate, lint, history. Mutating (quarantine-only, disabled in --read-only): draft, propose. Refused: promote, rollback, keygen, sign.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      readOnlyActions: ["list", "show", "validate", "lint", "history"],
      mutatingActions: ["draft", "propose"],
      refusedActions: ["promote", "rollback", "keygen", "sign"],
    },
    inputSchema: {
      type: "object",
      required: ["action"],
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["list", "show", "validate", "lint", "draft", "propose", "history"],
        },
        project: { type: "string" },
        name: { type: "string" },
        includeDrafts: { type: "boolean" },
        strict: { type: "boolean" },
        evidenceIds: { type: "array", items: { type: "string" } },
        handoffIds: { type: "array", items: { type: "string" } },
        title: { type: "string" },
        description: { type: "string" },
        reason: { type: "string" },
        appendNote: { type: "string" },
        steps: { type: "array", items: { type: "string" } },
        tags: { type: "array", items: { type: "string" } },
        triggers: { type: "array", items: { type: "string" } },
        dryRun: { type: "boolean" },
      },
    },
  },
];

function canonicalRealPath(dirPath) {
  try {
    return fs.realpathSync(dirPath);
  } catch {
    return path.resolve(dirPath);
  }
}

function buildTrustedProjectRoots({
  defaultProjectDir = null,
  allowedProjectRoots = null,
  cwd = process.cwd(),
  harnessDir,
}) {
  const roots = new Set();
  if (Array.isArray(allowedProjectRoots)) {
    for (const raw of allowedProjectRoots) {
      if (typeof raw === "string" && raw.trim()) {
        const resolved = resolveProjectDir({ project: raw.trim(), cwd, harnessDir }).projectDir;
        roots.add(canonicalRealPath(resolved));
      }
    }
  }
  if (typeof defaultProjectDir === "string" && defaultProjectDir.trim()) {
    const pinned = resolveProjectDir({ project: defaultProjectDir.trim(), cwd, harnessDir }).projectDir;
    roots.add(canonicalRealPath(pinned));
  } else if (roots.size === 0) {
    try {
      const cwdResolved = resolveProjectDir({ project: null, cwd, harnessDir }).projectDir;
      roots.add(canonicalRealPath(cwdResolved));
    } catch {
      // Launched outside any recognized GeloForge project without --project; keep roots empty so callers fail closed
    }
  }
  return roots;
}

function resolveTargetProject(args, ctx) {
  const { defaultProjectDir, allowedProjectRoots, cwd, harnessDir } = ctx;
  const trustedRoots = buildTrustedProjectRoots({ defaultProjectDir, allowedProjectRoots, cwd, harnessDir });
  if (trustedRoots.size === 0) {
    throw new Error(
      'Refusing MCP tool execution without a trusted project root: server was started outside a recognized GeloForge project without --project. Start with "geloforge mcp --project <dir>" or run from inside a project directory.'
    );
  }
  const explicit =
    typeof args?.project === "string" && args.project.trim() ? args.project.trim() : defaultProjectDir || null;
  const resolvedTarget = resolveProjectDir({ project: explicit, cwd, harnessDir }).projectDir;
  const canonicalTarget = canonicalRealPath(resolvedTarget);
  if (!trustedRoots.has(canonicalTarget)) {
    throw new Error(
      `Refusing MCP tool execution outside trusted project root (${Array.from(trustedRoots).join(", ")}): requested "${resolvedTarget}".`
    );
  }
  return resolvedTarget;
}

function assertWritable(ctx, toolName, action) {
  if (ctx.readOnly) {
    throw new Error(`Refusing state-mutating MCP action "${toolName}:${action}" while server is in --read-only mode.`);
  }
}

function invokeTaskTool(args, ctx) {
  const action = String(args?.action || "").trim().toLowerCase();
  if (MUTATING_TASK_ACTIONS.has(action)) {
    assertWritable(ctx, "geloforge_task", action);
  }
  const projectDir = resolveTargetProject(args, ctx);
  const harnessDir = ctx.harnessDir;
  switch (action) {
    case "list":
      return listTasks({ projectDir, status: args.status, harnessDir });
    case "show":
      return getTask({ projectDir, taskId: args.task, harnessDir });
    case "new":
      return createTask({
        projectDir,
        harnessDir,
        title: args.title,
        objective: args.objective,
        priority: args.priority,
        assignedRole: args.role,
        contextBudget: args.budget,
        status: args.status,
        activate: Boolean(args.activate),
        dryRun: Boolean(args.dryRun),
      });
    case "update":
      return updateTask({
        projectDir,
        harnessDir,
        taskId: args.task,
        status: args.status,
        priority: args.priority,
        assignedRole: args.role,
        activate: Boolean(args.activate),
        evidenceRefs: args.evidenceRefs,
        requireEvidence: Boolean(args.requireEvidence),
        tool: args.tool,
        sessionId: args.sessionId,
        force: Boolean(args.force),
        dryRun: Boolean(args.dryRun),
      });
    case "done":
      return completeTask({
        projectDir,
        harnessDir,
        taskId: args.task,
        evidenceRefs: args.evidenceRefs,
        requireEvidence: Boolean(args.requireEvidence),
        tool: args.tool,
        sessionId: args.sessionId,
        force: Boolean(args.force),
        dryRun: Boolean(args.dryRun),
      });
    case "claim":
      return claimTaskLease({
        projectDir,
        harnessDir,
        taskId: args.task,
        role: args.role,
        tool: args.tool,
        sessionId: args.sessionId,
        scopes: args.scopes,
        ttlMinutes: args.ttlMinutes,
        force: Boolean(args.force),
        dryRun: Boolean(args.dryRun),
      });
    case "release":
      return releaseTaskLease({
        projectDir,
        harnessDir,
        taskId: args.task,
        tool: args.tool,
        sessionId: args.sessionId,
        role: args.role,
        force: Boolean(args.force),
        dryRun: Boolean(args.dryRun),
      });
    case "leases":
      return listTaskLeases({
        projectDir,
        includeExpired: Boolean(args.includeExpired),
        harnessDir,
      });
    default:
      throw new Error(`Unsupported task action "${action}".`);
  }
}

function invokeCheckpointTool(args, ctx) {
  const action = String(args?.action || "").trim().toLowerCase();
  if (MUTATING_CHECKPOINT_ACTIONS.has(action)) {
    assertWritable(ctx, "geloforge_checkpoint", action);
  }
  const projectDir = resolveTargetProject(args, ctx);
  const harnessDir = ctx.harnessDir;
  switch (action) {
    case "create":
      return createCheckpoint({
        projectDir,
        harnessDir,
        summary: args.summary,
        resumeInstructions: args.resumeInstructions,
        evidenceRef: args.evidenceRef,
        createdBy: args.createdBy || "mcp-client",
        role: args.role,
        status: args.status,
        dryRun: Boolean(args.dryRun),
      });
    case "list":
      return listCheckpoints({ projectDir, status: args.status, harnessDir });
    case "show":
      return getCheckpoint({ projectDir, checkpointId: args.checkpointId, harnessDir });
    default:
      throw new Error(`Unsupported checkpoint action "${action}".`);
  }
}

function invokeSkillsTool(args, ctx) {
  const action = String(args?.action || "").trim().toLowerCase();
  if (BLOCKED_SKILL_ACTIONS.has(action)) {
    throw new Error(
      `Refusing privileged skill mutation/signing over MCP (action "${action}"). Human must authorize via local CLI.`
    );
  }
  if (MUTATING_SKILLS_ACTIONS.has(action)) {
    assertWritable(ctx, "geloforge_skills", action);
  }

  const projectDir = resolveTargetProject(args, ctx);
  const { harnessDir } = ctx;

  if (action === "draft") {
    return draftSkillFromExperience({
      projectDir,
      harnessDir,
      evidenceIds: args.evidenceIds || [],
      handoffIds: args.handoffIds || [],
      skillName: args.name,
      title: args.title,
      description: args.description,
      steps: args.steps,
      tags: args.tags,
      triggers: args.triggers,
      dryRun: Boolean(args.dryRun),
    });
  }

  if (action === "propose" || action === "propose-update") {
    return proposeSkillUpdate({
      projectDir,
      harnessDir,
      skillName: args.name,
      evidenceIds: args.evidenceIds || [],
      handoffIds: args.handoffIds || [],
      reason: args.reason,
      appendNote: args.appendNote,
      dryRun: Boolean(args.dryRun),
    });
  }

  if (action === "history") {
    return getSkillHistory({ projectDir, skillName: args.name, harnessDir });
  }

  const loc = resolveProjectForSkills({ project: projectDir, harnessDir });

  const discovery = discoverSkills({
    projectDir: loc.projectDir,
    proposalsDir: loc.proposalsDir,
    includeDrafts: Boolean(args?.includeDrafts),
  });

  if (action === "list") {
    return {
      projectDir: discovery.projectDir,
      skills: discovery.visibleSkills.map((s) => ({
        name: s.name,
        source: s.source,
        trustTier: s.trustTier,
        valid: s.valid,
        blocked: s.blocked,
        estimatedTokens: s.estimatedTokens,
      })),
      quarantinedCount: discovery.quarantinedSkills.length,
      conflicts: discovery.conflicts,
    };
  }

  if (action === "show") {
    if (!args?.name) throw new Error('Missing "name" for geloforge_skills action "show".');
    const found = discovery.visibleSkills.find((s) => s.name === args.name || s.folderName === args.name);
    if (!found) {
      throw new Error(`Skill "${args.name}" not found in visible skills.`);
    }
    return {
      name: found.name,
      source: found.source,
      trustTier: found.trustTier,
      valid: found.valid,
      blocked: found.blocked,
      body: found.hasSecrets ? "[REDACTED]" : found.body,
      lint: lintSkill(found),
    };
  }

  if (action === "validate") {
    const pool = [...discovery.allSkills, ...(args?.includeDrafts ? discovery.quarantinedSkills : [])];
    return {
      valid: discovery.rootErrors.length === 0 && pool.every((s) => s.valid),
      checkedCount: pool.length,
      invalidCount: pool.filter((s) => !s.valid).length,
      rootErrors: discovery.rootErrors,
      rootWarnings: discovery.rootWarnings,
    };
  }

  if (action === "lint") {
    return lintDiscoveredSkills(discovery, {
      strict: Boolean(args?.strict),
      includeDrafts: Boolean(args?.includeDrafts),
    });
  }

  throw new Error(`Unsupported skills action "${action}".`);
}

function executeToolCall(name, args, ctx) {
  switch (name) {
    case "geloforge_status": {
      const projectDir = resolveTargetProject(args, ctx);
      return getProjectStatus(projectDir);
    }
    case "geloforge_recommend": {
      const projectDir = resolveTargetProject(args, ctx);
      return getProjectRecommendations(projectDir);
    }
    case "geloforge_context": {
      const projectDir = resolveTargetProject(args, ctx);
      return compileContext({
        projectDir,
        harnessDir: ctx.harnessDir,
        taskId: args?.task,
        query: args?.query,
        profile: args?.profile || "working",
        budget: args?.budget,
        includeMap: Boolean(args?.map),
        includeSkills: Boolean(args?.skills) || (Array.isArray(args?.pinnedSkills) && args.pinnedSkills.length > 0),
        pinnedSkills: args?.pinnedSkills || [],
        fromDiff: Boolean(args?.fromDiff),
        includeCompleted: Boolean(args?.includeCompleted),
        excludeUnverified: Boolean(args?.excludeUnverified),
      });
    }
    case "geloforge_task":
      return invokeTaskTool(args, ctx);
    case "geloforge_checkpoint":
      return invokeCheckpointTool(args, ctx);
    case "geloforge_skills":
      return invokeSkillsTool(args, ctx);
    default:
      return null;
  }
}

/**
 * Handles a single parsed JSON-RPC 2.0 MCP message and returns the response object
 * (or null for JSON-RPC notifications).
 */
export function handleMcpMessage(
  msg,
  {
    defaultProjectDir = null,
    allowedProjectRoots = null,
    cwd = process.cwd(),
    harnessDir = DEFAULT_HARNESS_DIR,
    readOnly = false,
  } = {}
) {
  const absHarness = path.resolve(harnessDir || DEFAULT_HARNESS_DIR);
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0") {
    const safeId =
      msg && !Array.isArray(msg) && (typeof msg.id === "string" || typeof msg.id === "number") ? msg.id : null;
    return {
      jsonrpc: "2.0",
      id: safeId,
      error: { code: -32600, message: "Invalid JSON-RPC 2.0 request." },
    };
  }

  if (typeof msg.method !== "string" || msg.method.trim().length === 0) {
    const safeId = typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null;
    return {
      jsonrpc: "2.0",
      id: safeId,
      error: { code: -32600, message: "Invalid JSON-RPC 2.0 request: missing method." },
    };
  }

  const isNotification = msg.id === undefined || msg.id === null;
  const method = msg.method;

  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return null;
  }

  if (isNotification && method.startsWith("notifications/")) {
    return null;
  }

  const ctx = {
    defaultProjectDir,
    allowedProjectRoots,
    cwd: cwd || process.cwd(),
    harnessDir: absHarness,
    readOnly: Boolean(readOnly),
  };

  try {
    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: {
            name: "geloforge-mcp",
            version: getHarnessVersion(absHarness),
          },
        },
      };
    }

    if (method === "ping") {
      return { jsonrpc: "2.0", id: msg.id, result: {} };
    }

    if (method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: { tools: MCP_TOOLS },
      };
    }

    if (method === "tools/call") {
      const toolName = msg.params?.name;
      const rawArgs = msg.params?.arguments;
      if (rawArgs !== undefined && (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs))) {
        return {
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: "Invalid tool params: arguments must be a plain object." },
        };
      }
      const toolArgs = rawArgs || {};
      if (typeof toolName !== "string" || !MCP_TOOLS.some((t) => t.name === toolName)) {
        return {
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: `Unknown MCP tool "${String(toolName)}".` },
        };
      }
      try {
        const result = executeToolCall(toolName, toolArgs, ctx);
        const serialized = redactSecretContent(JSON.stringify(result, null, 2));
        return {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: serialized }],
            isError: false,
          },
        };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: redactSecretContent(err.message || "Tool execution failed") }],
            isError: true,
          },
        };
      }
    }

    if (isNotification) {
      return null;
    }

    return {
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  } catch (err) {
    if (isNotification) return null;
    return {
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32603, message: redactSecretContent(err.message || "Internal error") },
    };
  }
}

function writeFramedResponse(output, responseObj, framing) {
  const payload = JSON.stringify(responseObj);
  if (framing === "lsp") {
    const byteLen = Buffer.byteLength(payload, "utf8");
    output.write(`Content-Length: ${byteLen}\r\n\r\n${payload}`);
  } else {
    output.write(`${payload}\n`);
  }
}

export function parseLspContentLength(headersText, maxMessageBytes) {
  const lines = headersText.split(/\r?\n/);
  const contentLengths = [];
  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;
    const colonIdx = rawLine.indexOf(":");
    if (colonIdx <= 0) {
      return { ok: false, error: "Malformed LSP header line.", contentLength: 0 };
    }
    const name = rawLine.slice(0, colonIdx).trim().toLowerCase();
    const val = rawLine.slice(colonIdx + 1).trim();
    if (name === "content-length") {
      if (!/^\d+$/.test(val)) {
        return { ok: false, error: `Invalid Content-Length header "${val}".`, contentLength: 0 };
      }
      const n = Number(val);
      if (!Number.isSafeInteger(n) || n <= 0) {
        return { ok: false, error: `Invalid Content-Length value ${val} (must be >= 1).`, contentLength: 0 };
      }
      if (n > maxMessageBytes) {
        return {
          ok: false,
          error: `MCP message Content-Length (${n} bytes) exceeds maxMessageBytes (${maxMessageBytes}).`,
          contentLength: n,
          skipBody: true,
        };
      }
      contentLengths.push(n);
    }
  }
  if (contentLengths.length === 0) {
    return { ok: false, error: "Missing Content-Length header in LSP frame.", contentLength: 0 };
  }
  if (new Set(contentLengths).size > 1) {
    return { ok: false, error: "Conflicting duplicate Content-Length headers.", contentLength: 0 };
  }
  return { ok: true, contentLength: contentLengths[0] };
}

export function findHeaderSeparator(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
    return { index: crlf, len: 4 };
  }
  if (lf !== -1) {
    return { index: lf, len: 2 };
  }
  return { index: -1, len: 0 };
}

/**
 * Starts the synchronous-per-message MCP JSON-RPC 2.0 server over stdin/stdout streams.
 * Enforces bounded message/header sizes and malformed frame recovery cleanly.
 * Resolves when input stream ends cleanly.
 */
export function startMcpStdioServer({
  defaultProjectDir = null,
  allowedProjectRoots = null,
  cwd = process.cwd(),
  harnessDir = DEFAULT_HARNESS_DIR,
  input = process.stdin,
  output = process.stdout,
  maxMessageBytes = MAX_MCP_MESSAGE_BYTES,
  maxHeaderBytes = MAX_MCP_HEADER_BYTES,
  readOnly = false,
} = {}) {
  const safeMaxMsg =
    Number.isInteger(maxMessageBytes) && maxMessageBytes >= 64 ? maxMessageBytes : MAX_MCP_MESSAGE_BYTES;
  const safeMaxHdr =
    Number.isInteger(maxHeaderBytes) && maxHeaderBytes >= 64 ? maxHeaderBytes : MAX_MCP_HEADER_BYTES;

  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let discardRemainingBytes = 0;
    let discardUntilNewline = false;

    const emitError = (code, message, framing) => {
      writeFramedResponse(output, { jsonrpc: "2.0", id: null, error: { code, message } }, framing);
    };

    const dispatchRaw = (rawJson, framing) => {
      let msg;
      try {
        msg = JSON.parse(rawJson);
      } catch {
        emitError(-32700, "Parse error", framing);
        return;
      }
      const reply = handleMcpMessage(msg, {
        defaultProjectDir,
        allowedProjectRoots,
        cwd,
        harnessDir,
        readOnly,
      });
      if (reply !== null) {
        writeFramedResponse(output, reply, framing);
      }
    };

    const drainBuffer = () => {
      while (buffer.length > 0) {
        if (discardRemainingBytes > 0) {
          const drop = Math.min(discardRemainingBytes, buffer.length);
          buffer = buffer.subarray(drop);
          discardRemainingBytes -= drop;
          continue;
        }

        if (discardUntilNewline) {
          const nlIdx = buffer.indexOf("\n");
          if (nlIdx === -1) {
            buffer = Buffer.alloc(0);
            break;
          }
          buffer = buffer.subarray(nlIdx + 1);
          discardUntilNewline = false;
          continue;
        }

        // Trim leading whitespace before inspecting framing style
        let skip = 0;
        while (
          skip < buffer.length &&
          (buffer[skip] === 0x20 || buffer[skip] === 0x09 || buffer[skip] === 0x0d || buffer[skip] === 0x0a)
        ) {
          skip += 1;
        }
        if (skip > 0) {
          buffer = buffer.subarray(skip);
        }
        if (buffer.length === 0) break;

        const headPreview = buffer.subarray(0, Math.min(32, buffer.length)).toString("utf8");
        if (/^content-(?:length|type)\s*:/i.test(headPreview)) {
          const { index: sepIndex, len: sepLen } = findHeaderSeparator(buffer);
          if (sepIndex === -1) {
            if (buffer.length > safeMaxHdr) {
              buffer = Buffer.alloc(0);
              emitError(-32600, `MCP header block exceeds maxHeaderBytes (${safeMaxHdr}).`, "lsp");
            }
            break;
          }
          if (sepIndex > safeMaxHdr) {
            buffer = buffer.subarray(sepIndex + sepLen);
            emitError(-32600, `MCP header block exceeds maxHeaderBytes (${safeMaxHdr}).`, "lsp");
            continue;
          }
          const headersText = buffer.subarray(0, sepIndex).toString("utf8");
          const parsedHdr = parseLspContentLength(headersText, safeMaxMsg);
          if (!parsedHdr.ok) {
            buffer = buffer.subarray(sepIndex + sepLen);
            if (parsedHdr.skipBody && parsedHdr.contentLength > 0) {
              discardRemainingBytes = parsedHdr.contentLength;
            }
            emitError(-32600, parsedHdr.error, "lsp");
            continue;
          }
          const contentLen = parsedHdr.contentLength;
          const bodyStart = sepIndex + sepLen;
          if (buffer.length < bodyStart + contentLen) {
            break;
          }
          const bodyText = buffer.subarray(bodyStart, bodyStart + contentLen).toString("utf8");
          buffer = buffer.subarray(bodyStart + contentLen);
          dispatchRaw(bodyText, "lsp");
        } else {
          const nlIdx = buffer.indexOf("\n");
          if (nlIdx === -1) {
            if (buffer.length > safeMaxMsg) {
              buffer = Buffer.alloc(0);
              discardUntilNewline = true;
              emitError(-32600, `MCP message exceeds maxMessageBytes (${safeMaxMsg}).`, "jsonl");
            }
            break;
          }
          if (nlIdx > safeMaxMsg) {
            buffer = buffer.subarray(nlIdx + 1);
            emitError(-32600, `MCP message exceeds maxMessageBytes (${safeMaxMsg}).`, "jsonl");
            continue;
          }
          const line = buffer.subarray(0, nlIdx).toString("utf8").trim();
          buffer = buffer.subarray(nlIdx + 1);
          if (line.length > 0) {
            dispatchRaw(line, "jsonl");
          }
        }
      }
    };

    input.on("data", (chunk) => {
      const bufChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      buffer = Buffer.concat([buffer, bufChunk]);
      drainBuffer();
    });

    input.on("end", () => {
      if (!discardUntilNewline && discardRemainingBytes === 0 && buffer.length > 0) {
        if (buffer.length > safeMaxMsg) {
          emitError(-32600, `MCP message exceeds maxMessageBytes (${safeMaxMsg}).`, "jsonl");
        } else {
          const leftover = buffer.toString("utf8").trim();
          if (leftover && !/^content-(?:length|type)\s*:/i.test(leftover)) {
            dispatchRaw(leftover, "jsonl");
          }
        }
      }
      buffer = Buffer.alloc(0);
      resolve();
    });

    input.on("error", reject);
  });
}
