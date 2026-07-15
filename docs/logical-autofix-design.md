# Design v2: Fix-Eligibility von der Coverage-Lens entkoppeln (Wurzel-Fix)

Status: PROPOSAL v2 (nach Council-Deliberation council-db1efcde: v1-Symptom-Fix = request_changes).
Autor: Claude. Datum: 2026-07-16.

## Warum v1 (paralleler logical-Fixer + neuer Consent) verworfen wurde

Council-Consensus (9 Findings, 1 P0 von claude+codex+grok):
- **P0:** Der behauptete §6-Council-Patch-Review greift im Code NUR bei `sensitiveAutoApply && isSensitiveClass`
  (audit-fix.mjs:801). `category:bug`/`lens:logical_sense` sind nicht sensitive → die 248 Ziel-Bugs sähen NUR
  Test-Gate + enforceTouched. Genau der Intent-Raten-Fall.
- **P1 Split-Brain:** Consent-abhängiges scope in der PUREN `normalizeFindings` (audit-normalize.mjs:97) erzeugt
  kontextabhängige kanonische Identität — der gespeicherte scope flappt je nach schreibendem Clone/Consent.
- **P1 Consent-Leak:** `COUNCIL_TRUST_FIX=1` expandiert zu allen CONSENTS (consent.mjs:139); der Ack bindet
  nicht die Consent-Menge → `logical` würde ohne Re-Ack geerbt.
- **P1 Prädikat unzuverlässig:** Fundort ≠ Fixumfang; `verdict`/`survivor` überleben normalize/store nicht →
  2 von 4 Schutzbedingungen vakuum-wahr; `line>=1` nach normalize tautologisch (Default-Sentinel).
- **P1 Wurzel vs Symptom:** Ein dritter Consent-Pfad zementiert die Fehlklassifikation + lässt das Reporting
  weiter lügen (logical_sense/AC-DESIGN für Correctness-Bugs).

## Kern-Einsicht (Council-Konsens)

> **Coverage-Attribution und Fix-Eligibility sind getrennte Begriffe.** relens stempelt die Gruppen-Lens
> autoritativ (audit-grouped-review.mjs:275) — RICHTIG für die Coverage-Garantie, FALSCH als Fix-Klassifikation.
> Ein `category:bug` in der logical-Gruppe ist ein Correctness-Bug (categoryToLens: bug→correctness,
> audit-normalize.mjs:11), der zufällig beim logical-Review entdeckt wurde. Für die FIX-Entscheidung muss
> seine echte Natur zählen, nicht das Coverage-Label.

## Empirie (unverändert, 608 logical_sense-Findings)
248 bug · 200 test · 92 other · 42 design · 13 data-loss · 8 dead-code · 4 auth · 1 concurrency.
0 removal-class (kein Predicate-Detektor); alle aus dem LLM grouped review, group-relenst.

## Ansatz v2: Fix-Eligibility-Lens

Ein Finding trägt (mind. logisch) ZWEI Lens-Begriffe:
- **Coverage-Lens** (`lens`, group-stamped) — Reporting + Tier-Coverage-Garantie. UNVERÄNDERT logical_sense.
- **Fix-Eligibility-Lens** — steuert scope/fixDisposition + Fix-Tier. Ableitung (rein, kontextfrei,
  KEIN Consent — deterministisch):
  `fixLens = categoryToLens(category)` GDW ALLE:
  1. die Coverage-Lens ist propose-only (logical_sense/architecture_ssot),
  2. `categoryToLens(category)` ist NICHT propose-only (bug/correctness/security/data/concurrency/perf/reliability…),
  3. `raw.scope !== "cross-cutting"` (bestehendes cross-cutting-Signal ist VETO — Council P1),
  4. keine Cross-Cutting-Hints im title/detail (scope.mjs CROSS_CUTTING_HINTS — Council P1),
  5. kein removal-verdict (remove/merge-into/redesign/relocate) und kein `survivor` (auf raw, VOR Store-Verlust).
  Sonst `fixLens = lens` (bleibt propose-only). scope/fixDisposition werden aus `fixLens` abgeleitet.

### Auto-Fix-Eligibility (zusätzliche Gates — Council P1)
- **Multi-Seat-Consensus PFLICHT:** nur `consensus==="consensus"` (≥2 Seats) ODER adversarial-verifiziert
  ist auto-eligible; single/contested → propose-only. (Genau der Consensus, den der Grok-Dedup-Pass etabliert.)
- **Category-Allowlist eng:** nur klar mechanische Klassen (bug/correctness/data-loss/concurrency/security/
  reliability/performance). `other`(92)/`design`(42) NICHT auto-eligible (bleiben Proposal).
- **Test-Pfade:** `location.path` unter Test-Pfaden bleibt propose-only (PROTECTED_RE greift schon,
  audit-fix.mjs:78 — Defense-in-depth; `category:test` auf Nicht-Test-Pfaden konservativ Proposal).

## Umsetzungsvarianten (offene Frage → per Coverage-Untersuchung entschieden)
- **Option 1 (getrennte `fixLens`-Feld):** `lens` bleibt logical_sense; neues Feld `fixLens` steuert
  scope + Fix-Tier. Coverage-Garantie sicher unberührt. Invasiver (fixLens durch Tier-Filter/classifyFixable).
- **Option 2 (relens behält correctness):** relens stempelt die Gruppen-Lens nicht, wenn category klar
  fixbar → Finding trägt lens=correctness. Einfacher, ABER: nur sicher, WENN die Coverage an das gelaufene
  (cell,tier)-Review gebunden ist, NICHT an die Finding-Lens. → wird gerade untersucht.

## Änderungspunkte (fix-time Eligibility, NICHT pure Identität)
- `audit-normalize.mjs` — `fixLens`/scope-Ableitung als reine Funktion `fixEligibilityLens(raw, coverageLens)`.
  KEINE Consent-Abhängigkeit hier (Consent bleibt fix-time).
- `audit-findings-store.mjs:121` — fixLens/scope konsistent persistieren (kein Roundtrip-Verlust).
- `audit-fixloop.mjs` — Tier-Zuordnung + runtimeFixable/autoFixable nutzen fixLens; Consensus-Gate.
- `audit-fix.mjs:149` — `ineligibleReason`: fail-closed Consensus-Check + fixLens-basierte Eligibility;
  der Writer prüft die Eligibility an der letzten Mutationsgrenze (Council codex-unique P1).

## Schutz-Stack (bestehend, greift automatisch weil es der NORMALE correctness-Pfad ist)
Test-Gate + enforceTouched (single-file) + §6-Council-Patch-Review (für sensitive) + protected paths +
Severity-Floor + Multi-Seat-Consensus-Pflicht + revert-bei-rot. KEIN neuer Consent, KEIN Parallelpfad.
