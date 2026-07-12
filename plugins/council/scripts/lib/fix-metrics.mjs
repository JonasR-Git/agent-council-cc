// Rich per-run telemetry for an audit-fix / self-heal run: per-model token usage +
// call counts, which files each seat reviewed, the gate funnel (what reverted where),
// §6 verdict tallies, and per-finding lifecycle. Pure + serializable so a run can be
// persisted and the tool tuned from accumulated data ("which seat catches which bug").

// Rough public list-prices per 1M tokens (input / output), USD. Approximate + volatile —
// shown only as an "≈" estimate, never billed on. Update as pricing changes.
const RATE_PER_MTOK = {
  claude: { in: 5, out: 25 },
  codex: { in: 2.5, out: 10 },
  grok: { in: 3, out: 15 }
};

const SEAT_KEYS = ["claude", "codex", "grok"];

/** Diff two collectAllTokenUsage snapshots into per-model tokens consumed during a run. */
export function tokenDelta(before = {}, after = {}) {
  const out = {};
  for (const seat of SEAT_KEYS) {
    const b = before?.[seat] ?? {};
    const a = after?.[seat] ?? {};
    const d = (k) => Math.max(0, (Number(a[k]) || 0) - (Number(b[k]) || 0));
    out[seat] = {
      inputTokens: d("inputTokens"),
      outputTokens: d("outputTokens"),
      cacheReadTokens: d("cacheReadTokens"),
      cacheCreationTokens: d("cacheCreationTokens"),
      // Grok's session log records ONLY a running totalTokens (no input/output split — token-usage.mjs),
      // so carry the total through: without it a wired Grok seat still reports 0/0 and prices as free.
      totalTokens: d("totalTokens"),
      sessions: d("sessions")
    };
  }
  return out;
}

/** Estimate USD cost from a per-model token delta. Approximate. Prices the built-in CLI seats only:
 *  OpenRouter seats have no local token snapshot (their usage isn't collected into collectAllTokenUsage)
 *  and pricing varies per third-party model, so estUsd covers claude/codex/grok and excludes or-* seats
 *  (council Claude nit). cost.inputTokens/outputTokens still SUM any recorded OR volume for transparency.
 *  NO snapshot at all (null/undefined) returns null — "not measured", NEVER a $0 that reads as "free". */
export function estimateCost(tokens) {
  if (tokens == null) return null;
  let usd = 0;
  for (const seat of SEAT_KEYS) {
    const t = tokens[seat] ?? {};
    const r = RATE_PER_MTOK[seat] ?? { in: 0, out: 0 };
    const inTok = Number(t.inputTokens) || 0;
    const outTok = Number(t.outputTokens) || 0;
    const total = Number(t.totalTokens) || 0;
    // A seat that records only a TOTAL (Grok) would otherwise price at $0 though it burned tokens. Price
    // the total at that seat's INPUT rate: a documented LOWER BOUND (output is dearer), which is honest
    // under-reporting rather than a silent free ride.
    if (!inTok && !outTok && total > 0) usd += (total / 1e6) * r.in;
    else usd += (inTok / 1e6) * r.in + (outTok / 1e6) * r.out;
  }
  return Math.round(usd * 100) / 100;
}

// Map a revert/reject reason to the gate that produced it. Pre-filter reasons (never
// applied) are bucketed under "eligibility" so the funnel separates "gate reverted a
// real attempt" from "never eligible".
const GATE_MATCHERS = [
  [/touched files outside|changed set drifted/i, "touched"],
  [/protected by content|introduced protected content|cannot produce a diff/i, "content"],
  [/export surface changed/i, "snapshot"],
  [/changed lines not executed|coverage/i, "coverage"],
  [/oracle regression/i, "oracle"],
  [/tests (failed|timed out)/i, "test"],
  [/council not unanimous|council review error/i, "council"],
  [/sensitive class|cross-cutting|below severity gate|scope not|unsafe file path|no target file|protected path|file too large/i, "eligibility"]
];

