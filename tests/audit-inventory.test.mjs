import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCodebaseModel, fileClassOf, inventoryFiles } from "../plugins/council/scripts/lib/codebase-model.mjs";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  return result;
}

function gitSpawnUnavailable() {
  const result = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
  return result.error?.code === "EPERM" || result.status == null;
}

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

test("buildCodebaseModel trusts an empty (but successful) git ls-files as genuinely empty, not a gitignore-blind fs walk", (t) => {
  if (gitSpawnUnavailable()) {
    t.skip("git child process is blocked by this sandbox");
    return;
  }
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "council-enum-"));
  const dir = path.join(parent, "repo");
  fs.mkdirSync(dir);
  try {
    git(dir, ["init"]);
    // Exclude via core.excludesFile (outside the repo, so no extra untracked file like
    // .gitignore pollutes ls-files' output) -> `git ls-files --cached --others
    // --exclude-standard -z` succeeds (status 0) with truly EMPTY stdout. The graph
    // enumerator must agree with inventoryFiles that this means "no files" instead of
    // falling back to a raw fs walk (which only skips node_modules/.git and would leak
    // the excluded files).
    const excludeFile = path.join(parent, "exclude-mjs.txt");
    fs.writeFileSync(excludeFile, "*.mjs\n");
    git(dir, ["config", "core.excludesFile", excludeFile]);
    fs.writeFileSync(path.join(dir, "a.mjs"), "export function a(){ return 1; }\n");
    fs.writeFileSync(path.join(dir, "b.mjs"), "export function b(){ return 2; }\n");

    const check = git(dir, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
    assert.equal(check.stdout, "", "sanity: git ls-files must report truly empty stdout for this fixture");

    const model = buildCodebaseModel(dir);
    assert.equal(model.files.length, 0, "excluded files must not leak in via an fs-walk fallback");
    assert.equal(model.coverage.modules, 0);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("churnMap keys align with ls-files ids for non-ASCII filenames (git log -z, not C-quoted)", (t) => {
  if (gitSpawnUnavailable()) {
    t.skip("git child process is blocked by this sandbox");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-churn-"));
  try {
    git(dir, ["init"]);
    git(dir, ["config", "user.email", "a@b.com"]);
    git(dir, ["config", "user.name", "test"]);
    fs.writeFileSync(path.join(dir, "café.mjs"), "export const x = 1;\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "add unicode file"]);

    const model = buildCodebaseModel(dir, { churnDays: 365 });
    assert.equal(model.coverage.churnAvailable, true);
    const file = model.files.find((f) => f.id === "café.mjs");
    assert.ok(file, "the non-ASCII file is present in the model");
    assert.equal(file.churn, 1, "churn must match despite git's default C-quoting of non-ASCII paths");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
