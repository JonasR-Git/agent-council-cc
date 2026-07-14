import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildExportPoisonedSource, buildPoisonedSource, captureObservable, changedExportsFor, changedLinesCovered, makeNodeCharHarness, POISON_SENTINEL } from "../plugins/council/scripts/lib/chartest-node-harness.mjs";
import { exportSnapshot } from "../plugins/council/scripts/lib/audit-snapshot.mjs";
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

test("makeNodeCharHarness.executesTarget fails closed without a coverage reader OR probe fs, passes when changed lines covered", async () => {
  const source = "a\nb\nc\n";
  const abs = path.resolve("/r/m.mjs");
  const doc = { result: [{ url: fileUrl(abs), functions: [{ ranges: [{ startOffset: 0, endOffset: 5, count: 1 }] }] }] };
  // no readCoverage/coverageDir AND no readFile/writeFile → neither mechanism can run → fail closed
  const noReader = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", changedLines: [1], source, runCommand: okRun("ok 1") });
  assert.equal(await noReader.executesTarget(), false, "no coverage reader and no probe fs → can't verify → false");
  const withCov = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", changedLines: [1, 2], source, coverageDir: "/cov", readCoverage: () => doc, runCommand: okRun("ok 1") });
  assert.equal(await withCov.executesTarget(), true, "changed lines 1-2 covered (the PREFERRED coverage path still works)");
  assert.equal(withCov.notes.length, 0, "a real coverage verdict records no degradation note");
});

// -------------------------------- POISON PROBE (the §5 unblocker) ---------------------------------
// NODE_V8_COVERAGE is inspector-based and the permission sandbox blocks the inspector UNCONDITIONALLY,
// so the old coverage-only executesModule was permanently false → EVERY eligible refactor was rejected.
// The probe needs no inspector: the harness (trusted, unsandboxed parent) swaps the target for a
// poisoned twin and requires the test's outcome to DIFFER — a strictly stronger dependence signal.

const TARGET_ABS = path.join("/r", "m.mjs"); // = the harness's absTarget for cwd "/r" + targetFile "m.mjs"
const ORIGINAL_SRC = "export const f = () => 7;\n";

function memFs(initial) {
  const files = new Map(Object.entries(initial ?? {}));
  return {
    files,
    readFile: (p) => { if (!files.has(p)) throw new Error(`ENOENT: ${p}`); return files.get(p); },
    writeFile: (p, s) => { files.set(p, s); }
  };
}

// A run that DEPENDS on the target: green against the real source, red once the harness poisoned it.
const poisonAwareRun = (files) => async () => (String(files.get(TARGET_ABS) ?? "").includes(POISON_SENTINEL)
  ? { status: 1, stdout: `not ok 1 - ${POISON_SENTINEL}`, timedOut: false }
  : { status: 0, stdout: 'TAP version 13\n{"v":7}\nok 1', timedOut: false });

test("buildPoisonedSource fakes the SAME export surface with a throwing sentinel; un-fakeable surfaces yield null", () => {
  const src = "export function add(a, b) { return a + b; }\nexport const K = 7;\nexport default add;\n";
  const poisoned = buildPoisonedSource(src);
  assert.ok(poisoned.includes(POISON_SENTINEL), "every export throws the poison sentinel");
  // the poisoned twin exposes the identical surface, so the test's imports still resolve (no load-time
  // explosion — that would make even an import-unused test fail and be falsely accepted)
  assert.deepEqual(exportSnapshot(poisoned).names, exportSnapshot(src).names, "same exported names");
  assert.equal(exportSnapshot(poisoned).hasDefault, true, "default export preserved");
  assert.equal(buildPoisonedSource('export * from "./x.mjs";\n'), null, "opaque (star re-export) surface → null → probe fails closed");
});

