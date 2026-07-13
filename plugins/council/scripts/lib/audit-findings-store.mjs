// C — the DURABLE findings SSOT for the audit fix/review loops. Each finding is appended to
// `audit-findings.jsonl` in the run's state dir AS DISCOVERED: one COMPLETE newline-terminated JSON
// record, fsync'd per batch, deduped by the ledger fingerprint. This jsonl — not docs/AUDIT.md — is
// the source of truth the gate/SSOT-reduce reads and the dashboard tails; docs/AUDIT.md is a derived,
// atomically-rewritten per-pass projection (audit-doc.mjs).
//
// Two durability contracts (council fail-closed nuance):
//   - REVIEW may proceed in-memory: appendFindings is best-effort and the caller swallows a write error.
//   - Autonomous FIXING must FAIL CLOSED: a fix whose finding/checkpoint/evidence can't be durably
//     recorded is not committed. requireDurableStore() proves the store is writable BEFORE any fix and
//     throws otherwise, so the loop can turn that into a hard stop instead of an untracked mutation.
//
// The reader is TOLERANT of a truncated TRAILING line (a crash mid-append) but treats INTERIOR
// corruption as an error — a torn last record is expected under crash-safety, a garbled middle record
// means the file is damaged and must not be silently half-read.

import fs from "node:fs";
import path from "node:path";

import { fingerprintFinding } from "./ledger.mjs";
import { resolveStateDir } from "./state.mjs";

export const FINDINGS_SCHEMA_VERSION = 1;

/** Absolute path of the durable findings store for a workspace. */
export function findingsStorePath(cwd) {
  return path.join(resolveStateDir(cwd), "audit-findings.jsonl");
}

/**
 * Read the durable findings store TOLERANTLY. A truncated final line (no trailing newline, unparseable)
 * is a crash-safe partial write → DROPPED, not an error. An unparseable INTERIOR line means the file is
 * damaged → THROW (the caller must not silently proceed on a half-read SSOT). Missing file → []. PURE
 * over `fs`. `readFile` is injectable for tests.
 */
export function readFindingsStore(file, { readFile } = {}) {
  const read = readFile ?? ((f) => fs.readFileSync(f, "utf8"));
  let text;
  try {
    text = read(file);
  } catch {
    return []; // missing/unreadable store → empty (a first run, or a review that never recorded)
  }
  if (typeof text !== "string" || text === "") return [];
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    if (line === "") continue; // blank line, incl. the empty tail after a proper trailing newline
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      // The ONLY tolerable corruption is a torn trailing record (crash mid-append). A blank tail already
      // continued above, so a non-empty UNPARSEABLE last line is that torn record → drop it. Any earlier
      // line failing to parse means interior damage → fail loud.
      if (isLast) break;
      throw new Error(`audit-findings.jsonl corrupt at line ${i + 1}: ${String(err?.message ?? err)}`);
    }
  }
  return out;
}

/** The set of fingerprints already durably recorded (for dedupe + the accumulated-evidence gate). */
export function storedFingerprints(file, opts = {}) {
  const set = new Set();
  for (const rec of readFindingsStore(file, opts)) if (rec && rec.fingerprint) set.add(rec.fingerprint);
  return set;
}

/**
 * Reset the durable findings store for a FRESH (non-resume) run: delete the jsonl so the run starts with
 * an EMPTY SSOT. Mirrors the reviewed-cell cursor's reset() — a fresh run must not inherit a prior run's
 * findings (which readAccumulated would re-action, wasting budget) nor let the jsonl grow unbounded
 * across runs. A --resume KEEPS the store (its dedupe + cursor bridge the interrupted pass). Best-effort
 * + injectable (deps.rmSync) for tests; a missing file is a no-op (force).
 */
export function resetFindingsStore(file, { deps = {} } = {}) {
  const rmSync = deps.rmSync ?? ((f) => fs.rmSync(f, { force: true }));
  try {
    rmSync(file);
  } catch {
    /* best-effort: a fresh run that can't clear the store still de-dupes on append */
  }
}

