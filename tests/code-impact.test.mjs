// Pins the fix-loop report's code-impact metric — the operator's #1 concern (refactoring/SSOT/code-
// reduction) needs a trustworthy NUMBER. The parse + the structure-fix rule are the only logic; they are
// proven here without a repo. The git wrapper is exercised with a fake runner (no real git, no clock).

import test from "node:test";
import assert from "node:assert/strict";

import { parseNumstat, countStructureFixes, renderCodeImpactLine, computeCodeImpact } from "../plugins/council/scripts/lib/code-impact.mjs";

test("parseNumstat sums added/removed and counts files; binary rows add 0 lines but count as a file", () => {
  const out = ["12\t3\tsrc/a.mjs", "0\t40\tsrc/dead.mjs", "-\t-\tassets/logo.png", "", "garbage line"].join("\n");
  assert.deepEqual(parseNumstat(out), { added: 12, removed: 43, files: 3 });
});

test("parseNumstat is null-safe (no output → zeros, never throws)", () => {
  assert.deepEqual(parseNumstat(undefined), { added: 0, removed: 0, files: 0 });
  assert.deepEqual(parseNumstat(""), { added: 0, removed: 0, files: 0 });
});

test("countStructureFixes: fixLens WINS — a logical_sense finding reattributed to correctness is NOT structure", () => {
  const fixed = [
    { finding: { lens: "logical_sense", fixLens: "architecture_ssot" } }, // genuine structure
    { finding: { lens: "logical_sense", fixLens: "correctness" } },       // REATTRIBUTED → not structure
    { finding: { lens: "architecture_ssot" } },                            // no fixLens → coverage lens counts
    { finding: { lens: "correctness", fixLens: "correctness" } }           // plain correctness
  ];
  assert.equal(countStructureFixes(fixed), 2);
});

test("countStructureFixes tolerates empty / missing finding", () => {
  assert.equal(countStructureFixes([]), 0);
  assert.equal(countStructureFixes(undefined), 0);
  assert.equal(countStructureFixes([{}, { finding: null }]), 0);
});

test("renderCodeImpactLine flags a net reduction and signs the net; null in → null out (line skipped)", () => {
  assert.equal(renderCodeImpactLine(null), null);
  const reduction = renderCodeImpactLine({ added: 4, removed: 60, net: -56, files: 3, structureFixes: 2 });
  assert.match(reduction, /net -56/);
  assert.match(reduction, /net code reduction/);
  assert.match(reduction, /2 structure\/SSOT fix/);
  const growth = renderCodeImpactLine({ added: 30, removed: 5, net: 25, files: 2, structureFixes: 0 });
  assert.match(growth, /net \+25/);
  assert.doesNotMatch(growth, /net code reduction/);
  assert.doesNotMatch(growth, /structure\/SSOT/); // 0 structure fixes → the clause is omitted
});

test("computeCodeImpact returns null when nothing was committed (no fabricated 0)", async () => {
  let called = false;
  const runGit = async () => { called = true; return { status: 0, stdout: "" }; };
  assert.equal(await computeCodeImpact("/repo", { branch: "council/x", baseBranch: "main", fixed: [] }, runGit), null);
  assert.equal(called, false, "must short-circuit before spawning git when fixed is empty");
});

test("computeCodeImpact returns null on git failure rather than a fake metric", async () => {
  const runGit = async () => ({ status: 1, stdout: "", stderr: "fatal" });
  const out = { branch: "council/x", baseBranch: "main", fixed: [{ finding: { lens: "logical_sense", fixLens: "architecture_ssot" } }] };
  assert.equal(await computeCodeImpact("/repo", out, runGit), null);
});

test("computeCodeImpact wires numstat + structure count into one metric (three-dot range)", async () => {
  const calls = [];
  const runGit = async (cmd, args) => { calls.push(args.join(" ")); return { status: 0, stdout: "10\t2\tsrc/a.mjs\n0\t50\tsrc/dead.mjs" }; };
  const out = {
    branch: "council/audit-fix-abc",
    baseBranch: "main",
    fixed: [
      { finding: { lens: "logical_sense", fixLens: "architecture_ssot" } },
      { finding: { lens: "correctness", fixLens: "correctness" } }
    ]
  };
  const m = await computeCodeImpact("/repo", out, runGit);
  assert.deepEqual(m, { added: 10, removed: 52, net: -42, files: 2, structureFixes: 1 });
  assert.match(calls[0], /diff --numstat main\.\.\.council\/audit-fix-abc/);
});
