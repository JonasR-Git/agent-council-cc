// WAVE 3 (epoch-sweep) — FINDINGS-STORE sweepCellKey staleness. docs/epoch-sweep-design.md §D6.
// The durable findings store is APPEND-ONLY, so a finding whose source cell's CONTENT has since moved (a
// fix re-chunked the file) or whose epoch changed would be re-offered from the store union to the gate
// FOREVER — a stale actionable set. Wave 3 STAMPS each sweep-mode store record with its source sweepCellKey
// (+ epoch) and the loop EXCLUDES any stamped record whose key is no longer an expected key under the
// current sealed manifest/epoch. Legacy / non-sweep / unstamped records are ALWAYS-CURRENT (byte-identical).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeFindingsAppender, readFindingsStore } from "../plugins/council/scripts/lib/audit-findings-store.mjs";
import { runFixLoop } from "../plugins/council/scripts/lib/audit-fixloop.mjs";
import { makeFixLoopDeps } from "../plugins/council/scripts/lib/audit-fixloop-deps.mjs";
import { expectedKeys, fileOfKey, makeTierSweepCursor, scopeGroupsForTier } from "../plugins/council/scripts/lib/audit-tier-sweep.mjs";
import { resolveLensGroups } from "../plugins/council/scripts/lib/audit-lens-groups.mjs";
import { buildManifest as buildManifestPure } from "../plugins/council/scripts/lib/audit-tier-sweep.mjs";
import { chunkSource } from "../plugins/council/scripts/lib/audit-group-prompt.mjs";

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
const BACKENDS = { codex: { companionAvailable: true }, grok: { cli: { available: true } }, claude: { cli: { available: true } } };
const MODEL = { files: [{ id: "a.mjs", isTest: false, hotspot: 2, loc: 1, branches: 0 }, { id: "b.mjs", isTest: false, hotspot: 1, loc: 1, branches: 0 }] };

function mkWorkspace() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-store-"));
  fs.writeFileSync(path.join(tmp, "a.mjs"), "export const a = 1;\n");
  fs.writeFileSync(path.join(tmp, "b.mjs"), "export function b() { return 2; }\n");
  return tmp;
}
const rmWorkspace = (tmp) => fs.rmSync(tmp, { recursive: true, force: true });

function mkFakeGroupedReview(tmp, reviewedLog) {
  return async (cwd, scopedModel, backends, options) => {
    const selected = scopedModel.files.map((f) => f.id);
    reviewedLog.push({ tier: options.tier, files: [...selected] });
    const scoped = scopeGroupsForTier(resolveLensGroups(options.lensGroups), options.tier);
    const chunksOf = (f) => chunkSource(fs.readFileSync(path.join(tmp, f), "utf8"));
    const manifest = buildManifestPure({ files: selected, chunksOf, isSupplied: () => true });
    for (const k of expectedKeys(manifest, options.tier, scoped, options.sweep.reviewerSet, options.sweep.epochHash)) {
      options.sweep.cursor.markDone(k, { pass: options.pass });
    }
    return { findings: [], coverage: { ran: true, passComplete: true, complete: true, budgetSpent: selected.length, unitsSelected: selected.length, unitsReviewed: selected.length } };
  };
}
const sweepOpts = (over = {}) => ({ epochSweep: true, lensGroups: "tier", perTierConvergence: true, structureAutoApply: false, maxUnits: 5, ...over });

// ── the appender STAMP (backward-tolerant) ───────────────────────────────────────────────────────

