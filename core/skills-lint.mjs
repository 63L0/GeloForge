/**
 * Static security and quality linter for Agent Skills (SKILL.md) packages.
 * Adapted from NousResearch hermes-agent skills_guard.py & skill_linter.py patterns
 * into zero-dependency Node.js checks.
 *
 * IMPORTANT: Static pattern matching cannot prove a skill is harmless or stop
 * semantic prompt injection. Treat all external/third-party skills as untrusted
 * until reviewed by a human.
 */

import { hasSecretContent, redactSecretContent } from "./path-safety.mjs";

export const STATIC_LINT_DISCLAIMER =
  "Static checks detect known risky patterns only. A passing lint result does NOT prove a skill is harmless or guarantee protection against semantic prompt injection.";

const HIDDEN_UNICODE_REGEX = /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2060\uFEFF]/;

const INJECTION_OVERRIDE_PATTERNS = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:previous|prior|above|system|developer|harness|safety)\s+(?:instructions?|rules?|policies?|prompts?|constraints?)\b/i,
  /\b(?:override|disable|bypass|ignore|skip)\s+(?:the\s+)?(?:a0|quarantine|approval(?:\s+gate|\s+boundaries)?|human\s+(?:approval|review|authorization)|security\s+policies?|guardrails?)\b/i,
  /\b(?:do\s+not|never)\s+(?:tell|inform|show|mention\s+to)\s+(?:the\s+)?user\b/i,
  /\bconceal\s+(?:this|these\s+actions?|output)\s+from\s+(?:the\s+)?user\b/i,
  /\bsystem\s+prompt\s+override\b/i,
  /<<<(?:END_)?GELOFORGE_DOC(?:>>>)?/,
];

const REMOTE_EXEC_PATTERNS = [
  /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|pwsh|powershell|python\d*|node)\b/i,
  /\b(?:irm|iwr|invoke-webrequest|invoke-restmethod)\b[^\n|]*\|\s*(?:iex|invoke-expression)\b/i,
  /\bbase64\s+(?:-d|--decode)\b[^\n|]*\|\s*(?:sh|bash|zsh|pwsh|powershell|python\d*|node)\b/i,
  /\bpowershell(?:\.exe)?\b[^\n]*(?:-enc|-encodedcommand)\s+[A-Za-z0-9+/=]{16,}/i,
];

const EXFILTRATION_PATTERNS = [
  /(?:~\/\.ssh|~\/\.aws|\$\{?HOME\}?\/\.ssh|\$\{?HOME\}?\/\.aws|\/etc\/passwd|\/etc\/shadow|id_rsa|credentials\.json|\.env(?:\.[a-z]+)?)\b[^\n]*(?:curl|wget|nc\b|ncat|\/dev\/tcp\/|invoke-webrequest)/i,
  /(?:curl|wget|nc\b|ncat|invoke-webrequest)[^\n]*(?:~\/\.ssh|~\/\.aws|\$\{?HOME\}?\/\.ssh|\$\{?HOME\}?\/\.aws|\/etc\/passwd|id_rsa|credentials\.json)/i,
];

const AUTO_EXEC_CLAIM_PATTERNS = [
  /\b(?:automatically\s+execute|silently\s+run|without\s+(?:asking|user\s+confirmation|human\s+(?:approval|review|authorization))|auto[- ]approve)\b/i,
];

