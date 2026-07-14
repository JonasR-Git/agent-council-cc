// WAVE 3 (epoch-sweep) — the broad COVERAGE-GUARANTEE property test. docs/epoch-sweep-design.md.
// This is the guardrail the whole feature rests on: over several constructed scenarios (varying file
// count, chunks/file, seats, maxCells, and an interleaved fix that re-hashes a file mid-sweep) it drives
// the REAL runFixLoop sweep path with fakes and asserts the CORE INVARIANT —
//
//   (I)   NO tier is ever advanced while any expected current-content cell key for that tier is absent
//         from the done set (checked at the EXACT advance point, regardless of pass count / coverage.ran);
//   (II)  the UNION of cells scheduled across the run == the manifest (NO skip);
//   (III) no done cell is scheduled twice at an UNCHANGED hash (NO waste).
//
// All deterministic (injected fs/clock, no model/CLI calls).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LIVELOCK_MAX_CYCLES, runFixLoop } from "../plugins/council/scripts/lib/audit-fixloop.mjs";
import { makeFixLoopDeps } from "../plugins/council/scripts/lib/audit-fixloop-deps.mjs";
import { runGroupedReview } from "../plugins/council/scripts/lib/audit-grouped-review.mjs";
import { buildManifest, cellSweepKey, expectedKeys, makeTierSweepCursor, scopeGroupsForTier } from "../plugins/council/scripts/lib/audit-tier-sweep.mjs";
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
const ALL_BACKENDS = { codex: { companionAvailable: true }, grok: { cli: { available: true } }, claude: { cli: { available: true } } };
const keyOf = (cell, options) =>
  cellSweepKey({ epochHash: options.sweep.epochHash, tier: options.tier, group: cell.group, seat: cell.model, reviewerSet: options.sweep.reviewerSet, file: cell.file, chunkIndex: cell.chunk, chunkText: cell.chunkData?.text ?? "" });

// A workspace from a {filename: content} spec + the matching MODEL (hotspot desc → deterministic order).
function mkWorkspace(spec) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-guar-"));
  const ids = Object.keys(spec);
  for (const id of ids) fs.writeFileSync(path.join(tmp, id), spec[id]);
  const model = { files: ids.map((id, i) => ({ id, isTest: false, hotspot: ids.length - i, loc: 1, branches: 0 })) };
  return { tmp, model };
}
const rmWorkspace = (tmp) => fs.rmSync(tmp, { recursive: true, force: true });

// REAL grouped-review driver: runs the ACTUAL runGroupedReview (so capCells + the pending filter are
// exercised) with an injected runMatrix that records each SCHEDULED (capped) cell's key and marks it done
// through the real onCell path.
function mkRealDriver(scheduledKeys) {
  return async (cwd, model, backends, options) => {
    const runMatrix = async (cells, _rc, m) => {
      for (const cell of cells) {
        scheduledKeys.push(keyOf(cell, options));
        m.onCell?.({ ok: true, cell, findings: [], skipped: false }, 0);
      }
      return { results: cells.map((c) => ({ ok: true, cell: c, findings: [] })), matrix: { summary: () => ({}) }, findings: [], complete: true, triples: [], dispatched: cells.length, skipped: 0 };
    };
    return runGroupedReview(cwd, model, backends, options, { runMatrix });
  };
}

// Same REAL capCells path, but injects a tier-scoped finding at the REVIEW-RESULT level (only when the
// finding's file actually had ≥1 cell SCHEDULED this pass) — so a livelock scenario can drive the fixer
// through the genuine capped-drain path. `findingFor(tier)` returns the findings to surface for that tier.
function mkRealDriverWithFinding(findingFor) {
  return (scheduledKeys) => async (cwd, model, backends, options) => {
    const scheduledFiles = new Set();
    const runMatrix = async (cells, _rc, m) => {
      for (const cell of cells) {
        scheduledKeys.push(keyOf(cell, options));
        scheduledFiles.add(cell.file);
        m.onCell?.({ ok: true, cell, findings: [], skipped: false }, 0);
      }
      return { results: cells.map((c) => ({ ok: true, cell: c, findings: [] })), matrix: { summary: () => ({}) }, findings: [], complete: true, triples: [], dispatched: cells.length, skipped: 0 };
    };
    const out = await runGroupedReview(cwd, model, backends, options, { runMatrix });
    const inj = (findingFor ? findingFor(options.tier) : []).filter((f) => scheduledFiles.has(f.file ?? f.location?.path));
    return { ...out, findings: [...(out.findings ?? []), ...inj] };
  };
}

