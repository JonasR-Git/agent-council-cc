// WAVE 3 (epoch-sweep) — the (file,tier) LIVELOCK CIRCUIT-BREAKER. docs/epoch-sweep-design.md §D6.
// A test-GREEN fix that CHANGES a file's content without RESOLVING the finding re-hashes the file → its
// cells re-open → the SAME finding recurs → it is re-fixed → oscillation. Neither F-A's test-red counter
// (the fix "succeeded") nor seenFixed (dedupes reporting) catches it; only maxPasses/budget bound it today.
// These tests drive the REAL runFixLoop sweep path with fakes and assert the breaker TRIPS within
// LIVELOCK_MAX_CYCLES, QUARANTINES the file (surfacing its finding as a proposal), lets the tier SETTLE
// (does NOT spin to maxPasses), and converges — plus that a legitimate one-shot fix never trips it, and the
// quarantine memory survives a --resume. All deterministic (injected fs/clock, no model/CLI calls).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LIVELOCK_MAX_CYCLES, runFixLoop } from "../plugins/council/scripts/lib/audit-fixloop.mjs";
import { makeFixLoopDeps } from "../plugins/council/scripts/lib/audit-fixloop-deps.mjs";
import { buildManifest, expectedKeys, makeTierSweepCursor, scopeGroupsForTier } from "../plugins/council/scripts/lib/audit-tier-sweep.mjs";
import { resolveLensGroups } from "../plugins/council/scripts/lib/audit-lens-groups.mjs";
import { chunkSource } from "../plugins/council/scripts/lib/audit-group-prompt.mjs";

function cursorOn(store) {
  return makeTierSweepCursor("/led", {
    deps: {
      readFile: (p) => store.get(p) ?? "",
      appendFile: (p, d) => store.set(p, (store.get(p) ?? "") + d),
      fsyncFile: () => {},
      existsFile: (p) => store.has(p),
      writeFile: (p, d) => store.set(p, d),
      now: () => 0
    }
  });
}
const REVIEWERS = [
  { seat: "codex", backend: "codex", model: "gpt-5-codex", effort: "high" },
  { seat: "grok", backend: "grok", model: "grok-4", effort: "high" },
  { seat: "claude", backend: "claude", model: "opus", effort: "high" }
];
const BACKENDS = { codex: { companionAvailable: true }, grok: { cli: { available: true } }, claude: { cli: { available: true } } };
const MODEL = { files: [{ id: "a.mjs", isTest: false, hotspot: 2, loc: 1, branches: 0 }, { id: "b.mjs", isTest: false, hotspot: 1, loc: 1, branches: 0 }] };

function mkWorkspace() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-livelock-"));
  fs.writeFileSync(path.join(tmp, "a.mjs"), "export const a = 1;\n");
  fs.writeFileSync(path.join(tmp, "b.mjs"), "export function b() { return 2; }\n");
  return tmp;
}
const rmWorkspace = (tmp) => fs.rmSync(tmp, { recursive: true, force: true });

// A fake grouped review that marks every scheduled cell DONE through the SAME key path expectedKeys uses,
// and can inject findings per (tier, pass).
function mkFakeGroupedReview(tmp, reviewedLog, opts = {}) {
  return async (cwd, scopedModel, backends, options) => {
    const selected = scopedModel.files.map((f) => f.id);
    reviewedLog.push({ tier: options.tier, files: [...selected] });
    const scoped = scopeGroupsForTier(resolveLensGroups(options.lensGroups), options.tier);
    const chunksOf = (f) => chunkSource(fs.readFileSync(path.join(tmp, f), "utf8"));
    const manifest = buildManifest({ files: selected, chunksOf, isSupplied: () => true });
    for (const k of expectedKeys(manifest, options.tier, scoped, options.sweep.reviewerSet, options.sweep.epochHash)) {
      options.sweep.cursor.markDone(k, { pass: options.pass });
    }
    const findings = opts.findingsFor ? opts.findingsFor(options.tier, options.pass) : [];
    return { findings, coverage: { ran: true, passComplete: true, complete: true, budgetSpent: selected.length, unitsSelected: selected.length, unitsReviewed: selected.length } };
  };
}
const sweepOpts = (over = {}) => ({ epochSweep: true, lensGroups: "tier", perTierConvergence: true, structureAutoApply: false, maxUnits: 5, ...over });

// ── THE LIVELOCK: a test-GREEN fix that never resolves the finding is quarantined, the tier settles ──────

