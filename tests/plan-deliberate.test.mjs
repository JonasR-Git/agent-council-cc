import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildCritiquePrompt,
  buildProposalPrompt,
  buildSynthesisPrompt,
  parseCritiqueBatch,
  runPlanDeliberation,
  synthesizePlanSpec
} from "../plugins/council/scripts/lib/plan-deliberate.mjs";
import { requestDigest } from "../plugins/council/scripts/lib/plan-spec.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "council-plan-"));
const REQUEST = "Add a --json flag to the report command.";
const HEAD = "abc123def4567890abc123def4567890abc123de";

/** All three CLI seats reachable, plus optional OpenRouter seats (mirrors solve.test.mjs). */
function seatBackends(orSeatIds = []) {
  return {
    codex: { companionAvailable: true, companion: "companion.mjs" },
    grok: { cli: { available: true }, bin: "grok" },
    claude: { cli: { available: true }, bin: "claude" },
    openrouter: orSeatIds.length
      ? { available: true, seats: orSeatIds.map((id) => ({ id, model: `vendor/${id}` })) }
      : undefined
  };
}

function planJson(agent, extra = {}) {
  return JSON.stringify({
    agent,
    summary: `${agent}'s design`,
    approach: "small incremental steps",
    steps: [{ n: 1, title: "step", detail: "do it", files: ["lib/report.mjs"] }],
    risks: [],
    tradeoffs: [],
    effort: "M",
    confidence: 0.8,
    ...extra
  });
}

function critiqueEntry(about, extra = {}) {
  return {
    about,
    summary: "ok",
    scores: { feasibility: 4, risk: 3, simplicity: 4, completeness: 4 },
    overall: 7,
    blockers: [],
    improvements: [],
    ...extra
  };
}

function critiqueBatchJson(critic, abouts) {
  return JSON.stringify({ agent: critic, critiques: abouts.map((about) => critiqueEntry(about)) });
}

/** A frozen-contract PlanSpec reply whose binding fields are model-echoed GARBAGE on purpose. */
function planSpecJson(extra = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    request: "model-echoed request (must be ignored)",
    requestHash: "model-echoed-hash (must be ignored)",
    baseCommit: "model-echoed-sha (must be ignored)",
    steps: [
      {
        id: "add-json-flag",
        title: "Add --json flag",
        intent: "the report command gains a machine-readable mode",
        files: [
          { path: "lib/report.mjs", action: "edit", role: "source", intent: "add the flag" },
          { path: "tests/report-json.test.mjs", action: "create", role: "test", intent: "prove the flag" }
        ],
        test: { files: ["tests/report-json.test.mjs"], intent: "asserts the JSON output shape" },
        dependsOn: []
      }
    ],
    risks: [{ id: "r1", description: "output drift", mitigation: "schema test" }],
    testStrategy: { perStep: "full", final: "full" },
    ...extra
  });
}

const kindOf = (prompt) => {
  const p = String(prompt ?? "");
  if (/Round 3 — SYNTHESIS/.test(p)) return "synthesis";
  if (/Round 2 — PEER CRITIQUE/.test(p)) return "critique";
  return "proposal";
};

/**
 * Records every seat call and answers with a valid proposal (R1) / critique batch (R2) /
 * PlanSpec (R3). `stdoutFor(seat, kind, callNo)` can override any single reply: return a string
 * to replace the stdout, or an OBJECT to replace the whole runner result (failed runs etc.).
 * All side effects are injected: no CLI, no network, no git.
 */
