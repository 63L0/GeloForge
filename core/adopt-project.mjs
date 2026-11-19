/**
 * Safe, non-destructive brownfield adoption for existing repositories.
 * Never overwrites existing files or mutates Git history; validates staged changes
 * and rolls back only files and directories created by the current invocation.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoSymlinkInTree,
  assertSafeWithinRoot,
  deriveSlug,
  isForbiddenSecretPath,
  validateExistingProjectDir,
  validateProjectName,
  validateScalarText,
  validateSlug,
} from "./path-safety.mjs";
import { loadCompatibilityConfig } from "./compatibility.mjs";
import { getGitRepoInfo } from "./git-utils.mjs";
import { serializeYaml } from "./yaml-subset.mjs";
import { validateProject } from "./project-validator.mjs";
import {
  detectStackHints,
  inferProjectName,
  renderSinglePass,
  resolveProfile,
  validateCreatedAt,
} from "./template-utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_HARNESS_DIR = path.resolve(__dirname, "..");

function normalizeSubdirOption(rawVal, label, destDir) {
  const clean = validateScalarText(label, rawVal).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (clean.length === 0 || clean === "." || isForbiddenSecretPath(clean)) {
    throw new Error(`Invalid ${label} path "${rawVal}".`);
  }
  assertSafeWithinRoot(destDir, clean);
  return clean;
}

function pathExistsOrSymlink(absPath) {
  if (fs.existsSync(absPath)) {
    return true;
  }
  try {
    fs.lstatSync(absPath);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

function createDirsTracked(baseDir, relDir, createdDirs) {
  const parts = relDir.split("/").filter(Boolean);
  let cursor = baseDir;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    if (pathExistsOrSymlink(cursor)) {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Refusing non-directory or symlink path collision: ${cursor}`);
      }
    } else {
      fs.mkdirSync(cursor);
      createdDirs.push(cursor);
    }
  }
}

function buildAdoptedIndexMarkdown({ tokens, destDir, tasksDir, evidenceDir }) {
  const candidateCodeDirs = [
    "src",
    "app",
    "lib",
    "packages",
    "cmd",
    "pkg",
    "internal",
    "tests",
    "test",
    "__tests__",
    "spec",
    "docs",
  ];
  const existingDirs = candidateCodeDirs.filter((rel) => {
    const abs = path.join(destDir, rel);
    if (!fs.existsSync(abs)) return false;
    try {
      const st = fs.lstatSync(abs);
      return !st.isSymbolicLink() && st.isDirectory();
    } catch {
      return false;
    }
  });

  const codeLines =
    existingDirs.length > 0
      ? existingDirs.map((d) => `- [${d}/](../${d}/) — Existing project directory`)
      : ["- *(No standard `src/` or `tests/` top-level directory detected; customize links as needed.)*"];

  return [
    `# Second Brain Index — ${tokens.PROJECT_NAME}`,
    "",
    `**Project ID:** \`${tokens.PROJECT_ID}\`  `,
    `**Owner:** ${tokens.PROJECT_OWNER}`,
    "",
    "This index maps this repository's provider-independent Second Brain added by `geloforge adopt`.",
    "",
    "## Layer 1 — Authoritative Knowledge (`L1_AUTHORITATIVE`)",
    "",
    "- [Project Manifest](./manifest.yaml) — Canonical metadata, version compatibility, and configured path map.",
    "- [Product Requirements Document](./requirements/prd.md) — Goals, scope, and functional requirements (`A1` once owner-approved).",
    "- [Project Constraints](./requirements/constraints.md) — Technical, security, and operational boundaries (`A1` once owner-approved).",
    "- [Architecture Overview](./architecture/overview.md) — Topology overview and unverified (`A6`) stack hints for review.",
    "- [Architecture Decision Records](./decisions/) — Immutable `ADR-NNNN-*.md` history.",
    "",
    "## Layer 2 — Operational Memory (`L2_OPERATIONAL`)",
    "",
    "- [Current Project State](./state/current.yaml) — Active tasks, blockers, pending approvals, and conflicts (`A4`).",
    `- [Tasks](../${tasksDir}/) — Scoped \`TASK-NNNN\` contracts created with \`geloforge task new\`.`,
    "",
    "## Layer 3 — Research and Evidence (`L3_RESEARCH_EVIDENCE`)",
    "",
    `- Evidence records (\`EVID-NNNN-*.yaml\`) are written on demand into \`${evidenceDir}/\` via \`geloforge evidence capture\`.`,
    "- Cross-agent handoffs live under `handoffs/` via `geloforge handoff`.",
    "- Pending proposals live under `proposals/` when needed.",
    "",
    "## Existing Project Directories",
    "",
    ...codeLines,
    "",
  ].join("\n");
}

function buildAdoptedArchitectureMarkdown({ rawTemplate, tokens, hints }) {
  const base = renderSinglePass(rawTemplate, tokens, false, "brain/architecture/overview.md").trimEnd();
  const hintLines =
    hints.length > 0
      ? hints.map((h) => `- Detected marker: ${h.label}`)
      : ["- No standard language manifest detected in repository root."];
  return [
    base,
    "",
    "## 4. Auto-Detected Stack Hints (A6 Draft — Requires Human Confirmation)",
    "",
    "> **Unverified Draft Notice:** GeloForge detected these markers by filename inspection only during `geloforge adopt`. Review and confirm before treating them as `A2` authoritative architecture facts.",
    "",
    ...hintLines,
    "",
  ].join("\n");
}

/**
 * Safely adopts GeloForge into an existing project directory without overwriting any files.
 */
