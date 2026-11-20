/**
 * Zero-dependency JSON-RPC 2.0 MCP stdio server for GeloForge (v0.5).
 * Exposes read/advisory/bounded operational tools over stdin/stdout (supporting both
 * newline-delimited JSON and Content-Length LSP-style framing) while refusing privileged
 * skill promotion, rollback, or key-signing operations over MCP.
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
      "Inspect project validation health, operational state, active multi-IDE leases, pending human approvals inbox, and ranked next steps.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        project: { type: "string", description: "Target project directory (optional if default cwd is a project)." },
      },
    },
  },
  {
    name: "geloforge_recommend",
    description:
      "Return ranked Human-in-the-Loop Co-Pilot recommendations, pending human approval items, and multi-IDE overlap warnings.",
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
      "Compile a deterministic, trust-tiered, token-budgeted context packet with automatic completed-task pruning and peer IDE lease awareness.",
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
      "Manage scoped TASK-NNNN contracts and cooperative multi-IDE task/file-scope leases (list, show, new, update, done, claim, release, leases).",
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
      "Create, list, or inspect CHKPT-NNNN session recovery checkpoints to hand off cleanly across short sessions without context rot.",
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
      "Inspect, lint, draft quarantined skills from verified evidence, propose updates, or view history. Privileged promotion/rollback/signing actions are refused over MCP.",
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

function resolveTargetProject(args, defaultProjectDir, harnessDir) {
  const explicit = typeof args?.project === "string" && args.project.trim() ? args.project.trim() : defaultProjectDir || null;
  return resolveProjectDir({ project: explicit, harnessDir }).projectDir;
}

function invokeTaskTool(args, defaultProjectDir, harnessDir) {
  const action = String(args?.action || "").trim().toLowerCase();
  const projectDir = resolveTargetProject(args, defaultProjectDir, harnessDir);
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
        dryRun: Boolean(args.dryRun),
      });
    case "done":
      return completeTask({
        projectDir,
        harnessDir,
        taskId: args.task,
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

function invokeCheckpointTool(args, defaultProjectDir, harnessDir) {
  const action = String(args?.action || "").trim().toLowerCase();
  const projectDir = resolveTargetProject(args, defaultProjectDir, harnessDir);
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

function invokeSkillsTool(args, defaultProjectDir, harnessDir) {
  const action = String(args?.action || "").trim().toLowerCase();
  if (BLOCKED_SKILL_ACTIONS.has(action)) {
    throw new Error(
      `Refusing privileged skill mutation/signing over MCP (action "${action}"). Human must authorize via local CLI.`
    );
  }

  const projectHint =
    typeof args?.project === "string" && args.project.trim() ? args.project.trim() : defaultProjectDir || null;

  if (action === "draft") {
    const projectDir = resolveTargetProject(args, defaultProjectDir, harnessDir);
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
    const projectDir = resolveTargetProject(args, defaultProjectDir, harnessDir);
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
    const projectDir = resolveTargetProject(args, defaultProjectDir, harnessDir);
    return getSkillHistory({ projectDir, skillName: args.name, harnessDir });
  }

  const loc = resolveProjectForSkills({ project: projectHint, harnessDir });
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

function executeToolCall(name, args, { defaultProjectDir, harnessDir }) {
  switch (name) {
    case "geloforge_status": {
      const projectDir = resolveTargetProject(args, defaultProjectDir, harnessDir);
      return getProjectStatus(projectDir);
    }
    case "geloforge_recommend": {
      const projectDir = resolveTargetProject(args, defaultProjectDir, harnessDir);
      return getProjectRecommendations(projectDir);
    }
    case "geloforge_context": {
      const projectDir = resolveTargetProject(args, defaultProjectDir, harnessDir);
      return compileContext({
        projectDir,
        harnessDir,
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
      return invokeTaskTool(args, defaultProjectDir, harnessDir);
    case "geloforge_checkpoint":
      return invokeCheckpointTool(args, defaultProjectDir, harnessDir);
    case "geloforge_skills":
      return invokeSkillsTool(args, defaultProjectDir, harnessDir);
    default:
      return null;
  }
}

/**
 * Handles a single parsed JSON-RPC 2.0 MCP message and returns the response object
 * (or null for JSON-RPC notifications).
 */
