import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAX_INFLIGHT,
  capCells,
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

test("scheduleCells (council O10): an oversized maxInflight is CLAMPED to the 16 ceiling", async () => {
  // the 16-spawn ceiling exists to stop N×30×3 fanning out thousands of concurrent CLI processes —
  // exercise it with an out-of-band value (the prior test only passed 4, so the clamp was untested).
  const cells = Array.from({ length: 60 }, (_, i) => ({ i }));
  let inFlight = 0;
  let peak = 0;
  const runCell = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight -= 1;
    return { ok: true };
  };
  await scheduleCells(cells, runCell, { maxInflight: 1000 });
  assert.ok(peak <= 16, `peak in-flight ${peak} must be clamped to the 16 ceiling`);
  assert.ok(peak > 4, "and it does run well above a trivial concurrency (proves the value was honored up to the cap)");
});

test("makeCellReviewer (council O10): a status-0 but UNPARSEABLE reply is fail-closed (ok:false, unparsed), not a clean cell", async () => {
  // a dead/garbled backend that exits 0 with non-JSON must NOT count as a done cell with zero findings
  // (that would be a silent false-clean marking the triple six-eyes complete).
  const review = makeCellReviewer("/x", {}, {}, { runCodex: async () => ({ status: 0, stdout: "not json at all" }) });
  const cell = { model: "codex", groupId: "g", group: { id: "g", lenses: ["correctness"] }, file: "a.mjs", chunk: 0, chunkData: { text: "x", index: 0, total: 1, startLine: 1, endLine: 1 } };
  const r = await review(cell);
  assert.equal(r.ok, false, "unparseable → not ok (never a manufactured clean review)");
  assert.equal(r.unparsed, true);
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

test("B4 (council Claude seat): cellKey is printable JSON — stays a text .mjs (no NUL → git binary)", () => {
  const k = cellKey({ model: "codex", groupId: "security-injection", file: "a b/c.mjs", chunk: 3 });
  assert.equal(k, '["codex","security-injection","a b/c.mjs",3]');
  assert.equal(/\x00/.test(k), false, "no NUL byte");
  // collision-free even when a value contains what could be a separator
  assert.notEqual(cellKey({ model: "m", groupId: "a", file: "b", chunk: 0 }), cellKey({ model: "m", groupId: "a,b", file: "", chunk: 0 }));
});

test("B4 (council grok-2): capCells bounds total cells EXPLICITLY, reporting what was dropped", () => {
  const cells = Array.from({ length: 100 }, (_, i) => ({ i }));
  const under = capCells(cells, 200);
  assert.equal(under.capped, false);
  assert.equal(under.cells.length, 100);
  const over = capCells(cells, 30);
  assert.equal(over.capped, true);
  assert.equal(over.cells.length, 30);
  assert.equal(over.dropped, 70, "the overflow count is surfaced, never silently cut");
});

test("B4 (council grok-1): a rate-limited cell run is re-thrown so withCellRetry backs it off", async () => {
  let calls = 0;
  const review = makeCellReviewer("/x", {}, {}, {
    runCodex: async () => {
      calls += 1;
      if (calls < 2) return { status: 1, stderr: "Error: 429 rate limit exceeded", stdout: "" };
      return { status: 0, stdout: '{"agent":"codex","findings":[]}' };
    }
  });
  const cell = { model: "codex", groupId: "g", group: { id: "g", lenses: [], focus: "f" }, file: "a.mjs", chunk: 0, chunkData: { text: "x", index: 0, total: 1, startLine: 1, endLine: 1 } };
  // WITHOUT retry, the throttled run THROWS (not a silent {ok:false} the retry can't see)
  await assert.rejects(() => review(cell), /rate-limited/);
  calls = 0;
  // WITH the per-cell retry (injected sleep) it backs off then succeeds
  const wrapped = withCellRetry(review, { sleep: async () => {} });
  const r = await wrapped(cell, 0);
  assert.equal(r.ok, true);
  assert.equal(calls, 2, "retried once after the 429");
});

test("B4 (council grok-3): an ok-less reviewer result is marked FAILED, not done (no false completeness)", async () => {
  const cells = enumerateCells(["a.mjs"], [{ id: "g", lenses: [], focus: "f" }], ["codex"], () => [{ index: 0 }]);
  // returns findings WITHOUT an ok:true — must NOT complete the triple, and its findings are dropped (symmetric)
  const out = await runCellMatrix(cells, async () => ({ findings: [{ severity: "P2", title: "x" }] }), { models: ["codex"], retryOnLimit: false });
  assert.equal(out.complete, false);
  assert.equal(out.findings.length, 0);
  assert.equal(out.matrix.summary().done, 0);
});

test("B5: makeCellReviewer stamps each finding's LENS from its group (so tier gating works)", async () => {
  const review = makeCellReviewer("/x", {}, {}, {
    runCodex: async () => ({ status: 0, stdout: '{"agent":"codex","findings":[{"severity":"P1","title":"a","detail":"d"},{"severity":"P2","title":"b","detail":"d","lens":"security_secrets"}]}' })
  });
  const cell = { model: "codex", groupId: "correctness-logic", group: { id: "correctness-logic", lenses: ["correctness"], focus: "logic" }, file: "a.mjs", chunk: 0, chunkData: { text: "x", index: 0, total: 1, startLine: 1, endLine: 1 } };
  const r = await review(cell);
  // the pass is scoped to the single-lens correctness-logic group → every finding is tagged its lens
  assert.equal(r.findings[0].lens, "correctness");
  assert.equal(r.findings[1].lens, "correctness", "the group lens is authoritative for a single-lens group-scoped pass");
});

test("B5 (council codex P2): a MULTI-lens group keeps a finding's specific lens (P0 live-hole override intact)", async () => {
  const review = makeCellReviewer("/x", {}, {}, {
    runCodex: async () => ({ status: 0, stdout: '{"agent":"codex","findings":[{"severity":"P0","title":"sqli","detail":"d","lens":"security_secrets"},{"severity":"P2","title":"x","detail":"d"}]}' })
  });
  // the built-in 'tier' preset bundles several lenses per group — forcing lenses[0] would relabel a
  // security_secrets P0 as 'correctness' and defeat SECURITY_OVERRIDE_LENSES.
  const cell = { model: "codex", groupId: "tier-correctness", group: { id: "tier-correctness", lenses: ["correctness", "concurrency_resources", "security_secrets"] }, file: "a.mjs", chunk: 0, chunkData: { text: "x", index: 0, total: 1, startLine: 1, endLine: 1 } };
  const r = await review(cell);
  assert.equal(r.findings[0].lens, "security_secrets", "a multi-lens group must NOT overwrite the finding's real lens");
  assert.equal(r.findings[1].lens, "correctness", "an unlensed finding falls back to the group's first lens");
});

test("makeCellReviewer stamps file=cell.file + a GLOBALLY-UNIQUE id (fleet P1: no cross-cell lens collision)", async () => {
  // The model may omit/mis-state file, and its ids restart per cell (`codex-1`), which collided the
  // grouped path's id-keyed lens re-stamp. Force the cell's file + a cell-unique id.
  const stdout = '{"agent":"codex","findings":[{"severity":"P1","title":"t","detail":"d","file":"WRONG.mjs","id":"codex-1"}]}';
  const review = makeCellReviewer("/x", {}, {}, { runCodex: async () => ({ status: 0, stdout }) });
  const cellA = { model: "codex", groupId: "g1", group: { id: "g1", lenses: ["correctness"] }, file: "a.mjs", chunk: 0, chunkData: { text: "x", index: 0, total: 1, startLine: 1, endLine: 1 } };
  const cellB = { model: "codex", groupId: "g2", group: { id: "g2", lenses: ["security_secrets"] }, file: "a.mjs", chunk: 0, chunkData: { text: "x", index: 0, total: 1, startLine: 1, endLine: 1 } };
  const rA = await review(cellA);
  const rB = await review(cellB);
  assert.equal(rA.findings[0].file, "a.mjs", "the cell's file is authoritative, not the model's claim");
  assert.notEqual(rA.findings[0].id, rB.findings[0].id, "the same model's 1st finding in two cells gets DISTINCT ids");
  assert.ok(rA.findings[0].id.includes("g1") && rB.findings[0].id.includes("g2"), "the id carries the cell key");
});

test("makeCellReviewer (multi-lens group): an unlensed finding DERIVES its lens from category (Codex C1)", async () => {
  // A security finding the model labels category 'security' but leaves lens-less must NOT default to
  // lenses[0]=correctness in a tier cell — derive security_secrets so the P0 override still fires.
  const review = makeCellReviewer("/x", {}, {}, {
    runCodex: async () => ({ status: 0, stdout: '{"agent":"codex","findings":[{"severity":"P0","title":"sqli","detail":"d","category":"security"}]}' })
  });
  const cell = { model: "codex", groupId: "tier-correctness", group: { id: "tier-correctness", lenses: ["correctness", "concurrency_resources", "security_secrets"] }, file: "a.mjs", chunk: 0, chunkData: { text: "x", index: 0, total: 1, startLine: 1, endLine: 1 } };
  const r = await review(cell);
  assert.equal(r.findings[0].lens, "security_secrets", "category security → security_secrets (in the group), not lenses[0]");
});

test("OpenRouter: a cell whose model is a configured OR seat routes to the OpenRouter runner", async () => {
  const orBackends = { openrouter: { available: true, seats: [{ id: "or-x", model: "vendor/model" }] } };
  let seenId = null;
  const review = makeCellReviewer("/x", orBackends, {}, {
    runOpenRouter: async (cwd, b, o, p, id) => { seenId = id; return { status: 0, stdout: '{"agent":"or-x","findings":[{"severity":"P1","title":"t","detail":"d"}]}' }; }
  });
  const cell = { model: "or-x", groupId: "g", group: { id: "g", lenses: ["correctness"] }, file: "a.mjs", chunk: 0, chunkData: { text: "x", index: 0, total: 1, startLine: 1, endLine: 1 } };
  const r = await review(cell);
  assert.equal(seenId, "or-x", "the OpenRouter seat runner was invoked for its cell");
  assert.equal(r.ok, true);
  assert.equal(r.findings[0].file, "a.mjs", "OR findings get the same cell stamping as built-in seats");
});

test("B4 (council grok-4): enumerateCells threads per-file static facts onto each cell + into the prompt", async () => {
  const cells = enumerateCells(
    ["a.mjs"],
    [{ id: "g", lenses: ["correctness"], focus: "logic" }],
    ["codex"],
    () => [{ text: "x", index: 0, total: 1, startLine: 1, endLine: 1 }],
    (f) => `loc=42 hotspot=9 for ${f}`
  );
  assert.equal(cells[0].facts, "loc=42 hotspot=9 for a.mjs");
  let seen = "";
  const review = makeCellReviewer("/x", {}, {}, { runCodex: async (p) => { seen = p; return { status: 0, stdout: '{"agent":"codex","findings":[]}' }; } });
  await review(cells[0]);
  assert.match(seen, /loc=42 hotspot=9/, "the static facts reach the group prompt");
});
