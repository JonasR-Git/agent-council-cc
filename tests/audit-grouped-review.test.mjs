import assert from "node:assert/strict";
import test from "node:test";

import { activeModels, runGroupedReview } from "../plugins/council/scripts/lib/audit-grouped-review.mjs";
import { normalizeFindings } from "../plugins/council/scripts/lib/audit-normalize.mjs";
import { partitionByRefutation, shouldVerify } from "../plugins/council/scripts/lib/verify.mjs";
import { tierOfLens } from "../plugins/council/scripts/lib/audit-tiers.mjs";
import { getLens } from "../plugins/council/scripts/lib/audit-lenses.mjs";

const MODEL = { files: [{ id: "a.mjs", loc: 10, branches: 2, maxNesting: 1, fanIn: 0, fanOut: 1, churn: 3, smellCount: 0, tested: false, hotspot: 5 }] };
const ALL_BACKENDS = { codex: { companionAvailable: true }, grok: { cli: { available: true } }, claude: { cli: { available: true } } };
// Deterministic, filesystem-free file access: a small readable source → chunkSource yields one chunk.
const FS = { readFile: () => "const x = 1;\nconst y = 2;\n", statSize: () => 40 };
// Adversarial refutation is DEFAULT-ON (A1, mirroring the per-file audit path). Tests that are not
// about refutation and DO surface a single-agent P0/P1 opt out, so they never reach a real CLI.
const NO_VERIFY = { verifyAudit: false };

/**
 * A fake refutation verifier honoring the REAL verify.mjs contract: it only targets what
 * shouldVerify() allows (P0/P1, non-consensus), CHARGES the injected budget per call, leaves a
 * budget-starved target UNVERIFIED (never dropped), and partitions through the REAL
 * partitionByRefutation with the caller's demote posture — so the annotate-only wiring is pinned
 * end-to-end without a CLI.
 */
function fakeVerifier({ refute = () => true } = {}) {
  const seen = { calls: [], options: null, repoRoot: null, evidence: null };
  const fn = async (cwd, backends, options, merged, buildEvidence, repoRoot) => {
    seen.options = options;
    seen.repoRoot = repoRoot;
    seen.evidence = buildEvidence;
    const refutations = new Map();
    let verified = 0;
    for (const f of merged.all ?? []) {
      if (!shouldVerify(f, options.verifySeverities ?? ["P0", "P1"])) continue;
      if (options.budget && !options.budget.canSpend(1)) continue; // starved → keep it, unverified
      options.budget?.charge(1);
      seen.calls.push(f.title);
      verified += 1;
      refutations.set(f, { by: "grok", refuted: Boolean(refute(f)), reason: "no caller can reach this branch", demotable: true });
    }
    return partitionByRefutation(merged, refutations, verified, { demote: options.demote !== false });
  };
  return { fn, seen };
}

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
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "lens", ledger: false, ...NO_VERIFY }, { runMatrix, ...FS });
  assert.ok(out.findings.length >= 1);
  assert.equal(out.coverage.complete, true);
  assert.equal(out.coverage.groupPreset, "lens");
  assert.equal(out.coverage.ran, true);
  // lens preset = 13 groups × 1 file × 1 chunk × 3 models = 39
  assert.equal(seenCells, 39);
  assert.equal(out.coverage.cellsScheduled, 39);
  assert.deepEqual(out.coverage.reviewers, { codex: true, grok: true, claude: true });
});

test("runGroupedReview: a CAPPED run is not COMPLETE (report) but IS passComplete (loop) — council R9", async () => {
  const runMatrix = async () => ({ findings: [], matrix: { summary: () => ({}) }, complete: true });
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "fine", ledger: false, maxCells: 5 }, { runMatrix, ...FS });
  assert.equal(out.coverage.capped, true);
  assert.ok(out.coverage.cellsDropped > 0, "the overflow is surfaced");
  assert.equal(out.coverage.complete, false, "strict complete: a capped run is never six-eyes complete (one-shot report honesty)");
  assert.equal(out.coverage.passComplete, true, "passComplete: the SCHEDULED cells were all reviewed — cap is a caveat, not re-reviewable work, so it must NOT block loop convergence forever");
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
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "tier", ledger: false, ...NO_VERIFY }, { runMatrix, ...FS });
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
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "tier", ledger: false, ...NO_VERIFY }, { runMatrix, ...FS });
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

