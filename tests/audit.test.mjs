import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildGraph, findCycles, findOrphanModules, parseModule, resolveImport, stripComments } from "../plugins/council/scripts/lib/import-graph.mjs";
import { findDuplicateClusters } from "../plugins/council/scripts/lib/dup-detect.mjs";
import { buildCodebaseModel } from "../plugins/council/scripts/lib/codebase-model.mjs";
import { buildUnitPrompt, makeBudget, selectUnits } from "../plugins/council/scripts/lib/audit-review.mjs";

// --- import graph ------------------------------------------------------------

test("parseModule extracts imports and exported names", () => {
  const p = parseModule(`
import { a, b as c } from "./x.mjs";
import def from "./y.mjs";
import "./side.mjs";
export function foo() {}
export const bar = 1;
export { a, qux as quux };
export default foo;
`);
  assert.deepEqual(new Set(p.imports), new Set(["./x.mjs", "./y.mjs", "./side.mjs"]));
  assert.deepEqual(new Set(p.exports), new Set(["foo", "bar", "a", "quux"]));
  assert.equal(p.hasDefault, true);
});

test("resolveImport resolves relative specifiers (incl .cjs), ignores bare/builtin", () => {
  const set = new Set(["lib/x.mjs", "lib/sub/index.mjs", "lib/legacy.cjs"]);
  assert.equal(resolveImport("lib/a.mjs", "./x.mjs", set), "lib/x.mjs");
  assert.equal(resolveImport("lib/a.mjs", "./x", set), "lib/x.mjs");
  assert.equal(resolveImport("lib/a.mjs", "./sub", set), "lib/sub/index.mjs");
  assert.equal(resolveImport("lib/a.mjs", "./legacy", set), "lib/legacy.cjs", "extensionless .cjs resolves");
  assert.equal(resolveImport("lib/a.mjs", "node:fs", set), null);
  assert.equal(resolveImport("lib/a.mjs", "some-pkg", set), null);
});

test("parseModule handles MULTILINE named imports and skips commented import-shaped text", () => {
  const p = parseModule(`
import {
  alpha,
  beta
} from "./multi.mjs";
export {
  gamma
} from "./reexport.mjs";
/* import "./ghost.mjs"; a commented phantom */
// import "./line-ghost.mjs";
export function real(){}
`);
  assert.ok(p.imports.includes("./multi.mjs"), "multiline named import produces an edge");
  assert.ok(p.imports.includes("./reexport.mjs"), "multiline export-from produces an edge");
  assert.ok(!p.imports.includes("./ghost.mjs"), "block-commented import must not count");
  assert.ok(!p.imports.includes("./line-ghost.mjs"), "line-commented import must not count");
  assert.ok(p.exports.includes("real"), "local export captured");
  assert.ok(p.exports.includes("gamma"), "re-exported name captured");
});

test("stripComments blanks comments but preserves '://' in strings", () => {
  assert.match(stripComments('const u = "http://x/y"; // trailing'), /http:\/\/x\/y/);
  assert.doesNotMatch(stripComments("a; // gone"), /gone/);
});

test("findCycles detects a 2-module import cycle", () => {
  const nodes = buildGraph([
    { id: "a.mjs", text: 'import "./b.mjs"; export const a=1;' },
    { id: "b.mjs", text: 'import "./a.mjs"; export const b=1;' },
    { id: "c.mjs", text: "export const c=1;" }
  ]);
  const cycles = findCycles(nodes);
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0], ["a.mjs", "b.mjs"]);
});

test("findOrphanModules flags unimported modules and honors entrypoints", () => {
  const files = [
    { id: "a.mjs", text: 'import "./b.mjs";\nexport const a=1;' },
    { id: "b.mjs", text: "export const b=1;" },
    { id: "orphan.mjs", text: "export function lonely(){}" }
  ];
  const nodes = buildGraph(files);
  const ids = findOrphanModules(nodes).map((d) => d.id);
  assert.ok(ids.includes("orphan.mjs"));
  assert.ok(ids.includes("a.mjs"), "a is imported by nobody -> orphan candidate");
  assert.ok(!ids.includes("b.mjs"), "b is imported by a -> not orphan");

  const withEntry = findOrphanModules(nodes, { entrypoints: new Set(["a.mjs"]) }).map((d) => d.id);
  assert.ok(!withEntry.includes("a.mjs"), "declared entrypoint is not reported orphan");
});

