import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, splitRawArgumentString } from "../plugins/council/scripts/lib/args.mjs";

test("unknown flags throw with known flags listed", () => {
  assert.throws(
    () => parseArgs(["--jsonn"], { booleanOptions: ["json"], valueOptions: ["base"] }),
    /Unknown flag --jsonn\. Known flags: --base, --json/
  );
});

test("double dash passes remaining tokens through as positionals", () => {
  const parsed = parseArgs(["--json", "--", "--not-a-flag", "focus"], {
    booleanOptions: ["json"]
  });
  assert.equal(parsed.options.json, true);
  assert.deepEqual(parsed.positionals, ["--not-a-flag", "focus"]);
});

test("inline equals values are parsed", () => {
  const parsed = parseArgs(["--base=main", "--scope", "branch"], {
    valueOptions: ["base", "scope"]
  });
  assert.deepEqual(parsed.options, { base: "main", scope: "branch" });
});

test("quoted raw argument splitter preserves spaces inside quotes", () => {
  assert.deepEqual(splitRawArgumentString('--base main "focus with spaces" --json'), [
    "--base",
    "main",
    "focus with spaces",
    "--json"
  ]);
});