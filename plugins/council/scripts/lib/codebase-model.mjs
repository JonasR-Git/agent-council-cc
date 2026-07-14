import fs from "node:fs";
import path from "node:path";

import { buildGraph, findCycles, findOrphanModules } from "./import-graph.mjs";
import { findDuplicateClusters } from "./dup-detect.mjs";
import { runCommand } from "./process.mjs";
import { workspaceRoot } from "./state.mjs";

// The static fact base for the council audit engine (`/council:review --mode deep`) v1 (read-only). Zero-dep. The static
// analysis is deterministic for a given snapshot; git churn is time-relative (its
// window ends at run time) and is recorded explicitly. Everything emitted is a
// CANDIDATE (confidence-tagged), never authority to change anything - regex
// analysis cannot prove reachability/soundness.

const SOURCE_RE = /\.(mjs|cjs|js)$/;
// Segment-anchored so legitimate prefix-matching dirs (src/builders, src/output,
// src/vendorized) are NOT dropped; .min. is a filename marker, kept separate.
const IGNORE_RE = /(^|\/)(node_modules|dist|build|out|coverage|vendor)(\/|$)|\.min\.(js|css|mjs|cjs)/;
const GOD_FILE_LOC = 400;
const HIGH_BRANCHES = 60;
const BIG_CLONE_LINES = 12;

function toPosix(p) {
  return p.split(path.sep).join("/");
}

/**
 * Source files under the repo (tracked + untracked, minus gitignored), optionally
 * filtered to `areas` prefixes. Uses NUL-delimited `git ls-files` so filenames
 * with spaces/quotes/newlines survive; falls back to an fs walk outside a repo.
 */
function enumerateFiles(root, { areas } = {}) {
  const res = runCommand("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root });
  let rel;
  // git succeeded: trust it (an empty repo is genuinely empty — do NOT fall back to a
  // non-gitignore-aware walk that would leak dist/coverage). Only walk when git failed.
  // (Mirrors inventoryFiles below — the two enumerators must agree on what "empty" means.)
  if (res.status === 0) rel = res.stdout.length ? res.stdout.split("\0").filter(Boolean) : [];
  else rel = walk(root).map((abs) => toPosix(path.relative(root, abs)));
  const prefixes = (areas ?? []).map((a) => toPosix(a).replace(/\/+$/, ""));
  const seen = new Set();
  const files = [];
  for (const id of rel) {
    if (seen.has(id) || !SOURCE_RE.test(id) || IGNORE_RE.test(id)) continue;
    if (prefixes.length && !prefixes.some((p) => id === p || id.startsWith(`${p}/`))) continue;
    seen.add(id);
    let text;
    try {
      text = fs.readFileSync(path.join(root, id), "utf8");
    } catch {
      continue;
    }
    files.push({ id, text });
  }
  return files.sort((a, b) => a.id.localeCompare(b.id));
}

function walk(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (SOURCE_RE.test(e.name)) acc.push(full);
  }
  return acc;
}

// File classes so detectors can declare what they can PARSE — "mapped" (inventoried)
// never implies "parsed" (docs/audit-schema.md §4). The import-graph + complexity
// detectors parse only the "js" class today; everything else is mapped-only.
const FILE_CLASS = [
  [/\.(mjs|cjs|jsx?|tsx?)$/, "js"],
  [/(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|go\.(mod|sum)|cargo\.(toml|lock)|pom\.xml|composer\.(json|lock)|gemfile(\.lock)?)$/i, "manifest"],
  [/(^|\/)(\.github\/workflows\/|dockerfile|docker-compose|\.gitlab-ci|jenkinsfile|\.circleci\/|\.buildkite\/)/i, "ci"],
  [/\.(ya?ml|toml|ini|cfg|conf)$/i, "config"],
  [/(^|\/)\.env(\.|$)|\.(pem|key|p12|pfx|crt)$/i, "secret"],
  [/\.(md|mdx|rst|txt|adoc)$/i, "doc"],
  [/\.(py|rb|go|rs|java|kt|php|cs|swift|c|cc|cpp|h|hpp)$/i, "code-other"]
];

