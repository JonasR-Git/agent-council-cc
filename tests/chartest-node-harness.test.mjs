import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { captureObservable, changedLinesCovered, makeNodeCharHarness } from "../plugins/council/scripts/lib/chartest-node-harness.mjs";

const fileUrl = (p) => pathToFileURL(path.resolve(p)).href; // a correct file:// URL for any platform

test("captureObservable isolates JSON observable lines from TAP + volatile timing noise", () => {
  const stdout = [
    "TAP version 13",
    '{"observed":42}',
    "# Subtest: f",
    "ok 1 - f",
    "  ---",
    "  duration_ms: 3.1417", // volatile — must be excluded
    "  ...",
    '{"more":[1,2]}',
    "1..1",
    "# tests 1"
  ].join("\n");
  assert.equal(captureObservable(stdout), '{"observed":42}\n{"more":[1,2]}', "only the JSON observables, timing dropped");
  // two runs whose only difference is duration_ms produce an identical capture → deterministic
  const runA = 'TAP version 13\n{"v":1}\n  duration_ms: 1.2\nok 1';
  const runB = 'TAP version 13\n{"v":1}\n  duration_ms: 9.9\nok 1';
  assert.equal(captureObservable(runA), captureObservable(runB), "runner timing does not affect the observable");
  assert.equal(captureObservable("no json here\nok 1 - x"), "", "no observable → empty (acceptCharTest rejects as vacuous)");
});

test("changedLinesCovered: true only when the target's CHANGED lines fall in a covered function range", () => {
  const source = "line1\nline2\nline3\nline4\nline5\n"; // offsets: L1=0-5, L2=6-11, L3=12-17, L4=18-23, L5=24-29
  const abs = path.resolve("/repo/lib/m.mjs");
  const doc = { result: [{ url: fileUrl(abs), functions: [{ ranges: [{ startOffset: 6, endOffset: 17, count: 3 }] }] }] };
  assert.equal(changedLinesCovered(doc, abs, source, [2, 3]), true, "lines 2-3 are in the covered range");
  assert.equal(changedLinesCovered(doc, abs, source, [5]), false, "line 5 is outside every count>0 range");
  assert.equal(changedLinesCovered(doc, abs, source, []), false, "no changed lines → can't verify → fail closed");
  assert.equal(changedLinesCovered({ result: [] }, abs, source, [2]), false, "target absent from coverage → fail closed");
  const uncovered = { result: [{ url: fileUrl(abs), functions: [{ ranges: [{ startOffset: 6, endOffset: 17, count: 0 }] }] }] };
  assert.equal(changedLinesCovered(uncovered, abs, source, [2]), false, "a count:0 range does not cover");
});

const okRun = (stdout) => async () => ({ status: 0, stdout, timedOut: false });

test("makeNodeCharHarness.passesOnUnmodified reflects the run exit; a timeout/nonzero → false", async () => {
  const passing = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", runCommand: okRun("ok 1") });
  assert.equal(await passing.passesOnUnmodified(), true);
  const failing = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", runCommand: async () => ({ status: 1, stdout: "", timedOut: false }) });
  assert.equal(await failing.passesOnUnmodified(), false);
  const timeout = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", runCommand: async () => ({ status: 0, stdout: "", timedOut: true }) });
  assert.equal(await timeout.passesOnUnmodified(), false, "a timeout is not a pass");
});

test("makeNodeCharHarness.runs captures n deterministic observables; a mid-run failure short-lists (→ rejected)", async () => {
  const h = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", runCommand: okRun('TAP version 13\n{"v":7}\nok 1') });
  const outs = await h.runs(3);
  assert.deepEqual(outs, ['{"v":7}', '{"v":7}', '{"v":7}'], "3 identical observable captures");
  let call = 0;
  const flaky = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", runCommand: async () => (call++ === 1 ? { status: 1, stdout: "", timedOut: false } : { status: 0, stdout: '{"v":1}', timedOut: false }) });
  assert.equal((await flaky.runs(3)).length, 1, "a failed repeat truncates the list → acceptCharTest rejects (too few runs)");
});

test("makeNodeCharHarness.executesTarget fails closed without a coverage reader, passes when changed lines covered", async () => {
  const source = "a\nb\nc\n";
  const abs = path.resolve("/r/m.mjs");
  const doc = { result: [{ url: fileUrl(abs), functions: [{ ranges: [{ startOffset: 0, endOffset: 5, count: 1 }] }] }] };
  const noReader = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", changedLines: [1], source, runCommand: okRun("ok 1") });
  assert.equal(await noReader.executesTarget(), false, "no readCoverage/coverageDir → can't verify → false");
  const withCov = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", changedLines: [1, 2], source, coverageDir: "/cov", readCoverage: () => doc, runCommand: okRun("ok 1") });
  assert.equal(await withCov.executesTarget(), true, "changed lines 1-2 covered");
});

test("makeNodeCharHarness SANDBOXES the test run with the Node permission model (council Grok P0 — RCE)", async () => {
  let seenArgs = null;
  const h = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", runCommand: async (cmd, args) => { seenArgs = args; return { status: 0, stdout: "ok 1", timedOut: false }; } });
  await h.passesOnUnmodified();
  assert.ok(seenArgs.includes("--experimental-permission"), "the model-generated test runs under the permission sandbox");
  assert.ok(seenArgs.some((a) => a.startsWith("--allow-fs-read")), "fs reads allowed (import the target); child_process/writes denied by default");
  assert.ok(!seenArgs.some((a) => a.startsWith("--allow-child-process")), "child_process is NOT granted → no shell/spawn exfil");
});

test("makeNodeCharHarness.executesModule is true only when the target actually ran a function (not import-unused)", async () => {
  const abs = path.resolve("/r/m.mjs");
  const ran = { result: [{ url: fileUrl(abs), functions: [{ ranges: [{ startOffset: 0, endOffset: 20, count: 2 }] }] }] };
  const importedOnly = { result: [{ url: fileUrl(abs), functions: [{ ranges: [{ startOffset: 0, endOffset: 20, count: 0 }] }] }] };
  const hRan = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", coverageDir: "/c", readCoverage: () => ran, runCommand: async () => ({ status: 0, stdout: "ok 1", timedOut: false }) });
  assert.equal(await hRan.executesModule(), true, "a count>0 target function → the test exercised the module");
  const hImp = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", coverageDir: "/c", readCoverage: () => importedOnly, runCommand: async () => ({ status: 0, stdout: "ok 1", timedOut: false }) });
  assert.equal(await hImp.executesModule(), false, "imported but no function executed → not a real characterization");
});

test("makeNodeCharHarness.perturbedRun returns the observable under a faked clock/locale (null on failure)", async () => {
  let seenEnv = null;
  const h = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", runCommand: async (cmd, args, opts) => { seenEnv = opts.env; return { status: 0, stdout: '{"tz":"x"}', timedOut: false }; } });
  assert.equal(await h.perturbedRun(), '{"tz":"x"}');
  assert.equal(seenEnv.TZ, "Pacific/Kiritimati", "the clock is perturbed");
  assert.ok(/de_DE/.test(seenEnv.LANG), "the locale is perturbed");
});
