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
    const b = before[seat] ?? {};
    const a = after[seat] ?? {};
    const d = (k) => Math.max(0, (Number(a[k]) || 0) - (Number(b[k]) || 0));
    out[seat] = {
      inputTokens: d("inputTokens"),
      outputTokens: d("outputTokens"),
      cacheReadTokens: d("cacheReadTokens"),
      cacheCreationTokens: d("cacheCreationTokens"),
      sessions: d("sessions")
    };
  }
  return out;
}

/** Estimate USD cost from a per-model token delta. Approximate. Prices the built-in CLI seats only:
 *  OpenRouter seats have no local token snapshot (their usage isn't collected into collectAllTokenUsage)
 *  and pricing varies per third-party model, so estUsd covers claude/codex/grok and excludes or-* seats
 *  (council Claude nit). cost.inputTokens/outputTokens still SUM any recorded OR volume for transparency. */
export function estimateCost(tokens = {}) {
  let usd = 0;
  for (const seat of SEAT_KEYS) {
    const t = tokens[seat] ?? {};
    const r = RATE_PER_MTOK[seat] ?? { in: 0, out: 0 };
    usd += ((Number(t.inputTokens) || 0) / 1e6) * r.in + ((Number(t.outputTokens) || 0) / 1e6) * r.out;
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
 * Assemble the full run-metrics object from a runAuditFix result plus orchestration
 * context (per-seat calls/files/verdicts and token snapshots). Pure + serializable.
 */
export function buildRunMetrics(out, ctx = {}) {
  const tokens = ctx.tokens ?? (ctx.tokensBefore && ctx.tokensAfter ? tokenDelta(ctx.tokensBefore, ctx.tokensAfter) : {});
  const seatCtx = ctx.seats ?? {};
  const seats = {};
  // Built-ins are always emitted (stable shape); any extra seat the orchestrator recorded a context for
  // — an OpenRouter or-* seat — is emitted too (council Codex P2), so its calls/verdicts are not dropped.
  const seatList = [...SEAT_KEYS, ...Object.keys(seatCtx).filter((k) => !SEAT_KEYS.includes(k))];
  for (const seat of seatList) {
    const s = seatCtx[seat] ?? {};
    const tk = tokens[seat] ?? {};
    seats[seat] = {
      calls: Number(s.calls) || 0,
      durationMs: Number(s.durationMs) || 0,
      filesReviewed: [...new Set(s.filesReviewed ?? [])],
      findingsRaised: Number(s.findingsRaised) || 0,
      verdicts: s.verdicts ?? { confirm: 0, dissent: 0, abstain: 0 },
      inputTokens: Number(tk.inputTokens) || 0,
      outputTokens: Number(tk.outputTokens) || 0,
      cacheReadTokens: Number(tk.cacheReadTokens) || 0
    };
  }
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
      inputTokens: seatList.reduce((n, s) => n + seats[s].inputTokens, 0),
      outputTokens: seatList.reduce((n, s) => n + seats[s].outputTokens, 0),
      estUsd: estimateCost(tokens)
    }
  };
}
