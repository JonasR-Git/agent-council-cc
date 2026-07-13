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

test("preset 'fine' is a valid COVER of 30 focused groups (every lens hunted by ≥1 group)", () => {
  const groups = getLensGroups("fine");
  assert.equal(groups.length, 30, `fine group count is locked; got ${groups.length}`);
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

test("high-value lenses are SPLIT into the LOCKED number of focused passes (deeper than one sweep)", () => {
  const groups = getLensGroups("fine");
  const perLens = new Map();
  for (const g of groups) perLens.set(g.lenses[0], (perLens.get(g.lenses[0]) ?? 0) + 1);
  // Exact counts (council grok-6: a loose >= threshold would let a split silently collapse).
  assert.equal(perLens.get("security_secrets"), 5, "security → authz/injection/secrets/crypto/misconfig");
  assert.equal(perLens.get("concurrency_resources"), 4, "concurrency → races/deadlock/leaks/exhaustion");
  assert.equal(perLens.get("architecture_ssot"), 3, "SSOT/architecture (Prio 1) → duplication/coupling/graph");
  assert.equal(perLens.get("data_integrity"), 3);
  assert.equal(perLens.get("correctness"), 3);
  assert.equal(perLens.get("performance"), 2, "performance split into complexity + memory");
  assert.equal(perLens.get("reliability_observability"), 2, "reliability split from observability");
});

test("FINE_GROUPS is DEEP-frozen — an importer cannot mutate the shared singleton", () => {
  assert.equal(Object.isFrozen(FINE_GROUPS), true);
  assert.equal(Object.isFrozen(FINE_GROUPS[0]), true, "inner group objects are frozen");
  assert.equal(Object.isFrozen(FINE_GROUPS[0].lenses), true, "inner lenses arrays are frozen");
  assert.throws(() => { FINE_GROUPS[0].lenses.push("correctness"); }, TypeError);
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

test("validateLensGroups (council claude-2/codex-1): a lens listed twice WITHIN one group is NOT over-coverage", () => {
  // A copy-paste duplicate inside one group's array is one membership, flagged separately — it must
  // NOT read as a partition violation (the pre-fix bug counted raw occurrences).
  const r = validateLensGroups([{ id: "g", lenses: ["correctness", "correctness"] }], { requireExactlyOne: true, requireCover: false });
  assert.deepEqual(r.overCovered, [], "same lens twice in ONE group is not 'in >1 group'");
  assert.deepEqual(r.duplicateLensInGroup, ["g"], "the within-group duplicate is surfaced on its own signal");
  assert.equal(r.ok, false, "a duplicate-lens-in-group still fails validation");
});

test("validateLensGroups tolerates a null/undefined group element without crashing (council claude-5)", () => {
  const r = validateLensGroups([null, undefined, { id: "g", lenses: ["correctness"] }], { requireCover: false });
  assert.equal(r.emptyGroups.includes(""), true, "a null element is treated as an empty, id-less group");
  assert.ok(Array.isArray(r.uncovered));
});

test("validateLensGroups requireCover:false permits a scoped (incomplete) cover", () => {
  const r = validateLensGroups([{ id: "sec", lenses: ["security_secrets"] }], { requireCover: false });
  assert.equal(r.ok, true, "a deliberately-scoped run is valid when requireCover is off");
  assert.ok(r.uncovered.length > 0, "uncovered lenses are still reported, just not failing");
});

test("resolveLensGroups('custom') supports a scoped run via requireCover:false, else demands a full cover", () => {
  const scoped = [{ id: "sec", lenses: ["security_secrets"] }];
  assert.throws(() => resolveLensGroups("custom", { customGroups: scoped }), /uncovered lenses/);
  assert.equal(resolveLensGroups("custom", { customGroups: scoped, requireCover: false }).length, 1, "scoped custom resolves when requireCover is off");
  // a full-cover custom resolves through the default (requireCover true)
  const full = getLensGroups("lens"); // 13 single-lens groups = a full cover
  assert.equal(resolveLensGroups("custom", { customGroups: full }).length, 13);
});

test("resolveLensGroups surfaces integrity failures end-to-end (duplicate id / unknown lens / empty group)", () => {
  assert.throws(
    () => resolveLensGroups("custom", { customGroups: [{ id: "d", lenses: ["not_a_lens"] }, { id: "d", lenses: [] }], requireCover: false }),
    /unknown lenses.*|duplicate group ids.*|empty groups/
  );
});

test("getLensGroups('tier') and ('lens') also return fresh clones (council codex-4)", () => {
  for (const preset of ["tier", "lens"]) {
    const a = getLensGroups(preset);
    a[0].lenses.push("correctness");
    const b = getLensGroups(preset);
    assert.equal(b[0].lenses.includes("correctness") && b[0].lenses.length > 1, false, `${preset} result is not a shared reference`);
  }
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
