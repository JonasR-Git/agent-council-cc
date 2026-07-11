// Coverage ingestion (docs/enterprise-fix-design.md §5). Parse REAL coverage (lcov or
// istanbul coverage-final.json) into a per-file set of EXECUTED lines, so a fix whose
// changed lines aren't run by any test can be downgraded to propose-only — only then
// does "tests green" actually mean the change was exercised. Pure: text/JSON in,
// executed-line map out; no I/O.
//
// Scope (honest MVP): lcov + istanbul, i.e. JS-first. Python (pytest --cov-report=lcov)
// and Go (gcov2lcov) reach this via lcov; JaCoCo XML is NOT parsed (out of MVP scope).
// Coverage is LINE/STATEMENT granularity, not BRANCH: a line can read "covered" while a
// branch the fix adds on it (e.g. a §6 fail-open `??`/`||` fallback) was never taken —
// those classes are already propose-only via isSensitiveClass, but note the gap.

const posix = (p) =>
  String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");

/** Parse lcov text -> Map<posixFile, Set<executedLine>> (only DA lines with hits > 0). */
export function parseLcov(text) {
  const map = new Map();
  let file = null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      file = posix(line.slice(3));
      if (!map.has(file)) map.set(file, new Set());
    } else if (line.startsWith("DA:") && file) {
      const [ln, hits] = line.slice(3).split(",");
      if (Number(hits) > 0) map.get(file).add(Number(ln));
    } else if (line === "end_of_record") {
      file = null;
    }
  }
  return map;
}

/** Parse istanbul coverage-final.json -> Map<posixFile, Set<executedLine>>. */
export function parseIstanbul(json) {
  let data = json ?? {};
  if (typeof json === "string") {
    try {
      data = JSON.parse(json);
    } catch {
      return new Map(); // a corrupt report degrades to "no coverage" (fail-closed), never throws
    }
  }
  const map = new Map();
  for (const [rawPath, cov] of Object.entries(data)) {
    const file = posix(cov?.path ?? rawPath);
    const executed = new Set();
    const stmtMap = cov?.statementMap ?? {};
    const s = cov?.s ?? {};
    for (const [id, loc] of Object.entries(stmtMap)) {
      if ((s[id] ?? 0) > 0) {
        const start = Number(loc?.start?.line);
        const end = Number(loc?.end?.line ?? start);
        if (Number.isFinite(start)) for (let ln = start; ln <= (Number.isFinite(end) ? end : start); ln += 1) executed.add(ln);
      }
    }
    map.set(file, executed);
  }
  return map;
}

/** Union-merge lcov + istanbul executed-line maps into one coverage map. */
export function ingestCoverage({ lcov, istanbul } = {}) {
  const merged = new Map();
  const add = (m) => {
    for (const [f, set] of m) {
      if (!merged.has(f)) merged.set(f, new Set());
      for (const ln of set) merged.get(f).add(ln);
    }
  };
  if (lcov) add(parseLcov(lcov));
  if (istanbul) add(parseIstanbul(istanbul));
  return merged;
}

// Resolve a finding's file to a coverage entry. Exact (case-insensitive) match first;
// else a SEGMENT-BOUNDARY suffix match, but ONLY when it is UNIQUE — an ambiguous suffix
// (a repeated leaf name like index/utils/types, a vendored fork, a fixture mirror of
// lib/) is treated as ABSENT (fail-closed), never guessed, because a wrong bind would
// credit an untested fix with another file's coverage. No bare, non-boundary suffixes.
function lookup(coverage, file) {
  const f = posix(file).toLowerCase();
  for (const [k, v] of coverage) if (posix(k).toLowerCase() === f) return v;
  let hit = null;
  let count = 0;
  for (const [k, v] of coverage) {
    const kk = posix(k).toLowerCase();
    if (kk.endsWith(`/${f}`) || f.endsWith(`/${kk}`)) {
      hit = v;
      count += 1;
    }
  }
  return count === 1 ? hit : null; // ambiguous or none -> uncovered (fail-closed)
}

/**
 * Parse `git diff --unified=0` output -> the NEW-side line numbers that were added or
 * modified (the changed-line set the coverage gate judges). Pure text parser over the
 * `@@ -a,b +c,d @@` hunk headers.
 */
export function parseDiffLines(diffText) {
  const out = [];
  const re = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
  for (const raw of String(diffText ?? "").split(/\r?\n/)) {
    const m = re.exec(raw);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] == null ? 1 : Number(m[2]);
    for (let i = 0; i < count; i += 1) out.push(start + i);
  }
  return out;
}

/**
 * Coverage verdict for the changed lines of a file. Returns
 * { covered, uncovered, allCovered }. A file absent from coverage -> every line
 * uncovered (no test executed it) -> allCovered false. An empty `lines` list is treated
 * as NOT covered (nothing to prove executed) so a caller can fail-closed.
 */
export function coverageOfLines(coverage, file, lines = []) {
  const set = lookup(coverage, file) ?? new Set();
  const covered = [];
  const uncovered = [];
  for (const ln of lines) (set.has(Number(ln)) ? covered : uncovered).push(Number(ln));
  return { covered, uncovered, allCovered: lines.length > 0 && uncovered.length === 0 };
}
