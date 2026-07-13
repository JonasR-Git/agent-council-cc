import test from "node:test";
import assert from "node:assert/strict";

import {
  applyDebateOutcomes,
  NO_REPLY_STANCE,
  normalizeStance,
  renderDebateSection,
  runDebateRounds
} from "../plugins/council/scripts/lib/debate.mjs";

const SEAT_BACKENDS = {
  codex: { companionAvailable: true },
  grok: { cli: { available: true } },
  claude: { cli: { available: true } },
  openrouter: { available: true, seats: [{ id: "or-x", model: "vendor/model" }] }
};

function entry(id, author, critic = null) {
  return { id, author, critic, payload: { title: `t-${id}`, severity: "P1", detail: "d" } };
}

/** Injectable per-seat runners; each records that IT was the one asked. */
function seatDeps(calls, stdoutFor) {
  const reply = (seat, prompt) => {
    calls.push({ seat, prompt });
    return { agent: seat, status: 0, stdout: stdoutFor(seat, prompt) };
  };
  return {
    runCodex: async (p) => reply("codex", p),
    runGrok: async (p) => reply("grok", p),
    runClaude: async (p) => reply("claude", p),
    runOpenRouter: async (_cwd, _b, _o, p, seatId) => reply(seatId, p)
  };
}

test("normalizeStance defaults to defend", () => {
  assert.equal(normalizeStance("concede"), "concede");
  assert.equal(normalizeStance("REVISE"), "revise");
  assert.equal(normalizeStance("something else"), "defend");
  assert.equal(normalizeStance(null), "defend");
});

function mergedWith(item) {
  const all = [item];
  return {
    all,
    consensus: all.filter((i) => i.consensus),
    unique: all.filter((i) => !i.consensus),
    votes: []
  };
}

test("applyDebateOutcomes downgrades conceded items to nit and clears contested", () => {
  const merged = mergedWith({
    ids: ["codex-1"],
    agents: ["codex"],
    severity: "P1",
    consensus: false,
    contested: true
  });
  const debates = [{ id: "codex-1", agent: "codex", round: 1, stance: "concede", note: "you are right" }];
  const next = applyDebateOutcomes(merged, debates);
  assert.equal(next.all[0].severity, "nit");
  assert.equal(next.all[0].contested, false);
  assert.equal(next.all[0].debate.stance, "concede");
});

test("applyDebateOutcomes applies valid revised severity and attaches counters", () => {
  const merged = mergedWith({
    ids: ["grok-2"],
    agents: ["grok"],
    severity: "P0",
    consensus: false,
    contested: true
  });
  const debates = [
    { id: "grok-2", agent: "grok", round: 1, stance: "revise", note: "half right", revisedSeverity: "P2" },
    { id: "grok-2", agent: "codex", round: 2, upheld: true, note: "still an issue" }
  ];
  const next = applyDebateOutcomes(merged, debates);
  assert.equal(next.all[0].severity, "P2");
  assert.equal(next.all[0].debate.counter.upheld, true);
});

test("every debate agent argues on ITS OWN runner (no seat impersonates another)", async () => {
  const calls = [];
  const deps = seatDeps(calls, (seat) => JSON.stringify({ stance: "defend", note: `${seat} defends` }));
  const results = await runDebateRounds(
    "/x",
    SEAT_BACKENDS,
    { debateRounds: 1 },
    [entry("c-1", "codex"), entry("cl-1", "claude"), entry("or-1", "or-x")],
    deps
  );
  // Before the fix every non-codex author was routed to runGrok — grok wrote claude's/or-x's rebuttal
  // and the report attributed it to them (a fabricated attribution).
  assert.equal(calls.filter((c) => c.seat === "grok").length, 0, "grok never argues for another seat");
  assert.deepEqual(calls.map((c) => c.seat).sort(), ["claude", "codex", "or-x"]);
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(byId["cl-1"].agent, "claude");
  assert.equal(byId["cl-1"].note, "claude defends", "the claude rebuttal really came from the claude seat");
  assert.equal(byId["or-1"].agent, "or-x");
  assert.equal(byId["or-1"].note, "or-x defends", "the OpenRouter seat argued for itself");
});

