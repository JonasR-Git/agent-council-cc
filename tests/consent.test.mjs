import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONSENT_ACK_FILE,
  CONSENT_ENV_VAR,
  LOCAL_CONSENT_FILE,
  consentAckPath,
  evaluateAckWrite,
  formatConsentBanner,
  normalizeRemoteUrl,
  parseEnvConsent,
  readConsentAck,
  repoFingerprint,
  resolveConsents,
  writeConsentAck
} from "../plugins/council/scripts/lib/consent.mjs";
import { loadPolicy, parseFixBlock, trackedConsentWarnings } from "../plugins/council/scripts/lib/policy.mjs";

// Stage 4 (docs/cli-surface-design.md Appendix D) — CONSENT CONTAINMENT (the security fix).
// resolveConsents injects every side effect (git remote lookup, fs, clock, env), so these tests are
// fully deterministic without touching the real repo/clock. `cwd`/`stateDir` are separate temp dirs.

const ORIGIN_A = "https://github.com/foo/bar.git";
const ORIGIN_B = "git@github.com:baz/qux.git";
const gitOf = (url) => () => url; // injected git remote → always returns `url`
const FIXED_CLOCK = () => new Date("2026-07-14T12:00:00.000Z");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `council-consent-${prefix}-`));
}

/** A cwd temp dir carrying a `.council.local.yml` with the two consents + `trust_fingerprint`. */
function makeLocalRepo(fingerprint, { structure = true, sensitive = true } = {}) {
  const dir = tmpDir("repo");
  fs.writeFileSync(
    path.join(dir, LOCAL_CONSENT_FILE),
    `fix:\n  structure_auto_apply: ${structure}\n  sensitive_auto_apply: ${sensitive}\ntrust_fingerprint: ${fingerprint}\n`,
    "utf8"
  );
  return dir;
}

