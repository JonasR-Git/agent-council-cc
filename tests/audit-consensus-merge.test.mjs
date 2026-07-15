import test from "node:test";
import assert from "node:assert/strict";

import {
  applyConsensusClusters,
  buildConsensusPrompt,
  consensusCandidates,
  parseConsensusClusters,
  runConsensusMerge
} from "../plugins/council/scripts/lib/audit-consensus-merge.mjs";

const f = (over) => ({ severity: "P1", file: "a.mjs", line: 10, title: "t", seats: ["codex"], id: "x", ...over });

// --- consensusCandidates -----------------------------------------------------------------------------

test("consensusCandidates: same-file single-seat findings from ≥2 distinct seats are candidates", () => {
  const groups = consensusCandidates([
    f({ file: "a.mjs", line: 10, title: "null deref", seats: ["codex"] }),
    f({ file: "a.mjs", line: 31, title: "possible NPE", seats: ["grok"] })
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].file, "a.mjs");
  assert.deepEqual(groups[0].items.map((i) => i.index), [0, 1]);
});

test("consensusCandidates: an already-consensus (≥2-seat) finding is excluded", () => {
  const groups = consensusCandidates([
    f({ seats: ["codex", "grok"], title: "already merged" }),
    f({ seats: ["claude"], title: "solo" })
  ]);
  assert.equal(groups.length, 0, "only one single-seat item remains → no ≥2-item group");
});

test("consensusCandidates: findings all from ONE seat are not candidates (no cross-seat consensus possible)", () => {
  const groups = consensusCandidates([
    f({ file: "a.mjs", seats: ["codex"], title: "one" }),
    f({ file: "a.mjs", seats: ["codex"], title: "two" })
  ]);
  assert.equal(groups.length, 0);
});

test("consensusCandidates: unlocated findings (no file) are skipped", () => {
  const groups = consensusCandidates([
    f({ file: null, location: null, seats: ["codex"] }),
    f({ file: null, location: null, seats: ["grok"] })
  ]);
  assert.equal(groups.length, 0);
});

test("consensusCandidates: never crosses files", () => {
  const groups = consensusCandidates([
    f({ file: "a.mjs", seats: ["codex"] }),
    f({ file: "b.mjs", seats: ["grok"] })
  ]);
  assert.equal(groups.length, 0, "one single-seat finding per file → no same-file ≥2-seat group");
});

// --- parseConsensusClusters --------------------------------------------------------------------------

test("parseConsensusClusters: extracts valid ≥2-member clusters, drops invalid/duplicate indices", () => {
  const valid = new Set([0, 1, 2, 3]);
  const out = parseConsensusClusters('noise { "clusters": [[0,1],[2,2],[3,99],[1,3]] } tail', valid);
  // [0,1] ok; [2,2] collapses to 1 member → dropped; [3,99] → [3] (99 invalid) → dropped;
  // [1,3] → 1 already claimed by [0,1], 3 valid → only [3] → dropped.
  assert.deepEqual(out, [[0, 1]]);
});

test("parseConsensusClusters: a finding joins only one cluster (first wins)", () => {
  const out = parseConsensusClusters('{ "clusters": [[0,1],[1,2]] }', new Set([0, 1, 2]));
  assert.deepEqual(out, [[0, 1]], "index 1 is claimed by the first cluster, so the second collapses");
});

test("parseConsensusClusters: garbage / no JSON → no clusters (fail-soft)", () => {
  assert.deepEqual(parseConsensusClusters("sorry, I cannot", new Set([0, 1])), []);
  assert.deepEqual(parseConsensusClusters("", new Set([0, 1])), []);
  assert.deepEqual(parseConsensusClusters('{ "clusters": "nope" }', new Set([0, 1])), []);
});

// --- applyConsensusClusters --------------------------------------------------------------------------

