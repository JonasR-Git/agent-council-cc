import assert from "node:assert/strict";
import test from "node:test";

import { fixKey, gateFindings, runFixLoop } from "../plugins/council/scripts/lib/audit-fixloop.mjs";
import { makeFixLoopDeps } from "../plugins/council/scripts/lib/audit-fixloop-deps.mjs";

const finding = (o) => ({ lens: "correctness", severity: "P1", ...o });
const noCheckpoint = () => {};

test("runs review->fix passes until the dry streak, accumulating committed fixes", async () => {
  let p = 0;
  const review = async () => (p++ === 0 ? { findings: [finding({ file: "a.mjs", title: "bug" })], coverage: { budgetSpent: 2 } } : { findings: [], coverage: { budgetSpent: 1 } });
  const fix = async (actionable) => ({ fixed: actionable.map((f) => ({ file: f.file, finding: f, commit: "abc" })), failed: [], branch: "council/x", changedFiles: ["a.mjs"], spent: 2 });
  const out = await runFixLoop("/x", { budget: 40, dryStreak: 2 }, { review, fix, checkpoint: noCheckpoint });
  assert.equal(out.fixed.length, 1);
  assert.equal(out.branch, "council/x");
  assert.match(out.stopReason, /diminishing returns/);
});

test("--retry-on-limit backs off and retries a rate-limited review instead of stopping", async () => {
  const sleeps = [];
  let reviewCalls = 0;
  const review = async () => {
    reviewCalls += 1;
    if (reviewCalls === 1) throw new Error("HTTP 429 rate limit exceeded"); // transient limit on the first attempt
    return { findings: [finding({ file: "a.mjs", title: "bug" })], coverage: { budgetSpent: 2 } };
  };
  const fix = async (actionable) => ({ fixed: actionable.map((f) => ({ file: f.file, finding: f, commit: "abc" })), failed: [], branch: "council/x", changedFiles: ["a.mjs"], spent: 2 });
  const out = await runFixLoop(
    "/x",
    { budget: 40, dryStreak: 1, retryOnLimit: true, retryLimit: 3 },
    { review, fix, checkpoint: noCheckpoint, sleep: async (ms) => sleeps.push(ms) }
  );
  assert.equal(out.fixed.length, 1, "the loop survived the rate limit and still fixed the finding");
  assert.equal(reviewCalls >= 2, true, "review was retried after the 429");
  assert.equal(sleeps.length >= 1, true, "backed off before retrying");
  assert.ok(!/rate limit/i.test(out.stopReason ?? ""), "a retried limit is not a stop reason");
});

test("B5: fresh PROPOSE-ONLY findings do NOT count as stalled (only fresh auto-fixable that failed)", async () => {
  // Every pass surfaces a NEW finding, but the gate deems them all non-actionable (propose-only,
  // e.g. architecture/SSOT). The OLD stalled rule (fresh>0 && fixed==0) would falsely stop; B5 keys
  // stalled on fresh AUTO-FIXABLE, so this runs to the budget instead of a spurious 'stalled'.
  let p = 0;
  const review = async () => ({ findings: [finding({ file: "a.mjs", title: `proposal ${p++}` })], coverage: { budgetSpent: 1 } });
  const fix = async () => ({ fixed: [], failed: [], rejected: [], spent: 0 });
  const gate = () => ({ actionable: [], surfaced: [], skipped: [], redirected: [] });
  const out = await runFixLoop("/x", { budget: 6, dryStreak: 2 }, { review, fix, gate, checkpoint: noCheckpoint });
  assert.ok(!/stalled/.test(out.stopReason ?? ""), "propose-only findings are not a stall");
  assert.match(out.stopReason, /budget exhausted|max passes/);
});

test("B5: fresh AUTO-FIXABLE findings that fail to apply DO stall (honest stop)", async () => {
  let p = 0;
  const review = async () => ({ findings: [finding({ file: "a.mjs", title: `fixable ${p++}` })], coverage: { budgetSpent: 1 } });
  const fix = async () => ({ fixed: [], failed: [{ reason: "gate red" }], spent: 1 });
  const gate = (findings) => ({ actionable: findings, surfaced: [], skipped: [], redirected: [] });
  const out = await runFixLoop("/x", { budget: 20, dryStreak: 2 }, { review, fix, gate, checkpoint: noCheckpoint });
  assert.match(out.stopReason, /stalled/, "auto-fixable work that never applies is an honest stall");
});

