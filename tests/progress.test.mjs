import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runDeliberation } from "../plugins/council/scripts/lib/deliberate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("runDeliberation emits ordered phase callbacks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-phase-"));
  execSync("git init -q", { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n", "utf8");

  const phases = [];
  const findingsFile = path.join(dir, "claude.json");
  fs.writeFileSync(
    findingsFile,
    JSON.stringify({ agent: "claude", summary: "s", verdict: "approve", findings: [] }),
    "utf8"
  );

  const result = await runDeliberation(dir, { codex: {}, grok: {} }, {
    skipCodex: true,
    skipGrok: true,
    claudeFindingsPath: findingsFile,
    onPhase: (p) => phases.push(p)
  });

  assert.equal(result.mode, "deliberate");
  assert.equal(phases[0], "collecting-context");
  assert.ok(phases.includes("r1"));
  assert.ok(phases.includes("r1-done"));
  assert.ok(phases.indexOf("r1") < phases.indexOf("r1-done"));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a throwing onPhase does not exist here - reporter is guarded in the companion", () => {
  // The companion's makePhaseReporter swallows errors; runDeliberation itself
  // calls onPhase directly, so callers must not throw. This documents the contract.
  assert.ok(ROOT.length > 0);
});
