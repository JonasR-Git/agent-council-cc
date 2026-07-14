// lib/consent.mjs — Stage 4 of the CLI-surface redesign: CONSENT CONTAINMENT (the security fix).
//
// PROBLEM (council P1, confirmed live): the auto-apply consents (structure_auto_apply /
// sensitive_auto_apply) used to live in the TRACKED `.council.yml` `fix:` block. Any clone/fork/
// PR-checkout that carried those lines made a bare `fix` auto-apply WRITE fixes with NO consent from
// THAT operator — the consent spread with the tree. A dual-key in the SAME committed file does not help
// (it copies along).
//
// FIX (docs/cli-surface-design.md Appendix D): consents are read ONLY from an OUT-OF-TREE, non-shared
// channel — a gitignored `.council.local.yml` OR the env `COUNCIL_TRUST_FIX` — fingerprint-bound to the
// repo's git origin AND per-clone acknowledged in the plugin STATE dir (never the repo). The tracked
// `.council.yml` consent keys are IGNORED (and warned). THE INVARIANT: no consent channel present + no
// flag ⇒ propose-only (the safe default).
//
// Determinism: every side-effecting dependency (git remote lookup, fs, clock, env) is injected via
// `deps` so resolveConsents is fully testable without touching the real repo/clock.

import crypto from "node:crypto";
import fsDefault from "node:fs";
import path from "node:path";
import process from "node:process";

import { runCommand } from "./process.mjs";
import { parseSimpleYaml, parseVerbBlocks } from "./policy.mjs";

/** The two auto-apply consents, in banner/iteration order. */
export const CONSENTS = ["structure", "sensitive"];
/** consent → snake_case config key (as written in `.council.local.yml` fix:). */
export const CONSENT_CONFIG_KEY = { structure: "structure_auto_apply", sensitive: "sensitive_auto_apply" };
/** consent → kebab CLI/option key (as parseArgs stores the flag). */
export const CONSENT_OPT_KEY = { structure: "structure-auto-apply", sensitive: "sensitive-auto-apply" };

/** The gitignored, per-clone consent file (its OWN file, never the tracked `.council.yml`). */
export const LOCAL_CONSENT_FILE = ".council.local.yml";
/** Env channel: `COUNCIL_TRUST_FIX=1` (both) / `=structure,sensitive` (listed) / `=0` (none). */
export const CONSENT_ENV_VAR = "COUNCIL_TRUST_FIX";
/** Per-clone acknowledgment record, written to the plugin STATE dir (never the repo). */
export const CONSENT_ACK_FILE = "consent-ack.json";

/**
 * Normalize a git remote URL to a stable canonical form so the SAME repo hashes identically regardless
 * of protocol / credentials / HOST case / default ssh port / trailing `.git`:
 *   https://github.com/Foo/Bar.git   →  github.com/Foo/Bar
 *   git@github.com:Foo/Bar.git       →  github.com/Foo/Bar
 *   ssh://git@GitHub.com:22/Foo/Bar/ →  github.com/Foo/Bar
 * Only the HOST is lowercased — hosts are case-insensitive but PATHS are NOT (a case-sensitive git host
 * serves `Foo/Bar` and `foo/bar` as two different repos, so lowercasing the path would COLLIDE them).
 * Returns "" for an empty/unknown URL.
 */
export function normalizeRemoteUrl(url) {
  let u = String(url ?? "").trim();
  if (!u) return "";
  // scp-like syntax: user@host:path (no scheme). Rewrite to host/path so it unifies with ssh://host/path.
  const scp = u.match(/^[^/@]+@([^:]+):(.+)$/);
  if (scp) {
    u = `${scp[1]}/${scp[2]}`;
  } else {
    u = u.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, ""); // drop scheme (https:// / ssh:// / git://)
    u = u.replace(/^[^/@]+@/, ""); // drop embedded credentials (user[:pass]@)
  }
  u = u.replace(/\.git$/i, ""); // strip trailing .git
  u = u.replace(/\/+$/, ""); // strip trailing slashes
  // Lowercase ONLY the host segment (up to the first `/`); drop a default ssh port so ssh://host:22/x
  // unifies with host/x. The path keeps its exact case.
  const slash = u.indexOf("/");
  const host = (slash === -1 ? u : u.slice(0, slash)).replace(/:22$/, "").toLowerCase();
  const rest = slash === -1 ? "" : u.slice(slash);
  return host + rest;
}

