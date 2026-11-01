// REPORT.html renderer: one self-contained page, every value escaped.
import type { Finding } from "./types.ts";
import type { Ctx } from "./report-ctx.ts";
import { correctionText, counts, isStale, panel, uncoveredDimensions, verificationIncomplete } from "./report-ctx.ts";
import { diagrams } from "./report-arch.ts";

export function esc(v: unknown): string {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const MERMAID = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs";

const CSS = `
:root{--bg:#fbfaf8;--fg:#1d1d1b;--muted:#6b6a66;--card:#ffffff;--line:#e3e1dc;--accent:#b4532a;--crit:#b42318;--high:#c4520f;--med:#a37a00;--low:#4a6fa5;--ok:#2f7d4f;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#171716;--fg:#e8e6e1;--muted:#a3a19b;--card:#211f1d;--line:#36332f;--accent:#e08a5c;--crit:#f97066;--high:#f79009;--med:#eaaa08;--low:#84adff;--ok:#47cd89;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#171716;--fg:#e8e6e1;--muted:#a3a19b;--card:#211f1d;--line:#36332f;--accent:#e08a5c;--crit:#f97066;--high:#f79009;--med:#eaaa08;--low:#84adff;--ok:#47cd89;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}h1{font-size:1.6rem;margin:.2rem 0 1rem}h2{font-size:1.15rem;margin:2rem 0 .6rem;border-bottom:1px solid var(--line);padding-bottom:.3rem}
.muted{color:var(--muted)}.banner{border:1px solid var(--crit);color:var(--crit);border-radius:8px;padding:.6rem .8rem;margin:.6rem 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.7rem .8rem}
.tile b{display:block;font-size:1.5rem;font-variant-numeric:tabular-nums}.tile span{color:var(--muted);font-size:.85rem}
.wrap{overflow-x:auto;max-width:100%}table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{border-bottom:1px solid var(--line);padding:.35rem .5rem;text-align:left;vertical-align:top;overflow-wrap:anywhere}
th{color:var(--muted);font-weight:600}code{color:var(--accent);overflow-wrap:anywhere}
.sev{font-weight:600}.sev-Blocker,.sev-Critical{color:var(--crit)}.sev-High{color:var(--high)}.sev-Medium{color:var(--med)}.sev-Low,.sev-Nit{color:var(--low)}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin:.5rem 0}select{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:.25rem .4rem}
pre.mermaid{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.8rem;overflow-x:auto;font-size:.8rem}
`;

const JS = `
(function(){var f=document.querySelectorAll('[data-filter]');function apply(){var s={};f.forEach(function(x){s[x.dataset.filter]=x.value});
document.querySelectorAll('#findings tbody tr').forEach(function(r){var show=true;for(var k in s){if(s[k]&&r.dataset[k]!==s[k])show=false}r.hidden=!show})}
f.forEach(function(x){x.addEventListener('change',apply)})})();
`;

function tile(label: string, n: unknown): string {
  return `<div class="tile"><b>${esc(n)}</b><span>${esc(label)}</span></div>`;
}

function select(name: string, values: string[]): string {
  const opts = [...new Set(values)].sort().map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
  return `<label>${esc(name)} <select data-filter="${esc(name)}"><option value="">all</option>${opts}</select></label>`;
}

function row(f: Finding): string {
  const verdict = f.accepted ? "accepted" : f.verdict ?? "pending";
  return `<tr data-dimension="${esc(f.dimension)}" data-severity="${esc(f.severity)}" data-verdict="${esc(verdict)}">` +
    `<td><code>${esc(f.id)}</code></td><td>${esc(f.dimension)}</td><td class="sev sev-${esc(f.severity)}">${esc(f.severity)}</td>` +
    `<td>${esc(f.confidence)}</td><td>${esc(verdict)}${f.votes?.length ? ` (${esc(panel(f))})` : ""}</td>` +
    `<td><code>${esc(f.file)}:${esc(f.line)}</code></td><td>${esc(f.title)}${f.cwe ? ` <span class="muted">${esc(f.cwe)}</span>` : ""}</td>` +
    `<td>${esc(f.recommendation)}${f.corrections?.length ? `<div class="banner">⚠ Corrected by verification: ${correctionText(f).map(esc).join("<br>")}</div>` : ""}</td></tr>`;
}

export function reportHtml(c: Ctx): string {
  const k = counts(c);
  const ev = c.evidence ?? {};
  const name = c.scope?.name ?? "review";
  const banners: string[] = [];
  if (isStale(c)) banners.push("STALE REVIEW: the code changed after the scan. Re-run before acting.");
  if (verificationIncomplete(c)) banners.push(`VERIFICATION INCOMPLETE: ${k.pending} finding(s) have no verdict.`);
  const unc = [...uncoveredDimensions(c)];
  if (unc.length) banners.push(`Not fully covered: ${unc.join(", ")} (lost or deferred shards).`);
  const cov = c.coverage;
  const covRows = (cov?.top_level ?? []).map((d: any) => `<tr><td><code>${esc(d.dir)}</code></td><td>${esc(d.status)}</td><td>${esc(d.files)}</td><td>${esc(d.files_read)}</td><td>${esc(d.reason ?? "")}</td></tr>`).join("");
  const scanRows = (c.scanners ?? []).map((s) => `<tr><td>${esc(s.id ?? s.tool)}</td><td>${esc(s.status)}</td><td>${esc(s.version ?? "")}</td><td>${esc(s.findings ?? "")}</td><td>${esc(s.error ?? "")}</td></tr>`).join("");
  const shown = c.findings.filter((f) => f.verdict !== "refuted");
  const d = diagrams(c);
  const diag = d ? [["System context", d.context], ["Module dependencies", d.modules], ["Data lineage", d.lineage]]
    .map(([t, m]) => `<h3>${esc(t)}</h3><pre class="mermaid">${esc(m)}</pre>`).join("") : `<p class="muted">Topology not mapped (run the map stage).</p>`;
  const qa = (c.architecture?.quality_attributes ?? []).map((q: any) => `<tr><td>${esc(q.name)}</td><td>${esc(q.rating === "unavailable" ? "unavailable" : `${q.rating}/5`)}</td><td>${esc(q.rationale ?? "")}</td></tr>`).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Code Review Report</title><style>${CSS}</style></head>
<body><main>
<p class="muted">code-review-harness ${esc(c.pluginVersion)} · ${esc(name)}${c.revision ? ` · commit <code>${esc(String(c.revision.commit ?? "").slice(0, 12))}</code>${c.revision.dirty ? " (dirty)" : ""} · scanned ${esc(c.revision.scanned_at ?? "")}` : ""}</p>
<h1>Code Review Report</h1>
${banners.map((b) => `<div class="banner" role="alert">${esc(b)}</div>`).join("\n")}
<section class="tiles">
${tile("files", ev.total_files ?? "?")}${tile("code lines", ev.total_code_lines ?? "?")}${tile("confirmed", k.confirmed)}${tile("needs human", k.needs_human)}${tile("accepted risk", k.accepted)}${tile("refuted", k.refuted)}${tile("deferred", k.deferred)}
</section>
${c.architecture ? `<h2>Architecture</h2><p><b>Style:</b> ${esc(c.architecture.style)}</p><p>${esc(c.architecture.summary)}</p>${qa ? `<div class="wrap"><table><thead><tr><th>Quality attribute</th><th>Rating</th><th>Rationale</th></tr></thead><tbody>${qa}</tbody></table></div>` : ""}` : `<h2>Architecture</h2><p class="muted">Architecture stage not run.</p>`}
${diag}
<h2>Findings</h2>
<div class="filters">${select("dimension", shown.map((f) => f.dimension))}${select("severity", shown.map((f) => f.severity))}${select("verdict", shown.map((f) => (f.accepted ? "accepted" : f.verdict ?? "pending")))}</div>
<div class="wrap"><table id="findings"><thead><tr><th>ID</th><th>Dimension</th><th>Severity</th><th>Confidence</th><th>Verdict</th><th>Location</th><th>Title</th><th>Fix</th></tr></thead>
<tbody>${shown.map(row).join("\n") || `<tr><td colspan="8" class="muted">No findings.</td></tr>`}</tbody></table></div>
<h2>Coverage</h2>
${cov ? `<p>Files read by agents: ${esc(cov.files_read)} of ${esc(cov.files_total)} (${esc(cov.files_read_pct)}%). Lost shards: ${esc((cov.lost_shards ?? []).length)} · deferred: ${esc((cov.deferred_shards ?? []).length)}</p><div class="wrap"><table><thead><tr><th>Directory</th><th>Status</th><th>Files</th><th>Read</th><th>Reason</th></tr></thead><tbody>${covRows}</tbody></table></div>` : `<p class="muted">Coverage not computed.</p>`}
<h2>Scanners</h2>
${scanRows ? `<div class="wrap"><table><thead><tr><th>Scanner</th><th>Status</th><th>Version</th><th>Findings</th><th>Note</th></tr></thead><tbody>${scanRows}</tbody></table></div>` : `<p class="muted">No scanner status recorded.</p>`}
<h2>Refuted (audit)</h2>
<p class="muted">${c.refuted.length ? c.refuted.map((f) => esc(f.id)).join(", ") : "none"}</p>
<p class="muted">Full detail: ANALYSIS_REPORT.md · ARCHITECTURE.md · ROADMAP.md · findings.sarif</p>
</main>
<script>${JS}</script>
<script type="module">try{const m=await import(${JSON.stringify(MERMAID)});m.default.initialize({startOnLoad:false,securityLevel:"strict",theme:matchMedia("(prefers-color-scheme: dark)").matches?"dark":"default"});await m.default.run({querySelector:"pre.mermaid"});}catch(e){/* offline: diagrams stay as text */}</script>
</body></html>
`;
}
