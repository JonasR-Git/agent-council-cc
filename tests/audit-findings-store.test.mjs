import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FINDINGS_SCHEMA_VERSION,
  makeFindingsAppender,
  readFindingsStore,
  requireDurableStore,
  resetFindingsStore,
  storedFingerprints
} from "../plugins/council/scripts/lib/audit-findings-store.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "findings-store-"));
const finding = (o) => ({ severity: "P1", lens: "correctness", category: "bug", title: "t", detail: "d", file: "a.mjs", line: 10, ...o });

test("C: findings are appended as COMPLETE newline-terminated records with the full schema", () => {
  const dir = tmp();
  const file = path.join(dir, "audit-findings.jsonl");
  const app = makeFindingsAppender(file, { session: "s1", nowIso: () => "2026-07-13T00:00:00Z" });
  const r = app.append([finding({ title: "bug one", file: "a.mjs" }), finding({ title: "bug two", file: "b.mjs" })], { pass: 3 });
  assert.equal(r.appended, 2);
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(raw.endsWith("\n"), "every record ends in a newline (crash leaves at most a torn trailing line)");
  const recs = readFindingsStore(file);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].schemaVersion, FINDINGS_SCHEMA_VERSION);
  assert.equal(recs[0].session, "s1");
  assert.equal(recs[0].seq, 0);
  assert.equal(recs[1].seq, 1, "monotonic seq");
  assert.equal(recs[0].pass, 3);
  assert.equal(recs[0].ts, "2026-07-13T00:00:00Z");
  assert.equal(recs[0].file, "a.mjs");
  assert.ok(recs[0].fingerprint, "each record carries a stable ledger fingerprint");
});

test("C: toRecord PERSISTS scope + fixDisposition so the fix loop's classifyFixable survives the round-trip (regression: a dropped scope made EVERY finding read back as scope=undefined → propose-only → 0 auto-fixes)", () => {
  const dir = tmp();
  const file = path.join(dir, "audit-findings.jsonl");
  const app = makeFindingsAppender(file, { session: "s1", nowIso: () => "2026-07-13T00:00:00Z" });
  app.append([
    finding({ title: "localized correctness", lens: "correctness", file: "a.mjs" }),
    finding({ title: "structural", lens: "architecture_ssot", file: "b.mjs" }),
    finding({ title: "explicit x-cut on a fixable lens", lens: "correctness", scope: "cross-cutting", file: "c.mjs" })
  ], { pass: 1 });
  const byTitle = Object.fromEntries(readFindingsStore(file).map((r) => [r.title, r]));

  // A localized correctness finding round-trips as fixable — the exact property classifyFixable gates on.
  assert.equal(byTitle["localized correctness"].scope, "localized");
  assert.equal(byTitle["localized correctness"].fixDisposition, "localized");
  // A propose-only lens (structure/SSOT) is cross-cutting → propose-only.
  assert.equal(byTitle["structural"].scope, "cross-cutting");
  assert.equal(byTitle["structural"].fixDisposition, "propose-only");
  // An EXPLICIT reviewer scope of cross-cutting is honoured even on an otherwise-fixable lens.
  assert.equal(byTitle["explicit x-cut on a fixable lens"].scope, "cross-cutting");
  assert.equal(byTitle["explicit x-cut on a fixable lens"].fixDisposition, "propose-only");
});

test("C: a RAW logical_sense bug (no fixLens yet) reattributes on append so the store round-trip stays fixable (council P1 #5)", () => {
  const dir = tmp();
  const file = path.join(dir, "audit-findings.jsonl");
  const app = makeFindingsAppender(file, { session: "s1", nowIso: () => "2026-07-13T00:00:00Z" });
  // The grouped-review appends RAW cell findings BEFORE normalize — no fixLens set yet. toRecord must derive
  // it, else scope freezes to cross-cutting and the finding can never be reattributed/fixed on re-read.
  app.append([finding({ title: "off-by-one", lens: "logical_sense", category: "bug", file: "a.mjs", line: 42 })], { pass: 1 });
  const rec = readFindingsStore(file).find((r) => r.title === "off-by-one");
  assert.equal(rec.scope, "localized", "a raw logical bug is stored as fixable, not frozen cross-cutting");
  assert.equal(rec.fixDisposition, "localized");
  assert.equal(rec.fixLens, "correctness", "the derived fix-eligibility lens is persisted");
  assert.equal(rec.lens, "logical_sense", "the coverage lens is unchanged");
});

test("C: dedupe by fingerprint prevents duplicate lines (many-to-many provenance kept in-record)", () => {
  const dir = tmp();
  const file = path.join(dir, "audit-findings.jsonl");
  const app = makeFindingsAppender(file, { session: "s" });
  app.append([finding({ title: "same bug", file: "a.mjs", line: 10, agents: ["codex"] })]);
  // A SECOND appender (a later pass / resume) seeds its dedupe set from the existing store → no dup line.
  const app2 = makeFindingsAppender(file, { session: "s" });
  const r = app2.append([finding({ title: "same bug", file: "a.mjs", line: 10, agents: ["grok"] })]);
  assert.equal(r.appended, 0, "the same fingerprint is not re-appended across appenders/resumes");
  assert.equal(readFindingsStore(file).length, 1);
});