const OBFUSCATED_EXEC_PATTERNS = [
  /\b(?:eval\s*\(\s*(?:atob|Buffer\.from)|new\s+Function\s*\(|powershell(?:\.exe)?[^\n]*-WindowStyle\s+Hidden)\b/i,
];

const TRIGGER_GUIDANCE_REGEX =
  /\b(?:when\s+to\s+use|use\s+(?:this\s+skill\s+)?when|trigger(?:s|ed)?\s+(?:when|for)|applicable\s+when)\b/i;

function makeFinding({ ruleId, severity, category, message, file, remediation }) {
  return {
    ruleId,
    severity,
    category,
    message: redactSecretContent(message),
    file,
    remediation,
  };
}

function scanTextForSecurity(findings, text, relFile) {
  if (!text) return;

  if (hasSecretContent(text)) {
    findings.push(
      makeFinding({
        ruleId: "SEC-SECRET-CONTENT",
        severity: "critical",
        category: "security",
        message: `Detected embedded credential or private-key literal in ${relFile}.`,
        file: relFile,
        remediation: "Remove credential literals and reference runtime environment variables securely.",
      })
    );
  }
  if (HIDDEN_UNICODE_REGEX.test(text)) {
    findings.push(
      makeFinding({
        ruleId: "SEC-HIDDEN-UNICODE",
        severity: "critical",
        category: "security",
        message: `Detected hidden Unicode directional override or zero-width control character in ${relFile}.`,
        file: relFile,
        remediation: "Remove bidi override (U+202A-U+202E, U+2066-U+2069) and zero-width characters.",
      })
    );
  }
  if (INJECTION_OVERRIDE_PATTERNS.some((pat) => pat.test(text))) {
    findings.push(
      makeFinding({
        ruleId: "SEC-INJECTION-OVERRIDE",
        severity: "critical",
        category: "security",
        message: `Detected instruction-override, A0 bypass, stealth, or delimiter-spoofing phrase in ${relFile}.`,
        file: relFile,
        remediation: "Remove instructions asking agents to ignore A0 policies, deceive users, or spoof packet fences.",
      })
    );
  }
  if (REMOTE_EXEC_PATTERNS.some((pat) => pat.test(text))) {
    findings.push(
      makeFinding({
        ruleId: "SEC-REMOTE-EXEC",
        severity: "critical",
        category: "security",
        message: `Detected remote download-and-execute pipeline or encoded shell payload in ${relFile}.`,
        file: relFile,
        remediation: "Replace piped remote installers or encoded commands with inspectable local instructions.",
      })
    );
  }
  if (EXFILTRATION_PATTERNS.some((pat) => pat.test(text))) {
    findings.push(
      makeFinding({
        ruleId: "SEC-EXFILTRATION",
        severity: "critical",
        category: "security",
        message: `Detected potential credential/system-file exfiltration command in ${relFile}.`,
        file: relFile,
        remediation: "Remove commands referencing SSH keys, .aws, .env, or system files alongside network tools.",
      })
    );
  }
  if (AUTO_EXEC_CLAIM_PATTERNS.some((pat) => pat.test(text))) {
    findings.push(
      makeFinding({
        ruleId: "SEC-AUTO-EXEC-CLAIM",
        severity: "high",
        category: "security",
        message: `Detected language claiming silent execution or bypassing confirmation in ${relFile}.`,
        file: relFile,
        remediation: "Require explicit developer confirmation and remember GeloForge never auto-executes scripts.",
      })
    );
  }
  if (OBFUSCATED_EXEC_PATTERNS.some((pat) => pat.test(text))) {
    findings.push(
      makeFinding({
        ruleId: "SEC-OBFUSCATED-EXEC",
        severity: "high",
        category: "security",
        message: `Detected dynamic/obfuscated execution pattern in ${relFile}.`,
        file: relFile,
        remediation: "Avoid encoded dynamic code execution snippets inside skills.",
      })
    );
  }
}

/**
 * Runs static security and quality lint checks on an inspected skill package.
 */
export function lintSkill(skill) {
  const findings = [];
  const defaultFile = `${skill.displayPath}/SKILL.md`;

  for (const err of skill.errors || []) {
    if (err.code === "SEC-SECRET-CONTENT" || err.code === "SEC-SYMLINK-OR-TRAVERSAL") {
      findings.push(
        makeFinding({
          ruleId: err.code,
          severity: "critical",
          category: "security",
          message: err.message,
          file: err.file || defaultFile,
          remediation: err.remediation,
        })
      );
    } else {
      findings.push(
        makeFinding({
          ruleId: err.code || "VAL-INVALID",
          severity: "error",
          category: "validation",
          message: err.message,
          file: err.file || defaultFile,
          remediation: err.remediation,
        })
      );
    }
  }

  for (const warn of skill.warnings || []) {
    findings.push(
      makeFinding({
        ruleId: warn.code || "QUAL-WARNING",
        severity: "warning",
        category: warn.category || "quality",
        message: warn.message,
        file: warn.file || defaultFile,
        remediation: warn.remediation,
      })
    );
  }

  // Scan SKILL.md metadata + body
  if (skill.rawSkillText) {
    // Strip legitimate leading BOM already handled in parse; inspect normalized content.
    const normalizedForScan = skill.rawSkillText.replace(/^\uFEFF/, "");
    scanTextForSecurity(findings, normalizedForScan, defaultFile);
  }

  // Scan supporting text resources statically (never executing any scripts)
  for (const resText of skill.inspectableTexts || []) {
    scanTextForSecurity(findings, resText.text, `${skill.displayPath}/${resText.relPath}`);
  }

  // Quality & anti-rot checks (only meaningful once body exists)
  if (typeof skill.body === "string" && skill.body.length > 0) {
    if (skill.lineCount > 500 || skill.charCount > 24000) {
      findings.push(
        makeFinding({
          ruleId: "QUAL-BODY-SIZE",
          severity: "warning",
          category: "quality",
          message: `SKILL.md is large (${skill.lineCount} lines, ${skill.charCount} chars; recommended <= 500 lines / 24,000 chars).`,
          file: defaultFile,
          remediation: "Move bulky checklists or schemas into references/ and link them selectively.",
        })
      );
    }

    const desc = typeof skill.frontmatter?.description === "string" ? skill.frontmatter.description.trim() : "";
    if (desc.length > 0 && desc.length < 20) {
      findings.push(
        makeFinding({
          ruleId: "QUAL-SHORT-DESCRIPTION",
          severity: "warning",
          category: "quality",
          message: `Skill description is very short (${desc.length} chars; recommended >= 20 chars).`,
          file: defaultFile,
          remediation: "Describe both what the skill does and specific tasks/triggers when it applies.",
        })
      );
    }

    const combinedGuidanceText = `${desc}\n${skill.body}`;
    if (!TRIGGER_GUIDANCE_REGEX.test(combinedGuidanceText) && (skill.triggers || []).length === 0) {
      findings.push(
        makeFinding({
          ruleId: "QUAL-NO-TRIGGER-GUIDANCE",
          severity: "warning",
          category: "quality",
          message: "SKILL.md lacks explicit 'When to Use' / trigger guidance.",
          file: defaultFile,
          remediation: "Add a short '## When to Use' section or metadata.geloforge_triggers hint.",
        })
      );
    }
  }

  const refsCount = (skill.resources?.references || []).length;
  if (refsCount > 10) {
    findings.push(
      makeFinding({
        ruleId: "QUAL-REFERENCE-SPRAWL",
        severity: "warning",
        category: "quality",
        message: `Skill contains ${refsCount} files in references/ (recommended <= 10 for discoverability).`,
        file: `${skill.displayPath}/references`,
        remediation: "Consolidate related reference notes so agents do not have to guess among many files.",
      })
    );
  }

  for (const extra of skill.scaffoldingFiles || []) {
    findings.push(
      makeFinding({
        ruleId: "QUAL-FORBIDDEN-SCAFFOLDING",
        severity: "warning",
        category: "quality",
        message: `Extraneous scaffolding file "${extra}" inside skill directory.`,
        file: `${skill.displayPath}/${extra}`,
        remediation: "Remove README.md/CHANGELOG.md clutter and keep documentation inside SKILL.md or references/.",
      })
    );
  }

  const scripts = skill.resources?.scripts || [];
  const posixOnlyScripts = scripts.filter((rel) => /\.(sh|bash)$/i.test(rel));
  if (posixOnlyScripts.length > 0) {
    const hasCrossPlatformMjs = scripts.some((rel) => /\.(mjs|js|ps1)$/i.test(rel));
    const mentionsCrossPlatform = /\b(windows|powershell|cross-platform|wsl|git bash)\b/i.test(skill.body || "");
    if (!hasCrossPlatformMjs && !mentionsCrossPlatform) {
      findings.push(
        makeFinding({
          ruleId: "QUAL-POSIX-ONLY-SCRIPT",
          severity: "warning",
          category: "portability",
          message: `Skill includes shell script(s) (${posixOnlyScripts.join(", ")}) without cross-platform/Windows notes or Node .mjs equivalent. Note: GeloForge never auto-executes skill scripts.`,
          file: `${skill.displayPath}/${posixOnlyScripts[0]}`,
          remediation: "Add a portable Node .mjs helper or document shell requirements clearly.",
        })
      );
    }
  }

  // Deduplicate identical ruleId+file+message pairs
  const deduped = [];
  const seen = new Set();
  for (const f of findings) {
    const key = `${f.ruleId}|${f.file}|${f.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(f);
    }
  }

  const counts = { critical: 0, high: 0, error: 0, warning: 0, info: 0 };
  for (const f of deduped) {
    counts[f.severity] = (counts[f.severity] || 0) + 1;
  }

  return {
    name: skill.name,
    displayPath: skill.displayPath,
    source: skill.source,
    trustTier: skill.trustTier,
    findings: deduped,
    counts,
    hasCriticalOrError: counts.critical > 0 || counts.error > 0,
    hasHighOrAbove: counts.critical > 0 || counts.error > 0 || counts.high > 0,
  };
}

/**
 * Aggregates lint reports across discovered skills and root-level safety diagnostics.
 */
export function lintDiscoveredSkills(discovery, { strict = false, includeDrafts = false } = {}) {
  const pool = [...discovery.allSkills];
  if (includeDrafts) {
    pool.push(...discovery.quarantinedSkills);
  }
  const results = pool.map((skill) => lintSkill(skill));
  const counts = {
    critical: discovery.rootErrors.length,
    high: 0,
    error: 0,
    warning: discovery.rootWarnings.length,
    info: 0,
  };

  for (const r of results) {
    counts.critical += r.counts.critical;
    counts.high += r.counts.high;
    counts.error += r.counts.error;
    counts.warning += r.counts.warning;
    counts.info += r.counts.info;
  }

  const passed = strict
    ? counts.critical === 0 && counts.error === 0 && counts.high === 0 && counts.warning === 0
    : counts.critical === 0 && counts.error === 0;

  return {
    passed,
    strict,
    disclaimer: STATIC_LINT_DISCLAIMER,
    counts,
    rootErrors: discovery.rootErrors,
    rootWarnings: discovery.rootWarnings,
    conflicts: discovery.conflicts,
    skills: results,
  };
}
