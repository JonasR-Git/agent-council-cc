import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_HEADROOM_PCT,
  USAGE_TTL_MS,
  evaluateMidPassGuard,
  makeMidPassGuard,
  makeReviewCursor,
  snapshotHasUsableCeiling
} from "../plugins/council/scripts/lib/audit-midpass-guard.mjs";

const CEILING = { claude: 40, codex: 50, grok: 40 };
const PAUSE = { enabled: true, threshold: 85, autonomous: false };
const RESET = Date.parse("2026-07-13T02:00:00Z");
const NOW = Date.parse("2026-07-13T00:00:00Z");
const isoOf = (ms) => new Date(ms).toISOString();

const under = () => ({ claude: { available: false, weekPercent: null }, codex: { available: true, weekPercent: 5 }, grok: { available: false } });
const nearCeiling = () => ({ claude: { available: false }, codex: { available: true, weekPercent: 49 }, grok: { available: false } }); // 49 < 50 but within headroom
const overCeiling = () => ({ claude: { available: false }, codex: { available: true, weekPercent: 80 }, grok: { available: false } });
const allUnavailable = () => ({ claude: { available: false }, codex: { available: false }, grok: { available: false } });
const over5h = () => ({ claude: { available: true, fiveHourPercent: 92, fiveHourResetsAt: isoOf(RESET) }, codex: { available: false }, grok: { available: false } });

// ---- the PURE decision -----------------------------------------------------------------------------

test("B fail-soft: an UNKNOWN (all-unavailable) snapshot within the TTL never quiesces", () => {
  const r = evaluateMidPassGuard({ usageCeiling: CEILING, snapshot: allUnavailable(), usableAgeMs: 1000 });
  assert.equal(r.quiesce, null, "unknown usage within TTL is fail-soft — never stops paid work");
});

test("B fail-soft TTL (ceiling): usage STALE beyond the TTL quiesces new paid work for the ceiling", () => {
  const r = evaluateMidPassGuard({ usageCeiling: CEILING, snapshot: allUnavailable(), usableAgeMs: USAGE_TTL_MS + 1 });
  assert.ok(r.quiesce, "a hard ceiling cannot fail-soft forever — stale-beyond-TTL quiesces");
  assert.equal(r.quiesce.kind, "stale-ceiling");
});

test("B fail-soft TTL (pause-only): stale-beyond-TTL NEVER quiesces when only --pause-at-5h is set", () => {
  const r = evaluateMidPassGuard({ pause5h: PAUSE, snapshot: allUnavailable(), usableAgeMs: USAGE_TTL_MS * 10 });
  assert.equal(r.quiesce, null, "the soft 5h pause stays purely fail-soft — stale usage never pauses it");
});

test("B pre-dispatch headroom: usage WITHIN the headroom margin of the ceiling pre-empts the breach", () => {
  const r = evaluateMidPassGuard({ usageCeiling: CEILING, snapshot: nearCeiling(), usableAgeMs: 0, headroomPct: DEFAULT_HEADROOM_PCT });
  assert.ok(r.quiesce, "49% with a 50% ceiling + 2% headroom → stop BEFORE the breach");
  assert.equal(r.quiesce.kind, "ceiling");
  const b = r.quiesce.breaches.find((x) => x.model === "codex");
  assert.equal(b.ceiling, 50, "the breach reports the REAL ceiling, not the reduced internal threshold");
  assert.equal(b.preempt, true, "flagged as a pre-emptive (headroom) stop since 49 < 50");
});

test("B: a real over-ceiling snapshot quiesces (kind ceiling); an under one does not", () => {
  assert.equal(evaluateMidPassGuard({ usageCeiling: CEILING, snapshot: overCeiling(), usableAgeMs: 0 }).quiesce.kind, "ceiling");
  assert.equal(evaluateMidPassGuard({ usageCeiling: CEILING, snapshot: under(), usableAgeMs: 0 }).quiesce, null);
});

test("B: a mid-pass 5h breach quiesces with kind pause carrying the SAME pause object shape", () => {
  const r = evaluateMidPassGuard({ pause5h: PAUSE, snapshot: over5h(), usableAgeMs: 0, nowMs: NOW });
  assert.ok(r.quiesce);
  assert.equal(r.quiesce.kind, "pause");
  assert.equal(r.quiesce.pause.schedulable, true);
  assert.ok(r.quiesce.pause.blockers.some((b) => b.model === "claude" && b.percent === 92));
  assert.ok(r.quiesce.pause.pauseId, "the pause object carries the scheduler-idempotent pauseId (SSOT with between-pass)");
});

test("B: snapshotHasUsableCeiling only counts a CONFIGURED, AVAILABLE, finite-percent model", () => {
  assert.equal(snapshotHasUsableCeiling(under(), CEILING), true, "codex available at 5% is usable");
  assert.equal(snapshotHasUsableCeiling(allUnavailable(), CEILING), false, "all-unavailable is unknown, not usable");
  assert.equal(snapshotHasUsableCeiling(under(), null), false, "no ceiling configured → nothing usable");
});

// ---- the durable CURSOR ----------------------------------------------------------------------------

test("B cursor: a resume reloads completed keys from disk so the pass SKIPS them (no re-charge)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-"));
  const file = path.join(dir, "cur.jsonl");
  const c1 = makeReviewCursor(file);
  c1.markDone("k1");
  c1.markDone("k2");
  // A fresh process (--resume) constructs a NEW cursor over the same file → the keys persist.
  const c2 = makeReviewCursor(file);
  assert.equal(c2.isDone("k1"), true);
  assert.equal(c2.isDone("k2"), true);
  assert.equal(c2.isDone("k3"), false);
  assert.equal(c2.size(), 2);
});