test("a seat with no runner is skipped honestly — never executed under another seat's name", async () => {
  const calls = [];
  const deps = seatDeps(calls, () => JSON.stringify({ stance: "concede", note: "n" }));
  const [res] = await runDebateRounds("/x", SEAT_BACKENDS, { debateRounds: 1 }, [entry("u-1", "or-unconfigured")], deps);
  assert.equal(calls.length, 0, "no other seat is called in its place");
  assert.equal(res.skipped, true);
  assert.equal(res.stance, NO_REPLY_STANCE, "no stance is fabricated for a seat that never replied");
  assert.equal(res.parseOk, false);
  assert.match(res.reason, /no runner/);
});

test("a parse failure does not fabricate a 'defend' stance and buys no round-2 counter", async () => {
  const calls = [];
  const deps = seatDeps(calls, (seat) => (seat === "codex" ? "sorry, I could not comply" : '{"upheld": true}'));
  const results = await runDebateRounds("/x", SEAT_BACKENDS, { debateRounds: 2 }, [entry("c-9", "codex", "grok")], deps);
  const rebuttal = results.find((r) => r.round === 1);
  assert.equal(rebuttal.stance, NO_REPLY_STANCE, "an unparseable reply is NOT a defend");
  assert.equal(rebuttal.parseOk, false);
  assert.equal(rebuttal.failed, true);
  assert.equal(results.filter((r) => r.round === 2).length, 0, "no counter is paid for an argument nobody made");
  assert.equal(calls.filter((c) => c.seat === "grok").length, 0, "the critic seat is never called");

  // Fail-closed + visibly distinct: no severity change, item stays contested, report says 'no reply'.
  const merged = mergedWith({ ids: ["c-9"], agents: ["codex"], severity: "P1", consensus: false, contested: true });
  const next = applyDebateOutcomes(merged, results);
  assert.equal(next.all[0].severity, "P1");
  assert.equal(next.all[0].contested, true);
  assert.equal(next.all[0].debate.failed, true);
  const section = renderDebateSection(results);
  assert.match(section, /no reply/);
  assert.doesNotMatch(section, /\*\*defend\*\*/, "a failed reply never renders like a real defend");
});

test("a failed round-2 counter renders as no-reply and the critique still stands (fail-closed)", async () => {
  const calls = [];
  const deps = seatDeps(calls, (seat) =>
    seat === "codex" ? JSON.stringify({ stance: "defend", note: "holds" }) : "garbage, no json"
  );
  const results = await runDebateRounds("/x", SEAT_BACKENDS, { debateRounds: 2 }, [entry("c-2", "codex", "or-x")], deps);
  const counter = results.find((r) => r.round === 2);
  assert.equal(counter.agent, "or-x", "the counter ran on the critic's own runner");
  assert.equal(counter.failed, true);
  assert.equal(counter.upheld, true, "an unparseable counter never reads as a withdrawn critique");
  const section = renderDebateSection(results);
  assert.match(section, /counter by or-x: \*\*no reply\*\*/);
  assert.doesNotMatch(section, /withdraws critique/);
});

