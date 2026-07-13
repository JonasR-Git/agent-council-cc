import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CEILING, evaluateCeiling, parseUsageCeiling, readUsageSnapshot } from "../plugins/council/scripts/lib/usage-guard.mjs";

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
  const snap = await readUsageSnapshot({ homeDir: "/home/x", sinceMs: 0, readers: fakeReaders() });
  assert.equal(snap.claude.available, true);
  assert.equal(snap.claude.weekPercent, 1);
  assert.equal(snap.claude.fiveHourPercent, 6);
  assert.equal(snap.claude.weekResetsAt, "2026-07-20T00:00:00Z");
  assert.deepEqual(snap.claude.tokens, { out: 250, in: 1000, total: 1250 });

  assert.equal(snap.codex.available, true);
  assert.equal(snap.codex.weekPercent, 14);
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
  const snap = await readUsageSnapshot({ homeDir: "/home/x", sinceMs: 0, readers });
  assert.equal(snap.codex.weekPercent, 22, "weekly comes from whichever window is labelled weekly");
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

test("evaluateCeiling: claude 5h window is an earlier breach against the SAME claude ceiling", () => {
  const res = evaluateCeiling(availSnap({ claude: { weekPercent: 2, fiveHourPercent: 55 } }), { claude: 40, codex: 50, grok: 40 });
  assert.equal(res.breached, true);
  assert.ok(res.breaches.some((b) => b.model === "claude" && b.window === "5h" && b.percent === 55));
  assert.ok(!res.breaches.some((b) => b.model === "claude" && b.window === "weekly"), "the 7d window (2%) does not breach");
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
