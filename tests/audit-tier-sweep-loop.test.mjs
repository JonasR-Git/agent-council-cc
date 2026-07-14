// Wave 2 (epoch-sweep) — the durable ledger wired into the fix loop behind `--epoch-sweep`.
// docs/epoch-sweep-design.md. These tests assert the coverage-correctness INVARIANT + the loop's
// ledger-driven scheduling / tier-advance / fix-invalidation / fail-closed resume, and that the flag
// OFF is byte-identical to legacy. All deterministic (injected fs/clock, no model/CLI calls).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runFixLoop } from "../plugins/council/scripts/lib/audit-fixloop.mjs";
import { makeFixLoopDeps } from "../plugins/council/scripts/lib/audit-fixloop-deps.mjs";
import { runGroupedReview } from "../plugins/council/scripts/lib/audit-grouped-review.mjs";
import { buildManifest, cellSweepKey, expectedKeys, fileOfKey, makeTierSweepCursor, manifestDigest, scopeGroupsForTier } from "../plugins/council/scripts/lib/audit-tier-sweep.mjs";
import { resolveLensGroups } from "../plugins/council/scripts/lib/audit-lens-groups.mjs";
import { chunkSource } from "../plugins/council/scripts/lib/audit-group-prompt.mjs";

// A deterministic in-memory ledger backing store (no disk, no real fsync).
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

// A throwaway on-disk workspace (chunksOf reads it) with two tiny non-test files.
function mkWorkspace() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-loop-"));
  fs.writeFileSync(path.join(tmp, "a.mjs"), "export const a = 1;\n");
  fs.writeFileSync(path.join(tmp, "b.mjs"), "export function b() { return 2; }\n");
  return tmp;
}
const rmWorkspace = (tmp) => fs.rmSync(tmp, { recursive: true, force: true });

// A fake grouped review that marks every scheduled cell DONE through the SAME key path expectedKeys
// uses (buildManifest + expectedKeys over the selected files) — i.e. it simulates runGroupedReview's
// real markDone. `opts.skipKey(parsedKey, tier)` leaves a cell PENDING; `opts.findingsFor(tier,pass)`
// injects findings the fixer can act on. `reviewedLog` records the files each pass was handed.
function mkFakeGroupedReview(tmp, reviewedLog, opts = {}) {
  return async (cwd, scopedModel, backends, options) => {
    const selected = scopedModel.files.map((f) => f.id);
    reviewedLog.push({ tier: options.tier, files: [...selected] });
    const scoped = scopeGroupsForTier(resolveLensGroups(options.lensGroups), options.tier);
    const chunksOf = (f) => chunkSource(fs.readFileSync(path.join(tmp, f), "utf8"));
    const manifest = buildManifest({ files: selected, chunksOf, isSupplied: () => true });
    for (const k of expectedKeys(manifest, options.tier, scoped, options.sweep.reviewerSet, options.sweep.epochHash)) {
      if (opts.skipKey && opts.skipKey(JSON.parse(k), options.tier)) continue;
      options.sweep.cursor.markDone(k, { pass: options.pass });
    }
    const findings = opts.findingsFor ? opts.findingsFor(options.tier, options.pass) : [];
    return { findings, coverage: { ran: true, passComplete: true, complete: true, budgetSpent: selected.length, unitsSelected: selected.length, unitsReviewed: selected.length } };
  };
}
const noFix = async () => ({ fixed: [], failed: [], rejected: [], changedFiles: [], spent: 0, branch: "council/x", ok: true });
const sweepOpts = (over = {}) => ({ epochSweep: true, lensGroups: "tier", perTierConvergence: true, structureAutoApply: false, maxUnits: 5, ...over });

// ── THE INVARIANT: a reviewed cell's markDone key ∈ expectedKeys(...) ────────────────────────────

