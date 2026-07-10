// Live-dashboard helpers for `council watch <job>`: derive per-agent progress
// from the job's phase log and render a compact, tidy snapshot. Pure and
// testable - no I/O, no clock reads (caller passes nowMs).

const AGENTS = ["codex", "grok", "claude"];
const RULE = "-".repeat(52);

// A job is "terminal" when it is neither running nor queued - matches handleWait
// so `cancelled` (and any future non-active status) also ends the watch loop.
export function isTerminal(status) {
  return status != null && status !== "running" && status !== "queued";
}

/**
 * Parse the job phase log into per-agent R1/R2 progress. Only `Phase:` lines are
 * considered: the log also carries banners like "Deliberation stored (N chars)"
 * that must not be mistaken for the current phase. Emitted by the onPhase
 * reporter, e.g.
 *   Phase: r1
 *   Phase: r1: grok done (1/3)
 *   Phase: r2 (3 critiques)
 *   Phase: r2: codex->claude done (2/3)
 */
export function summarizeProgress(logText) {
  const lines = String(logText ?? "")
    .split(/\r?\n/)
    .filter((l) => /^Phase:\s*/.test(l))
    .map((l) => l.replace(/^Phase:\s*/, "").trim())
    .filter(Boolean);

  const r1Done = new Set();
  let r1Expected = null;
  let r2Done = 0;
  let r2Total = null;
  let reachedR1 = false;
  let reachedR2 = false;
  const lastPhase = lines[lines.length - 1] ?? null;

  for (const line of lines) {
    if (/^r1\b/.test(line)) reachedR1 = true;
    if (/^r2\b/.test(line)) reachedR2 = true;

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

  return { r1Done, r1Expected, r2Done, r2Total, reachedR1, reachedR2, lastPhase };
}

/**
 * Per-agent R1 state. Reconciles three realities the raw log can't express:
 *  - session-backed Claude is provided via a findings file, not run as a live
 *    R1 job, so it never emits `r1: claude done` -> shown as "file", not stuck
 *    "running";
 *  - a terminal job means every participating agent is done even if its done
 *    line was never parsed (or the mode emits no r1 phases at all);
 *  - a failed job leaves un-acked agents "unknown" rather than falsely "done".
 */
export function agentR1States(progress, { skipped = [], claudeBackend = "session", status = "running" } = {}) {
  const skip = new Set(skipped);
  const terminal = isTerminal(status);
  const failed = status === "failed";
  const states = {};
  for (const agent of AGENTS) {
    if (skip.has(agent)) {
      states[agent] = "skipped";
    } else if (agent === "claude" && claudeBackend === "session") {
      states[agent] = "file";
    } else if (progress.r1Done.has(agent)) {
      states[agent] = "done";
    } else if (terminal) {
      states[agent] = failed ? "unknown" : "done";
    } else if (progress.reachedR1) {
      states[agent] = "running";
    } else {
      states[agent] = "pending";
    }
  }
  return states;
}

const STATE_MARK = {
  done: "[x]",
  running: "[~]",
  pending: "[ ]",
  skipped: "[-]",
  file: "[f]",
  unknown: "[?]"
};
const STATE_NOTE = {
  skipped: " (not a reviewer)",
  file: " (from file, session backend)",
  unknown: " (no completion recorded)"
};

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m${String(rem).padStart(2, "0")}s` : `${rem}s`;
}

/** A fixed-width unicode progress bar. */
export function progressBar(done, total, width = 12) {
  if (!Number.isFinite(total) || total <= 0) return "-".repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)));
  return "#".repeat(filled) + ".".repeat(width - filled);
}

/** The 4-stage pipeline line with the current stage marked. */
export function pipelineLine(phase, terminal) {
  const stages = ["context", "R1", "R2", "done"];
  let idx = 0;
  if (terminal) idx = 3;
  else if (/^(r2|verify|debate)\b/.test(String(phase))) idx = 2;
  else if (/^r1/.test(String(phase))) idx = 1;
  return stages
    .map((label, i) => `${i < idx ? "(x)" : i === idx ? "(*)" : "( )"} ${label}`)
    .join("  >  ");
}

/**
 * Render a compact, tidy dashboard snapshot. `etaMs` is an optional median
 * full-job wall-clock from history (shown as remaining while running);
 * `skipped` lists non-participating agents; `jobPhase` (job.phase) is preferred
 * over the log-derived phase since it is never a stray banner line.
 */
export function formatDashboard(job, progress, { nowMs, etaMs = null, skipped = [], claudeBackend = "session", jobPhase = null } = {}) {
  const created = job.createdAt ? Date.parse(job.createdAt) : null;
  const finished = job.finishedAt ? Date.parse(job.finishedAt) : null;
  const terminal = isTerminal(job.status);
  const end = terminal && finished ? finished : nowMs;
  const elapsedMs = created != null ? end - created : null;
  const states = agentR1States(progress, { skipped, claudeBackend, status: job.status });
  const phase = terminal ? "done" : jobPhase || progress.lastPhase || "queued";

  // ETA reads as remaining time while running; over-median shows a hint.
  let timeLine = `elapsed ${formatDuration(elapsedMs)}`;
  if (!terminal && etaMs && elapsedMs != null) {
    const remaining = etaMs - elapsedMs;
    timeLine +=
      remaining > 0
        ? `  |  ~${formatDuration(remaining)} left (median ${formatDuration(etaMs)})`
        : `  |  over median ${formatDuration(etaMs)} - a slow agent?`;
  } else if (!terminal && etaMs) {
    timeLine += `  |  median ${formatDuration(etaMs)}`;
  }

  const r1Count = AGENTS.filter((a) => states[a] === "done" || states[a] === "file").length;
  const r1Total = AGENTS.filter((a) => states[a] !== "skipped").length;

  const lines = [];
  lines.push(RULE);
  lines.push(`  council watch  ${job.id}   [${job.status}]`);
  lines.push(`  ${job.title ?? "Council"}${job.kind ? ` - ${job.kind}` : ""}`);
  lines.push(`  ${timeLine}`);
  lines.push(RULE);
  lines.push(`  ${pipelineLine(phase, terminal)}`);
  lines.push(`  phase: ${phase}`);
  lines.push(RULE);
  lines.push(`  Round 1  independent      [${progressBar(r1Count, r1Total)}] ${r1Count}/${r1Total}`);
  for (const agent of AGENTS) {
    lines.push(`    ${STATE_MARK[states[agent]]} ${agent}${STATE_NOTE[states[agent]] ?? ""}`);
  }
  if (progress.reachedR2 || progress.r2Total) {
    const total = progress.r2Total ?? 0;
    lines.push(`  Round 2  peer critique    [${progressBar(progress.r2Done, total)}] ${progress.r2Done}/${total || "?"}`);
  }
  if (!terminal && /^verify\b/.test(phase)) lines.push("  Verify   refuting P0/P1 findings...");
  if (!terminal && /^debate\b/.test(phase)) lines.push("  Debate   bounded rebuttals...");
  lines.push(RULE);
  if (terminal) {
    lines.push(`  DONE (${job.status}) in ${formatDuration(elapsedMs)}  ->  /council:result ${job.id}`);
  } else {
    lines.push(`  live: redraws until done  |  /council:result ${job.id} when finished`);
  }
  lines.push(RULE);
  return { text: lines.join("\n"), terminal, elapsedMs };
}
