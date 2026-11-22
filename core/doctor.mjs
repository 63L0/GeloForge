/**
 * Deterministic one-command diagnostics (`geloforge doctor`) for project health,
 * harness compatibility, Git status, cooperative leases, skills lint, MCP pinning,
 * and ambient Git/IDE hook setup. Zero external dependencies, zero network calls.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkManifestCompatibility, loadCompatibilityConfig } from "./compatibility.mjs";
import { getGitStatusScoped } from "./git-utils.mjs";
import { parseConfig } from "./mcp-init.mjs";
import { checkMcpLock, MCP_LOCK_PATH } from "./mcp-lock.mjs";
import { assertSafeWithinRoot, redactSecretContent } from "./path-safety.mjs";
import { loadProjectManifestAndState } from "./project-locator.mjs";
import { validateProject } from "./project-validator.mjs";
import { discoverSkills } from "./skills.mjs";
import { lintDiscoveredSkills } from "./skills-lint.mjs";
import { listTaskLeases } from "./task-manager.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_HARNESS_DIR = path.resolve(__dirname, "..");

function readSafeHookConfig(projectDir, relPath) {
  const abs = assertSafeWithinRoot(projectDir, relPath);
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (!st) return { status: "missing", content: null };
  if (st.isSymbolicLink() || !st.isFile()) {
    return { status: "unsafe", content: null };
  }
  return { status: "ok", content: fs.readFileSync(abs, "utf8") };
}

function inspectConfiguredHooks(projectDir) {
  const configured = [];
  const unsafe = [];

  const gitHook = readSafeHookConfig(projectDir, ".git/hooks/pre-commit");
  if (gitHook.status === "unsafe") unsafe.push(".git/hooks/pre-commit");
  else if (gitHook.status === "ok" && gitHook.content.includes("geloforge:hooks-init:start")) {
    configured.push("git");
  }

  for (const [label, relPath] of [
    ["claude", ".claude/settings.json"],
    ["gemini", ".gemini/settings.json"],
  ]) {
    const file = readSafeHookConfig(projectDir, relPath);
    if (file.status === "unsafe") {
      unsafe.push(relPath);
      continue;
    }
    if (file.status !== "ok") continue;
    try {
      const { data } = parseConfig(file.content, relPath);
      if (data.hooks && typeof data.hooks === "object" && /geloforge/i.test(JSON.stringify(data.hooks))) {
        configured.push(label);
      }
    } catch {
      // Ignore malformed JSON here; dedicated config tools surface syntax diagnostics
    }
  }

  return { configured, unsafe };
}

/**
 * Runs deterministic read-only project diagnostics and returns structured check results with exact fix commands.
 */
