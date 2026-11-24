#!/usr/bin/env node
/**
 * Transactional, zero-dependency project bootstrapper for the AI Development Harness.
 * Combines templates/project-starter with an optional domain profile overlay,
 * enforces strict path/symlink/overwrite safety, runs validation inside staging,
 * and atomically commits to the target destination.
 */

import { addProjectBrief, chooseProjectGoal } from "../core/setup-planning.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  validateProjectName,
  deriveSlug,
  validateSlug,
  validateScalarText,
  validateDestinationPath,
  assertNoSymlinkInTree,
} from "../core/path-safety.mjs";
import { loadCompatibilityConfig } from "../core/compatibility.mjs";
import { validateProject } from "../core/project-validator.mjs";
import {
  escapeYamlScalarText,
  renderSinglePass,
  resolveProfile,
  validateCreatedAt,
} from "../core/template-utils.mjs";

export { renderSinglePass };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_DIR = path.resolve(__dirname, "..");
const WORKSPACE_ROOT = path.resolve(HARNESS_DIR, "..");
const IS_NPM_INSTALL = path.basename(WORKSPACE_ROOT) === "node_modules";
const TEMPLATE_DIR = path.join(HARNESS_DIR, "templates", "project-starter");
const PROFILES_DIR = path.join(HARNESS_DIR, "templates", "profiles");
const VERSION_FILE = path.join(HARNESS_DIR, "VERSION");
export const DEFAULT_INIT_LOCATION = IS_NPM_INSTALL ? "./projects/<slug>" : "<workspace-root>/projects/<slug>";

function printHelp() {
  console.log(`AI Harness Project Bootstrapper

Usage:
  node scripts/bootstrap-project.mjs --name "<Project Name>" [options]

Options:
  --name <string>         Project display name (required, 3-80 chars)
  --slug <string>         Lowercase ASCII slug (optional; derived from --name)
  --dest <path>           Target directory (default: ${DEFAULT_INIT_LOCATION})
  --owner <string>        Project owner name (default: "Project Owner")
  --description <string>  Short project description
  --profile <name>        Optional project profile (web, desktop, mobile, automation, ai-system)
  --created-at <iso>      Optional ISO-8601 timestamp for deterministic generation
  --git                   Initialize an isolated local Git repository (git init -b main)
  --goal <text>           Save an existing goal or spec
  --skip-planning         Skip the setup discussion
  --dry-run               Validate inputs and preview planned files without writing anything
  -h, --help              Show this help message
`);
}

function collectTemplateFiles(rootDir, currentDir = rootDir) {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTemplateFiles(rootDir, fullPath));
    } else if (entry.isFile()) {
      files.push(path.relative(rootDir, fullPath));
    }
  }
  return files;
}

function renderManifest(rawContent, tokens, { gitInit, profileMeta }) {
  let output = renderSinglePass(rawContent, tokens, true, "brain/manifest.yaml");
  output = output.replace(/^status:\s*"template"(?=\r?$)/m, 'status: "initialized"');
  if (gitInit) {
    output = output.replace(/^(\s*initialized:\s*)false(?=\r?$)/m, "$1true");
  }
  if (profileMeta) {
    output = output.replace(/^profile:\s*null(?=\r?$)/m, `profile: "${escapeYamlScalarText(profileMeta.name)}"`);
    output = output.replace(
      /^profile_version:\s*null(?=\r?$)/m,
      `profile_version: "${escapeYamlScalarText(profileMeta.version)}"`
    );
  }
  return output;
}

function ensureParentDirsTracked(targetParent) {
  const missing = [];
  let cursor = path.resolve(targetParent);
  while (cursor && !fs.existsSync(cursor)) {
    missing.push(cursor);
    const up = path.dirname(cursor);
    if (up === cursor) {
      break;
    }
    cursor = up;
  }
  missing.reverse();
  const created = [];
  for (const dir of missing) {
    fs.mkdirSync(dir);
    created.push(dir);
  }
  return created;
}

