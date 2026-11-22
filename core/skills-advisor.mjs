/**
 * Deterministic Project/Goal Skills Advisor & Quarantined Draft Scaffolder.
 *
 * Analyzes local repository signals (package manifests, CI workflows, Second Brain
 * constraints/architecture, active task scope, and EVID-* records) against trusted
 * `.agents/skills/` and global skills to:
 *   1. Rank existing skills relevant to the current project or goal.
 *   2. Identify concrete, evidence/repo-grounded skill gaps.
 *   3. Optionally scaffold a strictly quarantined SKILL.md draft under
 *      `<proposals_dir>/skills/<name>/` (never auto-activating or bypassing approval).
 *
 * Security invariants:
 * - Zero third-party dependencies, zero network calls, zero shell execution.
 * - Rejects symlinked manifests/directories cleanly and never emits secret literals.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml, serializeYaml } from "./yaml-subset.mjs";
import { loadProjectManifestAndState } from "./project-locator.mjs";
import { getTask } from "./task-manager.mjs";
import { validateCreatedAt } from "./template-utils.mjs";
import { scoreBm25Documents, tokenizeKeywords, tokenizeTerms } from "./text-utils.mjs";
import {
  assertSafeWithinRoot,
  deriveSlug,
  hasSecretContent,
  redactSecretContent,
  validateScalarText,
  walkNonSymlinkFiles,
} from "./path-safety.mjs";
import { discoverSkills, scoreSkillForContext } from "./skills.mjs";
import { draftSkillFromExperience } from "./skills-lifecycle.mjs";
import {
  assertSafeAncestorChain,
  assertSafeDirNonSymlink,
  removeDirSafe,
  renameSyncRetry,
  validateAndLintSkillStaging,
  validateSkillSlugName,
} from "./skills-history.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_HARNESS_DIR = path.resolve(__dirname, "..");

const MAX_READ_BYTES = 64 * 1024;
const NODE_DEP_STACKS = [
  ["typescript", "typescript"],
  ["next", "nextjs"],
  ["react", "react"],
  ["vue", "vue"],
  ["nuxt", "nuxt"],
  ["express", "express"],
  ["fastify", "fastify"],
  ["prisma", "prisma"],
  ["@prisma/client", "prisma"],
  ["drizzle-orm", "drizzle"],
  ["drizzle-kit", "drizzle"],
  ["pg", "postgres"],
  ["postgres", "postgres"],
  ["playwright", "playwright"],
  ["@playwright/test", "playwright"],
  ["cypress", "cypress"],
  ["vitest", "vitest"],
  ["jest", "jest"],
  ["stripe", "stripe"],
  ["tailwindcss", "tailwind"],
];
const SCRIPT_PRIORITY = ["test", "lint", "typecheck", "build", "eval", "check", "verify"];

function readSmallNonSymlinkText(projectDir, relPath, maxBytes = MAX_READ_BYTES) {
  if (typeof relPath !== "string" || relPath.trim().length === 0) {
    return null;
  }
  let resolved;
  try {
    resolved = assertSafeWithinRoot(projectDir, relPath);
  } catch {
    return null;
  }
  try {
    const st = fs.lstatSync(resolved);
    if (st.isSymbolicLink() || !st.isFile() || st.size > maxBytes) {
      return null;
    }
    return fs.readFileSync(resolved, "utf8");
  } catch {
    return null;
  }
}

function hasSafeSubdir(projectDir, relPath) {
  try {
    const resolved = assertSafeWithinRoot(projectDir, relPath);
    const st = fs.lstatSync(resolved);
    return !st.isSymbolicLink() && st.isDirectory();
  } catch {
    return false;
  }
}

function extractMarkdownHeadings(text, maxHeadings = 12, maxLevel = 3) {
  if (typeof text !== "string" || text.length === 0) {
    return [];
  }
  const lines = text.split(/\r?\n/);
  let idx = 0;
  if (lines[0] && lines[0].trim() === "---") {
    const closingIdx = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    if (closingIdx !== -1) {
      idx = closingIdx + 1;
    }
  }
  const headings = [];
  let inFence = false;
  const headingRe = new RegExp(`^#{1,${maxLevel}}\\s+(.+?)\\s*#*\\s*$`);
  for (; idx < lines.length && headings.length < maxHeadings; idx += 1) {
    const trimmed = lines[idx].trim();
    if (/^(?:`{3,}|~{3,})/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = headingRe.exec(trimmed);
    if (match && match[1]) {
      const cleaned = redactSecretContent(match[1].trim());
      if (cleaned && !hasSecretContent(cleaned)) {
        headings.push(cleaned);
      }
    }
  }
  return headings;
}

function extractConstraintBullets(constraintsText, maxBullets = 8) {
  if (typeof constraintsText !== "string" || constraintsText.length === 0) {
    return [];
  }
  const lines = constraintsText.split(/\r?\n/);
  const bullets = [];
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(?:`{3,}|~{3,})/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^[-*]\s+(.+)$/.exec(trimmed);
    if (!match) continue;
    const body = match[1].trim();
    if (body.length < 12 || /\{\{[^}]+\}\}/.test(body)) continue;
    if (hasSecretContent(body)) continue;
    const cleaned = redactSecretContent(body);
    if (!cleaned.startsWith("-")) {
      bullets.push(cleaned);
    }
    if (bullets.length >= maxBullets) break;
  }
  return bullets;
}

function detectStacksAndCommands(projectDir, manifest, overviewText, constraintsText) {
  const stacks = [];
  const stackSet = new Set();
  const commands = [];
  const commandSet = new Set();

  const addStack = (name) => {
    const clean = String(name || "").trim().toLowerCase();
    if (clean && !stackSet.has(clean)) {
      stackSet.add(clean);
      stacks.push(clean);
    }
  };
  const addCommand = (cmd, source) => {
    const clean = typeof cmd === "string" ? cmd.trim() : "";
    if (!clean || hasSecretContent(clean) || commandSet.has(clean)) return;
    commandSet.add(clean);
    commands.push({ command: redactSecretContent(clean), source });
  };

  if (typeof manifest?.profile === "string" && manifest.profile.trim()) {
    addStack(manifest.profile.trim());
  }

  const pkgRaw = readSmallNonSymlinkText(projectDir, "package.json");
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw);
      addStack("node");
      const allDeps = {
        ...(pkg && typeof pkg.dependencies === "object" ? pkg.dependencies : {}),
        ...(pkg && typeof pkg.devDependencies === "object" ? pkg.devDependencies : {}),
      };
      for (const [dep, stackName] of NODE_DEP_STACKS) {
        if (Object.hasOwn(allDeps, dep)) {
          addStack(stackName);
        }
      }
      const scripts = pkg && typeof pkg.scripts === "object" ? pkg.scripts : {};
      for (const key of SCRIPT_PRIORITY) {
        const val = scripts[key];
        if (typeof val !== "string" || val.trim().length === 0) continue;
        if (/no test specified/i.test(val) || hasSecretContent(val)) continue;
        addCommand(key === "test" ? "npm test" : `npm run ${key}`, "package.json");
      }
    } catch {
      // Ignore malformed package.json safely
    }
  }

  const pyprojectText = readSmallNonSymlinkText(projectDir, "pyproject.toml");
  const reqText = readSmallNonSymlinkText(projectDir, "requirements.txt");
  if (pyprojectText || reqText) {
    addStack("python");
    if (/\bpytest\b/i.test(`${pyprojectText || ""}\n${reqText || ""}`)) {
      addCommand("pytest", pyprojectText ? "pyproject.toml" : "requirements.txt");
    }
  }

  if (readSmallNonSymlinkText(projectDir, "go.mod")) {
    addStack("go");
    addCommand("go test ./...", "go.mod");
  }

  if (readSmallNonSymlinkText(projectDir, "Cargo.toml")) {
    addStack("rust");
    addCommand("cargo test", "Cargo.toml");
  }

  if (
    readSmallNonSymlinkText(projectDir, "Dockerfile") ||
    readSmallNonSymlinkText(projectDir, "docker-compose.yml") ||
    readSmallNonSymlinkText(projectDir, "compose.yaml")
  ) {
    addStack("docker");
  }

  if (hasSafeSubdir(projectDir, ".github/workflows")) {
    const wfRoot = assertSafeWithinRoot(projectDir, ".github/workflows");
    const wfFiles = walkNonSymlinkFiles(projectDir, wfRoot, (p) => /\.ya?ml$/i.test(p));
    if (wfFiles.length > 0) {
      addStack("github-actions");
      addStack("ci");
    }
  }

  const n8nSignalText = [manifest?.description || "", overviewText || "", constraintsText || ""].join("\n");
  if (/\bn8n\b/i.test(n8nSignalText) || hasSafeSubdir(projectDir, "adapters/n8n") || hasSafeSubdir(projectDir, "workflows")) {
    addStack("n8n");
  }

  return { stacks, commands };
}

function scanEvidenceRecords(projectDir, evidenceDirRel) {
  const verifiedEvidence = [];
  const failedChecks = [];
  const absDir = assertSafeWithinRoot(projectDir, evidenceDirRel);
  if (!assertSafeDirNonSymlink(absDir, evidenceDirRel)) {
    return { verifiedEvidence, failedChecks };
  }
  const files = walkNonSymlinkFiles(projectDir, absDir, (p) => /^EVID-\d{4}.*\.ya?ml$/i.test(path.basename(p)));
  for (const filePath of files) {
    const relPath = path.relative(projectDir, filePath).replace(/\\/g, "/");
    const raw = readSmallNonSymlinkText(projectDir, relPath);
    if (!raw) continue;
    let parsed;
    try {
      parsed = parseYaml(raw, relPath);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || parsed.is_example === true) continue;
    const checks = Array.isArray(parsed.checks) ? parsed.checks : [];
    const safeChecks = [];
    for (const chk of checks) {
      if (!chk || typeof chk !== "object") continue;
      const cmd = typeof chk.command === "string" ? chk.command.trim() : "";
      if (cmd && hasSecretContent(cmd)) continue;
      const item = {
        command: cmd ? redactSecretContent(cmd) : "",
        exit_code: chk.exit_code,
        result: chk.result || null,
      };
      safeChecks.push(item);
      if (
        item.result === "failed" ||
        item.result === "blocked" ||
        (item.exit_code !== undefined && item.exit_code !== null && Number.isFinite(Number(item.exit_code)) && Number(item.exit_code) !== 0)
      ) {
        failedChecks.push({
          id: parsed.id || relPath,
          title: parsed.title || parsed.id || relPath,
          command: item.command,
          exit_code: item.exit_code,
          result: item.result,
        });
      }
    }
    const hasPassedCheck = safeChecks.some((c) => c.result === "passed");
    const hasBadCheck = safeChecks.some((c) => c.result === "failed" || c.result === "blocked");
    if (parsed.status === "verified" && parsed.id && hasPassedCheck && !hasBadCheck) {
      verifiedEvidence.push({
        id: String(parsed.id),
        relPath,
        title: typeof parsed.title === "string" ? redactSecretContent(parsed.title) : String(parsed.id),
        tags: Array.isArray(parsed.tags) ? parsed.tags.map((t) => String(t)) : [],
        relatedTasks: Array.isArray(parsed.related_tasks) ? parsed.related_tasks.map((t) => String(t)) : [],
        taskId: typeof parsed.task_id === "string" ? parsed.task_id : null,
        checks: safeChecks,
      });
    }
  }
  return { verifiedEvidence, failedChecks };
}

/**
 * Extracts deterministic repository, goal, task, and verified evidence signals for skill discovery/advisory.
 */