/** Real git remote lookup (the injectable default). Returns the origin URL string, or null. */
export function defaultGitRemote(cwd) {
  const r = runCommand("git", ["remote", "get-url", "origin"], { cwd, timeoutMs: 10_000 });
  if (r.status === 0 && r.stdout && r.stdout.trim()) return r.stdout.trim();
  return null;
}

/**
 * Is `rel` TRACKED by git under `dir`? (exit 0 from `git ls-files --error-unmatch`). Mirrors
 * lib/dotenv.mjs's gitTracks. Injected into resolveConsents so a git-tracked consent file is REFUSED.
 */
export function gitTracks(dir, rel) {
  try {
    return runCommand("git", ["ls-files", "--error-unmatch", "--", rel], { cwd: dir }).status === 0;
  } catch {
    return false; // no git / error → treat as untracked (the file is still local-only)
  }
}

/**
 * Stable fingerprint of the repo's git origin (a 128-bit sha256 prefix over the normalized URL). Returns
 * null when there is no origin (a repo with no origin CANNOT bind a trust record → config/env consent is
 * refused; only a per-invocation --<consent> flag works). `git` is injected for determinism.
 *
 * SECURITY NOTE: the fingerprint is derived from the PUBLIC origin URL (trivially derivable by anyone) —
 * it is NOT a secret and defends ONLY against an ACCIDENTAL copy of a `.council.local.yml` into a
 * different repo, NEVER against an attacker who force-commits one with the victim's known fingerprint.
 * The REAL gates are the git-tracked-file refusal (a consent file must be out-of-tree) + the per-clone,
 * per-workspace acknowledgment. Do not weaken either on the assumption the fingerprint is a secret.
 */
