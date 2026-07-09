import fs from "node:fs";
import path from "node:path";

import { closeDanglingFence, wrapMarkdownFence } from "./markdown-fence.mjs";
import { runCommand, runCommandChecked } from "./process.mjs";

const MAX_DIFF_CHARS = 120_000;
const MAX_UNTRACKED_FILE_CHARS = 24_000;
const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".avif",
  ".bin",
  ".bmp",
  ".class",
  ".db",
  ".dll",
  ".dylib",
  ".eot",
  ".exe",
  ".flac",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".otf",
  ".pdf",
  ".png",
  ".rar",
  ".so",
  ".sqlite",
  ".tar",
  ".tgz",
  ".ttf",
  ".wasm",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip"
]);

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

export function globToRegExp(glob) {
  const normalized = String(glob ?? "").replace(/\\/g, "/");
  let pattern = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (ch === "*" && normalized[i + 1] === "*") {
      pattern += ".*";
      i += 1;
      continue;
    }
    if (ch === "*") {
      pattern += "[^/]*";
      continue;
    }
    if (ch === "?") {
      pattern += "[^/]";
      continue;
    }
    pattern += ch.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  pattern += "$";
  return new RegExp(pattern);
}

function normalizeSkipPaths(skipPaths = []) {
  return skipPaths.map((p) => String(p).replace(/\\/g, "/")).filter(Boolean);
}

function pathspecArgs(skipPaths = []) {
  const normalized = normalizeSkipPaths(skipPaths);
  if (!normalized.length) {
    return [];
  }
  return ["--", ".", ...normalized.map((p) => `:(exclude,glob)${p}`)];
}

function isSkipped(file, skipRegexps) {
  const normalized = String(file).replace(/\\/g, "/");
  return skipRegexps.some((re) => re.test(normalized));
}

function clip(text, max = MAX_DIFF_CHARS) {
  if (text.length <= max) {
    return text;
  }
  return closeDanglingFence(`${text.slice(0, max)}\n\n[... truncated ${text.length - max} chars ...]`);
}

function hashLite(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

function readHead(repoRoot) {
  const result = runCommand("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  if (result.status !== 0) {
    return "(no commits)";
  }
  return result.stdout.trim() || "(no commits)";
}

function assertBaseRef(repoRoot, baseRef) {
  const probe = runCommand("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], {
    cwd: repoRoot
  });
  if (probe.status !== 0) {
    throw new Error(`Base ref ${baseRef} not found - repo may have no commits yet`);
  }
}

function likelyBinaryFile(repoRoot, file) {
  if (BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) {
    return true;
  }
  const abs = path.join(repoRoot, file);
  let handle = null;
  try {
    handle = fs.openSync(abs, "r");
    const buf = Buffer.alloc(8192);
    const bytesRead = fs.readSync(handle, buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } catch {
    return true;
  } finally {
    if (handle != null) {
      try {
        fs.closeSync(handle);
      } catch {
        /* ignore */
      }
    }
  }
}

function readUntrackedFile(repoRoot, file) {
  const abs = path.join(repoRoot, file);
  const text = fs.readFileSync(abs, "utf8");
  if (text.length <= MAX_UNTRACKED_FILE_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_UNTRACKED_FILE_CHARS)}\n[... truncated ${text.length - MAX_UNTRACKED_FILE_CHARS} chars ...]`;
}

function collectUntrackedSections(repoRoot, skipPaths) {
  const skipRegexps = normalizeSkipPaths(skipPaths).map(globToRegExp);
  const result = runCommand("git", ["ls-files", "--others", "--exclude-standard", ...pathspecArgs(skipPaths)], {
    cwd: repoRoot
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    return [];
  }

  const sections = [];
  for (const file of result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    if (isSkipped(file, skipRegexps) || likelyBinaryFile(repoRoot, file)) {
      continue;
    }
    sections.push(["", `## new file: ${file}`, wrapMarkdownFence(readUntrackedFile(repoRoot, file))].join("\n"));
  }
  return sections;
}

export function collectReviewContext(cwd, target, opts = {}) {
  const skipPaths = opts.skipPaths ?? [];
  const repoRoot = ensureGitRepository(cwd);
  const head = readHead(repoRoot);
  const branch = runCommand("git", ["branch", "--show-current"], { cwd: repoRoot }).stdout.trim() || "(detached)";

  let content = "";
  let summary = "";

  if (target.mode === "working-tree") {
    const pathspec = pathspecArgs(skipPaths);
    const status = runCommandChecked(
      "git",
      ["status", "--short", "--untracked-files=all", ...pathspec],
      { cwd: repoRoot }
    ).stdout;
    const staged = runCommand("git", ["diff", "--cached", ...pathspec], { cwd: repoRoot }).stdout;
    const unstaged = runCommand("git", ["diff", ...pathspec], { cwd: repoRoot }).stdout;
    const untrackedSections = collectUntrackedSections(repoRoot, skipPaths);
    summary = status.trim() || "(clean working tree)";
    content = [
      "## git status",
      status || "(empty)",
      "",
      "## staged diff",
      staged || "(none)",
      "",
      "## unstaged diff",
      unstaged || "(none)",
      ...untrackedSections
    ].join("\n");
  } else {
    assertBaseRef(repoRoot, target.baseRef);
    const range = `${target.baseRef}...HEAD`;
    const pathspec = pathspecArgs(skipPaths);
    const stat = runCommand("git", ["diff", "--shortstat", range, ...pathspec], {
      cwd: repoRoot
    }).stdout.trim();
    const diff = runCommand("git", ["diff", range, ...pathspec], { cwd: repoRoot }).stdout;
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
    head,
    summary,
    target,
    content: clip(content),
    snapshotId: `${head === "(no commits)" ? "no-commits" : head.slice(0, 12)}+${hashLite(content)}`,
    collectionGuidance:
      target.mode === "working-tree"
        ? "Review uncommitted working-tree changes (staged + unstaged + untracked file bodies included below)."
        : `Review the branch diff against ${target.baseRef}.`
  };
}
