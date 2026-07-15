import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { route } from "../plugins/council/scripts/lib/cli-dispatch.mjs";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ENTRYPOINT GUARD (facade-class regression): every `council-companion.mjs <verb> …` invocation that
// the slash-command docs (plugins/council/commands/*.md) and skills (plugins/council/skills/**/SKILL.md)
// tell the user/Claude to run MUST resolve to a real dispatch handler. When the CLI redesign removed the
// legacy verb NAMES (deliberate/result/adversarial/watch/wait/audit/doctor…, commit 3614543), a doc that
// still called an old name would silently break at runtime with "unknown command". This test pins that
// every documented entrypoint routes to a non-error handler, and that any `--mode <x>` is a real review
// mode — so a future verb rename can't leave a dangling doc reference unnoticed.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const DOC_DIRS = [
  path.join(repoRoot, "plugins/council/commands"),
  path.join(repoRoot, "plugins/council/skills")
];

// review `--mode` values that handleReview accepts (deep/run/endless reach the audit engines;
// quick/deliberate/adversarial are the review styles). Keep in sync with resolveReviewMode / REVIEW_AUDIT_MODES.
const KNOWN_REVIEW_MODES = new Set(["quick", "deliberate", "adversarial", "deep", "run", "endless"]);

function mdFilesUnder(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...mdFilesUnder(p));
    else if (entry.name.endsWith(".md")) out.push(p);
  }
  return out;
}

// Pull every `council-companion.mjs …` invocation's VERB (first bare word) and optional `--mode` value.
// Flags (-x), placeholders ($ARGUMENTS, ${CLAUDE_PLUGIN_ROOT}), optional-brackets ([--background]) and
// quoted paths are skipped so the first BARE lowercase token is the verb.
function invocationsIn(text) {
  const out = [];
  const re = /council-companion\.mjs"?\s+([^\n\r]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const toks = m[1].split(/\s+/).filter(Boolean);
    const verb = toks.find((t) => /^[a-z][a-z-]*$/.test(t));
    if (!verb) continue;
    let mode = null;
    const mi = toks.indexOf("--mode");
    if (mi >= 0 && toks[mi + 1] && /^[a-z]+$/.test(toks[mi + 1])) mode = toks[mi + 1];
    out.push({ verb, mode, snippet: m[1].trim().slice(0, 80) });
  }
  return out;
}

test("every documented council-companion.mjs invocation resolves to a real handler (no removed verb)", () => {
  const files = DOC_DIRS.flatMap(mdFilesUnder);
  assert.ok(files.length >= 7, `expected the 7-verb command docs to exist, found ${files.length} .md files`);

  const problems = [];
  let checked = 0;
  for (const file of files) {
    const rel = path.relative(repoRoot, file);
    for (const inv of invocationsIn(fs.readFileSync(file, "utf8"))) {
      checked++;
      const r = route([inv.verb]);
      if (!r || r.handler === "error") {
        problems.push(`${rel}: verb '${inv.verb}' → ${r?.handler ?? "?"} (removed/unknown verb) [${inv.snippet}]`);
        continue;
      }
      if (inv.mode && !KNOWN_REVIEW_MODES.has(inv.mode)) {
        problems.push(`${rel}: --mode '${inv.mode}' is not a known review mode [${inv.snippet}]`);
      }
    }
  }

  assert.ok(checked >= 8, `expected to find documented invocations to check, found ${checked}`);
  assert.equal(problems.length, 0, `documented CLI entrypoints must resolve to a real handler:\n  ${problems.join("\n  ")}`);
});
