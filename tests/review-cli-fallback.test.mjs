import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// SILENTLY-DROPPED-SEAT GUARD (facade-class regression). The structured path (agents.mjs runCodexStructured)
// already falls back from the codex-companion to the standalone `codex exec` CLI, but the DEEP-review path
// runCodexReview was MISSED — a user with the codex CLI but no companion had a silently-dropped sixth eye,
// even though setup reports codex reachable via cli.available. This pins that BOTH deep-review seats fall
// back to their own CLI when the companion is absent, rather than returning skipped. Source-level because
// the review functions are internal (not exported); consistent with tests/agents-codex-cli.test.mjs.

const src = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugins/council/scripts/council-companion.mjs"),
  "utf8"
);

function functionBody(name) {
  const start = src.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} exists in council-companion.mjs`);
  const next = src.indexOf("\nasync function ", start + 20);
  return src.slice(start, next >= 0 ? next : start + 2500);
}

test("runCodexReview falls back to the codex CLI when the companion is absent (no silently-dropped seat)", () => {
  const body = functionBody("runCodexReview");
  assert.ok(/backends\.codex\.cli\.available/.test(body), "it consults codex.cli.available");
  assert.ok(/runCodexCli\(/.test(body), "it invokes the standalone codex CLI fallback (runCodexCli)");
  // The OLD bug: an unconditional skip the moment the companion is missing, before ever trying the CLI.
  assert.ok(
    !/!backends\.codex\.companionAvailable\)\s*\{\s*return\s*\{[^}]*skipped:\s*true/.test(body),
    "it must NOT bail to skipped merely because the companion is missing"
  );
});

test("runGrokReview falls back to the grok CLI when the companion is absent (parity)", () => {
  const body = functionBody("runGrokReview");
  assert.ok(/backends\.grok\.cli\.available/.test(body), "it consults grok.cli.available");
  assert.ok(/findGrokBinary\(/.test(body), "it invokes the standalone grok CLI fallback");
});
