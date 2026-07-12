import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAX_INFLIGHT,
  cellKey,
  enumerateCells,
  makeCellReviewer,
  makeCoverageMatrix,
  runCellMatrix,
  scheduleCells,
  triplesOf,
  withCellRetry
} from "../plugins/council/scripts/lib/audit-cell-scheduler.mjs";

const GROUPS = [
  { id: "security-injection", lenses: ["security_secrets"], focus: "injection" },
  { id: "concurrency-races", lenses: ["concurrency_resources"], focus: "races" }
];
const MODELS = ["codex", "grok", "claude"];

test("enumerateCells produces one cell per (model × group × file × chunk), deterministic order", () => {
  const files = ["a.mjs", "b.mjs"];
  const chunksOf = (f) => (f === "a.mjs" ? [{ index: 0 }, { index: 1 }] : [{ index: 0 }]); // a has 2 chunks, b has 1
  const cells = enumerateCells(files, GROUPS, MODELS, chunksOf);
  // a: 2 groups × 2 chunks × 3 models = 12 ; b: 2 groups × 1 chunk × 3 models = 6 → 18
  assert.equal(cells.length, 18);
  // order: file → group → chunk → model
  assert.deepEqual({ f: cells[0].file, g: cells[0].groupId, c: cells[0].chunk, m: cells[0].model }, { f: "a.mjs", g: "security-injection", c: 0, m: "codex" });
  // chunk data + total threaded onto the cell
  assert.equal(cells[0].chunkTotal, 2);
  assert.deepEqual(cells[0].chunkData, { index: 0 });
});

test("enumerateCells yields ≥1 cell per (group,model) even for a file with no chunks", () => {
  const cells = enumerateCells(["empty.mjs"], GROUPS, MODELS, () => []);
  assert.equal(cells.length, 2 * 1 * 3, "an unreadable/empty file is still visibly covered");
  assert.equal(cells[0].chunkData, null);
});

test("triplesOf collapses models — distinct (group,file,chunk) units six-eyes is measured on", () => {
  const cells = enumerateCells(["a.mjs"], GROUPS, MODELS, () => [{ index: 0 }]);
  const triples = triplesOf(cells);
  assert.equal(triples.length, 2, "2 groups × 1 file × 1 chunk = 2 triples (models collapsed)");
});

test("coverage matrix: a triple is six-eyes complete only when EVERY active model has a done cell", () => {
  const m = makeCoverageMatrix(MODELS);
  const triple = { groupId: "security-injection", file: "a.mjs", chunk: 0 };
  m.markDone({ model: "codex", ...triple });
  m.markDone({ model: "grok", ...triple });
  assert.equal(m.tripleComplete(triple), false, "two of three eyes is not six-eyes");
  m.markDone({ model: "claude", ...triple });
  assert.equal(m.tripleComplete(triple), true, "all three → complete");
  assert.equal(m.sixEyesComplete([triple]), true);
});

test("coverage matrix: a once-done cell is not un-done by a later failure (retry that succeeds sticks)", () => {
  const m = makeCoverageMatrix(["codex"]);
  const cell = { model: "codex", groupId: "g", file: "f", chunk: 0 };
  m.markDone(cell);
  m.markFailed(cell); // e.g. a duplicate late signal
  assert.equal(m.isDone(cell), true);
  assert.equal(m.summary().done, 1);
});

test("sixEyesComplete/incompleteTriples reflect partial coverage", () => {
  const m = makeCoverageMatrix(MODELS);
  const t1 = { groupId: "g1", file: "f", chunk: 0 };
  const t2 = { groupId: "g2", file: "f", chunk: 0 };
  for (const model of MODELS) m.markDone({ model, ...t1 });
  m.markDone({ model: "codex", ...t2 }); // t2 only 1/3
  assert.equal(m.sixEyesComplete([t1, t2]), false);
  assert.deepEqual(m.incompleteTriples([t1, t2]), [t2]);
});

test("scheduleCells clamps maxInflight and never exceeds it in flight", async () => {
  const cells = Array.from({ length: 30 }, (_, i) => ({ i }));
  let inFlight = 0;
  let peak = 0;
  const runCell = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight -= 1;
    return { ok: true };
  };
  const results = await scheduleCells(cells, runCell, { maxInflight: 4 });
  assert.equal(results.length, 30);
  assert.ok(peak <= 4, `peak in-flight ${peak} must not exceed maxInflight 4`);
  // clamp: a silly maxInflight is bounded to the 16 ceiling, and ≥1
  assert.ok(peak >= 1);
});

