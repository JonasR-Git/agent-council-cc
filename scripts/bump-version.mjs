#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

if (!version || !SEMVER.test(version)) {
  console.error("Usage: node scripts/bump-version.mjs <semver> (for example, 0.5.0)");
  process.exitCode = 1;
} else {
  const files = {
    package: "package.json",
    marketplace: ".claude-plugin/marketplace.json",
    council: "plugins/council/.claude-plugin/plugin.json",
    grok: "plugins/grok/.claude-plugin/plugin.json"
  };
  const read = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, name), "utf8"));
  const write = (name, value) =>
    fs.writeFileSync(path.join(ROOT, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");

  const pkg = read(files.package);
  const marketplace = read(files.marketplace);
  const council = read(files.council);
  const grok = read(files.grok);
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length !== 2) {
    throw new Error("marketplace.json must contain exactly two plugin entries");
  }

  pkg.version = version;
  marketplace.metadata.version = version;
  marketplace.plugins[0].version = version;
  marketplace.plugins[1].version = version;
  council.version = version;
  grok.version = version;

  write(files.package, pkg);
  write(files.marketplace, marketplace);
  write(files.council, council);
  write(files.grok, grok);
  console.log(`Updated 6 version fields to ${version}:`);
  for (const file of Object.values(files)) console.log(`- ${file}`);
}
