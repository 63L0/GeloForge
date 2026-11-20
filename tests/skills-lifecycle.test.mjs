import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bootstrapProject } from "../scripts/bootstrap-project.mjs";
import { createTask } from "../core/task-manager.mjs";
import { captureEvidence } from "../core/evidence-capture.mjs";
import { createHandoff } from "../core/handoff.mjs";
import { compileContext } from "../core/context-compiler.mjs";
import { validateProject } from "../core/project-validator.mjs";
import { computeSkillPackageDigest } from "../core/skills.mjs";
import {
  draftSkillFromExperience,
  generateApproverKeypair,
  getSkillHistory,
  promoteSkillProposal,
  proposeSkillUpdate,
  rollbackSkill,
  signSkillApproval,
} from "../core/skills-lifecycle.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_DIR = path.resolve(__dirname, "..");
const CLI_PATH = path.join(HARNESS_DIR, "scripts", "geloforge.mjs");
const DIR_SYMLINK_TYPE = process.platform === "win32" ? "junction" : "dir";

function runCli(args, { cwd = HARNESS_DIR, env = {} } = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    windowsHide: true,
  });
}

function initGitCommit(projectDir, msg = "Initial baseline") {
  const opts = { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] };
  execFileSync("git", ["-C", projectDir, "config", "user.name", "Test Bot"], opts);
  execFileSync("git", ["-C", projectDir, "config", "user.email", "test@example.invalid"], opts);
  execFileSync("git", ["-C", projectDir, "add", "-A"], opts);
  execFileSync("git", ["-C", projectDir, "commit", "-m", msg], opts);
}

function setupTaskWithEvidence(projectDir, { withGit = false, testShouldFail = false } = {}) {
  bootstrapProject({ name: "Adaptive Skill App", dest: projectDir, git: withGit });
  fs.mkdirSync(path.join(projectDir, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "tests", "smoke.test.mjs"),
    `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("smoke check", () => { assert.equal(${testShouldFail ? "1, 2" : "1, 1"}); });\n`,
    "utf8"
  );
  if (withGit) {
    initGitCommit(projectDir, "Initial project commit");
  }
  const t = createTask({
    projectDir,
    title: "Verify smoke regression checks",
    objective: "Ensure smoke tests pass before release.",
    activate: true,
    harnessDir: HARNESS_DIR,
  });
  const ev = captureEvidence({
    projectDir,
    harnessDir: HARNESS_DIR,
    taskId: t.id,
    name: "Smoke test run",
    commandArgv: testShouldFail
      ? [process.execPath, "-e", "console.error('smoke check assertion failed'); process.exit(1);"]
      : [process.execPath, "-e", "console.log('smoke check passed'); process.exit(0);"],
  });
  return { task: t, evidence: ev };
}

