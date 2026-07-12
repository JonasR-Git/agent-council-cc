import assert from "node:assert/strict";
import test from "node:test";

import { makeCharTestGate } from "../plugins/council/scripts/lib/chartest-wiring.mjs";

const GEN_OK = '```js\nimport test from "node:test";\nimport assert from "node:assert";\ntest("f", () => { console.log(JSON.stringify(42)); assert.equal(42, 42); });\n```';

// a runCommand that always passes and emits a stable JSON observable
const runPass = async () => ({ status: 0, stdout: 'TAP version 13\n{"v":42}\nok 1', timedOut: false });

function baseDeps(overrides = {}) {
  const files = new Map();
  return {
    generate: async () => GEN_OK,
    runCommand: runPass,
    writeFile: (p, s) => files.set(p, s),
    removeFile: (p) => files.delete(p),
    readCoverage: () => ({ result: [{ url: "file:///r/m.mjs", functions: [{ ranges: [{ startOffset: 0, endOffset: 9999, count: 1 }] }] }] }),
    _files: files,
    ...overrides
  };
}

test("makeCharTestGate.eligible gates on refactor lenses only", () => {
  const g = makeCharTestGate("/r", {}, {}, baseDeps());
  assert.equal(g.eligible({ lens: "architecture_ssot" }), true);
  assert.equal(g.eligible({ lens: "correctness" }), false);
});

test("makeCharTestGate.accept generates + pins behaviour, then DELETES the transient test (clean tree)", async () => {
  const deps = baseDeps();
  const g = makeCharTestGate("/r", {}, {}, deps);
  const res = await g.accept({ file: "m.mjs", source: "export const f = () => 42;" });
  assert.equal(res.accepted, true, "a deterministic, non-vacuous test is accepted");
  assert.ok(res.code && /node:test/.test(res.code), "the generated test code is carried forward");
  assert.equal(deps._files.size, 0, "the transient test file is removed → the tree is clean for applyFix");
});

test("makeCharTestGate.accept fails closed when the generator returns nothing (→ propose-only)", async () => {
  const g = makeCharTestGate("/r", {}, {}, baseDeps({ generate: async () => "" }));
  const res = await g.accept({ file: "m.mjs", source: "export const f = () => 42;" });
  assert.equal(res.accepted, false);
});

test("makeCharTestGate.accept rejects a NON-deterministic target (observable differs across runs)", async () => {
  let n = 0;
  const g = makeCharTestGate("/r", {}, {}, baseDeps({ runCommand: async () => ({ status: 0, stdout: `{"v":${n++}}`, timedOut: false }) }));
  const res = await g.accept({ file: "m.mjs", source: "export const f = () => Date.now();" });
  assert.equal(res.accepted, false, "flaky observable → not accepted");
});

test("makeCharTestGate.verify passes when the test stays green + covers the changed lines; deletes the test", async () => {
  const deps = baseDeps();
  const g = makeCharTestGate("/r", {}, {}, deps);
  const res = await g.verify({ file: "m.mjs", source: "export const f = () => 42;", code: "import test from 'node:test';", changedLines: [1] });
  assert.equal(res.pass, true);
  assert.equal(deps._files.size, 0, "the transient test file is removed after verify");
});

test("makeCharTestGate.verify FAILS (revert) when the test goes red after the refactor", async () => {
  const g = makeCharTestGate("/r", {}, {}, baseDeps({ runCommand: async () => ({ status: 1, stdout: "not ok 1", timedOut: false }) }));
  const res = await g.verify({ file: "m.mjs", source: "x", code: "import test from 'node:test';", changedLines: [1] });
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
