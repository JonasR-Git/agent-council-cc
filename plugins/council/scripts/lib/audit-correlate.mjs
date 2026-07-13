// D — cheap DETERMINISTIC correlation over the accumulated findings (NO LLM, no semantic merge). It
// clusters findings by STABLE anchors — file × overlapping line span × lens-family, plus cross-file
// dependency edges — so the fix layer can give ONE writer the whole SAME-FILE connected cluster (the
// commit then names every finding id it resolves) while MULTI-FILE / cross-cutting / SSOT clusters
// ESCALATE to proposal instead of being auto-patched into symptom fixes. Original finding ids +
// provenance are preserved throughout. This is intentionally boring and reproducible: same input →
// same clusters, no model call, so it can run every pass between the gate and the fixer for ~free.

import { tierOfLens } from "./audit-tiers.mjs";

const toPosix = (p) => String(p ?? "").replace(/\\/g, "/").trim();

/** A coarse lens FAMILY (the audit tier) — the anchor dimension that decides whether two findings are
 *  "the same kind" of defect for clustering. Falls back to the finding category when no lens. PURE. */
export function lensFamily(finding) {
  const lens = finding?.lens ?? null;
  if (lens != null) return `t${tierOfLens(lens)}`;
  const cat = String(finding?.category ?? "other").toLowerCase();
  if (/ssot|arch|structure|layer|design|dead/.test(cat)) return "t1";
  if (/secur|secret|auth|inject/.test(cat)) return "t2s";
  if (/bug|logic|concurren|data|race|error|correct|perf/.test(cat)) return "t2";
  return "t3";
}

const fileOf = (f) => toPosix(f?.file ?? f?.location?.path);
const lineOf = (f) => {
  const n = Number(f?.line ?? f?.location?.startLine);
  return Number.isFinite(n) ? n : null;
};
const idOf = (f, i) => String(f?.id ?? f?.fingerprint ?? `f${i}`);

/**
 * A finding must ESCALATE (never be auto-fixed as a plain same-file write) when it is inherently
 * cross-cutting: a cross-cutting scope, an explicit propose-only disposition, or an SSOT/architecture
 * lens family (tier 1 — structure). Those are consolidation proposals, not localized patches. PURE.
 */
export function mustEscalate(finding) {
  if (finding?.scope === "cross-cutting") return true;
  if (finding?.fixDisposition === "propose-only") return true;
  if (lensFamily(finding) === "t1") return true; // structure/SSOT/architecture → proposal, never a symptom fix
  return false;
}

/** Do two same-file findings share an ANCHOR (same lens-family AND overlapping/adjacent line span)? A
 *  null line is treated as file-wide within its family so file-level findings still connect. PURE. */
function sameAnchor(a, b, lineWindow) {
  if (lensFamily(a) !== lensFamily(b)) return false;
  const la = lineOf(a);
  const lb = lineOf(b);
  if (la == null || lb == null) return true; // a file-wide finding anchors to any same-family peer
  return Math.abs(la - lb) <= lineWindow;
}

/**
 * Correlate accumulated findings into fix clusters. Returns:
 *   { clusters: [{ file, kind:"same-file", family, findingIds, findings }],   // one writer each
 *     escalated: [{ kind, reason, files, findingIds, findings }] }            // proposal, never auto-fix
 *
 * Rules (deterministic):
 *  - A `mustEscalate` finding (cross-cutting / propose-only / structure-family) never enters a same-file
 *    writer cluster; it is surfaced under `escalated` (reason "cross-cutting").
 *  - CROSS-FILE dependency edge: two DIFFERENT files that (a) each hold a localized finding of the SAME
 *    lens-family AND (b) are connected by an import edge (`importers[a]` names b, or vice-versa) form a
 *    multi-file cluster → escalated (reason "multi-file-dependency"), never auto-fixed. This is the
 *    cheap dependency-hash: a defect that spans a dependency edge is a consolidation, not a symptom fix.
 *  - The remaining localized findings cluster PER FILE (one writer per file, matching audit-fix's
 *    scheduleFixes), connected by the file × span × lens-family anchor; the cluster names every finding
 *    id its single writer resolves. `lineWindow` (default 25) bounds span overlap.
 * PURE over its inputs — `importers` is `{ file: [importerFile,...] }` from the codebase model graph.
 */
