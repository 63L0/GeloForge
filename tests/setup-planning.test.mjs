import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../scripts/geloforge.mjs", import.meta.url));
for (const command of ["init", "adopt"]) {
  test(command + " previews and saves a pasted spec through the setup transaction", t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gf-planning-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dest = path.join(root, "project");
    if (command === "adopt") fs.mkdirSync(dest);
    const spec = "Support furniture quotes\nApprove the first estimate";
    const args = [cli, command, "--name", "Quote project", "--dest", dest, "--goal", spec, "--json"];
    const preview = JSON.parse(execFileSync(process.execPath, [...args, "--dry-run"]));
    assert.ok(preview.files.includes("brain/project-brief.md"));
    const brief = path.join(dest, "brain/project-brief.md");
    assert.ok(!fs.existsSync(brief));
    execFileSync(process.execPath, args);
    assert.ok(fs.readFileSync(brief, "utf8").includes(spec));
    assert.match(fs.readFileSync(path.join(dest, "brain/INDEX.md"), "utf8"), /project-brief.md/);
  });
}
