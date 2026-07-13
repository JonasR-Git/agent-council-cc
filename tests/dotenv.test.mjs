import test from "node:test";
import assert from "node:assert/strict";

import { loadCouncilEnv, parseDotenv } from "../plugins/council/scripts/lib/dotenv.mjs";

test("parseDotenv: KEY=value, export prefix, comments, quotes", () => {
  const vars = parseDotenv(
    ["# a comment", "OPENROUTER_API_KEY=sk-or-abc", "export FOO = bar ", 'QUOTED="has spaces"', "SINGLE='x'", "", "not a var line", "=novalue"].join("\n")
  );
  assert.deepEqual(vars, { OPENROUTER_API_KEY: "sk-or-abc", FOO: "bar", QUOTED: "has spaces", SINGLE: "x" });
});

test("loadCouncilEnv: loads an untracked .council.env into env, counts vars", () => {
  const env = {};
  const res = loadCouncilEnv("/repo", {
    env,
    exists: () => true,
    isTracked: () => false,
    readFile: () => "OPENROUTER_API_KEY=sk-or-xyz\nOTHER=1"
  });
  assert.deepEqual(res, { loaded: 2 });
  assert.equal(env.OPENROUTER_API_KEY, "sk-or-xyz");
  assert.equal(env.OTHER, "1");
});

test("loadCouncilEnv: NEVER overrides an already-set env var (explicit export wins)", () => {
  const env = { OPENROUTER_API_KEY: "from-shell" };
  const res = loadCouncilEnv("/repo", {
    env,
    exists: () => true,
    isTracked: () => false,
    readFile: () => "OPENROUTER_API_KEY=from-file\nNEW=2"
  });
  assert.equal(env.OPENROUTER_API_KEY, "from-shell", "the shell export is not clobbered");
  assert.equal(env.NEW, "2", "a new key is still loaded");
  assert.equal(res.loaded, 1);
});

test("loadCouncilEnv: REFUSES a git-TRACKED .council.env (would leak a committed secret)", () => {
  const env = {};
  const warnings = [];
  const res = loadCouncilEnv("/repo", {
    env,
    exists: () => true,
    isTracked: () => true, // git tracks it → refuse
    readFile: () => "OPENROUTER_API_KEY=should-not-load",
    warn: (m) => warnings.push(m)
  });
  assert.deepEqual(res, { loaded: 0, tracked: true });
  assert.equal(env.OPENROUTER_API_KEY, undefined, "a tracked file is never loaded");
  assert.match(warnings[0], /TRACKED by git/);
});

test("loadCouncilEnv: fail-soft — missing file and a throwing reader both yield loaded:0, never throw", () => {
  assert.deepEqual(loadCouncilEnv("/repo", { exists: () => false }), { loaded: 0 });
  assert.doesNotThrow(() =>
    loadCouncilEnv("/repo", {
      env: {},
      exists: () => true,
      isTracked: () => false,
      readFile: () => {
        throw new Error("disk error");
      }
    })
  );
});
