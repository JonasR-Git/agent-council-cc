// M7/B1 — LENS GROUPS: how the 13-lens registry (audit-lenses.mjs) is partitioned into focused
// review PASSES for the six-eyes finder. Instead of asking every model to sweep all 13 lenses at
// once (shallow), a run picks a PRESET that splits the lenses into groups; each group is one deep,
// narrow pass. Quality is the goal — many focused passes find more than one broad sweep.
//
// Presets:
//   tier   — the 4 audit tiers (Logical → Structure/SSOT → Correctness → Quality). A PARTITION:
//            every lens in exactly one group. Coarsest; mirrors the fix-loop's tier ordering.
//   lens   — one group per registered lens (13). Also a PARTITION.
//   fine   — 30 aspect-focused groups: each narrows ONE parent lens to a specific sub-surface
//            (e.g. security_secrets → authz | injection | secrets | crypto) via `focus`. A COVER
//            (every lens in ≥1 group; high-value lenses split across several). The deepest preset.
//   custom — a caller-supplied groups array, validated the same way.
//
// A group is { id, title, lenses: string[], focus?: string }. `focus` narrows the parent lens's
// detection guidance to one aspect when B3 (buildGroupPrompt) assembles the pass prompt.
import { lensIds } from "./audit-lenses.mjs";
import { TIERS } from "./audit-tiers.mjs";

export const LENS_GROUP_PRESETS = Object.freeze(["tier", "lens", "fine", "custom"]);

/** Recursively freeze an object graph so a shared singleton can't be mutated by an importer. */
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

// The 30 fine-grained, aspect-focused groups. Every registered lens is covered by ≥1 group
// (guarded by tests/audit-lens-groups.test.mjs); broad, high-value lenses are split so each pass
// hunts one failure family deeply. `focus` is the narrowing instruction for the pass prompt.
// The focuses are kept DISTINCT across lenses (council B1 grok-2): logical_sense passes judge
// design intent (should-this-exist / overlapping responsibility), architecture_ssot passes judge
// structure (data duplication / coupling / graph topology) — so the two lenses don't collide on
// "dead/duplicated". DEEP-frozen (council claude-4/grok-5) so the exported singleton is immutable.
export const FINE_GROUPS = deepFreeze([
  { id: "logical-dead", title: "Dead / needless code", lenses: ["logical_sense"], focus: "vestigial or never-called code, and features/abstractions whose existence isn't justified (should they exist at all?) — a DESIGN-intent judgement, not graph topology" },
  { id: "logical-redundant", title: "Redundant responsibility", lenses: ["logical_sense"], focus: "overlapping RESPONSIBILITIES/behaviours that should be one component; design-level duplication of purpose (not byte-level code duplication)" },
  { id: "ssot-duplication", title: "SSOT / duplication", lenses: ["architecture_ssot"], focus: "single-source-of-truth violations: duplicated DATA — constants, logic, schemas, config — that can drift out of sync" },
  { id: "ssot-coupling", title: "Coupling & boundaries", lenses: ["architecture_ssot"], focus: "coupling/cohesion problems, layering and module-boundary violations, leaky abstractions" },
  { id: "ssot-graph", title: "Dependency graph", lenses: ["architecture_ssot"], focus: "dependency-graph STRUCTURE: import cycles, inverted/tangled import direction, and modules disconnected from the graph" },
  { id: "deps-vuln", title: "Vulnerable dependencies", lenses: ["dependencies_supply_chain"], focus: "outdated, known-vulnerable, or unpinned dependencies and transitive risk" },
  { id: "deps-provenance", title: "Supply-chain provenance", lenses: ["dependencies_supply_chain"], focus: "license, provenance, integrity (lockfile/hashes), and install-script supply-chain risk" },
  { id: "correctness-logic", title: "Logic correctness", lenses: ["correctness"], focus: "core logic errors, wrong algorithms, incorrect state transitions or invariants" },
  { id: "correctness-errors", title: "Error handling", lenses: ["correctness"], focus: "error/exception handling: swallowed errors, wrong failure paths, missing rollback" },
  { id: "correctness-edges", title: "Edge cases", lenses: ["correctness"], focus: "null/undefined, empty, boundary, off-by-one, and type-coercion edge cases" },
  { id: "concurrency-races", title: "Data races", lenses: ["concurrency_resources"], focus: "data races, non-atomic read-modify-write, unguarded shared mutable state" },
  { id: "concurrency-deadlock", title: "Deadlocks & ordering", lenses: ["concurrency_resources"], focus: "deadlocks, lock-ordering inversions, async/await ordering and reentrancy hazards" },
  { id: "concurrency-leaks", title: "Resource leaks", lenses: ["concurrency_resources"], focus: "leaked file descriptors, memory, sockets/connections, timers, or unclosed handles; missing cleanup" },
  { id: "concurrency-exhaustion", title: "Resource exhaustion", lenses: ["concurrency_resources"], focus: "unbounded resource CONSUMPTION (CWE-400): missing backpressure/rate-limiting, unbounded queues/concurrency/recursion, DoS-shaped growth" },
  { id: "security-authz", title: "Auth & access control", lenses: ["security_secrets"], focus: "authentication, session handling, and authorization/access-control (missing checks, IDOR, privilege escalation)" },
  { id: "security-injection", title: "Injection", lenses: ["security_secrets"], focus: "injection: SQL, command, XSS, path traversal, template, and SSRF" },
  { id: "security-secrets", title: "Secrets & credentials", lenses: ["security_secrets"], focus: "hardcoded secrets, credential handling, key management, and secret exposure in logs/errors" },
  { id: "security-crypto", title: "Crypto & deserialization", lenses: ["security_secrets"], focus: "crypto misuse, weak algorithms, insecure randomness, and unsafe deserialization" },
  { id: "security-misconfig", title: "Security misconfiguration", lenses: ["security_secrets"], focus: "web/app security misconfiguration (OWASP-A05): missing security headers, permissive CORS, weak cookie flags (Secure/HttpOnly/SameSite), verbose error/info disclosure" },
  { id: "data-validation", title: "Input validation", lenses: ["data_integrity"], focus: "input validation, sanitization, and untrusted-data handling at trust boundaries" },
  { id: "data-numeric", title: "Numeric integrity", lenses: ["data_integrity"], focus: "numeric overflow/underflow, bounds, precision, and integer-handling defects" },
  { id: "data-consistency", title: "Consistency & TOCTOU", lenses: ["data_integrity"], focus: "TOCTOU, transaction/consistency integrity, and state-corruption windows" },
  { id: "config-security", title: "Config & CI/CD security", lenses: ["config_cicd_security"], focus: "CI/CD pipeline security, secrets in config, insecure defaults, and config-driven injection" },
  { id: "perf-complexity", title: "Algorithmic performance", lenses: ["performance"], focus: "algorithmic complexity, N+1 queries, and hot-path CPU/IO costs" },
  { id: "perf-memory", title: "Memory & caching", lenses: ["performance"], focus: "excessive allocations, memory growth/pressure, and missing or ineffective caching" },
  { id: "reliability", title: "Reliability", lenses: ["reliability_observability"], focus: "retries, timeouts, circuit breakers, graceful degradation, and failure recovery" },
  { id: "observability", title: "Observability", lenses: ["reliability_observability"], focus: "logging, metrics, tracing, and diagnostic/alerting gaps" },
  { id: "testing", title: "Testing", lenses: ["testing"], focus: "coverage gaps, missing edge-case/failure tests, and test-quality/flakiness issues" },
  { id: "compliance", title: "Compliance & privacy", lenses: ["compliance_governance"], focus: "privacy, PII handling, data governance, and regulatory obligations" },
  { id: "docs", title: "Docs & maintainability", lenses: ["docs_maintainability"], focus: "documentation drift/accuracy, readability, naming, and maintainability" }
]);

