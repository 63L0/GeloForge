/**
 * Lightweight, opt-in local hook installer (`geloforge hooks init`) for Git pre-commit,
 * Claude Code, and Gemini CLI. Zero external dependencies, zero background daemons,
 * safe non-destructive merging, and strict symlink/path confinement.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "./mcp-init.mjs";
import { assertSafeWithinRoot } from "./path-safety.mjs";
import { loadProjectManifestAndState } from "./project-locator.mjs";
import { runMultiFileTransaction, withProjectLock } from "./project-lock.mjs";
import { assertSafeAncestorChain } from "./skills-history.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_HARNESS_DIR = path.resolve(__dirname, "..");

export const HOOK_TARGETS = ["git", "claude", "gemini"];
const GIT_START = "# >>> geloforge:hooks-init:start";
const GIT_END = "# <<< geloforge:hooks-init:end";
const AGENT_DOCTOR_COMMAND = "npx geloforge doctor --skip-mcp-check";

function normalizeTargets(rawTargets) {
  if (!rawTargets || rawTargets.length === 0) {
    return [...HOOK_TARGETS];
  }
  const items = Array.isArray(rawTargets) ? rawTargets : [rawTargets];
  const parsed = items
    .flatMap((entry) => String(entry).split(","))
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (parsed.length === 0) {
    return [...HOOK_TARGETS];
  }
  const unique = [...new Set(parsed)];
  for (const target of unique) {
    if (!HOOK_TARGETS.includes(target)) {
      throw new Error(`Unknown hook target "${target}". Expected: ${HOOK_TARGETS.join(", ")}.`);
    }
  }
  return unique;
}

function readExistingHookFile(projectDir, relPath) {
  const filePath = assertSafeWithinRoot(projectDir, relPath);
  assertSafeAncestorChain(filePath, projectDir, relPath);
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
    throw new Error(`Refusing symbolic link or non-regular file at ${relPath}.`);
  }
  return {
    filePath,
    relPath,
    original: stat ? fs.readFileSync(filePath, "utf8") : null,
  };
}

function buildGitPreCommitBlock(eol) {
  return [
    GIT_START,
    "if command -v geloforge >/dev/null 2>&1; then",
    '  GELOFORGE_BIN="geloforge"',
    'elif [ -x "./node_modules/.bin/geloforge" ]; then',
    '  GELOFORGE_BIN="./node_modules/.bin/geloforge"',
    "elif command -v npx >/dev/null 2>&1 && npx --no-install geloforge --version >/dev/null 2>&1; then",
    '  GELOFORGE_BIN="npx --no-install geloforge"',
    "else",
    '  GELOFORGE_BIN=""',
    "fi",
    'if [ -n "$GELOFORGE_BIN" ]; then',
    "  $GELOFORGE_BIN validate || exit 1",
    '  if [ -f ".geloforge/mcp-lock.json" ]; then',
    "    $GELOFORGE_BIN mcp lock --check || exit 1",
    "  fi",
    "else",
    '  echo "[geloforge] pre-commit skipped: geloforge binary not found in PATH or node_modules." >&2',
    "fi",
    GIT_END,
  ].join(eol);
}

function planGitHookEdit(projectDir) {
  const gitAbs = assertSafeWithinRoot(projectDir, ".git");
  const gitStat = fs.lstatSync(gitAbs, { throwIfNoEntry: false });
  if (!gitStat || gitStat.isSymbolicLink() || !gitStat.isDirectory()) {
    return {
      target: "git",
      path: ".git/hooks/pre-commit",
      action: "skipped",
      reason: "Not a real Git repository directory",
      write: null,
    };
  }

  const hooksDirAbs = assertSafeWithinRoot(projectDir, ".git/hooks");
  const hooksStat = fs.lstatSync(hooksDirAbs, { throwIfNoEntry: false });
  if (hooksStat && (hooksStat.isSymbolicLink() || !hooksStat.isDirectory())) {
    throw new Error("Refusing symbolic link or non-directory .git/hooks path.");
  }

  const file = readExistingHookFile(projectDir, ".git/hooks/pre-commit");
  const original = file.original;
  const eol = original && original.includes("\r\n") ? "\r\n" : "\n";
  const block = buildGitPreCommitBlock(eol);

  let nextContent;
  if (original === null) {
    nextContent = `#!/usr/bin/env sh${eol}${eol}${block}${eol}`;
  } else {
    const startIdx = original.indexOf(GIT_START);
    const endIdx = original.indexOf(GIT_END);
    if (startIdx === -1 && endIdx === -1) {
      const trimmed = original.replace(/[\r\n]+$/, "");
      nextContent = trimmed.length > 0 ? `${trimmed}${eol}${eol}${block}${eol}` : `#!/usr/bin/env sh${eol}${eol}${block}${eol}`;
    } else if (
      startIdx === -1 ||
      endIdx < startIdx ||
      original.lastIndexOf(GIT_START) !== startIdx ||
      original.lastIndexOf(GIT_END) !== endIdx
    ) {
      throw new Error("Invalid GeloForge hook markers in .git/hooks/pre-commit.");
    } else {
      nextContent = original.slice(0, startIdx) + block + original.slice(endIdx + GIT_END.length);
    }
  }

  const action = original === nextContent ? "unchanged" : original === null ? "create" : "update";
  return {
    target: "git",
    path: file.relPath,
    action,
    write:
      action === "unchanged"
        ? null
        : { label: "git-hook", filePath: file.filePath, content: nextContent, mode: 0o755 },
  };
}

function hasGeloForgeHookEntry(list) {
  return list.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    if (typeof entry.command === "string" && /\bgeloforge\b/i.test(entry.command)) return true;
    if (Array.isArray(entry.hooks)) {
      return entry.hooks.some((h) => h && typeof h.command === "string" && /\bgeloforge\b/i.test(h.command));
    }
    return false;
  });
}

function planAgentHookEdit(projectDir, target, relPath, eventKey) {
  const file = readExistingHookFile(projectDir, relPath);
  const original = file.original;
  let data = {};
  if (original !== null && original.trim().length > 0) {
    data = parseConfig(original, relPath).data;
  }

  let hooksObj = {};
  if (Object.hasOwn(data, "hooks")) {
    if (!data.hooks || Array.isArray(data.hooks) || typeof data.hooks !== "object") {
      throw new Error(`Expected "hooks" to be a JSON object in ${relPath}.`);
    }
    hooksObj = { ...data.hooks };
  }

  let eventList = [];
  if (Object.hasOwn(hooksObj, eventKey)) {
    if (!Array.isArray(hooksObj[eventKey])) {
      throw new Error(`Expected "hooks.${eventKey}" to be an array in ${relPath}.`);
    }
    eventList = [...hooksObj[eventKey]];
  }

  if (hasGeloForgeHookEntry(eventList)) {
    return { target, path: relPath, action: "unchanged", write: null };
  }

  eventList.push({
    hooks: [{ type: "command", command: AGENT_DOCTOR_COMMAND }],
  });
  hooksObj[eventKey] = eventList;
  const nextData = { ...data, hooks: hooksObj };
  const eol = original && original.includes("\r\n") ? "\r\n" : "\n";
  const nextContent = `${JSON.stringify(nextData, null, 2).replace(/\n/g, eol)}${eol}`;

  return {
    target,
    path: relPath,
    action: original === null ? "create" : "update",
    write: { label: `${target}-hook`, filePath: file.filePath, content: nextContent },
  };
}

/**
 * Installs or updates opt-in GeloForge verification/advisory hooks for Git, Claude Code, and Gemini CLI.
 */
