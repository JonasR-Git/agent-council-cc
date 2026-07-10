import test from "node:test";
import assert from "node:assert/strict";

import { makeFenceNonce } from "../plugins/council/scripts/lib/agents.mjs";
import { evaluateBudget } from "../plugins/council/scripts/lib/budget.mjs";

test("makeFenceNonce is unique and hard to guess", () => {
  const a = makeFenceNonce();
  const b = makeFenceNonce();
  assert.notEqual(a, b);
  assert.match(a, /^[0-9A-F]{12}$/);
});

test("budget guard: no readable data -> caller must fail closed (checked===0)", () => {
  const { breaches, checked } = evaluateBudget({ claude: null, codex: null, grok: null }, 80);
  assert.equal(checked, 0);
  assert.equal(breaches.length, 0);
  // handleReview treats (breaches.length || !checked) as blocked -> fail closed.
  assert.equal(breaches.length || !checked, true);
});

test("budget guard: readable data under threshold does not fail closed", () => {
  const { breaches, checked } = evaluateBudget({ codex: { usedPercent: 10, window: "5h" } }, 80);
  assert.equal(checked, 1);
  assert.equal(breaches.length || !checked, false);
});
