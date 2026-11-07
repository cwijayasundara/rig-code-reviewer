// DECK.pptx renderer: the whole analysis as a Google-Slides-friendly, editable deck
// (pure: Ctx -> Deck, then bytes). Built from the same loaded context as
// ANALYSIS_REPORT.md, so every number reconciles; prose sections (analyst notes,
// assessment, threat model) are the same markdown files the report embeds.
// Diagrams are native shapes (deck-diagrams.ts). Text is paginated against the
// body box instead of relying on autofit, which Google Slides ignores.
import { join } from "node:path";
import type { Finding } from "./types.ts";
import { DIMENSIONS } from "./types.ts";
import { categoryOf } from "./cwe.ts";
import type { Ctx } from "./report-ctx.ts";
import { correctionText, counts, isStale, loadCtx, panel, uncoveredDimensions, verificationIncomplete } from "./report-ctx.ts";
import { BODY_H_PT, BODY_W_IN, buildPptx, C, rowHeightPt, textLines, type Cell, type Deck, type Para, type Shape, type Slide } from "./pptx.ts";
import * as D from "./deck-diagrams.ts";
import { redact } from "./redact.ts";
import { writeText } from "./util.ts";

const { SEV_COLOR } = D;
const CELL_MAX = 220;
const FIELD_MAX = 1200;

// ---------- text helpers ----------

export const trunc = D.clip;
const v = (x: unknown): string => (x === undefined || x === null || x === "" ? "—" : String(x));
const loc = (f: { file?: string; line?: number }) => `${f.file ?? "?"}:${f.line ?? "?"}`;