// --- duplication -------------------------------------------------------------

test("findDuplicateClusters finds an identical block across two files", () => {
  const block = ["const x = compute(a, b);", "if (x > 0) {", "log(x);", "total += x;", "count += 1;", "record(x, total);"].join("\n");
  const clusters = findDuplicateClusters(
    [
      { id: "one.mjs", text: `function f(){\n${block}\n}` },
      { id: "two.mjs", text: `function g(){\n${block}\n}` }
    ],
    { minLines: 6 }
  );
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].locations.length, 2);
  assert.deepEqual(clusters[0].locations.map((l) => l.file).sort(), ["one.mjs", "two.mjs"]);
});

test("findDuplicateClusters ignores short blocks and comments", () => {
  const shared = ["a();", "b();", "c();"].join("\n"); // only 3 lines < minLines
  const clusters = findDuplicateClusters(
    [
      { id: "one.mjs", text: `// identical license header\n// line two\n${shared}` },
      { id: "two.mjs", text: `// identical license header\n// line two\n${shared}` }
    ],
    { minLines: 6 }
  );
  assert.equal(clusters.length, 0);
});

// --- model integration -------------------------------------------------------

// --- v2 review backbone -----------------------------------------------------

test("makeBudget charges, gates, and never goes negative", () => {
  const b = makeBudget(3);
  assert.equal(b.remaining(), 3);
  assert.equal(b.canSpend(3), true);
  assert.equal(b.canSpend(4), false);
  b.charge(2);
  assert.equal(b.spent, 2);
  assert.equal(b.remaining(), 1);
  b.charge(5);
  assert.equal(b.remaining(), 0, "remaining clamps at 0");
});

test("selectUnits ranks by hotspot, excludes tests, caps at maxUnits", () => {
  const model = {
    files: [
      { id: "a.mjs", hotspot: 10, isTest: false },
      { id: "hot.mjs", hotspot: 90, isTest: false },
      { id: "mid.mjs", hotspot: 50, isTest: false },
      { id: "x.test.mjs", hotspot: 99, isTest: true }
    ]
  };
  assert.deepEqual(selectUnits(model, { maxUnits: 2 }), ["hot.mjs", "mid.mjs"]);
  assert.ok(!selectUnits(model, { maxUnits: 10 }).includes("x.test.mjs"), "tests excluded");
});

test("buildUnitPrompt bounds oversized source and flags the split", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-unit-"));
  fs.writeFileSync(path.join(dir, "big.mjs"), "x".repeat(50));
  const model = { files: [{ id: "big.mjs", loc: 1, branches: 0, maxNesting: 0, fanIn: 0, fanOut: 0, churn: 0, smellCount: 0, tested: false, hotspot: 5 }] };
  const p = buildUnitPrompt(dir, "big.mjs", model, { maxChars: 20 });
  assert.equal(p.totalChars, 50);
  assert.equal(p.suppliedChars, 20);
  assert.equal(p.split, true);
  assert.match(p.prompt, /hotspot=5/);
  assert.match(p.prompt, /truncated to 20 of 50/);
});

test("buildCodebaseModel scans a fixture (fs fallback, no git) and returns candidates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-audit-"));
  fs.writeFileSync(path.join(dir, "a.mjs"), 'import { help } from "./b.mjs";\nexport function main(){ return help(); }\n');
  fs.writeFileSync(path.join(dir, "b.mjs"), "export function help(){ return 42; }\n");
  fs.writeFileSync(path.join(dir, "orphan.mjs"), "export function unused(){ return 1; }\n");

  const model = buildCodebaseModel(dir);
  assert.equal(model.coverage.modules, 3);
  assert.ok(Array.isArray(model.findings));
  // orphan.mjs has no importer -> an orphan candidate
  assert.ok(model.findings.some((f) => f.category === "orphan" && f.file === "orphan.mjs"));
  // every file has a hotspot score
  assert.ok(model.files.every((f) => Number.isFinite(f.hotspot)));
});
