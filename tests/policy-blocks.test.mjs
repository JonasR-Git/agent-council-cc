import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadPolicy,
  parseSimpleYaml,
  parseFixBlock,
  parseVerbBlocks,
  verbBlockWarnings,
  KNOWN_BLOCKS,
  DEFAULT_POLICY
} from "../plugins/council/scripts/lib/policy.mjs";

const REPO_COUNCIL_YML = fileURLToPath(new URL("../.council.yml", import.meta.url));

// A byte-for-byte copy of the ORIGINAL single-purpose `parseFixBlock` (pre-Stage-1). The refactor made
// the shipping parseFixBlock delegate to parseVerbBlocks; this reference proves the delegation is
// byte-identical to what it replaced across every fixture below — Stage 1's whole safety contract.
function oldParseFixBlock(text) {
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^fix:\s*(#.*)?$/.test(lines[i])) continue;
    const out = {};
    for (let j = i + 1; j < lines.length; j += 1) {
      const l = lines[j];
      if (!l.trim() || l.trim().startsWith("#")) continue;
      if (!/^\s/.test(l)) break;
      const m = l.match(/^\s+([A-Za-z0-9_]+):\s*(.*)$/);
      if (!m) break;
      const val = stripInlineCommentRef(m[2].trimEnd()).trim();
      out[m[1]] = coerceScalarRef(stripQuotesRef(val));
    }
    return Object.keys(out).length ? out : null;
  }
  return null;
}
// Reference copies of the module-private helpers (so the old extractor above is self-contained).
function stripInlineCommentRef(s) {
  const trimmed = String(s ?? "").trimStart();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return s;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s;
}
function stripQuotesRef(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}
function coerceScalarRef(s) {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

// Capture stderr from a synchronous body by swapping console.error. Returns the collected lines.
function captureStderr(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(" "));
  try {
    fn();
  } finally {
    console.error = orig;
  }
  return lines;
}

function withTmpPolicy(yamlText, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-blocks-"));
  try {
    fs.writeFileSync(path.join(dir, ".council.yml"), yamlText, "utf8");
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── parseVerbBlocks: recovers EVERY one-level-nested known block ─────────────────────────────────

test("parseVerbBlocks recovers review:/plan:/build:/status:/defaults:/fix: into policy.<block> objects", () => {
  const text = [
    "version: 1",
    "review:",
    "  default_mode: deliberate",
    "  scope: auto",
    "  groups: lens",
    "plan:",
    "  synthesizer: claude",
    "build:",
    "  budget: 3000",
    "status:",
    "  interval: 2",
    "defaults:",
    "  budget: 1500",
    "  max_cells: 40",
    "fix:",
    "  loop: true",
    "  max_passes: 100",
    ""
  ].join("\n");
  const blocks = parseVerbBlocks(text);
  assert.deepEqual(blocks.review, { default_mode: "deliberate", scope: "auto", groups: "lens" });
  assert.deepEqual(blocks.plan, { synthesizer: "claude" });
  assert.deepEqual(blocks.build, { budget: 3000 });
  assert.deepEqual(blocks.status, { interval: 2 });
  assert.deepEqual(blocks.defaults, { budget: 1500, max_cells: 40 });
  assert.deepEqual(blocks.fix, { loop: true, max_passes: 100 });
});

test("parseVerbBlocks is BOUNDED: a childless block is omitted; a nested list ends the block (no deep descent)", () => {
  // Empty `build:` → omitted entirely (behaves like no block). Under `status:`, the deeper-indented
  // list under `tags:` is NOT descended into — the block ENDS at that list item, so `never:` (which
  // sits after it) is never captured. This is the one-level-of-nesting bound.
  const blocks = parseVerbBlocks("build:\nstatus:\n  interval: 2\n  tags:\n    - x\n  never: 1\n");
  assert.equal("build" in blocks, false, "childless build: is omitted");
  assert.equal(blocks.status.interval, 2);
  assert.equal("never" in blocks.status, false, "the block ended at the nested list — no deep descent");
});

test("parseVerbBlocks ignores unknown top-level headers (only the 6 known blocks become objects)", () => {
  const blocks = parseVerbBlocks("madeup:\n  x: 1\nreview:\n  scope: full\n");
  assert.equal("madeup" in blocks, false);
  assert.deepEqual(blocks.review, { scope: "full" });
});

test("loadPolicy reads a nested review: block into policy.review (and keeps flat top-level keys)", () => {
  withTmpPolicy("version: 1\ncodex_model: x\nreview:\n  default_mode: deliberate\n  scope: full\n", (dir) => {
    const pol = loadPolicy(dir);
    assert.deepEqual(pol.review, { default_mode: "deliberate", scope: "full" });
    assert.equal(pol.codex_model, "x", "flat top-level key still parsed");
    assert.equal("plan" in pol, false, "an absent block is absent (not a stray \"\")");
  });
});

// ── parseFixBlock stays BYTE-IDENTICAL (the refactor is a pure delegation) ────────────────────────

test("parseFixBlock is byte-identical to the pre-Stage-1 extractor across fixtures + the real .council.yml", () => {
  const fixtures = [
    "version: 1\n",                                             // no fix: block
    "fix:\nversion: 1\n",                                       // header, no indented children
    "fix:   # profile\n  loop: true\n\n  # note\n  deep: false\n",
    "version: 1\nfix:\n  loop: true\n  autonomy: aggressive\n  budget: 2000\n  usage_ceiling: 90/90/90\nother: 1\n",
    "review:\n  scope: auto\nfix:\n  deep: true\n  max_passes: 100\n",   // fix after another block
    fs.readFileSync(REPO_COUNCIL_YML, "utf8")                   // the repo's real committed config
  ];
  for (const t of fixtures) {
    assert.deepEqual(parseFixBlock(t), oldParseFixBlock(t), `parseFixBlock diverged for:\n${t}`);
  }
});

test("the repo's current .council.yml parses policy.fix byte-identical to the known snapshot", () => {
  const text = fs.readFileSync(REPO_COUNCIL_YML, "utf8");
  assert.deepEqual(parseFixBlock(text), {
    loop: true, deep: true, epoch_sweep: true, per_tier: true, supervise: true,
    autonomy: "aggressive", structure_auto_apply: true, sensitive_auto_apply: true,
    retry_on_limit: true, usage_ceiling: "90/90/90", pause_at_5h: "auto:90",
    max_passes: 100, budget: 2000
  });
});

test("loadPolicy over the real .council.yml warns on NOTHING (all fix: keys are recognized)", () => {
  withTmpPolicy(fs.readFileSync(REPO_COUNCIL_YML, "utf8"), (dir) => {
    const warnings = captureStderr(() => {
      const pol = loadPolicy(dir);
      assert.equal(pol._warnings.length, 0, `unexpected warnings: ${JSON.stringify(pol._warnings)}`);
    });
    assert.deepEqual(warnings, [], `real config must load silently, got: ${JSON.stringify(warnings)}`);
  });
});

// ── LOUD unknown-key warnings (captured, never silent) ────────────────────────────────────────────

test("verbBlockWarnings flags an unknown block key (a typo like epoch_sweeps), keeps the value parsed", () => {
  const blocks = parseVerbBlocks("fix:\n  epoch_sweeps: true\n  loop: true\n");
  assert.equal(blocks.fix.epoch_sweeps, true, "value is still parsed (non-destructive forward-compat)");
  const warnings = verbBlockWarnings(blocks, ".council.yml");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /fix\.epoch_sweeps is not a recognized fix: key/);
});

test("defaults: HARD whitelist — a non-whitelisted key (loop) warns", () => {
  const warnings = verbBlockWarnings(parseVerbBlocks("defaults:\n  budget: 10\n  loop: true\n"));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /defaults\.loop is not a recognized defaults: key/);
});

