import assert from "node:assert/strict";
import test from "node:test";

import { correlateFindings, lensFamily, mustEscalate } from "../plugins/council/scripts/lib/audit-correlate.mjs";

const f = (o) => ({ id: o.id, severity: "P1", lens: "correctness", category: "bug", ...o });

test("D: same-file findings sharing an anchor cluster into ONE writer naming every resolved id", () => {
  const findings = [
    f({ id: "a1", file: "x.mjs", line: 10, lens: "correctness" }),
    f({ id: "a2", file: "x.mjs", line: 18, lens: "correctness" }) // within the 25-line window → same cluster
  ];
  const { clusters, escalated } = correlateFindings(findings);
  assert.equal(escalated.length, 0);
  assert.equal(clusters.length, 1, "one same-file writer");
  assert.equal(clusters[0].file, "x.mjs");
  assert.deepEqual(clusters[0].findingIds.sort(), ["a1", "a2"], "the commit names every finding id it resolves");
});

test("D: far-apart same-file findings of the same family split into separate writer clusters", () => {
  const findings = [
    f({ id: "a1", file: "x.mjs", line: 10, lens: "correctness" }),
    f({ id: "a2", file: "x.mjs", line: 400, lens: "correctness" })
  ];
  const { clusters } = correlateFindings(findings, { lineWindow: 25 });
  assert.equal(clusters.length, 2, "line spans 390 apart do not share an anchor");
});

test("FIX #0: two INDEPENDENT localized findings on IMPORT-LINKED files are NOT escalated — one writer each", () => {
  const findings = [
    f({ id: "a1", file: "a.mjs", line: 5, lens: "correctness" }),
    f({ id: "b1", file: "b.mjs", line: 5, lens: "correctness" })
  ];
  // a.mjs imports b.mjs (importers[b.mjs] = [a.mjs]) → an import edge; both hold a same-family localized
  // finding. PRE-FIX this escalated BOTH to a "multi-file-dependency" proposal — on an interconnected
  // codebase (every lib file imports another) that escalated ~everything → 0 fixes. FIX #0: two independent
  // localized bugs are two SEPARATE same-file fixes (one writer each); cross-file safety is the fix loop's
  // test gate, not a pre-emptive escalation. An import edge alone must no longer escalate localized work.
  const { clusters, escalated } = correlateFindings(findings, { importers: { "b.mjs": ["a.mjs"] } });
  assert.equal(escalated.length, 0, "an import edge alone no longer escalates independent localized findings");
  assert.equal(clusters.length, 2, "each file keeps its own single writer — both stay actionable/fixable");
  assert.deepEqual(clusters.map((c) => c.file).sort(), ["a.mjs", "b.mjs"]);
  const ids = new Set(clusters.flatMap((c) => c.findingIds));
  assert.ok(ids.has("a1") && ids.has("b1"), "both findings survive as fixable same-file clusters, none dropped");
});

test("D: unrelated files (no import edge) stay SEPARATE same-file writers, not a multi-file escalation", () => {
  const findings = [
    f({ id: "a1", file: "a.mjs", line: 5, lens: "correctness" }),
    f({ id: "b1", file: "b.mjs", line: 5, lens: "correctness" })
  ];
  const { clusters, escalated } = correlateFindings(findings, { importers: {} });
  assert.equal(escalated.length, 0);
  assert.equal(clusters.length, 2, "one writer per file, no false cross-file coupling");
});

test("D: a cross-cutting / SSOT-family finding always escalates, never a same-file writer", () => {
  assert.equal(mustEscalate({ scope: "cross-cutting", lens: "correctness" }), true);
  assert.equal(mustEscalate({ fixDisposition: "propose-only", lens: "correctness" }), true);
  assert.equal(mustEscalate({ lens: "architecture_ssot" }), true, "structure/SSOT family (tier 1) → proposal");
  assert.equal(mustEscalate({ lens: "correctness" }), false);
  const { clusters, escalated } = correlateFindings([f({ id: "s1", file: "a.mjs", scope: "cross-cutting" })]);
  assert.equal(clusters.length, 0);
  assert.ok(escalated.some((c) => c.reason === "cross-cutting"));
});

test("D: correlation is deterministic — same input yields identical clusters/ids", () => {
  const findings = [
    f({ id: "a2", file: "x.mjs", line: 20 }),
    f({ id: "a1", file: "x.mjs", line: 12 })
  ];
  const one = JSON.stringify(correlateFindings(findings).clusters.map((c) => [c.file, c.findingIds.slice().sort()]));
  const two = JSON.stringify(correlateFindings(findings).clusters.map((c) => [c.file, c.findingIds.slice().sort()]));
  assert.equal(one, two);
});

test("D: lensFamily maps a null lens through category (no crash on bare findings)", () => {
  assert.equal(lensFamily({ category: "security" }), "t2s");
  assert.equal(lensFamily({ category: "architecture" }), "t1");
  assert.equal(typeof lensFamily({}), "string");
});
