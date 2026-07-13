import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runDeliberation } from "../plugins/council/scripts/lib/deliberate.mjs";

// A9: the deliberate path used to HARDCODE its seats — R1 ran codex/grok/spawn-claude literally and R2
// was four fixed grok/codex pairings. Consequences: the spawned Claude seat NEVER peer-critiqued (its
// findings were critiqued, but it critiqued nobody), and every configured OpenRouter seat was absent
// from the deliberation entirely. These tests pin the dynamic-registry behaviour: every ACTIVE seat
// proposes in R1 and critiques every OTHER seat (never itself) in R2. All seats are injected fakes —
// no CLI, no network.

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-deliberate-"));
  execSync("git init -q", { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.mjs"), "export const a = 1;\n", "utf8");
  return dir;
}

const R2_PROMPT = /PEER CRITIQUE/;
// r2-peer-critique.md: "Another independent reviewer (**<seat>**) produced findings."
const ABOUT_RE = /reviewer \(\*\*([\w.-]+)\*\*\)/;

function findingsJson(seat) {
  return JSON.stringify({
    agent: seat,
    summary: `${seat} summary`,
    verdict: "request_changes",
    findings: [
      {
        id: `${seat}-1`,
        severity: "P1",
        category: "bug",
        title: `${seat} sees an unchecked index`,
        detail: "detail",
        file: "a.mjs",
        line: 1,
        confidence: 0.8
      }
    ]
  });
}

function critiqueJson(seat, about) {
  return JSON.stringify({
    agent: seat,
    about,
    summary: `${seat} on ${about}`,
    votes: [{ targetId: `${about}-1`, title: `${about} sees an unchecked index`, vote: "agree", note: "confirmed" }]
  });
}

/** A fake seat runner (prompt) => result. Records `r1:<seat>` / `<critic>-><about>` per call. */
function fakeSeat(seat, calls) {
  return (prompt) => {
    const about = R2_PROMPT.test(prompt) ? String(prompt.match(ABOUT_RE)?.[1] ?? "?") : null;
    calls.push(about ? `${seat}->${about}` : `r1:${seat}`);
    return Promise.resolve({
      agent: seat,
      backend: "fake",
      status: 0,
      stdout: about ? critiqueJson(seat, about) : findingsJson(seat),
      stderr: "",
      skipped: false,
      timedOut: false
    });
  };
}

/** deps mirrors makeSeatRunners' injection contract (runOpenRouter also receives the seat id). */
function fakeDeps(calls) {
  return {
    runCodex: fakeSeat("codex", calls),
    runGrok: fakeSeat("grok", calls),
    runClaude: fakeSeat("claude", calls),
    runOpenRouter: (_cwd, _backends, _options, prompt, seatId) => fakeSeat(seatId, calls)(prompt)
  };
}

function backendsWith(seats = []) {
  return {
    codex: { companion: "codex-companion.mjs", companionAvailable: true },
    grok: { bin: "grok", cli: { available: true } },
    claude: { bin: "claude", cli: { available: true } },
    openrouter: { available: seats.length > 0, seats, baseURL: "https://openrouter.ai/api/v1" }
  };
}

const OR_SEAT = { id: "or-gpt", model: "openai/gpt-5" };
// ledger:false keeps the run hermetic (no state-dir writes); spawn = Claude is an independent seat.
const SPAWN_OPTIONS = { ledger: false, claudeBackend: "spawn" };

const pairsOf = (result) => result.r2.map((r) => `${r.agent}->${r.aboutAgent}`).sort();

test("R1: every active seat proposes - a configured OpenRouter seat is a full finder", async () => {
  const dir = makeRepo();
  const calls = [];
  const result = await runDeliberation(dir, backendsWith([OR_SEAT]), { ...SPAWN_OPTIONS }, fakeDeps(calls));

  assert.deepEqual(
    result.r1.map((r) => r.agent).sort(),
    ["claude", "codex", "grok", "or-gpt"]
  );
  assert.ok(result.r1.every((r) => r.findings?.parseOk));
  assert.ok(calls.includes("r1:or-gpt"));
  // The OR seat's finding actually lands in the merged set (it is not dropped after the run).
  assert.ok(result.merged.all.some((m) => m.agents.includes("or-gpt")));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("R2 is ALL-TO-ALL: claude critiques, the OpenRouter seat critiques, nobody critiques itself", async () => {
  const dir = makeRepo();
  const calls = [];
  const result = await runDeliberation(dir, backendsWith([OR_SEAT]), { ...SPAWN_OPTIONS }, fakeDeps(calls));

  const seats = ["codex", "grok", "claude", "or-gpt"];
  const expected = [];
  for (const about of seats) {
    for (const critic of seats) {
      if (critic !== about) expected.push(`${critic}->${about}`);
    }
  }
  assert.deepEqual(pairsOf(result), expected.sort());

  // The six-eyes fix: Claude CRITIQUES (before, it was only ever critiqued) ...
  assert.ok(pairsOf(result).includes("claude->codex"));
  assert.ok(pairsOf(result).includes("claude->grok"));
  assert.ok(pairsOf(result).includes("claude->or-gpt"));
  // ... and the OpenRouter seat critiques the built-ins.
  assert.ok(pairsOf(result).includes("or-gpt->codex"));
  assert.ok(pairsOf(result).includes("or-gpt->claude"));
  // Never itself.
  assert.ok(result.r2.every((r) => r.agent !== r.aboutAgent));

  // Their votes are ingested, not just dispatched.
  const voters = new Set(result.merged.all.flatMap((m) => (m.peerVotes ?? []).map((v) => v.from)));
  assert.ok(voters.has("claude"));
  assert.ok(voters.has("or-gpt"));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("critique scope is reported for every seat, including the OpenRouter seat", async () => {
  const dir = makeRepo();
  const result = await runDeliberation(dir, backendsWith([OR_SEAT]), { ...SPAWN_OPTIONS }, fakeDeps([]));

  assert.match(result.report, /### or-gpt/);
  assert.match(result.report, /### claude -> codex/);
  assert.match(result.sections.header, /or-gpt: 1\/1/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("backward compatible: three built-ins in session mode keep the legacy four pairings", async () => {
  const dir = makeRepo();
  const claudeFile = path.join(dir, "claude-findings.json");
  fs.writeFileSync(claudeFile, findingsJson("claude"), "utf8");
  const calls = [];

  const result = await runDeliberation(
    dir,
    backendsWith([]),
    { ledger: false, claudeFindingsPath: claudeFile },
    fakeDeps(calls)
  );

  assert.deepEqual(pairsOf(result), ["codex->claude", "codex->grok", "grok->claude", "grok->codex"].sort());
  // Session-mode Claude IS the orchestrator (it votes in-session), so no Claude CLI is spawned at all.
  assert.ok(!calls.some((c) => c.startsWith("claude")));
  assert.ok(!calls.includes("r1:claude"));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("fail-closed: an unreachable OpenRouter seat is dispatched nowhere (no phantom vote)", async () => {
  const dir = makeRepo();
  const backends = backendsWith([OR_SEAT]);
  backends.openrouter.available = false; // e.g. no API key registered
  const calls = [];

  const result = await runDeliberation(dir, backends, { ...SPAWN_OPTIONS }, fakeDeps(calls));

  assert.ok(!calls.some((c) => c.includes("or-gpt")));
  assert.ok(!result.r1.some((r) => r.agent === "or-gpt"));
  assert.ok(!result.r2.some((r) => r.agent === "or-gpt" || r.aboutAgent === "or-gpt"));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a per-seat skip removes the OpenRouter seat from both rounds", async () => {
  const dir = makeRepo();
  const calls = [];

  const result = await runDeliberation(
    dir,
    backendsWith([OR_SEAT]),
    { ...SPAWN_OPTIONS, skipSeats: ["or-gpt"] },
    fakeDeps(calls)
  );

  assert.ok(!calls.some((c) => c.includes("or-gpt")));
  assert.deepEqual(pairsOf(result), ["claude->codex", "claude->grok", "codex->claude", "codex->grok", "grok->claude", "grok->codex"].sort());

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a skipped built-in still shows an explicit skipped R1 row and casts no critique", async () => {
  const dir = makeRepo();
  const calls = [];

  const result = await runDeliberation(
    dir,
    backendsWith([OR_SEAT]),
    { ...SPAWN_OPTIONS, skipCodex: true },
    fakeDeps(calls)
  );

  const codex = result.r1.find((r) => r.agent === "codex");
  assert.ok(codex?.skipped);
  assert.equal(codex.reason, "skip");
  assert.ok(!calls.some((c) => c.startsWith("codex")));
  assert.ok(!result.r2.some((r) => r.agent === "codex" || r.aboutAgent === "codex"));

  fs.rmSync(dir, { recursive: true, force: true });
});