// FAKE grouped-review driver: marks every scheduled cell of the SELECTED files done (records the keys),
// and can inject findings per (tier, pass) for the mid-sweep-fix scenario.
function mkFakeDriver(tmp, scheduledKeys, findingsFor) {
  return async (cwd, scopedModel, backends, options) => {
    const selected = scopedModel.files.map((f) => f.id);
    const scoped = scopeGroupsForTier(resolveLensGroups(options.lensGroups), options.tier);
    const chunksOf = (f) => chunkSource(fs.readFileSync(path.join(tmp, f), "utf8"));
    const manifest = buildManifest({ files: selected, chunksOf, isSupplied: () => true });
    for (const k of expectedKeys(manifest, options.tier, scoped, options.sweep.reviewerSet, options.sweep.epochHash)) {
      scheduledKeys.push(k);
      options.sweep.cursor.markDone(k, { pass: options.pass });
    }
    const findings = findingsFor ? findingsFor(options.tier, options.pass) : [];
    return { findings, coverage: { ran: true, passComplete: true, complete: true, budgetSpent: selected.length, unitsSelected: selected.length, unitsReviewed: selected.length } };
  };
}
const noFix = async () => ({ fixed: [], failed: [], rejected: [], changedFiles: [], spent: 0, branch: "council/x", ok: true });

// Run a scenario against the REAL runFixLoop sweep path, instrumenting the EXACT tier-advance point
// (markTierClean) to record the cleaned tier's pending at advance — invariant (I).
function runScenario({ tmp, model, backends = ALL_BACKENDS, opts, driver, fix = noFix }) {
  const store = new Map();
  const scheduledKeys = [];
  const cursor = cursorOn(store);
  const deps = makeFixLoopDeps(tmp, model, backends, opts, { runGroupedReview: driver(scheduledKeys), runAuditFix: fix, tierSweepCursor: cursor });
  const advanceChecks = [];
  // Wrap markTierClean (called EXACTLY at a tier advance, before the index increments) to reconstruct the
  // current manifest + done set from the ledger and assert the cleaned tier has 0 pending at that instant.
  const origMarkTierClean = cursor.markTierClean;
  cursor.markTierClean = (arg) => {
    const loaded = cursorOn(store).load();
    const scoped = scopeGroupsForTier(deps.sweep.baseGroups, arg.tier);
    const pending = expectedKeys(loaded.manifest, arg.tier, scoped, deps.sweep.reviewerSet, deps.sweep.epochHash).filter((k) => !loaded.done.has(k));
    advanceChecks.push({ tier: arg.tier, pending: pending.length });
    return origMarkTierClean(arg);
  };
  return { store, scheduledKeys, deps, advanceChecks, cursor };
}

// The FINAL expected key set across ALL tiers, computed from the current on-disk manifest (reads final
// content, so a mid-sweep fix's re-hash is reflected).
function finalExpectedSet(deps, tiers) {
  const manifest = deps.sweep.buildManifest();
  const set = new Set();
  for (const t of tiers) {
    const scoped = scopeGroupsForTier(deps.sweep.baseGroups, t);
    for (const k of expectedKeys(manifest, t, scoped, deps.sweep.reviewerSet, deps.sweep.epochHash)) set.add(k);
  }
  return set;
}

