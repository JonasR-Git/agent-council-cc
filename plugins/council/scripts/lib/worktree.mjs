import path from "node:path";

import { runCommand } from "./process.mjs";
import { workspaceRoot } from "./state.mjs";

/**
 * Isolated git worktrees for single-writer solve implementations, so a writer
 * (Codex/Grok/Claude) works on its own checkout + branch without disturbing the
 * main tree. Convention: branch `council-solve/<slug>`, worktree under
 * `<repo>/../<repo-name>-council-<slug>`.
 */

export function sanitizeSlug(slug) {
  return (
    String(slug ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "work"
  );
}

export function worktreePaths(cwd, slug) {
  const root = workspaceRoot(cwd);
  const clean = sanitizeSlug(slug);
  const branch = `council-solve/${clean}`;
  const dir = path.join(path.dirname(root), `${path.basename(root)}-council-${clean}`);
  return { root, branch, dir, slug: clean };
}

function branchExists(root, branch) {
  return runCommand("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root }).status === 0;
}

export function addWorktree(cwd, slug, baseRef) {
  const { root, branch, dir } = worktreePaths(cwd, slug);
  // 1. A worktree for this branch already exists -> return it (crash/retry safe).
  const existing = listWorktrees(cwd).find((e) => e.branch === branch);
  if (existing) {
    return { ok: true, branch, dir: existing.path, reused: true };
  }
  // 2. The branch exists but has no worktree (remove keeps the branch for
  //    review/merge, and the fixloop re-adds the same slug) -> attach it, no -b.
  // 3. New branch -> create it with -b from base.
  const reattaching = branchExists(root, branch);
  const args = reattaching
    ? ["worktree", "add", dir, branch]
    : ["worktree", "add", "-b", branch, dir, baseRef || "HEAD"];
  const res = runCommand("git", args, { cwd: root });
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || "git worktree add failed").trim();
    const hint = /already exists|already checked out/i.test(detail)
      ? ` (target dir taken - remove it or use a new slug)`
      : "";
    return { ok: false, branch, dir, error: `${detail}${hint}` };
  }
  return { ok: true, branch, dir, reattached: reattaching };
}

export function hasUncommittedChanges(dir) {
  const res = runCommand("git", ["status", "--porcelain"], { cwd: dir });
  return res.status === 0 && res.stdout.trim().length > 0;
}

export function removeWorktree(cwd, slug, { force = false } = {}) {
  const { root, branch, dir } = worktreePaths(cwd, slug);
  const entry = listWorktrees(cwd).find((e) => e.branch === branch);
  const wtDir = entry?.path ?? dir;
  // Refuse to discard uncommitted work unless explicitly forced - `git worktree
  // remove --force` deletes it silently otherwise.
  if (!force && hasUncommittedChanges(wtDir)) {
    return {
      ok: false,
      branch,
      dir: wtDir,
      uncommitted: true,
      error: `Worktree has uncommitted changes; commit them or re-run with --force to discard.`
    };
  }
  const args = ["worktree", "remove", wtDir];
  if (force) args.push("--force");
  const res = runCommand("git", args, { cwd: root });
  if (res.status !== 0) {
    return { ok: false, branch, dir: wtDir, error: (res.stderr || res.stdout || "git worktree remove failed").trim() };
  }
  return { ok: true, branch, dir: wtDir };
}

export function listWorktrees(cwd) {
  const root = workspaceRoot(cwd);
  const res = runCommand("git", ["worktree", "list", "--porcelain"], { cwd: root });
  if (res.status !== 0) return [];
  const entries = [];
  let current = {};
  for (const line of res.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current.path) entries.push(current);
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace("refs/heads/", "");
    }
  }
  if (current.path) entries.push(current);
  return entries.filter((e) => (e.branch ?? "").startsWith("council-solve/"));
}