test("B5: an INCOMPLETE six-eyes coverage does not let a zero-fresh pass declare diminishing returns", async () => {
  // review keeps returning the same (already-seen) finding → 0 fresh, but coverage.complete:false.
  const review = async () => ({ findings: [finding({ file: "a.mjs", title: "recurring" })], coverage: { budgetSpent: 1, complete: false } });
  const fix = async (actionable) => ({ fixed: actionable.map((f) => ({ file: f.file, finding: f, commit: "x" })), failed: [], spent: 1 });
  const out = await runFixLoop("/x", { budget: 5, dryStreak: 2 }, { review, fix, checkpoint: noCheckpoint });
  assert.ok(!/diminishing returns/.test(out.stopReason ?? ""), "unreviewed cells block false convergence");
  assert.match(out.stopReason, /budget exhausted|max passes/);
});

test("B5 council (grok P1): per-tier does NOT global-dry-converge before a later tier is fixed", async () => {
  // A recurring tier-2 (correctness) finding: pre-fix, empty tier-0/1 passes made global dry hit
  // dryStop and stop with 'diminishing returns', fixed=[]. Now global dry is suppressed under
  // per-tier, so staging reaches tier 2 and fixes it.
  let done = false;
  const review = async () => ({ findings: done ? [] : [finding({ file: "a.mjs", title: "correctness bug", lens: "correctness" })], coverage: { budgetSpent: 1 } });
  const fix = async (actionable) => {
    if (actionable.length > 0) done = true;
    return { fixed: actionable.map((f) => ({ file: f.file, finding: f, commit: "x" })), failed: [], changedFiles: ["a.mjs"], spent: 1 };
  };
  const out = await runFixLoop("/x", { budget: 60, maxPasses: 30, dryStreak: 2, perTierConvergence: true }, { review, fix, checkpoint: noCheckpoint });
  assert.equal(out.fixed.length, 1, "the tier-2 finding was reached and fixed, not skipped by a premature global-dry stop");
  assert.match(out.stopReason, /all tiers converged/);
});

test("council Codex C2: a recurring PROPOSE-ONLY finding does not pin its tier (later tiers still reached)", async () => {
  // A tier-1 (structure) architecture proposal recurs every pass and is never auto-applied. Before
  // the fix it kept `actionable` non-empty → tierDryStreak reset forever → tier 1 pinned → the
  // tier-2 correctness bug behind it was never reached. Now propose-only findings don't count as
  // live tier work, so the stage advances and the real bug is fixed.
  let correctnessFixed = false;
  const review = async () => ({
    findings: [
      finding({ file: "a.mjs", title: "god module", lens: "architecture_ssot", scope: "cross-cutting", fixDisposition: "propose-only" }),
      ...(correctnessFixed ? [] : [finding({ file: "b.mjs", title: "off-by-one", lens: "correctness" })])
    ],
    coverage: { budgetSpent: 1 }
  });
  const fix = async (actionable) => {
    const auto = actionable.filter((f) => f.scope !== "cross-cutting");
    if (auto.some((f) => f.lens === "correctness")) correctnessFixed = true;
    return {
      fixed: auto.map((f) => ({ file: f.file, finding: f, commit: "x" })),
      rejected: actionable.filter((f) => f.scope === "cross-cutting").map((f) => ({ finding: f, reason: "cross-cutting → propose-only" })),
      failed: [],
      changedFiles: auto.map((f) => f.file),
      spent: 1
    };
  };
  const out = await runFixLoop("/x", { budget: 80, maxPasses: 40, dryStreak: 2, perTierConvergence: true }, { review, fix, checkpoint: noCheckpoint });
  assert.ok(out.fixed.some((f) => f.finding.lens === "correctness"), "the tier-2 correctness bug was reached + fixed despite the recurring tier-1 proposal");
  assert.match(out.stopReason, /all tiers converged/);
});

