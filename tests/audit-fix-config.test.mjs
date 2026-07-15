import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadPolicy, parseFixBlock } from "../plugins/council/scripts/lib/policy.mjs";
import { parseArgs } from "../plugins/council/scripts/lib/args.mjs";
import {
  applyFixPolicyDefaults,
  applyNoFlagNegations
} from "../plugins/council/scripts/council-companion.mjs";

// The exact parser config `handleAudit` uses for the audit subcommands, so these tests exercise the
// SAME parse → negate → merge pipeline the CLI runs (minus the git/backends plumbing).
const AUDIT_PARSE = {
  valueOptions: ["areas", "churn-days", "budget", "max-units", "doc-path", "from", "min-severity", "max-fixes", "max-passes", "dry-streak", "sarif-path", "autonomy", "base", "retry-limit", "groups", "max-cells", "skip-seats", "usage-ceiling", "pause-at-5h"],
  booleanOptions: ["json", "write-map", "doc", "dry-run", "resume", "sarif", "loop", "flat", "html", "retry-on-limit", "sensitive-auto-apply", "structure-auto-apply", "acknowledge-consents", "supervise", "completeness-critic", "skip-openrouter", "chartest", "deep", "epoch-sweep",
    "no-deep", "no-loop", "no-epoch-sweep", "no-supervise", "no-flat", "no-structure-auto-apply", "no-sensitive-auto-apply", "no-retry-on-limit", "no-chartest", "no-skip-openrouter", "no-completeness-critic"]
};

// Resolve options exactly like handleAudit's `fix` path: parse → fold --no-* → apply fix: config.
function resolveFix(argv, policyFix, emitSink) {
  const { options } = parseArgs(argv, AUDIT_PARSE);
  applyNoFlagNegations(options);
  const emit = emitSink ? (m) => emitSink.push(m) : () => {};
  const fromConfig = applyFixPolicyDefaults(options, policyFix, { emit });
  return { options, fromConfig };
}

// --- THE LOAD-BEARING INVARIANT: no `fix:` block ⇒ byte-identical option resolution --------------

test("INVARIANT: no fix: block ⇒ applyFixPolicyDefaults leaves options byte-identical", () => {
  for (const policyFix of [undefined, null, {}, []]) {
    const { options } = parseArgs(["fix", "--loop"], AUDIT_PARSE);
    const before = JSON.stringify(options);
    const fromConfig = applyFixPolicyDefaults(options, policyFix);
    assert.equal(JSON.stringify(options), before, `options mutated for policyFix=${JSON.stringify(policyFix)}`);
    assert.equal(fromConfig.size, 0);
  }
});

test("INVARIANT: a bare `audit fix` with no fix: block resolves to today's option object", () => {
  // Today's parse of a bare `audit fix` (no fix: block, no negations applied).
  const { options: baseline } = parseArgs(["fix"], AUDIT_PARSE);
  // The new pipeline over the SAME argv with NO config: negations fold nothing, merge fills nothing.
  const { options, fromConfig } = resolveFix(["fix"], undefined);
  assert.deepEqual(options, baseline);
  assert.deepEqual(baseline, { }); // only the positional; no boolean/value keys materialize
  assert.equal(fromConfig.size, 0);
});

