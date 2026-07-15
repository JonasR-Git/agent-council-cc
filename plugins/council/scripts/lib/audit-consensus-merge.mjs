// Semantic consensus + dedup pass — "does this bug already exist, and do multiple models mean the same one?"
//
// The lexical merge (findings.mjs fuzzyMatch) only fuses findings that share a file AND a near line AND a
// similar title. Two seats that describe the SAME underlying issue in DIFFERENT words (different line
// anchor, different phrasing) stay single-seat — so the fix consensus gate (audit-fix.mjs) never fires and
// the same issue is offered to the fixer twice. This pass asks a seat (Grok — the most budget-free of the
// three) whether same-file single-seat findings from DIFFERENT seats are the SAME issue, then UNIONS their
// seats (→ consensus, since consensus derives from the ≥2-seat union, audit-normalize.seatCount) and drops
// the duplicates.
//
// SAFETY (the Council's recurring warning is FABRICATED consensus, so every guard is conservative):
//   - SAME FILE ONLY. No cross-file clustering — a cross-file "same issue" is a cross-cutting design finding,
//     not a single-file dedup, and merging across files could fuse two genuinely distinct bugs.
//   - A cluster upgrades to CONSENSUS only when the merged seat union spans ≥2 DISTINCT seats. A cluster
//     that is one seat repeating itself is a pure DEDUP (drop the duplicate) but never a consensus vote.
//   - Grok's indices are validated against the candidate set; out-of-range / duplicate / <2-member clusters
//     are dropped. A finding may join at most ONE cluster (first wins) so a hallucinated overlap can't
//     cascade.
//   - FAIL-SOFT: a Grok error / timeout / unparseable reply leaves every finding exactly as-is. The pass is
//     an ENRICHMENT, never a gate — it can only ADD consensus + remove exact re-offers, never drop evidence.

import { extractJsonObject } from "./findings.mjs";
import { seatsOf } from "./audit-normalize.mjs";

const SEVERITY_RANK = { P0: 0, P1: 1, P2: 2, nit: 3 };
const sevRank = (f) => SEVERITY_RANK[f?.severity] ?? 2;
const fileOf = (f) => String(f?.file ?? f?.location?.path ?? "").replace(/\\/g, "/");
const lineOf = (f) => Number(f?.line ?? f?.location?.startLine) || null;

/**
 * Select the findings worth asking Grok about: per file, the SINGLE-SEAT findings (a finding already
 * agreed by ≥2 seats needs no upgrade) — but only for files where those single-seat findings span ≥2
 * DISTINCT seats (else there is no cross-seat consensus to discover, and same-seat dedup is low value).
 * Returns `[{ file, items: [{ index, finding, seats }] }]` where `index` is the finding's position in the
 * ORIGINAL list (stable id for the prompt + apply step). `maxPerFile` bounds the prompt size per file.
 * PURE.
 */
export function consensusCandidates(findings, { maxPerFile = 12 } = {}) {
  const byFile = new Map();
  (Array.isArray(findings) ? findings : []).forEach((finding, index) => {
    const seats = seatsOf(finding);
    if (seats.length >= 2) return; // already consensus — nothing to discover
    const file = fileOf(finding);
    if (!file) return; // an unlocated finding has no single-file dedup basis
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push({ index, finding, seats });
  });
  const groups = [];
  for (const [file, items] of byFile) {
    const distinctSeats = new Set(items.flatMap((it) => it.seats));
    // Need ≥2 items AND ≥2 distinct seats across them — otherwise no cross-seat consensus is possible.
    if (items.length < 2 || distinctSeats.size < 2) continue;
    // Worst-first, then by line, so a bounded prompt keeps the most important candidates.
    const ranked = items.slice().sort((a, b) => sevRank(a.finding) - sevRank(b.finding) || (lineOf(a.finding) ?? 1e9) - (lineOf(b.finding) ?? 1e9));
    groups.push({ file, items: ranked.slice(0, maxPerFile) });
  }
  return groups;
}

/**
 * Build the Grok prompt from the candidate file-groups. Each finding gets its ORIGINAL-list index as its
 * stable id. Grok must return `{ "clusters": [[index, index, ...], ...] }` — only indices that describe
 * the SAME underlying issue, only within one file, only when confident. PURE.
 */
export function buildConsensusPrompt(groups) {
  const blocks = groups.map(({ file, items }) => {
    const lines = items.map(({ index, finding, seats }) => {
      const loc = lineOf(finding) ? `:${lineOf(finding)}` : "";
      const detail = String(finding.detail ?? finding.failureScenario ?? "").replace(/\s+/g, " ").slice(0, 240);
      return `  [${index}] (seat: ${seats.join("+") || "?"}${loc}) ${String(finding.title ?? "").slice(0, 160)}${detail ? ` — ${detail}` : ""}`;
    });
    return `FILE ${file}\n${lines.join("\n")}`;
  });
  return [
    "You are de-duplicating code-review findings. Below are findings grouped by file, each with a numeric [index].",
    "Some may describe the SAME underlying issue reported by different reviewers in different words or at slightly",
    "different lines. Your job: cluster the indices that are the SAME root issue.",
    "",
    "STRICT RULES:",
    "- Only cluster findings from the SAME file (they are already grouped by file below).",
    "- Only cluster when you are confident it is genuinely the same underlying defect — not merely the same",
    "  topic, function, or category. When unsure, do NOT cluster.",
    "- A cluster must contain at least 2 indices. A finding may appear in at most one cluster.",
    "- Prefer clustering findings raised by DIFFERENT reviewers (different seat) — that is the signal that",
    "  multiple models independently mean the same bug.",
    "",
    "Reply with ONLY a JSON object, no prose:",
    '{ "clusters": [[1, 4], [7, 9, 12]] }',
    "An empty result is { \"clusters\": [] }.",
    "",
    blocks.join("\n\n")
  ].join("\n");
}

