import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runDeliberation } from "../plugins/council/scripts/lib/deliberate.mjs";
import {
  NOOP_REPORTER,
  PROGRESS_FILE,
  PROGRESS_SCHEMA_VERSION,
  initialProgressState,
  makeProgressReporter,
  mergeProgressEvent,
  mutedFindingsReporter
} from "../plugins/council/scripts/lib/progress.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("runDeliberation emits ordered phase callbacks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-phase-"));
  execSync("git init -q", { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n", "utf8");

  const phases = [];
  const findingsFile = path.join(dir, "claude.json");
  fs.writeFileSync(
    findingsFile,
    JSON.stringify({ agent: "claude", summary: "s", verdict: "approve", findings: [] }),
    "utf8"
  );

  const result = await runDeliberation(dir, { codex: {}, grok: {} }, {
    skipCodex: true,
    skipGrok: true,
    claudeFindingsPath: findingsFile,
    onPhase: (p) => phases.push(p)
  });

  assert.equal(result.mode, "deliberate");
  assert.equal(phases[0], "collecting-context");
  assert.ok(phases.includes("r1"));
  assert.ok(phases.includes("r1-done"));
  assert.ok(phases.indexOf("r1") < phases.indexOf("r1-done"));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("finding 8: a THROWING onPhase hook never aborts runDeliberation (fail-soft telemetry)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-phase-throw-"));
  execSync("git init -q", { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n", "utf8");
  const findingsFile = path.join(dir, "claude.json");
  fs.writeFileSync(findingsFile, JSON.stringify({ agent: "claude", summary: "s", verdict: "approve", findings: [] }), "utf8");

  let calls = 0;
  // The onPhase hook is untrusted telemetry: every call throws, yet the deliberation must complete.
  const result = await runDeliberation(dir, { codex: {}, grok: {} }, {
    skipCodex: true,
    skipGrok: true,
    claudeFindingsPath: findingsFile,
    onPhase: () => {
      calls += 1;
      throw new Error("telemetry hook exploded");
    }
  });
  assert.equal(result.mode, "deliberate", "the run finished despite every onPhase call throwing");
  assert.ok(calls > 0, "the throwing hook really was invoked (and swallowed, not propagated)");
  assert.ok(ROOT.length > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- shared progress model + reporter (progress.json writer side) -----------

/** Deterministic injected clock: each call advances one second. */
function makeClock(startMs = Date.parse("2026-07-13T00:00:00Z")) {
  let t = startMs - 1000;
  return () => new Date((t += 1000)).toISOString();
}

test("initialProgressState matches the schemaVersion-1 contract shape", () => {
  const s = initialProgressState({ kind: "build", title: "council build", jobId: "j1", startedAt: "2026-07-13T00:00:00.000Z" });
  assert.equal(s.schemaVersion, PROGRESS_SCHEMA_VERSION);
  assert.equal(s.kind, "build");
  assert.equal(s.jobId, "j1");
  assert.equal(s.title, "council build");
  assert.equal(s.startedAt, "2026-07-13T00:00:00.000Z");
  assert.equal(s.updatedAt, s.startedAt);
  assert.equal(s.phase, null);
  assert.deepEqual(s.seats, []);
  // progress/counters/findingsByLens start EMPTY (not zero-filled): a field only
  // appears once reported, so the reader can tell "not measured" from a real 0.
  assert.deepEqual(s.progress, {});
  assert.deepEqual(s.counters, {});
  assert.deepEqual(s.findingsByLens, {});
  assert.equal(s.gate, null);
  assert.equal(s.budget, null);
  assert.equal(s.etaMs, null);
  assert.deepEqual(s.recentLines, []);
  assert.equal(s.done, false);
  assert.equal(s.ok, null);
  assert.equal(s.stopReason, null);
});

test("a sequence of phase/seat/counter/gate/progress/budget/eta calls produces the expected snapshot and writes it each time", () => {
  const writes = [];
  const reporter = makeProgressReporter({
    kind: "audit-fix-loop",
    title: "audit fix --loop --chartest",
    jobId: "job-1",
    stateDir: "/state/dir",
    now: makeClock(),
    writeFile: (file, data) => writes.push({ file, data })
  });

  reporter.phase("review", "pass 1: reviewing 4 files");
  reporter.seat("codex", { state: "reviewing", unitsTotal: 4 });
  reporter.seat("codex", { state: "done", unitsDone: 4, raised: 2 });
  reporter.seat("grok", { state: "reviewing" });
  reporter.counter("fixed");
  reporter.counter("fixed", 2);
  reporter.counter("proposed", 5);
  reporter.gate({ name: "char-test", target: "lib/a.mjs", state: "running" });
  reporter.gate({ state: "pass" }); // merges into the existing gate
  reporter.progress({ unitsDone: 4, unitsTotal: 9, passesDone: 1, passesTotal: 3 });
  reporter.budget(2, 20);
  reporter.eta(90_000);

  const snap = reporter.snapshot();
  assert.equal(snap.schemaVersion, 1);
  assert.equal(snap.kind, "audit-fix-loop");
  assert.equal(snap.jobId, "job-1");
  assert.equal(snap.phase, "review");
  assert.equal(snap.phaseDetail, "pass 1: reviewing 4 files");
  assert.deepEqual(snap.seats, [
    { name: "codex", state: "done", unitsDone: 4, unitsTotal: 4, raised: 2 },
    { name: "grok", state: "reviewing", unitsDone: 0, unitsTotal: 0, raised: 0 }
  ]);
  assert.equal(snap.counters.fixed, 3, "counter defaults to +1 and accumulates deltas");
  assert.equal(snap.counters.proposed, 5);
  assert.deepEqual(snap.gate, { name: "char-test", target: "lib/a.mjs", state: "pass" });
  assert.deepEqual(snap.progress, { unitsDone: 4, unitsTotal: 9, passesDone: 1, passesTotal: 3 });
  assert.deepEqual(snap.budget, { spent: 2, total: 20 });
  assert.equal(snap.etaMs, 90_000);
  assert.equal(snap.done, false);
  assert.ok(snap.updatedAt > snap.startedAt, "updatedAt is stamped via now() on every call");

  // one initial write + one per mutating call, all to ${stateDir}/progress.json
  assert.equal(writes.length, 13);
  assert.ok(writes.every((w) => w.file === `/state/dir/${PROGRESS_FILE}`));
  const first = JSON.parse(writes[0].data);
  assert.equal(first.phase, null, "the run is announced immediately at creation");
  assert.deepEqual(JSON.parse(writes[writes.length - 1].data), snap, "the persisted snapshot IS the in-memory state");
});

test("phase without detail clears the previous phaseDetail; gate(null) clears the gate", () => {
  const reporter = makeProgressReporter({ now: makeClock(), writeFile: () => {} });
  reporter.phase("review", "detail A");
  reporter.gate({ name: "structure", state: "running" });
  reporter.phase("fix");
  reporter.gate(null);
  const snap = reporter.snapshot();
  assert.equal(snap.phase, "fix");
  assert.equal(snap.phaseDetail, null, "stale detail from the previous phase is dropped");
  assert.equal(snap.gate, null);
});

test("recentLines is capped at maxRecentLines with the newest kept, and logSink receives every .line verbatim", () => {
  const sunk = [];
  const reporter = makeProgressReporter({
    now: makeClock(),
    writeFile: () => {},
    logSink: (m) => sunk.push(m),
    maxRecentLines: 3
  });
  const lines = ["pass 1: review…", "  codex done raised=2", "  grok done raised=1", "gate: char-test pass", "pass 1: fixed 2"];
  for (const l of lines) reporter.line(l);

  assert.deepEqual(sunk, lines, "byte-compatible: every line reaches logSink unmodified, in order");
  assert.deepEqual(reporter.snapshot().recentLines, lines.slice(-3), "capped, newest last");
});

test("a throwing writeFile is swallowed (fail-soft) and the state still advances", () => {
  let attempts = 0;
  const reporter = makeProgressReporter({
    kind: "plan",
    stateDir: "/state/dir",
    now: makeClock(),
    writeFile: () => {
      attempts += 1;
      throw new Error("disk full");
    }
  });
  assert.doesNotThrow(() => {
    reporter.phase("council", "round 1");
    reporter.counter("proposed", 3);
    reporter.line("still alive");
    reporter.done({ ok: true, stopReason: "complete" });
  });
  assert.ok(attempts >= 4, "the write was attempted each time (and swallowed)");
  const snap = reporter.snapshot();
  assert.equal(snap.counters.proposed, 3);
  assert.deepEqual(snap.recentLines, ["still alive"]);
  assert.equal(snap.done, true);
});

test("a throwing logSink and a throwing now() never escape the reporter", () => {
  const reporter = makeProgressReporter({
    now: () => {
      throw new Error("no clock");
    },
    writeFile: () => {},
    logSink: () => {
      throw new Error("broken pipe");
    }
  });
  assert.doesNotThrow(() => {
    reporter.line("hello");
    reporter.phase("review");
  });
  const snap = reporter.snapshot();
  assert.deepEqual(snap.recentLines, ["hello"], "the state still advanced");
  assert.equal(snap.updatedAt, null, "a broken clock leaves the stamp alone instead of corrupting it");
});

test("snapshot() returns a deep copy - mutating it does not corrupt the reporter", () => {
  const reporter = makeProgressReporter({ now: makeClock(), writeFile: () => {} });
  reporter.seat("codex", { state: "reviewing" });
  reporter.counter("fixed", 1);
  reporter.line("one");

  const snap = reporter.snapshot();
  snap.seats[0].state = "hacked";
  snap.counters.fixed = 999;
  snap.recentLines.push("injected");
  snap.done = true;

  const fresh = reporter.snapshot();
  assert.equal(fresh.seats[0].state, "reviewing");
  assert.equal(fresh.counters.fixed, 1);
  assert.deepEqual(fresh.recentLines, ["one"]);
  assert.equal(fresh.done, false);
});

test("done() records ok/stopReason and mirrors the outcome into phase", () => {
  const ok = makeProgressReporter({ now: makeClock(), writeFile: () => {} });
  ok.done({ ok: true, stopReason: "budget-exhausted" });
  assert.deepEqual(
    { done: ok.snapshot().done, ok: ok.snapshot().ok, stopReason: ok.snapshot().stopReason, phase: ok.snapshot().phase },
    { done: true, ok: true, stopReason: "budget-exhausted", phase: "done" }
  );

  const failed = makeProgressReporter({ now: makeClock(), writeFile: () => {} });
  failed.done({ ok: false, stopReason: "crash" });
  assert.equal(failed.snapshot().phase, "failed");
  assert.equal(failed.snapshot().ok, false);
});

test("without a stateDir the reporter is in-memory only and never calls writeFile", () => {
  let calls = 0;
  const reporter = makeProgressReporter({
    now: makeClock(),
    writeFile: () => {
      calls += 1;
    }
  });
  reporter.phase("preflight");
  reporter.counter("fixed");
  assert.equal(calls, 0);
  assert.equal(reporter.snapshot().phase, "preflight");
});

test("mergeProgressEvent is pure: the input state is never mutated", () => {
  const s0 = initialProgressState({ kind: "audit-review", startedAt: "2026-07-13T00:00:00.000Z" });
  const before = structuredClone(s0);
  const s1 = mergeProgressEvent(s0, { type: "counter", key: "fixed", delta: 2, at: "2026-07-13T00:00:01.000Z" });
  assert.deepEqual(s0, before, "input untouched");
  assert.notEqual(s1, s0);
  assert.equal(s1.counters.fixed, 2);
  assert.equal(s1.updatedAt, "2026-07-13T00:00:01.000Z");

  const s2 = mergeProgressEvent(s1, { type: "seat", name: "grok", patch: { state: "voting" }, at: "2026-07-13T00:00:02.000Z" });
  assert.deepEqual(s1.seats, [], "seat creation does not leak into the prior state");
  assert.deepEqual(s2.seats, [{ name: "grok", state: "voting", unitsDone: 0, unitsTotal: 0, raised: 0 }]);
});

test("mergeProgressEvent tolerates junk: unknown types, null state, a seat patch trying to rename", () => {
  const s1 = mergeProgressEvent(null, { type: "totally-new-event", at: "2026-07-13T00:00:01.000Z" });
  assert.equal(s1.schemaVersion, PROGRESS_SCHEMA_VERSION, "null state falls back to the initial shape");
  assert.equal(s1.updatedAt, "2026-07-13T00:00:01.000Z", "unknown types still stamp updatedAt, change nothing else");

  const s2 = mergeProgressEvent(s1, { type: "seat", name: "codex", patch: { name: "evil", state: "done" } });
  assert.equal(s2.seats[0].name, "codex", "a patch can never rename a seat");
  assert.equal(s2.seats[0].state, "done");

  const s3 = mergeProgressEvent(s2, { type: "eta", ms: "soon" });
  assert.equal(s3.etaMs, null, "a non-numeric eta normalizes to null");
});

test(".findings aggregates a batch by lens+severity and bumps the named seat's raised", () => {
  const reporter = makeProgressReporter({ now: makeClock(), writeFile: () => {} });
  reporter.findings(
    [
      { lens: "correctness", severity: "P0" },
      { lens: "correctness", severity: "P2" },
      { lens: "security", severity: "P1" },
      { category: "efficiency", severity: "nit" } // category fallback when lens absent
    ],
    { seat: "codex" }
  );
  const snap = reporter.snapshot();
  assert.deepEqual(snap.findingsByLens.correctness, { total: 2, P0: 1, P1: 0, P2: 1, nit: 0 });
  assert.deepEqual(snap.findingsByLens.security, { total: 1, P0: 0, P1: 1, P2: 0, nit: 0 });
  assert.deepEqual(snap.findingsByLens.efficiency, { total: 1, P0: 0, P1: 0, P2: 0, nit: 1 });
  assert.equal(snap.seats.find((s) => s.name === "codex").raised, 4, "raised bumped by batch size");

  // A second batch accumulates into the existing cells and raised count.
  reporter.findings([{ lens: "correctness", severity: "P1" }], { seat: "codex" });
  const snap2 = reporter.snapshot();
  assert.deepEqual(snap2.findingsByLens.correctness, { total: 3, P0: 1, P1: 1, P2: 1, nit: 0 });
  assert.equal(snap2.seats.find((s) => s.name === "codex").raised, 5);
});

test("NOOP_REPORTER has the full reporter surface: every method callable + chainable, snapshot() null", () => {
  const real = makeProgressReporter({ now: makeClock(), writeFile: () => {} });
  for (const method of Object.keys(real)) {
    assert.equal(typeof NOOP_REPORTER[method], "function", `NOOP_REPORTER.${method} exists`);
  }
  assert.doesNotThrow(() => {
    const chained = NOOP_REPORTER.phase("review", "detail")
      .seat("codex", { state: "reviewing" })
      .counter("fixed", 2)
      .gate({ name: "g", state: "running" })
      .progress({ unitsDone: 1, unitsTotal: 2 })
      .findings([{ lens: "correctness", severity: "P0" }], { seat: "codex" })
      .budget(1, 10)
      .eta(1000)
      .line("hello")
      .done({ ok: true });
    assert.equal(chained, NOOP_REPORTER, "every method returns the reporter (chainable)");
  });
  assert.equal(NOOP_REPORTER.snapshot(), null, "no state to snapshot");
});

test("finding 1: a lens/counter literally named __proto__ or constructor is a REAL own key, never poisons the map", () => {
  const before = initialProgressState();
  const s = mergeProgressEvent(before, {
    type: "findings",
    list: [
      { lens: "__proto__", severity: "P0" },
      { lens: "constructor", severity: "P1" },
      { lens: "normal", severity: "P2" }
    ]
  });
  // Stored as REAL own keys — a plain {} accumulator would route "__proto__" through the prototype
  // setter and silently drop the finding (or reparent the whole map).
  assert.ok(Object.hasOwn(s.findingsByLens, "__proto__"), "__proto__ is an OWN key of the matrix");
  assert.ok(Object.hasOwn(s.findingsByLens, "constructor"), "constructor is an OWN key of the matrix");
  assert.deepEqual(s.findingsByLens["__proto__"], { total: 1, P0: 1, P1: 0, P2: 0, nit: 0 });
  assert.deepEqual(s.findingsByLens["constructor"], { total: 1, P0: 0, P1: 1, P2: 0, nit: 0 });
  assert.deepEqual(s.findingsByLens["normal"], { total: 1, P0: 0, P1: 0, P2: 1, nit: 0 });
  assert.equal(Object.getPrototypeOf(s.findingsByLens), null, "the accumulator is a null-proto map, not reparented");
  // Purity: the input state was not mutated (its matrix stays empty).
  assert.deepEqual(before.findingsByLens, {}, "mergeProgressEvent stayed pure — input matrix untouched");
  // The counter reducer is hardened the same way.
  const c = mergeProgressEvent(initialProgressState(), { type: "counter", key: "__proto__", delta: 3 });
  assert.ok(Object.hasOwn(c.counters, "__proto__"), "a __proto__ counter is an OWN key, not a dropped setter write");
  assert.equal(c.counters["__proto__"], 3);
  assert.equal(Object.getPrototypeOf(c.counters), null);
  // And it survives the JSON round-trip the dashboard actually reads back.
  const round = JSON.parse(JSON.stringify(s.findingsByLens));
  assert.deepEqual(round["__proto__"], { total: 1, P0: 1, P1: 0, P2: 0, nit: 0 });
});

test("finding 10: mutedFindingsReporter forwards every live signal but makes .findings() a no-op", () => {
  const real = makeProgressReporter({ now: makeClock(), writeFile: () => {} });
  const muted = mutedFindingsReporter(real);
  // findings() is MUTED so an inner review can't double-count against an outer loop that already folds.
  const chained = muted.findings([{ lens: "security", severity: "P0" }], { seat: "codex" });
  assert.equal(chained, muted, "findings() returns the wrapper (chainable) …");
  assert.deepEqual(real.snapshot().findingsByLens, {}, "… but folds NOTHING into the real matrix");
  // Every other signal forwards to the real reporter, so live per-unit progress still advances.
  muted.phase("review", "12 units").progress({ unitsDone: 3, unitsTotal: 12 }).counter("proposed", 2).seat("codex", { state: "reviewing" }).gate({ name: "g", state: "running" });
  const snap = real.snapshot();
  assert.equal(snap.phase, "review");
  assert.equal(snap.phaseDetail, "12 units");
  assert.deepEqual(snap.progress, { unitsDone: 3, unitsTotal: 12 });
  assert.equal(snap.counters.proposed, 2);
  assert.equal(snap.seats.find((s) => s.name === "codex").state, "reviewing");
  assert.equal(snap.gate.state, "running");
  // snapshot() delegates to the wrapped reporter (still zero findings).
  assert.deepEqual(muted.snapshot().findingsByLens, {}, "snapshot() delegates and findings stayed muted");
});

test(".findings tolerates junk and an unknown severity buckets to nit; no seat = no raised", () => {
  const s = mergeProgressEvent(initialProgressState(), {
    type: "findings",
    list: [null, 42, { severity: "bogus" }, { lens: "x", severity: "P0" }]
  });
  // null/42 skipped; {severity:"bogus"} -> lens "other", nit bucket; {lens:"x"} -> P0.
  assert.deepEqual(s.findingsByLens.other, { total: 1, P0: 0, P1: 0, P2: 0, nit: 1 });
  assert.deepEqual(s.findingsByLens.x, { total: 1, P0: 1, P1: 0, P2: 0, nit: 0 });
  assert.deepEqual(s.seats, [], "no seat named -> no raised side-effect");
});
