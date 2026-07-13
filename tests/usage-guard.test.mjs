import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CEILING, evaluateCeiling, evaluatePause5h, parsePause5hOption, parseUsageCeiling, readUsageSnapshot } from "../plugins/council/scripts/lib/usage-guard.mjs";

// --- parseUsageCeiling: every accepted form + the invalid inputs it must reject --

test("parseUsageCeiling: null/undefined/empty → the user-approved default 40/50/40", () => {
  const def = { claude: 40, codex: 50, grok: 40 };
  assert.deepEqual(parseUsageCeiling(null), def);
  assert.deepEqual(parseUsageCeiling(undefined), def);
  assert.deepEqual(parseUsageCeiling(""), def);
  assert.deepEqual(parseUsageCeiling("   "), def);
  assert.deepEqual({ ...DEFAULT_CEILING }, def); // the exported default matches
});

test("parseUsageCeiling: slash form 40/50/40 → claude/codex/grok in order", () => {
  assert.deepEqual(parseUsageCeiling("40/50/40"), { claude: 40, codex: 50, grok: 40 });
  assert.deepEqual(parseUsageCeiling("10/20/30"), { claude: 10, codex: 20, grok: 30 });
});

test("parseUsageCeiling: single number → all three", () => {
  assert.deepEqual(parseUsageCeiling("45"), { claude: 45, codex: 45, grok: 45 });
  assert.deepEqual(parseUsageCeiling(45), { claude: 45, codex: 45, grok: 45 });
});

test("parseUsageCeiling: keyed form (partial subset) → unspecified models fall back to default", () => {
  assert.deepEqual(parseUsageCeiling("claude=40,codex=50,grok=40"), { claude: 40, codex: 50, grok: 40 });
  assert.deepEqual(parseUsageCeiling("grok=30"), { claude: 40, codex: 50, grok: 30 });
  assert.deepEqual(parseUsageCeiling("CLAUDE=12, Codex=99"), { claude: 12, codex: 99, grok: 40 });
});

test("parseUsageCeiling: invalid inputs throw a clear Error", () => {
  assert.throws(() => parseUsageCeiling("200"), /between 1 and 100/);
  assert.throws(() => parseUsageCeiling("0"), /between 1 and 100/);
  assert.throws(() => parseUsageCeiling("abc"), /must be a number/);
  assert.throws(() => parseUsageCeiling("40/50"), /exactly 3 values/);
  assert.throws(() => parseUsageCeiling("40/50/40/10"), /exactly 3 values/);
  assert.throws(() => parseUsageCeiling("claude=abc"), /must be a number/);
  assert.throws(() => parseUsageCeiling("claude=150"), /between 1 and 100/);
  assert.throws(() => parseUsageCeiling("foo=40"), /unknown model/);
  assert.throws(() => parseUsageCeiling("claude="), /empty/);
});

// --- readUsageSnapshot: fake readers (incl. a throwing one) → fail-soft per model --

// readUsageSnapshot became time-aware for the D stale-window fix (a window whose reset is clearly in the
// past is dropped). These fixtures assert EXACT reset strings, so pin a `nowMs` BEFORE the fixture resets
// (05:00Z / 07-20) → they stay FRESH and the normalization assertions remain deterministic regardless of
// the real wall clock. This is not because the assertions were wrong — it pins the newly-added clock.
const FRESH_NOW = Date.parse("2026-07-13T00:00:00Z");

const fakeReaders = () => ({
  fetchClaudeLimits: async () => ({ fiveHour: { usedPercent: 6, resetsAt: "2026-07-13T05:00:00Z" }, sevenDay: { usedPercent: 1, resetsAt: "2026-07-20T00:00:00Z" } }),
  collectCodexRateLimits: () => ({ planType: "prolite", primary: { window: "weekly", usedPercent: 14, resetsAt: "2026-07-20T00:00:00Z" }, secondary: null }),
  collectGrokLimits: () => ({ window: "weekly", usedPercent: 11, resetsAt: "2026-07-20T00:00:00Z" }),
  collectAllTokenUsage: () => ({
    claude: { inputTokens: 1000, outputTokens: 250 },
    codex: { inputTokens: 500, outputTokens: 300, totalTokens: 1300 },
    grok: { totalTokens: 700 }
  })
});