test("POISON PROBE rejects a test that does NOT depend on the target (identical pass with the target poisoned)", async () => {
  const { files, readFile, writeFile } = memFs({ [TARGET_ABS]: ORIGINAL_SRC });
  // this run is BLIND to the target — same green verdict + observable, poisoned or not (the "imports the
  // target unused + asserts 1===1" shape the old coverage check was meant to catch)
  const h = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", runCommand: okRun('TAP version 13\n{"v":1}\nok 1'), readFile, writeFile });
  assert.equal(await h.executesModule(), false, "unchanged outcome under poison → no dependence → reject");
  assert.equal(files.get(TARGET_ABS), ORIGINAL_SRC, "the target is restored byte-for-byte");
  assert.ok(h.notes.some((n) => /does not depend on the target/.test(n) && /poison probe/.test(n)), "the HONEST cause is recorded for the reject reason");
});

test("POISON PROBE accepts a test that genuinely exercises the target (fails or differs when poisoned)", async () => {
  // outcome DIFFERS by exit status
  const a = memFs({ [TARGET_ABS]: ORIGINAL_SRC });
  const hFail = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", runCommand: poisonAwareRun(a.files), readFile: a.readFile, writeFile: a.writeFile });
  assert.equal(await hFail.executesModule(), true, "the test FAILS with the target poisoned → it depends on it");
  assert.equal(a.files.get(TARGET_ABS), ORIGINAL_SRC, "restored byte-for-byte after an accepting probe too");
  // outcome differs only by OBSERVABLE (a tautological assertion stays green, but the printed value moves)
  const b = memFs({ [TARGET_ABS]: ORIGINAL_SRC });
  const obsRun = async () => (String(b.files.get(TARGET_ABS) ?? "").includes(POISON_SENTINEL)
    ? { status: 0, stdout: '{"v":"poisoned"}', timedOut: false }
    : { status: 0, stdout: '{"v":7}', timedOut: false });
  const hObs = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", runCommand: obsRun, readFile: b.readFile, writeFile: b.writeFile });
  assert.equal(await hObs.executesModule(), true, "a different observable under poison also proves dependence");
  assert.equal(b.files.get(TARGET_ABS), ORIGINAL_SRC, "restored");
});

test("POISON PROBE restores the target even when the poisoned run THROWS, and fails closed without probe fs", async () => {
  const { files, readFile, writeFile } = memFs({ [TARGET_ABS]: ORIGINAL_SRC });
  let call = 0;
  const throwing = async () => {
    call += 1;
    if (call === 1) return { status: 0, stdout: '{"v":7}', timedOut: false }; // the real baseline run
    throw new Error("spawn exploded mid-probe");
  };
  const h = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", runCommand: throwing, readFile, writeFile });
  await assert.rejects(() => h.executesModule(), /spawn exploded/, "the fault propagates (acceptCharTest fails it closed)");
  assert.equal(files.get(TARGET_ABS), ORIGINAL_SRC, "the finally-restore ran: no poisoned tree even on a thrown run");
  // and with NO injected fs the probe cannot run at all → fail closed, honest note
  const noFs = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", runCommand: okRun("ok 1") });
  assert.equal(await noFs.executesModule(), false, "no readFile/writeFile → probe unavailable → reject");
  assert.ok(noFs.notes.some((n) => /probe unavailable/.test(n)));
});

test("POISON PROBE: a failed restore is FATAL and LOUD — never a silently poisoned tree", async () => {
  const files = new Map([[TARGET_ABS, ORIGINAL_SRC]]);
  let targetWrites = 0;
  const readFile = (p) => files.get(p);
  const writeFile = (p, s) => {
    if (p === TARGET_ABS) {
      targetWrites += 1;
      if (targetWrites > 1) throw new Error("disk full"); // the poison write lands; every restore write fails
    }
    files.set(p, s);
  };
  const h = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", runCommand: poisonAwareRun(files), readFile, writeFile });
  await assert.rejects(() => h.executesModule(), /FATAL\(chartest-poison-restore\).*POISONED/, "the restore failure throws with an unmistakable marker");
  assert.ok(h.restoreFailure, "restoreFailure is exposed so the wiring can escalate (last-ditch rewrite + rethrow)");
});

