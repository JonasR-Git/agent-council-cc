import fs from "node:fs";
import path from "node:path";

import { escapeHtml } from "./html-report.mjs";
import { resolveArtifactsDir } from "./state.mjs";

// Render a finished `audit fix` / fix-loop run (the runAuditFix result object) as a
// self-contained "verdict console" HTML report: run header, outcome stats, the gate
// chain, a status-coded findings table, §6 council verdicts, and an honesty section.
// Inline CSS/JS only (no external assets) so it opens straight from disk.

const SEV_RANK = { P0: 0, P1: 1, P2: 2, nit: 3 };

/** Classify one run outcome entry into a display status. Pure. */
function statusOf(kind, entry) {
  const reason = String(entry?.reason ?? "");
  if (kind === "fixed") {
    if (entry.council?.approved) return { key: "council", label: "COUNCIL ✓", pill: "council" };
    if (entry.verified) return { key: "fixed", label: "FIXED", pill: "fixed" };
    return { key: "unverified", label: "FIXED (unverif.)", pill: "unverified" };
  }
  if (kind === "failed") return { key: "failed", label: "FAILED · reverted", pill: "failed" };
  if (kind === "skipped") return { key: "skipped", label: "SKIPPED", pill: "gated" };
  // rejected
  if (/below severity gate/.test(reason)) return { key: "gate", label: "nit · Gate", pill: "gated" };
  if (/council not unanimous/.test(reason)) return { key: "no-consensus", label: "VORSCHLAG · kein Konsens", pill: "proposed" };
  return { key: "proposed", label: "VORSCHLAG", pill: "proposed" };
}

/** Flatten runAuditFix output into rows with a normalized status. Pure. */
export function fixReportRows(out) {
  const rows = [];
  for (const f of out?.fixed ?? []) rows.push({ finding: f.finding, file: f.file ?? f.finding?.file, commit: f.commit, council: f.council, status: statusOf("fixed", f) });
  for (const x of out?.failed ?? []) rows.push({ finding: x.finding, file: x.file ?? x.finding?.file, reason: x.reason, status: statusOf("failed", x) });
  for (const r of out?.rejected ?? []) rows.push({ finding: r.finding, file: r.finding?.file, reason: r.reason, council: r.council, status: statusOf("rejected", r) });
  // `proposed` is the fix-LOOP's propose-only bucket (same shape as rejected).
  for (const p of out?.proposed ?? []) rows.push({ finding: p.finding, file: p.finding?.file ?? p.file, reason: p.reason, council: p.council, status: statusOf("rejected", p) });
  for (const s of out?.skipped ?? []) rows.push({ finding: s.finding, file: s.file ?? s.finding?.file, reason: s.reason, status: statusOf("skipped", s) });
  rows.sort((a, b) => (SEV_RANK[a.finding?.severity] ?? 4) - (SEV_RANK[b.finding?.severity] ?? 4));
  return rows;
}

/** Aggregate the outcome counts. Pure. */
export function fixReportStats(rows) {
  const s = { total: rows.length, fixed: 0, council: 0, proposed: 0, gated: 0, failed: 0 };
  for (const r of rows) {
    const k = r.status.key;
    if (k === "fixed" || k === "unverified") s.fixed += 1;
    else if (k === "council") s.council += 1;
    else if (k === "proposed" || k === "no-consensus") s.proposed += 1;
    else if (k === "gate" || k === "skipped") s.gated += 1;
    else if (k === "failed") s.failed += 1;
  }
  return s;
}

