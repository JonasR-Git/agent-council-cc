import assert from "node:assert/strict";
import test from "node:test";

import { parseSimpleYaml } from "../plugins/council/scripts/lib/policy.mjs";

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