test("executesTarget DEGRADES HONESTLY when the coverage document is empty: poison probe + a granularity note", async () => {
  const { files, readFile, writeFile } = memFs({ [TARGET_ABS]: ORIGINAL_SRC });
  // readCoverage yields nothing (the default-sandbox reality: the run is green but the inspector was
  // blocked, so the coverage dir stays empty) → fall back to the probe instead of rejecting forever
  const h = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", changedLines: [1], source: ORIGINAL_SRC, coverageDir: "/cov", readCoverage: () => null, runCommand: poisonAwareRun(files), readFile, writeFile });
  assert.equal(await h.executesTarget(), true, "dependence established by the probe when coverage is unavailable");
  assert.ok(h.notes.some((n) => /changed-line coverage unavailable/.test(n)), "the degradation is DISCLOSED — never claimed as measured line coverage");
  assert.ok(h.notes.some((n) => /PER-EXPORT/.test(n) && /'f'/.test(n)), "the changed line was attributed to export 'f' and measured at EXPORT granularity");
  assert.equal(files.get(TARGET_ABS), ORIGINAL_SRC, "restored");
});

// ---------------------------- PER-EXPORT POISON PROBE (the granularity fix) ----------------------------
// The whole-module probe proves the test depends on the MODULE — but a test that exercises export A used
// to false-green a change in export B. The per-export probe attributes the CHANGED lines to the export
// region they fall inside, poisons ONLY that export (every other export keeps its real implementation),
// and requires the same hashed test's outcome to differ. Un-attributable changes degrade to the
// whole-module probe WITH a disclosure note — coarser granularity is said, never silently claimed finer.

const AB_SRC = [
  "export function a() {", // 1
  "  return 1;", //           2
  "}", //                     3
  "export function b() {", // 4
  "  return 2;", //           5
  "}", //                     6
  ""
].join("\n");

const MULTI_SRC = [
  'import path from "node:path";', //   1 — module-level code BEFORE the first export (unattributable)
  "", //                                2
  "export function a() {", //           3
  "  return 1;", //                     4
  "}", //                               5
  "export const K = 7;", //             6
  "export default function main() {", //7
  "  return a() + K;", //               8
  "}", //                               9
  ""
].join("\n");

test("changedExportsFor attributes changed lines to the export region they fall inside (region = decl → next export/EOF)", () => {
  assert.deepEqual(changedExportsFor(MULTI_SRC, [4]).exports, ["a"], "a body line belongs to its export");
  assert.deepEqual(changedExportsFor(MULTI_SRC, [6]).exports, ["K"], "a one-line const export is its own region");
  assert.deepEqual(changedExportsFor(MULTI_SRC, [4, 8]).exports, ["a", "default"], "lines across two exports name both (default included)");
  assert.equal(changedExportsFor(MULTI_SRC, []).exports, null, "no changed lines → nothing to attribute → fail closed");
  const before = changedExportsFor(MULTI_SRC, [1]);
  assert.equal(before.exports, null, "a line before the first export cannot be attributed");
  assert.match(before.reason, /outside every export region/, "with the honest cause");
  assert.equal(changedExportsFor(MULTI_SRC, [999]).exports, null, "a line past EOF cannot be attributed → fail closed");
  const opaque = changedExportsFor('export * from "./x.mjs";\n', [1]);
  assert.equal(opaque.exports, null, "a star re-export surface is un-enumerable");
  assert.match(opaque.reason, /un-enumerable/);
  const listForm = changedExportsFor("function a() {\n  return 1;\n}\nexport { a };\n", [4]);
  assert.equal(listForm.exports, null, "a list-export region cannot be singly poisoned");
  assert.match(listForm.reason, /cannot be singly poisoned/);
});

