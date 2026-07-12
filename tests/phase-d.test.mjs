import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseGrokEnvelope } from "../plugins/council/scripts/lib/agents.mjs";
import { runCommand } from "../plugins/council/scripts/lib/process.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION = path.join(ROOT, "plugins", "council", "scripts", "council-companion.mjs");

test("parseGrokEnvelope extracts text and sessionId, rejects prose", () => {
  const envelope = parseGrokEnvelope(
    JSON.stringify({ text: "OK", sessionId: "abc-123", stopReason: "EndTurn" })
  );
  assert.deepEqual(envelope, { text: "OK", sessionId: "abc-123" });
  assert.equal(parseGrokEnvelope("plain prose output"), null);
  assert.equal(parseGrokEnvelope(JSON.stringify({ notText: 1 })), null);
});

test("shell-bound arguments containing % are refused (cmd expansion guard)", (t) => {
  if (process.platform !== "win32") {
    t.skip("cmd shell path is Windows-only");
    return;
  }
  const result = runCommand("definitely-not-a-real-command", ["%PATH%"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to pass '%'/);
});

test("shell-bound arguments containing a newline are refused (cmd truncation guard, A4 claude-1)", (t) => {
  if (process.platform !== "win32") {
    t.skip("cmd shell path is Windows-only");
    return;
  }
  // A multi-line arg (e.g. a --append-system-prompt system charter) through cmd.exe would
  // truncate silently or break the call; the guard must fail LOUD instead.
  const result = runCommand("definitely-not-a-real-command", ["--append-system-prompt", "line one\nline two"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to pass a newline/);
});

test("archiveJobResults writes sidecars, truncates inline copies; wait/usage subcommands work", async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-state-"));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "council-work-"));
  const previous = process.env.AGENT_COUNCIL_STATE_DIR;
  process.env.AGENT_COUNCIL_STATE_DIR = stateRoot;

  try {
    const { archiveJobResults, resolveArtifactsDir, writeJobFile } = await import(
      "../plugins/council/scripts/lib/state.mjs"
    );

    const long = "x".repeat(6000);
    const slim = archiveJobResults(workDir, "council-testjob", [
      { agent: "grok", status: 0, stdout: long, stderr: "" },
      { agent: "codex", skipped: true, reason: "skip" }
    ]);
    assert.match(slim[0].stdout, /truncated, full output in/);
    assert.ok(slim[0].artifactFile.includes("council-testjob"));
    const artifactBody = fs.readFileSync(slim[0].artifactFile, "utf8");
    assert.ok(artifactBody.includes(long));
    assert.equal(slim[1].skipped, true);
    assert.ok(fs.existsSync(resolveArtifactsDir(workDir, "council-testjob")));

    writeJobFile(workDir, "council-testjob", {
      id: "council-testjob",
      kind: "deliberate",
      title: "t",
      status: "completed",
      summary: "s",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:01:00.000Z",
      finishedAt: "2026-07-10T00:01:00.000Z",
      exitCode: 0,
      results: slim,
      reportSections: { header: "H", merged: "M", debate: null }
    });

    const env = { ...process.env, AGENT_COUNCIL_STATE_DIR: stateRoot };
    const wait = spawnSync(
      process.execPath,
      [COMPANION, "wait", "council-testjob", "--timeout", "3", "--json"],
      { cwd: workDir, env, encoding: "utf8" }
    );
    assert.equal(wait.status, 0, wait.stderr);
    const waited = JSON.parse(wait.stdout);
    assert.equal(waited.finished, true);
    assert.equal(waited.status, "completed");

    const summary = spawnSync(
      process.execPath,
      [COMPANION, "result", "council-testjob", "--summary", "--json"],
      { cwd: workDir, env, encoding: "utf8" }
    );
    assert.equal(summary.status, 0, summary.stderr);
    const sections = JSON.parse(summary.stdout).sections;
    assert.equal(sections.header, "H");
    assert.equal(sections.merged, "M");

    const usage = spawnSync(process.execPath, [COMPANION, "usage", "--json"], {
      cwd: workDir,
      env,
      encoding: "utf8"
    });
    assert.equal(usage.status, 0, usage.stderr);
    const stats = JSON.parse(usage.stdout);
    assert.equal(stats.jobs >= 1, true);
    assert.equal(stats.agents.grok.calls >= 1, true);
    assert.equal(stats.kinds.deliberate.jobs >= 1, true);
  } finally {
    if (previous === undefined) delete process.env.AGENT_COUNCIL_STATE_DIR;
    else process.env.AGENT_COUNCIL_STATE_DIR = previous;
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
