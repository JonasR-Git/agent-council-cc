import assert from "node:assert/strict";
import test from "node:test";

import { coverageOfLines, ingestCoverage, parseIstanbul, parseLcov } from "../plugins/council/scripts/lib/audit-coverage-ingest.mjs";

test("parseLcov records only executed (hits>0) DA lines per file", () => {
  const lcov = ["SF:src/a.mjs", "DA:1,3", "DA:2,0", "DA:3,5", "end_of_record", "SF:src/b.mjs", "DA:10,1", "end_of_record"].join("\n");
  const m = parseLcov(lcov);
  assert.deepEqual([...m.get("src/a.mjs")].sort((x, y) => x - y), [1, 3], "line 2 (0 hits) is not executed");
  assert.deepEqual([...m.get("src/b.mjs")], [10]);
});

test("parseIstanbul expands executed statements to their line ranges", () => {
  const cov = {
    "/abs/src/a.mjs": { path: "/abs/src/a.mjs", statementMap: { 0: { start: { line: 1 }, end: { line: 1 } }, 1: { start: { line: 5 }, end: { line: 6 } } }, s: { 0: 2, 1: 0 } }
  };
  const m = parseIstanbul(cov);
  assert.deepEqual([...m.get("/abs/src/a.mjs")], [1], "stmt 1 (0 hits, lines 5-6) is not executed");
});

test("ingestCoverage unions lcov + istanbul", () => {
  const m = ingestCoverage({
    lcov: "SF:a.mjs\nDA:1,1\nend_of_record",
    istanbul: { "a.mjs": { path: "a.mjs", statementMap: { 0: { start: { line: 2 }, end: { line: 2 } } }, s: { 0: 1 } } }
  });
  assert.deepEqual([...m.get("a.mjs")].sort((x, y) => x - y), [1, 2]);
});

test("coverageOfLines: all covered / partial / absent / empty (fail-closed)", () => {
  const cov = new Map([["src/a.mjs", new Set([1, 2, 3])]]);
  assert.equal(coverageOfLines(cov, "src/a.mjs", [1, 2]).allCovered, true);
  const partial = coverageOfLines(cov, "src/a.mjs", [1, 4]);
  assert.equal(partial.allCovered, false);
  assert.deepEqual(partial.uncovered, [4]);
  assert.equal(coverageOfLines(cov, "missing.mjs", [1]).allCovered, false, "absent file -> uncovered");
  assert.equal(coverageOfLines(cov, "src/a.mjs", []).allCovered, false, "no changed lines -> nothing proven executed (fail-closed)");
});

test("coverageOfLines matches by suffix when coverage keys are absolute", () => {
  const abs = new Map([["/repo/src/a.mjs", new Set([1])]]);
  assert.equal(coverageOfLines(abs, "src/a.mjs", [1]).allCovered, true);
});
