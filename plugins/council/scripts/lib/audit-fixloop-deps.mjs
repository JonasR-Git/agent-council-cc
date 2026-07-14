// Wiring for `audit fix --loop` (docs/enterprise-fix-design.md M3): compose the real
// engine pieces into the injectable deps runFixLoop consumes. The composition is a
// separate, TESTABLE factory (runAuditReview + runAuditFix injectable) because it is
// exactly where the council found contract drift.
//
// - review: runAuditReview over the codebase model. Full-scope passes advance a
//   PROGRESSIVE hotspot window keyed to a FULL-SCOPE-pass counter (NOT the loop's global
//   pass number, which mixes scope modes) and WRAP at the end so an overrun re-reviews
//   the top band instead of returning an empty review the loop would misread as "dry".
//   A localized pass reviews exactly the changed files; if none of them are known model
//   units it falls back to full scope rather than reviewing nothing. It also folds the
//   PRIOR pass's coverage.completenessGaps (M8 completeness critic + B4 structural gaps)
//   into THIS pass's scope — a flagged file rides alongside (or becomes) the changed-files
//   scope, so a gap the critic/matrix flagged is actually RE-TARGETED next pass instead of
//   only resetting the loop's dry streak.
// - fix: runAuditFix on the actionable set, threading branch + stayOnBranch so ONE
//   integration branch continues across passes.
// - expandScope: blast-radius (§7) — a HUB-file change (fan-in >= threshold) forces a
//   full re-scope next pass; a leaf change stays narrow. NOTE (MVP limitation): the true
//   dependent SET isn't cheaply available (the codebase model exposes fan-in as a COUNT,
//   not importer ids), so a covered dependent regression is caught by the per-fix +
//   integration test gates, and an UNCOVERED one on a leaf edit can be missed until the
//   model exposes import edges. Documented gap.
// - verdictsFor: returns options.verdictMap — the Tier-0 verdict map the CLI threads in from
//   detectLogical (council-companion), whose above-floor, non-quarantined verdicts DO gate
//   (prune/redirect) findings; {} only for a bare caller that injects no map.

import fs from "node:fs";
import path from "node:path";

import { runAuditFix } from "./audit-fix.mjs";
import { normalizeFindings } from "./audit-normalize.mjs";
import { runAuditReview, selectUnits } from "./audit-review.mjs";
import { runGroupedReview, READ_MAX_BYTES } from "./audit-grouped-review.mjs";
import { resolveLensGroups } from "./audit-lens-groups.mjs";
import { chunkSource, CHUNK_MAX_CHARS, CHUNK_OVERLAP_LINES, CHUNKER_VERSION } from "./audit-group-prompt.mjs";
import { activeSeatNames } from "./seats.mjs";
import { buildManifest, computeEpochHash, fileOfKey, groupSpecHash, makeTierSweepCursor, posixKeyPath } from "./audit-tier-sweep.mjs";
import { resolveStateDir, workspaceRoot } from "./state.mjs";
import { runCommand } from "./process.mjs";

// WAVE 2 (epoch-sweep, G — SSOT): the sweep manifest chunks each file through the EXACT same read+chunk
// path the review uses, so it imports grouped-review's READ_MAX_BYTES (and matches its `>` comparison)
// rather than hand-mirroring the value — manifest eligibility and review eligibility can never drift.

/**
 * Parse `git diff --name-status -z A B` into `{ changed:[posix present], deleted:[posix gone] }`.
 * A/M/T → present (added/modified/type-changed); D → deleted; R<score> → OLD deleted + NEW present;
 * C<score> → NEW present (the copy source is unchanged). Every path folded to posix so it keys the SAME
 * way as the manifest (the Windows-backslash consistency the C-fix guarantees for changedSet+refreshFiles).
 */
function parseDiffNameStatusZ(raw) {
  const parts = String(raw ?? "").split("\0").filter((s) => s.length);
  const changed = [];
  const deleted = [];
  for (let i = 0; i < parts.length; i += 1) {
    const code = parts[i][0];
    if (code === "R" || code === "C") {
      const oldPath = parts[i + 1];
      const newPath = parts[i + 2];
      i += 2;
      if (code === "R" && oldPath) deleted.push(posixKeyPath(oldPath));
      if (newPath) changed.push(posixKeyPath(newPath));
    } else {
      const p = parts[i + 1];
      i += 1;
      if (!p) continue;
      if (code === "D") deleted.push(posixKeyPath(p));
      else changed.push(posixKeyPath(p));
    }
  }
  return { changed, deleted };
}