test("LIVELOCK: a fix that stays test-GREEN + mutates content but never resolves the finding trips the breaker within LIVELOCK_MAX_CYCLES, quarantines the file, surfaces a proposal, and the tier SETTLES (does not spin to maxPasses)", async () => {
  const tmp = mkWorkspace();
  try {
    const log = [];
    // a.mjs surfaces the SAME tier-2 finding EVERY pass (the fix never resolves it)
    const gr = mkFakeGroupedReview(tmp, log, {
      findingsFor: (tier) => tier === 2 ? [{ file: "a.mjs", lens: "correctness", category: "correctness", severity: "P1", title: "stubborn bug", line: 1, tier: 2 }] : []
    });
    let mutations = 0;
    // the fixer ALWAYS "succeeds" on a.mjs (test-green) but writes DIFFERENT content each time (new hash) —
    // so the content hash is self-limiting for condition (a) yet the finding recurs → condition (b) trips.
    const oscillatingFix = async (cwd, actionable) => {
      const hit = (actionable ?? []).filter((f) => (f.file ?? f.location?.path) === "a.mjs");
      if (hit.length) {
        mutations += 1;
        fs.writeFileSync(path.join(tmp, "a.mjs"), `export const a = ${mutations}; // churn ${mutations}\n`);
        return { fixed: hit.map((f) => ({ file: "a.mjs", finding: f })), failed: [], rejected: [], changedFiles: ["a.mjs"], spent: 1, branch: "council/x", ok: true };
      }
      return { fixed: [], failed: [], rejected: [], changedFiles: [], spent: 0, branch: "council/x", ok: true };
    };
    const opts = sweepOpts();
    const cursor = cursorOn(new Map());
    let cp = null;
    const deps = makeFixLoopDeps(tmp, MODEL, BACKENDS, opts, { runGroupedReview: gr, runAuditFix: oscillatingFix, tierSweepCursor: cursor });
    const out = await runFixLoop(tmp, { ...opts, budget: 2000, maxPasses: 40, dryStreak: 1 }, { ...deps, checkpoint: (s) => { cp = s; } });

    assert.match(out.stopReason, /epoch-sweep converged/, "the run converges (the tier settles) — it does NOT spin to maxPasses");
    assert.ok(out.passesRun < 40, `converged well under maxPasses (spun to ${out.passesRun})`);
    assert.ok(mutations <= LIVELOCK_MAX_CYCLES, `the fixer stopped mutating a.mjs after quarantine (≤ LIVELOCK_MAX_CYCLES fixes, got ${mutations})`);
    assert.equal(out.fixed.length, 1, "only the FIRST fix counts as a durable 'fixed' (the recurrences are the oscillation, not progress)");
    assert.ok((out.proposed ?? []).some((p) => /livelock/i.test(p.rejectedReason ?? "")), "the un-resolvable finding is SURFACED as a proposal for human review");
    assert.ok(cp?.sweep?.livelock?.excluded?.includes("a.mjs"), "a.mjs is quarantined in the checkpointed breaker state (resume keeps the oscillation memory)");
    // b.mjs (no finding) is NOT quarantined — the breaker is surgical, not a whole-run stop.
    assert.ok(!cp.sweep.livelock.excluded.includes("b.mjs"), "b.mjs (converged normally) is NOT quarantined");
  } finally {
    rmWorkspace(tmp);
  }
});

test("LIVELOCK negative: a legitimate one-shot fix that RESOLVES the finding never trips the breaker (no false quarantine)", async () => {
  const tmp = mkWorkspace();
  try {
    const log = [];
    let fixed = false;
    // the finding is offered once, then RESOLVED — a.mjs is fixed a single time and the finding is gone
    const gr = mkFakeGroupedReview(tmp, log, {
      findingsFor: (tier) => (tier === 2 && !fixed) ? [{ file: "a.mjs", lens: "correctness", category: "correctness", severity: "P1", title: "real bug", line: 1, tier: 2 }] : []
    });
    const resolvingFix = async (cwd, actionable) => {
      const hit = (actionable ?? []).filter((f) => (f.file ?? f.location?.path) === "a.mjs");
      if (hit.length) {
        fixed = true;
        fs.writeFileSync(path.join(tmp, "a.mjs"), "export const a = 2; // fixed\n");
        return { fixed: hit.map((f) => ({ file: "a.mjs", finding: f })), failed: [], rejected: [], changedFiles: ["a.mjs"], spent: 1, branch: "council/x", ok: true };
      }
      return { fixed: [], failed: [], rejected: [], changedFiles: [], spent: 0, branch: "council/x", ok: true };
    };
    const opts = sweepOpts();
    const cursor = cursorOn(new Map());
    let cp = null;
    const deps = makeFixLoopDeps(tmp, MODEL, BACKENDS, opts, { runGroupedReview: gr, runAuditFix: resolvingFix, tierSweepCursor: cursor });
    const out = await runFixLoop(tmp, { ...opts, budget: 2000, maxPasses: 40, dryStreak: 1 }, { ...deps, checkpoint: (s) => { cp = s; } });

    assert.match(out.stopReason, /epoch-sweep converged/, "a resolvable fix converges cleanly");
    assert.equal(out.fixed.length, 1, "the fix landed once");
    assert.deepEqual(cp?.sweep?.livelock?.excluded ?? [], [], "NO file was quarantined (a resolving fix is not a livelock)");
    assert.ok((out.proposed ?? []).every((p) => !/livelock/i.test(p.rejectedReason ?? "")), "no livelock proposal was surfaced");
  } finally {
    rmWorkspace(tmp);
  }
});

