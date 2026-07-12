import assert from "node:assert/strict";
import test from "node:test";

import { lensIds } from "../plugins/council/scripts/lib/audit-lenses.mjs";
import {
  FINE_GROUPS,
  LENS_GROUP_PRESETS,
  getLensGroups,
  lensesInGroups,
  resolveLensGroups,
  validateLensGroups
} from "../plugins/council/scripts/lib/audit-lens-groups.mjs";

const ALL_LENSES = lensIds();

test("LENS_GROUP_PRESETS lists exactly the four presets", () => {
  assert.deepEqual([...LENS_GROUP_PRESETS], ["tier", "lens", "fine", "custom"]);
});

test("preset 'tier' is a valid PARTITION (every lens in exactly one group)", () => {
  const groups = getLensGroups("tier");
  assert.equal(groups.length, 4);
  const r = validateLensGroups(groups, { requireExactlyOne: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([...lensesInGroups(groups)].sort(), [...ALL_LENSES].sort());
});

test("preset 'lens' is a valid PARTITION with one group per registered lens", () => {
  const groups = getLensGroups("lens");
  assert.equal(groups.length, ALL_LENSES.length);
  const r = validateLensGroups(groups, { requireExactlyOne: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const g of groups) assert.equal(g.lenses.length, 1);
});

test("preset 'fine' is a valid COVER of 20+ focused groups (every lens hunted by ≥1 group)", () => {
  const groups = getLensGroups("fine");
  assert.ok(groups.length >= 20, `expected ≥20 fine groups, got ${groups.length}`);
  const r = validateLensGroups(groups); // cover, not partition
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.uncovered, [], "no lens is left un-hunted");
  // every fine group narrows exactly one REGISTERED parent lens and carries a focus
  for (const g of groups) {
    assert.equal(g.lenses.length, 1, `${g.id} should narrow one parent lens`);
    assert.ok(ALL_LENSES.includes(g.lenses[0]), `${g.id} references a registered lens`);
    assert.ok(typeof g.focus === "string" && g.focus.length > 0, `${g.id} has a focus`);
  }
});

test("fine groups have unique ids", () => {
  const ids = FINE_GROUPS.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length, "fine group ids are unique");
});

test("high-value lenses are SPLIT across several fine groups (deeper than one broad sweep)", () => {
  const groups = getLensGroups("fine");
  const perLens = new Map();
  for (const g of groups) perLens.set(g.lenses[0], (perLens.get(g.lenses[0]) ?? 0) + 1);
  assert.ok(perLens.get("security_secrets") >= 3, "security is split into multiple focused passes");
  assert.ok(perLens.get("concurrency_resources") >= 3);
  assert.ok(perLens.get("architecture_ssot") >= 2, "SSOT/architecture (Prio 1) gets several passes");
});

test("validateLensGroups flags an uncovered lens", () => {
  const r = validateLensGroups([{ id: "g1", lenses: ["correctness"] }]);
  assert.equal(r.ok, false);
  assert.ok(r.uncovered.includes("security_secrets"), "missing lenses are reported");
});

test("validateLensGroups flags unknown lenses, duplicate ids, and empty groups", () => {
  const r = validateLensGroups([
    { id: "dup", lenses: ["correctness"] },
    { id: "dup", lenses: ["not_a_real_lens"] },
    { id: "empty", lenses: [] }
  ]);
  assert.equal(r.ok, false);
  assert.ok(r.unknownLenses.includes("not_a_real_lens"));
  assert.ok(r.duplicateIds.includes("dup"));
  assert.ok(r.emptyGroups.includes("empty"));
});

test("validateLensGroups flags over-coverage ONLY when a partition is required", () => {
  const groups = [
    { id: "a", lenses: ["correctness"] },
    { id: "b", lenses: ["correctness"] } // correctness in two groups
  ];
  assert.equal(validateLensGroups(groups).overCovered.length, 0, "a cover permits a lens in >1 group");
  assert.deepEqual(validateLensGroups(groups, { requireExactlyOne: true }).overCovered, ["correctness"]);
});

test("getLensGroups('custom') normalizes a caller list and throws on empty", () => {
  const groups = getLensGroups("custom", { customGroups: [{ id: "x", lenses: ["correctness", "testing"], focus: "f" }] });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].focus, "f");
  assert.throws(() => getLensGroups("custom", { customGroups: [] }), /non-empty customGroups/);
  assert.throws(() => getLensGroups("custom"), /non-empty customGroups/);
});

test("getLensGroups throws on an unknown preset (fail-loud, never silently empty)", () => {
  assert.throws(() => getLensGroups("bogus"), /unknown lens-group preset/);
});

test("getLensGroups returns cloned lenses arrays (frozen presets can't be mutated through the result)", () => {
  const a = getLensGroups("fine");
  a[0].lenses.push("correctness");
  const b = getLensGroups("fine");
  assert.equal(b[0].lenses.length, 1, "a later call is unaffected by mutating an earlier result");
});

test("resolveLensGroups validates and returns for the built-in presets; throws on an invalid cover", () => {
  for (const preset of ["tier", "lens", "fine"]) {
    assert.ok(resolveLensGroups(preset).length > 0, `${preset} resolves`);
  }
  assert.throws(() => resolveLensGroups("custom", { customGroups: [{ id: "g", lenses: ["correctness"] }] }), /uncovered lenses/);
});