function recordingDeps(calls, allSeats, stdoutFor = null) {
  const seen = new Map();
  const reply = (seat, prompt) => {
    const kind = kindOf(prompt);
    const callNo = (seen.get(`${seat}:${kind}`) ?? 0) + 1;
    seen.set(`${seat}:${kind}`, callNo);
    calls.push({ seat, kind, callNo, prompt: String(prompt) });
    const override = stdoutFor?.(seat, kind, callNo);
    if (override && typeof override === "object") return override; // full-result override
    let stdout = override;
    if (stdout == null) {
      if (kind === "proposal") stdout = planJson(seat);
      else if (kind === "critique") stdout = critiqueBatchJson(seat, allSeats.filter((s) => s !== seat));
      else stdout = planSpecJson();
    }
    return { status: 0, stdout, stderr: "", skipped: false };
  };
  return {
    head: () => HEAD,
    collectRepoHints: () => "## Files\nlib/report.mjs\n\n## README (head)\n(none)",
    validatePlanSpec: (spec) =>
      Array.isArray(spec?.steps) && spec.steps.length >= 1
        ? { valid: true, errors: [] }
        : { valid: false, errors: ["steps must be a non-empty array"] },
    runCodex: async (p) => reply("codex", p),
    runGrok: async (p) => reply("grok", p),
    runClaude: async (p) => reply("claude", p),
    runOpenRouter: async (_cwd, _backends, _options, p, seatId) => reply(seatId, p)
  };
}

// --- the deliberation protocol -----------------------------------------------------------------

test("every active seat proposes AND critiques (incl. an or-* OpenRouter seat); no seat critiques itself", async () => {
  const seats = ["codex", "grok", "claude", "or-x"];
  const calls = [];
  const run = await runPlanDeliberation(TMP, REQUEST, seatBackends(["or-x"]), {}, recordingDeps(calls, seats));

  for (const seat of seats) {
    assert.equal(calls.filter((c) => c.seat === seat && c.kind === "proposal").length, 1, `${seat} must propose`);
    assert.equal(calls.filter((c) => c.seat === seat && c.kind === "critique").length, 1, `${seat} must critique (one batched call)`);
  }
  assert.deepEqual(run.proposals.map((p) => p.agent).sort(), [...seats].sort());
  assert.equal(run.proposals.every((p) => p.parseOk), true);

  // All-to-all: N*(N-1) critiques, never self, and every plan is scored by the SAME pool
  // (all seats minus its own author) so the ranking averages are comparable.
  assert.equal(run.critiques.length, seats.length * (seats.length - 1));
  assert.equal(run.critiques.filter((c) => c.agent === c.aboutAgent).length, 0, "no seat may critique itself");
  for (const seat of seats) {
    const critics = run.critiques.filter((c) => c.aboutAgent === seat).map((c) => c.agent).sort();
    assert.deepEqual(critics, seats.filter((s) => s !== seat).sort());
  }
  assert.deepEqual([...new Set(run.ranking.map((r) => r.votes))], [seats.length - 1]);

  // Happy path spends EXACTLY the mandatory 2N+1 calls: N proposals + N critiques + 1 synthesis.
  assert.equal(run.budget.spent, 2 * seats.length + 1);
  assert.ok(run.planSpec, "a valid synthesis emits a PlanSpec");
});

test("R1 identity is runner-bound: a lying model-echoed `agent` field is ignored", async () => {
  const seats = ["codex", "grok", "claude"];
  const calls = [];
  // codex claims to be grok; trusting the echo would let codex critique/score its OWN proposal.
  const deps = recordingDeps(calls, seats, (seat, kind) => (seat === "codex" && kind === "proposal" ? planJson("grok") : null));
  const run = await runPlanDeliberation(TMP, REQUEST, seatBackends(), {}, deps);

  assert.deepEqual(run.proposals.map((p) => p.agent).sort(), ["claude", "codex", "grok"]);
  assert.equal(run.critiques.filter((c) => c.agent === c.aboutAgent).length, 0, "self-critique exclusion holds");
  assert.equal(run.critiques.filter((c) => c.aboutAgent === "codex").length, 2);
});

test("a lying critique entry (about = the critic itself, or an uninvited seat) is dropped, not honored", async () => {
  const seats = ["codex", "grok", "claude"];
  const calls = [];
  // grok's batch tries to score itself and an uninvited "mallory" alongside the legit entries.
  const lyingBatch = JSON.stringify({
    agent: "claude", // lying agent echo too — identity stays runner-bound to grok
    critiques: [
      critiqueEntry("grok", { overall: 10 }),
      critiqueEntry("mallory"),
      critiqueEntry("codex"),
      critiqueEntry("claude")
    ]
  });
  const deps = recordingDeps(calls, seats, (seat, kind) => (seat === "grok" && kind === "critique" ? lyingBatch : null));
  const run = await runPlanDeliberation(TMP, REQUEST, seatBackends(), {}, deps);

  const fromGrok = run.critiques.filter((c) => c.agent === "grok");
  assert.deepEqual(fromGrok.map((c) => c.aboutAgent).sort(), ["claude", "codex"]);
  assert.equal(run.critiques.filter((c) => c.aboutAgent === "grok" && c.agent === "grok").length, 0);
  assert.equal(run.critiques.some((c) => c.aboutAgent === "mallory"), false);
});