function assertCoreInvariants({ out, scheduledKeys, advanceChecks, deps, tiers, exactUnion }) {
  // (I) no tier advanced while any expected current-content key was absent from the done set.
  assert.ok(advanceChecks.length > 0, "at least one tier advanced (the sweep progressed)");
  for (const c of advanceChecks) assert.equal(c.pending, 0, `tier ${c.tier} advanced with 0 pending (never advanced while a cell was absent from done)`);
  // (III) no waste: no cell scheduled twice at an unchanged hash (a re-hash yields a DIFFERENT key).
  assert.equal(new Set(scheduledKeys).size, scheduledKeys.length, "no done cell was ever re-scheduled at an unchanged hash (no waste)");
  // (II) no skip: every FINAL expected key was scheduled at least once.
  const scheduledSet = new Set(scheduledKeys);
  const finalExpected = finalExpectedSet(deps, tiers);
  for (const k of finalExpected) assert.ok(scheduledSet.has(k), "every final-content expected cell was scheduled (no skip)");
  if (exactUnion) assert.deepEqual(scheduledSet, finalExpected, "with no invalidation, the scheduled union is EXACTLY the manifest");
  assert.match(out.stopReason, /epoch-sweep converged/, "the sweep converges (every tier reached 100% cell coverage)");
}

const ALL_TIERS = [0, 1, 2, 3];

// ── SCENARIO 1: many files, one per pass (file-level drain) ───────────────────────────────────────

test("PROPERTY 1: 4 files × 1 chunk, 3 seats, maxUnits=1 — the union of scheduled cells == manifest, no tier advances while pending, no waste", async () => {
  const { tmp, model } = mkWorkspace({
    "a.mjs": "export const a = 1;\n",
    "b.mjs": "export function b() { return 2; }\n",
    "c.mjs": "export const c = 3;\n",
    "d.mjs": "export function d() { return 4; }\n"
  });
  try {
    const opts = { epochSweep: true, lensGroups: "tier", perTierConvergence: true, structureAutoApply: false, maxUnits: 1, maxCells: 100, ledger: false };
    const { deps, scheduledKeys, advanceChecks } = runScenario({ tmp, model, opts, driver: mkRealDriver });
    const out = await runFixLoop(tmp, { ...opts, budget: 5000, maxPasses: 60, dryStreak: 1 }, deps);
    assertCoreInvariants({ out, scheduledKeys, advanceChecks, deps, tiers: ALL_TIERS, exactUnion: true });
  } finally {
    rmWorkspace(tmp);
  }
});

// ── SCENARIO 2: maxCells << cells/file (capCells intra-file DRAIN) ────────────────────────────────

test("PROPERTY 2: one multi-chunk file with maxCells << cells/file — capCells drains the tail across passes, no skip, no waste, no false advance", async () => {
  const big = "export const x = 1;\n".repeat(2200); // > 32KB → several chunks
  const { tmp, model } = mkWorkspace({ "big.mjs": big });
  try {
    const opts = { epochSweep: true, lensGroups: "tier", perTierConvergence: true, structureAutoApply: false, maxUnits: 1, maxCells: 3, ledger: false };
    // Precondition: the tier-2 cells of the single file exceed maxCells (the drain shape).
    const store0 = new Map();
    const probe = makeFixLoopDeps(tmp, model, ALL_BACKENDS, opts, { runGroupedReview: mkRealDriver([]), runAuditFix: noFix, tierSweepCursor: cursorOn(store0) });
    const scoped2 = scopeGroupsForTier(probe.sweep.baseGroups, 2);
    const cells2 = expectedKeys(probe.sweep.buildManifest(), 2, scoped2, probe.sweep.reviewerSet, probe.sweep.epochHash).length;
    assert.ok(cells2 > opts.maxCells, `precondition: the file's ${cells2} tier-2 cells exceed maxCells ${opts.maxCells} (the drain shape)`);

    const { deps, scheduledKeys, advanceChecks } = runScenario({ tmp, model, opts, driver: mkRealDriver });
    const out = await runFixLoop(tmp, { ...opts, budget: 20000, maxPasses: 200, dryStreak: 1 }, deps);
    assertCoreInvariants({ out, scheduledKeys, advanceChecks, deps, tiers: ALL_TIERS, exactUnion: true });
  } finally {
    rmWorkspace(tmp);
  }
});

// ── SCENARIO 3: a mid-sweep fix re-hashes a file → invalidation → re-cover BEFORE advance ─────────