test("B5 council (grok P2): per-tier position is checkpointed and restored on resume", async () => {
  // persistence: the checkpoint carries currentTier/tierDryStreak/stalledStreak
  let saved = null;
  await runFixLoop("/x", { budget: 4, dryStreak: 1, perTierConvergence: true, maxPasses: 2 }, { review: async () => ({ findings: [], coverage: { budgetSpent: 1 } }), fix: async () => ({ fixed: [], failed: [], spent: 0 }), checkpoint: (s) => { saved = s; } });
  assert.equal(typeof saved.currentTier, "number", "currentTier is persisted");
  assert.equal(typeof saved.tierDryStreak, "number");
  // restore: resuming PAST the last tier converges immediately (proves currentTier was restored, not reset to 0)
  const review = async () => ({ findings: [finding({ file: "a.mjs", title: "x", lens: "correctness" })], coverage: { budgetSpent: 1 } });
  const fix = async (a) => ({ fixed: a.map((f) => ({ file: f.file, finding: f })), failed: [], spent: 1 });
  const out = await runFixLoop("/x", { budget: 20, resume: true, perTierConvergence: true }, { review, fix, loadCheckpoint: () => ({ fixed: [], currentTier: 4, passNo: 2, spent: 1 }), checkpoint: noCheckpoint });
  assert.match(out.stopReason, /all tiers converged/, "resumed at tier 4 (>3) → immediate convergence, not a tier-0 restart");
  assert.equal(out.fixed.length, 0);
});

test("B5 (council codex P1): per-tier starts at Tier 1 (Structure), skipping the empty Logical Tier 0", async () => {
  // Tier 0 (logical_sense) is propose-only and never review-sourced, so starting there burned
  // dryStop warm-up passes every run. currentTier now starts at 1.
  let saved = null;
  await runFixLoop(
    "/x",
    { budget: 4, dryStreak: 5, perTierConvergence: true, maxPasses: 2 },
    { review: async () => ({ findings: [], coverage: { budgetSpent: 1 } }), fix: async () => ({ fixed: [], failed: [], spent: 0 }), checkpoint: (s) => { saved = s; } }
  );
  assert.ok(saved.currentTier >= 1, "no run wastes passes on the structurally-empty Logical tier 0");
});

test("without --retry-on-limit, a rate-limited review still stops the loop (opt-in only)", async () => {
  const review = async () => { throw new Error("HTTP 429 rate limit"); };
  const out = await runFixLoop("/x", { budget: 10 }, { review, fix: async () => ({}), checkpoint: noCheckpoint });
  assert.match(out.stopReason, /review error/);
});

test("a review that did NOT run (ran:false) stops honestly, never declares false convergence", async () => {
  // A throttled/backends-down review returns ran:false with 0 findings. It must NOT be
  // counted toward the dry streak (which would report a clean 'converged' success).
  let calls = 0;
  const review = async () => { calls += 1; return { findings: [], ran: false }; };
  const out = await runFixLoop("/x", { budget: 20, dryStreak: 2 }, { review, fix: async () => ({}), checkpoint: noCheckpoint });
  assert.equal(calls, 1, "stopped on the first non-running review, did not loop to a fake dry convergence");
  assert.match(out.stopReason, /did not run/);
  assert.ok(!/diminishing returns/.test(out.stopReason), "not reported as convergence");
});

test("END-TO-END real wiring: a throttled review (real coverage shape) stops the loop, never false-converges", async () => {
  // Refutes the contract-drift concern: makeFixLoopDeps.review must translate the REAL
  // runAuditReview coverage (0 reviewed, N attempted → all failed) into ran:false so the
  // loop's guard fires. No synthetic {ran:false} shape — the actual dep chain.
  const runAuditReview = async () => ({ findings: [], coverage: { unitsReviewed: 0, unitsSelected: 3, unitsAttempted: 3, budgetSpent: 1 } });
  const deps = makeFixLoopDeps("/x", { files: [{ id: "a.mjs", fanIn: 1 }] }, {}, {}, { runAuditReview });
  const out = await runFixLoop("/x", { budget: 20, dryStreak: 2 }, { review: deps.review, fix: async () => ({ ok: true, fixed: [], changedFiles: [] }), checkpoint: noCheckpoint });
  assert.match(out.stopReason, /did not run/, "throttled real-shape review stops honestly");
  assert.ok(!/diminishing returns/.test(out.stopReason), "never reported as convergence");
});

