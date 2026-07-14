// Brocken B — six-eyes-PRESERVING front-loading: a DYNAMIC finding-density signal blended on top of the
// static `hotspot` so likely-buggy (already-found-a-finding-this-run) cells are SCHEDULED FIRST. This is
// ORDERING ONLY: every cell is still six-eyed, the sealed-manifest denominator is untouched, a tier still
// advances only at tierPending==0. These tests pin:
//   1. suspicionRank — the pure scorer: backward-compat (no counts ⇒ pure hotspot), equal-hotspot ordering,
//      the blend (lower hotspot + findings can outrank higher hotspot + none), and the stable tiebreak.
//   2. selectUnits — findingCounts absent ⇒ byte-identical to the pure-hotspot order; supplied ⇒ blended.
//   3. findingCountsByFile — the durable-store → {posixFile: n} map (the front-loading input).
//   4. Loop integration (the sweep scheduler via the real makeFixLoopDeps `review` closure): with
//      findingCounts the ORDER changes (a finding-file is drawn first) but the scheduled SET does NOT
//      (coverage/union unchanged); AND a REAL runFixLoop sweep converges with union==manifest while
//      front-loading is ACTIVE (durable findings on) — the coverage guarantee is intact.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { selectUnits, suspicionRank } from "../plugins/council/scripts/lib/audit-review.mjs";
import { findingCountsByFile } from "../plugins/council/scripts/lib/audit-findings-store.mjs";
import { makeFixLoopDeps } from "../plugins/council/scripts/lib/audit-fixloop-deps.mjs";
import { runFixLoop } from "../plugins/council/scripts/lib/audit-fixloop.mjs";
import { buildManifest, expectedKeys, makeTierSweepCursor, scopeGroupsForTier } from "../plugins/council/scripts/lib/audit-tier-sweep.mjs";
import { resolveLensGroups } from "../plugins/council/scripts/lib/audit-lens-groups.mjs";
import { chunkSource } from "../plugins/council/scripts/lib/audit-group-prompt.mjs";

const ALL_BACKENDS = { codex: { companionAvailable: true }, grok: { cli: { available: true } }, claude: { cli: { available: true } } };

// ── 1. suspicionRank (the pure scorer) ────────────────────────────────────────────────────────────

test("suspicionRank: no findingCounts ⇒ order is the pure hotspot order (byte-identical, deterministic tiebreak)", () => {
  const files = [
    { id: "a.mjs", hotspot: 10 },
    { id: "hot.mjs", hotspot: 90 },
    { id: "mid.mjs", hotspot: 50 },
    { id: "tie2.mjs", hotspot: 50 },
    { id: "tie1.mjs", hotspot: 50 }
  ];
  // Pure hotspot desc, then id asc — EXACTLY the legacy selectUnits comparator.
  const expected = [...files].sort((a, b) => b.hotspot - a.hotspot || a.id.localeCompare(b.id)).map((f) => f.id);
  assert.deepEqual(suspicionRank(files, {}).map((f) => f.id), expected);
  assert.deepEqual(suspicionRank(files, { findingCounts: {} }).map((f) => f.id), expected, "an EMPTY map is also pure hotspot");
  assert.deepEqual(suspicionRank(files).map((f) => f.id), expected, "absent options object ⇒ pure hotspot");
  // Pure function: the input array is never mutated.
  const before = files.map((f) => f.id);
  suspicionRank(files, { findingCounts: { "a.mjs": 3 } });
  assert.deepEqual(files.map((f) => f.id), before, "input not mutated");
});

test("suspicionRank: two EQUAL-hotspot files — the one with findings THIS RUN sorts FIRST", () => {
  const files = [
    { id: "aaa.mjs", hotspot: 50 }, // sorts first by id when neither has findings
    { id: "zzz.mjs", hotspot: 50 }
  ];
  assert.deepEqual(suspicionRank(files, {}).map((f) => f.id), ["aaa.mjs", "zzz.mjs"], "no findings ⇒ id tiebreak");
  assert.deepEqual(
    suspicionRank(files, { findingCounts: { "zzz.mjs": 1 } }).map((f) => f.id),
    ["zzz.mjs", "aaa.mjs"],
    "the equal-hotspot file WITH a finding is front-loaded ahead of the one with none"
  );
});

