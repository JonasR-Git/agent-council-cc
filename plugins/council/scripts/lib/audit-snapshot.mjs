// Export/API snapshot gate (docs/enterprise-fix-design.md §4/§5). A LOCALIZED fix
// promises to keep the file's public surface stable; this gate MEASURES that instead
// of trusting the write prompt. Built on the regex import-graph parser plus local
// extraction for TS type-level and CommonJS export forms, so the surface it sees
// covers ESM named/default/re-export, `export type|interface|enum|namespace`, and
// `module.exports`/`exports.x`. Where the surface is genuinely un-enumerable
// (`export *` re-export, or a whole-module CommonJS assignment), it is marked OPAQUE
// and the gate FAILS CLOSED — a fix there is rejected, never reported "no violation".
// Pure: source strings in, verdict out.

import { parseModule } from "./import-graph.mjs";

const TS_TYPE_EXPORT = /(?:^|[\n;])\s*export\s+(?:declare\s+)?(?:abstract\s+)?(?:interface|type|enum|namespace|module)\s+([A-Za-z0-9_$]+)/g;
const CJS_MEMBER = /(?:^|[\n;])\s*(?:module\.)?exports\.([A-Za-z0-9_$]+)\s*=/g; // exports.x = / module.exports.x =
const CJS_OBJECT = /(?:^|[\n;])\s*module\.exports\s*=\s*\{([^}]*)\}/g; // module.exports = { a, b }
const CJS_DEFINE = /Object\.defineProperty\s*\(\s*(?:module\.)?exports\s*,\s*["']([^"']+)["']/g;
// module.exports = <non-object-literal> (a fn/require/class) — surface un-enumerable.
// The positive lookahead pins the FIRST non-whitespace char after `=` so a greedy
// `\s*` can't backtrack onto a space and misfire on an object literal.
const CJS_WHOLE = /(?:^|[\n;])\s*module\.exports\s*=\s*(?=[^\s{])/;

function collect(re, src, into) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(src)) !== null) into.add(m[1]);
}

/**
 * Capture a file's public export surface: the sorted, de-duplicated set of exported
 * names (ESM value + type, re-exported, and CommonJS members), whether a default
 * export exists, and `opaque` — true when the surface cannot be enumerated
 * (`export *` or a whole-module CommonJS export), which the gate treats as fail-closed.
 */
export function exportSnapshot(source) {
  const src = String(source ?? "");
  const p = parseModule(src); // ESM named/list/default/re-export names + hasStarReexport
  const names = new Set(p.exports);
  collect(TS_TYPE_EXPORT, src, names);
  collect(CJS_MEMBER, src, names);
  collect(CJS_DEFINE, src, names);
  CJS_OBJECT.lastIndex = 0;
  let m;
  while ((m = CJS_OBJECT.exec(src)) !== null) {
    for (const part of m[1].split(",")) {
      const key = part.trim().split(":")[0].trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z0-9_$]+$/.test(key)) names.add(key);
    }
  }
  return {
    names: [...names].sort(),
    hasDefault: Boolean(p.hasDefault),
    opaque: Boolean(p.hasStarReexport) || CJS_WHOLE.test(src)
  };
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
 * preserving fix must not — or null if it is provably stable. An OPAQUE surface on
 * either side is a violation (fail-closed): the gate cannot prove stability, so it
 * refuses rather than pass silently. By default ANY change (a removed OR added name,
 * or a default flip) is a violation: the localized fixer's contract is "keep the
 * public API stable". Pass { allowAdditions: true } for the Structure tier, which may
 * add/move exports the graph proves internal.
 */
export function snapshotViolation(beforeSource, afterSource, { allowAdditions = false } = {}) {
  const before = exportSnapshot(beforeSource);
  const after = exportSnapshot(afterSource);
  if (before.opaque || after.opaque) {
    return "export surface unverifiable (star re-export or whole-module CommonJS export) — fail-closed";
  }
  const d = diffSnapshot(before, after);
  const parts = [];
  if (d.removed.length) parts.push(`removed ${d.removed.join(", ")}`);
  if (!allowAdditions && d.added.length) parts.push(`added ${d.added.join(", ")}`);
  if (d.defaultFlipped) parts.push("default export flipped");
  return parts.length ? parts.join("; ") : null;
}