test("applyConsensusClusters: a cross-seat cluster unions seats, marks consensus, drops the duplicate", () => {
  const findings = [
    f({ severity: "P1", title: "null deref", seats: ["codex"], id: "c1" }),
    f({ severity: "P2", title: "possible NPE", seats: ["grok"], id: "g1" })
  ];
  const { findings: out, merges } = applyConsensusClusters(findings, [[0, 1]]);
  assert.equal(out.length, 1, "the duplicate is dropped");
  assert.equal(out[0].id, "c1", "the worst-severity (P1) finding is the representative");
  assert.deepEqual(out[0].seats.sort(), ["codex", "grok"]);
  assert.equal(out[0].consensus, "consensus");
  assert.deepEqual(out[0].ids.sort(), ["c1", "g1"]);
  assert.equal(merges[0].crossSeat, true);
});

test("applyConsensusClusters: representative is worst severity regardless of order", () => {
  const findings = [
    f({ severity: "P2", title: "minor", seats: ["grok"], id: "g" }),
    f({ severity: "P0", title: "critical", seats: ["codex"], id: "c" })
  ];
  const { findings: out } = applyConsensusClusters(findings, [[0, 1]]);
  assert.equal(out[0].id, "c", "P0 wins over P2 as representative");
});

test("applyConsensusClusters: a SAME-seat cluster dedups but NEVER fabricates consensus", () => {
  const findings = [
    f({ severity: "P1", title: "dup a", seats: ["codex"], id: "a" }),
    f({ severity: "P1", title: "dup b", seats: ["codex"], id: "b" })
  ];
  const { findings: out, merges } = applyConsensusClusters(findings, [[0, 1]]);
  assert.equal(out.length, 1, "one duplicate dropped");
  assert.ok(out[0].consensus !== "consensus", "a single seat repeating itself is NOT consensus");
  assert.equal(merges[0].crossSeat, false);
});

test("applyConsensusClusters: findings outside any cluster pass through unchanged and in order", () => {
  const findings = [f({ id: "keep-0", title: "x" }), f({ id: "a", seats: ["codex"] }), f({ id: "b", seats: ["grok"] }), f({ id: "keep-3", title: "y" })];
  const { findings: out } = applyConsensusClusters(findings, [[1, 2]]);
  assert.deepEqual(out.map((o) => o.id), ["keep-0", "a", "keep-3"], "untouched findings keep order; cluster collapses to its rep");
});

test("applyConsensusClusters: a CROSS-FILE cluster is rejected in code (council P1 — not prompt-only)", () => {
  const findings = [f({ file: "a.mjs", line: 10, seats: ["codex"], id: "a" }), f({ file: "b.mjs", line: 10, seats: ["grok"], id: "b" })];
  const { findings: out, merges } = applyConsensusClusters(findings, [[0, 1]]);
  assert.equal(out.length, 2, "cross-file members are never fused");
  assert.equal(merges.length, 0);
});

test("applyConsensusClusters: members too far apart are rejected (line-proximity guard vs. distinct bugs)", () => {
  const findings = [f({ file: "a.mjs", line: 10, seats: ["codex"], id: "a" }), f({ file: "a.mjs", line: 400, seats: ["grok"], id: "b" })];
  const { findings: out, merges } = applyConsensusClusters(findings, [[0, 1]]);
  assert.equal(out.length, 2, "two same-file findings 390 lines apart are likely distinct → not fused");
  assert.equal(merges.length, 0);
});

test("applyConsensusClusters: a REFUTED or cross-cutting member is never absorbed + consensus-stamped", () => {
  const refuted = [f({ file: "a.mjs", line: 10, seats: ["codex"], id: "a" }), f({ file: "a.mjs", line: 12, seats: ["grok"], id: "b", verified: { refuted: true } })];
  assert.equal(applyConsensusClusters(refuted, [[0, 1]]).merges.length, 0, "a refuted peer blocks the merge");
  const xcut = [f({ file: "a.mjs", line: 10, seats: ["codex"], id: "a" }), f({ file: "a.mjs", line: 12, seats: ["grok"], id: "b", scope: "cross-cutting" })];
  assert.equal(applyConsensusClusters(xcut, [[0, 1]]).merges.length, 0, "a cross-cutting peer blocks the merge");
});

test("applyConsensusClusters: conflicting fixLenses block the merge", () => {
  const findings = [f({ file: "a.mjs", line: 10, seats: ["codex"], id: "a", fixLens: "correctness" }), f({ file: "a.mjs", line: 12, seats: ["grok"], id: "b", fixLens: "security_secrets" })];
  assert.equal(applyConsensusClusters(findings, [[0, 1]]).merges.length, 0, "different fix-eligibility lenses → not the same fixable issue");
});

