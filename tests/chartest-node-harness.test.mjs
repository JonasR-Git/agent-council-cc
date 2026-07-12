import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { captureObservable, changedLinesCovered, makeNodeCharHarness } from "../plugins/council/scripts/lib/chartest-node-harness.mjs";
import { runCommandAsync } from "../plugins/council/scripts/lib/process.mjs";

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

test("captureObservable recognizes the '# '-FRAMED observable node --test actually emits (council P1)", () => {
  // Verified on v22.13.1: `console.log(JSON.stringify({sum:5}))` inside a node:test arrives on stdout as
  // the TAP diagnostic line `# {"sum":5}`, never as a bare `{"sum":5}` line — the prior implementation
  // dropped every line starting with "#" wholesale and so captured "" (vacuous) on every real run.
  const real = [
    "TAP version 13",
    '# {"sum":5}',
    "# Subtest: observable",
    "ok 1 - observable",
    "  ---",
    "  duration_ms: 0.9998",
    "  ...",
    "1..1",
    "# tests 1",
    "# suites 0",
    "# pass 1",
    "# fail 0",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 82.6491"
  ].join("\n");
  assert.equal(captureObservable(real), '{"sum":5}', "the '# '-framed JSON is the observable, not dropped as a comment");
  // the volatile "# duration_ms N" SUMMARY comment must still be excluded (not itself valid JSON)
  const realA = real.replace("# duration_ms 82.6491", "# duration_ms 12.0001");
  assert.equal(captureObservable(real), captureObservable(realA), "the summary comment's timing does not affect the observable");
  // a '#'-framed non-JSON comment (e.g. "# tests 1") must still be dropped, framed or not
  assert.equal(captureObservable("# tests 1\n# Subtest: x"), "", "framed prose/summary comments are not observables");
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

test("makeNodeCharHarness disables per-file process isolation so `node --test` never needs to spawn under the sandbox (council P1)", async () => {
  // `node --test` spawns a CHILD PROCESS per test file by default; under --experimental-permission that
  // spawn is denied unless child_process is granted (which would reopen the RCE vector above). The fix is
  // --experimental-test-isolation=none, not --allow-child-process — asserted explicitly so a future edit
  // can't "fix" the spawn denial by re-opening child_process instead.
  let seenArgs = null;
  const h = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", runCommand: async (cmd, args) => { seenArgs = args; return { status: 0, stdout: "ok 1", timedOut: false }; } });
  await h.passesOnUnmodified();
  assert.ok(seenArgs.includes("--experimental-test-isolation=none"), "test isolation is disabled so no child_process spawn is needed");
  assert.ok(!seenArgs.some((a) => a.startsWith("--allow-child-process")), "still not granted — the spawn denial is avoided, not permitted");
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

// ---------------------------------------------------------------------------------------------
// INTEGRATION (council P2): every test above injects runCommand with a hand-crafted stdout shape;
// none of them actually shells out to a real `node --test` under the real default sandbox args, so
// they could not have caught either P1 (the sandbox spawn-denial, or captureObservable dropping the
// '# '-framed observable). These tests use the REAL runCommandAsync (the same function
// chartest-wiring.mjs wires in production) and the REAL default sandboxArgs (not overridden), against
// a target + generated char-test written to a real temp directory.
// ---------------------------------------------------------------------------------------------

function readCoverageDir(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }
  if (!files.length) return null;
  const result = [];
  for (const f of files) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (Array.isArray(doc?.result)) result.push(...doc.result);
    } catch {
      /* skip an unreadable/partial coverage file */
    }
  }
  return { result };
}

// This test FILE is itself run under `node --test` (by the harness's own `runOnce`, and by whatever runs
// this suite), which sets NODE_TEST_CONTEXT=child-v8 on the CURRENT process so it reports back to ITS
// parent test-runner instead of the console. chartest-node-harness.mjs's runOnce spreads the live
// process.env into every spawned command's env; left as-is here, that var would leak into our own
// grandchild `node --test` invocation below, which would then (wrongly) think IT is a coordinated child of
// some other parent runner too — confirmed empirically: with it present the grandchild silently exits 0
// with EMPTY stdout even when the sandbox denies the spawn it should have failed on, masking exactly the
// bug this integration test exists to catch. A real (non-test-nested) invocation of this harness — e.g.
// the actual `audit fix --chartest` CLI — never has this var set, so stripping it here is what makes the
// nested test faithfully reproduce a top-level run, not a workaround for a product bug.
function realRunCommand(cmd, args, opts) {
  const env = { ...opts?.env };
  delete env.NODE_TEST_CONTEXT;
  return runCommandAsync(cmd, args, { ...opts, env });
}

test("INTEGRATION: real `node --test` under the real default sandbox passes + yields a non-empty, deterministic observable (would have caught both P1s)", { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chartest-harness-it-"));
  try {
    const targetFile = path.join(dir, "target.mjs");
    const targetSource = "export function add(a, b) {\n  return a + b;\n}\n";
    fs.writeFileSync(targetFile, targetSource, "utf8");
    const testFile = path.join(dir, "target.chartest.mjs");
    fs.writeFileSync(
      testFile,
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { add } from "./target.mjs";',
        "",
        'test("add characterization", () => {',
        "  const observed = add(2, 3);",
        "  console.log(JSON.stringify({ sum: observed }));",
        "  assert.equal(observed, 5);",
        "});"
      ].join("\n"),
      "utf8"
    );
    // sandboxArgs deliberately NOT passed → exercises the harness's real default baseSandbox, same as
    // production (chartest-wiring.mjs also passes none).
    const h = makeNodeCharHarness({ cwd: dir, testFile, targetFile, changedLines: [2], source: targetSource, runCommand: realRunCommand, timeoutMs: 20_000 });
    assert.equal(await h.passesOnUnmodified(), true, "the generated test passes on the unmodified target under the real sandbox (P1 #1 fixed)");
    const outs = await h.runs(2);
    assert.equal(outs.length, 2, "both repeats ran to completion under the sandbox");
    assert.equal(outs[0], '{"sum":5}', "the console.log observable is captured, not swallowed as TAP framing (P1 #2 fixed)");
    assert.equal(outs[0], outs[1], "the observable is byte-identical across repeats → deterministic");
    const perturbed = await h.perturbedRun();
    assert.equal(perturbed, outs[0], "the observable is unchanged under a perturbed locale/timezone");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("INTEGRATION: coverage-dependent executesTarget/executesModule stay fail-closed under the real sandbox (documented Node permission-model/inspector limitation, not a regression)", { timeout: 30_000 }, async () => {
  // NODE_V8_COVERAGE is collected via V8's inspector; Node's permission model unconditionally restricts
  // opening the inspector with no CLI flag to re-grant it, so a coverage-based check can never observe a
  // count under the sandbox — confirmed separately (not one of the fixed P1s): the coverage directory
  // stays empty regardless of --allow-fs-write/--allow-worker/--allow-addons/--allow-child-process. This
  // pins the CURRENT, SAFE (fail-closed) reality so a future fix to this residual gap has a red test to
  // turn green, and so nobody mistakes "no coverage json ever appears" for a bug in THIS integration test.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chartest-harness-it-cov-"));
  try {
    const targetFile = path.join(dir, "target.mjs");
    const targetSource = "export function add(a, b) {\n  return a + b;\n}\n";
    fs.writeFileSync(targetFile, targetSource, "utf8");
    const testFile = path.join(dir, "target.chartest.mjs");
    fs.writeFileSync(
      testFile,
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { add } from "./target.mjs";',
        "",
        'test("add characterization", () => {',
        "  const observed = add(2, 3);",
        "  console.log(JSON.stringify({ sum: observed }));",
        "  assert.equal(observed, 5);",
        "});"
      ].join("\n"),
      "utf8"
    );
    const coverageDir = path.join(dir, "cov");
    fs.mkdirSync(coverageDir, { recursive: true });
    const h = makeNodeCharHarness({ cwd: dir, testFile, targetFile, changedLines: [2], source: targetSource, runCommand: realRunCommand, readCoverage: readCoverageDir, coverageDir, timeoutMs: 20_000 });
    assert.equal(await h.executesModule(), false, "coverage cannot be collected under the permission sandbox → fails closed (safe, not a false-accept)");
    assert.equal(await h.executesTarget(), false, "same limitation → the changed-line coverage bar also stays fail-closed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
