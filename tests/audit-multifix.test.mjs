import assert from "node:assert/strict";
import test from "node:test";

import { enforcePlannedTouched, missingImporters, planConsolidation, planTouchedSet, runMultiFix, unionSurfaceViolation } from "../plugins/council/scripts/lib/audit-multifix.mjs";

test("planTouchedSet is the sorted, de-duped survivor + victims + importers", () => {
  assert.deepEqual(planTouchedSet({ survivor: "core.mjs", victims: ["h.mjs"], importers: ["app.mjs", "core.mjs"] }), ["app.mjs", "core.mjs", "h.mjs"]);
});

test("enforcePlannedTouched requires the touched set to EQUAL the plan", () => {
  assert.equal(enforcePlannedTouched(["a.mjs", "b.mjs"], ["a.mjs", "b.mjs"]).ok, true);
  assert.deepEqual(enforcePlannedTouched(["a.mjs", "b.mjs", "c.mjs"], ["a.mjs", "b.mjs"]).extra, ["c.mjs"]);
  assert.deepEqual(enforcePlannedTouched(["a.mjs"], ["a.mjs", "b.mjs"]).missing, ["b.mjs"]);
});

test("unionSurfaceViolation: move preserved; drop / collision / multi-default / opaque caught", () => {
  assert.equal(unionSurfaceViolation({ "h.mjs": "export const foo=1;", "c.mjs": "export const bar=2;" }, { "h.mjs": "", "c.mjs": "export const bar=2;\nexport const foo=1;" }), null);
  assert.match(unionSurfaceViolation({ "h.mjs": "export const foo=1;" }, { "h.mjs": "" }), /dropped/);
  // same name in TWO touched files pre-merge -> collision (two symbols, one silently lost)
  assert.match(unionSurfaceViolation({ "h.mjs": "export const validate=1;", "c.mjs": "export const validate=2;" }, { "h.mjs": "", "c.mjs": "export const validate=2;" }), /collision/);
  // two defaults -> one necessarily lost (OR'd boolean used to hide this)
  assert.match(unionSurfaceViolation({ "h.mjs": "export default 1;", "c.mjs": "export default 2;" }, { "h.mjs": "", "c.mjs": "export default 2;" }), /multiple default/);
  assert.match(unionSurfaceViolation({ "h.mjs": "export * from './x.mjs';" }, { "h.mjs": "export * from './y.mjs';" }), /unverifiable/);
});

function fakeGit({ resetLeavesDirty = false } = {}) {
  const calls = [];
  let head = "base0";
  let changed = [];
  let dirty = false;
  return {
    calls,
    setChanged: (c) => {
      changed = c;
    },
    isRepo: () => true,
    isClean: () => !dirty && changed.length === 0,
    head: () => head,
    changedFiles: () => changed,
    resetHard: (ref) => {
      calls.push(["resetHard", ref]);
      if (resetLeavesDirty) dirty = true;
      else {
        changed = [];
        dirty = false;
      }
    },
    commitFiles: (files, msg) => {
      calls.push(["commitFiles", files, msg]);
      head = `c${calls.length}`;
      changed = [];
      dirty = false;
      return head;
    }
  };
}

const codemod = { kind: "deterministic-codemod", survivor: "core.mjs", victims: ["helper.mjs"], importers: ["app.mjs"], title: "fold helper into core" };
const beforeMap = { "helper.mjs": "export const foo = 1;\n", "core.mjs": "export const bar = 2;\n", "app.mjs": "import { foo } from './helper.mjs';\n" };
const afterMoved = { "helper.mjs": "\n", "core.mjs": "export const bar = 2;\nexport const foo = 1;\n", "app.mjs": "import { foo } from './core.mjs';\n" };

const deps = (git, over = {}) => {
  let phase = 0;
  return {
    git,
    readFiles: () => (phase++ === 0 ? beforeMap : afterMoved),
    applyTransform: async () => git.setChanged(["app.mjs", "core.mjs", "helper.mjs"]),
    isDeterministic: async () => true,
    runTests: async () => ({ ok: true }),
    ...over
  };
};

test("runMultiFix PROPOSES by default (§9: no auto-commit without a verified deterministic transform)", async () => {
  const git = fakeGit();
  const out = await runMultiFix("/x", [{ ...codemod, kind: undefined }], {}, {}, deps(git));
  assert.equal(out.applied.length, 0);
  assert.equal(out.proposed.length, 1);
  assert.match(out.proposed[0].reason, /propose-only/);
  assert.ok(!git.calls.some((c) => c[0] === "commitFiles"), "nothing committed");
});