function cleanup(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

// ── fingerprint: stability + normalization ─────────────────────────────────────────────────────────

test("repoFingerprint is stable for the same origin and differs for a different origin", () => {
  const cwd = tmpDir("fp");
  try {
    const a1 = repoFingerprint(cwd, { git: gitOf(ORIGIN_A) });
    const a2 = repoFingerprint(cwd, { git: gitOf(ORIGIN_A) });
    const b = repoFingerprint(cwd, { git: gitOf(ORIGIN_B) });
    assert.equal(a1, a2, "same origin ⇒ identical fingerprint");
    assert.notEqual(a1, b, "different origin ⇒ different fingerprint");
    assert.match(a1, /^[0-9a-f]{32}$/, "fingerprint is a 128-bit hex prefix");
  } finally {
    cleanup(cwd);
  }
});

test("normalizeRemoteUrl unifies https/ssh/scp forms of the SAME repo; no origin → null fingerprint", () => {
  assert.equal(
    normalizeRemoteUrl("https://github.com/Foo/Bar.git"),
    normalizeRemoteUrl("git@github.com:Foo/Bar.git"),
    "https and scp-ssh of the same repo normalize equal"
  );
  assert.equal(normalizeRemoteUrl("ssh://git@github.com/foo/bar/"), "github.com/foo/bar");
  // G: only the HOST is lowercased; the default ssh port is dropped so ssh://host:22/x == host/x.
  assert.equal(normalizeRemoteUrl("https://GitHub.COM/Foo/Bar"), "github.com/Foo/Bar", "host lowercased, path case preserved");
  assert.equal(normalizeRemoteUrl("ssh://git@github.com:22/Foo/Bar.git"), "github.com/Foo/Bar", "default ssh port unified");
  // G: a case-sensitive host serves Foo/Bar and foo/bar as DIFFERENT repos — must not collide.
  assert.notEqual(normalizeRemoteUrl("https://example.com/Foo/Bar"), normalizeRemoteUrl("https://example.com/foo/bar"));
  const cwd = tmpDir("noorigin");
  try {
    assert.equal(repoFingerprint(cwd, { git: () => null }), null, "no origin ⇒ null fingerprint");
  } finally {
    cleanup(cwd);
  }
});

// ── rule 1: --no-<consent> beats everything ─────────────────────────────────────────────────────────

test("--no-<consent> is FALSE and wins over an otherwise-valid local+ack consent", () => {
  const cwd = tmpDir("no");
  const stateDir = tmpDir("no-state");
  try {
    const fp = repoFingerprint(cwd, { git: gitOf(ORIGIN_A) });
    fs.writeFileSync(path.join(cwd, LOCAL_CONSENT_FILE), `fix:\n  structure_auto_apply: true\ntrust_fingerprint: ${fp}\n`, "utf8");
    writeConsentAck(stateDir, { fingerprint: fp, cwd, now: FIXED_CLOCK });
    const r = resolveConsents({
      cwd,
      options: { "structure-auto-apply": false },
      stateDir,
      deps: { git: gitOf(ORIGIN_A) }
    });
    assert.equal(r.structureAutoApply, false);
    assert.equal(r.sources.structure, null);
  } finally {
    cleanup(cwd, stateDir);
  }
});

// ── rule 2: --<consent> flag → true, one-off, NO fingerprint/ack gate ───────────────────────────────

test("--<consent> flag grants the consent WITHOUT a fingerprint or ack (a per-invocation one-off)", () => {
  const cwd = tmpDir("flag"); // no .council.local.yml, no origin, no ack
  const stateDir = tmpDir("flag-state");
  try {
    const r = resolveConsents({
      cwd,
      options: { "structure-auto-apply": true },
      stateDir,
      deps: { git: () => null } // no origin at all
    });
    assert.equal(r.structureAutoApply, true);
    assert.equal(r.sources.structure, "flag");
    assert.equal(r.sensitiveAutoApply, false, "the other consent stays off");
    assert.equal(fs.existsSync(consentAckPath(stateDir)), false, "a flag never persists an ack");
  } finally {
    cleanup(cwd, stateDir);
  }
});

// ── rule 3: tracked .council.yml consent is IGNORED + warned ────────────────────────────────────────

test("a TRACKED .council.yml consent is NOT read by resolveConsents (propose-only)", () => {
  const cwd = tmpDir("tracked");
  const stateDir = tmpDir("tracked-state");
  try {
    // Only the TRACKED config carries the consent — no .council.local.yml, no env, no flag.
    fs.writeFileSync(path.join(cwd, ".council.yml"), "version: 1\nfix:\n  structure_auto_apply: true\n  sensitive_auto_apply: true\n", "utf8");
    const r = resolveConsents({ cwd, options: {}, stateDir, deps: { git: gitOf(ORIGIN_A) } });
    assert.equal(r.structureAutoApply, false, "tracked config must NEVER grant a consent");
    assert.equal(r.sensitiveAutoApply, false);
    assert.deepEqual(r.warnings, [], "no local/env grant ⇒ no ack/fingerprint warning (safe default, silent)");
  } finally {
    cleanup(cwd, stateDir);
  }
});

test("loadPolicy emits the LOUD tracked-consent warning; the key still parses (non-destructive)", () => {
  const cwd = tmpDir("trackedwarn");
  try {
    fs.writeFileSync(path.join(cwd, ".council.yml"), "version: 1\nfix:\n  loop: true\n  structure_auto_apply: true\n", "utf8");
    const pol = loadPolicy(cwd);
    assert.ok(
      pol._warnings.some((w) => /fix\.structure_auto_apply is IGNORED for consent/.test(w)),
      `expected a tracked-consent warning, got: ${JSON.stringify(pol._warnings)}`
    );
    assert.equal(parseFixBlock(fs.readFileSync(path.join(cwd, ".council.yml"), "utf8")).structure_auto_apply, true, "value is still parsed");
    // Direct helper: clean fix block → no warnings.
    assert.deepEqual(trackedConsentWarnings({ loop: true }), []);
  } finally {
    cleanup(cwd);
  }
});

// ── rule 3: local + matching fingerprint + ack → APPLIED ────────────────────────────────────────────

test("local consent + matching fingerprint + acknowledgment → APPLIED (source local,acknowledged)", () => {
  const stateDir = tmpDir("ok-state");
  const fpProbe = tmpDir("fpprobe");
  try {
    const fp = repoFingerprint(fpProbe, { git: gitOf(ORIGIN_A) });
    const cwd = makeLocalRepo(fp);
    try {
      writeConsentAck(stateDir, { fingerprint: fp, cwd, now: FIXED_CLOCK });
      const r = resolveConsents({ cwd, options: {}, stateDir, deps: { git: gitOf(ORIGIN_A) } });
      assert.equal(r.structureAutoApply, true);
      assert.equal(r.sensitiveAutoApply, true);
      assert.equal(r.sources.structure, "local");
      assert.equal(r.sources.sensitive, "local");
      assert.equal(r.acknowledged, true);
      assert.deepEqual(r.warnings, []);
    } finally {
      cleanup(cwd);
    }
  } finally {
    cleanup(stateDir, fpProbe);
  }
});

// ── rule 3: missing ack → REFUSED (propose-only) + message ──────────────────────────────────────────

test("local consent + matching fingerprint but NO ack → refused (propose-only) with a clear message", () => {
  const stateDir = tmpDir("noack-state"); // empty: no consent-ack.json
  const fpProbe = tmpDir("noack-fp");
  try {
    const fp = repoFingerprint(fpProbe, { git: gitOf(ORIGIN_A) });
    const cwd = makeLocalRepo(fp);
    try {
      const r = resolveConsents({ cwd, options: {}, stateDir, deps: { git: gitOf(ORIGIN_A) } });
      assert.equal(r.structureAutoApply, false);
      assert.equal(r.sensitiveAutoApply, false);
      assert.equal(r.acknowledged, false);
      assert.equal(r.sources.structure, "refused:no-ack", "channel present but unacked → distinct refused label");
      assert.ok(
        r.warnings.some((w) => /not acknowledged in this workspace/.test(w) && /--acknowledge-consents/.test(w)),
        `expected a missing-ack refusal message, got: ${JSON.stringify(r.warnings)}`
      );
    } finally {
      cleanup(cwd);
    }
  } finally {
    cleanup(stateDir, fpProbe);
  }
});

// ── rule 3: mismatched fingerprint (copied file) → IGNORED + warning ────────────────────────────────

test("a .council.local.yml copied from another repo (fingerprint mismatch) is IGNORED with a loud warning", () => {
  const stateDir = tmpDir("mismatch-state");
  const fpProbe = tmpDir("mismatch-fp");
  try {
    // The file's trust_fingerprint is repo B's, but the live origin is repo A → mismatch.
    const fpB = repoFingerprint(fpProbe, { git: gitOf(ORIGIN_B) });
    const cwd = makeLocalRepo(fpB);
    try {
      // Even WITH a matching ack for the live repo, the file fingerprint mismatch alone kills the consent.
      const fpA = repoFingerprint(fpProbe, { git: gitOf(ORIGIN_A) });
      writeConsentAck(stateDir, { fingerprint: fpA, cwd, now: FIXED_CLOCK });
      const r = resolveConsents({ cwd, options: {}, stateDir, deps: { git: gitOf(ORIGIN_A) } });
      assert.equal(r.structureAutoApply, false);
      assert.equal(r.sensitiveAutoApply, false);
      assert.ok(
        r.warnings.some((w) => /trust_fingerprint/.test(w) && /does not match/.test(w) && /IGNORED/.test(w)),
        `expected a fingerprint-mismatch warning, got: ${JSON.stringify(r.warnings)}`
      );
    } finally {
      cleanup(cwd);
    }
  } finally {
    cleanup(stateDir, fpProbe);
  }
});

// ── env COUNCIL_TRUST_FIX: explicit machine opt-in that STILL requires the per-clone ack ────────────

test("parseEnvConsent maps 1/true/all → both, a list → listed, 0/false → none", () => {
  assert.deepEqual(parseEnvConsent("1"), ["structure", "sensitive"]);
  assert.deepEqual(parseEnvConsent("true"), ["structure", "sensitive"]);
  assert.deepEqual(parseEnvConsent("structure"), ["structure"]);
  assert.deepEqual(parseEnvConsent("sensitive,structure"), ["structure", "sensitive"]);
  assert.deepEqual(parseEnvConsent("0"), []);
  assert.deepEqual(parseEnvConsent(""), []);
  assert.deepEqual(parseEnvConsent(undefined), []);
});

test("env COUNCIL_TRUST_FIX grants ONLY after the per-clone ack (no .council.local.yml needed)", () => {
  const cwd = tmpDir("env"); // NO .council.local.yml — env is the channel
  const stateDir = tmpDir("env-state");
  try {
    const fp = repoFingerprint(cwd, { git: gitOf(ORIGIN_A) });
    const env = { [CONSENT_ENV_VAR]: "1" };
    // DECISION: env is an explicit opt-in but still ack-gated — without an ack it is REFUSED.
    const before = resolveConsents({ cwd, options: {}, stateDir, deps: { git: gitOf(ORIGIN_A), env } });
    assert.equal(before.structureAutoApply, false, "env alone (no ack) does not auto-apply");
    assert.ok(before.warnings.some((w) => /not acknowledged/.test(w)));
    // After the ack, env grants both consents (source env).
    writeConsentAck(stateDir, { fingerprint: fp, cwd, now: FIXED_CLOCK });
    const after = resolveConsents({ cwd, options: {}, stateDir, deps: { git: gitOf(ORIGIN_A), env } });
    assert.equal(after.structureAutoApply, true);
    assert.equal(after.sensitiveAutoApply, true);
    assert.equal(after.sources.structure, "env");
  } finally {
    cleanup(cwd, stateDir);
  }
});

// ── acknowledgment record: write → read round-trip; second resolve applies ──────────────────────────

test("writeConsentAck records {fingerprint,cwd,acknowledgedAt}; a second resolve then applies the local consent", () => {
  const stateDir = tmpDir("ack-state");
  const fpProbe = tmpDir("ack-fp");
  try {
    const fp = repoFingerprint(fpProbe, { git: gitOf(ORIGIN_A) });
    const cwd = makeLocalRepo(fp);
    try {
      // First resolve: no ack → refused.
      assert.equal(resolveConsents({ cwd, options: {}, stateDir, deps: { git: gitOf(ORIGIN_A) } }).structureAutoApply, false);
      // Write the ack (the `fix --acknowledge-consents` action), then read it back.
      const rec = writeConsentAck(stateDir, { fingerprint: fp, cwd, now: FIXED_CLOCK });
      assert.equal(rec.fingerprint, fp);
      assert.equal(rec.cwd, cwd);
      assert.equal(rec.acknowledgedAt, "2026-07-14T12:00:00.000Z");
      assert.equal(path.basename(consentAckPath(stateDir)), CONSENT_ACK_FILE);
      const readBack = readConsentAck(stateDir);
      assert.deepEqual(readBack, rec);
      // Second resolve: ack present + matching → applied.
      assert.equal(resolveConsents({ cwd, options: {}, stateDir, deps: { git: gitOf(ORIGIN_A) } }).structureAutoApply, true);
    } finally {
      cleanup(cwd);
    }
  } finally {
    cleanup(stateDir, fpProbe);
  }
});

test("an ack recorded under a DIFFERENT fingerprint (acked clone A, resolving in clone B) does not apply", () => {
  const stateDir = tmpDir("crossack-state");
  const fpProbe = tmpDir("crossack-fp");
  try {
    const fpA = repoFingerprint(fpProbe, { git: gitOf(ORIGIN_A) });
    const cwd = makeLocalRepo(fpA); // local file bound to A
    try {
      // Ack was written for repo B's fingerprint (e.g. copied state) — must not validate for A.
      writeConsentAck(stateDir, { fingerprint: repoFingerprint(fpProbe, { git: gitOf(ORIGIN_B) }), cwd, now: FIXED_CLOCK });
      const r = resolveConsents({ cwd, options: {}, stateDir, deps: { git: gitOf(ORIGIN_A) } });
      assert.equal(r.structureAutoApply, false);
      assert.equal(r.acknowledged, false);
    } finally {
      cleanup(cwd);
    }
  } finally {
    cleanup(stateDir, fpProbe);
  }
});

// ── rule 4: --dry-run overrides an active consent ───────────────────────────────────────────────────

test("--dry-run overrides an otherwise-active local+ack consent (no writes; source dry-run)", () => {
  const stateDir = tmpDir("dry-state");
  const fpProbe = tmpDir("dry-fp");
  try {
    const fp = repoFingerprint(fpProbe, { git: gitOf(ORIGIN_A) });
    const cwd = makeLocalRepo(fp);
    try {
      writeConsentAck(stateDir, { fingerprint: fp, cwd, now: FIXED_CLOCK });
      const r = resolveConsents({ cwd, options: { "dry-run": true }, stateDir, deps: { git: gitOf(ORIGIN_A) } });
      assert.equal(r.structureAutoApply, false);
      assert.equal(r.sensitiveAutoApply, false);
      assert.equal(r.sources.structure, "dry-run");
      assert.equal(r.dryRun, true);
    } finally {
      cleanup(cwd);
    }
  } finally {
    cleanup(stateDir, fpProbe);
  }
});

test("--dry-run also overrides an explicit --<consent> flag", () => {
  const cwd = tmpDir("dryflag");
  const stateDir = tmpDir("dryflag-state");
  try {
    const r = resolveConsents({
      cwd,
      options: { "structure-auto-apply": true, "dry-run": true },
      stateDir,
      deps: { git: () => null }
    });
    assert.equal(r.structureAutoApply, false, "dry-run wins over any consent, incl. a per-invocation flag");
  } finally {
    cleanup(cwd, stateDir);
  }
});

// ── the invariant: no channel + no flag ⇒ propose-only ──────────────────────────────────────────────

test("INVARIANT: no consent channel + no flag ⇒ propose-only (both false, no warnings)", () => {
  const cwd = tmpDir("bare");
  const stateDir = tmpDir("bare-state");
  try {
    const r = resolveConsents({ cwd, options: {}, stateDir, deps: { git: gitOf(ORIGIN_A) } });
    assert.equal(r.structureAutoApply, false);
    assert.equal(r.sensitiveAutoApply, false);
    assert.deepEqual(r.sources, { structure: null, sensitive: null });
    assert.deepEqual(r.warnings, []);
  } finally {
    cleanup(cwd, stateDir);
  }
});

// ── the effective-policy banner ─────────────────────────────────────────────────────────────────────

test("formatConsentBanner reports each knob + its source, single line, verb-tagged", () => {
  const flagged = formatConsentBanner(
    { structureAutoApply: true, sensitiveAutoApply: false, sources: { structure: "flag", sensitive: null }, fingerprint: "abcdef0123456789", dryRun: false },
    { verb: "fix" }
  );
  assert.match(flagged, /^effective-policy \[fix\]: /);
  assert.match(flagged, /structure_auto_apply=true\(flag\)/);
  assert.match(flagged, /sensitive_auto_apply=false\(none\)/);
  assert.equal(flagged.includes("\n"), false, "the banner is exactly ONE line");

  const local = formatConsentBanner(
    { structureAutoApply: true, sensitiveAutoApply: true, sources: { structure: "local", sensitive: "env" }, fingerprint: "abcdef0123456789", dryRun: false }
  );
  assert.match(local, /structure_auto_apply=true\(local,acknowledged\)/);
  assert.match(local, /sensitive_auto_apply=true\(env,acknowledged\)/);
});

// ── A (P1): a GIT-TRACKED .council.local.yml is REFUSED even with a matching fingerprint + valid ack ──

test("A: a git-tracked .council.local.yml is IGNORED (force-add vector) even with matching fingerprint + ack", () => {
  const stateDir = tmpDir("tracked-local-state");
  const fpProbe = tmpDir("tracked-local-fp");
  try {
    const fp = repoFingerprint(fpProbe, { git: gitOf(ORIGIN_A) });
    const cwd = makeLocalRepo(fp);
    try {
      writeConsentAck(stateDir, { fingerprint: fp, cwd, now: FIXED_CLOCK }); // an already-acked clone
      const r = resolveConsents({
        cwd,
        options: {},
        stateDir,
        deps: { git: gitOf(ORIGIN_A), isTracked: () => true } // git TRACKS the file
      });
      assert.equal(r.structureAutoApply, false, "a tracked consent file must never auto-apply");
      assert.equal(r.sensitiveAutoApply, false);
      assert.ok(
        r.warnings.some((w) => /git-tracked/.test(w) && /SECURITY/.test(w)),
        `expected the git-tracked SECURITY warning, got: ${JSON.stringify(r.warnings)}`
      );
    } finally {
      cleanup(cwd);
    }
  } finally {
    cleanup(stateDir, fpProbe);
  }
});

// ── C (P1): no git origin ⇒ config/env consent refused; null-fingerprint ack cannot validate ─────────

test("C: no git origin + COUNCIL_TRUST_FIX + a null-fingerprint ack ⇒ REFUSED (propose-only)", () => {
  const cwd = tmpDir("noorigin-env");
  const stateDir = tmpDir("noorigin-env-state");
  try {
    // Even a pre-existing ack whose fingerprint is null must NOT validate (null===null guard).
    writeConsentAck(stateDir, { fingerprint: null, cwd, now: FIXED_CLOCK });
    const r = resolveConsents({
      cwd,
      options: {},
      stateDir,
      deps: { git: () => null, env: { [CONSENT_ENV_VAR]: "1" } }
    });
    assert.equal(r.structureAutoApply, false);
    assert.equal(r.sensitiveAutoApply, false);
    assert.equal(r.sources.structure, "refused:no-origin");
    assert.ok(r.warnings.some((w) => /no git origin/i.test(w)), `expected a no-origin note, got: ${JSON.stringify(r.warnings)}`);
  } finally {
    cleanup(cwd, stateDir);
  }
});

// ── D (P2): the ack is bound to the WORKSPACE (ack.cwd), not just the origin fingerprint ─────────────

test("D: an ack recorded for a DIFFERENT workspace (same origin) does NOT enable this one", () => {
  const stateDir = tmpDir("cwdbind-state");
  const fpProbe = tmpDir("cwdbind-fp");
  try {
    const fp = repoFingerprint(fpProbe, { git: gitOf(ORIGIN_A) });
    const cwd = makeLocalRepo(fp);
    try {
      // Same origin fingerprint, but the ack was made in clone A (a different path).
      writeConsentAck(stateDir, { fingerprint: fp, cwd: path.join(cwd, "..", "other-worktree"), now: FIXED_CLOCK });
      const r = resolveConsents({ cwd, options: {}, stateDir, deps: { git: gitOf(ORIGIN_A) } });
      assert.equal(r.structureAutoApply, false, "a shared/migrated state dir must not cross-enable workspaces");
      assert.equal(r.acknowledged, false);
      assert.equal(r.sources.structure, "refused:no-ack");
    } finally {
      cleanup(cwd);
    }
  } finally {
    cleanup(stateDir, fpProbe);
  }
});

// ── F (P2): a stale/hostile local file must NOT block an otherwise-valid env grant ───────────────────

test("F: a fingerprint-mismatched local file does not disable a valid COUNCIL_TRUST_FIX grant (env after local)", () => {
  const stateDir = tmpDir("envafterlocal-state");
  const fpProbe = tmpDir("envafterlocal-fp");
  try {
    const fpA = repoFingerprint(fpProbe, { git: gitOf(ORIGIN_A) });
    const fpB = repoFingerprint(fpProbe, { git: gitOf(ORIGIN_B) });
    const cwd = makeLocalRepo(fpB); // local file bound to the WRONG origin (stale/hostile)
    try {
      writeConsentAck(stateDir, { fingerprint: fpA, cwd, now: FIXED_CLOCK });
      const r = resolveConsents({
        cwd,
        options: {},
        stateDir,
        deps: { git: gitOf(ORIGIN_A), env: { [CONSENT_ENV_VAR]: "1" } }
      });
      assert.equal(r.structureAutoApply, true, "env grant survives a bad local file");
      assert.equal(r.sources.structure, "env");
      assert.ok(r.warnings.some((w) => /trust_fingerprint/.test(w)), "the bad local file still warns");
    } finally {
      cleanup(cwd);
    }
  } finally {
    cleanup(stateDir, fpProbe);
  }
});

// ── B (P1): evaluateAckWrite gates the ack write on a valid channel + non-null fingerprint ───────────

test("B: evaluateAckWrite refuses with no channel, no origin, or a tracked file; allows a valid local channel", () => {
  const fpProbe = tmpDir("ackeval-fp");
  try {
    const fp = repoFingerprint(fpProbe, { git: gitOf(ORIGIN_A) });
    // (i) no origin → refused with the one-off hint.
    const noOrigin = evaluateAckWrite({ cwd: tmpDir("ae-noorigin"), deps: { git: () => null } });
    assert.equal(noOrigin.ok, false);
    assert.match(noOrigin.reason, /no git origin/i);
    // (ii) origin but NO channel (no local file, no env) → refused.
    const bare = tmpDir("ae-bare");
    const noChannel = evaluateAckWrite({ cwd: bare, deps: { git: gitOf(ORIGIN_A), env: {} } });
    assert.equal(noChannel.ok, false);
    assert.match(noChannel.reason, /no valid consent channel/i);
    // (iii) a VALID gitignored local file (matching fingerprint) → ok, channel local.
    const good = makeLocalRepo(fp);
    const okLocal = evaluateAckWrite({ cwd: good, deps: { git: gitOf(ORIGIN_A), isTracked: () => false, env: {} } });
    assert.equal(okLocal.ok, true);
    assert.equal(okLocal.channel, "local");
    // (iv) the SAME local file but git-TRACKED → refused (env absent).
    const trackedRefuse = evaluateAckWrite({ cwd: good, deps: { git: gitOf(ORIGIN_A), isTracked: () => true, env: {} } });
    assert.equal(trackedRefuse.ok, false);
    assert.match(trackedRefuse.reason, /git-tracked/);
    // (v) env channel alone → ok, channel env.
    const okEnv = evaluateAckWrite({ cwd: bare, deps: { git: gitOf(ORIGIN_A), env: { [CONSENT_ENV_VAR]: "1" } } });
    assert.equal(okEnv.ok, true);
    assert.equal(okEnv.channel, "env");
    cleanup(good, bare);
  } finally {
    cleanup(fpProbe);
  }
});

// ── E: the banner distinguishes refused:no-ack from none ─────────────────────────────────────────────

test("E: the banner shows a distinct refused:no-ack source (channel present, not acknowledged)", () => {
  const banner = formatConsentBanner(
    { structureAutoApply: false, sensitiveAutoApply: false, sources: { structure: "refused:no-ack", sensitive: null }, fingerprint: "abcdef0123456789", dryRun: false }
  );
  assert.match(banner, /structure_auto_apply=false\(refused:no-ack\)/);
  assert.match(banner, /sensitive_auto_apply=false\(none\)/);
});

// ── CLI: the banner prints to STDERR even under --json; stdout stays pure JSON ───────────────────────

const COMPANION = fileURLToPath(new URL("../plugins/council/scripts/council-companion.mjs", import.meta.url));

/** A git repo with a committed source file, a detectable test command, all seats unreachable, and an
 *  empty findings file — the cheapest substrate for a single-shot `audit fix --json` that reaches the
 *  effective-policy banner and emits a JSON object. Returns null when git is unavailable. */
function makeFixRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-consent-cli-"));
  const git = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8", timeout: 30_000 });
  if (git("init").status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
  fs.writeFileSync(path.join(dir, "index.mjs"), "export const value = 1;\n", "utf8");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "exit 0" } }), "utf8");
  fs.writeFileSync(path.join(dir, ".council.yml"), "version: 1\nreviewers: [claude]\n", "utf8");
  fs.writeFileSync(path.join(dir, "findings.json"), "[]", "utf8");
  const fakeClaude = path.join(dir, "fake-claude.cmd");
  fs.writeFileSync(fakeClaude, "@echo off\r\nexit /b 1\r\n", "utf8");
  git("add", "-A");
  if (git("-c", "user.email=t@e.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-m", "init", "--no-verify").status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
  return { dir, fakeClaude };
}

