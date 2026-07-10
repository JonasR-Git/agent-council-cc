import path from "node:path";

import { appendJsonlCapped, readJsonl } from "./jsonl.mjs";
import { resolveStateDir } from "./state.mjs";
import { median } from "./stats.mjs";

/**
 * Persisted per-job metrics history: one JSONL line per finished job, appended
 * under the workspace state dir. Aggregated by the `metrics` subcommand.
 */
function metricsFile(cwd) {
  return path.join(resolveStateDir(cwd), "metrics.jsonl");
}

const MAX_METRICS_LINES = 2000;

/**
 * Per-major-phase wall-clock (ms) from a timestamped phase timeline. The duration
 * of a phase is the gap to the next timeline entry (or `endMs` for the last). Phase
 * names are normalized to their major (before ":"/space/"("; "-done" merged), so
 * "r1", "r1: grok done", "r1-done" all accrue to "r1". Pure; null when unusable.
 */
export function phaseDurations(timeline, endMs) {
  if (!Array.isArray(timeline) || !timeline.length) return null;
  const major = (p) => (String(p ?? "").split(/[:\s(]/)[0].replace(/-done$/, "") || "other");
  const out = {};
  for (let i = 0; i < timeline.length; i += 1) {
    const start = Number(timeline[i].atMs);
    const next = i + 1 < timeline.length ? Number(timeline[i + 1].atMs) : Number(endMs);
    if (!Number.isFinite(start) || !Number.isFinite(next) || next < start) continue;
    const m = major(timeline[i].phase);
    out[m] = (out[m] ?? 0) + (next - start);
  }
  return Object.keys(out).length ? out : null;
}

/** The decision-relevant outcome of a review (or null if the job carries none). */
function reviewSummary(job) {
  const d = job.deliberation;
  if (!d) return null;
  const all = Array.isArray(d.merged?.all) ? d.merged.all : [];
  const bySeverity = { P0: 0, P1: 0, P2: 0, nit: 0 };
  let consensus = 0;
  let contested = 0;
  for (const f of all) {
    bySeverity[f.severity in bySeverity ? f.severity : "nit"] += 1;
    if (f.consensus) consensus += 1;
    if (f.contested) contested += 1;
  }
  const verdicts = {};
  for (const v of d.verdicts ?? []) if (v?.agent) verdicts[v.agent] = v.verdict;
  return {
    findings: all.length,
    mustFix: bySeverity.P0 + bySeverity.P1,
    consensus,
    contested,
    bySeverity,
    verdicts,
    verify: d.verification ? { verified: d.verification.verifiedCount, refuted: d.verification.refutedCount } : null,
    parseFailures: Number.isFinite(Number(d.parseFailures)) ? Number(d.parseFailures) : null
  };
}

export function recordJobMetrics(cwd, job) {
  const agents = (job.results ?? [])
    .filter((r) => r && !r.skipped && r.agent)
    .map((r) => ({
      agent: r.agent,
      role: r.role ?? r.aboutAgent ?? "r1",
      status: r.status ?? null,
      durationMs: Number.isFinite(Number(r.durationMs)) ? Number(r.durationMs) : null,
      timedOut: Boolean(r.timedOut),
      retryAttempts: Number.isFinite(Number(r.retryAttempts)) ? Number(r.retryAttempts) : null
    }));
  const wallClockMs = Date.parse(job.finishedAt ?? "") - Date.parse(job.createdAt ?? "");
  const entry = {
    id: job.id,
    kind: job.kind,
    status: job.status,
    finishedAt: job.finishedAt ?? null,
    createdAt: job.createdAt ?? null,
    wallClockMs: Number.isFinite(wallClockMs) ? wallClockMs : null,
    agents,
    review: reviewSummary(job),
    phases: phaseDurations(job.phaseTimeline, Date.parse(job.finishedAt ?? ""))
  };
  try {
    appendJsonlCapped(metricsFile(cwd), entry, MAX_METRICS_LINES);
  } catch {
    /* metrics are best-effort; never break a run */
  }
  return entry;
}

/**
 * Record a synchronous audit run (review / fix / endless) — these are not
 * background jobs, so they never reach recordJobMetrics. `extra` carries the
 * run-shaped fields (coverage, fixed/failed counts, passes). Best-effort.
 */
export function recordAuditMetrics(cwd, kind, extra = {}, nowIsoStr = null) {
  const entry = { id: `audit-${kind}`, kind: `audit-${kind}`, status: "completed", finishedAt: nowIsoStr, createdAt: nowIsoStr, wallClockMs: extra.wallClockMs ?? null, agents: [], audit: extra };
  try {
    appendJsonlCapped(metricsFile(cwd), entry, MAX_METRICS_LINES);
  } catch {
    /* best-effort */
  }
  return entry;
}

export function readMetrics(cwd, sinceMs = 0) {
  const entries = [];
  for (const entry of readJsonl(metricsFile(cwd))) {
    const at = Date.parse(entry.finishedAt ?? entry.createdAt ?? "");
    if (!sinceMs || (Number.isFinite(at) && at >= sinceMs)) entries.push(entry);
  }
  return entries;
}

const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);

