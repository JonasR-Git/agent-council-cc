// Code-impact metric for the fix-loop report — the operator's #1 concern (refactoring / SSOT /
// code-reduction) needs a NUMBER, not just a committed-fix count. Derived from the integration branch's
// `git diff --numstat` vs its base: the ground truth of what the committed fixes did to the tree. A
// structure/consolidation run trends net-NEGATIVE (code removed); a correctness run trends positive.
//
// Split into a PURE parser + counters + line renderer (all unit-tested without a repo) and a thin git
// wrapper (`computeCodeImpact`) that injects the runner, so the only part with logic — the parse — is
// proven, and the report can never show a fabricated 0 (a git failure yields null → "not measured").

import { STRUCTURE_LENSES } from "./structure-gate.mjs";

/**
 * Parse `git diff --numstat` output → { added, removed, files }. Each data row is `<added>\t<removed>\t
 * <path>`; a binary file is `-\t-\t<path>` and counts as a touched file contributing 0 lines. PURE.
 */
export function parseNumstat(stdout) {
  let added = 0;
  let removed = 0;
  let files = 0;
  for (const raw of String(stdout ?? "").split("\n")) {
    const m = raw.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!m) continue;
    files += 1;
    if (m[1] !== "-") added += Number(m[1]);
    if (m[2] !== "-") removed += Number(m[2]);
  }
  return { added, removed, files };
}

/**
 * Count committed fixes that were STRUCTURAL. A fix is structural when it was staged on a structure
 * FIX-lens (architecture_ssot / logical_sense). fixLens wins; the coverage lens is the fallback ONLY
 * when no fixLens was recorded — so a logical_sense finding REATTRIBUTED to correctness (fixLens=
 * correctness) is correctly NOT counted as structure work. PURE.
 */
export function countStructureFixes(fixed) {
  return (fixed ?? []).filter((f) => {
    const fl = f?.finding?.fixLens;
    if (fl) return STRUCTURE_LENSES.includes(fl);
    return STRUCTURE_LENSES.includes(f?.finding?.lens);
  }).length;
}

/**
 * One-line human summary for the fix-loop report. PURE. Returns null when there is nothing to show
 * (no metric was computed), so the caller can skip the line entirely rather than print an empty stat.
 */
export function renderCodeImpactLine(codeImpact) {
  if (!codeImpact) return null;
  const ci = codeImpact;
  const netSigned = `${ci.net >= 0 ? "+" : ""}${ci.net}`;
  const struct = ci.structureFixes ? ` · ${ci.structureFixes} structure/SSOT fix(es)` : "";
  const tag = ci.net < 0 ? " — net code reduction" : "";
  return `Code impact: +${ci.added} / -${ci.removed} lines (net ${netSigned})${struct}${tag}.`;
}

/**
 * Compute the code-impact metric from the integration branch, injecting the command runner (the CLI
 * passes runCommandAsync). Best-effort: returns null when nothing was committed or on ANY git failure
 * — the report then renders "not measured" instead of a fabricated 0. Uses the three-dot `base...branch`
 * range so the diff is exactly the branch's own commits (from the merge-base), never unrelated base drift.
 */
export async function computeCodeImpact(cwd, out, runGit) {
  try {
    if (!out?.branch || !out?.baseBranch || !(out.fixed?.length)) return null;
    const r = await runGit("git", ["diff", "--numstat", `${out.baseBranch}...${out.branch}`], { cwd, timeoutMs: 30_000 });
    if (!r || r.status !== 0) return null;
    const { added, removed, files } = parseNumstat(r.stdout);
    return { added, removed, net: added - removed, files, structureFixes: countStructureFixes(out.fixed) };
  } catch {
    return null;
  }
}