test("runGroupedReview: an all-EMPTY (0-byte) readable scope is vacuously COMPLETE, not failed", async () => {
  // A readable 0-byte file yields 0 cells and is NOT unsupplied. With every selected file empty the
  // matrix gets 0 cells; sixEyesComplete([]) is fail-closed false, but there is nothing to review, so
  // the run must report complete + not count the empty file as failed (council Codex C1 / Opus O3).
  let seenCells = null;
  const runMatrix = async (cells) => { seenCells = cells.length; return { findings: [], results: [], matrix: { summary: () => ({}) }, complete: false }; };
  const empty = { readFile: () => "", statSize: () => 0 };
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "lens", ledger: false }, { runMatrix, ...empty });
  assert.equal(seenCells, 0, "an empty file schedules no cells");
  assert.deepEqual(out.coverage.filesUnsupplied, [], "an empty file is NOT unsupplied");
  assert.equal(out.coverage.complete, true, "nothing to review → vacuously complete");
  assert.equal(out.coverage.unitsFailed, 0, "the empty file is not miscounted as a failed unit");
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

test("runGroupedReview: --completeness-critic OFF → no completeness keys on coverage (byte-identical default)", async () => {
  const runMatrix = async () => ({ findings: [], matrix: { summary: () => ({}) }, complete: true });
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "lens", ledger: false }, { runMatrix, ...FS });
  assert.equal("completenessComplete" in out.coverage, false, "the critic is opt-in — no signal, no key");
});

test("runGroupedReview: --completeness-critic ON, critic says thorough → coverage.completenessComplete true (1 critic call)", async () => {
  let criticCalls = 0;
  const runMatrix = async () => ({ findings: [], matrix: { summary: () => ({}) }, complete: true });
  const runCritic = async () => { criticCalls += 1; return '{"complete": true, "gaps": []}'; };
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "lens", ledger: false, completenessCritic: true }, { runMatrix, runCritic, ...FS });
  assert.equal(out.coverage.completenessComplete, true);
  assert.equal(out.coverage.completenessCriticRan, true);
  assert.equal(criticCalls, 1, "exactly one completeness-critic call per pass");
});

test("runGroupedReview: --completeness-critic ON, critic finds a gap → coverage.completenessComplete false + gaps surfaced", async () => {
  const runMatrix = async () => ({ findings: [], matrix: { summary: () => ({}) }, complete: true });
  const runCritic = async () => '{"complete": false, "gaps": [{"class":"concurrency","where":"pool.mjs","why":"no race findings"}]}';
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "lens", ledger: false, completenessCritic: true }, { runMatrix, runCritic, ...FS });
  assert.equal(out.coverage.completenessComplete, false);
  assert.ok(out.coverage.completenessGaps.includes("concurrency"));
});

test("runGroupedReview: the completeness-critic call is CHARGED to budgetSpent (cells + 1; council Codex/Claude P2)", async () => {
  const runMatrix = async (cells) => ({ findings: [], matrix: { summary: () => ({}), incompleteTriples: () => [] }, triples: [], complete: true, _n: cells.length });
  const runCritic = async () => '{"complete": true, "gaps": []}';
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "lens", ledger: false, completenessCritic: true }, { runMatrix, runCritic, ...FS });
  // lens preset = 39 cells; the critic adds one paid call
  assert.equal(out.coverage.cellsScheduled, 39);
  assert.equal(out.coverage.budgetSpent, 40, "the extra critic call is charged, not hidden");
});

test("runGroupedReview: matrix EXTRA calls (parse repairs + rate-limit retries) are CHARGED to budgetSpent (council Grok P1/P2)", async () => {
  // A parse repair and a rate-limit retry each RE-INVOKE a seat runner — each is another PAID agent call.
  // Omitting them let a garbled/throttled pass spawn far more calls than it reported, so the fix loop
  // paced itself off a spend figure that was too low and could materially over-run its budget.
  const runMatrix = async (cells) => ({
    findings: [],
    matrix: { summary: () => ({}), incompleteTriples: () => [] },
    triples: [],
    complete: true,
    repairCalls: 4,
    retryCalls: 3,
    extraCalls: 7,
    _n: cells.length
  });
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "lens", ledger: false, ...NO_VERIFY }, { runMatrix, ...FS });
  assert.equal(out.coverage.cellsScheduled, 39);
  assert.equal(out.coverage.budgetSpent, 46, "39 cells + 7 extra (4 repairs + 3 retries) — every paid call is charged");
  assert.equal(out.coverage.repairCalls, 4, "surfaced so the operator sees WHY the pass cost more than its cell count");
  assert.equal(out.coverage.retryCalls, 3);
});

