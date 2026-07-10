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
    council: "plugins/council/.claude-plugin/plugin.json"
  };
  const read = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, name), "utf8"));
  const write = (name, value) =>
    fs.writeFileSync(path.join(ROOT, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");

  const pkg = read(files.package);
  const marketplace = read(files.marketplace);
  const council = read(files.council);
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length !== 1) {
    throw new Error("marketplace.json must contain exactly one plugin entry");
  }

  pkg.version = version;
  marketplace.metadata.version = version;
  marketplace.plugins[0].version = version;
  council.version = version;

  write(files.package, pkg);
  write(files.marketplace, marketplace);
  write(files.council, council);
  console.log(`Updated 4 version fields to ${version}:`);
  for (const file of Object.values(files)) console.log(`- ${file}`);
}