test("PROPERTY 3: a mid-sweep fix re-hashes a file → its cells re-open → they are RE-COVERED before the tier advances; the invariant holds through invalidation", async () => {
  const { tmp, model } = mkWorkspace({
    "a.mjs": "export const a = 1;\n",
    "b.mjs": "export function b() { return 2; }\n"
  });
  try {
    let fixed = false;
    const scheduledKeys = [];
    // a tier-2 finding on a.mjs, offered once; the fixer mutates a.mjs on disk (re-hash → re-open)
    const driver = (sk) => mkFakeDriver(tmp, sk, (tier) => (tier === 2 && !fixed) ? [{ file: "a.mjs", lens: "correctness", category: "correctness", severity: "P1", title: "bug", line: 1, tier: 2 }] : []);
    // An INJECTED runAuditFix is called as (cwd, actionable, backends, options, deps) — actionable is 2nd.
    const mutatingFix = async (cwd, actionable) => {
      const hit = (actionable ?? []).filter((f) => (f.file ?? f.location?.path) === "a.mjs");
      if (hit.length) {
        fixed = true;
        fs.writeFileSync(path.join(tmp, "a.mjs"), "export const a = 42; // fixed\n");
        return { fixed: hit.map((f) => ({ file: "a.mjs", finding: f })), failed: [], rejected: [], changedFiles: ["a.mjs"], spent: 1, branch: "council/x", ok: true };
      }
      return { fixed: [], failed: [], rejected: [], changedFiles: [], spent: 0, branch: "council/x", ok: true };
    };
    // structureAutoApply → plan [0,1,2,3] so a tier-2 fix can re-enter earlier tiers.
    const opts = { epochSweep: true, lensGroups: "tier", perTierConvergence: true, structureAutoApply: true, maxUnits: 2, maxCells: 100, ledger: false };
    const store = new Map();
    const cursor = cursorOn(store);
    const deps = makeFixLoopDeps(tmp, model, ALL_BACKENDS, opts, { runGroupedReview: driver(scheduledKeys), runAuditFix: mutatingFix, tierSweepCursor: cursor });
    const advanceChecks = [];
    const origMarkTierClean = cursor.markTierClean;
    cursor.markTierClean = (arg) => {
      const loaded = cursorOn(store).load();
      const scoped = scopeGroupsForTier(deps.sweep.baseGroups, arg.tier);
      const pending = expectedKeys(loaded.manifest, arg.tier, scoped, deps.sweep.reviewerSet, deps.sweep.epochHash).filter((k) => !loaded.done.has(k));
      advanceChecks.push({ tier: arg.tier, pending: pending.length });
      return origMarkTierClean(arg);
    };
    const out = await runFixLoop(tmp, { ...opts, budget: 5000, maxPasses: 60, dryStreak: 1 }, deps);

    assert.equal(out.fixed.length, 1, "the fix landed once");
    assertCoreInvariants({ out, scheduledKeys, advanceChecks, deps, tiers: ALL_TIERS, exactUnion: false });
    // The re-hashed a.mjs was RE-COVERED: its post-fix (new-hash) tier-2 cells appear in the scheduled set,
    // and the OLD-hash cells were also scheduled (pre-fix) — two DIFFERENT keys for the same (file,chunk),
    // proving the invalidation re-opened + re-reviewed rather than skipping.
    const finalExpected = finalExpectedSet(deps, [2]);
    const scheduledSet = new Set(scheduledKeys);
    for (const k of finalExpected) assert.ok(scheduledSet.has(k), "a.mjs's post-fix tier-2 cells were re-covered before tier 2 advanced");
  } finally {
    rmWorkspace(tmp);
  }
});

// ── SCENARIO 4: vary the seat count (2 seats) ────────────────────────────────────────────────────

test("PROPERTY 4: 3 files, 2 seats (skip claude), maxUnits=2 — the guarantee holds under a different reviewer-set denominator", async () => {
  const { tmp, model } = mkWorkspace({
    "a.mjs": "export const a = 1;\n",
    "b.mjs": "export function b() { return 2; }\n",
    "c.mjs": "export const c = 3;\n"
  });
  try {
    const opts = { epochSweep: true, lensGroups: "tier", perTierConvergence: true, structureAutoApply: false, maxUnits: 2, maxCells: 100, ledger: false, skipClaude: true };
    const { deps, scheduledKeys, advanceChecks } = runScenario({ tmp, model, opts, driver: mkRealDriver });
    assert.equal(deps.sweep.reviewerSet.length, 2, "precondition: the frozen reviewer set is 2 seats (claude skipped)");
    const out = await runFixLoop(tmp, { ...opts, budget: 5000, maxPasses: 60, dryStreak: 1 }, deps);
    assertCoreInvariants({ out, scheduledKeys, advanceChecks, deps, tiers: ALL_TIERS, exactUnion: true });
  } finally {
    rmWorkspace(tmp);
  }
});

