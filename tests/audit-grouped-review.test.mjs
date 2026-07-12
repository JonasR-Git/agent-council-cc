import assert from "node:assert/strict";
import test from "node:test";

import { activeModels, runGroupedReview } from "../plugins/council/scripts/lib/audit-grouped-review.mjs";
import { normalizeFindings } from "../plugins/council/scripts/lib/audit-normalize.mjs";
import { tierOfLens } from "../plugins/council/scripts/lib/audit-tiers.mjs";
import { getLens } from "../plugins/council/scripts/lib/audit-lenses.mjs";

const MODEL = { files: [{ id: "a.mjs", loc: 10, branches: 2, maxNesting: 1, fanIn: 0, fanOut: 1, churn: 3, smellCount: 0, tested: false, hotspot: 5 }] };
const ALL_BACKENDS = { codex: { companionAvailable: true }, grok: { cli: { available: true } }, claude: { cli: { available: true } } };
// Deterministic, filesystem-free file access: a small readable source → chunkSource yields one chunk.
const FS = { readFile: () => "const x = 1;\nconst y = 2;\n", statSize: () => 40 };

test("activeModels reflects reachable, non-skipped seats", () => {
  assert.deepEqual(activeModels(ALL_BACKENDS, {}), ["codex", "grok", "claude"]);
  assert.deepEqual(activeModels(ALL_BACKENDS, { skipGrok: true }), ["codex", "claude"]);
  assert.deepEqual(activeModels({ codex: { companionAvailable: false }, grok: { cli: { available: false } }, claude: { cli: { available: false } } }, {}), []);
});

test("runGroupedReview: the cell-matrix path returns findings + six-eyes coverage.complete", async () => {
  let seenCells = 0;
  const runMatrix = async (cells) => {
    seenCells = cells.length;
    return {
      findings: [{ id: "codex-1", agent: "codex", severity: "P1", category: "security", title: "sqli in query builder", detail: "d", file: "a.mjs", line: 1, lens: "security_secrets" }],
      matrix: { summary: () => ({ models: 3, done: cells.length, failed: 0 }) },
      complete: true
    };
  };
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "lens", ledger: false }, { runMatrix, ...FS });
  assert.ok(out.findings.length >= 1);
  assert.equal(out.coverage.complete, true);
  assert.equal(out.coverage.groupPreset, "lens");
  assert.equal(out.coverage.ran, true);
  // lens preset = 13 groups × 1 file × 1 chunk × 3 models = 39
  assert.equal(seenCells, 39);
  assert.equal(out.coverage.cellsScheduled, 39);
  assert.deepEqual(out.coverage.reviewers, { codex: true, grok: true, claude: true });
});

test("runGroupedReview: a CAPPED run never claims complete coverage", async () => {
  const runMatrix = async () => ({ findings: [], matrix: { summary: () => ({}) }, complete: true });
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "fine", ledger: false, maxCells: 5 }, { runMatrix, ...FS });
  assert.equal(out.coverage.capped, true);
  assert.ok(out.coverage.cellsDropped > 0, "the overflow is surfaced");
  assert.equal(out.coverage.complete, false, "a capped run is never six-eyes complete");
});

test("runGroupedReview: no reachable reviewer → ran:false with a specific reason, no matrix call", async () => {
  let called = false;
  const runMatrix = async () => { called = true; return { findings: [], complete: true }; };
  const out = await runGroupedReview("/x", MODEL, { codex: {}, grok: {}, claude: {} }, { lensGroups: "lens", ledger: false }, { runMatrix, ...FS });
  assert.equal(out.coverage.ran, false);
  assert.equal(out.coverage.complete, false);
  assert.match(out.coverage.ranReason, /no reachable reviewer/);
  assert.equal(called, false, "nothing dispatched when no seat is reachable");
});

