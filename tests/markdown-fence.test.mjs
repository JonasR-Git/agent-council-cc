import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildEvidence } from "../plugins/council/scripts/lib/deliberate.mjs";
import { collectReviewContext, resolveReviewTarget } from "../plugins/council/scripts/lib/git-context.mjs";
import {
  closeDanglingFence,
  wrapMarkdownFence
} from "../plugins/council/scripts/lib/markdown-fence.mjs";

test("wrapMarkdownFence: fence length table", () => {
  assert.equal(wrapMarkdownFence(""), "```\n\n```");
  assert.equal(wrapMarkdownFence("plain text"), "```\nplain text\n```");
  // Body with ``` and no tildes: tilde fence (3) is shorter than backtick fence (4).
  assert.ok(wrapMarkdownFence("code with ``` inside").startsWith("~~~\n"));
  // Body with both ``` and ~~~: backtick fence of 4 wins the tie.
  assert.ok(wrapMarkdownFence("has ``` and ~~~ runs").startsWith("````\n"));
  // Body with ~~~~ and ```: backtick fence (4) shorter than tilde fence (5).
  assert.ok(wrapMarkdownFence("has ~~~~ and ``` runs").startsWith("````\n"));
  assert.equal(wrapMarkdownFence(null), "```\n\n```");
});

test("wrapMarkdownFence: picks the shorter delimiter, backticks on tie", () => {
  const manyBackticks = "``````` seven backticks, no tildes";
  assert.ok(wrapMarkdownFence(manyBackticks).startsWith("~~~\n"));
  const both = "``` and ~~~";
  assert.ok(wrapMarkdownFence(both).startsWith("````\n") || wrapMarkdownFence(both).startsWith("~~~~\n"));
  assert.ok(wrapMarkdownFence("no runs").startsWith("```\n"));
});

test("closeDanglingFence: closes unbalanced fences, leaves balanced text alone", () => {
  const balanced = "text\n```\ncode\n```\nmore";
  assert.equal(closeDanglingFence(balanced), balanced);
  const dangling = "text\n````\ncode with ``` inside\n[cut here]";
  const closed = closeDanglingFence(dangling);
  assert.match(closed, /\n````\n\[\.\.\. fence auto-closed after truncation \.\.\.\]$/);
  const tilde = "x\n~~~\nstill open";
  assert.match(closeDanglingFence(tilde), /\n~~~\n/);
});

function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-fence-repo-"));
  execSync("git init -q", { cwd: dir });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, "utf8");
  }
  return dir;
}

function sectionIsOutsideFences(content, marker) {
  const lines = content.split(/\r?\n/);
  let open = null;
  for (const line of lines) {
    const m = line.match(/^(`{3,}|~{3,})/);
    if (m) {
      const char = m[1][0];
      const len = m[1].length;
      if (!open) open = { char, len };
      else if (char === open.char && len >= open.len) open = null;
      continue;
    }
    if (line.startsWith(marker)) {
      return open === null;
    }
  }
  return false;
}

test("council review context: file containing ``` cannot break section structure", () => {
  const dir = makeRepo({
    "first.md": "docs with a fence:\n```\ninner code\n```\nand a longer run ````\n",
    "second.txt": "SECOND-FILE-CONTENT"
  });
  const context = collectReviewContext(dir, resolveReviewTarget(dir, {}));
  assert.match(context.content, /SECOND-FILE-CONTENT/);
  assert.ok(
    sectionIsOutsideFences(context.content, "## new file: second.txt"),
    "second file heading must not be swallowed by the first file's fences"
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("buildEvidence: snippet containing ``` gets a longer fence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-fence-evidence-"));
  fs.writeFileSync(path.join(dir, "doc.md"), "a\n```\nfenced\n```\nb\n", "utf8");
  const evidence = buildEvidence(dir, [{ id: "e-1", file: "doc.md", line: 3 }], "");
  // Snippet contains ``` -> wrapper must not be a plain ``` fence (here: ~~~ wins as shorter).
  assert.match(evidence, /^~~~\n/m);
  assert.doesNotMatch(evidence, /^```\n/m);
  assert.ok(sectionIsOutsideFences(`${evidence}\n### NEXT`, "### NEXT"));
  fs.rmSync(dir, { recursive: true, force: true });
});