/** Classify a file for detector eligibility (js | manifest | ci | config | secret | doc | code-other | other). */
export function fileClassOf(id) {
  for (const [re, cls] of FILE_CLASS) if (re.test(String(id ?? ""))) return cls;
  return "other";
}

function walkAll(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkAll(full, acc);
    else acc.push(full);
  }
  return acc;
}

/**
 * Full inventory: EVERY non-ignored file (tracked + untracked, minus gitignored),
 * tagged with its fileClass — not just the JS subset enumerateFiles returns for the
 * graph. Lets coverage report the whole mapped surface (and what is only mapped, not
 * parsed) honestly. Bodies are not read here (cheap); the reviewer supplies source.
 */
export function inventoryFiles(root, { areas } = {}) {
  const res = runCommand("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root });
  let rel;
  // git succeeded: trust it (an empty repo is genuinely empty — do NOT fall back to a
  // non-gitignore-aware walk that would leak dist/coverage). Only walk when git failed.
  if (res.status === 0) rel = res.stdout.length ? res.stdout.split("\0").filter(Boolean) : [];
  else rel = walkAll(root).map((abs) => toPosix(path.relative(root, abs)));
  const prefixes = (areas ?? []).map((a) => toPosix(a).replace(/\/+$/, ""));
  const seen = new Set();
  const out = [];
  for (const id of rel) {
    if (seen.has(id) || IGNORE_RE.test(id)) continue;
    if (prefixes.length && !prefixes.some((p) => id === p || id.startsWith(`${p}/`))) continue;
    seen.add(id);
    out.push({ id, fileClass: fileClassOf(id) });
  }
  // Deterministic codepoint sort (locale-independent) so the inventory + any baseline
  // diff derived from it is reproducible across machines.
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function fileFacts(text) {
  const lines = String(text).split(/\r?\n/);
  const loc = lines.filter((l) => l.trim()).length;
  // Approximate: counts every brace (incl. object/array literals + destructuring),
  // so it overstates true block nesting for data-heavy modules. Used only as a
  // rough hotspot input.
  let depth = 0;
  let maxNesting = 0;
  for (const ch of text) {
    if (ch === "{") {
      depth += 1;
      if (depth > maxNesting) maxNesting = depth;
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
    }
  }
  const count = (re) => (text.match(re) ?? []).length;
  const branches = count(/\b(if|for|while|case|catch)\b/g) + count(/&&|\|\|/g) + count(/\?[^.:]/g);
  const smells = {
    emptyCatch: count(/catch\s*(\([^)]*\))?\s*\{\s*\}/g),
    console: count(/\bconsole\.\w+/g),
    todo: count(/\b(TODO|FIXME|HACK|XXX)\b/g),
    ignore: count(/@ts-ignore|eslint-disable/g)
  };
  const smellCount = smells.emptyCatch + smells.console + smells.todo + smells.ignore;
  return { loc, maxNesting, branches, smells, smellCount };
}

/** git commits touching each file in the last `days` days -> { map, ok }. */
function churnMap(root, days) {
  const map = new Map();
  // -z: NUL-delimited + unquoted raw filenames, so keys align with enumerateFiles'
  // `git ls-files -z` ids. Without -z, git C-quotes non-ASCII paths (core.quotePath
  // default true) and churn would silently miss every non-ASCII filename.
  const res = runCommand("git", ["log", `--since=${days}.days`, "--name-only", "-z", "--pretty=format:"], { cwd: root, timeout: 30_000 });
  if (res.status !== 0 || res.error) return { map, ok: false };
  for (const chunk of res.stdout.split("\0")) {
    const id = chunk.trim();
    if (id) map.set(id, (map.get(id) ?? 0) + 1);
  }
  return { map, ok: true };
}

const isTestId = (id) => /\.test\.(mjs|cjs|js)$/.test(id) || /(^|\/)tests?\//.test(id);

/** Source modules a test file resolves an import to (via the graph) -> "tested". */
function testedSet(nodes) {
  const tested = new Set();
  for (const [id, node] of nodes) {
    if (!isTestId(id)) continue;
    for (const t of node.out) if (!isTestId(t)) tested.add(t);
  }
  return tested;
}

function norm(v, max) {
  return max > 0 ? v / max : 0;
}

/**
 * Build the codebase model + candidate findings + coverage. Pure aside from
 * reading files/git under `cwd`.
 */
export function buildCodebaseModel(cwd, { areas, churnDays = 90 } = {}) {
  const root = workspaceRoot(cwd);
  const files = enumerateFiles(root, { areas });
  const nodes = buildGraph(files);
  // Entry points (a shebang, or the plugin CLIs) are legitimately never imported.
  const entrypoints = new Set(files.filter((f) => f.text.startsWith("#!") || /companion\.mjs$/.test(f.id)).map((f) => f.id));
  const cycles = findCycles(nodes);
  const orphans = findOrphanModules(nodes, { entrypoints });
  const churn = churnMap(root, churnDays);
  const tested = testedSet(nodes);

  const facts = files.map((f) => {
    const ff = fileFacts(f.text);
    const node = nodes.get(f.id);
    return {
      id: f.id,
      loc: ff.loc,
      maxNesting: ff.maxNesting,
      branches: ff.branches,
      smells: ff.smells,
      smellCount: ff.smellCount,
      churn: churn.map.get(f.id) ?? 0,
      fanIn: node ? node.in.size : 0,
      fanOut: node ? node.out.size : 0,
      exports: node ? node.exports.size + (node.hasDefault ? 1 : 0) : 0,
      isTest: isTestId(f.id),
      tested: tested.has(f.id)
    };
  });

  const max = (sel) => facts.reduce((m, x) => Math.max(m, sel(x)), 0);
  const mx = { loc: max((x) => x.loc), branches: max((x) => x.branches), churn: max((x) => x.churn), smell: max((x) => x.smellCount), fanIn: max((x) => x.fanIn) };
  for (const x of facts) {
    x.hotspot = Math.round(
      20 *
        (norm(x.loc, mx.loc) +
          norm(x.branches, mx.branches) +
          norm(x.churn, mx.churn) +
          norm(x.smellCount, mx.smell) +
          norm(x.fanIn, mx.fanIn))
    );
  }
  facts.sort((a, b) => b.hotspot - a.hotspot || a.id.localeCompare(b.id));

  // Clones in tests/generated code are noise; scan production modules only.
  const dupClusters = findDuplicateClusters(files.filter((f) => !isTestId(f.id)), { minLines: 6 });
  const findings = buildFindings({ facts, cycles, orphans, dupClusters });

  // Expose the import-graph EDGES (JSON-safe adjacency) so downstream consumers can
  // compute dependents/importers without re-parsing: expandScope's blast radius, the
  // Tier-0 detector's fact-base, and the M6 codemod planner all need this.
  const importers = {};
  const importsOf = {};
  const exportsOf = {};
  const hasDefault = {};
  const opaque = {};
  for (const [id, n] of nodes) {
    importers[id] = [...n.in].sort();
    importsOf[id] = [...n.out].sort();
    exportsOf[id] = [...n.exports].sort();
    hasDefault[id] = Boolean(n.hasDefault);
    opaque[id] = Boolean(n.opaque);
  }

  const supplied = facts.reduce((s, x) => s + x.loc, 0);
  return {
    files: facts,
    graph: { cycles, orphans, importers, imports: importsOf, exports: exportsOf, hasDefault, opaque, entrypoints: [...entrypoints].sort() },
    dupClusters,
    findings,
    coverage: {
      modules: files.length,
      sourceModules: facts.filter((x) => !x.isTest).length,
      mappedLOC: supplied,
      churnWindowDays: churnDays,
      churnAvailable: churn.ok
    }
  };
}

function buildFindings({ facts, cycles, orphans, dupClusters }) {
  const f = [];
  const add = (o) => f.push({ severity: "P2", confidence: 0.6, scope: "localized", ...o });

  for (const c of dupClusters) {
    add({
      category: "ssot",
      // Calibrate: only large clones are P1; short repeated shapes are P2.
      severity: c.lineCount >= BIG_CLONE_LINES ? "P1" : "P2",
      scope: "cross-cutting",
      confidence: 0.75,
      title: `Duplicated ${c.lineCount}-line block in ${c.locations.length} places`,
      detail: `Candidate copy-paste / parallel implementation. Consider consolidating to one source of truth. Locations: ${c.locations.map((l) => `${l.file}:${l.startLine}-${l.endLine}`).join(" · ")}`,
      file: c.locations[0].file,
      line: c.locations[0].startLine
    });
  }
  for (const cyc of cycles) {
    add({ category: "architecture", severity: "P1", scope: "cross-cutting", confidence: 0.5, title: `Import cycle among ${cyc.length} modules`, detail: `Cycle members (candidate, regex-derived; order is not an edge walk): ${cyc.join(", ")}`, file: cyc[0], line: null });
  }
  for (const d of orphans) {
    add({ category: "orphan", confidence: 0.35, title: `Orphan module (no in-repo importer): ${d.id}`, detail: `No module in the scanned set imports it (LOW confidence & module-level only: individual unused export NAMES are not detected; entry points, package exports, dynamic/external consumers are invisible - verify before removing). Exports: ${d.exports.slice(0, 8).join(", ")}${d.hasDefault ? ", default" : ""}`, file: d.id, line: null });
  }
  for (const x of facts) {
    if (x.isTest) continue;
    if (x.loc > GOD_FILE_LOC) add({ category: "complexity", title: `Large module (${x.loc} LOC): ${x.id}`, detail: `Above ${GOD_FILE_LOC} LOC; a hotspot for bugs and a candidate to split.`, file: x.id, line: null });
    if (x.branches > HIGH_BRANCHES) add({ category: "complexity", title: `High branch density (${x.branches}): ${x.id}`, detail: "Many control-flow branches; review the hottest functions.", file: x.id, line: null });
    if (x.smells.emptyCatch > 0) add({ category: "correctness", severity: "P2", confidence: 0.7, title: `${x.smells.emptyCatch} empty catch block(s): ${x.id}`, detail: "Swallowed errors hide failures; confirm each is intentional.", file: x.id, line: null });
    if (x.smells.todo > 0) add({ category: "docs", severity: "nit", confidence: 0.9, title: `${x.smells.todo} TODO/FIXME/HACK marker(s): ${x.id}`, detail: "Tracked debt markers.", file: x.id, line: null });
    if (x.exports > 0 && !x.tested) add({ category: "test", severity: "P2", confidence: 0.4, title: `No test references ${x.id}`, detail: "Exports with no apparent test file mention (heuristic).", file: x.id, line: null });
  }
  const rank = { P0: 0, P1: 1, P2: 2, nit: 3 };
  return f.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.confidence - a.confidence));
}

