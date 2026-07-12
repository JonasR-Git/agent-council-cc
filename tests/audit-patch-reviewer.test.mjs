import assert from "node:assert/strict";
import test from "node:test";

import { buildClaudeReviewArgs, makePatchReviewer, patchReviewerReady } from "../plugins/council/scripts/lib/audit-patch-reviewer.mjs";
import { evaluatePatchVerdicts } from "../plugins/council/scripts/lib/audit-council-gate.mjs";

const patch = { file: "a.mjs", finding: { severity: "P1", category: "concurrency", title: "race", detail: "d" }, diff: "@@ -1 +1 @@\n-x\n+y" };

test("buildClaudeReviewArgs is read-only: inspect tools allowed, edit/exec/network denied", () => {
  const args = buildClaudeReviewArgs({ claudeModel: "claude-opus-4-8" });
  assert.ok(args.includes("Read") && args.includes("Grep") && args.includes("Glob"));
  assert.ok(args.indexOf("Edit") > args.indexOf("--disallowed-tools"), "Edit only in the deny list");
  assert.ok(args.indexOf("Bash") > args.indexOf("--disallowed-tools"), "Bash only in the deny list");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(args.includes("--safe-mode"), "safe-mode disables audited-repo CLAUDE.md/hooks/plugins/MCP");
  assert.equal(args[args.indexOf("--model") + 1], "claude-opus-4-8");
  assert.equal(args[args.indexOf("--effort") + 1], "xhigh", "A2: reviewer reasons at xhigh by default");
  assert.equal(buildClaudeReviewArgs({ claudeEffort: "high" })[buildClaudeReviewArgs({ claudeEffort: "high" }).indexOf("--effort") + 1], "high", "explicit effort wins");
});

test("makePatchReviewer runs all three seats on the same patch and returns parsed verdicts", async () => {
  const seen = {};
  const review = makePatchReviewer("/x", {}, {}, {
    runClaude: async (p) => { seen.claude = p; return "VERDICT: CONFIRM\nREASON: ok"; },
    runCodex: async (p) => { seen.codex = p; return { stdout: "VERDICT: CONFIRM\nREASON: ok" }; },
    runGrok: async (p) => { seen.grok = p; return { stdout: "VERDICT: DISSENT\nREASON: risky" }; }
  });
  const verdicts = await review(patch);
  assert.equal(verdicts.length, 3);
  assert.equal(evaluatePatchVerdicts(verdicts).approved, false, "one dissent vetoes");
  // each seat received a prompt naming itself (independent judgement of the SAME patch)
  assert.match(seen.claude, /claude seat/);
  assert.match(seen.codex, /codex seat/);
  assert.match(seen.grok, /grok seat/);
});

test("A3: makePatchReviewer threads the post-patch source (after) into every seat's prompt", async () => {
  const seen = {};
  const review = makePatchReviewer("/x", {}, {}, {
    runClaude: async (p) => { seen.claude = p; return "VERDICT: CONFIRM\nREASON: ok"; },
    runCodex: async (p) => { seen.codex = p; return { stdout: "VERDICT: CONFIRM\nREASON: ok" }; },
    runGrok: async (p) => { seen.grok = p; return { stdout: "VERDICT: CONFIRM\nREASON: ok" }; }
  });
  await review({ ...patch, after: "export function mutex(){ /* SENTINEL_CTX */ }" });
  for (const seat of ["claude", "codex", "grok"]) {
    assert.match(seen[seat], /BEGIN PATCHED SOURCE/, `${seat} got the source block`);
    assert.ok(seen[seat].includes("SENTINEL_CTX"), `${seat} saw the post-patch source`);
  }
});

test("A3: an explicit context arg overrides after; absent both, no source block is sent", async () => {
  const seen = {};
  const ok = "VERDICT: CONFIRM\nREASON: ok";
  const review = makePatchReviewer("/x", {}, {}, {
    runClaude: async (p) => { seen.claude = p; return ok; },
    runCodex: async () => ok,
    runGrok: async () => ok
  });
  await review({ ...patch, after: "AFTER_SRC", context: "OVERRIDE_SRC" });
  assert.ok(seen.claude.includes("OVERRIDE_SRC") && !seen.claude.includes("AFTER_SRC"), "explicit context wins over after");
  await review(patch); // neither after nor context
  assert.equal(seen.claude.includes("PATCHED SOURCE"), false, "no source block when none supplied");
});

test("A3 (council codex-2/claude-4): an explicit empty context SUPPRESSES the block even when after is set", async () => {
  const seen = {};
  const ok = "VERDICT: CONFIRM\nREASON: ok";
  const review = makePatchReviewer("/x", {}, {}, {
    runClaude: async (p) => { seen.claude = p; return ok; },
    runCodex: async () => ok,
    runGrok: async () => ok
  });
  await review({ ...patch, after: "AFTER_SRC", context: "" });
  assert.equal(seen.claude.includes("PATCHED SOURCE"), false, "context:'' unambiguously suppresses, does not fall back to after");
  assert.equal(seen.claude.includes("AFTER_SRC"), false);
});