test("suspicionRank: the blend — a LOWER-hotspot file WITH findings can outrank a HIGHER-hotspot file with none", () => {
  const files = [
    { id: "hi.mjs", hotspot: 90 }, // higher static complexity, but clean this run
    { id: "lo.mjs", hotspot: 10 }  // lower static complexity, but already produced findings
  ];
  assert.deepEqual(suspicionRank(files, {}).map((f) => f.id), ["hi.mjs", "lo.mjs"], "no findings ⇒ hotspot wins");
  assert.deepEqual(
    suspicionRank(files, { findingCounts: { "lo.mjs": 2 } }).map((f) => f.id),
    ["lo.mjs", "hi.mjs"],
    "the dynamic finding-density signal front-loads the buggy-but-simpler file"
  );
});

test("suspicionRank: among finding-files, higher density sorts first; ties fall back to hotspot then id", () => {
  const files = [
    { id: "x.mjs", hotspot: 20 },
    { id: "y.mjs", hotspot: 20 },
    { id: "z.mjs", hotspot: 20 }
  ];
  // x has the most findings ⇒ first; y and z tie on 0 density ⇒ hotspot equal ⇒ id asc.
  assert.deepEqual(
    suspicionRank(files, { findingCounts: { "x.mjs": 5, "y.mjs": 0 } }).map((f) => f.id),
    ["x.mjs", "y.mjs", "z.mjs"]
  );
  // A backslash-bearing model id is posix-normalized on the ID side to match the posix count key
  // (findingCountsByFile always emits posix keys), so a Windows-style id still front-loads.
  assert.deepEqual(
    suspicionRank([{ id: "lib\\a.mjs", hotspot: 5 }, { id: "lib\\b.mjs", hotspot: 5 }], { findingCounts: { "lib/b.mjs": 1 } }).map((f) => f.id),
    ["lib\\b.mjs", "lib\\a.mjs"],
    "the id side is posix-normalized to match the posix findingCounts key"
  );
});

// ── 2. selectUnits wiring ─────────────────────────────────────────────────────────────────────────

test("selectUnits: findingCounts ABSENT ⇒ output IDENTICAL to the legacy pure-hotspot selection (backward-compat pin)", () => {
  const model = {
    files: [
      { id: "a.mjs", hotspot: 10, isTest: false },
      { id: "hot.mjs", hotspot: 90, isTest: false },
      { id: "mid.mjs", hotspot: 50, isTest: false },
      { id: "x.test.mjs", hotspot: 99, isTest: true }
    ]
  };
  // The exact assertions the legacy selectUnits test pins — must be unchanged.
  assert.deepEqual(selectUnits(model, { maxUnits: 2 }), ["hot.mjs", "mid.mjs"]);
  assert.deepEqual(selectUnits(model, { maxUnits: 2, offset: 2 }), ["a.mjs"]);
  assert.deepEqual(selectUnits(model, { maxUnits: 2, offset: 99 }), []);
});

test("selectUnits: with findingCounts, a lower-hotspot file with findings outranks a higher-hotspot file with none", () => {
  const model = {
    files: [
      { id: "hot.mjs", hotspot: 90, isTest: false },
      { id: "mid.mjs", hotspot: 50, isTest: false },
      { id: "low.mjs", hotspot: 10, isTest: false }
    ]
  };
  assert.deepEqual(selectUnits(model, { maxUnits: 3 }), ["hot.mjs", "mid.mjs", "low.mjs"], "no counts ⇒ pure hotspot");
  assert.deepEqual(
    selectUnits(model, { maxUnits: 3, findingCounts: { "low.mjs": 3 } }),
    ["low.mjs", "hot.mjs", "mid.mjs"],
    "the finding-file is front-loaded; the rest keep hotspot order"
  );
  // The SET (coverage) is unchanged — only the order differs.
  assert.deepEqual(
    new Set(selectUnits(model, { maxUnits: 3, findingCounts: { "low.mjs": 3 } })),
    new Set(selectUnits(model, { maxUnits: 3 })),
    "front-loading reorders the SAME selected set — never adds/removes a unit"
  );
});

// ── 3. findingCountsByFile (the durable-store → counts map) ────────────────────────────────────────

test("findingCountsByFile: counts per posix file; empty/absent ⇒ {}", () => {
  assert.deepEqual(findingCountsByFile([]), {});
  assert.deepEqual(findingCountsByFile(null), {});
  assert.deepEqual(
    findingCountsByFile([
      { file: "a.mjs" },
      { file: "a.mjs" },
      { file: "lib\\b.mjs" }, // backslash → normalized to posix
      { location: { path: "c.mjs" } }, // falls back to location.path
      { title: "no file" } // skipped
    ]),
    { "a.mjs": 2, "lib/b.mjs": 1, "c.mjs": 1 }
  );
});