test("readUsageSnapshot: all-available snapshot from fake readers is fully normalized", async () => {
  const snap = await readUsageSnapshot({ homeDir: "/home/x", sinceMs: 0, readers: fakeReaders(), nowMs: FRESH_NOW });
  assert.equal(snap.claude.available, true);
  assert.equal(snap.claude.weekPercent, 1);
  assert.equal(snap.claude.fiveHourPercent, 6);
  assert.equal(snap.claude.weekResetsAt, "2026-07-20T00:00:00Z");
  assert.equal(snap.claude.fiveHourResetsAt, "2026-07-13T05:00:00Z", "the 5h reset clock is plumbed for --pause-at-5h resume");
  assert.deepEqual(snap.claude.tokens, { out: 250, in: 1000, total: 1250 });

  assert.equal(snap.codex.available, true);
  assert.equal(snap.codex.weekPercent, 14);
  assert.equal(snap.codex.fiveHourResetsAt, null, "no active codex 5h window in this fixture → null reset");
  assert.deepEqual(snap.codex.tokens, { out: 300, in: 500, total: 1300 });

  assert.equal(snap.grok.available, true);
  assert.equal(snap.grok.weekPercent, 11);
  assert.deepEqual(snap.grok.tokens, { total: 700 });
});

test("readUsageSnapshot: a THROWING reader → that model unavailable, the others are fine", async () => {
  const readers = fakeReaders();
  readers.fetchClaudeLimits = async () => {
    throw new Error("OAuth endpoint unreachable");
  };
  const snap = await readUsageSnapshot({ homeDir: "/home/x", sinceMs: 0, readers });
  assert.equal(snap.claude.available, false, "a throwing quota reader never throws the snapshot");
  assert.equal(snap.claude.weekPercent, null);
  assert.equal(snap.claude.fiveHourPercent, null);
  assert.equal(snap.codex.available, true, "the other models are unaffected");
  assert.equal(snap.grok.available, true);
});

test("readUsageSnapshot: {error} / null quota readers → unavailable (never a breach source)", async () => {
  const readers = fakeReaders();
  readers.fetchClaudeLimits = async () => ({ error: "no local credentials" });
  readers.collectCodexRateLimits = () => null;
  const snap = await readUsageSnapshot({ homeDir: "/home/x", sinceMs: 0, readers });
  assert.equal(snap.claude.available, false);
  assert.equal(snap.codex.available, false);
  assert.equal(snap.grok.available, true);
});

test("readUsageSnapshot: a throwing token reader degrades tokens to zero without touching availability", async () => {
  const readers = fakeReaders();
  readers.collectAllTokenUsage = () => {
    throw new Error("fs blew up");
  };
  const snap = await readUsageSnapshot({ homeDir: "/home/x", sinceMs: 0, readers });
  assert.equal(snap.claude.available, true, "a token-read failure must not flip availability");
  assert.deepEqual(snap.claude.tokens, { out: 0, in: 0, total: 0 });
  assert.deepEqual(snap.grok.tokens, { total: 0 });
});

test("readUsageSnapshot: codex weekly window is picked even when it is the SECONDARY window", async () => {
  const readers = fakeReaders();
  readers.collectCodexRateLimits = () => ({
    planType: "prolite",
    primary: { window: "5h", usedPercent: 3, resetsAt: "2026-07-13T05:00:00Z" },
    secondary: { window: "weekly", usedPercent: 22, resetsAt: "2026-07-20T00:00:00Z" }
  });
  const snap = await readUsageSnapshot({ homeDir: "/home/x", sinceMs: 0, readers, nowMs: FRESH_NOW });
  assert.equal(snap.codex.weekPercent, 22, "weekly comes from whichever window is labelled weekly");
  assert.equal(snap.codex.fiveHourPercent, 3, "the 5h window's percent is picked from whichever slot is labelled 5h");
  assert.equal(snap.codex.fiveHourResetsAt, "2026-07-13T05:00:00Z", "the active codex 5h window's reset clock is plumbed");
});

