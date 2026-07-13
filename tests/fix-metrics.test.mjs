import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRunMetrics,
  councilTally,
  estimateCost,
  gateFunnel,
  outcomeTotals,
  seatContextFromResult,
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

test("P2: gateFunnel reads the fix-LOOP's flat rejectedReason field (not just .reason)", () => {
  // runFixLoop's `proposed` entries are flat ({...finding, rejectedReason}), never {finding, reason}.
  // Before the fix, gateOf(p.reason) === gateOf(undefined) === "other" for every one of them.
  const loopOut = {
    proposed: [
      { file: "a.mjs", title: "x", rejectedReason: "changed lines not executed by any test (2 uncovered) → propose-only" },
      { file: "b.mjs", title: "y", rejectedReason: "touched files outside target: c.mjs → propose-only" },
      { file: "c.mjs", title: "z", rejectedReason: "§6 council not unanimous (dissent: grok) → propose-only" }
    ]
  };
  const f = gateFunnel(loopOut);
  assert.equal(f.coverage, 1);
  assert.equal(f.touched, 1);
  assert.equal(f.council, 1);
  assert.equal(f.other, 0, "none of the three fall through to the catch-all bucket");
});

test("councilTally counts unanimity, dissent, and per-seat verdicts", () => {
  const c = councilTally(out());
  assert.equal(c.reviewed, 2);
  assert.equal(c.unanimous, 1);
  assert.equal(c.dissented, 1);
  assert.equal(c.perSeat.grok.dissent, 1);
  assert.equal(c.perSeat.claude.confirm, 2);
});

test("councilTally records an OpenRouter seat's veto dynamically (built-ins stay present)", () => {
  const withOr = {
    rejected: [
      { finding: { severity: "P1" }, reason: "§6 council not unanimous (dissent: or-gpt)", council: { approved: false, verdicts: [{ seat: "claude", verdict: "confirm" }, { seat: "codex", verdict: "confirm" }, { seat: "grok", verdict: "confirm" }, { seat: "or-gpt", verdict: "dissent" }] } }
    ]
  };
  const c = councilTally(withOr);
  assert.equal(c.dissented, 1);
  assert.equal(c.perSeat["or-gpt"].dissent, 1, "the OpenRouter seat's veto is recorded, not dropped");
  assert.ok(c.perSeat.claude && c.perSeat.codex && c.perSeat.grok, "built-in seats always present");
});