export function adoptProject(options = {}) {
  const harnessDir = path.resolve(options.harnessDir || DEFAULT_HARNESS_DIR);
  const workspaceRoot = path.resolve(options.workspaceRoot || path.resolve(harnessDir, ".."));
  const templateDir = path.join(harnessDir, "templates", "project-starter");
  const profilesDir = path.join(harnessDir, "templates", "profiles");
  const versionFile = path.join(harnessDir, "VERSION");

  if (!fs.existsSync(templateDir) || !fs.existsSync(versionFile)) {
    throw new Error(`Harness template or VERSION missing under ${harnessDir}`);
  }
  assertNoSymlinkInTree(templateDir);

  const compatConfig = options.compatibilityConfig || loadCompatibilityConfig();
  const destDir = validateExistingProjectDir(options.dest ?? process.cwd(), {
    harnessDir,
    workspaceRoot,
  });

  // Never allow duplicate adoption.
  const existingManifest = path.join(destDir, "brain", "manifest.yaml");
  if (pathExistsOrSymlink(existingManifest) || pathExistsOrSymlink(path.join(destDir, "brain", "manifest.yml"))) {
    throw new Error(`Refusing to adopt: "${destDir}" already contains a GeloForge Second Brain (brain/manifest.yaml).`);
  }

  const projectName = options.name ? validateProjectName(options.name) : inferProjectName(destDir);
  const derivedOrExplicitSlug = options.slug ? options.slug.trim() : deriveSlug(projectName);
  const slug = validateSlug(derivedOrExplicitSlug);
  const projectId = `proj-${slug}`;
  const owner = validateScalarText("--owner", options.owner ?? "Project Owner");
  const description = validateScalarText(
    "--description",
    options.description ?? "Existing project adopted into GeloForge Second Brain."
  );

  const tasksDir = normalizeSubdirOption(options.tasksDir ?? "tasks", "--tasks-dir", destDir);
  const evidenceDir = normalizeSubdirOption(options.evidenceDir ?? "evidence", "--evidence-dir", destDir);
  if (tasksDir === evidenceDir) {
    throw new Error(`--tasks-dir and --evidence-dir must resolve to different folders ("${tasksDir}").`);
  }

  const resolvedProfile = resolveProfile(options.profile, compatConfig, profilesDir);
  const profileMeta = resolvedProfile ? resolvedProfile.meta : null;

  const gitInfo = getGitRepoInfo(destDir);
  const defaultBranch = gitInfo.available && gitInfo.branch ? gitInfo.branch : "main";
  const harnessVersion = fs.readFileSync(versionFile, "utf8").trim();
  const createdAt = validateCreatedAt(options.createdAt);
  const createdDate = createdAt.slice(0, 10);

  const tokens = {
    PROJECT_NAME: projectName,
    PROJECT_SLUG: slug,
    PROJECT_ID: projectId,
    PROJECT_DESCRIPTION: description,
    PROJECT_OWNER: owner,
    CREATED_AT: createdAt,
    CREATED_DATE: createdDate,
    HARNESS_VERSION: harnessVersion,
    TEMPLATE_VERSION: compatConfig.template_version,
    PROFILE_NAME: profileMeta ? profileMeta.name : "none",
    PROFILE_VERSION: profileMeta ? profileMeta.version : "0.0.0",
  };

  const detectedStack = detectStackHints(destDir);
  const warnings = [];

  const manifestObj = {
    schema_version: "1.1",
    template_version: compatConfig.template_version,
    profile: profileMeta ? profileMeta.name : null,
    profile_version: profileMeta ? profileMeta.version : null,
    project_id: projectId,
    slug,
    name: projectName,
    description,
    status: "initialized",
    owner,
    memory_layer: "L1_AUTHORITATIVE",
    authority_level: "A1",
    harness_version: harnessVersion,
    created_at: createdAt,
    updated_at: createdAt,
    repository: {
      vcs: "git",
      initialized: Boolean(gitInfo.available),
      default_branch: defaultBranch,
    },
    paths: {
      brain_index: "brain/INDEX.md",
      prd: "brain/requirements/prd.md",
      constraints: "brain/requirements/constraints.md",
      architecture: "brain/architecture/overview.md",
      state: "brain/state/current.yaml",
      decisions_dir: "brain/decisions",
      research_dir: "brain/research",
      tasks_dir: tasksDir,
      evidence_dir: evidenceDir,
      proposals_dir: "proposals",
    },
    policies: [
      "policies/approval-boundaries.md",
      "policies/memory-policy.md",
      "policies/token-efficiency.md",
    ],
  };

  const stateObj = {
    schema_version: "1.1",
    project_id: projectId,
    state_revision: 0,
    status: "initialized",
    memory_layer: "L2_OPERATIONAL",
    authority_level: "A4",
    updated_at: createdAt,
    updated_by: owner,
    current_phase: "adoption",
    active_tasks: [],
    blocked_tasks: [],
    pending_approvals: [],
    open_conflicts: [],
    last_verified_evidence: null,
    last_checkpoint: null,
    last_completed_task: null,
    known_dependencies: [],
    summary: `Existing repository adopted into GeloForge Second Brain (tasks=${tasksDir}, evidence=${evidenceDir}); no application verification run captured yet.`,
  };

  const plannedMap = new Map();
  plannedMap.set("brain/manifest.yaml", serializeYaml(manifestObj, { headerComment: "Project Manifest (adopted)" }));
  plannedMap.set(
    "brain/state/current.yaml",
    serializeYaml(stateObj, { headerComment: "Current Operational Project State" })
  );
  plannedMap.set(
    "brain/INDEX.md",
    buildAdoptedIndexMarkdown({ tokens, destDir, tasksDir, evidenceDir })
  );
  plannedMap.set(
    "brain/requirements/prd.md",
    renderSinglePass(
      fs.readFileSync(path.join(templateDir, "brain", "requirements", "prd.md"), "utf8"),
      tokens,
      false,
      "brain/requirements/prd.md"
    )
  );
  plannedMap.set(
    "brain/requirements/constraints.md",
    renderSinglePass(
      fs.readFileSync(path.join(templateDir, "brain", "requirements", "constraints.md"), "utf8"),
      tokens,
      false,
      "brain/requirements/constraints.md"
    )
  );
  plannedMap.set(
    "brain/architecture/overview.md",
    buildAdoptedArchitectureMarkdown({
      rawTemplate: fs.readFileSync(path.join(templateDir, "brain", "architecture", "overview.md"), "utf8"),
      tokens,
      hints: detectedStack,
    })
  );

  if (!pathExistsOrSymlink(path.join(destDir, "brain", "decisions"))) {
    plannedMap.set("brain/decisions/.gitkeep", "");
  }

  const absTasksDir = path.join(destDir, tasksDir);
  if (!pathExistsOrSymlink(absTasksDir)) {
    plannedMap.set(`${tasksDir}/.gitkeep`, "");
  } else {
    const tasksStat = fs.lstatSync(absTasksDir);
    if (tasksStat.isSymbolicLink() || !tasksStat.isDirectory()) {
      throw new Error(`Existing tasks directory "${tasksDir}" is not a real non-symlink directory.`);
    }
    const preExistingTaskFiles = fs.readdirSync(absTasksDir).filter((f) => /\.(md|ya?ml)$/i.test(f));
    if (preExistingTaskFiles.length > 0) {
      warnings.push(
        `Existing directory "${tasksDir}" already contains ${preExistingTaskFiles.length} Markdown/YAML file(s); left untouched.`
      );
    }
  }

  if (resolvedProfile) {
    const profileGuideSrc = path.join(resolvedProfile.profileDir, "brain", "profile.md");
    if (fs.existsSync(profileGuideSrc)) {
      const rawGuide = fs.readFileSync(profileGuideSrc, "utf8");
      plannedMap.set("brain/profile.md", renderSinglePass(rawGuide, tokens, false, "brain/profile.md"));
    }
  }

  if (options.withAgentGuides) {
    for (const guideName of ["AGENTS.md", "GEMINI.md"]) {
      const rawGuide = fs.readFileSync(path.join(templateDir, guideName), "utf8");
      plannedMap.set(guideName, renderSinglePass(rawGuide, tokens, false, guideName));
    }
  }

  const orderedFiles = Array.from(plannedMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([relPath, content]) => ({ relPath, content }));

  // Pre-flight check: verify zero collisions and zero symlink escapes BEFORE creating any directory or file.
  for (const file of orderedFiles) {
    const absTarget = assertSafeWithinRoot(destDir, file.relPath);
    if (pathExistsOrSymlink(absTarget)) {
      throw new Error(`Refusing to overwrite existing file during adoption: ${file.relPath}`);
    }
  }

  if (options.dryRun) {
    return {
      dryRun: true,
      projectName,
      projectId,
      slug,
      owner,
      destDir,
      profile: profileMeta ? profileMeta.name : null,
      profileVersion: profileMeta ? profileMeta.version : null,
      gitDetected: Boolean(gitInfo.available),
      defaultBranch,
      tasksDir,
      evidenceDir,
      detectedStack,
      files: orderedFiles.map((f) => f.relPath),
      warnings,
      validation: null,
    };
  }

  const createdFiles = [];
  const createdDirs = [];

  try {
    for (const file of orderedFiles) {
      const parentRel = path.posix.dirname(file.relPath);
      if (parentRel && parentRel !== ".") {
        createDirsTracked(destDir, parentRel, createdDirs);
      }
      const absTarget = assertSafeWithinRoot(destDir, file.relPath);
      fs.writeFileSync(absTarget, file.content, { encoding: "utf8", flag: "wx" });
      createdFiles.push(absTarget);
    }

    const validation = validateProject(destDir, { compatibilityConfig: compatConfig });
    if (!validation.valid) {
      throw new Error(`Adopted project failed validation: ${validation.errors.join("; ")}`);
    }

    if (typeof options.onBeforeCommit === "function") {
      options.onBeforeCommit({
        destDir,
        createdFiles: [...createdFiles],
        createdDirs: [...createdDirs],
      });
    }

    return {
      dryRun: false,
      projectName,
      projectId,
      slug,
      owner,
      destDir,
      profile: profileMeta ? profileMeta.name : null,
      profileVersion: profileMeta ? profileMeta.version : null,
      gitDetected: Boolean(gitInfo.available),
      defaultBranch,
      tasksDir,
      evidenceDir,
      detectedStack,
      files: orderedFiles.map((f) => f.relPath),
      warnings,
      validation,
    };
  } catch (err) {
    // Strictly unlink/rmdir ONLY the files and empty directories created during this invocation.
    for (let i = createdFiles.length - 1; i >= 0; i -= 1) {
      try {
        fs.unlinkSync(createdFiles[i]);
      } catch {
        // Best-effort rollback
      }
    }
    for (let i = createdDirs.length - 1; i >= 0; i -= 1) {
      try {
        fs.rmdirSync(createdDirs[i]);
      } catch {
        // Leave non-empty or pre-existing directories untouched
      }
    }
    throw err;
  }
}