// --- D: STALE local quota windows fail-soft at the SNAPSHOT layer (SSOT — both evaluators inherit it) --
// An OLD local record (window reset already in the past) must NEVER stop --usage-ceiling or force a
// --pause-at-5h — stale == unknown for guard purposes. Fixed where the snapshot is assembled so the pure
// evaluators stay untouched. The fix is CONSERVATIVE: only a PRESENT timestamp clearly past-grace is stale.

const STALE_NOW = Date.parse("2026-07-13T12:00:00Z");
const pastReset = "2026-07-13T00:00:00Z"; // 12h before STALE_NOW → clearly past the 15m grace → stale
const futureReset = "2026-07-14T00:00:00Z"; // after STALE_NOW → fresh

// codex WEEKLY at 80% (over a 50 ceiling) + claude 5h at 95% (over an 85 pause threshold); the two
// window resets are parameterized so a test can make either window stale, fresh, or missing.
const staleReaders = (weekReset, fiveReset) => ({
  fetchClaudeLimits: async () => ({ fiveHour: { usedPercent: 95, resetsAt: fiveReset }, sevenDay: { usedPercent: 5, resetsAt: futureReset } }),
  collectCodexRateLimits: () => ({ planType: "pro", primary: { window: "weekly", usedPercent: 80, resetsAt: weekReset }, secondary: null }),
  collectGrokLimits: () => null,
  collectAllTokenUsage: () => ({ claude: {}, codex: {}, grok: {} })
});
const CEIL = { claude: 40, codex: 50, grok: 40 };

test("D stale window: a codex WEEKLY reset in the past drops weekPercent → evaluateCeiling does NOT breach", async () => {
  const snap = await readUsageSnapshot({ homeDir: "/x", sinceMs: 0, readers: staleReaders(pastReset, futureReset), nowMs: STALE_NOW });
  assert.equal(snap.codex.weekPercent, null, "a stale weekly window's percent is dropped (it is from a bygone window)");
  assert.equal(snap.codex.available, true, "the provider stays available — only the dead window is dropped, not the model");
  assert.equal(evaluateCeiling(snap, CEIL).breached, false, "a stale 80% weekly can never hard-stop the loop (fail-soft)");
});

test("D stale window: a claude 5h reset in the past drops fiveHourPercent → evaluatePause5h does NOT pause", async () => {
  const snap = await readUsageSnapshot({ homeDir: "/x", sinceMs: 0, readers: staleReaders(futureReset, pastReset), nowMs: STALE_NOW });
  assert.equal(snap.claude.fiveHourPercent, null, "a stale 5h window's percent is dropped");
  assert.equal(evaluatePause5h(snap, 85, { nowMs: STALE_NOW }).paused, false, "a stale 95% 5h can never pause the loop (fail-soft)");
});

test("D FRESH data is unchanged: future resets still breach the ceiling and pause the 5h window (live path intact)", async () => {
  const snap = await readUsageSnapshot({ homeDir: "/x", sinceMs: 0, readers: staleReaders(futureReset, futureReset), nowMs: STALE_NOW });
  assert.equal(snap.codex.weekPercent, 80, "a future weekly reset is fresh → percent retained");
  assert.equal(snap.claude.fiveHourPercent, 95, "a future 5h reset is fresh → percent retained");
  assert.equal(evaluateCeiling(snap, CEIL).breached, true, "fresh over-ceiling still breaches exactly as before");
  assert.equal(evaluatePause5h(snap, 85, { nowMs: STALE_NOW }).paused, true, "fresh over-threshold 5h still pauses exactly as before");
});

test("D conservative: a MISSING reset timestamp is NOT stale (missing != expired → percent retained)", async () => {
  const snap = await readUsageSnapshot({ homeDir: "/x", sinceMs: 0, readers: staleReaders(null, null), nowMs: STALE_NOW });
  assert.equal(snap.codex.weekPercent, 80, "no weekly reset timestamp → NOT treated as stale");
  assert.equal(snap.claude.fiveHourPercent, 95, "no 5h reset timestamp → NOT treated as stale");
  assert.equal(evaluateCeiling(snap, CEIL).breached, true, "a missing-timestamp breach still stops (behaviour unchanged)");
});

// --- evaluateCeiling: below / at / above, claude 5h, and unavailable-not-breached --

