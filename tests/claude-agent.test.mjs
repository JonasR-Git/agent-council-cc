import test from "node:test";
import assert from "node:assert/strict";

import { buildClaudeArgs, runClaudeStructured } from "../plugins/council/scripts/lib/claude-agent.mjs";
import { REVIEWER_CHARTER } from "../plugins/council/scripts/lib/reviewer-charter.mjs";

function valuesAfter(args, flag, stopFlags) {
  const i = args.indexOf(flag);
  if (i === -1) return [];
  const out = [];
  for (let j = i + 1; j < args.length; j += 1) {
    if (args[j].startsWith("--") && (!stopFlags || stopFlags.has(args[j]))) break;
    if (args[j].startsWith("--")) break;
    out.push(args[j]);
  }
  return out;
}

test("buildClaudeArgs confines the reviewer with a read-only ALLOW-list + strict MCP", () => {
  const args = buildClaudeArgs({});
  assert.deepEqual(args.slice(0, 3), ["-p", "--output-format", "text"]);

  // Allowlist: only read/search tools are reachable.
  const allowed = valuesAfter(args, "--allowed-tools");
  assert.deepEqual(allowed, ["Read", "Glob", "Grep"]);

  // strict MCP prevents the repo's own .mcp.json servers from loading.
  assert.ok(args.includes("--strict-mcp-config"), "must not load project MCP servers");

  // Defense in depth: write/exec AND exfiltration/subagent tools denied too.
  const disallowed = valuesAfter(args, "--disallowed-tools");
  for (const tool of ["Edit", "Write", "NotebookEdit", "Bash", "WebFetch", "WebSearch", "Task"]) {
    assert.ok(disallowed.includes(tool), `${tool} must be disallowed for a read-only reviewer`);
  }
});

test("buildClaudeArgs pins the model only when provided", () => {
  assert.equal(buildClaudeArgs({}).includes("--model"), false);

  const pinned = buildClaudeArgs({ claudeModel: "claude-opus-4-8" });
  const mi = pinned.indexOf("--model");
  assert.notEqual(mi, -1);
  assert.equal(pinned[mi + 1], "claude-opus-4-8");
});

test("B2: buildClaudeArgs hard-isolates the finder (--safe-mode), pins the charter, reasons at xhigh", () => {
  const args = buildClaudeArgs({});
  assert.ok(args.includes("--safe-mode"), "safe-mode disables the audited repo's CLAUDE.md/hooks/plugins/MCP");
  const ci = args.indexOf("--append-system-prompt");
  assert.ok(ci >= 0 && args[ci + 1] === REVIEWER_CHARTER, "the stable reviewer charter is appended");
  assert.equal(args[args.indexOf("--effort") + 1], "xhigh", "reasons at xhigh by default (A2 pref)");
  assert.equal(buildClaudeArgs({ claudeEffort: "high" })[buildClaudeArgs({ claudeEffort: "high" }).indexOf("--effort") + 1], "high", "explicit effort wins");
  // the charter is single-line, so it is safe as a cmd.exe-quoted CLI arg (A4)
  assert.equal(REVIEWER_CHARTER.includes("\n"), false);
});

test("B2: runClaudeStructured is fail-closed — a probed-unavailable Claude casts NO finding", async () => {
  const res = await runClaudeStructured("/x", { claude: { cli: { available: false, detail: "not found" } } }, {}, "prompt");
  assert.equal(res.skipped, true, "an unavailable probe skips instead of running");
  assert.equal(res.agent, "claude");
  assert.equal(res.stdout, "", "no output that could be mis-parsed as a clean review");
});
