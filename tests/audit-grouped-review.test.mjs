import assert from "node:assert/strict";
import test from "node:test";

import { activeModels, runGroupedReview } from "../plugins/council/scripts/lib/audit-grouped-review.mjs";
import { normalizeFindings } from "../plugins/council/scripts/lib/audit-normalize.mjs";
import { tierOfLens } from "../plugins/council/scripts/lib/audit-tiers.mjs";
import { getLens } from "../plugins/council/scripts/lib/audit-lenses.mjs";

const MODEL = { files: [{ id: "a.mjs", loc: 10, branches: 2, maxNesting: 1, fanIn: 0, fanOut: 1, churn: 3, smellCount: 0, tested: false, hotspot: 5 }] };
const ALL_BACKENDS = { codex: { companionAvailable: true }, grok: { cli: { available: true } }, claude: { cli: { available: true } } };

test("activeModels reflects reachable, non-skipped seats", () => {
  assert.deepEqual(activeModels(ALL_BACKENDS, {}), ["codex", "grok", "claude"]);
  assert.deepEqual(activeModels(ALL_BACKENDS, { skipGrok: true }), ["codex", "claude"]);
  assert.deepEqual(activeModels({ codex: { companionAvailable: false }, grok: { cli: { available: false } }, claude: { cli: { available: false } } }, {}), []);
});

test("runGroupedReview: the cell-matrix path returns findings + six-eyes coverage.complete", async () => {
  let seenCells = 0;
  const runMatrix = async (cells) => {
    seenCells = cells.length;
    return {
      findings: [{ severity: "P1", category: "security", title: "sqli in query builder", detail: "d", file: "a.mjs", lens: "security_secrets" }],
      matrix: { summary: () => ({ models: 3, done: cells.length, failed: 0 }) },
      complete: true
    };
  };
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "lens", ledger: false }, { runMatrix });
  assert.ok(out.findings.length >= 1);
  assert.equal(out.coverage.complete, true);
  assert.equal(out.coverage.groupPreset, "lens");
  assert.equal(out.coverage.ran, true);
  // lens preset = 13 groups × 1 file × 1 chunk (unreadable file → empty → 1 chunk) × 3 models = 39
  assert.equal(seenCells, 39);
  assert.equal(out.coverage.cellsScheduled, 39);
  assert.deepEqual(out.coverage.reviewers, { codex: true, grok: true, claude: true });
});

test("runGroupedReview: a CAPPED run never claims complete coverage", async () => {
  const runMatrix = async () => ({ findings: [], matrix: { summary: () => ({}) }, complete: true });
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "fine", ledger: false, maxCells: 5 }, { runMatrix });
  assert.equal(out.coverage.capped, true);
  assert.ok(out.coverage.cellsDropped > 0, "the overflow is surfaced");
  assert.equal(out.coverage.complete, false, "a capped run is never six-eyes complete");
});

test("runGroupedReview: no reachable reviewer → ran:false, no matrix call", async () => {
  let called = false;
  const runMatrix = async () => { called = true; return { findings: [], complete: true }; };
  const out = await runGroupedReview("/x", MODEL, { codex: {}, grok: {}, claude: {} }, { lensGroups: "lens", ledger: false }, { runMatrix });
  assert.equal(out.coverage.ran, false);
  assert.equal(out.coverage.complete, false);
  assert.equal(called, false, "nothing dispatched when no seat is reachable");
});

test("runGroupedReview: output is normalize-compatible so downstream tiering works", async () => {
  const runMatrix = async () => ({
    findings: [{ severity: "P2", category: "design", title: "duplicate config constant", detail: "d", file: "a.mjs", line: 5, lens: "architecture_ssot", agent: "codex" }],
    matrix: { summary: () => ({}) },
    complete: true
  });
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "tier", ledger: false }, { runMatrix });
  // mirror the per-file path: un-normalized findings.mjs shape (file/category/severity present)
  assert.equal(out.findings[0].file, "a.mjs");
  assert.equal(out.findings[0].category, "design");
  // the consumer normalizes → a valid lens whose tier is a real tier id
  const norm = normalizeFindings(out.findings, {});
  assert.ok(getLens(norm[0].lens), "normalize assigns a real lens");
  assert.equal(typeof tierOfLens(norm[0].lens), "number");
});

test("runGroupedReview: a defect seen by two seats on the same cell merges to consensus", async () => {
  const runMatrix = async () => ({
    findings: [
      { severity: "P1", category: "security", title: "unescaped shell arg", detail: "d", file: "a.mjs", line: 12, lens: "security_secrets", agent: "codex" },
      { severity: "P1", category: "security", title: "unescaped shell arg", detail: "d", file: "a.mjs", line: 12, lens: "security_secrets", agent: "grok" }
    ],
    matrix: { summary: () => ({}) },
    complete: true
  });
  const out = await runGroupedReview("/x", MODEL, ALL_BACKENDS, { lensGroups: "tier", ledger: false }, { runMatrix });
  assert.equal(out.findings.length, 1, "the two seats' identical finding merges to one");
  assert.equal(out.findings[0].consensus, true, "≥2 agents → consensus");
  assert.deepEqual([...out.findings[0].agents].sort(), ["codex", "grok"]);
});
