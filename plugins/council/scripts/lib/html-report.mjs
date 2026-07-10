import fs from "node:fs";
import path from "node:path";

import { resolveArtifactsDir } from "./state.mjs";

/**
 * Render a finished council job (deliberate/solve/review) as a self-contained
 * HTML file: verdict header, sortable/colour-coded findings table (or solve
 * ranking), and the full markdown report in a collapsed block. No external
 * assets — inline CSS/JS only, so it opens straight from disk.
 */

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const MAX_EMBEDDED_REPORT_CHARS = 200_000;

function clipReport(text) {
  const t = String(text ?? "");
  return t.length > MAX_EMBEDDED_REPORT_CHARS
    ? `${t.slice(0, MAX_EMBEDDED_REPORT_CHARS)}\n\n[... report truncated; full report on disk ...]`
    : t;
}

const SEVERITY_COLORS = {
  P0: "#b3261e",
  P1: "#c8641b",
  P2: "#8a7d1e",
  nit: "#5f6368"
};

function findingsRows(merged) {
  const all = merged?.all ?? [];
  if (!all.length) return "";
  return all
    .map((f) => {
      const color = SEVERITY_COLORS[f.severity] ?? "#5f6368";
      const loc = f.file ? `${escapeHtml(f.file)}${f.line != null ? `:${f.line}` : ""}` : "—";
      const agents = escapeHtml((f.agents ?? []).join("+"));
      const badges = [
        f.consensus ? '<span class="badge consensus">consensus</span>' : "",
        f.needsConsensus ? '<span class="badge policy">policy</span>' : "",
        f.contested ? '<span class="badge contested">contested</span>' : "",
        f.seenBefore && f.timesSeen > 1 ? `<span class="badge seen">seen ${f.timesSeen}x</span>` : ""
      ].join("");
      const sevRank = { P0: 0, P1: 1, P2: 2, nit: 3 }[f.severity] ?? 4;
      return `<tr data-sev="${sevRank}" data-consensus="${f.consensus ? 1 : 0}">
  <td><span class="sev" style="background:${color}">${escapeHtml(f.severity)}</span></td>
  <td>${agents}</td>
  <td><div class="title">${escapeHtml(f.title)}</div><div class="detail">${escapeHtml(f.detail ?? "")}</div>${badges}</td>
  <td class="loc">${loc}</td>
</tr>`;
    })
    .join("\n");
}

function verdictsBlock(verdicts) {
  if (!verdicts?.length) return "";
  const cls = (v) => (/approve/.test(v) ? "ok" : /block|request/.test(v) ? "bad" : "mid");
  const chips = verdicts
    .map((v) => `<span class="verdict ${cls(v.verdict)}">${escapeHtml(v.agent)}: ${escapeHtml(v.verdict)}</span>`)
    .join(" ");
  return `<div class="verdicts">${chips}</div>`;
}

function rankingBlock(ranking) {
  if (!ranking?.length) return "";
  const rows = ranking
    .map(
      (r, i) =>
        `<tr><td>${i + 1}</td><td>${escapeHtml(r.agent)}</td><td>${r.avgOverall ?? r.avgScore ?? "—"}</td><td>${r.votes ?? 0}</td><td>${(r.blockers ?? []).length}</td></tr>`
    )
    .join("\n");
  return `<h2>Ranking</h2><table class="rank"><thead><tr><th>#</th><th>agent</th><th>score</th><th>votes</th><th>blockers</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function renderJobHtml(job) {
  const merged = job.deliberation?.merged ?? null;
  const ranking = job.solve?.ranking ?? null;
  const verdicts = job.deliberation?.verdicts ?? [];
  const consensus = merged?.consensus?.length ?? 0;
  const unique = merged?.unique?.length ?? 0;

  const title = `${escapeHtml(job.title ?? "Council")} — ${escapeHtml(job.id ?? "")}`;
  const findingsTable = merged
    ? `<h2>Findings <span class="muted">(${consensus} consensus · ${unique} unique)</span></h2>
<div class="controls"><button onclick="sortBy('sev')">sort by severity</button> <button onclick="sortBy('consensus')">consensus first</button></div>
<table class="findings" id="findings"><thead><tr><th>sev</th><th>agents</th><th>finding</th><th>location</th></tr></thead>
<tbody>${findingsRows(merged)}</tbody></table>`
    : "";

  const style = `
:root{color-scheme:light dark}
body{font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:24px;max-width:1100px;margin:0 auto;
  background:#fff;color:#1a1a1a}
@media(prefers-color-scheme:dark){body{background:#161616;color:#e8e8e8}
  table{border-color:#333}th{background:#222}td{border-color:#2a2a2a}.detail{color:#aaa}pre{background:#111}}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px}
.muted{color:#888;font-weight:400;font-size:13px}
.verdicts{margin:8px 0}.verdict{display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;margin-right:6px}
.verdict.ok{background:#1e8e3e;color:#fff}.verdict.bad{background:#b3261e;color:#fff}.verdict.mid{background:#8a7d1e;color:#fff}
table{border-collapse:collapse;width:100%;border:1px solid #ddd;margin:4px 0}
th,td{border:1px solid #e0e0e0;padding:6px 9px;text-align:left;vertical-align:top}
th{background:#f4f4f4;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
.sev{display:inline-block;color:#fff;padding:1px 7px;border-radius:4px;font-weight:600;font-size:12px}
.title{font-weight:600}.detail{color:#555;font-size:13px;margin-top:2px}.loc{font-family:ui-monospace,monospace;font-size:12px}
.badge{display:inline-block;font-size:11px;padding:1px 6px;border-radius:8px;margin:4px 4px 0 0;background:#e8eaed;color:#333}
.badge.consensus{background:#1e8e3e;color:#fff}.badge.policy{background:#8a7d1e;color:#fff}
.badge.contested{background:#b3261e;color:#fff}.badge.seen{background:#3367d6;color:#fff}
.controls{margin:4px 0}button{font:inherit;padding:3px 10px;border:1px solid #ccc;border-radius:6px;background:#f6f6f6;cursor:pointer}
details{margin-top:24px}summary{cursor:pointer;font-weight:600}
pre{background:#f6f6f6;padding:12px;border-radius:8px;overflow:auto;font-size:12px;white-space:pre-wrap}
`;

  const script = `
function sortBy(key){
  const tb=document.querySelector('#findings tbody');if(!tb)return;
  const rows=[...tb.rows];
  rows.sort((a,b)=>key==='consensus'
    ?(b.dataset.consensus-a.dataset.consensus)||(a.dataset.sev-b.dataset.sev)
    :(a.dataset.sev-b.dataset.sev));
  rows.forEach(r=>tb.appendChild(r));
}
`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${style}</style></head><body>
<h1>${title}</h1>
<div class="muted">${escapeHtml(job.kind ?? "")} · ${escapeHtml(job.status ?? "")} · ${escapeHtml(job.summary ?? "")}</div>
${verdictsBlock(verdicts)}
${findingsTable}
${rankingBlock(ranking)}
<details><summary>Full report (markdown)</summary><pre>${escapeHtml(clipReport(job.report ?? job.output ?? "(none)"))}</pre></details>
<script>${script}</script>
</body></html>`;
}

/** Write the HTML report to the job's artifacts dir and return the path. */
export function writeJobHtml(cwd, job) {
  const dir = resolveArtifactsDir(cwd, job.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "report.html");
  fs.writeFileSync(file, renderJobHtml(job), "utf8");
  return file;
}