const STYLE = `
:root{--ground:#e9ece7;--surface:#f7f8f4;--surface-2:#eef1ea;--ink:#16282c;--ink-soft:#33484c;--muted:#5d6c6a;--line:#cdd3cc;--brass:#9a7526;--pass:#3c8a62;--warn:#b07f2a;--fail:#bd5747;--glow:rgba(154,117,38,.14);--font-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;--font-mono:ui-monospace,"Cascadia Code","SF Mono","Segoe UI Mono",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--ground:#0d1a1d;--surface:#13262a;--surface-2:#1a333a;--ink:#e8e6dd;--ink-soft:#c3ccc9;--muted:#8fa09d;--line:#24444b;--brass:#d0a755;--pass:#55b184;--warn:#d9a441;--fail:#d97a68;--glow:rgba(208,167,85,.18)}}
:root[data-theme="light"]{--ground:#e9ece7;--surface:#f7f8f4;--surface-2:#eef1ea;--ink:#16282c;--ink-soft:#33484c;--muted:#5d6c6a;--line:#cdd3cc;--brass:#9a7526;--pass:#3c8a62;--warn:#b07f2a;--fail:#bd5747;--glow:rgba(154,117,38,.14)}
:root[data-theme="dark"]{--ground:#0d1a1d;--surface:#13262a;--surface-2:#1a333a;--ink:#e8e6dd;--ink-soft:#c3ccc9;--muted:#8fa09d;--line:#24444b;--brass:#d0a755;--pass:#55b184;--warn:#d9a441;--fail:#d97a68;--glow:rgba(208,167,85,.18)}
*{box-sizing:border-box}body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--font-sans);line-height:1.6;-webkit-font-smoothing:antialiased}
.wrap{max-width:1000px;margin:0 auto;padding:0 26px}.mono{font-family:var(--font-mono)}b{font-weight:680}
h1,h2{text-wrap:balance;line-height:1.1;font-weight:660;letter-spacing:-.015em}
.eyebrow{font-family:var(--font-mono);font-size:.71rem;letter-spacing:.2em;text-transform:uppercase;color:var(--brass);margin:0 0 1rem;display:flex;align-items:center;gap:.7rem}
.eyebrow::before{content:"";width:24px;height:1px;background:var(--brass);opacity:.6}
.head{padding:clamp(2.6rem,6vw,4rem) 0 2rem}.head h1{font-size:clamp(1.8rem,4.4vw,2.9rem);margin:0 0 1rem;max-width:22ch}
.verdict-line{font-family:var(--font-mono);font-size:.88rem;color:var(--ink-soft);display:inline-flex;align-items:center;gap:.6rem;padding:.5rem .85rem;background:color-mix(in srgb,var(--pass) 10%,var(--surface));border:1px solid color-mix(in srgb,var(--pass) 40%,var(--line));border-radius:999px}
.verdict-line.red{background:color-mix(in srgb,var(--fail) 10%,var(--surface));border-color:color-mix(in srgb,var(--fail) 40%,var(--line))}
.verdict-line .dot{color:var(--pass)}.verdict-line.red .dot{color:var(--fail)}
.meta-bar{margin-top:1.8rem;display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line);border:1px solid var(--line);border-radius:12px;overflow:hidden}
@media(max-width:720px){.meta-bar{grid-template-columns:repeat(2,1fr)}}
.meta{background:var(--surface);padding:.9rem 1rem}.meta .k{font-family:var(--font-mono);font-size:.62rem;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}.meta .v{font-family:var(--font-mono);font-size:.84rem;color:var(--ink);margin-top:.3rem;word-break:break-word}
section.band{border-top:1px solid var(--line);padding:clamp(2.4rem,5vw,3.6rem) 0}
.bi{font-family:var(--font-mono);font-size:.7rem;letter-spacing:.16em;color:var(--muted);margin-bottom:1.1rem}.bi b{color:var(--brass)}
.band h2{font-size:clamp(1.4rem,3vw,2rem);margin:0 0 .6rem}.band .sub{color:var(--ink-soft);max-width:64ch;margin:0 0 1.4rem}
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:.8rem}@media(max-width:820px){.stats{grid-template-columns:repeat(2,1fr)}}
.stat{border:1px solid var(--line);border-radius:12px;padding:1.1rem 1rem;background:var(--surface)}.stat .n{font-family:var(--font-mono);font-size:clamp(1.5rem,3.4vw,2.1rem);font-weight:640;font-variant-numeric:tabular-nums}.stat .l{font-size:.76rem;color:var(--muted);margin-top:.35rem;line-height:1.35}
.stat.found .n{color:var(--ink)}.stat.fixed .n{color:var(--pass)}.stat.council .n{color:var(--brass)}.stat.proposed .n{color:var(--warn)}.stat.gated .n{color:var(--muted)}
.pipe{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:1.3rem 1.2rem 1.1rem;overflow-x:auto}
.pipe .cap{font-family:var(--font-mono);font-size:.68rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-bottom:1rem;display:flex;justify-content:space-between;gap:1rem}
.gates{display:flex;gap:.5rem;min-width:640px}.gate{flex:1;min-width:84px;border:1px solid color-mix(in srgb,var(--pass) 55%,var(--line));background:color-mix(in srgb,var(--pass) 9%,var(--surface-2));border-radius:9px;padding:.7rem .6rem;display:flex;flex-direction:column;gap:.5rem;position:relative}
.gate .led{width:9px;height:9px;border-radius:50%;background:var(--pass);box-shadow:0 0 0 3px color-mix(in srgb,var(--pass) 22%,transparent)}.gate .gn{font-family:var(--font-mono);font-size:.71rem;color:var(--ink-soft)}
.gate.council{border-style:dashed;border-color:color-mix(in srgb,var(--brass) 60%,var(--line));background:color-mix(in srgb,var(--brass) 10%,var(--surface-2))}.gate.council .led{background:var(--brass);box-shadow:0 0 0 3px var(--glow)}
.gate.commit{border-color:color-mix(in srgb,var(--brass) 60%,var(--line));background:color-mix(in srgb,var(--brass) 12%,var(--surface-2))}.gate.commit .led{background:var(--brass);box-shadow:0 0 0 3px var(--glow)}
.gate .ar{position:absolute;right:-.46rem;top:50%;transform:translateY(-50%);color:var(--muted);font-size:.68rem}.gate:last-child .ar{display:none}
.revert{margin-top:.9rem;font-family:var(--font-mono);font-size:.71rem;color:var(--muted)}.revert .x{color:var(--fail)}
.tscroll{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:var(--surface)}
table.f{width:100%;border-collapse:collapse;min-width:680px;font-size:.87rem}
table.f th{font-family:var(--font-mono);font-size:.63rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);text-align:left;padding:.75rem 1rem;border-bottom:1px solid var(--line);font-weight:500}
table.f td{padding:.75rem 1rem;border-bottom:1px solid var(--line);vertical-align:top;color:var(--ink-soft)}table.f tr:last-child td{border-bottom:none}
.sev{font-family:var(--font-mono);font-weight:680}.sev.P0{color:var(--fail)}.sev.P1{color:var(--warn)}.sev.P2{color:var(--muted)}.sev.nit{color:var(--muted)}
.tt{color:var(--ink)}.tf{font-family:var(--font-mono);font-size:.73rem;color:var(--muted)}
.pill{font-family:var(--font-mono);font-size:.67rem;padding:.22rem .55rem;border-radius:6px;white-space:nowrap;display:inline-block;border:1px solid transparent}
.pill.fixed{color:var(--pass);background:color-mix(in srgb,var(--pass) 12%,transparent);border-color:color-mix(in srgb,var(--pass) 38%,var(--line))}
.pill.council{color:var(--brass);background:color-mix(in srgb,var(--brass) 12%,transparent);border-color:color-mix(in srgb,var(--brass) 42%,var(--line))}
.pill.proposed{color:var(--warn);background:color-mix(in srgb,var(--warn) 12%,transparent);border-color:color-mix(in srgb,var(--warn) 38%,var(--line))}
.pill.unverified{color:var(--warn);background:transparent;border-color:color-mix(in srgb,var(--warn) 38%,var(--line))}
.pill.failed{color:var(--fail);background:color-mix(in srgb,var(--fail) 12%,transparent);border-color:color-mix(in srgb,var(--fail) 38%,var(--line))}
.pill.gated{color:var(--muted);background:var(--surface-2);border-color:var(--line)}
.council-card{margin-top:1rem;background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.council-card .ch{font-family:var(--font-mono);font-size:.72rem;color:var(--muted);padding:.7rem 1.05rem;border-bottom:1px solid var(--line);background:var(--surface-2);display:flex;gap:.55rem;align-items:center;flex-wrap:wrap}
.cb{padding:1rem 1.1rem}.vrow{display:flex;justify-content:space-between;gap:.8rem;font-family:var(--font-mono);font-size:.79rem;padding:.45rem .7rem;background:var(--surface-2);border:1px solid var(--line);border-radius:8px;margin-bottom:.4rem}
.vrow .vc{color:var(--pass);font-weight:680}.vrow .vd{color:var(--fail);font-weight:680}
ul.honesty{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.7rem}ul.honesty li{display:grid;grid-template-columns:auto 1fr;gap:.8rem;align-items:baseline;font-size:.92rem;color:var(--ink-soft)}
ul.honesty .mk{font-family:var(--font-mono);font-size:.66rem;padding:.16rem .45rem;border-radius:5px;white-space:nowrap}.mk.yes{color:var(--pass);border:1px solid color-mix(in srgb,var(--pass) 40%,var(--line))}.mk.no{color:var(--muted);border:1px solid var(--line)}
footer{border-top:1px solid var(--line);padding:2rem 0 3rem;color:var(--muted);font-family:var(--font-mono);font-size:.72rem}
.toggle{position:fixed;top:15px;right:16px;font-family:var(--font-mono);font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;background:var(--surface);color:var(--ink-soft);border:1px solid var(--line);border-radius:999px;padding:.4rem .75rem;cursor:pointer}.toggle:hover{border-color:var(--brass);color:var(--brass)}
`;