/** The frozen review identity of one seat (backend/model/effort) for the epoch fingerprint + key. The
 *  built-in seats read their model/effort pins off the same options the seat runners do; an OpenRouter
 *  seat carries its configured model. Empty strings when unpinned (deterministic + stable per config). */
function seatIdentity(seat, options = {}, backends = null) {
  if (seat === "codex") return { seat, backend: "codex", model: String(options.codexModel ?? ""), effort: String(options.codexEffort ?? "") };
  if (seat === "grok") return { seat, backend: "grok", model: String(options.grokModel ?? ""), effort: String(options.grokEffort ?? "") };
  if (seat === "claude") return { seat, backend: "claude", model: String(options.claudeModel ?? ""), effort: String(options.claudeEffort ?? "") };
  const or = (backends?.openrouter?.seats ?? []).find((s) => s.id === seat);
  return { seat, backend: "openrouter", model: String(or?.model ?? ""), effort: String(options.openrouterEffort ?? "") };
}

/** file -> Set(peer files that share a duplicate cluster with it). */
function buildDupPeers(dupClusters = []) {
  const peers = new Map();
  for (const cluster of dupClusters) {
    const inCluster = [...new Set((cluster.locations ?? []).map((l) => l.file).filter(Boolean))];
    for (const f of inCluster) {
      if (!peers.has(f)) peers.set(f, new Set());
      for (const g of inCluster) if (g !== f) peers.get(f).add(g);
    }
  }
  return peers;
}

/**
 * Recover REAL model file ids named by a completeness-gap token (coverage.completenessGaps —
 * completeness-critic's flattened `nextTargets`: un-scheduled files, "groupId:file#chunk"
 * incomplete-triple ids, or a critic-flagged class/where string). Only an EXACT match against a
 * known model file id is honored — a bare defect-class token ("concurrency") or an unresolvable
 * "where" description is not itself a valid scope target, and fuzzy-matching it risks folding in
 * the wrong file. Tried in order: the raw token, the token with a trailing "#chunk" stripped, then
 * that with a leading "groupId:" prefix also stripped.
 */
