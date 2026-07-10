import path from "node:path";

// Zero-dep ESM import/export extraction + module graph. Regex-based, so it is a
// CANDIDATE signal, not authority: dynamic import(), re-exports through aliases,
// string-built specifiers and non-ESM consumers are invisible. Callers must treat
// graph findings (cycles, dead exports) as low-confidence until agent-verified,
// and must NEVER delete from them automatically.

// Anchor at a statement boundary: line start or after `;` (handles `import "x";
// export const a=1;` on one line). Regex-based, so still best-effort.
const FROM_IMPORT = /(?:^|[\n;])\s*import\b[^;\n]*?\bfrom\s*["']([^"']+)["']/g;
// Side-effect import: `import "x"` - a quote directly after `import` (a from-import
// has an identifier/brace there, so this never matches those).
const SIDE_EFFECT_IMPORT = /(?:^|[\n;])\s*import\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const EXPORT_FROM = /(?:^|[\n;])\s*export\b[^;\n]*?\bfrom\s*["']([^"']+)["']/g;
const NAMED_DECL_EXPORT = /(?:^|[\n;])\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g;
const EXPORT_LIST = /(?:^|[\n;])\s*export\s*\{([^}]*)\}/g;
const DEFAULT_EXPORT = /(?:^|[\n;])\s*export\s+default\b/;

function matchAll(re, text) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m);
  return out;
}

/** Extract raw import specifiers and exported names from one file's source. */
export function parseModule(text) {
  const src = String(text ?? "");
  const imports = new Set();
  const dynamic = new Set();
  for (const m of matchAll(FROM_IMPORT, src)) imports.add(m[1]);
  for (const m of matchAll(EXPORT_FROM, src)) imports.add(m[1]); // re-export pulls a dep
  for (const m of matchAll(SIDE_EFFECT_IMPORT, src)) imports.add(m[1]);
  for (const m of matchAll(DYNAMIC_IMPORT, src)) dynamic.add(m[1]);

  const exports = new Set();
  for (const m of matchAll(NAMED_DECL_EXPORT, src)) exports.add(m[1]);
  for (const m of matchAll(EXPORT_LIST, src)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name && name !== "default") exports.add(name);
    }
  }
  const hasDefault = DEFAULT_EXPORT.test(src);
  const hasStarReexport = /(?:^|\n)\s*export\s*\*/.test(src);
  return { imports: [...imports], dynamic: [...dynamic], exports: [...exports], hasDefault, hasStarReexport };
}

/** Resolve a relative import specifier to a repo file id (posix), or null if external. */
export function resolveImport(fromFile, spec, fileSet) {
  if (!spec.startsWith(".")) return null; // bare/builtin -> external
  const dir = path.posix.dirname(fromFile);
  const base = path.posix.normalize(path.posix.join(dir, spec));
  const candidates = [base, `${base}.mjs`, `${base}.js`, `${base}/index.mjs`, `${base}/index.js`];
  for (const c of candidates) if (fileSet.has(c)) return c;
  return null;
}

/**
 * Build the module graph. `files` = [{ id (posix rel path), text }]. Returns
 * per-file import edges (resolved), a reverse index (importedBy), and a flag for
 * modules whose exports cannot be reasoned about (star re-export / dynamic).
 */
export function buildGraph(files) {
  const fileSet = new Set(files.map((f) => f.id));
  const nodes = new Map();
  for (const f of files) {
    const parsed = parseModule(f.text);
    nodes.set(f.id, {
      id: f.id,
      exports: new Set(parsed.exports),
      hasDefault: parsed.hasDefault,
      opaque: parsed.hasStarReexport || parsed.dynamic.length > 0,
      out: new Set(),
      in: new Set()
    });
  }
  for (const f of files) {
    const parsed = parseModule(f.text);
    for (const spec of [...parsed.imports, ...parsed.dynamic]) {
      const target = resolveImport(f.id, spec, fileSet);
      if (target && target !== f.id) {
        nodes.get(f.id).out.add(target);
        nodes.get(target).in.add(f.id);
      }
    }
  }
  return nodes;
}

/** Tarjan strongly-connected components; returns cycles (components with >1 node). */
export function findCycles(nodes) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const idx = new Map();
  const low = new Map();
  const cycles = [];

  function strongconnect(v) {
    idx.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of nodes.get(v).out) {
      if (!idx.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), idx.get(w)));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) cycles.push(comp.sort());
    }
  }

  for (const v of nodes.keys()) if (!idx.has(v)) strongconnect(v);
  return cycles.sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * Exported names that no other module in the set imports. LOW-CONFIDENCE: entry
 * points, package `exports`, framework hooks and any external/dynamic consumer are
 * invisible here, so these are candidates for review, never for deletion.
 */
export function findDeadExports(nodes, files) {
  // Collect every imported name across the graph (best-effort: we only know the
  // specifier, not which names, so we treat "imported at all" as "reachable").
  const importedModules = new Set();
  for (const n of nodes.values()) for (const t of n.out) importedModules.add(t);
  const dead = [];
  for (const n of nodes.values()) {
    if (n.opaque) continue; // can't reason about star/dynamic modules
    const reachable = importedModules.has(n.id);
    if (!reachable && (n.exports.size > 0 || n.hasDefault)) {
      dead.push({ id: n.id, exports: [...n.exports], hasDefault: n.hasDefault });
    }
  }
  return dead.sort((a, b) => a.id.localeCompare(b.id));
}