test("INVARIANT: loadPolicy on a policy with no fix: block leaves policy.fix undefined", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-nofix-"));
  try {
    fs.writeFileSync(path.join(dir, ".council.yml"), "version: 1\ncodex_model: x\n", "utf8");
    const pol = loadPolicy(dir);
    assert.equal(pol.fix, undefined);
    assert.equal("fix" in pol, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- parseFixBlock ------------------------------------------------------------------------------

test("parseFixBlock extracts a nested fix: map; null when absent or childless", () => {
  const t = "version: 1\nfix:\n  loop: true\n  deep: true\n  autonomy: aggressive\n  budget: 2000\n  usage_ceiling: 90/90/90\nother: 1\n";
  assert.deepEqual(parseFixBlock(t), { loop: true, deep: true, autonomy: "aggressive", budget: 2000, usage_ceiling: "90/90/90" });
  assert.equal(parseFixBlock("version: 1\n"), null);
  assert.equal(parseFixBlock("fix:\nversion: 1\n"), null); // header with no indented children
  // A trailing comment on the header and comment/blank lines inside the block are tolerated.
  assert.deepEqual(parseFixBlock("fix:   # profile\n  loop: true\n\n  # note\n  deep: false\n"), { loop: true, deep: false });
});

test("loadPolicy reads the nested fix: block from YAML (and per_tier stays a real bool)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-fix-"));
  try {
    fs.writeFileSync(path.join(dir, ".council.yml"), "version: 1\nfix:\n  loop: true\n  per_tier: true\n  max_passes: 100\n", "utf8");
    const pol = loadPolicy(dir);
    assert.deepEqual(pol.fix, { loop: true, per_tier: true, max_passes: 100 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- fix: block supplies defaults ---------------------------------------------------------------

test("fix: config sets defaults for a bare `audit fix` (booleans, values) — but NOT the consents", () => {
  const policyFix = {
    loop: true, deep: true, epoch_sweep: true, per_tier: true, supervise: true,
    autonomy: "aggressive", structure_auto_apply: true, sensitive_auto_apply: true,
    retry_on_limit: true, usage_ceiling: "90/90/90", pause_at_5h: "auto:90", max_passes: 100, budget: 2000
  };
  const { options, fromConfig } = resolveFix(["fix"], policyFix);
  assert.equal(options.loop, true);
  assert.equal(options.deep, true);
  assert.equal(options["epoch-sweep"], true);
  assert.equal(options.supervise, true);
  assert.equal(options["retry-on-limit"], true);
  assert.equal(options.flat, false); // per_tier: true ⇒ flat false
  assert.equal(options.autonomy, "aggressive");
  assert.equal(options["usage-ceiling"], "90/90/90");
  assert.equal(options["pause-at-5h"], "auto:90");
  assert.equal(options["max-passes"], "100");
  assert.equal(options.budget, "2000");
  // Stage 4 (Appendix D — consent containment): the tracked `fix:` block is IGNORED for consent. Even
  // with structure_auto_apply/sensitive_auto_apply true in policyFix, applyFixPolicyDefaults must NOT
  // set the consent options and must NOT report them in fromConfig. They are resolved out-of-tree only.
  assert.equal(options["structure-auto-apply"], undefined);
  assert.equal(options["sensitive-auto-apply"], undefined);
  assert.equal(fromConfig.has("structure-auto-apply"), false);
  assert.equal(fromConfig.has("sensitive-auto-apply"), false);
});

// --- precedence: explicit flag > fix.<key> > default --------------------------------------------

test("explicit flag overrides fix: config (usage-ceiling, budget, autonomy)", () => {
  const policyFix = { usage_ceiling: "90/90/90", budget: 2000, autonomy: "aggressive" };
  const { options, fromConfig } = resolveFix(
    ["fix", "--usage-ceiling", "50/50/50", "--budget", "10", "--autonomy", "conservative"],
    policyFix
  );
  assert.equal(options["usage-ceiling"], "50/50/50"); // flag wins
  assert.equal(options.budget, "10");
  assert.equal(options.autonomy, "conservative");
  // None of the three were sourced from config since the flag was present.
  assert.equal(fromConfig.has("usage-ceiling"), false);
  assert.equal(fromConfig.has("budget"), false);
});

test("--flat beats per_tier; --flat also beats a config flat:false", () => {
  assert.equal(resolveFix(["fix", "--flat"], { per_tier: true }).options.flat, true);
  assert.equal(resolveFix(["fix", "--flat"], { flat: false }).options.flat, true);
});

test("config `flat` wins over `per_tier` with a note", () => {
  const emit = [];
  const { options } = resolveFix(["fix"], { flat: true, per_tier: true }, emit);
  assert.equal(options.flat, true);
  assert.ok(emit.some((m) => /both .*flat.* and .*per_tier/i.test(m)), `expected a both-set note, got ${JSON.stringify(emit)}`);
});

// --- --no-<flag> overrides a config-true (explicit-false wins) -----------------------------------

test("--no-deep overrides config deep:true (explicit-false wins)", () => {
  const { options, fromConfig } = resolveFix(["fix", "--no-deep"], { deep: true, loop: true });
  assert.equal(options.deep, false); // config did NOT switch it back on
  assert.equal(options.loop, true); // loop still filled from config
  assert.equal(fromConfig.has("deep"), false);
});

test("--no-structure-auto-apply overrides the config consent (stays off, not in fromConfig)", () => {
  const { options, fromConfig } = resolveFix(["fix", "--no-structure-auto-apply"], { structure_auto_apply: true });
  assert.equal(options["structure-auto-apply"], false);
  assert.equal(fromConfig.has("structure-auto-apply"), false);
});

test("--no-flat forces flat off even when config per_tier:false would set flat true", () => {
  const { options } = resolveFix(["fix", "--no-flat"], { per_tier: false });
  assert.equal(options.flat, false);
});

// --- invalid config value fails loud (never silently ignored) ------------------------------------

test("invalid fix.usage_ceiling fails loud with a config-pointing message", () => {
  assert.throws(
    () => applyFixPolicyDefaults({}, { usage_ceiling: "1/2" }),
    /Invalid \.council\.yml fix\.usage_ceiling:/
  );
});

test("out-of-range fix.budget fails loud (< 2)", () => {
  assert.throws(
    () => applyFixPolicyDefaults({}, { budget: 1 }),
    /Invalid \.council\.yml fix\.budget:.*>= 2/
  );
});

test("out-of-range fix.max_passes fails loud (> 1000)", () => {
  assert.throws(
    () => applyFixPolicyDefaults({}, { max_passes: 5000 }),
    /Invalid \.council\.yml fix\.max_passes:.*between 1 and 1000/
  );
  // 300 (the quota-bound autonomous default) is now in-range — no throw.
  assert.doesNotThrow(() => applyFixPolicyDefaults({}, { max_passes: 300 }));
});

test("bad fix.groups fails loud", () => {
  assert.throws(
    () => applyFixPolicyDefaults({}, { groups: "nope" }),
    /Invalid \.council\.yml fix\.groups:.*fine\|tier\|lens/
  );
});

test("bad fix.pause_at_5h fails loud", () => {
  assert.throws(
    () => applyFixPolicyDefaults({}, { pause_at_5h: "autox" }),
    /Invalid \.council\.yml fix\.pause_at_5h:/
  );
});

// --- an invalid value that the user OVERRODE by flag must NOT fail (flag wins, config unread) -----

test("a bad config value is not validated when the flag overrides it", () => {
  const { options } = resolveFix(["fix", "--budget", "20"], { budget: 1 /* invalid, but overridden */ });
  assert.equal(options.budget, "20");
});
