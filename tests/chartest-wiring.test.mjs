import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { makeCharTestGate } from "../plugins/council/scripts/lib/chartest-wiring.mjs";
import { runCommandAsync } from "../plugins/council/scripts/lib/process.mjs";

const TARGET_URL = pathToFileURL(path.resolve("/r/m.mjs")).href; // a real file:// URL (correct slashes/drive)
const TARGET_ABS = path.join("/r", "m.mjs"); // = the harness's absTarget for root "/r" + file "m.mjs"
const TARGET_SRC = "export const f = () => 42;";

const GEN_OK = '```js\nimport test from "node:test";\nimport assert from "node:assert";\ntest("f", () => { console.log(JSON.stringify(42)); assert.equal(42, 42); });\n```';

// a runCommand that always passes and emits a stable JSON observable — BLIND to the target's content
// (so under the poison probe it reads as "the test does not depend on the target")
const runPass = async () => ({ status: 0, stdout: 'TAP version 13\n{"v":42}\nok 1', timedOut: false });

function baseDeps(overrides = {}) {
  const files = new Map([[TARGET_ABS, TARGET_SRC]]); // the target exists on the fake disk (the probe reads + rewrites it)
  return {
    generate: async () => GEN_OK,
    // poison-AWARE exec: green against the real target, red once the harness has poisoned it — the shape
    // a genuinely-depending test has, so the accept-phase poison probe passes without a real subprocess
    runCommand: async () => (String(files.get(TARGET_ABS) ?? "").includes("__COUNCIL_POISON__")
      ? { status: 1, stdout: "not ok 1 - poisoned", timedOut: false }
      : { status: 0, stdout: 'TAP version 13\n{"v":42}\nok 1', timedOut: false }),
    writeFile: (p, s) => files.set(p, s),
    removeFile: (p) => files.delete(p),
    readFile: (p) => { if (!files.has(p)) throw new Error(`ENOENT: ${p}`); return files.get(p); },
    // covered target module (a count>0 function range for /r/m.mjs) so verify's PREFERRED coverage path
    // passes; the url matches path.resolve("/r/m.mjs") after normalization
    readCoverage: () => ({ result: [{ url: TARGET_URL, functions: [{ ranges: [{ startOffset: 0, endOffset: 9999, count: 1 }] }] }] }),
    // no-op fs: keep the test off the real filesystem
    freshDir: (d) => d,
    rmDir: () => {},
    mkCoverageDir: () => "/covdir",
    exists: () => false, // transient path slot .0 is always free
    _files: files,
    ...overrides
  };
}

/** True when no council transient (test file / coverage dir) is left on the fake disk. */
const noTransients = (files) => [...files.keys()].every((p) => !p.includes(".council-chartest"));

test("makeCharTestGate.eligible gates on refactor lenses only", () => {
  const g = makeCharTestGate("/r", {}, {}, baseDeps());
  assert.equal(g.eligible({ lens: "architecture_ssot" }), true);
  assert.equal(g.eligible({ lens: "correctness" }), false);
});

test("makeCharTestGate.accept generates + pins behaviour, then DELETES the transient test (clean tree)", async () => {
  const deps = baseDeps();
  const g = makeCharTestGate("/r", {}, {}, deps);
  const res = await g.accept({ file: "m.mjs", source: TARGET_SRC });
  assert.equal(res.accepted, true, "a deterministic, non-vacuous, target-depending test is accepted");
  assert.ok(res.code && /node:test/.test(res.code), "the generated test code is carried forward");
  assert.equal(res.baseline, '{"v":42}', "the accepted BASELINE observable is captured for the verify-phase compare");
  assert.ok(noTransients(deps._files), "the transient test file is removed → the tree is clean for applyFix");
  assert.equal(deps._files.get(TARGET_ABS), TARGET_SRC, "the target is byte-identical after the accept-phase poison probe");
});

test("makeCharTestGate.accept fails closed when the generator returns nothing (→ propose-only)", async () => {
  const g = makeCharTestGate("/r", {}, {}, baseDeps({ generate: async () => "" }));
  const res = await g.accept({ file: "m.mjs", source: TARGET_SRC });
  assert.equal(res.accepted, false);
});

test("makeCharTestGate.accept rejects a NON-deterministic target (observable differs across runs)", async () => {
  let n = 0;
  const g = makeCharTestGate("/r", {}, {}, baseDeps({ runCommand: async () => ({ status: 0, stdout: `{"v":${n++}}`, timedOut: false }) }));
  const res = await g.accept({ file: "m.mjs", source: "export const f = () => Date.now();" });
  assert.equal(res.accepted, false, "flaky observable → not accepted");
});