// ── correction C — the fp-AGNOSTIC trip: an oscillation whose fix DRIFTS the fingerprint still trips ──────

test("LIVELOCK fp-drift (correction C): a fixer that churns content AND drifts the finding fingerprint every pass still trips the breaker within a bounded number of passes (not maxPasses) — via the fp-AGNOSTIC 'no net reduction' condition", async () => {
  const tmp = mkWorkspace();
  try {
    const log = [];
    let mutations = 0;
    // a.mjs surfaces a tier-2 finding whose LINE + TITLE DRIFT with each fix (a line-shift → a NEW fingerprint
    // every pass), so neither the exact-transition (a) nor the recurring-fingerprint (b) condition can EVER
    // fire — only the fp-agnostic (c) "K cycles with the open-finding count not net-decreased" catches it.
    const gr = mkFakeGroupedReview(tmp, log, {
      findingsFor: (tier) => tier === 2 ? [{ file: "a.mjs", lens: "correctness", category: "correctness", severity: "P1", title: `drift variant${mutations}`, line: 1 + mutations * 60, tier: 2 }] : []
    });
    // each fix "succeeds" (test-green) + writes NEW content — the fingerprint drift is exactly what the fix's
    // line-shift would cause in the field. Once quarantined the fixer stops, content stabilizes, the finding
    // stops drifting, and the tier settles (correction A).
    const driftFix = async (cwd, actionable) => {
      const hit = (actionable ?? []).filter((f) => (f.file ?? f.location?.path) === "a.mjs");
      if (hit.length) {
        mutations += 1;
        fs.writeFileSync(path.join(tmp, "a.mjs"), `export const a = ${mutations};\n`.repeat(mutations + 1));
        return { fixed: hit.map((f) => ({ file: "a.mjs", finding: f })), failed: [], rejected: [], changedFiles: ["a.mjs"], spent: 1, branch: "council/x", ok: true };
      }
      return { fixed: [], failed: [], rejected: [], changedFiles: [], spent: 0, branch: "council/x", ok: true };
    };
    const opts = sweepOpts();
    const cursor = cursorOn(new Map());
    let cp = null;
    const deps = makeFixLoopDeps(tmp, MODEL, BACKENDS, opts, { runGroupedReview: gr, runAuditFix: driftFix, tierSweepCursor: cursor });
    const out = await runFixLoop(tmp, { ...opts, budget: 3000, maxPasses: 40, dryStreak: 1 }, { ...deps, checkpoint: (s) => { cp = s; } });

    assert.match(out.stopReason, /epoch-sweep converged/, "the DRIFTING oscillation is caught and the tier settles — it does NOT spin to maxPasses");
    assert.ok(out.passesRun < 40, `converged well under maxPasses (spun to ${out.passesRun})`);
    assert.ok(mutations <= LIVELOCK_MAX_CYCLES, `the fp-agnostic (c) condition quarantined a.mjs after ≤ LIVELOCK_MAX_CYCLES churns (got ${mutations})`);
    assert.ok(cp?.sweep?.livelock?.excluded?.includes("a.mjs"), "a.mjs is quarantined DESPITE the fingerprint never repeating");
    assert.ok((out.proposed ?? []).some((p) => /livelock/i.test(p.rejectedReason ?? "")), "the un-resolvable drifting finding is surfaced as a proposal");
    // PROOF it was the fp-agnostic path, not (b): every fixedFps count is 1 (no fingerprint was ever fixed twice).
    const row = (cp.sweep.livelock.state ?? []).find((r) => JSON.parse(r[0])[1] === "a.mjs");
    assert.ok(row, "a.mjs has checkpointed livelock state");
    assert.ok(row[2].every(([, c]) => c < 2), "no fingerprint recurred (it drifted) — (a)/(b) could NOT have tripped; only the fp-agnostic (c) did");
  } finally {
    rmWorkspace(tmp);
  }
});

