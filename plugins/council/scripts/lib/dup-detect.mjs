import { hashLite } from "./util.mjs";

// Deterministic line-level clone detection (a cheap jscpd-style heuristic): hash
// every window of K normalized code lines; a window whose content recurs is
// duplicated. Maximal runs of duplicated windows merge into blocks, blocks with
// identical content form a cluster. Comments/blank lines are dropped so license
// headers don't match. It is a CANDIDATE signal - propose consolidation, never
// auto-merge (identical-length clones are found; a longer clone that overlaps a
// shorter one may be reported as its shared core).

function normalizeLines(text) {
  const out = [];
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t) continue;
    if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t === "*/") continue;
    out.push({ n: i + 1, s: t.replace(/\s+/g, " ") });
  }
  return out;
}

/**
 * @param files [{ id, text }]
 * @param opts { minLines=6 }
 * @returns clusters ranked by lineCount * locations, each
 *   { lineCount, locations:[{ file, startLine, endLine }] }
 */
export function findDuplicateClusters(files, { minLines = 6 } = {}) {
  const K = Math.max(2, minLines);
  const perFile = files.map((f) => ({ id: f.id, norm: normalizeLines(f.text) }));

  // 1. count every K-line window's content across all files, caching each
  //    window's hash so the block-merge pass doesn't re-hash.
  const winCount = new Map();
  const winHash = perFile.map(() => []);
  for (let fi = 0; fi < perFile.length; fi += 1) {
    const norm = perFile[fi].norm;
    for (let i = 0; i + K <= norm.length; i += 1) {
      const content = norm.slice(i, i + K).map((l) => l.s).join("\n");
      const h = hashLite(content);
      winHash[fi][i] = h;
      winCount.set(h, (winCount.get(h) ?? 0) + 1);
    }
  }

  // 2. per file, merge consecutive duplicated windows into maximal blocks
  const blocks = [];
  for (let fi = 0; fi < perFile.length; fi += 1) {
    const norm = perFile[fi].norm;
    const dup = (start) => (winCount.get(winHash[fi][start]) ?? 0) >= 2;
    let i = 0;
    while (i + K <= norm.length) {
      if (!dup(i)) {
        i += 1;
        continue;
      }
      let end = i;
      while (end + 1 + K <= norm.length && dup(end + 1)) end += 1;
      const blockNorm = norm.slice(i, end + K);
      blocks.push({
        file: perFile[fi].id,
        startLine: blockNorm[0].n,
        endLine: blockNorm[blockNorm.length - 1].n,
        lineCount: blockNorm.length,
        content: blockNorm.map((l) => l.s).join("\n") // exact content, not just a hash
      });
      i = end + 1;
    }
  }

  // 3. group blocks by EXACT content (hashLite is a 32-bit digest, so bucketing by
  //    hash alone would false-cluster on collisions). >= 2 distinct locations wins.
  const byContent = new Map();
  for (const b of blocks) {
    if (!byContent.has(b.content)) byContent.set(b.content, []);
    byContent.get(b.content).push(b);
  }
  const clusters = [];
  for (const group of byContent.values()) {
    // distinct locations only (a block can't cluster with itself)
    const seen = new Set();
    const locations = [];
    for (const b of group) {
      const key = `${b.file}:${b.startLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      locations.push({ file: b.file, startLine: b.startLine, endLine: b.endLine });
    }
    if (locations.length >= 2) {
      clusters.push({ lineCount: group[0].lineCount, locations: locations.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine) });
    }
  }
  clusters.sort((a, b) => b.lineCount * b.locations.length - a.lineCount * a.locations.length);
  return clusters;
}
