import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { extractFrontmatter, serializeYaml } from "../core/yaml-subset.mjs";
import { bootstrapProject } from "../scripts/bootstrap-project.mjs";

const CLI = fileURLToPath(new URL("../scripts/geloforge.mjs", import.meta.url));
const exec = promisify(execFile);

async function cli(cwd, ...args) {
  const { stdout } = await exec(process.execPath, [CLI, ...args, "--json"], { cwd, timeout: 20_000 });
  return JSON.parse(stdout);
}

function fixture(t, { git = false } = {}) {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "geloforge-roadmap-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 }));
  const root = path.join(temp, "source checkout");
  bootstrapProject({ name: "Pilot Checkout", owner: "Fixture Owner", dest: root, git });
  fs.mkdirSync(path.join(root, "proposals"), { recursive: true });
  return { temp, root };
}

function ownerKeys(temp, prefix = "pilot-owner") {
  const pair = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const key = path.join(temp, `${prefix}.pem`);
  const pin = path.join(temp, `${prefix}-public.pem`);
  fs.writeFileSync(key, pair.privateKey);
  fs.writeFileSync(pin, pair.publicKey);
  return { key, pin };
}

async function evidence(root, code = 0) {
  const { id } = await cli(root, "task", "new", "--title", "Verify candidate change", "--activate");
  const { stdout } = await exec(process.execPath, [
    CLI, "evidence", "capture", "--task", id, "--json", "--", process.execPath, "-e", `process.exit(${code})`,
  ], { cwd: root }).catch((err) => {
    if (code === 1 && err.code === 1 && err.stdout) return { stdout: err.stdout };
    throw err;
  });
  return JSON.parse(stdout);
}

test("requirements promotion is bound to verified evidence, owner signature and exact file bytes", async (t) => {
  const { temp, root } = fixture(t);
  const { key, pin } = ownerKeys(temp);
  const other = ownerKeys(temp, "untrusted");
  const draft = "proposals/quotation-rules.md";
  const target = "brain/requirements/constraints.md";
  const updated = "# Quotation rules\n\nConfirm the request before handoff.\n";
  fs.writeFileSync(path.join(root, draft), updated);
  const failed = await evidence(root, 1);
  const proposed = ["--proposal", draft, "--target", target];
  await assert.rejects(cli(root, "proposal", "sign", ...proposed, "--evidence", failed.id, "--key", key), /expected "verified"/);
  const passed = await evidence(root);
  const args = [...proposed, "--evidence", passed.id];
  const before = fs.readFileSync(path.join(root, target), "utf8");
  const preview = await cli(root, "proposal", "preview", ...args);
  const signed = await cli(root, "proposal", "sign", ...args, "--key", key);
  assert.equal(preview.digest, signed.digest);
  const promote = (owner = pin) => cli(root, "proposal", "promote", ...args, "--approval", signed.approvalId, "--owner-key", owner);
  await assert.rejects(promote(other.pin), /did not match the pinned public key/);
  fs.appendFileSync(path.join(root, draft), "\nUnreviewed change.\n");
  await assert.rejects(promote(), /does not authorize these inputs/);
  fs.writeFileSync(path.join(root, draft), updated);
  fs.appendFileSync(path.join(root, target), "\nConcurrent change.\n");
  await assert.rejects(promote(), /does not authorize these inputs/);
  fs.writeFileSync(path.join(root, target), before);
  assert.equal((await promote()).promoted, true);
  assert.equal(fs.readFileSync(path.join(root, target), "utf8"), updated);
  fs.writeFileSync(path.join(root, target), before);
  await assert.rejects(promote(), /already used/);
});

test("ADR promotion writes valid accepted metadata and archives the reviewed source", async (t) => {
  const { temp, root } = fixture(t);
  const { key, pin } = ownerKeys(temp);
  const id = "ADR-0004";
  const name = `${id}-staging-verification.md`;
  const source = `proposals/${name}`;
  const target = `brain/decisions/${name}`;
  const now = new Date().toISOString();
  const draft = {
    schema_version: "1.1", id, title: "Staging verification", status: "proposed", memory_layer: "L1_AUTHORITATIVE",
    authority_level: "A2", owner: "Fixture Owner", proposed_by: "reviewer", approved_by: null,
    created_at: now, updated_at: now, decided_at: null, review_by: null, supersedes: [], superseded_by: null,
    related_requirements: [], related_research: [], approval_ref: null, tags: ["staging"],
  };
  fs.writeFileSync(path.join(root, source), `---\n${serializeYaml(draft)}---\n\nKeep staging verification in scope.\n`);
  const verified = await evidence(root);
  const args = ["--proposal", source, "--target", target, "--evidence", verified.id];
  const { approvalId } = await cli(root, "proposal", "sign", ...args, "--key", key);
  const promoted = await cli(root, "proposal", "promote", ...args, "--approval", approvalId, "--owner-key", pin);
  const destination = fs.readFileSync(path.join(root, target), "utf8");
  const accepted = extractFrontmatter(destination);
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.approval_ref, approvalId);
  assert.match(destination, /Keep staging verification in scope/);
  assert.equal(fs.existsSync(path.join(root, source)), false);
  assert.equal(extractFrontmatter(fs.readFileSync(path.join(root, promoted.archivedProposal), "utf8")).status, "proposed");
  const validation = await cli(root, "validate");
  assert.equal(validation.valid, true, validation.errors.join("\n"));
});

