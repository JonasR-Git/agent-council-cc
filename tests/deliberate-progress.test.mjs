import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runDeliberation } from "../plugins/council/scripts/lib/deliberate.mjs";

// Phase 2 / Task 5 — `council deliberate` must FEED the run reporter at its milestones. runDeliberation
// wraps its onPhase seam so every milestone (context → r1 → r2 → verify/debate) drives reporter.phase
// ALONGSIDE the caller's own onPhase. All seats are injected fakes — no CLI, no network.

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-deliberate-progress-"));
  execSync("git init -q", { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.mjs"), "export const a = 1;\n", "utf8");
  return dir;
}

function findingsJson(seat) {
  return JSON.stringify({
    agent: seat,
    summary: `${seat} summary`,
    verdict: "request_changes",
    findings: [{ id: `${seat}-1`, severity: "P1", category: "bug", title: `${seat} sees an unchecked index`, detail: "d", file: "a.mjs", line: 1, confidence: 0.8 }]
  });
}
function critiqueJson(seat, about) {
  return JSON.stringify({ agent: seat, about, summary: `${seat} on ${about}`, votes: [{ targetId: `${about}-1`, title: `${about} sees an unchecked index`, vote: "agree", note: "ok" }] });
}
function fakeSeat(seat) {
  return (prompt) => {
    const about = /PEER CRITIQUE/.test(prompt) ? String(prompt.match(/reviewer \(\*\*([\w.-]+)\*\*\)/)?.[1] ?? "?") : null;
    return Promise.resolve({ agent: seat, backend: "fake", status: 0, stdout: about ? critiqueJson(seat, about) : findingsJson(seat), stderr: "", skipped: false, timedOut: false });
  };
}
const fakeDeps = () => ({ runCodex: fakeSeat("codex"), runGrok: fakeSeat("grok"), runClaude: fakeSeat("claude") });
const backends = () => ({ codex: { companion: "c.mjs", companionAvailable: true }, grok: { bin: "grok", cli: { available: true } }, claude: { bin: "claude", cli: { available: true } } });

function recordingReporter() {
  const phases = [];
  const r = {
    phase: (kind, detail) => { phases.push([kind, detail]); return r; },
    seat: () => r, counter: () => r, gate: () => r, progress: () => r, findings: () => r,
    budget: () => r, eta: () => r, line: () => r, done: () => r, snapshot: () => null
  };
  return { reporter: r, phases };
}

test("runDeliberation drives reporter.phase at its milestones (alongside the caller's onPhase)", async () => {
  const dir = makeRepo();
  const { reporter, phases } = recordingReporter();
  const userPhases = [];
  const result = await runDeliberation(dir, backends(), { ledger: false, claudeBackend: "spawn", reporter, onPhase: (m) => userPhases.push(m) }, fakeDeps());
  assert.ok(result.r1.length >= 2, "the deliberation still ran (reporter is additive)");

  // Every reporter phase is the "deliberate" kind, and the key milestones drove it.
  assert.ok(phases.length > 0, "the reporter received phase events");
  assert.ok(phases.every(([kind]) => kind === "deliberate"), "all phases carry the deliberate kind");
  const details = phases.map(([, d]) => d);
  assert.ok(details.some((d) => /collecting-context/.test(d)), "the context milestone drove a phase");
  assert.ok(details.some((d) => /^r1/.test(d)), "an r1 milestone drove a phase");
  assert.ok(details.some((d) => /^r2/.test(d)), "an r2 milestone drove a phase");
  // The caller's own onPhase was preserved, not replaced.
  assert.ok(userPhases.length > 0 && userPhases.some((m) => /^r1/.test(m)), "the caller's onPhase still fires");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("runDeliberation without a reporter still runs (NOOP fallback, caller onPhase intact)", async () => {
  const dir = makeRepo();
  const userPhases = [];
  const result = await runDeliberation(dir, backends(), { ledger: false, claudeBackend: "spawn", onPhase: (m) => userPhases.push(m) }, fakeDeps());
  assert.ok(result.r1.length >= 2, "omitting options.reporter falls back to NOOP_REPORTER and changes nothing");
  assert.ok(userPhases.length > 0, "the caller's onPhase still fires without a reporter");
  fs.rmSync(dir, { recursive: true, force: true });
});
