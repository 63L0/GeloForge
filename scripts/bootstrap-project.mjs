#!/usr/bin/env node
/**
 * Zero-dependency project bootstrapper for the AI Development Harness.
 * Copies harness/templates/project-starter to a new project directory,
 * substitutes approved placeholders, enforces path/overwrite safety, and
 * optionally initializes a local Git repository.
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_DIR = path.resolve(__dirname, "..");
const WORKSPACE_ROOT = path.resolve(HARNESS_DIR, "..");
const TEMPLATE_DIR = path.join(HARNESS_DIR, "templates", "project-starter");
const VERSION_FILE = path.join(HARNESS_DIR, "VERSION");

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const WINDOWS_RESERVED_NAME_REGEX = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/;
const INVALID_WINDOWS_SEGMENT_CHARS = /[<>:"/\\|?*]/;

function printHelp() {
  console.log(`AI Harness Project Bootstrapper (Phase 1)

Usage:
  node scripts/bootstrap-project.mjs --name "<Project Name>" [options]

Options:
  --name <string>         Project display name (required, 3-80 chars)
  --slug <string>         Lowercase URL/directory slug (optional; derived from --name)
  --dest <path>           Target directory (default: C:\\AI-Workspace\\projects\\<slug>)
  --owner <string>        Project owner name (default: "Project Owner")
  --description <string>  Short project description
  --git                   Initialize an isolated local Git repository (git init -b main)
  --dry-run               Validate inputs and preview files without writing anything
  -h, --help              Show this help message
`);
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function deriveSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function validateProjectName(rawName) {
  if (typeof rawName !== "string" || rawName.trim().length === 0) {
    fail("Missing required option --name.");
  }
  const name = rawName.trim();
  if (name.length < 3 || name.length > 80) {
    fail("--name must be between 3 and 80 characters after trimming.");
  }
  if (CONTROL_CHAR_REGEX.test(name)) {
    fail("--name must not contain control characters or newlines.");
  }
  if (/[<>:"/\\|?*]/.test(name) || name.includes("..")) {
    fail('--name must not contain path separators, "..", colons, or reserved filename characters.');
  }
  return name;
}

function validateSlug(slug) {
  if (!SLUG_REGEX.test(slug)) {
    fail(
      `Invalid slug "${slug}". Must match ${SLUG_REGEX} (3-50 chars, lowercase letters, digits, hyphens).`
    );
  }
  if (WINDOWS_RESERVED_NAME_REGEX.test(slug)) {
    fail(`Slug "${slug}" is a reserved Windows device name.`);
  }
  return slug;
}

function validateScalarText(label, value) {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    fail(`${label} must not be empty.`);
  }
  if (CONTROL_CHAR_REGEX.test(trimmed)) {
    fail(`${label} must not contain control characters or newlines.`);
  }
  return trimmed;
}

function isSameOrInside(candidatePath, forbiddenParent) {
  const normCandidate = path.resolve(candidatePath).toLowerCase();
  const normParent = path.resolve(forbiddenParent).toLowerCase();
  return normCandidate === normParent || normCandidate.startsWith(normParent + path.sep);
}

function validateDestination(rawDest) {
  if (typeof rawDest !== "string" || rawDest.trim().length === 0) {
    fail("Destination path must not be empty.");
  }
  if (CONTROL_CHAR_REGEX.test(rawDest)) {
    fail("Destination path contains illegal control characters.");
  }

  const resolved = path.resolve(rawDest);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) {
    fail(`Refusing to initialize project at filesystem root "${resolved}".`);
  }

  // Inspect each path segment below the root for illegal Windows characters or reserved names.
  const remainder = resolved.slice(parsed.root.length);
  const segments = remainder.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) {
    fail(`Invalid destination path "${resolved}".`);
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      fail(`Destination path "${resolved}" contains invalid relative segment "${segment}".`);
    }
    if (INVALID_WINDOWS_SEGMENT_CHARS.test(segment)) {
      fail(`Destination path segment "${segment}" contains illegal Windows characters.`);
    }
    if (WINDOWS_RESERVED_NAME_REGEX.test(segment)) {
      fail(`Destination path segment "${segment}" is a reserved Windows device name.`);
    }
  }

  const protectedDirs = [
    HARNESS_DIR,
    path.join(WORKSPACE_ROOT, "local-runtime"),
    path.join(WORKSPACE_ROOT, "worktrees"),
  ];
  for (const dir of protectedDirs) {
    if (isSameOrInside(resolved, dir)) {
      fail(`Refusing to write inside protected workspace directory: ${dir}`);
    }
  }

  const exactForbidden = [WORKSPACE_ROOT, path.join(WORKSPACE_ROOT, "projects")];
  const resolvedLower = resolved.toLowerCase();
  for (const dir of exactForbidden) {
    if (resolvedLower === path.resolve(dir).toLowerCase()) {
      fail(`Refusing to initialize project directly at container directory: ${dir}`);
    }
  }

  if (fs.existsSync(resolved)) {
    fail(`Refusing to overwrite existing destination: ${resolved}`);
  }
  try {
    fs.lstatSync(resolved);
    fail(`Refusing to overwrite existing destination entry: ${resolved}`);
  } catch (err) {
    if (err.code !== "ENOENT") {
      fail(`Unable to inspect destination "${resolved}": ${err.message}`);
    }
  }

  return resolved;
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

function escapeYamlString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function renderContent(relPath, rawContent, tokens, gitInit) {
  const isYaml = relPath.endsWith(".yaml") || relPath.endsWith(".yml");
  let output = rawContent;

  for (const [key, rawVal] of Object.entries(tokens)) {
    const placeholder = `{{${key}}}`;
    const replacement = isYaml ? escapeYamlString(rawVal) : rawVal;
    output = output.split(placeholder).join(replacement);
  }

  const normalizedRel = relPath.replace(/\\/g, "/");
  if (normalizedRel === "brain/manifest.yaml") {
    output = output.replace(/^status:\s*"template"(?=\r?$)/m, 'status: "initialized"');
    if (gitInit) {
      output = output.replace(/^(\s*initialized:\s*)false(?=\r?$)/m, "$1true");
    }
  }

  const leftover = output.match(/\{\{[A-Z0-9_]+\}\}/g);
  if (leftover) {
    throw new Error(`Unreplaced placeholder(s) in ${normalizedRel}: ${leftover.join(", ")}`);
  }

  return output;
}

function main() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        name: { type: "string" },
        slug: { type: "string" },
        dest: { type: "string" },
        owner: { type: "string", default: "Project Owner" },
        description: {
          type: "string",
          default: "Project initialized from the AI harness Second Brain starter template.",
        },
        git: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    fail(err.message);
  }

  const opts = parsed.values;
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  if (!fs.existsSync(TEMPLATE_DIR)) {
    fail(`Template directory missing: ${TEMPLATE_DIR}`);
  }
  if (!fs.existsSync(VERSION_FILE)) {
    fail(`Harness VERSION file missing: ${VERSION_FILE}`);
  }

  const projectName = validateProjectName(opts.name);
  const slug = validateSlug(opts.slug ? opts.slug.trim() : deriveSlug(projectName));
  const projectId = `proj-${slug}`;
  const owner = validateScalarText("--owner", opts.owner);
  const description = validateScalarText("--description", opts.description);
  const defaultDest = path.join(WORKSPACE_ROOT, "projects", slug);
  const destDir = validateDestination(opts.dest ?? defaultDest);
  const dryRun = Boolean(opts["dry-run"]);
  const gitInit = Boolean(opts.git);

  const harnessVersion = fs.readFileSync(VERSION_FILE, "utf8").trim();
  const createdAt = new Date().toISOString();
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
  };

  const templateFiles = collectTemplateFiles(TEMPLATE_DIR);
  const renderedFiles = templateFiles.map((relPath) => {
    const srcPath = path.join(TEMPLATE_DIR, relPath);
    const raw = fs.readFileSync(srcPath, "utf8");
    const content = renderContent(relPath, raw, tokens, gitInit);
    return {
      relPath: relPath.replace(/\\/g, "/"),
      targetPath: path.join(destDir, relPath),
      content,
    };
  });

  if (dryRun) {
    console.log("DRY RUN — No directories, files, or Git repositories were created.");
    console.log(`Project Name : ${projectName}`);
    console.log(`Project ID   : ${projectId}`);
    console.log(`Slug         : ${slug}`);
    console.log(`Owner        : ${owner}`);
    console.log(`Destination  : ${destDir}`);
    console.log(`Git Init     : ${gitInit ? "would run: git init -b main" : "no"}`);
    console.log(`Planned Files (${renderedFiles.length}):`);
    for (const f of renderedFiles) {
      console.log(`  - ${f.relPath}`);
    }
    return;
  }

  fs.mkdirSync(destDir, { recursive: true });
  for (const file of renderedFiles) {
    fs.mkdirSync(path.dirname(file.targetPath), { recursive: true });
    // Exclusive write ('wx') guarantees we never overwrite an existing file.
    fs.writeFileSync(file.targetPath, file.content, { encoding: "utf8", flag: "wx" });
  }

  let gitStatusMsg = "Skipped (pass --git to initialize an isolated project Git repo)";
  if (gitInit) {
    execFileSync("git", ["init", "-b", "main"], {
      cwd: destDir,
      encoding: "utf8",
      windowsHide: true,
    });
    gitStatusMsg = "Initialized isolated Git repository on branch 'main' (no remotes, no commits)";
  }

  console.log("Project Second Brain initialized successfully.");
  console.log(`Project Name : ${projectName}`);
  console.log(`Project ID   : ${projectId}`);
  console.log(`Slug         : ${slug}`);
  console.log(`Owner        : ${owner}`);
  console.log(`Destination  : ${destDir}`);
  console.log(`Git          : ${gitStatusMsg}`);
  console.log(`Generated Files (${renderedFiles.length}):`);
  for (const f of renderedFiles) {
    console.log(`  - ${f.relPath}`);
  }
}

main();