// ── correction D — no false-trip on a DUPLICATE item within one fx.fixed batch ────────────────────────────

test("LIVELOCK no false-trip (correction D): two fx.fixed items with the SAME fixKey in ONE pass are a duplicate batch item, not a cross-pass recurrence — the first legitimate fix is NOT quarantined", async () => {
  const tmp = mkWorkspace();
  try {
    const log = [];
    let fixed = false;
    // a legit ONE-SHOT fix: the finding is offered once, then resolved.
    const gr = mkFakeGroupedReview(tmp, log, { findingsFor: (tier) => (tier === 2 && !fixed) ? [{ file: "a.mjs", lens: "correctness", category: "correctness", severity: "P1", title: "real bug", line: 1, tier: 2 }] : [] });
    // the fixer reports the SAME fix TWICE in one batch (a duplicate item — identical fixKey). Without the
    // batch dedupe, the second item would see the FIRST item's just-added transition and FALSE-TRIP the
    // breaker on the very first legitimate fix.
    const dupBatchFix = async (cwd, actionable) => {
      const hit = (actionable ?? []).filter((f) => (f.file ?? f.location?.path) === "a.mjs");
      if (hit.length) {
        fixed = true;
        fs.writeFileSync(path.join(tmp, "a.mjs"), "export const a = 2; // fixed\n");
        const item = { file: "a.mjs", finding: hit[0] };
        return { fixed: [item, item], failed: [], rejected: [], changedFiles: ["a.mjs"], spent: 1, branch: "council/x", ok: true };
      }
      return { fixed: [], failed: [], rejected: [], changedFiles: [], spent: 0, branch: "council/x", ok: true };
    };
    const opts = sweepOpts();
    const cursor = cursorOn(new Map());
    let cp = null;
    const deps = makeFixLoopDeps(tmp, MODEL, BACKENDS, opts, { runGroupedReview: gr, runAuditFix: dupBatchFix, tierSweepCursor: cursor });
    const out = await runFixLoop(tmp, { ...opts, budget: 2000, maxPasses: 40, dryStreak: 1 }, { ...deps, checkpoint: (s) => { cp = s; } });

    assert.match(out.stopReason, /epoch-sweep converged/, "the one-shot fix converges cleanly");
    assert.equal(out.fixed.length, 1, "the duplicate batch item is deduped to a single durable fix");
    assert.deepEqual(cp?.sweep?.livelock?.excluded ?? [], [], "a duplicate batch item did NOT false-trip the breaker (no quarantine on the first legit fix)");
    assert.ok((out.proposed ?? []).every((p) => !/livelock/i.test(p.rejectedReason ?? "")), "no livelock proposal was surfaced");
    const row = (cp.sweep.livelock.state ?? []).find((r) => JSON.parse(r[0])[1] === "a.mjs");
    if (row) assert.equal(row[1], 1, "the duplicate batch counted as ONE (file,tier) cycle, not two");
  } finally {
    rmWorkspace(tmp);
  }
});

// ── F — the LIVELOCK RESUME round-trip: the quarantine + cycle/transition memory survives --resume ─────────