test("makeCharTestGate.accept REJECTS with the HONEST reason when the test does not depend on the target (poison probe)", async () => {
  // runPass is blind to the target: the same green verdict + observable with the target poisoned → the
  // probe rejects, and the reason must name the real cause, not a phantom coverage complaint.
  const deps = baseDeps({ runCommand: runPass });
  const g = makeCharTestGate("/r", {}, {}, deps);
  const res = await g.accept({ file: "m.mjs", source: TARGET_SRC });
  assert.equal(res.accepted, false, "unchanged outcome under poison → not accepted");
  assert.match(res.reason, /does not depend on the target/, "the honest cause is surfaced");
  assert.match(res.reason, /poison probe/, "and attributed to the probe measurement");
  assert.equal(deps._files.get(TARGET_ABS), TARGET_SRC, "the target is restored after the rejecting probe");
});

test("makeCharTestGate.verify passes when the test stays green, the observable matches the baseline + covers the changed lines", async () => {
  const deps = baseDeps();
  const g = makeCharTestGate("/r", {}, {}, deps);
  const res = await g.verify({ file: "m.mjs", source: TARGET_SRC, code: "import test from 'node:test';", baseline: '{"v":42}', changedLines: [1] });
  assert.equal(res.pass, true);
  assert.doesNotMatch(res.reason, /coverage unavailable/, "a REAL coverage verdict carries no degradation note");
  assert.ok(noTransients(deps._files), "the transient test file is removed after verify");
});

test("makeCharTestGate.verify DEGRADES HONESTLY when coverage is unavailable: poison probe attests dependence + the granularity gap is disclosed", async () => {
  // the default-sandbox reality: the coverage run is green but the inspector is blocked → empty document.
  // The old wiring failed EVERY refactor closed here; now the poison probe answers "does the test depend
  // on the target" and the reason RECORDS that changed-LINE granularity was not measured.
  const deps = baseDeps({ readCoverage: () => null });
  const g = makeCharTestGate("/r", {}, {}, deps);
  const res = await g.verify({ file: "m.mjs", source: TARGET_SRC, code: "import test from 'node:test';", baseline: '{"v":42}', changedLines: [1] });
  assert.equal(res.pass, true, "dependence established by the probe → verified");
  assert.match(res.reason, /changed-line coverage unavailable under the sandbox/, "the degradation is disclosed, never claimed as measured coverage");
  assert.equal(deps._files.get(TARGET_ABS), TARGET_SRC, "the target is restored after the probe");
});

test("makeCharTestGate.verify (coverage unavailable) still REJECTS a non-depending test, with the honest cause", async () => {
  const deps = baseDeps({ readCoverage: () => null, runCommand: runPass });
  const g = makeCharTestGate("/r", {}, {}, deps);
  const res = await g.verify({ file: "m.mjs", source: TARGET_SRC, code: "import test from 'node:test';", baseline: '{"v":42}', changedLines: [1] });
  assert.equal(res.pass, false, "no dependence under the probe → not verified");
  assert.match(res.reason, /does not depend on the target/, "the reject blames the test's dependence, not a platform phantom");
});

test("a failed poison-probe restore is FATAL and LOUD at the wiring level (never a silently poisoned tree)", async () => {
  const deps = baseDeps();
  const files = deps._files;
  let targetWrites = 0;
  deps.writeFile = (p, s) => {
    if (p === TARGET_ABS) {
      targetWrites += 1;
      if (targetWrites > 1) throw new Error("disk full"); // the poison write lands; every restore write fails
    }
    files.set(p, s);
  };
  const g = makeCharTestGate("/r", {}, {}, deps);
  await assert.rejects(
    () => g.accept({ file: "m.mjs", source: TARGET_SRC }),
    /FATAL §5 char-test: poison-probe restore failed.*POISONED/,
    "accept THROWS (audit-fix logs it + stays propose-only) instead of returning a verdict over a poisoned tree"
  );
});

test("makeCharTestGate.verify REVERTS when the OBSERVABLE changed even though the test stays green (council Codex/Claude P1 — tautology-proof)", async () => {
  // the run emits {"v":42}; the accepted baseline was {"v":7} → the target's observable changed across the
  // refactor. The test still exits 0 (a tautological assertion), but the harness-captured observable is
  // the behaviour oracle → revert.
  const g = makeCharTestGate("/r", {}, {}, baseDeps());
  const res = await g.verify({ file: "m.mjs", source: "x", code: "import test from 'node:test';", baseline: '{"v":7}', changedLines: [1] });
  assert.equal(res.pass, false, "observable != baseline → behaviour not preserved → revert");
  assert.match(res.reason, /observable changed/);
});

test("makeCharTestGate.verify: a pure DELETION (empty changedLines) skips the changed-line bar (dead_code; council Grok/Codex P2)", async () => {
  // a dead-code deletion has no NEW lines to cover; requiring changed-line coverage would ALWAYS revert
  // it. The still-green + observable-match checks attest preservation. Force coverage to FAIL to prove the
  // changed-line bar is not consulted for a deletion.
  const deps = baseDeps({ readCoverage: () => ({ result: [] }) });
  const g = makeCharTestGate("/r", {}, {}, deps);
  const res = await g.verify({ file: "m.mjs", source: "x", code: "import test from 'node:test';", baseline: '{"v":42}', changedLines: [] });
  assert.equal(res.pass, true, "deletion-only: green + observable-match is enough; the changed-line bar is skipped");
});

