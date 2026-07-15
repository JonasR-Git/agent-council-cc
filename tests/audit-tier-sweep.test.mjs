import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  posixKeyPath,
  chunkHash,
  scopeGroupsForTier,
  tierLenses,
  groupSpecHash,
  modelIdentityHash,
  reviewerSetHash,
  computeEpochHash,
  sweepCellKey,
  buildManifest,
  expected,
  expectedKeys,
  makeTierSweepCursor,
  SCHEMA_VERSION
} from "../plugins/council/scripts/lib/audit-tier-sweep.mjs";

// A deterministic in-memory fs+clock so the ledger tests need no disk and are byte-stable.
function memFs({ fsync } = {}) {
  const store = new Map();
  return {
    store,
    deps: {
      readFile: (p) => {
        if (!store.has(p)) throw new Error(`ENOENT: ${p}`);
        return store.get(p);
      },
      appendFile: (p, d) => store.set(p, (store.get(p) ?? "") + d),
      fsyncFile: fsync ?? (() => {}),
      existsFile: (p) => store.has(p),
      writeFile: (p, d) => store.set(p, d),
      now: () => 0
    }
  };
}

const REVIEWERS = [
  { seat: "codex", backend: "codex", model: "gpt-5-codex", effort: "high" },
  { seat: "grok", backend: "grok", model: "grok-4", effort: "high" },
  { seat: "claude", backend: "claude", model: "opus-4-8", effort: "high" }
];

// ── posixKeyPath / sweepCellKey Windows determinism ─────────────────────────────────────────────

test("posixKeyPath folds Windows backslashes to POSIX — same string for \\ and /", () => {
  assert.equal(posixKeyPath("a\\b\\c.mjs"), "a/b/c.mjs");
  assert.equal(posixKeyPath("a/b/c.mjs"), "a/b/c.mjs");
  assert.equal(posixKeyPath("a\\b\\c.mjs"), posixKeyPath("a/b/c.mjs"));
});

test("sweepCellKey is byte-identical for \\ vs / file input (Windows determinism)", () => {
  const common = {
    schemaV: SCHEMA_VERSION,
    epochHash: "epoch",
    tier: 2,
    groupSpecHash: "gsh",
    groupId: "g@t2",
    reviewerSetHash: "rsh",
    modelSeat: "codex",
    modelIdentityHash: "mih",
    chunkIndex: 0,
    chunkHash: "h"
  };
  assert.equal(sweepCellKey({ ...common, file: "a\\b\\c.mjs" }), sweepCellKey({ ...common, file: "a/b/c.mjs" }));
});

// ── chunkHash ───────────────────────────────────────────────────────────────────────────────────

test("chunkHash is deterministic, differs for one-char changes, and is 64 hex chars", () => {
  const a = chunkHash("const x = 1;\n");
  assert.equal(a, chunkHash("const x = 1;\n")); // deterministic
  assert.notEqual(a, chunkHash("const x = 2;\n")); // one-char difference
  assert.match(a, /^[0-9a-f]{64}$/); // sha256 hex, 64 chars
});

// ── scopeGroupsForTier (INTERSECTION projection) ────────────────────────────────────────────────

test("scopeGroupsForTier: a mixed group is projected to the tier's lenses (off-tier lens dropped)", () => {
  const groups = [{ id: "g", title: "mixed", lenses: ["correctness", "design_quality"], focus: "f" }];
  const scoped = scopeGroupsForTier(groups, 2);
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].id, "g@t2");
  assert.deepEqual(scoped[0].lenses, ["correctness"]); // design_quality is not a tier-2 lens → dropped
  assert.equal(scoped[0].focus, "f"); // focus retained
  assert.equal(scoped[0].title, "mixed"); // title retained
});

test("scopeGroupsForTier: a group that touches NO tier lens is dropped entirely", () => {
  const groups = [{ id: "g", title: "mixed", lenses: ["correctness", "design_quality"] }];
  // Tier 0 = logical_sense only; the group has neither → empty intersection → dropped.
  assert.deepEqual(scopeGroupsForTier(groups, 0), []);
});

test("scopeGroupsForTier: tier == null returns the groups UNCHANGED (backward compat)", () => {
  const groups = [{ id: "g", title: "t", lenses: ["correctness"] }];
  assert.equal(scopeGroupsForTier(groups, null), groups); // same reference
  assert.equal(scopeGroupsForTier(groups, undefined), groups);
});

