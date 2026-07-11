import assert from "node:assert/strict";
import test from "node:test";

import { detectLogical } from "../plugins/council/scripts/lib/audit-logical.mjs";

const node = (id, { exports = [], hasDefault = false, inn = [], out = [], opaque = false } = {}) => ({
  id,
  exports: new Set(exports),
  hasDefault,
  in: new Set(inn),
  out: new Set(out),
  opaque
});
const graph = (...nodes) => new Map(nodes.map((n) => [n.id, n]));

test("deadModule is a LOW-confidence OBSERVATION: surfaced, but never gates", async () => {
  const facts = { nodes: graph(node("entry.mjs"), node("dead.mjs", { exports: ["x"] })), entrypoints: new Set(["entry.mjs"]) };
  const { findings, verdictMap } = await detectLogical(facts);
  const dead = findings.find((f) => f.location.path === "dead.mjs");
  assert.ok(dead, "the dead module is surfaced as a proposal");
  assert.equal(dead.verdict, "remove");
  assert.equal(dead.observation, true, "a regex-grade signal is an observation, not a gating verdict");
  assert.equal(dead.fixDisposition, "propose-only");
  assert.deepEqual(verdictMap, {}, "below the confidence floor -> no gating entry (does not disarm the override)");
});

test("singleConsumer is a LOW-confidence observation, labelled over-layered-indirection", async () => {
  const facts = { nodes: graph(node("a.mjs", { out: ["b.mjs"] }), node("b.mjs", { exports: ["foo"], inn: ["a.mjs"] })), entrypoints: new Set(["a.mjs"]) };
  const { findings, verdictMap } = await detectLogical(facts);
  const b = findings.find((f) => f.location.path === "b.mjs");
  assert.equal(b.category, "over-layered-indirection");
  assert.equal(b.observation, true);
  assert.deepEqual(verdictMap, {}, "a single regex import edge never redirects a real fix");
});

test("a corroborated (>= floor) gating verdict IS written to the verdict map", async () => {
  const predicates = {
    hi: () => [{ unit: "g.mjs", category: "dead-feature", verdict: "remove", confidence: 0.95, severity: "P2", reason: "corroborated dead" }]
  };
  const { findings, verdictMap } = await detectLogical({ nodes: new Map(), entrypoints: new Set() }, { predicates });
  assert.equal(findings[0].observation, false);
  assert.equal(verdictMap["g.mjs"].verdict, "remove");
  assert.equal(verdictMap["g.mjs"].confidence, 0.95);
});

test("entry points are never flagged dead; no firing predicate -> empty", async () => {
  const facts = {
    nodes: graph(node("a1.mjs", { out: ["b.mjs"] }), node("a2.mjs", { out: ["b.mjs"] }), node("b.mjs", { exports: ["foo"], inn: ["a1.mjs", "a2.mjs"] })),
    entrypoints: new Set(["a1.mjs", "a2.mjs"])
  };
  const { findings, verdictMap } = await detectLogical(facts);
  assert.equal(findings.length, 0);
  assert.deepEqual(verdictMap, {});
});

test("adversarial intent-defense is batched (one call) and demotes removal -> quarantine", async () => {
  const predicates = {
    hi: () => [{ unit: "b.mjs", category: "dead-feature", verdict: "remove", confidence: 0.95, severity: "P2", reason: "dead?" }]
  };
  let calls = 0;
  const intentDefense = async (cands) => {
    calls += 1;
    return new Map(cands.map((c) => [c.unit, { found: true, source: "README", quote: "kept on purpose" }]));
  };
  const { findings, verdictMap } = await detectLogical({ nodes: new Map(), entrypoints: new Set() }, { predicates, intentDefense });
  assert.equal(calls, 1, "defense runs ONCE for all candidates, not per-candidate");
  const b = findings.find((f) => f.location.path === "b.mjs");
  assert.equal(b.verdict, "quarantine");
  assert.equal(b.intentEvidence.source, "README");
  assert.deepEqual(verdictMap, {}, "a quarantined (intent-defended) unit does not gate");
});

test("a throwing intent-defense degrades gracefully (candidates remain, as observations)", async () => {
  const predicates = { hi: () => [{ unit: "b.mjs", category: "dead-feature", verdict: "remove", confidence: 0.95, severity: "P2", reason: "x" }] };
  const intentDefense = async () => {
    throw new Error("agent timed out");
  };
  const { findings } = await detectLogical({ nodes: new Map(), entrypoints: new Set() }, { predicates, intentDefense });
  assert.equal(findings.length, 1, "one defense failure must not abort the whole pass");
});

test("age guard suppresses speculative AND removal-class candidates on young code", async () => {
  const facts = {
    nodes: graph(node("a.mjs", { out: ["b.mjs"] }), node("b.mjs", { exports: ["foo"], inn: ["a.mjs"] }), node("young.mjs", { exports: ["z"] })),
    entrypoints: new Set(["a.mjs"]),
    ageOf: (id) => (id === "b.mjs" || id === "young.mjs" ? 5 : 100)
  };
  const { findings } = await detectLogical(facts, { ageGuardDays: 30 });
  assert.equal(findings.find((f) => f.location.path === "b.mjs"), undefined, "young single-consumer suppressed");
  assert.equal(findings.find((f) => f.location.path === "young.mjs"), undefined, "young dead-module suppressed (a plan, not dead)");
});

test("a partial/malformed node degrades to no-candidate instead of crashing", async () => {
  const bad = { id: "bad.mjs", exports: new Set(["x"]), hasDefault: false, out: new Set(), opaque: false }; // no `.in`
  const { findings } = await detectLogical({ nodes: new Map([["bad.mjs", bad]]), entrypoints: new Set() });
  assert.ok(Array.isArray(findings), "detection did not throw on a node missing .in");
});

test("opaque modules (star re-export / dynamic) are not flagged single-consumer", async () => {
  const facts = { nodes: graph(node("a.mjs", { out: ["b.mjs"] }), node("b.mjs", { exports: ["foo"], inn: ["a.mjs"], opaque: true })), entrypoints: new Set(["a.mjs"]) };
  const { findings } = await detectLogical(facts);
  assert.equal(findings.find((f) => f.location.path === "b.mjs" && f.category === "over-layered-indirection"), undefined);
});