test("parseCritiqueBatch: coverage-incomplete batches keep valid entries but flag parseOk=false for repair", () => {
  const batch = parseCritiqueBatch(critiqueBatchJson("grok", ["grok", "codex"]), "grok", ["codex", "claude"]);
  assert.equal(batch.agent, "grok");
  assert.equal(batch.parseOk, false, "claude is missing -> incomplete -> repairable");
  assert.deepEqual(batch.critiques.map((c) => c.aboutAgent), ["codex"], "the self-entry is dropped, the valid one kept");

  const garbage = parseCritiqueBatch("no json at all", "grok", ["codex"]);
  assert.equal(garbage.parseOk, false);
  assert.deepEqual(garbage.critiques, []);

  const dupes = parseCritiqueBatch(
    JSON.stringify({ critiques: [critiqueEntry("codex", { overall: 2 }), critiqueEntry("codex", { overall: 9 })] }),
    "grok",
    ["codex"]
  );
  assert.equal(dupes.parseOk, true);
  assert.equal(dupes.critiques.length, 1, "one critique per about — the first wins");
  assert.equal(dupes.critiques[0].overall, 2);
});

test("a malformed R1 proposal is repaired by the retry, not silently lost", async () => {
  const seats = ["codex", "grok", "claude"];
  const calls = [];
  const deps = recordingDeps(calls, seats, (seat, kind, callNo) =>
    seat === "grok" && kind === "proposal" && callNo === 1 ? "sorry, prose instead of JSON" : null
  );
  const run = await runPlanDeliberation(TMP, REQUEST, seatBackends(), {}, deps);

  assert.equal(calls.filter((c) => c.seat === "grok" && c.kind === "proposal").length, 2, "R1 retried once");
  assert.equal(run.proposals.find((p) => p.agent === "grok")?.parseOk, true, "the repaired proposal is kept");
  assert.ok(
    run.ranking.some((r) => r.agent === "grok" && r.votes === 2),
    "and the repaired proposal still gets its full peer-critique pool"
  );
});

test("a partially-valid critique batch keeps its delivered critiques, but incomplete R2 VETOES the synthesis", async () => {
  const seats = ["codex", "grok", "claude"];
  const calls = [];
  // claude's first batch covers only codex (incomplete -> repair retry); the retry is garbage.
  // The first reply's valid critique must survive — a retry never deletes evidence — but an
  // incomplete critic must fail the run CLOSED: no synthesis, no PlanSpec, a loud report.
  const deps = recordingDeps(calls, seats, (seat, kind, callNo) => {
    if (seat !== "claude" || kind !== "critique") return null;
    return callNo === 1 ? critiqueBatchJson("claude", ["codex"]) : "garbage retry";
  });
  const run = await runPlanDeliberation(TMP, REQUEST, seatBackends(), {}, deps);

  assert.equal(calls.filter((c) => c.seat === "claude" && c.kind === "critique").length, 2, "one repair retry");
  const fromClaude = run.critiques.filter((c) => c.agent === "claude");
  assert.deepEqual(fromClaude.map((c) => c.aboutAgent), ["codex"], "the delivered critique survived the failed repair");
  assert.equal(run.planSpec, null, "incomplete peer review must never emit a PlanSpec");
  assert.equal(calls.filter((c) => c.kind === "synthesis").length, 0, "the synthesis is withheld, not dispatched");
  assert.match(run.synthesis.errors.join(" "), /R2 peer critique incomplete/);
  assert.match(run.synthesis.errors.join(" "), /claude delivered 1\/2/);
  assert.match(run.report, /FAILED CLOSED/);
});

