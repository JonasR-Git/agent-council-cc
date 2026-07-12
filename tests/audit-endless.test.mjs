import assert from "node:assert/strict";
import test from "node:test";

import { dedupeNew, endlessKey, endlessStopReason, runEndless } from "../plugins/council/scripts/lib/audit-endless.mjs";

const noCheckpoint = () => {};
const f = (file, title, extra = {}) => ({ severity: "P2", file, title, ...extra });

// --- pure helpers ------------------------------------------------------------

test("dedupeNew keeps only unseen fingerprints and records them", () => {
  const seen = new Set();
  const a = dedupeNew([f("a.mjs", "empty catch swallows error"), f("b.mjs", "missing null guard here")], seen);
  assert.equal(a.length, 2);
  // same file+title => same fingerprint => not fresh the second time
  const b = dedupeNew([f("a.mjs", "empty catch swallows error"), f("c.mjs", "new distinct problem token")], seen);
  assert.equal(b.length, 1);
  assert.equal(b[0].file, "c.mjs");
});

test("endlessStopReason fires on max passes, budget, and diminishing returns", () => {
  const limits = { maxPasses: 5, totalBudget: 20, dryStop: 2 };
  assert.equal(endlessStopReason({ passNo: 0, spent: 0, dryStreak: 0 }, limits), null);
  assert.match(endlessStopReason({ passNo: 5, spent: 0, dryStreak: 0 }, limits), /max passes/);
  assert.match(endlessStopReason({ passNo: 1, spent: 20, dryStreak: 0 }, limits), /budget exhausted/);
  assert.match(endlessStopReason({ passNo: 1, spent: 0, dryStreak: 2 }, limits), /diminishing/);
});

// --- loop with injected review ----------------------------------------------

test("runEndless stops on diminishing returns when passes stop finding anything new", async () => {
  const review = async () => ({ findings: [f("a.mjs", "the one recurring finding token")], coverage: { budgetSpent: 1 } });
  const out = await runEndless("/x", { maxPasses: 20, dryStreak: 2, budget: 60 }, { review, checkpoint: noCheckpoint });
  assert.match(out.stopReason, /diminishing/);
  assert.equal(out.findings.length, 1, "the recurring finding is counted once");
  assert.equal(out.passesRun, 3, "pass1 fresh, pass2+pass3 dry => stop after 2 dry");
});

test("runEndless stops at the max-pass ceiling when every pass finds something new", async () => {
  const review = async ({ pass }) => ({ findings: [f(`m${pass}.mjs`, `distinct problem number ${pass} alpha`)], coverage: { budgetSpent: 1 } });
  const out = await runEndless("/x", { maxPasses: 3, dryStreak: 5, budget: 100 }, { review, checkpoint: noCheckpoint });
  assert.match(out.stopReason, /max passes/);
  assert.equal(out.passesRun, 3);
  assert.equal(out.findings.length, 3, "three unique findings accumulated");
});

test("B5: an INCOMPLETE six-eyes coverage never lets a zero-fresh pass declare diminishing returns", async () => {
  // Every pass finds the same (already-seen) finding → 0 fresh, but coverage is NOT complete, so
  // there are still unreviewed cells → the dry streak must NOT advance. The loop runs to maxPasses.
  const review = async () => ({ findings: [f("a.mjs", "recurring token")], coverage: { budgetSpent: 1, complete: false } });
  const out = await runEndless("/x", { maxPasses: 4, dryStreak: 2, budget: 100 }, { review, checkpoint: noCheckpoint });
  assert.match(out.stopReason, /max passes/, "incomplete coverage blocks false convergence");
  assert.equal(out.passesRun, 4);
  assert.equal(out.dryStreak, 0, "the dry streak never advanced while cells were unreviewed");
});

test("B5: once coverage IS complete, a zero-fresh pass converges as before", async () => {
  const review = async () => ({ findings: [f("a.mjs", "recurring token")], coverage: { budgetSpent: 1, complete: true } });
  const out = await runEndless("/x", { maxPasses: 20, dryStreak: 2, budget: 100 }, { review, checkpoint: noCheckpoint });
  assert.match(out.stopReason, /diminishing/);
  assert.equal(out.passesRun, 3);
});

test("runEndless respects the finite total budget", async () => {
  // each pass charges exactly the budget it is handed
  const review = async ({ pass, budget }) => ({ findings: [f(`b${pass}.mjs`, `unique budget token ${pass} beta`)], coverage: { budgetSpent: budget } });
  const out = await runEndless("/x", { maxPasses: 100, dryStreak: 50, budget: 25 }, { review, checkpoint: noCheckpoint });
  assert.match(out.stopReason, /budget exhausted/);
  assert.ok(out.spent >= 25, "did not exceed... but reached the budget");
  assert.ok(out.spent <= 25, "budget is a hard ceiling (per-pass allotment is clamped to what remains)");
});

