// Export/API snapshot gate (docs/enterprise-fix-design.md §4/§5). A LOCALIZED fix
// promises to keep the file's public surface stable; this gate MEASURES that instead
// of trusting the write prompt. Built on the regex import-graph parser, so it is a
// CANDIDATE signal (dynamic/computed re-exports stay invisible) — but the surface it
// does see is exactly the contract the single-file fixer must not break, and any
// change it detects is a real change. Pure: source strings in, verdict out.

import { parseModule } from "./import-graph.mjs";

/**
 * Capture a file's public export surface: the sorted, de-duplicated set of exported
 * names plus whether a default export exists.
 */
export function exportSnapshot(source) {
  const p = parseModule(source);
  return { names: [...new Set(p.exports)].sort(), hasDefault: Boolean(p.hasDefault) };
}

/** Name/default deltas between two snapshots. */
export function diffSnapshot(before, after) {
  const b = new Set(before.names);
  const a = new Set(after.names);
  return {
    removed: [...b].filter((n) => !a.has(n)),
    added: [...a].filter((n) => !b.has(n)),
    defaultFlipped: before.hasDefault !== after.hasDefault
  };
}

/**
 * Reason string if the export surface changed in a way a LOCALIZED, behavior-
 * preserving fix must not — or null if it is stable. By default ANY change (a removed
 * OR added name, or a default flip) is a violation: the localized fixer's contract is
 * "keep the public API stable". Pass { allowAdditions: true } for the Structure tier,
 * which may add/move exports the graph proves internal.
 */
export function snapshotViolation(beforeSource, afterSource, { allowAdditions = false } = {}) {
  const d = diffSnapshot(exportSnapshot(beforeSource), exportSnapshot(afterSource));
  const parts = [];
  if (d.removed.length) parts.push(`removed ${d.removed.join(", ")}`);
  if (!allowAdditions && d.added.length) parts.push(`added ${d.added.join(", ")}`);
  if (d.defaultFlipped) parts.push("default export flipped");
  return parts.length ? parts.join("; ") : null;
}
