import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildEvidence } from "../plugins/council/scripts/lib/deliberate.mjs";
import { mergeFindings } from "../plugins/council/scripts/lib/findings.mjs";
import { DEFAULT_POLICY, mergeOptionsWithPolicy } from "../plugins/council/scripts/lib/policy.mjs";

function doc(agent, findings) {
  return { agent, summary: "", verdict: "request_changes", findings, parseOk: true };
}

test("nearby lines with disjoint titles do NOT merge into consensus (grok-1 regression)", () => {
  const merged = mergeFindings([
    doc("codex", [
      { id: "codex-1", severity: "P1", category: "auth", title: "Broken session ownership check", detail: "", file: "a.mjs", line: 40, confidence: 0.8 }
    ]),
    doc("grok", [
      { id: "grok-1", severity: "P2", category: "performance", title: "Unbounded cache growth", detail: "", file: "a.mjs", line: 45, confidence: 0.8 }
    ])
  ]);
  assert.equal(merged.consensus.length, 0);
  assert.equal(merged.unique.length, 2);
});

test("nearby lines WITH shared title tokens still merge into consensus", () => {
  const merged = mergeFindings([
    doc("codex", [
      { id: "codex-1", severity: "P1", category: "security", title: "Evidence reads arbitrary paths", detail: "", file: "a.mjs", line: 61, confidence: 0.8 }
    ]),
    doc("grok", [
      { id: "grok-1", severity: "P2", category: "bug", title: "buildEvidence resolves paths without containment", detail: "", file: "a.mjs", line: 54, confidence: 0.8 }
    ])
  ]);
  assert.equal(merged.consensus.length, 1);
  assert.deepEqual(merged.consensus[0].agents.sort(), ["codex", "grok"]);
});

test("buildEvidence refuses paths escaping the repo root (grok-2 regression)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-containment-"));
  const outside = path.join(os.tmpdir(), `council-secret-${process.pid}.txt`);
  fs.writeFileSync(outside, "TOP-SECRET", "utf8");

  const traversal = path.relative(dir, outside);
  const evidence = buildEvidence(
    dir,
    [
      { id: "x-1", file: traversal, line: 1 },
      { id: "x-2", file: outside, line: 1 }
    ],
    "fallback-content"
  );
  assert.doesNotMatch(evidence, /TOP-SECRET/);
  assert.equal(evidence, "fallback-content");

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { force: true });
});

test("peer_critique_severities 'all' and explicit empty list mean critique everything (grok-5 regression)", () => {
  const base = { ...DEFAULT_POLICY, _source: null };
  assert.deepEqual(mergeOptionsWithPolicy({ peerCritiqueSeverities: "all" }, base).peerCritiqueSeverities, []);
  assert.deepEqual(mergeOptionsWithPolicy({ peerCritiqueSeverities: ["all"] }, base).peerCritiqueSeverities, []);
  assert.deepEqual(mergeOptionsWithPolicy({ peerCritiqueSeverities: [] }, base).peerCritiqueSeverities, []);
  assert.deepEqual(
    mergeOptionsWithPolicy({}, { ...base, peer_critique_severities: ["all"] }).peerCritiqueSeverities,
    []
  );
});
