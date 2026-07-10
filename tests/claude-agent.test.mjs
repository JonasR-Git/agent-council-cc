import test from "node:test";
import assert from "node:assert/strict";

import { buildClaudeArgs } from "../plugins/council/scripts/lib/claude-agent.mjs";

test("buildClaudeArgs runs headless print mode and disallows all write tools", () => {
  const args = buildClaudeArgs({});
  assert.deepEqual(args.slice(0, 3), ["-p", "--output-format", "text"]);
  const di = args.indexOf("--disallowed-tools");
  assert.notEqual(di, -1, "read-only reviewer must disallow write tools");
  const disallowed = args.slice(di + 1);
  for (const tool of ["Edit", "Write", "NotebookEdit", "Bash"]) {
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