export function aggregateMetrics(entries) {
  const byKind = {};
  const byAgent = {};
  const review = { runs: 0, findings: [], mustFix: [], consensus: 0, contested: 0, parseFailures: 0, verified: 0, refuted: 0 };
  const phaseMs = {};
  const audit = {};
  for (const entry of entries) {
    for (const [p, ms] of Object.entries(entry.phases ?? {})) {
      if (Number.isFinite(Number(ms))) (phaseMs[p] = phaseMs[p] ?? []).push(Number(ms));
    }
    if (entry.audit) {
      const a = (audit[entry.kind] = audit[entry.kind] ?? { runs: 0, sums: {} });
      a.runs += 1;
      for (const [k, v] of Object.entries(entry.audit)) if (Number.isFinite(Number(v))) a.sums[k] = (a.sums[k] ?? 0) + Number(v);
    }
    const kind = (byKind[entry.kind] = byKind[entry.kind] ?? { jobs: 0, wallClockMs: [] });
    kind.jobs += 1;
    if (Number.isFinite(Number(entry.wallClockMs))) kind.wallClockMs.push(Number(entry.wallClockMs));
    for (const a of entry.agents ?? []) {
      const stats = (byAgent[a.agent] = byAgent[a.agent] ?? { calls: 0, failures: 0, timeouts: 0, retries: 0, durationsMs: [] });
      stats.calls += 1;
      if (a.status !== 0 && a.status != null) stats.failures += 1;
      if (a.timedOut) stats.timeouts += 1;
      if (Number.isFinite(Number(a.retryAttempts)) && a.retryAttempts > 1) stats.retries += a.retryAttempts - 1;
      if (Number.isFinite(Number(a.durationMs))) stats.durationsMs.push(Number(a.durationMs));
    }
    if (entry.review) {
      review.runs += 1;
      if (Number.isFinite(Number(entry.review.findings))) review.findings.push(Number(entry.review.findings));
      if (Number.isFinite(Number(entry.review.mustFix))) review.mustFix.push(Number(entry.review.mustFix));
      review.consensus += entry.review.consensus ?? 0;
      review.contested += entry.review.contested ?? 0;
      review.parseFailures += entry.review.parseFailures ?? 0;
      review.verified += entry.review.verify?.verified ?? 0;
      review.refuted += entry.review.verify?.refuted ?? 0;
    }
  }
  const kinds = Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, { jobs: v.jobs, avgWallClockMs: avg(v.wallClockMs) }]));
  const agents = Object.fromEntries(
    Object.entries(byAgent).map(([k, v]) => [
      k,
      { calls: v.calls, failures: v.failures, timeouts: v.timeouts, retries: v.retries, avgDurationMs: avg(v.durationsMs), medianDurationMs: median(v.durationsMs) }
    ])
  );
  const phases = Object.keys(phaseMs).length ? Object.fromEntries(Object.entries(phaseMs).map(([p, arr]) => [p, avg(arr)])) : null;
  return {
    jobs: entries.length,
    kinds,
    agents,
    review: review.runs
      ? {
          runs: review.runs,
          avgFindings: avg(review.findings),
          avgMustFix: avg(review.mustFix),
          // These are lifetime totals across `runs`, not per-run averages.
          totals: { consensus: review.consensus, contested: review.contested, parseFailures: review.parseFailures, verified: review.verified, refuted: review.refuted }
        }
      : null,
    phases,
    audit: Object.keys(audit).length ? audit : null
  };
}

export function renderMetrics(agg, days) {
  const min = (ms) => (ms == null ? "-" : `${(ms / 60000).toFixed(1)}min`);
  const lines = [`Council metrics (${agg.jobs} finished jobs, last ${days} day${days === 1 ? "" : "s"}):`];
  lines.push("Per kind:");
  for (const [kind, v] of Object.entries(agg.kinds)) {
    lines.push(`  ${kind.padEnd(12)} jobs=${v.jobs}  avg wall-clock=${min(v.avgWallClockMs)}`);
  }
  lines.push("Per agent (across all rounds):");
  for (const [agent, v] of Object.entries(agg.agents)) {
    lines.push(
      `  ${agent.padEnd(12)} calls=${v.calls}  failures=${v.failures}  timeouts=${v.timeouts}  retries=${v.retries ?? 0}  avg=${min(v.avgDurationMs)}  median=${min(v.medianDurationMs)}`
    );
  }
  if (agg.review) {
    const r = agg.review;
    const t = r.totals;
    const holdup = t.verified + t.refuted > 0 ? ` verify hold-up=${Math.round((100 * t.verified) / (t.verified + t.refuted))}%` : "";
    lines.push("Review quality:");
    lines.push(`  runs=${r.runs}  per-run avg: findings=${r.avgFindings ?? "-"} must-fix=${r.avgMustFix ?? "-"}`);
    lines.push(`  totals (across ${r.runs}): consensus=${t.consensus}  contested=${t.contested}  parse-failures=${t.parseFailures}${holdup}`);
  }
  if (agg.phases) {
    lines.push(`Per phase (avg): ${Object.entries(agg.phases).map(([p, ms]) => `${p}=${min(ms)}`).join("  ")}`);
  }
  if (agg.audit) {
    lines.push("Audit runs:");
    for (const [kind, v] of Object.entries(agg.audit)) {
      const fields = Object.entries(v.sums).map(([k, s]) => `${k}=${s}`).join("  ");
      lines.push(`  ${kind.padEnd(14)} runs=${v.runs}  ${fields}`);
    }
  }
  return lines.join("\n");
}
