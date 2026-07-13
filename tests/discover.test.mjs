import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { newestMatching } from "../plugins/council/scripts/lib/discover.mjs";

test("newestMatching degrades to null when a probe throws, instead of crashing the command", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "council-discover-"));
  try {
    fs.mkdirSync(path.join(tmp, "sub"));
    // A predicate/stat failure at probe time (models the ENOTDIR/race the guard is for): readdir
    // succeeds, then the per-entry probe throws. Without the try/catch this propagated and crashed.
    const boom = () => {
      throw new Error("ENOTDIR (simulated probe failure)");
    };
    assert.doesNotThrow(() => newestMatching(tmp, boom));
    assert.equal(newestMatching(tmp, boom), null);

    // Realistic ENOTDIR: the path is a regular file, so readdirSync throws — still degrades to null.
    const asFile = path.join(tmp, "not-a-dir");
    fs.writeFileSync(asFile, "x", "utf8");
    assert.doesNotThrow(() => newestMatching(asFile, () => true));
    assert.equal(newestMatching(asFile, () => true), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("newestMatching returns null for a non-existent directory (existing behaviour preserved)", () => {
  assert.equal(newestMatching(path.join(os.tmpdir(), "council-discover-does-not-exist-xyz"), () => true), null);
});