const availSnap = (over = {}) => ({
  claude: { available: true, weekPercent: 1, fiveHourPercent: 6, weekResetsAt: null, tokens: { out: 0, in: 0, total: 0 }, ...over.claude },
  codex: { available: true, weekPercent: 14, weekResetsAt: null, tokens: { out: 0, in: 0, total: 0 }, ...over.codex },
  grok: { available: true, weekPercent: 11, weekResetsAt: null, tokens: { total: 0 }, ...over.grok }
});

test("evaluateCeiling: the live-ish 40/50/40 default with real values → NOT breached", () => {
  const res = evaluateCeiling(availSnap(), parseUsageCeiling("40/50/40"));
  assert.equal(res.breached, false);
  assert.deepEqual(res.breaches, []);
  assert.deepEqual(res.unavailable, []);
});

test("evaluateCeiling: below ceiling → not breached", () => {
  const res = evaluateCeiling(availSnap({ codex: { weekPercent: 49 } }), { claude: 40, codex: 50, grok: 40 });
  assert.equal(res.breached, false);
});

test("evaluateCeiling: AT the ceiling (>=) → breached", () => {
  const res = evaluateCeiling(availSnap({ codex: { weekPercent: 50 } }), { claude: 40, codex: 50, grok: 40 });
  assert.equal(res.breached, true);
  assert.equal(res.breaches.length, 1);
  assert.deepEqual(res.breaches[0], { model: "codex", window: "weekly", percent: 50, ceiling: 50 });
});

test("evaluateCeiling: ABOVE the ceiling → breached with the exact percent/ceiling", () => {
  const res = evaluateCeiling(availSnap({ grok: { weekPercent: 88 } }), { claude: 40, codex: 50, grok: 40 });
  assert.equal(res.breached, true);
  assert.deepEqual(res.breaches[0], { model: "grok", window: "weekly", percent: 88, ceiling: 40 });
});

test("evaluateCeiling is WEEKLY-ONLY: a claude 5h window over the ceiling does NOT breach (5h is pause, not stop)", () => {
  // --usage-ceiling is the WEEKLY hard stop and nothing else. The 5h window is the SEPARATE soft-pause
  // policy (evaluatePause5h). A claude 5h at 55% with a 2% weekly must NEVER breach the ceiling.
  const res = evaluateCeiling(availSnap({ claude: { weekPercent: 2, fiveHourPercent: 55 } }), { claude: 40, codex: 50, grok: 40 });
  assert.equal(res.breached, false, "the 5h window is never a ceiling breach");
  assert.deepEqual(res.breaches, []);
  assert.ok(!res.breaches.some((b) => b.window === "5h"), "evaluateCeiling emits no 5h breaches at all");
});

test("evaluateCeiling still breaches WEEKLY even when the same model's 5h is under (weekly is the only signal)", () => {
  const res = evaluateCeiling(availSnap({ claude: { weekPercent: 40, fiveHourPercent: 1 } }), { claude: 40, codex: 50, grok: 40 });
  assert.equal(res.breached, true);
  assert.equal(res.breaches.length, 1);
  assert.deepEqual(res.breaches[0], { model: "claude", window: "weekly", percent: 40, ceiling: 40 });
});

test("evaluateCeiling: an unavailable model is NEVER a breach even if a stray percent is over", () => {
  const snap = availSnap({ codex: { available: false, weekPercent: 99 } });
  const res = evaluateCeiling(snap, { claude: 40, codex: 50, grok: 40 });
  assert.equal(res.breached, false, "unknown usage can never stop the loop");
  assert.ok(res.unavailable.includes("codex"));
});

test("evaluateCeiling: available but null weekPercent → not breached (no numeric usage)", () => {
  const snap = availSnap({ grok: { available: true, weekPercent: null } });
  const res = evaluateCeiling(snap, { claude: 40, codex: 50, grok: 40 });
  assert.equal(res.breached, false);
});

test("evaluateCeiling: garbage inputs never throw", () => {
  assert.doesNotThrow(() => evaluateCeiling(null, null));
  assert.doesNotThrow(() => evaluateCeiling(undefined, undefined));
  const res = evaluateCeiling({ claude: "nope" }, { claude: 40 });
  assert.equal(res.breached, false);
  assert.deepEqual(res.unavailable, ["claude", "codex", "grok"]);
});

