import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readLedgerEntries, recordAndAnnotate, reconcilePendingFixes, resolveLedgerEntry } from "../plugins/council/scripts/lib/ledger.mjs";
import { ensureStateDir } from "../plugins/council/scripts/lib/state.mjs";

const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "council-ledger-"));
  ensureStateDir(d);
  return d;
};
const rec = (cwd, job, iso) => recordAndAnnotate(cwd, job, { all: [{ title: "the bug", file: "a.mjs", category: "correctness", severity: "P1", consensus: false }] }, iso);

test("a committed fix is provisional (pending-merge) and keeps re-surfacing until reconciled", () => {
  const cwd = tmp();
  rec(cwd, "job1", "2026-01-01T00:00:00Z");
  const fp = readLedgerEntries(cwd)[0].fingerprint;
  resolveLedgerEntry(cwd, fp, "fixed-pending-merge", "2026-01-02T00:00:00Z", { resolvedCommit: "abc123", branch: "council/x" });

  // A re-audit before merge still SEES the finding (pending is not durably resolved),
  // and the resolution metadata is carried so reconcile can find the commit.
  const re = rec(cwd, "job2", "2026-01-03T00:00:00Z");
  assert.equal(re.all[0].ledgerStatus, "fixed-pending-merge");
  const entry = readLedgerEntries(cwd).find((e) => e.fingerprint === fp);
  assert.equal(entry.status, "fixed-pending-merge");
  assert.equal(entry.resolvedCommit, "abc123", "resolvedCommit carried across recordAndAnnotate");
});

test("reconcile promotes a pending fix to 'fixed' once its commit landed on base", () => {
  const cwd = tmp();
  rec(cwd, "job1", "2026-01-01T00:00:00Z");
  const fp = readLedgerEntries(cwd)[0].fingerprint;
  resolveLedgerEntry(cwd, fp, "fixed-pending-merge", "2026-01-02T00:00:00Z", { resolvedCommit: "abc123" });
  const n = reconcilePendingFixes(cwd, { isAncestor: () => true, commitExists: () => true });
  assert.equal(n, 1);
  assert.equal(readLedgerEntries(cwd).find((e) => e.fingerprint === fp).status, "fixed");
});

test("reconcile REOPENS a pending fix whose commit was discarded (branch never merged)", () => {
  const cwd = tmp();
  rec(cwd, "job1", "2026-01-01T00:00:00Z");
  const fp = readLedgerEntries(cwd)[0].fingerprint;
  resolveLedgerEntry(cwd, fp, "fixed-pending-merge", "2026-01-02T00:00:00Z", { resolvedCommit: "dead999" });
  const n = reconcilePendingFixes(cwd, { isAncestor: () => false, commitExists: () => false });
  assert.equal(n, 1);
  assert.equal(readLedgerEntries(cwd).find((e) => e.fingerprint === fp).status, "open", "discarded branch -> the defect is back");
});

test("reconcile leaves an un-merged, still-existing pending fix pending", () => {
  const cwd = tmp();
  rec(cwd, "job1", "2026-01-01T00:00:00Z");
  const fp = readLedgerEntries(cwd)[0].fingerprint;
  resolveLedgerEntry(cwd, fp, "fixed-pending-merge", "2026-01-02T00:00:00Z", { resolvedCommit: "abc123" });
  const n = reconcilePendingFixes(cwd, { isAncestor: () => false, commitExists: () => true });
  assert.equal(n, 0);
  assert.equal(readLedgerEntries(cwd).find((e) => e.fingerprint === fp).status, "fixed-pending-merge");
});
