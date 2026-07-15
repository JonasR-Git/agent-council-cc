// Epoch-sweep — Wave 1 STAGE 1: a PURE, deterministic foundation for a tier-scoped, run-wide
// coverage guarantee (docs/epoch-sweep-design.md). This module is NOT yet wired into the fix loop
// (that is Wave 2); it is built + unit-tested in isolation.
//
// What it provides:
//  - A canonical, cross-platform DONE-key for a review cell that carries FULL identity (epoch config
//    fingerprint + tier + group spec + reviewer set + model identity + POSIX file + chunk index +
//    content hash), so two distinct groups / models / edits can never false-satisfy each other.
//  - SHA-256 content hashing (node:crypto — a built-in, ZERO deps). A non-crypto rolling hash has a
//    false-DONE collision direction (two different chunks hashing equal ⇒ a never-reviewed cell reads
//    as done) which is unacceptable for a coverage-correctness key.
//  - `scopeGroupsForTier`: project lens groups onto ONE tier's lenses via INTERSECTION (never `.some()`,
//    which would keep a straddling group whole and review off-tier lenses ⇒ poisoned denominator).
//  - A SEALED-MANIFEST denominator (the crux): expected work is computed once from the reviewed
//    payload, so "all VISITED cells done" can never masquerade as "all EXPECTED cells done".
//  - A DURABLE append-only jsonl ledger with fsync-after-append (a persistence error THROWS — the
//    caller hard-stops sweep mode) and corrupt-tail recovery.
//
// PURITY / DETERMINISM: fs + clock are INJECTED ports (deps = { readFile, appendFile, fsyncFile,
// existsFile, writeFile, now }) with real defaults, so callers run it for real and tests inject fakes.
// No bare Date.now / fs / Math.random at module scope. All hashes use deterministic key ordering.
import fs from "node:fs";
import { createHash } from "node:crypto";

import { TIERS } from "./audit-tiers.mjs";

// Bump when the KEY SHAPE or manifest/ledger record shape changes (invalidates on-disk ledgers).
export const SCHEMA_VERSION = 1;
export const LEDGER_VERSION = 1;

// ── deterministic hashing primitives ───────────────────────────────────────────────────────────

/** SHA-256 hex of a UTF-8 string. */
function sha256(str) {
  return createHash("sha256").update(String(str), "utf8").digest("hex");
}

/**
 * Canonical JSON: object keys sorted RECURSIVELY (arrays keep their order — the caller pre-sorts any
 * order-independent array). The single source of determinism for every hash in this module.
 */
function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}
function sortValue(v) {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortValue(v[k]);
    return out;
  }
  return v;
}

/**
 * Repo-relative-STYLE path with Windows `\` folded to POSIX `/` at THIS one place — every key derives
 * its file component through here so the SAME cell is the SAME key regardless of the platform or
 * invocation style that produced the path. (Without this, `a\\b.mjs` and `a/b.mjs` are different keys.)
 */
export function posixKeyPath(file) {
  return String(file ?? "").replace(/\\/g, "/");
}

/**
 * SHA-256 hex of the EXACT chunk text (no newline normalization — the chunker output IS the reviewed
 * payload). Crypto-grade on purpose: the collision direction of a weak hash is false-DONE (fail-open),
 * which a coverage-correctness key must not have. Deterministic, 64 hex chars.
 */
export function chunkHash(text) {
  return sha256(text ?? "");
}

// ── tier scoping (Building Block 1, pure projection) ────────────────────────────────────────────

/** The lenses of a tier (tier id === array index 0..3). Out-of-range / null → [] (fail-closed). */
export function tierLenses(tier) {
  if (tier == null) return [];
  const t = TIERS[tier];
  return t && Array.isArray(t.lenses) ? [...t.lenses] : [];
}

