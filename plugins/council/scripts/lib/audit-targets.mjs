// Mandatory-surface discovery (docs/audit-schema.md §4). These files MUST be covered
// regardless of hotspot rank because their blast radius is high: security-sensitive
// paths, dependency manifests/lockfiles, CI/infra config, entrypoints, public exports,
// high fan-in modules, configured critical globs, and files containing security sinks.
// Pure + deterministic.

import { globToRegExp } from "./git-context.mjs";

const SECURITY_PATH = /(^|\/)(auth|authn|authz|login|session|crypto|secret|token|password|passwd|oauth|jwt|acl|permission|sanitiz|escape)/i;
const SECRET_FILE = /(^|\/)\.env(\.|$)|\.(pem|key|p12|pfx|crt)$/i;
const INFRA_FILE = /(^|\/)(\.github\/workflows\/|dockerfile|docker-compose|\.gitlab-ci|jenkinsfile|\.circleci\/|\.buildkite\/)/i;
const MANIFEST_FILE = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|go\.(mod|sum)|cargo\.(toml|lock)|pom\.xml|composer\.(json|lock)|gemfile(\.lock)?)$/i;

const SINK_MARKERS = [
  /\bchild_process\b/,
  /\bexec(File)?(Sync)?\s*\(/,
  /\beval\s*\(/,
  /new\s+Function\s*\(/,
  /\bdeserialize\b/,
  /\.innerHTML\b/,
  /\bcreateHash\b|\bcrypto\b/,
  /\b(query|execute)\s*\(\s*[`'"].*\$\{/
];

export function isSecuritySensitive(file) {
  const f = String(file ?? "");
  return SECURITY_PATH.test(f) || SECRET_FILE.test(f);
}
export function isInfra(file) {
  return INFRA_FILE.test(String(file ?? ""));
}
export function isManifest(file) {
  return MANIFEST_FILE.test(String(file ?? ""));
}
export function hasSecuritySink(source) {
  const s = String(source ?? "");
  return SINK_MARKERS.some((re) => re.test(s));
}

/**
 * Compute the mandatory coverage set. `files` = [{ id, source?, isEntrypoint?,
 * isExport?, fanIn? }]. Returns the unique ids + a reason per id (why it is mandatory).
 * Reasons are checked most-specific first so a file gets its strongest reason.
 */
export function mandatorySet(files = [], { criticalGlobs = [], highFanIn = 8 } = {}) {
  const globRes = criticalGlobs.map((g) => globToRegExp(g));
  const reasons = {};
  for (const f of files) {
    const id = f.id;
    if (id == null || reasons[id]) continue;
    let reason = null;
    if (isSecuritySensitive(id)) reason = "security-sensitive path";
    else if (isInfra(id)) reason = "CI/infra config";
    else if (isManifest(id)) reason = "dependency manifest/lockfile";
    else if (f.isEntrypoint) reason = "entrypoint";
    else if (f.isExport) reason = "public export surface";
    else if (Number.isFinite(f.fanIn) && f.fanIn >= highFanIn) reason = `high fan-in (${f.fanIn})`;
    else if (globRes.some((re) => re.test(id))) reason = "configured critical glob";
    else if (f.source && hasSecuritySink(f.source)) reason = "security sink in source";
    if (reason) reasons[id] = reason;
  }
  return { ids: Object.keys(reasons), reasons };
}
