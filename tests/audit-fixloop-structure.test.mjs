// Loop-path structure transform wiring (M9 × M3): `audit fix --loop --structure-auto-apply`.
// The SINGLE-SHOT structure pass is pinned in tests/audit-fix.test.mjs; this file pins the
// LOOP composition the CLI actually runs: runFixLoop drives makeFixLoopDeps, whose
// impl.runAuditFix seam is how council-companion threads { structureAutoApply: true } +
// { runStructureTransform } into EVERY pass's runAuditFix (council-companion.mjs, the
// `structureTransformRunner ? { runAuditFix: ... } : {}` wiring). Everything side-effecting
// (git, fs reads, tests, the transform itself, the reviewers) is an injected fake — no repo,
// no CLI, no network. The loop-level safety contract pinned here:
//   1. consent + runner  → a structural finding IS offered to the transform runner;
//   2. either one absent → the runner is NEVER called, the finding stays a visible proposal,
//      and the default loop path is byte-identical (the tree is never even touched);
//   3. an APPLIED transform lands in the loop's fixed set (not its proposals) and the loop's
//      budget / re-scope / convergence accounting sees it;
//   4. a REFUSED transform keeps the finding proposed WITH the reason — no stall, no false stop;
//   5. a STRANDED transform (unrestorable tree) aborts the loop on that pass — a later pass
//      must never stage un-reviewed bytes on a dirty tree.
// Tests run in FLAT convergence mode (runFixLoop's pure default). The CLI defaults --per-tier,
// which only changes WHICH pass offers a tier's findings to fix() — the consent/gate wiring
// inside each pass, which is what this file pins, is identical in both modes.

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runFixLoop } from "../plugins/council/scripts/lib/audit-fixloop.mjs";
import { makeFixLoopDeps } from "../plugins/council/scripts/lib/audit-fixloop-deps.mjs";
import { runAuditFix } from "../plugins/council/scripts/lib/audit-fix.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "council-fixloop-structure-"));

// Two known model files so the loop's re-scope path (expandScope / scoped review) has real ids.
const model = {
  files: [
    { id: "a.mjs", fanIn: 1, isTest: false },
    { id: "b.mjs", fanIn: 1, isTest: false }
  ],
  graph: { importers: {} },
  dupClusters: []
};

// A raw reviewer finding in a STRUCTURE lens. makeFixLoopDeps's review wrapper canonicalizes it
// (normalizeFindings): architecture_ssot is propose-only by lens registry, so it reaches
// runAuditFix as scope cross-cutting / fixDisposition propose-only — exactly the shape the
// single-file writer must reject and ONLY the double-consented structure pass may apply.
const structuralRaw = () => ({
  lens: "architecture_ssot",
  category: "ssot",
  severity: "P1",
  scope: "cross-cutting",
  file: "a.mjs",
  line: 3,
  title: "duplicated config parsing — consolidate to one SSOT module"
});

// Reviewer scripts: the finding appears on pass 1 only (consolidated away), or recurs every pass.
const oncePass1 = (pass) => (pass === 1 ? [structuralRaw()] : []);
const everyPass = () => [structuralRaw()];

// Same fake git shape as tests/audit-fix.test.mjs (records mutating calls; head moves on commit).
function fakeGit() {
  const calls = [];
  let head = "base0000ffffffff";
  let changed = [];
  return {
    calls,
    isRepo: () => true,
    isClean: () => true,
    head: () => head,
    currentBranch: () => "master",
    createAndCheckout: (b, ref) => calls.push(["createAndCheckout", b, ref]),
    checkout: (r) => (calls.push(["checkout", r]), true),
    changedFiles: () => changed,
    resetHard: (ref) => {
      calls.push(["resetHard", ref]);
      changed = [];
    },
    commitFile: (file, msg) => {
      calls.push(["commitFile", file, msg]);
      head = `commit${calls.length}`;
      changed = [];
      return head;
    }
  };
}

/**
 * Compose the REAL loop pieces the way council-companion wires `--loop --structure-auto-apply`:
 * runFixLoop → makeFixLoopDeps → impl.runAuditFix seam → the REAL runAuditFix. Only when the
 * harness is given `consent`/`runner` is anything threaded — { structureAutoApply: true } spread
 * into the options and { runStructureTransform } into the deps, mirroring the CLI's
 * `structureTransformRunner ? { runAuditFix: ... } : {}` (absent the flag, NOTHING is added, so
 * the default path stays byte-identical). `reviewFindings(pass)` scripts the fake reviewer.
 */
