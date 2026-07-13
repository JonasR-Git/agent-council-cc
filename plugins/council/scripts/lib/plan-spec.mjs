// council plan/build — the FROZEN PlanSpec contract (docs/plan-build-design.md).
//
// This is the PURE pivot both `council plan` (which synthesizes a PlanSpec) and `council build`
// (which implements one step at a time behind the gate ladder) code against. It performs NO I/O:
// the only side-effectful check (does a planned path exist as a regular file?) is INJECTED via
// deps.fileExists, so the whole contract unit-tests with no repo, no network, no cli.
//
// Safety model (fail-closed everywhere):
//  - STRICT schema: unknown keys reject, missing keys reject, bounded sizes, exact enums. A spec
//    that "mostly" parses is NOT a plan — it is a rejection with reasons (the synthesizer retries
//    with the errors appended; the builder aborts).
//  - planStepTouched(step) is the step's CAPABILITY BOUNDARY: the writer may touch exactly the
//    declared files[].path set (which INCLUDES the test files — every test file must also appear
//    in files[] with role:"test") and the commit is later bound to exactly that set. It is the
//    EXACT declared set — never widened (a malformed step must fail the drift gate, not be
//    accommodated by a defensive union). The boundary helpers THROW on a step that is not shaped
//    like a validated one (council G3/G4): a caller that skipped validatePlanSpec crashes instead
//    of receiving an empty/narrowed "boundary" it could misread as "nothing to write".
//  - Path safety + protected classes mirror structure-gate.mjs. The ONE narrow relaxation: a path
//    matching a test convention is allowed ONLY when it is declared in files[] with role:"test"
//    (and then it must ALSO be listed in test.files). Every other protection (CI/git/deps/
//    lockfiles/secrets/.council/node_modules/credentials) applies to EVERY path, test or not.
//  - requestHash is VERIFIED here (sha256 of the whitespace-normalized request), so a --from
//    plan.json cannot be quietly re-pointed at a different request. Self-consistency alone cannot
//    catch a request+hash pair recomputed TOGETHER, so callers that received the request out of
//    band (build --from MUST) pass deps.expectedRequest and the spec's request must normalize-
//    equal it (council C2).
//  - Safety v1 autonomous scope is enforced at the contract: every planned path must be a Node
//    ESM `.mjs` file and the step count is capped at PLAN_LIMITS.steps (≤6–8 per the design) —
//    shell/SQL/migrations/config/manifest work is not autonomously plannable (council C4/C5).
//  - validatePlanSpec REQUIRES an injected fileExists: without it the create/edit existence
//    checks cannot run, and skipping them silently would be fail-open.
import { createHash } from "node:crypto";

export const PLAN_SCHEMA_VERSION = 1;

/** Bounded sizes — a spec beyond these is rejected, never truncated (truncation hides content). */
export const PLAN_LIMITS = Object.freeze({
  specChars: 262_144, // parse input bound (chars)
  request: 20_000,
  // Safety v1 caps autonomous builds at ≤6–8 ordered steps (docs/plan-build-design.md). This is
  // the CONTRACT bound: build's maxSteps option can only lower it, never raise it (council C5 —
  // the earlier 32 let a caller-raised downstream maxSteps execute a plan 4× the designed bound).
  steps: 8,
  filesPerStep: 32,
  risks: 64,
  title: 200,
  intent: 2_000,
  text: 2_000,
  path: 400
});

const MAX_ERRORS = 100; // bound the error list itself (a hostile spec must not balloon the report)

const ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const ACTIONS = Object.freeze(["create", "edit"]);
const ROLES = Object.freeze(["source", "test"]);

const TOP_KEYS = Object.freeze(["schemaVersion", "request", "requestHash", "baseCommit", "steps", "risks", "testStrategy"]);
const STEP_KEYS = Object.freeze(["id", "title", "intent", "files", "test"]);
const STEP_KEYS_OPTIONAL = Object.freeze(["dependsOn"]);
const FILE_KEYS = Object.freeze(["path", "action", "role", "intent"]);
const TEST_KEYS = Object.freeze(["files", "intent"]);
const RISK_KEYS = Object.freeze(["id", "description", "mitigation"]);
const TEST_STRATEGY_KEYS = Object.freeze(["perStep", "final"]);

// ---------------------------------------------------------------------------
// Path safety — DUPLICATED VERBATIM from structure-gate.mjs's private helpers (isUnsafePath /
// hasUnsafeChars / STRUCTURE_PROTECTED_RE). The design doc plans a shared extraction, but this
// module may not edit structure-gate.mjs (concurrent work), so the checks are reimplemented
// EXACTLY and must be kept in sync. The two TEST patterns are split out of the protected list
// because plan-spec narrowly relaxes them for declared role:"test" files.
// ---------------------------------------------------------------------------

