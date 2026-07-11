// SARIF 2.1.0 output (docs/audit-schema.md §6) so /council:audit results plug into
// GitHub code scanning / dashboards / SIEM. Pure: canonical findings -> SARIF log.
// Waived findings are emitted with a suppression so the sink sees them as accepted,
// not silently dropped.

const LEVEL = { P0: "error", P1: "error", P2: "warning", nit: "note" };

const toUri = (p) => { const s = String(p ?? "unknown").split(String.fromCharCode(92)).join("/"); return s.split("/").map((seg) => encodeURIComponent(seg)).join("/"); };

/**
 * Build a SARIF 2.1.0 log from canonical audit findings. Each ruleId becomes a rule
 * (deduped); each finding a result with a physical location, the audit fingerprint as
 * a partialFingerprint (stable across line moves), rich properties, and a suppression
 * when waived/baselined.
 */
export function toSarif(findings = [], { toolVersion = "0.0.0" } = {}) {
  const rules = new Map();
  const results = [];
  for (const f of findings) {
    const ruleId = String(f.ruleId ?? f.lens ?? "finding");
    if (!rules.has(ruleId)) {
      rules.set(ruleId, {
        id: ruleId,
        name: ruleId,
        properties: { lens: f.lens ?? null, standards: Array.isArray(f.standards) ? f.standards : [] }
      });
    }
    const result = {
      ruleId,
      level: LEVEL[f.severity] ?? "warning",
      message: { text: String(f.failureScenario || f.title || ruleId) },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: toUri(f.location?.path) },
            region: { startLine: Math.max(1, Number(f.location?.startLine) || 1) }
          }
        }
      ],
      properties: {
        severity: f.severity ?? null,
        lens: f.lens ?? null,
        lifecycle: f.lifecycle ?? null,
        risk: f.risk?.calibrated ?? null,
        confidence: f.confidence ?? null,
        scope: f.scope ?? null,
        standards: Array.isArray(f.standards) ? f.standards : [],
        owners: Array.isArray(f.owners) ? f.owners : []
      }
    };
    if (f.fingerprint) result.partialFingerprints = { auditFingerprint: String(f.fingerprint) };
    if (f.baseline === "waived" || f.baseline === "baselined") {
      result.suppressions = [{ kind: "external", status: "accepted" }];
    }
    results.push(result);
  }
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "council-audit",
            version: String(toolVersion),
            informationUri: "https://github.com/JonasR-Git/agent-council-cc",
            rules: [...rules.values()]
          }
        },
        results
      }
    ]
  };
}
