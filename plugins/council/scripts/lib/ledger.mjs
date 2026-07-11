import path from "node:path";

import { readJsonl, writeJsonlCapped } from "./jsonl.mjs";
import { resolveStateDir, withFileLock } from "./state.mjs";
import { hashLite } from "./util.mjs";

/**
 * A cross-run findings ledger: fingerprints each merged finding so later runs
 * can recognize "already flagged" issues and track fixed/open status.
 */
function ledgerFile(cwd) {
  return path.join(resolveStateDir(cwd), "ledger.jsonl");
}

const MAX_LEDGER_ENTRIES = 5000;

const STOPWORDS = new Set([
  "here", "there", "this", "that", "these", "those", "with", "from", "into",
  "when", "then", "than", "will", "would", "could", "should", "have", "does",
  "your", "their", "which", "while", "only", "also", "just", "such", "some"
]);

export function fingerprintFinding(finding) {
  const file = String(finding.file ?? "")
    .toLowerCase()
    .replace(/\\/g, "/")
    .trim();
  const titleNorm = String(finding.title ?? "").toLowerCase();
  const tokens =
    titleNorm
      .match(/[a-z0-9]+/g)
      ?.filter((t) => t.length >= 4 && !STOPWORDS.has(t))
      .sort()
      .slice(0, 8)
      .join("-") ?? "";
  // Coarse line bucket disambiguates distinct findings in the same file that
  // share a token set; a title-hash fallback prevents an empty token side from
  // collapsing every short-titled finding on a file into one key.
  const bucket = Number.isFinite(Number(finding.line)) ? Math.floor(Number(finding.line) / 50) : "x";
  const key = tokens || `h${hashLite(titleNorm.replace(/\s+/g, " ").trim())}`;
  return `${file}::${bucket}::${key}`;
}

function readLedger(cwd) {
  const map = new Map();
  for (const entry of readJsonl(ledgerFile(cwd))) {
    if (entry.fingerprint) map.set(entry.fingerprint, entry);
  }
  return map;
}

function writeLedger(cwd, map) {
  writeJsonlCapped(ledgerFile(cwd), [...map.values()], MAX_LEDGER_ENTRIES);
}

function ledgerLockPath(cwd) {
  return `${ledgerFile(cwd)}.lock`;
}

/**
 * Merge freshly-computed entries into the on-disk ledger just before writing,
 * so a concurrent finish is not lost. Newer lastSeen / higher timesSeen wins;
 * an explicit non-open status is preserved.
 */
function mergeAndWriteLedger(cwd, map) {
  // Serialize the read-merge-write across processes so two jobs finishing at
  // once can't lose each other's fingerprints.
  withFileLock(ledgerLockPath(cwd), () => {
    const disk = readLedger(cwd);
    for (const [fp, entry] of map) {
      const other = disk.get(fp);
      if (!other) {
        disk.set(fp, entry);
        continue;
      }
      // If the concurrent write resolved the entry (non-open), adopt its status AND its
      // fix provenance so a concurrently-landed resolveLedgerEntry isn't left promotable.
      const adoptOther = other.status !== "open";
      disk.set(fp, {
        ...entry,
        ...(adoptOther ? { resolvedCommit: other.resolvedCommit, branch: other.branch, baseBranch: other.baseBranch, resolvedAt: other.resolvedAt } : {}),
        timesSeen: Math.max(entry.timesSeen ?? 0, other.timesSeen ?? 0),
        consensusSeen: Math.max(entry.consensusSeen ?? 0, other.consensusSeen ?? 0),
        category: entry.category ?? other.category ?? "other",
        firstSeen: [entry.firstSeen, other.firstSeen].filter(Boolean).sort()[0] ?? entry.firstSeen,
        firstJobId: (entry.firstSeen ?? "") <= (other.firstSeen ?? "") ? entry.firstJobId : other.firstJobId,
        lastSeen: (entry.lastSeen ?? "") >= (other.lastSeen ?? "") ? entry.lastSeen : other.lastSeen,
        lastJobId: (entry.lastSeen ?? "") >= (other.lastSeen ?? "") ? entry.lastJobId : other.lastJobId,
        status: adoptOther ? other.status : entry.status
      });
    }
    writeLedger(cwd, disk);
  });
}

/**
 * Annotate merged findings with ledger history (seenBefore, timesSeen, first/last
 * jobId) and update the ledger. Does NOT auto-mark absent findings as fixed:
 * reviews have varying scopes, so absence does not imply resolution. Use
 * resolveLedgerEntry to explicitly set fixed/ignored. Best-effort; never throws.
 */
