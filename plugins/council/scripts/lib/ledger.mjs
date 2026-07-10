import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "./state.mjs";

/**
 * A cross-run findings ledger: fingerprints each merged finding so later runs
 * can recognize "already flagged" issues and track fixed/open status.
 */
export function ledgerFile(cwd) {
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
  const tokens = String(finding.title ?? "")
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((t) => t.length >= 4 && !STOPWORDS.has(t))
    .sort()
    .slice(0, 8)
    .join("-") ?? "";
  return `${file}::${tokens}`;
}

function readLedger(cwd) {
  const file = ledgerFile(cwd);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return new Map();
  }
  const map = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.fingerprint) map.set(entry.fingerprint, entry);
    } catch {
      /* skip */
    }
  }
  return map;
}

function writeLedger(cwd, map) {
  const file = ledgerFile(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entries = [...map.values()].slice(-MAX_LEDGER_ENTRIES);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""), "utf8");
}

/**
 * Annotate merged findings with ledger history (seenBefore, timesSeen, first/last
 * jobId) and update the ledger. Does NOT auto-mark absent findings as fixed:
 * reviews have varying scopes, so absence does not imply resolution. Use
 * resolveLedgerEntry to explicitly set fixed/ignored. Best-effort; never throws.
 */
export function recordAndAnnotate(cwd, jobId, merged, nowIso) {
  try {
    const map = readLedger(cwd);
    const annotated = (merged.all ?? []).map((item) => {
      const fingerprint = fingerprintFinding(item);
      const prior = map.get(fingerprint);
      const timesSeen = (prior?.timesSeen ?? 0) + 1;
      map.set(fingerprint, {
        fingerprint,
        title: item.title,
        file: item.file ?? null,
        severity: item.severity,
        status: prior?.status === "ignored" ? "ignored" : "open",
        timesSeen,
        firstJobId: prior?.firstJobId ?? jobId,
        firstSeen: prior?.firstSeen ?? nowIso,
        lastJobId: jobId,
        lastSeen: nowIso
      });
      return { ...item, seenBefore: Boolean(prior), timesSeen, ledgerStatus: prior?.status ?? "new" };
    });
    writeLedger(cwd, map);
    return { ...merged, all: annotated };
  } catch {
    return merged;
  }
}

/** Explicitly set a ledger entry's status (fixed | ignored | open). */
export function resolveLedgerEntry(cwd, fingerprint, status, nowIso) {
  const map = readLedger(cwd);
  const entry = map.get(fingerprint);
  if (!entry) return false;
  map.set(fingerprint, { ...entry, status, resolvedAt: nowIso });
  writeLedger(cwd, map);
  return true;
}

export function readLedgerEntries(cwd) {
  return [...readLedger(cwd).values()];
}
