import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("marketplace and plugin command manifests are complete", () => {
  const marketplaceFile = path.join(ROOT, ".claude-plugin", "marketplace.json");
  const marketplace = JSON.parse(fs.readFileSync(marketplaceFile, "utf8"));
  assert.equal(typeof marketplace.name, "string");
  assert.equal(typeof marketplace.owner, "object");
  assert.equal(typeof marketplace.metadata?.version, "string");
  assert.ok(Array.isArray(marketplace.plugins));

  for (const plugin of marketplace.plugins) {
    for (const field of ["name", "description", "version", "source"]) {
      assert.equal(typeof plugin[field], "string", `${plugin.name ?? "plugin"}.${field}`);
      assert.ok(plugin[field].trim(), `${plugin.name ?? "plugin"}.${field} is empty`);
    }
    const pluginDir = path.resolve(ROOT, plugin.source);
    assert.ok(fs.statSync(pluginDir).isDirectory(), `${plugin.source} is not a directory`);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), "utf8")
    );
    assert.equal(manifest.name, plugin.name);

    const commandsDir = path.join(pluginDir, "commands");
    for (const name of fs.readdirSync(commandsDir).filter((file) => file.endsWith(".md"))) {
      const text = fs.readFileSync(path.join(commandsDir, name), "utf8");
      const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      assert.ok(frontmatter, `${plugin.name}/commands/${name} has no frontmatter`);
      assert.match(frontmatter[1], /^description:\s*\S.+$/m);
    }
  }
});