/** Strip inline markdown: bold/italic markers, code ticks, links. */
function inline(s: string): string {
  return s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*\*|__/g, "").replace(/`/g, "").trim();
}

/** Markdown prose (notes, assessment, threat model) -> slide paragraphs. */
export function mdToParas(md: string | null | undefined): Para[] {
  const out: Para[] = [];
  let fenced = false;
  for (const raw of String(md ?? "").split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) { fenced = !fenced; continue; }
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (fenced) { out.push({ runs: [{ text: line.trim(), color: C.muted, mono: true }] }); continue; }
    if (/^\s*\|?\s*:?-{3,}/.test(line)) continue; // table separator
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^#{1,6}\s+(.*)$/))) out.push({ heading: true, runs: [{ text: trunc(inline(m[1]!), FIELD_MAX) }] });
    else if ((m = line.match(/^(\s*)[-*+]\s+(.*)$/))) out.push({ bullet: true, level: m[1]!.length >= 2 ? 1 : 0, runs: [{ text: trunc(inline(m[2]!), FIELD_MAX) }] });
    else if (/^\s*\|/.test(line)) out.push({ bullet: true, runs: [{ text: trunc(line.split("|").map((c) => inline(c)).filter(Boolean).join(" · "), FIELD_MAX) }] });
    else out.push({ runs: [{ text: trunc(inline(line.replace(/^\s*>\s?/, "")), FIELD_MAX) }] });
  }
  return out;
}

const p = (text: string, over: Partial<Para> = {}): Para => ({ runs: [{ text }], ...over });
const b = (text: string, level: 0 | 1 = 0): Para => ({ bullet: true, level, runs: [{ text }] });
const lp = (label: string, text: unknown, bullet = false): Para => ({ bullet, runs: [{ text: `${label}: `, bold: true, color: C.navy }, { text: trunc(v(text), FIELD_MAX) }] });
const sevCell = (s: string): Cell => ({ text: s, bold: true, color: SEV_COLOR[s] ?? C.ink });
const idCell = (id: string): Cell => ({ text: id, bold: true, color: C.navy });
const mono = (s: string): Cell => ({ text: s, color: C.navy2 });

// ---------- pagination ----------

function paraHeight(q: Para, size: number): number {
  const sz = q.heading ? size + 2 : size;
  const indent = q.bullet ? 0.375 * (1 + (q.level ?? 0)) : 0;
  const text = q.runs.map((r) => r.text).join("");
  return textLines(text, BODY_W_IN - indent, sz, q.runs.some((r) => r.mono)) * sz * 1.2 + (q.space ?? (q.heading ? 9 : 4));
}

function numbered(title: string, i: number, n: number): string {
  return n > 1 ? `${title} (${i + 1}/${n})` : title;
}

/** Split paragraphs over as many slides as their estimated height needs. */
export function bulletSlides(title: string, paras: Para[], size = 14): Slide[] {
  // A prose file usually opens with a heading that repeats the slide title.
  const first = paras[0];
  if (first?.heading && first.runs.map((r) => r.text).join("").trim().toLowerCase() === title.toLowerCase()) paras = paras.slice(1);
  if (!paras.length) paras = [{ runs: [{ text: "None recorded.", color: C.muted }] }];
  const budget = BODY_H_PT * 0.92;
  // Short content gets larger type: use the biggest size that still fits one slide.
  for (const up of [18, 16]) if (up > size && paras.reduce((n, q) => n + paraHeight(q, up), 0) <= budget * 0.8) { size = up; break; }
  const pages: Para[][] = [[]];
  let used = 0;
  for (const q of paras) {
    const h = paraHeight(q, size);
    const page = pages[pages.length - 1]!;
    // Never strand a heading at the bottom of a page.
    if (page.length && (used + h > budget || (q.heading && used + h + size * 2.5 > budget))) { pages.push([q]); used = h; }
    else { page.push(q); used += h; }
  }
  return pages.map((ps, i) => ({ kind: "bullets", title: numbered(title, i, pages.length), paras: ps, size }));
}

const cellText = (c: Cell) => (typeof c === "string" ? c : c.text);

/** Split table rows over slides; every page repeats the header. */
export function tableSlides(title: string, head: string[], rows: unknown[][], widths: number[], opts: { size?: number; caption?: string } = {}): Slide[] {
  const size = opts.size ?? 11;
  const total = widths.reduce((a, c) => a + c, 0) || 1;
  const colIn = widths.map((w) => (BODY_W_IN * w) / total - 0.18);
  const cells: Cell[][] = rows.map((r) => head.map((_, i) => {
    const x = r[i];
    return x && typeof x === "object" && "text" in (x as object) ? { ...(x as Exclude<Cell, string>), text: trunc(v((x as { text: unknown }).text), CELL_MAX) } : trunc(v(x), CELL_MAX);
  }));
  const rowH = (r: Cell[], sz: number) => Math.max(...r.map((c, i) => textLines(cellText(c), colIn[i]!, sz, typeof c !== "string" && !!c.mono))) * sz * 1.2 + 7.2;
  const budget = (BODY_H_PT - (opts.caption ? 32 : 0)) * 0.93 - rowHeightPt(size);
  if (!cells.length) return [canvas(title, [{ t: "box", x: 0.6, y: 1.6, w: 12.13, h: 1.1, geom: "roundRect", fill: C.surface, line: C.line, lineW: 0.75, inset: 0.3, anchor: "ctr", size: 16,
    paras: [{ runs: [{ text: "None. ", bold: true, color: C.navy }, { text: "This review recorded nothing in this category.", color: C.muted }], space: 0 }] }])];
  const pages: Cell[][][] = [[]];
  let used = 0;
  for (const r of cells) {
    const h = rowH(r, size);
    if (pages[pages.length - 1]!.length && used + h > budget) { pages.push([]); used = 0; }
    pages[pages.length - 1]!.push(r);
    used += h;
  }
  return pages.map((rs, i) => ({ kind: "table", title: numbered(title, i, pages.length), head, rows: rs, widths, size, caption: opts.caption }));
}

const canvas = (title: string, shapes: Shape[], caption?: string): Slide => ({ kind: "canvas", title, shapes, caption });

// ---------- findings ----------

function findingParas(f: Finding): Para[] {
  const lowered = f.original_severity && f.original_severity !== f.severity ? ` · reported ${f.original_severity}, lowered by verification` : "";
  const L: Para[] = [
    { runs: [{ text: f.severity, bold: true, color: SEV_COLOR[f.severity] }, { text: ` · confidence ${f.confidence} · effort ${f.effort}${f.votes?.length ? ` · panel ${panel(f)} confirmed` : ""}${lowered} · ${f.dimension}` }] },
    lp("Where", `${loc(f)}${f.symbol ? ` (${f.symbol})` : ""}${f.cwe ? ` · ${f.cwe} (${categoryOf(f.cwe).name})` : ""}`),
  ];
  if (f.corrections?.length) {
    L.push({ runs: [{ text: "⚠ Corrected by verification — these statements replace the text below:", bold: true, color: C.crit }] });
    for (const t of correctionText(f)) L.push(b(trunc(t, FIELD_MAX), 1));
  }
  L.push(lp("Evidence", f.evidence), lp("Impact", f.impact), lp("Recommendation", f.recommendation));
  if (f.exploit_scenario) L.push(lp("Exploit", f.exploit_scenario));
  if (f.reporters > 1) L.push(lp("Independent reporters", f.reporters));
  if (f.also_reported_as?.length) L.push(lp("Also reported as (consolidated)", `${f.also_reported_as.join(", ")}${f.consolidation_note ? ` — ${f.consolidation_note}` : ""}`));
  return L;
}

/** One designed slide per finding; text too long for the card layout uses full-text slides instead. */
function findingSlides(f: Finding): Slide[] {
  const title = trunc(`${f.id} — ${f.title}`, 90);
  const where = `${loc(f)}${f.symbol ? ` (${f.symbol})` : ""}${f.cwe ? `  ·  ${categoryOf(f.cwe).name}` : ""}`;
  const fitted = D.findingCanvas(f, correctionText(f), where);
  if (!fitted) return bulletSlides(title, findingParas(f), 13);
  const extra: string[] = [];
  if (f.original_severity && f.original_severity !== f.severity) extra.push(`Reported as ${f.original_severity}; lowered by verification`);
  if (f.reporters > 1) extra.push(`${f.reporters} independent reporters`);
  if (f.also_reported_as?.length) extra.push(`Also reported as: ${f.also_reported_as.join(", ")}${f.consolidation_note ? ` — ${f.consolidation_note}` : ""}`);
  return [canvas(title, fitted, extra.length ? trunc(extra.join("  ·  "), 220) : undefined)];
}

function fixText(f: Finding): string {
  return f.corrections?.length ? `${f.recommendation} ⚠ corrected: ${correctionText(f).join("; ")}` : f.recommendation;
}

const ROADMAP_HEAD = ["ID", "Severity", "Title", "Location", "Effort", "Fix"];
const ROADMAP_W = [1.25, 0.85, 2.6, 2.4, 0.6, 4.0];
const roadmapRows = (fs: Finding[]) => fs.map((f) => [idCell(f.id), sevCell(f.severity), f.title, mono(loc(f)), f.effort, fixText(f)]);

// ---------- deck ----------

export function buildDeck(c: Ctx): Deck {
  const k = counts(c);
  const ev = c.evidence, a = c.architecture, t = c.topology, cov = c.coverage;
  const name = c.scope?.name ?? "review";
  const S: Slide[] = [];
  let sectionNo = 0;
  const section = (title: string, subtitle?: string) => S.push({ kind: "section", num: ++sectionNo, title, subtitle });
  const dims = (c.scope?.dimensions?.length ? c.scope.dimensions : [...DIMENSIONS]) as string[];
  const unc = uncoveredDimensions(c);
  const none = (d: string) => (!dims.includes(d) ? `Not reviewed — ${d} was outside this review's scope (not evidence of absence).`
    : unc.has(d) ? `No confirmed findings — but ${d} was not fully covered (lost/deferred shards). Absence of findings is not evidence of absence.` : "No confirmed findings.");
  const sev = new Map<string, number>();
  for (const f of c.confirmed) sev.set(f.severity, (sev.get(f.severity) ?? 0) + 1);
  const now = c.confirmed.filter((f) => ["Blocker", "Critical", "High"].includes(f.severity));
  const next = c.confirmed.filter((f) => f.severity === "Medium");
  const later = c.confirmed.filter((f) => f.severity === "Low" || f.severity === "Nit");
  const pct = cov?.files_read_pct;
  const pctText = pct !== undefined && pct !== null ? `${pct}%` : "—";

  // Title
  S.push({ kind: "title", kicker: "Code review", title: `Code Analysis — ${name}`, subtitle: [
    "Architecture, code quality and security: verified findings and a prioritised roadmap",
    c.revision ? `Revision ${v(c.revision.commit).slice(0, 12)}${c.revision.dirty ? " (dirty tree)" : ""} · scanned ${v(c.revision.scanned_at)}` : "Revision not recorded",
    "Every number is computed by script from the verified review data",
  ], stats: [
    { value: String(k.confirmed), label: "confirmed findings" },
    { value: String(now.length), label: "Blocker / Critical / High", color: now.length ? "FCA5A5" : "86EFAC" },
    { value: pctText, label: "of files read by reviewers" },
  ] });
  const agendaAt = S.length; // the agenda goes here once section slide numbers are known

  // 1. Overview
  section("Executive overview", "Where the risk is, and the one change that matters most");
  S.push(canvas("Executive dashboard", D.dashboard({
    confirmed: k.confirmed, urgent: now.length, needsHuman: k.needs_human, filesPct: pctText, sev, pending: k.pending,
    oneThing: a?.one_thing ? String(a.one_thing) : undefined, style: a?.style ? String(a.style) : undefined,
    size: ev ? `${v(ev.total_files)} files · ${v(ev.total_code_lines)} code lines · ${Object.keys(ev.languages ?? {}).slice(0, 3).join(", ") || "—"}` : undefined,
  }), [isStale(c) ? "STALE: the code changed after the scan — findings may point at moved or fixed code." : "",
    verificationIncomplete(c) ? `VERIFICATION INCOMPLETE: ${k.pending} finding(s) without a verdict are excluded from every count.` : ""].filter(Boolean).join("  ")
    || `Also: ${k.accepted} accepted risk · ${k.refuted} refuted · ${k.deferred} deferred (coverage gap) · ${k.unverified} unverified (below the verification floor).`));
  S.push(canvas("Where the findings are", D.heatmap(dims, c.confirmed, unc), "Confirmed findings by dimension and severity; darker cells hold more findings. \"partial\" marks a dimension that was not fully covered."));
  if (now.length) S.push(...tableSlides("Top risks — act now", ["ID", "Severity", "Title", "Location", "Effort"], now.map((f) => [idCell(f.id), sevCell(f.severity), f.title, mono(loc(f)), f.effort]), [1.3, 0.9, 5, 3, 0.7]));
  if (c.notes?.trim()) S.push(...bulletSlides("Analyst notes", mdToParas(c.notes), 13));

  // 2. Scope & coverage
  section("Scope, method & coverage", "What was reviewed, how findings were verified, and what was not reached");
  S.push(canvas("How the review works", D.pipeline(), "Non-security findings get one independent verifier, which may lower but never raise severity. Repository text is data, never instructions."));
  if (c.scope) S.push(...bulletSlides("Scope", [
    lp("Source", `${c.scope.source}${c.scope.module ? ` · module ${c.scope.module}` : ""}`, true), lp("Dimensions", dims.join(", "), true),
    lp("Security effort", c.scope.security_effort, true), lp("Excluded", (c.scope.exclude ?? []).join(", ") || "none", true),
    lp("Code execution", c.scope.no_execution ? "not allowed" : "allowed when approved in preflight", true)], 16));
  if (c.scanners?.length) S.push(...tableSlides("Scanners", ["Scanner", "Status", "Version", "Findings", "Network", "Note"],
    c.scanners.map((s) => [{ text: v(s.id ?? s.tool), bold: true }, { text: v(s.status), bold: true, color: s.status === "ok" ? C.ok : s.status === "failed" || s.status === "missing" ? C.crit : C.ink }, s.version, s.findings, s.network ? "yes" : "no", s.error]), [1.5, 1.2, 1.3, 1, 0.9, 4.5]));
  if (cov) {
    if ((cov.top_level ?? []).length) {
      S.push(canvas("Coverage", D.coverageBars(cov.top_level, pct), `Files read by reviewers: ${v(cov.files_read)} of ${v(cov.files_total)}.`));
      if (cov.top_level.length > 11) S.push(...tableSlides("Coverage by top-level directory", ["Directory", "Status", "Files", "Files read", "Reason"],
        cov.top_level.map((d: any) => [mono(v(d.dir)), d.status, d.files, d.files_read, d.reason]), [2.5, 1.4, 0.9, 1, 4.5]));
    }
    const gaps: Para[] = [];
    for (const s of cov.lost_shards ?? []) gaps.push(b(`Lost shard: ${s}`));
    for (const s of cov.deferred_shards ?? []) gaps.push(b(`Deferred shard (agent cap): ${s}`));
    for (const s of cov.capped_shards ?? []) gaps.push(b(`Findings cap: ${s.shard} filed ${s.filed}, the ${s.kept} most severe were kept`));
    for (const s of cov.scanners?.failed ?? []) gaps.push(b(`Scanner ${v(s.id)} ${v(s.status)}: ${trunc(v(s.error), 300)}`));
    for (const s of cov.scanners?.missing ?? []) gaps.push(b(`Scanner ${s} not installed`));
    for (const s of cov.not_reached ?? []) gaps.push(b(`Not reached: ${s}`));
    for (const d of (cov.top_level ?? []).filter((x: any) => x.status === "unaccounted")) gaps.push(b(`Unaccounted directory: ${d.dir}`));
    if (unc.size) gaps.push({ runs: [{ text: `Dimensions not fully covered: ${[...unc].join(", ")}. Their "no findings" means "not fully examined", not "clean".`, bold: true, color: C.med }] });
    S.push(...bulletSlides("Coverage gaps", gaps.length ? gaps : [p("No coverage gaps recorded.")], 14));
  }

  // 3. Architecture
  section("Architecture", a?.style ? String(a.style) : "Structure, quality attributes and decisions");
  if (t) S.push(canvas("System context", D.contextDiagram(t, name, `${(t.modules ?? []).length} modules${ev?.total_code_lines ? ` · ${ev.total_code_lines} code lines` : ""}`), "Reconstructed from the code by the map stage; every element cites file:line in topology.json."));
  if (t?.modules?.length) {
    const g = D.moduleGraph(t, a);
    S.push(canvas("Module dependencies", g.shapes, `${g.shown} of ${g.total} modules (most connected first) · ${g.edges} dependencies · fill colour = disposition. Full map: ARCHITECTURE.md.`));
  }
  if (a) S.push(...bulletSlides("Architecture summary", [lp("Style", a.style), ...mdToParas(String(a.summary ?? ""))], 15));
  if ((a?.quality_attributes ?? []).length) S.push(canvas("Quality attributes (ISO 25010)", D.qualityMeters(a!.quality_attributes), "Evidence-anchored judgments (1 = poor, 5 = strong), not measurements. No composite score is computed."));
  if (t?.modules?.length) {
    const disp = new Map<string, any>((a?.dispositions ?? []).map((x: any) => [String(x.module), x]));
    S.push(...tableSlides("Modules", ["Module", "Path", "Lines", "Kind", "Description", "Disposition"],
      t.modules.map((m: any) => [{ text: v(m.name), bold: true }, mono(v(m.path)), m.lines, m.kind, m.description, disp.get(String(m.name))?.disposition]), [1.6, 2, 0.7, 1, 4, 1.2]));
  }
  if ((t?.flows ?? []).length) S.push(...bulletSlides("Key flows", t!.flows.flatMap((f: any) => [p(v(f.name), { heading: true }),
    ...(f.steps ?? []).map((s: string, i: number) => b(`${i + 1}. ${trunc(s, FIELD_MAX)}`, 1))]), 13));
  if ((a?.decisions ?? []).length) S.push(...bulletSlides("Reconstructed decisions", a!.decisions.flatMap((x: any, i: number) => [
    p(`ADR-R${String(i + 1).padStart(2, "0")}: ${v(x.title)}`, { heading: true }), lp("Context", x.context, true), lp("Decision (as implemented)", x.decision, true), lp("Consequences", x.consequences, true)]), 12));
  if ((a?.dispositions ?? []).length) S.push(...tableSlides("Module dispositions", ["Module", "Disposition", "Rationale"], a!.dispositions.map((x: any) => [{ text: v(x.module), bold: true }, x.disposition, x.rationale]), [2, 1.4, 6.6]));
  if ((a?.risks ?? []).length) S.push(...tableSlides("Architectural risks", ["Risk", "Findings"], a!.risks.map((r: any) => [r.title, (r.finding_ids ?? []).join(", ")]), [7, 3]));
  if ((t?.dead_ends ?? []).length) S.push(...tableSlides("Dead ends", ["Dead end", "Reason", "Evidence"], t!.dead_ends.map((x: any) => [x.name, x.reason, x.evidence]), [2.5, 4, 3.5]));
  if ((t?.observations ?? []).length) S.push(...bulletSlides("Observations", t!.observations.map((o: string) => b(trunc(o, FIELD_MAX))), 13));
  if (!a && !t) S.push(...bulletSlides("Architecture", [p("Not available (run the map and architecture stages).")]));

  // 4. Security
  section("Security", "Threat model and panel-verified findings");
  const sec = c.confirmed.filter((f) => f.dimension === "security");
  if (dims.includes("security")) S.push(canvas("Security posture", D.securityPosture(sec, c.needsHuman.filter((f) => f.dimension === "security").length)));
  if (c.threatModel?.trim()) S.push(...bulletSlides("Threat model", mdToParas(c.threatModel), 12));
  S.push(...(sec.length ? tableSlides("Security findings", ["ID", "CWE", "Category", "Severity", "Panel", "Location", "Fix"],
    sec.map((f) => [idCell(f.id), f.cwe, f.cwe ? categoryOf(f.cwe).name : f.category, sevCell(f.severity), panel(f), mono(loc(f)), fixText(f)]), [1.25, 0.9, 1.5, 0.85, 0.65, 1.9, 3.5])
    : bulletSlides("Security findings", [p(none("security"))], 16)));

  // 5. Quality, tests, dependencies
  section("Code quality, tests & dependencies", "Heuristic signals, hotspots and test posture");
  if (ev) {
    const god = ev.god_class_candidates ?? [], lm = ev.long_method_candidates ?? [], th = ev.thresholds ?? {};
    const src = Number(ev.source_files ?? 0), tst = Number(ev.test_files ?? 0);
    const measured = ev.measured_coverage ? String(typeof ev.measured_coverage === "object" ? JSON.stringify(ev.measured_coverage) : ev.measured_coverage) : null;
    const tw = (12.13 - 3 * 0.25) / 4;
    const qShapes: Shape[] = [
      ...D.tile(0.6, 1.5, tw, 1.2, String(god.length), `god-file candidates (≥${th.god_file_lines ?? 500} lines)`, C.high),
      ...D.tile(0.6 + (tw + 0.25), 1.5, tw, 1.2, String(lm.length), `long-method candidates (≥${th.long_method_lines ?? 50} lines)`, C.med),
      ...D.tile(0.6 + 2 * (tw + 0.25), 1.5, tw, 1.2, measured ? trunc(measured, 8) : `${src ? Math.round((100 * tst) / src) : 0}%`, measured ? "measured test coverage" : "test files per source file (proxy)", C.accent),
      ...D.tile(0.6 + 3 * (tw + 0.25), 1.5, tw, 1.2, String(c.confirmed.filter((f) => f.dimension === "quality").length), "confirmed quality findings", C.navy),
    ];
    if ((ev.hotspots ?? []).length) qShapes.push({ t: "box", x: 0.6, y: 3.0, w: 12.1, h: 0.35, size: 13, anchor: "ctr", paras: [{ runs: [{ text: "Hotspots", bold: true, color: C.navy }, { text: `   ${v(ev.hotspot_formula ?? "churn × complexity")} — where change and complexity collide`, color: C.muted, size: 11 }], space: 0 }] },
      ...D.hbars(0.6, 3.45, 12.1, 3.1, ev.hotspots.slice(0, 6).map((h: any) => ({ label: D.tailPath(h.file, 36), value: Number(h.score) || 0, color: C.high, note: `${h.churn} × ${h.complexity}` })), { labelW: 3.8 }));
    else qShapes.push({ t: "box", x: 0.6, y: 3.2, w: 12.1, h: 0.5, size: 12, paras: [{ runs: [{ text: ev.churn?.available === false ? "Hotspots unavailable: no git history." : "No hotspots recorded.", italic: true, color: C.muted }] }] });
    S.push(canvas("Code quality signals", qShapes, "Candidates are heuristics, not verdicts; confirmed findings follow in the detail section."));
    if ((ev.hotspots ?? []).length > 6) S.push(canvas("Hotspots (churn × complexity)", D.hotspotChart(ev.hotspots)));
    if (god.length) S.push(...tableSlides("God-file candidates", ["File", "Lines"], god.slice(0, 25).map((g: any) => [mono(v(g.file)), g.lines ?? g.sloc]), [8, 2]));
    if (lm.length) S.push(...tableSlides("Long-method candidates", ["Function", "Location", "Lines", "Complexity"], lm.slice(0, 25).map((m: any) => [{ text: v(m.name), bold: true }, mono(`${m.file}:${m.line}`), m.lines, m.complexity]), [3, 5, 1, 1.2]));
    if ((ev.complexity_top ?? []).length) S.push(...tableSlides("Most complex files", ["File", "Complexity", "Functions"], ev.complexity_top.slice(0, 15).map((x: any) => [mono(v(x.file)), x.complexity, x.functions]), [7, 1.5, 1.5]));
    if ((ev.ownership ?? []).length) S.push(...tableSlides("Ownership & bus factor", ["Directory", "Authors", "Top author share", "Bus factor"], ev.ownership.map((o: any) => [mono(v(o.dir)), o.authors, o.top_author_share, { text: v(o.bus_factor), bold: true, color: Number(o.bus_factor) <= 1 ? C.crit : C.ink }]), [5, 1.3, 2, 1.5]));
    const test: Para[] = [];
    if (measured) test.push(b(`Measured coverage: ${measured}`));
    else test.push(b(`Test files: ${tst} vs ${src} source files (ratio ${src ? Math.round((100 * tst) / src) : 0}%).`),
      b("PROXY, not measured coverage: this counts test files only. Measured line/branch coverage requires running the project's coverage tool."));
    const tf = c.confirmed.filter((f) => f.dimension === "testing").length;
    test.push(b(tf ? `${tf} confirmed testing finding(s) — see the detail section.` : none("testing")));
    S.push(...bulletSlides("Test posture", test, 16));
  } else S.push(...bulletSlides("Code quality", [p("Evidence not available (run the assess stage).")]));
  const deps = c.confirmed.filter((f) => f.dimension === "dependencies");
  const manifests = (ev?.manifests ?? []) as string[];
  S.push(...(deps.length ? tableSlides("Dependencies", ["ID", "Severity", "Source", "Location", "Title", "Fix"],
    deps.map((f) => [idCell(f.id), sevCell(f.severity), f.source ?? "agent", mono(loc(f)), f.title, fixText(f)]), [1.25, 0.85, 1, 1.9, 2.5, 3.5],
    manifests.length ? { caption: `Manifests: ${trunc(manifests.join(", "), 180)}` } : {})
    : bulletSlides("Dependencies", [...(manifests.length ? [b(`Manifests: ${manifests.join(", ")}`)] : []), p(none("dependencies"))], 16)));

  // 6. Every confirmed finding in detail, grouped by dimension
  section("Findings in detail", `${k.confirmed} confirmed finding(s), ranked by severity → confidence → effort`);
  for (const d of dims) for (const f of c.confirmed.filter((x) => x.dimension === d)) S.push(...findingSlides(f));
  const silent = dims.filter((d) => !c.confirmed.some((f) => f.dimension === d));
  if (silent.length) S.push(...bulletSlides("Dimensions without confirmed findings", silent.map((d) => ({ bullet: true, runs: [{ text: `${d}: `, bold: true, color: C.navy }, { text: none(d) }] } as Para)), 14));

  // 7. Roadmap
  section("Roadmap", "Confirmed findings only · severity → confidence → effort (quick wins first)");
  S.push(canvas("Roadmap at a glance", D.roadmapLanes(now, next, later)));
  S.push(canvas("Priority matrix — severity × effort", D.priorityMatrix(c.confirmed)));
  S.push(...tableSlides("Now — Blocker / Critical / High", ROADMAP_HEAD, roadmapRows(now), ROADMAP_W, { size: 10 }));
  S.push(...tableSlides("Next — Medium", ROADMAP_HEAD, roadmapRows(next), ROADMAP_W, { size: 10 }));
  S.push(...tableSlides("Later — Low / Nit", ROADMAP_HEAD, roadmapRows(later), ROADMAP_W, { size: 10 }));
  S.push(...tableSlides("Open questions (needs a human)", ["ID", "Title", "Location", "Question"],
    c.needsHuman.map((f) => [idCell(f.id), f.title, mono(loc(f)), f.verifier_note ?? "verifier could not decide"]), [1.3, 3, 2.2, 4.5]));
  S.push(canvas("Recommended next steps", D.nextSteps(now, a?.one_thing ? String(a.one_thing) : undefined)));

  // 8. Appendix
  section("Appendix", "Accepted risks, baseline changes, assessment, and findings kept for audit");
  if (c.accepted.length) S.push(...tableSlides("Accepted risks", ["ID", "Severity", "Location", "Title", "Reason", "By", "At"],
    c.accepted.map((f) => [idCell(f.id), sevCell(f.severity), mono(loc(f)), f.title, f.accepted?.reason, f.accepted?.by, f.accepted?.at]), [1.25, 0.85, 1.9, 2.3, 2.6, 0.9, 1.2]));
  if (c.diff) {
    const dp: Para[] = [b(`Baseline: ${v(c.diff.baseline)} · new ${(c.diff.new ?? []).length} · no longer reported ${(c.diff.fixed ?? []).length} · persisting ${(c.diff.persisting ?? []).length}`)];
    for (const f of c.diff.fixed ?? []) dp.push(b(`No longer reported: ${v(f.id)} ${trunc(v(f.title), 200)} (${v(f.file)}:${v(f.line)})`, 1));
    if ((c.diff.new ?? []).length) dp.push(b(`New: ${(c.diff.new as string[]).join(", ")}`));
    S.push(...bulletSlides("Changes since baseline", dp));
  }
  if (c.assessment?.trim()) S.push(...bulletSlides("Assessment", mdToParas(c.assessment), 12));
  S.push(...tableSlides("Refuted (kept for audit)", ["ID", "Title", "Location", "Verifier"],
    c.refuted.map((f) => [idCell(f.id), f.title, mono(loc(f)), f.verifier_note ?? (f.votes ?? []).map((x) => `${x.lens}: ${x.note}`).join("; ")]), [1.3, 3, 2.2, 4.5]));
  S.push(...tableSlides("Deferred (coverage gap — not verified)", ["ID", "Severity", "Title", "Location"],
    c.deferred.map((f) => [idCell(f.id), sevCell(f.severity), f.title, mono(loc(f))]), [1.3, 1, 5, 3]));
  S.push(...tableSlides("Unverified (below the verification floor)", ["ID", "Severity", "Title", "Location"],
    c.unverified.map((f) => [idCell(f.id), sevCell(f.severity), f.title, mono(loc(f))]), [1.3, 1, 5, 3]));

  // Agenda (section positions +1 for the agenda slide itself), then a section kicker on every content slide.
  const items = S.map((s, i) => [s, i] as const).filter(([s]) => s.kind === "section").map(([s, i]) => ({ title: s.title, slide: i + 2 }));
  S.splice(agendaAt, 0, canvas("Agenda", D.agenda(items)));
  let current = "Overview";
  for (const s of S) {
    if (s.kind === "section") current = s.title;
    else if (s.kind !== "title" && !s.kicker) s.kicker = s.title === "Agenda" ? "Overview" : current;
  }

  const warning = isStale(c) ? "STALE — code changed after the scan" : verificationIncomplete(c) ? `VERIFICATION INCOMPLETE — ${k.pending} pending` : undefined;
  return {
    title: `Code Analysis — ${name}`,
    footer: `${name}${c.revision?.commit ? ` · ${String(c.revision.commit).slice(0, 12)}` : ""} · code-review-harness ${c.pluginVersion}`,
    warning, slides: S,
  };
}

/** Redact every string in the deck (defence in depth, like renderAll). Colours and kinds never match a pattern. */
export function scrubDeck(d: Deck): { deck: Deck; redactions: number } {
  let redactions = 0;
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") { const r = redact(x); redactions += r.count; return r.text; }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([key, val]) => [key, walk(val)]));
    return x;
  };
  return { deck: walk(d) as Deck, redactions };
}

export function renderDeck(analysis: string, opts: { pluginVersion?: string } = {}): { path: string; slides: number; redactions: number } {
  const { deck, redactions } = scrubDeck(buildDeck(loadCtx(analysis, opts.pluginVersion)));
  const path = join(analysis, "DECK.pptx");
  writeText(path, buildPptx(deck));
  return { path, slides: deck.slides.length, redactions };
}