/**
 * Project each group onto a tier by lens INTERSECTION: `lenses' = group.lenses ∩ TIERS[tier].lenses`.
 * Groups with an EMPTY intersection are DROPPED (they hunt nothing in this tier). Survivors keep their
 * title/focus and get a STABLE derived id `${g.id}@t${tier}` (the ledger key depends on it, so it must
 * be deterministic). Intersection preserves the group's own lens order.
 *
 * `tier == null/undefined` → return `groups` UNCHANGED (the backward-compat contract: enumeration is
 * byte-identical to today). Deliberately NOT `.some()` (keeping a straddling group whole would review
 * off-tier lenses and poison the denominator) and NOT a collapse to one group/tier (that flattens
 * fine's aspect-focused depth). A single-lens FINE group is a no-op projection (same lens, id suffixed).
 */
export function scopeGroupsForTier(groups, tier) {
  if (tier == null) return groups;
  const allowed = new Set(tierLenses(tier));
  const out = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    const lenses = (Array.isArray(g?.lenses) ? g.lenses : []).filter((l) => allowed.has(l));
    if (lenses.length === 0) continue;
    out.push({ id: `${g.id}@t${tier}`, title: g.title, lenses, ...(g.focus ? { focus: g.focus } : {}) });
  }
  return out;
}

// ── identity hashes (the sweep key's components) ────────────────────────────────────────────────

/** The group's REVIEW CONTRACT: id + ordered(sorted) lenses + title + focus. Two different groups
 *  (different lenses / focus) hash differently, so they never false-satisfy each other's cells. */
export function groupSpecHash(group) {
  const spec = {
    id: String(group?.id ?? ""),
    lenses: [...(Array.isArray(group?.lenses) ? group.lenses : [])].map(String).sort(),
    title: String(group?.title ?? ""),
    focus: String(group?.focus ?? "")
  };
  return sha256(stableStringify(spec));
}

/** The RESOLVED model identity (backend/model/effort) — NOT the seat name. Re-pinning a seat to a
 *  different model/effort changes the key ⇒ the old cells are re-owed (correct: different reviewer). */
export function modelIdentityHash(identity = {}) {
  const spec = { backend: String(identity?.backend ?? ""), model: String(identity?.model ?? ""), effort: String(identity?.effort ?? "") };
  return sha256(stableStringify(spec));
}

/** Hash of the FROZEN reviewer set (sorted by full identity so order is irrelevant). Freezing the set
 *  at epoch creation means a temporarily-unavailable seat stays OWED, never silently shrinks the count. */