export function analyzeProjectSignals({
  projectDir: rawProjectDir,
  harnessDir: rawHarnessDir = DEFAULT_HARNESS_DIR,
  taskId = null,
  goal = null,
  query = null,
} = {}) {
  const harnessDir = path.resolve(rawHarnessDir || DEFAULT_HARNESS_DIR);
  const loaded = loadProjectManifestAndState(rawProjectDir, harnessDir);
  const { projectDir, manifest, state, projectPaths } = loaded;

  const goalText = typeof goal === "string" && goal.trim() ? goal.trim() : typeof query === "string" && query.trim() ? query.trim() : null;
  const constraintsText = readSmallNonSymlinkText(projectDir, projectPaths.constraints_doc) || "";
  const overviewText = readSmallNonSymlinkText(projectDir, projectPaths.architecture) || "";

  const { stacks, commands } = detectStacksAndCommands(projectDir, manifest, overviewText, constraintsText);
  const constraintHeadings = extractMarkdownHeadings(constraintsText, 8, 3);
  const constraintBullets = extractConstraintBullets(constraintsText, 8);
  const overviewHeadings = extractMarkdownHeadings(overviewText, 12, 3);

  let targetTask = null;
  if (typeof taskId === "string" && taskId.trim().length > 0) {
    targetTask = getTask({ projectDir, taskId: taskId.trim(), harnessDir });
  } else if (!goalText && Array.isArray(state.active_tasks) && state.active_tasks.length > 0) {
    try {
      targetTask = getTask({ projectDir, taskId: state.active_tasks[0], harnessDir });
    } catch {
      targetTask = null;
    }
  }

  const { verifiedEvidence, failedChecks } = scanEvidenceRecords(projectDir, projectPaths.evidence_dir);

  const goalParts = [];
  if (goalText) goalParts.push(goalText);
  if (targetTask?.record) {
    const r = targetTask.record;
    goalParts.push(r.id || "", r.title || "", r.objective || "");
    if (Array.isArray(r.scope_in)) goalParts.push(...r.scope_in);
    if (Array.isArray(r.acceptance_criteria)) goalParts.push(...r.acceptance_criteria);
  }
  const goalKeywords = tokenizeKeywords(goalParts.join(" "));

  const projectParts = [
    ...stacks,
    ...commands.map((c) => c.command),
    ...constraintHeadings,
    ...constraintBullets,
    ...overviewHeadings,
    ...verifiedEvidence.slice(0, 12).flatMap((ev) => [ev.title, ...ev.tags, ...ev.checks.map((c) => c.command)]),
  ];
  const projectKeywords = tokenizeKeywords(projectParts.join(" "));

  return {
    projectDir,
    harnessDir,
    manifest,
    state,
    projectPaths,
    goal: goalText,
    taskId: targetTask?.id || null,
    targetTask,
    stacks,
    commands,
    constraintHeadings,
    constraintBullets,
    overviewHeadings,
    verifiedEvidence,
    failedChecks,
    goalKeywords,
    projectKeywords,
  };
}

