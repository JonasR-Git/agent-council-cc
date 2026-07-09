import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildEvidence, filterDocForCritique } from "../plugins/council/scripts/lib/deliberate.mjs";

function doc(findings) {
  return { agent: "codex", summary: "", verdict: "request_changes", findings, parseOk: true };
}

test("filterDocForCritique keeps only configured severities", () => {
  const input = doc([
    { id: "c-1", severity: "P0" },
    { id: "c-2", severity: "P2" },
    { id: "c-3", severity: "P1" },
    { id: "c-4", severity: "nit" }
  ]);
  const { doc: filtered, critiqued, total } = filterDocForCritique(input, ["P0", "P1"]);
  assert.equal(total, 4);
  assert.equal(critiqued, 2);
  assert.deepEqual(
    filtered.findings.map((f) => f.id),
    ["c-1", "c-3"]
  );
});

test("filterDocForCritique with empty severity list critiques everything", () => {
  const input = doc([{ id: "c-1", severity: "nit" }]);
  const { critiqued, total } = filterDocForCritique(input, []);
  assert.equal(critiqued, total);
});

test("buildEvidence extracts a line window around each finding", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-evidence-"));
  const lines = Array.from({ length: 100 }, (_, i) => `line-${i + 1}`);
  fs.writeFileSync(path.join(dir, "sample.txt"), lines.join("\n"), "utf8");

  const evidence = buildEvidence(dir, [{ id: "x-1", file: "sample.txt", line: 50 }], "fallback");
  assert.match(evidence, /x-1/);
  assert.match(evidence, /50: line-50/);
  assert.match(evidence, /25: line-25/);
  assert.match(evidence, /75: line-75/);
  assert.doesNotMatch(evidence, /(^|\n)24: line-24/);
  assert.doesNotMatch(evidence, /(^|\n)76: line-76/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("buildEvidence falls back to provided content when no file evidence exists", () => {
  const evidence = buildEvidence("C:/does/not/exist", [{ id: "x-1", file: null }], "the fallback diff");
  assert.equal(evidence, "the fallback diff");
});