// --- parsePause5hOption: the DEFAULT-ON soft pause + off / <N> / auto forms -------------------

test("parsePause5hOption: an ABSENT flag is ON BY DEFAULT at 85% (the user's explicit safety rule)", () => {
  const def = { enabled: true, threshold: 85, autonomous: false };
  assert.deepEqual(parsePause5hOption(undefined), def);
  assert.deepEqual(parsePause5hOption(null), def);
  assert.deepEqual(parsePause5hOption(""), def, "the BARE flag (rewritten to empty) is default-on, not off");
  assert.deepEqual(parsePause5hOption("   "), def);
});

test("parsePause5hOption: off/none/0/false all DISABLE the pause", () => {
  const off = { enabled: false, threshold: 85, autonomous: false };
  for (const v of ["off", "none", "0", "false", "OFF", "None"]) assert.deepEqual(parsePause5hOption(v), off, `"${v}" disables`);
});

test("parsePause5hOption: a plain <N> retunes the threshold (still non-autonomous)", () => {
  assert.deepEqual(parsePause5hOption("90"), { enabled: true, threshold: 90, autonomous: false });
  assert.deepEqual(parsePause5hOption(70), { enabled: true, threshold: 70, autonomous: false });
  assert.deepEqual(parsePause5hOption("1"), { enabled: true, threshold: 1, autonomous: false });
  assert.deepEqual(parsePause5hOption("100"), { enabled: true, threshold: 100, autonomous: false });
});

test("parsePause5hOption: auto / auto:<N> / <N>:auto make it AUTONOMOUS (default 85 when no number)", () => {
  assert.deepEqual(parsePause5hOption("auto"), { enabled: true, threshold: 85, autonomous: true });
  assert.deepEqual(parsePause5hOption("auto:90"), { enabled: true, threshold: 90, autonomous: true });
  assert.deepEqual(parsePause5hOption("90:auto"), { enabled: true, threshold: 90, autonomous: true });
  assert.deepEqual(parsePause5hOption("AUTO:75"), { enabled: true, threshold: 75, autonomous: true });
});

test("parsePause5hOption: out-of-range / unparseable inputs throw a clear Error", () => {
  assert.throws(() => parsePause5hOption("200"), /between 1 and 100/);
  assert.throws(() => parsePause5hOption("abc"), /must be a number/);
  assert.throws(() => parsePause5hOption("auto:200"), /between 1 and 100/);
  assert.throws(() => parsePause5hOption("auto:hi"), /unrecognized value/);
  assert.throws(() => parsePause5hOption("autox"), /unrecognized value/);
});

// --- evaluatePause5h: which model pauses, and whether a resume time is schedulable -------------

const NOW = Date.parse("2026-07-13T00:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const pauseSnap = (over = {}) => ({
  claude: { available: true, fiveHourPercent: 10, fiveHourResetsAt: iso(NOW + 3600e3), ...over.claude },
  codex: { available: true, fiveHourPercent: 5, fiveHourResetsAt: iso(NOW + 3600e3), ...over.codex },
  grok: { available: true, weekPercent: 11, ...over.grok } // grok has no 5h window at all
});

test("evaluatePause5h: one model over threshold → paused + schedulable, resumeAt = resetsAt + buffer", () => {
  const resets = NOW + 2 * 3600e3;
  const snap = pauseSnap({ claude: { fiveHourPercent: 90, fiveHourResetsAt: iso(resets) } });
  const p = evaluatePause5h(snap, 85, { nowMs: NOW, bufferMs: 120000 });
  assert.equal(p.paused, true);
  assert.equal(p.schedulable, true);
  assert.equal(p.reason, "ok");
  assert.equal(p.blockers.length, 1);
  assert.deepEqual(p.blockers[0], { model: "claude", percent: 90, threshold: 85, resetsAt: iso(resets) });
  assert.equal(p.resumeAt, iso(resets + 120000), "resume is the breaching reset plus the buffer");
});