function scoreAndRankSkills(discovery, signals, limit) {
  const validSkills = (discovery.activeSkills || []).filter((s) => s.valid && !s.blocked);
  if (validSkills.length === 0) {
    return [];
  }

  const combinedMetaDocs = validSkills.map((skill) => ({
    id: skill.name,
    terms: tokenizeTerms(
      [
        skill.name.replace(/-/g, " "),
        ...(skill.tags || []),
        ...(skill.triggers || []),
        skill.frontmatter?.description || "",
      ].join(" ")
    ),
  }));
  const bodyDocs = validSkills.map((skill) => ({
    id: skill.name,
    terms: tokenizeTerms(skill.body || ""),
  }));

  const goalMetaBm25 = scoreBm25Documents(signals.goalKeywords, combinedMetaDocs);
  const goalBodyBm25 = scoreBm25Documents(signals.goalKeywords, bodyDocs);
  const projMetaBm25 = scoreBm25Documents(signals.projectKeywords, combinedMetaDocs);
  const projBodyBm25 = scoreBm25Documents(signals.projectKeywords, bodyDocs);

  const ranked = [];
  for (const skill of validSkills) {
    const skillMetaTokens = tokenizeKeywords(
      [
        skill.name.replace(/-/g, " "),
        ...(skill.tags || []),
        ...(skill.triggers || []),
        skill.frontmatter?.description || "",
      ].join(" ")
    );
    const skillAllTokens = new Set([...skillMetaTokens, ...tokenizeKeywords(skill.body || "")]);

    const matchedGoalKeywords = [...signals.goalKeywords].filter((k) => skillAllTokens.has(k));
    const matchedProjectKeywords = [...signals.projectKeywords].filter((k) => skillAllTokens.has(k));
    const minProjectOverlap = signals.goalKeywords.size > 0 ? 2 : 1;
    if (matchedGoalKeywords.length === 0 && matchedProjectKeywords.length < minProjectOverlap) {
      continue;
    }

    const baseCtx = scoreSkillForContext(skill, {
      queryKeywords: signals.goalKeywords.size > 0 ? signals.goalKeywords : signals.projectKeywords,
      pinnedSet: new Set(),
    });
    const bm25Score =
      (goalMetaBm25.get(skill.name) ?? 0) * 18 +
      (goalBodyBm25.get(skill.name) ?? 0) * 8 +
      (projMetaBm25.get(skill.name) ?? 0) * 6 +
      (projBodyBm25.get(skill.name) ?? 0) * 2;
    const score = Math.round((baseCtx.score * 0.25 + bm25Score) * 1e6) / 1e6;

    const reasons = [];
    if (matchedGoalKeywords.length > 0) {
      reasons.push(`matched goal keywords: ${matchedGoalKeywords.slice(0, 6).join(", ")}`);
    }
    if (matchedProjectKeywords.length > 0) {
      reasons.push(`matched project signals: ${matchedProjectKeywords.slice(0, 6).join(", ")}`);
    }

    ranked.push({
      name: skill.name,
      source: skill.source,
      trustTier: skill.trustTier,
      displayPath: skill.displayPath,
      description: skill.frontmatter?.description || "",
      score,
      matchedGoalKeywords,
      matchedProjectKeywords,
      reasons,
      command: `geloforge context --skills --skill ${skill.name}`,
    });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });
  return ranked.slice(0, limit);
}

