import assert from "node:assert/strict";
import test from "node:test";

import { runGroupedReview } from "../plugins/council/scripts/lib/audit-grouped-review.mjs";

const MODEL = { files: [{ id: "a.mjs", loc: 10, branches: 2, maxNesting: 1, fanIn: 0, fanOut: 1, churn: 3, smellCount: 0, tested: false, hotspot: 5 }] };
const ALL_BACKENDS = { codex: { companionAvailable: true }, grok: { cli: { available: true } }, claude: { cli: { available: true } } };
const FS = { readFile: () => "const x = 1;\nconst y = 2;\n", statSize: () => 40 };

// C + B wiring in the grouped review: each reviewed cell's findings are flushed to the durable store,
// and a mid-pass quiesce surfaces on coverage — charging ONLY the cells actually dispatched.
test("grouped review: cells feed the durable store; a mid-pass quiesce surfaces + charges only dispatched cells", async () => {
  const appended = [];
  const appender = { append: (fs2) => { appended.push(...fs2); return { appended: fs2.length }; } };
  let seen = 0;
  const guard = {
    quiesce: null,
    isDone: () => false,
    beforeCell: async () => {
      if (seen >= 6) { guard.quiesce = { kind: "ceiling", breaches: [{ model: "codex", percent: 80, ceiling: 50, window: "weekly" }] }; return true; }
      seen += 1;
      return false;
    }
  };
  const reviewCell = async (cell) => ({ ok: true, cell, findings: [{ id: `${cell.model}-${cell.groupId}-${cell.chunk}`, agent: cell.model, severity: "P2", category: "bug", title: `f ${cell.file}`, detail: "d", file: "a.mjs", line: 1, lens: "correctness" }] });
  const out = await runGroupedReview(
    "/x",
    MODEL,
    { ...ALL_BACKENDS },
    { lensGroups: "lens", ledger: false, verifyAudit: false, maxInflight: 1, reviewGuard: guard, findingsAppender: appender, pass: 2 },
    { reviewCell, ...FS }
  );
  assert.ok(out.coverage.quiesced, "the quiesce marker propagates from the matrix to coverage");
  assert.equal(out.coverage.quiesced.kind, "ceiling");
  assert.equal(appended.length, 6, "each of the 6 dispatched cells flushed its findings to the durable store");
  assert.equal(out.coverage.budgetSpent, 6, "only the 6 dispatched cells are charged (quiesced cells cost 0)");
  assert.ok(out.coverage.cellsQuiesced > 0, "the remaining cells were refused, not dispatched");
  assert.equal(out.coverage.passComplete, false, "an interrupted band is incomplete → the loop knows work remains");
});

// Grok-2 REGRESSION PIN: a cell whose durable append THROWS must NOT be marked done in the resume cursor —
// else a --resume SKIPS it and its findings (never recorded) are lost forever. markDone runs ONLY when the
// flush succeeded (or there was nothing to flush).
test("Grok-2 (markDone): a cell whose durable append THROWS is NOT marked done → a resume re-reviews it", async () => {
  const reviewCell = async (cell) => ({ ok: true, cell, findings: [{ id: `${cell.model}-${cell.groupId}-${cell.chunk}`, agent: cell.model, severity: "P2", category: "bug", title: "x", detail: "d", file: "a.mjs", line: 1, lens: "correctness" }] });
  // Failing appender: every durable flush throws → not one cell may be marked done.
  const failCalls = [];
  const failGuard = { quiesce: null, isDone: () => false, beforeCell: async () => false, markDone: (k) => failCalls.push(k) };
  const failAppender = { append: () => { throw new Error("EIO: durable store write failed"); } };
  await runGroupedReview("/x", MODEL, { ...ALL_BACKENDS }, { lensGroups: "lens", ledger: false, verifyAudit: false, maxInflight: 1, reviewGuard: failGuard, findingsAppender: failAppender, pass: 1 }, { reviewCell, ...FS });
  assert.equal(failCalls.length, 0, "no cell is marked done while its durable flush keeps throwing (resume re-reviews them, findings not lost)");
  // Contrast: a HEALTHY appender advances the resume cursor for each reviewed cell.
  const okCalls = [];
  const okGuard = { quiesce: null, isDone: () => false, beforeCell: async () => false, markDone: (k) => okCalls.push(k) };
  const okAppender = { append: () => ({ appended: 1 }) };
  await runGroupedReview("/x", MODEL, { ...ALL_BACKENDS }, { lensGroups: "lens", ledger: false, verifyAudit: false, maxInflight: 1, reviewGuard: okGuard, findingsAppender: okAppender, pass: 1 }, { reviewCell, ...FS });
  assert.ok(okCalls.length > 0, "a successful flush DOES mark cells done");
});

test("grouped review: with no guard/appender the path is byte-identical (findings still returned)", async () => {
  const reviewCell = async (cell) => ({ ok: true, cell, findings: [{ id: `${cell.model}-${cell.groupId}`, agent: cell.model, severity: "P2", category: "bug", title: "x", file: "a.mjs", line: 1, lens: "correctness" }] });
  const out = await runGroupedReview("/x", MODEL, { ...ALL_BACKENDS }, { lensGroups: "lens", ledger: false, verifyAudit: false, maxInflight: 1 }, { reviewCell, ...FS });
  assert.equal(out.coverage.quiesced, null, "no guard → never quiesces");
  assert.equal(out.coverage.cellsQuiesced, 0);
  assert.equal(out.coverage.budgetSpent, 39, "lens preset: 13 groups × 1 file × 1 chunk × 3 models");
});
