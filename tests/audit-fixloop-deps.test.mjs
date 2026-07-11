import assert from "node:assert/strict";
import test from "node:test";

import { makeFixLoopDeps } from "../plugins/council/scripts/lib/audit-fixloop-deps.mjs";

const model = { files: [{ id: "a.mjs", fanIn: 2 }, { id: "hub.mjs", fanIn: 12 }, { id: "b.mjs", fanIn: 1 }] };

test("review scopes to changedFiles when set; full-scope passes advance the window", async () => {
  const calls = [];
  const runAuditReview = async (cwd, m, backends, opts) => {
    calls.push({ files: m.files.map((f) => f.id), opts });
    return { findings: [], coverage: { budgetSpent: 1 } };
  };
  const deps = makeFixLoopDeps("/x", model, {}, { maxUnits: 5 }, { runAuditReview });
  await deps.review({ budget: 10, pass: 1, changedFiles: null });
  await deps.review({ budget: 10, pass: 2, changedFiles: null });
  await deps.review({ budget: 10, pass: 3, changedFiles: ["a.mjs"] });
  assert.deepEqual(calls[0].files, ["a.mjs", "hub.mjs", "b.mjs"], "full scope reviews the whole model");
  assert.equal(calls[0].opts.unitOffset, 0);
  assert.equal(calls[1].opts.unitOffset, 5, "pass 2 advances the hotspot window");
  assert.equal(calls[1].opts.skipReduce, true, "the SSOT reduce runs once");
  assert.deepEqual(calls[2].files, ["a.mjs"], "a scoped pass restricts the model to changed files");
  assert.equal(calls[2].opts.unitOffset, 0);
});

test("fix threads branch + stayOnBranch (and severity/max) to runAuditFix", async () => {
  let seen;
  const runAuditFix = async (cwd, findings, backends, opts) => {
    seen = opts;
    return { ok: true, fixed: [], changedFiles: [], spent: 0 };
  };
  const deps = makeFixLoopDeps("/x", model, {}, { minSeverity: "P1", maxFixesPerPass: 3 }, { runAuditFix });
  await deps.fix([{ file: "a.mjs" }], { branch: "council/z", stayOnBranch: true });
  assert.equal(seen.branch, "council/z");
  assert.equal(seen.stayOnBranch, true);
  assert.equal(seen.minSeverity, "P1");
  assert.equal(seen.maxFixes, 3);
});

test("expandScope forces a full re-scope after a hub-file change, stays narrow for a leaf", () => {
  const deps = makeFixLoopDeps("/x", model, {}, { hubFanIn: 8 });
  assert.deepEqual(deps.expandScope(["b.mjs"]), ["b.mjs"], "a leaf change stays narrow");
  assert.deepEqual(deps.expandScope(["hub.mjs"]), [], "a hub change -> full re-scope (empty signals full)");
  assert.deepEqual(deps.expandScope(["a.mjs", "hub.mjs"]), [], "any hub in the set forces full re-scope");
});

test("verdictsFor returns the configured verdict map (empty by default)", () => {
  assert.deepEqual(makeFixLoopDeps("/x", model, {}, {}).verdictsFor(), {});
  assert.deepEqual(makeFixLoopDeps("/x", model, {}, { verdictMap: { "a.mjs": { verdict: "remove" } } }).verdictsFor(), { "a.mjs": { verdict: "remove" } });
});