test("fix --json prints the effective-policy banner to STDERR while stdout stays pure JSON", (t) => {
  const repo = makeFixRepo();
  if (!repo) {
    t.skip("git is unavailable in this environment");
    return;
  }
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-consent-clistate-"));
  try {
    const res = spawnSync(
      process.execPath,
      [COMPANION, "fix", "--from", "findings.json", "--json"],
      { cwd: repo.dir, env: { ...process.env, AGENT_COUNCIL_STATE_DIR: stateRoot, CLAUDE_BIN: repo.fakeClaude }, encoding: "utf8", timeout: 120_000 }
    );
    if (isSandboxBlocked(res)) {
      t.skip("child_process.spawn is blocked by this sandbox");
      return;
    }
    assert.equal(res.status, 0, res.stderr);
    // stderr carries the banner (EVEN under --json — the silent-change defense).
    assert.match(res.stderr, /effective-policy \[fix\]:/);
    assert.match(res.stderr, /structure_auto_apply=false\(none\)/, "no channel ⇒ propose-only source in the banner");
    // stdout is PURE JSON — the banner never leaks into it.
    const parsed = JSON.parse(res.stdout);
    assert.equal(typeof parsed, "object");
    assert.doesNotMatch(res.stdout, /effective-policy/, "the banner must never appear on stdout");
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(repo.dir, { recursive: true, force: true });
  }
});