test("C tolerant reader: a truncated TRAILING line is dropped (crash mid-append), not an error", () => {
  const dir = tmp();
  const file = path.join(dir, "audit-findings.jsonl");
  const app = makeFindingsAppender(file);
  app.append([finding({ title: "complete one", file: "a.mjs" })]);
  // Simulate a crash mid-write: a partial (unterminated, unparseable) record appended to the tail.
  fs.appendFileSync(file, '{"schemaVersion":1,"seq":9,"title":"torn', "utf8");
  const recs = readFindingsStore(file);
  assert.equal(recs.length, 1, "the complete record survives; the torn trailing record is tolerated");
  assert.equal(recs[0].title, "complete one");
});

test("C tolerant reader: INTERIOR corruption is a hard error (a half-read SSOT must fail loud)", () => {
  const dir = tmp();
  const file = path.join(dir, "audit-findings.jsonl");
  const app = makeFindingsAppender(file);
  app.append([finding({ title: "one", file: "a.mjs" })]);
  app.append([finding({ title: "two", file: "b.mjs" })]);
  // Corrupt an INTERIOR line (not the last) — the file is damaged, not merely torn.
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines[0] = "{ this is not json";
  fs.writeFileSync(file, lines.join("\n"), "utf8");
  assert.throws(() => readFindingsStore(file), /corrupt at line 1/);
});

test("C: storedFingerprints reflects the accumulated ledger (the accumulated-evidence gate reads this)", () => {
  const dir = tmp();
  const file = path.join(dir, "audit-findings.jsonl");
  const app = makeFindingsAppender(file);
  app.append([finding({ title: "p1 bug", file: "a.mjs" }), finding({ title: "p1 other", file: "b.mjs" })]);
  const fps = storedFingerprints(file);
  assert.equal(fps.size, 2);
});

test("C fail-closed: requireDurableStore THROWS when the store can't be written (fixing must not proceed)", () => {
  const dir = tmp();
  const file = path.join(dir, "audit-findings.jsonl");
  const failingDeps = {
    openSync: () => 3,
    writeSync: () => { throw new Error("EROFS: read-only file system"); },
    fsyncSync: () => {},
    closeSync: () => {}
  };
  assert.throws(() => requireDurableStore(file, { deps: failingDeps }), /read-only|EROFS/);
});

test("C fail-closed: requireDurableStore returns a working appender on a healthy store", () => {
  const dir = tmp();
  const file = path.join(dir, "audit-findings.jsonl");
  const app = requireDurableStore(file, { session: "ok" });
  assert.equal(typeof app.append, "function");
  app.append([finding({ title: "recorded", file: "a.mjs" })]);
  assert.equal(readFindingsStore(file).length, 1);
});

// Grok-3 REGRESSION PIN: a write throw must NOT poison the in-memory dedupe set. The fix advances
// `seen`/`seq` only AFTER the durable write succeeds — before it, a throw during toRecord/write left the
// fingerprint marked "seen" so a same-process RETRY of the same finding silently dropped it (lost).
test("Grok-3 (seen after write): a write THROW does not poison the dedupe set — a retry still writes the finding", () => {
  const dir = tmp();
  const file = path.join(dir, "audit-findings.jsonl");
  let failNext = true;
  const deps = {
    openSync: () => 7,
    writeSync: () => { if (failNext) throw new Error("ENOSPC: no space left on device"); },
    fsyncSync: () => {},
    closeSync: () => {}
  };
  const app = makeFindingsAppender(file, { nowIso: () => "2026-07-13T00:00:00Z", deps });
  assert.throws(() => app.append([finding({ title: "flaky bug", file: "a.mjs" })]), /ENOSPC/);
  // fs recovers → the SAME fingerprint must still be appendable (seen was NOT advanced by the failed write).
  failNext = false;
  const r = app.append([finding({ title: "flaky bug", file: "a.mjs" })]);
  assert.equal(r.appended, 1, "the retry writes the finding — the failed write did not poison `seen`");
});

// Claude-P2a REGRESSION PIN (store half): resetFindingsStore truncates the durable store so a FRESH run
// starts empty; a run that does NOT reset keeps the prior records (the --resume path).
test("P2a: resetFindingsStore clears the durable store (a fresh run starts empty); no reset keeps it (resume)", () => {
  const dir = tmp();
  const file = path.join(dir, "audit-findings.jsonl");
  makeFindingsAppender(file).append([finding({ title: "prior run bug", file: "a.mjs" })]);
  assert.equal(readFindingsStore(file).length, 1, "the prior run recorded a finding");
  resetFindingsStore(file);
  assert.equal(readFindingsStore(file).length, 0, "a fresh run starts with an empty store");
  // A missing store is a no-op (force) — never throws.
  assert.doesNotThrow(() => resetFindingsStore(path.join(dir, "does-not-exist.jsonl")));
});
