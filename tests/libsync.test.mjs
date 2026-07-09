import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const pairs = [
  ["plugins/council/scripts/lib/args.mjs", "plugins/grok/scripts/lib/args.mjs"],
  ["plugins/council/scripts/lib/process.mjs", "plugins/grok/scripts/lib/process.mjs"]
];

test("shared duplicated libs stay byte-identical", () => {
  for (const [left, right] of pairs) {
    assert.deepEqual(fs.readFileSync(left), fs.readFileSync(right), `${left} differs from ${right}`);
  }
});