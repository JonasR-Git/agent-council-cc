import test from "node:test";
import assert from "node:assert/strict";

import {
  agentR1States,
  colorize,
  formatDashboard,
  formatDashboardMarkdown,
  formatDuration,
  isTerminal,
  progressBar,
  stripAnsi,
  summarizeCouncilExtras,
  summarizeFindings,
  summarizeProgress
} from "../plugins/council/scripts/lib/watch.mjs";

const LOG = [
  "Phase: collecting-context",
  "Phase: r1",
  "Phase: r1: grok done (1/2)",
  "Phase: r1: codex done (2/2)",
  "Phase: r1-done",
  "Phase: r2 (2 critiques)",
  "Phase: r2: grok->codex done (1/2)",
  "Deliberation stored (29871 chars)" // NOT a Phase: line - must be ignored
].join("\n");

const MERGED = {
  all: [
    { severity: "P1", agents: ["codex", "grok"], consensus: true, contested: false },
    { severity: "P1", agents: ["grok"], consensus: false, contested: true },
    { severity: "P2", agents: ["codex", "grok", "claude"], consensus: true, contested: false },
    { severity: "nit", agents: ["claude"], consensus: false, contested: false }
  ]
};

test("summarizeProgress ignores non-Phase banner lines for lastPhase", () => {
  const p = summarizeProgress(LOG);
  assert.deepEqual([...p.r1Done].sort(), ["codex", "grok"]);
  assert.equal(p.r2Done, 1);
  assert.equal(p.r2Total, 2);
  assert.equal(p.lastPhase, "r2: grok->codex done (1/2)");
});

test("summarizeProgress parses a live raised= count per agent", () => {
  const p = summarizeProgress(["Phase: r1: grok done (1/3) raised=9", "Phase: r1: codex done (2/3) raised=0", "Phase: r1: claude done (3/3)"].join("\n"));
  assert.equal(p.raisedByAgent.grok, 9);
  assert.equal(p.raisedByAgent.codex, 0);
  assert.equal(p.raisedByAgent.claude, undefined, "no suffix -> no live raised");
});

test("formatDashboardMarkdown renders a table, bars, status emoji, and severity squares", () => {
  const job = { id: "council-abc123", kind: "deliberate", status: "completed", createdAt: "2026-07-10T00:00:00Z", finishedAt: "2026-07-10T00:05:00Z" };
  const { markdown, snapshot } = formatDashboardMarkdown(job, summarizeProgress(LOG), { nowMs: Date.parse("2026-07-10T00:05:00Z"), findings: summarizeFindings(MERGED) });
  assert.match(markdown, /🟢 Council deliberate/, "status emoji for completed");
  assert.match(markdown, /\| Reviewer \| Verdict \| Raised \| Consensus \| Contested \|/, "a clearly-labelled table");
  assert.match(markdown, /Raised = findings this reviewer flagged/, "column legend");
  assert.match(markdown, /🟥 P0|🟧 P1/, "severity squares");
  assert.match(markdown, /🤝 2 consensus/, "consensus badge");
  assert.match(markdown, /\*\*2 must-fix\*\* \(P0\+P1\)/);
  assert.equal(snapshot.findingsTotal, 4);
});

test("formatDashboardMarkdown shows live raised before merge and a delta vs the prior snapshot", () => {
  const job = { id: "council-x", kind: "deliberate", status: "running", createdAt: "2026-07-10T00:00:00Z" };
  const progress = summarizeProgress(["Phase: r1: grok done (1/3) raised=5"].join("\n"));
  const prior = { phase: "r1", findingsTotal: 0, r1Count: 0, r2Done: 0, consensus: 0 };
  const { markdown } = formatDashboardMarkdown(job, progress, { nowMs: Date.parse("2026-07-10T00:01:00Z"), jobPhase: "r1: grok done (1/3)", skipped: ["claude"], prior });
  assert.match(markdown, /\| 🟢 grok \| – \| 5 \|/, "live raised from the log (verdict – until merge)");
  assert.match(markdown, /Δ since last update/, "delta line present");
  assert.match(markdown, /R1 0→1/, "delta shows R1 progress");
});