test("scopeGroupsForTier: a single-lens FINE group is a no-op projection (same lens, id suffixed)", () => {
  const groups = [{ id: "correctness-logic", title: "Logic correctness", lenses: ["correctness"], focus: "core logic" }];
  const scoped = scopeGroupsForTier(groups, 2);
  assert.equal(scoped[0].id, "correctness-logic@t2");
  assert.deepEqual(scoped[0].lenses, ["correctness"]);
  assert.equal(scoped[0].focus, "core logic");
});

test("tierLenses returns the tier's lenses and [] for an out-of-range/null tier", () => {
  assert.deepEqual(tierLenses(0), ["logical_sense"]);
  assert.deepEqual(tierLenses(9), []); // out of range
  assert.deepEqual(tierLenses(null), []);
});

// ── sweepCellKey includes groupId ───────────────────────────────────────────────────────────────

test("sweepCellKey includes groupId — two groups over the same cell yield DIFFERENT keys", () => {
  const base = {
    schemaV: SCHEMA_VERSION,
    epochHash: "e",
    tier: 2,
    reviewerSetHash: "rsh",
    modelSeat: "codex",
    modelIdentityHash: "mih",
    file: "a.mjs",
    chunkIndex: 0,
    chunkHash: "h"
  };
  const g1 = { id: "correctness-logic@t2", title: "Logic correctness", lenses: ["correctness"] };
  const g2 = { id: "correctness-edges@t2", title: "Edge cases", lenses: ["correctness"] };
  const k1 = sweepCellKey({ ...base, groupId: g1.id, groupSpecHash: groupSpecHash(g1) });
  const k2 = sweepCellKey({ ...base, groupId: g2.id, groupSpecHash: groupSpecHash(g2) });
  assert.notEqual(k1, k2);
});

// ── computeEpochHash config fingerprint ─────────────────────────────────────────────────────────

test("computeEpochHash is stable for the same config and order-independent over reviewers", () => {
  const cfg = { presetId: "fine", deep: true, tierLensMapVersion: 1, reviewers: REVIEWERS, scopedGroupSpecs: ["a", "b"] };
  const reordered = { ...cfg, reviewers: [...REVIEWERS].reverse(), scopedGroupSpecs: ["b", "a"] };
  assert.equal(computeEpochHash(cfg), computeEpochHash({ ...cfg })); // stable
  assert.equal(computeEpochHash(cfg), computeEpochHash(reordered)); // order-independent
});

test("computeEpochHash changes when reviewers / deep / presetId / tierLensMap change", () => {
  const cfg = { presetId: "fine", deep: false, tierLensMapVersion: 1, reviewers: REVIEWERS };
  const base = computeEpochHash(cfg);
  assert.notEqual(base, computeEpochHash({ ...cfg, reviewers: REVIEWERS.slice(0, 2) })); // dropped a reviewer
  assert.notEqual(base, computeEpochHash({ ...cfg, deep: true })); // deep flag
  assert.notEqual(base, computeEpochHash({ ...cfg, presetId: "tier" })); // preset id
  assert.notEqual(base, computeEpochHash({ ...cfg, tierLensMapVersion: 2 })); // tier→lens map version
});

// ── buildManifest + expected ────────────────────────────────────────────────────────────────────

test("buildManifest + expected: eligible file counts, unreadable/oversize lands in debt not the count", () => {
  const files = ["a.mjs", "b.mjs"]; // a = eligible (3 chunks), b = unreadable/oversize → debt
  const chunksOf = (f) =>
    f === "a.mjs"
      ? [
          { index: 0, text: "l1", startLine: 1, endLine: 1 },
          { index: 1, text: "l2", startLine: 2, endLine: 2 },
          { index: 2, text: "l3", startLine: 3, endLine: 3 }
        ]
      : [];
  const isSupplied = (f) => f === "a.mjs"; // b.mjs is oversize/unreadable
  const scopedGroups = [
    { id: "g1@t2", title: "g1", lenses: ["correctness"] },
    { id: "g2@t2", title: "g2", lenses: ["security_secrets"] }
  ];
  const manifest = buildManifest({ files, chunksOf, isSupplied });
  assert.equal(manifest.files.length, 1); // only a.mjs counted
  assert.equal(manifest.files[0].file, "a.mjs");
  assert.equal(manifest.files[0].chunks.length, 3);
  assert.match(manifest.files[0].chunks[0].h, /^[0-9a-f]{64}$/);
  assert.equal(manifest.debt.length, 1); // b.mjs is debt, not counted
  assert.equal(manifest.debt[0].file, "b.mjs");
  assert.match(manifest.digest, /^[0-9a-f]{64}$/);
  // 3 chunks × 2 groups × 3 models = 18
  assert.equal(expected(manifest, scopedGroups, REVIEWERS), 18);
});

