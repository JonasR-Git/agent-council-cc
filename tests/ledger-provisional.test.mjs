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
const statusOf = (cwd, fp) => readLedgerEntries(cwd).find((e) => e.fingerprint === fp).status;

test("a committed fix is provisional (pending-merge) and keeps re-surfacing until reconciled", () => {
  const cwd = tmp();
  rec(cwd, "job1", "2026-01-01T00:00:00Z");
  const fp = readLedgerEntries(cwd)[0].fingerprint;
  resolveLedgerEntry(cwd, fp, "fixed-pending-merge", "2026-01-02T00:00:00Z", { resolvedCommit: "abc123", branch: "council/x", baseBranch: "main" });
  const re = rec(cwd, "job2", "2026-01-03T00:00:00Z");
  assert.equal(re.all[0].ledgerStatus, "fixed-pending-merge");
  const entry = readLedgerEntries(cwd).find((e) => e.fingerprint === fp);
  assert.equal(entry.status, "fixed-pending-merge");
  assert.equal(entry.resolvedCommit, "abc123", "resolvedCommit carried across recordAndAnnotate");
  assert.equal(entry.baseBranch, "main", "baseBranch carried too (reconcile needs it)");
});

test("reconcile promotes to 'fixed' once the commit is an ancestor of the fix's BASE branch", () => {
  const cwd = tmp();
  rec(cwd, "job1", "2026-01-01T00:00:00Z");
  const fp = readLedgerEntries(cwd)[0].fingerprint;
  resolveLedgerEntry(cwd, fp, "fixed-pending-merge", "2026-01-02T00:00:00Z", { resolvedCommit: "abc123", baseBranch: "main" });
  // isAncestor must be checked against 'main', NOT the current HEAD
  const n = reconcilePendingFixes(cwd, { isAncestor: (sha, ref) => sha === "abc123" && ref === "main" });
  assert.equal(n, 1);
  assert.equal(statusOf(cwd, fp), "fixed");
});

test("reconcile does NOT reopen a pending fix on an unreachable sha (squash/rebase-merge safe)", () => {
  const cwd = tmp();
  rec(cwd, "job1", "2026-01-01T00:00:00Z");
  const fp = readLedgerEntries(cwd)[0].fingerprint;
  resolveLedgerEntry(cwd, fp, "fixed-pending-merge", "2026-01-02T00:00:00Z", { resolvedCommit: "squashed", baseBranch: "main" });
  const n = reconcilePendingFixes(cwd, { isAncestor: () => false });
  assert.equal(n, 0);
  assert.equal(statusOf(cwd, fp), "fixed-pending-merge", "unreachable sha is ambiguous -> stays pending, never falsely reopened");
});

test("reconcile promotes a squash/rebase-merged fix via patch-id (original sha not an ancestor)", () => {
  const cwd = tmp();
  rec(cwd, "job1", "2026-01-01T00:00:00Z");
  const fp = readLedgerEntries(cwd)[0].fingerprint;
  resolveLedgerEntry(cwd, fp, "fixed-pending-merge", "2026-01-02T00:00:00Z", { resolvedCommit: "squashed", baseBranch: "main" });
  const n = reconcilePendingFixes(cwd, { isAncestor: () => false, patchIdMerged: (sha, ref) => sha === "squashed" && ref === "main" });
  assert.equal(n, 1);
  assert.equal(statusOf(cwd, fp), "fixed", "the change landed under a new sha -> promoted via patch-id");
});

test("resolving to a NON-fix status clears stale fix provenance", () => {
  const cwd = tmp();
  rec(cwd, "job1", "2026-01-01T00:00:00Z");
  const fp = readLedgerEntries(cwd)[0].fingerprint;
  resolveLedgerEntry(cwd, fp, "fixed-pending-merge", "2026-01-02T00:00:00Z", { resolvedCommit: "abc123", baseBranch: "main" });
  resolveLedgerEntry(cwd, fp, "ignored", "2026-01-03T00:00:00Z"); // human dismisses it
  const entry = readLedgerEntries(cwd).find((e) => e.fingerprint === fp);
  assert.equal(entry.status, "ignored");
  assert.equal(entry.resolvedCommit, undefined, "an ignored entry must not claim it was fixed by commit X");
});