test("runGroupedReview: a CAPPED pass + critic-complete → completenessComplete TRUE (no persistent-false pin; council Codex/Claude P2)", async () => {
  // the pin bug: passing all-selected files as expected scope made a capped pass permanently 'missing' →
  // completenessComplete false every pass → the loop could never converge. The fix drops expected scope,
  // so a capped pass whose scheduled cells are done + critic says complete is completenessComplete:true.
  const runMatrix = async () => ({ findings: [], matrix: { summary: () => ({}), incompleteTriples: () => [] }, triples: [], complete: true });
  const runCritic = async () => '{"complete": true, "gaps": []}';
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "fine", ledger: false, maxCells: 5, completenessCritic: true }, { runMatrix, runCritic, ...FS });
  assert.equal(out.coverage.capped, true, "sanity: this pass IS capped");
  assert.equal(out.coverage.completenessComplete, true, "a cap is a surfaced caveat, not a convergence-blocking gap");
});

// ── A1: adversarial refutation on the GROUPED path (it used to return `refuted: []` unconditionally —
// no model ever challenged a grouped finding, so every single-agent P0/P1 stayed "verification_required"
// forever and the report gate was permanently indeterminate).
const SINGLE_P1 = [{ id: "codex-1", agent: "codex", severity: "P1", category: "bug", title: "off-by-one drops the last row", detail: "d", file: "a.mjs", line: 4, lens: "correctness" }];
const matrixWith = (findings) => async (cells) => ({ findings, results: cells.map((c) => ({ ok: true, cell: c })), matrix: { summary: () => ({}) }, complete: true });

test("runGroupedReview: the grouped path REFUTES a single-agent P0/P1 (annotate-only, never dropped)", async () => {
  const v = fakeVerifier({ refute: () => true });
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "lens", ledger: false }, { runMatrix: matrixWith(SINGLE_P1), verifyFindings: v.fn, ...FS });

  assert.deepEqual(v.seen.calls, ["off-by-one drops the last row"], "the single-agent P1 was adversarially re-checked");
  assert.equal(v.seen.options.demote, false, "ANNOTATE-ONLY posture (same as the per-file audit path)");
  assert.equal(typeof v.seen.options.budget?.charge, "function", "the verifier gets a real budget object, not the loop's raw cell number");
  assert.equal(out.refuted.length, 1, "the refuted finding is surfaced in the low-confidence bucket (was ALWAYS [] before)");
  assert.equal(out.coverage.refutedCount, 1);
  // annotate-only: it STAYS visible in `findings`, carrying the verifier's verdict — a wrongly-refuted
  // REAL defect must never be silently erased, only deprioritized.
  assert.equal(out.findings.length, 1, "not dropped from .all");
  assert.equal(out.findings[0].verified.refuted, true);
  assert.equal(out.findings[0].verified.by, "grok");
  // …and downstream it lands in the WEAKEST evidence state — never "confirmed"/"verification_required"
  // (the inversion audit-normalize guards against).
  const norm = normalizeFindings(out.findings, {});
  assert.equal(norm[0].lifecycle, "refuted");
});

test("runGroupedReview: a SUPPORTED finding is confirmed, not refuted (no inversion)", async () => {
  const v = fakeVerifier({ refute: () => false });
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "lens", ledger: false }, { runMatrix: matrixWith(SINGLE_P1), verifyFindings: v.fn, ...FS });
  assert.equal(out.refuted.length, 0);
  assert.equal(out.coverage.refutedCount, 0);
  assert.equal(out.findings[0].verified.refuted, false);
  const norm = normalizeFindings(out.findings, {});
  assert.equal(norm[0].lifecycle, "confirmed", "an independently SUPPORTED finding leaves verification_required limbo");
});