test("runGroupedReview: the group-authoritative lens survives merge (not re-derived from category)", async () => {
  // A security-group finding the model mislabels category 'bug' (→ categoryToLens='correctness').
  // Without re-stamping, mergeFindings drops the group lens and downstream normalize mis-tiers it.
  const runMatrix = async () => ({
    findings: [{ id: "codex-1", agent: "codex", severity: "P0", category: "bug", title: "unsanitized eval of user input", detail: "d", file: "a.mjs", line: 5, lens: "security_secrets" }],
    matrix: { summary: () => ({}) },
    complete: true
  });
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "tier", ledger: false }, { runMatrix, ...FS });
  assert.equal(out.findings[0].lens, "security_secrets", "group lens re-stamped onto the merged finding");
  // and it survives the consumer's normalize with a real lens + tier (not the category fallback)
  const norm = normalizeFindings(out.findings, {});
  assert.equal(norm[0].lens, "security_secrets");
  assert.ok(getLens(norm[0].lens));
  assert.equal(typeof tierOfLens(norm[0].lens), "number");
});

test("runGroupedReview: a cross-group merge keeps the most foundational (lowest-tier) lens", async () => {
  // Same defect surfaced under a quality group (docs_maintainability, tier 3) and a structure group
  // (architecture_ssot, tier 1). The merged finding must be handled at the higher-priority tier.
  const runMatrix = async () => ({
    findings: [
      { id: "codex-1", agent: "codex", severity: "P2", category: "docs", title: "god module mixes 5 concerns", detail: "d", file: "a.mjs", line: 3, lens: "docs_maintainability" },
      { id: "grok-1", agent: "grok", severity: "P2", category: "design", title: "god module mixes 5 concerns", detail: "d", file: "a.mjs", line: 3, lens: "architecture_ssot" }
    ],
    matrix: { summary: () => ({}) },
    complete: true
  });
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "tier", ledger: false }, { runMatrix, ...FS });
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].lens, "architecture_ssot", "lower-tier lens wins the merge");
  assert.ok(tierOfLens("architecture_ssot") < tierOfLens("docs_maintainability"), "sanity: structure < quality");
});

test("runGroupedReview: on a tier TIE the merge keeps the security lens (not id order)", async () => {
  // security_secrets and correctness are both tier 2; the correctness finding is FIRST. The merge
  // must still keep security_secrets so the P0 live-hole attribution survives.
  const runMatrix = async () => ({
    findings: [
      { id: "codex-1", agent: "codex", severity: "P1", category: "bug", title: "tainted path reaches exec", detail: "d", file: "a.mjs", line: 7, lens: "correctness" },
      { id: "grok-1", agent: "grok", severity: "P1", category: "security", title: "tainted path reaches exec", detail: "d", file: "a.mjs", line: 7, lens: "security_secrets" }
    ],
    matrix: { summary: () => ({}) },
    complete: true
  });
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "tier", ledger: false }, { runMatrix, ...FS });
  assert.equal(out.findings.length, 1);
  assert.equal(tierOfLens("security_secrets"), tierOfLens("correctness"), "sanity: same tier");
  assert.equal(out.findings[0].lens, "security_secrets", "security attribution wins the tie");
});

test("runGroupedReview: a defect seen by two seats on the same cell merges to consensus", async () => {
  const runMatrix = async () => ({
    findings: [
      { id: "codex-1", agent: "codex", severity: "P1", category: "security", title: "unescaped shell arg", detail: "d", file: "a.mjs", line: 12, lens: "security_secrets" },
      { id: "grok-1", agent: "grok", severity: "P1", category: "security", title: "unescaped shell arg", detail: "d", file: "a.mjs", line: 12, lens: "security_secrets" }
    ],
    matrix: { summary: () => ({}) },
    complete: true
  });
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "tier", ledger: false }, { runMatrix, ...FS });
  assert.equal(out.findings.length, 1, "the two seats' identical finding merges to one");
  assert.equal(out.findings[0].consensus, true, "≥2 agents → consensus");
  assert.deepEqual([...out.findings[0].agents].sort(), ["codex", "grok"]);
});

