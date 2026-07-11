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
  assert.equal(rep.coverage.total, 4, "all inventory files are coverage units");
  // src/auth.mjs (security path) + package.json (manifest) are mandatory
  assert.ok(rep.mandatorySurface.count >= 2);
  assert.equal(rep.mandatorySurface.reasons["package.json"], "dependency manifest/lockfile");
});

test("gate is indeterminate while the mandatory surface is only mapped, not reviewed", async () => {
  const rep = await runAudit("/x", model, {}, {}, deps());
  // package.json is mandatory but not "reviewed" -> mandatory.complete false -> indeterminate
  assert.equal(rep.gate.status, "indeterminate", "honest: full mandatory surface not yet reviewed");
});

test("runAudit tolerates a review that returns nothing", async () => {
  const rep = await runAudit("/x", model, {}, {}, deps({ review: async () => ({}) }));
  assert.ok(validate(SCHEMAS.auditReport, rep).valid);
  assert.equal(rep.register.length, 0);
});
