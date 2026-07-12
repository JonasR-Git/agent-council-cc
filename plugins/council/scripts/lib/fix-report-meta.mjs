// Assemble the fix-report HTML `meta` (telemetry). The report already RENDERS a metrics section
// (renderMetricsSection ← meta.metrics) and a codebase-shape section (renderShapeSection ← meta.shape),
// but nothing fed them — fix-metrics.mjs + codebase-shape.mjs were built-but-unwired (council fleet
// F1/O9). This is the thin, PURE, injectable assembler that wires them: no repo + no network needed in
// tests. Only computed when a run asks for the HTML report.
import { buildRunMetrics } from "./fix-metrics.mjs";
import { computeShape, shapeDelta, parseGitNumstat } from "./codebase-shape.mjs";

/**
 * Build the report meta from a fix/loop RESULT + timing context.
 *  - metrics: gate funnel + council tally + outcome totals + timing + cost, derived from `out` (seat
 *    token/call data is optional and zeroes out when not instrumented).
 *  - shape: only when both before/after codebase shapes are supplied — the before→after delta + git
 *    churn (parsed from a `git diff --numstat` string).
 * Returns { metrics, shape? } to spread into writeFixReportHtml's meta.
 */
export function assembleFixMeta(out, ctx = {}) {
  const meta = { metrics: buildRunMetrics(out, ctx) };
  if (ctx.shapeBefore && ctx.shapeAfter) {
    meta.shape = shapeDelta(ctx.shapeBefore, ctx.shapeAfter, ctx.numstat != null ? parseGitNumstat(ctx.numstat) : null);
  }
  return meta;
}

/**
 * Before/after codebase shape of ONLY the changed files (bounded — a fix touches a small set), reading
 * each side at its git ref via `readAt(ref, path)`. A file unreadable at a ref (added / deleted /
 * renamed) contributes an empty side rather than throwing — FAIL-SOFT (council Grok telemetry risk:
 * `git show ref:path` fails on renames/deletes/paths-outside-the-tree, and a telemetry report must never
 * crash a completed fix run).
 */
export function changedFilesShape(changedFiles, baseRef, headRef, readAt) {
  const files = [...new Set((Array.isArray(changedFiles) ? changedFiles : []).filter(Boolean))];
  const read = (ref, p) => {
    try {
      return String(readAt(ref, p) ?? "");
    } catch {
      return "";
    }
  };
  const side = (ref) => computeShape(files.map((f) => ({ id: f, source: read(ref, f) })));
  return { before: side(baseRef), after: side(headRef) };
}
