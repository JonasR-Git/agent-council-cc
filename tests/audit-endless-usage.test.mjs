import assert from "node:assert/strict";
import test from "node:test";

import { runEndless } from "../plugins/council/scripts/lib/audit-endless.mjs";
import { parsePause5hOption, parseUsageCeiling } from "../plugins/council/scripts/lib/usage-guard.mjs";
import { makeProgressReporter } from "../plugins/council/scripts/lib/progress.mjs";

// The review-only endless loop now honours the SAME two quota guards as the fix-loop, through the
// shared decision helper. FAIL-SOFT is the load-bearing invariant: a flaky/unknown usage read must
// NEVER stop or pause a long unattended run. Every side effect (readUsage, now, sleep, checkpoint) is
// injected so these need no clock/fs/network.

const f = (file, title, extra = {}) => ({ severity: "P2", file, title, ...extra });
const noCheckpoint = () => {};
const CEILING = { claude: 40, codex: 50, grok: 40 };

const underSnap = () => ({ claude: { available: false, weekPercent: null }, codex: { available: true, weekPercent: 5 }, grok: { available: false } });
const overCodexSnap = () => ({ claude: { available: false, weekPercent: null }, codex: { available: true, weekPercent: 80 }, grok: { available: false } });

// Each pass raises a NEW finding so the loop never converges dry on its own — only a guard can stop it.
const freshEveryPass = () => {
  let p = 0;
  return async () => ({ findings: [f(`m${p}.mjs`, `bug ${p++}`)], coverage: { budgetSpent: 1 } });
};

// --- --usage-ceiling ----------------------------------------------------------

test("--usage-ceiling STOPS endless between passes on a confirmed breach (over on pass 2)", async () => {
  let usageCalls = 0;
  const readUsage = async () => (++usageCalls >= 2 ? overCodexSnap() : underSnap());
  const out = await runEndless(
    "/x",
    { maxPasses: 10, dryStreak: 5, budget: 40, usageCeiling: CEILING },
    { review: freshEveryPass(), readUsage, checkpoint: noCheckpoint }
  );
  assert.match(out.stopReason, /usage-ceiling/);
  assert.match(out.stopReason, /codex 80%≥50% \(weekly\)/);
  assert.equal(out.passesRun, 2, "ran pass 1 (under) then stopped after pass 2 (over) — no extra pass");
  assert.equal(out.pause, undefined, "a ceiling stop is terminal, not a pause");
});

test("--usage-ceiling under the ceiling → endless runs to its normal convergence (no usage stop)", async () => {
  let p = 0;
  const review = async () => (p++ === 0 ? { findings: [f("a.mjs", "bug")], coverage: { budgetSpent: 1 } } : { findings: [], coverage: { budgetSpent: 1 } });
  const out = await runEndless("/x", { maxPasses: 20, dryStreak: 2, budget: 40, usageCeiling: CEILING }, { review, readUsage: async () => underSnap(), checkpoint: noCheckpoint });
  assert.match(out.stopReason, /diminishing/);
  assert.ok(!/usage-ceiling/.test(out.stopReason ?? ""));
});

test("--usage-ceiling FAIL-SOFT: a THROWING readUsage never crashes or stops endless", async () => {
  const out = await runEndless(
    "/x",
    { maxPasses: 3, dryStreak: 5, budget: 40, usageCeiling: CEILING },
    { review: freshEveryPass(), readUsage: async () => { throw new Error("provider network down"); }, checkpoint: noCheckpoint }
  );
  assert.match(out.stopReason, /max passes/, "a usage-read failure is treated as not-breached; the loop runs to its normal bound");
  assert.ok(!/usage-ceiling/.test(out.stopReason ?? ""));
});

