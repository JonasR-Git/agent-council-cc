import path from "node:path";

// Zero-dep ESM import/export extraction + module graph. Regex-based, so it is a
// CANDIDATE signal, not authority: dynamic import(), computed specifiers and
// non-ESM consumers stay invisible. Callers must treat graph findings as
// low-confidence until agent-verified, and NEVER delete from them automatically.

// Statement-boundary anchored; the from-clause allows newlines so multiline
// named imports (`import {\n a,\n b\n} from "x"`) still produce an edge.
const FROM_IMPORT = /(?:^|[\n;])\s*import\b[\s\S]*?\bfrom\s*["']([^"']+)["']/g;
const SIDE_EFFECT_IMPORT = /(?:^|[\n;])\s*import\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const EXPORT_FROM = /(?:^|[\n;])\s*export\b[\s\S]*?\bfrom\s*["']([^"']+)["']/g;
const NAMED_DECL_EXPORT = /(?:^|[\n;])\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g;
const EXPORT_LIST = /(?:^|[\n;])\s*export\s*\{([^}]*)\}/g;
const DEFAULT_EXPORT = /(?:^|[\n;])\s*export\s+default\b/;
const STAR_EXPORT = /(?:^|[\n;])\s*export\s*\*/;

/** Remove block and line comments so comment text can't create phantom edges. */
export function stripComments(src) {
  return String(src ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_, p) => p); // keep the char before // (avoid eating "://")
}

function matchAll(re, text) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m);
  return out;
}

/** Extract import specifiers and exported names from one file's source. */
export function parseModule(rawText) {
  const src = stripComments(rawText);
  const imports = new Set();
  const dynamic = new Set();
  for (const m of matchAll(FROM_IMPORT, src)) imports.add(m[1]);
  for (const m of matchAll(EXPORT_FROM, src)) imports.add(m[1]);
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
  return {
    imports: [...imports],
    dynamic: [...dynamic],
    exports: [...exports],
    hasDefault: DEFAULT_EXPORT.test(src),
    hasStarReexport: STAR_EXPORT.test(src)
  };
}

/** Resolve a relative import specifier to a repo file id (posix), or null if external. */
export function resolveImport(fromFile, spec, fileSet) {
  if (!spec.startsWith(".")) return null; // bare/builtin -> external
  const dir = path.posix.dirname(fromFile);
  const base = path.posix.normalize(path.posix.join(dir, spec));
  const exts = [".mjs", ".js", ".cjs"];
  const candidates = [base, ...exts.map((e) => `${base}${e}`), ...exts.map((e) => `${base}/index${e}`)];
  for (const c of candidates) if (fileSet.has(c)) return c;
  return null;
}

/**
 * Build the module graph. `files` = [{ id (posix rel path), text }]. Each file is
 * parsed once. Returns per-file resolved edges + reverse index; `opaque` marks
 * modules whose exports can't be reasoned about (star re-export / dynamic).
 */
export function buildGraph(files) {
  const fileSet = new Set(files.map((f) => f.id));
  const nodes = new Map();
  const parsedById = new Map();
  for (const f of files) {
    const parsed = parseModule(f.text);
    parsedById.set(f.id, parsed);
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
    const parsed = parsedById.get(f.id);
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

/**
 * Iterative Tarjan SCC (no recursion, so a deep 3000+-module graph can't blow the
 * native stack). Returns cycles as UNORDERED node sets (the members form a cycle;
 * the listed order is not a guaranteed edge walk).
 */
export function findCycles(nodes) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const onStack = new Set();
  const S = [];
  const cycles = [];

  for (const start of nodes.keys()) {
    if (idx.has(start)) continue;
    const work = [{ v: start, edges: [...nodes.get(start).out], i: 0 }];
    idx.set(start, index);
    low.set(start, index);
    index += 1;
    S.push(start);
    onStack.add(start);

    while (work.length) {
      const frame = work[work.length - 1];
      const v = frame.v;
      if (frame.i < frame.edges.length) {
        const w = frame.edges[frame.i];
        frame.i += 1;
        if (!idx.has(w)) {
          idx.set(w, index);
          low.set(w, index);
          index += 1;
          S.push(w);
          onStack.add(w);
          work.push({ v: w, edges: [...nodes.get(w).out], i: 0 });
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), idx.get(w)));
        }
      } else {
        if (low.get(v) === idx.get(v)) {
          const comp = [];
          let w;
          do {
            w = S.pop();
            onStack.delete(w);
            comp.push(w);
          } while (w !== v);
          if (comp.length > 1) cycles.push(comp.sort());
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1].v;
          low.set(parent, Math.min(low.get(parent), low.get(v)));
        }
      }
    }
  }
  return cycles.sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * ORPHAN modules: modules with exports that NO other module in the set imports.
 * This is module-level only - it does NOT prove individual exported names are
 * unused (a partially-imported module is reachable). Entry points, package
 * exports, dynamic and external consumers are invisible, so these are
 * low-confidence candidates for review, never for deletion. Pass `entrypoints`
 * (a Set of ids) to exclude known CLI/entry modules.
 */
/**
 * Reconstruct a nodes Map (in/out/exports Sets) from the JSON-safe adjacency the codebase
 * model exposes (graph.importers/imports/exports/hasDefault/opaque). Lets downstream (the
 * Tier-0 detector) reuse findOrphanModules et al. without re-parsing the whole tree.
 */
export function nodesFromGraph(graph = {}) {
  const nodes = new Map();
  const ids = new Set([...Object.keys(graph.importers ?? {}), ...Object.keys(graph.imports ?? {}), ...Object.keys(graph.exports ?? {})]);
  for (const id of ids) {
    nodes.set(id, {
      id,
      in: new Set(graph.importers?.[id] ?? []),
      out: new Set(graph.imports?.[id] ?? []),
      exports: new Set(graph.exports?.[id] ?? []),
      hasDefault: Boolean(graph.hasDefault?.[id]),
      opaque: Boolean(graph.opaque?.[id])
    });
  }
  return nodes;
}

export function findOrphanModules(nodes, { entrypoints = new Set() } = {}) {
  const importedModules = new Set();
  for (const n of nodes.values()) for (const t of n.out) importedModules.add(t);
  const orphans = [];
  for (const n of nodes.values()) {
    if (n.opaque || entrypoints.has(n.id)) continue;
    if (!importedModules.has(n.id) && (n.exports.size > 0 || n.hasDefault)) {
      orphans.push({ id: n.id, exports: [...n.exports], hasDefault: n.hasDefault });
    }
  }
  return orphans.sort((a, b) => a.id.localeCompare(b.id));
}