test("runEndless ends cleanly on a review error, keeping prior findings", async () => {
  let n = 0;
  const review = async () => {
    n += 1;
    if (n === 2) throw new Error("backend blew up");
    return { findings: [f(`p${n}.mjs`, `token for pass ${n} gamma delta`)], coverage: { budgetSpent: 1 } };
  };
  const out = await runEndless("/x", { maxPasses: 10, dryStreak: 3, budget: 60 }, { review, checkpoint: noCheckpoint });
  assert.match(out.stopReason, /review error/);
  assert.equal(out.findings.length, 1, "pass-1 findings are retained after the pass-2 error");
  assert.ok(out.passes.some((p) => p.error));
});

test("runEndless requires an injected review function", async () => {
  await assert.rejects(() => runEndless("/x", {}, { checkpoint: noCheckpoint }), /requires deps\.review/);
});

// --- hardening (council-0af8fb8f) -------------------------------------------

test("endlessKey distinguishes different titles/categories but ignores the line number", () => {
  // opposite-direction bugs in the same file must NOT collide (former token bug)
  assert.notEqual(endlessKey(f("a.mjs", "CSRF via GET")), endlessKey(f("a.mjs", "CSRF via PUT")));
  assert.notEqual(endlessKey(f("a.mjs", "same title", { category: "bug" })), endlessKey(f("a.mjs", "same title", { category: "security" })));
  // same issue reported at a drifting line must map to the SAME key (no false "fresh")
  assert.equal(endlessKey(f("a.mjs", "off-by-one", { line: 12 })), endlessKey(f("a.mjs", "off-by-one", { line: 480 })));
});

test("dedupeNew does not drop distinct findings that share tokens", () => {
  const seen = new Set();
  const fresh = dedupeNew([f("a.mjs", "CSRF via GET"), f("a.mjs", "CSRF via PUT")], seen);
  assert.equal(fresh.length, 2, "both distinct CSRF findings survive");
});

test("runEndless hard-clamps spent to the total budget even if a pass over-reports", async () => {
  const review = async ({ pass }) => ({ findings: [f(`o${pass}.mjs`, `over token ${pass}`)], coverage: { budgetSpent: 1000 } });
  const out = await runEndless("/x", { maxPasses: 100, dryStreak: 50, budget: 10 }, { review, checkpoint: noCheckpoint });
  assert.match(out.stopReason, /budget exhausted/);
  assert.ok(out.spent <= 10, `spent (${out.spent}) never exceeds the total budget`);
});

test("runEndless writes a per-pass checkpoint (done:false) and a final one (done:true)", async () => {
  const writes = [];
  const review = async ({ pass }) => ({ findings: [f(`c${pass}.mjs`, `cp token ${pass}`)], coverage: { budgetSpent: 1 } });
  const out = await runEndless("/x", { maxPasses: 2, dryStreak: 9, budget: 60 }, { review, checkpoint: (s) => writes.push(s) });
  assert.equal(writes.filter((w) => w.done === false).length, 2, "one non-final checkpoint per pass");
  const final = writes[writes.length - 1];
  assert.equal(final.done, true);
  assert.match(final.stopReason, /max passes/);
  assert.equal(final.findings.length, out.findings.length);
});

test("runEndless resumes from a prior checkpoint instead of restarting", async () => {
  const prior = { findings: [f("old.mjs", "prior finding token")], spent: 5, passNo: 2, dryStreak: 0 };
  const review = async ({ pass }) => ({ findings: [f("old.mjs", "prior finding token"), f(`new${pass}.mjs`, `fresh token ${pass}`)], coverage: { budgetSpent: 1 } });
  const out = await runEndless(
    "/x",
    { maxPasses: 3, dryStreak: 9, budget: 60, resume: true },
    { review, checkpoint: noCheckpoint, loadCheckpoint: () => prior }
  );
  assert.equal(out.passesRun, 3, "continued at pass 3, not from 1");
  assert.ok(out.spent > 5, "budget continued from the resumed spend");
  assert.equal(out.findings.filter((x) => x.file === "old.mjs").length, 1, "the resumed finding is not re-emitted");
  assert.ok(out.findings.some((x) => x.file === "new3.mjs"), "the new pass-3 finding is accumulated");
});