test("--usage-ceiling FAIL-SOFT: an UNKNOWN/unavailable snapshot never stops endless, even at 99%", async () => {
  const readUsage = async () => ({ claude: { available: false, weekPercent: 99 }, codex: { available: false, weekPercent: 99 }, grok: { available: false, weekPercent: 99 } });
  const out = await runEndless("/x", { maxPasses: 3, dryStreak: 5, budget: 40, usageCeiling: CEILING }, { review: freshEveryPass(), readUsage, checkpoint: noCheckpoint });
  assert.ok(!/usage-ceiling/.test(out.stopReason ?? ""), "unknown usage can never stop the loop");
  assert.match(out.stopReason, /max passes/);
});

test("no guards → endless never reads usage (zero overhead / byte-identical to today)", async () => {
  let usageCalls = 0;
  let p = 0;
  const review = async () => (p++ === 0 ? { findings: [f("a.mjs", "bug")], coverage: { budgetSpent: 1 } } : { findings: [], coverage: { budgetSpent: 1 } });
  await runEndless("/x", { maxPasses: 20, dryStreak: 2, budget: 40 }, { review, readUsage: async () => { usageCalls += 1; return underSnap(); }, checkpoint: noCheckpoint });
  assert.equal(usageCalls, 0, "with no ceiling AND no pause the loop never reads usage");
});

test("--usage-ceiling stashes each pass's snapshot into progress state (reporter.usage)", async () => {
  const reporter = makeProgressReporter({ kind: "audit-endless", stateDir: null });
  let p = 0;
  const review = async () => (p++ === 0 ? { findings: [f("a.mjs", "bug")], coverage: { budgetSpent: 1 } } : { findings: [], coverage: { budgetSpent: 1 } });
  await runEndless("/x", { maxPasses: 20, dryStreak: 2, budget: 40, usageCeiling: CEILING, reporter }, { review, readUsage: async () => underSnap(), checkpoint: noCheckpoint });
  const s = reporter.snapshot();
  assert.ok(s.usage, "the latest usage snapshot is on the progress state");
  assert.equal(s.usage.codex.weekPercent, 5);
  assert.deepEqual(s.usageCeiling, CEILING);
});

// --- --pause-at-5h ------------------------------------------------------------

const NOWMS = Date.parse("2026-07-13T00:00:00Z");
const RESET = Date.parse("2026-07-13T02:00:00Z");
const isoOf = (ms) => new Date(ms).toISOString();
const under5h = () => ({ claude: { available: true, fiveHourPercent: 10, fiveHourResetsAt: isoOf(RESET) }, codex: { available: false }, grok: { available: false } });
const over5h = () => ({ claude: { available: true, fiveHourPercent: 92, fiveHourResetsAt: isoOf(RESET) }, codex: { available: false }, grok: { available: false } });
const PAUSE_ON = { enabled: true, threshold: 85, autonomous: false };
const PAUSE_AUTO = { enabled: true, threshold: 85, autonomous: true };

test("--pause-at-5h (non-autonomous): a 5h breach BREAKS CLEAN and returns out.pause for the companion", async () => {
  let calls = 0;
  const readUsage = async () => (++calls >= 2 ? over5h() : under5h());
  const out = await runEndless(
    "/x",
    { maxPasses: 10, dryStreak: 5, budget: 40, pause5h: PAUSE_ON },
    { review: freshEveryPass(), readUsage, now: () => NOWMS, checkpoint: noCheckpoint }
  );
  assert.ok(out.pause, "endless returns a machine-readable pause object the companion emits as the contract + exit 75");
  assert.equal(out.pause.schedulable, true);
  assert.equal(out.pause.autonomous, false);
  assert.equal(out.pause.threshold, 85);
  assert.equal(out.pause.resumeAt, isoOf(RESET + 120000));
  assert.ok(out.pause.blockers.some((b) => b.model === "claude" && b.percent === 92));
  assert.ok(out.pause.pauseId);
  assert.equal(out.passesRun, 2, "ran pass 1 (under) then paused after pass 2 (over)");
  assert.match(out.stopReason, /quota-pause/);
});