test("KEY-CONSISTENCY: every cell runGroupedReview marks done is a key expectedKeys generates", async () => {
  const content = { "a.mjs": "export const a = 1;\n", "b.mjs": "export function b() { return 2; }\n" };
  const files = ["a.mjs", "b.mjs"];
  const chunksOf = (f) => chunkSource(content[f]);
  const epoch = "EPOCH-KC";
  const tier = 2;
  const scoped = scopeGroupsForTier(resolveLensGroups("tier"), tier);
  const manifest = buildManifest({ files, chunksOf, isSupplied: () => true });
  const expected = expectedKeys(manifest, tier, scoped, REVIEWERS, epoch);

  const store = new Map();
  const cursor = cursorOn(store);
  cursor.reset();

  // An injected matrix that drives the REAL runGroupedReview onCell markDone path for every cell.
  const runMatrix = async (cells, reviewCell, m) => {
    for (const cell of cells) m.onCell?.({ ok: true, cell, findings: [], skipped: false }, 0);
    return { results: cells.map((c) => ({ ok: true, cell: c, findings: [] })), matrix: { summary: () => ({}) }, findings: [], complete: true, triples: [], dispatched: cells.length, skipped: 0 };
  };
  await runGroupedReview("/x", { files: files.map((id) => ({ id, isTest: false, hotspot: 1, loc: 1, branches: 0 })) }, BACKENDS, {
    lensGroups: "tier", tier, ledger: false, maxCells: 100000,
    sweep: { cursor, epochHash: epoch, reviewerSet: REVIEWERS }
  }, { runMatrix, readFile: (p) => content[path.basename(p)], statSize: (p) => content[path.basename(p)].length });

  const done = (store.get("/led") ?? "").split("\n").filter(Boolean).map(JSON.parse).filter((r) => r.type === "done").map((r) => r.k);
  const expectedSet = new Set(expected);
  assert.equal(done.length, 6, "2 files × 1 chunk × 1 tier group × 3 seats = 6 cells");
  for (const k of done) assert.ok(expectedSet.has(k), `a reviewed cell's done-key must be an expected key: ${k}`);
  assert.deepEqual(new Set(done), expectedSet, "the done set is EXACTLY the expected set (no missing, no extra)");
});

// ── SCHEDULING: pending-driven, no skip, no waste ───────────────────────────────────────────────

test("SCHEDULING: the union of cells scheduled across passes == the full manifest for a tier (no skip, no waste)", async () => {
  const tmp = mkWorkspace();
  try {
    const log = [];
    const gr = mkFakeGroupedReview(tmp, log);
    const opts = sweepOpts({ maxUnits: 1 }); // one file/pass ⇒ coverage MUST spread across passes
    const cursor = cursorOn(new Map());
    const deps = makeFixLoopDeps(tmp, MODEL, BACKENDS, opts, { runGroupedReview: gr, runAuditFix: noFix, tierSweepCursor: cursor });
    await runFixLoop(tmp, { ...opts, budget: 500, maxPasses: 40, dryStreak: 1 }, deps);

    const tier2 = log.filter((r) => r.tier === 2).flatMap((r) => r.files);
    assert.deepEqual(new Set(tier2), new Set(["a.mjs", "b.mjs"]), "every manifest file was scheduled for tier 2 (no skip)");
    assert.equal(tier2.length, new Set(tier2).size, "no file was re-scheduled for tier 2 once its cells were done (no waste)");
    const scoped2 = scopeGroupsForTier(deps.sweep.baseGroups, 2);
    assert.equal(cursor.tierPending(2, deps.sweep.buildManifest(), scoped2, deps.sweep.reviewerSet, deps.sweep.epochHash).count, 0, "tier 2 pending reaches 0");
  } finally {
    rmWorkspace(tmp);
  }
});

// ── CAP-DRAIN (A, the P0): the pending filter BEFORE capCells drains the tail ─────────────────────

