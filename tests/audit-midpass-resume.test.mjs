import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cellKey, runCellMatrix } from "../plugins/council/scripts/lib/audit-cell-scheduler.mjs";
import { makeReviewCursor } from "../plugins/council/scripts/lib/audit-midpass-guard.mjs";

const mkCells = (files) => files.map((file) => ({ model: "m", groupId: "g", group: { id: "g", lenses: ["correctness"] }, file, chunk: 0 }));
const cursorFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "resume-")), "cursor.jsonl");

// INVARIANT 1 (the load-bearing one): a --resume after a mid-pass quiesce SKIPS the cells already
// reviewed (durable cursor) — no double-charge, no lost cells. Proven end-to-end over the REAL scheduler
// + REAL cursor: a first run quiesces after 2 of 4 cells; a resume completes the remaining 2 and never
// re-dispatches the first 2. Total dispatches across both runs == the cell count, each exactly once.
test("checkpoint-and-resume: a resume skips completed cells — no double-charge, no lost cells", async () => {
  const cells = mkCells(["a.mjs", "b.mjs", "c.mjs", "d.mjs"]);
  const file = cursorFile();
  const cursor = makeReviewCursor(file);
  const dispatched = [];
  const reviewCell = async (cell) => {
    dispatched.push(cellKey(cell));
    return { ok: true, cell, findings: [{ id: `${cell.file}#0`, file: cell.file, title: `bug ${cell.file}`, severity: "P1", lens: "correctness" }] };
  };
  // Mirror the grouped review's onCell: mark the durable cursor AFTER a successful (non-skipped) cell.
  const markCursor = (r) => { if (r && r.ok === true && r.skipped !== true && r.cell) cursor.markDone(cellKey(r.cell)); };

  // Run 1 — a quota breach quiesces after the first 2 cells (maxInflight 1 → deterministic order).
  let n = 0;
  const guard1 = {
    quiesce: null,
    isDone: (k) => cursor.isDone(k),
    beforeCell: async () => {
      if (n >= 2) { guard1.quiesce = { kind: "ceiling", breaches: [] }; return true; }
      n += 1;
      return false;
    }
  };
  const out1 = await runCellMatrix(cells, reviewCell, { models: ["m"], guard: guard1, maxInflight: 1, onCell: markCursor });
  assert.equal(out1.dispatched, 2, "run 1 dispatched exactly the 2 cells before the breach (overshoot bounded)");
  assert.ok(out1.quiesced, "run 1 returns the quiesce marker");
  assert.equal(out1.complete, false, "the band is INCOMPLETE — the loop knows work remains");
  assert.equal(cursor.size(), 2, "the 2 reviewed cells are in the durable cursor");

  // Run 2 — the --resume: a NEW cursor over the SAME file (fresh process) + a guard that never trips.
  const cursor2 = makeReviewCursor(file);
  const guard2 = { quiesce: null, isDone: (k) => cursor2.isDone(k), beforeCell: async () => false };
  const dispatched2Start = dispatched.length;
  const out2 = await runCellMatrix(cells, reviewCell, {
    models: ["m"], guard: guard2, maxInflight: 1,
    onCell: (r) => { if (r && r.ok === true && r.skipped !== true && r.cell) cursor2.markDone(cellKey(r.cell)); }
  });
  const run2Dispatched = dispatched.slice(dispatched2Start);
  assert.equal(out2.skipped, 2, "the resume SKIPPED the 2 cells already reviewed (no re-charge)");
  assert.equal(out2.dispatched, 2, "the resume dispatched only the remaining 2 cells");
  assert.deepEqual(run2Dispatched.sort(), [cellKey(cells[2]), cellKey(cells[3])].sort(), "exactly the un-reviewed cells");
  assert.equal(out2.complete, true, "the resume COMPLETES the band — no lost cells");

  // No double-charge: across BOTH runs every cell was dispatched exactly once.
  assert.equal(dispatched.length, 4, "4 cells → 4 total dispatches");
  assert.equal(new Set(dispatched).size, 4, "each cell dispatched exactly once (no double-charge)");
});

// PRE-DISPATCH headroom bounds overshoot to the in-flight cell(s): once the guard quiesces, no further
// cell is started even though many remain unscheduled.
test("quiesce stops scheduling new cells — remaining cells are refused, not dispatched", async () => {
  const cells = mkCells(["a.mjs", "b.mjs", "c.mjs", "d.mjs", "e.mjs"]);
  const dispatched = [];
  const reviewCell = async (cell) => { dispatched.push(cell.file); return { ok: true, cell, findings: [] }; };
  const guard = {
    quiesce: null,
    isDone: () => false,
    beforeCell: async () => { guard.quiesce = { kind: "ceiling", breaches: [] }; return true; } // breach immediately
  };
  const out = await runCellMatrix(cells, reviewCell, { models: ["m"], guard, maxInflight: 1 });
  assert.equal(dispatched.length, 0, "an immediate breach dispatches ZERO new cells");
  assert.equal(out.dispatched, 0);
  assert.ok(out.quiesced, "the quiesce marker is surfaced to the caller");
});
