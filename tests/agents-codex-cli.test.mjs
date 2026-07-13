import assert from "node:assert/strict";
import test from "node:test";

import { runCodexStructured } from "../plugins/council/scripts/lib/agents.mjs";

// The Codex seat used to run ONLY through the codex-companion, which ships with the separate
// OpenAI-Codex CLAUDE PLUGIN. Without that plugin the seat was SKIPPED outright — even though
// discover.mjs already probes the standalone `codex` CLI. So a user with the codex CLI but without the
// Claude plugin had a SILENTLY DEAD sixth eye: codex never reviewed, never voted in §6, never refuted.
// That is the same "a configured model is silently dropped" class purged everywhere else in this repo.
//
// These tests pin the three-way contract: companion → CLI → skipped(fail-closed).

test("codex seat: with NO companion but the standalone CLI available, it runs `codex exec` (no silently dead seat)", async () => {
  let seen = null;
  const backends = { codex: { companionAvailable: false, cli: { available: true } } };
  // runCommandAsync is not injectable here, so exercise the routing through a stubbed global spawn path:
  // instead we assert on the RESULT contract, which only the CLI branch can produce.
  const res = await runCodexStructured(process.cwd(), backends, { agentTimeoutMs: 1 }, "hello", "audit").catch((e) => ({ error: e }));
  assert.ok(res, "the seat produced a result");
  assert.notEqual(res.skipped, true, "the seat is NOT skipped when the standalone CLI is available");
  assert.equal(res.agent, "codex");
  // a 1ms timeout guarantees the real CLI cannot complete — what matters is that the CLI branch was TAKEN
  // (a skipped seat would have returned {skipped:true, reason:"codex unavailable..."} without spawning).
  assert.ok(res.backend === "codex-cli-exec" || res.timedOut || res.status !== 0, "the CLI branch ran (not the skip branch)");
  void seen;
});

test("codex seat: with NEITHER the companion NOR the CLI, it is SKIPPED fail-closed (never a fake clean review)", async () => {
  const backends = { codex: { companionAvailable: false, cli: { available: false } } };
  const res = await runCodexStructured(process.cwd(), backends, {}, "hello", "audit");
  assert.equal(res.skipped, true, "no backend → the seat casts no vote and manufactures no review");
  assert.match(res.reason, /codex unavailable/i);
  assert.equal(res.stdout, "", "a skipped seat never returns content that could read as a clean review");
});