test("buildExportPoisonedSource poisons ONLY the named export — every other export keeps its REAL implementation", () => {
  const v = buildExportPoisonedSource(AB_SRC, "b");
  assert.ok(v.includes(POISON_SENTINEL), "the poisoned export throws the sentinel");
  assert.match(v, /export \{ __councilPoison__ as b \};/, "b's binding is the poison");
  assert.ok(v.includes("export function a() {"), "a stays REALLY exported and implemented");
  assert.ok(v.includes("  return 2;"), "b's real body stays defined (internally callable — no load-time explosion)");
  assert.ok(!/as a \}/.test(v), "a's binding is NOT poisoned");
  assert.deepEqual(exportSnapshot(v).names, exportSnapshot(AB_SRC).names, "the enumerable surface is IDENTICAL");
  // the default export: a NAMED default declaration keeps its module-scope binding (internal refs stay real)
  const d = buildExportPoisonedSource(MULTI_SRC, "default");
  assert.ok(d.includes("export default __councilPoison__;"), "the default binding is the poison");
  assert.match(d, /\nfunction main\(\) \{/, "the real declaration survives un-exported, name intact");
  assert.equal(exportSnapshot(d).hasDefault, true, "default preserved on the surface");
  assert.deepEqual(exportSnapshot(d).names, exportSnapshot(MULTI_SRC).names, "named surface unchanged");
  // an ANONYMOUS default (expression form) has no module-scope binding to preserve → a plain const keeps
  // the expression (and any side effects) evaluated while the default binding becomes the poison
  const anon = buildExportPoisonedSource("export default { v: 1 };\nexport const K = 2;\n", "default");
  assert.ok(anon.includes("const __councilRealDefault__ = { v: 1 };"), "the expression stays evaluated, un-exported");
  assert.ok(anon.includes("export default __councilPoison__;"), "and the default binding is the poison");
  assert.deepEqual(exportSnapshot(anon).names, ["K"], "the sibling named export is untouched");
  // an ANONYMOUS default CLASS (`class extends Base` / `class implements Foo`) has no name after `class`,
  // so it MUST take the const-expression branch — the named-declaration branch would emit `class extends
  // Base {…}`, an unnamed class DECLARATION which is a hard SyntaxError, and a twin that fails to LOAD is
  // read by the poison probe as a spurious outcome difference (false-positive dependence).
  const anonClass = buildExportPoisonedSource("export default class extends Base { greet() { return 1; } }\nexport const K = 2;\n", "default");
  assert.ok(anonClass, "an anonymous default class still produces a twin (not null)");
  assert.ok(anonClass.includes("const __councilRealDefault__ = class extends Base {"), "kept as a VALID class EXPRESSION, not an unnamed declaration");
  assert.ok(!/\bexport\s+default\s+class\s+extends\b/.test(anonClass) && !/^\s*class\s+extends\b/m.test(anonClass), "no invalid unnamed `class extends` declaration is emitted");
  assert.ok(anonClass.includes("export default __councilPoison__;"), "the default binding is the poison");
});

test("buildExportPoisonedSource fails CLOSED (null) on unknown names, opaque surfaces and surface-drifting transforms", () => {
  assert.equal(buildExportPoisonedSource(AB_SRC, "nope"), null, "an unknown export cannot be poisoned");
  assert.equal(buildExportPoisonedSource(AB_SRC, "b; import x"), null, "a non-identifier name is rejected (no twin injection)");
  assert.equal(buildExportPoisonedSource('export * from "./x.mjs";\n', "a"), null, "opaque surface → no twin");
  // un-exporting `export const a = 1, b = 2` would silently DROP b from the twin (whose import then fails
  // at LINK time → a spurious outcome difference → false accept). exportSnapshot is single-name-blind for
  // multi-declarators, so the snapshot compare CANNOT see it — the declarator scan must reject instead.
  assert.equal(buildExportPoisonedSource("export const a = 1, b = 2;\n", "a"), null, "multi-declarator → surface drift → null");
  // and the scan is bracket-depth aware: commas INSIDE the single initializer do not reject
  assert.ok(buildExportPoisonedSource("export const cfg = { x: 1, y: [1, 2] };\nexport const other = 3;\n", "cfg"), "inner commas are not declarators");
});

// A run simulating a test that exercises ONLY export `a`: it fails exactly when the CURRENT on-disk
// target poisons a's binding (the per-export twin for `a`, or the whole-module twin, which poisons all).
const exercisesOnlyA = (files) => async () => (String(files.get(TARGET_ABS) ?? "").includes("as a };")
  ? { status: 1, stdout: `not ok 1 - ${POISON_SENTINEL}`, timedOut: false }
  : { status: 0, stdout: 'TAP version 13\n{"v":1}\nok 1', timedOut: false });

