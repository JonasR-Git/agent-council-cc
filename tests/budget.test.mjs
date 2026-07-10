import test from "node:test";
import assert from "node:assert/strict";

import { evaluateBudget, renderBudgetBreaches } from "../plugins/council/scripts/lib/budget.mjs";
import { DEFAULT_POLICY, mergeOptionsWithPolicy } from "../plugins/council/scripts/lib/policy.mjs";

const pressure = {
  claude: { usedPercent: 92, window: "weekly", resetsAt: "2026-07-12T00:00:00Z" },
  codex: { usedPercent: 40, window: "5h", resetsAt: null },
  grok: { usedPercent: 5, window: "weekly", resetsAt: null }
};

test("evaluateBudget flags only windows at/above threshold", () => {
  const { breaches, checked } = evaluateBudget(pressure, 80);
  assert.equal(checked, 3);
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].agent, "claude");
  assert.equal(breaches[0].percent, 92);
});

test("evaluateBudget ignores skipped agents and reports unreadable data", () => {
  const partial = { claude: { usedPercent: 95, window: "weekly" }, codex: null, grok: null };
  const skipped = evaluateBudget(partial, 80, ["claude", "codex", "grok"]);
  assert.equal(skipped.breaches.length, 0);
  assert.equal(skipped.checked, 0);
  assert.deepEqual(skipped.unreadable, []);

  const included = evaluateBudget(partial, 80, []);
  assert.equal(included.breaches.length, 1);
  assert.equal(included.checked, 1);
  // codex + grok have no data -> unreadable -> caller fails closed.
  assert.deepEqual(included.unreadable.sort(), ["codex", "grok"]);
});

test("evaluateBudget: a readable-but-under provider with an unreadable peer still flags unreadable", () => {
  const mixed = { claude: null, codex: { usedPercent: 10, window: "5h" }, grok: { usedPercent: 5, window: "weekly" } };
  const r = evaluateBudget(mixed, 80, []);
  assert.equal(r.breaches.length, 0);
  assert.deepEqual(r.unreadable, ["claude"]);
  // companion blocks on (breaches || unreadable.length || !checked)
  assert.equal(r.breaches.length || r.unreadable.length || !r.checked ? true : false, true);
});

test("threshold boundary is inclusive", () => {
  const exact = evaluateBudget({ codex: { usedPercent: 80, window: "5h" } }, 80);
  assert.equal(exact.breaches.length, 1);
});

test("renderBudgetBreaches includes percent, window and reset", () => {
  const text = renderBudgetBreaches(evaluateBudget(pressure, 80).breaches);
  assert.match(text, /claude: 92% of weekly window used/);
  assert.match(text, /resets 2026-07-12/);
});

test("policy budget_guard clamps and merges", () => {
  const base = { ...DEFAULT_POLICY, _source: null };
  assert.equal(mergeOptionsWithPolicy({}, base).budgetGuard, 0);
  assert.equal(mergeOptionsWithPolicy({ budgetGuard: 80 }, base).budgetGuard, 80);
  assert.equal(mergeOptionsWithPolicy({ budgetGuard: 150 }, base).budgetGuard, 100);
  assert.equal(mergeOptionsWithPolicy({ budgetGuard: -5 }, base).budgetGuard, 0);
  assert.equal(mergeOptionsWithPolicy({}, { ...base, budget_guard: 75 }).budgetGuard, 75);
});
