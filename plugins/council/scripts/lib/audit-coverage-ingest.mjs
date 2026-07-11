// Coverage ingestion (docs/enterprise-fix-design.md §5). Parse REAL coverage (lcov or
// istanbul coverage-final.json) into a per-file set of EXECUTED lines, so a fix whose
// changed lines aren't run by any test can be downgraded to propose-only — only then
// does "tests green" actually mean the change was exercised. Pure: text/JSON in,
// executed-line map out; no I/O.

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
  const data = typeof json === "string" ? JSON.parse(json) : (json ?? {});
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

// Coverage paths are often absolute while findings are repo-relative; match by suffix
// when there's no exact key.
function lookup(coverage, file) {
  const f = posix(file);
  if (coverage.has(f)) return coverage.get(f);
  for (const [k, v] of coverage) if (k.endsWith(`/${f}`) || f.endsWith(`/${k}`) || k.endsWith(f) || f.endsWith(k)) return v;
  return null;
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