const DELIB = {
  r1: [
    { agent: "codex", findings: { verdict: "request_changes" } },
    { agent: "grok", findings: { verdict: "approve_with_nits" } },
    { agent: "claude", findings: { verdict: "block" } }
  ],
  merged: {
    all: [
      { severity: "P1", title: "Data loss on\nrollback", file: "a.mjs", line: 12, consensus: true, seenBefore: true, scope: "localized" },
      { severity: "P0", title: "Auth bypass", file: "b.mjs", consensus: true, seenBefore: false, scope: "localized" },
      { severity: "P2", title: "Dup logic", file: "c.mjs", consensus: false, seenBefore: false, scope: "cross-cutting" }
    ]
  },
  verification: { verifiedCount: 2, refutedCount: 1 }
};

test("summarizeCouncilExtras extracts verdicts, top must-fix, ledger split, verify, scope", () => {
  const x = summarizeCouncilExtras(DELIB);
  assert.deepEqual(x.verdicts, { codex: "request_changes", grok: "approve_with_nits", claude: "block" });
  assert.equal(x.topFindings.length, 2, "only P0/P1 are must-fix");
  assert.equal(x.topFindings[0].severity, "P0", "worst first");
  assert.doesNotMatch(x.topFindings[1].title, /\n/, "untrusted title newlines flattened");
  assert.deepEqual(x.ledger, { recurring: 1, fresh: 2 });
  assert.deepEqual(x.verify, { verified: 2, refuted: 1 });
  assert.deepEqual(x.scope, { localized: 2, crossCutting: 1 });
  assert.equal(summarizeCouncilExtras(null), null);
});