test("A3 (council claude-2): an oversized `after` threaded through makePatchReviewer is windowed to the change, not head-truncated", async () => {
  const seen = {};
  const ok = "VERDICT: CONFIRM\nREASON: ok";
  const lines = [];
  for (let i = 1; i <= 600; i += 1) {
    if (i === 1) lines.push("HEAD_ONLY_SENTINEL");
    else if (i === 480) lines.push("PATCHED_LINE_SENTINEL");
    else lines.push(`filler ${i} ${"xyzxyz".repeat(6)}`);
  }
  const bigAfter = lines.join("\n");
  const review = makePatchReviewer("/x", {}, {}, {
    runClaude: async (p) => { seen.claude = p; return ok; },
    runCodex: async () => ok,
    runGrok: async () => ok
  });
  await review({ file: "big.mjs", finding: patch.finding, diff: "@@ -480,1 +480,1 @@", after: bigAfter });
  assert.ok(seen.claude.includes("PATCHED_LINE_SENTINEL"), "reviewer sees the changed region");
  assert.equal(seen.claude.includes("HEAD_ONLY_SENTINEL"), false, "reviewer is not blinded by the file head");
  assert.match(seen.claude, /WINDOWED around the changed region/);
});

test("makePatchReviewer is fail-closed: an erroring or skipped seat casts NO vote", async () => {
  const review = makePatchReviewer("/x", {}, {}, {
    runClaude: async () => "VERDICT: CONFIRM\nREASON: ok",
    runCodex: async () => { throw new Error("codex offline"); },       // error → no vote
    runGrok: async () => ({ skipped: true, reason: "grok not found" }) // skipped → no vote
  });
  const verdicts = await review(patch);
  assert.equal(verdicts.length, 1, "only the reachable seat voted");
  // the gate needs all three: two missing → never approves
  assert.equal(evaluatePatchVerdicts(verdicts).approved, false);
});

test("makePatchReviewer: a failed/timed-out Codex/Grok run casts NO vote even if it emitted CONFIRM", async () => {
  const review = makePatchReviewer("/x", {}, {}, {
    runClaude: async () => "VERDICT: CONFIRM\nREASON: ok",
    runCodex: async () => ({ status: 1, stdout: "VERDICT: CONFIRM" }),               // non-zero exit → no vote
    runGrok: async () => ({ status: 124, timedOut: true, stdout: "VERDICT: CONFIRM" }) // timed out → no vote
  });
  const verdicts = await review(patch);
  assert.equal(verdicts.length, 1, "only the cleanly-completed claude run voted");
  assert.equal(evaluatePatchVerdicts(verdicts).approved, false, "a truncated/failed run cannot manufacture unanimity");
});

test("makePatchReviewer: a truncated (partial) Codex/Grok run casts no vote", async () => {
  const review = makePatchReviewer("/x", {}, {}, {
    runClaude: async () => "VERDICT: CONFIRM\nREASON: ok",
    runCodex: async () => ({ status: 0, truncated: true, stdout: "VERDICT: CONFIRM" }),
    runGrok: async () => "VERDICT: CONFIRM\nREASON: ok"
  });
  const verdicts = await review(patch);
  assert.equal(verdicts.length, 2);
  assert.equal(evaluatePatchVerdicts(verdicts).approved, false, "codex truncated → missing → not unanimous");
});

test("makePatchReviewer: three genuine confirms approve the patch", async () => {
  const ok = async () => "VERDICT: CONFIRM\nREASON: correct";
  const review = makePatchReviewer("/x", {}, {}, { runClaude: ok, runCodex: ok, runGrok: ok });
  assert.equal(evaluatePatchVerdicts(await review(patch)).approved, true);
});

test("patchReviewerReady requires all three seats reachable", () => {
  // Reachability comes from the ACTUAL probes, not fallback bin names.
  assert.equal(patchReviewerReady({ claude: { cli: { available: true } }, codex: { companionAvailable: true }, grok: { cli: { available: true } } }).ready, true);
  assert.equal(patchReviewerReady({ claude: { cli: { available: true } }, codex: { companionAvailable: false }, grok: { cli: { available: true } } }).ready, false);
  // a fallback bin name with a FAILED probe is NOT reachable
  assert.equal(patchReviewerReady({ claude: { bin: "claude", cli: { available: false } }, codex: { companionAvailable: true }, grok: { bin: "grok", cli: { available: false } } }).ready, false);
  // codex CLI present but companion ABSENT is NOT ready — the codex seat votes only via the
  // companion, so cli.available alone would print ENABLED yet never confirm.
  assert.equal(patchReviewerReady({ claude: { cli: { available: true } }, codex: { companionAvailable: false, cli: { available: true } }, grok: { cli: { available: true } } }).ready, false);
});