test("an R2 seat failure (timeout) VETOES the synthesis — its stdout is never parsed, delivered critiques survive", async () => {
  const seats = ["codex", "grok", "claude"];
  const calls = [];
  // grok's critique call times out WITH parseable stdout: a dead seat's partial output is not
  // evidence, and the missing critic must veto the synthesis rather than become a silent skip.
  const deps = recordingDeps(calls, seats, (seat, kind) =>
    seat === "grok" && kind === "critique"
      ? { status: 1, timedOut: true, skipped: false, stdout: critiqueBatchJson("grok", ["codex", "claude"]), stderr: "" }
      : null
  );
  const run = await runPlanDeliberation(TMP, REQUEST, seatBackends(), {}, deps);

  assert.equal(run.planSpec, null);
  assert.equal(calls.filter((c) => c.kind === "synthesis").length, 0, "no synthesizer call after an incomplete R2");
  assert.match(run.synthesis.errors.join(" "), /grok delivered 0\/2/);
  assert.equal(run.critiques.filter((c) => c.agent === "grok").length, 0, "the timed-out run's stdout is never parsed");
  assert.equal(run.critiques.length, 4, "the other critics' delivered critiques stay in the record");
  assert.match(run.report, /FAILED CLOSED/);
});

test("R1 incompleteness fails closed BEFORE R2: one seat unparseable after repair aborts the whole run", async () => {
  const seats = ["codex", "grok", "claude"];
  const calls = [];
  // grok's proposal is prose on the initial call AND on the repair retry — with only the other
  // two voices left, the deliberation is no longer the every-active-seat protocol.
  const deps = recordingDeps(calls, seats, (seat, kind) =>
    seat === "grok" && kind === "proposal" ? "prose, not JSON, every time" : null
  );
  await assert.rejects(
    runPlanDeliberation(TMP, REQUEST, seatBackends(), {}, deps),
    /R1 incomplete — no usable proposal from seat\(s\): grok/
  );
  assert.equal(calls.filter((c) => c.kind === "critique").length, 0, "R2 must not spend after an incomplete R1");
  assert.equal(calls.filter((c) => c.kind === "synthesis").length, 0);
});

test("a FAILED R1 run's stdout is never parsed into a proposal, even when it would parse", async () => {
  const seats = ["codex", "grok", "claude"];
  const calls = [];
  const deps = recordingDeps(calls, seats, (seat, kind) =>
    seat === "grok" && kind === "proposal"
      ? { status: 1, timedOut: false, skipped: false, stdout: planJson("grok"), stderr: "" }
      : null
  );
  await assert.rejects(runPlanDeliberation(TMP, REQUEST, seatBackends(), {}, deps), /R1 incomplete/);
});

// --- the R3 synthesis ---------------------------------------------------------------------------

test("a valid synthesis emits the PlanSpec with RUNNER-computed binding fields (model echoes ignored)", async () => {
  const seats = ["codex", "grok", "claude"];
  const calls = [];
  const run = await runPlanDeliberation(TMP, REQUEST, seatBackends(), {}, recordingDeps(calls, seats));

  assert.ok(run.planSpec);
  assert.equal(run.planSpec.request, REQUEST, "the ORIGINAL request, not the model echo");
  assert.equal(run.planSpec.requestHash, requestDigest(REQUEST), "hash binding = plan-spec's own digest");
  assert.equal(run.planSpec.baseCommit, HEAD, "the resolved head, not the model echo");
  assert.equal(run.planSpec.schemaVersion, 1);
  // The synthesizer defaults to the claude seat.
  const synth = calls.filter((c) => c.kind === "synthesis");
  assert.equal(synth.length, 1);
  assert.equal(synth[0].seat, "claude");
  assert.match(run.report, /PlanSpec synthesized/);
});

test("an INVALID synthesis retries once with the validation errors appended, then fails CLOSED", async () => {
  const seats = ["codex", "grok", "claude"];
  const calls = [];
  const deps = recordingDeps(calls, seats);
  deps.validatePlanSpec = () => ({ valid: false, errors: ["steps[0].id must be kebab-case"] });
  const run = await runPlanDeliberation(TMP, REQUEST, seatBackends(), {}, deps);

  const synth = calls.filter((c) => c.kind === "synthesis");
  assert.equal(synth.length, 2, "exactly one validation retry");
  assert.match(synth[1].prompt, /steps\[0\]\.id must be kebab-case/, "the retry carries the validation errors");
  assert.equal(run.planSpec, null, "no PlanSpec is emitted rather than an invalid one");
  assert.deepEqual(run.synthesis.errors, ["steps[0].id must be kebab-case"]);
  assert.match(run.report, /FAILED CLOSED — no PlanSpec emitted/);
});

