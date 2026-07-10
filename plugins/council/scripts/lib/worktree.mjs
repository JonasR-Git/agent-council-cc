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

export function addWorktree(cwd, slug, baseRef) {
  const { root, branch, dir } = worktreePaths(cwd, slug);
  const base = baseRef || "HEAD";
  const res = runCommand("git", ["worktree", "add", "-b", branch, dir, base], { cwd: root });
  if (res.status !== 0) {
    return { ok: false, branch, dir, error: (res.stderr || res.stdout || "git worktree add failed").trim() };
  }
  return { ok: true, branch, dir };
}

export function removeWorktree(cwd, slug, { force = false } = {}) {
  const { root, branch, dir } = worktreePaths(cwd, slug);
  const args = ["worktree", "remove", dir];
  if (force) args.push("--force");
  const res = runCommand("git", args, { cwd: root });
  if (res.status !== 0) {
    return { ok: false, branch, dir, error: (res.stderr || res.stdout || "git worktree remove failed").trim() };
  }
  return { ok: true, branch, dir };
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
