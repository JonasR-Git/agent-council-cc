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
    review: reviewSummary(job)
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
  const review = { runs: 0, findings: [], mustFix: [], consensus: 0, contested: 0, parseFailures: 0 };
  for (const entry of entries) {
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
    }
  }
  const kinds = Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, { jobs: v.jobs, avgWallClockMs: avg(v.wallClockMs) }]));
  const agents = Object.fromEntries(
    Object.entries(byAgent).map(([k, v]) => [
      k,
      { calls: v.calls, failures: v.failures, timeouts: v.timeouts, retries: v.retries, avgDurationMs: avg(v.durationsMs), medianDurationMs: median(v.durationsMs) }
    ])
  );
  return {
    jobs: entries.length,
    kinds,
    agents,
    review: review.runs ? { runs: review.runs, avgFindings: avg(review.findings), avgMustFix: avg(review.mustFix), consensus: review.consensus, contested: review.contested, parseFailures: review.parseFailures } : null
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
    lines.push("Review quality:");
    lines.push(`  runs=${r.runs}  avg findings=${r.avgFindings ?? "-"}  avg must-fix=${r.avgMustFix ?? "-"}  consensus=${r.consensus}  contested=${r.contested}  parse-failures=${r.parseFailures}`);
  }
  return lines.join("\n");
}