// Guards the P0: capCells takes a deterministic whole-triple PREFIX. Without A's pending-filter-before-cap,
// a file with MORE cells than maxCells re-schedules the SAME prefix every pass and the tail is NEVER
// reviewed → tierPending never hits 0 → the tier never advances. This drives the REAL runGroupedReview
// (with an injected runMatrix that marks every SCHEDULED cell done, like a real pass) over a file whose
// cell count (51 = 17 fine-tier2 groups × 1 chunk × 3 seats) exceeds maxCells (40), and asserts it DRAINS.
test("CAP-DRAIN (A): pending filter before capCells drains the tail — a file with more cells than maxCells reaches pending 0 across ⌈cells/cap⌉ passes, no done cell re-scheduled (no waste)", async () => {
  const content = { "big.mjs": "export const x = 1;\n" };
  const files = ["big.mjs"];
  const chunksOf = (f) => chunkSource(content[f]);
  const epoch = "EPOCH-DRAIN";
  const tier = 2;
  const scoped = scopeGroupsForTier(resolveLensGroups("fine"), tier);
  const manifest = buildManifest({ files, chunksOf, isSupplied: () => true });
  const allExpected = expectedKeys(manifest, tier, scoped, REVIEWERS, epoch);
  const cellsPerFile = allExpected.length;
  const maxCells = 40;
  const wholeTripleCap = Math.floor(maxCells / REVIEWERS.length) * REVIEWERS.length; // capCells rounds to triples
  assert.ok(cellsPerFile > maxCells, `precondition: the file's ${cellsPerFile} cells exceed maxCells ${maxCells} (the P0 shape)`);

  const store = new Map();
  const cursor = cursorOn(store);
  cursor.reset();

  const keyOf = (c) => cellSweepKey({ epochHash: epoch, tier, group: c.group, seat: c.model, reviewerSet: REVIEWERS, file: c.file, chunkIndex: c.chunk, chunkText: c.chunkData?.text ?? "" });
  const scheduledPerPass = [];
  const allScheduledKeys = [];
  let passes = 0;
  while (cursor.pending(manifest, tier, scoped, REVIEWERS, epoch).length > 0) {
    passes += 1;
    assert.ok(passes <= 8, "must DRAIN in a bounded number of passes (A) — never re-prefix the same done cells forever");
    let scheduled = [];
    // A runMatrix that marks EVERY scheduled cell done through the real onCell markDone path.
    const runMatrix = async (cells, _rc, m) => {
      scheduled = cells.slice();
      for (const cell of cells) m.onCell?.({ ok: true, cell, findings: [], skipped: false }, 0);
      return { results: cells.map((c) => ({ ok: true, cell: c, findings: [] })), matrix: { summary: () => ({}) }, findings: [], complete: true, triples: [], dispatched: cells.length, skipped: 0 };
    };
    await runGroupedReview(
      "/x",
      { files: files.map((id) => ({ id, isTest: false, hotspot: 1, loc: 1, branches: 0 })) },
      BACKENDS,
      { lensGroups: "fine", tier, ledger: false, maxCells, sweep: { cursor, epochHash: epoch, reviewerSet: REVIEWERS } },
      { runMatrix, readFile: (p) => content[path.basename(p)], statSize: (p) => content[path.basename(p)].length }
    );
    scheduledPerPass.push(scheduled.length);
    allScheduledKeys.push(...scheduled.map(keyOf));
  }

  assert.ok(scheduledPerPass.every((n) => n <= maxCells), `every pass caps to ≤ maxCells: ${scheduledPerPass}`);
  assert.ok(scheduledPerPass.every((n) => n % REVIEWERS.length === 0), "each pass schedules WHOLE triples only (capCells rounding preserved on the pending set)");
  assert.equal(passes, Math.ceil(cellsPerFile / wholeTripleCap), "drained in ⌈cells / whole-triple-cap⌉ passes (the tail advanced, not a re-prefixed stable head)");
  assert.equal(new Set(allScheduledKeys).size, allScheduledKeys.length, "NO already-done cell was ever re-scheduled (no waste)");
  assert.deepEqual(new Set(allScheduledKeys), new Set(allExpected), "the UNION of scheduled cells across passes is EXACTLY the manifest (no skip)");
  assert.equal(cursor.pending(manifest, tier, scoped, REVIEWERS, epoch).length, 0, "tier pending reaches 0 — the tier can now advance");
});

// ── TIER-ADVANCE gating ─────────────────────────────────────────────────────────────────────────

