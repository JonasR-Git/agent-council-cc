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
import { readCachedR1, writeCachedR1 } from "../plugins/council/scripts/lib/resume.mjs";

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
  const a = fingerprintFinding({ file: "src/A.mjs", title: "The budget guard fails open here" });
  const b = fingerprintFinding({ file: "src\\A.mjs", title: "budget guard fails open" });
  assert.equal(a, b);
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