test("a THROWING validator counts as invalid (fail closed), never as an approval", async () => {
  const seats = ["codex", "grok", "claude"];
  const calls = [];
  const deps = recordingDeps(calls, seats);
  deps.validatePlanSpec = () => {
    throw new Error("validator exploded");
  };
  const run = await runPlanDeliberation(TMP, REQUEST, seatBackends(), {}, deps);
  assert.equal(run.planSpec, null);
  assert.match(run.synthesis.errors.join(" "), /validator exploded/);
});

test("a FAILED synthesizer run (timeout/skipped) is NEVER parsed into a PlanSpec, even when its stdout validates", async () => {
  for (const bad of [
    { status: 1, timedOut: true, skipped: false, stdout: planSpecJson(), stderr: "" },
    { status: 0, timedOut: false, skipped: true, stdout: planSpecJson(), stderr: "" }
  ]) {
    let dispatches = 0;
    const out = await synthesizePlanSpec({
      runner: async () => {
        dispatches += 1;
        return bad;
      },
      request: REQUEST,
      requestHash: "h",
      baseCommit: "c",
      validatePlanSpec: () => ({ valid: true, errors: [] })
    });
    assert.equal(out.planSpec, null, "a failed run's output must not become a PlanSpec");
    assert.match(out.errors.join(" "), /timed out|skipped/i);
    assert.equal(dispatches, 2, "both bounded attempts ran, then failed closed");
  }
});

test("a validator answering bare `true` is an unrecognized result — fail closed, no normalization bypass", async () => {
  const out = await synthesizePlanSpec({
    runner: async () => ({ status: 0, timedOut: false, skipped: false, stdout: planSpecJson({ evilExtraKey: "x" }), stderr: "" }),
    request: REQUEST,
    requestHash: "h",
    baseCommit: "c",
    validatePlanSpec: async () => true
  });
  assert.equal(out.planSpec, null, "a bare-boolean approval must not bless the raw model object");
  assert.match(out.errors.join(" "), /unrecognized result/);
});

test("synthesizePlanSpec fails closed without dispatching when the budget cannot afford the call", async () => {
  const noBudget = { total: 0, spent: 0, canSpend: () => false, charge: () => {} };
  let dispatched = false;
  const out = await synthesizePlanSpec({
    runner: async () => {
      dispatched = true;
      return { status: 0, stdout: planSpecJson(), skipped: false };
    },
    request: REQUEST,
    requestHash: "h",
    baseCommit: "c",
    budget: noBudget,
    validatePlanSpec: () => ({ valid: true, errors: [] })
  });
  assert.equal(dispatched, false, "an unaffordable call is never dispatched");
  assert.equal(out.planSpec, null);
  assert.match(out.errors.join(" "), /unaffordable|budget/i);
});

test("the synthesizer seat is overridable; an inactive synthesizer fails closed", async () => {
  const seats = ["codex", "grok", "claude"];
  const calls = [];
  const run = await runPlanDeliberation(TMP, REQUEST, seatBackends(), { synthesizer: "grok" }, recordingDeps(calls, seats));
  const synth = calls.filter((c) => c.kind === "synthesis");
  assert.deepEqual(synth.map((c) => c.seat), ["grok"]);
  assert.ok(run.planSpec);

  await assert.rejects(
    runPlanDeliberation(TMP, REQUEST, seatBackends(), { synthesizer: "or-nope" }, recordingDeps([], seats)),
    /synthesizer seat "or-nope" is not active/
  );
});

// --- fail-closed preflights ----------------------------------------------------------------------

test("budget preflight fails closed BEFORE any seat call when 2N+1 mandatory calls are uncovered", async () => {
  const calls = [];
  // 3 active seats -> mandatory 7; a budget of 6 must be rejected up front.
  await assert.rejects(
    runPlanDeliberation(TMP, REQUEST, seatBackends(), { budget: 6 }, recordingDeps(calls, ["codex", "grok", "claude"])),
    /budget 6 cannot cover the mandatory 7 calls/
  );
  assert.equal(calls.length, 0, "no seat may be dispatched");
});

