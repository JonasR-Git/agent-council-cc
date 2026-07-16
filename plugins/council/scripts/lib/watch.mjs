// Live-dashboard helpers for `council watch <job>`: derive per-agent progress
// from the job's phase log + merged findings, and render a tidy boxed table.
// Pure and testable - no I/O, no clock reads (caller passes nowMs).
// Also home of the UNIVERSAL progress renderer (the reader side of the shared
// progress.json contract, schemaVersion 1) at the bottom of this file. Same
// purity rule; readProgressState is the one deliberate exception (a fail-soft
// fs read whose readFile is injectable for tests).

import fs from "node:fs";
import path from "node:path";
import { PROGRESS_SCHEMA_VERSION, SEVERITY_BUCKETS } from "./progress.mjs";
import { evaluateCeiling } from "./usage-guard.mjs";

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
  const raisedByAgent = {};
  let r2Done = 0;
  let r2Total = null;
  let reachedR1 = false;
  let reachedR2 = false;
  const lastPhase = lines[lines.length - 1] ?? null;

  for (const line of lines) {
    if (/^r1\b/.test(line)) reachedR1 = true;
    if (/^r2\b/.test(line)) reachedR2 = true;

    // e.g. "r1: grok done (1/3) raised=9" — the raised= suffix (when present) gives
    // a LIVE per-agent finding count before the final merge fills in shared/disputed.
    // The "(x/N)" progress suffix itself is NOT the authoritative R1 total: both renderers
    // derive that from the per-agent `states` map instead (agentR1States), so its groups
    // are intentionally unread here beyond identifying the agent + raised count.
    const r1 = line.match(/^r1:\s*(\w+)\s+done(?:\s*\((\d+)\/(\d+)\))?(?:\s+raised=(\d+))?/);
    if (r1) {
      r1Done.add(r1[1].toLowerCase());
      if (r1[4] != null) raisedByAgent[r1[1].toLowerCase()] = Number(r1[4]);
    }
    const r2 = line.match(/^r2:\s*[\w-]+->[\w-]+\s+done(?:\s*\((\d+)\/(\d+)\))?/);
    if (r2) {
      r2Done += 1;
      if (r2[2]) r2Total = Number(r2[2]);
    }
    const r2start = line.match(/^r2\s*\((\d+)\s+critiques\)/);
    if (r2start) r2Total = Number(r2start[1]);
  }

  return { r1Done, raisedByAgent, r2Done, r2Total, reachedR1, reachedR2, lastPhase };
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

// --- Markdown dashboard (for the chat, where ANSI in a code block won't render) --
// A chat message is static Markdown, so this renders a rich SNAPSHOT (emoji status,
// Unicode bars, a real table, severity squares, consensus badge, and a delta vs the
// previous snapshot) instead of the terminal box. Pure: the caller supplies `prior`
// (the last snapshot) for the delta and persists the returned `snapshot`.
const STATUS_EMOJI = { running: "🟡", queued: "⚪", completed: "🟢", completed_with_errors: "🟠", failed: "🔴", cancelled: "🔴" };
const R1_EMOJI = { done: "🟢", running: "🟡", pending: "⚪", skipped: "⚫", file: "🔵", unknown: "🔴" };
const SEV_SQUARE = { P0: "🟥", P1: "🟧", P2: "🟨", nit: "⬜" };
const VERDICT_BADGE = { approve: "✅", approve_with_nits: "👍", request_changes: "🟠", block: "⛔" };