test("runGroupedReview: ONE seat's duplicate across two cells is NOT false consensus", async () => {
  const runMatrix = async () => ({
    findings: [
      { id: "codex-1", agent: "codex", severity: "P1", category: "security", title: "unescaped shell arg", detail: "d", file: "a.mjs", line: 12, lens: "security_secrets" },
      { id: "codex-2", agent: "codex", severity: "P1", category: "security", title: "unescaped shell arg", detail: "d", file: "a.mjs", line: 12, lens: "security_secrets" }
    ],
    matrix: { summary: () => ({}) },
    complete: true
  });
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "tier", ledger: false }, { runMatrix, ...FS });
  assert.equal(out.findings.length, 1, "the same seat's duplicate merges to one");
  assert.notEqual(out.findings[0].consensus, true, "one seat is never consensus");
  assert.deepEqual([...out.findings[0].agents], ["codex"]);
});

test("runGroupedReview: an oversized file is UNSUPPLIED — surfaced + forces PARTIAL coverage, no fake-clean cell", async () => {
  let seenCells = null;
  const runMatrix = async (cells) => { seenCells = cells.length; return { findings: [], matrix: { summary: () => ({}) }, complete: true }; };
  const oversize = { readFile: () => "x", statSize: () => 3_000_000 }; // > READ_MAX_BYTES (2e6)
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "lens", ledger: false }, { runMatrix, ...oversize });
  assert.deepEqual(out.coverage.filesUnsupplied, ["a.mjs"]);
  assert.equal(seenCells, 0, "an unsupplied file yields NO cells (no empty-source review)");
  assert.equal(out.coverage.complete, false, "matrix.complete:true is overridden — an unreviewed file can't be six-eyes complete");
});

test("runGroupedReview: an unreadable file is UNSUPPLIED, not a silent empty review", async () => {
  const runMatrix = async () => ({ findings: [], matrix: { summary: () => ({}) }, complete: true });
  const unreadable = { readFile: () => { throw new Error("EACCES"); }, statSize: () => 40 };
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "lens", ledger: false }, { runMatrix, ...unreadable });
  assert.deepEqual(out.coverage.filesUnsupplied, ["a.mjs"]);
  assert.equal(out.coverage.complete, false);
});

test("runGroupedReview: unitsReviewed derives from successful matrix results (mirrors runAuditReview)", async () => {
  const runMatrix = async () => ({
    findings: [],
    results: [{ ok: true, cell: { file: "a.mjs" } }, { ok: false, cell: { file: "a.mjs" } }],
    matrix: { summary: () => ({}) },
    complete: true
  });
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "lens", ledger: false }, { runMatrix, ...FS });
  assert.equal(out.coverage.unitsReviewed, 1, "a file with ≥1 successful cell counts reviewed");
  assert.equal(out.coverage.unitsAttempted, 1);
  assert.equal(out.coverage.unitsFailed, 0);
  assert.deepEqual(out.reviewed, ["a.mjs"]);
});

test("runGroupedReview: a file whose every cell failed is NOT counted reviewed", async () => {
  const runMatrix = async () => ({
    findings: [],
    results: [{ ok: false, cell: { file: "a.mjs" } }],
    matrix: { summary: () => ({}) },
    complete: false
  });
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "lens", ledger: false }, { runMatrix, ...FS });
  assert.equal(out.coverage.unitsReviewed, 0);
  assert.equal(out.coverage.unitsFailed, 1);
  assert.deepEqual(out.reviewed, []);
});

test("runGroupedReview: onProgress surfaces the planned cell count BEFORE dispatch", async () => {
  const msgs = [];
  const runMatrix = async () => ({ findings: [], matrix: { summary: () => ({}) }, complete: true });
  await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "lens", ledger: false, onProgress: (m) => msgs.push(m) }, { runMatrix, ...FS });
  assert.ok(msgs.some((m) => /grouped review:.*39 cell/.test(m)), "the cost is announced up front");
});
