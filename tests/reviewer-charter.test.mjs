import assert from "node:assert/strict";
import test from "node:test";

import { REVIEWER_CHARTER } from "../plugins/council/scripts/lib/reviewer-charter.mjs";

test("REVIEWER_CHARTER encodes the three disciplines A4 requires", () => {
  assert.match(REVIEWER_CHARTER, /EVIDENCE-FIRST/);
  assert.match(REVIEWER_CHARTER, /FAILURE-SCENARIO-REQUIRED/);
  assert.match(REVIEWER_CHARTER, /SEVERITY-CAP DISCIPLINE/);
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