export function repoFingerprint(cwd, { git = defaultGitRemote } = {}) {
  const normalized = normalizeRemoteUrl(git(cwd));
  if (!normalized) return null;
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

/**
 * Parse the gitignored `.council.local.yml` (if present) at `dir`. Returns `{ file, fix, trustFingerprint }`
 * or null when the file is absent/unreadable. Uses the Stage-1 nesting parser so a `fix:` block with the
 * consent keys is recovered exactly like the tracked config, plus the top-level `trust_fingerprint` scalar.
 */
export function readLocalConsentConfig(dir, { fs = fsDefault } = {}) {
  const file = path.join(dir, LOCAL_CONSENT_FILE);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const flat = parseSimpleYaml(text);
  const blocks = parseVerbBlocks(text);
  const tf = flat.trust_fingerprint;
  return {
    file,
    fix: blocks.fix ?? {},
    trustFingerprint: tf == null || tf === "" ? null : String(tf)
  };
}

/**
 * Parse the `COUNCIL_TRUST_FIX` env value into the list of consents it grants:
 *   "1" / "true" / "all" → both; "structure,sensitive" → listed; "0" / "false" / "" → none.
 */
export function parseEnvConsent(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  const low = raw.toLowerCase();
  if (["0", "false", "off", "no"].includes(low)) return [];
  if (["1", "true", "on", "yes", "all"].includes(low)) return [...CONSENTS];
  const parts = raw.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  return CONSENTS.filter(
    (c) => parts.includes(c) || parts.includes(CONSENT_CONFIG_KEY[c]) || parts.includes(CONSENT_OPT_KEY[c])
  );
}

/** Path of the per-clone ack record inside the STATE dir. */
export function consentAckPath(stateDir) {
  return path.join(stateDir, CONSENT_ACK_FILE);
}

/** Read the per-clone ack record `{ fingerprint, cwd, acknowledgedAt }` or null. */
export function readConsentAck(stateDir, { fs = fsDefault } = {}) {
  try {
    const obj = JSON.parse(fs.readFileSync(consentAckPath(stateDir), "utf8"));
    if (obj && typeof obj === "object") return obj;
  } catch {
    /* absent/corrupt → no ack */
  }
  return null;
}

/**
 * Write the per-clone ack record to the STATE dir. `now` (clock) + `fs` are injected. The record binds
 * the acknowledgment to the current repo fingerprint + workspace path + timestamp; a later resolveConsents
 * only honors it when `fingerprint` matches the live one — so acking clone A never enables clone B.
 */
export function writeConsentAck(stateDir, { fingerprint = null, cwd, now = () => new Date(), fs = fsDefault } = {}) {
  const record = { fingerprint: fingerprint ?? null, cwd: cwd ?? null, acknowledgedAt: now().toISOString() };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(consentAckPath(stateDir), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

/**
 * Resolve the effective auto-apply consents for a fix run. STRICT precedence per consent
 * (flag > local(valid) > env > refused):
 *   1. `--no-<consent>` (options[optKey] === false) → FALSE, always wins (never overridable).
 *   2. `--<consent>` flag (options[optKey] === true) → TRUE, source "flag" — a deliberate per-invocation
 *      operator consent, allowed WITHOUT the fingerprint/ack/origin gate (they typed it this run; it is
 *      not persisted and cannot spread).
 *   3. otherwise CONFIG/ENV-SOURCED, allowed ONLY when ALL hold:
 *        - the live `repoFingerprint(cwd)` is NON-NULL (a repo with no git origin cannot bind a trust
 *          record → config/env consent is refused, source "refused:no-origin");
 *        - a channel grants it: a gitignored `.council.local.yml` fix: block whose `trust_fingerprint`
 *          equals the live fingerprint AND that is NOT git-tracked (a git-tracked consent file is a
 *          force-add attack vector → REFUSED + loud warning), OR env COUNCIL_TRUST_FIX. When the local
 *          file is ignored (mismatch / tracked) the env grant is STILL evaluated for that consent — a
 *          stale/hostile local file must never disable a valid env opt-in;
 *        - a per-clone, per-WORKSPACE ack record exists in the STATE dir whose fingerprint matches the
 *          live one AND whose cwd equals this workspace (two worktrees of one origin don't share an ack).
 *          Missing ack → REFUSED (source "refused:no-ack") with a clear "run `fix --acknowledge-consents`"
 *          message. ENV DECISION: env is an explicit machine-level opt-in that STILL requires the ack.
 *   4. `--dry-run` ALWAYS wins over any resolved consent (no writes regardless).
 * All side effects (git/fs/tracked/clock/env) come from `deps` for determinism.
 */
export function resolveConsents({ cwd, options = {}, stateDir, deps = {} } = {}) {
  const { fs = fsDefault, git = defaultGitRemote, isTracked = gitTracks, env = process.env } = deps;

  const warnings = [];
  const sources = { structure: null, sensitive: null };
  const value = { structure: false, sensitive: false };

  const dryRun = options["dry-run"] === true;
  const fingerprint = repoFingerprint(cwd, { git });
  const local = readLocalConsentConfig(cwd, { fs });
  const localTracked = !!local && isTracked(cwd, LOCAL_CONSENT_FILE); // A: a tracked consent file is refused
  const envConsents = parseEnvConsent(env[CONSENT_ENV_VAR]);
  const ack = readConsentAck(stateDir, { fs });
  // C + D: a valid ack requires a NON-NULL fingerprint that matches AND the recorded workspace to be THIS
  // one — so null===null cannot validate and a shared/migrated state dir cannot cross-enable clones.
  const ackValid = !!ack && fingerprint != null && ack.fingerprint === fingerprint && ack.cwd === cwd;

  // Classify the local grant ONCE (shared across both consents' warnings). "valid" | "tracked" | "mismatch".
  let localState = null;
  if (local && (local.fix.structure_auto_apply === true || local.fix.sensitive_auto_apply === true)) {
    if (localTracked) localState = "tracked";
    else if (!fingerprint || !local.trustFingerprint || local.trustFingerprint !== fingerprint) localState = "mismatch";
    else localState = "valid";
  }
  if (localState === "tracked") {
    warnings.push(
      `SECURITY: ${LOCAL_CONSENT_FILE} is git-tracked — a consent file MUST be gitignored/out-of-tree ` +
        "(a tracked consent file is a red flag: it can be force-added in a PR to auto-apply from repo " +
        "content). IGNORING its consents. Remove it from git and keep it local-only. See Appendix D."
    );
  } else if (localState === "mismatch") {
    warnings.push(
      `Warning: ${LOCAL_CONSENT_FILE} carries auto-apply consent but its trust_fingerprint ` +
        `${local.trustFingerprint ? `(${local.trustFingerprint.slice(0, 12)}…) ` : "is missing and "}` +
        `does not match this repo's git origin fingerprint` +
        `${fingerprint ? ` (${fingerprint.slice(0, 12)}…)` : " (no git origin found)"} — consent IGNORED ` +
        `(was this file copied from another repo?). Regenerate ${LOCAL_CONSENT_FILE} for THIS clone. See Appendix D.`
    );
  }

  const needAck = [];
  let noOriginRefused = false;

  for (const c of CONSENTS) {
    const optKey = CONSENT_OPT_KEY[c];
    const cfgKey = CONSENT_CONFIG_KEY[c];
    const flagVal = options[optKey];

    // Rule 1: --no-<consent> → false, always wins.
    if (flagVal === false) continue;
    // Rule 2: --<consent> flag → true, one-off, no gate.
    if (flagVal === true) {
      value[c] = true;
      sources[c] = "flag";
      continue;
    }

    // Rule 3: config/env-sourced. Precedence: local(valid) > env; a bad local NEVER blocks env (F).
    const localGrant = !!(local && local.fix && local.fix[cfgKey] === true);
    const envGrant = envConsents.includes(c);
    if (!localGrant && !envGrant) continue; // no channel ⇒ safe default (propose-only), source null

    // C: config/env consent requires a NON-NULL live fingerprint (no origin ⇒ cannot bind a trust record).
    if (!fingerprint) {
      sources[c] = "refused:no-origin";
      noOriginRefused = true;
      continue;
    }

    // The channel that could grant `c`: a VALID local file for this consent, else env (F: env after local).
    let channel = null;
    if (localGrant && localState === "valid") channel = "local";
    else if (envGrant) channel = "env";
    if (!channel) {
      // localGrant was the only source and it was ignored (tracked/mismatch); already warned above.
      sources[c] = "refused:ignored";
      continue;
    }

    // Ack gate (C non-null fingerprint + D cwd binding folded into ackValid).
    if (!ackValid) {
      needAck.push(cfgKey);
      sources[c] = "refused:no-ack";
      continue;
    }

    value[c] = true;
    sources[c] = channel;
  }

  if (noOriginRefused) {
    warnings.push(
      "config/env auto-apply consent found but this repo has NO git origin — cannot bind a trust record; " +
        "consent REFUSED (propose-only). Pass --structure-auto-apply / --sensitive-auto-apply for a one-off."
    );
  }
  if (needAck.length) {
    warnings.push(
      `config/env auto-apply consent (${needAck.join(", ")}) found but not acknowledged in this workspace — ` +
        "run `fix --acknowledge-consents` once to enable, or pass --structure-auto-apply / " +
        "--sensitive-auto-apply for a one-off. See Appendix D."
    );
  }

  // Rule 4: --dry-run ALWAYS wins over any resolved consent (no writes regardless).
  if (dryRun) {
    for (const c of CONSENTS) {
      if (value[c]) sources[c] = "dry-run";
      value[c] = false;
    }
  }

  return {
    structureAutoApply: value.structure,
    sensitiveAutoApply: value.sensitive,
    sources,
    warnings,
    fingerprint,
    acknowledged: ackValid,
    dryRun
  };
}

/**
 * Decide whether `fix --acknowledge-consents` may WRITE an ack right now (B). Returns
 * `{ ok, fingerprint, channel?, reason? }`. An ack is written ONLY when a valid consent CHANNEL exists
 * this instant AND the live fingerprint is non-null (C) — never pre-created to later validate a
 * force-added file. `git`/`fs`/`isTracked`/`env` are injected.
 */
export function evaluateAckWrite({ cwd, deps = {} } = {}) {
  const { fs = fsDefault, git = defaultGitRemote, isTracked = gitTracks, env = process.env } = deps;
  const fingerprint = repoFingerprint(cwd, { git });
  if (!fingerprint) {
    return { ok: false, fingerprint: null, reason: "no git origin — cannot bind a trust record; use --structure-auto-apply / --sensitive-auto-apply for a one-off." };
  }
  const local = readLocalConsentConfig(cwd, { fs });
  const tracked = !!local && isTracked(cwd, LOCAL_CONSENT_FILE);
  const localValid =
    !!local && !tracked && local.trustFingerprint === fingerprint &&
    (local.fix.structure_auto_apply === true || local.fix.sensitive_auto_apply === true);
  const envGranted = parseEnvConsent(env[CONSENT_ENV_VAR]).length > 0;
  if (!localValid && !envGranted) {
    const reason = tracked
      ? `${LOCAL_CONSENT_FILE} is git-tracked (ignored — a consent file must be gitignored) and no ${CONSENT_ENV_VAR} is set — no valid consent channel to acknowledge.`
      : `no valid consent channel present (need a gitignored ${LOCAL_CONSENT_FILE} whose trust_fingerprint matches this repo, or ${CONSENT_ENV_VAR}). Nothing to acknowledge.`;
    return { ok: false, fingerprint, reason };
  }
  return { ok: true, fingerprint, channel: localValid ? "local" : "env" };
}

/** Human label for a resolved consent source (used by the effective-policy banner). */
function sourceLabel(source) {
  switch (source) {
    case "flag":
      return "flag";
    case "local":
      return "local,acknowledged";
    case "env":
      return "env,acknowledged";
    case "dry-run":
      return "dry-run";
    // Refused states — a channel WAS present but did not grant; distinct from "none" (no channel at all).
    case "refused:no-ack":
      return "refused:no-ack";
    case "refused:no-origin":
      return "refused:no-origin";
    case "refused:ignored":
      return "refused:ignored";
    default:
      return "none";
  }
}

/**
 * Format the ONE effective-policy banner line printed to stderr at the start of every fix run (EVEN under
 * --json, so a silent behavior change is impossible): each consent knob with its resolved value + source.
 * e.g. `effective-policy [fix]: structure_auto_apply=true(local,acknowledged) sensitive_auto_apply=false(none)`
 */
export function formatConsentBanner(resolution, { verb = "fix" } = {}) {
  const parts = CONSENTS.map((c) => {
    const on = c === "structure" ? resolution.structureAutoApply : resolution.sensitiveAutoApply;
    return `${CONSENT_CONFIG_KEY[c]}=${on ? "true" : "false"}(${sourceLabel(resolution.sources[c])})`;
  });
  const fp = resolution.fingerprint ? ` fingerprint=${resolution.fingerprint.slice(0, 12)}…` : " fingerprint=none";
  return `effective-policy [${verb}]: ${parts.join(" ")}${resolution.dryRun ? " dry_run=true" : ""}${fp}`;
}
