#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SKIP = new Set([".git", "node_modules"]);

function findModules(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) findModules(file, found);
    else if (entry.isFile() && entry.name.endsWith(".mjs")) found.push(file);
  }
  return found;
}

const root = process.cwd();
const files = findModules(root).sort();
const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) failures.push({ file, output: result.stderr || result.stdout });
}

if (failures.length) {
  for (const failure of failures) {
    console.error(`Syntax check failed: ${path.relative(root, failure.file)}`);
    console.error(failure.output.trim());
  }
  console.error(`Lint failed: ${failures.length}/${files.length} files failed.`);
  process.exitCode = 1;
} else {
  console.log(`Lint passed: ${files.length} .mjs files checked.`);
}