function loopHarness({ consent = false, runner = null, reviewFindings }) {
  const cwd = tmp();
  const git = fakeGit();
  const reviewScopes = []; // file ids each review pass actually saw (pins the re-scope)
  let reviewCalls = 0;
  let fixCalls = 0;
  const impl = {
    runAuditReview: async (rcwd, m) => {
      reviewCalls += 1;
      reviewScopes.push(m.files.map((f) => f.id));
      return { findings: reviewFindings(reviewCalls) ?? [], coverage: { unitsSelected: 1, unitsReviewed: 1, budgetSpent: 1 } };
    },
    runAuditFix: (fixCwd, fixFindings, fixBackends, fixOptions, fixDeps) => {
      fixCalls += 1;
      return runAuditFix(
        fixCwd,
        fixFindings,
        fixBackends,
        consent ? { ...fixOptions, structureAutoApply: true } : fixOptions,
        {
          ...fixDeps,
          // hermetic side-effect fakes (the same injection seam tests/audit-fix.test.mjs uses)
          git,
          fileExists: () => true,
          readFile: () => "export const x = 1;\n",
          testCmd: { cmd: "true", args: [] },
          runTests: async () => ({ ok: true }),
          runOracle: async () => ({ ok: true }),
          resolveLedger: () => true,
          ...(runner ? { runStructureTransform: runner } : {})
        }
      );
    }
  };
  const deps = makeFixLoopDeps(cwd, model, {}, {}, impl);
  const run = (opts = {}) => runFixLoop(cwd, { budget: 40, maxPasses: 6, dryStreak: 2, ...opts }, { ...deps, checkpoint: () => {} });
  return { run, git, reviewScopes, reviewCalls: () => reviewCalls, fixCalls: () => fixCalls };
}

test("M9×M3: a loop pass OFFERS a structural finding to the injected runStructureTransform under strict consent", async () => {
  const offered = [];
  const runner = async (args, ctx) => {
    offered.push({ args, ctx });
    return { ok: false, reason: "gate not satisfied (test stub)" };
  };
  const h = loopHarness({ consent: true, runner, reviewFindings: oncePass1 });
  await h.run();

  assert.equal(offered.length, 1, "the structural finding reached the transform runner exactly once");
  assert.equal(offered[0].args.finding.lens, "architecture_ssot");
  assert.match(offered[0].args.finding.title, /consolidate to one SSOT/);
  // It arrived via the propose-only rejection channel: the single-file writer refused it FIRST
  // (capability boundary), and only then was it offered to the gated multi-file transform.
  assert.equal(offered[0].args.finding.fixDisposition, "propose-only");
  assert.equal(offered[0].args.snapshot, "base0000ffffffff", "the pre-transform snapshot rides along for the revert path");
  assert.equal(offered[0].ctx.git, h.git, "the runner gets the SAME git handle the fix pass uses (one tree, one rollback authority)");
  assert.equal(offered[0].ctx.options.structureAutoApply, true, "the strict === true consent is visible at the transform layer");
});

test("M9×M3: WITHOUT consent the runner is NEVER called — and the default loop path is byte-identical", async () => {
  let ran = 0;
  const runner = async () => {
    ran += 1;
    return { ok: true, commit: "must-never-happen" };
  };
  // Runner injected but NO consent — mirrors a wiring slip where the dep leaks without the flag.
  // runAuditFix's strict `options.structureAutoApply === true` check must keep it inert.
  const noConsent = loopHarness({ consent: false, runner, reviewFindings: oncePass1 });
  const outNoConsent = await noConsent.run();
  assert.equal(ran, 0, "no structureAutoApply === true → the transform machinery is inert");
  assert.equal(outNoConsent.fixed.length, 0);
  assert.equal(outNoConsent.proposed.length, 1, "the structural finding is surfaced as a proposal, never dropped");
  assert.match(outNoConsent.proposed[0].rejectedReason, /cross-cutting → propose-only/);
  assert.deepEqual(noConsent.git.calls, [], "the tree is never touched — no branch, no commit, no reset");

  // The TRUE default (no runner, no consent — the CLI passes no impl seam at all without the
  // flag) must produce the IDENTICAL loop outcome as runner-without-consent.
  const dflt = loopHarness({ consent: false, runner: null, reviewFindings: oncePass1 });
  const outDefault = await dflt.run();
  const shape = (o) => ({ fixed: o.fixed, proposed: o.proposed, passes: o.passes, spent: o.spent, stopReason: o.stopReason });
  assert.deepEqual(shape(outNoConsent), shape(outDefault), "runner-without-consent behaves exactly like the default loop path");
  assert.deepEqual(dflt.git.calls, [], "the default path never touches the tree either");
});

