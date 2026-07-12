import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  fingerprintFinding,
  readLedgerEntries,
  recordAndAnnotate,
  resolveLedgerEntry
} from "../plugins/council/scripts/lib/ledger.mjs";
import { readCachedR1, resumeContextKey, writeCachedR1 } from "../plugins/council/scripts/lib/resume.mjs";

function withState(fn) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-ledger-state-"));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "council-ledger-work-"));
  const previous = process.env.AGENT_COUNCIL_STATE_DIR;
  process.env.AGENT_COUNCIL_STATE_DIR = stateRoot;
  try {
    return fn(workDir);
  } finally {
    if (previous === undefined) delete process.env.AGENT_COUNCIL_STATE_DIR;
    else process.env.AGENT_COUNCIL_STATE_DIR = previous;
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

test("fingerprintFinding is stable across title phrasing noise", () => {
  const a = fingerprintFinding({ file: "src/A.mjs", title: "The budget guard fails open here", line: 10 });
  const b = fingerprintFinding({ file: "src\\A.mjs", title: "budget guard fails open", line: 12 });
  assert.equal(a, b);
});

test("fingerprintFinding disambiguates distant lines and empty-token titles", () => {
  // Same file + same tokens but far-apart lines -> different buckets.
  const near = fingerprintFinding({ file: "a.mjs", title: "cache leak", line: 10 });
  const far = fingerprintFinding({ file: "a.mjs", title: "cache leak", line: 400 });
  assert.notEqual(near, far);
  // Two short titles with no >=4 tokens must not collapse to the same key.
  const one = fingerprintFinding({ file: "a.mjs", title: "Bad API", line: 5 });
  const two = fingerprintFinding({ file: "a.mjs", title: "Fix me", line: 5 });
  assert.notEqual(one, two);
});

test("recordAndAnnotate marks seenBefore on the second run and counts timesSeen", () => {
  withState((cwd) => {
    const merged = { all: [{ file: "a.mjs", title: "Race condition in upsert", severity: "P1" }], consensus: [], unique: [] };
    const first = recordAndAnnotate(cwd, "job1", merged, "2026-07-10T00:00:00Z");
    assert.equal(first.all[0].seenBefore, false);
    assert.equal(first.all[0].timesSeen, 1);

    const second = recordAndAnnotate(cwd, "job2", merged, "2026-07-10T01:00:00Z");
    assert.equal(second.all[0].seenBefore, true);
    assert.equal(second.all[0].timesSeen, 2);

    const entries = readLedgerEntries(cwd);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].timesSeen, 2);
    assert.equal(entries[0].firstJobId, "job1");
    assert.equal(entries[0].lastJobId, "job2");
  });
});

test("absence does NOT auto-fix; resolve does", () => {
  withState((cwd) => {
    recordAndAnnotate(cwd, "job1", { all: [{ file: "a.mjs", title: "Leak in cache" }] }, "t1");
    // A later run on a different file must not flip the first to fixed.
    recordAndAnnotate(cwd, "job2", { all: [{ file: "b.mjs", title: "Other issue" }] }, "t2");
    const open = readLedgerEntries(cwd).filter((e) => e.status === "open");
    assert.equal(open.length, 2);

    const fp = fingerprintFinding({ file: "a.mjs", title: "Leak in cache" });
    assert.equal(resolveLedgerEntry(cwd, fp, "fixed", "t3"), true);
    assert.equal(readLedgerEntries(cwd).find((e) => e.fingerprint === fp).status, "fixed");
    assert.equal(resolveLedgerEntry(cwd, "no-such-fp", "fixed", "t3"), false);
  });
});