export function reviewerSetHash(seats = []) {
  const list = (Array.isArray(seats) ? seats : []).map((s) => ({
    seat: String(s?.seat ?? ""),
    backend: String(s?.backend ?? ""),
    model: String(s?.model ?? ""),
    effort: String(s?.effort ?? "")
  }));
  list.sort((a, b) => cmp(stableStringify(a), stableStringify(b)));
  return sha256(stableStringify(list));
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The GLOBAL epoch = a config FINGERPRINT over only the inputs that change the reviewed PAYLOAD:
 * schema + chunker version/settings + tier→lens map version + scoped group specs + prompt version +
 * frozen reviewer identities + deep flag + preset id. Content edits do NOT feed this (chunkHash handles
 * them). Order-independent (reviewers + scopedGroupSpecs are sorted) and stable for the same config.
 */
export function computeEpochHash(config = {}) {
  const reviewers = (Array.isArray(config.reviewers) ? config.reviewers : []).map((r) => ({
    seat: String(r?.seat ?? ""),
    backend: String(r?.backend ?? ""),
    model: String(r?.model ?? ""),
    effort: String(r?.effort ?? "")
  }));
  reviewers.sort((a, b) => cmp(stableStringify(a), stableStringify(b)));
  const scopedGroupSpecs = (Array.isArray(config.scopedGroupSpecs) ? config.scopedGroupSpecs : []).map(String).sort();
  const fingerprint = {
    schemaVersion: config.schemaVersion ?? SCHEMA_VERSION,
    chunkerVersion: config.chunkerVersion ?? null,
    chunkMaxChars: config.chunkMaxChars ?? null,
    chunkOverlapLines: config.chunkOverlapLines ?? null,
    tierLensMapVersion: config.tierLensMapVersion ?? null,
    scopedGroupSpecs,
    promptVersion: config.promptVersion ?? null,
    reviewers,
    deep: Boolean(config.deep),
    presetId: config.presetId ?? null
  };
  return sha256(stableStringify(fingerprint));
}

/**
 * The canonical DONE-key for a review cell. A JSON array in EXACTLY this order (positional, compact,
 * git-diffable text). The file component is canonicalized through posixKeyPath at this one place.
 * Includes groupId AND groupSpecHash AND full model identity, so distinct fine groups / re-pinned
 * models never false-satisfy one another.
 */
export function sweepCellKey({ schemaV, epochHash, tier, groupSpecHash, groupId, reviewerSetHash, modelSeat, modelIdentityHash, file, chunkIndex, chunkHash } = {}) {
  return JSON.stringify([
    schemaV ?? SCHEMA_VERSION,
    epochHash,
    tier,
    groupSpecHash,
    groupId,
    reviewerSetHash,
    modelSeat,
    modelIdentityHash,
    posixKeyPath(file),
    chunkIndex,
    chunkHash
  ]);
}

/**
 * THE SINGLE SHARED KEY-BUILDER (Wave 2 invariant). Both the grouped-review `markDone` side AND the
 * `expectedKeys`/`pending` side derive a cell's DONE-key through THIS one function, from the SAME raw
 * semantic inputs (the scoped group OBJECT, the seat NAME, the frozen reviewer set, the file, the chunk
 * index, and either the chunk text or its precomputed hash). Deriving every component (groupSpecHash,
 * reviewerSetHash, the seat's modelIdentityHash, the content hash) through one place is what GUARANTEES
 * the two sides produce a byte-identical key — if either side hand-assembled the key, a subtly different
 * gsh/mih/rsh/hash would silently break coverage (pending never reaches 0, or a false 100%).
 *
 * `chunkHash` (precomputed, from the manifest row) wins over `chunkText`; `reviewerSetHash` may be passed
 * precomputed (a per-call micro-opt) but defaults to `reviewerSetHash(reviewerSet)` — same value either way.
 * The seat's identity is looked up IN the frozen reviewer set by seat name, so a temporarily-absent seat
 * still resolves to its frozen identity (never a shrinking denominator).
 */
export function cellSweepKey({ epochHash, tier, group, seat, reviewerSet, reviewerSetHash: rshIn, file, chunkIndex, chunkHash: hIn, chunkText } = {}) {
  const set = Array.isArray(reviewerSet) ? reviewerSet : [];
  const rsh = rshIn != null ? rshIn : reviewerSetHash(set);
  const identity = set.find((m) => String(m?.seat ?? "") === String(seat ?? "")) ?? {};
  return sweepCellKey({
    schemaV: SCHEMA_VERSION,
    epochHash,
    tier,
    groupSpecHash: groupSpecHash(group),
    groupId: group?.id,
    reviewerSetHash: rsh,
    modelSeat: String(seat ?? ""),
    modelIdentityHash: modelIdentityHash(identity),
    file,
    chunkIndex,
    chunkHash: hIn != null ? hIn : chunkHash(chunkText ?? "")
  });
}

/** The repo-relative POSIX file carried in a sweep key (array index 8), or null on a malformed key. Lets
 *  the scheduler group a tier's pending keys back to their files without re-deriving them. */
export function fileOfKey(key) {
  try {
    const arr = JSON.parse(key);
    return Array.isArray(arr) ? arr[8] ?? null : null;
  } catch {
    return null;
  }
}

// ── sealed manifest denominator (Building Block 2) ──────────────────────────────────────────────

/** Order two manifest/debt rows by their posix file path (ascending, deterministic). */
function byFile(a, b) {
  const x = String(a?.file ?? "");
  const y = String(b?.file ?? "");
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * A CANONICAL copy of a manifest: `files` + `debt` each sorted by posix path (chunks keep their
 * intra-file order). Every digest is computed over this canonical form, so
 * digest(build) == digest(resume-reconstruct) == digest(post-fix-invalidation) regardless of the order
 * rows were enumerated/appended in — the Wave 2 (B) ordering invariant that lets a routine interrupt
 * after fixing a NON-FINAL file --resume cleanly (the in-memory invalidation appends refreshed rows at
 * the END, so without canonical ordering the reconstructed insertion order would digest-mismatch).
 */
export function sortManifest(manifest = {}) {
  return { files: [...(manifest?.files ?? [])].sort(byFile), debt: [...(manifest?.debt ?? [])].sort(byFile) };
}

/**
 * Build the sealed MANIFEST — the denominator. Mirrors enumerateCells→supplied: for every ELIGIBLE
 * file compute chunks via the SAME `chunksOf` contract the grouped review uses and hash each chunk's
 * text with chunkHash. Eligibility mirrors grouped-review.mjs:72-107:
 *   - `isSupplied(file) === false`  → unreadable / oversize → recorded as DEBT (blocks completion,
 *     never a silent zero contribution).
 *   - supplied but 0 chunks         → a vacuously-clean 0-byte file: no cells, and NOT debt.
 *   - supplied with ≥1 chunk         → eligible; contributes to the counted set.
 * `revisionOf(file)` (optional) stamps a per-file revision (Wave 2 wires the git tree id; default null).
 * Returns `{ files:[{file,revision,status,chunks:[{i,startLine,endLine,h}]}], debt:[{file,reason}], digest }`
 * where digest = sha256 of the canonical manifest. (`scopedGroups`/`models`/`factsOf` from the documented
 * input contract feed `expected(...)`, not the manifest itself, so a caller may pass them harmlessly —
 * extra keys are ignored here.)
 */
export function buildManifest({ files, chunksOf, isSupplied, revisionOf } = {}) {
  const fileRows = [];
  const debt = [];
  for (const file of Array.isArray(files) ? files : []) {
    const supplied = typeof isSupplied === "function" ? isSupplied(file) !== false : true;
    if (!supplied) {
      debt.push({ file: posixKeyPath(file), reason: "unreadable-or-oversize" });
      continue;
    }
    const chunks = (typeof chunksOf === "function" ? chunksOf(file) : []) ?? [];
    if (chunks.length === 0) continue; // 0-byte / no-content → vacuously clean, no cells, not debt
    const rows = chunks.map((c, i) => ({
      i: Number.isFinite(c?.index) ? c.index : i,
      startLine: Number.isFinite(c?.startLine) ? c.startLine : null,
      endLine: Number.isFinite(c?.endLine) ? c.endLine : null,
      h: chunkHash(c?.text ?? "")
    }));
    fileRows.push({ file: posixKeyPath(file), revision: typeof revisionOf === "function" ? revisionOf(file) : null, status: "eligible", chunks: rows });
  }
  // CANONICAL ORDER (Wave 2 B): sort files + debt by posix path so the sealed digest is INDEPENDENT of
  // the order the files were enumerated in — the SAME property the resume reconstruction relies on.
  fileRows.sort(byFile);
  debt.sort(byFile);
  const digest = sha256(stableStringify({ files: fileRows, debt }));
  return { files: fileRows, debt, digest };
}

/**
 * Recompute a manifest's canonical digest from its `{ files, debt }` — the SAME hash `buildManifest`
 * seals. Wave 2 uses it after fix-invalidation replaces file rows in the in-memory manifest (so the
 * new digest can be re-sealed / checkpointed) and on resume to validate the reconstructed manifest
 * against the checkpoint's `manifestDigest` (a mismatch fails closed).
 */
export function manifestDigest(manifest = {}) {
  const c = sortManifest(manifest);
  return sha256(stableStringify({ files: c.files, debt: c.debt }));
}

/**
 * Expected CELL COUNT for a tier = `|models| × Σ_f (chunkCount(f) × |scopedGroups|)` over the manifest's
 * ELIGIBLE files (debt files contribute nothing to the count but are surfaced separately as debt that
 * blocks completion). Every scoped group currently covers every chunk (adjust here if focus scoping
 * ever makes a group skip chunks). First arg is the MANIFEST (the chunk counts live there).
 */
export function expected(manifest, scopedGroups, models) {
  const groupCount = Array.isArray(scopedGroups) ? scopedGroups.length : 0;
  const modelCount = Array.isArray(models) ? models.length : 0;
  const chunkSum = (manifest?.files ?? []).reduce((sum, f) => sum + (Array.isArray(f?.chunks) ? f.chunks.length : 0), 0);
  return modelCount * chunkSum * groupCount;
}

/**
 * The full ordered list of EXPECTED sweep keys for a tier under an epoch — the SSOT both the ledger's
 * done-rows and `pending()` derive from. Order: file → chunk → group → model (deterministic + resumable).
 * `models` entries are reviewer identities `{ seat, backend, model, effort }`.
 *
 * WAVE 2 KEY-CONSISTENCY: every key here is built through `cellSweepKey` — THE SAME single builder the
 * grouped-review `markDone` side uses. Routing both sides through one function (from the same raw
 * semantic inputs: the scoped group OBJECT, the seat NAME, the frozen reviewer set, the file, the chunk
 * index, and the content hash) is what GUARANTEES a reviewed cell's done-key is byte-identical to the key
 * this function generates for it. `reviewerSetHash` is computed ONCE and passed in (a micro-opt — the
 * per-call default derives the identical value). The manifest's chunk `{i,h}` are the same index+hash the
 * reviewed cell carries (both from the same chunksOf path over stable content), so the keys match.
 */
export function expectedKeys(manifest, tier, scopedGroups, models, epochHash) {
  const rsh = reviewerSetHash(models);
  const groups = Array.isArray(scopedGroups) ? scopedGroups : [];
  const reviewers = Array.isArray(models) ? models : [];
  const keys = [];
  for (const f of manifest?.files ?? []) {
    for (const c of f?.chunks ?? []) {
      for (const g of groups) {
        for (const r of reviewers) {
          keys.push(
            cellSweepKey({
              epochHash,
              tier,
              group: g,
              seat: r?.seat,
              reviewerSet: reviewers,
              reviewerSetHash: rsh,
              file: f.file,
              chunkIndex: c.i,
              chunkHash: c.h
            })
          );
        }
      }
    }
  }
  return keys;
}

// ── durable append-only ledger (Building Block 2, own file) ─────────────────────────────────────

/**
 * Parse the jsonl ledger with CORRUPT-TAIL RECOVERY:
 *  - A truncated/invalid LAST line (no terminating newline, OR the last data line fails to parse) is
 *    DROPPED and every prior valid line kept (`droppedTail`). Fail-closed: that cell re-reviews.
 *  - An invalid INTERIOR line ⇒ the ledger is CORRUPT (`corrupt`); the caller must fail closed.
 */
function parseLedger(raw) {
  const records = [];
  let corrupt = false;
  let droppedTail = false;
  if (!raw) return { records, corrupt, droppedTail };
  const endsWithNewline = raw.endsWith("\n");
  const parts = raw.split("\n");
  if (parts.length && parts[parts.length - 1] === "") parts.pop(); // the terminator's empty tail
  if (!endsWithNewline && parts.length) {
    parts.pop(); // an un-terminated final line is a torn write → drop it
    droppedTail = true;
  }
  for (let idx = 0; idx < parts.length; idx += 1) {
    let rec;
    try {
      rec = JSON.parse(parts[idx]);
    } catch {
      if (idx === parts.length - 1) {
        droppedTail = true; // invalid LAST line → torn tail, drop it, keep the rest
        break;
      }
      corrupt = true; // invalid INTERIOR line → fail closed
      break;
    }
    records.push(rec);
  }
  return { records, corrupt, droppedTail };
}

/**
 * A DURABLE append-only jsonl ledger — the run-wide sweep cursor (its OWN file, NOT the best-effort,
 * per-pass-reset mid-pass cursor). Every append is a COMPLETE newline-terminated JSON record, appended
 * THEN fsync'd; a persistence error THROWS (the caller hard-stops sweep mode — never a best-effort
 * swallow). `markDone` counts as done ONLY after a successful fsync. The ledger lives where the caller
 * says (the audit-state dir, never the working tree); this module just writes there.
 *
 * `deps = { readFile, appendFile, fsyncFile, existsFile, writeFile, now }` — injected ports with real
 * fs/clock defaults; tests inject fakes for determinism.
 */
export function makeTierSweepCursor(filePath, { deps = {} } = {}) {
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, "utf8"));
  const appendFile = deps.appendFile ?? ((p, d) => fs.appendFileSync(p, d));
  const fsyncFile =
    deps.fsyncFile ??
    ((p) => {
      // "r+" (read-WRITE), NOT "r": on Windows FlushFileBuffers requires write access, so fsync on a
      // read-only handle throws EPERM (live-found — it aborted the first real epoch-sweep run on pass 1;
      // unit tests inject a fake fsyncFile so the real handle mode was never exercised). The file always
      // exists here (appendFile created/appended it before this fsync).
      const fd = fs.openSync(p, "r+");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    });
  const existsFile = deps.existsFile ?? ((p) => fs.existsSync(p));
  const writeFile = deps.writeFile ?? ((p, d) => fs.writeFileSync(p, d));
  const now = deps.now ?? (() => Date.now());

  let seq = 0;
  const doneSet = new Set();
  const tierCleanSet = new Set();
  const manifestRows = [];
  let header = null;
  let seal = null;

  // Append + fsync a complete record. fsync failure propagates (BEFORE any in-memory commit) so a
  // markDone whose durability is not guaranteed is NOT counted done.
  function writeRecord(rec) {
    appendFile(filePath, JSON.stringify(rec) + "\n");
    fsyncFile(filePath);
    seq += 1;
    return rec;
  }

  return {
    appendHeader({ runId, baseBranch, baseHead, epochHash, reviewers, tierPlan } = {}) {
      const rec = { v: LEDGER_VERSION, type: "header", seq, ts: now(), runId, baseBranch, baseHead, epochHash, reviewers, tierPlan };
      writeRecord(rec);
      header = rec;
      return rec;
    },
    appendManifest(fileRow = {}) {
      const rec = { v: LEDGER_VERSION, type: "file", seq, file: posixKeyPath(fileRow.file), revision: fileRow.revision ?? null, chunks: fileRow.chunks ?? [] };
      writeRecord(rec);
      manifestRows.push(rec);
      return rec;
    },
    sealManifest({ digest, fileCount } = {}) {
      return writeRecord({ v: LEDGER_VERSION, type: "manifest-seal", seq, digest, fileCount: fileCount ?? null });
    },
    // Wave 2 (B/D): persist a DEBT row (a still-present file that is unreadable/oversize) so a resume
    // reconstructs the SAME {files,debt} the sealed digest covers. The seal's digest INCLUDES debt, so a
    // manifest with any debt could never re-match its seal (→ "cannot resume") unless debt is persisted.
    appendDebt(debtRow = {}) {
      const rec = { v: LEDGER_VERSION, type: "file-debt", seq, file: posixKeyPath(debtRow.file), reason: debtRow.reason ?? "unreadable-or-oversize" };
      writeRecord(rec);
      return rec;
    },
    // Wave 2 (C/D): a VERIFIED deletion — the path is gone from the git tree, so it leaves the denominator
    // entirely (no row, no debt). Distinct from appendDebt (a still-present unreadable/oversize file that
    // BLOCKS completion): reconstruction drops the file from BOTH the eligible set and the debt set.
    dropFile(file) {
      const rec = { v: LEDGER_VERSION, type: "file-drop", seq, file: posixKeyPath(file) };
      writeRecord(rec);
      return rec;
    },
    markDone(sweepKey, { pass } = {}) {
      const rec = writeRecord({ v: LEDGER_VERSION, type: "done", seq, k: sweepKey, pass: pass ?? null }); // throws ⇒ NOT counted done
      doneSet.add(sweepKey);
      return rec;
    },
    markTierClean({ tier, manifestDigest } = {}) {
      const rec = writeRecord({ v: LEDGER_VERSION, type: "tier-clean", seq, tier, manifestDigest: manifestDigest ?? null });
      tierCleanSet.add(tier);
      return rec;
    },
    load() {
      doneSet.clear();
      tierCleanSet.clear();
      manifestRows.length = 0;
      header = null;
      seal = null;
      seq = 0;
      if (!existsFile(filePath)) return { header: null, manifestRows: [], manifest: { files: [], debt: [] }, seal: null, done: new Set(), tierClean: new Set(), corrupt: false, droppedTail: false };
      const { records, corrupt, droppedTail } = parseLedger(readFile(filePath) ?? "");
      // ORDERED replay (Wave 2 B/D): file / file-debt / file-drop are LAST-WINS per path ACROSS their
      // interleaving, so a path that went eligible→debt→eligible (or was deleted) reconstructs to its
      // FINAL state. The reconstructed {files,debt} is sorted canonically so its digest matches the seal.
      const fileMap = new Map();
      const debtMap = new Map();
      for (const rec of records) {
        if (!rec || typeof rec !== "object") continue;
        if (rec.type === "header") header = rec;
        else if (rec.type === "file") {
          manifestRows.push(rec);
          fileMap.set(rec.file, { file: rec.file, revision: rec.revision ?? null, status: "eligible", chunks: rec.chunks ?? [] });
          debtMap.delete(rec.file);
        } else if (rec.type === "file-debt") {
          debtMap.set(rec.file, { file: rec.file, reason: rec.reason ?? "unreadable-or-oversize" });
          fileMap.delete(rec.file);
        } else if (rec.type === "file-drop") {
          fileMap.delete(rec.file);
          debtMap.delete(rec.file);
        } else if (rec.type === "manifest-seal") seal = rec;
        else if (rec.type === "done" && typeof rec.k === "string") doneSet.add(rec.k);
        else if (rec.type === "tier-clean") tierCleanSet.add(rec.tier);
      }
      seq = records.length;
      const manifest = sortManifest({ files: [...fileMap.values()], debt: [...debtMap.values()] });
      return { header, manifestRows: [...manifestRows], manifest, seal, done: new Set(doneSet), tierClean: new Set(tierCleanSet), corrupt, droppedTail };
    },
    isDone(sweepKey) {
      return doneSet.has(sweepKey);
    },
    /** Expected keys for the tier MINUS the done set (keys embed epochHash, so old-epoch dones simply
     *  don't match current expected keys ⇒ they count ZERO, exactly the fail-closed epoch semantics). */
    pending(manifest, tier, scopedGroups, models, epochHash) {
      return expectedKeys(manifest, tier, scopedGroups, models, epochHash).filter((k) => !doneSet.has(k));
    },
    tierPending(tier, manifest, scopedGroups, models, epochHash) {
      const keys = expectedKeys(manifest, tier, scopedGroups, models, epochHash).filter((k) => !doneSet.has(k));
      return { tier, count: keys.length, keys };
    },
    expectedCount(manifest, scopedGroups, models) {
      return expected(manifest, scopedGroups, models);
    },
    reset() {
      writeFile(filePath, "");
      doneSet.clear();
      tierCleanSet.clear();
      manifestRows.length = 0;
      header = null;
      seal = null;
      seq = 0;
    },
    // Introspection (tests / callers).
    get seq() {
      return seq;
    },
    doneCount() {
      return doneSet.size;
    },
    cleanTiers() {
      return new Set(tierCleanSet);
    }
  };
}
