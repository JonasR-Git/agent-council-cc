import assert from "node:assert/strict";
import test from "node:test";

import { MAX_AUTONOMOUS_WAIT_MS, evaluateBetweenPassGuards, pauseWindowSig } from "../plugins/council/scripts/lib/audit-loop-guards.mjs";

// The SSOT between-pass DECISION shared by BOTH review loops (audit-fixloop + audit-endless). It is
// PURE (no clock/fs) and reuses evaluateCeiling/evaluatePause5h, so its whole job is the ceiling
// breach y/n, the pause schedulability, and the anti-thrash signature. FAIL-SOFT is the load-bearing
// invariant: unknown/unavailable/stale usage must NEVER breach or pause.

const CEILING = { claude: 40, codex: 50, grok: 40 };
const NOWMS = Date.parse("2026-07-13T00:00:00Z");
const RESET = Date.parse("2026-07-13T02:00:00Z");
const isoOf = (ms) => new Date(ms).toISOString();

const overCodexWeek = () => ({ claude: { available: false, weekPercent: null }, codex: { available: true, weekPercent: 80 }, grok: { available: false } });
const underWeek = () => ({ claude: { available: false, weekPercent: null }, codex: { available: true, weekPercent: 5 }, grok: { available: false } });
const over5h = () => ({ claude: { available: true, fiveHourPercent: 92, fiveHourResetsAt: isoOf(RESET) }, codex: { available: false }, grok: { available: false } });
const under5h = () => ({ claude: { available: true, fiveHourPercent: 10, fiveHourResetsAt: isoOf(RESET) }, codex: { available: false }, grok: { available: false } });
const PAUSE_ON = { enabled: true, threshold: 85, autonomous: false };
const PAUSE_AUTO = { enabled: true, threshold: 85, autonomous: true };

// --- ceiling ------------------------------------------------------------------

test("no usageCeiling → ceiling is null (the guard is off)", () => {
  const { ceiling } = evaluateBetweenPassGuards({ snapshot: overCodexWeek() });
  assert.equal(ceiling, null);
});

test("ceiling: an AVAILABLE model at/over its weekly ceiling breaches", () => {
  const { ceiling } = evaluateBetweenPassGuards({ usageCeiling: CEILING, snapshot: overCodexWeek() });
  assert.equal(ceiling.breached, true);
  assert.ok(ceiling.breaches.some((b) => b.model === "codex" && b.window === "weekly" && b.percent === 80 && b.ceiling === 50));
});

test("ceiling FAIL-SOFT: an UNAVAILABLE model never breaches, even at 99% (unknown usage never stops)", () => {
  const snap = { claude: { available: false, weekPercent: 99 }, codex: { available: false, weekPercent: 99 }, grok: { available: false, weekPercent: 99 } };
  const { ceiling } = evaluateBetweenPassGuards({ usageCeiling: CEILING, snapshot: snap });
  assert.equal(ceiling.breached, false, "an available:false model can never breach");
});

test("ceiling FAIL-SOFT: a null/garbage snapshot never breaches", () => {
  for (const snapshot of [null, undefined, {}, { codex: {} }]) {
    const { ceiling } = evaluateBetweenPassGuards({ usageCeiling: CEILING, snapshot });
    assert.equal(ceiling.breached, false);
  }
});

test("ceiling: under the ceiling does not breach", () => {
  const { ceiling } = evaluateBetweenPassGuards({ usageCeiling: CEILING, snapshot: underWeek() });
  assert.equal(ceiling.breached, false);
});

// --- pause --------------------------------------------------------------------

test("no pause5h (or disabled) → pause is null", () => {
  assert.equal(evaluateBetweenPassGuards({ snapshot: over5h(), nowMs: NOWMS }).pause, null);
  assert.equal(evaluateBetweenPassGuards({ pause5h: { enabled: false, threshold: 85 }, snapshot: over5h(), nowMs: NOWMS }).pause, null);
});

test("pause: an AVAILABLE model over the 5h threshold with a future reset is schedulable", () => {
  const { pause } = evaluateBetweenPassGuards({ pause5h: PAUSE_ON, snapshot: over5h(), nowMs: NOWMS });
  assert.ok(pause);
  assert.equal(pause.paused, true);
  assert.equal(pause.schedulable, true);
  assert.equal(pause.resumeAt, isoOf(RESET + 120000), "resumeAt = breaching reset + the 2m buffer");
  assert.equal(pause.threshold, 85);
  assert.equal(pause.thrash, false, "a first pause is never a thrash");
  assert.ok(pause.blockers.some((b) => b.model === "claude" && b.percent === 92));
  assert.equal(pause.windowSig, `claude@${isoOf(RESET)}`);
  assert.ok(pause.pauseId, "a deterministic pauseId is derived");
});