test("buildRebuttalPrompt/buildCounterPrompt fence the untrusted ITEM_JSON (and REBUTTAL_NOTE) with a one-time nonce", async () => {
  const calls = [];
  const deps = seatDeps(calls, (seat) =>
    seat === "codex" ? JSON.stringify({ stance: "defend", note: "codex-note-marker" }) : JSON.stringify({ upheld: true, note: "grok-counter-note" })
  );
  await runDebateRounds("/x", SEAT_BACKENDS, { debateRounds: 2 }, [entry("f-1", "codex", "grok")], deps);

  const rebuttalPrompt = calls.find((c) => c.seat === "codex").prompt;
  const itemNonceMatch = rebuttalPrompt.match(/BEGIN ITEM ([0-9A-F]{6,}) \(untrusted data\)/);
  assert.ok(itemNonceMatch, "the rebuttal prompt must fence ITEM_JSON with a nonce, like every other untrusted-content prompt");
  assert.ok(rebuttalPrompt.includes(`END ITEM ${itemNonceMatch[1]} (untrusted data)`));

  const counterPrompt = calls.find((c) => c.seat === "grok").prompt;
  const counterItemNonce = counterPrompt.match(/BEGIN ITEM ([0-9A-F]{6,}) \(untrusted data\)/);
  assert.ok(counterItemNonce, "the counter prompt must also fence ITEM_JSON");
  const rebuttalNonceMatch = counterPrompt.match(/BEGIN REBUTTAL ([0-9A-F]{6,}) \(untrusted data\)/);
  assert.ok(rebuttalNonceMatch, "the counter prompt must fence the peer's REBUTTAL_NOTE with a nonce too");
  assert.ok(counterPrompt.includes(`END REBUTTAL ${rebuttalNonceMatch[1]} (untrusted data)`));
  // the untrusted note text itself must live INSIDE the fence, not outside it
  const start = counterPrompt.indexOf(`BEGIN REBUTTAL ${rebuttalNonceMatch[1]}`);
  const end = counterPrompt.indexOf(`END REBUTTAL ${rebuttalNonceMatch[1]}`);
  assert.ok(counterPrompt.slice(start, end).includes("codex-note-marker"), "the peer rebuttal note lives inside its fence");
});

test("parseDebateRebuttal trusts the CALLER's id, never a model-echoed doc.id (anti-spoofing)", async () => {
  const calls = [];
  const deps = seatDeps(calls, () => JSON.stringify({ id: "totally-different-id", stance: "concede", note: "you are right" }));
  const results = await runDebateRounds("/x", SEAT_BACKENDS, { debateRounds: 1 }, [entry("real-id", "codex")], deps);
  const rebuttal = results.find((r) => r.round === 1);
  assert.equal(rebuttal.id, "real-id", "the trusted entry id is used, never the model-echoed doc.id");

  // Prove the failure this fixes: if the diverging echoed id were trusted, applyDebateOutcomes'
  // byId lookup would miss and silently drop the legitimate concede. With the trusted id it applies.
  const merged = mergedWith({ ids: ["real-id"], agents: ["codex"], severity: "P1", consensus: false, contested: true });
  const next = applyDebateOutcomes(merged, results);
  assert.equal(next.all[0].severity, "nit", "the concede must be applied despite the model echoing a different id");
  assert.equal(next.all[0].contested, false);
});

test("parseDebateCounter trusts the CALLER's id, never a model-echoed (or empty) doc.id (anti-spoofing)", async () => {
  const calls = [];
  const deps = seatDeps(calls, (seat) =>
    seat === "codex" ? JSON.stringify({ stance: "defend", note: "holds" }) : JSON.stringify({ id: "", upheld: true, note: "still stands" })
  );
  const results = await runDebateRounds("/x", SEAT_BACKENDS, { debateRounds: 2 }, [entry("real-id-2", "codex", "grok")], deps);
  const counter = results.find((r) => r.round === 2);
  assert.equal(counter.id, "real-id-2", "the trusted entry id is used, never an empty/diverging model-echoed doc.id");
});

test("applyDebateOutcomes ignores invalid revised severities and untouched items", () => {
  const merged = mergedWith({
    ids: ["codex-9"],
    agents: ["codex"],
    severity: "P1",
    consensus: false,
    contested: true
  });
  const debates = [
    { id: "codex-9", agent: "codex", round: 1, stance: "revise", note: "", revisedSeverity: "CRITICAL" }
  ];
  const next = applyDebateOutcomes(merged, debates);
  assert.equal(next.all[0].severity, "P1");

  const untouched = applyDebateOutcomes(merged, []);
  assert.equal(untouched, merged);
});