test("R1 repair spend can never overrun the hard budget: unaffordable mandatory R2 calls are withheld and VETO", async () => {
  const seats = ["codex", "grok", "claude"];
  const calls = [];
  // budget=7 (exactly the mandatory 2N+1). Every initial R1 reply is malformed and every repair
  // succeeds: R1 spends 6 of 7. Only ONE mandatory R2 call is still affordable — the other two
  // must be withheld (spent must NEVER exceed total) and must veto the synthesis, fail closed.
  const deps = recordingDeps(calls, seats, (seat, kind, callNo) =>
    kind === "proposal" && callNo === 1 ? "malformed prose" : null
  );
  const run = await runPlanDeliberation(TMP, REQUEST, seatBackends(), { budget: 7 }, deps);

  assert.ok(
    run.budget.spent <= run.budget.total,
    `spent (${run.budget.spent}) must never exceed the declared total (${run.budget.total})`
  );
  assert.equal(run.planSpec, null);
  assert.match(run.synthesis.errors.join(" "), /budget exhausted before this mandatory critique call/);
  assert.equal(calls.filter((c) => c.kind === "synthesis").length, 0);
});

test("an empty request and a sub-2-seat council both fail closed before any call", async () => {
  const calls = [];
  const deps = recordingDeps(calls, ["codex"]);
  await assert.rejects(runPlanDeliberation(TMP, "   ", seatBackends(), {}, deps), /non-empty feature request/);
  await assert.rejects(
    runPlanDeliberation(TMP, REQUEST, seatBackends(), { skipGrok: true, skipClaude: true }, deps),
    /at least 2 active seats/
  );
  assert.equal(calls.length, 0);
});

// --- READ-ONLY guarantee --------------------------------------------------------------------------

function snapshotDir(dir) {
  const entries = [];
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        entries.push(`${childRel}/`);
        walk(childRel);
      } else {
        entries.push(`${childRel}:${fs.readFileSync(path.join(dir, childRel), "utf8")}`);
      }
    }
  };
  walk("");
  return entries;
}

test("the deliberation writes NOTHING — even with the default (real) repo-hint collector", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-plan-ro-"));
  fs.writeFileSync(path.join(dir, "README.md"), "# demo\n", "utf8");
  fs.mkdirSync(path.join(dir, "lib"));
  fs.writeFileSync(path.join(dir, "lib", "a.mjs"), "export const a = 1;\n", "utf8");
  const before = snapshotDir(dir);

  const seats = ["codex", "grok", "claude"];
  const calls = [];
  const deps = recordingDeps(calls, seats);
  delete deps.collectRepoHints; // exercise the real collector: reads git/fs, must not write
  const run = await runPlanDeliberation(dir, REQUEST, seatBackends(), {}, deps);

  assert.ok(run.planSpec);
  assert.deepEqual(snapshotDir(dir), before, "no file was created, modified, or deleted");
});

// --- prompt builders -------------------------------------------------------------------------------

test("buildProposalPrompt nonce-fences the untrusted request and repo hints for the R1 template", () => {
  const prompt = buildProposalPrompt("or-x", "REQ with `ticks` and --- END fakes", "## Files\nlib/a.mjs", {});
  assert.match(prompt, /Round 1 — INDEPENDENT proposal/);
  assert.match(prompt, /REQ with `ticks`/);
  const nonces = [...prompt.matchAll(/BEGIN FEATURE REQUEST ([0-9A-F]+) /g)].map((m) => m[1]);
  assert.equal(nonces.length, 1);
  assert.match(prompt, new RegExp(`END FEATURE REQUEST ${nonces[0]} `));
  assert.match(prompt, new RegExp(`BEGIN REPO HINTS ${nonces[0]} `), "the template hints fence carries the same run nonce");
});