function isTopicCoveredBySkills(topicKeywords, validSkills) {
  if (!topicKeywords || topicKeywords.size === 0) return false;
  const requiredHits = topicKeywords.size <= 2 ? 1 : 2;
  for (const skill of validSkills) {
    const metaTokens = tokenizeKeywords(
      [
        skill.name.replace(/-/g, " "),
        ...(skill.tags || []),
        ...(skill.triggers || []),
        skill.frontmatter?.description || "",
      ].join(" ")
    );
    let hits = 0;
    for (const kw of topicKeywords) {
      if (metaTokens.has(kw)) hits += 1;
    }
    if (hits >= requiredHits) {
      return true;
    }
  }
  return false;
}

function slugifySkillName(rawText, fallback = "project-workflow") {
  const cleaned = String(rawText || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  const base = cleaned.length >= 2 ? cleaned : deriveSlug(fallback);
  return validateSkillSlugName(base.length >= 2 ? base : fallback, fallback);
}

function uniqueCommandsFromEvidence(evList) {
  const out = [];
  const seen = new Set();
  for (const ev of evList) {
    for (const chk of ev.checks || []) {
      if (chk.command && !seen.has(chk.command)) {
        seen.add(chk.command);
        out.push(chk.command);
      }
    }
  }
  return out;
}

function detectSkillGaps(signals, discovery) {
  const validActive = (discovery.activeSkills || []).filter((s) => s.valid && !s.blocked);
  const activeNames = new Set((discovery.activeSkills || []).map((s) => s.name));
  const quarantinedNames = new Set((discovery.quarantinedSkills || []).map((s) => s.name));
  const gaps = [];
  const seenKinds = new Set();

  const evScored = signals.verifiedEvidence.map((ev) => {
    const evTokens = tokenizeKeywords([ev.title, ...ev.tags, ...ev.checks.map((c) => c.command)].join(" "));
    let goalHits = 0;
    for (const kw of signals.goalKeywords) {
      if (evTokens.has(kw)) goalHits += 1;
    }
    const taskLinked = Boolean(
      signals.taskId && (ev.taskId === signals.taskId || ev.relatedTasks.includes(signals.taskId))
    );
    return { ev, evTokens, goalHits, taskLinked };
  });

  const goalMatchedEv = evScored
    .filter((item) => item.taskLinked || item.goalHits > 0)
    .sort((a, b) => Number(b.taskLinked) - Number(a.taskLinked) || b.goalHits - a.goalHits || b.ev.id.localeCompare(a.ev.id));

  // Gap 1: Goal or active task with verified matching evidence
  if (goalMatchedEv.length > 0) {
    const chosen = goalMatchedEv.slice(0, 3).map((x) => x.ev);
    const topicKeywords = new Set(goalMatchedEv.slice(0, 3).flatMap((x) => [...x.evTokens]));
    for (const kw of signals.goalKeywords) topicKeywords.add(kw);

    if (!isTopicCoveredBySkills(topicKeywords, validActive)) {
      const titleSource = signals.goal || signals.targetTask?.record?.title || chosen[0].title;
      const suggestedName = slugifySkillName(titleSource, "verified-workflow");
      const commands = uniqueCommandsFromEvidence(chosen);
      gaps.push({
        kind: "evidence_backed_workflow",
        suggestedName,
        title: titleSource,
        reason: `Verified evidence (${chosen.map((e) => e.id).join(", ")}) backs this workflow, and no active skill covers it.`,
        evidenceIds: chosen.map((e) => e.id),
        commands,
        constraints: signals.constraintBullets.slice(0, 3),
        promotableAfterReview: true,
        existingQuarantinedDraft: quarantinedNames.has(suggestedName),
        scaffoldable: !activeNames.has(suggestedName) && !quarantinedNames.has(suggestedName),
        recommendedCommand: `geloforge skills draft --from-evidence ${chosen.map((e) => e.id).join(" --from-evidence ")} --name ${suggestedName}`,
      });
      seenKinds.add("evidence_backed_workflow");
    }
  } else if (signals.goalKeywords.size > 0 && !isTopicCoveredBySkills(signals.goalKeywords, validActive)) {
    // Gap 2: Explicit goal or active task without verified evidence yet
    const goalLabel = signals.goal || signals.targetTask?.record?.title || "project-goal";
    const suggestedName = slugifySkillName(goalLabel, "goal-workflow");
    gaps.push({
      kind: "goal_workflow",
      suggestedName,
      title: goalLabel,
      reason: `No active skill covers the current goal/task ("${goalLabel}"). Stage a quarantined repo-grounded draft and capture verification evidence before promotion.`,
      evidenceIds: [],
      commands: signals.commands.map((c) => c.command),
      constraints: signals.constraintBullets.slice(0, 4),
      promotableAfterReview: false,
      existingQuarantinedDraft: quarantinedNames.has(suggestedName),
      scaffoldable: !activeNames.has(suggestedName) && !quarantinedNames.has(suggestedName),
      recommendedCommand: signals.goal
        ? `geloforge skills suggest --goal ${JSON.stringify(signals.goal)} --scaffold-draft`
        : `geloforge skills suggest --scaffold-draft`,
    });
    seenKinds.add("goal_workflow");
  }

  // Secondary Gap: Uncovered verified evidence elsewhere in the project
  if (gaps.length < 3 && !seenKinds.has("evidence_backed_workflow") && signals.verifiedEvidence.length > 0) {
    const withCommands = signals.verifiedEvidence.filter((e) => e.checks.some((c) => c.command));
    const pool = withCommands.length > 0 ? withCommands : signals.verifiedEvidence;
    const chosen = pool.slice(0, 3);
    const evTopic = tokenizeKeywords(chosen.flatMap((e) => [e.title, ...e.tags]).join(" "));
    if (!isTopicCoveredBySkills(evTopic, validActive)) {
      const suggestedName = slugifySkillName(chosen[0].title, "verified-project-checks");
      gaps.push({
        kind: "evidence_backed_workflow",
        suggestedName,
        title: chosen[0].title,
        reason: `Verified evidence (${chosen.map((e) => e.id).join(", ")}) records reusable checks not yet captured in an active skill.`,
        evidenceIds: chosen.map((e) => e.id),
        commands: uniqueCommandsFromEvidence(chosen),
        constraints: signals.constraintBullets.slice(0, 3),
        promotableAfterReview: true,
        existingQuarantinedDraft: quarantinedNames.has(suggestedName),
        scaffoldable: !activeNames.has(suggestedName) && !quarantinedNames.has(suggestedName),
        recommendedCommand: `geloforge skills draft --from-evidence ${chosen.map((e) => e.id).join(" --from-evidence ")} --name ${suggestedName}`,
      });
      seenKinds.add("evidence_backed_workflow");
    }
  }

  // Gap 3: Day-1 baseline workflow when no active skills exist and repo has concrete commands or constraints
  if (
    validActive.length === 0 &&
    gaps.length === 0 &&
    (signals.commands.length > 0 || signals.constraintBullets.length > 0)
  ) {
    const projectName = signals.manifest?.name || path.basename(signals.projectDir);
    const suggestedName = slugifySkillName(`${projectName}-verification`, "project-verification");
    gaps.push({
      kind: "repo_baseline_workflow",
      suggestedName,
      title: `${projectName} Verification Workflow`,
      reason:
        "No active skills are configured, and concrete verification commands or constraints were detected in this repository.",
      evidenceIds: [],
      commands: signals.commands.map((c) => c.command),
      constraints: signals.constraintBullets.slice(0, 5),
      promotableAfterReview: false,
      existingQuarantinedDraft: quarantinedNames.has(suggestedName),
      scaffoldable: !activeNames.has(suggestedName) && !quarantinedNames.has(suggestedName),
      recommendedCommand: "geloforge skills suggest --scaffold-draft",
    });
  }

  return gaps.slice(0, 3);
}

function buildRepoScaffoldMarkdown({ skillName, title, description, gap, signals, tags, triggers }) {
  const mergedTags = Array.from(new Set(["repo-scaffold", ...signals.stacks.slice(0, 4), ...tags])).join(", ");
  const mergedTriggers = Array.from(
    new Set(triggers.length > 0 ? triggers : [skillName.replace(/-/g, " "), ...signals.stacks.slice(0, 3)])
  ).join(", ");

  const frontmatterObj = {
    name: skillName,
    description,
    license: "MIT",
    metadata: {
      geloforge_origin: "repo_scaffold",
      geloforge_promotion_status: "requires_verified_evidence",
      geloforge_tags: mergedTags,
      geloforge_triggers: mergedTriggers,
    },
  };

  const groundingLines = [
    `- **Detected Stack:** ${signals.stacks.join(", ") || "none detected"}`,
    ...(gap.commands.length > 0
      ? [`- **Detected Repository Commands:** ${gap.commands.map((c) => `\`${c}\``).join(", ")}`]
      : ["- **Detected Repository Commands:** (none detected in package/build manifests)"]),
    ...(signals.constraintBullets.length > 0
      ? signals.constraintBullets.slice(0, 4).map((b) => `- **Project Constraint:** ${b}`)
      : ["- **Project Constraint:** Follow A0 approval boundaries and record evidence before closure."]),
    ...(signals.failedChecks.length > 0
      ? [
          `- **Recent Failed Checks Seen in History:** ${signals.failedChecks
            .slice(0, 2)
            .map((f) => `${f.id} (\`${f.command || "check"}\` exit=${f.exit_code})`)
            .join(", ")}`,
        ]
      : []),
  ];

  const procSteps = [];
  if (signals.goal) {
    procSteps.push(`Review goal scope and repository constraints for: ${redactSecretContent(signals.goal)}.`);
  } else {
    procSteps.push("Review repository constraints and active task scope before modifying code.");
  }
  if (gap.commands.length > 0) {
    for (const cmd of gap.commands.slice(0, 4)) {
      procSteps.push(`Run verification command \`${cmd}\` via \`geloforge evidence capture\` and inspect output.`);
    }
  } else {
    procSteps.push("Capture command-backed verification via `geloforge evidence capture --task <TASK-NNNN> -- <command>`.");
  }
  procSteps.push(
    `After capturing verified EVID-NNNN, regenerate an evidence-backed draft with \`geloforge skills draft --from-evidence <EVID-NNNN> --name ${skillName}\` before requesting human promotion.`
  );

  const mdLines = [
    "---",
    serializeYaml(frontmatterObj).trimEnd(),
    "---",
    "",
    `# ${title}`,
    "",
    "> **Quarantined Scaffold Draft:** Generated solely from local repository signals and goal context without verified EVID-* provenance. Human review and verified evidence are required before any promotion.",
    "",
    "## When to Use",
    "",
    `Use this skill when working on ${title.toLowerCase()} where the grounded project commands and constraints below apply.`,
    "",
    "## Detected Project Grounding (Factual Repo Signals)",
    "",
    ...groundingLines,
    "",
    "## Suggested Procedure (Unverified Draft — Review & Capture Evidence)",
    "",
    ...procSteps.map((step, idx) => `${idx + 1}. ${step}`),
    "",
  ];

  return redactSecretContent(mdLines.join("\n"));
}

