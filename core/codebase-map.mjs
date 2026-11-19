/**
 * Selective Deterministic Codebase Mapper for GeloForge (Layer 4 navigational aid).
 * Inspired by Aider's RepoMap concept: builds concise symbol outlines weighted by
 * task/query relevance and local import relationships without paid APIs, embeddings,
 * or loading entire large repositories into prompt context.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { assertSafeWithinRoot, hasSecretContent, isForbiddenSecretPath } from "./path-safety.mjs";

const MAX_DISCOVERED_PATHS = 10000;
const DEFAULT_MAX_SCANNED_FILES = 500;
const DEFAULT_MAX_SELECTED_FILES = 25;
const DEFAULT_MAP_BUDGET = 1200;
const MAX_SOURCE_FILE_BYTES = 256 * 1024;

const EXCLUDED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".cache",
  ".turbo",
  ".parcel-cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".venv",
  "venv",
  "target",
  "vendor",
  "bin",
  "obj",
  "secrets",
  ".aws",
  ".ssh",
]);

const SECOND_BRAIN_DIRS = new Set([
  "brain",
  "tasks",
  "evidence",
  "proposals",
  "handoffs",
  "local-runtime",
  "worktrees",
]);

const EXCLUDED_LOCKFILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "cargo.lock",
  "poetry.lock",
  "pipfile.lock",
  "composer.lock",
  "gemfile.lock",
  "go.sum",
]);

const BINARY_AND_ASSET_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp", ".tiff",
  ".pdf", ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".wasm", ".o", ".a", ".lib",
  ".class", ".pyc", ".pyo", ".pyd",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".wav", ".ogg", ".flac", ".mp4", ".mov", ".avi", ".webm",
  ".sqlite", ".sqlite3", ".db", ".map", ".crt", ".cer", ".der", ".csr",
]);

const MAP_STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "what",
  "where", "which", "will", "should", "must", "have", "has", "been", "they",
  "their", "them", "then", "than", "only", "also", "more", "most", "some",
  "such", "each", "other", "about", "after", "before", "using", "use", "used",
  "task", "project", "file", "files", "code", "implement", "update", "fix",
]);

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function sanitizeInline(text) {
  return String(text || "")
    .replace(/<<<END_GELOFORGE_DOC>>>/g, "<<<ESCAPED_END_GELOFORGE_DOC>>>")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function tokenizeKeywords(text) {
  if (!text || typeof text !== "string") return new Set();
  const raw = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !MAP_STOP_WORDS.has(t));
  return new Set(raw);
}

function isExcludedPath(relPath, { excludeSecondBrainDirs = true } = {}) {
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!norm) return "empty-path";
  if (isForbiddenSecretPath(norm)) return "forbidden-secret-path";

  const segments = norm.split("/").filter(Boolean);
  const baseLower = segments[segments.length - 1].toLowerCase();
  if (
    baseLower === "secrets.json" ||
    baseLower === "secrets.yaml" ||
    baseLower === "secrets.yml" ||
    baseLower.startsWith("secrets.")
  ) {
    return "forbidden-secret-path";
  }

  for (let i = 0; i < segments.length - 1; i += 1) {
    const dirLower = segments[i].toLowerCase();
    if (EXCLUDED_DIRS.has(dirLower)) return "excluded-dir";
    if (excludeSecondBrainDirs && i === 0 && SECOND_BRAIN_DIRS.has(dirLower)) {
      return "second-brain-dir";
    }
  }

  if (EXCLUDED_LOCKFILES.has(baseLower)) return "lockfile";
  if (baseLower.endsWith(".min.js") || baseLower.endsWith(".min.css")) return "minified-bundle";
  const ext = path.extname(baseLower);
  if (BINARY_AND_ASSET_EXTS.has(ext)) return "binary-or-asset";
  return null;
}

function compileGitignoreMatcher(gitignoreText, baseRelDir = "") {
  const rules = [];
  const lines = gitignoreText.split(/\r?\n/);
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    let negate = false;
    let pat = trimmed;
    if (pat.startsWith("!")) {
      negate = true;
      pat = pat.slice(1);
    }
    const dirOnly = pat.endsWith("/");
    if (dirOnly) pat = pat.slice(0, -1);
    const anchored = pat.startsWith("/");
    if (anchored) pat = pat.slice(1);
    if (!pat) continue;

    const escaped = pat
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\//g, "(?:.*/)?")
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]");
    const hasSlash = pat.includes("/");
    const regexStr = anchored || hasSlash
      ? `^${escaped}(?:/.*)?$`
      : `(?:^|/)${escaped}(?:/.*)?$`;
    rules.push({ negate, dirOnly, regex: new RegExp(regexStr, "i"), baseRelDir });
  }
  return rules;
}

