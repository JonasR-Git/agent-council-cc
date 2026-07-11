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

test("deadModule predicate: an orphan non-entry module -> remove?, reachable:false", async () => {
  const facts = {
    nodes: graph(node("entry.mjs"), node("dead.mjs", { exports: ["x"] })),
    entrypoints: new Set(["entry.mjs"])
  };
  const { findings, verdictMap } = await detectLogical(facts);
  const dead = findings.find((f) => f.location.path === "dead.mjs");
  assert.ok(dead, "the dead module is flagged");
  assert.equal(dead.lens, "logical_sense");
  assert.equal(dead.verdict, "remove");
  assert.equal(dead.scope, "cross-cutting");
  assert.equal(dead.fixDisposition, "propose-only");
  assert.equal(verdictMap["dead.mjs"].verdict, "remove");
  assert.equal(verdictMap["dead.mjs"].reachable, false);
});

test("singleConsumer predicate: a one-importer module -> merge-into that survivor", async () => {
  const facts = {
    nodes: graph(node("a.mjs", { out: ["b.mjs"] }), node("b.mjs", { exports: ["foo"], inn: ["a.mjs"] })),
    entrypoints: new Set(["a.mjs"])
  };
  const { findings, verdictMap } = await detectLogical(facts);
  const b = findings.find((f) => f.location.path === "b.mjs");
  assert.equal(b.verdict, "merge-into");
  assert.equal(b.survivor, "a.mjs");
  assert.equal(verdictMap["b.mjs"].survivor, "a.mjs");
});

test("entry points are never flagged dead; predicate-driven -> no candidates -> empty", async () => {
  const facts = {
    nodes: graph(node("a1.mjs", { out: ["b.mjs"] }), node("a2.mjs", { out: ["b.mjs"] }), node("b.mjs", { exports: ["foo"], inn: ["a1.mjs", "a2.mjs"] })),
    entrypoints: new Set(["a1.mjs", "a2.mjs"])
  };
  const { findings, verdictMap } = await detectLogical(facts);
  assert.equal(findings.length, 0, "nothing fires when every module is reachable + multiply-imported");
  assert.deepEqual(verdictMap, {});
});

test("adversarial intent-defense demotes a removal-class verdict to quarantine", async () => {
  const facts = {
    nodes: graph(node("a.mjs", { out: ["b.mjs"] }), node("b.mjs", { exports: ["foo"], inn: ["a.mjs"] })),
    entrypoints: new Set(["a.mjs"])
  };
  const intentDefense = async (c) => (c.unit === "b.mjs" ? { found: true, source: "README", quote: "kept on purpose" } : { found: false });
  const { findings, verdictMap } = await detectLogical(facts, { intentDefense });
  const b = findings.find((f) => f.location.path === "b.mjs");
  assert.equal(b.verdict, "quarantine", "documented intent demotes merge-into to quarantine");
  assert.equal(b.intentEvidence.found, true);
  assert.equal(b.intentEvidence.source, "README");
  assert.equal(verdictMap["b.mjs"].verdict, "quarantine");
});

test("age guard suppresses speculative-generality on young code", async () => {
  const facts = {
    nodes: graph(node("a.mjs", { out: ["b.mjs"] }), node("b.mjs", { exports: ["foo"], inn: ["a.mjs"] })),
    entrypoints: new Set(["a.mjs"]),
    ageOf: (id) => (id === "b.mjs" ? 5 : 100)
  };
  const { findings } = await detectLogical(facts, { ageGuardDays: 30 });
  assert.equal(findings.find((f) => f.location.path === "b.mjs"), undefined, "a 5-day-old one-consumer module is a plan, not a finding");
});

test("opaque modules (star re-export / dynamic) are not flagged single-consumer", async () => {
  const facts = {
    nodes: graph(node("a.mjs", { out: ["b.mjs"] }), node("b.mjs", { exports: ["foo"], inn: ["a.mjs"], opaque: true })),
    entrypoints: new Set(["a.mjs"])
  };
  const { findings } = await detectLogical(facts);
  assert.equal(findings.length, 0, "an opaque module's true fan-in is unknowable");
});
