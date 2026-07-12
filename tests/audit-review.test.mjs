import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalizeUnitFile, globalReduce, makeBudget, reviewUnit, runAuditReview } from "../plugins/council/scripts/lib/audit-review.mjs";
import { buildCodebaseModel } from "../plugins/council/scripts/lib/codebase-model.mjs";

// A2 — the SSOT/architecture global reduce and the per-unit merge must honor the DYNAMIC seat
// registry. Both used to be quietly codex/grok-shaped: globalReduce dispatched exactly ONE of them
// (so a claude-only or or-*-only config never reduced at all), and reviewUnit stamped the unit onto a
// finding only AFTER mergeFindings, so a seat that answered file:null / a bare basename could never
// match a peer and the same defect stayed two "unique" findings. Everything here is injected (deps.*)
// — no CLI, no network.

const OK = (payload) => ({ status: 0, stdout: JSON.stringify(payload), stderr: "", skipped: false });
const DOC = (findings) => ({ agent: "seat", summary: "s", verdict: "request_changes", findings });
const F = (over = {}) => ({ id: "f-1", severity: "P1", category: "bug", title: "t", detail: "d", file: null, line: null, confidence: 0.8, ...over });

const MAP_MODEL = {
  files: [],
  dupClusters: [{ lineCount: 8, locations: [{ file: "a.mjs", startLine: 1 }, { file: "b.mjs", startLine: 4 }] }],
  graph: { cycles: [["a.mjs", "b.mjs"]], orphans: [{ id: "o.mjs" }] }
};

const CLAUDE_ONLY = { codex: { companionAvailable: false }, grok: { cli: { available: false } }, claude: { cli: { available: true } } };
const OR_ONLY = {
  codex: { companionAvailable: false },
  grok: { cli: { available: false } },
  claude: { cli: { available: false } },
  openrouter: { available: true, seats: [{ id: "or-glm", model: "z-ai/glm-4.6" }] }
};
const THREE = { codex: { companionAvailable: true }, grok: { cli: { available: true } }, claude: { cli: { available: true } } };
const NONE = { codex: { companionAvailable: false }, grok: { cli: { available: false } }, claude: { cli: { available: false } } };

// --- globalReduce: the dynamic seat registry ---------------------------------

test("globalReduce runs on a CLAUDE-ONLY backend (the codex/grok hardcode skipped the reduce entirely)", async () => {
  const seen = [];
  const deps = {
    runClaude: async (prompt) => {
      seen.push(prompt);
      return OK(DOC([F({ category: "ssot", title: "retry helper duplicated across two modules", file: "a.mjs" })]));
    }
  };
  const budget = makeBudget(5);
  const out = await globalReduce("/x", CLAUDE_ONLY, {}, MAP_MODEL, budget, deps);
  assert.equal(out.ran, true, "a claude-only config must still get its SSOT/architecture reduce");
  assert.equal(seen.length, 1, "the claude seat was dispatched");
  assert.match(seen[0], /BEGIN MAP/, "it got the map prompt, not a unit prompt");
  assert.equal(out.all.length, 1);
  assert.deepEqual(out.all[0].agents, ["claude"]);
  assert.equal(budget.spent, 1, "one charge per dispatched seat");
});

test("globalReduce runs on an OpenRouter seat (a configured, paid seat is never dropped)", async () => {
  const seats = [];
  const deps = {
    runOpenRouter: async (_cwd, _backends, _options, prompt, seatId) => {
      seats.push({ seatId, prompt });
      return OK(DOC([F({ category: "architecture", title: "layering violation: lib imports the CLI" })]));
    }
  };
  const budget = makeBudget(5);
  const out = await globalReduce("/x", OR_ONLY, {}, MAP_MODEL, budget, deps);
  assert.equal(out.ran, true, "an or-* only config still reduces");
  assert.deepEqual(seats.map((s) => s.seatId), ["or-glm"], "the OpenRouter seat itself ran the reduce");
  assert.match(seats[0].prompt, /BEGIN MAP/);
  assert.deepEqual(out.all[0].agents, ["or-glm"]);
  assert.equal(budget.spent, 1);
});

