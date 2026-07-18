// buildLoopOpts is the SSOT for the options the CLI hands runFixLoop. It exists because the object used to
// be built INLINE in the command handler where no test could reach it, so 12 test files hand-rolled 165
// approximations that silently drifted from production — that drift is exactly how the M9 structure pass
// stayed dead for 17 live passes behind a green suite (9ce65a7). These pin the contract so a caller cannot
// quietly omit a key the loop keys its behaviour on.

import test from "node:test";
import assert from "node:assert/strict";

import { buildLoopOpts } from "../plugins/council/scripts/lib/fix-loop-opts.mjs";
import { NOOP_REPORTER } from "../plugins/council/scripts/lib/progress.mjs";

test("THE M9 LESSON: the structure consent is present at the LOOP level, not only at the fixer seam", () => {
  // runFixLoop derives its tier FLOOR from this. The old hand-rolled harness set the consent only on the
  // runAuditFix impl seam, so the loop itself always saw `undefined` and filtered every tier-0/1 structure
  // finding out before fix() ever saw it. Both places are required; this pins the one that was forgotten.
  assert.equal(buildLoopOpts({ structureAutoApply: true }).structureAutoApply, true);
  assert.equal(buildLoopOpts({}).structureAutoApply, false, "fail-closed: absent consent is never truthy");
});

test("the autonomous-fix invariants are pinned here and cannot be forgotten by a caller", () => {
  const o = buildLoopOpts({});
  assert.equal(o.midPassGuard, true);
  assert.equal(o.durableFindings, true);
  assert.equal(o.failClosedFindings, true, "autonomous fixing must fail CLOSED if the store cannot open");
  assert.equal(o.correlate, true);
});

test("perTierConvergence is the INVERSE of flat (an easy place to silently flip a run's whole strategy)", () => {
  assert.equal(buildLoopOpts({ flat: true }).perTierConvergence, false);
  assert.equal(buildLoopOpts({ flat: false }).perTierConvergence, true);
  assert.equal(buildLoopOpts({}).perTierConvergence, true, "the CLI default is per-tier");
});

test("baseBranch becomes ledgerBaseBranch (the rename is the point — pins the ledger's TRUE base)", () => {
  assert.equal(buildLoopOpts({ baseBranch: "main" }).ledgerBaseBranch, "main");
  assert.equal(buildLoopOpts({}).ledgerBaseBranch, null);
});

test("onProgress is wired from the reporter, and a missing reporter degrades to NOOP (never undefined)", () => {
  const lines = [];
  const rep = { ...NOOP_REPORTER, line: (m) => lines.push(m) };
  const o = buildLoopOpts({ reporter: rep });
  assert.equal(o.reporter, rep);
  o.onProgress("hello");
  assert.deepEqual(lines, ["hello"], "onProgress actually reaches the reporter");
  // A null reporter must not produce `onProgress: undefined` — the loop calls it unconditionally.
  const bare = buildLoopOpts({ reporter: null });
  assert.equal(bare.reporter, NOOP_REPORTER);
  assert.equal(typeof bare.onProgress, "function");
});

test("pass-through values survive verbatim (budget/passes/limits/usage)", () => {
  const o = buildLoopOpts({
    budget: 40000,
    maxPasses: 1000,
    dryStreak: 2,
    maxUnits: 7,
    epochSweep: true,
    retryOnLimit: true,
    retryLimit: 5,
    usageCeiling: "80/80/80",
    usageSince: 123,
    pause5h: "auto:70",
    logicalProposals: [{ id: "x" }],
    importers: { "a.mjs": ["b.mjs"] }
  });
  assert.equal(o.budget, 40000);
  assert.equal(o.maxPasses, 1000);
  assert.equal(o.dryStreak, 2);
  assert.equal(o.maxUnits, 7);
  assert.equal(o.epochSweep, true);
  assert.equal(o.retryOnLimit, true);
  assert.equal(o.retryLimit, 5);
  assert.equal(o.usageCeiling, "80/80/80");
  assert.equal(o.usageSince, 123);
  assert.equal(o.pause5h, "auto:70");
  assert.deepEqual(o.logicalProposals, [{ id: "x" }]);
  assert.deepEqual(o.correlateImporters, { "a.mjs": ["b.mjs"] });
});

test("the key set is pinned — an accidental drop is a silent behaviour change, so make it fail loudly", () => {
  assert.deepEqual(Object.keys(buildLoopOpts({})).sort(), [
    "budget",
    "correlate",
    "correlateImporters",
    "dryStreak",
    "durableFindings",
    "epochSweep",
    "failClosedFindings",
    "ledgerBaseBranch",
    "logicalProposals",
    "maxPasses",
    "maxUnits",
    "midPassGuard",
    "onProgress",
    "pause5h",
    "perTierConvergence",
    "reporter",
    "retryLimit",
    "retryOnLimit",
    "structureAutoApply",
    "structureFirst",
    "usageCeiling",
    "usageSince"
  ]);
});

test("buildLoopOpts threads structureFirst (opt-in structure/SSOT-before-correctness), default false", () => {
  assert.equal(buildLoopOpts({}).structureFirst, false, "default is correctness-first");
  assert.equal(buildLoopOpts({ structureFirst: true }).structureFirst, true, "opt-in threads through to runFixLoop's deriveTierPlan");
});
