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

/**
 * Count durable findings per posix-normalized file → `{ [posixFile]: n }`. PURE over a records array
 * (the findings-store union readFindingsStore returns). Used by the fix loop to build the DYNAMIC
 * finding-density signal (Brocken B front-loading): suspicionRank front-loads pending files that already
 * produced findings THIS RUN ahead of equal-hotspot clean files — ORDERING ONLY, never coverage. A record
 * with no file is skipped; an empty/absent list → {} (⇒ suspicionRank falls back to the pure-hotspot order,
 * byte-identical). Paths are folded to posix so they key the SAME way the model file ids / manifest do.
 */
export function findingCountsByFile(records) {
  const counts = {};
  for (const rec of Array.isArray(records) ? records : []) {
    const file = rec?.file ?? rec?.location?.path ?? null;
    if (!file) continue;
    const key = String(file).replace(/\\/g, "/");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
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
function toRecord(finding, { session, seq, pass, nowIso, sweepCellKey = null, epochHash = null }) {
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
    // WAVE 3 (epoch-sweep, docs/epoch-sweep-design.md) — SOURCE-CELL IDENTITY. In sweep mode the caller
    // passes the finding's source `sweepCellKey` (+ epoch); the loop then EXCLUDES any stored finding whose
    // key is no longer an expected key under the current sealed manifest/epoch (its content moved), so the
    // append-only store stops re-offering a stale finding forever. Stamped ONLY when supplied — a legacy /
    // non-sweep record simply omits it and is treated as always-current, so the record shape (and every
    // existing test) is byte-identical when no key is passed. (correction E: the always-null `fileRevision`
    // param was DROPPED — the sweepCellKey embeds the chunkHash, which IS the content identity the staleness
    // exclusion judges by, so a separate file revision was dead provenance the sole call site never threaded.)
    ...(sweepCellKey != null ? { sweepCellKey, epochHash: epochHash ?? null } : {}),
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
  // WAVE 3 (correction B): the sweepCellKey of each fingerprint's MOST-RECENT record. The store dedupes by
  // fingerprint, but in sweep mode a fix can MOVE a finding's content so the SAME defect is re-reported from
  // a NEW cell (a fresh sweepCellKey). The loop's stale-exclusion drops the record stamped with the OLD key;
  // if the re-report were skipped as a plain dup, NO surviving record would carry the CURRENT key and a
  // still-LIVE finding would vanish forever. So when a known fingerprint is re-reported under a DIFFERENT,
  // non-null sweepCellKey, RE-STAMP it — append a fresh record with the current key — so a finding whose
  // current cell is still expected survives the stale-exclusion. Non-sweep (null key) stays a plain dup.
  const lastSweepKey = new Map();
  let seq = 0;
  for (const rec of readFindingsStore(file, deps)) {
    if (rec && rec.fingerprint) {
      seen.add(rec.fingerprint);
      if (typeof rec.sweepCellKey === "string") lastSweepKey.set(rec.fingerprint, rec.sweepCellKey);
    }
    if (Number.isFinite(rec?.seq)) seq = Math.max(seq, rec.seq + 1);
  }

  function append(findings, { pass = null, sweepCellKey = null, epochHash = null } = {}) {
    const records = [];
    const newFps = [];
    const stampedFps = []; // fps RE-STAMPED this batch (already seen, but their source cell MOVED)
    for (const f of findings ?? []) {
      const fp = fingerprintFinding(f);
      if (newFps.includes(fp) || stampedFps.includes(fp)) continue; // at most one record per fp per batch
      if (seen.has(fp)) {
        // A re-report of a known finding is normally a dup → skip. But in sweep mode, if its source cell
        // MOVED (a new, non-null sweepCellKey ≠ the last recorded one), RE-STAMP it (correction B) so a
        // record carrying the CURRENT key exists — else the stale-exclusion drops the only (old-key) record
        // and the live finding is lost. A null key (non-sweep) or an unchanged key stays a plain dup → skip.
        if (sweepCellKey != null && lastSweepKey.get(fp) !== sweepCellKey) {
          stampedFps.push(fp);
          records.push(toRecord(f, { session, seq: seq + records.length, pass, nowIso: now(), sweepCellKey, epochHash }));
        }
        continue;
      }
      newFps.push(fp);
      // A batch is the findings of ONE reviewed cell, so they all share that cell's sweep identity (sweep
      // mode only; null otherwise → an unstamped, always-current legacy record).
      records.push(toRecord(f, { session, seq: seq + records.length, pass, nowIso: now(), sweepCellKey, epochHash }));
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
    // WAVE 3 (correction B): track the latest key per fp for BOTH new AND re-stamped records, so a FURTHER
    // content move re-stamps again (a null key never overwrites a known key — non-sweep is inert here).
    if (sweepCellKey != null) { for (const fp of newFps) lastSweepKey.set(fp, sweepCellKey); for (const fp of stampedFps) lastSweepKey.set(fp, sweepCellKey); }
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