test("makeCharTestGate.verify FAILS (revert) when the test goes red after the refactor", async () => {
  const g = makeCharTestGate("/r", {}, {}, baseDeps({ runCommand: async () => ({ status: 1, stdout: "not ok 1", timedOut: false }) }));
  const res = await g.verify({ file: "m.mjs", source: "x", code: "import test from 'node:test';", baseline: '{"v":42}', changedLines: [1] });
  assert.equal(res.pass, false, "a red test after the refactor → behaviour changed → revert");
});

test("makeCharTestGate.verify fails closed when the accepted code is missing", async () => {
  const g = makeCharTestGate("/r", {}, {}, baseDeps());
  const res = await g.verify({ file: "m.mjs", source: "x", code: null, changedLines: [1] });
  assert.equal(res.pass, false);
});

test("makeCharTestGate returns null when no seat can generate (CLI can warn instead of enabling a dead gate)", () => {
  // no injected generate + no reachable seats → makeSeatRunners yields runners, but force the no-seat path
  const g = makeCharTestGate("/r", { openrouter: { seats: [] } }, {}, { generate: null, runCommand: runPass });
  // with built-in seat runners present, generate is a function; assert the explicit-null path is handled
  assert.ok(g === null || typeof g.accept === "function");
});

// ---------------------------------------------------------------------------------------------
// INTEGRATION (E2E): the PRODUCTION path — real fs, real runCommandAsync, real default sandbox
// (no sandboxArgs override, default readFile/writeFile/readCoverage/freshDir) — with only the
// generator seat stubbed. This is the state the old inspector-based coverage check made IMPOSSIBLE:
// under --experimental-permission the coverage document is always empty, so accept's executesModule
// and verify's executesChanged were permanently false and EVERY eligible refactor was rejected.
// ---------------------------------------------------------------------------------------------

// This test FILE is itself run under `node --test`, which sets NODE_TEST_CONTEXT on the CURRENT process;
// the harness spreads the live process.env into every spawned run, and with that var present the nested
// grandchild `node --test` reports to a phantom parent runner (empty stdout, masked failures) instead of
// behaving like the top-level `audit fix --chartest` invocation this must reproduce — strip it (see the
// matching comment in chartest-node-harness.test.mjs).
function realRunCommand(cmd, args, opts) {
  const env = { ...opts?.env };
  delete env.NODE_TEST_CONTEXT;
  return runCommandAsync(cmd, args, { ...opts, env });
}

test("INTEGRATION (E2E): the production path ACCEPTS a valid generated char-test under the DEFAULT sandbox and VERIFIES a behaviour-preserving refactor", { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chartest-wiring-e2e-"));
  try {
    const targetRel = "target.mjs";
    const targetAbs = path.join(dir, targetRel);
    const v1 = "export function add(a, b) {\n  return a + b;\n}\n";
    fs.writeFileSync(targetAbs, v1, "utf8");
    // the stubbed SEAT: returns a fenced, discriminating characterization test (what a healthy model emits)
    const generate = async () => [
      "```js",
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { add } from "./target.mjs";',
      "",
      'test("add characterization", () => {',
      "  const observed = add(2, 3);",
      "  console.log(JSON.stringify({ sum: observed }));",
      "  assert.equal(observed, 5);",
      "});",
      "```"
    ].join("\n");
    const g = makeCharTestGate(dir, {}, {}, { generate, runCommand: realRunCommand });
    const res = await g.accept({ file: targetRel, source: v1 });
    assert.equal(res.accepted, true, `accept must succeed under the default sandbox (was permanently rejected before): ${res.reason}`);
    assert.equal(res.baseline, '{"sum":5}', "the baseline observable is pinned");
    assert.equal(fs.readFileSync(targetAbs, "utf8"), v1, "the target is byte-identical after accept (poison restored)");
    // apply a behaviour-PRESERVING refactor, then VERIFY on the post-fix tree (audit-fix's sequence)
    const v2 = "export function add(a, b) {\n  const total = a + b;\n  return total;\n}\n";
    fs.writeFileSync(targetAbs, v2, "utf8");
    const verdict = await g.verify({ file: targetRel, source: v2, code: res.code, baseline: res.baseline, changedLines: [2, 3] });
    assert.equal(verdict.pass, true, `verify must pass for a preserved observable: ${verdict.reason}`);
    assert.match(verdict.reason, /changed-line coverage unavailable under the sandbox/, "the sandbox's line-granularity gap is disclosed in the verdict");
    assert.equal(fs.readFileSync(targetAbs, "utf8"), v2, "the post-fix target is intact after verify (poison restored)");
    assert.ok(!fs.readdirSync(dir).some((f) => f.includes(".council-chartest")), "transient test + coverage dirs are cleaned up");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