/** Human-readable v1 report. Everything is a read-only candidate. */
export function renderAuditReport(model, { limit = 60 } = {}) {
  const L = [];
  const c = model.coverage;
  L.push("# Council Audit (v1 - static, read-only candidates)");
  L.push("");
  L.push(`Scanned ${c.modules} modules (${c.sourceModules} source, ${c.mappedLOC} LOC). Findings are CANDIDATES - verify before acting; nothing was changed.`);
  L.push("");

  const byCat = new Map();
  for (const x of model.findings) byCat.set(x.category, (byCat.get(x.category) ?? 0) + 1);
  L.push("## Findings by category");
  for (const [cat, n] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) L.push(`- ${cat}: ${n}`);
  L.push("");

  L.push(`## Findings (${model.findings.length}, most severe first)`);
  for (const x of model.findings.slice(0, limit)) {
    L.push(`- **${x.severity}** [${x.category}] ${x.title} · conf ${x.confidence} · ${x.scope}${x.line ? ` · ${x.file}:${x.line}` : x.file ? ` · ${x.file}` : ""}`);
    if (x.detail) L.push(`  ${x.detail}`);
  }
  if (model.findings.length > limit) L.push(`… and ${model.findings.length - limit} more (use --json for all).`);
  L.push("");

  L.push("## Top hotspots (complexity × fan-in × churn × smells)");
  for (const x of model.files.filter((f) => !f.isTest).slice(0, 12)) {
    L.push(`- ${x.hotspot}  ${x.id}  (loc ${x.loc}, branches ${x.branches}, churn ${x.churn}, fan-in ${x.fanIn}${x.smellCount ? `, smells ${x.smellCount}` : ""})`);
  }
  L.push("");
  L.push("Next: review the top hotspots + P1 candidates; consolidation of duplicated blocks is a *proposal*, not applied.");
  return L.join("\n");
}
