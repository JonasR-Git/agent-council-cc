// Baseline + expiring waivers (docs/audit-schema.md §6). A baseline accepts known
// debt so re-runs surface only NEW issues; waivers accept a specific finding until an
// expiry date. P0 is never waivable. Governance is keyed by the stable semantic
// fingerprint. Pure matching + a best-effort loader from <root>/.council/.

import fs from "node:fs";
import path from "node:path";

/** Load baseline + waivers from <root>/.council/ (missing files -> empty governance). */
export function loadGovernance(root) {
  const read = (name) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, ".council", name), "utf8"));
    } catch {
      return null;
    }
  };
  const baseline = read("audit-baseline.json");
  const waivers = read("audit-waivers.json");
  const baselined = new Set(Array.isArray(baseline?.fingerprints) ? baseline.fingerprints : Array.isArray(baseline) ? baseline : []);
  const list = Array.isArray(waivers?.waivers) ? waivers.waivers : Array.isArray(waivers) ? waivers : [];
  const waiverMap = new Map();
  for (const w of list) if (w?.fingerprint) waiverMap.set(String(w.fingerprint), w);
  return { baselined, waivers: waiverMap };
}

/** A waiver applies only when it is unexpired AND the finding is not a P0 (non-waivable). */
export function isWaived(finding, waiver, nowIso) {
  if (!waiver) return false;
  if (finding.severity === "P0") return false;
  if (waiver.expires) {
    const exp = Date.parse(waiver.expires);
    const now = Date.parse(nowIso);
    if (Number.isFinite(exp) && Number.isFinite(now) && now > exp) return false; // expired -> re-surfaces as new
  }
  return true;
}

/**
 * Annotate each finding's `baseline` state ("waived" | "baselined" | "new"). Waiver
 * wins over baseline; an expired waiver or a P0 falls through to baseline/new so it is
 * NOT suppressed. Pure.
 */
export function applyGovernance(findings = [], governance = { baselined: new Set(), waivers: new Map() }, nowIso = "1970-01-01T00:00:00Z") {
  const { baselined, waivers } = governance;
  return findings.map((f) => {
    const fp = String(f.fingerprint ?? "");
    if (isWaived(f, waivers.get(fp), nowIso)) return { ...f, baseline: "waived" };
    if (baselined.has(fp)) return { ...f, baseline: "baselined" };
    return { ...f, baseline: "new" };
  });
}
