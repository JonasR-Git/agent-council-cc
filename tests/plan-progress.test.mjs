import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runPlanDeliberation } from "../plugins/council/scripts/lib/plan-deliberate.mjs";
import { makeProgressReporter } from "../plugins/council/scripts/lib/progress.mjs";

// Phase 2 / Task 4 — `council plan` must FEED the progress reporter at its deliberation milestones
// (proposals → critiques → synthesis). All model calls are injected; a real reporter records phases.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "council-plan-progress-"));
const REQUEST = "Add a --json flag to the report command.";
const HEAD = "abc123def4567890abc123def4567890abc123de";

function seatBackends() {
  return {
    codex: { companionAvailable: true, companion: "companion.mjs" },
    grok: { cli: { available: true }, bin: "grok" },
    claude: { cli: { available: true }, bin: "claude" }
  };
}

function planJson(agent) {
  return JSON.stringify({
    agent,
    summary: `${agent}'s design`,
    approach: "small incremental steps",
    steps: [{ n: 1, title: "step", detail: "do it", files: ["lib/report.mjs"] }],
    risks: [],
    tradeoffs: [],
    effort: "M",
    confidence: 0.8
  });
}

function critiqueBatchJson(critic, abouts) {
  return JSON.stringify({
    agent: critic,
    critiques: abouts.map((about) => ({ about, summary: "ok", scores: { feasibility: 4, risk: 3, simplicity: 4, completeness: 4 }, overall: 7, blockers: [], improvements: [] }))
  });
}

function planSpecJson() {
  return JSON.stringify({
    schemaVersion: 1,
    request: "echoed (ignored)",
    requestHash: "echoed (ignored)",
    baseCommit: "echoed (ignored)",
    steps: [
      {
        id: "add-json-flag",
        title: "Add --json flag",
        intent: "the report command gains a machine-readable mode",
        files: [
          { path: "lib/report.mjs", action: "edit", role: "source", intent: "add the flag" },
          { path: "tests/report-json.test.mjs", action: "create", role: "test", intent: "prove the flag" }
        ],
        test: { files: ["tests/report-json.test.mjs"], intent: "asserts the JSON output shape" },
        dependsOn: []
      }
    ],
    risks: [],
    testStrategy: { perStep: "full", final: "full" }
  });
}

function kindOf(prompt) {
  const p = String(prompt ?? "");
  if (/Round 3 — SYNTHESIS/.test(p)) return "synthesis";
  if (/Round 2 — PEER CRITIQUE/.test(p)) return "critique";
  return "proposal";
}

function recordingDeps(allSeats) {
  const reply = (seat, prompt) => {
    const kind = kindOf(prompt);
    let stdout;
    if (kind === "proposal") stdout = planJson(seat);
    else if (kind === "critique") stdout = critiqueBatchJson(seat, allSeats.filter((s) => s !== seat));
    else stdout = planSpecJson();
    return { status: 0, stdout, stderr: "", skipped: false };
  };
  return {
    head: () => HEAD,
    collectRepoHints: () => "## Files\nlib/report.mjs\n\n## README (head)\n(none)",
    validatePlanSpec: (spec) => (Array.isArray(spec?.steps) && spec.steps.length >= 1 ? { valid: true, errors: [] } : { valid: false, errors: ["no steps"] }),
    runCodex: async (p) => reply("codex", p),
    runGrok: async (p) => reply("grok", p),
    runClaude: async (p) => reply("claude", p)
  };
}

test("runPlanDeliberation drives reporter.phase at each deliberation milestone", async () => {
  const seats = ["codex", "grok", "claude"];
  const phases = [];
  const writes = [];
  const reporter = makeProgressReporter({
    kind: "plan",
    title: "council plan",
    stateDir: "C:/state",
    now: () => "2026-07-13T00:00:00.000Z",
    writeFile: (file, data) => writes.push({ file, data })
  });
  // options.onPhase still fires for the caller — the reporter is threaded ALONGSIDE it, not instead.
  const run = await runPlanDeliberation(TMP, REQUEST, seatBackends(), { reporter, onPhase: (m) => phases.push(m) }, recordingDeps(seats));
  assert.ok(run.planSpec, "a valid synthesis still emits a PlanSpec (reporter is additive)");

  const snap = reporter.snapshot();
  assert.equal(snap.phase, "plan", "the plan phase kind is set");
  assert.match(snap.phaseDetail, /synthesis/, "the final milestone is the synthesis");
  // The caller's own onPhase was preserved (threaded alongside the reporter).
  assert.ok(phases.some((m) => /proposals/.test(m)) && phases.some((m) => /critiques/.test(m)) && phases.some((m) => /synthesis/.test(m)));
  assert.ok(writes.length > 0, "progress.json was persisted through the injected writeFile");
});

test("finding 8: a THROWING onPhase hook never aborts runPlanDeliberation (fail-soft telemetry)", async () => {
  const seats = ["codex", "grok", "claude"];
  let calls = 0;
  const run = await runPlanDeliberation(TMP, REQUEST, seatBackends(), {
    onPhase: () => {
      calls += 1;
      throw new Error("telemetry hook exploded");
    }
  }, recordingDeps(seats));
  assert.ok(run.planSpec, "the deliberation still produced a PlanSpec despite every onPhase throwing");
  assert.ok(calls > 0, "the throwing hook really was invoked (and swallowed, not propagated)");
});

test("runPlanDeliberation without a reporter is unchanged (NOOP fallback)", async () => {
  const seats = ["codex", "grok", "claude"];
  const run = await runPlanDeliberation(TMP, REQUEST, seatBackends(), {}, recordingDeps(seats));
  assert.ok(run.planSpec, "omitting options.reporter falls back to NOOP_REPORTER and changes nothing");
});
