import test from "node:test";
import assert from "node:assert/strict";

import { mergeFindings, parseAgentFindings } from "../plugins/council/scripts/lib/findings.mjs";
import { annotateScopes, classifyScope } from "../plugins/council/scripts/lib/scope.mjs";
import { shouldVerify, verifierFor } from "../plugins/council/scripts/lib/verify.mjs";

// --- #1 scope override now survives the pipeline ----------------------------

test("an explicit agent scope survives parse -> merge -> annotate (override honored)", () => {
  // Title has cross-cutting words ("refactor", "pattern") so the heuristic would
  // say cross-cutting; the agent explicitly marked it localized.
  const doc = parseAgentFindings(
    JSON.stringify({
      agent: "codex",
      verdict: "request_changes",
      findings: [
        { id: "c1", severity: "P1", title: "refactor the retry pattern here", file: "x.js", line: 10, scope: "localized" }
      ]
    }),
    "codex"
  );
  assert.equal(doc.findings[0].scope, "localized", "normalize must carry scope through");

  const merged = annotateScopes(mergeFindings([doc]));
  assert.equal(merged.all[0].scope, "localized", "explicit override beats the heuristic");
  assert.equal(merged.all[0].deliverable, "fix-diff");
});

test("classifyScope: a file with a null line is NOT a precise location", () => {
  assert.equal(classifyScope({ file: "x.js", line: null, title: "bug", detail: "" }), "cross-cutting");
  assert.equal(classifyScope({ file: "x.js", line: 5, title: "bug", detail: "" }), "localized");
});

// --- #A merge must not discard a known line on severity takeover -------------

test("severity takeover keeps a known line when the higher-severity dup has none", () => {
  const codex = parseAgentFindings(
    JSON.stringify({ agent: "codex", findings: [{ id: "c", severity: "P1", title: "Null deref crash", file: "a.js", line: 42 }] }),
    "codex"
  );
  const grok = parseAgentFindings(
    JSON.stringify({ agent: "grok", findings: [{ id: "g", severity: "P0", title: "Null deref crash", file: "a.js" }] }),
    "grok"
  );
  const merged = mergeFindings([codex, grok]);
  const item = merged.all.find((m) => m.agents.includes("codex") && m.agents.includes("grok"));
  assert.ok(item, "the two should fuzzy-merge into one bucket");
  assert.equal(item.severity, "P0", "higher severity wins");
  assert.equal(item.line, 42, "known line must not be clobbered to null");
  assert.equal(item.file, "a.js");
});

// --- #2 verify never lets a finding's own author refute it ------------------

test("verifierFor returns null rather than the raiser when the peer is skipped", () => {
  // grok raised it; codex is skipped -> no independent verifier -> null.
  assert.equal(verifierFor({ agents: ["grok"] }, { skipCodex: true }), null);
  // both available, grok raised -> codex verifies.
  assert.equal(verifierFor({ agents: ["grok"] }, {}), "codex");
  // codex raised -> grok verifies.
  assert.equal(verifierFor({ agents: ["codex"] }, {}), "grok");
});

// --- #4 verify does not target protected consensus findings -----------------

test("shouldVerify skips consensus (never demotable) and non-target severities", () => {
  assert.equal(shouldVerify({ severity: "P1", consensus: false }, ["P0", "P1"]), true);
  assert.equal(shouldVerify({ severity: "P1", consensus: true }, ["P0", "P1"]), false, "consensus is protected -> no wasted spawn");
  assert.equal(shouldVerify({ severity: "P2", consensus: false }, ["P0", "P1"]), false);
});