test("--pause-at-5h auto: endless WAITS in-process to the reset then RESUMES (no pause returned); converges once clear", async () => {
  let rc = 0;
  const review = async () => (rc++ === 0 ? { findings: [f("a.mjs", "bug")], coverage: { budgetSpent: 1 } } : { findings: [], coverage: { budgetSpent: 1 } });
  let calls = 0;
  const readUsage = async () => (++calls === 1 ? over5h() : under5h()); // over on pass 1's check, clears after
  const sleeps = [];
  const out = await runEndless(
    "/x",
    { maxPasses: 10, dryStreak: 2, budget: 40, pause5h: PAUSE_AUTO },
    { review, readUsage, now: () => NOWMS, sleep: async (ms) => sleeps.push(ms), checkpoint: noCheckpoint }
  );
  assert.equal(sleeps.length, 1, "it waited exactly once, in-process (did not exit)");
  assert.equal(sleeps[0], RESET + 120000 - NOWMS, "the wait runs until resumeAt (reset + buffer)");
  assert.equal(out.pause, undefined, "an autonomous wait that resumed then converged returns NO pause");
  assert.match(out.stopReason, /diminishing|max passes|budget/);
});

test("--pause-at-5h auto with an UNSCHEDULABLE reset → returns a manual pause, NEVER a blind in-process wait", async () => {
  const overStale = () => ({ claude: { available: true, fiveHourPercent: 92, fiveHourResetsAt: "2020-01-01T00:00:00Z" }, codex: { available: false }, grok: { available: false } });
  const sleeps = [];
  const out = await runEndless(
    "/x",
    { maxPasses: 10, dryStreak: 5, budget: 40, pause5h: PAUSE_AUTO },
    { review: freshEveryPass(), readUsage: async () => overStale(), now: () => NOWMS, sleep: async (ms) => sleeps.push(ms), checkpoint: noCheckpoint }
  );
  assert.equal(sleeps.length, 0, "an unschedulable reset must never trigger a blind multi-hour wait, even in auto");
  assert.ok(out.pause);
  assert.equal(out.pause.schedulable, false);
  assert.equal(out.pause.resumeAt, null);
  assert.match(out.stopReason, /quota-pause-manual/);
  assert.equal(out.passesRun, 1);
});

test("--pause-at-5h FAIL-SOFT: a THROWING readUsage never pauses or crashes endless", async () => {
  const out = await runEndless(
    "/x",
    { maxPasses: 3, dryStreak: 5, budget: 40, pause5h: PAUSE_ON },
    { review: freshEveryPass(), readUsage: async () => { throw new Error("provider network down"); }, now: () => NOWMS, checkpoint: noCheckpoint }
  );
  assert.equal(out.pause, undefined, "a usage-read failure is treated as not-paused");
  assert.match(out.stopReason, /max passes/);
});

test("--pause-at-5h anti-thrash: a resume that re-pauses the SAME 5h window with no new findings → hard manual stop", async () => {
  // Prior run paused on this exact window with 1 finding. On resume the window is STILL over and this
  // pass finds nothing new → a resume→re-pause spin. It must hard-stop for manual attention.
  const sig = `claude@${isoOf(RESET)}`;
  const prior = { findings: [f("old.mjs", "prior finding")], passNo: 1, spent: 1, dryStreak: 0, pauseGuard: { windowSig: sig, findingsCount: 1, passNo: 1 } };
  const review = async () => ({ findings: [f("old.mjs", "prior finding")], coverage: { budgetSpent: 1 } }); // only the already-seen finding → 0 fresh
  const out = await runEndless(
    "/x",
    { maxPasses: 10, dryStreak: 5, budget: 40, resume: true, pause5h: PAUSE_ON },
    { review, readUsage: async () => over5h(), now: () => NOWMS, loadCheckpoint: () => prior, checkpoint: noCheckpoint }
  );
  assert.ok(out.pause, "the thrash stop still surfaces a (manual) pause object");
  assert.equal(out.pause.thrash, true);
  assert.equal(out.pause.schedulable, false);
  assert.match(out.stopReason, /no progress/);
});