test("buildRunMetrics emits an OpenRouter seat when the orchestrator recorded a context for it", () => {
  const m = buildRunMetrics({ fixed: [] }, {
    seats: {
      claude: { calls: 1 }, codex: { calls: 1 }, grok: { calls: 1 },
      "or-gpt": { calls: 2, findingsRaised: 3, verdicts: { confirm: 1, dissent: 1, abstain: 0 } }
    }
  });
  assert.equal(m.seats["or-gpt"].calls, 2, "the dynamic seat is emitted");
  assert.equal(m.seats["or-gpt"].findingsRaised, 3);
  assert.ok(m.seats.claude && m.seats.codex && m.seats.grok, "built-ins still present");
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

// A12 — the telemetry was BUILT but never fed: both computeFixReportMeta call sites passed no token
// snapshot, so every report rendered "0 tokens / $0.00" for a six-model run. An UNMEASURED run must be
// reported as unmeasured (fail-closed), and a WIRED before/after pair must actually produce the numbers.

test("estimateCost: no snapshot at all is null (unknown), an empty-but-real snapshot is 0", () => {
  assert.equal(estimateCost(null), null, "never measured → unknown, not free");
  assert.equal(estimateCost(undefined), null);
  assert.equal(estimateCost({}), 0, "a measured snapshot with no volume genuinely costs 0");
});

test("buildRunMetrics: a MISSING token snapshot is reported as unmeasured, never as $0", () => {
  const m = buildRunMetrics(out(), { wallClockMs: 1000, autonomy: "aggressive" });
  assert.equal(m.cost.tokensMeasured, false, "the report must be able to say 'not measured'");
  assert.equal(m.cost.estUsd, null, "$0 would claim the six-model run was free");
  assert.equal(m.cost.inputTokens, null);
  assert.equal(m.cost.outputTokens, null);
  assert.equal(m.seats.claude.inputTokens, null, "per-seat tokens are unknown, not zero");
  assert.equal(m.seats.grok.outputTokens, null);
  assert.doesNotThrow(() => JSON.stringify(m), "unmeasured metrics stay serializable");
});

test("buildRunMetrics: a measured all-zero snapshot IS $0 (distinct claim from 'not measured')", () => {
  const empty = { claude: {}, codex: {}, grok: {} };
  const m = buildRunMetrics(out(), { tokensBefore: empty, tokensAfter: empty });
  assert.equal(m.cost.tokensMeasured, true);
  assert.equal(m.cost.estUsd, 0, "measured zero volume → 0, not null");
  assert.equal(m.seats.claude.inputTokens, 0);
});

test("buildRunMetrics: a tokensBefore/tokensAfter pair (the wired call site) diffs into per-seat tokens + cost", () => {
  const m = buildRunMetrics(out(), {
    tokensBefore: { claude: { inputTokens: 1_000, outputTokens: 100 }, codex: { inputTokens: 10, outputTokens: 5 }, grok: { totalTokens: 500 } },
    tokensAfter: { claude: { inputTokens: 1_000_000, outputTokens: 200_100 }, codex: { inputTokens: 500_010, outputTokens: 100_005 }, grok: { totalTokens: 300_500 } }
  });
  assert.equal(m.cost.tokensMeasured, true);
  assert.equal(m.seats.claude.inputTokens, 999_000, "only what THIS run consumed (after − before)");
  assert.equal(m.seats.claude.outputTokens, 200_000);
  assert.equal(m.seats.codex.inputTokens, 500_000);
  assert.equal(m.cost.inputTokens, 1_499_000);
  assert.ok(m.cost.estUsd > 0, "a wired run reports a real ≈cost");
});

test("buildRunMetrics: a Grok delta with only totalTokens is priced, not billed as free", () => {
  const m = buildRunMetrics({ fixed: [] }, {
    tokensBefore: { grok: { totalTokens: 0 } },
    tokensAfter: { grok: { totalTokens: 2_000_000 } }
  });
  assert.equal(m.seats.grok.totalTokens, 2_000_000, "Grok's CLI log has no in/out split — keep the total");
  assert.ok(m.cost.estUsd > 0, "a seat that only reports a total must still cost something");
});

test("seatContextFromResult derives per-seat findings + §6 verdicts from the run result (incl. or-* seats)", () => {
  const ctx = seatContextFromResult({
    fixed: [{ finding: { agents: ["claude", "or-gpt"] } }],
    rejected: [
      {
        finding: { agents: ["grok"] },
        reason: "§6 council not unanimous (dissent: or-gpt)",
        council: { approved: false, verdicts: [{ seat: "claude", verdict: "confirm" }, { seat: "or-gpt", verdict: "dissent" }] }
      }
    ]
  });
  assert.equal(ctx.claude.findingsRaised, 1);
  assert.equal(ctx.grok.findingsRaised, 1);
  assert.equal(ctx["or-gpt"].findingsRaised, 1, "an OpenRouter seat's finding is attributed to it");
  assert.equal(ctx.claude.verdicts.confirm, 1);
  assert.equal(ctx["or-gpt"].verdicts.dissent, 1);
});

test("buildRunMetrics renders seat verdicts/findings WITHOUT orchestrator instrumentation (derived from `out`)", () => {
  const m = buildRunMetrics(out(), { wallClockMs: 1 });
  assert.equal(m.seats.claude.verdicts.confirm, 2, "the §6 votes in the result are attributed per seat");
  assert.equal(m.seats.grok.verdicts.dissent, 1, "grok's veto shows up without a ctx.seats map");
  assert.equal(m.seats.codex.calls, 0, "call counts are NOT invented — they stay 0 until instrumented");
});

test("buildRunMetrics: an explicit ctx.seats entry overrides the derived fields, keeping the rest", () => {
  const m = buildRunMetrics(out(), { seats: { claude: { calls: 7, durationMs: 1234 } } });
  assert.equal(m.seats.claude.calls, 7, "instrumented calls win");
  assert.equal(m.seats.claude.durationMs, 1234);
  assert.equal(m.seats.claude.verdicts.confirm, 2, "derived verdicts survive a partial ctx.seats entry");
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