test("re-scopes each pass to the previous pass's changed files (diff-scoped re-review)", async () => {
  const scopes = [];
  let p = 0;
  const review = async ({ changedFiles }) => {
    scopes.push(changedFiles);
    return p++ === 0 ? { findings: [finding({ file: "a.mjs", title: "b" })], coverage: { budgetSpent: 1 } } : { findings: [], coverage: { budgetSpent: 1 } };
  };
  const fix = async (a) => ({ fixed: a.map((f) => ({ file: f.file, finding: f, commit: "c" })), changedFiles: ["a.mjs"], spent: 1 });
  await runFixLoop("/x", { budget: 20, dryStreak: 1 }, { review, fix, checkpoint: noCheckpoint });
  assert.equal(scopes[0], null, "first pass reviews the full scope");
  assert.deepEqual(scopes[1], ["a.mjs"], "the next pass re-scopes to what changed");
});

test("stops when the agent budget is exhausted", async () => {
  const review = async () => ({ findings: [finding({ file: "a.mjs", title: "b" })], coverage: { budgetSpent: 10 } });
  const fix = async (a) => ({ fixed: a.map((f) => ({ file: f.file, finding: f, commit: "c" })), changedFiles: ["a.mjs"], spent: 10 });
  const out = await runFixLoop("/x", { budget: 20, dryStreak: 9, maxPasses: 50 }, { review, fix, checkpoint: noCheckpoint });
  assert.match(out.stopReason, /budget/);
});

test("a fix that recurs across passes is counted once (dedupe drives convergence)", async () => {
  const review = async () => ({ findings: [finding({ file: "a.mjs", title: "same bug" })], coverage: { budgetSpent: 1 } });
  const fix = async (a) => ({ fixed: a.map((f) => ({ file: f.file, finding: f, commit: "c" })), changedFiles: ["a.mjs"], spent: 1 });
  const out = await runFixLoop("/x", { budget: 30, dryStreak: 2, maxPasses: 6 }, { review, fix, checkpoint: noCheckpoint });
  assert.equal(out.fixed.length, 1, "same file+title fix deduped across passes");
  assert.match(out.stopReason, /diminishing returns/);
});

test("a review or fix error stops the loop gracefully with a reason", async () => {
  const boom = async () => {
    throw new Error("kaboom");
  };
  const r1 = await runFixLoop("/x", { budget: 10 }, { review: boom, fix: async () => ({}), checkpoint: noCheckpoint });
  assert.match(r1.stopReason, /review error.*kaboom/);
  const r2 = await runFixLoop("/x", { budget: 10 }, { review: async () => ({ findings: [finding({ file: "a.mjs", title: "b" })], coverage: { budgetSpent: 1 } }), fix: boom, checkpoint: noCheckpoint });
  assert.match(r2.stopReason, /fix error.*kaboom/);
});

test("resume seeds fixed/spent/branch from the checkpoint instead of re-spending", async () => {
  const prior = { fixed: [{ file: "a.mjs", finding: { title: "old" }, commit: "c" }], proposed: [], spent: 8, passNo: 2, dryStreak: 1, branch: "council/y" };
  const review = async () => ({ findings: [], coverage: { budgetSpent: 1 } });
  const out = await runFixLoop("/x", { budget: 30, resume: true, dryStreak: 2 }, { review, fix: async () => ({ fixed: [], changedFiles: [] }), loadCheckpoint: () => prior, checkpoint: noCheckpoint });
  assert.equal(out.branch, "council/y");
  assert.ok(out.fixed.some((f) => f.finding.title === "old"), "the prior fix is retained, not re-done");
  assert.ok(out.spent >= 8, "prior spend is carried");
});

