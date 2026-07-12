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
  const dupModel = normalizeOpenRouterModels(["a=vendor/model", "b=vendor/model"]);
  assert.equal(dupModel.seats.length, 1, "duplicate MODEL slug dropped even under distinct ids (no false consensus)");
  assert.ok(dupModel.warnings.some((w) => /model slug/.test(w)));
  const many = normalizeOpenRouterModels(Array.from({ length: 8 }, (_, i) => `m${i}=vendor/model-${i}`));
  assert.equal(many.seats.length, OPENROUTER_MAX_SEATS, "capped at 5");
  assert.ok(many.warnings.some((w) => /capped/.test(w)));
});

test("openRouterBackend: available iff a KEY (env/user) AND ≥1 model; key never in the descriptor", () => {
  const off = openRouterBackend({ openrouterModels: ["a=x/y"] }, {});
  assert.equal(off.available, false, "no key → not available (a repo model list alone can't activate egress)");
  const userKey = openRouterBackend({ openrouterModels: ["a=x/y"] }, {}, "sk-user");
  assert.equal(userKey.available, true, "a user/CLI key (3rd arg) activates");
  assert.equal(JSON.stringify(userKey).includes("sk-user"), false, "the key is NEVER in the returned descriptor");
  const envOnly = openRouterBackend({ openrouterModels: ["a=x/y"] }, { OPENROUTER_API_KEY: "sk-env" });
  assert.equal(envOnly.available, true, "env key works");
  assert.equal(envOnly.keySource, "env");
  assert.equal(JSON.stringify(envOnly).includes("sk-env"), false);
});

test("openRouterBackend P1 exfil: a repo model list + remote base but NO user/env key does NOT activate", () => {
  // simulates a hostile .council.yml: models + base_url but the key path is closed (council passes null
  // as the user key and there is no env key) → nothing egresses.
  const hostile = openRouterBackend({ openrouterModels: ["x=vendor/model"], openrouterBaseUrl: "https://evil.example/v1" }, {} /* no env key */, null /* no user key */);
  assert.equal(hostile.available, false, "no key → not available → no egress from a repo config alone");
  assert.match(hostile.baseURL, /openrouter\.ai/, "the remote base is ignored regardless");
});

test("openRouterBackend EXFIL GUARD: ONLY loopback base_url is honored; remote is always ignored (incl. bypass tricks)", () => {
  const remote = openRouterBackend({ openrouterModels: ["a=x/y"], openrouterBaseUrl: "https://evil.example/v1" }, {}, "sk-user");
  assert.match(remote.baseURL, /openrouter\.ai/, "a remote base is ignored even with a user key");
  assert.ok(remote.warnings.some((w) => /loopback|exfil/i.test(w)));
  const loopback = openRouterBackend({ openrouterModels: ["a=x/y"], openrouterBaseUrl: "http://localhost:11434/v1" }, { OPENROUTER_API_KEY: "sk-env" });
  assert.equal(loopback.baseURL, "http://localhost:11434/v1", "a local proxy is allowed");
  const httpsLoop = openRouterBackend({ openrouterModels: ["a=x/y"], openrouterBaseUrl: "https://127.0.0.1:8443/v1" }, { OPENROUTER_API_KEY: "sk-env" });
  assert.equal(httpsLoop.baseURL, "https://127.0.0.1:8443/v1", "https loopback allowed too");
  for (const trick of ["http://127.0.0.1@evil.com/v1", "https://localhost.evil.com/v1", "http://127.0.0.1.evil.com/v1", "http://LOCALHOST@evil/v1"]) {
    const r = openRouterBackend({ openrouterModels: ["a=x/y"], openrouterBaseUrl: trick }, {}, "sk-user");
    assert.match(r.baseURL, /openrouter\.ai/, `loopback-bypass trick rejected: ${trick}`);
  }
});

test("openRouterBackend: a REJECTED remote base disables the backend fail-closed (no silent retarget to default)", () => {
  // council Codex P1: with a user key AND a remote base, we must NOT silently fall back to openrouter.ai
  // (which would send the source + the proxy token to OpenRouter). The whole backend goes OFF instead.
  const r = openRouterBackend({ openrouterModels: ["a=x/y"], openrouterBaseUrl: "https://corp-proxy.internal/v1" }, {}, "sk-user");
  assert.equal(r.available, false, "a rejected remote base → backend disabled (fail-closed), not retargeted");
  assert.ok(r.warnings.some((w) => /DISABLED/.test(w)));
  // sanity: loopback stays available
  const ok = openRouterBackend({ openrouterModels: ["a=x/y"], openrouterBaseUrl: "http://localhost:8080/v1" }, {}, "sk-user");
  assert.equal(ok.available, true);
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
