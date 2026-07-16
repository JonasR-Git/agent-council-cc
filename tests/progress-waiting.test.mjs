// Liveness heartbeat during long in-process waits. A rate-limit backoff (up to ~15 min) or a
// --pause-at-5h quota wait (up to hours) emits no other progress events, so without a heartbeat
// updatedAt freezes for the whole wait and a watcher/monitor mistakes a healthy waiting run for a
// hang and KILLS it (this is exactly what kept killing the CubeServHub fix loop). These pin the
// `waiting` progress field + observableWait's chunked heartbeat that keeps progress.json fresh.

import test from "node:test";
import assert from "node:assert/strict";

import {
  NOOP_REPORTER,
  initialProgressState,
  makeProgressReporter,
  mergeProgressEvent,
  mutedFindingsReporter,
  observableWait
} from "../plugins/council/scripts/lib/progress.mjs";
import { renderProgressDashboard } from "../plugins/council/scripts/lib/watch.mjs";

function runningStateWaiting(extra = {}) {
  return {
    ...initialProgressState({ kind: "audit-fix-loop", startedAt: "2026-07-16T00:00:00.000Z" }),
    phase: "review",
    updatedAt: "2026-07-16T00:00:10.000Z",
    waiting: { reason: "rate-limit backoff", remainingMs: 180_000, resumeAt: "2026-07-16T00:03:10.000Z" },
    ...extra
  };
}

test("mergeProgressEvent 'waiting' sets a sanitized descriptor and stamps updatedAt; null clears it", () => {
  const a = mergeProgressEvent(initialProgressState({ startedAt: "t0" }), {
    type: "waiting",
    at: "t1",
    waiting: { reason: "rate-limit backoff", remainingMs: 4000, resumeAt: "2026-07-16T00:00:00.000Z", junk: "x" }
  });
  assert.equal(a.updatedAt, "t1", "a waiting stamp advances updatedAt (the proof-of-life)");
  assert.deepEqual(a.waiting, {
    reason: "rate-limit backoff",
    remainingMs: 4000,
    resumeAt: "2026-07-16T00:00:00.000Z"
  });
  // Garbage numerics -> null; a non-string resumeAt -> null; unknown field dropped.
  const b = mergeProgressEvent(a, { type: "waiting", at: "t2", waiting: { reason: "x", remainingMs: "NaN", resumeAt: 5 } });
  assert.deepEqual(b.waiting, { reason: "x", remainingMs: null, resumeAt: null });
  // null clears.
  const c = mergeProgressEvent(b, { type: "waiting", at: "t3", waiting: null });
  assert.equal(c.waiting, null);
});

test("mergeProgressEvent 'done' clears any lingering waiting descriptor", () => {
  const waiting = mergeProgressEvent(initialProgressState(), { type: "waiting", waiting: { reason: "quota pause" } });
  assert.ok(waiting.waiting, "precondition: waiting is set");
  const done = mergeProgressEvent(waiting, { type: "done", ok: true });
  assert.equal(done.waiting, null, "a terminal run is not waiting on anything");
});

test("reporter.waiting persists the descriptor to progress.json and clears on null", () => {
  const writes = [];
  const clock = (() => {
    let n = 0;
    return () => `t${n++}`;
  })();
  const reporter = makeProgressReporter({
    kind: "audit-fix-loop",
    stateDir: "/state",
    now: clock,
    writeFile: (file, data) => writes.push({ file, data })
  });
  reporter.waiting({ reason: "rate-limit backoff", remainingMs: 3000, resumeAt: "2026-07-16T00:00:00.000Z" });
  let last = JSON.parse(writes.at(-1).data);
  assert.equal(last.waiting.reason, "rate-limit backoff");
  assert.equal(last.waiting.remainingMs, 3000);
  reporter.waiting(null);
  last = JSON.parse(writes.at(-1).data);
  assert.equal(last.waiting, null);
});

