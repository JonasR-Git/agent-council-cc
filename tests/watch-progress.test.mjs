import test from "node:test";
import assert from "node:assert/strict";

import { readProgressState, renderProgressDashboard } from "../plugins/council/scripts/lib/watch.mjs";
import { makeProgressReporter } from "../plugins/council/scripts/lib/progress.mjs";

// A full audit-fix-loop snapshot exercising every section of the contract.
const FIXLOOP = {
  schemaVersion: 1,
  kind: "audit-fix-loop",
  jobId: "fixloop-42",
  title: "audit fix --loop --chartest",
  startedAt: "2026-07-12T10:00:00Z",
  updatedAt: "2026-07-12T10:04:00Z",
  phase: "fix",
  phaseDetail: "applying tier-0 batch",
  seats: [
    { name: "codex", state: "reviewing", unitsDone: 3, unitsTotal: 10, raised: 2 },
    { name: "grok", state: "done", unitsDone: 10, unitsTotal: 10, raised: 5 },
    { name: "claude", state: "idle", unitsDone: 0, unitsTotal: 10, raised: 0 },
    { name: "or-deepseek", state: "error", unitsDone: 1, unitsTotal: 10, raised: 1 }
  ],
  progress: { unitsDone: 12, unitsTotal: 20, passesDone: 1, passesTotal: 3 },
  counters: { fixed: 3, proposed: 5, reverted: 1, skipped: 2, committed: 2 },
  gate: { name: "char-test", target: "lib/audit-fix.mjs", state: "running" },
  budget: { spent: 12, total: 40 },
  etaMs: 120_000,
  recentLines: ["pass 1: 5 findings gated", "fix: applied 3 of 5", "gate: char-test running"],
  done: false,
  ok: null,
  stopReason: null
};
const NOW = Date.parse("2026-07-12T10:04:00Z");

test("TTY box on a full audit-fix-loop state shows phase, seats, gate, counters, budget, ETA", () => {
  const out = renderProgressDashboard(FIXLOOP, { nowMs: NOW });
  assert.equal(typeof out, "string");
  assert.match(out, /COUNCIL AUDIT FIX LOOP/, "kind headline");
  assert.match(out, /audit fix --loop --chartest/, "title line");
  assert.match(out, /fixloop-42 {2}│ {2}running {2}│ {2}4m00s {2}│ {2}~2m00s left/, "meta: id, status, elapsed, ETA");
  assert.match(out, /phase {2}fix — applying tier-0 batch/, "phase + detail");
  assert.match(out, /codex {8}reviewing {2}3\/10/, "seat row with units");
  assert.match(out, /or-deepseek {2}error/, "openrouter seat rendered too");
  assert.match(out, /units {2}[█░]{12} 12\/20 {3}pass 1\/3/, "overall bar + passes");
  assert.match(out, /gate {3}char-test -> lib\/audit-fix\.mjs {2}\[running\]/, "gate with target and state");
  assert.match(out, /fixed 3 {2}proposed 5 {2}reverted 1 {2}skipped 2 {2}committed 2/, "all five counters");
  assert.match(out, /budget [█░]{10} 12\/40/, "budget bar spent/total");
  assert.match(out, /· gate: char-test running/, "recent lines included");

  // Alignment invariant: every bordered line has the same length (default 60).
  const lens = new Set(out.split("\n").map((l) => l.length));
  assert.equal(lens.size, 1, "all box lines must be equal width");
  assert.equal([...lens][0], 60);
});

test("TTY box respects a custom width and clamps absurd ones without throwing", () => {
  const wide = renderProgressDashboard(FIXLOOP, { nowMs: NOW, width: 100 });
  assert.equal(new Set(wide.split("\n").map((l) => l.length)).size, 1);
  assert.equal(wide.split("\n")[0].length, 100);
  const tiny = renderProgressDashboard(FIXLOOP, { nowMs: NOW, width: 5 });
  assert.equal(tiny.split("\n")[0].length, 44, "clamped to the minimum");
  const garbage = renderProgressDashboard(FIXLOOP, { nowMs: NOW, width: "wat" });
  assert.equal(garbage.split("\n")[0].length, 60, "non-numeric width -> default");
});

