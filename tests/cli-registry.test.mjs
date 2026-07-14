import assert from "node:assert/strict";
import test from "node:test";

import {
  CLI_FLAGS,
  booleanOptionsFor,
  fixConfigBooleans,
  fixConfigValues,
  negatableFlags,
  valueOptionsFor
} from "../plugins/council/scripts/lib/cli-registry.mjs";
import { parsePause5hOption, parseUsageCeiling } from "../plugins/council/scripts/lib/usage-guard.mjs";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// BYTE-IDENTICAL GOLDENS — Stage 2's whole safety contract.
// Each constant below is a VERBATIM copy of the hand-written array/map that council-companion.mjs used
// before the registry rewire (commit ef93217). The registry generators must reproduce them exactly, so
// the audit parser + the `.council.yml` fix: merge behave identically now that they are registry-fed.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// council-companion.mjs handleAudit parseCommandInput valueOptions (verbatim @ ef93217):
const GOLDEN_AUDIT_VALUE_OPTIONS = ["areas", "churn-days", "budget", "max-units", "doc-path", "from", "min-severity", "max-fixes", "max-passes", "dry-streak", "sarif-path", "autonomy", "base", "retry-limit", "groups", "max-cells", "skip-seats", "usage-ceiling", "pause-at-5h"];

// council-companion.mjs handleAudit parseCommandInput booleanOptions (incl. no-* twins). Stage 4
// (Appendix D — consent containment) ADDED the `acknowledge-consents` base flag (records a per-clone
// consent ack); the consent flags + their --no-* twins are UNCHANGED (only their CONFIG binding moved).
const GOLDEN_AUDIT_BOOLEAN_OPTIONS = ["json", "write-map", "doc", "dry-run", "resume", "sarif", "loop", "flat", "html", "retry-on-limit", "sensitive-auto-apply", "structure-auto-apply", "acknowledge-consents", "supervise", "completeness-critic", "skip-openrouter", "chartest", "deep", "epoch-sweep",
  "no-deep", "no-loop", "no-epoch-sweep", "no-supervise", "no-flat", "no-structure-auto-apply", "no-sensitive-auto-apply", "no-retry-on-limit", "no-chartest", "no-skip-openrouter", "no-completeness-critic"];

// council-companion.mjs FIX_CONFIG_BOOLEANS. Stage 4 (Appendix D) REMOVED structure_auto_apply /
// sensitive_auto_apply from the tracked-config binding — consents are resolved out-of-tree (gitignored
// .council.local.yml / env + fingerprint + per-clone ack), never from the committed `fix:` block.
const GOLDEN_FIX_CONFIG_BOOLEANS = {
  loop: "loop",
  deep: "deep",
  epoch_sweep: "epoch-sweep",
  supervise: "supervise",
  retry_on_limit: "retry-on-limit",
  chartest: "chartest",
  completeness_critic: "completeness-critic",
  skip_openrouter: "skip-openrouter"
};

// council-companion.mjs FIX_NEGATABLE_FLAGS (verbatim @ ef93217):
const GOLDEN_FIX_NEGATABLE_FLAGS = [
  "deep", "loop", "epoch-sweep", "supervise", "flat",
  "structure-auto-apply", "sensitive-auto-apply", "retry-on-limit",
  "chartest", "skip-openrouter", "completeness-critic"
];

// council-companion.mjs FIX_CONFIG_VALUES targets — the { configKey → opt } mapping (verbatim @ ef93217).
// (The validator functions can't be reference-compared across a re-declaration, so identity of `opt` +
// presence/behavior of `validate` are pinned separately below.)
const GOLDEN_FIX_CONFIG_VALUES_OPTS = {
  autonomy: "autonomy",
  min_severity: "min-severity",
  groups: "groups",
  max_fixes: "max-fixes",
  max_passes: "max-passes",
  dry_streak: "dry-streak",
  max_cells: "max-cells",
  budget: "budget",
  usage_ceiling: "usage-ceiling",
  pause_at_5h: "pause-at-5h"
};
// Which FIX_CONFIG_VALUES keys carried a validator (vs null) in the original hand-written map:
const GOLDEN_FIX_CONFIG_VALUES_HAS_VALIDATE = {
  autonomy: false,
  min_severity: false,
  groups: true,
  max_fixes: true,
  max_passes: true,
  dry_streak: true,
  max_cells: true,
  budget: true,
  usage_ceiling: true,
  pause_at_5h: true
};

test("valueOptionsFor('audit') is byte-identical to the hand-written valueOptions", () => {
  assert.deepStrictEqual(valueOptionsFor("audit"), GOLDEN_AUDIT_VALUE_OPTIONS);
});

test("booleanOptionsFor('audit') is byte-identical incl. the --no-* twins", () => {
  assert.deepStrictEqual(booleanOptionsFor("audit"), GOLDEN_AUDIT_BOOLEAN_OPTIONS);
});

test("negatableFlags('audit') is byte-identical to FIX_NEGATABLE_FLAGS (exact order)", () => {
  assert.deepStrictEqual(negatableFlags("audit"), GOLDEN_FIX_NEGATABLE_FLAGS);
  // command-agnostic call yields the same list (all negatable flags are audit-scoped in Stage 2)
  assert.deepStrictEqual(negatableFlags(), GOLDEN_FIX_NEGATABLE_FLAGS);
});

test("fixConfigBooleans() deep-equals FIX_CONFIG_BOOLEANS (keys + kebab targets)", () => {
  assert.deepStrictEqual(fixConfigBooleans(), GOLDEN_FIX_CONFIG_BOOLEANS);
});

