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

export function recordJobMetrics(cwd, job) {
  const agents = (job.results ?? [])
    .filter((r) => r && !r.skipped && r.agent)
    .map((r) => ({
      agent: r.agent,
      role: r.role ?? r.aboutAgent ?? "r1",
      status: r.status ?? null,
      durationMs: Number.isFinite(Number(r.durationMs)) ? Number(r.durationMs) : null,
      timedOut: Boolean(r.timedOut)
    }));
  const wallClockMs = Date.parse(job.finishedAt ?? "") - Date.parse(job.createdAt ?? "");
  const entry = {
    id: job.id,
    kind: job.kind,
    status: job.status,
    finishedAt: job.finishedAt ?? null,
    createdAt: job.createdAt ?? null,
    wallClockMs: Number.isFinite(wallClockMs) ? wallClockMs : null,
    agents
  };
  try {
    appendJsonlCapped(metricsFile(cwd), entry, MAX_METRICS_LINES);
  } catch {
    /* metrics are best-effort; never break a run */
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

export function aggregateMetrics(entries) {
  const byKind = {};
  const byAgent = {};
  for (const entry of entries) {
    const kind = (byKind[entry.kind] = byKind[entry.kind] ?? { jobs: 0, wallClockMs: [] });
    kind.jobs += 1;
    if (Number.isFinite(Number(entry.wallClockMs))) kind.wallClockMs.push(Number(entry.wallClockMs));
    for (const a of entry.agents ?? []) {
      const stats = (byAgent[a.agent] = byAgent[a.agent] ?? { calls: 0, failures: 0, timeouts: 0, durationsMs: [] });
      stats.calls += 1;
      if (a.status !== 0 && a.status != null) stats.failures += 1;
      if (a.timedOut) stats.timeouts += 1;
      if (Number.isFinite(Number(a.durationMs))) stats.durationsMs.push(Number(a.durationMs));
    }
  }
  const kinds = Object.fromEntries(
    Object.entries(byKind).map(([k, v]) => [
      k,
      { jobs: v.jobs, avgWallClockMs: v.wallClockMs.length ? Math.round(v.wallClockMs.reduce((a, b) => a + b, 0) / v.wallClockMs.length) : null }
    ])
  );
  const agents = Object.fromEntries(
    Object.entries(byAgent).map(([k, v]) => [
      k,
      {
        calls: v.calls,
        failures: v.failures,
        timeouts: v.timeouts,
        avgDurationMs: v.durationsMs.length ? Math.round(v.durationsMs.reduce((a, b) => a + b, 0) / v.durationsMs.length) : null,
        medianDurationMs: median(v.durationsMs)
      }
    ])
  );
  return { jobs: entries.length, kinds, agents };
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
      `  ${agent.padEnd(12)} calls=${v.calls}  failures=${v.failures}  timeouts=${v.timeouts}  avg=${min(v.avgDurationMs)}  median=${min(v.medianDurationMs)}`
    );
  }
  return lines.join("\n");
}
