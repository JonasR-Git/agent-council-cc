import assert from "node:assert/strict";
import test from "node:test";

import { runAudit } from "../plugins/council/scripts/lib/audit-run.mjs";
import { SCHEMAS } from "../plugins/council/scripts/lib/schemas.mjs";
import { validate } from "../plugins/council/scripts/lib/validate.mjs";

const model = { files: [{ id: "src/auth.mjs", fanIn: 3 }, { id: "src/util.mjs", fanIn: 1 }], entrypoints: [] };

const deps = (over = {}) => ({
  inventory: [
    { id: "src/auth.mjs", fileClass: "js" },
    { id: "src/util.mjs", fileClass: "js" },
    { id: "package.json", fileClass: "manifest" },
    { id: "README.md", fileClass: "doc" }
  ],
  nowIso: () => "2026-07-11T00:00:00Z",
  governance: { baselined: new Set(), waivers: new Map() },
  review: async () => ({
    findings: [{ severity: "P1", category: "security", title: "auth bypass", detail: "no check", file: "src/auth.mjs", line: 10, agents: ["codex", "claude"], consensus: true, anchor: "checkAuth" }],
    reviewed: ["src/auth.mjs"],
    coverage: { budgetSpent: 4 }
  }),
  ...over
});

test("runAudit assembles a schema-valid report end-to-end (injected review)", async () => {
  const rep = await runAudit("/x", model, {}, {}, deps());
  const v = validate(SCHEMAS.auditReport, rep);
  assert.ok(v.valid, v.errors.join("; "));
  assert.equal(rep.register.length, 1);
  assert.equal(rep.register[0].lens, "security_secrets");
  assert.equal(rep.coverage.total, 4);
  assert.ok(rep.mandatorySurface.count >= 2);
  assert.equal(rep.mandatorySurface.reasons["package.json"], "dependency manifest/lockfile");
});

test("gate reaches fail when the mandatory surface is covered and a new confirmed P1 exists", async () => {
  const rep = await runAudit("/x", model, {}, {}, deps());
  assert.equal(rep.gate.status, "fail");
  assert.deepEqual(rep.mandatoryUnreviewed, []);
});

test("gate is indeterminate when a mandatory JS file was not reviewed", async () => {
  const d = deps({
    inventory: [
      { id: "src/auth.mjs", fileClass: "js" },
      { id: "src/login.mjs", fileClass: "js" },
      { id: "package.json", fileClass: "manifest" }
    ],
    review: async () => ({ findings: [], reviewed: ["src/auth.mjs"], coverage: {} })
  });
  const rep = await runAudit("/x", model, {}, {}, d);
  assert.ok(rep.mandatoryUnreviewed.includes("src/login.mjs"));
  assert.equal(rep.gate.status, "indeterminate", "unreviewed mandatory JS keeps the gate honest");
});

test("runAudit tolerates a review that returns nothing", async () => {
  const rep = await runAudit("/x", model, {}, {}, deps({ review: async () => ({}) }));
  assert.ok(validate(SCHEMAS.auditReport, rep).valid);
  assert.equal(rep.register.length, 0);
});

test("runAudit marks a graph.entrypoint unit as mandatory (entrypoints live on model.graph, not model root)", async () => {
  // src/cli.mjs is not security/manifest/high-fan-in, so its ONLY route into the mandatory set is the
  // entrypoint signal — which must be read from model.graph.entrypoints, the shape codebase-model emits.
  const modelWithEntry = { files: [{ id: "src/cli.mjs", fanIn: 1 }], graph: { entrypoints: ["src/cli.mjs"] } };
  const customDeps = {
    inventory: [{ id: "src/cli.mjs", fileClass: "js" }],
    nowIso: () => "2026-07-11T00:00:00Z",
    governance: { baselined: new Set(), waivers: new Map() },
    review: async () => ({ findings: [], reviewed: [] })
  };
  const rep = await runAudit("/x", modelWithEntry, {}, {}, customDeps);
  assert.equal(rep.mandatorySurface.reasons["src/cli.mjs"], "entrypoint", "the CLI entrypoint is mandatory-covered via graph.entrypoints");
});
