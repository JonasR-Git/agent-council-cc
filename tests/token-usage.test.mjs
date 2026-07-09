import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  collectAllTokenUsage,
  collectClaudeTokens,
  collectCodexRateLimits,
  collectCodexTokens,
  collectGrokTokens,
  parseClaudeLimits
} from "../plugins/council/scripts/lib/token-usage.mjs";

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "council-usage-home-"));
  fs.mkdirSync(path.join(home, ".claude", "projects", "proj"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".claude", "projects", "proj", "session.jsonl"),
    [
      JSON.stringify({ message: { usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } } }),
      JSON.stringify({ message: { usage: { input_tokens: 200, output_tokens: 25 } } }),
      "not json at all"
    ].join("\n"),
    "utf8"
  );

  fs.mkdirSync(path.join(home, ".codex", "sessions", "2026", "07", "10"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".codex", "sessions", "2026", "07", "10", "rollout-x.jsonl"),
    [
      JSON.stringify({ info: { total_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 2 } } }),
      JSON.stringify({
        info: {
          total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 300, reasoning_output_tokens: 120, total_tokens: 1300 },
          rate_limits: {
            plan_type: "prolite",
            primary: { used_percent: 7.5, window_minutes: 300, resets_at: 1783640279 },
            secondary: { used_percent: 43.0, window_minutes: 10080, resets_at: 1783926001 }
          }
        }
      })
    ].join("\n"),
    "utf8"
  );

  const grokSession = path.join(home, ".grok", "sessions", "workspace", "abc");
  fs.mkdirSync(grokSession, { recursive: true });
  fs.writeFileSync(
    path.join(grokSession, "updates.jsonl"),
    ['{"totalTokens":100}', '{"totalTokens":1500}', '{"totalTokens":1750}'].join("\n"),
    "utf8"
  );
  return home;
}

test("token collectors parse all three local stores", () => {
  const home = makeHome();
  try {
    const claude = collectClaudeTokens(path.join(home, ".claude"), 0);
    assert.equal(claude.sessions, 1);
    assert.equal(claude.inputTokens, 300);
    assert.equal(claude.outputTokens, 75);
    assert.equal(claude.cacheReadTokens, 10);

    const codex = collectCodexTokens(path.join(home, ".codex"), 0);
    assert.equal(codex.sessions, 1);
    assert.equal(codex.totalTokens, 1300);
    assert.equal(codex.reasoningOutputTokens, 120);

    const grok = collectGrokTokens(path.join(home, ".grok"), 0);
    assert.equal(grok.sessions, 1);
    assert.equal(grok.totalTokens, 1750);

    const all = collectAllTokenUsage({ homeDir: home, sinceMs: 0 });
    assert.equal(all.claude.inputTokens, 300);
    assert.equal(all.codex.totalTokens, 1300);
    assert.equal(all.grok.totalTokens, 1750);

    const none = collectAllTokenUsage({ homeDir: home, sinceMs: Date.now() + 60_000 });
    assert.equal(none.claude.sessions + none.codex.sessions + none.grok.sessions, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("codex rate limits: newest local snapshot with 5h/weekly windows", () => {
  const home = makeHome();
  try {
    const limits = collectCodexRateLimits(path.join(home, ".codex"));
    assert.equal(limits.planType, "prolite");
    assert.equal(limits.primary.window, "5h");
    assert.equal(limits.primary.usedPercent, 7.5);
    assert.equal(limits.secondary.window, "weekly");
    assert.equal(limits.secondary.usedPercent, 43);
    assert.match(limits.secondary.resetsAt, /^2026-/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("collectors yield zeros/null when stores are absent", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "council-usage-empty-"));
  try {
    assert.equal(collectClaudeTokens(path.join(empty, ".claude"), 0).sessions, 0);
    assert.equal(collectCodexTokens(path.join(empty, ".codex"), 0).sessions, 0);
    assert.equal(collectGrokTokens(path.join(empty, ".grok"), 0).sessions, 0);
    assert.equal(collectCodexRateLimits(path.join(empty, ".codex")), null);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("parseClaudeLimits maps the OAuth usage payload", () => {
  const limits = parseClaudeLimits({
    five_hour: { utilization: 3.0, resets_at: "2026-07-10T03:49:59+00:00" },
    seven_day: { utilization: 11.0, resets_at: "2026-07-12T20:59:59+00:00" }
  });
  assert.equal(limits.fiveHour.usedPercent, 3);
  assert.equal(limits.sevenDay.usedPercent, 11);
  assert.equal(parseClaudeLimits({ nothing: true }), null);
  assert.equal(parseClaudeLimits(null), null);
});