test("STAMP: a sweep-mode append records sweepCellKey + epochHash; an unstamped append is byte-identical legacy shape", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-stamp-"));
  const file = path.join(dir, "audit-findings.jsonl");
  try {
    const app = makeFindingsAppender(file, { session: "s", nowIso: () => "2026-07-14T00:00:00Z" });
    app.append([{ severity: "P1", lens: "correctness", category: "bug", title: "stamped one", file: "a.mjs", line: 3 }], { pass: 1, sweepCellKey: "KEY-abc", epochHash: "EPOCH-xyz" });
    app.append([{ severity: "P1", lens: "correctness", category: "bug", title: "legacy one", file: "b.mjs", line: 7 }], { pass: 2 });
    const recs = readFindingsStore(file);
    assert.equal(recs.length, 2);
    assert.equal(recs[0].sweepCellKey, "KEY-abc", "the sweep record carries its source cell key");
    assert.equal(recs[0].epochHash, "EPOCH-xyz");
    assert.ok(!("fileRevision" in recs[0]), "the dead fileRevision param was dropped (correction E) — sweepCellKey embeds the content identity");
    assert.ok(!("sweepCellKey" in recs[1]), "an unstamped (legacy) record does NOT gain the field — always-current");
    assert.ok(!("epochHash" in recs[1]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── the RE-STAMP (correction B): a live re-discovered finding must not be dropped forever ─────────

test("RE-STAMP (correction B): a known fingerprint re-reported under a NEW sweepCellKey is re-stamped so a record with the CURRENT key survives the stale-exclusion; a same-key re-report and a non-sweep dup are NOT re-stamped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-restamp-"));
  const file = path.join(dir, "audit-findings.jsonl");
  try {
    const app = makeFindingsAppender(file, { nowIso: () => "2026-07-14T00:00:00Z" });
    const finding = { severity: "P1", lens: "correctness", category: "bug", title: "moving bug", file: "a.mjs", line: 3 };
    app.append([finding], { sweepCellKey: "K0", epochHash: "E" }); // (1) stored at K0
    app.append([finding], { sweepCellKey: "K1", epochHash: "E" }); // (2) content MOVED → re-reported at K1 → RE-STAMP
    app.append([finding], { sweepCellKey: "K1", epochHash: "E" }); // (3) same K1 again → plain dup, NO new record
    const recs = readFindingsStore(file);
    // exactly two records: K0 (now stale) + the re-stamped K1; the same-key re-report added no third.
    assert.equal(recs.length, 2, "one record per distinct source key — the same-key re-report is a plain dup");
    assert.deepEqual(recs.map((r) => r.sweepCellKey).sort(), ["K0", "K1"]);
    const fp = recs[0].fingerprint;
    assert.ok(recs.every((r) => r.fingerprint === fp), "both records are the SAME finding (same fingerprint)");

    // The stale-exclusion keeps only records whose key is still expected. With the finding's CURRENT cell
    // (K1) still expected, F SURVIVES via its re-stamped record even though its original K0 record is stale.
    const expected = new Set(["K1"]);
    const surviving = recs.filter((r) => !(typeof r.sweepCellKey === "string") || expected.has(r.sweepCellKey));
    assert.ok(surviving.some((r) => r.fingerprint === fp), "the re-discovered finding SURVIVES (its current-key record is expected)");

    // A truly-VANISHED finding (only a stale record, its current cell no longer expected) is still dropped.
    const other = makeFindingsAppender(file, { nowIso: () => "2026-07-14T00:00:00Z" });
    other.append([{ severity: "P1", lens: "correctness", category: "bug", title: "gone bug", file: "b.mjs", line: 9 }], { sweepCellKey: "GONE", epochHash: "E" });
    const recs2 = readFindingsStore(file);
    const gone = recs2.find((r) => r.title === "gone bug");
    assert.ok(!expected.has(gone.sweepCellKey), "a finding whose only record's key vanished IS excluded (dropped)");

    // A NON-SWEEP dup (null key) is never re-stamped — byte-identical legacy behavior.
    const app2 = makeFindingsAppender(file, { nowIso: () => "2026-07-14T00:00:00Z" });
    const before = readFindingsStore(file).length;
    app2.append([finding], {}); // no key → plain dup of the known fingerprint → NO record
    assert.equal(readFindingsStore(file).length, before, "a non-sweep re-append of a known fingerprint adds nothing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── the loop EXCLUSION (sweep) ───────────────────────────────────────────────────────────────────

test("EXCLUSION (sweep): a stored finding whose sweepCellKey is no longer expected (content moved) is DROPPED from the actionable union; a current-key finding is RETAINED", async () => {
  const tmp = mkWorkspace();
  try {
    const log = [];
    const gr = mkFakeGroupedReview(tmp, log);
    const opts = sweepOpts();
    const cursor = cursorOn(new Map());
    const seenActionable = [];
    const recordFix = async (cwd, actionable) => {
      for (const f of actionable ?? []) seenActionable.push(f.title);
      return { fixed: (actionable ?? []).map((f) => ({ file: f.file ?? f.location?.path, finding: f })), failed: [], rejected: [], changedFiles: [], spent: 0, branch: "council/x", ok: true };
    };
    const deps = makeFixLoopDeps(tmp, MODEL, BACKENDS, opts, { runGroupedReview: gr, runAuditFix: recordFix, tierSweepCursor: cursor });

    // Build a REAL current tier-2 key from the sweep denominator, and a STALE sibling (bogus chunk hash).
    const manifest = deps.sweep.buildManifest();
    const scoped2 = scopeGroupsForTier(deps.sweep.baseGroups, 2);
    const keys2 = expectedKeys(manifest, 2, scoped2, deps.sweep.reviewerSet, deps.sweep.epochHash);
    const currentKey = keys2[0];
    const targetFile = fileOfKey(currentKey);
    const staleKey = JSON.stringify((() => { const arr = JSON.parse(currentKey); arr[10] = "0".repeat(64); return arr; })()); // index 10 = chunkHash
    assert.ok(!keys2.includes(staleKey), "precondition: the stale key is NOT an expected key (its content moved)");

    const stamped = [
      { fingerprint: "fp-current", file: targetFile, line: 1, severity: "P1", lens: "correctness", category: "correctness", title: "current bug", sweepCellKey: currentKey, epochHash: deps.sweep.epochHash },
      { fingerprint: "fp-stale", file: targetFile, line: 1, severity: "P1", lens: "correctness", category: "correctness", title: "stale bug", sweepCellKey: staleKey, epochHash: deps.sweep.epochHash }
    ];
    await runFixLoop(tmp, { ...opts, budget: 500, maxPasses: 1, dryStreak: 1 }, { ...deps, accumulatedFindings: () => stamped });

    assert.ok(seenActionable.includes("current bug"), "the finding whose cell is still expected stays actionable");
    assert.ok(!seenActionable.includes("stale bug"), "the finding whose cell VANISHED (content moved) is excluded from the sweep actionable union");
  } finally {
    rmWorkspace(tmp);
  }
});

// ── a NON-SWEEP run IGNORES the stamp ─────────────────────────────────────────────────────────────

test("NON-SWEEP: a legacy run ignores the sweepCellKey stamp entirely — a stamped 'stale' finding stays actionable", async () => {
  const seenActionable = [];
  const review = async () => ({ findings: [], ran: true, coverage: { budgetSpent: 1, passComplete: true } });
  // deps.fix is called as fix(actionable, opts) — the actionable set is the FIRST arg.
  const fix = async (actionable) => {
    for (const f of actionable ?? []) seenActionable.push(f.title);
    return { fixed: [], failed: [], rejected: [], spent: 0, branch: "council/x", ok: true };
  };
  const stamped = [
    { fingerprint: "fp-1", file: "a.mjs", line: 1, severity: "P1", lens: "correctness", category: "correctness", title: "stamped stale", sweepCellKey: '["v","EPOCH",2,"g","gid","r","codex","m","a.mjs",0,"deadbeef"]', epochHash: "EPOCH" }
  ];
  // Flat legacy mode (no epochSweep, no per-tier): the stamp is meaningless and must be ignored → actionable.
  await runFixLoop("/x", { budget: 5, dryStreak: 1, maxPasses: 1, perTierConvergence: false }, { review, fix, accumulatedFindings: () => stamped, checkpoint: () => {} });
  assert.ok(seenActionable.includes("stamped stale"), "a non-sweep run treats every stored record as always-current (the stamp is ignored)");
});
