// M6 — the multi-file structure fixer (the crux; docs/enterprise-fix-design.md §9, M6).
// A consolidation (move a symbol into a survivor + rewrite its importers) inherently
// touches N files, so the single-file enforceTouched can't gate it. This does, safely:
//   1. a transform PLAN is computed FIRST — the explicit set of files the transform is
//      allowed to touch (survivor + victims + importers);
//   2. planned-touched-set enforcement — the ACTUAL touched set must EQUAL the planned set
//      (an unplanned file OR a missing planned file reverts the whole transform); no
//      unplanned edits, no half-done plan;
//   3. the gates run on the WHOLE transform as one atomic unit — the UNION export surface
//      across the touched files must be preserved (a moved symbol leaves the victim and
//      appears in the survivor, so the union is unchanged; a genuine DROP reverts), plus
//      char-test acceptance + full suite + coverage;
//   4. one commit per transform, full rollback on any gate red; top-autonomy only.
// Pure control flow; every side effect (the multi-file write, git, tests, coverage,
// char-test) is injectable, so the plan/enforcement/rollback logic is testable without a
// repo or an agent. This lib NEVER auto-merges and is only reached at the top autonomy
// level.

import { toPosix } from "./audit-fix.mjs";
import { exportSnapshot } from "./audit-snapshot.mjs";
import { coverageOfLines } from "./audit-coverage-ingest.mjs";

/** The set of files a transform is allowed to touch (survivor + victims + importers). */
export function planTouchedSet(transform = {}) {
  const files = [transform.survivor, ...(transform.victims ?? []), ...(transform.importers ?? [])].filter(Boolean).map(toPosix);
  return [...new Set(files)].sort();
}

/**
 * Enforce that the ACTUAL touched set equals the PLANNED set. Returns { ok, missing,
 * extra }: `extra` = files touched but NOT planned (unplanned edits — the dangerous
 * direction), `missing` = planned but NOT touched (an incomplete transform). Both revert
 * by default; a plan is a contract.
 */
export function enforcePlannedTouched(changedFiles = [], plannedSet = []) {
  const changed = new Set(changedFiles.map(toPosix));
  const planned = new Set(plannedSet.map(toPosix));
  const missing = [...planned].filter((f) => !changed.has(f));
  const extra = [...changed].filter((f) => !planned.has(f));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

/** Union export surface (names + default) across a { file: source } map. */
export function unionSurface(sourcesByFile = {}) {
  const names = new Set();
  let hasDefault = false;
  let opaque = false;
  for (const src of Object.values(sourcesByFile)) {
    const s = exportSnapshot(src);
    for (const n of s.names) names.add(n);
    hasDefault = hasDefault || s.hasDefault;
    opaque = opaque || s.opaque;
  }
  return { names: [...names].sort(), hasDefault, opaque };
}

/**
 * A structure transform must PRESERVE the union export surface: a moved symbol leaves the
 * victim and reappears in the survivor, so the union is unchanged; a genuine DROP (a name
 * gone from ALL touched files, or the default export lost) is a violation. Additions are
 * allowed (the survivor grows). Fails closed on an un-enumerable surface. Returns a reason
 * string or null.
 */
export function unionSurfaceViolation(beforeByFile, afterByFile) {
  const b = unionSurface(beforeByFile);
  const a = unionSurface(afterByFile);
  if (b.opaque || a.opaque) return "union export surface unverifiable (star re-export / whole-module CommonJS) — fail-closed";
  const removed = b.names.filter((n) => !a.names.includes(n));
  if (removed.length) return `consolidation dropped exported name(s): ${removed.join(", ")}`;
  if (b.hasDefault && !a.hasDefault) return "consolidation dropped the default export";
  return null;
}

/**
 * Orchestrate one atomic multi-file transform. Returns { ok, committed, reason }.
 * deps: { git: { head, changedFiles, resetHard, commitFiles(files,msg) },
 *         readFiles(files)->{file:source}, applyTransform(transform)->void,
 *         runTests()->{ok}, acceptCharTest?()->{accept,reason},
 *         coverage?: Map, diffLines?(file, ref)->number[] }.
 */
async function runOneTransform(transform, deps, options) {
  const planned = planTouchedSet(transform);
  if (planned.length < 2) return { ok: false, reason: "not a multi-file transform (planned set < 2)" };

  const snapshot = deps.git.head();
  const before = deps.readFiles(planned);
  try {
    await deps.applyTransform(transform);
  } catch (err) {
    try {
      deps.git.resetHard(snapshot);
    } catch {
      /* best effort */
    }
    return { ok: false, reason: `transform write failed: ${String(err?.message ?? err)}` };
  }

  const revert = (reason) => {
    try {
      deps.git.resetHard(snapshot);
    } catch {
      /* best effort */
    }
    return { ok: false, reason };
  };

  // 2. planned-touched-set enforcement (no unplanned edits, no half-done plan).
  const guard = enforcePlannedTouched(deps.git.changedFiles(), planned);
  if (!guard.ok) return revert(`touched set != planned set (extra: ${guard.extra.join(", ") || "-"}; missing: ${guard.missing.join(", ") || "-"})`);

  const after = deps.readFiles(planned);
  // 3a. union export surface preserved (a move is fine; a drop is not).
  const surf = unionSurfaceViolation(before, after);
  if (surf) return revert(surf);

  // 3b. characterization test (if the transform touched thinly-covered code).
  if (typeof deps.acceptCharTest === "function") {
    const ct = await deps.acceptCharTest(transform);
    if (!ct?.accept) return revert(`characterization test not accepted: ${ct?.reason ?? "unknown"}`);
  }

  // 3c. coverage: every changed line across the touched files must be executed.
  if (options.coverage && typeof deps.diffLines === "function") {
    for (const file of planned) {
      const lines = deps.diffLines(file, snapshot);
      if (lines.length && !coverageOfLines(options.coverage, file, lines).allCovered) {
        return revert(`changed lines in ${file} not executed by any test — consolidation stays propose-only`);
      }
    }
  }

  // 3d. full suite green as one unit.
  const t = await deps.runTests();
  if (!t?.ok) return revert("full suite went red after the transform");

  // 4. one commit for the whole transform.
  const commit = deps.git.commitFiles(planned, `audit-multifix: ${transform.title ?? "consolidation"} (${planned.length} files)`);
  return { ok: true, committed: commit, planned };
}

/**
 * Apply a list of structure transforms, each atomic + independently reverted. Never
 * throws for one failed transform. Top-autonomy only (the caller gates on that).
 */
export async function runMultiFix(cwd, transforms = [], backends = {}, options = {}, deps = {}) {
  if (!deps.git || typeof deps.applyTransform !== "function" || typeof deps.readFiles !== "function" || typeof deps.runTests !== "function") {
    return { ok: false, error: "runMultiFix requires deps.git + applyTransform + readFiles + runTests" };
  }
  if (!deps.git.isRepo?.() && deps.git.isRepo) return { ok: false, error: "not a git repository" };
  if (deps.git.isClean && !deps.git.isClean()) return { ok: false, error: "working tree not clean" };

  const applied = [];
  const rejected = [];
  for (const transform of transforms) {
    let res;
    try {
      res = await runOneTransform(transform, deps, options);
    } catch (err) {
      res = { ok: false, reason: `transform error: ${String(err?.message ?? err)}` };
    }
    if (res.ok) applied.push({ transform, commit: res.committed, files: res.planned });
    else rejected.push({ transform, reason: res.reason });
  }
  return { ok: true, applied, rejected };
}
