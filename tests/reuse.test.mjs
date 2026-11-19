import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapProject } from "../scripts/bootstrap-project.mjs";
import { validateProject } from "../core/project-validator.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_DIR = path.resolve(__dirname, "..");

function snapshotHashes(rootDir) {
  const hashes = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const digest = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
        hashes.set(path.relative(rootDir, full).replace(/\\/g, "/"), digest);
      }
    }
  };
  walk(rootDir);
  return hashes;
}

test("web and desktop profiles reuse the same Second Brain core without modifying harness files", () => {
  const before = snapshotHashes(HARNESS_DIR);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-reuse-"));

  try {
    const webDir = path.join(tmp, "sample-web-app");
    const desktopDir = path.join(tmp, "sample-desktop-app");

    const webRes = bootstrapProject({
      name: "Sample Web App",
      profile: "web",
      dest: webDir,
      git: true,
    });
    const desktopRes = bootstrapProject({
      name: "Sample Desktop App",
      profile: "desktop",
      dest: desktopDir,
      git: true,
    });

    assert.equal(webRes.profile, "web");
    assert.equal(desktopRes.profile, "desktop");
    assert.equal(validateProject(webDir).valid, true);
    assert.equal(validateProject(desktopDir).valid, true);

    // Core Second Brain entrypoint files are identical across profiles.
    for (const sharedFile of ["AGENTS.md", "GEMINI.md"]) {
      assert.equal(
        fs.readFileSync(path.join(webDir, sharedFile), "utf8"),
        fs.readFileSync(path.join(desktopDir, sharedFile), "utf8"),
        `${sharedFile} should share identical provider-neutral entrypoint`
      );
    }

    // Profile guides and .gitignore additions differ cleanly by domain.
    const webProfile = fs.readFileSync(path.join(webDir, "brain", "profile.md"), "utf8");
    const desktopProfile = fs.readFileSync(path.join(desktopDir, "brain", "profile.md"), "utf8");
    assert.match(webProfile, /Project Profile: Web/);
    assert.match(desktopProfile, /Project Profile: Desktop/);
    assert.match(fs.readFileSync(path.join(webDir, ".gitignore"), "utf8"), /\.next\//);
    assert.match(fs.readFileSync(path.join(desktopDir, ".gitignore"), "utf8"), /\.exe/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }

  const after = snapshotHashes(HARNESS_DIR);
  assert.deepEqual(after, before, "Harness core files must remain completely untouched when creating projects");
});