function scaffoldFromGap({ targetGap, signals, options }) {
  const createdAt = validateCreatedAt(options.createdAt);
  const skillName = validateSkillSlugName(options.skillName || targetGap.suggestedName, targetGap.suggestedName);

  const activeDir = assertSafeWithinRoot(signals.projectDir, `.agents/skills/${skillName}`);
  if (fs.existsSync(activeDir)) {
    throw new Error(
      `Active skill "${skillName}" already exists at .agents/skills/${skillName}. Choose a different --name or use "geloforge skills propose-update ${skillName}".`
    );
  }

  const proposalsSkillsRel = `${signals.projectPaths.proposals_dir}/skills`;
  const proposalRel = `${proposalsSkillsRel}/${skillName}`;
  const proposalDir = assertSafeWithinRoot(signals.projectDir, proposalRel);
  if (fs.existsSync(proposalDir)) {
    throw new Error(`Quarantined draft "${skillName}" already exists at ${proposalRel}. Review or remove it before scaffolding again.`);
  }

  const extraTags = Array.isArray(options.tags) ? options.tags : signals.stacks.slice(0, 4);
  const extraTriggers = Array.isArray(options.triggers) ? options.triggers : [];
  const rawTitle = validateScalarText(
    "title",
    String(options.title || targetGap.title || skillName).replace(/\s+/g, " ").trim()
  );
  const title = redactSecretContent(rawTitle);

  if (targetGap.evidenceIds.length > 0) {
    const steps = [];
    for (const cmd of targetGap.commands.slice(0, 4)) {
      steps.push(`Run verified project check \`${cmd}\` with \`geloforge evidence capture\`.`);
    }
    for (const cBullet of targetGap.constraints.slice(0, 2)) {
      steps.push(`Enforce project constraint: ${cBullet}`);
    }
    const res = draftSkillFromExperience({
      projectDir: signals.projectDir,
      harnessDir: signals.harnessDir,
      evidenceIds: targetGap.evidenceIds,
      skillName,
      title,
      steps: steps.length > 0 ? steps : undefined,
      tags: extraTags,
      triggers: extraTriggers,
      createdAt,
      dryRun: Boolean(options.dryRun),
    });
    return {
      mode: "evidence_draft",
      quarantined: true,
      promotable: true,
      gapKind: targetGap.kind,
      ...res,
    };
  }

  // Day-1 repo/goal scaffold (quarantined ONLY; intentionally lacks .proposals/<name>.yaml so promotion stays fail-closed)
  const rawDesc =
    options.description ||
    `Apply verified project checks and constraints for ${title} grounded in local repository signals (${signals.stacks.join(", ") || "project rules"}).`;
  let description = redactSecretContent(validateScalarText("description", rawDesc));
  if (description.length < 20) {
    description = `${description} — quarantined repository workflow draft.`;
  }
  if (description.length > 1024) {
    description = `${description.slice(0, 1021)}...`;
  }
  if (hasSecretContent(title) || hasSecretContent(description)) {
    throw new Error("Refusing scaffold metadata containing credential-like content.");
  }

  const markdown = buildRepoScaffoldMarkdown({
    skillName,
    title,
    description,
    gap: targetGap,
    signals,
    tags: extraTags,
    triggers: extraTriggers,
  });
  if (hasSecretContent(markdown)) {
    throw new Error("Refusing scaffold draft because generated SKILL.md triggered secret-content detection.");
  }

  const skillsProposalsRoot = assertSafeWithinRoot(signals.projectDir, proposalsSkillsRel);
  assertSafeAncestorChain(skillsProposalsRoot, signals.projectDir, proposalsSkillsRel);
  if (fs.existsSync(skillsProposalsRoot)) {
    assertSafeDirNonSymlink(skillsProposalsRoot, proposalsSkillsRel);
  } else if (!options.dryRun) {
    fs.mkdirSync(skillsProposalsRoot, { recursive: true });
  }

  const stageParent = options.dryRun ? os.tmpdir() : skillsProposalsRoot;
  const stageDir = path.join(stageParent, `.geloforge-stage-${crypto.randomBytes(6).toString("hex")}`);
  try {
    fs.mkdirSync(stageDir, { recursive: true });
    fs.writeFileSync(path.join(stageDir, "SKILL.md"), markdown, { encoding: "utf8", flag: "wx" });
    const verified = validateAndLintSkillStaging({
      stageDir,
      skillName,
      displayRoot: proposalsSkillsRel,
    });

    const nextSteps = [
      `Inspect draft safely: geloforge skills show ${skillName} --include-drafts`,
      `Capture real verification evidence: geloforge evidence capture --task <TASK-NNNN> -- ${targetGap.commands[0] || "<command>"}`,
      `Replace unverified scaffold with an evidence-backed proposal via: geloforge skills draft --from-evidence <EVID-NNNN> --name ${skillName}`,
    ];

    if (options.dryRun) {
      return {
        mode: "repo_scaffold_quarantined",
        dryRun: true,
        quarantined: true,
        promotable: false,
        gapKind: targetGap.kind,
        skillName,
        proposalDir: proposalRel,
        candidateDigest: verified.digestInfo.digest,
        lintPassed: true,
        markdown,
        nextSteps,
      };
    }

    assertSafeAncestorChain(proposalDir, signals.projectDir, proposalRel);
    renameSyncRetry(stageDir, proposalDir);

    return {
      mode: "repo_scaffold_quarantined",
      dryRun: false,
      quarantined: true,
      promotable: false,
      gapKind: targetGap.kind,
      skillName,
      proposalDir: proposalRel,
      candidateDigest: verified.digestInfo.digest,
      lintPassed: true,
      nextSteps,
    };
  } finally {
    removeDirSafe(stageDir);
  }
}

