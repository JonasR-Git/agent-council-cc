import { readLedgerEntries } from "./ledger.mjs";

/**
 * Cross-run findings overview and per-CATEGORY calibration. Deliberately
 * model-agnostic: it summarizes what was found, how often it recurred, whether
 * it reached consensus, and — from resolved outcomes — how often the council was
 * right per category. Model identity is never an anchor (models get swapped).
 *
 * Outcome semantics (ledger status):
 *   open      - not yet resolved
 *   fixed     - real, was fixed (true positive)
 *   ignored   - real but won't act now (true positive)
 *   dismissed - reviewed, not a real issue (false positive)
 */
const TRUE_POSITIVE = new Set(["fixed", "ignored"]);
const FALSE_POSITIVE = new Set(["dismissed"]);

export function buildOverview(entries) {
  const byCategory = {};
  let consensusTotal = 0;
  let recurringTotal = 0;

  for (const e of entries) {
    const cat = e.category ?? "other";
    const c = (byCategory[cat] = byCategory[cat] ?? {
      total: 0,
      open: 0,
      fixed: 0,
      pendingMerge: 0,
      dismissed: 0,
      ignored: 0,
      recurring: 0,
      everConsensus: 0
    });
    c.total += 1;
    if (e.status === "fixed") c.fixed += 1;
    else if (e.status === "fixed-pending-merge") c.pendingMerge += 1; // committed, not yet merged — not "open"
    else if (e.status === "dismissed") c.dismissed += 1;
    else if (e.status === "ignored") c.ignored += 1;
    else c.open += 1;
    if ((e.timesSeen ?? 1) > 1) {
      c.recurring += 1;
      recurringTotal += 1;
    }
    if ((e.consensusSeen ?? 0) > 0) {
      c.everConsensus += 1;
      consensusTotal += 1;
    }
  }

  const categories = Object.fromEntries(
    Object.entries(byCategory).map(([cat, c]) => {
      const tp = c.fixed + c.ignored;
      const fp = c.dismissed;
      const resolved = tp + fp;
      return [
        cat,
        {
          ...c,
          // Calibration: of RESOLVED findings in this category, the share that
          // turned out real. null until there is resolved data (no false claims).
          calibration: resolved ? Math.round((tp / resolved) * 100) : null,
          resolved
        }
      ];
    })
  );

  return {
    totalFindings: entries.length,
    consensusTotal,
    recurringTotal,
    categories
  };
}

export function topRecurring(entries, limit = 10) {
  return [...entries]
    .filter((e) => (e.timesSeen ?? 1) > 1)
    .sort((a, b) => (b.timesSeen ?? 0) - (a.timesSeen ?? 0))
    .slice(0, limit);
}

export function renderOverview(cwd, { limit = 10 } = {}) {
  const entries = readLedgerEntries(cwd);
  const ov = buildOverview(entries);
  const lines = [
    `Findings overview (${ov.totalFindings} tracked · ${ov.consensusTotal} reached consensus · ${ov.recurringTotal} recurring):`,
    "",
    "Per category (calibration = share of RESOLVED findings that were real):"
  ];
  const rows = Object.entries(ov.categories).sort((a, b) => b[1].total - a[1].total);
  for (const [cat, c] of rows) {
    const cal = c.calibration == null ? "n/a" : `${c.calibration}%`;
    lines.push(
      `  ${cat.padEnd(12)} total=${c.total}  open=${c.open}  fixed=${c.fixed}  dismissed=${c.dismissed}  ignored=${c.ignored}  recurring=${c.recurring}  calibration=${cal} (${c.resolved} resolved)`
    );
  }
  const rec = topRecurring(entries, limit);
  if (rec.length) {
    lines.push("", "Top recurring findings (candidate systemic issues):");
    for (const e of rec) {
      lines.push(`  seen ${String(e.timesSeen).padStart(2)}x  [${e.status}]  ${(e.file ?? "-").slice(0, 36).padEnd(36)}  ${String(e.title ?? "").slice(0, 46)}`);
    }
  }
  lines.push("", "Note: calibration is per finding category, not per model (models are swappable).");
  return { text: lines.join("\n"), overview: ov, recurring: rec };
}