/** Normalize a finding into a durable record. PURE. */
function toRecord(finding, { session, seq, pass, nowIso }) {
  const fp = fingerprintFinding(finding);
  const id = finding.id != null ? String(finding.id) : fp;
  // Provenance is kept many-to-many (never destructive): a fingerprint seen by several seats records the
  // union of the raising seats + the original finding ids, so a later dedupe can't erase who found it.
  const seats = Array.isArray(finding.agents) ? finding.agents : finding.seat ? [finding.seat] : finding.agent ? [finding.agent] : [];
  const ids = Array.isArray(finding.ids) ? finding.ids.map(String) : [id];
  return {
    schemaVersion: FINDINGS_SCHEMA_VERSION,
    session: session ?? null,
    seq,
    id,
    fingerprint: fp,
    severity: finding.severity ?? null,
    lens: finding.lens ?? null,
    category: finding.category ?? null,
    title: finding.title ?? null,
    detail: finding.detail ?? null,
    file: finding.file ?? finding.location?.path ?? null,
    line: finding.line ?? finding.location?.startLine ?? null,
    seats,
    ids,
    pass: pass ?? null,
    ts: nowIso
  };
}

/**
 * A durable, dedup-by-fingerprint appender over one jsonl store. Construction seeds the dedupe set +
 * the monotonic seq from any existing store (so a --resume never re-appends a recorded finding and seq
 * stays strictly increasing). `append(findings, { pass })` writes ONE complete newline-terminated
 * record per NEW fingerprint and fsyncs — the record is either fully on disk or (on a crash) a torn
 * trailing line the tolerant reader drops. `deps.openSync/writeSync/fsyncSync/closeSync` are injectable
 * so a test can force a write failure (fail-closed) without touching the real fs.
 */
export function makeFindingsAppender(file, { session = null, nowIso = null, deps = {} } = {}) {
  const openSync = deps.openSync ?? fs.openSync;
  const writeSync = deps.writeSync ?? fs.writeSync;
  const fsyncSync = deps.fsyncSync ?? fs.fsyncSync;
  const closeSync = deps.closeSync ?? fs.closeSync;
  const now = typeof nowIso === "function" ? nowIso : () => new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    /* dir may already exist; a real failure surfaces on the first append */
  }
  const seen = new Set();
  let seq = 0;
  for (const rec of readFindingsStore(file, deps)) {
    if (rec && rec.fingerprint) seen.add(rec.fingerprint);
    if (Number.isFinite(rec?.seq)) seq = Math.max(seq, rec.seq + 1);
  }

  function append(findings, { pass = null } = {}) {
    const records = [];
    const newFps = [];
    for (const f of findings ?? []) {
      const fp = fingerprintFinding(f);
      if (seen.has(fp) || newFps.includes(fp)) continue; // dedupe vs stored AND within this batch
      newFps.push(fp);
      records.push(toRecord(f, { session, seq: seq + records.length, pass, nowIso: now() }));
    }
    if (!records.length) return { appended: 0, records: [] };
    // One complete newline-terminated line per record → a crash leaves at most a torn trailing line.
    const payload = records.map((r) => `${JSON.stringify(r)}\n`).join("");
    const fd = openSync(file, "a");
    try {
      writeSync(fd, payload);
      fsyncSync(fd); // durability: the record survives a power loss, not just a process exit
    } finally {
      closeSync(fd);
    }
    // Advance the in-memory dedupe set + seq ONLY after the durable write succeeds — otherwise a throw
    // during toRecord/write poisons `seen`, and a same-process re-append silently drops the finding.
    for (const fp of newFps) seen.add(fp);
    seq += records.length;
    return { appended: records.length, records };
  }

  return { append, path: file, seen: () => new Set(seen), count: () => seen.size };
}

/**
 * FAIL-CLOSED gate for autonomous fixing: prove the durable store is writable (open→write a zero-byte
 * probe→fsync→close) BEFORE any fix is applied, THROWING if it is not. A fix without durable provenance
 * must never land, so the loop calls this once per run (or per pass) and treats a throw as a hard stop.
 * `deps` mirror makeFindingsAppender's for tests. Returns the appender on success.
 */
export function requireDurableStore(file, { session = null, nowIso = null, deps = {} } = {}) {
  const openSync = deps.openSync ?? fs.openSync;
  const writeSync = deps.writeSync ?? fs.writeSync;
  const fsyncSync = deps.fsyncSync ?? fs.fsyncSync;
  const closeSync = deps.closeSync ?? fs.closeSync;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    /* surfaced by the probe below */
  }
  // Zero-byte append probe: proves we can open+write+fsync+close without adding a record.
  const fd = openSync(file, "a");
  try {
    writeSync(fd, "");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return makeFindingsAppender(file, { session, nowIso, deps });
}