// Repo-escape: empty, traversal, leading /, or any DRIVE-QUALIFIED path — including the
// drive-RELATIVE `C:foo` form (no slash after the colon), which resolves against the drive's
// current dir, i.e. outside the repo.
function isUnsafePath(posix) {
  return posix === "" || posix.split("/").includes("..") || /^[a-zA-Z]:/.test(posix) || posix.startsWith("/");
}

// Control chars / edge whitespace are not part of a legitimate source path; a plan carrying them
// is malformed and REJECTED (not silently normalized — normalization let lookalike paths collapse).
function hasUnsafeChars(p) {
  const s = String(p ?? "");
  return /[\x00-\x1f\x7f]/.test(s) || s !== s.trim();
}

// Test-convention patterns (split out of the protected list): a path matching one of these is a
// TEST path — banned unless the step declares it in files[] with role:"test" AND lists it in
// test.files. Conversely a role:"test" file MUST match one (the harness must recognize it).
const TEST_PATH_RE = [
  /(^|\/)[^/]*\.(test|spec)\.[cm]?[jt]sx?$/i,
  /(^|\/)(tests?|__tests__|specs?)\//i
];

// Paths a plan must NEVER touch, regardless of role: repo/CI/git internals, deps + manifests,
// lockfiles, secrets, key material, build output, council state. Superset of structure-gate.mjs
// STRUCTURE_PROTECTED_RE (minus the test patterns above, which get the narrow role:"test"
// relaxation), of build-step.mjs PROTECTED_RE — a spec must never validate a path the build
// gate would later reject (council G1/C3: package.json / Dockerfile / dist|build|vendor|coverage
// were build-blocked but plan-validatable) — AND of audit-fix.mjs PROTECTED_RE's path classes
// (which add `.crt` to the key-material formats). Git CONTROL FILES (.gitmodules can re-point a
// submodule at an external URL; .gitattributes rewires filters/diff; .gitignore can hide
// artifacts from the drift rescan) and migrations (Safety v1 defers ALL migration work) are
// blocked here too — build-step should mirror both (see module notes).
const PLAN_PROTECTED_RE = [
  /(^|\/)\.github(\/|$)/i,
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)\.git(modules|attributes|ignore)$/i,
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)(dist|build|vendor|coverage)\//i,
  /(^|\/)package\.json$/i,
  /(^|\/)Dockerfile(\.[^/]*)?$/i,
  /(^|\/)migrations?(\/|$)/i,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i,
  /(^|\/)(Cargo\.lock|go\.sum|poetry\.lock|composer\.lock|Gemfile\.lock)$/i,
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.council/,
  /(^|\/)\.circleci(\/|$)/i,
  /(^|\/)\.buildkite(\/|$)/i,
  /(^|\/)\.teamcity(\/|$)/i,
  /(^|\/)(azure-pipelines|bitbucket-pipelines|appveyor)\.ya?ml$/i,
  /(^|\/)\.gitlab-ci\.ya?ml$/i,
  /(^|\/)\.travis\.ya?ml$/i,
  /(^|\/)(Jenkinsfile|\.drone\.ya?ml)$/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.docker(\/|$)/i,
  /(^|\/)\.dockercfg$/i,
  /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.|$)/i,
  /\.(pem|key|crt|p12|pfx|keystore|jks|p8|gpg|pgp|asc)$/i,
  /(^|\/)(\.npmrc|\.pypirc|\.netrc|\.envrc)$/i
];

/** True when a path matches a recognized test convention (file suffix or test directory). */
export function isPlanTestPath(posix) {
  const p = String(posix ?? "");
  return TEST_PATH_RE.some((re) => re.test(p));
}

/** True when a path is in a protected class no plan may EVER touch (test relaxation excluded). */
export function isPlanProtectedPath(posix) {
  const p = String(posix ?? "");
  return PLAN_PROTECTED_RE.some((re) => re.test(p));
}

// Reason a path is not a well-formed repo-relative POSIX path, or null. Plan paths are authored
// fresh by the synthesizer, so this REJECTS (never repairs): backslashes, control chars, edge
// whitespace, traversal, absolute/drive, empty or "." segments are all malformed.
function pathShapeReason(p) {
  if (typeof p !== "string" || p === "") return "must be a non-empty string";
  if (p.length > PLAN_LIMITS.path) return `exceeds ${PLAN_LIMITS.path} chars`;
  if (hasUnsafeChars(p)) return "contains control chars or edge whitespace";
  if (p.includes("\\")) return "contains a backslash (must be repo-relative POSIX)";
  if (isUnsafePath(p)) return "unsafe (traversal/absolute/drive)";
  const segs = p.split("/");
  if (segs.includes("") || segs.includes(".")) return "contains an empty or '.' segment";
  return null;
}

