import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { fileClassOf, inventoryFiles } from "../plugins/council/scripts/lib/codebase-model.mjs";

test("fileClassOf classifies the whole surface, not just JS", () => {
  assert.equal(fileClassOf("src/a.mjs"), "js");
  assert.equal(fileClassOf("src/a.ts"), "js");
  assert.equal(fileClassOf("package-lock.json"), "manifest");
  assert.equal(fileClassOf(".github/workflows/ci.yml"), "ci");
  assert.equal(fileClassOf("config/app.toml"), "config");
  assert.equal(fileClassOf(".env.production"), "secret");
  assert.equal(fileClassOf("README.md"), "doc");
  assert.equal(fileClassOf("svc/main.go"), "code-other");
  assert.equal(fileClassOf("LICENSE"), "other");
});

test("inventoryFiles maps ALL non-ignored files (fs fallback), tagged by class", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-inv-"));
  fs.writeFileSync(path.join(dir, "a.mjs"), "export const x = 1;\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# hi\n");
  fs.writeFileSync(path.join(dir, "config.yml"), "a: 1\n");
  fs.mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "dep", "index.js"), "x\n");

  const inv = inventoryFiles(dir);
  const ids = inv.map((f) => f.id);
  assert.ok(ids.includes("a.mjs") && ids.includes("README.md") && ids.includes("config.yml"), "non-JS files are mapped too");
  assert.ok(!ids.some((id) => id.includes("node_modules")), "ignored trees excluded");
  assert.equal(inv.find((f) => f.id === "README.md").fileClass, "doc");
  assert.equal(inv.find((f) => f.id === "config.yml").fileClass, "config");
});
