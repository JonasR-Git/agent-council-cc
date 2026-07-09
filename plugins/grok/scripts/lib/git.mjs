import { runCommand, runCommandChecked } from "./process.mjs";

const MAX_DIFF_CHARS = 120_000;

export function ensureGitRepository(cwd) {
  const result = runCommand("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (result.error && result.error.code === "ENOENT") {
    throw new Error("git is not installed.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = runCommand("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd });
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }
  for (const candidate of ["main", "master"]) {
    const probe = runCommand("git", ["rev-parse", "--verify", candidate], { cwd });
    if (probe.status === 0) {
      return candidate;
    }
  }
  return "main";
}

export function resolveReviewTarget(cwd, options = {}) {
  const scope = options.scope ?? "auto";
  const base = options.base ?? null;

  if (scope === "branch" || base) {
    const baseRef = base || detectDefaultBranch(cwd);
    return {
      mode: "branch",
      baseRef,
      label: `branch vs ${baseRef}`
    };
  }

  if (scope === "working-tree" || scope === "auto") {
    return {
      mode: "working-tree",
      baseRef: null,
      label: "uncommitted changes"
    };
  }

  throw new Error(`Unsupported review scope: ${scope}`);
}

function clip(text, max = MAX_DIFF_CHARS) {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n\n[... truncated ${text.length - max} chars ...]`;
}

export function collectReviewContext(cwd, target) {
  const repoRoot = ensureGitRepository(cwd);
  const branch = runCommand("git", ["branch", "--show-current"], { cwd: repoRoot }).stdout.trim() || "(detached)";

  let content = "";
  let summary = "";

  if (target.mode === "working-tree") {
    const status = runCommandChecked("git", ["status", "--short", "--untracked-files=all"], {
      cwd: repoRoot
    }).stdout;
    const staged = runCommand("git", ["diff", "--cached"], { cwd: repoRoot }).stdout;
    const unstaged = runCommand("git", ["diff"], { cwd: repoRoot }).stdout;
    summary = status.trim() || "(clean working tree)";
    content = [
      "## git status",
      status || "(empty)",
      "",
      "## staged diff",
      staged || "(none)",
      "",
      "## unstaged diff",
      unstaged || "(none)"
    ].join("\n");
  } else {
    const range = `${target.baseRef}...HEAD`;
    const stat = runCommand("git", ["diff", "--shortstat", range], { cwd: repoRoot }).stdout.trim();
    const diff = runCommand("git", ["diff", range], { cwd: repoRoot }).stdout;
    const log = runCommand("git", ["log", "--oneline", `${target.baseRef}..HEAD`], {
      cwd: repoRoot
    }).stdout;
    summary = stat || "(no branch diff)";
    content = [
      `## commits (${target.baseRef}..HEAD)`,
      log || "(none)",
      "",
      `## diff (${range})`,
      diff || "(empty)"
    ].join("\n");
  }

  return {
    repoRoot,
    branch,
    summary,
    target,
    content: clip(content),
    collectionGuidance:
      target.mode === "working-tree"
        ? "Review uncommitted working-tree changes (staged + unstaged + untracked listed in status)."
        : `Review the branch diff against ${target.baseRef}.`
  };
}