export function initProjectHooks({
  projectDir: rawProjectDir,
  harnessDir: rawHarnessDir = DEFAULT_HARNESS_DIR,
  targets = HOOK_TARGETS,
  dryRun = false,
} = {}) {
  const resolvedTargets = normalizeTargets(targets);
  const harnessDir = path.resolve(rawHarnessDir || DEFAULT_HARNESS_DIR);
  const loaded = loadProjectManifestAndState(rawProjectDir, harnessDir);
  const { projectDir } = loaded;

  const run = () => {
    const plans = [];

    for (const target of resolvedTargets) {
      if (target === "git") {
        plans.push(planGitHookEdit(projectDir));
      } else if (target === "claude") {
        plans.push(planAgentHookEdit(projectDir, "claude", ".claude/settings.json", "Stop"));
      } else if (target === "gemini") {
        plans.push(planAgentHookEdit(projectDir, "gemini", ".gemini/settings.json", "AfterAgent"));
      }
    }

    if (!dryRun) {
      const writes = plans.map((p) => p.write).filter(Boolean);
      if (writes.length > 0) {
        // Agent settings may sit alongside MCP config; keep pre-image backups in memory rather than writing .tx-journal.json
        runMultiFileTransaction(writes);
      }
    }

    return {
      projectDir,
      dryRun: Boolean(dryRun),
      targets: resolvedTargets,
      files: plans.map(({ target, path: fileRel, action, reason }) => ({
        target,
        path: fileRel,
        action,
        ...(reason ? { reason } : {}),
      })),
    };
  };

  return dryRun ? run() : withProjectLock(projectDir, run);
}
