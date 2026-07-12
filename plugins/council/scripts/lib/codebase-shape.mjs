// Code-shape telemetry: a before→after snapshot of the codebase's STRUCTURE so a refactor
// run can be measured, not just felt. Files, lines, functions, and a cyclomatic-proxy
// complexity — pure + language-light (works off source text), so a run can report "−3
// files, −18 functions, −1,240 lines, complexity 812 → 640" and prove it simplified.
//
// Deliberately approximate (regex over JS/TS-ish source, not a full parser) — the VALUE is
// the DELTA between two snapshots of the SAME codebase measured the SAME way, where the
// approximation cancels out. Pure: the file list + reader are passed in / injectable.

const FUNCTION_RE = [
  /\bfunction\b\s*\*?\s*[A-Za-z0-9_$]*\s*\(/g, // function decl/expr
  /\b[A-Za-z0-9_$]+\s*\([^)]*\)\s*\{/g, // method shorthand  name(...) {  (approx)
  /=>/g // arrow functions
];
// Decision points → cyclomatic-complexity proxy (1 + branches per function-ish).
const BRANCH_RE = /\b(if|for|while|case|catch)\b|&&|\|\||\?\.|(?<![=!<>])\?(?!\.)/g;

const stripCommentsAndStrings = (src) =>
  String(src ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ") // line comments (not http://)
    .replace(/`(?:\\.|[^`\\])*`/g, "``") // template strings
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");

/** Count matches of a global regex without mutating shared lastIndex. */
function countMatches(re, text) {
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let n = 0;
  while (r.exec(text) !== null) n += 1;
  return n;
}

/** Shape metrics for ONE source string. Pure. */
export function fileShape(source) {
  const raw = String(source ?? "");
  const code = stripCommentsAndStrings(raw);
  const lines = raw.split(/\r?\n/);
  const codeLines = lines.filter((l) => l.trim() !== "").length;
  const functions = FUNCTION_RE.reduce((n, re) => n + countMatches(re, code), 0);
  const branches = countMatches(BRANCH_RE, code);
  return {
    lines: lines.length,
    codeLines,
    functions,
    branches,
    // cyclomatic proxy: one base path per function + one per decision point.
    complexity: Math.max(functions, 1) + branches
  };
}

/**
 * Aggregate shape over a set of files. `files` is a list of {id/path, source} OR a list of
 * paths with a `readFile(path)` reader. Pure given its inputs.
 */
export function computeShape(files, readFile) {
  const shape = { files: 0, lines: 0, codeLines: 0, functions: 0, branches: 0, complexity: 0, perFile: {} };
  for (const f of files ?? []) {
    const id = typeof f === "string" ? f : f.id ?? f.path ?? f.file;
    const src = typeof f === "string" ? (readFile ? readFile(f) : "") : f.source ?? (readFile ? readFile(id) : "");
    const s = fileShape(src);
    shape.files += 1;
    shape.lines += s.lines;
    shape.codeLines += s.codeLines;
    shape.functions += s.functions;
    shape.branches += s.branches;
    shape.complexity += s.complexity;
    shape.perFile[id] = s;
  }
  shape.avgComplexityPerFile = shape.files ? Math.round((shape.complexity / shape.files) * 10) / 10 : 0;
  return shape;
}

/** Signed delta between two shape snapshots (after − before), plus per-file churn if given. */
export function shapeDelta(before, after, gitDiffStat = null) {
  const d = (k) => (Number(after?.[k]) || 0) - (Number(before?.[k]) || 0);
  return {
    files: d("files"),
    lines: d("lines"),
    codeLines: d("codeLines"),
    functions: d("functions"),
    branches: d("branches"),
    complexity: d("complexity"),
    // line churn from git (added/removed/net) if the orchestrator supplies it
    linesAdded: gitDiffStat?.added ?? null,
    linesRemoved: gitDiffStat?.removed ?? null,
    // before→after headline pairs for the report
    before: { files: before?.files ?? 0, functions: before?.functions ?? 0, lines: before?.lines ?? 0, complexity: before?.complexity ?? 0 },
    after: { files: after?.files ?? 0, functions: after?.functions ?? 0, lines: after?.lines ?? 0, complexity: after?.complexity ?? 0 }
  };
}

/** Parse `git diff --numstat` (or a summed --shortstat) into {added, removed}. Pure. */
export function parseGitNumstat(numstat) {
  let added = 0;
  let removed = 0;
  for (const line of String(numstat ?? "").split(/\r?\n/)) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!m) continue;
    if (m[1] !== "-") added += Number(m[1]);
    if (m[2] !== "-") removed += Number(m[2]);
  }
  return { added, removed };
}