test("NOOP_REPORTER.waiting is chainable and mutedFindingsReporter forwards waiting", () => {
  assert.equal(NOOP_REPORTER.waiting({ reason: "x" }), NOOP_REPORTER);
  const seen = [];
  const base = { ...NOOP_REPORTER, waiting: (info) => (seen.push(info), base) };
  const muted = mutedFindingsReporter(base);
  muted.waiting({ reason: "backoff" });
  assert.deepEqual(seen, [{ reason: "backoff" }]);
});

test("observableWait heartbeats through the reporter across the wait, then clears (injected clock+sleep)", async () => {
  // A 60s wait in 20s steps: expect stamps at 60s/40s/20s remaining, then a null clear = 4 calls.
  const calls = [];
  const reporter = { waiting: (info) => calls.push(info) };
  let nowMs = 1_000_000;
  const clock = () => nowMs;
  const sleep = (ms) => {
    nowMs += ms; // deterministic virtual time
    return Promise.resolve();
  };
  await observableWait(60_000, { reporter, reason: "rate-limit backoff", stepMs: 20_000, sleep, clock });
  assert.equal(calls.length, 4, "3 countdown stamps + 1 clear");
  assert.deepEqual(calls.slice(0, 3).map((c) => c && c.remainingMs), [60_000, 40_000, 20_000]);
  assert.ok(calls.slice(0, 3).every((c) => c.reason === "rate-limit backoff"));
  assert.equal(calls.at(-1), null, "the wait clears the waiting state when it ends");
});

test("observableWait resolves immediately (no reporter touch) for a non-positive/NaN wait", async () => {
  const calls = [];
  const reporter = { waiting: (info) => calls.push(info) };
  await observableWait(0, { reporter });
  await observableWait(-5, { reporter });
  await observableWait(NaN, { reporter });
  assert.deepEqual(calls, [], "a no-op wait never stamps waiting");
});

test("observableWait clears the waiting state even if the sleep throws (finally)", async () => {
  const calls = [];
  const reporter = { waiting: (info) => calls.push(info) };
  const clock = () => 0; // remaining stays positive so the first chunk is attempted
  const sleep = () => Promise.reject(new Error("interrupted"));
  await assert.rejects(
    observableWait(10_000, { reporter, reason: "quota pause", sleep, clock }),
    /interrupted/
  );
  assert.equal(calls.at(-1), null, "waiting is cleared on throw so no stale wait lingers");
});

test("observableWait tolerates a reporter with no .waiting method (fail-soft) and still waits fully", async () => {
  let nowMs = 0;
  const clock = () => nowMs;
  let slept = 0;
  const sleep = (ms) => {
    nowMs += ms;
    slept += ms;
    return Promise.resolve();
  };
  await observableWait(50_000, { reporter: NOOP_REPORTER, stepMs: 20_000, sleep, clock });
  assert.equal(slept, 50_000, "the full wait elapses regardless of the reporter surface");
});

test("renderProgressDashboard (plain box) shows a ⏳ waiting line with a countdown while backing off", () => {
  const out = renderProgressDashboard(runningStateWaiting(), { nowMs: Date.parse("2026-07-16T00:00:10.000Z") });
  assert.match(out, /waiting: rate-limit backoff/);
  assert.match(out, /resuming in ~3m/);
});

test("renderProgressDashboard (markdown) shows the ⏳ waiting callout while backing off", () => {
  const out = renderProgressDashboard(runningStateWaiting(), { md: true, nowMs: Date.parse("2026-07-16T00:00:10.000Z") });
  assert.match(out, /> ⏳ waiting: rate-limit backoff/);
});

test("a terminal (done) run never renders a stale waiting line even if the field lingers", () => {
  // Defensive: normalization suppresses `waiting` once terminal, so a leftover descriptor can't
  // make a finished run look like it is still backing off.
  const done = runningStateWaiting({ done: true, phase: "done" });
  const box = renderProgressDashboard(done, { nowMs: Date.parse("2026-07-16T01:00:00.000Z") });
  const md = renderProgressDashboard(done, { md: true, nowMs: Date.parse("2026-07-16T01:00:00.000Z") });
  assert.doesNotMatch(box, /waiting:/);
  assert.doesNotMatch(md, /waiting:/);
});
