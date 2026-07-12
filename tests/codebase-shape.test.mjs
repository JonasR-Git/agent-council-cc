import assert from "node:assert/strict";
import test from "node:test";

import { computeShape, fileShape, parseGitNumstat, shapeDelta } from "../plugins/council/scripts/lib/codebase-shape.mjs";

test("fileShape counts functions, branches, and lines; ignores comments/strings", () => {
  const src = `// a comment with if and && that must NOT count
function foo(a) {
  if (a && a > 1) return 1;   // real branch
  const s = "if (x) for (y) &&"; // string must not count
  return a ? 2 : 3;
}
const bar = (x) => x || 0;
`;
  const s = fileShape(src);
  assert.ok(s.functions >= 2, "function foo + arrow bar");
  // branches: if, &&, ternary ?, || = 4 real decision points (string ones excluded)
  assert.ok(s.branches >= 4, `expected >=4 branches, got ${s.branches}`);
  assert.ok(s.complexity > s.branches, "complexity = functions + branches");
  assert.ok(s.codeLines < s.lines || s.codeLines === s.lines);
});

test("fileShape does not count // inside a URL as a comment", () => {
  const s = fileShape('const u = "see http://x.y for if and &&";\nfunction f(){ return 1; }\n');
  // the &&/if are inside a string → not counted
  assert.equal(s.branches, 0);
  assert.ok(s.functions >= 1);
});

test("computeShape aggregates a file set and records per-file shape", () => {
  const files = [
    { id: "a.mjs", source: "function a(){ if (x) return 1; }\n" },
    { id: "b.mjs", source: "export const b = 2;\n" }
  ];
  const shape = computeShape(files);
  assert.equal(shape.files, 2);
  assert.ok(shape.functions >= 1);
  assert.ok(shape.perFile["a.mjs"].branches >= 1);
  assert.equal(shape.perFile["b.mjs"].functions, 0);
  assert.ok(shape.avgComplexityPerFile > 0);
});

test("computeShape supports a readFile reader for path lists", () => {
  const fs = { "a.mjs": "const x = () => 1;\n" };
  const shape = computeShape(["a.mjs"], (p) => fs[p]);
  assert.equal(shape.files, 1);
  assert.ok(shape.functions >= 1, "arrow counted via reader");
});

test("shapeDelta reports signed before→after deltas and headline pairs", () => {
  const before = { files: 10, lines: 1000, codeLines: 800, functions: 60, branches: 200, complexity: 260 };
  const after = { files: 7, lines: 760, codeLines: 610, functions: 42, branches: 150, complexity: 192 };
  const d = shapeDelta(before, after, { added: 40, removed: 280 });
  assert.equal(d.files, -3, "3 files removed");
  assert.equal(d.functions, -18);
  assert.equal(d.complexity, -68, "simplified");
  assert.equal(d.linesRemoved, 280);
  assert.equal(d.before.functions, 60);
  assert.equal(d.after.functions, 42);
});

test("parseGitNumstat sums added/removed, handling binary '-' rows", () => {
  const numstat = "12\t4\tsrc/a.mjs\n0\t30\tsrc/b.mjs\n-\t-\timg.png\n";
  assert.deepEqual(parseGitNumstat(numstat), { added: 12, removed: 34 });
});