// ── 4. Loop integration — the sweep pending scheduler via the REAL makeFixLoopDeps `review` closure ──

// A sweep cell key carries its posix file at array index 8 (see cellSweepKey); fileOfKey reads it back.
const keyForFile = (file) => JSON.stringify([1, "epoch", 2, "gsh", "gid", "rsh", "seat", "mih", file, 0, "hash"]);

// A deps bundle whose grouped-review is a SPY that records the scheduled file order (scopedModel.files),
// plus a fake reviewSweep whose cursor.tierPending returns a fixed pending set spanning the given files.
function mkSchedulerProbe(model, pendingFiles, opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-"));
  const scheduled = [];
  const spyReview = async (cwd, scopedModel) => {
    scheduled.push(scopedModel.files.map((f) => f.id));
    const n = scopedModel.files.length;
    return { findings: [], coverage: { ran: true, passComplete: true, complete: true, budgetSpent: n, unitsSelected: n, unitsReviewed: n } };
  };
  const stubCursor = makeTierSweepCursor(path.join(tmp, "led.jsonl"), {
    deps: { readFile: () => "", appendFile: () => {}, fsyncFile: () => {}, existsFile: () => false, writeFile: () => {}, now: () => 0 }
  });
  const deps = makeFixLoopDeps(tmp, model, ALL_BACKENDS, { epochSweep: true, lensGroups: "tier", perTierConvergence: true, maxCells: 100, ...opts },
    { runGroupedReview: spyReview, tierSweepCursor: stubCursor });
  const pendKeys = pendingFiles.map(keyForFile);
  const reviewSweep = {
    cursor: { tierPending: () => ({ count: pendKeys.length, keys: pendKeys }) },
    epochHash: "epoch",
    reviewerSet: deps.sweep.reviewerSet,
    manifest: {},
    scopedGroups: []
  };
  const runPass = async (findingCounts) => {
    scheduled.length = 0;
    await deps.review({ budget: 100, pass: 1, changedFiles: null, tier: 2, sweep: reviewSweep, findingCounts });
    return scheduled[0] ?? [];
  };
  return { runPass, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

test("sweep scheduler: findingCounts front-loads an EQUAL-hotspot finding-file first, WITHOUT changing the scheduled SET", async () => {
  // Two equal-hotspot pending files. Pure order = id asc (aaa, zzz). A finding on zzz must draw it first.
  const model = { files: [{ id: "aaa.mjs", hotspot: 50, isTest: false }, { id: "zzz.mjs", hotspot: 50, isTest: false }] };
  const probe = mkSchedulerProbe(model, ["aaa.mjs", "zzz.mjs"], { maxUnits: 2 });
  try {
    const baseline = await probe.runPass(undefined); // no store yet
    const frontloaded = await probe.runPass({ "zzz.mjs": 1 }); // zzz produced a finding this run
    assert.deepEqual(baseline, ["aaa.mjs", "zzz.mjs"], "no findingCounts ⇒ pure hotspot/id order (byte-identical)");
    assert.deepEqual(frontloaded, ["zzz.mjs", "aaa.mjs"], "the finding-file is scheduled FIRST");
    // COVERAGE UNCHANGED: the reorder schedules the SAME set of pending files — no cell added or dropped.
    assert.deepEqual(new Set(frontloaded), new Set(baseline), "front-loading only reorders; the scheduled set is identical");
  } finally {
    probe.cleanup();
  }
});

test("sweep scheduler: with maxUnits=1, a finding-file's cells are drawn a pass SOONER than an equal-hotspot no-finding file", async () => {
  const model = { files: [{ id: "aaa.mjs", hotspot: 50, isTest: false }, { id: "zzz.mjs", hotspot: 50, isTest: false }] };
  const probe = mkSchedulerProbe(model, ["aaa.mjs", "zzz.mjs"], { maxUnits: 1 });
  try {
    assert.deepEqual(await probe.runPass(undefined), ["aaa.mjs"], "pure order draws aaa first");
    assert.deepEqual(await probe.runPass({ "zzz.mjs": 2 }), ["zzz.mjs"], "front-loading draws zzz first — its pending cells are scheduled sooner");
  } finally {
    probe.cleanup();
  }
});

test("sweep scheduler: a lower-hotspot finding-file outranks a higher-hotspot clean file; changedFiles stay top priority", async () => {
  const model = {
    files: [
      { id: "hi.mjs", hotspot: 90, isTest: false },
      { id: "mid.mjs", hotspot: 50, isTest: false },
      { id: "lo.mjs", hotspot: 10, isTest: false }
    ]
  };
  const probe = mkSchedulerProbe(model, ["hi.mjs", "mid.mjs", "lo.mjs"], { maxUnits: 3 });
  try {
    assert.deepEqual(await probe.runPass(undefined), ["hi.mjs", "mid.mjs", "lo.mjs"], "pure hotspot order");
    assert.deepEqual(await probe.runPass({ "lo.mjs": 4 }), ["lo.mjs", "hi.mjs", "mid.mjs"], "low-hotspot finding-file front-loaded, rest by hotspot");
  } finally {
    probe.cleanup();
  }
});

// ── 5. NON-SWEEP regression (P1 guard) — front-loading must NOT touch the progressive-offset window ──
// The non-sweep loop reviews a MOVING `offset` window (offset = fullPasses*maxUnits % N) over the SORTED
// order. If findingCounts made that sort dynamic per pass, a shifting band boundary would SKIP a file (or
// re-review one before the dry-streak stop) — a real coverage regression. This drives the REAL non-sweep
// `review` closure across 3 full passes with a GROWING findingCounts and asserts (a) the loop NEVER forwards
// findingCounts to the offset window (doReview sees `undefined`), (b) the windows are the STATIC hotspot
// bands, and (c) their union covers ALL files (no skip). WITHOUT the P1 fix, assertion (a) fails.

test("non-sweep loop: findingCounts NEVER reaches the progressive-offset selectUnits window — the union of the offset bands still covers every file (no skip)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-nonsweep-"));
  // 3 files, distinct hotspots ⇒ static order [hi, mid, lo]; maxUnits=1 ⇒ each pass windows exactly one.
  const model = { files: [
    { id: "hi.mjs", hotspot: 90, isTest: false },
    { id: "mid.mjs", hotspot: 50, isTest: false },
    { id: "lo.mjs", hotspot: 10, isTest: false }
  ] };
  const windows = [];
  const seenFindingCounts = [];
  // The spy mirrors what runGroupedReview does internally: select via the offset window. It records the
  // findingCounts it was handed so the test can prove the loop passed NONE into the offset path.
  const spyReview = async (cwd, m, backends, options) => {
    seenFindingCounts.push(options.findingCounts);
    const sel = selectUnits(m, { maxUnits: options.maxUnits, offset: options.unitOffset, findingCounts: options.findingCounts });
    windows.push(sel);
    return { findings: [], coverage: { ran: true, passComplete: true, complete: true, budgetSpent: 1, unitsSelected: 1, unitsReviewed: 1 } };
  };
  try {
    // NON-sweep: lensGroups set (grouped path) but NO epochSweep ⇒ the review closure walks the offset window.
    const deps = makeFixLoopDeps(tmp, model, ALL_BACKENDS, { lensGroups: "tier", maxUnits: 1 }, { runGroupedReview: spyReview });
    // Simulate 3 full passes; a growing findingCounts (as the durable store would accrue) is passed to review.
    // Even though lo.mjs accrues findings, the offset window must stay static so all 3 files are covered.
    await deps.review({ budget: 10, pass: 1, changedFiles: null, findingCounts: {} });
    await deps.review({ budget: 10, pass: 2, changedFiles: null, findingCounts: { "lo.mjs": 3 } });
    await deps.review({ budget: 10, pass: 3, changedFiles: null, findingCounts: { "lo.mjs": 9, "mid.mjs": 4 } });
    // (a) the loop NEVER forwards findingCounts to the offset window (the P1 fix).
    assert.deepEqual(seenFindingCounts, [undefined, undefined, undefined], "the non-sweep offset window is never handed findingCounts");
    // (b) STATIC hotspot bands regardless of the growing findingCounts.
    assert.deepEqual(windows, [["hi.mjs"], ["mid.mjs"], ["lo.mjs"]], "the offset bands stay the static hotspot partition");
    // (c) NO SKIP: the union of the offset windows covers every file.
    assert.deepEqual(new Set(windows.flat()), new Set(["hi.mjs", "mid.mjs", "lo.mjs"]), "every file is windowed exactly once (coverage preserved)");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// A REAL runFixLoop sweep, front-loading ACTIVE (durable findings on), asserting the coverage guarantee
// holds: the sweep converges and the UNION of scheduled cells == the sealed manifest (no skip, no waste).

function cursorOn(store) {
  return makeTierSweepCursor("/led", {
    deps: {
      readFile: (p) => store.get(p) ?? "",
      appendFile: (p, d) => store.set(p, (store.get(p) ?? "") + d),
      fsyncFile: () => {},
      existsFile: (p) => store.has(p),
      writeFile: (p, d) => store.set(p, d),
      now: () => 0
    }
  });
}

test("sweep loop (front-loading ACTIVE): a low-hotspot file that produces a finding early still yields union==manifest and converges", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-loop-"));
  const spec = { "a.mjs": "export const a = 1;\n", "b.mjs": "export function b() { return 2; }\n", "lo.mjs": "export const lo = 3;\n" };
  for (const id of Object.keys(spec)) fs.writeFileSync(path.join(tmp, id), spec[id]);
  // lo.mjs has the LOWEST hotspot (normally scheduled last) but will produce a finding early → front-loaded.
  const model = { files: [
    { id: "a.mjs", isTest: false, hotspot: 9, loc: 1, branches: 0 },
    { id: "b.mjs", isTest: false, hotspot: 8, loc: 1, branches: 0 },
    { id: "lo.mjs", isTest: false, hotspot: 1, loc: 1, branches: 0 }
  ] };
  try {
    const store = new Map();
    const cursor = cursorOn(store);
    const scheduledKeys = [];
    // A driver that (a) marks every scheduled cell of the selected files DONE (records its key), and
    // (b) durably APPENDS a benign propose-only finding on lo.mjs the first time lo.mjs is scheduled —
    // so from the next pass on, findingCounts front-loads lo.mjs (through the REAL orderPendingFiles).
    let appended = false;
    const driver = async (cwd, scopedModel, backends, options) => {
      const selected = scopedModel.files.map((f) => f.id);
      const scoped = scopeGroupsForTier(resolveLensGroups(options.lensGroups), options.tier);
      const chunksOf = (f) => chunkSource(fs.readFileSync(path.join(tmp, f), "utf8"));
      const manifest = buildManifest({ files: selected, chunksOf, isSupplied: () => true });
      for (const k of expectedKeys(manifest, options.tier, scoped, options.sweep.reviewerSet, options.sweep.epochHash)) {
        scheduledKeys.push(k);
        options.sweep.cursor.markDone(k, { pass: options.pass });
      }
      if (!appended && selected.includes("lo.mjs")) {
        appended = true;
        options.findingsAppender?.append([{ file: "lo.mjs", severity: "P2", category: "architecture", lens: "architecture_ssot", title: "cross-cutting", detail: "x", line: 1 }], { pass: options.pass });
      }
      return { findings: [], coverage: { ran: true, passComplete: true, complete: true, budgetSpent: selected.length, unitsSelected: selected.length, unitsReviewed: selected.length } };
    };
    const noFix = async () => ({ fixed: [], failed: [], rejected: [], changedFiles: [], spent: 0, branch: "council/x", ok: true });
    const opts = { epochSweep: true, lensGroups: "tier", perTierConvergence: true, structureAutoApply: false, maxUnits: 1, maxCells: 100, ledger: false, durableFindings: true };
    const deps = makeFixLoopDeps(tmp, model, ALL_BACKENDS, opts, { runGroupedReview: driver, runAuditFix: noFix, tierSweepCursor: cursor });
    const out = await runFixLoop(tmp, { ...opts, budget: 5000, maxPasses: 100, dryStreak: 1 }, deps);

    assert.match(out.stopReason ?? "", /epoch-sweep converged/, "the sweep converges with front-loading active");
    assert.ok(appended, "lo.mjs's finding was recorded (front-loading input was live)");
    // (II) NO SKIP + (III) NO WASTE — the coverage guarantee is untouched by the reorder.
    assert.equal(new Set(scheduledKeys).size, scheduledKeys.length, "no cell scheduled twice at an unchanged hash (no waste)");
    const finalManifest = deps.sweep.buildManifest();
    const finalExpected = new Set();
    for (const t of [0, 1, 2, 3]) {
      const scoped = scopeGroupsForTier(deps.sweep.baseGroups, t);
      for (const k of expectedKeys(finalManifest, t, scoped, deps.sweep.reviewerSet, deps.sweep.epochHash)) finalExpected.add(k);
    }
    assert.deepEqual(new Set(scheduledKeys), finalExpected, "the scheduled union == the manifest (coverage/union UNCHANGED by front-loading)");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