test("TIER-ADVANCE: a persistently-uncovered cell blocks advance and terminates COVERAGE INCOMPLETE", async () => {
  const tmp = mkWorkspace();
  try {
    const log = [];
    // one seat (claude) never completes b.mjs at tier 2 ⇒ tier-2 pending never reaches 0
    const gr = mkFakeGroupedReview(tmp, log, { skipKey: (arr, tier) => tier === 2 && arr[8] === "b.mjs" && arr[6] === "claude" });
    const opts = sweepOpts();
    const cursor = cursorOn(new Map());
    const deps = makeFixLoopDeps(tmp, MODEL, BACKENDS, opts, { runGroupedReview: gr, runAuditFix: noFix, tierSweepCursor: cursor });
    const out = await runFixLoop(tmp, { ...opts, budget: 500, maxPasses: 6, dryStreak: 1 }, deps);

    assert.match(out.stopReason, /COVERAGE INCOMPLETE/, "the terminal reason discloses the coverage debt");
    assert.equal(out.coverageIncomplete, true, "coverageIncomplete is derived at terminal");
    const scoped2 = scopeGroupsForTier(deps.sweep.baseGroups, 2);
    assert.ok(cursor.tierPending(2, deps.sweep.buildManifest(), scoped2, deps.sweep.reviewerSet, deps.sweep.epochHash).count > 0, "tier 2 still has pending cells — it never falsely advanced");
  } finally {
    rmWorkspace(tmp);
  }
});

test("TIER-ADVANCE: full coverage + a dry streak converges cleanly (not incomplete)", async () => {
  const tmp = mkWorkspace();
  try {
    const log = [];
    const gr = mkFakeGroupedReview(tmp, log);
    const opts = sweepOpts({ maxUnits: 1 });
    const cursor = cursorOn(new Map());
    const deps = makeFixLoopDeps(tmp, MODEL, BACKENDS, opts, { runGroupedReview: gr, runAuditFix: noFix, tierSweepCursor: cursor });
    const out = await runFixLoop(tmp, { ...opts, budget: 500, maxPasses: 40, dryStreak: 1 }, deps);

    assert.match(out.stopReason, /epoch-sweep converged/, "walking the full tier plan under 100% coverage converges");
    assert.ok(!out.coverageIncomplete, "a fully-covered sweep is NOT incomplete");
  } finally {
    rmWorkspace(tmp);
  }
});

test("TIER-ADVANCE: a report-only tier (no --structure-auto-apply) is COVERED but never staged to fix()", async () => {
  const tmp = mkWorkspace();
  try {
    const log = [];
    const stagedTiers = new Set();
    // surface a structural finding on the report-only tiers (0/1)
    const gr = mkFakeGroupedReview(tmp, log, { findingsFor: (tier) => tier <= 1 ? [{ file: "a.mjs", lens: tier === 0 ? "logical_sense" : "architecture_ssot", severity: "P1", title: "structural", tier }] : [] });
    const recordFix = async (cwd, actionable) => { for (const f of actionable ?? []) stagedTiers.add(f.tier); return { fixed: [], failed: [], rejected: [], changedFiles: [], spent: 0, branch: "council/x", ok: true }; };
    const opts = sweepOpts();
    const cursor = cursorOn(new Map());
    const deps = makeFixLoopDeps(tmp, MODEL, BACKENDS, opts, { runGroupedReview: gr, runAuditFix: recordFix, tierSweepCursor: cursor });
    const out = await runFixLoop(tmp, { ...opts, budget: 500, maxPasses: 40, dryStreak: 1 }, deps);

    assert.match(out.stopReason, /epoch-sweep converged/, "report-only tiers still advance on 100% coverage");
    assert.ok(![...stagedTiers].some((t) => t < 2), "no tier-0/1 finding was ever staged to the fixer (report-only)");
    // the report-only tiers were still REVIEWED (covered)
    assert.ok(log.some((r) => r.tier === 0) && log.some((r) => r.tier === 1), "the report-only tiers 0 and 1 were reviewed for coverage");
  } finally {
    rmWorkspace(tmp);
  }
});

// ── FIX-INVALIDATION + re-entry ─────────────────────────────────────────────────────────────────