function gapFileIds(gaps, knownIds) {
  if (!Array.isArray(gaps) || !gaps.length) return [];
  const out = [];
  for (const g of gaps) {
    const s = String(g ?? "");
    const withoutChunk = s.includes("#") ? s.slice(0, s.lastIndexOf("#")) : s;
    const afterColon = withoutChunk.includes(":") ? withoutChunk.slice(withoutChunk.indexOf(":") + 1) : withoutChunk;
    const hit = [s, withoutChunk, afterColon].find((c) => knownIds.has(c));
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

// A grouped pass spends its per-pass budget on THREE kinds of paid agent call: cells, the (optional)
// completeness critic, and (A1) adversarial refutation of its single-agent P0/P1s. Cells are capped to
// what remains AFTER the other two are reserved, so the pass's TOTAL spend stays within its allowance.
const VERIFY_RESERVE_CAP = 24; // mirrors audit-grouped-review's VERIFY_MAX_CALLS ceiling

/** Calls reserved for refutation this pass: at most a QUARTER of the budget, capped, ≥0. */
function verifyReserve(options, budget) {
  if (!options.lensGroups || options.verifyAudit === false) return 0;
  const b = Math.max(0, Math.floor(budget));
  return Math.max(0, Math.min(VERIFY_RESERVE_CAP, Math.floor(b / 4)));
}

/**
 * Total non-cell reserve, clamped so it can never consume the whole budget:
 *   - the completeness critic (1 call when enabled),
 *   - adversarial refutation (verifyReserve),
 *   - a HEADROOM allowance for the matrix's EXTRA calls: a parse repair and a rate-limit retry each
 *     re-invoke a seat runner, so they are paid calls too (council Grok P1/P2). They are now CHARGED to
 *     coverage.budgetSpent; reserving a slice keeps a garbled/throttled pass from over-running its
 *     allowance before the loop's total-budget clamp catches it.
 */
const EXTRA_RESERVE_FRACTION = 8; // ~12% of the pass budget held back for repairs/retries

function extraReserve(options, budget) {
  if (!options.lensGroups) return 0;
  const b = Math.max(0, Math.floor(budget));
  return Math.max(0, Math.floor(b / EXTRA_RESERVE_FRACTION));
}

function groupedReserve(options, budget) {
  const b = Math.max(0, Math.floor(budget));
  const critic = options.completenessCritic ? 1 : 0;
  const reserve = critic + verifyReserve(options, budget) + extraReserve(options, budget);
  // never starve the cells: leave at least half the budget for actual review work
  return Math.min(reserve, Math.max(0, Math.floor(b / 2)));
}

export function makeFixLoopDeps(cwd, model, backends, options = {}, impl = {}) {
  // R9 wiring: when --groups is set, drive the loop off the cell-granular GROUPED six-eyes review
  // (runGroupedReview) instead of the per-file runAuditReview — its coverage.complete feeds the loop's
  // convergence guard so a pass whose six-eyes matrix is INCOMPLETE (cells unreviewed) does NOT count
  // toward the dry streak. NOTE: complete reflects THIS pass's scheduled cells (the selected maxUnits
  // window under its budget cap), not a whole-project matrix — the progressive window + blast-radius
  // re-scope move coverage across the project over passes. Both paths return a compatible {findings,
  // coverage:{unitsReviewed/unitsSelected/complete/budgetSpent}} shape; each is injectable for tests.
  const doPerFile = impl.runAuditReview ?? runAuditReview;
  const doGrouped = impl.runGroupedReview ?? runGroupedReview;
  const doReview = options.lensGroups ? doGrouped : doPerFile;
  const doFix = impl.runAuditFix ?? runAuditFix;
  const maxUnits = Math.max(1, options.maxUnits ?? 8);
  const hubFanIn = options.hubFanIn ?? 8;
  const files = model?.files ?? [];
  const nonTestCount = Math.max(1, files.filter((f) => !f.isTest).length);
  const importersOf = model?.graph?.importers ?? {};
  const dupPeers = buildDupPeers(model?.dupClusters);
  let fullPasses = 0; // counts ONLY full-scope passes, so the window advance is honest
  const knownFileIds = new Set(files.map((f) => f?.id).filter(Boolean));
  // M8 follow-up (council P2): files flagged by the PRIOR pass's completeness gaps (structural
  // un-scheduled/incomplete cells + the critic's flagged classes, coverage.completenessGaps). Folded
  // into the NEXT pass's scope below so a flagged gap actually gets RE-TARGETED — before this fix the
  // gap was computed and exposed but never consumed, and only completenessComplete=false resetting the
  // dry streak kept the loop from converging over it, without ever scheduling the gap itself.
  let pendingGapFiles = [];

  // A5: the model/effort/TIMEOUT pins (--codex-model/--grok-model/--claude-model, --agent-timeout and
  // their .council.yml policy equivalents) must reach EVERY seat the loop spawns — the seat runners read
  // them straight off the options object (seats.mjs → agents/claude-agent/openrouter-agent). The one-shot
  // path spreads ...merged into runAuditReview/runGroupedReview/runAuditFix and honors them; the loop
  // forwarded only budget + the skip flags, so every finder silently ran on the CLI-default model and the
  // 300s default timeout, discarding the pins the user (or the policy) chose. Thread the same pin SET into
  // BOTH the review and the fix call. An unset pin stays undefined → each agent keeps its own CLI default,
  // so a run without pins behaves exactly as before.
  const agentPins = {
    codexModel: options.codexModel,
    grokModel: options.grokModel,
    claudeModel: options.claudeModel,
    codexEffort: options.codexEffort,
    grokEffort: options.grokEffort,
    claudeEffort: options.claudeEffort,
    openrouterEffort: options.openrouterEffort,
    agentTimeoutMs: options.agentTimeoutMs
  };

  const filesById = new Map(files.map((f) => [f?.id, f]).filter(([id]) => id));

  // WAVE 2 (epoch-sweep, docs/epoch-sweep-design.md) — the DURABLE run-wide coverage machinery, built
  // ONCE and injected into the loop as `deps.sweep`. It is constructed ONLY on the grouped path with
  // `--epoch-sweep` on; otherwise it is null and every sweep code path (in runFixLoop + the review
  // closure) is skipped ⇒ behaviour is byte-identical to today. This factory holds the IMPURE materials
  // (frozen reviewer identities, the epoch fingerprint, the on-disk ledger, the disk read/chunk path);
  // runFixLoop drives the pure orchestration (build/seal, tier plan, pending scheduling, advance,
  // invalidation, resume) over them. fs/state access lives here so the loop stays unit-testable with an
  // injected fake `deps.sweep`.
  let sweep = null;
  if (options.epochSweep && options.lensGroups) {
    const reviewerSet = activeSeatNames(backends, options).map((s) => seatIdentity(s, options, backends));
    const baseGroups = resolveLensGroups(options.lensGroups);
    const epochHash = computeEpochHash({
      reviewers: reviewerSet,
      scopedGroupSpecs: baseGroups.map((g) => groupSpecHash(g)),
      // WAVE 2 (G): fold the LIVE chunker identity into the epoch — the actual maxChars/overlap the manifest
      // + review chunk with (chunkSource defaults) + a CHUNKER_VERSION. A CHUNK_MAX_CHARS / overlap / algorithm
      // change now ROTATES the epoch (old chunk boundaries ⇒ old done-rows re-owed); fail-closed on skew.
      chunkerVersion: CHUNKER_VERSION,
      chunkMaxChars: CHUNK_MAX_CHARS,
      chunkOverlapLines: CHUNK_OVERLAP_LINES,
      deep: options.deep,
      presetId: options.lensGroups
    });
    // The full non-test file universe in the SAME deterministic order the scheduler + selectUnits use
    // (hotspot desc, id asc) — the manifest denominator (every eligible file, NOT the per-pass window).
    const allFiles = selectUnits(model, { maxUnits: Number.MAX_SAFE_INTEGER, offset: 0 });
    const root = workspaceRoot(cwd);
    // chunksOf mirrors grouped-review.mjs:89-104 EXACTLY (same READ_MAX_BYTES guard, same chunkSource),
    // so the manifest's chunk hashes equal the reviewed cells' chunk hashes. A cache keyed by file id;
    // `null` = unsupplied (oversize/unreadable) so isSupplied can report DEBT, `[]` = a 0-byte file
    // (vacuously clean, no cells). `bust` re-reads a file after a fix so invalidation re-hashes it.
    const chunkCache = new Map();
    const readChunks = (fileId) => {
      if (chunkCache.has(fileId)) return chunkCache.get(fileId);
      let chunks = null;
      try {
        const p = path.join(root, fileId);
        if (fs.statSync(p).size > READ_MAX_BYTES) chunks = null;
        else {
          const text = fs.readFileSync(p, "utf8");
          chunks = text ? chunkSource(text) : [];
        }
      } catch {
        chunks = null;
      }
      chunkCache.set(fileId, chunks);
      return chunks;
    };
    const isSupplied = (fileId) => readChunks(fileId) !== null;
    const chunksOf = (fileId) => readChunks(fileId) ?? [];
    sweep = {
      epochHash,
      reviewerSet,
      baseGroups,
      cursor: impl.tierSweepCursor ?? makeTierSweepCursor(path.join(resolveStateDir(cwd), "audit-tier-sweep-cursor.jsonl")),
      allFiles,
      fileObjById: (id) => filesById.get(id),
      // Build the WHOLE manifest (all eligible files × chunks) from disk. Tier-independent.
      buildManifest: () => buildManifest({ files: allFiles, chunksOf, isSupplied }),
      // Re-hash a set of files from DISK after a fix batch (bust the cache first) → fresh manifest rows
      // whose chunk hashes no longer match the old done-rows ⇒ those cells become pending again.
      refreshFiles: (fileIds) => {
        for (const f of fileIds) chunkCache.delete(f);
        return buildManifest({ files: fileIds, chunksOf, isSupplied });
      },
      // WAVE 2 (C): the VERIFIED changed set. Capture HEAD before/after a fix batch and diff the two
      // commits on the isolation branch (added/modified/deleted/renamed) — fx.changedFiles records only
      // one file per finding, so a MULTI-FILE structure transform's co-edited files are otherwise left with
      // STALE manifest rows. Uses the SAME git port (runCommand at the workspace root) the fix layer shells
      // through — no new dep. Returns null when git is unavailable (e.g. a non-git test workspace) so the
      // loop falls back to fx.changedFiles.
      gitHead: () => {
        const r = runCommand("git", ["rev-parse", "HEAD"], { cwd: root });
        return r.status === 0 ? r.stdout.trim() || null : null;
      },
      gitChangedSince: (before, after) => {
        if (!before || !after) return null;
        const r = runCommand("git", ["diff", "--name-status", "-z", before, after], { cwd: root });
        if (r.status !== 0) return null;
        return parseDiffNameStatusZ(r.stdout);
      },
      // Fallback (no git) deletion probe: does a changed path still exist on disk?
      fileExists: (fileId) => {
        try {
          return fs.existsSync(path.join(root, String(fileId)));
        } catch {
          return false;
        }
      }
    };
  }

  // WAVE 2: order a tier's PENDING files for scheduling — `changedFiles` (a localized pass) are PRIORITY
  // (touched files' pending cells first), then the rest of the pending set in the SAME deterministic
  // selectUnits order (hotspot desc, id asc) the full-scope window uses. Never a RESTRICTION on the
  // expected universe — just the order the bounded window walks it.
  const orderPendingFiles = (keys, changed) => {
    const pendingSet = new Set(keys.map(fileOfKey).filter(Boolean));
    const rank = new Map((sweep?.allFiles ?? []).map((id, i) => [id, i]));
    const out = [];
    const seen = new Set();
    for (const c of changed ?? []) {
      const id = String(c).replace(/\\/g, "/");
      if (pendingSet.has(id) && !seen.has(id)) { out.push(id); seen.add(id); }
    }
    const rest = [...pendingSet].filter((f) => !seen.has(f)).sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || String(a).localeCompare(String(b)));
    return [...out, ...rest];
  };

  const review = async ({ budget, changedFiles, pass, guard, findingsAppender, tier, sweep: reviewSweep } = {}) => {
    // Fold the PRIOR pass's flagged gap files (if any) into this pass's scope: they ride ALONGSIDE
    // an existing localized changedFiles scope, or — absent one — BECOME it, so the loop actually
    // re-targets the gap next pass instead of only resetting the dry streak.
    const gapScope = pendingGapFiles.length ? [...new Set([...(changedFiles ?? []), ...pendingGapFiles])] : changedFiles;
    const scopedFiles = gapScope && gapScope.length ? files.filter((f) => gapScope.includes(f.id)) : null;
    let reviewFiles;
    let offset = 0;
    let fullScopePass = false;
    if (reviewSweep) {
      // WAVE 2 — PENDING-DRIVEN scheduling REPLACES the modulo window in sweep mode. Select the files
      // that still have ≥1 pending cell for the current tier (OWED = manifest − done), in selectUnits
      // order, up to maxUnits. The uncapped remainder is simply not reviewed this pass → stays pending
      // (free OWED persistence — no windowState desync). windowState/fullPasses are untouched here.
      const pend = reviewSweep.cursor.tierPending(tier, reviewSweep.manifest, reviewSweep.scopedGroups, reviewSweep.reviewerSet, reviewSweep.epochHash);
      if (pend.count === 0) {
        // The current tier is fully COVERED — nothing to schedule. Return a clean DRY pass (0 spend,
        // complete) so the loop's ledger-gated tier-advance can fire. This is NOT a starved/undispatched
        // pass (which must never advance the tier); it is genuine completion, so ran:true.
        return { findings: [], ran: true, coverage: { ran: true, passComplete: true, complete: true, budgetSpent: 0, unitsSelected: 0, unitsReviewed: 0, sweepNoPending: true } };
      }
      reviewFiles = orderPendingFiles(pend.keys, changedFiles).slice(0, maxUnits).map((id) => filesById.get(id)).filter(Boolean);
    } else if (scopedFiles && scopedFiles.length) {
      reviewFiles = scopedFiles; // localized pass: review the changed (+ folded gap) band from the top
    } else {
      // Full scope (first pass, hub-forced full, or empty-scoped fallback): advance the window by
      // full-scope passes and WRAP so an overrun never returns an empty review. The advance is DEFERRED
      // until AFTER a successful (non-quiesced) review, so a mid-pass quiesce leaves the offset unchanged
      // and the --resume re-reviews the SAME band (its durable cursor skips the cells already done).
      reviewFiles = files;
      offset = (fullPasses * maxUnits) % nonTestCount;
      fullScopePass = true;
    }
    // skipReduce keys on the full-scope-pass COUNT INCLUDING this pass (the SSOT reduce runs once, on the
    // first full pass). Since the fullPasses INCREMENT is now deferred until after a non-quiesced review,
    // fold this pass in here so the value is byte-identical to the pre-deferral `fullPasses > 1`.
    const effectiveFullPasses = fullScopePass ? fullPasses + 1 : fullPasses;
    const scopedModel = reviewFiles === files ? model : { ...model, files: reviewFiles };
    const rev = await doReview(cwd, scopedModel, backends, {
      // A5: model/effort/timeout pins first — every explicit key below still wins.
      ...agentPins,
      // Phase 2: the loop's ONE reporter (audit-fix-loop) also gets each pass's review so the live
      // per-lens matrix + unit progress land on the same progress.json the fix counters do (additive).
      reporter: options.reporter,
      // B/C: the mid-pass checkpoint-and-resume quota guard + the durable findings appender, threaded
      // into the grouped review (runAuditReview ignores them). `pass` stamps each durable finding record.
      reviewGuard: guard,
      findingsAppender,
      pass,
      budget,
      maxUnits,
      unitOffset: offset,
      skipReduce: effectiveFullPasses > 1, // the SSOT reduce is over static input — run it once
      skipCodex: options.skipCodex,
      skipGrok: options.skipGrok,
      // B2 (council grok-1): thread skipClaude too, else the fix loop spawns the Claude finder
      // even when the user opted out (reviewers:[codex,grok] / --skip-claude), inflating cost.
      skipClaude: options.skipClaude,
      ledger: options.ledger,
      // R9: when set, doReview is runGroupedReview — it honors maxUnits/unitOffset (per-file selection)
      // and drives the cell matrix off these; runAuditReview ignores them. CAP the pass's cells to the
      // per-pass BUDGET (each cell = one paid agent call) so a grouped pass never dispatches more calls
      // than the pass is allotted — else it ignored the budget entirely and one pass blew the whole
      // loop budget → a 1-pass stop with under-reported spend (council Grok R9 P0/P1). budgetSpent then
      // stays ≤ budget and the loop iterates honestly.
      lensGroups: options.lensGroups,
      // Wave 1 Stage 2 (BB1): OPTIONAL tier-scoped enumeration. When the loop supplies a `tier`,
      // runGroupedReview scopes the groups to that tier's lenses before enumerateCells. `tier == null`
      // (today's default) ⇒ no scoping ⇒ byte-identical enumeration. runAuditReview ignores it.
      tier,
      // Wave 2 (epoch-sweep): the durable coverage cursor + epoch + frozen reviewer set. When present,
      // runGroupedReview appends each reviewed cell's DONE-key to the ledger (after its findings flush).
      // The SAME frozen reviewerSet + scoped groups + epoch feed the loop's expectedKeys, so the done-key
      // is byte-identical to the expected key (the Wave 2 invariant). runAuditReview ignores it.
      sweep: reviewSweep ? { cursor: reviewSweep.cursor, epochHash: reviewSweep.epochHash, reviewerSet: reviewSweep.reviewerSet } : undefined,
      // RESERVE the pass's NON-CELL agent calls before capping the cells, so a grouped pass's TOTAL spend
      // stays within its per-pass budget (council Codex/Claude P2 + A1 wiring):
      //   - the completeness critic is 1 call when enabled;
      //   - ADVERSARIAL REFUTATION (A1: the grouped path now refutes, like the per-file path) is up to
      //     verifyMaxCalls paid calls, all charged into coverage.budgetSpent. Without this reserve a pass
      //     could dispatch `budget` cells and THEN spend up to 24 more on refutation — over-running the
      //     per-pass allowance and under-reporting nothing, but blowing the loop's pacing.
      // The reserve is CLAMPED so it can never starve the cells below one whole pass of work.
      maxCells: options.lensGroups
        ? Math.max(1, Math.min(options.maxCells ?? Infinity, Math.floor(budget) - groupedReserve(options, budget)))
        : options.maxCells,
      // M8: opt-in completeness critic. Only meaningful on the grouped path (runGroupedReview reads it);
      // runAuditReview ignores it. Its (charged, reserved) verdict gates the dry streak.
      completenessCritic: options.completenessCritic,
      // A1: bound the refutation fan-out to what this pass actually reserved for it.
      verifyMaxCalls: verifyReserve(options, budget)
    });
    // Surface a top-level `ran` the loop can trust. runAuditReview swallows backend
    // failures (rate-limit / unreachable / undispatched) into 0 findings WITHOUT throwing,
    // so the loop must distinguish "reviewed, found nothing" (dry — real) from "couldn't
    // review". Key on unitsSELECTED, not unitsAttempted: if units were selected (there WAS
    // work) but none produced a review — whether they failed OR were never dispatched (no
    // reachable reviewer, budget-starved) — that is NOT convergence → ran:false. Only a
    // genuinely empty scope (0 selected) stays ran:true.
    // Assign the canonical LENS to each finding. The one-shot `audit` path does this via
    // normalizeFindings; the loop path did NOT — so downstream tierOfLens(f.lens) saw
    // undefined and dropped EVERY loop finding into the Quality tier (id 3), silently
    // disabling structure-first --per-tier staging. Normalizing here repairs tier gating.
    // BUT normalizeFindings canonicalizes to {location:{path,startLine}} and DROPS the top-level
    // file/line + refuter flags. runAuditFix keys on f.file (ineligibleReason "no target file") and
    // the gate treats f.refuted as propose-only — so without re-attaching them the loop rejected
    // EVERY finding and never auto-fixed anything (council P0, empirically confirmed). Re-attach the
    // operational fields onto the canonical shape (normalizeFindings is a pure 1:1 map, so index i
    // aligns with the raw finding). file/line come from the canonical location (index-independent).
    const rawFindings = rev?.findings ?? [];
    const findings = normalizeFindings(rawFindings, {}).map((nf, i) => ({
      ...nf,
      file: nf.location?.path ?? rawFindings[i]?.file,
      line: nf.location?.startLine ?? rawFindings[i]?.line,
      verified: rawFindings[i]?.verified,
      refuted: rawFindings[i]?.refuted,
      agents: rawFindings[i]?.agents ?? nf.agents
    }));
    const cov = rev?.coverage ?? {};
    // Advance the full-scope window cursor ONLY after a full-scope pass that did NOT quiesce — a mid-pass
    // quiesce must leave the offset put so the --resume re-reviews the SAME band from its durable cursor.
    if (fullScopePass && !cov.quiesced) fullPasses += 1;
    // Capture THIS pass's flagged gaps for the NEXT call (replaces, not accumulates — a gap that
    // got resolved this pass naturally drops off coverage.completenessGaps and stops being scoped).
    pendingGapFiles = gapFileIds(cov.completenessGaps, knownFileIds);
    const selected = cov.unitsSelected ?? 0;
    const reviewed = cov.unitsReviewed ?? 0;
    // ran:false must not DISCARD real findings (council Codex C2 P2): on a budget-starved pass where no
    // unit could be dispatched but the reserved global SSOT reduce still ran and produced a structural
    // finding, keying ran solely on unitsReviewed dropped that finding before it was ever gated. A pass
    // that yielded ANY finding (from a unit OR the reduce) DID run — surface it; only a genuinely empty
    // undispatched pass (selected>0, reviewed=0, no findings) is the "couldn't review" stop.
    return { ...rev, findings, ran: reviewed > 0 || selected === 0 || findings.length > 0 };
  };

  const fix = async (actionable, ctx = {}) =>
    doFix(
      cwd,
      actionable,
      backends,
      {
        // A5: the SAME pin set the review gets. runAuditFix's writer reads claudeModel/claudeEffort and
        // bounds its spawn by agentTimeoutMs (?? 300_000) — without these the fixer ran on the CLI-default
        // model and the default timeout even when the run was pinned. The codex/grok/openrouter pins ride
        // along for the seats runAuditFix's §6 gate reaches; unset pins stay undefined (CLI defaults).
        ...agentPins,
        // Phase 2: thread the loop's reporter so runAuditFix's live fix counters (fixed/proposed/
        // reverted/committed) + gate state land on the SAME progress.json the review progress does.
        reporter: options.reporter,
        branch: ctx.branch,
        stayOnBranch: ctx.stayOnBranch,
        minSeverity: options.minSeverity ?? "P2",
        maxFixes: options.maxFixesPerPass ?? 10,
        allowUntested: options.allowUntested,
        coverage: options.coverage, // §5 coverage gate (a fix on an unexecuted line -> propose-only)
        // §6: consented council-gated auto-apply. sensitiveAutoApply only takes effect in
        // runAuditFix when a reviewPatch is ALSO injected (both are threaded from the CLI).
        sensitiveAutoApply: options.sensitiveAutoApply,
        // §6 required-seat set must honor the OpenRouter opt-outs (council OpenRouter Claude P2): without
        // these, requiredPatchSeats(backends, options) inside runAuditFix would still REQUIRE a skipped
        // OR seat → its (absent) vote vetoes every patch. Passing them shrinks the required set to match
        // the reviewer's actual participation; the reviewer remains the superset (sound).
        skipOpenRouter: options.skipOpenRouter,
        skipSeats: options.skipSeats,
        // Rate-limit resilience must reach the layer where the 429 is actually thrown
        // (applyFix / reviewPatch) — the loop-level wrapper never sees it because
        // runAuditFix records a per-fix failure instead of throwing.
        retryOnLimit: options.retryOnLimit,
        // Pin the ledger's baseBranch to the loop's TRUE base (not git.currentBranch(), which on a
        // continuation pass is the integration branch → false durable promotion; council Opus O7).
        ledgerBaseBranch: options.ledgerBaseBranch
      },
      {
        ...(options.reviewPatch ? { reviewPatch: options.reviewPatch } : {}),
        // §5 char-test gate (opt-in) threaded to runAuditFix's deps so a refactor must keep its
        // characterization test green across the change; null/absent → the gate is skipped.
        ...(options.charTestGate ? { charTestGate: options.charTestGate } : {})
      }
    );

  // Blast radius (§7): re-scope the next pass to the changed files PLUS their real
  // dependents (importers, from the graph) and dup-cluster peers (editing B can flip A's
  // duplicate status). If that set is a large fraction of the repo (a hub), fall back to a
  // full re-scope — cheaper + more honest than a huge scoped list.
  const expandScope = (changed) => {
    const set = new Set(changed);
    for (const c of changed) {
      for (const imp of importersOf[c] ?? []) set.add(imp);
      for (const peer of dupPeers.get(c) ?? []) set.add(peer);
    }
    if (set.size > Math.max(hubFanIn, Math.ceil(nonTestCount * 0.5))) return [];
    return [...set];
  };

  const verdictsFor = () => options.verdictMap ?? {};

  // The full-scope window cursor (fullPasses) lives in this closure but must SURVIVE a --resume: it
  // drives the progressive unitOffset, so a resumed run that reset it to 0 would re-review the first
  // window and never reach later units (council Codex C2 P1). Expose it so runFixLoop persists it in
  // the checkpoint and restores it here on resume.
  const windowState = { get: () => fullPasses, set: (n) => { fullPasses = Math.max(0, Math.floor(Number(n) || 0)); } };

  // WAVE 2: `sweep` (null unless --epoch-sweep on the grouped path) carries the durable coverage
  // machinery runFixLoop drives — the frozen reviewer set, the epoch fingerprint, the on-disk ledger
  // cursor, the file universe, and the disk-backed manifest builders. null ⇒ the loop runs legacy.
  return { review, fix, expandScope, verdictsFor, windowState, sweep };
}