test("Tier-0 gating surfaces a skipped serious finding as a proposal (never dropped)", async () => {
  let p = 0;
  const review = async () => (p++ === 0 ? { findings: [finding({ file: "dead.mjs", title: "bug in dead" })], coverage: { budgetSpent: 1 } } : { findings: [], coverage: { budgetSpent: 1 } });
  const fix = async () => ({ fixed: [], changedFiles: [], spent: 0 });
  const out = await runFixLoop("/x", { budget: 20, dryStreak: 1, verdictMap: { "dead.mjs": { verdict: "remove", confidence: 0.9 } } }, { review, fix, checkpoint: noCheckpoint });
  assert.ok(out.proposed.some((f) => f.file === "dead.mjs"), "the P1 parked behind a remove? is surfaced, not silently skipped");
});

test("a structured fix blocker (dirty tree / lock / red integration) stops with the real reason, not 'dry'", async () => {
  const review = async () => ({ findings: [finding({ file: "a.mjs", title: "b" })], coverage: { budgetSpent: 1 } });
  const fix = async () => ({ ok: false, error: "working tree not clean" });
  const out = await runFixLoop("/x", { budget: 20 }, { review, fix, checkpoint: noCheckpoint });
  assert.match(out.stopReason, /fix blocked.*working tree not clean/);
});

test("integration going red stops the loop (does not layer more fixes onto a red branch)", async () => {
  const review = async () => ({ findings: [finding({ file: "a.mjs", title: "b" })], coverage: { budgetSpent: 1 } });
  const fix = async (a) => ({ ok: true, integrationFailed: true, branch: "council/x", fixed: a.map((f) => ({ file: f.file, finding: f, commit: "c" })), changedFiles: ["a.mjs"], spent: 1 });
  const out = await runFixLoop("/x", { budget: 20 }, { review, fix, checkpoint: noCheckpoint });
  assert.match(out.stopReason, /fix blocked.*red/i);
  assert.equal(out.branch, "council/x");
});

test("budget is charged via fallback even when a dep under-reports spend (never a no-op)", async () => {
  const review = async () => ({ findings: [finding({ file: "a.mjs", title: "b" })] }); // no coverage.budgetSpent
  const fix = async (a) => ({ ok: true, fixed: a.map((f) => ({ file: f.file, finding: f, commit: "c" })), changedFiles: ["a.mjs"] }); // no spent
  const out = await runFixLoop("/x", { budget: 8, maxPasses: 50, dryStreak: 9 }, { review, fix, checkpoint: noCheckpoint });
  assert.match(out.stopReason, /budget/, "under-reported spend still consumes budget");
});

test("resume clamps out-of-range checkpoint numerics (negative spent can't bypass the budget)", async () => {
  const prior = { fixed: [], failed: [], proposed: [], passes: [], spent: -500, passNo: 0, dryStreak: 0, branch: null };
  const review = async () => ({ findings: [], coverage: { budgetSpent: 1 } });
  const out = await runFixLoop("/x", { budget: 10, resume: true, dryStreak: 1 }, { review, fix: async () => ({ ok: true, fixed: [], changedFiles: [] }), loadCheckpoint: () => prior, checkpoint: noCheckpoint });
  assert.ok(out.spent >= 0, "negative resumed spend clamped to 0");
});

test("blast-radius re-scope: expandScope widens the next pass beyond the literal changed file", async () => {
  const scopes = [];
  let p = 0;
  const review = async ({ changedFiles }) => {
    scopes.push(changedFiles);
    return p++ === 0 ? { findings: [finding({ file: "hub.mjs", title: "b" })], coverage: { budgetSpent: 1 } } : { findings: [], coverage: { budgetSpent: 1 } };
  };
  const fix = async (a) => ({ ok: true, fixed: a.map((f) => ({ file: f.file, finding: f, commit: "c" })), changedFiles: ["hub.mjs"], spent: 1 });
  const expandScope = (changed) => [...changed, "dependent1.mjs", "dependent2.mjs"];
  await runFixLoop("/x", { budget: 20, dryStreak: 1 }, { review, fix, expandScope, checkpoint: noCheckpoint });
  assert.deepEqual(scopes[1], ["hub.mjs", "dependent1.mjs", "dependent2.mjs"], "dependents are re-reviewed, not just the hub");
});

