import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { escapeHtml, renderJobHtml } from "../plugins/council/scripts/lib/html-report.mjs";
import { addWorktree, listWorktrees, removeWorktree, sanitizeSlug, worktreePaths } from "../plugins/council/scripts/lib/worktree.mjs";

test("escapeHtml neutralizes markup", () => {
  assert.equal(escapeHtml('<script>"x"&\'y\''), "&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;");
});

test("renderJobHtml is self-contained and renders findings + verdicts", () => {
  const job = {
    id: "council-abc",
    kind: "deliberate",
    status: "completed",
    title: "Council Deliberation",
    summary: "test",
    report: "# report\nsome <markdown> body",
    deliberation: {
      verdicts: [
        { agent: "codex", verdict: "approve" },
        { agent: "grok", verdict: "request_changes" }
      ],
      merged: {
        consensus: [{ severity: "P1", title: "Consensus bug", detail: "d", agents: ["codex", "grok"], consensus: true, file: "a.mjs", line: 5 }],
        unique: [{ severity: "nit", title: "A nit", detail: "", agents: ["grok"], consensus: false }],
        all: [
          { severity: "P1", title: "Consensus bug", detail: "<inject>", agents: ["codex", "grok"], consensus: true, file: "a.mjs", line: 5, seenBefore: true, timesSeen: 3 },
          { severity: "nit", title: "A nit", detail: "", agents: ["grok"], consensus: false }
        ]
      }
    }
  };
  const html = renderJobHtml(job);
  assert.match(html, /^<!doctype html>/);
  assert.doesNotMatch(html, /https?:\/\//, "no external asset URLs (self-contained)");
  assert.match(html, /Consensus bug/);
  assert.match(html, /codex: approve/);
  assert.match(html, /seen 3x/);
  // Injected markup in a detail field is escaped, not live.
  assert.doesNotMatch(html, /<inject>/);
  assert.match(html, /&lt;inject&gt;/);
});

test("renderJobHtml handles a solve job with a ranking", () => {
  const html = renderJobHtml({
    id: "council-s",
    kind: "solve",
    status: "completed",
    report: "r",
    solve: { ranking: [{ agent: "codex", avgOverall: 8, votes: 2, blockers: [] }] }
  });
  assert.match(html, /Ranking/);
  assert.match(html, /codex/);
});

test("worktree slug sanitizing and path convention", () => {
  assert.equal(sanitizeSlug("Feature: Add X!!"), "feature-add-x");
  assert.equal(sanitizeSlug(""), "work");
  const p = worktreePaths(process.cwd(), "my slug");
  assert.equal(p.branch, "council-solve/my-slug");
  assert.ok(p.dir.includes("-council-my-slug"));
});

test("worktree add/list/remove against a real temp repo, with idempotency + uncommitted guard", async () => {
  const { hasUncommittedChanges } = await import("../plugins/council/scripts/lib/worktree.mjs");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "council-wt-"));
  execSync("git init -q", { cwd: repo });
  execSync('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m base', { cwd: repo });
  try {
    const added = addWorktree(repo, "demo");
    assert.equal(added.ok, true, added.error);
    assert.ok(fs.existsSync(added.dir));
    assert.equal(added.branch, "council-solve/demo");

    // Idempotent: adding the same slug again reuses the existing worktree.
    const again = addWorktree(repo, "demo");
    assert.equal(again.ok, true);
    assert.equal(again.reused, true);

    assert.ok(listWorktrees(repo).some((e) => e.branch === "council-solve/demo"));

    // Uncommitted-change guard: a new file makes remove refuse without --force.
    fs.writeFileSync(path.join(added.dir, "dirty.txt"), "wip", "utf8");
    assert.equal(hasUncommittedChanges(added.dir), true);
    const refused = removeWorktree(repo, "demo");
    assert.equal(refused.ok, false);
    assert.equal(refused.uncommitted, true);
    assert.ok(fs.existsSync(added.dir), "worktree kept when uncommitted work present");

    // --force discards and removes.
    const removed = removeWorktree(repo, "demo", { force: true });
    assert.equal(removed.ok, true, removed.error);
    assert.ok(!fs.existsSync(added.dir), "worktree dir gone after forced remove");

    // Fixloop scenario: remove keeps the branch, so re-adding the same slug must
    // re-attach the existing branch (no -b), not fail.
    const readd = addWorktree(repo, "demo");
    assert.equal(readd.ok, true, readd.error);
    assert.equal(readd.reattached, true, "re-add attaches the kept branch");
    assert.ok(fs.existsSync(readd.dir));
    removeWorktree(repo, "demo", { force: true });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
