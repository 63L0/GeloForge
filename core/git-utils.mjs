/**
 * Shared, project-scoped Git inspection helpers for GeloForge.
 * Ensures subproject operations never leak sibling files from a parent Git repository,
 * handles unborn HEAD and non-Git directories safely, and strips forbidden secret paths.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isForbiddenSecretPath } from "./path-safety.mjs";

function runGit(projectDir, args, maxBuffer = 8 * 1024 * 1024) {
  return execFileSync("git", ["-C", projectDir, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function getGitRepoInfo(projectDir) {
  const resolvedProj = path.resolve(projectDir);
  try {
    const inside = runGit(resolvedProj, ["rev-parse", "--is-inside-work-tree"]).trim();
    if (inside !== "true") {
      return {
        available: false,
        isRepoRoot: false,
        relPrefix: "",
        branch: null,
        head: null,
        unborn: false,
      };
    }
  } catch {
    return {
      available: false,
      isRepoRoot: false,
      relPrefix: "",
      branch: null,
      head: null,
      unborn: false,
    };
  }

  let isRepoRoot = false;
  let relPrefix = "";
  try {
    const topLevel = runGit(resolvedProj, ["rev-parse", "--show-toplevel"]).trim();
    const realProj = fs.realpathSync(resolvedProj);
    const realTop = fs.realpathSync(topLevel);
    const rel = path.relative(realTop, realProj).replace(/\\/g, "/");
    isRepoRoot = rel === "";
    relPrefix = rel;
  } catch {
    isRepoRoot = fs.existsSync(path.join(resolvedProj, ".git"));
  }

  let branch = null;
  try {
    branch = runGit(resolvedProj, ["symbolic-ref", "--short", "HEAD"]).trim() || null;
  } catch {
    try {
      const abbrev = runGit(resolvedProj, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
      branch = abbrev && abbrev !== "HEAD" ? abbrev : abbrev || null;
    } catch {
      branch = null;
    }
  }

  let head = null;
  let unborn = false;
  try {
    head = runGit(resolvedProj, ["rev-parse", "HEAD"]).trim() || null;
  } catch {
    head = null;
    unborn = true;
  }

  return {
    available: true,
    isRepoRoot,
    relPrefix,
    branch,
    head,
    unborn,
  };
}

export function getGitStatusScoped(projectDir, warnings = null) {
  const info = getGitRepoInfo(projectDir);
  if (!info.available) {
    return {
      ...info,
      dirty: false,
      dirtyCount: 0,
      changedFiles: [],
    };
  }

  const rawChanged = [];
  let entryCount = 0;
  try {
    const statusOut = runGit(projectDir, ["status", "--porcelain", "-z", "-uall", "--", "."]);
    const tokens = statusOut.split("\0").filter(Boolean);
    const prefixSlash = info.relPrefix ? `${info.relPrefix}/` : "";

    for (let i = 0; i < tokens.length; i += 1) {
      const entry = tokens[i];
      if (entry.length < 4) continue;
      const xy = entry.slice(0, 2);
      let filePath = entry.slice(3).replace(/\\/g, "/");
      if (xy.includes("R") || xy.includes("C")) {
        i += 1;
      }
      if (!info.isRepoRoot && prefixSlash) {
        if (!filePath.startsWith(prefixSlash)) {
          continue;
        }
        filePath = filePath.slice(prefixSlash.length);
      }
      if (!filePath) continue;
      entryCount += 1;
      if (isForbiddenSecretPath(filePath)) {
        if (Array.isArray(warnings)) {
          warnings.push(`Excluded sensitive changed path from git status: ${filePath}`);
        }
        continue;
      }
      rawChanged.push(filePath);
    }
  } catch (err) {
    if (Array.isArray(warnings)) {
      warnings.push(`Unable to collect scoped git status: ${err.message}`);
    }
  }

  const changedFiles = Array.from(new Set(rawChanged)).sort((a, b) => a.localeCompare(b));
  return {
    ...info,
    dirty: entryCount > 0,
    dirtyCount: entryCount,
    changedFiles,
  };
}

export function listGitVisibleFiles(projectDir, warnings = null) {
  const info = getGitRepoInfo(projectDir);
  if (!info.available || !info.isRepoRoot) {
    return null;
  }
  try {
    const out = runGit(
      projectDir,
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      16 * 1024 * 1024
    );
    const paths = out.split("\0").filter(Boolean);
    return { mode: "git-ls-files", paths };
  } catch (err) {
    if (Array.isArray(warnings) && fs.existsSync(path.join(projectDir, ".git"))) {
      warnings.push(`Git discovery failed (${err.message}); falling back to filesystem walk.`);
    }
    return null;
  }
}