export async function runProjectDoctor({
  projectDir: rawProjectDir,
  harnessDir: rawHarnessDir = DEFAULT_HARNESS_DIR,
  globalSkillsDir = undefined,
  includeDrafts = false,
  checkMcp = true,
  timeoutMs = 5000,
} = {}) {
  const harnessDir = path.resolve(rawHarnessDir || DEFAULT_HARNESS_DIR);
  const loaded = loadProjectManifestAndState(rawProjectDir, harnessDir);
  const { projectDir, manifest, projectPaths } = loaded;
  const checks = [];

  // 1. Node.js runtime
  const nodeVersion = process.versions?.node || "0.0.0";
  const nodeMajor = Number.parseInt(nodeVersion.split(".")[0], 10);
  checks.push({
    id: "node_runtime",
    status: Number.isFinite(nodeMajor) && nodeMajor >= 20 ? "pass" : "fail",
    summary:
      nodeMajor >= 20
        ? `Node.js v${nodeVersion} satisfies >= 20.0.0`
        : `Node.js v${nodeVersion} is below minimum 20.0.0`,
    ...(nodeMajor >= 20 ? {} : { fix: "Install Node.js 20+ (LTS) before running GeloForge" }),
  });

  // 2. Second Brain project validation
  const validation = validateProject(projectDir, { harnessDir });
  if (!validation.valid) {
    checks.push({
      id: "project_validation",
      status: "fail",
      summary: `Project validation failed with ${validation.errors.length} error(s)`,
      details: validation.errors.slice(0, 5),
      fix: "geloforge validate",
    });
  } else if (validation.warnings.length > 0) {
    checks.push({
      id: "project_validation",
      status: "warn",
      summary: `Project valid (${validation.recordCount} records) with ${validation.warnings.length} warning(s)`,
      details: validation.warnings.slice(0, 5),
      fix: "geloforge validate",
    });
  } else {
    checks.push({
      id: "project_validation",
      status: "pass",
      summary: `Project valid (${validation.recordCount} records, ${validation.checkedMarkdownFiles} markdown files)`,
    });
  }

  // 3. Harness compatibility & version currency
  const compatConfig = loadCompatibilityConfig();
  const compatResult = checkManifestCompatibility(manifest, compatConfig);
  const manifestHarnessVersion = manifest?.harness_version || "unknown";
  if (!compatResult.compatible) {
    checks.push({
      id: "harness_compatibility",
      status: "fail",
      summary: `Incompatible manifest (${compatResult.errors.join("; ")})`,
      fix: "geloforge validate",
    });
  } else if (manifestHarnessVersion !== compatConfig.harness_version || compatResult.warnings.length > 0) {
    checks.push({
      id: "harness_compatibility",
      status: "warn",
      summary: `Project manifest harness_version "${manifestHarnessVersion}" is older than harness v${compatConfig.harness_version}`,
      details: compatResult.warnings,
      fix: `Update brain/manifest.yaml harness_version to "${compatConfig.harness_version}" and run geloforge validate`,
    });
  } else {
    checks.push({
      id: "harness_compatibility",
      status: "pass",
      summary: `Manifest matches harness v${compatConfig.harness_version} (schema ${manifest.schema_version})`,
    });
  }

  // 4. Git repository state
  const gitState = getGitStatusScoped(projectDir);
  if (!gitState.available) {
    checks.push({
      id: "git_repository",
      status: "warn",
      summary: "Project is not inside a Git repository (diff-scoped context and worktrees unavailable)",
      fix: "git init",
    });
  } else if (gitState.dirty) {
    checks.push({
      id: "git_repository",
      status: "warn",
      summary: `Git branch "${gitState.branch || "HEAD"}" has ${gitState.dirtyCount} uncommitted change(s)`,
    });
  } else {
    checks.push({
      id: "git_repository",
      status: "pass",
      summary: `Clean Git working tree on branch "${gitState.branch || "HEAD"}"`,
    });
  }

  // 5. Task leases
  const leaseInfo = listTaskLeases({ projectDir, harnessDir, includeExpired: true });
  if (leaseInfo.expiredLeases.length > 0) {
    checks.push({
      id: "task_leases",
      status: "warn",
      summary: `${leaseInfo.activeLeases.length} active lease(s), ${leaseInfo.expiredLeases.length} expired lease(s)`,
      fix: "geloforge task leases --include-expired",
    });
  } else {
    checks.push({
      id: "task_leases",
      status: "pass",
      summary: `${leaseInfo.activeLeases.length} active lease(s), 0 expired`,
    });
  }

  // 6. Portable skills & quarantined drafts
  const discovery = discoverSkills({
    projectDir,
    globalSkillsDir,
    proposalsDir: projectPaths.proposals_dir,
    includeDrafts,
  });
  const lint = lintDiscoveredSkills(discovery, { strict: false, includeDrafts });
  if (!lint.passed) {
    checks.push({
      id: "skills_health",
      status: "fail",
      summary: `Skills lint failed (critical=${lint.counts.critical}, error=${lint.counts.error})`,
      fix: `geloforge skills lint${includeDrafts ? " --include-drafts" : ""}`,
    });
  } else if (lint.counts.high > 0 || lint.counts.warning > 0 || discovery.quarantinedSkills.length > 0) {
    checks.push({
      id: "skills_health",
      status: "warn",
      summary: `${discovery.activeSkills.length} active skill(s), ${discovery.quarantinedSkills.length} quarantined draft(s), warnings=${lint.counts.warning}, high=${lint.counts.high}`,
      fix: "geloforge skills lint --include-drafts",
    });
  } else {
    checks.push({
      id: "skills_health",
      status: "pass",
      summary: `${discovery.activeSkills.length} active skill(s), 0 lint errors`,
    });
  }

  // 7. MCP tool-surface lock
  const lockAbs = assertSafeWithinRoot(projectDir, MCP_LOCK_PATH);
  const lockStat = fs.lstatSync(lockAbs, { throwIfNoEntry: false });
  if (lockStat && (lockStat.isSymbolicLink() || !lockStat.isFile())) {
    checks.push({
      id: "mcp_lock",
      status: "fail",
      summary: `Unsafe symbolic link or non-regular file at ${MCP_LOCK_PATH}`,
      fix: `Remove ${MCP_LOCK_PATH} symlink/non-file and run geloforge mcp lock`,
    });
  } else if (!lockStat) {
    checks.push({
      id: "mcp_lock",
      status: "warn",
      summary: `MCP tool lockfile not present (${MCP_LOCK_PATH})`,
      fix: "geloforge mcp lock",
    });
  } else if (!checkMcp) {
    checks.push({
      id: "mcp_lock",
      status: "pass",
      summary: `MCP lockfile present at ${MCP_LOCK_PATH} (live server probe skipped)`,
    });
  } else {
    try {
      const mcpCheck = await checkMcpLock({ projectDir, harnessDir, timeoutMs });
      if (mcpCheck.passed) {
        checks.push({
          id: "mcp_lock",
          status: "pass",
          summary: `MCP lock check passed (${mcpCheck.checkedCount} pinned server(s))`,
        });
      } else {
        checks.push({
          id: "mcp_lock",
          status: "fail",
          summary: `MCP tool-surface drift or probe error detected (added=${mcpCheck.addedServers.length}, removed=${mcpCheck.removedServers.length}, drifted=${mcpCheck.driftedServers.length}, errors=${mcpCheck.errors.length})`,
          fix: "geloforge mcp lock --check",
        });
      }
    } catch (err) {
      checks.push({
        id: "mcp_lock",
        status: "fail",
        summary: redactSecretContent(err.message),
        fix: "geloforge mcp lock --check",
      });
    }
  }

  // 8. Ambient Git / IDE hooks
  const hookStatus = inspectConfiguredHooks(projectDir);
  if (hookStatus.unsafe.length > 0) {
    checks.push({
      id: "hooks_configured",
      status: "fail",
      summary: `Unsafe symbolic link in hook path(s): ${hookStatus.unsafe.join(", ")}`,
      fix: "Replace symlinked hook config files with regular files before running geloforge hooks init",
    });
  } else if (hookStatus.configured.length > 0) {
    checks.push({
      id: "hooks_configured",
      status: "pass",
      summary: `Configured ambient hooks: ${hookStatus.configured.join(", ")}`,
    });
  } else {
    checks.push({
      id: "hooks_configured",
      status: "warn",
      summary: "No ambient Git or IDE GeloForge hooks configured yet",
      fix: "geloforge hooks init --dry-run",
    });
  }

  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) {
    counts[c.status] = (counts[c.status] || 0) + 1;
  }

  const nextActions = [];
  const seenActions = new Set();
  for (const severity of ["fail", "warn"]) {
    for (const c of checks) {
      if (c.status === severity && c.fix && !seenActions.has(c.fix)) {
        seenActions.add(c.fix);
        nextActions.push(c.fix);
      }
    }
  }

  return {
    projectDir,
    projectId: manifest?.project_id || null,
    harnessVersion: compatConfig.harness_version,
    healthy: counts.fail === 0,
    counts,
    checks,
    nextActions,
  };
}