test("LIVELOCK RESUME round-trip (F): a second runFixLoop({resume:true}) KEEPS the quarantine across the interrupt — the fixedFps Map survives the JSON round-trip, cycles/transitions do NOT reset, and the quarantined file is NEVER re-fixed", async () => {
  const tmp = mkWorkspace();
  try {
    const store = new Map(); // the durable ledger shared across the interrupt/resume boundary
    let cp = null;
    const checkpoint = (s) => { cp = s; };
    const loadCheckpoint = () => cp;
    const opts = sweepOpts({ runId: "run-livelock-resume" });

    // PHASE 1 (interrupted at maxPasses === LIVELOCK_MAX_CYCLES, right after the cycle-K quarantine): a.mjs
    // surfaces the SAME tier-2 finding every pass; the fixer churns it but never resolves it → quarantine.
    const log1 = [];
    let mut1 = 0;
    const gr1 = mkFakeGroupedReview(tmp, log1, { findingsFor: (tier) => tier === 2 ? [{ file: "a.mjs", lens: "correctness", category: "correctness", severity: "P1", title: "stubborn bug", line: 1, tier: 2 }] : [] });
    const oscillatingFix = async (cwd, actionable) => {
      const hit = (actionable ?? []).filter((f) => (f.file ?? f.location?.path) === "a.mjs");
      if (hit.length) { mut1 += 1; fs.writeFileSync(path.join(tmp, "a.mjs"), `export const a = ${mut1}; // churn ${mut1}\n`); return { fixed: hit.map((f) => ({ file: "a.mjs", finding: f })), failed: [], rejected: [], changedFiles: ["a.mjs"], spent: 1, branch: "council/x", ok: true }; }
      return { fixed: [], failed: [], rejected: [], changedFiles: [], spent: 0, branch: "council/x", ok: true };
    };
    const cursor1 = cursorOn(store);
    const deps1 = makeFixLoopDeps(tmp, MODEL, BACKENDS, opts, { runGroupedReview: gr1, runAuditFix: oscillatingFix, tierSweepCursor: cursor1 });
    await runFixLoop(tmp, { ...opts, budget: 2000, maxPasses: LIVELOCK_MAX_CYCLES, dryStreak: 1 }, { ...deps1, checkpoint, loadCheckpoint });

    const interruptCp = cp;
    assert.ok(interruptCp?.sweep?.livelock?.excluded?.includes("a.mjs"), "phase 1 quarantined a.mjs before the interrupt");
    const rowBefore = interruptCp.sweep.livelock.state.find((r) => JSON.parse(r[0])[1] === "a.mjs");
    assert.ok(rowBefore, "the (tier,a.mjs) livelock state was checkpointed");
    const cyclesBefore = rowBefore[1];
    assert.ok(Array.isArray(rowBefore[2]) && rowBefore[2].length >= 1, "fixedFps was serialized as an array (Map → array)");
    assert.ok(interruptCp.sweep.livelock.transitions.length >= 1, "the content transitions were checkpointed");

    // The checkpoint is plain JSON (the on-disk round-trip): serialize + parse it and resume from THAT — so
    // the fixedFps Map genuinely survives array → JSON → array → Map.
    cp = JSON.parse(JSON.stringify(interruptCp));

    // PHASE 2 — RESUME (same epoch / reviewers / runId) over the SAME store; assert the breaker memory survives.
    let reFixedA = false;
    const log2 = [];
    const gr2 = mkFakeGroupedReview(tmp, log2, { findingsFor: (tier) => tier === 2 ? [{ file: "a.mjs", lens: "correctness", category: "correctness", severity: "P1", title: "stubborn bug", line: 1, tier: 2 }] : [] });
    const watchFix = async (cwd, actionable) => {
      if ((actionable ?? []).some((f) => (f.file ?? f.location?.path) === "a.mjs")) reFixedA = true;
      return { fixed: [], failed: [], rejected: [], changedFiles: [], spent: 0, branch: "council/x", ok: true };
    };
    const cursor2 = cursorOn(store);
    const deps2 = makeFixLoopDeps(tmp, MODEL, BACKENDS, opts, { runGroupedReview: gr2, runAuditFix: watchFix, tierSweepCursor: cursor2 });
    const out2 = await runFixLoop(tmp, { ...opts, budget: 2000, maxPasses: 40, dryStreak: 1, resume: true }, { ...deps2, checkpoint, loadCheckpoint });

    assert.ok(!/resume blocked/.test(out2.stopReason ?? ""), `resume must NOT fail closed (same epoch/store): ${out2.stopReason}`);
    assert.match(out2.stopReason, /epoch-sweep converged/, "the resumed run converges over the re-opened cells");
    assert.ok(!reFixedA, "the quarantined a.mjs is NEVER re-fixed on resume (the oscillation memory survived — it is not re-fixed afresh)");
    const rowAfter = cp.sweep.livelock.state.find((r) => JSON.parse(r[0])[1] === "a.mjs");
    assert.ok(cp.sweep.livelock.excluded.includes("a.mjs"), "a.mjs STAYS quarantined after resume");
    assert.ok(rowAfter && rowAfter[1] >= cyclesBefore, "the cycle count did NOT reset on resume");
    assert.ok(Array.isArray(rowAfter[2]) && rowAfter[2].length >= 1, "the fixedFps Map survived the JSON round-trip (array → Map → array)");
  } finally {
    rmWorkspace(tmp);
  }
});
