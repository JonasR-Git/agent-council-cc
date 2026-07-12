// M7/B1 — LENS GROUPS: how the 13-lens registry (audit-lenses.mjs) is partitioned into focused
// review PASSES for the six-eyes finder. Instead of asking every model to sweep all 13 lenses at
// once (shallow), a run picks a PRESET that splits the lenses into groups; each group is one deep,
// narrow pass. Quality is the goal — many focused passes find more than one broad sweep.
//
// Presets:
//   tier   — the 4 audit tiers (Logical → Structure/SSOT → Correctness → Quality). A PARTITION:
//            every lens in exactly one group. Coarsest; mirrors the fix-loop's tier ordering.
//   lens   — one group per registered lens (13). Also a PARTITION.
//   fine   — 26 aspect-focused groups: each narrows ONE parent lens to a specific sub-surface
//            (e.g. security_secrets → authz | injection | secrets | crypto) via `focus`. A COVER
//            (every lens in ≥1 group; high-value lenses split across several). The deepest preset.
//   custom — a caller-supplied groups array, validated the same way.
//
// A group is { id, title, lenses: string[], focus?: string }. `focus` narrows the parent lens's
// detection guidance to one aspect when B3 (buildGroupPrompt) assembles the pass prompt.
import { getLens, lensIds } from "./audit-lenses.mjs";
import { TIERS } from "./audit-tiers.mjs";

export const LENS_GROUP_PRESETS = Object.freeze(["tier", "lens", "fine", "custom"]);

