// The user-facing surface of `council plan` / `council build` (skills-docs module). These tests are
// DISCRIMINATING for the docs contract: they fail if a doc is missing, loses its frontmatter (the
// manifests test only checks description), drops a contract-critical flag/guarantee, or starts
// advertising one of the escape hatches that Safety v1 explicitly forbids on `build`.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readDoc(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), "utf8");
}

/** The commands/*.md frontmatter block (same shape the plugin manifest test enforces). */
function frontmatterOf(text, name) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(match, `${name} has no frontmatter`);
  return match[1];
}

test("plan.md documents the read-only multi-model deliberation", () => {
  const text = readDoc("plugins", "council", "commands", "plan.md");
  const frontmatter = frontmatterOf(text, "plan.md");
  assert.match(frontmatter, /^description:\s*\S.+$/m, "description present");
  assert.match(frontmatter, /^argument-hint:/m, "argument-hint present");
  assert.match(frontmatter, /^allowed-tools:.*Bash\(node:\*\)/m, "thin node wrapper");

  // The companion invocation follows the other thin-wrapper commands (audit/doctor/status).
  assert.match(text, /council-companion\.mjs" plan \$ARGUMENTS/, "invokes the plan subcommand");

  // Contract-critical content: synthesizer override, JSON output, the PlanSpec artifact,
  // the deliberation shape, and the read-only guarantee.
  for (const needle of ["--synthesizer", "--json", "PlanSpec", "requestHash", "baseCommit", "state dir"]) {
    assert.ok(text.includes(needle), `plan.md mentions ${needle}`);
  }
  assert.match(text, /READ-ONLY|read-only/, "read-only guarantee stated");
  assert.match(text, /every active seat/i, "dynamic seat registry, not a fixed pair");
  assert.match(text, /fail-closed/i, "fail-closed validation stated");
  assert.ok(text.includes("council build"), "hands off to council build");
});

test("build.md documents the fail-closed gate ladder without escape hatches", () => {
  const text = readDoc("plugins", "council", "commands", "build.md");
  const frontmatter = frontmatterOf(text, "build.md");
  assert.match(frontmatter, /^description:\s*\S.+$/m, "description present");
  assert.match(frontmatter, /^argument-hint:/m, "argument-hint present");
  assert.match(text, /council-companion\.mjs" build \$ARGUMENTS/, "invokes the build subcommand");

  // The only flags the command has.
  for (const flag of ["--from", "--dry-run", "--json"]) {
    assert.ok(frontmatter.includes(flag), `argument-hint offers ${flag}`);
  }

  // The ladder's load-bearing guarantees, in plain language.
  for (const needle of [
    "RED",
    "GREEN",
    "capability boundary",
    "unanimous",
    "byte-for-byte",
    "baseCommit",
    "stranded",
    "One commit per step"
  ]) {
    assert.ok(text.includes(needle), `build.md mentions ${needle}`);
  }
  assert.match(text, /clean working\s+tree/i, "clean-tree requirement stated");
  assert.match(text, /never merged/i, "the branch is never merged");
  assert.match(text, /ABORTS?\b/, "abort-on-first-failure stated");

  // Safety v1: the escape hatches must be named ONLY as non-features, never offered as flags.
  for (const hatch of ["--allow-untested", "--skip-council", "--skip-codex", "--skip-grok"]) {
    assert.ok(!frontmatter.includes(hatch), `argument-hint must not advertise ${hatch}`);
  }
  assert.match(text, /no\s+`--allow-untested`/, "explicitly disclaims --allow-untested");
  assert.match(text, /no\s+`--skip-council`/, "explicitly disclaims --skip-council");
  assert.match(text, /no\s+auto-merge/, "explicitly disclaims auto-merge");
});

test("plan-build-usage.md walks the workflow and is honest about limitations", () => {
  const text = readDoc("docs", "plan-build-usage.md");

  // The five workflow stages, in order.
  const stages = ["## 1. Plan", "## 2. Read", "## 3. Build", "## 4. Review the branch", "## 5. Merge yourself"];
  let cursor = -1;
  for (const stage of stages) {
    const at = text.indexOf(stage);
    assert.ok(at > cursor, `usage doc has ${stage} after the previous stage`);
    cursor = at;
  }

  assert.match(text, /^## Limitations/m, "has a LIMITATIONS section");
  const limitations = text.slice(text.indexOf("## Limitations"));
  for (const limit of ["No deletes", "dependency", "cross-cutting", "No resume", "Node ESM"]) {
    assert.ok(limitations.includes(limit), `limitations cover: ${limit}`);
  }

  // The human stays the merger; the plan is editable but hash/base-bound.
  assert.ok(text.includes("--from"), "shows the build --from handoff");
  assert.match(text, /never merges/i, "build never merges");
  assert.ok(text.includes("requestHash"), "explains the requestHash binding");
  assert.ok(text.includes("baseCommit"), "explains the baseCommit binding");
});
