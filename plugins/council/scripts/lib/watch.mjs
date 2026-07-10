// Live-dashboard helpers for `council watch <job>`: derive per-agent progress
// from the job's phase log and render a compact, refreshing snapshot. Pure and
// testable - no I/O, no clock reads (caller passes nowMs).

const AGENTS = ["codex", "grok", "claude"];

/**
 * Parse the job phase log into per-agent R1/R2 progress. The log is a sequence
 * of `Phase: ...` lines emitted by the deliberation onPhase reporter, e.g.
 *   Phase: r1
 *   Phase: r1: grok done (1/3)
 *   Phase: r2 (3 critiques)
 *   Phase: r2: codex->claude done (2/3)
 */
export function summarizeProgress(logText) {
  const lines = String(logText ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^Phase:\s*/, "").trim())
    .filter(Boolean);

  const r1Done = new Set();
  let r1Expected = null;
  let r2Done = 0;
  let r2Total = null;
  let reachedR1 = false;
  let reachedR2 = false;
  let lastPhase = lines[lines.length - 1] ?? "queued";
  let verifying = false;
  let debating = false;

  for (const line of lines) {
    if (/^r1\b/.test(line)) reachedR1 = true;
    if (/^r2\b/.test(line)) reachedR2 = true;
    if (/^verify\b/.test(line)) verifying = true;
    if (/^debate\b/.test(line)) debating = true;

    const r1 = line.match(/^r1:\s*(\w+)\s+done(?:\s*\((\d+)\/(\d+)\))?/);
    if (r1) {
      r1Done.add(r1[1].toLowerCase());
      if (r1[3]) r1Expected = Number(r1[3]);
    }
    const r2 = line.match(/^r2:\s*[\w-]+->[\w-]+\s+done(?:\s*\((\d+)\/(\d+)\))?/);
    if (r2) {
      r2Done += 1;
      if (r2[2]) r2Total = Number(r2[2]);
    }
    const r2start = line.match(/^r2\s*\((\d+)\s+critiques\)/);
    if (r2start) r2Total = Number(r2start[1]);
  }

  return { r1Done, r1Expected, r2Done, r2Total, reachedR1, reachedR2, verifying, debating, lastPhase };
}

/** Per-agent R1 state derived from progress + which agents were skipped. */
export function agentR1States(progress, skipped = []) {
  const skip = new Set(skipped);
  const states = {};
  for (const agent of AGENTS) {
    if (skip.has(agent)) {
      states[agent] = "skipped";
    } else if (progress.r1Done.has(agent)) {
      states[agent] = "done";
    } else if (progress.reachedR1) {
      states[agent] = "running";
    } else {
      states[agent] = "pending";
    }
  }
  return states;
}

const STATE_MARK = { done: "[x]", running: "[~]", pending: "[ ]", skipped: "[-]" };

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m${String(rem).padStart(2, "0")}s` : `${rem}s`;
}

function isTerminal(status) {
  return status === "completed" || status === "completed_with_errors" || status === "failed";
}

/**
 * Render a compact dashboard snapshot. `etaMs` is an optional median wall-clock
 * from history; `skipped` lists agents excluded via reviewers/skip flags.
 */
export function formatDashboard(job, progress, { nowMs, etaMs = null, skipped = [] } = {}) {
  const created = job.createdAt ? Date.parse(job.createdAt) : null;
  const finished = job.finishedAt ? Date.parse(job.finishedAt) : null;
  const end = isTerminal(job.status) && finished ? finished : nowMs;
  const elapsedMs = created != null ? end - created : null;
  const states = agentR1States(progress, skipped);

  const lines = [];
  lines.push(`Council watch - ${job.id}  [${job.status}]`);
  lines.push(`  ${job.title ?? "Council"}${job.kind ? ` (${job.kind})` : ""}`);
  lines.push(`  elapsed: ${formatDuration(elapsedMs)}${etaMs ? `  ~eta: ${formatDuration(etaMs)}` : ""}`);
  lines.push(`  phase: ${progress.lastPhase}`);
  lines.push("");
  lines.push("  Round 1 (independent):");
  for (const agent of AGENTS) {
    lines.push(`    ${STATE_MARK[states[agent]]} ${agent}${states[agent] === "skipped" ? " (not a reviewer)" : ""}`);
  }
  if (progress.reachedR2 || progress.r2Total) {
    const total = progress.r2Total ?? "?";
    lines.push(`  Round 2 (peer critique): ${progress.r2Done}/${total} critiques`);
  }
  if (progress.verifying) lines.push("  Verify: refuting P0/P1 findings...");
  if (progress.debating) lines.push("  Debate: bounded rebuttals...");
  lines.push("");
  if (isTerminal(job.status)) {
    lines.push(`  DONE (${job.status}) in ${formatDuration(elapsedMs)}. See /council:result ${job.id}.`);
  } else if (etaMs && elapsedMs != null && elapsedMs > etaMs) {
    lines.push(`  ...running longer than the ${formatDuration(etaMs)} median (a slow agent?).`);
  }
  return { text: lines.join("\n"), terminal: isTerminal(job.status), elapsedMs };
}
