import assert from "node:assert/strict";
import test from "node:test";

import {
  CHARTEST_LENSES,
  acceptCharTestForTarget,
  buildCharTestPrompt,
  isRefactorClass,
  parseCharTest,
  verifyCharTestAfterFix
} from "../plugins/council/scripts/lib/chartest-gate.mjs";

test("isRefactorClass is true only for behaviour-preserving lenses (not correctness/security fixes)", () => {
  assert.equal(isRefactorClass({ lens: "architecture_ssot" }), true);
  assert.equal(isRefactorClass({ lens: "dead_code" }), true);
  assert.equal(isRefactorClass({ lens: "  Logical_Sense " }), true, "trimmed + case-folded");
  assert.equal(isRefactorClass({ lens: "correctness" }), false, "a correctness FIX changes behaviour → not char-test-gated");
  assert.equal(isRefactorClass({ lens: "security_secrets" }), false);
  assert.equal(isRefactorClass({}), false);
  for (const l of CHARTEST_LENSES) assert.equal(isRefactorClass({ lens: l }), true);
});

test("buildCharTestPrompt is FIREWALLED: it contains the source but never the finding/fix, and nonce-fences the source", () => {
  const p = buildCharTestPrompt("lib/math.mjs", "export const add = (a,b) => a+b; // SENTINEL_SRC", {});
  assert.match(p, /CHARACTERIZATION TEST/);
  assert.match(p, /BEGIN SOURCE [0-9A-F]{6,}/);
  assert.ok(p.includes("SENTINEL_SRC"), "the target source is included");
  assert.match(p, /node:test/, "asks for a node:test file");
  assert.match(p, /PRINT the observed value/i, "asks for a capturable observable (anti-vacuity)");
});

test("buildCharTestPrompt discloses truncation of an oversized source instead of silently cutting", () => {
  const big = "x".repeat(45000);
  const p = buildCharTestPrompt("big.mjs", big, {});
  assert.match(p, /truncated \d+ chars/);
});

test("parseCharTest extracts a fenced node:test body; fails closed on empty / non-test / no-assert", () => {
  const ok = parseCharTest('```js\nimport test from "node:test";\nimport assert from "node:assert";\ntest("x", () => { console.log("1"); assert.equal(1,1); });\n```');
  assert.ok(ok && /node:test/.test(ok.code));
  assert.equal(parseCharTest(""), null, "empty → null");
  assert.equal(parseCharTest("```js\nconst x = 1;\n```"), null, "no test/assert → null (not a char-test)");
  assert.equal(parseCharTest("just prose, no code"), null);
  // a bare (unfenced) but valid-looking body is still accepted
  assert.ok(parseCharTest('import test from "node:test"; import assert from "node:assert"; test("t",()=>assert.ok(true));'));
});

const goodHarness = () => ({
  passesOnUnmodified: async () => true,
  runs: async (n) => Array.from({ length: n }, () => '{"observed":42}'),
  executesTarget: async () => true,
  perturbedRun: async () => '{"observed":42}'
});

test("acceptCharTestForTarget: generate → parse → write → acceptCharTest, returns accepted+testPath", async () => {
  let wrote = null;
  const r = await acceptCharTestForTarget("lib/m.mjs", "export const f = () => 42;", {
    generate: async () => '```js\nimport test from "node:test";\nimport assert from "node:assert";\ntest("f", () => { console.log(JSON.stringify(42)); assert.equal(42,42); });\n```',
    writeTest: async (code) => { wrote = code; return "/tmp/char.test.mjs"; },
    harness: goodHarness()
  });
  assert.equal(r.accepted, true);
  assert.equal(r.testPath, "/tmp/char.test.mjs");
  assert.ok(wrote && /node:test/.test(wrote), "the generated test was written");
});