// ── SCENARIO 5 (correction A): QUARANTINE × CAPPED SCHEDULER — the test that would have CAUGHT the bug ──
// A large multi-chunk file that livelock-quarantines + smaller other files + maxCells << the big file's
// cells + dryStreak:1. The earlier `genuinePending` SUBTRACTED the quarantined file's cells from the advance
// denominator, so once the OTHER files were done and the quarantined file was the SOLE pending, the tier
// advanced while its many re-opened cells (all re-hashed by the last churn) were still RAW-pending, draining
// under the cap — NEVER-reviewed cells hidden from the 100% claim (verified: the subtracting variant fires
// markTierClean at RAW pending 6, and the later tiers at 21). The markTierClean wrapper computes the cleaned
// tier's RAW pending from the LEDGER at the advance instant; asserting it is 0 fails against the subtracting
// bug and holds under the fix (the tier settles only once the quarantined file's re-opened cells are actually
// reviewed to done — with no fix to re-hash them, they stay done and raw pending reaches 0 naturally).

test("PROPERTY 5 (quarantine × capped scheduler): a livelock-quarantined multi-chunk file that becomes the SOLE pending file + maxCells << its cells + dryStreak:1 — markTierClean NEVER fires while RAW ledger pending exists (correction A)", async () => {
  const big = "export const x = 1;\n".repeat(4600); // several chunks per tier (≫ maxCells)
  // big.mjs has the LOWEST hotspot so the small files drain FIRST + stay done (no findings → no re-hash);
  // big.mjs then becomes the SOLE pending file while it churns → the exact shape that unmasked the bug.
  const { tmp } = mkWorkspace({ "a.mjs": "export const a = 1;\n", "b.mjs": "export function b() { return 2; }\n", "big.mjs": big });
  const model = { files: [{ id: "a.mjs", isTest: false, hotspot: 9, loc: 1, branches: 0 }, { id: "b.mjs", isTest: false, hotspot: 8, loc: 1, branches: 0 }, { id: "big.mjs", isTest: false, hotspot: 1, loc: 1, branches: 0 }] };
  try {
    // big.mjs surfaces the SAME tier-2 finding whenever it is scheduled; the fixer PREPENDS to big.mjs (so
    // EVERY chunk re-hashes → all its cells re-open) but never resolves it → livelock → quarantine.
    const findingFor = (tier) => tier === 2 ? [{ file: "big.mjs", lens: "correctness", category: "correctness", severity: "P1", title: "stubborn", line: 1, tier: 2 }] : [];
    let mutations = 0;
    const churnFix = async (cwd, actionable) => {
      const hit = (actionable ?? []).filter((f) => (f.file ?? f.location?.path) === "big.mjs");
      if (hit.length) {
        mutations += 1;
        fs.writeFileSync(path.join(tmp, "big.mjs"), `// churn ${mutations}\n${big}`); // PREPEND → all chunks shift → all re-open
        return { fixed: hit.map((f) => ({ file: "big.mjs", finding: f })), failed: [], rejected: [], changedFiles: ["big.mjs"], spent: 1, branch: "council/x", ok: true };
      }
      return { fixed: [], failed: [], rejected: [], changedFiles: [], spent: 0, branch: "council/x", ok: true };
    };
    const opts = { epochSweep: true, lensGroups: "tier", perTierConvergence: true, structureAutoApply: false, maxUnits: 3, maxCells: 6, ledger: false };
    // Precondition: big.mjs's tier-2 cells exceed maxCells (the capped multi-pass drain the bug needed).
    const probe = makeFixLoopDeps(tmp, model, ALL_BACKENDS, opts, { runGroupedReview: mkRealDriver([]), runAuditFix: noFix, tierSweepCursor: cursorOn(new Map()) });
    const scoped2 = scopeGroupsForTier(probe.sweep.baseGroups, 2);
    const cells2 = expectedKeys(probe.sweep.buildManifest(), 2, scoped2, probe.sweep.reviewerSet, probe.sweep.epochHash).filter((k) => k.includes("big.mjs")).length;
    assert.ok(cells2 > opts.maxCells, `precondition: big.mjs's ${cells2} tier-2 cells exceed maxCells ${opts.maxCells} (a multi-pass capped drain)`);

    const { deps, advanceChecks } = runScenario({ tmp, model, opts, driver: mkRealDriverWithFinding(findingFor), fix: churnFix });
    const out = await runFixLoop(tmp, { ...opts, budget: 80000, maxPasses: 400, dryStreak: 1 }, deps);

    // THE invariant that would have caught bug A: every tier advanced with 0 RAW pending under the ledger.
    assert.ok(advanceChecks.length > 0, "at least one tier advanced");
    for (const c of advanceChecks) assert.equal(c.pending, 0, `tier ${c.tier} advanced with 0 RAW pending — a quarantine must NOT subtract from the coverage denominator`);
    assert.match(out.stopReason, /epoch-sweep converged/, "the sweep converges (the quarantined file's cells were reviewed to done, so raw pending settled to 0)");
    assert.ok(mutations <= LIVELOCK_MAX_CYCLES, `the fixer stopped churning big.mjs after quarantine (≤ LIVELOCK_MAX_CYCLES, got ${mutations})`);
    assert.ok((out.proposed ?? []).some((p) => /livelock/i.test(p.rejectedReason ?? "")), "the churning file's finding is surfaced as a proposal for human review");
  } finally {
    rmWorkspace(tmp);
  }
});

