import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_POLICY,
  mergeOptionsWithPolicy,
  normalizeReviewers
} from "../plugins/council/scripts/lib/policy.mjs";

const base = { ...DEFAULT_POLICY, _source: null };

test("normalizeReviewers dedups, lowercases, and drops unknown agents", () => {
  assert.deepEqual(normalizeReviewers(["Claude", "codex", "codex", "grok"]), ["claude", "codex", "grok"]);
  assert.deepEqual(normalizeReviewers("claude, grok, bogus"), ["claude", "grok"]);
  assert.deepEqual(normalizeReviewers(["GROK"]), ["grok"]);
});

test("normalizeReviewers falls back to all three when empty or all-junk", () => {
  assert.deepEqual(normalizeReviewers([]), ["claude", "codex", "grok"]);
  assert.deepEqual(normalizeReviewers("nonsense,other"), ["claude", "codex", "grok"]);
  assert.deepEqual(normalizeReviewers(null), ["claude", "codex", "grok"]);
});

test("default policy reviews with all three; nobody is skipped", () => {
  const merged = mergeOptionsWithPolicy({}, base);
  assert.deepEqual(merged.reviewers, ["claude", "codex", "grok"]);
  assert.equal(merged.skipCodex, false);
  assert.equal(merged.skipGrok, false);
  assert.equal(merged.skipClaude, false);
});

test("reviewers list omitting an agent force-skips exactly that agent", () => {
  const merged = mergeOptionsWithPolicy({}, { ...base, reviewers: ["claude", "grok"] });
  assert.deepEqual(merged.reviewers, ["claude", "grok"]);
  assert.equal(merged.skipCodex, true, "codex absent from reviewers -> skipped");
  assert.equal(merged.skipGrok, false);
  assert.equal(merged.skipClaude, false);
});

test("reviewers flag (CLI string) overrides policy list", () => {
  const merged = mergeOptionsWithPolicy({ reviewers: "codex" }, { ...base, reviewers: ["claude", "codex", "grok"] });
  assert.deepEqual(merged.reviewers, ["codex"]);
  assert.equal(merged.skipClaude, true);
  assert.equal(merged.skipGrok, true);
  assert.equal(merged.skipCodex, false);
});

test("explicit --skip flags still force-skip even when the agent is a reviewer", () => {
  const merged = mergeOptionsWithPolicy({ skipGrok: true }, base);
  assert.equal(merged.skipGrok, true);
  // others remain participating
  assert.equal(merged.skipCodex, false);
  assert.equal(merged.skipClaude, false);
});

test("claude backend defaults to session with no pinned model", () => {
  const merged = mergeOptionsWithPolicy({}, base);
  assert.equal(merged.claudeBackend, "session");
  assert.equal(merged.claudeModel, null);
});

test("claude backend + model resolve from policy, and flags win over policy", () => {
  const fromPolicy = mergeOptionsWithPolicy({}, { ...base, claude_backend: "spawn", claude_model: "claude-opus-4-8" });
  assert.equal(fromPolicy.claudeBackend, "spawn");
  assert.equal(fromPolicy.claudeModel, "claude-opus-4-8");

  const fromFlags = mergeOptionsWithPolicy(
    { claudeBackend: "session", claudeModel: "claude-fable-5" },
    { ...base, claude_backend: "spawn", claude_model: "claude-opus-4-8" }
  );
  assert.equal(fromFlags.claudeBackend, "session");
  assert.equal(fromFlags.claudeModel, "claude-fable-5");
});