/** The 4 tiers as groups (a partition: every lens in exactly one). */
function tierGroups() {
  return TIERS.map((t) => ({ id: `tier-${t.key}`, title: t.title, lenses: [...t.lenses] }));
}

/** One group per registered lens (a partition: 13 groups). */
function lensGroups() {
  return lensIds().map((id) => ({ id: `lens-${id}`, title: id, lenses: [id] }));
}

/** Normalize a caller-supplied custom group into the canonical { id, title, lenses, focus? }. */
function normalizeGroup(g, i) {
  const lenses = Array.isArray(g?.lenses) ? g.lenses.map((l) => String(l)) : [];
  const out = { id: String(g?.id ?? `custom-${i}`), title: String(g?.title ?? g?.id ?? `group ${i + 1}`), lenses };
  if (g?.focus) out.focus = String(g.focus);
  return out;
}

/**
 * Resolve a preset into its group list. Returns fresh objects with cloned `lenses` arrays so a
 * caller can't mutate the frozen presets. `custom` requires a non-empty customGroups array.
 * Throws on an unknown preset (fail-loud, never silently empty).
 */
export function getLensGroups(preset = "lens", { customGroups } = {}) {
  switch (preset) {
    case "tier":
      return tierGroups();
    case "lens":
      return lensGroups();
    case "fine":
      return FINE_GROUPS.map((g) => ({ id: g.id, title: g.title, lenses: [...g.lenses], ...(g.focus ? { focus: g.focus } : {}) }));
    case "custom":
      if (!Array.isArray(customGroups) || customGroups.length === 0) {
        throw new Error("lens-group preset 'custom' requires a non-empty customGroups array");
      }
      return customGroups.map(normalizeGroup);
    default:
      throw new Error(`unknown lens-group preset: ${String(preset)} (expected one of ${LENS_GROUP_PRESETS.join(", ")})`);
  }
}

/** The set of lenses referenced by a group list (unknown lens names included as-is). */
export function lensesInGroups(groups = []) {
  const s = new Set();
  for (const g of groups) for (const l of g?.lenses ?? []) s.add(l);
  return s;
}