test("evaluatePause5h: the == threshold boundary breaches (>=)", () => {
  const p = evaluatePause5h(pauseSnap({ codex: { fiveHourPercent: 85 } }), 85, { nowMs: NOW });
  assert.equal(p.paused, true);
  assert.ok(p.blockers.some((b) => b.model === "codex" && b.percent === 85));
});

test("evaluatePause5h: multiple models over → resumeAt uses the LATEST breaching reset", () => {
  const early = NOW + 1 * 3600e3;
  const late = NOW + 3 * 3600e3;
  const snap = pauseSnap({
    claude: { fiveHourPercent: 91, fiveHourResetsAt: iso(early) },
    codex: { fiveHourPercent: 96, fiveHourResetsAt: iso(late) }
  });
  const p = evaluatePause5h(snap, 85, { nowMs: NOW, bufferMs: 60000 });
  assert.equal(p.blockers.length, 2);
  assert.equal(p.resumeAt, iso(late + 60000), "the loop must wait for the LAST window to clear, not the first");
});

test("evaluatePause5h: an unavailable model OR a null/absent 5h is never a blocker (grok never)", () => {
  const snap = pauseSnap({
    claude: { available: false, fiveHourPercent: 99 }, // unavailable: unknown usage never pauses
    codex: { available: true, fiveHourPercent: null }, // available but no numeric 5h
    grok: { available: true, weekPercent: 99 } // grok has no 5h field at all
  });
  const p = evaluatePause5h(snap, 85, { nowMs: NOW });
  assert.equal(p.paused, false);
  assert.deepEqual(p.blockers, []);
  assert.equal(p.reason, "none");
});

test("evaluatePause5h: a missing/invalid/stale/far resetsAt → schedulable:false, reason unschedulable-timestamp", () => {
  // missing
  let p = evaluatePause5h(pauseSnap({ claude: { fiveHourPercent: 90, fiveHourResetsAt: null } }), 85, { nowMs: NOW });
  assert.equal(p.paused, true);
  assert.equal(p.schedulable, false);
  assert.equal(p.resumeAt, null);
  assert.equal(p.reason, "unschedulable-timestamp");
  // invalid string
  p = evaluatePause5h(pauseSnap({ claude: { fiveHourPercent: 90, fiveHourResetsAt: "not-a-date" } }), 85, { nowMs: NOW });
  assert.equal(p.schedulable, false);
  assert.equal(p.reason, "unschedulable-timestamp");
  // genuinely stale (years in the past) → not trustworthy → manual stop
  p = evaluatePause5h(pauseSnap({ claude: { fiveHourPercent: 90, fiveHourResetsAt: "2020-01-01T00:00:00Z" } }), 85, { nowMs: NOW });
  assert.equal(p.schedulable, false);
  assert.equal(p.reason, "unschedulable-timestamp");
  // absurdly far ahead (> now + maxAheadMs) → never a blind multi-hour+ wait
  p = evaluatePause5h(pauseSnap({ claude: { fiveHourPercent: 90, fiveHourResetsAt: iso(NOW + 48 * 3600e3) } }), 85, { nowMs: NOW });
  assert.equal(p.schedulable, false);
  assert.equal(p.reason, "unschedulable-timestamp");
});

test("evaluatePause5h: a JUST-reset window (barely in the past) is resumable-now (short buffer)", () => {
  const p = evaluatePause5h(pauseSnap({ claude: { fiveHourPercent: 90, fiveHourResetsAt: iso(NOW - 60000) } }), 85, { nowMs: NOW, bufferMs: 120000 });
  assert.equal(p.paused, true);
  assert.equal(p.schedulable, true, "a window that just reset is resumable immediately, not a manual stop");
  assert.equal(p.resumeAt, iso(NOW + 120000), "resume-now = now + buffer");
});

test("evaluatePause5h: no breach → { paused:false, reason:'none' } (fully total/pure)", () => {
  const p = evaluatePause5h(pauseSnap(), 85, { nowMs: NOW });
  assert.deepEqual(p, { paused: false, blockers: [], schedulable: false, resumeAt: null, reason: "none" });
  assert.doesNotThrow(() => evaluatePause5h(null, 85, { nowMs: NOW }));
  assert.doesNotThrow(() => evaluatePause5h(undefined, undefined, {}));
});