function isIgnoredByRules(relPath, isDir, rules) {
  const norm = relPath.replace(/\\/g, "/");
  let ignored = false;
  for (const rule of rules) {
    let target = norm;
    if (rule.baseRelDir) {
      const prefix = `${rule.baseRelDir}/`;
      if (!norm.startsWith(prefix)) continue;
      target = norm.slice(prefix.length);
    }
    if (rule.dirOnly && !isDir && !target.includes("/")) {
      // File cannot match dirOnly rule on its own filename alone unless parent matched
      if (!rule.regex.test(`${target}/`)) {
        continue;
      }
    }
    if (rule.regex.test(target)) {
      ignored = !rule.negate;
    }
  }
  return ignored;
}

function discoverFilesWithGit(projectDir, warnings) {
  try {
    const inside = execFileSync("git", ["-C", projectDir, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (inside !== "true") {
      return null;
    }
    const out = execFileSync(
      "git",
      ["-C", projectDir, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    const paths = out.split("\0").filter(Boolean);
    return { mode: "git-ls-files", paths };
  } catch (err) {
    if (fs.existsSync(path.join(projectDir, ".git"))) {
      warnings.push(`Git discovery failed (${err.message}); falling back to filesystem walk.`);
    }
    return null;
  }
}

function discoverFilesFallback(projectDir, warnings, excludeSecondBrainDirs) {
  const discovered = [];
  let hitMaxCap = false;

  const walk = (absDir, inheritedRules) => {
    if (discovered.length >= MAX_DISCOVERED_PATHS) {
      hitMaxCap = true;
      return;
    }
    let rules = inheritedRules;
    const giPath = path.join(absDir, ".gitignore");
    if (fs.existsSync(giPath)) {
      try {
        const giStat = fs.lstatSync(giPath);
        if (giStat.isFile() && !giStat.isSymbolicLink() && giStat.size <= 64 * 1024) {
          const baseRel = path.relative(projectDir, absDir).replace(/\\/g, "/");
          rules = [
            ...inheritedRules,
            ...compileGitignoreMatcher(fs.readFileSync(giPath, "utf8"), baseRel),
          ];
        }
      } catch {
        // Ignore unreadable .gitignore
      }
    }

    const entries = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (discovered.length >= MAX_DISCOVERED_PATHS) {
        hitMaxCap = true;
        break;
      }
      const full = path.join(absDir, entry.name);
      const rel = path.relative(projectDir, full).replace(/\\/g, "/");
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        warnings.push(`Skipped symbolic link during codebase scan: ${rel}`);
        continue;
      }
      if (stat.isDirectory()) {
        const dirLower = entry.name.toLowerCase();
        if (EXCLUDED_DIRS.has(dirLower)) continue;
        if (excludeSecondBrainDirs && !rel.includes("/") && SECOND_BRAIN_DIRS.has(dirLower)) continue;
        if (isIgnoredByRules(rel, true, rules)) continue;
        walk(full, rules);
      } else if (stat.isFile()) {
        if (entry.name === ".gitignore") continue;
        if (isIgnoredByRules(rel, false, rules)) continue;
        discovered.push(rel);
      }
    }
  };

  walk(projectDir, []);
  if (hitMaxCap) {
    warnings.push(`Directory discovery stopped after ${MAX_DISCOVERED_PATHS} files (bounded scan safeguard).`);
  }
  return { mode: "filesystem-walk", paths: discovered };
}

function detectLanguage(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  switch (ext) {
    case ".js":
    case ".mjs":
    case ".cjs":
    case ".jsx":
      return "javascript";
    case ".ts":
    case ".mts":
    case ".cts":
    case ".tsx":
      return "typescript";
    case ".py":
    case ".pyw":
      return "python";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".java":
      return "java";
    case ".cs":
      return "csharp";
    case ".kt":
    case ".kts":
      return "kotlin";
    case ".c":
    case ".h":
    case ".cc":
    case ".cpp":
    case ".hpp":
    case ".hh":
      return "c_cpp";
    case ".sh":
    case ".bash":
    case ".zsh":
    case ".ps1":
      return "shell";
    case ".sql":
      return "sql";
    case ".md":
    case ".mdx":
      return "markdown";
    case ".json":
      return "json";
    case ".yaml":
    case ".yml":
      return "yaml";
    case ".toml":
      return "toml";
    default:
      return ext ? `unsupported(${ext})` : "unsupported";
  }
}

export function extractFileOutline(relPath, content) {
  const language = detectLanguage(relPath);
  const lines = content.split(/\r?\n/);
  const symbols = [];
  const imports = [];

  const pushSym = (lineNum, kind, name, sig) => {
    const cleanSig = sanitizeInline(sig).slice(0, 110);
    symbols.push({
      line: lineNum,
      kind,
      name: sanitizeInline(name),
      signature: cleanSig,
    });
  };

  if (language === "javascript" || language === "typescript") {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();
      const ln = i + 1;
      const impMatch = trimmed.match(/^(?:import\s+.*?\s+from\s+|import\s+|.*?\brequire\()\s*['"]([^'"]+)['"]/);
      if (impMatch) imports.push(impMatch[1]);

      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      let m;
      if ((m = line.match(/^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/))) {
        pushSym(ln, "function", m[1], `function ${m[1]}(${m[2].trim()})`);
      } else if ((m = line.match(/^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/))) {
        pushSym(ln, "class", m[1], trimmed.replace(/\{.*$/, "").trim());
      } else if ((m = line.match(/^\s*(?:export\s+)?(interface|type|enum)\s+([A-Za-z_$][\w$]*)/))) {
        pushSym(ln, m[1], m[2], trimmed.replace(/\{.*$/, "").trim());
      } else if ((m = line.match(/^\s*export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/))) {
        pushSym(ln, "function", m[1], trimmed.replace(/=>.*$/, "=> ...").trim());
      }
    }
    return { language, outlineMode: "ast-regex", symbols, imports, lineCount: lines.length };
  }

  if (language === "python") {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();
      const ln = i + 1;
      let m;
      if ((m = trimmed.match(/^from\s+(\S+)\s+import\s+/))) imports.push(m[1]);
      else if ((m = trimmed.match(/^import\s+([A-Za-z_][\w.]*)/))) imports.push(m[1]);

      if ((m = line.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/))) {
        const kind = m[1].length > 0 ? "method" : "function";
        pushSym(ln, kind, m[2], `def ${m[2]}(${m[3].trim()})`);
      } else if ((m = line.match(/^\s*class\s+([A-Za-z_]\w*(?:\([^)]*\))?)\s*:/))) {
        pushSym(ln, "class", m[1].split("(")[0], `class ${m[1]}`);
      }
    }
    return { language, outlineMode: "ast-regex", symbols, imports, lineCount: lines.length };
  }

  if (language === "go") {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();
      const ln = i + 1;
      let m;
      if ((m = trimmed.match(/^import\s+(?:[A-Za-z_]\w*\s+)?"([^"]+)"/))) imports.push(m[1]);
      if ((m = line.match(/^func\s+(?:\([^)]+\)\s+)?([A-Za-z_]\w*)\s*\(([^)]*)\)/))) {
        pushSym(ln, "function", m[1], trimmed.replace(/\{.*$/, "").trim());
      } else if ((m = line.match(/^type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/))) {
        pushSym(ln, m[2], m[1], `type ${m[1]} ${m[2]}`);
      }
    }
    return { language, outlineMode: "ast-regex", symbols, imports, lineCount: lines.length };
  }

  if (language === "rust") {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();
      const ln = i + 1;
      let m;
      if ((m = trimmed.match(/^use\s+([^;]+);/))) imports.push(m[1]);
      if ((m = line.match(/^\s*(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/))) {
        pushSym(ln, "fn", m[1], trimmed.replace(/\{.*$/, "").trim());
      } else if ((m = line.match(/^\s*(?:pub(?:\([^)]+\))?\s+)?(struct|enum|trait|mod)\s+([A-Za-z_]\w*)/))) {
        pushSym(ln, m[1], m[2], trimmed.replace(/[{;].*$/, "").trim());
      } else if ((m = line.match(/^\s*impl(?:<[^>]+>)?\s+([^{]+)/))) {
        pushSym(ln, "impl", m[1].trim(), `impl ${m[1].trim()}`);
      }
    }
    return { language, outlineMode: "ast-regex", symbols, imports, lineCount: lines.length };
  }

  if (language === "java" || language === "csharp" || language === "kotlin") {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();
      const ln = i + 1;
      let m;
      if ((m = trimmed.match(/^(?:import|using)\s+([^;]+)/))) imports.push(m[1]);
      if (
        (m = line.match(
          /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|data|open)\s+)*(class|interface|enum|record|struct)\s+([A-Za-z_]\w*)/
        ))
      ) {
        pushSym(ln, m[1], m[2], trimmed.replace(/\{.*$/, "").trim());
      } else if (
        language === "kotlin" &&
        (m = line.match(/^\s*(?:(?:public|private|internal|suspend)\s+)*fun\s+([A-Za-z_]\w*\s*\([^)]*\))/))
      ) {
        pushSym(ln, "function", m[1].split("(")[0], `fun ${m[1]}`);
      } else if (
        (m = line.match(
          /^\s*(?:public|private|protected|internal)\s+(?:static\s+|async\s+|virtual\s+|override\s+)*[\w<>[\], ?]+\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/
        ))
      ) {
        pushSym(ln, "method", m[1], trimmed.replace(/\{.*$/, "").trim());
      }
    }
    return { language, outlineMode: "ast-regex", symbols, imports, lineCount: lines.length };
  }

  if (language === "c_cpp") {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();
      const ln = i + 1;
      let m;
      if ((m = trimmed.match(/^#include\s+"([^"]+)"/))) imports.push(m[1]);
      if ((m = line.match(/^\s*(?:template\s*<[^>]+>\s*)?(class|struct|enum|namespace)\s+([A-Za-z_]\w*)/))) {
        pushSym(ln, m[1], m[2], `${m[1]} ${m[2]}`);
      } else if (
        !trimmed.startsWith("if") &&
        !trimmed.startsWith("for") &&
        !trimmed.startsWith("while") &&
        (m = line.match(/^[A-Za-z_][\w:*&<> ]+\s+([A-Za-z_]\w*)\s*\(([^;)]*)\)\s*(?:\{|$)/))
      ) {
        pushSym(ln, "function", m[1], trimmed.replace(/\{.*$/, "").trim());
      }
    }
    return { language, outlineMode: "ast-regex", symbols, imports, lineCount: lines.length };
  }

  if (language === "shell" || language === "sql" || language === "markdown" || language === "yaml" || language === "toml" || language === "json") {
    if (language === "json") {
      try {
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const key of Object.keys(parsed).slice(0, 12)) {
            pushSym(1, "key", key, key);
          }
        }
      } catch {
        // Fallback silently for invalid/JSONC files
      }
      return { language, outlineMode: "structured", symbols, imports, lineCount: lines.length };
    }
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const ln = i + 1;
      let m;
      if (language === "markdown" && (m = line.match(/^(#{1,3})\s+(.+)$/))) {
        pushSym(ln, `h${m[1].length}`, m[2], `${m[1]} ${m[2]}`);
      } else if ((language === "yaml" || language === "toml") && (m = line.match(/^([A-Za-z_][\w.-]*)\s*:/) || line.match(/^\[([A-Za-z_][\w.-]*)\]/))) {
        pushSym(ln, "section", m[1], m[1]);
      } else if (language === "shell" && (m = line.match(/^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/))) {
        pushSym(ln, "function", m[1], `${m[1]}()`);
      } else if (language === "sql" && (m = line.match(/^\s*create\s+(?:or\s+replace\s+)?(table|view|function|index)\s+(?:if\s+not\s+exists\s+)?([A-Za-z_][\w."]*)/i))) {
        pushSym(ln, m[1].toLowerCase(), m[2], line.trim());
      }
    }
    return { language, outlineMode: "structured", symbols, imports, lineCount: lines.length };
  }

  // Graceful fallback for unsupported or custom text extensions
  for (let i = 0; i < Math.min(lines.length, 60); i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    const gen = trimmed.match(/^(?:pub\s+|export\s+)?(fn|def|func|function|class|struct|module|contract)\s+([A-Za-z_][\w]*)/);
    if (gen) {
      pushSym(i + 1, gen[1], gen[2], trimmed.slice(0, 90));
    }
  }
  if (symbols.length === 0) {
    for (let i = 0; i < Math.min(lines.length, 15) && symbols.length < 2; i += 1) {
      const trimmed = sanitizeInline(lines[i]);
      if (trimmed.length >= 4) {
        pushSym(i + 1, "line", trimmed.slice(0, 40), trimmed.slice(0, 90));
      }
    }
  }
  return { language, outlineMode: "fallback", symbols, imports, lineCount: lines.length };
}

function resolveLocalImport(fromRelPath, specifier, candidateSet) {
  if (!specifier) {
    return null;
  }
  let normalizedSpec = specifier;
  if (/^\.+[A-Za-z_]/.test(specifier)) {
    const dotMatch = specifier.match(/^(\.+)(.*)$/);
    if (dotMatch) {
      const dots = dotMatch[1];
      const modPath = dotMatch[2].replace(/\./g, "/");
      const prefix = dots.length === 1 ? "./" : "../".repeat(dots.length - 1);
      normalizedSpec = `${prefix}${modPath}`;
    }
  }
  if (!normalizedSpec.startsWith(".") && !normalizedSpec.startsWith("/")) {
    return null;
  }
  const fromDir = path.posix.dirname(fromRelPath.replace(/\\/g, "/"));
  const base = normalizedSpec.startsWith("/")
    ? normalizedSpec.slice(1)
    : path.posix.normalize(path.posix.join(fromDir, normalizedSpec));

  const trials = [
    base,
    `${base}.mjs`,
    `${base}.js`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.jsx`,
    `${base}.py`,
    `${base}/index.mjs`,
    `${base}/index.js`,
    `${base}/index.ts`,
  ];
  for (const t of trials) {
    if (candidateSet.has(t)) return t;
  }
  return null;
}

export function buildCodebaseMap(options = {}) {
  if (typeof options.projectDir !== "string" || options.projectDir.trim().length === 0) {
    throw new Error("buildCodebaseMap requires options.projectDir.");
  }
  const projectDir = path.resolve(options.projectDir);
  const warnings = Array.isArray(options.warnings) ? options.warnings : [];
  const mapBudget = Number.isInteger(options.mapBudget) && options.mapBudget >= 100 ? options.mapBudget : DEFAULT_MAP_BUDGET;
  const maxScannedFiles =
    Number.isInteger(options.maxScannedFiles) && options.maxScannedFiles > 0
      ? options.maxScannedFiles
      : DEFAULT_MAX_SCANNED_FILES;
  const maxSelectedFiles =
    Number.isInteger(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : DEFAULT_MAX_SELECTED_FILES;
  const maxSymbolsPerFile =
    Number.isInteger(options.maxSymbolsPerFile) && options.maxSymbolsPerFile > 0 ? options.maxSymbolsPerFile : 12;
  const excludeSecondBrainDirs = options.excludeSecondBrainDirs !== false;

  const seedPaths = new Set(Array.from(options.seedPaths || [], (p) => String(p).replace(/\\/g, "/")));
  const skipPaths = new Set(Array.from(options.alreadyIncludedPaths || [], (p) => String(p).replace(/\\/g, "/")));
  const queryKeywords = options.queryKeywords instanceof Set ? options.queryKeywords : tokenizeKeywords(options.queryText || "");
  const queryMentionsTests = queryKeywords.has("test") || queryKeywords.has("tests") || queryKeywords.has("spec");

  // 1. Discover files (Git .gitignore-aware when available, deterministic fallback walk otherwise)
  const gitDiscovery = discoverFilesWithGit(projectDir, warnings);
  const rawDiscovery = gitDiscovery || discoverFilesFallback(projectDir, warnings, excludeSecondBrainDirs);
  const scanMode = rawDiscovery.mode;

  // 2. Filter paths cleanly before reading any bytes
  const blockedFiles = [];
  const eligiblePaths = [];
  for (const rawRel of rawDiscovery.paths) {
    const rel = rawRel.replace(/\\/g, "/");
    const excludedReason = isExcludedPath(rel, { excludeSecondBrainDirs });
    if (excludedReason) {
      if (excludedReason === "forbidden-secret-path") {
        blockedFiles.push({ path: rel, reason: "Excluded sensitive credential/key path" });
      }
      continue;
    }
    eligiblePaths.push(rel);
  }

  // Deduplicate + sort cleanly
  const uniqueEligible = Array.from(new Set(eligiblePaths)).sort((a, b) => a.localeCompare(b));
  const totalDiscoveredFiles = uniqueEligible.length;

  // 3. Cheap path-level pre-ranking so bounded scans still prioritize relevant deep paths (e.g. src/z-payments.ts)
  const preRanked = uniqueEligible.map((rel) => {
    const pathTokens = tokenizeKeywords(rel);
    let pathMatches = 0;
    for (const kw of queryKeywords) {
      if (pathTokens.has(kw)) pathMatches += 1;
    }
    const isSeed = seedPaths.has(rel);
    const segments = rel.split("/");
    const stem = path.posix.basename(rel, path.posix.extname(rel)).toLowerCase();
    const isSourceTree = segments.length > 1 && /^(src|core|lib|app|server|api|packages|cmd|internal|scripts)$/.test(segments[0].toLowerCase());
    const isEntrypoint = /^(index|main|app|server|cli|mod|lib)$/.test(stem);
    const isTestFile = /(?:^|\/)(?:tests?|__tests__|specs?)\/|\.(?:test|spec)\.[^.]+$/i.test(rel);

    let preScore = pathMatches * 25;
    if (isSeed) preScore += 120;
    if (isSourceTree) preScore += 12;
    if (isEntrypoint) preScore += 8;
    if (isTestFile && !queryMentionsTests) preScore -= 15;

    return { rel, preScore, pathMatches, isSeed, isSourceTree, isEntrypoint, isTestFile };
  });

  preRanked.sort((a, b) => {
    if (b.preScore !== a.preScore) return b.preScore - a.preScore;
    return a.rel.localeCompare(b.rel);
  });

  const truncatedScan = preRanked.length > maxScannedFiles;
  const toScan = preRanked.slice(0, maxScannedFiles);
  if (truncatedScan) {
    warnings.push(
      `Codebase map bounded scan: pre-ranked ${preRanked.length} eligible source files and read top ${maxScannedFiles}.`
    );
  }

  // 4. Safe read, binary/secret checks, symbol outline & import extraction
  const scannedCandidateSet = new Set(toScan.map((item) => item.rel));
  const analyzed = [];
  const analyzedByPath = new Map();

  for (const item of toScan) {
    const rel = item.rel;
    let absPath;
    try {
      absPath = assertSafeWithinRoot(projectDir, rel);
    } catch (err) {
      warnings.push(`Blocked unsafe path in codebase map (${rel}): ${err.message}`);
      blockedFiles.push({ path: rel, reason: `Unsafe path (${err.message})` });
      continue;
    }
    if (!fs.existsSync(absPath)) continue;

    let stat;
    try {
      stat = fs.lstatSync(absPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      warnings.push(`Skipped symbolic link or non-file in codebase map: ${rel}`);
      blockedFiles.push({ path: rel, reason: "Symbolic link or non-regular file" });
      continue;
    }
    if (stat.size > MAX_SOURCE_FILE_BYTES) {
      blockedFiles.push({ path: rel, reason: `Skipped large source file (${stat.size} bytes > ${MAX_SOURCE_FILE_BYTES})` });
      continue;
    }

    const buf = fs.readFileSync(absPath);
    if (buf.subarray(0, 8192).includes(0)) {
      blockedFiles.push({ path: rel, reason: "Skipped binary file (NUL bytes detected)" });
      continue;
    }
    const text = buf.toString("utf8");
    if (hasSecretContent(text)) {
      const reason = `Blocked by security filter (credential-like pattern in ${rel})`;
      warnings.push(reason);
      blockedFiles.push({ path: rel, reason });
      continue;
    }

    const outline = extractFileOutline(rel, text);
    const resolvedImports = [];
    for (const imp of outline.imports) {
      const target = resolveLocalImport(rel, imp, scannedCandidateSet);
      if (target && target !== rel && !resolvedImports.includes(target)) {
        resolvedImports.push(target);
      }
    }

    const entry = {
      ...item,
      language: outline.language,
      outlineMode: outline.outlineMode,
      lineCount: outline.lineCount,
      symbols: outline.symbols,
      resolvedImports,
      importedBy: [],
    };
    analyzed.push(entry);
    analyzedByPath.set(rel, entry);
  }

  // 5. Build reverse import graph (1-hop centrality & seed/high-score propagation)
  for (const entry of analyzed) {
    for (const target of entry.resolvedImports) {
      const dep = analyzedByPath.get(target);
      if (dep) dep.importedBy.push(entry.rel);
    }
  }

  const scoredFiles = [];
  const omittedFiles = [];

  for (const entry of analyzed) {
    const symTokens = tokenizeKeywords(entry.symbols.map((s) => s.name).join(" "));
    let symbolMatches = 0;
    const matchedKeywords = [];
    for (const kw of queryKeywords) {
      if (tokenizeKeywords(entry.rel).has(kw) || symTokens.has(kw)) {
        matchedKeywords.push(kw);
      }
      if (symTokens.has(kw)) {
        symbolMatches += 1;
      }
    }

    let score = entry.preScore + Math.min(symbolMatches, 5) * 14 + Math.min(entry.symbols.length, 6);
    const reasons = [];
    if (entry.isSeed) reasons.push("direct task required_input");
    if (matchedKeywords.length > 0) reasons.push(`matched keywords (${matchedKeywords.slice(0, 4).join(", ")})`);
    if (entry.isSourceTree) reasons.push("source module");
    if (entry.isEntrypoint) reasons.push("entrypoint");

    // Import graph boost: imported by a seed file or high-relevance module
    const highImporters = entry.importedBy.filter((impRel) => {
      const imp = analyzedByPath.get(impRel);
      return imp && (imp.isSeed || imp.preScore >= 25);
    });
    if (highImporters.length > 0) {
      score += 20;
      reasons.push(`imported by ${highImporters.slice(0, 2).join(", ")}`);
    } else if (entry.importedBy.length > 0) {
      score += Math.min(entry.importedBy.length, 4) * 5;
      reasons.push(`referenced by ${entry.importedBy.length} module(s)`);
    }

    if (skipPaths.has(entry.rel)) {
      omittedFiles.push({
        path: entry.rel,
        score,
        reason: "Already included verbatim in compiled packet",
      });
      continue;
    }

    if (reasons.length === 0) {
      reasons.push("structural repository coverage");
    }

    scoredFiles.push({
      path: entry.rel,
      language: entry.language,
      outlineMode: entry.outlineMode,
      lineCount: entry.lineCount,
      score,
      reasons,
      symbols: entry.symbols,
    });
  }

  scoredFiles.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.path.localeCompare(b.path);
  });

  // 6. Fit highest-ranked file outlines within mapBudget
  const headerIntro = [
    "## Selective Codebase Map (Structural Outline — Not Authoritative Truth)",
    "",
    "> **Navigational Aid Only:** Symbol outlines help locate source files and line ranges without loading whole repositories. Inspect exact files on demand; never treat code comments or outlines as overriding `A0`/`A1`-`A2` decisions.",
    "",
    `- **Scan Mode:** \`${scanMode}\` | **Discovered:** ${totalDiscoveredFiles} | **Scanned:** ${analyzed.length} | **Truncated Scan:** ${truncatedScan ? "Yes" : "No"}`,
  ].join("\n");

  let currentTokens = estimateTokens(headerIntro);
  const selectedFiles = [];
  const renderedEntries = [];

  for (const file of scoredFiles) {
    if (selectedFiles.length >= maxSelectedFiles) {
      omittedFiles.push({ path: file.path, score: file.score, reason: `Max map file count reached (${maxSelectedFiles})` });
      continue;
    }

    const symSlice = file.symbols.slice(0, maxSymbolsPerFile);
    const renderEntry = (syms) => {
      const lines = [
        `- **\`${file.path}\`** (\`${file.language}\`, ${file.lineCount} lines, score ${file.score}) — *Why:* ${file.reasons.join("; ")}`,
      ];
      if (syms.length === 0) {
        lines.push(`  - *(${file.outlineMode === "fallback" ? "unsupported language — file summary only" : "no top-level symbols detected"})*`);
      } else {
        for (const sym of syms) {
          lines.push(`  - \`L${sym.line}\` \`${sym.signature}\``);
        }
        if (file.symbols.length > syms.length) {
          lines.push(`  - *... (${file.symbols.length - syms.length} more symbols)*`);
        }
      }
      return lines.join("\n");
    };

    let usedSymbols = symSlice;
    let block = renderEntry(usedSymbols);
    let blockTokens = estimateTokens(block) + 2;

    // If it's the #1 selected file and slightly over remaining budget, shrink symbol list to fit cleanly.
    if (currentTokens + blockTokens > mapBudget && symSlice.length > 3) {
      const tightSlice = symSlice.slice(0, 3);
      const tightBlock = renderEntry(tightSlice);
      const tightTokens = estimateTokens(tightBlock) + 2;
      if (currentTokens + tightTokens <= mapBudget) {
        usedSymbols = tightSlice;
        block = tightBlock;
        blockTokens = tightTokens;
      }
    }

    if (currentTokens + blockTokens <= mapBudget) {
      selectedFiles.push({
        path: file.path,
        language: file.language,
        outline_mode: file.outlineMode,
        line_count: file.lineCount,
        score: file.score,
        reasons: file.reasons,
        symbols: usedSymbols,
      });
      renderedEntries.push(block);
      currentTokens += blockTokens;
    } else {
      omittedFiles.push({
        path: file.path,
        score: file.score,
        reason: `Map token budget reached (${blockTokens} est. tokens needed)`,
      });
    }
  }

  const markdownSection =
    renderedEntries.length > 0
      ? `${headerIntro}\n\n${renderedEntries.join("\n")}`
      : `${headerIntro}\n\n- *(No source files mapped within ${mapBudget} est. token map budget; discovered ${totalDiscoveredFiles} candidate files.)*`;

  const estimatedTokens = estimateTokens(markdownSection);

  return {
    enabled: true,
    scanMode,
    totalDiscoveredFiles,
    scannedFilesCount: analyzed.length,
    truncatedScan,
    mapBudget,
    estimatedTokens,
    selectedFiles,
    omittedFiles,
    blockedFiles,
    markdownSection,
    warnings,
  };
}
