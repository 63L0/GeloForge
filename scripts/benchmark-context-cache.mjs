import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { bootstrapProject } from "./bootstrap-project.mjs";
import { compileContext } from "../core/context-compiler.mjs";
import { compileCachedContext } from "../core/context-cache.mjs";

const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "geloforge-cache-bench-"));
const query = "workflow validation and local test evidence";
const projects = ["Cache Project One", "Cache Project Two", "Cache Project Three"].map((name, i) => ({
  name, projectDir: path.join(temporary, `project-${i}`), query,
}));

try {
  for (const { name, projectDir } of projects) {
    bootstrapProject({ name, dest: projectDir, git: false });
    for (let i = 0; i < 36; i += 1) {
      const rel = path.join(projectDir, "brain", "lessons");
      fs.mkdirSync(rel, { recursive: true });
      fs.writeFileSync(path.join(rel, `lesson-${i}.md`), `# Workflow evidence ${name} ${i}\n${"Capture local test evidence and validate routing. ".repeat(140)}\n`);
    }
  }
  const measures = [];
  for (const { name, ...options } of projects) {
    const coldStart = performance.now();
    const uncached = compileContext(options);
    const uncachedMs = performance.now() - coldStart;
    assert.equal(compileCachedContext(options).diskCache, "miss");
    const warmStart = performance.now();
    const warm = compileCachedContext(options);
    const cachedMs = performance.now() - warmStart;
    assert.equal(warm.diskCache, "hit");
    assert.equal(warm.markdown, uncached.markdown);
    assert.equal(warm.manifest.project_id, uncached.manifest.project_id);
    measures.push({ name, uncachedMs: Number(uncachedMs.toFixed(2)), cachedMs: Number(cachedMs.toFixed(2)) });
  }
  const [first, second, third] = projects;
  fs.appendFileSync(path.join(first.projectDir, "brain", "requirements", "constraints.md"), "\nAlways validate distinct project constraints.\n");
  const changed = compileCachedContext(first);
  assert.equal(changed.diskCache, "miss");
  assert.match(changed.markdown, /validate distinct project constraints/);
  assert.equal(compileCachedContext(second).diskCache, "hit");
  assert.equal(compileCachedContext(third).diskCache, "hit");
  const added = path.join(first.projectDir, "brain", "lessons", "new-lesson.md");
  fs.writeFileSync(added, "# Workflow validation and local test evidence\nUnique new audit data.\n");
  assert.equal(compileCachedContext(first).diskCache, "miss");
  fs.unlinkSync(added);
  assert.equal(compileCachedContext(first).diskCache, "miss");
  console.table(measures);
  console.log("Three projects retained separate packets. Editing, adding, and removing inputs invalidated only the changed project's cache.");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 });
}