test("formatDashboardMarkdown neutralizes markdown injection in untrusted finding titles/files", () => {
  const delib = {
    verdicts: [],
    merged: { all: [{ severity: "P1", title: "evil `code` [link](http://x) | row", file: "a`b|c.mjs", scope: "localized", consensus: false }] },
    context: { branch: "m`a|in", target: { label: "t" } }
  };
  const { markdown } = formatDashboardMarkdown(
    { id: "c", kind: "deliberate", status: "completed", createdAt: "2026-07-10T00:00:00Z", finishedAt: "2026-07-10T00:01:00Z" },
    summarizeProgress(""),
    { nowMs: Date.parse("2026-07-10T00:01:00Z"), findings: summarizeFindings(delib.merged), extras: summarizeCouncilExtras(delib) }
  );
  assert.match(markdown, /evil 'code' link\(http/, "backticks -> ', brackets removed in the title");
  assert.doesNotMatch(markdown, /\[link\]/, "no link syntax survives");
  assert.doesNotMatch(markdown, /`code`/, "no title backtick survives (would break code spans)");
  assert.doesNotMatch(markdown, /m`a/, "branch is sanitized too");
});

test("summarizeCouncilExtras also reads the persisted verdicts[] array shape", () => {
  const persisted = { verdicts: [{ agent: "codex", verdict: "block" }, { agent: "grok", verdict: "approve" }], merged: { all: [] } };
  assert.deepEqual(summarizeCouncilExtras(persisted).verdicts, { codex: "block", grok: "approve" });
});

test("formatDashboardMarkdown renders verdict column, ledger/verify/scope lines, and a top must-fix list", () => {
  const job = { id: "council-z", kind: "deliberate", status: "completed", createdAt: "2026-07-10T00:00:00Z", finishedAt: "2026-07-10T00:05:00Z" };
  const { markdown } = formatDashboardMarkdown(job, summarizeProgress(LOG), {
    nowMs: Date.parse("2026-07-10T00:05:00Z"),
    findings: summarizeFindings(DELIB.merged),
    extras: summarizeCouncilExtras(DELIB)
  });
  assert.match(markdown, /\| Reviewer \| Verdict \| Raised \| Consensus \| Contested \|/, "verdict column present");
  assert.match(markdown, /⛔ block/, "claude verdict badge");
  assert.match(markdown, /♻️ 1 recurring.*🆕 2 new this run/, "ledger split labelled");
  assert.match(markdown, /🔬 2 held up · 1 refuted/, "verify line labelled");
  assert.match(markdown, /🎯 2 fixable in place · 📄 1 cross-cutting/, "scope split labelled");
  assert.match(markdown, /\*\*Top issues to fix first\*\*/);
  assert.match(markdown, /🟥 \*\*P0\*\* Auth bypass — `b\.mjs`/, "worst finding listed with file");
});

test("isTerminal treats cancelled and any non-active status as terminal", () => {
  assert.equal(isTerminal("running"), false);
  assert.equal(isTerminal("queued"), false);
  assert.equal(isTerminal("completed"), true);
  assert.equal(isTerminal("cancelled"), true);
  assert.equal(isTerminal("failed"), true);
  assert.equal(isTerminal(null), false);
});

test("agentR1States: session Claude is 'file', terminal reconciles, failed is unknown", () => {
  const midR1 = summarizeProgress("Phase: r1\nPhase: r1: grok done (1/2)");
  assert.equal(agentR1States(midR1, { claudeBackend: "session" }).claude, "file");
  assert.equal(agentR1States(midR1, { claudeBackend: "spawn" }).claude, "running");
  assert.equal(agentR1States(midR1, { claudeBackend: "spawn", status: "completed" }).codex, "done");
  assert.equal(agentR1States(midR1, { claudeBackend: "spawn", status: "failed" }).codex, "unknown");
  assert.equal(agentR1States(midR1, { skipped: ["codex"] }).codex, "skipped");
});

test("summarizeFindings counts totals, consensus, contested, per-severity, per-agent raised/shared", () => {
  const f = summarizeFindings(MERGED);
  assert.equal(f.total, 4);
  assert.equal(f.consensus, 2);
  assert.equal(f.unique, 2);
  assert.equal(f.contested, 1);
  assert.deepEqual(f.bySeverity, { P0: 0, P1: 2, P2: 1, nit: 1 });
  assert.deepEqual(f.byAgent.codex, { raised: 2, shared: 2, disputed: 0 });
  assert.deepEqual(f.byAgent.grok, { raised: 3, shared: 2, disputed: 1 });
  assert.deepEqual(f.byAgent.claude, { raised: 2, shared: 1, disputed: 0 });
});

test("summarizeFindings returns null when no merged findings exist yet", () => {
  assert.equal(summarizeFindings(undefined), null);
  assert.equal(summarizeFindings({}), null);
});

test("progressBar fills proportionally and renders neutral on unknown total", () => {
  assert.equal(progressBar(1, 2, 4), "██░░");
  assert.equal(progressBar(2, 2, 4), "████");
  assert.equal(progressBar(0, 0, 4), "░░░░");
});

test("formatDuration renders seconds and minutes", () => {
  assert.equal(formatDuration(65_000), "1m05s");
  assert.equal(formatDuration(-1), "-");
});

const COMPLETED_JOB = {
  id: "council-abc",
  title: "Council Deliberation",
  kind: "deliberate",
  status: "completed",
  createdAt: "2026-07-10T08:30:00.000Z",
  finishedAt: "2026-07-10T08:33:20.000Z"
};

test("formatDashboard (completed) shows the findings breakdown and a right-aligned box", () => {
  const out = formatDashboard(COMPLETED_JOB, summarizeProgress(LOG), {
    nowMs: Date.parse("2026-07-10T08:40:00.000Z"),
    etaMs: 180_000,
    findings: summarizeFindings(MERGED),
    claudeBackend: "session",
    jobPhase: "done"
  });
  assert.equal(out.terminal, true);
  assert.match(out.text, /council-abc/);
  assert.match(out.text, /claude\s+file/, "session Claude shows as file in the table");
  assert.match(out.text, /disputed/, "table has a disputed column");
  assert.match(out.text, /4 findings\s+│\s+2 consensus\s+│\s+2 unique\s+│\s+1 disputed/);
  assert.match(out.text, /severity\s+P1 2\s+P2 1\s+nit 1/);
  assert.match(out.text, /\/council:status --result council-abc/);

  // Alignment invariant: every bordered line has the same length.
  const borderLens = new Set(
    out.text.split("\n").filter((l) => /^[║╔╟╠╚]/.test(l)).map((l) => l.length)
  );
  assert.equal(borderLens.size, 1, "all box lines must be equal width");
});

test("completed dashboard highlights the must-fix (P0/P1) count", () => {
  const out = formatDashboard(COMPLETED_JOB, summarizeProgress(LOG), {
    nowMs: Date.parse("2026-07-10T08:40:00.000Z"),
    findings: summarizeFindings(MERGED),
    jobPhase: "done"
  });
  assert.match(out.text, /must-fix  2 \(P0\/P1\)/); // MERGED: P0 0 + P1 2
});

test("no R2 bar and a 'status' column for non-deliberate modes", () => {
  const reviewJob = {
    id: "council-r",
    title: "Council Review",
    kind: "review",
    status: "completed",
    createdAt: "2026-07-10T08:30:00.000Z",
    finishedAt: "2026-07-10T08:31:00.000Z"
  };
  const out = formatDashboard(reviewJob, summarizeProgress("Phase: r1\nPhase: r1: codex done (1/2)"), {
    nowMs: Date.parse("2026-07-10T08:40:00.000Z"),
    findings: null,
    jobPhase: "done"
  });
  assert.doesNotMatch(out.text, /R2 {2}/, "a review has no peer round -> no R2 bar");
  assert.match(out.text, /agent\s+status\s+raised/, "non-deliberate uses a 'status' column");
  assert.match(out.text, /see \/council:status --result/, "terminal-but-no-merged-findings points at the report, not 'pending'");
});

test("colorize is layout-neutral: strips back to the exact plain text, same widths", () => {
  const out = formatDashboard(COMPLETED_JOB, summarizeProgress(LOG), {
    nowMs: Date.parse("2026-07-10T08:40:00.000Z"),
    findings: summarizeFindings(MERGED),
    claudeBackend: "session",
    jobPhase: "done"
  });
  const colored = colorize(out.text);
  assert.notEqual(colored, out.text, "should inject ANSI escapes");
  assert.equal(stripAnsi(colored), out.text, "stripping ANSI returns the exact plain text");
  const plain = out.text.split("\n");
  const paint = colored.split("\n");
  for (let i = 0; i < plain.length; i += 1) {
    assert.equal(stripAnsi(paint[i]).length, plain[i].length, `line ${i} visible width unchanged`);
  }
});

test("formatDashboard (running) shows remaining time and 'pending' findings", () => {
  const job = { id: "council-xyz", title: "Council Deliberation", kind: "deliberate", status: "running", createdAt: "2026-07-10T08:30:00.000Z" };
  const out = formatDashboard(job, summarizeProgress("Phase: r1\nPhase: r1: grok done (1/2)"), {
    nowMs: Date.parse("2026-07-10T08:32:00.000Z"), // 2 min elapsed
    etaMs: 600_000, // 10 min median -> ~8 min left
    findings: null,
    jobPhase: "r1: grok done (1/2)"
  });
  assert.equal(out.terminal, false);
  assert.match(out.text, /~8m00s left/);
  assert.match(out.text, /pending — available/);
});