test("FIX-INVALIDATION: a fix that changes a file re-hashes its rows → its cells re-open (re-entry) → re-reviewed", async () => {
  const tmp = mkWorkspace();
  try {
    const log = [];
    let fixed = false;
    // a quality (tier 3) finding on a.mjs, offered once; the fixer MUTATES a.mjs on disk
    const gr = mkFakeGroupedReview(tmp, log, { findingsFor: (tier) => (tier === 3 && !fixed) ? [{ file: "a.mjs", lens: "performance", category: "performance", severity: "P1", title: "slow", tier: 3 }] : [] });
    const mutatingFix = async (cwd, actionable) => {
      if (Array.isArray(actionable) && actionable.length) {
        fixed = true;
        fs.writeFileSync(path.join(tmp, "a.mjs"), "export const a = 42; // changed by the fixer\n");
        return { fixed: actionable.map((f) => ({ file: f.file, finding: f })), failed: [], rejected: [], changedFiles: ["a.mjs"], spent: 1, branch: "council/x", ok: true };
      }
      return { fixed: [], failed: [], rejected: [], changedFiles: [], spent: 0, branch: "council/x", ok: true };
    };
    const opts = sweepOpts({ structureAutoApply: true }); // plan [0,1,2,3] so a fix can re-enter an earlier tier
    const cursor = cursorOn(new Map());
    const deps = makeFixLoopDeps(tmp, MODEL, BACKENDS, opts, { runGroupedReview: gr, runAuditFix: mutatingFix, tierSweepCursor: cursor });
    const out = await runFixLoop(tmp, { ...opts, budget: 500, maxPasses: 40, dryStreak: 1 }, deps);

    const aReviewsAtTier2 = log.filter((r) => r.tier === 2).flatMap((r) => r.files).filter((f) => f === "a.mjs").length;
    assert.ok(aReviewsAtTier2 >= 2, "a.mjs was re-reviewed at tier 2 after the fix re-opened its content-hash cells (re-entry)");
    assert.equal(out.fixed.length, 1, "the fix landed once");
    assert.match(out.stopReason, /epoch-sweep converged/, "after re-covering the re-opened cells, the sweep converges");
  } finally {
    rmWorkspace(tmp);
  }
});

// ── fail-closed resume ──────────────────────────────────────────────────────────────────────────

test("RESUME fail-closed: an epoch mismatch aborts WITHOUT touching the tree (0 passes, fixer never called)", async () => {
  const tmp = mkWorkspace();
  try {
    const store = new Map();
    // seed a ledger written under a DIFFERENT epoch
    const seed = cursorOn(store);
    seed.reset();
    seed.appendHeader({ epochHash: "STALE-EPOCH", reviewers: [], tierPlan: [] });
    seed.sealManifest({ digest: "d", fileCount: 0 });

    let fixCalls = 0;
    const gr = mkFakeGroupedReview(tmp, []);
    const countingFix = async () => { fixCalls += 1; return { fixed: [], failed: [], rejected: [], changedFiles: [], spent: 0, branch: "council/x", ok: true }; };
    const opts = sweepOpts();
    const cursor = cursorOn(store);
    const deps = makeFixLoopDeps(tmp, MODEL, BACKENDS, opts, { runGroupedReview: gr, runAuditFix: countingFix, tierSweepCursor: cursor });
    const out = await runFixLoop(tmp, { ...opts, budget: 500, maxPasses: 5, dryStreak: 1, resume: true },
      { ...deps, loadCheckpoint: () => ({ sweep: { v: 1, epochHash: "STALE-EPOCH", ledgerSeq: 2, manifestDigest: "d", tierPlan: [{ tier: 2, fix: true }], tierPlanIndex: 0 } }) });

    assert.match(out.stopReason, /resume blocked \(fail-closed\).*epoch/i, "an epoch mismatch is a fail-closed blocked resume");
    assert.equal(out.passesRun, 0, "no pass ran");
    assert.equal(fixCalls, 0, "the fixer was never called — the tree is untouched");
  } finally {
    rmWorkspace(tmp);
  }
});