// Neutralize untrusted text before it enters the chat markdown. Finding titles/
// files/branch come from external Codex/Grok output, so beyond flattening rows we
// must stop markdown injection: backticks (code-span breakout), [] (phishing
// links), pipes (table rows), and control/bidi chars. Cosmetic emphasis (*/_) is
// left as-is.
const flat = (s, max = 120) =>
  String(s ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[|`]/g, "'")
    .replace(/[[\]]/g, "")
    .slice(0, max)
    .trim();

/**
 * Decision-relevant extras from a finished deliberation (null while running / for
 * non-deliberate jobs): per-agent verdict, the top must-fix findings, the cross-run
 * ledger split (recurring vs new), verify outcomes, and the scope split. Pure.
 */
export function summarizeCouncilExtras(deliberation) {
  if (!deliberation) return null;
  const all = Array.isArray(deliberation.merged?.all) ? deliberation.merged.all : [];
  const verdicts = {};
  // A persisted job slims the deliberation to a verdicts[] array; a fresh in-memory
  // one carries the full r1[] docs. Support both shapes.
  if (Array.isArray(deliberation.verdicts)) {
    for (const v of deliberation.verdicts) if (v?.agent && v.verdict) verdicts[v.agent] = v.verdict;
  } else {
    for (const r of deliberation.r1 ?? []) if (r?.agent && r.findings?.verdict) verdicts[r.agent] = r.findings.verdict;
  }
  const rank = { P0: 0, P1: 1, P2: 2, nit: 3 };
  const topFindings = [...all]
    .filter((f) => f.severity === "P0" || f.severity === "P1")
    .sort((a, b) => (rank[a.severity] ?? 2) - (rank[b.severity] ?? 2))
    .slice(0, 5)
    .map((f) => ({ severity: f.severity, title: flat(f.title), file: f.file ? flat(f.file, 80) : null, line: f.line ?? null, consensus: Boolean(f.consensus) }));
  const recurring = all.filter((f) => f.seenBefore).length;
  const ledger = all.length ? { recurring, fresh: all.length - recurring } : null;
  const verify = deliberation.verification ? { verified: deliberation.verification.verifiedCount, refuted: deliberation.verification.refutedCount } : null;
  const localized = all.filter((f) => f.scope === "localized").length;
  const crossCutting = all.filter((f) => f.scope === "cross-cutting").length;
  const scope = localized || crossCutting ? { localized, crossCutting } : null;
  const context = deliberation.context ? { branch: flat(deliberation.context.branch, 60), target: flat(deliberation.context.target?.label, 60) } : null;
  return { verdicts, topFindings, ledger, verify, scope, context };
}

export function formatDashboardMarkdown(job, progress, { nowMs, etaMs = null, skipped = [], claudeBackend = "session", jobPhase = null, findings = null, extras = null, prior = null } = {}) {
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
    timeMeta += remaining > 0 ? ` · ~${formatDuration(remaining)} left` : ` · over median ${formatDuration(etaMs)}`;
  }

  const r1Count = AGENTS.filter((a) => states[a] === "done" || states[a] === "file").length;
  const r1Total = AGENTS.filter((a) => states[a] !== "skipped").length;
  const r2Total = progress.r2Total ?? 0;
  const hasR2 = progress.reachedR2 || r2Total > 0;

  const L = [];
  L.push(`### ${STATUS_EMOJI[job.status] ?? "⚪"} Council ${String(job.kind ?? "review")} · \`${job.id}\``);
  if (extras?.context?.target) L.push(`_reviewing ${extras.context.target}${extras.context.branch ? ` · \`${extras.context.branch}\`` : ""}_`);
  L.push(`**${job.status}** · ${timeMeta} · phase \`${phase}\``);
  L.push("");
  let bars = `**Round 1** (independent) \`${progressBar(r1Count, r1Total, 12)}\` ${r1Count}/${r1Total}`;
  if (hasR2) bars += ` · **Round 2** (peer critique) \`${progressBar(progress.r2Done, r2Total, 12)}\` ${progress.r2Done}/${r2Total || "?"}`;
  L.push(bars);
  L.push("");
  L.push("| Reviewer | Verdict | Raised | Consensus | Contested |");
  L.push("|---|---|--:|--:|--:|");
  for (const agent of AGENTS) {
    const fa = findings?.byAgent?.[agent];
    const liveRaised = progress.raisedByAgent?.[agent];
    const raised = fa ? fa.raised : liveRaised != null ? liveRaised : "–";
    const shared = fa ? fa.shared : "–";
    const disputed = fa ? fa.disputed : "–";
    const v = extras?.verdicts?.[agent];
    const verdict = v ? `${VERDICT_BADGE[v] ?? ""} ${v.replace(/_/g, " ")}`.trim() : "–";
    L.push(`| ${R1_EMOJI[states[agent]] ?? "⚪"} ${agent} | ${verdict} | ${raised} | ${shared} | ${disputed} |`);
  }
  L.push("");
  L.push("_Raised = findings this reviewer flagged · Consensus = also flagged by a peer · Contested = a peer disagreed_");
  L.push("");
  if (findings) {
    const mustFix = findings.bySeverity.P0 + findings.bySeverity.P1;
    L.push(`**Findings — ${findings.total} total**`);
    const sev = ["P0", "P1", "P2", "nit"].filter((k) => findings.bySeverity[k]).map((k) => `${SEV_SQUARE[k]} ${k} ${findings.bySeverity[k]}`).join(" · ");
    if (sev) L.push(`by severity: ${sev} → **${mustFix} must-fix** (P0+P1)`);
    L.push(`agreement: 🤝 ${findings.consensus} consensus (≥2 reviewers) · 🔍 ${findings.unique} unique (one reviewer — verify first) · ⚔️ ${findings.contested} contested`);
  } else if (terminal) {
    L.push("_findings: see `/council:status --result` for the full report_");
  } else {
    L.push("_findings pending — available when the run completes_");
  }

  if (extras) {
    if (extras.ledger) L.push(`history: ♻️ ${extras.ledger.recurring} recurring (seen in earlier runs) · 🆕 ${extras.ledger.fresh} new this run`);
    if (extras.verify) L.push(`verified: 🔬 ${extras.verify.verified} held up · ${extras.verify.refuted} refuted under adversarial check`);
    if (extras.scope) L.push(`action: 🎯 ${extras.scope.localized} fixable in place · 📄 ${extras.scope.crossCutting} cross-cutting (needs a migration)`);
    if (extras.topFindings?.length) {
      L.push("");
      L.push("**Top issues to fix first**");
      for (const f of extras.topFindings) {
        L.push(`- ${SEV_SQUARE[f.severity] ?? ""} **${f.severity}** ${f.title}${f.file ? ` — \`${f.file}${f.line ? `:${f.line}` : ""}\`` : ""}${f.consensus ? " · 🤝 consensus" : ""}`);
      }
    }
  }

  const snapshot = { phase, findingsTotal: findings?.total ?? 0, r1Count, r2Done: progress.r2Done ?? 0, consensus: findings?.consensus ?? 0 };
  if (prior) {
    const d = [];
    if (prior.phase !== phase) d.push(`phase \`${prior.phase}\` → \`${phase}\``);
    if (prior.r1Count !== r1Count) d.push(`R1 ${prior.r1Count}→${r1Count}`);
    if ((prior.r2Done ?? 0) !== (progress.r2Done ?? 0)) d.push(`R2 ${prior.r2Done ?? 0}→${progress.r2Done ?? 0}`);
    const df = (findings?.total ?? 0) - (prior.findingsTotal ?? 0);
    if (df !== 0) d.push(`${df > 0 ? "+" : ""}${df} findings`);
    if (d.length) {
      L.push("");
      L.push(`_Δ since last update: ${d.join(" · ")}_`);
    }
  }
  return { markdown: L.join("\n"), snapshot, terminal };
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

// --- Universal progress dashboard (reader side of the progress.json contract) --
// Renders a progress.json snapshot of ANY kind (audit review/fix/loop/endless,
// build, plan, deliberate). TOTAL by design: every field is optional, wrong
// types are coerced or dropped, and an unknown schemaVersion yields a minimal
// safe header - a dashboard that crashes is worse than none.

// PROGRESS_SCHEMA_VERSION + SEVERITY_BUCKETS are imported from progress.mjs (the
// writer) so a schema bump on one side can never silently desync the reader.
const COUNTER_KEYS = ["fixed", "proposed", "reverted", "skipped", "committed"];
const SEAT_EMOJI = { reviewing: "🟢", done: "✅", idle: "⚪", voting: "🗳️", error: "🔴" };
const GATE_EMOJI = { running: "🟡", pass: "✅", veto: "⛔" };
const RUN_EMOJI = { running: "🟡", done: "🟢", failed: "🔴", paused: "⏸️" };
// What one "unit" means per kind (a build/plan reports steps; the rest report
// generic work units). Unknown kinds fall back to "units".
const UNIT_NOUN = { build: "steps", plan: "steps" };

// Type-strict coercers: anything of the wrong type becomes null (= omitted),
// never a NaN/`[object Object]` leaking into the dashboard. Strings run through
// flat() so untrusted reporter text can't inject markdown or control chars.
const asStr = (v, max = 120) => {
  if (typeof v !== "string") return null;
  const s = flat(v, max);
  return s || null;
};
const asNum = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const asTs = (v) => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const unitsText = (done, total, dash) => (total != null && total > 0 ? `${done ?? 0}/${total}` : done != null ? String(done) : dash);

/** Coerce an arbitrary parsed progress.json into a safe, fully-typed shape. */
function normalizeProgressState(state) {
  const s = state && typeof state === "object" && !Array.isArray(state) ? state : {};
  const seats = Array.isArray(s.seats)
    ? s.seats
        .filter((x) => x && typeof x === "object" && !Array.isArray(x))
        .slice(0, 16)
        .map((x) => ({
          name: asStr(x.name, 24) ?? "?",
          state: asStr(x.state, 16) ?? "idle",
          unitsDone: asNum(x.unitsDone),
          unitsTotal: asNum(x.unitsTotal),
          raised: asNum(x.raised)
        }))
    : [];
  const p = s.progress && typeof s.progress === "object" && !Array.isArray(s.progress) ? s.progress : null;
  const progress = p
    ? { unitsDone: asNum(p.unitsDone), unitsTotal: asNum(p.unitsTotal), passesDone: asNum(p.passesDone), passesTotal: asNum(p.passesTotal) }
    : null;
  const counters = {};
  if (s.counters && typeof s.counters === "object" && !Array.isArray(s.counters)) {
    for (const k of COUNTER_KEYS) {
      const v = asNum(s.counters[k]);
      if (v != null) counters[k] = v;
    }
  }
  // Per-lens finding matrix (findingsByLens[lens] = {total, P0, P1, P2, nit}).
  // Only lenses with >=1 finding survive; each cell is type-strict, capped at 24
  // lenses so a garbage payload can't blow up the table.
  const lenses = [];
  if (s.findingsByLens && typeof s.findingsByLens === "object" && !Array.isArray(s.findingsByLens)) {
    for (const [rawLens, rawCell] of Object.entries(s.findingsByLens)) {
      if (lenses.length >= 24) break;
      if (!rawCell || typeof rawCell !== "object" || Array.isArray(rawCell)) continue;
      const name = asStr(rawLens, 40);
      if (!name) continue;
      const cell = { P0: 0, P1: 0, P2: 0, nit: 0 };
      let bySeverity = 0;
      for (const k of SEVERITY_BUCKETS) {
        const v = asNum(rawCell[k]);
        if (v != null && v > 0) cell[k] = v;
        bySeverity += cell[k];
      }
      const declared = asNum(rawCell.total);
      const total = declared != null && declared > bySeverity ? declared : bySeverity;
      if (total > 0) lenses.push({ name, total, ...cell });
    }
    lenses.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  }
  const g = s.gate && typeof s.gate === "object" && !Array.isArray(s.gate) ? s.gate : null;
  const gate = g ? { name: asStr(g.name, 40), target: asStr(g.target, 80), state: asStr(g.state, 16) } : null;
  const b = s.budget && typeof s.budget === "object" && !Array.isArray(s.budget) ? s.budget : null;
  const budget = b ? { spent: asNum(b.spent), total: asNum(b.total) } : null;
  const recent = Array.isArray(s.recentLines)
    ? s.recentLines
        .filter((l) => typeof l === "string" && l.trim())
        .slice(-3)
        .map((l) => flat(l, 100))
    : [];
  const phase = asStr(s.phase, 32);
  const failed = s.ok === false || phase === "failed";
  // A --pause-at-5h suspend is terminal-for-polling (done:true so watchers stop) but reads SUSPENDED,
  // not finished-green — surface a distinct "paused" status so the dashboard shows ⏸️, not 🟢 (B residual).
  const paused = !failed && phase === "paused";
  const done = failed || s.done === true || phase === "done";
  // Liveness during a long in-process wait (rate-limit backoff / --pause-at-5h quota wait). Surfaced so a
  // watcher SEES the run is alive-and-waiting (not hung) with a countdown; suppressed once terminal.
  const wRaw = s.waiting && typeof s.waiting === "object" && !Array.isArray(s.waiting) ? s.waiting : null;
  const waiting = wRaw && !done ? { reason: asStr(wRaw.reason, 80), remainingMs: asNum(wRaw.remainingMs), resumeAt: asTs(wRaw.resumeAt) } : null;
  return {
    kind: asStr(s.kind, 40),
    jobId: asStr(s.jobId, 60),
    title: asStr(s.title, 100),
    startedAt: asTs(s.startedAt),
    updatedAt: asTs(s.updatedAt),
    phase,
    phaseDetail: asStr(s.phaseDetail, 96),
    seats,
    progress,
    counters,
    lenses,
    gate,
    budget,
    etaMs: asNum(s.etaMs),
    recent,
    waiting,
    done,
    status: failed ? "failed" : paused ? "paused" : done ? "done" : "running",
    stopReason: asStr(s.stopReason, 100)
  };
}

// Human one-liner for an active in-process wait, e.g. "waiting: rate-limit backoff — resuming in 3m12s".
// Prefers a fresh countdown from resumeAt vs the render clock (remainingMs is a stamp snapshot, up to one
// heartbeat stale); falls back to the stamped remainingMs. Returns null when nothing renderable.
function formatWaiting(waiting, nowMs) {
  if (!waiting || typeof waiting !== "object") return null;
  const reason = waiting.reason || "waiting";
  let remaining = null;
  if (Number.isFinite(waiting.resumeAt) && Number.isFinite(nowMs)) remaining = waiting.resumeAt - nowMs;
  if (remaining == null || remaining < 0) remaining = Number.isFinite(waiting.remainingMs) ? waiting.remainingMs : null;
  const eta = remaining != null && remaining > 0 ? ` — resuming in ~${formatDuration(remaining)}` : "";
  return `waiting: ${reason}${eta}`;
}

// Elapsed (startedAt -> nowMs, frozen at updatedAt once done) + remaining ETA,
// as separate meta parts so each renderer joins them with its own separator.
function progressTimeParts(n, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : n.updatedAt;
  const end = n.done && n.updatedAt != null ? n.updatedAt : now;
  const parts = [];
  if (n.startedAt != null && end != null) parts.push(formatDuration(end - n.startedAt));
  if (!n.done && n.etaMs != null) parts.push(`~${formatDuration(n.etaMs)} left`);
  return parts;
}

const hasUnits = (n) => n.progress != null && (n.progress.unitsTotal != null || n.progress.unitsDone != null);
const hasPasses = (n) => n.progress != null && (n.progress.passesTotal != null || n.progress.passesDone != null);
const hasGate = (n) => n.gate != null && (n.gate.name != null || n.gate.state != null);
const hasBudget = (n) => n.budget != null && (n.budget.spent != null || n.budget.total != null);

// Greedy-pack short entries into rows no longer than maxLen (so e.g. five
// counters with big numbers wrap to a second box row instead of truncating).
function packRows(entries, sep, maxLen) {
  const rows = [];
  let cur = "";
  for (const e of entries) {
    const next = cur ? cur + sep + e : e;
    if (cur && next.length > maxLen) {
      rows.push(cur);
      cur = e;
    } else {
      cur = next;
    }
  }
  if (cur) rows.push(cur);
  return rows;
}

// Width-parameterized twin of the fixed-width box helpers above (same ASCII-only
// content rule: no emoji/ambiguous-width glyphs inside the box).
function boxParts(inner) {
  return {
    top: `╔${"═".repeat(inner)}╗`,
    sep: `╟${"─".repeat(inner)}╢`,
    bot: `╚${"═".repeat(inner)}╝`,
    row: (content = "") => {
      const c = `  ${content}`;
      return `║${c.length > inner ? c.slice(0, inner) : c.padEnd(inner)}║`;
    }
  };
}

function renderProgressBox(state, { nowMs, width } = {}) {
  const inner = Math.max(44, Math.min(140, Number.isFinite(width) ? width : 60)) - 2;
  const { top, sep, bot, row } = boxParts(inner);
  if (state == null || typeof state !== "object" || Array.isArray(state)) {
    return [top, row("COUNCIL PROGRESS"), row("no progress data yet"), bot].join("\n");
  }
  const version = state.schemaVersion;
  const n = normalizeProgressState(state);
  if (version != null && version !== PROGRESS_SCHEMA_VERSION) {
    const lines = [top, row("COUNCIL PROGRESS")];
    if (n.jobId) lines.push(row(n.jobId));
    lines.push(row(`unsupported progress schema (v${flat(String(version), 20)})`));
    lines.push(bot);
    return lines.join("\n");
  }

  const kindLabel = (n.kind ?? "progress").replace(/-/g, " ");
  const lines = [top];
  lines.push(row(`COUNCIL ${kindLabel.toUpperCase()}`));
  if (n.title) lines.push(row(n.title));
  lines.push(row([n.jobId ?? "-", n.status, ...progressTimeParts(n, nowMs)].join("  │  ")));
  if (n.phase || n.phaseDetail) lines.push(row(`phase  ${[n.phase ?? "?", n.phaseDetail].filter(Boolean).join(" — ")}`));
  const waitLine = formatWaiting(n.waiting, nowMs);
  if (waitLine) lines.push(row(`⏳ ${waitLine}`));
  if (n.stopReason) lines.push(row(`stop   ${n.stopReason}`));

  if (n.seats.length) {
    lines.push(sep);
    lines.push(row(`${col("seat", 13)}${col("state", 11)}${col("units", 8)}raised`));
    for (const seat of n.seats) {
      lines.push(row(`${col(seat.name, 13)}${col(seat.state, 11)}${col(unitsText(seat.unitsDone, seat.unitsTotal, "-"), 8)}${seat.raised ?? "-"}`));
    }
  }

  if (n.lenses.length) {
    lines.push(sep);
    lines.push(row(`${col("lens (completed units)", 22)}${col("P0", 4)}${col("P1", 4)}${col("P2", 4)}${col("nit", 5)}tot`));
    for (const l of n.lenses) {
      lines.push(row(`${col(l.name, 22)}${col(String(l.P0), 4)}${col(String(l.P1), 4)}${col(String(l.P2), 4)}${col(String(l.nit), 5)}${l.total}`));
    }
  }

  const statLines = [];
  if (hasUnits(n) || hasPasses(n)) {
    const noun = UNIT_NOUN[n.kind] ?? "units";
    const segs = [];
    if (hasUnits(n)) segs.push(`${noun}  ${progressBar(n.progress.unitsDone ?? 0, n.progress.unitsTotal ?? 0, 12)} ${unitsText(n.progress.unitsDone, n.progress.unitsTotal, "?")}`);
    if (hasPasses(n)) segs.push(`pass ${n.progress.passesDone ?? 0}/${n.progress.passesTotal ?? "?"}`);
    statLines.push(segs.join("   "));
  }
  if (hasGate(n)) {
    statLines.push(`gate   ${[n.gate.name ?? "gate", n.gate.target ? `-> ${n.gate.target}` : null].filter(Boolean).join(" ")}  [${n.gate.state ?? "?"}]`);
  }
  const counterEntries = COUNTER_KEYS.filter((k) => k in n.counters).map((k) => `${k} ${n.counters[k]}`);
  if (counterEntries.length) statLines.push(...packRows(counterEntries, "  ", inner - 2));
  if (hasBudget(n)) {
    const bTotal = n.budget.total;
    statLines.push(`budget ${bTotal != null && bTotal > 0 ? `${progressBar(n.budget.spent ?? 0, bTotal, 10)} ` : ""}${n.budget.spent ?? 0}/${bTotal ?? "?"}`);
  }
  if (statLines.length) {
    lines.push(sep);
    for (const l of statLines) lines.push(row(l));
  }

  if (n.recent.length) {
    lines.push(sep);
    for (const l of n.recent) lines.push(row(`· ${l}`));
  }
  lines.push(bot);
  return lines.join("\n");
}

function renderProgressMarkdown(state, { prior, nowMs } = {}) {
  if (state == null || typeof state !== "object" || Array.isArray(state)) return "_no council progress yet_";
  const version = state.schemaVersion;
  const n = normalizeProgressState(state);
  const kindLabel = (n.kind ?? "progress").replace(/-/g, " ");
  if (version != null && version !== PROGRESS_SCHEMA_VERSION) {
    return [
      `### ⚪ Council ${kindLabel}${n.jobId ? ` · \`${n.jobId}\`` : ""}`,
      `_unsupported progress schema (v${flat(String(version), 20)}) — update the council plugin to render this run_`
    ].join("\n");
  }

  const L = [];
  L.push(`### ${RUN_EMOJI[n.status] ?? "⚪"} Council ${kindLabel}${n.jobId ? ` · \`${n.jobId}\`` : ""}`);
  if (n.title) L.push(`_${n.title}_`);
  const meta = [`**${n.status}**`, ...progressTimeParts(n, nowMs)];
  if (n.phase || n.phaseDetail) meta.push(`phase \`${n.phase ?? "?"}\`${n.phaseDetail ? ` — ${n.phaseDetail}` : ""}`);
  L.push(meta.join(" · "));
  const pmWait = formatWaiting(n.waiting, nowMs);
  if (pmWait) L.push(`> ⏳ ${pmWait}`); // liveness callout: a backing-off / paused run is ALIVE, not hung
  L.push("");

  if (hasUnits(n) || hasPasses(n)) {
    const noun = UNIT_NOUN[n.kind] ?? "units";
    const segs = [];
    if (hasUnits(n)) segs.push(`\`${progressBar(n.progress.unitsDone ?? 0, n.progress.unitsTotal ?? 0, 12)}\` ${unitsText(n.progress.unitsDone, n.progress.unitsTotal, "?")} ${noun}`);
    if (hasPasses(n)) segs.push(`pass ${n.progress.passesDone ?? 0}/${n.progress.passesTotal ?? "?"}`);
    L.push(`**Progress** ${segs.join(" · ")}`);
    L.push("");
  }

  if (n.seats.length) {
    L.push("| Seat | State | Units | Raised |");
    L.push("|---|---|--:|--:|");
    for (const seat of n.seats) {
      L.push(`| ${SEAT_EMOJI[seat.state] ?? "⚪"} ${seat.name} | ${seat.state} | ${unitsText(seat.unitsDone, seat.unitsTotal, "–")} | ${seat.raised ?? "–"} |`);
    }
    L.push("");
  }

  if (n.lenses.length) {
    const cell = (v) => (v > 0 ? String(v) : "·");
    L.push("**Findings by lens** _(live over completed units)_");
    L.push("| Lens | Total | 🟥 P0 | 🟧 P1 | 🟨 P2 | ▫️ nit |");
    L.push("|---|--:|--:|--:|--:|--:|");
    for (const l of n.lenses) {
      L.push(`| ${l.name} | ${l.total} | ${cell(l.P0)} | ${cell(l.P1)} | ${cell(l.P2)} | ${cell(l.nit)} |`);
    }
    L.push("");
  }

  if (hasGate(n)) {
    L.push(`**Gate** ${GATE_EMOJI[n.gate.state] ?? "⚪"} \`${n.gate.name ?? "gate"}\`${n.gate.target ? ` → \`${n.gate.target}\`` : ""}${n.gate.state ? ` — ${n.gate.state}` : ""}`);
  }
  const counterEntries = COUNTER_KEYS.filter((k) => k in n.counters).map((k) => `${k} ${n.counters[k]}`);
  if (counterEntries.length) L.push(`**Counters** ${counterEntries.join(" · ")}`);
  if (hasBudget(n)) {
    const bTotal = n.budget.total;
    L.push(`**Budget** ${bTotal != null && bTotal > 0 ? `\`${progressBar(n.budget.spent ?? 0, bTotal, 10)}\` ` : ""}${n.budget.spent ?? 0}/${bTotal ?? "?"} spent`);
  }
  if (n.stopReason) L.push(`**Stopped** — ${n.stopReason}`);

  if (n.recent.length) {
    L.push("");
    L.push("**Recent**");
    for (const l of n.recent) L.push(`- ${l}`);
  }

  // Δ vs the caller-persisted previous snapshot (a prior progress.json). Prior
  // runs through the same normalizer, so a garbage prior degrades to "no delta".
  if (prior != null && typeof prior === "object" && !Array.isArray(prior)) {
    const p = normalizeProgressState(prior);
    const d = [];
    if (p.phase && n.phase && p.phase !== n.phase) d.push(`phase \`${p.phase}\` → \`${n.phase}\``);
    const pu = p.progress?.unitsDone;
    const cu = n.progress?.unitsDone;
    if (pu != null && cu != null && pu !== cu) d.push(`${UNIT_NOUN[n.kind] ?? "units"} ${pu}→${cu}`);
    const pp = p.progress?.passesDone;
    const cp = n.progress?.passesDone;
    if (pp != null && cp != null && pp !== cp) d.push(`pass ${pp}→${cp}`);
    for (const k of COUNTER_KEYS) {
      const a = p.counters[k];
      const b = n.counters[k];
      if (a != null && b != null && a !== b) d.push(`${b - a > 0 ? "+" : ""}${b - a} ${k}`);
    }
    if (d.length) {
      L.push("");
      L.push(`_Δ since last update: ${d.join(" · ")}_`);
    }
  }

  // Honest limit: aggregation is over COMPLETED units/cells — a single model's
  // review streams no partials (the subprocess returns one block at the end).
  // Say so rather than implying token-level liveness the pipeline can't give.
  if ((n.seats.length || n.lenses.length) && !n.done) {
    L.push("");
    L.push("_live over completed units · no token streaming during a single review_");
  }
  return L.join("\n");
}

/**
 * Universal dashboard for a progress.json state of ANY kind.
 * `renderProgressDashboard(progressState, { md = false, prior = null, nowMs, width } = {})`
 * md=false: a plain ASCII box for a TTY (pipe through colorize() for ANSI accents;
 * `width` is the total box width incl. borders, clamped 44..140, default 60).
 * md=true: a chat markdown snapshot (emoji seat table, gate, counters, budget,
 * ETA, and a `Δ since last update` line vs the `prior` snapshot).
 * TOTAL: never throws - partial/null/garbage input renders what it can, and an
 * unknown schemaVersion renders a minimal safe header.
 */
export function renderProgressDashboard(progressState, opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const md = o.md === true;
  try {
    return md
      ? renderProgressMarkdown(progressState, { prior: o.prior ?? null, nowMs: o.nowMs })
      : renderProgressBox(progressState, { nowMs: o.nowMs, width: o.width });
  } catch {
    // Last-resort totality: a dashboard render error must never take down the watcher.
    return md ? "_council progress unavailable (render error)_" : "council progress unavailable (render error)";
  }
}

// --- Rich run dashboard (progress.json + live per-model provider USAGE) --------
// The markdown box the user approved for a long `audit fix --loop`: the plain
// kind-agnostic progress markdown PLUS a per-seat quota/token/ceiling table and a
// ceiling status line. usage/ceiling are PASSED IN (no I/O here) so this stays PURE
// + TOTAL. Without a usage snapshot it degrades to the plain progress box.

const RUN_SEAT_KEYS = new Set(["claude", "codex", "grok"]);

// Compact a token count: 45000 -> "45k", 1_200_000 -> "1.2M", small stays exact.
function compactTokens(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "–";
  const fmt = (x, suffix) => `${x.toFixed(1).replace(/\.0$/, "")}${suffix}`;
  const abs = Math.abs(n);
  if (abs >= 1e6) return fmt(n / 1e6, "M");
  if (abs >= 1e3) return fmt(n / 1e3, "k");
  return String(Math.round(n));
}

// A percent rendered with at most one decimal (14 -> "14%", 6.5 -> "6.5%").
const fmtPct = (p) => (Number.isFinite(Number(p)) ? `${Math.round(Number(p) * 10) / 10}%` : "–");

// A tiny 5-cell usage bar (used/limit) for the seat table's Ceiling column.
function tinyBar(used, limit, width = 5) {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return "";
  const filled = Math.max(0, Math.min(width, Math.round((used / limit) * width)));
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

// Map a seat name onto its provider usage record ({key,model}); unknown/OpenRouter
// seats have no provider quota → {key:null, model:null} so their row shows dashes.
function usageForSeat(usage, name) {
  const key = String(name ?? "").trim().toLowerCase();
  if (RUN_SEAT_KEYS.has(key) && usage && typeof usage[key] === "object" && usage[key]) return { key, model: usage[key] };
  return { key: null, model: null };
}

// Pretty run-kind labels + per-counter emoji for the polished markdown box.
const RUN_KIND_LABEL = {
  "audit-fix-loop": "Audit Fix · Loop",
  "audit-review": "Audit Review",
  "audit-endless": "Audit Endless",
  build: "Build",
  plan: "Plan",
  deliberate: "Deliberate"
};
const COUNTER_EMOJI = { fixed: "✅", proposed: "📋", reverted: "↩", committed: "📦", skipped: "⏭" };

function prettyRunKind(kind, title) {
  const base =
    RUN_KIND_LABEL[kind] ?? String(kind ?? "run").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return typeof title === "string" && /--deep\b/.test(title) ? `${base} + Deep` : base;
}

// "seit letztem Update"-Delta: phase/pass moves, counter deltas, findings-total delta, and per-model
// weekly-quota moves (prior usage comes from the prior progress.json's stashed `usage`). TOTAL.
function buildRunDelta(n, usage, prior) {
  if (prior == null || typeof prior !== "object" || Array.isArray(prior)) return null;
  const p = normalizeProgressState(prior);
  const d = [];
  if (p.phase && n.phase && p.phase !== n.phase) d.push(`Phase ${p.phase}→${n.phase}`);
  const pp = p.progress?.passesDone;
  const cp = n.progress?.passesDone;
  if (pp != null && cp != null && pp !== cp) d.push(`Pass ${pp}→${cp}`);
  for (const k of COUNTER_KEYS) {
    const a = p.counters[k];
    const b = n.counters[k];
    if (a != null && b != null && b !== a) d.push(`${b - a > 0 ? "+" : ""}${b - a} ${k}`);
  }
  const pf = (p.lenses || []).reduce((s, l) => s + (l.total || 0), 0);
  const cf = (n.lenses || []).reduce((s, l) => s + (l.total || 0), 0);
  if (cf !== pf) d.push(`${cf - pf > 0 ? "+" : ""}${cf - pf} Funde`);
  const priorUsage = prior.usage && typeof prior.usage === "object" ? prior.usage : null;
  if (priorUsage && usage && typeof usage === "object") {
    for (const k of ["claude", "codex", "grok"]) {
      const a = Number(priorUsage[k]?.weekPercent);
      const b = Number(usage[k]?.weekPercent);
      if (Number.isFinite(a) && Number.isFinite(b) && a !== b) d.push(`${k[0].toUpperCase()}${k.slice(1)} ${a}→${b}%`);
    }
  }
  return d.length ? d.join(" · ") : null;
}

function renderRunDashboardMarkdown(progressState, { usage, ceiling, prior, nowMs }) {
  const n = normalizeProgressState(progressState);
  const L = [];

  // Header (h2) + a single status line: state · pass · elapsed/ETA · units bar · phase detail.
  L.push(`## ${RUN_EMOJI[n.status] ?? "⚪"} ${prettyRunKind(n.kind, n.title)}`);
  const status = [`\`${n.status}\``];
  if (hasPasses(n)) status.push(`**Pass ${n.progress.passesDone ?? 0}/${n.progress.passesTotal ?? "?"}**`);
  status.push(...progressTimeParts(n, nowMs));
  if (hasUnits(n)) status.push(`\`${progressBar(n.progress.unitsDone ?? 0, n.progress.unitsTotal ?? 0, 8)}\` ${unitsText(n.progress.unitsDone, n.progress.unitsTotal, "?")}`);
  if (n.phaseDetail) status.push(n.phaseDetail);
  L.push(status.join(" · "));
  const mdWait = formatWaiting(n.waiting, nowMs);
  if (mdWait) L.push(`> ⏳ ${mdWait}`); // liveness callout: a backing-off / paused run is ALIVE, not hung
  L.push("");

  // Seats & Quota — raised, weekly quota, Claude 5h, tokens this run, and a bar vs the ceiling.
  L.push("**Seats & Quota**");
  L.push("| Seat | raised | week | 5h | tokens | vs ceiling |");
  L.push("|:--|--:|--:|--:|--:|:--|");
  for (const seat of n.seats) {
    const { key, model } = usageForSeat(usage, seat.name);
    const avail = model != null && model.available === true; // quota columns only trust an AVAILABLE model
    const raised = seat.raised != null ? seat.raised : "–";
    const wk = avail && model.weekPercent != null ? `\`${fmtPct(model.weekPercent)}\`` : "–";
    // 5h window: any model that reports one (Claude always; Codex when active). Grok has none.
    const fiveH = avail && model.fiveHourPercent != null ? `\`${fmtPct(model.fiveHourPercent)}\`` : "–";
    const tok = model && model.tokens ? compactTokens(model.tokens.total) : "–";
    let ceil = "–";
    if (ceiling && avail) {
      const limit = Number(ceiling[key]);
      const used = Number(model.weekPercent);
      if (Number.isFinite(limit) && limit > 0 && Number.isFinite(used)) ceil = `\`${tinyBar(used, limit)}\` ${Math.round(used)}/${limit}`;
    }
    L.push(`| ${SEAT_EMOJI[seat.state] ?? "⚪"} ${seat.name} | ${raised} | ${wk} | ${fiveH} | ${tok} | ${ceil} |`);
  }
  L.push("");

  // Findings — severity-emoji column headers, Σ bold; the 🟥 P0 column only when a P0 exists.
  if (n.lenses.length) {
    const totalFindings = n.lenses.reduce((s, l) => s + (l.total || 0), 0);
    const anyP0 = n.lenses.some((l) => l.P0 > 0);
    const cell = (v) => (v > 0 ? String(v) : "·");
    L.push(`**Findings · ${totalFindings}**`);
    L.push(`| Lens |${anyP0 ? " 🟥 |" : ""} 🟧 | 🟨 | ▫️ | Σ |`);
    L.push(`|:--|${anyP0 ? "--:|" : ""}--:|--:|--:|--:|`);
    for (const l of n.lenses) {
      L.push(`| ${l.name} |${anyP0 ? ` ${cell(l.P0)} |` : ""} ${cell(l.P1)} | ${cell(l.P2)} | ${cell(l.nit)} | **${l.total}** |`);
    }
    L.push("");
  }

  // Applied · Ceiling · Gate on one line.
  const parts = [];
  const applied = COUNTER_KEYS.filter((k) => k in n.counters).map((k) => `${COUNTER_EMOJI[k] ?? ""} ${n.counters[k]}`.trim());
  if (applied.length) parts.push(`**Applied** ${applied.join(" · ")}`);
  if (ceiling && typeof ceiling === "object") {
    const c = ["claude", "codex", "grok"].map((k) => (Number.isFinite(Number(ceiling[k])) ? Number(ceiling[k]) : "–")).join("/");
    const { breached, breaches } = evaluateCeiling(usage, ceiling);
    parts.push(
      breached
        ? `⛔ **Ceiling** ${c} — ${breaches.map((b) => `${b.model} ${fmtPct(b.percent)}≥${b.ceiling}% (${b.window})`).join(", ")}`
        : `**Ceiling** ${c} ✓`
    );
  }
  if (hasGate(n)) parts.push(`**Gate** ${GATE_EMOJI[n.gate.state] ?? "⚪"} ${n.gate.name ?? "gate"}${n.gate.state ? ` ${n.gate.state}` : ""}`);
  if (parts.length) L.push(parts.join("  ·  "));
  if (n.stopReason) L.push(`**Stopped** — ${n.stopReason}`);

  // Δ since last update (counters + findings + quota moves).
  const delta = buildRunDelta(n, usage, prior);
  if (delta) L.push(`_Δ seit letztem Update: ${delta}_`);

  // Recent (last ~2, as quotes) + honest footer while running.
  if (n.recent.length) {
    L.push("");
    for (const l of n.recent.slice(-2)) L.push(`> ${l}`);
  }
  if (!n.done) L.push("\n_live über fertige Einheiten · kein Token-Streaming_");
  return L.join("\n");
}

/**
 * `renderRunDashboard(progressState, { usage = null, ceiling = null, prior = null, nowMs } = {})`
 * The rich markdown run box: the plain progress markdown PLUS a per-seat quota/token/ceiling
 * table and a ceiling status line, for a long `audit fix --loop`. usage/ceiling are the caller's
 * snapshot + parsed ceiling (no I/O here). PURE + TOTAL: with no usage it degrades to the plain
 * progress markdown, and any render error falls back to a safe one-liner (never throws).
 */
export function renderRunDashboard(progressState, opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const usage = o.usage && typeof o.usage === "object" && !Array.isArray(o.usage) ? o.usage : null;
  const ceiling = o.ceiling && typeof o.ceiling === "object" && !Array.isArray(o.ceiling) ? o.ceiling : null;
  try {
    // No usage snapshot → the plain kind-agnostic box (no quota columns).
    if (!usage) return renderProgressMarkdown(progressState, { prior: o.prior ?? null, nowMs: o.nowMs });
    return renderRunDashboardMarkdown(progressState, { usage, ceiling, prior: o.prior ?? null, nowMs: o.nowMs });
  } catch {
    return "_council run dashboard unavailable (render error)_";
  }
}

/**
 * Read+parse `${stateDir}/progress.json`. Fail-soft: null on any read/parse
 * error or a non-object payload (progress is best-effort telemetry, never load-
 * bearing). `readFile` is injectable so tests run with no real filesystem.
 */
export function readProgressState(stateDir, opts = {}) {
  try {
    const readFile = (opts && typeof opts === "object" ? opts.readFile : null) ?? ((p) => fs.readFileSync(p, "utf8"));
    const parsed = JSON.parse(readFile(path.join(String(stateDir ?? ""), "progress.json")));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * `council watch` with no explicit job must render whichever source is LIVE, not whichever
 * legacy job happens to be newest-created. Every long-running command now writes a universal
 * progress.json; a stale legacy job must never shadow a running command's progress. Returns
 * `{ kind: "progress" }` when the progress.json is at least as fresh as the newest job (ties
 * and untimestamped/absent jobs go to progress.json), else `{ kind: "job", job }`.
 * `progressState`/`job` may be null; `parseTs(v)` is injectable for tests (defaults to Date.parse).
 */
export function pickFreshestWatchSource(progressState, job, { parseTs = (v) => Date.parse(v) } = {}) {
  const tsOf = (v) => {
    const t = typeof v === "string" ? parseTs(v) : NaN;
    return Number.isFinite(t) ? t : null;
  };
  if (!progressState || typeof progressState !== "object") return { kind: "job", job: job ?? null };
  const progTs = tsOf(progressState.updatedAt) ?? 0;
  const jobTs = job ? tsOf(job.updatedAt) ?? tsOf(job.createdAt) ?? 0 : -1;
  // Liveness beats freshness: a FINISHED progress.json (done:true) must never shadow a still-running
  // job, and a terminal job must never shadow a live progress.json — a completed source can be stamped
  // a hair later than the one still doing work, so a pure updatedAt race would show a done dashboard
  // while the run continues. Prefer whichever source is non-terminal when the other has finished; only
  // when both agree on liveness fall back to the freshest stamp (ties/absent jobs -> progress).
  const progDone = progressState.done === true;
  const jobLive = job ? !isTerminal(job.status) : false;
  const jobTerminal = job ? isTerminal(job.status) : false;
  if (progDone && jobLive) return { kind: "job", job };
  if (jobTerminal && !progDone) return { kind: "progress" };
  return progTs >= jobTs ? { kind: "progress" } : { kind: "job", job };
}