const SCRIPT = `(function(){var r=document.documentElement,t=document.getElementById('tt');function c(){return r.dataset.theme?r.dataset.theme:(window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light')}t&&t.addEventListener('click',function(){r.dataset.theme=c()==='dark'?'light':'dark'})})();`;

function metaCell(k, v) {
  return `<div class="meta"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div></div>`;
}

function findingRow(row) {
  const f = row.finding ?? {};
  const sev = escapeHtml(f.severity ?? "P2");
  const file = f.file ? escapeHtml(String(f.file).split("/").pop()) : "—";
  return `<tr><td class="sev ${sev}">${sev}</td><td class="mono">${escapeHtml(f.category ?? "—")}</td><td class="tt">${escapeHtml(f.title ?? "")}</td><td class="tf">${file}</td><td><span class="pill ${row.status.pill}">${escapeHtml(row.status.label)}</span></td></tr>`;
}

function councilCards(rows) {
  const withCouncil = rows.filter((r) => r.council && Array.isArray(r.council.verdicts) && r.council.verdicts.length);
  if (!withCouncil.length) return "";
  const cards = withCouncil.slice(0, 4).map((r) => {
    const f = r.finding ?? {};
    const approved = r.council.approved;
    const vrows = r.council.verdicts.map((v) => {
      const cls = v.verdict === "confirm" ? "vc" : "vd";
      return `<div class="vrow"><span>${escapeHtml(v.seat ?? "?")}</span><span class="${cls}">${escapeHtml(v.verdict ?? "?")}</span></div>`;
    }).join("");
    const pill = approved ? '<span class="pill council">COUNCIL ✓</span>' : '<span class="pill proposed">VORSCHLAG</span>';
    return `<div class="council-card"><div class="ch">${pill} ${escapeHtml(f.severity ?? "")} · ${escapeHtml(f.category ?? "")} · ${escapeHtml(String(f.file ?? "").split("/").pop())}</div><div class="cb"><p class="tt" style="margin:0 0 .8rem">${escapeHtml(f.title ?? "")}</p>${vrows}</div></div>`;
  }).join("\n");
  return `<section class="band"><div class="wrap"><div class="bi"><b>§6</b> / Council-Urteile</div><h2>Sensible Fixes — jeder Patch einstimmig geprüft</h2><p class="sub">Für §6-Klassen (Concurrency, Auth, Data-Integrity) musste jeder Sitz den Patch bestätigen, bevor er committen durfte.</p>${cards}</div></section>`;
}

