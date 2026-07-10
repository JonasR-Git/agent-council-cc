import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildGraph, findCycles, findDeadExports, parseModule, resolveImport } from "../plugins/council/scripts/lib/import-graph.mjs";
import { findDuplicateClusters } from "../plugins/council/scripts/lib/dup-detect.mjs";
import { buildCodebaseModel } from "../plugins/council/scripts/lib/codebase-model.mjs";

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

test("resolveImport resolves relative specifiers, ignores bare/builtin", () => {
  const set = new Set(["lib/x.mjs", "lib/sub/index.mjs"]);
  assert.equal(resolveImport("lib/a.mjs", "./x.mjs", set), "lib/x.mjs");
  assert.equal(resolveImport("lib/a.mjs", "./x", set), "lib/x.mjs");
  assert.equal(resolveImport("lib/a.mjs", "./sub", set), "lib/sub/index.mjs");
  assert.equal(resolveImport("lib/a.mjs", "node:fs", set), null);
  assert.equal(resolveImport("lib/a.mjs", "some-pkg", set), null);
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

test("findDeadExports flags an unimported module (low-confidence candidate)", () => {
  const files = [
    { id: "a.mjs", text: 'import "./b.mjs"; export const a=1;' },
    { id: "b.mjs", text: "export const b=1;" },
    { id: "orphan.mjs", text: "export function lonely(){}" }
  ];
  const nodes = buildGraph(files);
  const dead = findDeadExports(nodes, files);
  const ids = dead.map((d) => d.id);
  assert.ok(ids.includes("orphan.mjs"));
  assert.ok(ids.includes("a.mjs"), "a is imported by nobody -> also a candidate");
  assert.ok(!ids.includes("b.mjs"), "b is imported by a -> not dead");
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

test("buildCodebaseModel scans a fixture (fs fallback, no git) and returns candidates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-audit-"));
  fs.writeFileSync(path.join(dir, "a.mjs"), 'import { help } from "./b.mjs";\nexport function main(){ return help(); }\n');
  fs.writeFileSync(path.join(dir, "b.mjs"), "export function help(){ return 42; }\n");
  fs.writeFileSync(path.join(dir, "orphan.mjs"), "export function unused(){ return 1; }\n");

  const model = buildCodebaseModel(dir);
  assert.equal(model.coverage.modules, 3);
  assert.ok(Array.isArray(model.findings));
  // orphan.mjs has no importer -> a dead-code candidate
  assert.ok(model.findings.some((f) => f.category === "dead-code" && f.file === "orphan.mjs"));
  // every file has a hotspot score
  assert.ok(model.files.every((f) => Number.isFinite(f.hotspot)));
});