test("loadPolicy PRINTS the unknown-key warning to stderr AND returns it in _warnings (captured, not silent)", () => {
  // A unique typo key dodges the per-process print de-dupe so the stderr capture is deterministic.
  withTmpPolicy("version: 1\nreview:\n  scope: auto\n  zqx_typo_key: 1\n", (dir) => {
    let pol;
    const printed = captureStderr(() => { pol = loadPolicy(dir); });
    assert.equal(pol._warnings.length, 1, "warning returned on the policy object");
    assert.match(pol._warnings[0], /review\.zqx_typo_key is not a recognized review: key/);
    assert.ok(printed.some((l) => /review\.zqx_typo_key/.test(l)), `warning must reach stderr, got: ${JSON.stringify(printed)}`);
  });
});

// ── the HARD INVARIANT: no nested blocks ⇒ byte-identical to today ────────────────────────────────

test("INVARIANT: a policy with NO nested blocks loads with no block keys and no warnings", () => {
  withTmpPolicy("version: 1\ncodex_model: a\ngrok_model: b\nscope: auto\n", (dir) => {
    const pol = loadPolicy(dir);
    for (const name of KNOWN_BLOCKS) assert.equal(name in pol, false, `${name} should be absent`);
    assert.deepEqual(pol._warnings, []);
    assert.equal(pol.codex_model, "a");
    assert.equal(pol.scope, "auto");
  });
});

test("config_version defaults to 1 (absent) and reflects the file value when present; no behavior change", () => {
  withTmpPolicy("version: 1\n", (dir) => assert.equal(loadPolicy(dir).config_version, 1));
  withTmpPolicy("config_version: 2\nversion: 1\n", (dir) => assert.equal(loadPolicy(dir).config_version, 2));
  assert.equal(DEFAULT_POLICY.config_version, 1);
});

// ── flat top-level keys + scalar lists + block text still parse alongside nested blocks ───────────

test("flat scalars, a scalar list, and block text (focus) still parse — and coexist with a review: block", () => {
  const text = [
    "version: 1",
    "focus: |",
    "  first line",
    "  second line",
    "require_consensus_for:",
    "  - security",
    "  - concurrency",
    "scope: auto",
    "review:",
    "  default_mode: deliberate",
    ""
  ].join("\n");
  // parseSimpleYaml (unchanged) still handles the flat surface exactly as before.
  const flat = parseSimpleYaml(text);
  assert.equal(flat.focus, "first line\nsecond line");
  assert.deepEqual(flat.require_consensus_for, ["security", "concurrency"]);
  assert.equal(flat.scope, "auto");
  // loadPolicy layers the nested block on top without disturbing the flat keys.
  withTmpPolicy(text, (dir) => {
    const pol = loadPolicy(dir);
    assert.equal(pol.focus, "first line\nsecond line");
    assert.deepEqual(pol.require_consensus_for, ["security", "concurrency"]);
    assert.deepEqual(pol.review, { default_mode: "deliberate" });
  });
});
