import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bootstrapProject } from "../scripts/bootstrap-project.mjs";
import { buildCodebaseMap, extractFileOutline } from "../core/codebase-map.mjs";
import { compileContext } from "../core/context-compiler.mjs";
import { validateAgainstSchema } from "../core/json-schema-lite.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_DIR = path.resolve(__dirname, "..");
const CLI_PATH = path.join(HARNESS_DIR, "scripts", "geloforge.mjs");

test("extractFileOutline & buildCodebaseMap support multi-language outlines, unsupported fallback, binaries, and import centrality", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-map-lang-"));
  try {
    const repo = path.join(tmp, "polyglot");
    fs.mkdirSync(path.join(repo, "src", "auth"), { recursive: true });
    fs.mkdirSync(path.join(repo, "pypkg"), { recursive: true });
    fs.mkdirSync(path.join(repo, "cmd"), { recursive: true });
    fs.mkdirSync(path.join(repo, "rustlib"), { recursive: true });
    fs.mkdirSync(path.join(repo, "jvm"), { recursive: true });
    fs.mkdirSync(path.join(repo, "db"), { recursive: true });
    fs.mkdirSync(path.join(repo, "extra"), { recursive: true });

    fs.writeFileSync(
      path.join(repo, "src", "routes.ts"),
      `import { signJwtToken } from "./auth/signer";\nexport async function handleLogin(userId: string) { return signJwtToken(userId); }\nexport interface LoginResult { ok: boolean; }\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(repo, "src", "auth", "signer.ts"),
      `export function signJwtToken(id: string) { return id; }\nexport class TokenSigner {}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(repo, "pypkg", "__init__.py"),
      `from .verifier import check_signature\n\ndef entry():\n    return check_signature("ok")\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(repo, "pypkg", "verifier.py"),
      `class SignatureError(Exception):\n    pass\n\ndef check_signature(payload):\n    return True\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(repo, "cmd", "server.go"),
      `package main\ntype HealthCheck struct {}\nfunc StartServer(port int) error { return nil }\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(repo, "rustlib", "lib.rs"),
      `pub struct LedgerConfig { pub scale: u32 }\npub fn verify_hash(input: &str) -> bool { !input.is_empty() }\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(repo, "jvm", "BillingService.java"),
      `public class BillingService {\n  public int computeTotal(int cents) { return cents; }\n}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(repo, "db", "schema.sql"),
      `CREATE TABLE invoices (id INTEGER PRIMARY KEY);\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(repo, "extra", "custom.zig"),
      `const std = @import("std");\npub fn customProbe(val: u32) u32 { return val + 1; }\n`,
      "utf8"
    );
    // Binary file masquerading with text extension must be skipped safely
    fs.writeFileSync(path.join(repo, "extra", "blob.dat"), Buffer.from([0x41, 0x00, 0x42, 0x43]));

    const zigOutline = extractFileOutline("extra/custom.zig", fs.readFileSync(path.join(repo, "extra", "custom.zig"), "utf8"));
    assert.equal(zigOutline.outlineMode, "fallback");
    assert.equal(zigOutline.symbols.some((s) => s.name === "customProbe"), true);

    const mapRes = buildCodebaseMap({
      projectDir: repo,
      queryText: "login route jwt signature verifier",
      seedPaths: new Set(["src/routes.ts", "pypkg/__init__.py"]),
      mapBudget: 2000,
    });

    assert.equal(mapRes.scanMode, "filesystem-walk");
    assert.equal(mapRes.blockedFiles.some((b) => b.path === "extra/blob.dat"), true);
    const selectedMap = new Map(mapRes.selectedFiles.map((f) => [f.path, f]));
    assert.equal(selectedMap.has("src/routes.ts"), true);
    assert.equal(selectedMap.has("src/auth/signer.ts"), true);
    assert.equal(selectedMap.has("pypkg/verifier.py"), true);
    // Verify 1-hop import boost explanations
    assert.ok(selectedMap.get("src/auth/signer.ts").reasons.some((r) => /imported by src\/routes\.ts/.test(r)));
    assert.ok(selectedMap.get("pypkg/verifier.py").reasons.some((r) => /imported by pypkg\/__init__\.py/.test(r)));

    // Unsupported extension degrades gracefully without failing map generation
    const zigOnly = buildCodebaseMap({ projectDir: repo, queryText: "customProbe", mapBudget: 1200 });
    const zigEntry = zigOnly.selectedFiles.find((f) => f.path === "extra/custom.zig");
    assert.ok(zigEntry);
    assert.equal(zigEntry.outline_mode, "fallback");

    // Multi-language extraction assertions
    const mapLangs = new Set(zigOnly.selectedFiles.map((f) => f.language));
    assert.equal(mapLangs.has("go"), true);
    assert.equal(mapLangs.has("rust"), true);
    assert.equal(mapLangs.has("java"), true);
    assert.equal(mapLangs.has("sql"), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("buildCodebaseMap enforces .gitignore in Git and fallback walks while blocking secrets and symlinks", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-map-sec-"));
  try {
    const setupIgnoredAndSecrets = (dir) => {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.mkdirSync(path.join(dir, "secrets"), { recursive: true });
      fs.mkdirSync(path.join(dir, "ignored_build"), { recursive: true });
      fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });

      fs.writeFileSync(path.join(dir, ".gitignore"), "ignored_build/\n*.tmp.js\n!keep.tmp.js\n", "utf8");
      fs.writeFileSync(path.join(dir, "src", "clean.mjs"), "export function cleanHealth() { return true; }\n", "utf8");
      fs.writeFileSync(path.join(dir, "ignored_build", "bundle.js"), "export function ignoredFunc() {}\n", "utf8");
      fs.writeFileSync(path.join(dir, "drop.tmp.js"), "export function dropped() {}\n", "utf8");
      fs.writeFileSync(path.join(dir, "keep.tmp.js"), "export function keptByNegation() {}\n", "utf8");
      fs.writeFileSync(path.join(dir, "node_modules", "pkg", "index.js"), "export function vendor() {}\n", "utf8");
      fs.writeFileSync(path.join(dir, ".env"), "SECRET_TOKEN=top_secret_env\n", "utf8");
      fs.writeFileSync(path.join(dir, "secrets", "api.key"), "PRIVATE_KEY_MATERIAL\n", "utf8");
      fs.writeFileSync(path.join(dir, "src", "package-lock.json"), "{}\n", "utf8");

      const dynamicGhToken = "ghp_" + "A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8";
      fs.writeFileSync(path.join(dir, "src", "embedded-secret.mjs"), `export const tok = "${dynamicGhToken}";\n`, "utf8");
    };

    // 1. Non-Git fallback walk
    const nonGit = path.join(tmp, "non-git");
    setupIgnoredAndSecrets(nonGit);

    // Symlink target outside repo must be ignored with warning
    const extTarget = path.join(tmp, "external-target");
    fs.mkdirSync(extTarget);
    fs.writeFileSync(path.join(extTarget, "leak.mjs"), "export function outside() {}\n", "utf8");
    fs.symlinkSync(extTarget, path.join(nonGit, "src", "sym"), process.platform === "win32" ? "junction" : "dir");

    const nonGitMap = buildCodebaseMap({ projectDir: nonGit, queryText: "cleanHealth", mapBudget: 1500 });
    assert.equal(nonGitMap.scanMode, "filesystem-walk");
    const nonGitSelected = new Set(nonGitMap.selectedFiles.map((f) => f.path));
    assert.equal(nonGitSelected.has("src/clean.mjs"), true);
    assert.equal(nonGitSelected.has("keep.tmp.js"), true);
    assert.equal(nonGitSelected.has("ignored_build/bundle.js"), false);
    assert.equal(nonGitSelected.has("drop.tmp.js"), false);
    assert.equal(nonGitSelected.has("src/embedded-secret.mjs"), false);
    assert.equal(nonGitMap.markdownSection.includes("top_secret_env"), false);
    assert.equal(nonGitMap.markdownSection.includes("PRIVATE_KEY_MATERIAL"), false);
    assert.equal(nonGitMap.markdownSection.includes("escaped") || nonGitMap.blockedFiles.some((b) => b.path === "src/embedded-secret.mjs"), true);
    assert.equal(nonGitMap.markdownSection.includes("sym/leak.mjs"), false);

    // 2. Git repo mode (git ls-files --cached --others --exclude-standard)
    const gitRepo = path.join(tmp, "git-repo");
    setupIgnoredAndSecrets(gitRepo);
    execFileSync("git", ["init", "-b", "main", gitRepo], { windowsHide: true, stdio: "ignore" });
    const gitMap = buildCodebaseMap({ projectDir: gitRepo, queryText: "cleanHealth", mapBudget: 1500 });
    assert.equal(gitMap.scanMode, "git-ls-files");
    const gitSelected = new Set(gitMap.selectedFiles.map((f) => f.path));
    assert.equal(gitSelected.has("src/clean.mjs"), true);
    assert.equal(gitSelected.has("keep.tmp.js"), true);
    assert.equal(gitSelected.has("ignored_build/bundle.js"), false);
    assert.equal(gitSelected.has("drop.tmp.js"), false);
    assert.equal(gitSelected.has("src/embedded-secret.mjs"), false);
    assert.equal(gitMap.blockedFiles.some((b) => b.path === ".env"), true);
    assert.equal(gitMap.blockedFiles.some((b) => b.path === "secrets/api.key"), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("buildCodebaseMap scales cleanly on a 1,200-file repository via bounded pre-ranked scanning", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-map-scale-"));
  try {
    const repo = path.join(tmp, "large-repo");
    for (let d = 0; d < 12; d += 1) {
      const dir = path.join(repo, "src", `mod-${String(d).padStart(2, "0")}`);
      fs.mkdirSync(dir, { recursive: true });
      for (let f = 0; f < 100; f += 1) {
        fs.writeFileSync(
          path.join(dir, `file-${String(f).padStart(3, "0")}.mjs`),
          `export function worker_${d}_${f}() { return ${f}; }\n`,
          "utf8"
        );
      }
    }
    fs.mkdirSync(path.join(repo, "src", "z-payments"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "src", "z-payments", "refund-processor.ts"),
      `export function issueStripeRefund(txId: string) { return txId; }\n`,
      "utf8"
    );

    const r1 = buildCodebaseMap({
      projectDir: repo,
      queryText: "stripe refund processor",
      maxScannedFiles: 500,
      mapBudget: 800,
    });
    const r2 = buildCodebaseMap({
      projectDir: repo,
      queryText: "stripe refund processor",
      maxScannedFiles: 500,
      mapBudget: 800,
    });

    assert.equal(r1.truncatedScan, true);
    assert.equal(r1.totalDiscoveredFiles, 1201);
    assert.equal(r1.scannedFilesCount, 500);
    assert.ok(r1.estimatedTokens <= 800);
    assert.equal(r1.selectedFiles.some((s) => s.path === "src/z-payments/refund-processor.ts"), true);
    assert.equal(r1.markdownSection, r2.markdownSection);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("compileContext and CLI integrate --map cleanly and preserve manifest validity", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-map-cli-"));
  try {
    const projectDir = path.join(tmp, "mapped-proj");
    bootstrapProject({ name: "Mapped CLI App", dest: projectDir, git: true });
    fs.mkdirSync(path.join(projectDir, "src", "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "src", "auth.mjs"),
      `import { verifySig } from "./lib/crypto.mjs";\nexport function authenticate() { return verifySig(); }\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(projectDir, "src", "lib", "crypto.mjs"),
      `export function verifySig() { return true; }\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(projectDir, "tasks", "TASK-0001-auth.yaml"),
      `schema_version: "1.1"
id: "TASK-0001"
title: "Authenticate incoming requests"
project_id: "proj-mapped-cli-app"
status: "active"
memory_layer: "L2_OPERATIONAL"
authority_level: "A4"
priority: "high"
assigned_role: "developer"
created_by: "orchestrator"
created_at: "2026-03-01T00:00:00Z"
updated_at: "2026-03-01T00:00:00Z"
objective: "Implement authenticate check using verifySig."
scope_in:
  - "src/auth.mjs"
scope_out:
  - "payments"
required_inputs:
  - path: "src/auth.mjs"
    revision: "HEAD"
expected_outputs: []
acceptance_criteria:
  - "Validates signature via verifySig."
dependencies: []
approval_required: false
approval_ref: null
context_budget: "working"
max_retries: 2
evidence_refs: []
`,
      "utf8"
    );

    const outRaw = execFileSync(
      process.execPath,
      [CLI_PATH, "context", "--project", projectDir, "--task", "TASK-0001", "--map", "--map-budget", "700", "--json"],
      { encoding: "utf8", windowsHide: true }
    );
    const parsed = JSON.parse(outRaw);
    const schema = JSON.parse(fs.readFileSync(path.join(HARNESS_DIR, "schemas", "context-pack-manifest.schema.json"), "utf8"));
    const schemaCheck = validateAgainstSchema(parsed.manifest, schema);
    assert.equal(schemaCheck.valid, true, schemaCheck.errors.join("; "));
    assert.equal(parsed.manifest.codebase_map.enabled, true);
    assert.equal(parsed.manifest.codebase_map.selected_files.includes("src/lib/crypto.mjs"), true);
    // Already included verbatim as required_inputs -> not duplicated inside map selection
    assert.equal(parsed.manifest.codebase_map.selected_files.includes("src/auth.mjs"), false);
    assert.ok(parsed.manifest.budget_breakdown.codebase_map_tokens > 0);

    const resDirect = compileContext({ projectDir, taskId: "TASK-0001", includeMap: true, mapBudget: 700 });
    assert.ok(resDirect.markdown.includes("## Selective Codebase Map"));
    assert.ok(resDirect.markdown.includes("src/lib/crypto.mjs"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});