test("B cursor: reset() clears the durable cursor (a fresh, non-resume pass starts empty)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-"));
  const file = path.join(dir, "cur.jsonl");
  const c = makeReviewCursor(file);
  c.markDone("k1");
  c.reset();
  assert.equal(c.size(), 0);
  assert.equal(makeReviewCursor(file).size(), 0, "reset is durable");
});

test("B cursor: a TORN trailing line is tolerated (safe direction: re-review, never skip an undone cell)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-"));
  const file = path.join(dir, "cur.jsonl");
  makeReviewCursor(file).markDone("k1");
  fs.appendFileSync(file, '{"k":"k2', "utf8"); // torn
  const c = makeReviewCursor(file);
  assert.equal(c.isDone("k1"), true, "the complete key survives");
  assert.equal(c.isDone("k2"), false, "the torn key is dropped → its cell is re-reviewed, not wrongly skipped");
});

// ---- the runtime GUARD -----------------------------------------------------------------------------

test("B guard: beforeCell QUIESCES on an over-ceiling read and is STICKY (bounds overshoot to in-flight)", async () => {
  let reads = 0;
  const guard = makeMidPassGuard({ readUsage: async () => (++reads, overCeiling()), usageCeiling: CEILING, now: () => NOW });
  assert.equal(await guard.beforeCell({}), true, "the first cell's pre-dispatch check quiesces");
  assert.equal(guard.quiesce.kind, "ceiling");
  assert.equal(await guard.beforeCell({}), true, "sticky: every later cell short-circuits to stop");
  assert.equal(reads, 1, "once quiesced it stops re-reading usage");
});

test("B guard: under-ceiling never quiesces; reads are cached to the guard cadence (coalesced)", async () => {
  let reads = 0;
  let t = NOW;
  const guard = makeMidPassGuard({ readUsage: async () => (++reads, under()), usageCeiling: CEILING, now: () => t });
  assert.equal(await guard.beforeCell({}), false);
  assert.equal(await guard.beforeCell({}), false);
  assert.equal(reads, 1, "a second cell within the cadence reuses the cached snapshot (no extra read)");
});

test("B guard: a persistently unreadable ceiling quiesces once the last-good read ages past the TTL", async () => {
  let t = NOW;
  const guard = makeMidPassGuard({ readUsage: async () => { throw new Error("network down"); }, usageCeiling: CEILING, now: () => t });
  assert.equal(await guard.beforeCell({}), false, "the first failed read is within the TTL → fail-soft, keep going");
  t += USAGE_TTL_MS + 1000; // the reader stayed down past the TTL
  assert.equal(await guard.beforeCell({}), true, "beyond the TTL a hard ceiling quiesces new paid work");
  assert.equal(guard.quiesce.kind, "stale-ceiling");
});

test("B guard: with a pause-only config, a persistently unreadable snapshot NEVER quiesces (fail-soft)", async () => {
  let t = NOW;
  const guard = makeMidPassGuard({ readUsage: async () => { throw new Error("down"); }, pause5h: PAUSE, now: () => t });
  assert.equal(await guard.beforeCell({}), false);
  t += USAGE_TTL_MS * 100;
  assert.equal(await guard.beforeCell({}), false, "the soft pause never quiesces on stale/unreadable usage");
});

// Claude-P2b REGRESSION PIN (guard half): the stale-TTL clock is RUN-wide, seeded via staleSinceMs. A
// guard rebuilt on a later pass whose seeded clock is ALREADY past the TTL quiesces the hard ceiling on
// its FIRST cell — the accrued staleness from prior passes is not forgotten. And the getter exposes the
// current clock so runFixLoop can re-checkpoint it.
test("P2b: a guard SEEDED with an already-stale run clock quiesces the hard ceiling on the FIRST cell", async () => {
  const guard = makeMidPassGuard({ readUsage: async () => { throw new Error("usage down"); }, usageCeiling: CEILING, now: () => NOW, staleSinceMs: NOW - (USAGE_TTL_MS + 1000) });
  assert.equal(await guard.beforeCell({}), true, "the persisted run-wide staleness is already past the TTL → quiesce immediately");
  assert.equal(guard.quiesce.kind, "stale-ceiling");
  assert.equal(guard.lastUsableAtMs, NOW - (USAGE_TTL_MS + 1000), "the seeded run-level clock is exposed for the loop to re-checkpoint");
});

test("P2b: even with a RUN-WIDE stale clock seeded far in the past, a PAUSE-only guard NEVER quiesces", async () => {
  const guard = makeMidPassGuard({ readUsage: async () => { throw new Error("down"); }, pause5h: PAUSE, now: () => NOW, staleSinceMs: NOW - USAGE_TTL_MS * 100 });
  assert.equal(await guard.beforeCell({}), false, "the soft 5h pause stays purely fail-soft across passes — stale usage never pauses it");
});

test("B guard: isDone/markDone delegate to the durable cursor (resume-skip wiring)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-"));
  const cursor = makeReviewCursor(path.join(dir, "c.jsonl"));
  const guard = makeMidPassGuard({ cursor, readUsage: async () => under(), usageCeiling: CEILING, now: () => NOW });
  guard.markDone("cellA");
  assert.equal(guard.isDone("cellA"), true);
  assert.equal(guard.isDone("cellB"), false);
});
