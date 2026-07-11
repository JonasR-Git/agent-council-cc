import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRunMetrics,
  councilTally,
  estimateCost,
  gateFunnel,
  outcomeTotals,
  tokenDelta
} from "../plugins/council/scripts/lib/fix-metrics.mjs";

const out = () => ({
  branch: "council/audit-fix-x",
  baseBranch: "master",
  fixed: [
    { finding: { severity: "P1", category: "bug", file: "a.mjs" }, file: "a.mjs", commit: "c1", verified: true },
    { finding: { severity: "P1", category: "concurrency", file: "b.mjs" }, file: "b.mjs", commit: "c2", verified: true, council: { approved: true, verdicts: [{ seat: "claude", verdict: "confirm" }, { seat: "codex", verdict: "confirm" }, { seat: "grok", verdict: "confirm" }] } }
  ],
  rejected: [
    { finding: { severity: "P1", category: "concurrency", file: "b.mjs" }, reason: "§6 council not unanimous (dissent: grok)", council: { approved: false, verdicts: [{ seat: "claude", verdict: "confirm" }, { seat: "codex", verdict: "confirm" }, { seat: "grok", verdict: "dissent" }] } },
    { finding: { severity: "P2", category: "design", file: "c.mjs" }, reason: "cross-cutting → propose-only (never auto-patched)" },
    { finding: { severity: "nit", category: "style", file: "c.mjs" }, reason: "below severity gate (nit)" }
  ],
  failed: [{ finding: { severity: "P2", category: "bug", file: "d.mjs" }, reason: "tests failed after fix" }]
});

test("tokenDelta diffs two usage snapshots, clamping negatives to zero", () => {
  const d = tokenDelta(
    { claude: { inputTokens: 100, outputTokens: 10 }, codex: { inputTokens: 5 } },
    { claude: { inputTokens: 350, outputTokens: 40 }, codex: { inputTokens: 5 } }
  );
  assert.equal(d.claude.inputTokens, 250);
  assert.equal(d.claude.outputTokens, 30);
  assert.equal(d.codex.inputTokens, 0);
  assert.equal(d.grok.inputTokens, 0); // absent seat → zero, never NaN
});

test("estimateCost is monotonic in tokens and zero at zero", () => {
  assert.equal(estimateCost({}), 0);
  const a = estimateCost({ claude: { inputTokens: 1e6, outputTokens: 0 } });
  const b = estimateCost({ claude: { inputTokens: 2e6, outputTokens: 0 } });
  assert.ok(b > a && a > 0);
});

test("gateFunnel buckets revert/reject reasons by gate", () => {
  const f = gateFunnel(out());
  assert.equal(f.council, 1);     // "council not unanimous"
  assert.equal(f.eligibility, 2); // cross-cutting + below-severity
  assert.equal(f.test, 1);        // failed: tests failed
});

test("councilTally counts unanimity, dissent, and per-seat verdicts", () => {
  const c = councilTally(out());
  assert.equal(c.reviewed, 2);
  assert.equal(c.unanimous, 1);
  assert.equal(c.dissented, 1);
  assert.equal(c.perSeat.grok.dissent, 1);
  assert.equal(c.perSeat.claude.confirm, 2);
});

test("outcomeTotals separates fixed / council / proposed / gated / failed", () => {
  const t = outcomeTotals(out());
  assert.equal(t.found, 6);
  assert.equal(t.fixed, 1);
  assert.equal(t.council, 1);
  assert.equal(t.proposed, 2); // council-dissent + cross-cutting
  assert.equal(t.gated, 1);    // below-severity nit
  assert.equal(t.failed, 1);
});

test("buildRunMetrics assembles a serializable record with seats, gates, council, cost", () => {
  const m = buildRunMetrics(out(), {
    runId: "r1",
    autonomy: "§6 council-gated",
    sensitiveAutoApply: true,
    wallClockMs: 123000,
    tokens: { claude: { inputTokens: 1000, outputTokens: 200 }, codex: { inputTokens: 500, outputTokens: 100 }, grok: { inputTokens: 400, outputTokens: 80 } },
    seats: {
      claude: { calls: 3, filesReviewed: ["a.mjs", "b.mjs"], verdicts: { confirm: 2, dissent: 0 }, findingsRaised: 5, durationMs: 60000 },
      codex: { calls: 2, filesReviewed: ["b.mjs"], verdicts: { confirm: 2, dissent: 0 }, findingsRaised: 3, durationMs: 40000 },
      grok: { calls: 2, filesReviewed: ["b.mjs"], verdicts: { confirm: 1, dissent: 1 }, findingsRaised: 4, durationMs: 45000 }
    }
  });
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.seats.claude.calls, 3);
  assert.equal(m.seats.claude.inputTokens, 1000);
  assert.deepEqual(m.seats.claude.filesReviewed, ["a.mjs", "b.mjs"]);
  assert.equal(m.council.unanimous, 1);
  assert.equal(m.cost.inputTokens, 1900);
  assert.ok(m.cost.estUsd > 0);
  assert.doesNotThrow(() => JSON.stringify(m), "metrics must be serializable");
});