export function bootstrapProject(options = {}) {
  if (!fs.existsSync(TEMPLATE_DIR)) {
    throw new Error(`Template directory missing: ${TEMPLATE_DIR}`);
  }
  if (!fs.existsSync(VERSION_FILE)) {
    throw new Error(`Harness VERSION file missing: ${VERSION_FILE}`);
  }
  assertNoSymlinkInTree(TEMPLATE_DIR);

  const compatConfig = loadCompatibilityConfig();
  const projectName = validateProjectName(options.name);
  const derivedOrExplicitSlug = options.slug ? options.slug.trim() : deriveSlug(projectName);
  const slug = validateSlug(derivedOrExplicitSlug);
  const projectId = `proj-${slug}`;
  const owner = validateScalarText("--owner", options.owner ?? "Project Owner");
  const description = validateScalarText(
    "--description",
    options.description ?? "Project initialized from the AI harness Second Brain starter template."
  );

  const resolvedProfile = resolveProfile(options.profile, compatConfig, PROFILES_DIR);
  const profileMeta = resolvedProfile ? resolvedProfile.meta : null;

  const defaultDest = path.join(IS_NPM_INSTALL ? process.cwd() : WORKSPACE_ROOT, "projects", slug);
  const destDir = validateDestinationPath(options.dest ?? defaultDest, {
    harnessDir: HARNESS_DIR,
    workspaceRoot: WORKSPACE_ROOT,
  });

  const dryRun = Boolean(options.dryRun);
  const gitInit = Boolean(options.git);
  const harnessVersion = fs.readFileSync(VERSION_FILE, "utf8").trim();
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

  const baseFiles = collectTemplateFiles(TEMPLATE_DIR);
  const renderedMap = new Map();

  for (const relPath of baseFiles) {
    // npm omits .gitignore files from tarballs. Restore the name in the generated project.
    const normalizedRel = relPath === "gitignore.template" ? ".gitignore" : relPath.replace(/\\/g, "/");
    const raw = fs.readFileSync(path.join(TEMPLATE_DIR, relPath), "utf8");
    const isYaml = normalizedRel.endsWith(".yaml") || normalizedRel.endsWith(".yml");
    const content =
      normalizedRel === "brain/manifest.yaml"
        ? renderManifest(raw, tokens, { gitInit, profileMeta })
        : renderSinglePass(raw, tokens, isYaml, normalizedRel);
    renderedMap.set(normalizedRel, content);
  }

  if (resolvedProfile) {
    const profileGuideSrc = path.join(resolvedProfile.profileDir, "brain", "profile.md");
    if (fs.existsSync(profileGuideSrc)) {
      const rawGuide = fs.readFileSync(profileGuideSrc, "utf8");
      renderedMap.set("brain/profile.md", renderSinglePass(rawGuide, tokens, false, "brain/profile.md"));
    }
    const gitignoreAppendSrc = path.join(resolvedProfile.profileDir, "gitignore.append");
    if (fs.existsSync(gitignoreAppendSrc)) {
      const baseIgnore = (renderedMap.get(".gitignore") || "").replace(/\r\n/g, "\n").trimEnd();
      const extraIgnore = fs.readFileSync(gitignoreAppendSrc, "utf8").replace(/\r\n/g, "\n").trim();
      if (extraIgnore.length > 0) {
        renderedMap.set(
          ".gitignore",
          `${baseIgnore}\n\n# Profile additions (${profileMeta.name} v${profileMeta.version})\n${extraIgnore}\n`
        );
      }
    }
  }

  addProjectBrief(renderedMap, options.goal);
  const orderedFiles = Array.from(renderedMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([relPath, content]) => ({ relPath, content }));

  if (dryRun) {
    return {
      dryRun: true,
      projectName,
      projectId,
      slug,
      owner,
      profile: profileMeta ? profileMeta.name : null,
      profileVersion: profileMeta ? profileMeta.version : null,
      destDir,
      gitInitialized: false,
      files: orderedFiles.map((f) => f.relPath),
      validation: null,
    };
  }

  const parentDir = path.dirname(destDir);
  const createdParents = ensureParentDirsTracked(parentDir);
  const stageDir = path.join(parentDir, `.harness-stage-${crypto.randomBytes(6).toString("hex")}`);
  fs.mkdirSync(stageDir, { recursive: false });

  try {
    for (const file of orderedFiles) {
      const targetPath = path.join(stageDir, file.relPath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, file.content, { encoding: "utf8", flag: "wx" });
    }

    if (gitInit) {
      execFileSync("git", ["init", "-b", "main"], {
        cwd: stageDir,
        encoding: "utf8",
        windowsHide: true,
      });
    }

    const validation = validateProject(stageDir, { compatibilityConfig: compatConfig });
    if (!validation.valid) {
      throw new Error(`Staged project failed validation: ${validation.errors.join("; ")}`);
    }

    if (typeof options.onBeforeCommit === "function") {
      options.onBeforeCommit(stageDir);
    }

    fs.renameSync(stageDir, destDir);

    return {
      dryRun: false,
      projectName,
      projectId,
      slug,
      owner,
      profile: profileMeta ? profileMeta.name : null,
      profileVersion: profileMeta ? profileMeta.version : null,
      destDir,
      gitInitialized: gitInit,
      files: orderedFiles.map((f) => f.relPath),
      validation,
    };
  } catch (err) {
    try {
      fs.rmSync(stageDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Best-effort cleanup of staging directory.
    }
    for (const dir of createdParents.reverse()) {
      try {
        fs.rmdirSync(dir);
      } catch {
        // Leave non-empty directories untouched.
      }
    }
    throw err;
  }
}

async function runCli() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        name: { type: "string" },
        goal: { type: "string" },
        "skip-planning": { type: "boolean" },
        slug: { type: "string" },
        dest: { type: "string" },
        owner: { type: "string" },
        description: { type: "string" },
        profile: { type: "string" },
        "created-at": { type: "string" },
        git: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }

  const opts = parsed.values;
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  try {
    const result = bootstrapProject({
      goal: await chooseProjectGoal(opts),
      name: opts.name,
      slug: opts.slug,
      dest: opts.dest,
      owner: opts.owner,
      description: opts.description,
      profile: opts.profile,
      createdAt: opts["created-at"],
      git: opts.git,
      dryRun: opts["dry-run"],
    });

    if (result.dryRun) {
      console.log("DRY RUN — No directories, files, or Git repositories were created.");
    } else {
      console.log("Project Second Brain initialized successfully.");
    }
    console.log(`Project Name : ${result.projectName}`);
    console.log(`Project ID   : ${result.projectId}`);
    console.log(`Slug         : ${result.slug}`);
    console.log(`Owner        : ${result.owner}`);
    console.log(`Profile      : ${result.profile ? `${result.profile} (${result.profileVersion})` : "none (base starter)"}`);
    console.log(`Destination  : ${result.destDir}`);
    console.log(
      `Git Init     : ${
        result.dryRun
          ? opts.git
            ? "would run: git init -b main"
            : "no"
          : result.gitInitialized
            ? "Initialized isolated Git repository on branch 'main' (no remotes, no commits)"
            : "Skipped (pass --git to initialize an isolated project Git repo)"
      }`
    );
    console.log(`${result.dryRun ? "Planned" : "Generated"} Files (${result.files.length}):`);
    for (const f of result.files) {
      console.log(`  - ${f}`);
    }
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

const isDirectRun = Boolean(process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename));
if (isDirectRun) {
  runCli();
}
