import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { adoptProject } from "../core/adopt-project.mjs";
import { createTask, listTasks, getTask } from "../core/task-manager.mjs";
import { validateProject } from "../core/project-validator.mjs";
import { parseYaml } from "../core/yaml-subset.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_DIR = path.resolve(__dirname, "..");
const CLI_PATH = path.join(HARNESS_DIR, "scripts", "geloforge.mjs");

test("task new, list, and show create schema-valid monotonic contracts and honor custom tasks_dir", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-task-"));
  try {
    const repoDir = path.join(tmp, "service");
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "src", "server.mjs"), "export const port = 3000;\n", "utf8");
    adoptProject({ dest: repoDir, name: "Service App", tasksDir: "ops-tasks", evidenceDir: "ops-evidence" });

    // Dry run creates nothing
    const dry = createTask({ projectDir: repoDir, title: "Dry run task", dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.id, "TASK-0001");
    assert.equal(fs.existsSync(dry.filePath), false);

    // Create TASK-0001 and activate in brain/state/current.yaml
    const t1 = createTask({
      projectDir: repoDir,
      title: "Add health check endpoint",
      priority: "high",
      activate: true,
      requiredInputs: ["src/server.mjs"],
      acceptanceCriteria: ["GET /health returns 200 JSON"],
      createdAt: "2026-11-19T12:00:00Z",
    });
    assert.equal(t1.id, "TASK-0001");
    assert.equal(t1.relPath.startsWith("ops-tasks/TASK-0001-"), true);
    assert.equal(t1.activated, true);

    const stateAfter = parseYaml(fs.readFileSync(path.join(repoDir, "brain", "state", "current.yaml"), "utf8"));
    assert.deepEqual(stateAfter.active_tasks, ["TASK-0001"]);
    assert.equal(stateAfter.status, "active");

    // Create TASK-0002 depending on TASK-0001 via CLI using CWD discovery (no --project!)
    const cliNew = spawnSync(
      process.execPath,
      [CLI_PATH, "task", "new", "--title", "Document health endpoint", "--dep", "TASK-0001", "--json"],
      { cwd: path.join(repoDir, "src"), encoding: "utf8", windowsHide: true }
    );
    assert.equal(cliNew.status, 0, cliNew.stderr);
    const t2 = JSON.parse(cliNew.stdout);
    assert.equal(t2.id, "TASK-0002");

    // Reject duplicate explicit ID
    assert.throws(
      () => createTask({ projectDir: repoDir, id: "TASK-0001", title: "Duplicate test" }),
      /Duplicate record ID "TASK-0001"/
    );

    // Reject secret content or non-existent --input
    assert.throws(
      () => createTask({ projectDir: repoDir, title: "Use key " + "AKIA" + "1234567890ABCDEF" }),
      /credential-like/i
    );
    assert.throws(
      () => createTask({ projectDir: repoDir, title: "Bad input", requiredInputs: ["src/missing.mjs"] }),
      /does not exist/
    );

    // List and show
    const all = listTasks({ projectDir: repoDir });
    assert.equal(all.tasks.length, 2);
    const activeOnly = listTasks({ projectDir: repoDir, status: "active" });
    assert.equal(activeOnly.tasks.length, 1);
    assert.equal(activeOnly.tasks[0].id, "TASK-0001");

    const shown = getTask({ projectDir: repoDir, taskId: "TASK-0002" });
    assert.deepEqual(shown.record.dependencies, ["TASK-0001"]);

    // CLI task list & show without --project
    const cliShow = spawnSync(process.execPath, [CLI_PATH, "task", "show", "TASK-0001", "--json"], {
      cwd: repoDir,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(cliShow.status, 0, cliShow.stderr);
    assert.equal(JSON.parse(cliShow.stdout).id, "TASK-0001");

    assert.equal(validateProject(repoDir).valid, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});
