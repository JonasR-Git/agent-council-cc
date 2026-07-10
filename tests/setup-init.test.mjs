import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadPolicy } from "../plugins/council/scripts/lib/policy.mjs";

const COMPANION = fileURLToPath(
  new URL("../plugins/council/scripts/council-companion.mjs", import.meta.url)
);

function runSetupInit(cwd, extraArgs = []) {
  return spawnSync(process.execPath, [COMPANION, "setup", "--init", "--json", ...extraArgs], {
    cwd,
    encoding: "utf8"
  });
}

test("setup --init scaffolds a .council.yml that loadPolicy reads back", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "council-init-"));
  const result = runSetupInit(cwd, [
    "--reviewers",
    "claude,grok",
    "--claude-backend",
    "spawn",
    "--claude-model",
    "claude-opus-4-8",
    "--default-mode",
    "deliberate"
  ]);
  if (result.error && (result.error.code === "EPERM" || result.error.code === "ENOENT")) {
    t.skip("child_process.spawn is blocked by this sandbox");
    return;
  }
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const report = JSON.parse(result.stdout);
  assert.equal(report.written, true);
  assert.ok(fs.existsSync(report.path), "scaffolded file should exist on disk");

  const policy = loadPolicy(cwd);
  assert.deepEqual(policy.reviewers, ["claude", "grok"]);
  assert.equal(policy.claude_backend, "spawn");
  assert.equal(policy.claude_model, "claude-opus-4-8");
  assert.equal(policy.default_mode, "deliberate");
});

test("setup --init rejects model strings that could inject into the YAML", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "council-init-"));
  const result = runSetupInit(cwd, ["--claude-model", "opus\n#danger: true"]);
  if (result.error && (result.error.code === "EPERM" || result.error.code === "ENOENT")) {
    t.skip("child_process.spawn is blocked by this sandbox");
    return;
  }
  assert.notEqual(result.status, 0, "a newline/# in a model value must be rejected");
  assert.equal(fs.existsSync(path.join(cwd, ".council.yml")), false, "no file written on invalid input");
});

test("setup --init refuses to clobber an existing file without --force", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "council-init-"));
  const first = runSetupInit(cwd);
  if (first.error && (first.error.code === "EPERM" || first.error.code === "ENOENT")) {
    t.skip("child_process.spawn is blocked by this sandbox");
    return;
  }
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.equal(JSON.parse(first.stdout).written, true);

  const second = runSetupInit(cwd);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const secondReport = JSON.parse(second.stdout);
  assert.equal(secondReport.written, false, "second init without --force must not overwrite");

  const forced = runSetupInit(cwd, ["--force"]);
  assert.equal(JSON.parse(forced.stdout).written, true, "--force allows overwrite");
});