test("M9×M3: consent WITHOUT an injected runner applies nothing (fail-closed) — the finding stays a proposal", async () => {
  const h = loopHarness({ consent: true, runner: null, reviewFindings: oncePass1 });
  const out = await h.run();
  assert.equal(out.fixed.length, 0, "consent alone must not fabricate a transform path");
  assert.equal(out.proposed.length, 1);
  assert.match(out.proposed[0].rejectedReason, /propose-only/);
  assert.deepEqual(h.git.calls, [], "nothing staged, nothing committed");
});

test("M9×M3: an APPLIED transform lands in the loop's FIXED set — not its proposals — and the accounting sees it", async () => {
  const runner = async () => ({ ok: true, commit: "s7ruc7ur3c0mm17", gates: { council: { approved: true } } });
  const h = loopHarness({ consent: true, runner, reviewFindings: oncePass1 });
  const out = await h.run();

  assert.equal(out.fixed.length, 1, "the transform is a loop-level FIX");
  assert.equal(out.fixed[0].commit, "s7ruc7ur3c0mm17");
  assert.equal(out.fixed[0].verified, true, "an applied transform cleared the full ladder — it counts as verified");
  assert.equal(out.proposed.length, 0, "it LEFT the proposal set (never double-reported)");
  assert.equal(out.passes[0].fixed, 1, "the pass record counted the applied transform");
  // Budget accounting: 3 review calls (1 each) + the transform pass's spent (fixed+failed = 1) = 4.
  assert.equal(out.spent, 4, "the loop CHARGED the transform pass (fx.spent), not just the reviews");
  assert.deepEqual(out.changedFiles, ["a.mjs"], "the transformed file is the loop's reported change set");
  // Convergence saw it: the next pass was RE-SCOPED to the transformed file's blast radius…
  assert.deepEqual(h.reviewScopes[1], ["a.mjs"], "the pass after the transform re-reviews the transformed file, not the full model");
  // …and the loop then converges dry — an applied transform never wedges convergence.
  assert.match(out.stopReason, /diminishing returns/);
});

test("M9×M3: a REFUSED transform keeps the finding proposed WITH the reason — no stall, no false convergence", async () => {
  let refusals = 0;
  const runner = async () => {
    refusals += 1;
    return { ok: false, reason: "§6 council not unanimous (dissent: grok)" };
  };
  // Unfixed → the reviewer keeps finding it every pass.
  const h = loopHarness({ consent: true, runner, reviewFindings: everyPass });
  const out = await h.run();

  assert.equal(out.fixed.length, 0);
  assert.equal(out.proposed.length, 1, "surfaced once (fingerprint-deduped across passes), never dropped");
  assert.match(out.proposed[0].rejectedReason, /structure transform not applied: §6 council not unanimous/, "the operator learns WHY");
  assert.ok(!/stalled/.test(out.stopReason ?? ""), "a propose-only structural refusal is NOT a stall (only fresh auto-fixable work that fails to apply stalls)");
  assert.match(out.stopReason, /diminishing returns/, "the loop converges HONESTLY: dry, with the refusal surfaced as a proposal");
  assert.equal(out.passesRun, 3, "…after its normal dry streak — no early wedge, no endless spin");
  assert.equal(refusals, 3, "the refused transform is re-OFFERED each pass (a refusal is a per-pass gate verdict, not a silent blacklist)");
});

test("M9×M3: a STRANDED transform aborts the LOOP on that pass — no later pass stages bytes on the dirty tree", async () => {
  let offered = 0;
  const runner = async () => {
    offered += 1;
    return { ok: false, stranded: true, reason: "reset --hard failed mid-transform" };
  };
  const h = loopHarness({ consent: true, runner, reviewFindings: everyPass });
  const out = await h.run();

  assert.equal(out.passesRun, 1, "the loop stopped ON the stranded pass");
  assert.equal(h.fixCalls(), 1, "no second fix pass ever ran against the unrestorable tree");
  assert.equal(h.reviewCalls(), 1, "…and no second review either");
  assert.equal(offered, 1);
  assert.equal(out.fixed.length, 0, "nothing is reported fixed on a stranded run");
  assert.match(out.stopReason, /fix blocked on pass 1/, "the stop is a structured fix blocker, never 'dry'");
  // KNOWN reporting gap (documented, not fixed here — audit-fixloop.mjs belongs to another agent):
  // runAuditFix's stranded return carries the cause in `aborted`/`stranded` but sets no `error`,
  // and runFixLoop threads only `fx.error` into its stop reason — so the message falls back to
  // the generic integration-red text instead of naming the unrestorable tree. The SAFETY property
  // (abort; zero further passes) holds; only the reason STRING is conflated. If the loop ever
  // threads fx.aborted into the stop reason, flip this assertion to match the true cause.
  assert.ok(!/unrestorable|stranded/i.test(out.stopReason), "pins the current (conflated) reason text — see comment above");
});
