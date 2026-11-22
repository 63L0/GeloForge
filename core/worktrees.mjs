import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getGitRepoInfo } from "./git-utils.mjs";
import { assertSafeWithinRoot, isSameOrInside, validateSlug } from "./path-safety.mjs";
import { withProjectLock } from "./project-lock.mjs";

function git(projectDir, ...args) {
  return execFileSync("git", ["-C", projectDir, ...args], {
    encoding: "utf8", windowsHide: true, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
  });
}

export function manageWorktrees({ projectDir, workspace = path.dirname(projectDir), action, name, ref = "HEAD" }) {
  const root = fs.realpathSync(path.resolve(workspace));
  const worktreesDir = assertSafeWithinRoot(root, "worktrees");
  if (isSameOrInside(worktreesDir, projectDir)) throw new Error("Worktrees must be outside the project's main checkout.");
  const info = getGitRepoInfo(projectDir);
  if (!info.isRepoRoot || info.unborn) throw new Error("Use an initialized Git project root with at least one commit.");

  const list = () => git(projectDir, "worktree", "list", "--porcelain", "-z").split("\0\0").flatMap((block) => {
    const [entry, head, branch, ...flags] = block.split("\0");
    if (!entry.startsWith("worktree ") || !head?.startsWith("HEAD ") || !branch?.startsWith("branch refs/heads/geloforge/")) return [];
    const target = path.resolve(entry.slice(9));
    if (path.dirname(target) !== worktreesDir || isSameOrInside(projectDir, target)) return [];
    return [{ path: target, name: path.basename(target), commit: head.slice(5), branch: branch.slice(18), locked: flags.some((flag) => flag.startsWith("locked")) }];
  });
  if (action === "list") return { worktrees: list() };

  validateSlug(name);
  const target = assertSafeWithinRoot(root, `worktrees/${name}`);
  return withProjectLock(projectDir, () => {
    if (action === "add") {
      const commit = git(projectDir, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`).trim();
      if (!/^[a-f0-9]{40,64}$/.test(commit) || fs.existsSync(target)) {
        throw new Error("Worktree target must be unused and the ref must resolve to a commit.");
      }
      fs.mkdirSync(worktreesDir, { recursive: true });
      git(projectDir, "worktree", "add", "-b", `geloforge/${name}`, "--", target, commit);
      return { path: target, branch: `geloforge/${name}`, commit };
    }
    const existing = list().find((item) => item.path === target && item.branch === `geloforge/${name}`);
    if (!existing) throw new Error("Managed worktree not found.");
    // Git's default removal can discard ignored files, including local runtime state.
    if (git(target, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching")) {
      throw new Error("Worktree contains uncommitted, untracked, or ignored files. Preserve them before removal.");
    }
    git(projectDir, "worktree", "remove", "--", target);
    return { ...existing, removed: true };
  });
}
