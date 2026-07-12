import assert from "node:assert/strict";
import test from "node:test";

import { mergeOptionsWithPolicy, parseSimpleYaml } from "../plugins/council/scripts/lib/policy.mjs";
import { openRouterBackend } from "../plugins/council/scripts/lib/openrouter-agent.mjs";

test("OpenRouter config resolves from flat YAML (parseSimpleYaml) → backend seats", () => {
  const policy = parseSimpleYaml(`
version: 1
openrouter_base_url: https://openrouter.ai/api/v1
openrouter_models:
  - gpt=openai/gpt-4o
  - r1=deepseek/r1@high
`);
  const merged = mergeOptionsWithPolicy({}, policy);
  assert.deepEqual(merged.openrouterModels, ["gpt=openai/gpt-4o", "r1=deepseek/r1@high"]);
  const backend = openRouterBackend(merged, { OPENROUTER_API_KEY: "sk-test" });
  assert.equal(backend.available, true);
  assert.deepEqual(backend.seats.map((s) => s.id), ["or-gpt", "or-r1"]);
  assert.equal(JSON.stringify(backend).includes("sk-test"), false, "key never in the descriptor");
});

test("OpenRouter config resolves from a nested object (.council.json); a custom OPENROUTER* env name is honored", () => {
  const merged = mergeOptionsWithPolicy({}, { openrouter: { models: [{ id: "llama", model: "meta/llama-3.1" }], apiKeyEnv: "OPENROUTER_KEY_ALT" } });
  const backend = openRouterBackend(merged, { OPENROUTER_KEY_ALT: "sk-y" });
  assert.equal(backend.available, true);
  assert.equal(backend.seats[0].id, "or-llama");
  assert.equal(backend.apiKeyEnv, "OPENROUTER_KEY_ALT");
});

test("OpenRouter SECURITY: a repo-chosen env name that is NOT OPENROUTER* is refused (can't select AWS_* etc.; council Codex P1)", () => {
  // a hostile .council.yml pointing the key env at an unrelated secret must NOT read that secret
  const merged = mergeOptionsWithPolicy({}, { openrouter: { models: [{ id: "x", model: "vendor/m" }], apiKeyEnv: "AWS_SECRET_ACCESS_KEY" } });
  const backend = openRouterBackend(merged, { AWS_SECRET_ACCESS_KEY: "AKIA-super-secret" });
  assert.equal(backend.apiKeyEnv, "OPENROUTER_API_KEY", "the refused name falls back to the safe default");
  assert.equal(backend.available, false, "no OPENROUTER_API_KEY in env → not available → the AWS secret is never read/sent");
  assert.ok(backend.warnings.some((w) => /refused/.test(w)));
});

test("--skip-openrouter is read from the KEBAB CLI flag (kebab→camel trap; council Codex/Claude P1)", () => {
  // parseArgs stores --skip-openrouter as options["skip-openrouter"] without camelCasing; the merge must
  // still resolve it, else the opt-out is inert dead-wiring.
  const kebab = mergeOptionsWithPolicy({ "skip-openrouter": true }, parseSimpleYaml("version: 1"));
  assert.equal(kebab.skipOpenRouter, true, "the kebab flag activates the opt-out");
  const camel = mergeOptionsWithPolicy({ skipOpenRouter: true }, parseSimpleYaml("version: 1"));
  assert.equal(camel.skipOpenRouter, true, "the camelCase (programmatic) form also works");
  const off = mergeOptionsWithPolicy({}, parseSimpleYaml("version: 1"));
  assert.equal(off.skipOpenRouter, false);
  const viaPolicy = mergeOptionsWithPolicy({}, parseSimpleYaml("skip_openrouter: true"));
  assert.equal(viaPolicy.skipOpenRouter, true, "a policy skip_openrouter also opts out");
});

test("OpenRouter unconfigured → backend unavailable, no seats (default 3-seat behavior preserved)", () => {
  const merged = mergeOptionsWithPolicy({}, parseSimpleYaml("version: 1"));
  const backend = openRouterBackend(merged, {});
  assert.equal(backend.available, false);
  assert.deepEqual(backend.seats, []);
});

test("parseSimpleYaml handles blocks, lists, inline lists, scalars, and comments", () => {
  const parsed = parseSimpleYaml(`
version: 1 # inline comment
focus: |
  keep # inside block
  second line
require_consensus_for:
  - auth # strip this
  - "security # keep"
skip_paths: [content/blog/**, src/generated/**] # comment
deliberate_peer: true
agent_timeout_minutes: 12
plain: value # strip
quoted: "value # keep"
`);

  assert.equal(parsed.version, 1);
  assert.equal(parsed.focus, "keep # inside block\nsecond line");
  assert.deepEqual(parsed.require_consensus_for, ["auth", "security # keep"]);
  assert.deepEqual(parsed.skip_paths, ["content/blog/**", "src/generated/**"]);
  assert.equal(parsed.deliberate_peer, true);
  assert.equal(parsed.agent_timeout_minutes, 12);
  assert.equal(parsed.plain, "value");
  assert.equal(parsed.quoted, "value # keep");
});