test("RESUME fail-closed: an interior-corrupt ledger aborts WITHOUT touching the tree", async () => {
  const tmp = mkWorkspace();
  try {
    const store = new Map();
    // a valid header then an INVALID interior line then a valid line → corrupt (not a torn tail)
    store.set("/led", '{"v":1,"type":"header","epochHash":"X"}\nNOT-JSON\n{"v":1,"type":"manifest-seal","digest":"d"}\n');
    let fixCalls = 0;
    const gr = mkFakeGroupedReview(tmp, []);
    const countingFix = async () => { fixCalls += 1; return { fixed: [], failed: [], rejected: [], changedFiles: [], spent: 0, branch: "council/x", ok: true }; };
    const opts = sweepOpts();
    const cursor = cursorOn(store);
    const deps = makeFixLoopDeps(tmp, MODEL, BACKENDS, opts, { runGroupedReview: gr, runAuditFix: countingFix, tierSweepCursor: cursor });
    const out = await runFixLoop(tmp, { ...opts, budget: 500, maxPasses: 5, dryStreak: 1, resume: true },
      { ...deps, loadCheckpoint: () => ({ sweep: { v: 1, epochHash: "X", ledgerSeq: 3, manifestDigest: "d", tierPlan: [{ tier: 2, fix: true }], tierPlanIndex: 0 } }) });

    assert.match(out.stopReason, /resume blocked \(fail-closed\).*corrupt/i, "an interior-corrupt ledger fails closed");
    assert.equal(fixCalls, 0, "the fixer was never called");
  } finally {
    rmWorkspace(tmp);
  }
});

// ── HAPPY-PATH RESUME (B): interrupt mid-tier after a fix, resume the same epoch, converge ────────

