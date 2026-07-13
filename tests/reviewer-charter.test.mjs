import assert from "node:assert/strict";
import test from "node:test";

import { REVIEWER_CHARTER } from "../plugins/council/scripts/lib/reviewer-charter.mjs";

test("REVIEWER_CHARTER encodes all four named disciplines A4 requires", () => {
  assert.match(REVIEWER_CHARTER, /EVIDENCE-FIRST/);
  assert.match(REVIEWER_CHARTER, /FAILURE-SCENARIO-REQUIRED/);
  assert.match(REVIEWER_CHARTER, /SEVERITY-CAP DISCIPLINE/);
  assert.match(REVIEWER_CHARTER, /CONSERVATIVE UNDER UNCERTAINTY/); // grok-3: the 4th was untested
});

test("A4 (codex-1/grok-1): the charter scopes disciplines to REASONING and forces the verdict/first line FIRST", () => {
  // The fix for the prose-vs-2-line-VERDICT tension: evidence/failure-scenario reasoning goes in
  // PRIVATE thinking, and the reply must emit the required first line first (no citation preamble
  // that parsePatchVerdict would fail-close as UNKNOWN).
  assert.match(REVIEWER_CHARTER, /private thinking, NOT in the reply body/);
  assert.match(REVIEWER_CHARTER, /emit THAT line FIRST with nothing before it/);
  assert.match(REVIEWER_CHARTER, /Never prefix the reply with citations or\s+reasoning/);
});

test("REVIEWER_CHARTER defers to the task's output format (compatible with the §6 2-line verdict)", () => {
  // It must NOT pin an output shape of its own — the §6 reviewer needs its strict VERDICT/REASON
  // reply, the finder needs JSON. The charter only tells the model to obey the task's format.
  assert.match(REVIEWER_CHARTER, /Follow the EXACT answer format\s+the task specifies/);
  assert.equal(REVIEWER_CHARTER.includes("VERDICT:"), false, "charter does not hardcode a reply grammar");
});

test("REVIEWER_CHARTER is a stable non-empty string (cache-friendliness depends on byte-stability)", () => {
  // The value is a module constant, so it is byte-identical on every call → a prompt-cache hit.
  assert.equal(typeof REVIEWER_CHARTER, "string");
  assert.ok(REVIEWER_CHARTER.length > 200);
  // reinforces the injection defense: repo-embedded instructions are untrusted data
  assert.match(REVIEWER_CHARTER, /UNTRUSTED DATA/);
});

test("A4 (claude-1 P1): REVIEWER_CHARTER contains NO newline — it ships as a cmd.exe-quoted CLI arg on Windows", () => {
  // A multi-line --append-system-prompt value is truncated/broken when a bare-name or .cmd claude
  // binary is spawned through cmd.exe (shell:true). Keeping the charter single-line is the fix.
  assert.equal(REVIEWER_CHARTER.includes("\n"), false, "no LF");
  assert.equal(REVIEWER_CHARTER.includes("\r"), false, "no CR");
});

test("A4 (claude-2): for a go/no-go GATE, conservative-under-uncertainty OVERRIDES the don't-cry-wolf disposition", () => {
  // The severity-cap 'downgrade unproven worries' altitude is finder-shaped; for the fail-closed
  // §6 gate an unproven risk must WITHHOLD approval, not be waved through.
  assert.match(REVIEWER_CHARTER, /go\/no-go GATE/);
  assert.match(REVIEWER_CHARTER, /WITHHOLD approval, never to wave the change through/);
});