test("fixConfigValues() keys + opt targets match FIX_CONFIG_VALUES", () => {
  const opts = Object.fromEntries(Object.entries(fixConfigValues()).map(([k, v]) => [k, v.opt]));
  assert.deepStrictEqual(opts, GOLDEN_FIX_CONFIG_VALUES_OPTS);
  const hasValidate = Object.fromEntries(
    Object.entries(fixConfigValues()).map(([k, v]) => [k, typeof v.validate === "function"])
  );
  assert.deepStrictEqual(hasValidate, GOLDEN_FIX_CONFIG_VALUES_HAS_VALIDATE);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Validator BEHAVIOR equivalence — re-derive the ORIGINAL inline validators and assert the registry's
// validators throw/pass on identical inputs (proves the fix-merge stays byte-identical, since functions
// can't be reference-compared across the move into the registry module).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const ORIGINAL_VALIDATORS = {
  groups: (v) => { if (!["fine", "tier", "lens"].includes(String(v))) throw new Error(`must be one of fine|tier|lens (got: ${v})`); },
  max_fixes: (v) => { const n = Number(v); if (!Number.isFinite(n) || n < 1) throw new Error("must be a positive number"); },
  max_passes: (v) => { const n = Number(v); if (!Number.isFinite(n) || n < 1 || n > 100) throw new Error("must be between 1 and 100"); },
  dry_streak: (v) => { const n = Number(v); if (!Number.isFinite(n) || n < 1) throw new Error("must be a positive number"); },
  max_cells: (v) => { const n = Number(v); if (!Number.isFinite(n) || n < 1) throw new Error("must be a positive number"); },
  budget: (v) => { const n = Number(v); if (!Number.isFinite(n) || n < 2) throw new Error("must be a number >= 2"); },
  usage_ceiling: (v) => { parseUsageCeiling(v); },
  pause_at_5h: (v) => { parsePause5hOption(v); }
};
const VALIDATOR_SAMPLES = ["fine", "tier", "lens", "bogus", "", "0", "1", "2", "100", "101", "-3", "3.5", "40/50/40", "45", "claude=40", "auto:90", "85", null, undefined];

test("registry validators are behaviorally identical to the original inline validators", () => {
  const derived = fixConfigValues();
  for (const [cfgKey, original] of Object.entries(ORIGINAL_VALIDATORS)) {
    const registryValidate = derived[cfgKey].validate;
    assert.equal(typeof registryValidate, "function", `${cfgKey} should have a validator`);
    for (const sample of VALIDATOR_SAMPLES) {
      let origErr = null;
      let regErr = null;
      try { original(sample); } catch (e) { origErr = e.message; }
      try { registryValidate(sample); } catch (e) { regErr = e.message; }
      assert.equal(
        regErr,
        origErr,
        `validator ${cfgKey} disagreed on ${JSON.stringify(sample)}: original=${JSON.stringify(origErr)} registry=${JSON.stringify(regErr)}`
      );
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Registry INTEGRITY — structural invariants that keep the SSOT well-formed.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
test("every entry has a valid type", () => {
  for (const e of CLI_FLAGS) {
    assert.ok(e.type === "value" || e.type === "boolean", `bad type on --${e.flag}: ${e.type}`);
  }
});

test("no duplicate flag names", () => {
  const names = CLI_FLAGS.map((e) => e.flag);
  assert.equal(new Set(names).size, names.length, `duplicate flag: ${names.filter((n, i) => names.indexOf(n) !== i)}`);
});

test("every negatable flag is a boolean", () => {
  for (const e of CLI_FLAGS) {
    if (e.negatable) assert.equal(e.type, "boolean", `negatable non-boolean flag: --${e.flag}`);
  }
});

test("negatable flags carry a unique numeric negOrder; non-negatable carry none", () => {
  const orders = [];
  for (const e of CLI_FLAGS) {
    if (e.negatable) {
      assert.equal(typeof e.negOrder, "number", `negatable --${e.flag} missing numeric negOrder`);
      orders.push(e.negOrder);
    } else {
      assert.equal(e.negOrder, null, `non-negatable --${e.flag} should have negOrder null`);
    }
  }
  assert.equal(new Set(orders).size, orders.length, "negOrder values must be unique");
});

test("value flags with a config validator are callable; boolean flags never carry a validator", () => {
  for (const e of CLI_FLAGS) {
    if (e.validate != null) {
      assert.equal(e.type, "value", `only value flags may have a validator: --${e.flag}`);
      assert.equal(typeof e.validate, "function", `validator on --${e.flag} must be a function`);
    }
    if (e.type === "boolean") assert.equal(e.validate, null, `boolean --${e.flag} should not have a validator`);
  }
});

test("every fix-backed entry declares a snake_case configKey; block is fix|null", () => {
  for (const e of CLI_FLAGS) {
    assert.ok(e.block === "fix" || e.block === null, `bad block on --${e.flag}: ${e.block}`);
    if (e.block === "fix") assert.ok(e.configKey && /^[a-z0-9_]+$/.test(e.configKey), `--${e.flag} needs snake_case configKey`);
    if (e.block === null) assert.equal(e.configKey, null, `--${e.flag} has configKey but no block`);
  }
});

test("mutationClass is one of the three recorded classes; aliasOf inert in Stage 2", () => {
  for (const e of CLI_FLAGS) {
    assert.ok(["none", "state-only", "working-tree"].includes(e.mutationClass), `bad mutationClass on --${e.flag}`);
    assert.equal(e.aliasOf, null, `aliasOf must stay null until Stage 3: --${e.flag}`);
  }
});