test("local checkpoints restore practical guidance without putting local IDs in shared state", async (t) => {
  const { root } = fixture(t);
  const state = path.join(root, "brain", "state", "current.yaml");
  const original = fs.readFileSync(state, "utf8");
  const local = await cli(root, "checkpoint", "create", "--local", "--resume", "Check the staging retry evidence.");
  assert.match(local.recordPath, /^local-runtime\/checkpoints\/CHKPT-/);
  assert.equal(fs.readFileSync(state, "utf8"), original);
  const recovered = await cli(root, "checkpoint", "resume");
  assert.equal(recovered.nextAction, local.record.resume_instructions);
  assert.equal(recovered.stateAdvanced, false);
  const shared = await cli(root, "checkpoint", "create", "--resume", "Review newer work.");
  assert.notEqual(shared.checkpointId, local.checkpointId);
  assert.equal((await cli(root, "checkpoint", "resume", "--id", local.checkpointId)).stateAdvanced, true);
  fs.unlinkSync(path.join(root, local.recordPath));
  assert.equal((await cli(root, "validate")).valid, true);
});

test("worktrees use dedicated branches and refuse to remove a dirty checkout", async (t) => {
  const { root, temp } = fixture(t, { git: true });
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("add", ".");
  git("-c", "user.name=Test Owner", "-c", "user.email=test@example.invalid", "commit", "-m", "Initial project");
  const worktree = await cli(root, "worktree", "add", "routing-review");
  assert.equal(worktree.path, path.join(temp, "worktrees", "routing-review"));
  assert.equal(worktree.branch, "geloforge/routing-review");
  assert.equal(worktree.commit, git("rev-parse", "HEAD"));
  const relevant = (await cli(root, "worktree", "list")).worktrees;
  assert.equal(relevant[0]?.path, worktree.path, JSON.stringify({
    expected: worktree.path, registered: git("worktree", "list", "--porcelain", "-z"),
  }));
  assert.equal(git("branch", "--show-current"), "main");
  const uncommitted = path.join(worktree.path, "keep-me.md");
  fs.writeFileSync(uncommitted, "Pending independent work.");
  await assert.rejects(cli(root, "worktree", "remove", "routing-review"), /untracked/);
  fs.unlinkSync(uncommitted);
  const ignored = path.join(worktree.path, ".env");
  fs.writeFileSync(ignored, "local fixture");
  await assert.rejects(cli(root, "worktree", "remove", "routing-review"), /ignored files/);
  assert.equal(fs.readFileSync(ignored, "utf8"), "local fixture");
  fs.unlinkSync(ignored);
  assert.equal((await cli(root, "worktree", "remove", "routing-review")).removed, true);
  assert.ok(git("show-ref", "--verify", "refs/heads/geloforge/routing-review"));
  assert.deepEqual((await cli(root, "worktree", "list")).worktrees, []);
});

test("query cache survives CLI restarts and invalidates on context changes", async (t) => {
  const { root } = fixture(t);
  const args = ["context", "--cache", "--query", "quotation staging workflow"];
  assert.equal((await cli(root, ...args)).diskCache, "miss");
  const cached = await cli(root, ...args);
  assert.equal(cached.diskCache, "hit");
  assert.equal(cached.markdown, (await cli(root, "context", "--query", "quotation staging workflow")).markdown);
  fs.appendFileSync(path.join(root, "brain", "requirements", "constraints.md"), "\nStaging revision evidence is required.\n");
  const changed = await cli(root, ...args);
  assert.equal(changed.diskCache, "miss");
  assert.match(changed.markdown, /Staging revision evidence is required/);
  assert.equal((await cli(root, ...args, "--skills")).diskCache, "bypassed");
  const { id } = await cli(root, "task", "new", "--title", "Check coordination", "--activate");
  await cli(root, "task", "claim", "--task", id, "--tool", "codex", "--session", "pilot-session", "--scope", "src/");
  const leased = await cli(root, ...args);
  assert.equal(leased.diskCache, "bypassed");
  assert.match(leased.markdown, /Active Multi-IDE Peer Leases/);
});

test("Antigravity receives a workspace read-only MCP adapter and keeps other servers", async (t) => {
  const { root } = fixture(t);
  const agentConfig = path.join(root, ".agents", "mcp_config.json");
  const otherServer = { command: "example-n8n-integration", args: [] };
  fs.mkdirSync(path.dirname(agentConfig), { recursive: true });
  fs.writeFileSync(agentConfig, JSON.stringify({ mcpServers: { "n8n-mcp": otherServer } }));
  await cli(root, "mcp", "init", "--client", "antigravity", "--read-only");
  const { mcpServers } = JSON.parse(fs.readFileSync(agentConfig, "utf8"));
  assert.deepEqual(mcpServers["n8n-mcp"], otherServer);
  const { command, args } = mcpServers.geloforge;
  assert.deepEqual(args.slice(-3), ["--project", root, "--read-only"]);
  const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n";
  const output = execFileSync(command, args, { cwd: path.dirname(root), input: request, encoding: "utf8", timeout: 10_000 });
  assert.ok(JSON.parse(output).result.tools.some(({ name }) => name === "geloforge_context"));
  assert.match(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), /geloforge_context.+skills: true/);
});
