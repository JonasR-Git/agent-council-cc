import assert from "node:assert/strict";
import test from "node:test";

import { normalizeOpenRouterModels, openRouterBackend, registerOpenRouterKey, runOpenRouterStructured, OPENROUTER_MAX_SEATS } from "../plugins/council/scripts/lib/openrouter-agent.mjs";
import { isRateLimitError } from "../plugins/council/scripts/lib/audit-retry.mjs";

test("normalizeOpenRouterModels parses the 3 string forms + object form, sanitizes ids", () => {
  const { seats } = normalizeOpenRouterModels(["anthropic/claude-3.5", "gpt=openai/gpt-4o", "r1=deepseek/r1@high", { id: "llama", model: "meta/llama-3.1", effort: "low" }]);
  assert.equal(seats.length, 4);
  assert.equal(seats[0].id, "or-anthropic-claude-3-5");
  assert.equal(seats[1].id, "or-gpt");
  assert.equal(seats[1].model, "openai/gpt-4o");
  assert.equal(seats[2].effort, "high");
  assert.equal(seats[3].id, "or-llama");
  for (const s of seats) assert.match(s.id, /^or-[a-z0-9-]+$/, "ids are sanitized");
});

test("normalizeOpenRouterModels rejects built-in collisions, dedupes, and HARD-CAPS at 5", () => {
  const collide = normalizeOpenRouterModels(["codex=some/model", "grok=x/y"]);
  assert.equal(collide.seats.length, 0, "or-codex / or-grok collide with built-ins → dropped");
  assert.ok(collide.warnings.some((w) => /collides/.test(w)));
  const dup = normalizeOpenRouterModels(["a=x/y", "a=x/z"]);
  assert.equal(dup.seats.length, 1, "duplicate id dropped");
  const many = normalizeOpenRouterModels(Array.from({ length: 8 }, (_, i) => `m${i}=vendor/model-${i}`));
  assert.equal(many.seats.length, OPENROUTER_MAX_SEATS, "capped at 5");
  assert.ok(many.warnings.some((w) => /capped/.test(w)));
});

test("openRouterBackend: available iff a key AND ≥1 model; key held in module scope, not returned", () => {
  const off = openRouterBackend({ openrouterModels: ["a=x/y"] }, {});
  assert.equal(off.available, false, "no key → not available");
  const on = openRouterBackend({ openrouterModels: ["a=x/y"], openrouterApiKey: "sk-secret" }, {});
  assert.equal(on.available, true);
  assert.equal(on.apiKeyPresent, true);
  assert.equal(JSON.stringify(on).includes("sk-secret"), false, "the key is NEVER in the returned descriptor");
  const envOnly = openRouterBackend({ openrouterModels: ["a=x/y"] }, { OPENROUTER_API_KEY: "sk-env" });
  assert.equal(envOnly.available, true, "env key works");
  assert.equal(JSON.stringify(envOnly).includes("sk-env"), false);
});

test("openRouterBackend EXFIL GUARD: a remote base_url is ignored with an ENV key, honored with an explicit key; non-https ignored", () => {
  const envRemote = openRouterBackend({ openrouterModels: ["a=x/y"], openrouterBaseUrl: "https://evil.example/v1" }, { OPENROUTER_API_KEY: "sk-env" });
  assert.match(envRemote.baseURL, /openrouter\.ai/, "env key + repo remote base → default (exfil-blocked)");
  assert.ok(envRemote.warnings.some((w) => /exfil guard/.test(w)));
  const explicitRemote = openRouterBackend({ openrouterModels: ["a=x/y"], openrouterApiKey: "sk-x", openrouterBaseUrl: "https://proxy.mine/v1" }, {});
  assert.equal(explicitRemote.baseURL, "https://proxy.mine/v1", "explicit key + custom https base → honored");
  const insecure = openRouterBackend({ openrouterModels: ["a=x/y"], openrouterApiKey: "sk-x", openrouterBaseUrl: "http://evil.example/v1" }, {});
  assert.match(insecure.baseURL, /openrouter\.ai/, "non-https remote base → ignored");
  const loopback = openRouterBackend({ openrouterModels: ["a=x/y"], openrouterBaseUrl: "http://localhost:11434/v1" }, { OPENROUTER_API_KEY: "sk-env" });
  assert.equal(loopback.baseURL, "http://localhost:11434/v1", "a local proxy is allowed even with an env key");
});

const seatBackends = () => ({ openrouter: { available: true, baseURL: "https://openrouter.ai/api/v1", seats: [{ id: "or-x", model: "vendor/model" }] } });

test("runOpenRouterStructured: a 2xx content reply → status 0, stdout = content (injected transport, no network)", async () => {
  registerOpenRouterKey("sk-secret");
  const transport = async () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: '{"agent":"or-x","findings":[]}' } }] }) });
  const r = await runOpenRouterStructured("/x", seatBackends(), {}, "review this", "or-x", { transport });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /findings/);
  assert.equal(r.agent, "or-x");
});

test("runOpenRouterStructured: a 429 → rate-limit signal; a 401 → permanent; the key is SCRUBBED from stderr", async () => {
  registerOpenRouterKey("sk-secret");
  const b = seatBackends();
  const r429 = await runOpenRouterStructured("/x", b, {}, "p", "or-x", { transport: async () => ({ status: 429, body: "rate limited, key sk-secret leaked" }) });
  assert.equal(r429.status, 429);
  assert.equal(isRateLimitError(`${r429.stderr}`), true, "429 is a transient rate-limit (cell scheduler will back off)");
  assert.equal(r429.stderr.includes("sk-secret"), false, "the API key is scrubbed from surfaced error text");
  assert.match(r429.stderr, /\[redacted\]/);
  const r401 = await runOpenRouterStructured("/x", b, {}, "p", "or-x", { transport: async () => ({ status: 401, body: "invalid api key" }) });
  assert.equal(isRateLimitError(`${r401.stderr}`), false, "401/invalid-key is PERMANENT — never retried");
});

test("runOpenRouterStructured: a transport timeout → status 124 timedOut; a missing seat → skipped", async () => {
  registerOpenRouterKey("sk-secret");
  const r = await runOpenRouterStructured("/x", seatBackends(), {}, "p", "or-x", { transport: async () => { throw new Error("timeout"); } });
  assert.equal(r.status, 124);
  assert.equal(r.timedOut, true);
  const miss = await runOpenRouterStructured("/x", seatBackends(), {}, "p", "or-unknown", { transport: async () => ({ status: 200, body: "{}" }) });
  assert.equal(miss.skipped, true, "an unconfigured seat id is skipped, not run");
});