test("drafting from verified evidence and verified handoff quarantines safely and rejects bad/conflicted sources", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-lc-draft-"));
  try {
    const projDir = path.join(tmp, "proj-good");
    const { task, evidence } = setupTaskWithEvidence(projDir, { withGit: true });
    assert.equal(evidence.verified, true);

    const handoff = createHandoff({
      projectDir: projDir,
      harnessDir: HARNESS_DIR,
      workspaceRoot: path.resolve(HARNESS_DIR, ".."),
      taskId: task.id,
      fromRole: "developer",
      toRole: "qa-security-reviewer",
      fromTool: "codex",
      toTool: "gemini-cli",
      summary: "Smoke test verified via EVID-0001.",
      completedItems: ["Added smoke test"],
      unverifiedClaims: ["Manual docs formatting looks clean"],
      nextAction: "Draft portable skill proposal for smoke verification.",
    });

    // Dry run writes nothing
    const dryRes = draftSkillFromExperience({
      projectDir: projDir,
      harnessDir: HARNESS_DIR,
      handoffIds: [handoff.id],
      skillName: "smoke-check-verify",
      dryRun: true,
    });
    assert.equal(dryRes.dryRun, true);
    assert.equal(fs.existsSync(path.join(projDir, "proposals", "skills", "smoke-check-verify")), false);

    // Actual draft writes ONLY under proposals/skills/ and never activates
    const draftRes = draftSkillFromExperience({
      projectDir: projDir,
      harnessDir: HARNESS_DIR,
      handoffIds: [handoff.id],
      skillName: "smoke-check-verify",
    });
    assert.equal(fs.existsSync(path.join(projDir, "proposals", "skills", "smoke-check-verify", "SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(projDir, ".agents", "skills", "smoke-check-verify")), false);

    const draftText = fs.readFileSync(
      path.join(projDir, "proposals", "skills", "smoke-check-verify", "SKILL.md"),
      "utf8"
    );
    assert.match(draftText, /Verified Observations \(Source Evidence — Factual Only\)/);
    assert.match(draftText, /Suggested Procedure \(Agent\/Draft Suggestion — Unverified Until Promoted\)/);
    assert.match(draftText, /EVID-0001/);
    assert.match(draftText, /HANDOFF-0001/);

    // Duplicate proposal rejected
    assert.throws(
      () =>
        draftSkillFromExperience({
          projectDir: projDir,
          harnessDir: HARNESS_DIR,
          evidenceIds: [evidence.id],
          skillName: "smoke-check-verify",
        }),
      /already exists/i
    );

    // Git staleness warning detected after commit advances beyond EVID source_revision
    fs.writeFileSync(path.join(projDir, "README.md"), "# Updated Repo\n", "utf8");
    initGitCommit(projDir, "Advance HEAD past EVID-0001");
    const staleDraft = draftSkillFromExperience({
      projectDir: projDir,
      harnessDir: HARNESS_DIR,
      evidenceIds: [evidence.id],
      skillName: "smoke-check-stale",
    });
    assert.equal(staleDraft.stalenessWarnings.length, 1);
    assert.match(staleDraft.stalenessWarnings[0], /while current HEAD is/);

    // Missing source ID rejected
    assert.throws(
      () =>
        draftSkillFromExperience({
          projectDir: projDir,
          harnessDir: HARNESS_DIR,
          evidenceIds: ["EVID-9999"],
          skillName: "missing-evid",
        }),
      /not found/i
    );

    // Tampered hashed artifact rejected
    const artifactFile = path.join(projDir, "tests", "smoke.test.mjs");
    const realHash = computeSkillPackageDigest(path.join(projDir, "tests")).files[0].sha256;
    const evidFile = path.join(projDir, "evidence", `${evidence.id}-smoke-test-run.yaml`);
    const origEvid = fs.readFileSync(evidFile, "utf8");
    fs.writeFileSync(
      evidFile,
      origEvid.replace("artifacts: []", `artifacts:\n  - path: "tests/smoke.test.mjs"\n    description: "test"\n    sha256: "${realHash}"`),
      "utf8"
    );
    fs.appendFileSync(artifactFile, "\n// tampered artifact\n", "utf8");
    assert.throws(
      () =>
        draftSkillFromExperience({
          projectDir: projDir,
          harnessDir: HARNESS_DIR,
          evidenceIds: [evidence.id],
          skillName: "tampered-art",
        }),
      /SHA-256 mismatch/i
    );
    fs.writeFileSync(evidFile, origEvid, "utf8");

    // Open contradiction CONF-0001 blocks drafting fail-closed
    fs.mkdirSync(path.join(projDir, "brain", "conflicts"), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, "brain", "conflicts", "CONF-0001-smoke-conflict.yaml"),
      `schema_version: "1.1"
id: "CONF-0001"
title: "Smoke Check Contradiction"
status: "open"
memory_layer: "L2_OPERATIONAL"
authority_level: "A4"
severity: "high"
detected_at: "2026-11-20T00:00:00Z"
detected_by: "qa-security-reviewer"
conflicting_records:
  - record_id: "EVID-0001"
    path: "evidence/${evidence.id}-smoke-test-run.yaml"
    authority_level: "A4"
    claim: "Outdated run"
description: "Contradiction test."
impact: "Blocks promotion."
resolution_strategy: null
resolved_by: null
resolved_at: null
approval_ref: null
`,
      "utf8"
    );
    assert.throws(
      () =>
        draftSkillFromExperience({
          projectDir: projDir,
          harnessDir: HARNESS_DIR,
          evidenceIds: [evidence.id],
          skillName: "conflicted-draft",
        }),
      /Open contradiction conflict/i
    );

    // Example evidence (is_example: true) fails closed even if status === verified
    const exEvidPath = path.join(projDir, "evidence", "EVID-0099-example.yaml");
    fs.writeFileSync(
      exEvidPath,
      origEvid.replace('id: "EVID-0001"', 'id: "EVID-0099"\nis_example: true\nexample_notice: "EXAMPLE ONLY"'),
      "utf8"
    );
    assert.throws(
      () =>
        draftSkillFromExperience({
          projectDir: projDir,
          harnessDir: HARNESS_DIR,
          evidenceIds: ["EVID-0099"],
          skillName: "example-evid-reject",
        }),
      /example evidence fixture/i
    );
    fs.unlinkSync(exEvidPath);

    // Failed/draft evidence AND handoff with zero verified_evidence fail closed
    const badProj = path.join(tmp, "proj-fail");
    const badSetup = setupTaskWithEvidence(badProj, { testShouldFail: true });
    assert.equal(badSetup.evidence.verified, false);
    assert.throws(
      () =>
        draftSkillFromExperience({
          projectDir: badProj,
          harnessDir: HARNESS_DIR,
          evidenceIds: [badSetup.evidence.id],
          skillName: "from-failed-evid",
        }),
      /expected "verified"/i
    );
    const unverifiedHandoff = createHandoff({
      projectDir: badProj,
      harnessDir: HARNESS_DIR,
      workspaceRoot: path.resolve(HARNESS_DIR, ".."),
      taskId: badSetup.task.id,
      summary: "No verified evidence attached.",
      completedItems: ["Claimed manual check"],
      nextAction: "Run tests.",
    });
    assert.throws(
      () =>
        draftSkillFromExperience({
          projectDir: badProj,
          harnessDir: HARNESS_DIR,
          handoffIds: [unverifiedHandoff.id],
          skillName: "from-unverified-handoff",
        }),
      /zero verified_evidence/i
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("authorization gates enforce Ed25519 digest binding, reject spoofs, and handle PR branch / TTY / stale conflicts", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-lc-auth-"));
  try {
    const projDir = path.join(tmp, "proj");
    const { evidence } = setupTaskWithEvidence(projDir, { withGit: true });

    const draft = draftSkillFromExperience({
      projectDir: projDir,
      harnessDir: HARNESS_DIR,
      evidenceIds: [evidence.id],
      skillName: "auth-skill",
    });

    // 1. Refuse unauthorized promotion and spoofed --approved-by
    assert.throws(
      () => promoteSkillProposal({ projectDir: projDir, harnessDir: HARNESS_DIR, proposalName: "auth-skill" }),
      /Authorization required/i
    );
    assert.throws(
      () =>
        promoteSkillProposal({
          projectDir: projDir,
          harnessDir: HARNESS_DIR,
          proposalName: "auth-skill",
          approvedBy: "Project Owner",
        }),
      /self-reported --approved-by/i
    );

    // 2. keygen refuses writing inside projectDir or HARNESS_DIR
    assert.throws(
      () =>
        generateApproverKeypair({
          projectDir: projDir,
          harnessDir: HARNESS_DIR,
          workspaceRoot: path.resolve(HARNESS_DIR, ".."),
          approverId: "owner-1",
          privateKeyOut: path.join(projDir, "owner-1.pem"),
        }),
      /inside repository or protected directory/i
    );

    const extKeyPath = path.join(tmp, "keys", "owner-1.pem");
    const keyInfo = generateApproverKeypair({
      projectDir: projDir,
      harnessDir: HARNESS_DIR,
      workspaceRoot: path.resolve(HARNESS_DIR, ".."),
      approverId: "owner-1",
      privateKeyOut: extKeyPath,
    });
    assert.equal(fs.existsSync(extKeyPath), true);
    assert.equal(fs.existsSync(path.join(projDir, ".geloforge", "approvers.yaml")), true);

    // Sign approval bound to exact content_sha256
    const signed = signSkillApproval({
      projectDir: projDir,
      harnessDir: HARNESS_DIR,
      action: "promote",
      skillName: "auth-skill",
      approverId: keyInfo.approverId,
      privateKeyPath: extKeyPath,
      decidedAt: "2026-11-20T01:00:00Z",
      expiresAt: "2027-01-01T00:00:00Z",
    });

    // Tamper 1 byte in quarantined candidate AFTER signing -> rejected!
    const draftFile = path.join(projDir, "proposals", "skills", "auth-skill", "SKILL.md");
    const origDraftMd = fs.readFileSync(draftFile, "utf8");
    fs.writeFileSync(draftFile, `${origDraftMd}\n<!-- tampered -->\n`, "utf8");
    assert.throws(
      () =>
        promoteSkillProposal({
          projectDir: projDir,
          harnessDir: HARNESS_DIR,
          proposalName: "auth-skill",
          approvalId: signed.approvalId,
          createdAt: "2026-11-20T01:05:00Z",
        }),
      /Proposal content digest mismatch/i
    );
    fs.writeFileSync(draftFile, origDraftMd, "utf8");

    // Tamper signature inside APPR YAML -> rejected!
    const apprFile = path.join(projDir, signed.relPath);
    const origAppr = fs.readFileSync(apprFile, "utf8");
    const mutatedSig = origAppr.replace(/signature_base64: "([^"]+)"/, (_m, s) => `signature_base64: "${s.slice(0, -4)}AAAA"`);
    fs.writeFileSync(apprFile, mutatedSig, "utf8");
    assert.throws(
      () =>
        promoteSkillProposal({
          projectDir: projDir,
          harnessDir: HARNESS_DIR,
          proposalName: "auth-skill",
          approvalId: signed.approvalId,
          createdAt: "2026-11-20T01:05:00Z",
        }),
      /signature verification failed/i
    );

    // Expired approval -> rejected!
    fs.writeFileSync(apprFile, origAppr, "utf8");
    assert.throws(
      () =>
        promoteSkillProposal({
          projectDir: projDir,
          harnessDir: HARNESS_DIR,
          proposalName: "auth-skill",
          approvalId: signed.approvalId,
          createdAt: "2027-06-01T00:00:00Z",
        }),
      /approval expired/i
    );

    // Valid signature promotes cleanly
    const prom = promoteSkillProposal({
      projectDir: projDir,
      harnessDir: HARNESS_DIR,
      proposalName: "auth-skill",
      approvalId: signed.approvalId,
      createdAt: "2026-11-20T01:05:00Z",
    });
    assert.equal(prom.revision, "rev-0001");
    assert.equal(prom.authorizationTier, "cryptographic_ed25519");
    assert.equal(fs.existsSync(path.join(projDir, ".agents", "skills", "auth-skill", "SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(projDir, "proposals", "skills", "auth-skill")), false);

    // Propose update -> sign -> concurrently modify active skill -> stale approval rejected!
    const upd = proposeSkillUpdate({
      projectDir: projDir,
      harnessDir: HARNESS_DIR,
      skillName: "auth-skill",
      evidenceIds: [evidence.id],
      reason: "Add timeout boundary guidance.",
      appendNote: "Always pass bounded --timeout values.",
    });
    assert.match(upd.diff, /\+### Supporting Verified Observations/);
    // Concurrent proposal rejected cleanly
    assert.throws(
      () =>
        proposeSkillUpdate({
          projectDir: projDir,
          harnessDir: HARNESS_DIR,
          skillName: "auth-skill",
          evidenceIds: [evidence.id],
          reason: "Duplicate update.",
        }),
      /already exists/i
    );

    const signedUpd = signSkillApproval({
      projectDir: projDir,
      harnessDir: HARNESS_DIR,
      action: "promote",
      skillName: "auth-skill",
      approverId: keyInfo.approverId,
      privateKeyPath: extKeyPath,
      decidedAt: "2026-11-20T01:10:00Z",
    });

    // Tampering source EVID-0001 after signing triggers fail-closed evidence mismatch
    const evidAuthPath = path.join(projDir, "evidence", `${evidence.id}-smoke-test-run.yaml`);
    const origEvidAuth = fs.readFileSync(evidAuthPath, "utf8");
    fs.writeFileSync(evidAuthPath, origEvidAuth.replace("Smoke test run", "Smoke test mutated"), "utf8");
    assert.throws(
      () =>
        promoteSkillProposal({
          projectDir: projDir,
          harnessDir: HARNESS_DIR,
          proposalName: "auth-skill",
          approvalId: signedUpd.approvalId,
          createdAt: "2026-11-20T01:11:00Z",
        }),
      /changed or missing since proposal|evidence binding mismatch/i
    );
    fs.writeFileSync(evidAuthPath, origEvidAuth, "utf8");

    // Mutate active skill out-of-band concurrently -> both base check & stale approval reject!
    const activeSkillMd = path.join(projDir, ".agents", "skills", "auth-skill", "SKILL.md");
    const savedV1 = fs.readFileSync(activeSkillMd, "utf8");
    fs.writeFileSync(activeSkillMd, `${savedV1}\nOut-of-band edit.\n`, "utf8");
    assert.throws(
      () =>
        promoteSkillProposal({
          projectDir: projDir,
          harnessDir: HARNESS_DIR,
          proposalName: "auth-skill",
          approvalId: signedUpd.approvalId,
          createdAt: "2026-11-20T01:12:00Z",
        }),
      /Stale\/concurrent update conflict/i
    );

    // Restore v1 active file so signedUpd proceeds cleanly via external pinned --public-key PEM
    fs.writeFileSync(activeSkillMd, savedV1, "utf8");
    const extPubPath = path.join(tmp, "keys", "owner-1.pub.pem");
    fs.writeFileSync(extPubPath, keyInfo.publicKeyPem, "utf8");
    const promV2 = promoteSkillProposal({
      projectDir: projDir,
      harnessDir: HARNESS_DIR,
      proposalName: "auth-skill",
      approvalId: signedUpd.approvalId,
      publicKeyPath: extPubPath,
      createdAt: "2026-11-20T01:13:00Z",
    });
    assert.equal(promV2.revision, "rev-0002");

    // 3. Tampered snapshot on disk makes rollback fail closed BEFORE modifying active skill!
    const snap1Md = path.join(projDir, ".geloforge", "skill-history", "auth-skill", "snapshots", "rev-0001", "SKILL.md");
    const savedSnap1 = fs.readFileSync(snap1Md, "utf8");
    fs.writeFileSync(snap1Md, `${savedSnap1}\n<!-- corrupted snapshot -->\n`, "utf8");
    const histTampered = getSkillHistory({ projectDir: projDir, skillName: "auth-skill", harnessDir: HARNESS_DIR });
    assert.equal(histTampered.revisions[0].snapshotValid, false);
    assert.throws(
      () =>
        rollbackSkill({
          projectDir: projDir,
          harnessDir: HARNESS_DIR,
          skillName: "auth-skill",
          targetRevision: "rev-0001",
          interactiveConfirm: () => true,
        }),
      /Snapshot integrity failure/i
    );
    fs.writeFileSync(snap1Md, savedSnap1, "utf8");

    // Unauthorized rollback refused (and --approved-by spoof refused)
    assert.throws(
      () => rollbackSkill({ projectDir: projDir, harnessDir: HARNESS_DIR, skillName: "auth-skill", targetRevision: "rev-0001" }),
      /Authorization required/i
    );
    assert.throws(
      () =>
        rollbackSkill({
          projectDir: projDir,
          harnessDir: HARNESS_DIR,
          skillName: "auth-skill",
          targetRevision: "rev-0001",
          approvedBy: "Owner",
        }),
      /self-reported --approved-by/i
    );

    // 4. Test PR-branch promotion & local interactive TTY confirmation on a Git-clean project
    const gitProj = path.join(tmp, "proj-pr");
    const prSetup = setupTaskWithEvidence(gitProj, { withGit: true });
    initGitCommit(gitProj, "Commit task and verified evidence baseline");

    draftSkillFromExperience({
      projectDir: gitProj,
      harnessDir: HARNESS_DIR,
      evidenceIds: [prSetup.evidence.id],
      skillName: "pr-gated-skill",
    });
    const mainHeadBefore = execFileSync("git", ["-C", gitProj, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const prRes = promoteSkillProposal({
      projectDir: gitProj,
      harnessDir: HARNESS_DIR,
      proposalName: "pr-gated-skill",
      mode: "pr-branch",
    });
    assert.equal(prRes.authorizationTier, "git_pr_review_pending");
    assert.match(prRes.prBranch, /^skill-promote\/pr-gated-skill-/);
    assert.match(prRes.authorizationWarning, /branch protection/i);
    assert.equal(execFileSync("git", ["-C", gitProj, "rev-parse", "main"], { encoding: "utf8" }).trim(), mainHeadBefore);

    // Test --interactive rejection when confirmation returns false, then success when true
    draftSkillFromExperience({
      projectDir: gitProj,
      harnessDir: HARNESS_DIR,
      evidenceIds: [prSetup.evidence.id],
      skillName: "tty-skill",
    });
    assert.throws(
      () =>
        promoteSkillProposal({
          projectDir: gitProj,
          harnessDir: HARNESS_DIR,
          proposalName: "tty-skill",
          mode: "interactive",
          interactiveConfirm: () => false,
        }),
      /Interactive confirmation aborted/i
    );
    const ttyRes = promoteSkillProposal({
      projectDir: gitProj,
      harnessDir: HARNESS_DIR,
      proposalName: "tty-skill",
      mode: "interactive",
      interactiveConfirm: ({ expectedInput }) => expectedInput.startsWith("promote tty-skill "),
    });
    assert.equal(ttyRes.authorizationTier, "local_interactive_tty");
    assert.match(ttyRes.authorizationWarning, /weaker than independent/i);

    assert.ok(draft.candidateDigest);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("security boundaries block secret/symlink proposals, preexisting baselines snapshot as rev-0000, and end-to-end CLI flow succeeds", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-lc-e2e-"));
  try {
    // 1. Preexisting manual skill gets rev-0000 baseline before update, and symlinks/secrets fail closed
    const secProj = path.join(tmp, "sec-proj");
    const { evidence } = setupTaskWithEvidence(secProj);
    const manualDir = path.join(secProj, ".agents", "skills", "legacy-skill");
    fs.mkdirSync(manualDir, { recursive: true });
    const legacyContent = `---\nname: "legacy-skill"\ndescription: "Preexisting manually committed trusted skill before adaptive updates."\n---\n\n# Legacy Skill\n## When to Use\nLegacy manual guide.\n`;
    fs.writeFileSync(path.join(manualDir, "SKILL.md"), legacyContent, "utf8");

    // Secret token in --append-note blocked fail-closed
    const fakeSecret = "ghp_" + "99887766554433221100AABBCCDDEEFF0011";
    assert.throws(
      () =>
        proposeSkillUpdate({
          projectDir: secProj,
          harnessDir: HARNESS_DIR,
          skillName: "legacy-skill",
          evidenceIds: [evidence.id],
          reason: "Test secret block",
          appendNote: `Leak ${fakeSecret}`,
        }),
      /credential-like pattern/i
    );

    const updLegacy = proposeSkillUpdate({
      projectDir: secProj,
      harnessDir: HARNESS_DIR,
      skillName: "legacy-skill",
      evidenceIds: [evidence.id],
      reason: "Upgrade preexisting skill safely",
      appendNote: "Capture real command outputs.",
    });
    const promLegacy = promoteSkillProposal({
      projectDir: secProj,
      harnessDir: HARNESS_DIR,
      proposalName: "legacy-skill",
      mode: "interactive",
      interactiveConfirm: () => true,
    });
    const legacyHist = getSkillHistory({ projectDir: secProj, skillName: "legacy-skill", harnessDir: HARNESS_DIR });
    assert.equal(legacyHist.revisions[0].revision, "rev-0000");
    assert.equal(legacyHist.revisions[0].action, "baseline_snapshot");
    assert.equal(legacyHist.revisions[1].revision, "rev-0001");
    assert.ok(updLegacy.candidateDigest && promLegacy.revision);

    // Concurrent rollback via --patch-file + rollback back to rev-0000 baseline
    const rbLegacy = rollbackSkill({
      projectDir: secProj,
      harnessDir: HARNESS_DIR,
      skillName: "legacy-skill",
      targetRevision: "rev-0000",
      mode: "interactive",
      interactiveConfirm: () => true,
    });
    assert.equal(rbLegacy.newRevision, "rev-0002");
    assert.equal(fs.readFileSync(path.join(manualDir, "SKILL.md"), "utf8"), legacyContent);

    // Propose-update via external --patch-file cleanly creates diff without mutating active skill
    const patchFile = path.join(tmp, "legacy-patch.md");
    fs.writeFileSync(
      patchFile,
      legacyContent.replace("Legacy manual guide.", "Legacy manual guide updated cleanly via --patch-file."),
      "utf8"
    );
    const patchUpd = proposeSkillUpdate({
      projectDir: secProj,
      harnessDir: HARNESS_DIR,
      skillName: "legacy-skill",
      evidenceIds: [evidence.id],
      reason: "Refine legacy wording via patch file",
      patchFile,
    });
    assert.match(patchUpd.diff, /\+Legacy manual guide updated cleanly via --patch-file\./);

    // Symlink inside snapshot blocks rollback fail-closed
    const snap0Dir = path.join(secProj, ".geloforge", "skill-history", "legacy-skill", "snapshots", "rev-0001");
    const outTarget = path.join(tmp, "out-snap");
    fs.mkdirSync(outTarget, { recursive: true });
    fs.symlinkSync(outTarget, path.join(snap0Dir, "references"), DIR_SYMLINK_TYPE);
    assert.throws(
      () =>
        rollbackSkill({
          projectDir: secProj,
          harnessDir: HARNESS_DIR,
          skillName: "legacy-skill",
          targetRevision: "rev-0001",
          mode: "interactive",
          interactiveConfirm: () => true,
        }),
      /symbolic link|SEC-SYMLINK-OR-TRAVERSAL/i
    );

    // Symlink/junction inside proposal blocks promotion fail-closed
    const draftSym = draftSkillFromExperience({
      projectDir: secProj,
      harnessDir: HARNESS_DIR,
      evidenceIds: [evidence.id],
      skillName: "sym-attack",
    });
    const extTarget = path.join(tmp, "outside-ref");
    fs.mkdirSync(extTarget, { recursive: true });
    fs.symlinkSync(
      extTarget,
      path.join(secProj, "proposals", "skills", "sym-attack", "references"),
      DIR_SYMLINK_TYPE
    );
    assert.throws(
      () =>
        promoteSkillProposal({
          projectDir: secProj,
          harnessDir: HARNESS_DIR,
          proposalName: "sym-attack",
          mode: "interactive",
          interactiveConfirm: () => true,
        }),
      /symbolic link|SEC-SYMLINK-OR-TRAVERSAL/i
    );
    assert.ok(draftSym.candidateDigest);

    // 2. Full End-to-End CLI Journey:
    //    init --git -> task new -> evidence capture -> handoff -> skills draft -> context check ->
    //    keygen -> sign -> promote -> second evidence -> propose-update -> reject bad auth ->
    //    sign & promote v2 -> history -> sign & rollback -> verify byte-identical v1 + validateProject!
    const e2eProj = path.join(tmp, "e2e-cli-proj");
    assert.equal(
      runCli(["init", "--name", "E2E Lifecycle App", "--dest", e2eProj, "--git"]).status,
      0
    );
    fs.mkdirSync(path.join(e2eProj, "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(e2eProj, "tests", "app.test.mjs"),
      'import test from "node:test"; import assert from "node:assert/strict"; test("app passes", () => { assert.equal(2 + 2, 4); });\n',
      "utf8"
    );
    initGitCommit(e2eProj, "Initial E2E baseline");

    assert.equal(
      runCli(["task", "new", "--title", "Verify arithmetic smoke test", "--activate"], { cwd: e2eProj }).status,
      0
    );
    assert.equal(
      runCli(
        ["evidence", "capture", "--task", "TASK-0001", "--name", "Arithmetic test", "--", process.execPath, "--test", "tests/app.test.mjs"],
        { cwd: e2eProj }
      ).status,
      0
    );
    assert.equal(
      runCli(
        [
          "handoff",
          "--task",
          "TASK-0001",
          "--summary",
          "Arithmetic test verified cleanly.",
          "--completed",
          "Verified tests/app.test.mjs via EVID-0001",
          "--next-action",
          "Draft and review reusable skill.",
        ],
        { cwd: e2eProj }
      ).status,
      0
    );

    const cliDraft = runCli(
      ["skills", "draft", "--from-handoff", "HANDOFF-0001", "--name", "arithmetic-smoke-verify", "--json"],
      { cwd: e2eProj }
    );
    assert.equal(cliDraft.status, 0, cliDraft.stderr);

    // Quarantined draft must NOT load in context --skills yet
    const ctxBefore = JSON.parse(
      runCli(["context", "--task", "TASK-0001", "--skills", "--json"], { cwd: e2eProj }).stdout
    );
    assert.equal(ctxBefore.manifest.skills.indexed_count, 0);
    assert.equal(ctxBefore.manifest.skills.quarantined_excluded, 1);

    // Spoofed --approved-by CLI attempt fails exit 1
    const spoofRes = runCli(
      ["skills", "promote", "arithmetic-smoke-verify", "--approved-by", "Owner"],
      { cwd: e2eProj }
    );
    assert.equal(spoofRes.status, 1);
    assert.match(spoofRes.stderr, /self-reported --approved-by/);

    // Non-TTY --interactive fails closed with exit 1 instead of hanging
    const nonTtyRes = runCli(["skills", "promote", "arithmetic-smoke-verify", "--interactive"], { cwd: e2eProj });
    assert.equal(nonTtyRes.status, 1);
    assert.match(nonTtyRes.stderr, /requires a real interactive terminal/);

    // Keygen + sign + promote v1
    const e2eKey = path.join(tmp, "e2e-owner.pem");
    assert.equal(
      runCli(["skills", "keygen", "--approver", "maintainer", "--out", e2eKey], { cwd: e2eProj }).status,
      0
    );
    const sign1 = JSON.parse(
      runCli(
        ["skills", "sign", "--action", "promote", "--skill", "arithmetic-smoke-verify", "--approver", "maintainer", "--key", e2eKey, "--json"],
        { cwd: e2eProj }
      ).stdout
    );
    const prom1 = JSON.parse(
      runCli(
        ["skills", "promote", "arithmetic-smoke-verify", "--approval", sign1.approvalId, "--json"],
        { cwd: e2eProj }
      ).stdout
    );
    assert.equal(prom1.revision, "rev-0001");
    const v1Bytes = fs.readFileSync(path.join(e2eProj, ".agents", "skills", "arithmetic-smoke-verify", "SKILL.md"));

    // Active promoted skill now compiles into context --skills while A0 policies stay intact
    const ctxAfter = JSON.parse(
      runCli(["context", "--task", "TASK-0001", "--skills", "--skill", "arithmetic-smoke-verify", "--json"], { cwd: e2eProj }).stdout
    );
    assert.equal(ctxAfter.manifest.skills.selected_skills[0].name, "arithmetic-smoke-verify");
    assert.match(ctxAfter.markdown, /harness\/policies\/approval-boundaries\.md/);

    // Second evidence + propose-update -> sign -> promote v2
    assert.equal(
      runCli(
        ["evidence", "capture", "--task", "TASK-0001", "--name", "Second arithmetic run", "--", process.execPath, "--test", "tests/app.test.mjs"],
        { cwd: e2eProj }
      ).status,
      0
    );
    assert.equal(
      runCli(
        [
          "skills",
          "propose-update",
          "arithmetic-smoke-verify",
          "--from-evidence",
          "EVID-0002",
          "--reason",
          "Confirm repeatable second test run",
          "--append-note",
          "Repeat smoke run across clean Node child process.",
        ],
        { cwd: e2eProj }
      ).status,
      0
    );
    const sign2 = JSON.parse(
      runCli(
        ["skills", "sign", "--action", "promote", "--skill", "arithmetic-smoke-verify", "--approver", "maintainer", "--key", e2eKey, "--json"],
        { cwd: e2eProj }
      ).stdout
    );
    const prom2 = JSON.parse(
      runCli(
        ["skills", "promote", "arithmetic-smoke-verify", "--approval", sign2.approvalId, "--json"],
        { cwd: e2eProj }
      ).stdout
    );
    assert.equal(prom2.revision, "rev-0002");

    // History -> sign rollback -> execute rollback -> verify byte-identical v1 + valid Second Brain!
    const histRes = JSON.parse(
      runCli(["skills", "history", "arithmetic-smoke-verify", "--json"], { cwd: e2eProj }).stdout
    );
    assert.equal(histRes.revisions.length, 2);
    assert.equal(histRes.driftDetected, false);

    const signRb = JSON.parse(
      runCli(
        [
          "skills",
          "sign",
          "--action",
          "rollback",
          "--skill",
          "arithmetic-smoke-verify",
          "--revision",
          "rev-0001",
          "--approver",
          "maintainer",
          "--key",
          e2eKey,
          "--json",
        ],
        { cwd: e2eProj }
      ).stdout
    );
    const rbRes = JSON.parse(
      runCli(
        ["skills", "rollback", "arithmetic-smoke-verify", "rev-0001", "--approval", signRb.approvalId, "--json"],
        { cwd: e2eProj }
      ).stdout
    );
    assert.equal(rbRes.newRevision, "rev-0003");
    assert.equal(rbRes.restoredFromRevision, "rev-0001");

    const restoredBytes = fs.readFileSync(path.join(e2eProj, ".agents", "skills", "arithmetic-smoke-verify", "SKILL.md"));
    assert.deepEqual(restoredBytes, v1Bytes);

    const finalHist = JSON.parse(
      runCli(["skills", "history", "arithmetic-smoke-verify", "--json"], { cwd: e2eProj }).stdout
    );
    assert.equal(finalHist.revisions.length, 3);
    assert.equal(finalHist.revisions.every((r) => r.snapshotValid === true), true);

    // Reusing already-executed rollback approval rev-0001 after restoring back to rev-0001 must fail (stale base)
    const staleRbRes = runCli(
      ["skills", "rollback", "arithmetic-smoke-verify", "rev-0001", "--approval", signRb.approvalId],
      { cwd: e2eProj }
    );
    assert.equal(staleRbRes.status, 1);

    const projVal = validateProject(e2eProj);
    assert.equal(projVal.valid, true, projVal.errors.join("; "));
    assert.equal(projVal.warnings.length, 0, projVal.warnings.join("; "));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});
