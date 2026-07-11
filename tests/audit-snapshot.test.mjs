import assert from "node:assert/strict";
import test from "node:test";

import { diffSnapshot, exportSnapshot, snapshotViolation } from "../plugins/council/scripts/lib/audit-snapshot.mjs";

test("exportSnapshot captures sorted named exports + default flag", () => {
  const s = exportSnapshot("export const b = 1;\nexport function a() {}\nexport default 3;\n");
  assert.deepEqual(s.names, ["a", "b"]);
  assert.equal(s.hasDefault, true);
  assert.equal(exportSnapshot("const x = 1;\n").hasDefault, false);
  assert.deepEqual(exportSnapshot("const x = 1;\n").names, []);
});

test("exportSnapshot reads export-list and de-dupes", () => {
  const s = exportSnapshot("const a=1,b=2;\nexport { a, b as b };\nexport const a2 = 3;\n");
  assert.deepEqual(s.names, ["a", "a2", "b"]);
});

test("diffSnapshot reports removed / added / default flip", () => {
  const d = diffSnapshot({ names: ["a", "b"], hasDefault: true }, { names: ["a", "c"], hasDefault: false });
  assert.deepEqual(d.removed, ["b"]);
  assert.deepEqual(d.added, ["c"]);
  assert.equal(d.defaultFlipped, true);
});

test("snapshotViolation: stable surface -> null", () => {
  assert.equal(snapshotViolation("export const x = 1;\n", "export const x = 2;\n"), null, "body change, same surface");
  assert.equal(snapshotViolation("const x=1;\n", "const x=2;\n"), null, "no exports either side");
});

test("snapshotViolation flags a removed export", () => {
  const v = snapshotViolation("export const x=1;\nexport const y=2;\n", "export const x=1;\n");
  assert.match(v, /removed y/);
});

test("snapshotViolation flags an added export and a default flip by default", () => {
  assert.match(snapshotViolation("export const x=1;\n", "export const x=1;\nexport const z=2;\n"), /added z/);
  assert.match(snapshotViolation("export const x=1;\n", "export const x=1;\nexport default 9;\n"), /default export flipped/);
});

test("snapshotViolation allowAdditions tolerates a new export (Structure tier) but not a removal", () => {
  assert.equal(snapshotViolation("export const x=1;\n", "export const x=1;\nexport const z=2;\n", { allowAdditions: true }), null);
  assert.match(snapshotViolation("export const x=1;\nexport const y=2;\n", "export const x=1;\n", { allowAdditions: true }), /removed y/);
});

test("exportSnapshot sees TS type-level exports and CommonJS members", () => {
  const ts = exportSnapshot("export interface Opts {}\nexport type T = number;\nexport enum E { A }\n");
  assert.deepEqual(ts.names, ["E", "Opts", "T"]);
  const cjs = exportSnapshot("exports.foo = 1;\nmodule.exports.bar = 2;\n");
  assert.deepEqual(cjs.names, ["bar", "foo"]);
  const obj = exportSnapshot("const a=1,c=3;\nmodule.exports = { a, b: 2, c };\n");
  assert.deepEqual(obj.names, ["a", "b", "c"]);
  assert.equal(obj.opaque, false, "an object literal is enumerable, not opaque");
});

test("exportSnapshot marks un-enumerable surfaces opaque; snapshotViolation fails closed", () => {
  assert.equal(exportSnapshot("export * from './a.mjs';\n").opaque, true);
  assert.equal(exportSnapshot("module.exports = makeThing();\n").opaque, true);
  assert.equal(exportSnapshot("export const x = 1;\n").opaque, false);
  assert.match(snapshotViolation("export * from './a.mjs';\n", "export * from './b.mjs';\n"), /unverifiable/);
  assert.match(snapshotViolation("module.exports = build();\n", "module.exports = build();\n"), /unverifiable/);
});
