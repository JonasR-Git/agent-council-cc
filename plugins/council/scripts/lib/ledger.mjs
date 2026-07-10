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
      disk.set(fp, {
        ...entry,
        timesSeen: Math.max(entry.timesSeen ?? 0, other.timesSeen ?? 0),
        consensusSeen: Math.max(entry.consensusSeen ?? 0, other.consensusSeen ?? 0),
        category: entry.category ?? other.category ?? "other",
        firstSeen: [entry.firstSeen, other.firstSeen].filter(Boolean).sort()[0] ?? entry.firstSeen,
        firstJobId: (entry.firstSeen ?? "") <= (other.firstSeen ?? "") ? entry.firstJobId : other.firstJobId,
        lastSeen: (entry.lastSeen ?? "") >= (other.lastSeen ?? "") ? entry.lastSeen : other.lastSeen,
        lastJobId: (entry.lastSeen ?? "") >= (other.lastSeen ?? "") ? entry.lastJobId : other.lastJobId,
        status: other.status !== "open" ? other.status : entry.status
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
      // A resolved outcome (fixed/dismissed/ignored) is durable; only 'open'
      // entries reopen. Category + consensus count are tracked model-agnostically.
      const resolved = prior?.status && prior.status !== "open";
      map.set(fingerprint, {
        fingerprint,
        title: item.title,
        file: item.file ?? null,
        category: item.category ?? prior?.category ?? "other",
        severity: item.severity,
        status: resolved ? prior.status : "open",
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

/** Explicitly set a ledger entry's status (fixed | ignored | open). */
export function resolveLedgerEntry(cwd, fingerprint, status, nowIso) {
  // Under the same lock as recordAndAnnotate so a concurrent finish can't clobber
  // the status we just set (and vice versa).
  return withFileLock(ledgerLockPath(cwd), () => {
    const map = readLedger(cwd);
    const entry = map.get(fingerprint);
    if (!entry) return false;
    map.set(fingerprint, { ...entry, status, resolvedAt: nowIso });
    writeLedger(cwd, map);
    return true;
  });
}

export function readLedgerEntries(cwd) {
  return [...readLedger(cwd).values()];
}
