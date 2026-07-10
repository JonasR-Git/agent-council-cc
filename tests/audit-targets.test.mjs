import assert from "node:assert/strict";
import test from "node:test";

import { hasSecuritySink, isInfra, isManifest, isSecuritySensitive, mandatorySet } from "../plugins/council/scripts/lib/audit-targets.mjs";

test("path classifiers flag the high-blast-radius surface", () => {
  assert.ok(isSecuritySensitive("src/auth/login.mjs"));
  assert.ok(isSecuritySensitive(".env.production"));
  assert.ok(isSecuritySensitive("config/tls.pem"));
  assert.ok(!isSecuritySensitive("src/util/format.mjs"));
  assert.ok(isInfra(".github/workflows/ci.yml"));
  assert.ok(isInfra("Dockerfile"));
  assert.ok(isManifest("package-lock.json"));
  assert.ok(isManifest("go.mod"));
  assert.ok(!isManifest("src/index.mjs"));
});

test("hasSecuritySink detects dangerous source markers", () => {
  assert.ok(hasSecuritySink("import cp from 'child_process'; cp.execSync(x)"));
  assert.ok(hasSecuritySink("el.innerHTML = userInput"));
  assert.ok(hasSecuritySink("db.query(`select * from t where id=${id}`)"));
  assert.ok(!hasSecuritySink("export const add = (a, b) => a + b;"));
});

test("mandatorySet unions the surface with a strongest-reason per file", () => {
  const { ids, reasons } = mandatorySet(
    [
      { id: "src/auth/session.mjs" },
      { id: ".github/workflows/ci.yml" },
      { id: "package.json" },
      { id: "bin/cli.mjs", isEntrypoint: true },
      { id: "src/api.mjs", isExport: true },
      { id: "src/hot.mjs", fanIn: 12 },
      { id: "src/glue.mjs", source: "require('child_process')" },
      { id: "src/plain.mjs", fanIn: 1 }
    ],
    { highFanIn: 8 }
  );
  assert.ok(!ids.includes("src/plain.mjs"), "a low-fan-in ordinary file is not mandatory");
  assert.equal(reasons["src/auth/session.mjs"], "security-sensitive path");
  assert.equal(reasons[".github/workflows/ci.yml"], "CI/infra config");
  assert.equal(reasons["package.json"], "dependency manifest/lockfile");
  assert.equal(reasons["bin/cli.mjs"], "entrypoint");
  assert.equal(reasons["src/api.mjs"], "public export surface");
  assert.match(reasons["src/hot.mjs"], /high fan-in/);
  assert.equal(reasons["src/glue.mjs"], "security sink in source");
});

test("mandatorySet honors configured critical globs", () => {
  const { reasons } = mandatorySet([{ id: "payments/charge.mjs" }], { criticalGlobs: ["payments/**"] });
  assert.equal(reasons["payments/charge.mjs"], "configured critical glob");
});
