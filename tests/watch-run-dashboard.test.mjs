import test from "node:test";
import assert from "node:assert/strict";

import { renderRunDashboard } from "../plugins/council/scripts/lib/watch.mjs";

const fullState = () => ({
  schemaVersion: 1,
  kind: "audit-fix-loop",
  jobId: "job-1",
  title: "audit fix --loop",
  startedAt: "2026-07-13T00:00:00Z",
  updatedAt: "2026-07-13T00:05:00Z",
  phase: "fix",
  phaseDetail: "pass 2",
  seats: [
    { name: "codex", state: "reviewing", raised: 4 },
    { name: "grok", state: "done", raised: 2 },
    { name: "claude", state: "voting", raised: 1 },
    { name: "or-deepseek", state: "reviewing", raised: 0 }
  ],
  progress: { passesDone: 2, passesTotal: 8 },
  counters: { fixed: 3, proposed: 5, committed: 2 },
  findingsByLens: {
    correctness: { total: 3, P0: 1, P1: 2, P2: 0, nit: 0 },
    architecture_ssot: { total: 2, P0: 0, P1: 0, P2: 1, nit: 1 }
  },
  gate: { name: "§6", target: "patch", state: "pass" },
  recentLines: ["reviewing cell 3/12", "pass 2: fixed 1"],
  done: false
});

const fullUsage = () => ({
  claude: { available: true, weekPercent: 1, fiveHourPercent: 6, weekResetsAt: null, tokens: { out: 250, in: 1000, total: 45000 } },
  codex: { available: true, weekPercent: 14, weekResetsAt: null, tokens: { out: 1, in: 2, total: 1200000 } },
  grok: { available: true, weekPercent: 11, weekResetsAt: null, tokens: { total: 700 } }
});

const CEILING = { claude: 40, codex: 50, grok: 40 };

test("renderRunDashboard: full state+usage+ceiling → seat quota/token/ceiling table, lens table, ceiling OK", () => {
  const md = renderRunDashboard(fullState(), { usage: fullUsage(), ceiling: CEILING, nowMs: Date.parse("2026-07-13T00:05:00Z") });
  // Header (h2) with the pretty kind label + a status line carrying the pass counter.
  assert.match(md, /## 🟡 Audit Fix · Loop/);
  assert.match(md, /Pass 2\/8/);
  // The quota-aware seat table header (polished labels).
  assert.match(md, /\| Seat \| raised \| week \| 5h \| tokens \| vs ceiling \|/);
  // Codex row: weekly quota 14%, compact tokens 1.2M, ceiling bar `.../14/50`.
  assert.match(md, /codex .*14%.*1\.2M/);
  assert.match(md, /14\/50/);
  // Claude row shows BOTH weekly (1%) and 5h (6%), tokens 45k.
  assert.match(md, /claude .*1%.*6%.*45k/);
  // Grok weekly 11%, ceiling bar over 40.
  assert.match(md, /grok .*11%/);
  assert.match(md, /11\/40/);
  // An unknown/OpenRouter seat has no provider quota → all dashes.
  assert.match(md, /or-deepseek \| 0 \| – \| – \| – \| – \|/);
  // Findings block: severity-emoji headers (🟥 present because correctness has a P0); Σ is bold.
  assert.match(md, /\*\*Findings · 5\*\*/);
  assert.match(md, /\| Lens \| 🟥 \| 🟧 \| 🟨 \| ▫️ \| Σ \|/);
  assert.match(md, /architecture_ssot \| · \| · \| 1 \| 1 \| \*\*2\*\* \|/);
  assert.match(md, /correctness \| 1 \| 2 \| · \| · \| \*\*3\*\* \|/);
  // Applied counters (emoji) + gate + ceiling OK status.
  assert.match(md, /\*\*Applied\*\* ✅ 3 · 📋 5 · 📦 2/);
  assert.match(md, /\*\*Gate\*\* .*§6/);
  assert.match(md, /\*\*Ceiling\*\* 40\/50\/40 ✓/);
  // Honest footer while running.
  assert.match(md, /_live über fertige Einheiten · kein Token-Streaming_/);
});

test("renderRunDashboard: a breach shows the ⛔ ceiling line with model/percent/ceiling", () => {
  const usage = fullUsage();
  usage.codex = { available: true, weekPercent: 88, weekResetsAt: null, tokens: { total: 5 } };
  const md = renderRunDashboard(fullState(), { usage, ceiling: CEILING });
  assert.match(md, /⛔ \*\*Ceiling\*\* 40\/50\/40 —/);
  assert.match(md, /codex 88%≥50% \(weekly\)/);
  assert.ok(!/\*\*Ceiling\*\* 40\/50\/40 ✓/.test(md), "a breach never also prints the OK line");
});

test("renderRunDashboard: claude 5h breach is surfaced on the ceiling line", () => {
  const usage = fullUsage();
  usage.claude = { available: true, weekPercent: 2, fiveHourPercent: 55, weekResetsAt: null, tokens: { total: 10 } };
  const md = renderRunDashboard(fullState(), { usage, ceiling: CEILING });
  assert.match(md, /⛔ \*\*Ceiling\*\*/);
  assert.match(md, /claude 55%≥40% \(5h\)/);
});

test("renderRunDashboard: null usage degrades to the plain box (no quota columns)", () => {
  const plain = renderRunDashboard(fullState(), { usage: null, ceiling: CEILING, nowMs: Date.parse("2026-07-13T00:05:00Z") });
  assert.ok(!/Quota wk/.test(plain), "no usage → the quota columns are absent");
  assert.ok(!/Tokens \(run\)/.test(plain), "no usage → no per-seat token column");
  // It still renders the plain kind-agnostic seat table.
  assert.match(plain, /\| Seat \| State \| Units \| Raised \|/);
});

test("renderRunDashboard: an unavailable model shows dashes and never breaches", () => {
  const usage = fullUsage();
  usage.codex = { available: false, weekPercent: 99, tokens: { total: 0 } };
  const md = renderRunDashboard(fullState(), { usage, ceiling: CEILING });
  // codex row quota/ceiling are dashes despite the stray 99%.
  assert.match(md, /codex \| 4 \| – \| – \| 0 \| – \|/);
  assert.match(md, /\*\*Ceiling\*\* 40\/50\/40 ✓/, "unavailable usage is never a breach");
});

test("renderRunDashboard: never throws on garbage input", () => {
  assert.doesNotThrow(() => renderRunDashboard(null, {}));
  assert.doesNotThrow(() => renderRunDashboard(undefined, { usage: "nope", ceiling: 5 }));
  assert.doesNotThrow(() => renderRunDashboard({ seats: "bad", findingsByLens: 42, counters: null }, { usage: { claude: "x" }, ceiling: { claude: NaN } }));
  const s = renderRunDashboard({ kind: "x", seats: [{ name: "codex", state: "idle" }] }, { usage: { codex: { available: true, weekPercent: 5, tokens: {} } }, ceiling: { codex: 50 } });
  assert.equal(typeof s, "string");
  assert.match(s, /codex/);
});

test("renderRunDashboard: a prior snapshot yields a Δ line (pass + counter moves)", () => {
  const prior = { ...fullState(), progress: { passesDone: 1, passesTotal: 8 }, counters: { fixed: 1, proposed: 5, committed: 1 } };
  const md = renderRunDashboard(fullState(), { usage: fullUsage(), ceiling: CEILING, prior });
  assert.match(md, /Δ seit letztem Update/);
  assert.match(md, /Pass 1→2/);
  assert.match(md, /\+2 fixed/);
});
