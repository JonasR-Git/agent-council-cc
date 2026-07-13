import assert from "node:assert/strict";
import test from "node:test";

import { BUILTIN_SEATS, activeSeatNames, allSeatNames, isOpenRouterSeat, makeSeatRunners, requiredPatchSeats, seatActive } from "../plugins/council/scripts/lib/seats.mjs";

const builtinBackends = { codex: { companionAvailable: true }, grok: { cli: { available: true } }, claude: { cli: { available: true } } };
const withOR = (extra = {}) => ({ ...builtinBackends, openrouter: { available: true, seats: [{ id: "or-x", model: "v/m" }, { id: "or-y", model: "v/n" }], ...extra } });

test("allSeatNames: exactly the 3 built-ins with no openrouter; built-ins + OR ids with config", () => {
  assert.deepEqual(allSeatNames({}), ["codex", "grok", "claude"]);
  assert.deepEqual(allSeatNames(builtinBackends), ["codex", "grok", "claude"]);
  assert.deepEqual(allSeatNames(withOR()), ["codex", "grok", "claude", "or-x", "or-y"]);
});

test("seatActive: built-in branches match the former reviewerActive; OR seats gated on availability + skip", () => {
  assert.equal(seatActive("codex", builtinBackends, {}), true);
  assert.equal(seatActive("codex", builtinBackends, { skipCodex: true }), false);
  assert.equal(seatActive("grok", { grok: { cli: { available: false } } }, {}), false);
  assert.equal(seatActive("claude", builtinBackends, { skipClaude: true }), false);
  // OR seat
  assert.equal(seatActive("or-x", withOR(), {}), true);
  assert.equal(seatActive("or-x", withOR({ available: false }), {}), false, "unreachable openrouter → inactive");
  assert.equal(seatActive("or-x", withOR(), { skipOpenRouter: true }), false);
  assert.equal(seatActive("or-x", withOR(), { skipSeats: ["or-x"] }), false, "per-seat skip");
  assert.equal(seatActive("or-unknown", withOR(), {}), false, "an unconfigured id is never active");
});

test("activeSeatNames: default is the 3 built-ins; OR seats add when reachable", () => {
  assert.deepEqual(activeSeatNames(builtinBackends, {}), ["codex", "grok", "claude"]);
  assert.deepEqual(activeSeatNames(withOR(), {}), ["codex", "grok", "claude", "or-x", "or-y"]);
  assert.deepEqual(activeSeatNames(withOR({ available: false }), {}), ["codex", "grok", "claude"], "openrouter down → back to 3");
});

test("makeSeatRunners: a runner per built-in + per OR seat; injectable", async () => {
  const calls = [];
  const runners = makeSeatRunners("/x", withOR(), {}, {
    runCodex: async () => "codex",
    runGrok: async () => "grok",
    runClaude: async () => "claude",
    runOpenRouter: async (cwd, b, o, p, id) => { calls.push(id); return id; }
  });
  assert.deepEqual(Object.keys(runners).sort(), ["claude", "codex", "grok", "or-x", "or-y"]);
  assert.equal(await runners["or-x"]("prompt"), "or-x");
  assert.equal(await runners["or-y"]("prompt"), "or-y");
  assert.deepEqual(calls, ["or-x", "or-y"], "each OR runner passes its own seat id");
});

test("requiredPatchSeats: §6 unanimity = built-ins + every CONFIGURED (non-skipped) OR seat", () => {
  assert.deepEqual(requiredPatchSeats(builtinBackends, {}), ["codex", "grok", "claude"], "no OR → the 3 built-ins");
  assert.deepEqual(requiredPatchSeats(withOR(), {}), ["codex", "grok", "claude", "or-x", "or-y"], "OR seats are also required to confirm");
  // a configured-but-down OR seat is STILL required — its missing vote vetoes, fail-closed (reachability
  // is checked up front by patchReviewerReady, which keeps the class propose-only when a seat is down).
  assert.deepEqual(requiredPatchSeats(withOR({ available: false }), {}), ["codex", "grok", "claude", "or-x", "or-y"], "a down configured OR seat still vetoes");
  assert.deepEqual(requiredPatchSeats(withOR(), { skipOpenRouter: true }), ["codex", "grok", "claude"], "--skip-openrouter drops all OR seats");
  assert.deepEqual(requiredPatchSeats(withOR(), { skipSeats: ["or-x"] }), ["codex", "grok", "claude", "or-y"], "a per-seat skip drops just that seat");
});

test("isOpenRouterSeat / BUILTIN_SEATS", () => {
  assert.deepEqual([...BUILTIN_SEATS], ["codex", "grok", "claude"]);
  assert.equal(isOpenRouterSeat("or-x"), true);
  assert.equal(isOpenRouterSeat("codex"), false);
  assert.equal(isOpenRouterSeat("or-x", withOR()), true);
  assert.equal(isOpenRouterSeat("or-z", withOR()), false, "unconfigured or- id with backends → false");
});