/**
 * Recommends relevant active skills and detects concrete evidence/repo-grounded gaps.
 * Optionally stages a strictly quarantined draft skill when `scaffoldDraft: true`.
 */
export function suggestProjectSkills(options = {}) {
  const limitRaw = options.limit !== undefined && options.limit !== null ? Number(options.limit) : 5;
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 20) {
    throw new Error("--limit must be an integer between 1 and 20.");
  }
  const scaffoldDraft = Boolean(options.scaffoldDraft);
  if (options.dryRun && !scaffoldDraft) {
    throw new Error("--dry-run is only valid together with --scaffold-draft.");
  }

  const signals = analyzeProjectSignals({
    projectDir: options.projectDir,
    harnessDir: options.harnessDir,
    taskId: options.taskId,
    goal: options.goal,
    query: options.query,
  });

  const discovery = discoverSkills({
    projectDir: signals.projectDir,
    globalSkillsDir: options.globalSkillsDir,
    proposalsDir: signals.projectPaths.proposals_dir,
    includeDrafts: Boolean(options.includeDrafts),
  });

  const recommendedSkills = scoreAndRankSkills(discovery, signals, limitRaw);
  const skillGaps = detectSkillGaps(signals, discovery);

  let scaffoldResult = null;
  if (scaffoldDraft) {
    const requestedName = options.skillName ? validateSkillSlugName(options.skillName) : null;
    const candidateGap =
      (requestedName ? skillGaps[0] : skillGaps.find((g) => g.scaffoldable)) || null;
    if (!candidateGap) {
      throw new Error(
        "No grounded, un-scaffolded skill gap was detected for this project/goal. Capture verified EVID-NNNN or specify an explicit --goal and unused --name."
      );
    }
    scaffoldResult = scaffoldFromGap({ targetGap: candidateGap, signals, options });
  }

  return {
    projectDir: signals.projectDir,
    projectId: signals.manifest?.project_id || null,
    goal: signals.goal,
    taskId: signals.taskId,
    detectedSignals: {
      stacks: signals.stacks,
      commands: signals.commands,
      constraintCount: signals.constraintBullets.length,
      overviewHeadings: signals.overviewHeadings.slice(0, 6),
      verifiedEvidenceIds: signals.verifiedEvidence.map((e) => e.id),
      failedCheckCount: signals.failedChecks.length,
    },
    activeSkillCount: (discovery.activeSkills || []).length,
    quarantinedDraftCount: (discovery.quarantinedSkills || []).length,
    recommendedSkills,
    skillGaps,
    scaffoldResult,
  };
}