/**
 * Validate a group list against the registry. Returns a structured report:
 *   - uncovered:            registered lenses NOT in any group (a lens no pass hunts) — only fails
 *                           `ok` when requireCover (the default)
 *   - unknownLenses:        group-referenced names that are not registered lenses (a typo/drift)
 *   - duplicateIds:         group ids used more than once (a scheduling-key collision)
 *   - emptyGroups:          group ids with no lenses (a pass that would search nothing)
 *   - duplicateLensInGroup: group ids that list the same lens more than once (a copy-paste typo)
 *   - overCovered:          lenses assigned to >1 DISTINCT group — reported/failed only when
 *                           requireExactlyOne (a partition). Counted per distinct group, so a lens
 *                           listed twice WITHIN one group is NOT over-coverage (council claude-2/codex-1).
 * ok is true only when every applicable check passes. Default requires a COVER (every lens ≥1
 * group); pass requireExactlyOne for the tier/lens PARTITION presets, or requireCover:false for a
 * deliberately scoped run (e.g. a security-only custom preset).
 */
export function validateLensGroups(groups, { requireExactlyOne = false, requireCover = true } = {}) {
  const registered = new Set(lensIds());
  const seenIds = new Set();
  const duplicateIds = [];
  const emptyGroups = [];
  const duplicateLensInGroup = [];
  const unknownLenses = new Set();
  const coverage = new Map(); // lens -> number of DISTINCT groups that contain it
  for (const g of Array.isArray(groups) ? groups : []) {
    const id = String(g?.id ?? "");
    if (seenIds.has(id)) duplicateIds.push(id);
    else seenIds.add(id);
    const lenses = Array.isArray(g?.lenses) ? g.lenses : [];
    if (lenses.length === 0) emptyGroups.push(id);
    // Dedupe WITHIN the group first: a lens listed twice in one group's array is one membership,
    // not over-coverage — but it IS a typo worth surfacing separately.
    const seenInGroup = new Set();
    let hadDup = false;
    for (const l of lenses) {
      const name = String(l);
      if (seenInGroup.has(name)) {
        hadDup = true;
        continue;
      }
      seenInGroup.add(name);
      if (registered.has(name)) coverage.set(name, (coverage.get(name) ?? 0) + 1);
      else unknownLenses.add(name);
    }
    if (hadDup) duplicateLensInGroup.push(id);
  }
  const uncovered = [...registered].filter((l) => !coverage.has(l));
  const overCovered = requireExactlyOne ? [...coverage.entries()].filter(([, n]) => n > 1).map(([l]) => l) : [];
  const ok =
    (!requireCover || uncovered.length === 0) &&
    unknownLenses.size === 0 &&
    duplicateIds.length === 0 &&
    emptyGroups.length === 0 &&
    duplicateLensInGroup.length === 0 &&
    overCovered.length === 0;
  return { ok, uncovered, unknownLenses: [...unknownLenses], duplicateIds, emptyGroups, duplicateLensInGroup, overCovered };
}

/**
 * Resolve + validate in one step, throwing on an invalid preset result. This is the guard the
 * finder should call so a coverage hole (a lens no pass hunts) fails loudly instead of silently
 * skipping a whole class of defects. Returns the validated groups.
 *
 * The built-in tier/lens presets are validated as PARTITIONS and fine as a full COVER. A `custom`
 * preset defaults to requiring a full cover (a whole-project custom audit); pass
 * `requireCover:false` for a deliberately SCOPED custom run (e.g. security-only) so it isn't
 * rejected for not touching all 13 lenses (council claude-3) — integrity checks (unknown lens,
 * duplicate id, empty group, duplicate-lens-in-group) still apply.
 */
export function resolveLensGroups(preset = "lens", { customGroups, requireCover = true } = {}) {
  const groups = getLensGroups(preset, { customGroups });
  const partition = preset === "tier" || preset === "lens";
  // Built-in presets always require full coverage; only a custom preset may opt out of it.
  const cover = preset === "custom" ? requireCover : true;
  const report = validateLensGroups(groups, { requireExactlyOne: partition, requireCover: cover });
  if (!report.ok) {
    const parts = [];
    if (cover && report.uncovered.length) parts.push(`uncovered lenses: ${report.uncovered.join(", ")}`);
    if (report.unknownLenses.length) parts.push(`unknown lenses: ${report.unknownLenses.join(", ")}`);
    if (report.duplicateIds.length) parts.push(`duplicate group ids: ${report.duplicateIds.join(", ")}`);
    if (report.emptyGroups.length) parts.push(`empty groups: ${report.emptyGroups.join(", ")}`);
    if (report.duplicateLensInGroup.length) parts.push(`duplicate lens within a group: ${report.duplicateLensInGroup.join(", ")}`);
    if (report.overCovered.length) parts.push(`lenses in >1 group (partition required): ${report.overCovered.join(", ")}`);
    throw new Error(`invalid lens groups for preset '${preset}': ${parts.join("; ")}`);
  }
  return groups;
}
