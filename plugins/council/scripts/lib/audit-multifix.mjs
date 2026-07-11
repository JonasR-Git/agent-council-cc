// M6 — the multi-file structure fixer (the crux; docs/enterprise-fix-design.md §9).
// A consolidation (move a symbol into a survivor + rewrite its importers) touches N
// files, so the single-file enforceTouched can't gate it. This does.
//
// SAFETY DEFAULT (the §9 rule, confirmed by the M6 council): auto-consolidation stays
// PROPOSE-ONLY until a *verified deterministic transform* exists. So runMultiFix EMITS A
// PROPOSAL by default and only COMMITS a transform explicitly marked
// kind === "deterministic-codemod" (a reproducible ast codemod, NOT a free-form LLM edit
// — a shape gate + suite is luck, not proof) that also passes a determinism re-run and
// the full gate stack. The enforcement/surface/rollback harness below is ready for when a
// deterministic codemod planner lands; it is NOT wired into the loop yet (deliberately
// deferred — the highest-risk automation in the system).
//
//   1. planTouchedSet — the transform PLAN (survivor + victims + importers) computed FIRST.
//   2. enforcePlannedTouched — the ACTUAL touched set must EQUAL the plan (extra OR missing
//      reverts), re-checked AGAIN right before the commit (the gates can dirty the tree).
//   3. gates on the WHOLE transform: union export surface preserved (a move is fine; a
//      DROP, a lost default, OR a same-name collision across files reverts; fails closed on
//      an un-enumerable surface) + char-test + coverage + full suite.
//   4. one commit per transform; a revert is VERIFIED (a failed rollback aborts the whole
//      batch rather than silently poisoning the next transform), and the tree is
//      re-asserted clean before every transform.
// Pure control flow; every side effect injectable.

import { toPosix } from "./audit-fix.mjs";
import { exportSnapshot } from "./audit-snapshot.mjs";
import { coverageOfLines } from "./audit-coverage-ingest.mjs";

const DEFAULT_MAX_BLAST = 12;

/** The files a transform is allowed to touch (survivor + victims + importers). */
export function planTouchedSet(transform = {}) {
  const files = [transform.survivor, ...(transform.victims ?? []), ...(transform.importers ?? [])].filter(Boolean).map(toPosix);
  return [...new Set(files)].sort();
}