// The 26 fine-grained, aspect-focused groups. Every registered lens is covered by ≥1 group
// (guarded by tests/audit-lens-groups.test.mjs); broad, high-value lenses are split so each pass
// hunts one failure family deeply. `focus` is the narrowing instruction for the pass prompt.
export const FINE_GROUPS = Object.freeze([
  { id: "logical-dead", title: "Dead / needless code", lenses: ["logical_sense"], focus: "unreachable, never-called, or vestigial code; features/abstractions that should not exist at all" },
  { id: "logical-redundant", title: "Redundant responsibility", lenses: ["logical_sense"], focus: "duplicated or overlapping responsibilities; components that should be merged or consolidated" },
  { id: "ssot-duplication", title: "SSOT / duplication", lenses: ["architecture_ssot"], focus: "single-source-of-truth violations: duplicated constants, logic, schemas, or config that can drift" },
  { id: "ssot-coupling", title: "Coupling & boundaries", lenses: ["architecture_ssot"], focus: "coupling/cohesion problems, layering and module-boundary violations, leaky abstractions" },
  { id: "ssot-graph", title: "Dependency graph", lenses: ["architecture_ssot"], focus: "module dependency cycles, orphan/unreachable modules, tangled or inverted import graphs" },
  { id: "deps-vuln", title: "Vulnerable dependencies", lenses: ["dependencies_supply_chain"], focus: "outdated, known-vulnerable, or unpinned dependencies and transitive risk" },
  { id: "deps-provenance", title: "Supply-chain provenance", lenses: ["dependencies_supply_chain"], focus: "license, provenance, integrity (lockfile/hashes), and install-script supply-chain risk" },
  { id: "correctness-logic", title: "Logic correctness", lenses: ["correctness"], focus: "core logic errors, wrong algorithms, incorrect state transitions or invariants" },
  { id: "correctness-errors", title: "Error handling", lenses: ["correctness"], focus: "error/exception handling: swallowed errors, wrong failure paths, missing rollback" },
  { id: "correctness-edges", title: "Edge cases", lenses: ["correctness"], focus: "null/undefined, empty, boundary, off-by-one, and type-coercion edge cases" },
  { id: "concurrency-races", title: "Data races", lenses: ["concurrency_resources"], focus: "data races, non-atomic read-modify-write, unguarded shared mutable state" },
  { id: "concurrency-deadlock", title: "Deadlocks & ordering", lenses: ["concurrency_resources"], focus: "deadlocks, lock-ordering inversions, async/await ordering and reentrancy hazards" },
  { id: "concurrency-leaks", title: "Resource leaks", lenses: ["concurrency_resources"], focus: "leaked file descriptors, memory, sockets/connections, timers, or unclosed handles; missing cleanup" },
  { id: "security-authz", title: "Auth & access control", lenses: ["security_secrets"], focus: "authentication, session handling, and authorization/access-control (missing checks, IDOR, privilege escalation)" },
  { id: "security-injection", title: "Injection", lenses: ["security_secrets"], focus: "injection: SQL, command, XSS, path traversal, template, and SSRF" },
  { id: "security-secrets", title: "Secrets & credentials", lenses: ["security_secrets"], focus: "hardcoded secrets, credential handling, key management, and secret exposure in logs/errors" },
  { id: "security-crypto", title: "Crypto & deserialization", lenses: ["security_secrets"], focus: "crypto misuse, weak algorithms, insecure randomness, and unsafe deserialization" },
  { id: "data-validation", title: "Input validation", lenses: ["data_integrity"], focus: "input validation, sanitization, and untrusted-data handling at trust boundaries" },
  { id: "data-numeric", title: "Numeric integrity", lenses: ["data_integrity"], focus: "numeric overflow/underflow, bounds, precision, and integer-handling defects" },
  { id: "data-consistency", title: "Consistency & TOCTOU", lenses: ["data_integrity"], focus: "TOCTOU, transaction/consistency integrity, and state-corruption windows" },
  { id: "config-security", title: "Config & CI/CD security", lenses: ["config_cicd_security"], focus: "CI/CD pipeline security, secrets in config, insecure defaults, and config-driven injection" },
  { id: "performance", title: "Performance", lenses: ["performance"], focus: "algorithmic complexity, N+1 and hot-path costs, allocations/memory growth, and caching gaps" },
  { id: "reliability", title: "Reliability & observability", lenses: ["reliability_observability"], focus: "retries, timeouts, graceful degradation, and logging/metrics/tracing gaps" },
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
 *   - uncovered:     registered lenses NOT in any group (a coverage hole — a lens no pass hunts)
 *   - unknownLenses: group-referenced names that are not registered lenses (a typo/drift)
 *   - duplicateIds:  group ids used more than once (a scheduling-key collision)
 *   - emptyGroups:   group ids with no lenses (a pass that would search nothing)
 *   - overCovered:   lenses in >1 group — only reported/failed when requireExactlyOne (partition)
 * ok is true only when every check passes. Default requires a COVER (every lens ≥1 group);
 * pass requireExactlyOne for the tier/lens PARTITION presets.
 */
export function validateLensGroups(groups, { requireExactlyOne = false } = {}) {
  const registered = new Set(lensIds());
  const seenIds = new Set();
  const duplicateIds = [];
  const emptyGroups = [];
  const unknownLenses = new Set();
  const coverage = new Map();
  for (const g of Array.isArray(groups) ? groups : []) {
    const id = String(g?.id ?? "");
    if (seenIds.has(id)) duplicateIds.push(id);
    else seenIds.add(id);
    const lenses = Array.isArray(g?.lenses) ? g.lenses : [];
    if (lenses.length === 0) emptyGroups.push(id);
    for (const l of lenses) {
      if (registered.has(l)) coverage.set(l, (coverage.get(l) ?? 0) + 1);
      else unknownLenses.add(String(l));
    }
  }
  const uncovered = [...registered].filter((l) => !coverage.has(l));
  const overCovered = requireExactlyOne ? [...coverage.entries()].filter(([, n]) => n > 1).map(([l]) => l) : [];
  const ok =
    uncovered.length === 0 &&
    unknownLenses.size === 0 &&
    duplicateIds.length === 0 &&
    emptyGroups.length === 0 &&
    overCovered.length === 0;
  return { ok, uncovered, unknownLenses: [...unknownLenses], duplicateIds, emptyGroups, overCovered };
}

/**
 * Resolve + validate in one step, throwing on an invalid preset result. This is the guard the
 * finder should call so a coverage hole (a lens no pass hunts) fails loudly instead of silently
 * skipping a whole class of defects. Returns the validated groups.
 */
export function resolveLensGroups(preset = "lens", { customGroups } = {}) {
  const groups = getLensGroups(preset, { customGroups });
  const partition = preset === "tier" || preset === "lens";
  const report = validateLensGroups(groups, { requireExactlyOne: partition });
  if (!report.ok) {
    const parts = [];
    if (report.uncovered.length) parts.push(`uncovered lenses: ${report.uncovered.join(", ")}`);
    if (report.unknownLenses.length) parts.push(`unknown lenses: ${report.unknownLenses.join(", ")}`);
    if (report.duplicateIds.length) parts.push(`duplicate group ids: ${report.duplicateIds.join(", ")}`);
    if (report.emptyGroups.length) parts.push(`empty groups: ${report.emptyGroups.join(", ")}`);
    if (report.overCovered.length) parts.push(`lenses in >1 group (partition required): ${report.overCovered.join(", ")}`);
    throw new Error(`invalid lens groups for preset '${preset}': ${parts.join("; ")}`);
  }
  return groups;
}
