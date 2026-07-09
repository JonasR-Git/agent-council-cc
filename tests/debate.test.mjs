import test from "node:test";
import assert from "node:assert/strict";

import { applyDebateOutcomes, normalizeStance } from "../plugins/council/scripts/lib/debate.mjs";

test("normalizeStance defaults to defend", () => {
  assert.equal(normalizeStance("concede"), "concede");
  assert.equal(normalizeStance("REVISE"), "revise");
  assert.equal(normalizeStance("something else"), "defend");
  assert.equal(normalizeStance(null), "defend");
});

function mergedWith(item) {
  const all = [item];
  return {
    all,
    consensus: all.filter((i) => i.consensus),
    unique: all.filter((i) => !i.consensus),
    votes: []
  };
}

test("applyDebateOutcomes downgrades conceded items to nit and clears contested", () => {
  const merged = mergedWith({
    ids: ["codex-1"],
    agents: ["codex"],
    severity: "P1",
    consensus: false,
    contested: true
  });
  const debates = [{ id: "codex-1", agent: "codex", round: 1, stance: "concede", note: "you are right" }];
  const next = applyDebateOutcomes(merged, debates);
  assert.equal(next.all[0].severity, "nit");
  assert.equal(next.all[0].contested, false);
  assert.equal(next.all[0].debate.stance, "concede");
});

test("applyDebateOutcomes applies valid revised severity and attaches counters", () => {
  const merged = mergedWith({
    ids: ["grok-2"],
    agents: ["grok"],
    severity: "P0",
    consensus: false,
    contested: true
  });
  const debates = [
    { id: "grok-2", agent: "grok", round: 1, stance: "revise", note: "half right", revisedSeverity: "P2" },
    { id: "grok-2", agent: "codex", round: 2, upheld: true, note: "still an issue" }
  ];
  const next = applyDebateOutcomes(merged, debates);
  assert.equal(next.all[0].severity, "P2");
  assert.equal(next.all[0].debate.counter.upheld, true);
});

test("applyDebateOutcomes ignores invalid revised severities and untouched items", () => {
  const merged = mergedWith({
    ids: ["codex-9"],
    agents: ["codex"],
    severity: "P1",
    consensus: false,
    contested: true
  });
  const debates = [
    { id: "codex-9", agent: "codex", round: 1, stance: "revise", note: "", revisedSeverity: "CRITICAL" }
  ];
  const next = applyDebateOutcomes(merged, debates);
  assert.equal(next.all[0].severity, "P1");

  const untouched = applyDebateOutcomes(merged, []);
  assert.equal(untouched, merged);
});