test("HAPPY-PATH RESUME (B): interrupt mid-tier after a fix → --resume same epoch → digest MATCHES, done cells not re-scheduled, tier restores, converges", async () => {
  const tmp = mkWorkspace();
  try {
    const store = new Map(); // the durable ledger shared across the interrupt/resume boundary
    let cp = null;
    const checkpoint = (state) => { cp = state; };
    const loadCheckpoint = () => cp;

    // PASS 1 (interrupted at maxPasses:1): a tier-2 finding on a.mjs; the fixer MUTATES a.mjs on disk →
    // invalidation re-hashes it + APPENDS the refreshed row at the END + re-seals (the order-dependence B fixes).
    let fixed = false;
    const log1 = [];
    const gr1 = mkFakeGroupedReview(tmp, log1, { findingsFor: (tier) => (tier === 2 && !fixed) ? [{ file: "a.mjs", lens: "correctness", category: "correctness", severity: "P1", title: "bug", tier: 2 }] : [] });
    const mutatingFix = async (cwd, actionable) => {
      if (Array.isArray(actionable) && actionable.length) {
        fixed = true;
        fs.writeFileSync(path.join(tmp, "a.mjs"), "export const a = 99; // fixed by the fixer\n");
        return { fixed: actionable.map((f) => ({ file: f.file, finding: f })), failed: [], rejected: [], changedFiles: ["a.mjs"], spent: 1, branch: "council/x", ok: true };
      }
      return { fixed: [], failed: [], rejected: [], changedFiles: [], spent: 0, branch: "council/x", ok: true };
    };
    const opts = sweepOpts({ runId: "run-happy" }); // plan [2,3,0,1]; starts at tier 2
    const cursor1 = cursorOn(store);
    const deps1 = makeFixLoopDeps(tmp, MODEL, BACKENDS, opts, { runGroupedReview: gr1, runAuditFix: mutatingFix, tierSweepCursor: cursor1 });
    const out1 = await runFixLoop(tmp, { ...opts, budget: 500, maxPasses: 1, dryStreak: 1 }, { ...deps1, checkpoint, loadCheckpoint });

    assert.equal(out1.fixed.length, 1, "the fix landed in the interrupted segment");
    const interruptCp = cp;
    assert.ok(interruptCp?.sweep, "the interrupt checkpoint carries the sweep block");
    assert.equal(interruptCp.currentTier, 2, "interrupted mid tier 2 (a fix pinned it: fix-free settle is false)");
    assert.equal(interruptCp.sweep.tierPlanIndex, 0, "the tier plan did NOT advance past the fixed tier");
    const digestAtInterrupt = interruptCp.sweep.manifestDigest;

    // B — the digest is ORDER-INDEPENDENT: a FRESH reconstruction of the ledger (canonical sort) equals the
    // digest the interrupt sealed, even though invalidation appended a.mjs's refreshed row AFTER b.mjs's.
    const reopened = cursorOn(store).load();
    assert.equal(manifestDigest(reopened.manifest), digestAtInterrupt, "the ledger reconstructs to the SAME digest the interrupt sealed (canonical ordering)");
    assert.ok(reopened.seal && reopened.seal.digest === digestAtInterrupt, "the LAST manifest-seal matches the reconstructed digest");

    // RESUME (same epoch, same config) — fresh deps over the SAME store; the fix already applied.
    const log2 = [];
    const gr2 = mkFakeGroupedReview(tmp, log2);
    const cursor2 = cursorOn(store);
    const deps2 = makeFixLoopDeps(tmp, MODEL, BACKENDS, opts, { runGroupedReview: gr2, runAuditFix: noFix, tierSweepCursor: cursor2 });
    const out2 = await runFixLoop(tmp, { ...opts, budget: 500, maxPasses: 40, dryStreak: 1, resume: true }, { ...deps2, checkpoint, loadCheckpoint });

    assert.ok(!/resume blocked/.test(out2.stopReason ?? ""), `resume must NOT fail closed (digest matched): ${out2.stopReason}`);
    assert.ok(out2.passesRun > 0, "the resume actually ran passes (it was not aborted at init)");
    assert.match(out2.stopReason, /epoch-sweep converged/, "the resumed sweep converges over the re-opened + remaining cells");
    assert.ok(!out2.coverageIncomplete, "a fully re-covered resume is NOT incomplete");

    // Done cells are NOT re-scheduled: b.mjs's tier-2 cells were done before the interrupt and NOT re-opened
    // (only a.mjs was fixed), so the resumed run never re-reviews b.mjs at tier 2 — a.mjs alone re-opened.
    const tier2FilesOnResume = log2.filter((r) => r.tier === 2).flatMap((r) => r.files);
    assert.ok(!tier2FilesOnResume.includes("b.mjs"), "b.mjs (done pre-interrupt, not re-opened) is NOT re-scheduled at tier 2 on resume");
    assert.ok(tier2FilesOnResume.includes("a.mjs"), "a.mjs (re-opened by the fix's content-hash change) IS re-reviewed at tier 2 on resume");
    assert.equal(cp.sweep.tierPlanIndex, 4, "the tier plan (4 entries) was fully walked after resume");
  } finally {
    rmWorkspace(tmp);
  }
});

// ── legacy byte-identical with the flag OFF ─────────────────────────────────────────────────────

test("LEGACY UNCHANGED: with --epoch-sweep OFF, deps.sweep is null and the result is byte-identical", async () => {
  // deps.sweep must be null on the grouped path when the flag is absent (every sweep path is skipped)
  const depsNoFlag = makeFixLoopDeps("/x", MODEL, BACKENDS, { lensGroups: "tier" }, {});
  assert.equal(depsNoFlag.sweep, null, "no sweep machinery is built without --epoch-sweep");

  const review = async () => ({ findings: [], coverage: { budgetSpent: 1, passComplete: true } });
  const fix = async () => ({ fixed: [], failed: [], spent: 0 });
  const flagAbsent = await runFixLoop("/x", { budget: 5, dryStreak: 2 }, { review, fix, checkpoint: () => {} });
  const flagOff = await runFixLoop("/x", { budget: 5, dryStreak: 2, epochSweep: false }, { review, fix, checkpoint: () => {} });
  assert.deepEqual(flagOff, flagAbsent, "epochSweep:false is byte-identical to omitting the option");
  assert.ok(!("coverageIncomplete" in flagAbsent), "the legacy result shape gains no sweep-only fields");
});