test("buildManifest: a supplied 0-byte file is vacuously clean — neither counted nor debt", () => {
  const manifest = buildManifest({ files: ["empty.mjs"], chunksOf: () => [], isSupplied: () => true });
  assert.equal(manifest.files.length, 0);
  assert.equal(manifest.debt.length, 0);
});

// ── durable ledger round-trip + recovery ────────────────────────────────────────────────────────

function seedLedger(cursor, keys) {
  cursor.appendHeader({ runId: "r1", baseBranch: "master", baseHead: "abc", epochHash: "e", reviewers: REVIEWERS, tierPlan: [2, 3] });
  cursor.appendManifest({ file: "a.mjs", revision: null, chunks: [{ i: 0, startLine: 1, endLine: 1, h: "h0" }] });
  cursor.sealManifest({ digest: "dig", fileCount: 1 });
  for (const k of keys) cursor.markDone(k, { pass: 1 });
}

test("ledger round-trip: header + manifest + seal + done rows reload with the done set intact", () => {
  const { deps } = memFs();
  const path = "/state/sweep.jsonl";
  const cursor = makeTierSweepCursor(path, { deps });
  seedLedger(cursor, ["k1", "k2", "k3"]);
  assert.equal(cursor.isDone("k1"), true);

  // A fresh cursor over the same durable file reloads the exact state (persistence proven).
  const reopened = makeTierSweepCursor(path, { deps });
  const state = reopened.load();
  assert.equal(state.corrupt, false);
  assert.equal(state.header.runId, "r1");
  assert.equal(state.manifestRows.length, 1);
  assert.deepEqual([...state.done].sort(), ["k1", "k2", "k3"]);
  assert.equal(reopened.isDone("k2"), true);
});

test("ledger recovery: a torn final line is dropped, all prior valid lines load", () => {
  const { deps, store } = memFs();
  const path = "/state/sweep.jsonl";
  const cursor = makeTierSweepCursor(path, { deps });
  seedLedger(cursor, ["k1", "k2"]);
  // Simulate a crash mid-append: a partial, un-terminated final record.
  store.set(path, store.get(path) + '{"v":1,"type":"done","seq":9,"k":"torn');

  const reopened = makeTierSweepCursor(path, { deps });
  const state = reopened.load();
  assert.equal(state.corrupt, false);
  assert.equal(state.droppedTail, true);
  assert.deepEqual([...state.done].sort(), ["k1", "k2"]); // torn "torn" key dropped, rest intact
});

test("ledger recovery: an invalid INTERIOR line flags the ledger corrupt (fail closed)", () => {
  const { deps, store } = memFs();
  const path = "/state/sweep.jsonl";
  const good1 = JSON.stringify({ v: 1, type: "header", runId: "r1" });
  const good2 = JSON.stringify({ v: 1, type: "done", k: "k1" });
  store.set(path, `${good1}\nGARBAGE-INTERIOR\n${good2}\n`);
  const cursor = makeTierSweepCursor(path, { deps });
  const state = cursor.load();
  assert.equal(state.corrupt, true);
});

test("markDone whose fsync THROWS propagates and does NOT count the cell done", () => {
  const { deps } = memFs({
    fsync: () => {
      throw new Error("EIO: fsync failed");
    }
  });
  const cursor = makeTierSweepCursor("/state/sweep.jsonl", { deps });
  assert.throws(() => cursor.markDone("k1"), /EIO/);
  assert.equal(cursor.isDone("k1"), false); // never marked done — the caller must hard-stop, not proceed
});