// --- parse AND thread through: the EXACT objects the companion feeds drive the loop ----------------

test("companion parse → thread: parseUsageCeiling('50/50/50') stops endless when codex crosses 50", async () => {
  const usageCeiling = parseUsageCeiling("50/50/50"); // exactly what the endless CLI block builds
  assert.deepEqual(usageCeiling, { claude: 50, codex: 50, grok: 50 });
  let calls = 0;
  const readUsage = async () => (++calls >= 2 ? overCodexSnap() : underSnap());
  const out = await runEndless("/x", { maxPasses: 10, dryStreak: 5, budget: 40, usageCeiling }, { review: freshEveryPass(), readUsage, checkpoint: noCheckpoint });
  assert.match(out.stopReason, /usage-ceiling/);
  assert.match(out.stopReason, /codex 80%≥50%/);
});

test("companion parse → thread: parsePause5hOption('auto:90') drives an AUTONOMOUS wait+resume in endless", async () => {
  const pause5h = parsePause5hOption("auto:90"); // exactly what the endless CLI block builds
  assert.deepEqual(pause5h, { enabled: true, threshold: 90, autonomous: true });
  let rc = 0;
  const review = async () => (rc++ === 0 ? { findings: [f("a.mjs", "bug")], coverage: { budgetSpent: 1 } } : { findings: [], coverage: { budgetSpent: 1 } });
  let calls = 0;
  const over90 = () => ({ claude: { available: true, fiveHourPercent: 95, fiveHourResetsAt: isoOf(RESET) }, codex: { available: false }, grok: { available: false } });
  const readUsage = async () => (++calls === 1 ? over90() : under5h());
  const sleeps = [];
  const out = await runEndless("/x", { maxPasses: 10, dryStreak: 2, budget: 40, pause5h }, { review, readUsage, now: () => NOWMS, sleep: async (ms) => sleeps.push(ms), checkpoint: noCheckpoint });
  assert.equal(sleeps.length, 1, "the autonomous threshold-90 pause waited in-process then resumed");
  assert.equal(out.pause, undefined, "resumed and converged → no pause returned");
});

// --- C (codex-4): the between-pass guards must NOT run after an already-terminal FINAL pass -----------

test("C: --max-passes 1 + over-threshold 5h → stops on max-passes with NO pause and NO in-process sleep", async () => {
  // Before C the pause guard ran AFTER the last allowed pass, so an already-terminal autonomous run would
  // pointlessly sleep for hours. Now the loop breaks on the terminal stop BEFORE the guard. Inject the
  // sleep stub and assert it is never called; the over-threshold snapshot WOULD pause if the guard ran.
  const sleeps = [];
  const out = await runEndless(
    "/x",
    { maxPasses: 1, dryStreak: 5, budget: 40, pause5h: PAUSE_AUTO },
    { review: freshEveryPass(), readUsage: async () => over5h(), now: () => NOWMS, sleep: async (ms) => sleeps.push(ms), checkpoint: noCheckpoint }
  );
  assert.equal(out.passesRun, 1);
  assert.match(out.stopReason, /max passes/);
  assert.equal(out.pause, undefined, "an already-terminal final pass must not pause (exit 75)");
  assert.equal(sleeps.length, 0, "no pointless multi-hour sleep on a run that was ending anyway");
});

test("C: --max-passes 1 + over-CEILING snapshot → stops on max-passes, NOT usage-ceiling (no exit-75 on the terminal pass)", async () => {
  const out = await runEndless(
    "/x",
    { maxPasses: 1, dryStreak: 5, budget: 40, usageCeiling: CEILING },
    { review: freshEveryPass(), readUsage: async () => overCodexSnap(), checkpoint: noCheckpoint }
  );
  assert.equal(out.passesRun, 1);
  assert.match(out.stopReason, /max passes/);
  assert.ok(!/usage-ceiling/.test(out.stopReason ?? ""), "the ceiling guard does not run on an already-terminal final pass");
});