/**
 * Parse Grok's reply into validated clusters. Keeps only clusters that are arrays of ≥2 DISTINCT indices,
 * all present in `validIndices`. A finding may join only one cluster (first cluster claiming it wins). PURE.
 */
export function parseConsensusClusters(text, validIndices) {
  const obj = extractJsonObject(typeof text === "string" ? text : "");
  const raw = Array.isArray(obj?.clusters) ? obj.clusters : [];
  const valid = validIndices instanceof Set ? validIndices : new Set(validIndices ?? []);
  const claimed = new Set();
  const clusters = [];
  for (const c of raw) {
    if (!Array.isArray(c)) continue;
    const members = [...new Set(c.map((n) => Number(n)).filter((n) => Number.isInteger(n) && valid.has(n) && !claimed.has(n)))];
    if (members.length < 2) continue;
    members.forEach((m) => claimed.add(m));
    clusters.push(members);
  }
  return clusters;
}

/**
 * Apply validated clusters to the finding list. For each cluster: pick the representative (worst severity,
 * then lowest index), UNION every member's seats + ids onto it, and drop the other members. The union's
 * distinct-seat count decides `consensus`: ≥2 seats → "consensus" (a real cross-seat agreement); a
 * same-seat cluster is a pure dedup that keeps the representative's original consensus. Findings in no
 * cluster pass through unchanged and in order. PURE. Returns `{ findings, merges }`.
 */
export function applyConsensusClusters(findings, clusters) {
  const list = Array.isArray(findings) ? findings : [];
  const repOf = new Map(); // index → representative index
  const mergedInto = new Map(); // representative index → { seats:Set, ids:Set, members:[] }
  const dropped = new Set();
  const merges = [];
  for (const cluster of clusters) {
    if (!Array.isArray(cluster) || cluster.length < 2) continue;
    const members = cluster.filter((i) => i >= 0 && i < list.length);
    if (members.length < 2) continue;
    // Representative = worst severity, tie-break lowest index (stable, deterministic).
    const rep = members.slice().sort((a, b) => sevRank(list[a]) - sevRank(list[b]) || a - b)[0];
    const seats = new Set();
    const ids = new Set();
    for (const i of members) {
      seatsOf(list[i]).forEach((s) => seats.add(s));
      (Array.isArray(list[i].ids) ? list[i].ids : [list[i].id].filter((x) => x != null)).forEach((x) => ids.add(String(x)));
      if (i !== rep) {
        dropped.add(i);
        repOf.set(i, rep);
      }
    }
    mergedInto.set(rep, { seats, ids });
    merges.push({ kept: rep, dropped: members.filter((i) => i !== rep), seats: [...seats], crossSeat: seats.size >= 2 });
  }
  const out = [];
  list.forEach((finding, index) => {
    if (dropped.has(index)) return;
    const merged = mergedInto.get(index);
    if (!merged) {
      out.push(finding);
      return;
    }
    const seats = [...merged.seats];
    out.push({
      ...finding,
      seats,
      ids: [...merged.ids],
      // A ≥2-seat union is genuine independent agreement → consensus. A same-seat dedup keeps whatever the
      // representative already was (never fabricates consensus from one seat repeating itself).
      ...(seats.length >= 2 ? { consensus: "consensus" } : {})
    });
  });
  return { findings: out, merges };
}

/**
 * Orchestrate the pass: select candidates → ask Grok → parse → apply. FAIL-SOFT — any error or empty result
 * returns the input findings unchanged (with `merged: 0`). `grok` is `(prompt) => Promise<{ stdout }>` (a
 * runGrokStructured-shaped result) or a plain string; injected so the loop can wire the real seat and tests
 * can stub it. `log` is an optional progress sink.
 */
export async function runConsensusMerge(findings, { grok, log = () => {}, maxPerFile = 12 } = {}) {
  const list = Array.isArray(findings) ? findings : [];
  if (typeof grok !== "function" || list.length < 2) return { findings: list, merged: 0, merges: [] };
  const groups = consensusCandidates(list, { maxPerFile });
  if (!groups.length) return { findings: list, merged: 0, merges: [] };
  const validIndices = new Set(groups.flatMap((g) => g.items.map((it) => it.index)));
  let text = "";
  try {
    const res = await grok(buildConsensusPrompt(groups));
    text = typeof res === "string" ? res : String(res?.stdout ?? "");
  } catch {
    return { findings: list, merged: 0, merges: [] }; // fail-soft: a Grok failure never disturbs the findings
  }
  const clusters = parseConsensusClusters(text, validIndices);
  if (!clusters.length) return { findings: list, merged: 0, merges: [] };
  const { findings: out, merges } = applyConsensusClusters(list, clusters);
  const consensusMerges = merges.filter((m) => m.crossSeat).length;
  const dedupOnly = merges.length - consensusMerges;
  if (merges.length) log(`consensus pass: ${consensusMerges} cross-seat consensus, ${dedupOnly} dedup (${list.length}→${out.length} findings)`);
  return { findings: out, merged: consensusMerges, merges };
}