function gateOf(reason) {
  for (const [re, gate] of GATE_MATCHERS) if (re.test(String(reason ?? ""))) return gate;
  return "other";
}

/** Count where fixes reverted, keyed by gate. Pure. */
export function gateFunnel(out) {
  const funnel = { touched: 0, content: 0, snapshot: 0, coverage: 0, oracle: 0, test: 0, council: 0, eligibility: 0, other: 0 };
  for (const r of out?.rejected ?? []) funnel[gateOf(r.reason)] += 1;
  for (const p of out?.proposed ?? []) funnel[gateOf(p.reason)] += 1;
  for (const f of out?.failed ?? []) funnel[gateOf(f.reason)] += 1;
  return funnel;
}

/** Tally §6 verdicts across all council-reviewed findings. Pure. */
export function councilTally(out) {
  const withCouncil = [...(out?.fixed ?? []), ...(out?.rejected ?? []), ...(out?.proposed ?? [])].filter((e) => e.council?.verdicts);
  // Built-ins are ALWAYS present (stable shape); any OpenRouter seat that actually cast a §6 vote is
  // ADDED dynamically (council Codex P2) — an or-* seat can veto the patch, so the persisted report
  // must be able to explain that vote instead of silently dropping every dynamic seat.
  const perSeat = { claude: { confirm: 0, dissent: 0, abstain: 0 }, codex: { confirm: 0, dissent: 0, abstain: 0 }, grok: { confirm: 0, dissent: 0, abstain: 0 } };
  const tally = { reviewed: withCouncil.length, unanimous: 0, dissented: 0, perSeat };
  for (const e of withCouncil) {
    if (e.council.approved) tally.unanimous += 1; else tally.dissented += 1;
    for (const v of e.council.verdicts ?? []) {
      if (!v?.seat) continue;
      if (!perSeat[v.seat]) perSeat[v.seat] = { confirm: 0, dissent: 0, abstain: 0 };
      if (perSeat[v.seat][v.verdict] != null) perSeat[v.seat][v.verdict] += 1;
    }
  }
  return tally;
}

/** Outcome totals. Pure. */
export function outcomeTotals(out) {
  const t = { found: 0, fixed: 0, council: 0, proposed: 0, gated: 0, failed: 0 };
  for (const f of out?.fixed ?? []) { t.found += 1; if (f.council?.approved) t.council += 1; else t.fixed += 1; }
  for (const r of out?.rejected ?? []) { t.found += 1; if (/below severity gate/.test(r.reason ?? "")) t.gated += 1; else t.proposed += 1; }
  for (const p of out?.proposed ?? []) { t.found += 1; t.proposed += 1; }
  for (const s of out?.skipped ?? []) { t.found += 1; t.gated += 1; }
  for (const f of out?.failed ?? []) { t.found += 1; t.failed += 1; }
  return t;
}

/**
 * Derive the per-seat context that a run RESULT already carries honestly: how many findings each seat
 * raised (finding.agents) and how it voted in §6 (council.verdicts) — for EVERY seat that appears,
 * built-in or OpenRouter or-*. Nothing is invented: call COUNTS, durations and files-reviewed live inside
 * the review engine and are NOT derivable from the result, so they stay unset here (0) until the
 * orchestrator instruments them. Pure — the orchestrator needs no extra plumbing to get seat telemetry.
 */
export function seatContextFromResult(out) {
  const seats = {};
  const seat = (name) => (seats[name] ??= { findingsRaised: 0, verdicts: { confirm: 0, dissent: 0, abstain: 0 } });
  const entries = [
    ...(out?.fixed ?? []),
    ...(out?.rejected ?? []),
    ...(out?.proposed ?? []),
    ...(out?.failed ?? []),
    ...(out?.skipped ?? [])
  ];
  for (const e of entries) {
    for (const agent of e?.finding?.agents ?? []) if (agent) seat(String(agent)).findingsRaised += 1;
    for (const v of e?.council?.verdicts ?? []) {
      if (!v?.seat) continue;
      const s = seat(String(v.seat));
      if (s.verdicts[v.verdict] != null) s.verdicts[v.verdict] += 1;
    }
  }
  return seats;
}

