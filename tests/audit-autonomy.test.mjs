import assert from "node:assert/strict";
import test from "node:test";

import { AUTONOMY_LEVELS, commitsAt, resolveAutonomy } from "../plugins/council/scripts/lib/audit-autonomy.mjs";

test("aggressive commits down to P2; conservative only P0/P1; propose-only commits nothing", () => {
  assert.equal(resolveAutonomy("aggressive").minSeverity, "P2");
  assert.equal(resolveAutonomy("aggressive").apply, true);
  assert.equal(resolveAutonomy("conservative").minSeverity, "P1");
  assert.equal(resolveAutonomy("conservative").apply, true);
  assert.equal(resolveAutonomy("propose-only").apply, false);
  assert.equal(resolveAutonomy("nonsense").label, "aggressive", "unknown level -> aggressive default");
});

test("commitsAt maps severity against the dial", () => {
  assert.equal(commitsAt("aggressive", "P2"), true);
  assert.equal(commitsAt("aggressive", "nit"), false, "nit is below the P2 line");
  assert.equal(commitsAt("conservative", "P2"), false);
  assert.equal(commitsAt("conservative", "P1"), true);
  assert.equal(commitsAt("propose-only", "P0"), false, "apply:false -> nothing commits");
});

test("per-run takes explicit apply + minSeverity", () => {
  assert.equal(resolveAutonomy("per-run", { minSeverity: "P1" }).minSeverity, "P1");
  assert.equal(resolveAutonomy("per-run", { apply: false }).apply, false);
  assert.equal(resolveAutonomy("per-run", {}).minSeverity, "P2", "default minSeverity when unspecified");
  assert.ok(AUTONOMY_LEVELS.includes("aggressive") && AUTONOMY_LEVELS.includes("propose-only"));
});