/** Touched set must EQUAL the plan. { ok, missing, extra } — both directions revert. */
export function enforcePlannedTouched(changedFiles = [], plannedSet = []) {
  const changed = new Set(changedFiles.map(toPosix));
  const planned = new Set(plannedSet.map(toPosix));
  const missing = [...planned].filter((f) => !changed.has(f));
  const extra = [...changed].filter((f) => !planned.has(f));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

/**
 * Union export surface across a { file: source } map, tracking each name's ORIGIN files
 * and the DEFAULT-export count so a collision or a lost default can't hide behind an
 * OR'd boolean / a collapsed name set.
 */
export function unionSurface(sourcesByFile = {}) {
  const byName = new Map();
  let defaultCount = 0;
  let opaque = false;
  for (const [file, src] of Object.entries(sourcesByFile)) {
    const s = exportSnapshot(src);
    for (const n of s.names) {
      if (!byName.has(n)) byName.set(n, new Set());
      byName.get(n).add(file);
    }
    if (s.hasDefault) defaultCount += 1;
    opaque = opaque || s.opaque;
  }
  return { names: [...byName.keys()].sort(), byName, defaultCount, opaque };
}

/**
 * A structure transform must PRESERVE the union surface: a moved symbol leaves the victim
 * and reappears in the survivor (union unchanged). Violations: an un-enumerable surface;
 * a name exported by >1 touched file BEFORE the merge (two different symbols under one
 * name — the merge silently drops one); a genuinely dropped name; >1 default across the
 * touched files (a default is necessarily lost); a lost default. Additions are allowed.
 */
export function unionSurfaceViolation(beforeByFile, afterByFile) {
  const b = unionSurface(beforeByFile);
  const a = unionSurface(afterByFile);
  if (b.opaque || a.opaque) return "union export surface unverifiable (star re-export / whole-module CommonJS) — fail-closed";
  const collision = [...b.byName].filter(([, files]) => files.size > 1).map(([n]) => n);
  if (collision.length) return `export name collision across touched files (can't safely merge): ${collision.join(", ")}`;
  const removed = b.names.filter((n) => !a.names.includes(n));
  if (removed.length) return `consolidation dropped exported name(s): ${removed.join(", ")}`;
  if (b.defaultCount > 1) return "multiple default exports across touched files — a default would be lost on merge";
  if (b.defaultCount >= 1 && a.defaultCount < 1) return "consolidation dropped the default export";
  return null;
}

/**
 * One transform. Returns { outcome: "commit"|"propose"|"reject"|"abort", ... }.
 * "abort" is fatal for the whole batch (a failed rollback / dirty precondition).
 */
async function runOneTransform(transform, deps, options) {
  const planned = planTouchedSet(transform);
  if (planned.length < 2) return { outcome: "reject", reason: "not a multi-file transform (planned set < 2)" };

  // §9 safety rule: only a verified deterministic codemod may COMMIT; else PROPOSE.
  const maxBlast = Number.isFinite(options.maxBlastRadius) ? options.maxBlastRadius : DEFAULT_MAX_BLAST;
  if (transform.kind !== "deterministic-codemod") return { outcome: "propose", reason: "not a verified deterministic transform — propose-only (§9)" };
  if (planned.length > maxBlast) return { outcome: "propose", reason: `blast radius ${planned.length} > ${maxBlast} — propose-only (§7)` };

  // Per-transform clean-tree re-assert: never build on a tree a prior revert left dirty.
  if (deps.git.isClean && !deps.git.isClean()) return { outcome: "abort", reason: "working tree not clean before transform (a prior rollback may have failed) — aborting batch" };

  const snapshot = deps.git.head();
  const before = deps.readFiles(planned);
  const revert = (reason) => {
    try {
      deps.git.resetHard(snapshot);
    } catch {
      /* verified below */
    }
    if (deps.git.isClean && !deps.git.isClean()) return { outcome: "abort", reason: `rollback FAILED — repo left dirty after: ${reason}` };
    return { outcome: "reject", reason };
  };

  try {
    await deps.applyTransform(transform);
  } catch (err) {
    return revert(`transform write failed: ${String(err?.message ?? err)}`);
  }

  // A real codemod must be reproducible (a second run yields an identical result).
  if (typeof deps.isDeterministic === "function" && !(await deps.isDeterministic(transform))) {
    return revert("codemod is not reproducible (a second run differs) — propose-only");
  }

  const guard = enforcePlannedTouched(deps.git.changedFiles(), planned);
  if (!guard.ok) return revert(`touched set != planned set (extra: ${guard.extra.join(", ") || "-"}; missing: ${guard.missing.join(", ") || "-"})`);

  const after = deps.readFiles(planned);
  const surf = unionSurfaceViolation(before, after);
  if (surf) return revert(surf);

  if (typeof deps.acceptCharTest === "function") {
    const ct = await deps.acceptCharTest(transform);
    if (!ct?.accept) return revert(`characterization test not accepted: ${ct?.reason ?? "unknown"}`);
  }
  if (options.coverage && typeof deps.diffLines === "function") {
    for (const file of planned) {
      const lines = deps.diffLines(file, snapshot);
      if (lines.length && !coverageOfLines(options.coverage, file, lines).allCovered) return revert(`changed lines in ${file} not executed by any test`);
    }
  }
  const t = await deps.runTests();
  if (!t?.ok) return revert("full suite went red after the transform");

  // Re-assert the touched set immediately before staging — the gates (char-test / tests /
  // pre/post hooks) may have dirtied the tree; commitFiles must stage ONLY the planned
  // pathspec (never add -A), which its adapter contract requires.
  const guard2 = enforcePlannedTouched(deps.git.changedFiles(), planned);
  if (!guard2.ok) return revert(`tree changed during gating (extra: ${guard2.extra.join(", ") || "-"}) — refusing to commit`);

  const commit = deps.git.commitFiles(planned, `audit-multifix: ${transform.title ?? "consolidation"} (${planned.length} files)`);
  return { outcome: "commit", committed: commit, planned };
}

/**
 * Apply a list of structure transforms. Each is atomic + independently reverted; a
 * verified-deterministic-codemod may commit, everything else is PROPOSED (§9). A failed
 * rollback aborts the whole batch. Returns { ok, aborted, applied, proposed, rejected }.
 */
export async function runMultiFix(cwd, transforms = [], backends = {}, options = {}, deps = {}) {
  if (!deps.git || typeof deps.applyTransform !== "function" || typeof deps.readFiles !== "function" || typeof deps.runTests !== "function") {
    return { ok: false, error: "runMultiFix requires deps.git + applyTransform + readFiles + runTests" };
  }
  if (deps.git.isRepo && !deps.git.isRepo()) return { ok: false, error: "not a git repository" };
  if (deps.git.isClean && !deps.git.isClean()) return { ok: false, error: "working tree not clean" };

  const applied = [];
  const proposed = [];
  const rejected = [];
  let aborted = null;
  for (const transform of transforms) {
    let res;
    try {
      res = await runOneTransform(transform, deps, options);
    } catch (err) {
      res = { outcome: "reject", reason: `transform error: ${String(err?.message ?? err)}` };
    }
    if (res.outcome === "commit") applied.push({ transform, commit: res.committed, files: res.planned });
    else if (res.outcome === "propose") proposed.push({ transform, plannedSet: planTouchedSet(transform), reason: res.reason });
    else if (res.outcome === "abort") {
      aborted = res.reason;
      break; // fatal — do not build further transforms on a compromised tree
    } else rejected.push({ transform, reason: res.reason });
  }
  return { ok: !aborted, aborted, applied, proposed, rejected };
}
