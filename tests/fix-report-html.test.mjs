import assert from "node:assert/strict";
import test from "node:test";

import { fixReportRows, fixReportStats, renderFixReportHtml } from "../plugins/council/scripts/lib/fix-report-html.mjs";

const sampleOut = () => ({
  ok: true,
  branch: "council/audit-fix-abc1234",
  baseBranch: "master",
  ledgerResolved: 2,
  fixed: [
    { finding: { severity: "P1", category: "bug", title: "--wait no-op", file: "a/council-companion.mjs" }, file: "a/council-companion.mjs", commit: "deadbeef", verified: true },
    { finding: { severity: "P1", category: "concurrency", title: "race in lock", file: "b/state.mjs" }, file: "b/state.mjs", commit: "cafef00d", verified: true, council: { approved: true, summary: "3/3 confirm", verdicts: [{ seat: "claude", verdict: "confirm" }, { seat: "codex", verdict: "confirm" }, { seat: "grok", verdict: "confirm" }] } }
  ],
  rejected: [
    { finding: { severity: "P1", category: "concurrency", title: "steals live lock", file: "b/state.mjs" }, reason: "§6 council not unanimous (dissent: grok) → propose-only", council: { approved: false, summary: "dissent: grok", verdicts: [{ seat: "claude", verdict: "confirm" }, { seat: "codex", verdict: "confirm" }, { seat: "grok", verdict: "dissent" }] } },
    { finding: { severity: "P2", category: "design", title: "cross-cutting dup", file: "c/x.mjs" }, reason: "cross-cutting → propose-only (never auto-patched)" },
    { finding: { severity: "nit", category: "style", title: "unused import", file: "c/x.mjs" }, reason: "below severity gate (nit)" }
  ],
  failed: [
    { finding: { severity: "P2", category: "bug", title: "broke tests", file: "d/y.mjs" }, file: "d/y.mjs", reason: "tests failed after fix" }
  ],
  skipped: []
});

test("fixReportRows classifies every outcome kind", () => {
  const rows = fixReportRows(sampleOut());
  const byTitle = Object.fromEntries(rows.map((r) => [r.finding.title, r.status.key]));
  assert.equal(byTitle["--wait no-op"], "fixed");
  assert.equal(byTitle["race in lock"], "council");
  assert.equal(byTitle["steals live lock"], "no-consensus");
  assert.equal(byTitle["cross-cutting dup"], "proposed");
  assert.equal(byTitle["unused import"], "gate");
  assert.equal(byTitle["broke tests"], "failed");
});

test("fixReportRows sorts by severity (P0<P1<P2<nit)", () => {
  const rows = fixReportRows(sampleOut());
  const sevs = rows.map((r) => r.finding.severity);
  const rank = { P0: 0, P1: 1, P2: 2, nit: 3 };
  for (let i = 1; i < sevs.length; i++) assert.ok(rank[sevs[i - 1]] <= rank[sevs[i]], "non-decreasing severity");
});

test("fixReportStats aggregates outcome buckets", () => {
  const s = fixReportStats(fixReportRows(sampleOut()));
  assert.equal(s.total, 6);
  assert.equal(s.fixed, 1);
  assert.equal(s.council, 1);
  assert.equal(s.proposed, 2); // no-consensus + cross-cutting
  assert.equal(s.gated, 1);    // below-severity nit
  assert.equal(s.failed, 1);
});

test("renderFixReportHtml is self-contained, escapes content, shows pills + council verdicts", () => {
  const html = renderFixReportHtml(sampleOut(), { seats: "Claude · Codex · Grok", sensitiveAutoApply: true });
  assert.match(html, /^<!doctype html>/);
  assert.ok(!/src=|href=|@import/.test(html), "no external asset references");
  assert.match(html, /council\/audit-fix-abc1234/);
  assert.match(html, /pill council/);   // §6 applied
  assert.match(html, /pill proposed/);  // dissent → proposed
  assert.match(html, /§6 council/);      // the gate + section
  assert.match(html, /dissent/);         // the grok verdict rendered
});

test("renderFixReportHtml escapes a malicious finding title", () => {
  const out = { branch: "b", baseBranch: "master", fixed: [], rejected: [{ finding: { severity: "P2", title: "<script>alert(1)</script>", file: "x.mjs" }, reason: "cross-cutting → propose-only" }], failed: [], skipped: [] };
  const html = renderFixReportHtml(out);
  assert.ok(!html.includes("<script>alert(1)</script>"), "raw script not embedded");
  assert.match(html, /&lt;script&gt;/);
});

test("renderFixReportHtml injects the telemetry section when meta.metrics is present", () => {
  const metrics = {
    seats: {
      claude: { calls: 3, inputTokens: 1200, outputTokens: 300, durationMs: 60000, filesReviewed: ["a.mjs"], findingsRaised: 4, verdicts: { confirm: 2, dissent: 0 } },
      codex: { calls: 2, inputTokens: 800, outputTokens: 150, durationMs: 40000, filesReviewed: ["b.mjs"], findingsRaised: 3, verdicts: { confirm: 2, dissent: 0 } },
      grok: { calls: 2, inputTokens: 600, outputTokens: 120, durationMs: 45000, filesReviewed: ["b.mjs"], findingsRaised: 2, verdicts: { confirm: 1, dissent: 1 } }
    },
    gates: { council: 1, test: 1, eligibility: 2, touched: 0, content: 0, snapshot: 0, coverage: 0, oracle: 0, other: 0 },
    council: { reviewed: 2, unanimous: 1, dissented: 1 },
    cost: { inputTokens: 2600, outputTokens: 570, estUsd: 0.03 },
    wallClockMs: 145000
  };
  const html = renderFixReportHtml(sampleOut(), { metrics });
  assert.match(html, /Telemetrie/);
  assert.match(html, /Gate-Funnel/);
  assert.match(html, /§6-Konsens/);
  assert.match(html, /Claude/);
  // no telemetry section when metrics absent
  assert.ok(!/Telemetrie/.test(renderFixReportHtml(sampleOut(), {})));
});

test("renderFixReportHtml renders a RED integration run distinctly", () => {
  const out = { ...sampleOut(), ok: false, integrationFailed: true };
  const html = renderFixReportHtml(out);
  assert.match(html, /verdict-line red/);
  assert.match(html, /Integrationslauf ROT|rot/);
});