export function recordAndAnnotate(cwd, jobId, merged, nowIso) {
  try {
    // Read the current ledger, then compute annotations. We re-read again just
    // before writing (below) and merge, so a concurrent finish that landed in
    // between is not clobbered - a lock-free best effort for this local tool.
    const map = readLedger(cwd);
    const annotated = (merged.all ?? []).map((item) => {
      const fingerprint = fingerprintFinding(item);
      const prior = map.get(fingerprint);
      const timesSeen = (prior?.timesSeen ?? 0) + 1;
      // A resolved outcome (fixed/pending-merge/dismissed/ignored) keeps its status;
      // only 'open' entries reopen. 'fixed-pending-merge' is NOT a durable resolution
      // (downstream suppresses only 'fixed'), so the finding keeps re-surfacing until
      // reconcilePendingFixes promotes it to 'fixed' — but its resolution metadata
      // (resolvedCommit/branch) is CARRIED so reconcile can still find the commit.
      const resolved = prior?.status && prior.status !== "open";
      const carry = resolved ? { resolvedCommit: prior.resolvedCommit, branch: prior.branch, baseBranch: prior.baseBranch, resolvedAt: prior.resolvedAt } : {};
      map.set(fingerprint, {
        fingerprint,
        title: item.title,
        file: item.file ?? null,
        category: item.category ?? prior?.category ?? "other",
        severity: item.severity,
        status: resolved ? prior.status : "open",
        ...carry,
        timesSeen,
        consensusSeen: (prior?.consensusSeen ?? 0) + (item.consensus ? 1 : 0),
        firstJobId: prior?.firstJobId ?? jobId,
        firstSeen: prior?.firstSeen ?? nowIso,
        lastJobId: jobId,
        lastSeen: nowIso
      });
      return { ...item, seenBefore: Boolean(prior), timesSeen, ledgerStatus: prior?.status ?? "new" };
    });
    mergeAndWriteLedger(cwd, map);
    const all = annotated;
    return {
      ...merged,
      all,
      consensus: all.filter((m) => m.consensus),
      unique: all.filter((m) => !m.consensus)
    };
  } catch {
    return merged;
  }
}

/**
 * Explicitly set a ledger entry's status (fixed | fixed-pending-merge | ignored | open).
 * `meta` (e.g. { resolvedCommit, branch }) is merged so reconcilePendingFixes can later
 * check whether the fix's commit actually landed on the base branch.
 */
export function resolveLedgerEntry(cwd, fingerprint, status, nowIso, meta = {}) {
  // Under the same lock as recordAndAnnotate so a concurrent finish can't clobber
  // the status we just set (and vice versa).
  return withFileLock(ledgerLockPath(cwd), () => {
    const map = readLedger(cwd);
    const entry = map.get(fingerprint);
    if (!entry) return false;
    // Only 'fixed-pending-merge' carries fix provenance; any other status (ignored /
    // dismissed / open) must NOT keep stale resolvedCommit/branch that would misreport
    // it as "fixed by commit X".
    const cleared = status === "fixed-pending-merge" ? {} : { resolvedCommit: undefined, branch: undefined, baseBranch: undefined };
    map.set(fingerprint, { ...entry, ...cleared, ...meta, status, resolvedAt: nowIso });
    writeLedger(cwd, map);
    return true;
  });
}

/**
 * Reconcile provisional fixes: a fix committed on an isolated branch is recorded
 * 'fixed-pending-merge', not durable 'fixed'. This promotes it to 'fixed' ONLY on a
 * positive merge signal — its commit is an ancestor of the fix's own BASE branch
 * (recorded at resolve time, NOT the current HEAD, so reconciling while checked out on
 * the integration branch during a --resume can't see every pending fix as an ancestor
 * of the tip and wrongly promote it). It NEVER reopens on an unreachable sha:
 * squash/rebase/cherry-pick merges (the common case) leave the original sha
 * un-ancestored and eventually gc'd, so treating unreachability as "discarded" would
 * falsely reopen a shipped fix. An un-promoted pending fix keeps re-surfacing in review
 * anyway, so a genuinely-discarded defect stays visible without a false reopen.
 * `git` is injectable: { isAncestor(sha, ref)->bool, patchIdMerged?(sha, ref)->bool }
 * (the latter promotes squash/rebase/cherry-pick merges by matching the change's patch-id
 * among commits reachable from the base). Returns the count promoted.
 */
export function reconcilePendingFixes(cwd, git) {
  return withFileLock(ledgerLockPath(cwd), () => {
    const map = readLedger(cwd);
    let reconciled = 0;
    for (const [fp, entry] of map) {
      if (entry.status !== "fixed-pending-merge") continue;
      const sha = entry.resolvedCommit;
      if (!sha) continue;
      const base = entry.baseBranch || "HEAD";
      let merged = false;
      try {
        // Ancestor covers merge-commit / fast-forward; the patch-id fallback covers
        // squash / rebase / cherry-pick merges (a new sha, but the same change landed).
        merged = git.isAncestor(sha, base) || (typeof git.patchIdMerged === "function" && git.patchIdMerged(sha, base));
      } catch {
        merged = false;
      }
      if (merged) {
        map.set(fp, { ...entry, status: "fixed" });
        reconciled += 1;
      }
    }
    if (reconciled) writeLedger(cwd, map);
    return reconciled;
  });
}

export function readLedgerEntries(cwd) {
  return [...readLedger(cwd).values()];
}