function isSandboxBlocked(result) {
  return Boolean(result.error) && (result.error.code === "EPERM" || result.error.code === "ENOENT");
}

/** Recursively search `dir` for any file named `consent-ack.json`. */
function ackFileExistsUnder(dir) {
  let found = false;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === CONSENT_ACK_FILE) found = true;
    }
  };
  try { walk(dir); } catch { /* absent */ }
  return found;
}

/** A git repo with a REAL origin remote + a gitignored, fingerprint-matching .council.local.yml — the
 *  substrate for the `--acknowledge-consents` (B) dry-run-safety + write contract. Returns null if git
 *  is unavailable. */
function makeAckRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-consent-ack-"));
  const git = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8", timeout: 30_000 });
  if (git("init").status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
  if (git("remote", "add", "origin", "https://github.com/test-owner/test-repo.git").status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
  const fp = repoFingerprint(dir); // real git remote in this repo
  fs.writeFileSync(path.join(dir, ".gitignore"), ".council.local.yml\n", "utf8");
  fs.writeFileSync(path.join(dir, LOCAL_CONSENT_FILE), `fix:\n  structure_auto_apply: true\n  sensitive_auto_apply: true\ntrust_fingerprint: ${fp}\n`, "utf8");
  const fakeClaude = path.join(dir, "fake-claude.cmd");
  fs.writeFileSync(fakeClaude, "@echo off\r\nexit /b 1\r\n", "utf8");
  return { dir, fakeClaude, fp };
}

test("B: `fix --acknowledge-consents --dry-run` prints the banner + WOULD-record and writes NOTHING; the real run writes", (t) => {
  const repo = makeAckRepo();
  if (!repo) {
    t.skip("git is unavailable in this environment");
    return;
  }
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-consent-ackstate-"));
  const run = (args) => spawnSync(
    process.execPath,
    [COMPANION, "fix", ...args],
    { cwd: repo.dir, env: { ...process.env, AGENT_COUNCIL_STATE_DIR: stateRoot, CLAUDE_BIN: repo.fakeClaude }, encoding: "utf8", timeout: 120_000 }
  );
  try {
    // Dry-run: banner present (unconditional, even on the ack path), print-only, NO write.
    const dry = run(["--acknowledge-consents", "--dry-run"]);
    if (isSandboxBlocked(dry)) {
      t.skip("child_process.spawn is blocked by this sandbox");
      return;
    }
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stderr, /effective-policy \[fix\]:/, "the banner must print even on the --acknowledge-consents path");
    assert.match(dry.stderr, /WOULD record/i);
    assert.equal(ackFileExistsUnder(stateRoot), false, "--dry-run must not write the ack");
    // Real run: writes the ack.
    const real = run(["--acknowledge-consents"]);
    assert.equal(real.status, 0, real.stderr);
    assert.match(real.stderr, /Recorded this workspace/i);
    assert.equal(ackFileExistsUnder(stateRoot), true, "the real ack run persists consent-ack.json");
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("B: `fix --acknowledge-consents` with NO channel refuses and writes nothing", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-consent-noack-"));
  const git = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8", timeout: 30_000 });
  if (git("init").status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    t.skip("git is unavailable in this environment");
    return;
  }
  git("remote", "add", "origin", "https://github.com/test-owner/test-repo.git");
  const fakeClaude = path.join(dir, "fake-claude.cmd");
  fs.writeFileSync(fakeClaude, "@echo off\r\nexit /b 1\r\n", "utf8");
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-consent-noackstate-"));
  try {
    const res = spawnSync(
      process.execPath,
      [COMPANION, "fix", "--acknowledge-consents"],
      { cwd: dir, env: { ...process.env, AGENT_COUNCIL_STATE_DIR: stateRoot, CLAUDE_BIN: fakeClaude }, encoding: "utf8", timeout: 120_000 }
    );
    if (isSandboxBlocked(res)) {
      t.skip("child_process.spawn is blocked by this sandbox");
      return;
    }
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /Cannot record consent acknowledgment/i);
    assert.equal(ackFileExistsUnder(stateRoot), false, "no channel ⇒ no ack pre-created");
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