export function handleMcpMessage(msg, { defaultProjectDir = null, harnessDir = DEFAULT_HARNESS_DIR } = {}) {
  const absHarness = path.resolve(harnessDir || DEFAULT_HARNESS_DIR);
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    return {
      jsonrpc: "2.0",
      id: msg?.id ?? null,
      error: { code: -32600, message: "Invalid JSON-RPC 2.0 request." },
    };
  }

  const isNotification = msg.id === undefined || msg.id === null;
  const method = String(msg.method || "");

  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return null;
  }

  if (isNotification && method.startsWith("notifications/")) {
    return null;
  }

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
      const toolArgs = msg.params?.arguments || {};
      if (typeof toolName !== "string" || !MCP_TOOLS.some((t) => t.name === toolName)) {
        return {
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: `Unknown MCP tool "${String(toolName)}".` },
        };
      }
      try {
        const result = executeToolCall(toolName, toolArgs, { defaultProjectDir, harnessDir: absHarness });
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

/**
 * Starts the synchronous-per-message MCP JSON-RPC 2.0 server over stdin/stdout streams.
 * Resolves when input stream ends cleanly.
 */
export function startMcpStdioServer({
  defaultProjectDir = null,
  harnessDir = DEFAULT_HARNESS_DIR,
  input = process.stdin,
  output = process.stdout,
} = {}) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);

    const dispatchRaw = (rawJson, framing) => {
      let msg;
      try {
        msg = JSON.parse(rawJson);
      } catch {
        writeFramedResponse(
          output,
          { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
          framing
        );
        return;
      }
      const reply = handleMcpMessage(msg, { defaultProjectDir, harnessDir });
      if (reply !== null) {
        writeFramedResponse(output, reply, framing);
      }
    };

    const drainBuffer = () => {
      while (buffer.length > 0) {
        // Trim leading whitespace before inspecting framing style
        let skip = 0;
        while (skip < buffer.length && (buffer[skip] === 0x20 || buffer[skip] === 0x09 || buffer[skip] === 0x0d || buffer[skip] === 0x0a)) {
          skip += 1;
        }
        if (skip > 0) {
          buffer = buffer.subarray(skip);
        }
        if (buffer.length === 0) break;

        const headPreview = buffer.subarray(0, Math.min(32, buffer.length)).toString("utf8");
        if (/^content-length\s*:/i.test(headPreview)) {
          let sepIndex = buffer.indexOf("\r\n\r\n");
          let sepLen = 4;
          if (sepIndex === -1) {
            sepIndex = buffer.indexOf("\n\n");
            sepLen = 2;
          }
          if (sepIndex === -1) break;
          const headersText = buffer.subarray(0, sepIndex).toString("utf8");
          const match = headersText.match(/content-length\s*:\s*(\d+)/i);
          if (!match) {
            buffer = buffer.subarray(sepIndex + sepLen);
            continue;
          }
          const contentLen = Number.parseInt(match[1], 10);
          const bodyStart = sepIndex + sepLen;
          if (buffer.length < bodyStart + contentLen) break;
          const bodyText = buffer.subarray(bodyStart, bodyStart + contentLen).toString("utf8");
          buffer = buffer.subarray(bodyStart + contentLen);
          dispatchRaw(bodyText, "lsp");
        } else {
          const nlIdx = buffer.indexOf("\n");
          if (nlIdx === -1) break;
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
      if (buffer.length > 0) {
        const leftover = buffer.toString("utf8").trim();
        if (leftover && !/^content-length\s*:/i.test(leftover)) {
          dispatchRaw(leftover, "jsonl");
        }
        buffer = Buffer.alloc(0);
      }
      resolve();
    });

    input.on("error", reject);
  });
}