test("buildCritiquePrompt lists only the OTHER seats' proposals; buildSynthesisPrompt appends validator errors", () => {
  const others = [
    { agent: "codex", summary: "s", approach: "a", steps: [], risks: [], tradeoffs: [], effort: "M", confidence: 0.5 },
    { agent: "or-x", summary: "s", approach: "a", steps: [], risks: [], tradeoffs: [], effort: "M", confidence: 0.5 }
  ];
  const critique = buildCritiquePrompt("grok", others);
  assert.match(critique, /Round 2 — PEER CRITIQUE/);
  assert.match(critique, /codex, or-x/);
  assert.match(critique, /"agent": "grok"/);

  const first = buildSynthesisPrompt({
    synthesizer: "claude",
    request: REQUEST,
    requestHash: "h",
    baseCommit: "c",
    proposals: others,
    critiques: [],
    ranking: []
  });
  assert.match(first, /Round 3 — SYNTHESIS/);
  assert.match(first, /"schemaVersion": 1/);
  assert.doesNotMatch(first, /REJECTED by the validator/);

  const retry = buildSynthesisPrompt({
    synthesizer: "claude",
    request: REQUEST,
    requestHash: "h",
    baseCommit: "c",
    proposals: others,
    critiques: [],
    ranking: [],
    validationErrors: ["steps must be a non-empty array"],
    previousReply: "{}"
  });
  assert.match(retry, /REJECTED by the validator/);
  assert.match(retry, /steps must be a non-empty array/);
});

// --- integration with the REAL plan-spec validator ------------------------------------------------

test("end-to-end with plan-spec's REAL validator: the default wiring supplies root + the mandatory fileExists probe", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-plan-real-"));
  // The synthesized step edits lib/report.mjs (must exist) and creates tests/report-json.test.mjs
  // (must be absent) — plan-spec verifies both against the tree via the injected lstat probe.
  fs.mkdirSync(path.join(dir, "lib"));
  fs.writeFileSync(path.join(dir, "lib", "report.mjs"), "export const x = 1;\n", "utf8");

  const seats = ["codex", "grok", "claude"];
  const calls = [];
  const deps = recordingDeps(calls, seats);
  delete deps.validatePlanSpec; // exercise the REAL fail-closed validator, not a test fake
  const run = await runPlanDeliberation(dir, REQUEST, seatBackends(), {}, deps);

  assert.ok(run.planSpec, `real validator must accept the compliant spec (errors: ${run.synthesis.errors.join("; ")})`);
  assert.equal(run.planSpec.requestHash, requestDigest(REQUEST), "the forced hash satisfies plan-spec's verification");
  assert.equal(run.planSpec.baseCommit, HEAD);
  assert.equal(run.planSpec.steps[0].id, "add-json-flag");

  // And the tree checks really bite: with the edit target missing, the same run FAILS CLOSED.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "council-plan-bare-"));
  const deps2 = recordingDeps([], seats);
  delete deps2.validatePlanSpec;
  const run2 = await runPlanDeliberation(bare, REQUEST, seatBackends(), {}, deps2);
  assert.equal(run2.planSpec, null, "edit of a nonexistent file must be rejected by the real validator");
});

test("the REAL validator rejects a synthesized step touching a PROTECTED path (.github/workflows) — fail closed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-plan-prot-"));
  const evil = planSpecJson({
    steps: [
      {
        id: "touch-ci",
        title: "Touch CI",
        intent: "sneak a workflow change past the plan gate",
        files: [
          { path: ".github/workflows/ci.yml", action: "create", role: "source", intent: "ci" },
          { path: "tests/ci.test.mjs", action: "create", role: "test", intent: "pin" }
        ],
        test: { files: ["tests/ci.test.mjs"], intent: "pin" },
        dependsOn: []
      }
    ]
  });
  const seats = ["codex", "grok", "claude"];
  const calls = [];
  const deps = recordingDeps(calls, seats, (_seat, kind) => (kind === "synthesis" ? evil : null));
  delete deps.validatePlanSpec; // the REAL fail-closed validator with the default root+lstat wiring

  const run = await runPlanDeliberation(dir, REQUEST, seatBackends(), {}, deps);
  assert.equal(run.planSpec, null, "a protected-path step must never survive synthesis");
  assert.match(run.synthesis.errors.join(" "), /protected path/);
  assert.equal(calls.filter((c) => c.kind === "synthesis").length, 2, "one validation retry, then fail closed");
});