// ── SCENARIO 6 (correction E): a throwing cellSweepKey is a FAIL-CLOSED hard stop, not a swallowed spin ──
// Wave 3 hoisted cellSweepKey OUTSIDE the try that sets sweepError; a throw there was swallowed by the
// scheduler (onCell throws are swallowed) → the cell stayed silently pending (spin) with its findings never
// appended. The fix computes the key INSIDE a try that sets sweepError → the loop turns it into a hard stop.

test("SCENARIO 6 (correction E): a cellSweepKey that THROWS during onCell sets coverage.sweepError → the loop HARD-STOPS (never a silently-pending spin)", async () => {
  const { tmp, model } = mkWorkspace({ "a.mjs": "export const a = 1;\n" });
  try {
    // Feed onCell a MALFORMED cell (a BigInt groupId → the canonical key's JSON.stringify throws), exactly
    // the "malformed cell" case: the key is computed INSIDE the fail-closed try, so the throw becomes a hard
    // stop instead of a swallowed spin. maxPasses is generous — a swallowed throw would spin to it.
    const driver = () => async (cwd, m, b, o) => {
      const runMatrix = async (cells, _rc, mm) => {
        for (const cell of cells) mm.onCell?.({ ok: true, cell: { ...cell, group: { ...cell.group, id: 1n } }, findings: [], skipped: false }, 0);
        return { results: cells.map((c) => ({ ok: true, cell: c, findings: [] })), matrix: { summary: () => ({}) }, findings: [], complete: true, triples: [], dispatched: cells.length, skipped: 0 };
      };
      return runGroupedReview(cwd, m, b, o, { runMatrix });
    };
    const opts = { epochSweep: true, lensGroups: "tier", perTierConvergence: true, structureAutoApply: false, maxUnits: 1, maxCells: 100, ledger: false };
    const { deps } = runScenario({ tmp, model, opts, driver });
    const out = await runFixLoop(tmp, { ...opts, budget: 5000, maxPasses: 20, dryStreak: 1 }, deps);
    assert.match(out.stopReason ?? "", /hard stop.*durable coverage ledger|coverage ledger write failed/i, "a throwing cellSweepKey is a FAIL-CLOSED hard stop (sweepError), not a swallowed silent spin");
    assert.equal(out.passesRun, 1, "the hard stop fires on the FIRST pass — it never spins");
  } finally {
    rmWorkspace(tmp);
  }
});