test("PER-EXPORT PROBE rejects a test that exercises export A when the change is in export B (the gap this closes)", async () => {
  const { files, readFile, writeFile } = memFs({ [TARGET_ABS]: AB_SRC });
  // sanity: the WHOLE-MODULE probe accepts this test (it does depend on the module via `a`) — which is
  // exactly why module granularity could not attest the changed REGION and this bar had to exist
  const hModule = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", runCommand: exercisesOnlyA(files), readFile, writeFile });
  assert.equal(await hModule.executesModule(), true, "module-level dependence holds (the old, too-coarse signal)");
  // the changed line (5) is inside export b — poisoning ONLY b leaves the a-exercising test green → reject
  const h = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", changedLines: [5], source: AB_SRC, runCommand: exercisesOnlyA(files), readFile, writeFile });
  assert.equal(await h.executesTarget(), false, "unchanged outcome with only 'b' poisoned → the changed region is NOT exercised");
  assert.ok(h.notes.some((n) => /does not exercise the changed export 'b'/.test(n)), "the HONEST cause names the un-exercised export");
  assert.equal(files.get(TARGET_ABS), AB_SRC, "the target is restored byte-for-byte");
});

test("PER-EXPORT PROBE accepts a test that exercises the changed export, and requires EVERY changed export to be exercised", async () => {
  const { files, readFile, writeFile } = memFs({ [TARGET_ABS]: AB_SRC });
  const h = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", changedLines: [2], source: AB_SRC, runCommand: exercisesOnlyA(files), readFile, writeFile });
  assert.equal(await h.executesTarget(), true, "poisoning the changed export 'a' flips the outcome → the region is exercised");
  assert.ok(h.notes.some((n) => /PER-EXPORT/.test(n) && /'a'/.test(n) && /line granularity not established/.test(n)), "export granularity is claimed, line granularity honestly NOT");
  assert.equal(files.get(TARGET_ABS), AB_SRC, "restored");
  // a change spanning BOTH exports: 'a' is exercised but 'b' is not → the whole check rejects
  const both = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", changedLines: [2, 5], source: AB_SRC, runCommand: exercisesOnlyA(files), readFile, writeFile });
  assert.equal(await both.executesTarget(), false, "one un-exercised changed export fails the whole check");
  assert.ok(both.notes.some((n) => /does not exercise the changed export 'b'/.test(n)));
  assert.equal(files.get(TARGET_ABS), AB_SRC, "restored after the multi-export probe too");
});

test("PER-EXPORT PROBE degrades to the WHOLE-MODULE probe — and SAYS SO — when the changed lines cannot be attributed", async () => {
  // the changed line sits in a module-level helper ABOVE the first export: no export region contains it
  const HELPER_SRC = [
    "function helper() {", // 1
    "  return 5;", //          2  ← the changed line
    "}", //                    3
    "export function a() {", //4
    "  return helper();", //   5
    "}", //                    6
    ""
  ].join("\n");
  const { files, readFile, writeFile } = memFs({ [TARGET_ABS]: HELPER_SRC });
  const h = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", changedLines: [2], source: HELPER_SRC, runCommand: poisonAwareRun(files), readFile, writeFile });
  assert.equal(await h.executesTarget(), true, "module dependence still attested by the whole-module probe");
  assert.ok(h.notes.some((n) => /per-export granularity NOT established/.test(n)), "the degradation is DISCLOSED — never a silent finer claim");
  assert.ok(h.notes.some((n) => /outside every export region/.test(n)), "with the attribution cause");
  assert.equal(files.get(TARGET_ABS), HELPER_SRC, "restored");
});