test("a build state shows steps (not units) and works without seats/gate/counters", () => {
  const build = {
    schemaVersion: 1,
    kind: "build",
    jobId: "build-7",
    title: "council build docs/plan-build-design.md",
    startedAt: "2026-07-12T09:00:00Z",
    phase: "integration",
    phaseDetail: "step 3: wire renderer",
    progress: { unitsDone: 2, unitsTotal: 6 },
    recentLines: ["step 2 done: reporter"],
    done: false
  };
  const out = renderProgressDashboard(build, { nowMs: Date.parse("2026-07-12T09:10:00Z") });
  assert.match(out, /COUNCIL BUILD/);
  assert.match(out, /steps {2}[█░]{12} 2\/6/, "step-labelled progress bar");
  assert.doesNotMatch(out, /seat {2}/, "no seat table when there are no seats");
  assert.doesNotMatch(out, /gate {2}/, "no gate line when gate is null");
  const md = renderProgressDashboard(build, { md: true, nowMs: Date.parse("2026-07-12T09:10:00Z") });
  assert.match(md, /2\/6 steps/, "markdown names the steps too");
  assert.match(md, /phase `integration` — step 3: wire renderer/);
});

test("md=true renders a valid markdown table with emoji seat states, gate, counters, budget, ETA", () => {
  const md = renderProgressDashboard(FIXLOOP, { md: true, nowMs: NOW });
  assert.match(md, /^### 🟡 Council audit fix loop · `fixloop-42`/, "status emoji headline");
  assert.match(md, /_audit fix --loop --chartest_/, "title as subtitle");
  assert.match(md, /\*\*running\*\* · 4m00s · ~2m00s left · phase `fix` — applying tier-0 batch/);
  assert.match(md, /\*\*Progress\*\* `[█░]{12}` 12\/20 units · pass 1\/3/, "unicode bar in a code span");
  assert.match(md, /\| Seat \| State \| Units \| Raised \|/, "table header");
  assert.match(md, /\| 🟢 codex \| reviewing \| 3\/10 \| 2 \|/, "reviewing seat");
  assert.match(md, /\| ✅ grok \| done \| 10\/10 \| 5 \|/, "done seat");
  assert.match(md, /\| ⚪ claude \| idle \| 0\/10 \| 0 \|/, "idle seat");
  assert.match(md, /\| 🔴 or-deepseek \| error \| 1\/10 \| 1 \|/, "error seat");
  assert.match(md, /\*\*Gate\*\* 🟡 `char-test` → `lib\/audit-fix\.mjs` — running/);
  assert.match(md, /\*\*Counters\*\* fixed 3 · proposed 5 · reverted 1 · skipped 2 · committed 2/);
  assert.match(md, /\*\*Budget\*\* `[█░]{10}` 12\/40 spent/);
  assert.match(md, /\*\*Recent\*\*\n- pass 1: 5 findings gated/);

  // Structural validity: every table line has the same column count.
  const tableLines = md.split("\n").filter((l) => l.startsWith("|"));
  assert.equal(tableLines.length, 6, "header + separator + 4 seats");
  const cols = tableLines[0].split("|").length;
  for (const l of tableLines) assert.equal(l.split("|").length, cols, "consistent column count");
});

test("md=true shows a Δ since last update line vs the prior snapshot", () => {
  const prior = {
    ...FIXLOOP,
    phase: "review",
    progress: { ...FIXLOOP.progress, unitsDone: 10, passesDone: 0 },
    counters: { ...FIXLOOP.counters, fixed: 1, committed: 2 }
  };
  const md = renderProgressDashboard(FIXLOOP, { md: true, nowMs: NOW, prior });
  assert.match(md, /Δ since last update/);
  assert.match(md, /phase `review` → `fix`/);
  assert.match(md, /units 10→12/);
  assert.match(md, /pass 0→1/);
  assert.match(md, /\+2 fixed/, "counter delta with sign");
  assert.doesNotMatch(md, /[-+]\d+ committed/, "unchanged counters produce no delta");
});

test("no Δ line when prior is missing, unchanged, or garbage", () => {
  assert.doesNotMatch(renderProgressDashboard(FIXLOOP, { md: true, nowMs: NOW }), /Δ since/);
  assert.doesNotMatch(renderProgressDashboard(FIXLOOP, { md: true, nowMs: NOW, prior: FIXLOOP }), /Δ since/);
  assert.doesNotMatch(renderProgressDashboard(FIXLOOP, { md: true, nowMs: NOW, prior: "garbage" }), /Δ since/);
});

test("a finished failed run shows failed status and the stop reason", () => {
  const s = {
    schemaVersion: 1,
    kind: "audit-endless",
    jobId: "endless-1",
    startedAt: "2026-07-12T08:00:00Z",
    updatedAt: "2026-07-12T09:00:00Z",
    phase: "failed",
    etaMs: 5000,
    done: true,
    ok: false,
    stopReason: "budget exhausted"
  };
  const out = renderProgressDashboard(s, { nowMs: Date.parse("2026-07-12T12:00:00Z") });
  assert.match(out, /endless-1 {2}│ {2}failed {2}│ {2}60m00s/, "failed status; elapsed frozen at updatedAt, not nowMs");
  assert.match(out, /stop {3}budget exhausted/);
  assert.doesNotMatch(out, /left/, "no ETA once the run is done");
  const md = renderProgressDashboard(s, { md: true, nowMs: Date.parse("2026-07-12T12:00:00Z") });
  assert.match(md, /^### 🔴 Council audit endless/);
  assert.match(md, /\*\*failed\*\*/);
  assert.match(md, /\*\*Stopped\*\* — budget exhausted/);
});

test("TOTAL: null/partial/garbage states render without throwing, in both modes", () => {
  const cases = [
    null,
    undefined,
    42,
    "hi",
    [],
    {},
    { schemaVersion: 1 },
    { schemaVersion: 1, phase: "review" },
    {
      schemaVersion: 1,
      kind: 7,
      jobId: {},
      title: ["x"],
      startedAt: 123,
      updatedAt: "not a date",
      seats: "nope",
      progress: 7,
      counters: [1, 2],
      gate: "x",
      budget: { spent: "12", total: NaN },
      etaMs: "soon",
      recentLines: { a: 1 },
      done: "yes",
      ok: "maybe",
      stopReason: 9
    },
    { schemaVersion: 1, seats: [null, "x", { name: 1, state: {}, unitsDone: "3" }] }
  ];
  for (const state of cases) {
    for (const md of [false, true]) {
      const out = renderProgressDashboard(state, { md });
      assert.equal(typeof out, "string", `renders a string for ${JSON.stringify(state)} md=${md}`);
      assert.ok(out.length > 0);
    }
  }
  // Explicit null/garbage opts must not throw either.
  assert.equal(typeof renderProgressDashboard(FIXLOOP, null), "string");
  assert.equal(typeof renderProgressDashboard(FIXLOOP, "opts?"), "string");
  assert.equal(typeof renderProgressDashboard(FIXLOOP), "string", "nowMs omitted -> falls back to updatedAt");
});

test("a partial state simply omits missing sections instead of inventing them", () => {
  const out = renderProgressDashboard({ schemaVersion: 1, kind: "plan", jobId: "p1", phase: "council" }, {});
  assert.match(out, /COUNCIL PLAN/);
  assert.match(out, /phase {2}council/);
  assert.doesNotMatch(out, /seat/, "no seats section");
  assert.doesNotMatch(out, /budget/, "no budget line");
  assert.doesNotMatch(out, /gate/, "no gate line");
  const md = renderProgressDashboard({ schemaVersion: 1, kind: "plan", jobId: "p1", phase: "council" }, { md: true });
  assert.doesNotMatch(md, /\| Seat \|/, "no empty table in markdown");
  assert.doesNotMatch(md, /\*\*Counters\*\*/);
});

test("an unknown schemaVersion renders a minimal safe fallback, never seats/counters", () => {
  const future = { ...FIXLOOP, schemaVersion: 99 };
  const out = renderProgressDashboard(future, { nowMs: NOW });
  assert.match(out, /unsupported progress schema \(v99\)/);
  assert.match(out, /fixloop-42/, "still identifies the job");
  assert.doesNotMatch(out, /codex/, "no seat details from an unknown schema");
  const md = renderProgressDashboard(future, { md: true, nowMs: NOW });
  assert.match(md, /^### ⚪ Council audit fix loop · `fixloop-42`/);
  assert.match(md, /unsupported progress schema \(v99\)/);
  assert.doesNotMatch(md, /\| Seat \|/);
  // Non-numeric versions fall back too (and are sanitized).
  assert.match(renderProgressDashboard({ schemaVersion: "2.0|`x`" }, { md: true }), /unsupported progress schema/);
});

test("markdown injection in untrusted reporter strings is neutralized", () => {
  const evil = {
    schemaVersion: 1,
    kind: "audit-review",
    jobId: "j`1`|x",
    title: "pwn `code` [link](http://x) | row",
    phase: "review",
    seats: [{ name: "co|dex`", state: "reviewing" }],
    gate: { name: "§6-council`", target: "a|b.mjs", state: "running" },
    recentLines: ["evil | `tick` [z](u)"]
  };
  const md = renderProgressDashboard(evil, { md: true });
  assert.doesNotMatch(md, /`code`/, "no title backtick survives");
  assert.doesNotMatch(md, /\[link\]/, "no link syntax survives");
  assert.doesNotMatch(md, /co\|dex/, "seat name pipes cannot break the table");
  assert.match(md, /§6-council/, "benign non-ASCII like § is kept");
});

test("readProgressState reads+parses via the injected readFile", () => {
  let seenPath = null;
  const state = readProgressState("/state/dir", {
    readFile: (p) => {
      seenPath = p;
      return JSON.stringify(FIXLOOP);
    }
  });
  assert.equal(state.kind, "audit-fix-loop");
  assert.equal(state.seats.length, 4);
  assert.match(String(seenPath), /progress\.json$/, "reads <stateDir>/progress.json");
  assert.match(String(seenPath).replace(/\\/g, "/"), /state\/dir/, "under the given state dir");
});

test("readProgressState fail-softs to null on any read/parse error or non-object payload", () => {
  assert.equal(readProgressState("/d", { readFile: () => { throw new Error("ENOENT"); } }), null);
  assert.equal(readProgressState("/d", { readFile: () => "not json{" }), null);
  assert.equal(readProgressState("/d", { readFile: () => "null" }), null);
  assert.equal(readProgressState("/d", { readFile: () => '"a string"' }), null);
  assert.equal(readProgressState("/d", { readFile: () => "[1,2]" }), null);
  assert.equal(readProgressState(null, { readFile: () => { throw new Error("bad dir"); } }), null);
  // Default (real fs) readFile on a missing dir is also fail-soft.
  assert.equal(readProgressState("Z:/definitely/not/here-" + Date.now()), null);
});

// --- Writer -> reader round-trip (the real on-disk contract, not a hand-built state) ---

// Drive a real reporter, capture the exact JSON it persists, parse it back, and
// render it — so the writer's empty-vs-real-data contract is exercised end to end.
function driveAndRead(fn) {
  let last = null;
  const reporter = makeProgressReporter({
    kind: "plan",
    title: "council plan",
    jobId: "rt-1",
    stateDir: "/state",
    now: () => "2026-07-13T00:00:00Z",
    writeFile: (_file, data) => {
      last = data;
    }
  });
  fn(reporter);
  return JSON.parse(last);
}

test("round-trip: a run that reports no units/counters renders NO zero bar or zero counters", () => {
  // The P1 case: writer must not persist zero-filled progress/counters, so the
  // reader can't mistake "not measured" for a real 0.
  const state = driveAndRead((r) => {
    r.phase("council");
    r.done({ ok: true });
  });
  const box = renderProgressDashboard(state, { nowMs: Date.parse("2026-07-13T00:01:00Z") });
  const md = renderProgressDashboard(state, { md: true });
  for (const out of [box, md]) {
    assert.ok(!/0\/0/.test(out), "no 0/0 units bar for an unmeasured run");
    assert.ok(!/fixed 0|proposed 0|committed 0/.test(out), "no zero counters for an unmeasured run");
  }
});

test("round-trip: reported units/counters/findings DO render (bar, counters, lens table)", () => {
  const state = driveAndRead((r) => {
    r.phase("review", "6 files");
    r.progress({ unitsDone: 3, unitsTotal: 6 });
    r.counter("proposed", 2);
    r.findings(
      [
        { lens: "correctness", severity: "P0" },
        { lens: "correctness", severity: "nit" },
        { lens: "security", severity: "P1" }
      ],
      { seat: "grok" }
    );
    r.seat("grok", { state: "reviewing", unitsDone: 3, unitsTotal: 6 });
  });
  // The persisted state proves empty sections stayed absent, real ones present.
  assert.deepEqual(state.progress, { unitsDone: 3, unitsTotal: 6 });
  assert.deepEqual(state.counters, { proposed: 2 });
  assert.equal(state.findingsByLens.correctness.total, 2);

  const md = renderProgressDashboard(state, { md: true });
  assert.match(md, /3\/6 steps/); // kind "plan" labels units as steps
  assert.match(md, /proposed 2/);
  assert.match(md, /Findings by lens/);
  assert.match(md, /correctness/);
  assert.match(md, /\| correctness \| 2 \|/); // total column
  assert.match(md, /no token streaming/); // honest-limit footer while running

  const box = renderProgressDashboard(state, {});
  assert.match(box, /lens/);
  assert.match(box, /correctness/);
});