test("applyConsensusClusters: a merged finding's agents track the seat union (seatsOf agrees post-merge)", () => {
  const findings = [f({ file: "a.mjs", line: 10, seats: ["codex"], agents: ["codex"], id: "a" }), f({ file: "a.mjs", line: 12, seats: ["grok"], agents: ["grok"], id: "b" })];
  const { findings: out } = applyConsensusClusters(findings, [[0, 1]]);
  assert.deepEqual(out[0].agents.sort(), ["codex", "grok"], "agents is set to the union so seatsOf reports 2 seats");
});

test("runConsensusMerge: a failed Grok result (non-zero status / timed out) is NOT parsed (council P2)", async () => {
  const findings = [f({ file: "a.mjs", seats: ["codex"], id: "c" }), f({ file: "a.mjs", seats: ["grok"], id: "g" })];
  const nonZero = await runConsensusMerge(findings, { grok: async () => ({ status: 1, stdout: '{ "clusters": [[0,1]] }' }) });
  assert.equal(nonZero.merged, 0, "a non-zero exit is fail-soft, even with a parseable stdout fragment");
  const timedOut = await runConsensusMerge(findings, { grok: async () => ({ status: 0, timedOut: true, stdout: '{ "clusters": [[0,1]] }' }) });
  assert.equal(timedOut.merged, 0, "a timed-out call is fail-soft");
});

// --- runConsensusMerge (orchestrator) ----------------------------------------------------------------

test("runConsensusMerge: end-to-end upgrades a cross-seat pair to consensus", async () => {
  const findings = [
    f({ file: "a.mjs", line: 10, title: "off-by-one in loop", seats: ["codex"], id: "c" }),
    f({ file: "a.mjs", line: 12, title: "loop overruns by one", seats: ["grok"], id: "g" })
  ];
  const grok = async () => ({ stdout: '{ "clusters": [[0,1]] }' });
  const res = await runConsensusMerge(findings, { grok });
  assert.equal(res.merged, 1);
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0].consensus, "consensus");
  assert.deepEqual(res.findings[0].seats.sort(), ["codex", "grok"]);
});

test("runConsensusMerge: a Grok error leaves findings untouched (fail-soft)", async () => {
  const findings = [f({ seats: ["codex"], title: "a" }), f({ seats: ["grok"], title: "b" })];
  const grok = async () => {
    throw new Error("grok timeout");
  };
  const res = await runConsensusMerge(findings, { grok });
  assert.equal(res.merged, 0);
  assert.deepEqual(res.findings, findings, "the exact input is returned on failure");
});

test("runConsensusMerge: no grok fn or <2 findings → no-op", async () => {
  assert.equal((await runConsensusMerge([f({})], { grok: async () => "" })).merged, 0);
  assert.equal((await runConsensusMerge([f({}), f({})], {})).merged, 0);
});

test("runConsensusMerge: Grok inventing an out-of-range index cannot fabricate consensus", async () => {
  const findings = [f({ file: "a.mjs", seats: ["codex"], id: "c" }), f({ file: "a.mjs", seats: ["grok"], id: "g" })];
  const grok = async () => ({ stdout: '{ "clusters": [[0, 5]] }' }); // 5 is out of range → cluster collapses
  const res = await runConsensusMerge(findings, { grok });
  assert.equal(res.merged, 0, "an out-of-range partner drops the cluster; no false merge");
  assert.equal(res.findings.length, 2);
});

test("buildConsensusPrompt: lists indices + seats + file, asks for JSON clusters", () => {
  const groups = consensusCandidates([
    f({ file: "a.mjs", line: 10, title: "null deref", seats: ["codex"] }),
    f({ file: "a.mjs", line: 31, title: "NPE risk", seats: ["grok"] })
  ]);
  const prompt = buildConsensusPrompt(groups);
  assert.match(prompt, /FILE a\.mjs/);
  assert.match(prompt, /\[0\].*codex/);
  assert.match(prompt, /\[1\].*grok/);
  assert.match(prompt, /"clusters"/);
});
