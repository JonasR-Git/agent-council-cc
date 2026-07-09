import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function readJson(file) {
  return JSON.parse(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
}

test("all six published version fields are consistent", () => {
  const pkg = readJson("package.json");
  const marketplace = readJson(".claude-plugin/marketplace.json");
  const council = readJson("plugins/council/.claude-plugin/plugin.json");
  const grok = readJson("plugins/grok/.claude-plugin/plugin.json");
  const versions = [
    pkg.version,
    marketplace.metadata.version,
    marketplace.plugins[0].version,
    marketplace.plugins[1].version,
    council.version,
    grok.version
  ];
  assert.equal(new Set(versions).size, 1, `version mismatch: ${versions.join(", ")}`);
});