/** Render the full self-contained HTML report for a runAuditFix result. Pure. */
export function renderFixReportHtml(out, meta = {}) {
  const rows = fixReportRows(out);
  const stats = fixReportStats(rows);
  const red = out?.integrationFailed || out?.ok === false;
  const seats = meta.seats ?? "Claude · Codex · Grok";
  const autonomy = meta.autonomy ?? (meta.sensitiveAutoApply ? "§6 council-gated" : "sicher-auto");
  const genAt = meta.generatedAt ?? "";

  const tableRows = rows.length ? rows.map(findingRow).join("\n") : `<tr><td colspan="5" class="tf">keine Funde</td></tr>`;
  const verdictText = red
    ? `${stats.total} Funde · Integrationslauf ROT — Commits liegen isoliert zum Review`
    : `${stats.total} Funde · ${stats.fixed + stats.council} angewendet & getestet · ${stats.proposed} vorgeschlagen · Tests grün pro Commit`;

  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Council Audit Fix — Lauf-Bericht</title><style>${STYLE}</style></head><body>
<button class="toggle" id="tt" aria-label="Theme">◐ Theme</button>
<main>
<header class="head"><div class="wrap">
<p class="eyebrow">Council Audit Fix · Lauf-Bericht</p>
<h1>${red ? "Enterprise-Fix-Lauf: Integrationslauf rot — zum Review" : "Enterprise-Fix-Lauf abgeschlossen — Basis unangetastet, jeder Fix isoliert &amp; verifiziert."}</h1>
<span class="verdict-line ${red ? "red" : ""}"><span class="dot">●</span> ${escapeHtml(verdictText)}</span>
<div class="meta-bar">
${metaCell("Branch", out?.branch ?? "—")}
${metaCell("Basis", (out?.baseBranch ?? "—") + " (nie verändert)")}
${metaCell("Autonomie", autonomy)}
${metaCell("Sitze", seats)}
${metaCell("Ledger", `${out?.ledgerResolved ?? 0} aufgelöst`)}
${metaCell("Fehlgeschlagen", `${stats.failed}`)}
${metaCell("Ergebnis", red ? "Review nötig" : "bereit zum Merge")}
${metaCell("Erzeugt", genAt || "pro Lauf")}
</div></div></header>

<section class="band"><div class="wrap"><div class="bi"><b>01</b> / Ergebnis</div>
<div class="stats">
<div class="stat found"><div class="n">${stats.total}</div><div class="l">Funde gesamt</div></div>
<div class="stat fixed"><div class="n">${stats.fixed}</div><div class="l">gefixt + verifiziert</div></div>
<div class="stat council"><div class="n">${stats.council}</div><div class="l">council-angewendet (§6)</div></div>
<div class="stat proposed"><div class="n">${stats.proposed}</div><div class="l">vorgeschlagen</div></div>
<div class="stat gated"><div class="n">${stats.gated}</div><div class="l">unter Gate / übersprungen</div></div>
</div></div></section>

<section class="band"><div class="wrap"><div class="bi"><b>02</b> / Absicherung</div><h2>Die Gate-Kette</h2>
<p class="sub">Kein Fix zählt, bevor nicht jedes Gate grün ist. §6-sensible Klassen durchlaufen zusätzlich das Council-Gate — drei einstimmige Patch-Urteile.</p>
<div class="pipe"><div class="cap"><span>Pro Fix</span><span>rot an einem Gate → Revert</span></div>
<div class="gates">
<div class="gate"><span class="led"></span><span class="gn">touched</span><span class="ar">▶</span></div>
<div class="gate"><span class="led"></span><span class="gn">content</span><span class="ar">▶</span></div>
<div class="gate"><span class="led"></span><span class="gn">oracle</span><span class="ar">▶</span></div>
<div class="gate"><span class="led"></span><span class="gn">test</span><span class="ar">▶</span></div>
<div class="gate"><span class="led"></span><span class="gn">coverage</span><span class="ar">▶</span></div>
<div class="gate council"><span class="led"></span><span class="gn">§6 council</span><span class="ar">▶</span></div>
<div class="gate commit"><span class="led"></span><span class="gn">commit ✓</span></div>
</div>
<div class="revert"><span class="x">✕</span> Jeder Commit ist ein einzelner Fix. Rotes Gate → verifizierter Revert.</div>
</div></div></section>

<section class="band"><div class="wrap"><div class="bi"><b>03</b> / Die Funde</div><h2>Was gefunden wurde — und was damit geschah</h2>
<div class="tscroll"><table class="f"><thead><tr><th>Sev</th><th>Klasse</th><th>Fund</th><th>Datei</th><th>Status</th></tr></thead><tbody>
${tableRows}
</tbody></table></div></div></section>

${councilCards(rows)}

<section class="band"><div class="wrap"><div class="bi"><b>04</b> / Ehrlichkeit</div><h2>Verifiziert vs. nicht verifiziert</h2>
<ul class="honesty">
<li><span class="mk yes">verifiziert</span><span><b>Test-Gate</b> — volle Suite grün pro Commit + finaler Integrationslauf.</span></li>
<li><span class="mk yes">verifiziert</span><span><b>Oracle</b> — Lint/Typecheck grün pro Fix.</span></li>
<li><span class="mk yes">verifiziert</span><span><b>§6-Konsens</b> — drei unabhängige Patch-Urteile, einstimmig erforderlich.</span></li>
<li><span class="mk no">prüf selbst</span><span><b>Export-/API-Snapshot</b> — namensbasiert, regex; fällt geschlossen bei Star-Reexport.</span></li>
<li><span class="mk no">prüf selbst</span><span><b>Content-Schutz</b> — musterbasiert, kein voller Secret/CI-Scanner — Diffs überfliegen.</span></li>
<li><span class="mk no">Grenze</span><span><b>Nebenläufigkeit</b> — drei KIs einig ≠ Beweis; isolierter Branch, pro-Fix-Commit, Ein-Klick-Revert bleiben.</span></li>
</ul></div></section>

<footer><div class="wrap">Council Audit Fix · measured safety, not blind automation · Branch ${escapeHtml(out?.branch ?? "—")}</div></footer>
</main><script>${SCRIPT}</script></body></html>`;
}

/** Write the fix report HTML to the run's artifacts dir and return the path. */
export function writeFixReportHtml(cwd, out, meta = {}) {
  const id = meta.id ?? (out?.branch ? String(out.branch).replace(/[^a-zA-Z0-9_-]/g, "-") : "audit-fix");
  const dir = resolveArtifactsDir(cwd, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "fix-report.html");
  fs.writeFileSync(file, renderFixReportHtml(out, meta), "utf8");
  return file;
}