test("globalReduce is SIX-EYES: every active seat reduces, and a shared defect merges to ONE consensus finding", async () => {
  const calls = [];
  const shared = "duplicated retry helper should be consolidated";
  const mk = (seat, findings) => async () => {
    calls.push(seat);
    return OK(DOC(findings));
  };
  const deps = {
    runCodex: mk("codex", [F({ category: "ssot", title: shared, file: "a.mjs" })]),
    runGrok: mk("grok", [F({ id: "g-1", category: "ssot", title: shared, file: "a.mjs" })]),
    runClaude: mk("claude", [F({ id: "c-1", category: "architecture", title: "risky cycle between a and b", file: "b.mjs" })])
  };
  const budget = makeBudget(10);
  const out = await globalReduce("/x", THREE, {}, MAP_MODEL, budget, deps);
  assert.deepEqual(calls.sort(), ["claude", "codex", "grok"], "all three built-in seats reduce, not just one");
  assert.equal(budget.spent, 3, "one charge per dispatched seat");
  assert.equal(out.consensus.length, 1, "codex+grok saw the same SSOT break → consensus (the same mergeFindings path)");
  assert.deepEqual(out.consensus[0].agents.sort(), ["codex", "grok"]);
  assert.equal(out.unique.length, 1, "claude's solo structural finding stays unique, not dropped");
  assert.equal(out.all.length, 2);
});

test("globalReduce dispatches only the seats the remaining budget covers (never over-spends)", async () => {
  const calls = [];
  const mk = (seat) => async () => {
    calls.push(seat);
    return OK(DOC([F({ title: `structural note from ${seat}` })]));
  };
  const budget = makeBudget(2);
  const out = await globalReduce("/x", THREE, {}, MAP_MODEL, budget, { runCodex: mk("codex"), runGrok: mk("grok"), runClaude: mk("claude") });
  assert.deepEqual(calls.sort(), ["codex", "grok"], "registry order: the seats the budget affords");
  assert.equal(budget.spent, 2, "never charges more than the budget holds");
  assert.equal(out.ran, true);
});

test("globalReduce charges nothing when no seat is callable, or when the budget is exhausted", async () => {
  let calls = 0;
  const spy = async () => {
    calls += 1;
    return OK(DOC([]));
  };
  const b1 = makeBudget(5);
  const noSeats = await globalReduce("/x", NONE, {}, MAP_MODEL, b1, { runCodex: spy, runGrok: spy, runClaude: spy });
  assert.equal(noSeats.ran, false);
  assert.equal(b1.spent, 0, "no callable seat → nothing charged");

  const b2 = makeBudget(0);
  const broke = await globalReduce("/x", THREE, {}, MAP_MODEL, b2, { runCodex: spy, runGrok: spy, runClaude: spy });
  assert.equal(broke.ran, false);
  assert.equal(b2.spent, 0, "exhausted budget → nothing charged");
  assert.equal(calls, 0, "and no agent was ever dispatched");
});

test("globalReduce fails CLOSED: every seat erroring reports ran:false, never a silent 'reduce found nothing'", async () => {
  const boom = async () => ({ status: 1, stdout: "", stderr: "backend down", skipped: false });
  const budget = makeBudget(6);
  const out = await globalReduce("/x", THREE, {}, MAP_MODEL, budget, { runCodex: boom, runGrok: boom, runClaude: boom });
  assert.equal(out.ran, false, "a dead bench must surface as a SKIPPED reduce, not an empty clean one");
  assert.deepEqual(out.all, []);
});

test("globalReduce honors seat skips (skipCodex/skipClaude/skipOpenRouter) via the shared registry", async () => {
  const calls = [];
  const mk = (seat) => async () => {
    calls.push(seat);
    return OK(DOC([]));
  };
  const budget = makeBudget(10);
  await globalReduce("/x", THREE, { skipCodex: true, skipClaude: true }, MAP_MODEL, budget, {
    runCodex: mk("codex"),
    runGrok: mk("grok"),
    runClaude: mk("claude")
  });
  assert.deepEqual(calls, ["grok"], "a skipped seat is never dispatched");
  assert.equal(budget.spent, 1);
});