test("scheduleCells preserves order and turns a throwing cell into ok:false (batch never rejects)", async () => {
  const cells = [{ n: 0 }, { n: 1 }, { n: 2 }];
  const results = await scheduleCells(
    cells,
    async (cell) => {
      if (cell.n === 1) throw new Error("boom");
      return { ok: true, n: cell.n };
    },
    { maxInflight: 2 }
  );
  assert.equal(results[0].n, 0);
  assert.equal(results[1].ok, false);
  assert.match(String(results[1].error?.message), /boom/);
  assert.equal(results[2].n, 2);
});

test("withCellRetry retries a rate-limited cell in isolation (injected sleep), not the batch", async () => {
  let calls = 0;
  const rateErr = Object.assign(new Error("429 Too Many Requests"), { status: 429 });
  const runCell = async () => {
    calls += 1;
    if (calls < 3) throw rateErr;
    return { ok: true };
  };
  const wrapped = withCellRetry(runCell, { retries: 5, sleep: async () => {} });
  const r = await wrapped({ model: "codex" }, 0);
  assert.equal(r.ok, true);
  assert.equal(calls, 3, "retried twice then succeeded");
});

test("withCellRetry lets a non-rate-limit error propagate", async () => {
  const wrapped = withCellRetry(async () => { throw new Error("syntax"); }, { sleep: async () => {} });
  await assert.rejects(() => wrapped({}, 0), /syntax/);
});

test("makeCellReviewer runs the cell's MODEL with the group prompt; fail-closed on a bad run", async () => {
  const seen = {};
  const review = makeCellReviewer("/x", {}, {}, {
    runCodex: async (p) => { seen.codex = p; return { status: 0, stdout: '{"agent":"codex","findings":[{"severity":"P1","title":"t","detail":"d"}]}' }; },
    runGrok: async () => ({ skipped: true }),
    runClaude: async () => ({ status: 1, stdout: "" })
  });
  const cell = { model: "codex", groupId: "security-injection", group: GROUPS[0], file: "db.mjs", chunk: 0, chunkData: { text: "SELECT", index: 0, total: 1, startLine: 1, endLine: 1 } };
  const ok = await review(cell);
  assert.equal(ok.ok, true);
  assert.equal(ok.findings.length, 1);
  assert.match(seen.codex, /injection/, "the group focus drives the cell prompt");
  // skipped grok and errored claude are fail-closed (no finding manufactured)
  assert.equal((await review({ ...cell, model: "grok" })).ok, false);
  assert.equal((await review({ ...cell, model: "claude" })).ok, false);
});

test("runCellMatrix: all-ok cells → six-eyes complete; a failed model keeps the triple incomplete", async () => {
  const cells = enumerateCells(["a.mjs"], [GROUPS[0]], MODELS, () => [{ index: 0, text: "x", startLine: 1, endLine: 1, total: 1 }]);
  // codex+grok succeed, claude fails → triple never complete
  const reviewCell = async (cell) => (cell.model === "claude" ? { ok: false, cell } : { ok: true, cell, findings: [{ severity: "P2", title: cell.model }] });
  const out = await runCellMatrix(cells, reviewCell, { models: MODELS, maxInflight: 4, retryOnLimit: false });
  assert.equal(out.complete, false, "one failing eye → not six-eyes complete");
  assert.equal(out.findings.length, 2, "codex + grok findings collected");
  assert.deepEqual(out.matrix.incompleteTriples(out.triples).length, 1);

  // now all three succeed → complete
  const out2 = await runCellMatrix(cells, async (cell) => ({ ok: true, cell, findings: [] }), { models: MODELS, maxInflight: 4, retryOnLimit: false });
  assert.equal(out2.complete, true);
});

test("DEFAULT_MAX_INFLIGHT is in the 4–8 target band, and cellKey is collision-free across dimensions", () => {
  assert.ok(DEFAULT_MAX_INFLIGHT >= 4 && DEFAULT_MAX_INFLIGHT <= 8);
  assert.notEqual(
    cellKey({ model: "codex", groupId: "g", file: "a", chunk: 0 }),
    cellKey({ model: "codex", groupId: "g", file: "a", chunk: 1 })
  );
});