test("runGroupedReview: refutation calls are CHARGED to budgetSpent (a verifier spawn is a paid call)", async () => {
  const v = fakeVerifier({ refute: () => true });
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "lens", ledger: false }, { runMatrix: matrixWith(SINGLE_P1), verifyFindings: v.fn, ...FS });
  assert.equal(out.coverage.cellsScheduled, 39); // lens preset = 13 groups × 1 file × 3 seats
  assert.equal(out.coverage.verifySpent, 1);
  assert.equal(out.coverage.budgetSpent, 40, "cells + the refutation call — the loop must see every paid call");
});

test("runGroupedReview: verifyAudit:false → nothing is verified and the budget is byte-identical", async () => {
  const v = fakeVerifier({ refute: () => true });
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "lens", ledger: false, verifyAudit: false }, { runMatrix: matrixWith(SINGLE_P1), verifyFindings: v.fn, ...FS });
  assert.deepEqual(v.seen.calls, [], "the verifier is never invoked when the option is off");
  assert.deepEqual(out.refuted, []);
  assert.equal(out.coverage.refutedCount, 0);
  assert.equal(out.coverage.verifySpent, 0);
  assert.equal(out.coverage.budgetSpent, 39, "cells only — no hidden spend");
  assert.equal(out.findings.length, 1, "the finding is still surfaced, just unverified");
});

test("runGroupedReview: a CONSENSUS finding is never refuted — no verifier spawn is wasted on it", async () => {
  const consensus = [
    { id: "codex-1", agent: "codex", severity: "P0", category: "security", title: "unescaped shell arg", detail: "d", file: "a.mjs", line: 12, lens: "security_secrets" },
    { id: "grok-1", agent: "grok", severity: "P0", category: "security", title: "unescaped shell arg", detail: "d", file: "a.mjs", line: 12, lens: "security_secrets" }
  ];
  const v = fakeVerifier({ refute: () => true });
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "lens", ledger: false }, { runMatrix: matrixWith(consensus), verifyFindings: v.fn, ...FS });
  assert.equal(out.findings[0].consensus, true);
  assert.deepEqual(v.seen.calls, [], "independent agreement is protected — one refuter can't overturn it");
  assert.deepEqual(out.refuted, []);
  assert.equal(out.coverage.verifySpent, 0);
});

test("runGroupedReview: a single reachable seat → NO refutation (a finding is never refuted by its author)", async () => {
  const only = { codex: { companionAvailable: true }, grok: { cli: { available: false } }, claude: { cli: { available: false } } };
  const v = fakeVerifier({ refute: () => true });
  const out = await runGroupedReview("/x", MODEL, only, { lensGroups: "lens", ledger: false }, { runMatrix: matrixWith(SINGLE_P1), verifyFindings: v.fn, ...FS });
  assert.deepEqual(activeModels(only, {}), ["codex"]);
  assert.deepEqual(v.seen.calls, [], "with one seat there is no independent refuter");
  assert.deepEqual(out.refuted, []);
  assert.equal(out.findings.length, 1, "and the finding is still surfaced — fail-closed, never dropped");
});

test("runGroupedReview: the refutation fan-out is BOUNDED — a starved target is kept UNVERIFIED, not dropped", async () => {
  const two = [
    SINGLE_P1[0],
    { id: "codex-2", agent: "codex", severity: "P1", category: "bug", title: "null deref on empty input", detail: "d", file: "a.mjs", line: 9, lens: "correctness" }
  ];
  const v = fakeVerifier({ refute: () => true });
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "lens", ledger: false, verifyMaxCalls: 1 }, { runMatrix: matrixWith(two), verifyFindings: v.fn, ...FS });
  assert.equal(v.seen.options.budget.total, 1, "the cap bounds the verifier's budget");
  assert.equal(v.seen.calls.length, 1, "only what the budget affords is spawned");
  assert.equal(out.coverage.verifySpent, 1);
  assert.equal(out.coverage.budgetSpent, 40);
  assert.equal(out.findings.length, 2, "the budget-starved finding is KEPT (unverified), never silently dropped");
  assert.equal(out.findings.filter((f) => f.verified).length, 1);
});

test("runGroupedReview: onProgress surfaces the planned cell count BEFORE dispatch", async () => {
  const msgs = [];
  const runMatrix = async () => ({ findings: [], matrix: { summary: () => ({}) }, complete: true });
  await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "lens", ledger: false, onProgress: (m) => msgs.push(m) }, { runMatrix, ...FS });
  assert.ok(msgs.some((m) => /grouped review:.*39 cell/.test(m)), "the cost is announced up front");
});
