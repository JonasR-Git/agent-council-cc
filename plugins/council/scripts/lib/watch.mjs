// Live-dashboard helpers for `council watch <job>`: derive per-agent progress
// from the job's phase log + merged findings, and render a tidy boxed table.
// Pure and testable - no I/O, no clock reads (caller passes nowMs).

const AGENTS = ["codex", "grok", "claude"];
const W = 58; // inner box width (all glyphs used are single display-width)

// A job is "terminal" when it is neither running nor queued - matches handleWait
// so `cancelled` (and any future non-active status) also ends the watch loop.
export function isTerminal(status) {
  return status != null && status !== "running" && status !== "queued";
}

/**
 * Parse the job phase log into per-agent R1/R2 progress. Only `Phase:` lines are
 * considered: the log also carries banners like "Deliberation stored (N chars)"
 * that must not be mistaken for the current phase.
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
 * Per-agent R1 state. session-backed Claude is provided via file (never emits an
 * r1 done line) -> "file"; a terminal job reconciles un-acked participants to
 * "done" (a failed job leaves them "unknown"); skipped agents win.
 */
export function agentR1States(progress, { skipped = [], claudeBackend = "session", status = "running" } = {}) {
  const skip = new Set(skipped);
  const terminal = isTerminal(status);
  const failed = status === "failed";
  const states = {};
  for (const agent of AGENTS) {
    if (skip.has(agent)) states[agent] = "skipped";
    else if (agent === "claude" && claudeBackend === "session") states[agent] = "file";
    else if (progress.r1Done.has(agent)) states[agent] = "done";
    else if (terminal) states[agent] = failed ? "unknown" : "done";
    else if (progress.reachedR1) states[agent] = "running";
    else states[agent] = "pending";
  }
  return states;
}

/**
 * Findings breakdown from the stored merged doc: totals, consensus/unique/
 * contested, per-severity, and per-agent (how many each RAISED and how many of
 * those are shared/consensus). Null when findings aren't available yet.
 */
export function summarizeFindings(merged) {
  const all = merged?.all;
  if (!Array.isArray(all)) return null;
  const bySeverity = { P0: 0, P1: 0, P2: 0, nit: 0 };
  const blank = () => ({ raised: 0, shared: 0, disputed: 0 });
  const byAgent = { codex: blank(), grok: blank(), claude: blank() };
  let consensus = 0;
  let contested = 0;
  for (const f of all) {
    const sev = f.severity in bySeverity ? f.severity : "nit";
    bySeverity[sev] += 1;
    if (f.consensus) consensus += 1;
    // "disputed" = a peer voted disagree on this finding (contested), i.e. it
    // was pushed back on / partly refuted in Round 2.
    const disputed = Boolean(f.contested);
    if (disputed) contested += 1;
    for (const a of f.agents ?? []) {
      if (!byAgent[a]) continue;
      byAgent[a].raised += 1;
      if (f.consensus) byAgent[a].shared += 1;
      if (disputed) byAgent[a].disputed += 1;
    }
  }
  return { total: all.length, consensus, unique: all.length - consensus, contested, bySeverity, byAgent };
}