/**
 * Assemble the full run-metrics object from a runAuditFix result plus orchestration
 * context (per-seat calls/files/verdicts and token snapshots). Pure + serializable.
 *
 * TOKENS ARE FAIL-CLOSED: a run whose token usage was never snapshotted reports cost.tokensMeasured=false
 * and NULL token/cost figures — "not measured" must never render as "$0 / free" (the report would claim a
 * six-model run was free). A measured snapshot may legitimately be all-zero; that is a different claim.
 */
export function buildRunMetrics(out, ctx = {}) {
  const measured = ctx.tokens != null || (ctx.tokensBefore != null && ctx.tokensAfter != null);
  const tokens = measured ? ctx.tokens ?? tokenDelta(ctx.tokensBefore, ctx.tokensAfter) : null;
  // Seat findings/verdicts are DERIVED from the result (works with zero instrumentation, and covers every
  // or-* seat that voted); anything the orchestrator actually recorded (calls/durationMs/filesReviewed)
  // overrides the derived fields per seat.
  const derived = seatContextFromResult(out);
  const seatCtx = ctx.seats ?? {};
  const seats = {};
  // Built-ins are always emitted (stable shape); any extra seat that raised a finding, cast a §6 vote, or
  // the orchestrator recorded a context for — an OpenRouter or-* seat — is emitted too (council Codex P2),
  // so its calls/verdicts are not dropped.
  const extras = [...new Set([...Object.keys(derived), ...Object.keys(seatCtx)])].filter((k) => !SEAT_KEYS.includes(k));
  const seatList = [...SEAT_KEYS, ...extras];
  for (const seat of seatList) {
    const s = { ...(derived[seat] ?? {}), ...(seatCtx[seat] ?? {}) };
    const tk = tokens?.[seat] ?? {};
    seats[seat] = {
      calls: Number(s.calls) || 0,
      durationMs: Number(s.durationMs) || 0,
      filesReviewed: [...new Set(s.filesReviewed ?? [])],
      findingsRaised: Number(s.findingsRaised) || 0,
      verdicts: s.verdicts ?? { confirm: 0, dissent: 0, abstain: 0 },
      // null = not measured (no snapshot). 0 would be a claim ("used nothing") the run cannot make.
      inputTokens: measured ? Number(tk.inputTokens) || 0 : null,
      outputTokens: measured ? Number(tk.outputTokens) || 0 : null,
      cacheReadTokens: measured ? Number(tk.cacheReadTokens) || 0 : null,
      totalTokens: measured ? Number(tk.totalTokens) || 0 : null
    };
  }
  const sum = (key) => seatList.reduce((n, s) => n + (Number(seats[s][key]) || 0), 0);
  return {
    schemaVersion: 1,
    runId: ctx.runId ?? out?.branch ?? null,
    branch: out?.branch ?? null,
    baseBranch: out?.baseBranch ?? null,
    startedAt: ctx.startedAt ?? null,
    finishedAt: ctx.finishedAt ?? null,
    wallClockMs: Number(ctx.wallClockMs) || null,
    autonomy: ctx.autonomy ?? null,
    sensitiveAutoApply: Boolean(ctx.sensitiveAutoApply),
    totals: outcomeTotals(out),
    seats,
    gates: gateFunnel(out),
    council: councilTally(out),
    cost: {
      // The honesty flag every consumer must check before printing a "$" figure.
      tokensMeasured: measured,
      inputTokens: measured ? sum("inputTokens") : null,
      outputTokens: measured ? sum("outputTokens") : null,
      totalTokens: measured ? sum("totalTokens") : null,
      estUsd: estimateCost(tokens)
    }
  };
}
