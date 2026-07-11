import assert from "node:assert/strict";
import test from "node:test";

import { enforcePlannedTouched, planTouchedSet, runMultiFix, unionSurfaceViolation } from "../plugins/council/scripts/lib/audit-multifix.mjs";

test("planTouchedSet is the sorted, de-duped survivor + victims + importers", () => {
  assert.deepEqual(planTouchedSet({ survivor: "core.mjs", victims: ["h.mjs"], importers: ["app.mjs", "core.mjs"] }), ["app.mjs", "core.mjs", "h.mjs"]);
});

test("enforcePlannedTouched requires the touched set to EQUAL the plan", () => {
  assert.equal(enforcePlannedTouched(["a.mjs", "b.mjs"], ["a.mjs", "b.mjs"]).ok, true);
  const extra = enforcePlannedTouched(["a.mjs", "b.mjs", "c.mjs"], ["a.mjs", "b.mjs"]);
  assert.equal(extra.ok, false);
  assert.deepEqual(extra.extra, ["c.mjs"], "an unplanned edit reverts");
  const missing = enforcePlannedTouched(["a.mjs"], ["a.mjs", "b.mjs"]);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ["b.mjs"], "a half-done plan reverts");
});

test("unionSurfaceViolation: a MOVE preserves the union; a DROP violates; opaque fails closed", () => {
  // foo moves from helper into core -> union {bar,foo} unchanged
  assert.equal(unionSurfaceViolation({ "h.mjs": "export const foo=1;", "c.mjs": "export const bar=2;" }, { "h.mjs": "", "c.mjs": "export const bar=2;\nexport const foo=1;" }), null);
  // foo dropped from everywhere
  assert.match(unionSurfaceViolation({ "h.mjs": "export const foo=1;" }, { "h.mjs": "" }), /dropped/);
  // additions are allowed
  assert.equal(unionSurfaceViolation({ "c.mjs": "export const bar=2;" }, { "c.mjs": "export const bar=2;\nexport const baz=3;" }), null);
  // un-enumerable surface -> fail closed
  assert.match(unionSurfaceViolation({ "h.mjs": "export * from './x.mjs';" }, { "h.mjs": "export * from './y.mjs';" }), /unverifiable/);
});

function fakeGit() {
  const calls = [];
  let head = "base0";
  let changed = [];
  return {
    calls,
    setChanged: (c) => {
      changed = c;
    },
    isRepo: () => true,
    isClean: () => true,
    head: () => head,
    changedFiles: () => changed,
    resetHard: (ref) => {
      calls.push(["resetHard", ref]);
      changed = [];
    },
    commitFiles: (files, msg) => {
      calls.push(["commitFiles", files, msg]);
      head = `c${calls.length}`;
      changed = [];
      return head;
    }
  };
}

const moveTransform = { survivor: "core.mjs", victims: ["helper.mjs"], importers: ["app.mjs"], title: "fold helper into core" };
const beforeMap = { "helper.mjs": "export const foo = 1;\n", "core.mjs": "export const bar = 2;\n", "app.mjs": "import { foo } from './helper.mjs';\n" };
const afterMoved = { "helper.mjs": "\n", "core.mjs": "export const bar = 2;\nexport const foo = 1;\n", "app.mjs": "import { foo } from './core.mjs';\n" };

const deps = (git, over = {}) => {
  let phase = 0;
  return {
    git,
    readFiles: () => (phase++ === 0 ? beforeMap : afterMoved),
    applyTransform: async () => git.setChanged(["app.mjs", "core.mjs", "helper.mjs"]),
    runTests: async () => ({ ok: true }),
    ...over
  };
};

test("runMultiFix commits an atomic move whose touched set matches the plan + preserves the surface", async () => {
  const git = fakeGit();
  const out = await runMultiFix("/x", [moveTransform], {}, {}, deps(git));
  assert.equal(out.applied.length, 1);
  assert.equal(out.rejected.length, 0);
  const commit = git.calls.find((c) => c[0] === "commitFiles");
  assert.deepEqual(commit[1], ["app.mjs", "core.mjs", "helper.mjs"], "one commit for all planned files");
});

test("runMultiFix reverts a transform that touches an UNPLANNED file", async () => {
  const git = fakeGit();
  const out = await runMultiFix("/x", [moveTransform], {}, {}, deps(git, { applyTransform: async () => git.setChanged(["app.mjs", "core.mjs", "helper.mjs", "sneaky.mjs"]) }));
  assert.equal(out.applied.length, 0);
  assert.match(out.rejected[0].reason, /touched set != planned/);
  assert.ok(git.calls.some((c) => c[0] === "resetHard"));
});

test("runMultiFix reverts a consolidation that DROPS an exported name", async () => {
  const git = fakeGit();
  let phase = 0;
  const dropped = { "helper.mjs": "\n", "core.mjs": "export const bar = 2;\n", "app.mjs": "import { foo } from './core.mjs';\n" };
  const out = await runMultiFix("/x", [moveTransform], {}, {}, deps(git, { readFiles: () => (phase++ === 0 ? beforeMap : dropped) }));
  assert.equal(out.applied.length, 0);
  assert.match(out.rejected[0].reason, /dropped exported name/);
});

test("runMultiFix reverts when the full suite goes red, or the char-test is rejected", async () => {
  const red = await runMultiFix("/x", [moveTransform], {}, {}, deps(fakeGit(), { runTests: async () => ({ ok: false }) }));
  assert.match(red.rejected[0].reason, /suite went red/);
  const ct = await runMultiFix("/x", [moveTransform], {}, {}, deps(fakeGit(), { acceptCharTest: async () => ({ accept: false, reason: "non-deterministic target" }) }));
  assert.match(ct.rejected[0].reason, /characterization test not accepted/);
});

test("runMultiFix requires its injectable deps", async () => {
  const out = await runMultiFix("/x", [moveTransform], {}, {}, { git: fakeGit() });
  assert.match(out.error, /requires deps/);
});
