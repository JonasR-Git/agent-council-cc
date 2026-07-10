// Stable, VERSIONED semantic finding identity (docs/audit-schema.md §6, blocker 5).
// The legacy ledger fingerprint (file + line/50-bucket + sorted title tokens) drifts
// across bucket boundaries (false "new") and collides distinct findings (false drop),
// so it is unsafe as a baseline/gate key. This identity is driven by (file, lens,
// ruleId, code anchor) — stable across line moves, distinguishing across rules — and
// only falls back to a title hash when no better anchor exists.

import { hashLite } from "./util.mjs";

export const FINGERPRINT_VERSION = 1;

const posix = (p) =>
  String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim()
    .toLowerCase();

// Prefer a stable code anchor over the volatile line number. A reworded title only
// drifts the identity when NO anchor/symbol/snippet is available (documented tradeoff).
function anchorPart(f) {
  if (f.anchor != null && String(f.anchor).trim()) return `a:${String(f.anchor).trim().toLowerCase()}`;
  if (f.symbol != null && String(f.symbol).trim()) return `y:${String(f.symbol).trim().toLowerCase()}`;
  if (f.snippetHash != null && String(f.snippetHash).trim()) return `s:${String(f.snippetHash).trim().toLowerCase()}`;
  const t = String(f.title ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return `t:h${hashLite(t)}`;
}

/** Versioned semantic fingerprint: fp<V>|file|lens|ruleId|anchor. Deterministic. */
export function semanticFingerprint(f = {}) {
  const file = posix(f.file);
  const lens = String(f.lens ?? f.category ?? "other").toLowerCase().trim();
  const rule = String(f.ruleId ?? f.category ?? "other").toLowerCase().trim();
  return `fp${FINGERPRINT_VERSION}|${file}|${lens}|${rule}|${anchorPart(f)}`;
}

/** True for a versioned (fp<N>|...) fingerprint — lets a reader dual-read old vs new. */
export function isVersioned(fp) {
  return /^fp\d+\|/.test(String(fp ?? ""));
}