test("acceptCharTestForTarget fails CLOSED at every step (no test, unparseable, write/gen fault, oversize)", async () => {
  const base = { writeTest: async () => "/t", harness: goodHarness() };
  assert.equal((await acceptCharTestForTarget("m", "s", {})).accepted, false, "no deps → not accepted");
  assert.equal((await acceptCharTestForTarget("m", "s", { ...base, generate: async () => "no code here" })).accepted, false, "unparseable reply");
  assert.equal((await acceptCharTestForTarget("m", "s", { ...base, generate: async () => { throw new Error("rate limit"); } })).accepted, false, "generator throw");
  assert.equal((await acceptCharTestForTarget("m", "x".repeat(41000), { ...base, generate: async () => "```js\nnode:test assert\n```" })).accepted, false, "oversize target");
  const writeFault = await acceptCharTestForTarget("m", "s", {
    generate: async () => '```js\nimport test from "node:test"; import assert from "node:assert"; test("t",()=>assert.ok(1));\n```',
    writeTest: async () => { throw new Error("EACCES"); },
    harness: goodHarness()
  });
  assert.equal(writeFault.accepted, false, "write fault → not accepted");
});

test("acceptCharTestForTarget honors acceptCharTest's verdict (a non-deterministic target is rejected)", async () => {
  let call = 0;
  const flaky = { ...goodHarness(), runs: async (n) => Array.from({ length: n }, () => `{"v":${call++}}`) }; // differs each run
  const r = await acceptCharTestForTarget("m", "s", {
    generate: async () => '```js\nimport test from "node:test"; import assert from "node:assert"; test("t",()=>{console.log("x");assert.ok(1);});\n```',
    writeTest: async () => "/t",
    harness: flaky
  });
  assert.equal(r.accepted, false);
  assert.match(r.reason, /non-deterministic/);
});

test("verifyCharTestAfterFix: green after the refactor → pass; RED → revert (behaviour changed)", async () => {
  const accepted = { accepted: true, testPath: "/t", reason: "ok" };
  const pass = await verifyCharTestAfterFix(accepted, { runAccepted: async () => true });
  assert.equal(pass.pass, true);
  const red = await verifyCharTestAfterFix(accepted, { runAccepted: async () => false });
  assert.equal(red.pass, false);
  assert.match(red.reason, /went RED|behaviour changed/i);
});

test("verifyCharTestAfterFix fails closed on a non-accepted input or a missing runner or a run fault", async () => {
  assert.equal((await verifyCharTestAfterFix({ accepted: false, reason: "x" }, { runAccepted: async () => true })).pass, false);
  assert.equal((await verifyCharTestAfterFix({ accepted: true }, {})).pass, false, "no runAccepted → fail closed");
  assert.equal((await verifyCharTestAfterFix({ accepted: true }, { runAccepted: async () => { throw new Error("boom"); } })).pass, false);
});

test("verifyCharTestAfterFix requires executesChanged when supplied (test must cover the changed lines)", async () => {
  const accepted = { accepted: true, testPath: "/t" };
  const notCovered = await verifyCharTestAfterFix(accepted, { runAccepted: async () => true, executesChanged: async () => false });
  assert.equal(notCovered.pass, false, "green but does not execute the changed lines → propose-only");
  assert.match(notCovered.reason, /changed lines/);
  const covered = await verifyCharTestAfterFix(accepted, { runAccepted: async () => true, executesChanged: async () => true });
  assert.equal(covered.pass, true);
  const faultCov = await verifyCharTestAfterFix(accepted, { runAccepted: async () => true, executesChanged: async () => { throw new Error("cov boom"); } });
  assert.equal(faultCov.pass, false, "a coverage-check fault fails closed");
});

test("verifyCharTestAfterFix applies the OPTIONAL mutation gate when a scorer is supplied", async () => {
  const accepted = { accepted: true, testPath: "/t" };
  const weak = await verifyCharTestAfterFix(accepted, { runAccepted: async () => true, mutation: { score: async () => 0.2, severity: "P1", file: "m", lines: [1] } });
  assert.equal(weak.pass, false, "a weak mutation score blocks even a green char-test");
  assert.match(weak.reason, /mutation/);
  const strong = await verifyCharTestAfterFix(accepted, { runAccepted: async () => true, mutation: { score: async () => 0.95, severity: "P1", file: "m", lines: [1] } });
  assert.equal(strong.pass, true);
});