test("pruneR1Cache drops snapshots older than the age window, keeps fresh", async () => {
  const { pruneR1Cache } = await import("../plugins/council/scripts/lib/resume.mjs");
  const { resolveStateDir } = await import("../plugins/council/scripts/lib/state.mjs");
  withState((cwd) => {
    writeCachedR1(cwd, "fresh+aaaa", "codex", { agent: "codex", status: 0, stdout: "{}" });
    writeCachedR1(cwd, "stale+bbbb", "codex", { agent: "codex", status: 0, stdout: "{}" });
    const cacheRoot = path.join(resolveStateDir(cwd), "r1-cache");
    const staleDir = fs.readdirSync(cacheRoot).find((d) => d.startsWith("stale"));
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(cacheRoot, staleDir), old, old);

    pruneR1Cache(cwd, Date.now());
    assert.ok(readCachedR1(cwd, "fresh+aaaa", "codex"), "fresh snapshot survives");
    assert.equal(readCachedR1(cwd, "stale+bbbb", "codex"), null, "stale snapshot pruned");
  });
});

test("listAllJobsDirs finds per-workspace job dirs under the state root", async () => {
  const { listAllJobsDirs, writeJobFile } = await import("../plugins/council/scripts/lib/state.mjs");
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-global-"));
  const previous = process.env.AGENT_COUNCIL_STATE_DIR;
  process.env.AGENT_COUNCIL_STATE_DIR = stateRoot;
  try {
    // Two distinct workspaces write a job each; both must be discoverable globally.
    const wsA = fs.mkdtempSync(path.join(os.tmpdir(), "wsA-"));
    const wsB = fs.mkdtempSync(path.join(os.tmpdir(), "wsB-"));
    writeJobFile(wsA, "council-a", { id: "council-a", kind: "deliberate", status: "completed" });
    writeJobFile(wsB, "council-b", { id: "council-b", kind: "solve", status: "completed" });
    const dirs = listAllJobsDirs();
    assert.ok(dirs.length >= 2);
    const ids = dirs.flatMap((d) => fs.readdirSync(d.jobsDir)).filter((f) => f.endsWith(".json"));
    assert.ok(ids.includes("council-a.json"));
    assert.ok(ids.includes("council-b.json"));
    fs.rmSync(wsA, { recursive: true, force: true });
    fs.rmSync(wsB, { recursive: true, force: true });
  } finally {
    if (previous === undefined) delete process.env.AGENT_COUNCIL_STATE_DIR;
    else process.env.AGENT_COUNCIL_STATE_DIR = previous;
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("resumeContextKey changes when claudeModel or claudeBackend changes", () => {
  const base = {
    focusText: "focus",
    policyFocus: "policy",
    codexModel: "gpt-5",
    grokModel: "grok-4",
    grokEffort: "high",
    claudeModel: "claude-opus-4-8",
    claudeBackend: "spawn",
    base: "main",
    scope: "diff"
  };
  const keyA = resumeContextKey(base);
  const keyDifferentModel = resumeContextKey({ ...base, claudeModel: "claude-haiku-4-5" });
  const keyDifferentBackend = resumeContextKey({ ...base, claudeBackend: "api" });
  assert.notEqual(keyA, keyDifferentModel, "a changed claudeModel must not reuse the same resume-cache key");
  assert.notEqual(keyA, keyDifferentBackend, "a changed claudeBackend must not reuse the same resume-cache key");
  // Sanity: identical options still produce a stable, identical key.
  assert.equal(keyA, resumeContextKey({ ...base }));
});

test("R1 cache round-trips only successful outputs, keyed by snapshot", () => {
  withState((cwd) => {
    const snap = "abc123+deadbeef";
    assert.equal(writeCachedR1(cwd, snap, "codex", { agent: "codex", status: 0, stdout: '{"findings":[]}' }), true);
    assert.equal(writeCachedR1(cwd, snap, "grok", { agent: "grok", status: 1, stdout: "" }), false);
    assert.equal(writeCachedR1(cwd, snap, "grok", { agent: "grok", skipped: true }), false);

    const cached = readCachedR1(cwd, snap, "codex");
    assert.equal(cached.resumedFromCache, true);
    assert.equal(cached.status, 0);
    assert.match(cached.stdout, /findings/);
    assert.equal(readCachedR1(cwd, snap, "grok"), null);
    assert.equal(readCachedR1(cwd, "other-snap", "codex"), null);
  });
});
