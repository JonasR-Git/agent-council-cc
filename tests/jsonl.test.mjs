import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendJsonlCapped, readJsonl, writeJsonlCapped } from "../plugins/council/scripts/lib/jsonl.mjs";

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-jsonl-"));
  return path.join(dir, "store.jsonl");
}

test("readJsonl returns [] for a missing file and skips blank/corrupt lines", () => {
  assert.deepEqual(readJsonl(path.join(os.tmpdir(), "does-not-exist-xyz.jsonl")), []);
  const file = tmpFile();
  fs.writeFileSync(file, '{"a":1}\n\n{bad json}\n{"a":2}\n', "utf8");
  assert.deepEqual(readJsonl(file), [{ a: 1 }, { a: 2 }]);
});

test("writeJsonlCapped keeps only the last `max` entries, atomically", () => {
  const file = tmpFile();
  writeJsonlCapped(file, [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }], 2);
  assert.deepEqual(readJsonl(file), [{ n: 3 }, { n: 4 }]);
  // round-trips through the file with a trailing newline
  assert.ok(fs.readFileSync(file, "utf8").endsWith("\n"));
});

test("writeJsonlCapped with no cap writes everything; empty writes an empty file", () => {
  const file = tmpFile();
  writeJsonlCapped(file, [{ n: 1 }, { n: 2 }]);
  assert.equal(readJsonl(file).length, 2);
  writeJsonlCapped(file, []);
  assert.deepEqual(readJsonl(file), []);
  assert.equal(fs.readFileSync(file, "utf8"), "");
});

test("appendJsonlCapped appends then caps to the last `max`", () => {
  const file = tmpFile();
  for (let i = 1; i <= 5; i += 1) appendJsonlCapped(file, { i }, 3);
  assert.deepEqual(readJsonl(file), [{ i: 3 }, { i: 4 }, { i: 5 }]);
});
