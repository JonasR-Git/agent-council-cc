/**
 * Classify a finding as 'localized' (a concrete, well-scoped fix diff is the
 * right deliverable) or 'cross-cutting' (a documented approach/plan beats an
 * auto-generated patch - the user's instinct). Model-agnostic, heuristic, and
 * overridable by an explicit finding.scope from the agents.
 */

const CROSS_CUTTING_HINTS =
  /\b(architect|refactor|pattern|across|throughout|everywhere|consistent(?:ly|cy)?|design|abstraction|coupling|systemic|wide|multiple files|api surface|convention|migration|rename)\b/i;

export function classifyScope(finding) {
  const explicit = String(finding?.scope ?? "").toLowerCase();
  if (explicit === "localized" || explicit === "cross-cutting") return explicit;

  const hasPreciseLocation = Boolean(finding?.file) && Number.isFinite(Number(finding?.line));
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