// --- reviewUnit: canonicalize the file BEFORE the merge ----------------------

test("canonicalizeUnitFile maps null/basename/./-prefixed/backslashed/absolute onto the unit, but keeps a different file", () => {
  const unit = "lib/deep/x.mjs";
  assert.equal(canonicalizeUnitFile(null, unit), unit, "null → the reviewed unit");
  assert.equal(canonicalizeUnitFile("", unit), unit);
  assert.equal(canonicalizeUnitFile("x.mjs", unit), unit, "a bare basename is the unit (the seat saw only it)");
  assert.equal(canonicalizeUnitFile("./lib/deep/x.mjs", unit), unit);
  assert.equal(canonicalizeUnitFile("lib\\deep\\x.mjs", unit), unit, "windows separators");
  assert.equal(canonicalizeUnitFile("C:/repo/lib/deep/x.mjs", unit), unit, "an absolute path carrying the unit id");
  assert.equal(canonicalizeUnitFile("deep/x.mjs", unit), unit, "a partial path suffix");
  assert.equal(canonicalizeUnitFile("other/y.mjs", unit), "other/y.mjs", "a genuinely different file is never laundered onto the unit");
  assert.equal(canonicalizeUnitFile("utils/index.mjs", "lib/index.mjs"), "utils/index.mjs", "same basename, different module → kept apart");
});

function unitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-a2-"));
  fs.mkdirSync(path.join(dir, "lib", "deep"), { recursive: true });
  fs.writeFileSync(path.join(dir, "lib", "deep", "x.mjs"), "export function retry(){ while(true){} }\n");
  return dir;
}

test("reviewUnit: the SAME defect reported with file:null and a bare basename merges to ONE consensus finding", async () => {
  const dir = unitFixture();
  const unit = "lib/deep/x.mjs";
  const title = "unbounded loop in the retry helper never terminates";
  const deps = {
    runCodex: async () => OK(DOC([F({ id: "cx-1", title, file: null })])),
    runGrok: async () => OK(DOC([F({ id: "gk-1", title, file: "x.mjs" })])),
    runClaude: async () => OK(DOC([F({ id: "cl-1", title, file: "./lib/deep/x.mjs" })]))
  };
  const out = await reviewUnit(dir, THREE, {}, unit, { files: [] }, makeBudget(10), deps);
  assert.equal(out.reviewed, true);
  assert.equal(out.merged.all.length, 1, "one defect, one finding — not three 'unique' single-agent copies");
  assert.equal(out.merged.consensus.length, 1, "cross-seat consensus can finally match");
  assert.deepEqual(out.merged.all[0].agents.sort(), ["claude", "codex", "grok"]);
  assert.equal(out.merged.all[0].file, unit, "the merged finding carries the canonical unit id");
});

test("reviewUnit: an OpenRouter seat's sloppy file:null still joins a built-in's consensus", async () => {
  const dir = unitFixture();
  const unit = "lib/deep/x.mjs";
  const title = "unbounded loop in the retry helper never terminates";
  const backends = { ...THREE, openrouter: { available: true, seats: [{ id: "or-glm", model: "z-ai/glm-4.6" }] } };
  const deps = {
    runCodex: async () => OK(DOC([F({ id: "cx-1", title, file: unit })])),
    runGrok: async () => OK(DOC([])),
    runClaude: async () => OK(DOC([])),
    runOpenRouter: async () => OK(DOC([F({ id: "or-1", title, file: null })]))
  };
  const out = await reviewUnit(dir, backends, {}, unit, { files: [] }, makeBudget(10), deps);
  assert.equal(out.merged.all.length, 1);
  assert.deepEqual(out.merged.all[0].agents.sort(), ["codex", "or-glm"], "the or-* seat's finding is not orphaned by a missing file");
  assert.equal(out.merged.consensus.length, 1);
});