// ASCII-only status words: box-drawing + block bars are reliably single-width,
// but check/diamond glyphs are "ambiguous width" and would break the right
// border in some terminals. Color (in the live TTY) provides the visual accent.
const R1_LABEL = {
  done: "done",
  running: "running",
  pending: "pending",
  skipped: "skipped",
  file: "file",
  unknown: "unknown"
};

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m${String(rem).padStart(2, "0")}s` : `${rem}s`;
}

/** A fixed-width block progress bar. */
export function progressBar(done, total, width = 12) {
  if (!Number.isFinite(total) || total <= 0) return "░".repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// --- box helpers (all content uses single-width glyphs, so .length == width) --
const TOP = `╔${"═".repeat(W)}╗`;
const SEP = `╟${"─".repeat(W)}╢`;
const BOT = `╚${"═".repeat(W)}╝`;
function box(content = "") {
  const c = `  ${content}`;
  return `║${(c.length > W ? c.slice(0, W) : c.padEnd(W))}║`;
}
function col(s, n) {
  const t = String(s);
  return t.length >= n ? `${t} ` : t.padEnd(n);
}

/**
 * Render the boxed dashboard. `etaMs` = median full-job wall-clock (shown as
 * remaining while running); `findings` = summarizeFindings(...) or null;
 * `jobPhase` (job.phase) is preferred over the log-derived phase.
 */
export function formatDashboard(job, progress, { nowMs, etaMs = null, skipped = [], claudeBackend = "session", jobPhase = null, findings = null } = {}) {
  const created = job.createdAt ? Date.parse(job.createdAt) : null;
  const finished = job.finishedAt ? Date.parse(job.finishedAt) : null;
  const terminal = isTerminal(job.status);
  const end = terminal && finished ? finished : nowMs;
  const elapsedMs = created != null ? end - created : null;
  const states = agentR1States(progress, { skipped, claudeBackend, status: job.status });
  const phase = terminal ? "done" : jobPhase || progress.lastPhase || "queued";

  let timeMeta = formatDuration(elapsedMs);
  if (!terminal && etaMs && elapsedMs != null) {
    const remaining = etaMs - elapsedMs;
    timeMeta += remaining > 0 ? ` │ ~${formatDuration(remaining)} left` : ` │ over median ${formatDuration(etaMs)}`;
  }

  const r1Count = AGENTS.filter((a) => states[a] === "done" || states[a] === "file").length;
  const r1Total = AGENTS.filter((a) => states[a] !== "skipped").length;
  const r2Total = progress.r2Total ?? 0;

  const lines = [];
  lines.push(TOP);
  // Everything is left-aligned for a consistent gutter (no lone right-floated
  // element); the box pads the right edge, so it stays flush regardless of id.
  lines.push(box(`COUNCIL ${String(job.kind ?? "review").toUpperCase()}`));
  lines.push(box(`${job.id}  │  ${job.status}  │  ${timeMeta}`));
  lines.push(box(`phase  ${phase}`));
  lines.push(SEP);
  // Only deliberate has an R1/R2 round structure; other modes review once.
  const roundLabel = job.kind === "deliberate" ? "round 1" : "status";
  lines.push(box(`${col("agent", 9)}${col(roundLabel, 10)}${col("raised", 8)}${col("shared", 8)}disputed`));
  for (const agent of AGENTS) {
    const fa = findings?.byAgent?.[agent];
    const raised = fa ? String(fa.raised) : "-";
    const shared = fa ? String(fa.shared) : "-";
    const disputed = fa ? String(fa.disputed) : "-";
    lines.push(box(`${col(agent, 9)}${col(R1_LABEL[states[agent]], 10)}${col(raised, 8)}${col(shared, 8)}${disputed}`));
  }
  lines.push(SEP);
  // Show the R2 bar only when a peer round actually happens (deliberate); a
  // review/adversarial/solve run has none, so "R2 0/?" would be misleading.
  const hasR2 = progress.reachedR2 || r2Total > 0;
  const bar1 = `R1  ${progressBar(r1Count, r1Total, 12)} ${r1Count}/${r1Total}`;
  const bar2 = hasR2 ? `    R2  ${progressBar(progress.r2Done, r2Total, 12)} ${progress.r2Done}/${r2Total || "?"}` : "";
  lines.push(box(bar1 + bar2));
  lines.push(SEP);
  if (findings) {
    const mustFix = findings.bySeverity.P0 + findings.bySeverity.P1;
    lines.push(box(`${findings.total} findings  │  ${findings.consensus} consensus  │  ${findings.unique} unique  │  ${findings.contested} disputed`));
    const sev = Object.entries(findings.bySeverity)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} ${n}`)
      .join("   ");
    lines.push(box(`must-fix  ${mustFix} (P0/P1)`));
    lines.push(box(`severity  ${sev || "none"}`));
  } else if (terminal) {
    lines.push(box("findings  see /council:status --result for the full report"));
  } else {
    lines.push(box("findings  pending — available when the run completes"));
  }
  lines.push(BOT);
  lines.push(`  → /council:status --result ${job.id}`);
  return { text: lines.join("\n"), terminal, elapsedMs };
}

// --- optional ANSI color for the live TTY only ------------------------------
// Applied AFTER layout so escapes (zero display width) never shift the box.
const ANSI = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  gray: "\x1b[90m"
};

export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Colorize a rendered (plain) dashboard for a TTY. Only wraps tokens in ANSI
 * escapes - it never adds or removes visible characters, so the layout computed
 * by formatDashboard is preserved exactly.
 */
export function colorize(text) {
  const wrap = (s, c) => `${c}${s}${ANSI.reset}`;
  return String(text)
    .replace(/█+/g, (m) => wrap(m, ANSI.cyan))
    .replace(/░+/g, (m) => wrap(m, ANSI.dim))
    .replace(/\bcompleted_with_errors\b/g, (m) => wrap(m, ANSI.yellow))
    .replace(/\b(done|completed)\b/g, (m) => wrap(m, ANSI.green))
    .replace(/\b(running|queued)\b/g, (m) => wrap(m, ANSI.yellow))
    .replace(/\b(failed|cancelled)\b/g, (m) => wrap(m, ANSI.red))
    .replace(/\bfile\b/g, (m) => wrap(m, ANSI.cyan))
    .replace(/\b(pending|wait|skipped|unknown|none)\b/g, (m) => wrap(m, ANSI.dim))
    .replace(/\bP0\b/g, (m) => wrap(m, ANSI.bold + ANSI.red))
    .replace(/\bP1\b/g, (m) => wrap(m, ANSI.red))
    .replace(/\bP2\b/g, (m) => wrap(m, ANSI.yellow))
    .replace(/\bnit\b/g, (m) => wrap(m, ANSI.dim))
    .replace(/must-fix {2}(\d+)/g, (m, n) => (n === "0" ? wrap(m, ANSI.dim) : `must-fix  ${wrap(n, ANSI.bold + ANSI.red)}`))
    .replace(/[║╔╗╚╝╟╢═─]+/g, (m) => wrap(m, ANSI.gray));
}