export function correlateFindings(findings, { importers = {}, lineWindow = 25 } = {}) {
  const list = (findings ?? []).map((f, i) => ({ f, i, id: idOf(f, i), file: fileOf(f), fam: lensFamily(f) }));

  const escalated = [];
  const escalatedIds = new Set();
  const pushEscalated = (kind, reason, items) => {
    const findings2 = items.map((x) => x.f);
    const findingIds = items.map((x) => x.id);
    for (const id of findingIds) escalatedIds.add(id);
    escalated.push({ kind, reason, files: [...new Set(items.map((x) => x.file).filter(Boolean))], findingIds, findings: findings2 });
  };

  // 1) Inherently cross-cutting findings → escalate (one entry, grouped for a readable proposal).
  const crossCut = list.filter((x) => mustEscalate(x.f));
  if (crossCut.length) pushEscalated("cross-cutting", "cross-cutting", crossCut);

  // 2) Cross-file dependency edges over the LOCALIZED remainder. Build file→family presence, then for
  //    each import edge connecting two DISTINCT files sharing a family, escalate that family's findings
  //    on both files as a multi-file cluster (deterministic over sorted keys).
  const localized = list.filter((x) => !escalatedIds.has(x.id) && x.file);
  const byFileFam = new Map(); // `${file}::${fam}` -> items
  for (const x of localized) {
    const k = `${x.file}::${x.fam}`;
    if (!byFileFam.has(k)) byFileFam.set(k, []);
    byFileFam.get(k).push(x);
  }
  const imp = importers && typeof importers === "object" ? importers : {};
  const edge = (a, b) => (imp[a] ?? []).map(toPosix).includes(b) || (imp[b] ?? []).map(toPosix).includes(a);
  const files = [...new Set(localized.map((x) => x.file))].sort();
  const multiFileHandled = new Set();
  for (let ai = 0; ai < files.length; ai += 1) {
    for (let bi = ai + 1; bi < files.length; bi += 1) {
      const a = files[ai];
      const b = files[bi];
      if (!edge(a, b)) continue;
      const fams = new Set([...byFileFam.keys()].filter((k) => k.startsWith(`${a}::`) || k.startsWith(`${b}::`)).map((k) => k.split("::")[1]));
      for (const fam of [...fams].sort()) {
        const ka = `${a}::${fam}`;
        const kb = `${b}::${fam}`;
        if (!byFileFam.has(ka) || !byFileFam.has(kb)) continue; // the family must be present on BOTH sides of the edge
        const items = [...byFileFam.get(ka), ...byFileFam.get(kb)];
        const fresh = items.filter((x) => !escalatedIds.has(x.id));
        if (!fresh.length) continue;
        pushEscalated("multi-file", "multi-file-dependency", fresh);
        multiFileHandled.add(ka);
        multiFileHandled.add(kb);
      }
    }
  }

  // 3) The localized remainder clusters per file via the span×family anchor; each cluster is one writer.
  const clusters = [];
  const remaining = localized.filter((x) => !escalatedIds.has(x.id));
  const byFile = new Map();
  for (const x of remaining) {
    if (!byFile.has(x.file)) byFile.set(x.file, []);
    byFile.get(x.file).push(x);
  }
  for (const file of [...byFile.keys()].sort()) {
    const items = byFile.get(file);
    // Union-find over same-anchor pairs → connected same-file clusters. One writer per connected cluster;
    // in practice audit-fix already serializes one writer per FILE, so file-level grouping is the floor —
    // the anchor split just records which ids each write resolves for the commit message.
    const parent = items.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        if (sameAnchor(items[i].f, items[j].f, lineWindow)) parent[find(i)] = find(j);
      }
    }
    const groups = new Map();
    for (let i = 0; i < items.length; i += 1) {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(items[i]);
    }
    for (const g of groups.values()) {
      clusters.push({
        file,
        kind: "same-file",
        family: g[0].fam,
        findingIds: g.map((x) => x.id),
        findings: g.map((x) => x.f)
      });
    }
  }

  return { clusters, escalated };
}