test("pause FAIL-SOFT: under threshold / unavailable / null-5h / garbage → NEVER pauses", () => {
  assert.equal(evaluateBetweenPassGuards({ pause5h: PAUSE_ON, snapshot: under5h(), nowMs: NOWMS }).pause, null);
  const unavail = { claude: { available: false, fiveHourPercent: 99, fiveHourResetsAt: isoOf(RESET) }, codex: { available: false }, grok: { available: false } };
  assert.equal(evaluateBetweenPassGuards({ pause5h: PAUSE_ON, snapshot: unavail, nowMs: NOWMS }).pause, null, "an available:false model never pauses even at 99%");
  const null5h = { claude: { available: true, fiveHourPercent: null, fiveHourResetsAt: null }, codex: { available: false }, grok: { available: false } };
  assert.equal(evaluateBetweenPassGuards({ pause5h: PAUSE_ON, snapshot: null5h, nowMs: NOWMS }).pause, null, "a null 5h% never pauses");
  for (const snapshot of [null, undefined, {}]) {
    assert.equal(evaluateBetweenPassGuards({ pause5h: PAUSE_ON, snapshot, nowMs: NOWMS }).pause, null);
  }
});

test("pause: a STALE/unschedulable reset pauses but is not schedulable (manual stop, never a blind wait)", () => {
  const overStale = { claude: { available: true, fiveHourPercent: 92, fiveHourResetsAt: "2020-01-01T00:00:00Z" }, codex: { available: false }, grok: { available: false } };
  const { pause } = evaluateBetweenPassGuards({ pause5h: PAUSE_AUTO, snapshot: overStale, nowMs: NOWMS });
  assert.ok(pause);
  assert.equal(pause.schedulable, false);
  assert.equal(pause.resumeAt, null);
});

test("pause autonomous flag passes through", () => {
  assert.equal(evaluateBetweenPassGuards({ pause5h: PAUSE_ON, snapshot: over5h(), nowMs: NOWMS }).pause.autonomous, false);
  assert.equal(evaluateBetweenPassGuards({ pause5h: PAUSE_AUTO, snapshot: over5h(), nowMs: NOWMS }).pause.autonomous, true);
});

// --- anti-thrash --------------------------------------------------------------

test("thrash: SAME window as the last pause AND no progress → thrash true", () => {
  const sig = `claude@${isoOf(RESET)}`;
  const { pause } = evaluateBetweenPassGuards({ pause5h: PAUSE_ON, snapshot: over5h(), nowMs: NOWMS, prevWindowSig: sig, madeProgress: false });
  assert.equal(pause.thrash, true);
});

test("thrash: SAME window but PROGRESS was made → NOT a thrash (a legitimate re-pause)", () => {
  const sig = `claude@${isoOf(RESET)}`;
  const { pause } = evaluateBetweenPassGuards({ pause5h: PAUSE_ON, snapshot: over5h(), nowMs: NOWMS, prevWindowSig: sig, madeProgress: true });
  assert.equal(pause.thrash, false);
});

test("thrash: a DIFFERENT window is never a thrash even with no progress", () => {
  const { pause } = evaluateBetweenPassGuards({ pause5h: PAUSE_ON, snapshot: over5h(), nowMs: NOWMS, prevWindowSig: "codex@somewhere-else", madeProgress: false });
  assert.equal(pause.thrash, false);
});

test("pauseId is deterministic and distinguishes a thrash from a normal pause on the same window", () => {
  const seed = "run|branch|3";
  const sig = `claude@${isoOf(RESET)}`;
  const normal = evaluateBetweenPassGuards({ pause5h: PAUSE_ON, snapshot: over5h(), nowMs: NOWMS, pauseIdSeed: seed }).pause;
  const normal2 = evaluateBetweenPassGuards({ pause5h: PAUSE_ON, snapshot: over5h(), nowMs: NOWMS, pauseIdSeed: seed }).pause;
  const thrash = evaluateBetweenPassGuards({ pause5h: PAUSE_ON, snapshot: over5h(), nowMs: NOWMS, prevWindowSig: sig, madeProgress: false, pauseIdSeed: seed }).pause;
  assert.equal(normal.pauseId, normal2.pauseId, "deterministic for the same inputs");
  assert.notEqual(normal.pauseId, thrash.pauseId, "a thrash keys differently than a normal pause");
});

// --- exports ------------------------------------------------------------------

test("pauseWindowSig is order-independent and marks a missing reset", () => {
  const a = pauseWindowSig([{ model: "codex", resetsAt: "b" }, { model: "claude", resetsAt: "a" }]);
  const b = pauseWindowSig([{ model: "claude", resetsAt: "a" }, { model: "codex", resetsAt: "b" }]);
  assert.equal(a, b, "sorted → order-independent");
  assert.equal(pauseWindowSig([{ model: "claude", resetsAt: null }]), "claude@?");
});

test("MAX_AUTONOMOUS_WAIT_MS is the shared bounded wait ceiling (5h15m + 2m)", () => {
  assert.equal(MAX_AUTONOMOUS_WAIT_MS, 5 * 3600e3 + 17 * 60e3);
});
