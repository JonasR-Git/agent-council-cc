import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectReviewContext,
  globToRegExp,
  resolveReviewTarget
} from "../plugins/council/scripts/lib/git-context.mjs";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  return result;
}

function gitSpawnUnavailable() {
  const result = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
  return result.error?.code === "EPERM" || result.status == null;
}

test("globToRegExp supports star, globstar, and question mark", () => {
  assert.equal(globToRegExp("src/**/*.js").test("src/a/b.js"), true);
  assert.equal(globToRegExp("src/*.js").test("src/a/b.js"), false);
  assert.equal(globToRegExp("file-?.txt").test("file-a.txt"), true);
});

test("collectReviewContext includes untracked file bodies, supports skipPaths, and works before first commit", (t) => {
  if (gitSpawnUnavailable()) {
    t.skip("git child process is blocked by this sandbox");
    return;
  }

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-repo-"));
  try {
    git(repo, ["init"]);
    fs.writeFileSync(path.join(repo, "new.txt"), "hello untracked\n", "utf8");

    const target = resolveReviewTarget(repo, { scope: "working-tree" });
    const context = collectReviewContext(repo, target);
    assert.equal(context.head, "(no commits)");
    assert.match(context.snapshotId, /^no-commits\+/);
    assert.match(context.content, /## new file: new\.txt/);
    assert.match(context.content, /hello untracked/);

    const skipped = collectReviewContext(repo, target, { skipPaths: ["new.txt"] });
    assert.doesNotMatch(skipped.content, /hello untracked/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});