test("reviewUnit: a finding about ANOTHER file keeps its own path (no laundering onto the unit)", async () => {
  const dir = unitFixture();
  const unit = "lib/deep/x.mjs";
  const deps = {
    runCodex: async () => OK(DOC([F({ id: "cx-1", title: "caller in other module passes a null handle", file: "other/y.mjs" })])),
    runGrok: async () => OK(DOC([])),
    runClaude: async () => OK(DOC([]))
  };
  const out = await reviewUnit(dir, THREE, {}, unit, { files: [] }, makeBudget(10), deps);
  assert.equal(out.merged.all.length, 1);
  assert.equal(out.merged.all[0].file, "other/y.mjs", "a cross-file observation keeps its real location");
});

// --- runAuditReview: end to end, reserve matches the real reduce spend --------

function repoFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-a2-repo-"));
  fs.writeFileSync(path.join(dir, "a.mjs"), 'import { help } from "./b.mjs";\nexport function main(){ return help(); }\n');
  fs.writeFileSync(path.join(dir, "b.mjs"), "export function help(){ return 42; }\n");
  return dir;
}

test("runAuditReview: a CLAUDE-ONLY bench still reviews units AND runs the global reduce", async () => {
  const dir = repoFixture();
  const model = buildCodebaseModel(dir);
  const prompts = [];
  const deps = {
    runClaude: async (prompt) => {
      prompts.push(prompt);
      return OK(DOC([F({ title: `finding ${prompts.length} from the claude seat` })]));
    }
  };
  const out = await runAuditReview(dir, model, CLAUDE_ONLY, { budget: 6, maxUnits: 2, ledger: false, verifyAudit: false }, deps);
  assert.equal(out.coverage.reduceRan, true, "the reduce is no longer codex/grok-only");
  assert.equal(out.coverage.unitsReviewed, 2);
  assert.equal(out.coverage.budgetSpent, 3, "2 unit calls + 1 reduce call — the reserve strands nothing");
  assert.equal(out.coverage.reviewers.claude, true);
  assert.ok(prompts.some((p) => p.includes("BEGIN MAP")), "one of the claude calls WAS the map reduce");
});

test("runAuditReview: with the three built-ins the reduce costs one call per seat and the reserve matches it exactly", async () => {
  const dir = repoFixture();
  const model = buildCodebaseModel(dir);
  const calls = { codex: 0, grok: 0, claude: 0 };
  const mk = (seat) => async () => {
    calls[seat] += 1;
    return OK(DOC([F({ title: `${seat} finding ${calls[seat]}` })]));
  };
  // budget 7, cost/unit 3, reserve 3 → exactly ONE unit (3) + the six-eyed reduce (3) = 6 spent.
  const out = await runAuditReview(dir, model, THREE, { budget: 7, maxUnits: 2, ledger: false, verifyAudit: false }, { runCodex: mk("codex"), runGrok: mk("grok"), runClaude: mk("claude") });
  assert.equal(out.coverage.unitsReviewed, 1, "the reserve keeps exactly enough budget back for the reduce");
  assert.equal(out.coverage.reduceRan, true);
  assert.equal(out.coverage.budgetSpent, 6, "3 (unit) + 3 (reduce, one per seat)");
  assert.deepEqual(calls, { codex: 2, grok: 2, claude: 2 }, "every seat ran BOTH the unit review and the reduce");
});

test("runAuditReview: skipReduce reserves nothing (no stranded charge) and dispatches no reduce", async () => {
  const dir = repoFixture();
  const model = buildCodebaseModel(dir);
  const prompts = [];
  const deps = {
    runClaude: async (prompt) => {
      prompts.push(prompt);
      return OK(DOC([]));
    }
  };
  const out = await runAuditReview(dir, model, CLAUDE_ONLY, { budget: 2, maxUnits: 5, skipReduce: true, ledger: false, verifyAudit: false }, deps);
  assert.equal(out.coverage.reduceRan, false);
  assert.equal(out.coverage.budgetSpent, 2, "the whole budget goes to units when the reduce is skipped");
  assert.ok(!prompts.some((p) => p.includes("BEGIN MAP")), "no map prompt was dispatched");
});