// Display-only scrubbing for error messages / markdown: strips control chars + clips. NEVER used
// for comparisons (identity stays exact so lookalike paths cannot collapse to equal).
function scrub(v, max = 120) {
  const s = String(v ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function isPlainObject(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function sha256Hex(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Request binding
// ---------------------------------------------------------------------------

/** Whitespace-normalized request (trim + collapse runs) — shell re-quoting must not break the bind. */
export function normalizeRequest(request) {
  return String(request ?? "").replace(/\s+/g, " ").trim();
}

/** sha256 of the normalized request — the value spec.requestHash MUST equal (verified in validate). */
export function requestDigest(request) {
  return sha256Hex(normalizeRequest(request));
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Parse PlanSpec input (JSON text or an already-parsed plain object) → { ok, spec, error }.
 * Strict: bounded size, JSON only, plain-object root. Parsing does NOT validate — callers must
 * run validatePlanSpec before trusting anything in the result. That is not comment-only (council
 * G3): a parse-only spec is UNUSABLE as a write boundary, because the capability-boundary helpers
 * (planStepTouched / planStepTestFiles / planStepImplFiles) THROW on steps that were never
 * validated. Only the deliberately-total display/digest helpers accept an unvalidated spec.
 */
export function parsePlanSpec(input) {
  if (isPlainObject(input)) return { ok: true, spec: input, error: null };
  if (typeof input !== "string") return { ok: false, spec: null, error: "input must be JSON text or a plain object" };
  const text = input.replace(/^\uFEFF/, ""); // strip a UTF-8 BOM before the strict parse
  if (text.length > PLAN_LIMITS.specChars) return { ok: false, spec: null, error: `spec exceeds ${PLAN_LIMITS.specChars} chars (bounded — never truncated)` };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, spec: null, error: `invalid JSON: ${scrub(e?.message)}` };
  }
  if (!isPlainObject(parsed)) return { ok: false, spec: null, error: "root must be a JSON object" };
  return { ok: true, spec: parsed, error: null };
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

function checkKeys(obj, required, optional, label, err) {
  const allowed = new Set([...required, ...optional]);
  for (const k of Object.keys(obj)) if (!allowed.has(k)) err(`${label}: unknown key '${scrub(k, 60)}'`);
  for (const k of required) if (!Object.prototype.hasOwnProperty.call(obj, k)) err(`${label}: missing key '${k}'`);
}

// Non-empty bounded string with no control chars beyond \t \n \r (intents may be multi-line).
function checkText(v, max, label, err) {
  if (typeof v !== "string" || !v.trim()) err(`${label} must be a non-empty string`);
  else if (v.length > max) err(`${label} exceeds ${max} chars`);
  else if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)) err(`${label} contains control characters`);
}

// Normalize the injected fileExists result to false | "file" | <other kind string>. A bare
// boolean `true` reads as "exists, kind unproven" — which fail-closed BLOCKS both create
// (something is there) and edit (not proven a regular file). A throwing probe records an error
// and returns "error" so the caller skips the (already-failed) existence checks.
function probeKind(probe, relPath, root, label, err) {
  let raw;
  try {
    raw = probe(relPath, root);
  } catch (e) {
    err(`${label}: fileExists threw (${scrub(e?.message)}) — fail-closed`);
    return "error";
  }
  if (raw === false || raw === null || raw === undefined || raw === "missing") return false;
  if (raw === "file") return "file";
  if (raw === true) return "exists (kind unproven)";
  return scrub(raw, 40) || "exists (kind unproven)";
}

/**
 * Validate a parsed PlanSpec against the frozen contract AND the current tree → { valid, errors,
 * value }. `value` is the normalized (canonical) spec when valid, else null. Fail-closed: every
 * rule violation is an error; an absent fileExists is itself an error (existence checks are
 * mandatory, not skippable). Existence is checked against a VIRTUAL overlay advanced step by
 * step, so "create in step 1, edit in step 2" validates while "create twice" or "edit a file
 * that never exists" rejects.
 *
 * deps: { root, fileExists, expectedRequest? }
 *  - fileExists(relPosixPath, root) → "file" | "dir" | false (boolean true is tolerated but reads
 *    as exists-of-unknown-kind, which blocks create AND edit). The adapter MUST lstat (a symlink
 *    is not a regular file) and MUST NOT answer "file" for a path whose RESOLUTION escapes root
 *    (ancestor symlink/junction) — report "symlink"/"escapes-root" instead; any kind other than
 *    exactly "file"/false fail-closed blocks both actions here. Realpath containment itself is
 *    I/O and is enforced again at build gate 2 (design ladder: "no symlink escape").
 *  - expectedRequest: the request the CALLER received out of band (CLI argv). When provided, the
 *    spec's request must normalize-equal it — which transitively re-binds requestHash to the real
 *    request. Without it the hash check is self-consistency only, and a request+hash pair
 *    recomputed together re-points the plan undetected (council C2). build --from MUST pass it.
 */
export function validatePlanSpec(spec, { root = ".", fileExists, expectedRequest } = {}) {
  const errors = [];
  const err = (msg) => {
    if (errors.length < MAX_ERRORS) errors.push(msg);
  };
  if (!isPlainObject(spec)) return { valid: false, errors: ["spec is not a plain object"], value: null };

  checkKeys(spec, TOP_KEYS, [], "spec", err);
  if (spec.schemaVersion !== PLAN_SCHEMA_VERSION) err(`schemaVersion must be exactly ${PLAN_SCHEMA_VERSION}`);

  checkText(spec.request, PLAN_LIMITS.request, "request", err);
  if (typeof spec.requestHash !== "string" || !SHA256_RE.test(spec.requestHash)) {
    err("requestHash must be 64 lowercase hex chars (sha256)");
  } else if (typeof spec.request === "string" && spec.request.trim() && spec.requestHash !== requestDigest(spec.request)) {
    // The hash is VERIFIED, not trusted: a --from plan re-pointed at a different request rejects.
    err("requestHash does not match sha256(normalized request)");
  }
  // Out-of-band request binding (council C2): self-consistency cannot catch request AND hash
  // replaced together, so a caller that knows the real request passes it and the spec must match.
  // A provided-but-garbage expectedRequest is itself an error (fail-closed, never a silent skip).
  if (expectedRequest !== undefined) {
    if (typeof expectedRequest !== "string" || !normalizeRequest(expectedRequest)) {
      err("expectedRequest must be a non-empty string when provided (fail-closed)");
    } else if (typeof spec.request === "string" && normalizeRequest(spec.request) !== normalizeRequest(expectedRequest)) {
      err("request does not match the expected request (--from plan re-pointed at a different request?)");
    }
  }
  if (typeof spec.baseCommit !== "string" || !GIT_SHA_RE.test(spec.baseCommit)) {
    err("baseCommit must be a full 40-char lowercase hex git sha");
  }

  const probe = typeof fileExists === "function" ? fileExists : null;
  if (!probe) err("fileExists is required (fail-closed: create/edit existence checks cannot run without it)");

  // --- steps ---
  if (!Array.isArray(spec.steps)) err("steps must be an array");
  else if (spec.steps.length === 0) err("steps must contain at least one step");
  else if (spec.steps.length > PLAN_LIMITS.steps) err(`steps exceeds ${PLAN_LIMITS.steps}`);
  else {
    const seenIds = new Map(); // id → step index (for the earlier-only dependsOn rule)
    const virtual = new Set(); // paths created by an EARLIER step (the tree, virtually advanced)
    spec.steps.forEach((step, i) => {
      const label = `steps[${i}]`;
      if (!isPlainObject(step)) {
        err(`${label}: not an object`);
        return;
      }
      checkKeys(step, STEP_KEYS, STEP_KEYS_OPTIONAL, label, err);

      const id = step.id;
      if (typeof id !== "string" || !ID_RE.test(id)) err(`${label}.id must match ^[a-z][a-z0-9-]{0,63}$`);
      else if (seenIds.has(id)) err(`${label}.id: duplicate id '${id}'`);
      else seenIds.set(id, i);

      checkText(step.title, PLAN_LIMITS.title, `${label}.title`, err);
      checkText(step.intent, PLAN_LIMITS.intent, `${label}.intent`, err);

      // dependsOn: EARLIER steps only — which makes the graph acyclic by construction (a cycle
      // would need at least one forward or self reference, and both reject here).
      const deps = Object.prototype.hasOwnProperty.call(step, "dependsOn") ? step.dependsOn : [];
      if (!Array.isArray(deps)) err(`${label}.dependsOn must be an array`);
      else {
        const seenDeps = new Set();
        for (const d of deps) {
          if (typeof d !== "string" || !ID_RE.test(d)) {
            err(`${label}.dependsOn: invalid id '${scrub(d, 80)}'`);
            continue;
          }
          if (seenDeps.has(d)) {
            err(`${label}.dependsOn: duplicate '${d}'`);
            continue;
          }
          seenDeps.add(d);
          const at = seenIds.get(d);
          if (at === undefined || at >= i) err(`${label}.dependsOn: '${d}' is not an EARLIER step (unknown, self, or forward reference)`);
        }
      }

      // files: the step's capability boundary. Each path appears ONCE with ONE role — which
      // makes the impl and test sets disjoint by construction.
      const files = step.files;
      if (!Array.isArray(files) || files.length === 0) {
        err(`${label}.files must be a non-empty array`);
        return;
      }
      if (files.length > PLAN_LIMITS.filesPerStep) err(`${label}.files exceeds ${PLAN_LIMITS.filesPerStep}`);
      const pathsSeen = new Set();
      const testRolePaths = new Set();
      let sourceRoleCount = 0;
      files.forEach((f, j) => {
        const flabel = `${label}.files[${j}]`;
        if (!isPlainObject(f)) {
          err(`${flabel}: not an object`);
          return;
        }
        checkKeys(f, FILE_KEYS, [], flabel, err);
        const reason = pathShapeReason(f.path);
        if (reason) {
          err(`${flabel}.path: ${reason}`);
          return;
        }
        const p = f.path;
        if (pathsSeen.has(p)) {
          err(`${flabel}.path: duplicate path '${scrub(p, 200)}' within the step`);
          return;
        }
        pathsSeen.add(p);
        checkText(f.intent, PLAN_LIMITS.text, `${flabel}.intent`, err);
        if (!ROLES.includes(f.role)) err(`${flabel}.role: unknown role '${scrub(f.role, 40)}' (source|test only)`);
        else if (f.role === "test") testRolePaths.add(p);
        else sourceRoleCount += 1;

        // Protection applies to EVERY path; the test relaxation is ONLY the convention patterns.
        if (isPlanProtectedPath(p)) err(`${flabel}.path: protected path (CI/git/deps/lockfiles/secrets/state — never plan-writable): '${scrub(p, 200)}'`);
        // Safety v1 autonomous scope (council C4): pure Node ESM LIBRARY steps only. Anything
        // else (shell, SQL, migrations, config, docs, other JS dialects) is deferred/human-gated
        // by design and must never validate into an autonomous plan. Exact lowercase `.mjs` —
        // a weird-cased extension is a lookalike, not a Node ESM module.
        if (!p.endsWith(".mjs")) err(`${flabel}.path: '${scrub(p, 200)}' is not a Node ESM module (*.mjs) — Safety v1 allows pure Node ESM library steps only`);
        const testish = isPlanTestPath(p);
        if (f.role === "test" && !testish) err(`${flabel}.path: role 'test' but '${scrub(p, 200)}' does not match a recognized test convention`);
        if (f.role !== "test" && testish) err(`${flabel}.path: test path '${scrub(p, 200)}' not declared role:'test' — the test-file ban applies`);

        if (!ACTIONS.includes(f.action)) {
          err(`${flabel}.action: unknown action '${scrub(f.action, 40)}' (create|edit only)`);
        } else if (probe) {
          // Existence vs the virtually-advanced tree: an earlier step's create satisfies a later
          // edit; a second create of the same path rejects.
          const kind = virtual.has(p) ? "file" : probeKind(probe, p, root, flabel, err);
          if (kind !== "error") {
            if (f.action === "create" && kind !== false) err(`${flabel}: create but '${scrub(p, 200)}' already exists (${kind === "file" ? "regular file" : kind})`);
            if (f.action === "edit" && kind !== "file") err(`${flabel}: edit but '${scrub(p, 200)}' ${kind === false ? "does not exist" : `is not a regular file (${kind})`}`);
            if (f.action === "create" && kind === false) virtual.add(p);
          }
        }
      });
      if (sourceRoleCount === 0) err(`${label}: needs at least one role:'source' file (RED→GREEN needs impl bytes)`);
      if (testRolePaths.size === 0) err(`${label}: needs at least one role:'test' file`);

      // test: its files must EXACTLY equal the role:"test" set — a declared-but-unlisted test
      // file (or a listed-but-undeclared one) is a contract violation, not a repairable slip.
      const t = step.test;
      if (!isPlainObject(t)) err(`${label}.test must be an object`);
      else {
        checkKeys(t, TEST_KEYS, [], `${label}.test`, err);
        checkText(t.intent, PLAN_LIMITS.text, `${label}.test.intent`, err);
        if (!Array.isArray(t.files) || t.files.length === 0) err(`${label}.test.files must be a non-empty array`);
        else {
          const seenT = new Set();
          for (const p of t.files) {
            if (typeof p !== "string" || pathShapeReason(p)) {
              err(`${label}.test.files: malformed path '${scrub(p, 200)}'`);
              continue;
            }
            if (seenT.has(p)) {
              err(`${label}.test.files: duplicate '${scrub(p, 200)}'`);
              continue;
            }
            seenT.add(p);
            if (!testRolePaths.has(p)) err(`${label}.test.files: '${scrub(p, 200)}' is not declared in files[] with role:'test'`);
          }
          for (const p of testRolePaths) if (!seenT.has(p)) err(`${label}: role:'test' file '${scrub(p, 200)}' missing from test.files`);
        }
      }
    });
  }

  // --- risks (may be empty, but the key is required and every entry is strict) ---
  if (!Array.isArray(spec.risks)) err("risks must be an array");
  else if (spec.risks.length > PLAN_LIMITS.risks) err(`risks exceeds ${PLAN_LIMITS.risks}`);
  else {
    const seen = new Set();
    spec.risks.forEach((r, i) => {
      const label = `risks[${i}]`;
      if (!isPlainObject(r)) {
        err(`${label}: not an object`);
        return;
      }
      checkKeys(r, RISK_KEYS, [], label, err);
      if (typeof r.id !== "string" || !r.id.trim() || r.id.length > 64 || hasUnsafeChars(r.id)) err(`${label}.id must be a short clean string`);
      else if (seen.has(r.id)) err(`${label}.id: duplicate '${scrub(r.id, 64)}'`);
      else seen.add(r.id);
      checkText(r.description, PLAN_LIMITS.text, `${label}.description`, err);
      checkText(r.mitigation, PLAN_LIMITS.text, `${label}.mitigation`, err);
    });
  }

  // --- testStrategy: "full" is the ONLY supported mode (frozen; anything else is an unknown
  // future dialect this build must not silently accept) ---
  const ts = spec.testStrategy;
  if (!isPlainObject(ts)) err("testStrategy must be an object");
  else {
    checkKeys(ts, TEST_STRATEGY_KEYS, [], "testStrategy", err);
    if (ts.perStep !== "full") err("testStrategy.perStep must be 'full'");
    if (ts.final !== "full") err("testStrategy.final must be 'full'");
  }

  const valid = errors.length === 0;
  return { valid, errors, value: valid ? normalizePlanSpec(spec) : null };
}

// ---------------------------------------------------------------------------
// Normalize / touched / digest
// ---------------------------------------------------------------------------

const byString = (a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

/**
 * Canonical deep copy: fixed key order, set-like arrays (files-by-path, test.files, dependsOn)
 * sorted, dependsOn defaulted to []. Step ORDER is preserved (it is semantic — dependsOn is
 * earlier-only). Values are copied verbatim — normalize never repairs; validation rejects.
 * Meant for VALIDATED specs; defensive on shape so it stays total.
 */
export function normalizePlanSpec(spec) {
  const s = isPlainObject(spec) ? spec : {};
  return {
    schemaVersion: s.schemaVersion,
    request: s.request,
    requestHash: s.requestHash,
    baseCommit: s.baseCommit,
    steps: (Array.isArray(s.steps) ? s.steps : []).map(normalizeStep),
    risks: (Array.isArray(s.risks) ? s.risks : []).map((r) => ({
      id: r?.id,
      description: r?.description,
      mitigation: r?.mitigation
    })),
    testStrategy: { perStep: s.testStrategy?.perStep, final: s.testStrategy?.final }
  };
}

function normalizeStep(step) {
  const st = isPlainObject(step) ? step : {};
  return {
    id: st.id,
    title: st.title,
    intent: st.intent,
    files: (Array.isArray(st.files) ? st.files : [])
      .map((f) => ({ path: f?.path, action: f?.action, role: f?.role, intent: f?.intent }))
      .sort((a, b) => byString(a.path, b.path)),
    test: {
      files: (Array.isArray(st.test?.files) ? st.test.files : []).slice().sort(byString),
      intent: st.test?.intent
    },
    dependsOn: (Array.isArray(st.dependsOn) ? st.dependsOn : []).slice().sort(byString)
  };
}

// The boundary helpers interpret ONLY validated steps. A step failing these shape checks means a
// caller SKIPPED validatePlanSpec (council G3/G4 — the parse-without-validate footgun): answering
// [] (or quietly dropping entries) there would hand downstream logic an empty/narrowed "boundary"
// it could misread as "nothing to write". Fail-closed: THROW, so a skipped validation becomes a
// crash, never a silent boundary collapse. (planSpecDigest stays total by design — a digest must
// never throw mid-gate — and renderPlanMarkdown is display-only with every value scrubbed.)
function validatedStepFiles(step, helper) {
  if (!isPlainObject(step) || !Array.isArray(step.files) || step.files.length === 0) {
    throw new Error(`${helper}: step is not a validated PlanSpec step — run validatePlanSpec first (fail-closed)`);
  }
  for (const f of step.files) {
    if (!isPlainObject(f) || pathShapeReason(f.path) !== null || !ACTIONS.includes(f.action) || !ROLES.includes(f.role)) {
      throw new Error(`${helper}: files[] entry '${scrub(f?.path, 200)}' is not a validated PlanSpec file — run validatePlanSpec first (fail-closed)`);
    }
    // PATH SHAPE IS NOT ENOUGH (council Codex P1): a syntactically fine path can still be a PROTECTED
    // one. Without this check a caller who skipped validatePlanSpec could hand in a step declaring
    // `.github/workflows/pwn.mjs` and planStepTouched would hand that path back as the step's CAPABILITY
    // BOUNDARY — i.e. the boundary itself would authorise writing a CI workflow. The boundary helpers are
    // the last line before the writer, so they must refuse a protected path outright, not merely a
    // malformed one.
    if (isPlanProtectedPath(f.path)) {
      throw new Error(`${helper}: files[] entry '${scrub(f.path, 200)}' is a PROTECTED path (CI/git/deps/lockfiles/secrets/manifests) — a validated PlanSpec can never declare one (fail-closed)`);
    }
    // Role/test coherence: a role:"test" file must look like a test path, and a role:"source" file must
    // not — otherwise a step could smuggle an impl file past the TEST-FIRST author boundary (or vice
    // versa) on an unvalidated shape.
    const looksTest = isPlanTestPath(f.path);
    if (f.role === "test" && !looksTest) {
      throw new Error(`${helper}: files[] entry '${scrub(f.path, 200)}' has role:"test" but is not a test path — run validatePlanSpec first (fail-closed)`);
    }
    if (f.role === "source" && looksTest) {
      throw new Error(`${helper}: files[] entry '${scrub(f.path, 200)}' has role:"source" but IS a test path — run validatePlanSpec first (fail-closed)`);
    }
  }
  return step.files;
}

/**
 * The step's CAPABILITY BOUNDARY: the EXACT set of files[].path (sorted, deduped) — which
 * already INCLUDES the test files (every test file must appear in files[] with role:"test").
 * Deliberately NOT widened with test.files: on a malformed step a defensive union would let the
 * writer touch an undeclared path the drift gate should catch instead. Throws on an unvalidated
 * step shape (never returns [] for garbage — an empty boundary must be impossible to fabricate).
 */
export function planStepTouched(step) {
  const set = new Set();
  for (const f of validatedStepFiles(step, "planStepTouched")) set.add(f.path);
  return [...set].sort(byString);
}

/** The step's test-file subset (role:"test"), sorted — the TEST-FIRST author's boundary. Throws on an unvalidated step shape. */
export function planStepTestFiles(step) {
  const set = new Set();
  for (const f of validatedStepFiles(step, "planStepTestFiles")) {
    if (f.role === "test") set.add(f.path);
  }
  return [...set].sort(byString);
}

/** The step's impl-file subset (everything not role:"test"), sorted — the IMPL author's boundary. Throws on an unvalidated step shape. */
export function planStepImplFiles(step) {
  const set = new Set();
  for (const f of validatedStepFiles(step, "planStepImplFiles")) {
    if (f.role !== "test") set.add(f.path);
  }
  return [...set].sort(byString);
}

// Canonical JSON: recursive key sort, so the digest is stable under key reordering. Undefined
// values serialize as null (total function — a digest must never throw mid-gate).
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * sha256 of the CANONICAL serialization (recursively sorted keys) — stable under key reordering,
 * sensitive to ANY value change. Deliberately does NOT drop or normalize fields first: an
 * injected unknown key must CHANGE the digest (tamper-evident), not vanish from it. For full
 * order-canonicity (sorted files/dependsOn too), digest validatePlanSpec(...).value.
 */
export function planSpecDigest(spec) {
  return sha256Hex(canonicalJson(spec));
}

// ---------------------------------------------------------------------------
// §6 sensitivity classification
// ---------------------------------------------------------------------------

// The §6 never-auto-apply classes (kept in spirit with audit-fix.mjs SENSITIVE_CATEGORIES), but a
// plan step has no finding category/lens — sensitivity is inferred from its paths + stated
// intents. Over-matching is SAFE here (a false "sensitive" only adds scrutiny/consent); a false
// negative is the dangerous direction, so the patterns are moderately broad. Council G2/C6:
// the real review demonstrated concrete false negatives (jwt/bearer, injection, xss/csrf/ssrf,
// sandboxing, privilege escalation), so those vocabularies are matched explicitly now — plus a
// second widening pass (cors/csp/clickjacking/traversal/spoofing/tampering, saml/oidc/mfa/otp,
// nonce/salt/keypair/KDFs/named ciphers, reentrancy/synchronization, sql/corruption/data-loss/
// backup): each is a §6 vocabulary a synthesizer plausibly uses without any earlier keyword.
const SENSITIVE_CLASS_RE = Object.freeze([
  ["security", /\b(secrets?|credentials?|tokens?|api[-_]?keys?|passwords?|passwd|csrf|xss|ssrf|cors|csp|clickjack\w*|injections?|traversal|spoof\w*|tamper\w*|sanitiz\w*|sandbox\w*|privileges?|escalat\w*|vulnerabilit\w*|exploits?|cves?)\b/i],
  ["auth", /\b(auth|authn|authz|authenticat\w*|authoriz\w*|login|logout|sessions?|oauth|sso|saml|oidc|mfa|2fa|otp|totp|rbac|acl|permissions?|jwts?|bearer|cookies?)\b/i],
  ["crypto", /\b(crypto\w*|ciphers?|encrypt\w*|decrypt\w*|hmac|sha-?\d+|md5|aes|rsa|ecdsa|ed25519|nonces?|salts?|key-?pairs?|private[-_ ]?keys?|bcrypt|scrypt|argon2\w*|pbkdf2|csprngs?|prngs?|entropy|signatures?|signing|certificates?|tls|ssl)\b/i],
  ["concurrency", /\b(concurren\w*|races?|mutex\w*|semaphores?|locks?|locking|atomic\w*|threads?|deadlocks?|re-?entran\w*|synchroniz\w*)\b/i],
  ["data-integrity", /\b(integrity|migrations?|transactions?|checksums?|persistence|databases?|db|sql|corrupt\w*|data[- ]loss|backups?)\b/i]
]);

/**
 * Does a step touch a §6-sensitive class (security/auth/crypto/concurrency/data-integrity)?
 * → { sensitive, classes, signals }. Fail-closed: a step with nothing classifiable (not an
 * object, or no text and no files) reads as SENSITIVE — an unclassifiable step must get more
 * scrutiny, never less (mirrors structure-gate's sensitiveOrUnclassified).
 */
export function classifyStep(step) {
  if (!isPlainObject(step)) {
    return { sensitive: true, classes: ["unclassifiable"], signals: ["step is not an object — fail-closed as sensitive"] };
  }
  const hasText = [step.title, step.intent].some((t) => typeof t === "string" && t.trim());
  const hasFiles = Array.isArray(step.files) && step.files.length > 0;
  if (!hasText && !hasFiles) {
    return { sensitive: true, classes: ["unclassifiable"], signals: ["no classifiable text or files — fail-closed as sensitive"] };
  }
  const classes = new Set();
  const signals = [];
  const scan = (text, source) => {
    const s = typeof text === "string" ? text : "";
    if (!s) return;
    for (const [cls, re] of SENSITIVE_CLASS_RE) {
      const m = re.exec(s);
      if (m && !classes.has(cls)) {
        classes.add(cls);
        signals.push(`${cls} ← ${source}: '${scrub(m[0], 40)}'`);
      }
    }
  };
  scan(step.title, "title");
  scan(step.intent, "intent");
  scan(step.test?.intent, "test intent");
  for (const f of Array.isArray(step.files) ? step.files : []) {
    scan(f?.path, "file path");
    scan(f?.intent, "file intent");
  }
  return { sensitive: classes.size > 0, classes: [...classes].sort(), signals };
}

// ---------------------------------------------------------------------------
// Markdown rendering (human artifact; display-only — everything scrubbed, nothing trusted)
// ---------------------------------------------------------------------------

/** Human-readable markdown for a PlanSpec. Defensive on shape; all values display-scrubbed. */
export function renderPlanMarkdown(spec) {
  const s = isPlainObject(spec) ? spec : {};
  const steps = Array.isArray(s.steps) ? s.steps : [];
  const lines = [];
  lines.push(`# PlanSpec: ${scrub(normalizeRequest(s.request), 100) || "(no request)"}`);
  lines.push("");
  lines.push(`- schemaVersion: ${scrub(s.schemaVersion, 20)}`);
  lines.push(`- baseCommit: \`${scrub(s.baseCommit, 64)}\``);
  lines.push(`- requestHash: \`${scrub(s.requestHash, 64)}\``);
  lines.push(`- steps: ${steps.length}`);
  lines.push("");
  lines.push("## Request");
  lines.push("");
  lines.push(scrub(s.request, PLAN_LIMITS.request));
  lines.push("");
  lines.push("## Steps");
  steps.forEach((step, i) => {
    const st = isPlainObject(step) ? step : {};
    lines.push("");
    lines.push(`### ${i + 1}. \`${scrub(st.id, 64)}\` — ${scrub(st.title, PLAN_LIMITS.title)}`);
    const deps = Array.isArray(st.dependsOn) ? st.dependsOn : [];
    if (deps.length) lines.push(`_depends on: ${deps.map((d) => `\`${scrub(d, 64)}\``).join(", ")}_`);
    lines.push("");
    lines.push(scrub(st.intent, PLAN_LIMITS.intent));
    lines.push("");
    for (const f of Array.isArray(st.files) ? st.files : []) {
      lines.push(`- \`${scrub(f?.path, PLAN_LIMITS.path)}\` (${scrub(f?.action, 12)}, ${scrub(f?.role, 12)}) — ${scrub(f?.intent, 200)}`);
    }
    const tf = Array.isArray(st.test?.files) ? st.test.files : [];
    lines.push("");
    lines.push(`**Test** (${tf.map((p) => `\`${scrub(p, PLAN_LIMITS.path)}\``).join(", ") || "none"}): ${scrub(st.test?.intent, 500)}`);
  });
  const risks = Array.isArray(s.risks) ? s.risks : [];
  if (risks.length) {
    lines.push("");
    lines.push("## Risks");
    for (const r of risks) lines.push(`- **${scrub(r?.id, 64)}**: ${scrub(r?.description, 500)} — _mitigation:_ ${scrub(r?.mitigation, 500)}`);
  }
  lines.push("");
  lines.push("## Test strategy");
  lines.push(`per-step: \`${scrub(s.testStrategy?.perStep, 20)}\` · final: \`${scrub(s.testStrategy?.final, 20)}\``);
  lines.push("");
  return lines.join("\n");
}