test("a verified deterministic codemod that passes every gate commits atomically", async () => {
  const git = fakeGit();
  const out = await runMultiFix("/x", [codemod], {}, {}, deps(git));
  assert.equal(out.applied.length, 1);
  const commit = git.calls.find((c) => c[0] === "commitFiles");
  assert.deepEqual(commit[1], ["app.mjs", "core.mjs", "helper.mjs"], "one commit for all planned files");
});

test("reverts an unplanned edit, a dropped export, a red suite, or a rejected char-test", async () => {
  const g1 = fakeGit();
  const unplanned = await runMultiFix("/x", [codemod], {}, {}, deps(g1, { applyTransform: async () => g1.setChanged(["app.mjs", "core.mjs", "helper.mjs", "sneaky.mjs"]) }));
  assert.match(unplanned.rejected[0].reason, /touched set != planned/);

  let phase = 0;
  const dropped = { "helper.mjs": "\n", "core.mjs": "export const bar = 2;\n", "app.mjs": "import { foo } from './core.mjs';\n" };
  const drop = await runMultiFix("/x", [codemod], {}, {}, deps(fakeGit(), { readFiles: () => (phase++ === 0 ? beforeMap : dropped) }));
  assert.match(drop.rejected[0].reason, /dropped exported name/);

  const red = await runMultiFix("/x", [codemod], {}, {}, deps(fakeGit(), { runTests: async () => ({ ok: false }) }));
  assert.match(red.rejected[0].reason, /suite went red/);

  const ct = await runMultiFix("/x", [codemod], {}, {}, deps(fakeGit(), { acceptCharTest: async () => ({ accept: false, reason: "non-deterministic" }) }));
  assert.match(ct.rejected[0].reason, /characterization test not accepted/);
});

test("a non-reproducible codemod is reverted to propose-only", async () => {
  const out = await runMultiFix("/x", [codemod], {}, {}, deps(fakeGit(), { isDeterministic: async () => false }));
  assert.match(out.rejected[0].reason, /not reproducible/);
});

test("a FAILED rollback aborts the whole batch (never poisons the next transform)", async () => {
  const git = fakeGit({ resetLeavesDirty: true });
  const out = await runMultiFix("/x", [codemod, codemod], {}, {}, deps(git, { runTests: async () => ({ ok: false }) }));
  assert.equal(out.ok, false);
  assert.match(out.aborted, /rollback FAILED/);
});

test("blast-radius breaker: a transform above the threshold is proposed, not committed", async () => {
  const out = await runMultiFix("/x", [codemod], {}, { maxBlastRadius: 2 }, deps(fakeGit()));
  assert.equal(out.applied.length, 0);
  assert.match(out.proposed[0].reason, /blast radius/);
});

test("planConsolidation builds a codemod transform from the graph; missingImporters finds gaps", () => {
  const graph = { importers: { "helper.mjs": ["app.mjs", "core.mjs"] } };
  const plan = planConsolidation(graph, { victim: "helper.mjs", survivor: "core.mjs" });
  assert.equal(plan.kind, "deterministic-codemod");
  assert.deepEqual(plan.victims, ["helper.mjs"]);
  assert.deepEqual(plan.importers, ["app.mjs"], "the survivor is not listed as its own importer");
  assert.deepEqual(missingImporters(graph, ["helper.mjs"], ["helper.mjs", "core.mjs", "app.mjs"]), []);
  assert.deepEqual(missingImporters(graph, ["helper.mjs"], ["helper.mjs", "core.mjs"]), ["app.mjs"]);
});

test("an incomplete plan (a victim importer outside the plan) is PROPOSED, not committed", async () => {
  const graph = { importers: { "helper.mjs": ["app.mjs", "other.mjs"] } };
  const out = await runMultiFix("/x", [codemod], {}, { graph }, deps(fakeGit()));
  assert.equal(out.applied.length, 0);
  assert.match(out.proposed[0].reason, /plan incomplete.*other\.mjs/);
});

test("reverts a transform that carries protected content into a survivor, or regresses the oracle", async () => {
  let phase = 0;
  const withSecret = { "helper.mjs": "\n", "core.mjs": "export const bar=2;\nexport const foo=1;\nconst k='sk_live_ABCDEFGHIJKLMNOP';\n", "app.mjs": "import { foo } from './core.mjs';\n" };
  const secret = await runMultiFix("/x", [codemod], {}, {}, deps(fakeGit(), { readFiles: () => (phase++ === 0 ? beforeMap : withSecret) }));
  assert.match(secret.rejected[0].reason, /protected content/);
  const oracle = await runMultiFix("/x", [codemod], {}, {}, deps(fakeGit(), { runOracle: async () => ({ ok: false }) }));
  assert.match(oracle.rejected[0].reason, /oracle regression/);
});

test("runMultiFix requires its injectable deps", async () => {
  const out = await runMultiFix("/x", [codemod], {}, {}, { git: fakeGit() });
  assert.match(out.error, /requires deps/);
});
