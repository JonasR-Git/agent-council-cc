/**
 * Classify a finding as 'localized' (a concrete, well-scoped fix diff is the
 * right deliverable) or 'cross-cutting' (a documented approach/plan beats an
 * auto-generated patch - the user's instinct). Model-agnostic, heuristic, and
 * overridable by an explicit finding.scope from the agents.
 */

const CROSS_CUTTING_HINTS =
  /\b(architect|refactor|pattern|across|throughout|everywhere|consistent(?:ly|cy)?|design|abstraction|coupling|systemic|wide|multiple files|api surface|convention|migration|rename)\b/i;

/**
 * True when a finding's title/detail contains cross-cutting vocabulary (architect/refactor/across/api
 * surface/…), INDEPENDENT of any explicit `scope` field. classifyScope lets an explicit scope:"localized"
 * short-circuit before the hint scan; the fix-eligibility reattribution needs the hint signal as a veto that
 * an explicit "localized" cannot override (council diff-review P1), so it calls this directly.
 */
export function textSoundsCrossCutting(finding) {
  return CROSS_CUTTING_HINTS.test(`${finding?.title ?? ""} ${finding?.detail ?? ""}`);
}

export function classifyScope(finding) {
  const explicit = String(finding?.scope ?? "").toLowerCase();
  if (explicit === "localized" || explicit === "cross-cutting") return explicit;

  // Number(null) is 0 (finite), so guard against a null line explicitly -
  // a finding with a file but no line is NOT a precise location.
  const hasPreciseLocation = Boolean(finding?.file) && finding?.line != null && Number.isFinite(Number(finding.line));
  const text = `${finding?.title ?? ""} ${finding?.detail ?? ""}`;
  const soundsCrossCutting = CROSS_CUTTING_HINTS.test(text);

  // A single file:line with no architectural language -> localized (patchable).
  // Anything spanning/architectural, or with no precise location -> cross-cutting
  // (document the approach; a patch would be brittle or incomplete).
  if (hasPreciseLocation && !soundsCrossCutting) return "localized";
  return "cross-cutting";
}

/** Preferred deliverable for a finding's scope. */
export function deliverableFor(scope) {
  return scope === "localized" ? "fix-diff" : "documented-approach";
}

export function annotateScopes(merged) {
  const all = (merged?.all ?? []).map((f) => {
    const scope = classifyScope(f);
    return { ...f, scope, deliverable: deliverableFor(scope) };
  });
  return {
    ...merged,
    all,
    consensus: all.filter((m) => m.consensus),
    unique: all.filter((m) => !m.consensus)
  };
}