// ── pending / tierPending math ──────────────────────────────────────────────────────────────────

test("pending/tierPending: after marking a subset done, pending = expected − done for the tier", () => {
  const { deps } = memFs();
  const cursor = makeTierSweepCursor("/state/sweep.jsonl", { deps });
  cursor.appendHeader({ runId: "r1", epochHash: "e", reviewers: REVIEWERS });

  const manifest = buildManifest({
    files: ["a.mjs"],
    chunksOf: () => [
      { index: 0, text: "l1", startLine: 1, endLine: 1 },
      { index: 1, text: "l2", startLine: 2, endLine: 2 }
    ],
    isSupplied: () => true
  });
  const scopedGroups = [{ id: "correctness-logic@t2", title: "Logic correctness", lenses: ["correctness"] }];
  const models = REVIEWERS.slice(0, 2); // 2 reviewers
  const epochHash = "e";
  const tier = 2;

  // 2 chunks × 1 group × 2 models = 4 expected keys.
  const all = expectedKeys(manifest, tier, scopedGroups, models, epochHash);
  assert.equal(all.length, 4);
  assert.equal(cursor.expectedCount(manifest, scopedGroups, models), 4);
  assert.equal(cursor.pending(manifest, tier, scopedGroups, models, epochHash).length, 4);

  // Mark a subset (2 of 4) done.
  cursor.markDone(all[0]);
  cursor.markDone(all[1]);
  assert.equal(cursor.pending(manifest, tier, scopedGroups, models, epochHash).length, 2);
  const tp = cursor.tierPending(tier, manifest, scopedGroups, models, epochHash);
  assert.equal(tp.tier, 2);
  assert.equal(tp.count, 2);
  assert.deepEqual(tp.keys.sort(), [all[2], all[3]].sort());
});

test("pending ignores done keys from a DIFFERENT epoch (fail-closed epoch semantics)", () => {
  const { deps } = memFs();
  const cursor = makeTierSweepCursor("/state/sweep.jsonl", { deps });
  cursor.appendHeader({ runId: "r1", epochHash: "eNEW", reviewers: REVIEWERS });
  const manifest = buildManifest({ files: ["a.mjs"], chunksOf: () => [{ index: 0, text: "l1", startLine: 1, endLine: 1 }], isSupplied: () => true });
  const scopedGroups = [{ id: "correctness-logic@t2", title: "g", lenses: ["correctness"] }];
  const models = REVIEWERS.slice(0, 1);

  // Mark done under the OLD epoch, then ask pending under the NEW epoch.
  for (const k of expectedKeys(manifest, 2, scopedGroups, models, "eOLD")) cursor.markDone(k);
  assert.equal(cursor.pending(manifest, 2, scopedGroups, models, "eNEW").length, 1); // old-epoch dones don't satisfy new keys
});

// ── identity-hash guards (used inside the sweep key) ────────────────────────────────────────────

test("modelIdentityHash keys on backend/model/effort, not seat; reviewerSetHash is order-independent", () => {
  const a = modelIdentityHash({ backend: "codex", model: "gpt-5-codex", effort: "high" });
  assert.equal(a, modelIdentityHash({ backend: "codex", model: "gpt-5-codex", effort: "high" }));
  assert.notEqual(a, modelIdentityHash({ backend: "codex", model: "gpt-5-codex", effort: "low" })); // effort matters
  assert.equal(reviewerSetHash(REVIEWERS), reviewerSetHash([...REVIEWERS].reverse())); // order-independent
});

test("makeTierSweepCursor with the REAL fs ports fsyncs without EPERM (Windows FlushFileBuffers needs write access — live-found; every other test injects a fake fsync so the real handle mode was never exercised)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-fsync-"));
  const file = path.join(dir, "audit-tier-sweep-cursor.jsonl");
  try {
    const cur = makeTierSweepCursor(file, {}); // NO injected fsyncFile → exercises the real "r+" fsync path
    assert.doesNotThrow(() => cur.appendHeader({ runId: "t", epochHash: "e", reviewers: [], tierPlan: [] }), "appendHeader fsync must not EPERM");
    assert.doesNotThrow(() => cur.markDone("k1", { pass: 1 }), "markDone append+fsync must not EPERM");
    assert.equal(cur.doneCount(), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