test("the fixer's rejected findings (propose-only / protected) surface as proposals", async () => {
  let p = 0;
  const review = async () => (p++ === 0 ? { findings: [finding({ file: "a.mjs", title: "b" })], coverage: { budgetSpent: 1 } } : { findings: [], coverage: { budgetSpent: 1 } });
  const fix = async () => ({ ok: true, fixed: [], failed: [], rejected: [{ finding: { file: "big.mjs", title: "consolidate", severity: "P2" }, reason: "cross-cutting → propose-only" }], changedFiles: [], spent: 1 });
  const out = await runFixLoop("/x", { budget: 20, dryStreak: 1 }, { review, fix, checkpoint: noCheckpoint });
  assert.ok(out.proposed.some((f) => f.file === "big.mjs" && f.rejectedReason), "the not-auto-fixed product is surfaced, not hidden");
});

test("resume restores changedFiles so it continues the localized scope (not a stale full offset)", async () => {
  const prior = { fixed: [], failed: [], proposed: [], passes: [], spent: 2, passNo: 3, dryStreak: 0, branch: "council/y", changedFiles: ["a.mjs"] };
  const scopes = [];
  const review = async ({ changedFiles }) => {
    scopes.push(changedFiles);
    return { findings: [], coverage: { budgetSpent: 1 } };
  };
  await runFixLoop("/x", { budget: 20, resume: true, dryStreak: 1 }, { review, fix: async () => ({ ok: true, fixed: [], changedFiles: [] }), loadCheckpoint: () => prior, checkpoint: noCheckpoint });
  assert.deepEqual(scopes[0], ["a.mjs"], "resumed run continues the checkpointed scope");
});

test("per-tier convergence processes Structure (tier 1) before Correctness (tier 2)", async () => {
  // Tier 0 (logical_sense) is structurally empty on the review path, so staging starts at Structure.
  let p = 0;
  const review = async () =>
    p++ === 0
      ? { findings: [finding({ lens: "architecture_ssot", file: "s.mjs", title: "t1" }), finding({ lens: "correctness", file: "c.mjs", title: "t2" })], coverage: { budgetSpent: 1 } }
      : { findings: [], coverage: { budgetSpent: 1 } };
  const fixedPasses = [];
  const fix = async (actionable) => {
    fixedPasses.push(actionable.map((f) => f.file));
    return { ok: true, fixed: actionable.map((f) => ({ file: f.file, finding: f, commit: "c" })), changedFiles: [] };
  };
  await runFixLoop("/x", { budget: 40, dryStreak: 1, maxPasses: 20, perTierConvergence: true }, { review, fix, checkpoint: noCheckpoint });
  assert.deepEqual(fixedPasses[0], ["s.mjs"], "Structure (tier 1) is processed before Correctness (tier 2) — no wasted tier-0 pass");
});

test("Tier-0 detector proposals are surfaced in the loop's proposals", async () => {
  const review = async () => ({ findings: [], coverage: { budgetSpent: 1 } });
  const fix = async () => ({ ok: true, fixed: [], changedFiles: [] });
  const logicalProposals = [{ location: { path: "dead.mjs" }, title: "dead capability?", severity: "P2", verdict: "remove" }];
  const out = await runFixLoop("/x", { budget: 20, dryStreak: 1, logicalProposals }, { review, fix, checkpoint: noCheckpoint });
  assert.ok(out.proposed.some((p) => p.file === "dead.mjs" && /Tier-0/.test(p.rejectedReason)), "the dead-module proposal is surfaced");
});

test("requires deps.review and deps.fix", async () => {
  await assert.rejects(runFixLoop("/x", {}, { fix: async () => ({}) }), /requires deps\.review/);
  await assert.rejects(runFixLoop("/x", {}, { review: async () => ({}) }), /requires deps\.fix/);
});

test("gateFindings tier-orders the actionable set and separates surfaced/skipped", () => {
  const g = gateFindings(
    [finding({ lens: "logical_sense", severity: "P1", file: "l.mjs", title: "x" }), finding({ file: "c.mjs", title: "y" })],
    {}
  );
  assert.equal(g.actionable[0].file, "l.mjs", "tier-0 finding ordered first");
  assert.equal(g.skipped.length, 0);
});

test("fixKey is line-independent and separator-normalized", () => {
  assert.equal(fixKey({ file: "src\\a.mjs", finding: { title: "The  Bug" } }), fixKey({ file: "src/a.mjs", finding: { title: "the bug" } }));
});