test("PER-EXPORT PROBE on an un-enumerable surface degrades AND the whole-module probe still fails closed", async () => {
  const STAR_SRC = 'export * from "./x.mjs";\n';
  const { files, readFile, writeFile } = memFs({ [TARGET_ABS]: STAR_SRC });
  const h = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", changedLines: [1], source: STAR_SRC, runCommand: okRun("ok 1"), readFile, writeFile });
  assert.equal(await h.executesTarget(), false, "opaque surface → neither probe can attest → fail closed");
  assert.ok(h.notes.some((n) => /per-export granularity NOT established/.test(n)), "the degrade is recorded");
  assert.ok(h.notes.some((n) => /cannot fake the target's export surface/.test(n)), "and the whole-module probe's own honest cause too");
  assert.equal(files.get(TARGET_ABS), STAR_SRC, "the target is untouched");
});

test("PER-EXPORT PROBE restores the target byte-for-byte even when the poisoned run THROWS, and fails closed on a timeout", async () => {
  const { files, readFile, writeFile } = memFs({ [TARGET_ABS]: AB_SRC });
  let call = 0;
  const throwing = async () => {
    call += 1;
    if (call === 1) return { status: 0, stdout: '{"v":1}', timedOut: false }; // the real baseline run
    throw new Error("spawn exploded mid-probe");
  };
  const h = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", changedLines: [2], source: AB_SRC, runCommand: throwing, readFile, writeFile });
  await assert.rejects(() => h.executesTarget(), /spawn exploded/, "the fault propagates (the gate fails it closed)");
  assert.equal(files.get(TARGET_ABS), AB_SRC, "the finally-restore ran: no poisoned tree even on a thrown per-export run");
  // an incomplete (timed-out) per-export run is never an approval
  const b = memFs({ [TARGET_ABS]: AB_SRC });
  let n = 0;
  const timingOut = async () => (n++ === 0 ? { status: 0, stdout: '{"v":1}', timedOut: false } : { status: 0, stdout: "", timedOut: true });
  const ht = makeNodeCharHarness({ cwd: "/r", testFile: "t.mjs", targetFile: "m.mjs", changedLines: [2], source: AB_SRC, runCommand: timingOut, readFile: b.readFile, writeFile: b.writeFile });
  assert.equal(await ht.executesTarget(), false, "a timed-out per-export run → fail closed");
  assert.ok(ht.notes.some((nn) => /did not complete/.test(nn)));
  assert.equal(b.files.get(TARGET_ABS), AB_SRC, "restored after the timed-out run");
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
// the actual `fix --chartest` CLI — never has this var set, so stripping it here is what makes the
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

test("INTEGRATION: the POISON PROBE accepts a genuine char-test and rejects an import-unused tautology under the REAL default sandbox (the §5 unblocker)", { timeout: 60_000 }, async () => {
  // NODE_V8_COVERAGE is collected via V8's inspector; Node's permission model unconditionally restricts
  // opening the inspector with no CLI flag to re-grant it (confirmed on v22.13.1: the coverage directory
  // stays empty regardless of --allow-fs-write/--allow-worker/--allow-addons/--allow-child-process), so a
  // coverage-based check could NEVER accept under the sandbox — the §5 gate rejected every eligible
  // refactor. This test used to PIN that fail-closed dead end; it now proves the poison probe unblocks it:
  // executesModule/executesTarget accept a genuinely-depending test with NO inspector, under the FULL
  // default sandbox, while the import-unused tautology the coverage check was meant to catch stays rejected.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chartest-harness-it-poison-"));
  try {
    const targetFile = path.join(dir, "target.mjs");
    const targetSource = "export function add(a, b) {\n  return a + b;\n}\n";
    fs.writeFileSync(targetFile, targetSource, "utf8");
    const realFs = { readFile: (p) => fs.readFileSync(p, "utf8"), writeFile: (p, s) => fs.writeFileSync(p, s, "utf8") };
    const genuine = path.join(dir, "target.chartest.mjs");
    fs.writeFileSync(
      genuine,
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
    const h = makeNodeCharHarness({ cwd: dir, testFile: genuine, targetFile, changedLines: [2], source: targetSource, runCommand: realRunCommand, readCoverage: readCoverageDir, coverageDir, timeoutMs: 20_000, ...realFs });
    assert.equal(await h.executesModule(), true, "the genuine test FAILS with the target poisoned → dependence proven WITHOUT the inspector (was permanently false before)");
    assert.equal(fs.readFileSync(targetFile, "utf8"), targetSource, "the target is byte-identical after the probe");
    assert.equal(await h.executesTarget(), true, "coverage stays empty under the sandbox → honest poison-probe fallback accepts");
    assert.ok(h.notes.some((n) => /changed-line coverage unavailable/.test(n)), "the line-granularity gap is disclosed, not papered over");
    assert.equal(fs.readFileSync(targetFile, "utf8"), targetSource, "still byte-identical after the fallback probe");
    // the strictly-stronger property: a test that IMPORTS the target but never uses it passes unchanged
    // against the poisoned twin → rejected (coverage would also have caught this; the probe must too)
    const tautology = path.join(dir, "target.tautology.mjs");
    fs.writeFileSync(
      tautology,
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { add } from "./target.mjs";', // imported, never called
        "",
        'test("tautology", () => {',
        "  console.log(JSON.stringify({ ok: 1 }));",
        "  assert.equal(1, 1);",
        "});"
      ].join("\n"),
      "utf8"
    );
    const hTaut = makeNodeCharHarness({ cwd: dir, testFile: tautology, targetFile, source: targetSource, runCommand: realRunCommand, timeoutMs: 20_000, ...realFs });
    assert.equal(await hTaut.executesModule(), false, "import-unused + assert 1===1 → identical pass under poison → rejected");
    assert.ok(hTaut.notes.some((n) => /does not depend on the target/.test(n)), "and the reject cause is the honest one");
    assert.equal(fs.readFileSync(targetFile, "utf8"), targetSource, "target intact after the rejecting probe too");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("INTEGRATION: the PER-EXPORT probe rejects a real test that exercises export A when the change is in export B, under the REAL default sandbox", { timeout: 120_000 }, async () => {
  // The whole-module probe was blind to WHERE inside the module the change landed: a test exercising
  // `add` attested a change inside `mul`. Per-export poisoning closes that — with the SAME test, the SAME
  // full sandbox, and no inspector.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chartest-harness-it-perexport-"));
  try {
    const targetFile = path.join(dir, "target.mjs");
    const targetSource = [
      "export function add(a, b) {", // 1
      "  return a + b;", //             2
      "}", //                           3
      "export function mul(a, b) {", // 4
      "  return a * b;", //             5
      "}", //                           6
      ""
    ].join("\n");
    fs.writeFileSync(targetFile, targetSource, "utf8");
    const realFs = { readFile: (p) => fs.readFileSync(p, "utf8"), writeFile: (p, s) => fs.writeFileSync(p, s, "utf8") };
    const testFile = path.join(dir, "target.chartest.mjs");
    fs.writeFileSync(
      testFile,
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { add } from "./target.mjs";', // mul is never touched
        "",
        'test("add characterization", () => {',
        "  const observed = add(2, 3);",
        "  console.log(JSON.stringify({ sum: observed }));",
        "  assert.equal(observed, 5);",
        "});"
      ].join("\n"),
      "utf8"
    );
    // the change is in mul (line 5) but the test only exercises add → REJECT (this used to pass)
    const hWrong = makeNodeCharHarness({ cwd: dir, testFile, targetFile, changedLines: [5], source: targetSource, runCommand: realRunCommand, timeoutMs: 20_000, ...realFs });
    assert.equal(await hWrong.executesTarget(), false, "a change in 'mul' is NOT attested by an add-only test");
    assert.ok(hWrong.notes.some((n) => /does not exercise the changed export 'mul'/.test(n)), "the honest cause names the un-exercised export");
    assert.equal(fs.readFileSync(targetFile, "utf8"), targetSource, "the target is byte-identical after the rejecting probe");
    // the change is in add (line 2) and the test exercises add → ACCEPT, at disclosed export granularity
    const hRight = makeNodeCharHarness({ cwd: dir, testFile, targetFile, changedLines: [2], source: targetSource, runCommand: realRunCommand, timeoutMs: 20_000, ...realFs });
    assert.equal(await hRight.executesTarget(), true, "poisoning only 'add' fails the test → the changed region IS exercised");
    assert.ok(hRight.notes.some((n) => /PER-EXPORT/.test(n) && /'add'/.test(n)), "the granularity note names the attributed export");
    assert.equal(fs.readFileSync(targetFile, "utf8"), targetSource, "byte-identical after the accepting probe too");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
