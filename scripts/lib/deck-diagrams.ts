// Diagrams for DECK.pptx, drawn as native shapes and connectors (Shape[] in inches)
// so every box, arrow and label stays editable after Google Slides import. Pure
// functions of the review data; no images, no embedded charts.
import type { Finding } from "./types.ts";
import { categoryOf } from "./cwe.ts";
import { BODY_IN, C, P, textLines, tint, type Box, type Para, type Shape } from "./pptx.ts";

export const SEV_COLOR: Record<string, string> = { Blocker: C.crit, Critical: C.crit, High: C.high, Medium: C.med, Low: C.low, Nit: C.nit };
export const SEVERITIES = ["Blocker", "Critical", "High", "Medium", "Low", "Nit"] as const;

const X0 = BODY_IN.x, Y0 = BODY_IN.y, W = BODY_IN.w, H = BODY_IN.h;

export function clip(s: unknown, n: number): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

/** Keep the end of a path, which carries the meaning: "…/orders/service.py". */
export function tailPath(s: unknown, n: number): string {
  const t = String(s ?? "");
  return t.length > n ? `…${t.slice(t.length - n + 1)}` : t;
}

/** Truncate text so it fits a box (estimated by wrapped lines). */
export function fit(text: string, widthIn: number, heightIn: number, size: number): string {
  const maxLines = Math.max(1, Math.floor((heightIn * 72) / (size * 1.22)));
  if (textLines(text, widthIn, size) <= maxLines) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (textLines(`${text.slice(0, mid)}…`, widthIn, size) <= maxLines) lo = mid; else hi = mid - 1; }
  return `${text.slice(0, lo).trimEnd()}…`;
}

const box = (x: number, y: number, w: number, h: number, o: Partial<Box> = {}): Box => ({ t: "box", x, y, w, h, ...o });
const label = (x: number, y: number, w: number, h: number, text: string, o: Partial<Box> & { bold?: boolean; italic?: boolean; align?: "l" | "ctr" | "r" } = {}): Box => {
  const { bold, italic, align, ...rest } = o;
  return box(x, y, w, h, { anchor: "ctr", ...rest, paras: [P(text, { bold, italic, align, space: 0 })] });
};
const arrow = (x1: number, y1: number, x2: number, y2: number, color: string = C.faint, dash = false): Shape => ({ t: "line", x1, y1, x2, y2, color, w: 1.25, arrow: true, dash });

/** A KPI tile: big number, label, coloured strip. */
export function tile(x: number, y: number, w: number, h: number, value: string, caption: string, color: string): Shape[] {
  return [
    box(x, y, w, h, { geom: "roundRect", fill: C.surface, line: C.line, lineW: 0.75 }),
    box(x, y + 0.18, 0.07, h - 0.36, { fill: color }),
    box(x + 0.28, y + 0.12, w - 0.4, h * 0.55, { anchor: "b", paras: [P(value, { bold: true, color: C.ink, space: 0 })], size: h > 1.1 ? 32 : 26 }),
    box(x + 0.28, y + 0.12 + h * 0.55, w - 0.4, h * 0.35, { anchor: "t", paras: [P(caption, { color: C.muted, space: 2 })], size: 11 }),
  ];
}

/** A small rounded pill with centred text. */
export function pill(x: number, y: number, w: number, h: number, text: string, fill: string, color: string = C.white, size = 10): Box {
  return box(x, y, w, h, { geom: "roundRect", fill, inset: 0.03, anchor: "ctr", size, paras: [P(text, { bold: true, color, align: "ctr", space: 0 })] });
}

/** Horizontal bar chart: label · bar · value. Bars scale to the largest value. */
export function hbars(x: number, y: number, w: number, h: number, rows: { label: string; value: number; color: string; note?: string }[], opts: { labelW?: number; max?: number } = {}): Shape[] {
  if (!rows.length) return [label(x, y, w, 0.5, "No data.", { color: C.muted, italic: true, size: 12 })];
  const lw = opts.labelW ?? 1.6, vw = 1.2;
  const max = opts.max ?? Math.max(1, ...rows.map((r) => r.value));
  const pitch = Math.min(0.62, h / rows.length);
  const bh = Math.min(0.36, pitch * 0.62);
  const track = w - lw - vw - 0.1;
  const out: Shape[] = [];
  rows.forEach((r, i) => {
    const cy = y + i * pitch + (pitch - bh) / 2;
    out.push(label(x, cy - 0.05, lw - 0.1, bh + 0.1, r.label, { size: 11, color: C.ink, align: "r" }));
    out.push(box(x + lw, cy, track, bh, { fill: C.panel }));
    if (r.value > 0) out.push(box(x + lw, cy, Math.max(0.04, (track * r.value) / max), bh, { fill: r.color }));
    out.push(label(x + lw + track + 0.1, cy - 0.05, vw, bh + 0.1, r.note ?? String(r.value), { size: 11, bold: true, color: C.ink }));
  });
  return out;
}

// ---------- executive dashboard ----------

export function dashboard(o: { confirmed: number; urgent: number; needsHuman: number; filesPct: string; sev: Map<string, number>; oneThing?: string; style?: string; size?: string; pending: number }): Shape[] {
  const out: Shape[] = [];
  const gap = 0.25, tw = (W - 3 * gap) / 4, th = 1.25;
  const tiles: [string, string, string][] = [
    [String(o.confirmed), "confirmed findings", C.navy],
    [String(o.urgent), "Blocker / Critical / High", o.urgent ? C.crit : C.ok],
    [String(o.needsHuman), "open questions for a human", o.needsHuman ? C.med : C.ok],
    [o.filesPct, "of files read by reviewers", C.accent],
  ];
  tiles.forEach(([v, l, c], i) => out.push(...tile(X0 + i * (tw + gap), Y0, tw, th, v, l, c)));
  const y = Y0 + th + 0.4, leftW = 6.7;
  out.push(label(X0, y, leftW, 0.3, "Confirmed findings by severity", { bold: true, size: 13, color: C.navy }));
  out.push(...hbars(X0, y + 0.45, leftW, H - th - 0.9, SEVERITIES.map((s) => ({ label: s, value: o.sev.get(s) ?? 0, color: SEV_COLOR[s]! })), { labelW: 1.3 }));
  const rx = X0 + leftW + 0.45, rw = W - leftW - 0.45, ch = 2.2;
  out.push(box(rx, y, rw, ch, { geom: "roundRect", fill: C.navy }));
  out.push(box(rx + 0.3, y + 0.2, rw - 0.6, 0.3, { paras: [P("IF ONLY ONE THING CHANGES", { bold: true, color: "5EEAD4", space: 0 })], size: 10 }));
  out.push(box(rx + 0.3, y + 0.55, rw - 0.6, ch - 0.7, { paras: [P(fit(o.oneThing ?? "No single priority was recorded by the architecture stage.", rw - 0.6, ch - 0.7, 15), { color: C.white, space: 0 })], size: 15 }));
  const facts: Para[] = [];
  if (o.style) facts.push({ runs: [{ text: "Architecture  ", bold: true, color: C.muted }, { text: clip(o.style, 60) }], space: 0 });
  if (o.size) facts.push({ runs: [{ text: "Codebase  ", bold: true, color: C.muted }, { text: o.size }], space: 6 });
  if (o.pending) facts.push({ runs: [{ text: `${o.pending} finding(s) still unverified`, bold: true, color: C.crit }], space: 6 });
  if (facts.length) out.push(box(rx, y + ch + 0.25, rw, H - th - ch - 0.9, { paras: facts, size: 12, fill: C.surface, line: C.line, lineW: 0.75, geom: "roundRect", inset: 0.2 }));
  return out;
}

// ---------- severity heatmap ----------

export function heatmap(dims: string[], confirmed: Finding[], partial: Set<string>): Shape[] {
  const out: Shape[] = [];
  const cols = [...SEVERITIES, "Total"];
  const lw = 2.3, cw = (W - lw) / cols.length;
  const rh = Math.min(0.52, (H - 0.6) / (dims.length + 2));
  cols.forEach((c, i) => out.push(label(X0 + lw + i * cw, Y0, cw, rh, c, { bold: true, size: 11, color: c === "Total" ? C.navy : SEV_COLOR[c], align: "ctr" })));
  const counts = dims.map((d) => SEVERITIES.map((s) => confirmed.filter((f) => f.dimension === d && f.severity === s).length));
  const max = Math.max(1, ...counts.flat());
  const rowsAll = [...dims, "All dimensions"];
  rowsAll.forEach((d, r) => {
    const y = Y0 + (r + 1) * rh + (r === dims.length ? 0.12 : 0);
    const row = r < dims.length ? counts[r]! : SEVERITIES.map((_, j) => counts.reduce((n, c) => n + c[j]!, 0));
    const name: Para = { runs: [{ text: d, bold: r === dims.length, color: C.ink }, ...(partial.has(d) ? [{ text: "  partial", italic: true, color: C.med, size: 9 }] : [])], space: 0, align: "r" };
    out.push(box(X0, y, lw - 0.15, rh, { anchor: "ctr", paras: [name], size: 12 }));
    row.forEach((n, j) => {
      const sevC = SEV_COLOR[SEVERITIES[j]!]!;
      const strength = r === dims.length ? Math.min(1, n / Math.max(1, ...row)) : n / max;
      const fill = n ? tint(sevC, 0.82 - 0.72 * strength) : C.surface;
      out.push(box(X0 + lw + j * cw + 0.03, y + 0.03, cw - 0.06, rh - 0.06, { fill, anchor: "ctr", paras: [P(n ? String(n) : "·", { bold: !!n, align: "ctr", color: n && strength > 0.5 ? C.white : n ? C.ink : C.faint, space: 0 })], size: 13 }));
    });
    const tot = row.reduce((a, b) => a + b, 0);
    out.push(box(X0 + lw + SEVERITIES.length * cw + 0.03, y + 0.03, cw - 0.06, rh - 0.06, { fill: tot ? C.navy : C.panel, anchor: "ctr", paras: [P(String(tot), { bold: true, align: "ctr", color: tot ? C.white : C.faint, space: 0 })], size: 13 }));
  });
  return out;
}

// ---------- methodology ----------

const STAGES: [string, "script" | "model" | "agents"][] = [
  ["Scope", "script"], ["Preflight", "model"], ["Assess", "script"], ["Map", "model"], ["Deep review", "agents"],
  ["Security", "agents"], ["Consolidate", "agents"], ["Verify", "agents"], ["Architecture", "model"], ["Report", "script"],
];
const OWNER: Record<string, [string, string]> = { script: [C.navy, "Script — deterministic, owns every number"], model: [C.accent, "Model — prose and structure, validated"], agents: [C.indigo, "Agents — parallel specialists, verified"] };

export function pipeline(): Shape[] {
  const out: Shape[] = [];
  const cw = W / STAGES.length;
  STAGES.forEach(([name, owner], i) => out.push(box(X0 + i * cw, Y0 + 0.1, cw + 0.12, 0.95, {
    geom: i ? "chevron" : "homePlate", fill: OWNER[owner]![0], anchor: "ctr", inset: 0.02,
    paras: [P(name, { bold: true, color: C.white, align: "ctr", space: 0 })], size: name.length > 9 ? 9 : 10.5,
  })));
  Object.values(OWNER).forEach(([color, text], i) => {
    const x = X0 + i * 4.05;
    out.push(box(x, Y0 + 1.3, 0.22, 0.22, { geom: "roundRect", fill: color }), label(x + 0.32, Y0 + 1.22, 3.6, 0.38, text, { size: 11, color: C.muted }));
  });
  // Verification panel
  const y = Y0 + 1.8;
  out.push(label(X0, y, W, 0.35, "How a finding earns a place in the report", { bold: true, size: 14, color: C.navy }));
  const by = y + 0.5, pitch = 0.85, lh = 0.7, mid = by + pitch + lh / 2;
  out.push(box(X0, mid - 0.5, 2.2, 1.0, { geom: "roundRect", fill: C.panel, line: C.line, anchor: "ctr", paras: [P("Candidate finding", { bold: true, align: "ctr", space: 0 }), P("from any reviewer", { align: "ctr", color: C.muted, size: 10, space: 2 })], size: 13 }));
  const lenses = ["REACHABILITY", "IMPACT", "DEFENSES"];
  lenses.forEach((l, i) => {
    const ly = by + i * pitch;
    out.push(box(X0 + 3.0, ly, 2.3, lh, { geom: "roundRect", fill: tint(C.indigo, 0.85), line: C.indigo, anchor: "ctr", paras: [P(l, { bold: true, align: "ctr", color: C.indigo, space: 0 }), P("independent lens", { align: "ctr", color: C.muted, size: 9, space: 1 })], size: 12 }));
    out.push(arrow(X0 + 2.2, mid, X0 + 3.0, ly + lh / 2));
    out.push(arrow(X0 + 5.3, ly + lh / 2, X0 + 6.1, mid));
  });
  out.push(box(X0 + 6.1, mid - 0.9, 3.0, 1.8, { geom: "roundRect", fill: C.navy, anchor: "ctr", inset: 0.15, size: 11, paras: [
    P("Security rule", { bold: true, color: "5EEAD4", space: 0 }), P("2 of 3 lenses must confirm", { color: C.white, space: 3 }),
    P("Severity = median of confirming votes, never raised", { color: C.white, space: 3 }), P("High confidence only on 3 of 3", { color: C.white, space: 3 })] }));
  const outcomes: [string, string, string][] = [["Confirmed", "roadmap", C.ok], ["Needs a human", "open questions", C.med], ["Refuted", "appendix only", C.faint]];
  outcomes.forEach(([a, b2, col], i) => {
    const oy = by + 0.05 + i * pitch;
    out.push(arrow(X0 + 9.1, mid, X0 + 9.7, oy + 0.3, col));
    out.push(box(X0 + 9.7, oy, W - 9.7, 0.6, { geom: "roundRect", fill: tint(col, 0.85), line: col, anchor: "ctr", inset: 0.1, size: 11, paras: [{ runs: [{ text: a, bold: true, color: C.ink }, { text: `  →  ${b2}`, color: C.muted }], space: 0 }] }));
  });
  return out;
}

// ---------- coverage ----------

export function coverageBars(dirs: { dir: string; status: string; files: number; files_read: number; reason?: string }[], pct: unknown): Shape[] {
  const out: Shape[] = [];
  const lw = 2.8, tw = 2.6;
  out.push(...tile(X0, Y0, tw, 1.35, `${pct ?? "—"}%`, "of files read by reviewers", C.accent));
  const rows = dirs.slice(0, 11);
  const x = X0 + tw + 0.5, w = W - tw - 0.5;
  const pitch = Math.min(0.48, (H - 0.3) / Math.max(1, rows.length));
  const track = w - lw - 2.4;
  out.push(label(x, Y0 - 0.05, w, 0.3, "Files read per top-level directory", { bold: true, size: 13, color: C.navy }));
  rows.forEach((d, i) => {
    const y = Y0 + 0.4 + i * pitch, bh = pitch * 0.55;
    const files = Number(d.files) || 0, read = Number(d.files_read) || 0;
    const scanned = d.status === "scanned" || d.status === "reviewed";
    out.push(label(x, y - 0.04, lw - 0.1, bh + 0.08, tailPath(d.dir, 32), { size: 11, align: "r" }));
    out.push(box(x + lw, y, track, bh, { fill: C.panel }));
    if (files && read) out.push(box(x + lw, y, Math.max(0.04, (track * Math.min(read, files)) / files), bh, { fill: scanned ? C.accent : C.faint }));
    out.push(label(x + lw + track + 0.1, y - 0.04, 2.3, bh + 0.08, `${read}/${files} · ${clip(d.reason || d.status, 22)}`, { size: 10, color: scanned ? C.ink : C.muted }));
  });
  if (dirs.length > rows.length) out.push(label(x, Y0 + 0.4 + rows.length * pitch, w, 0.3, `+${dirs.length - rows.length} more directories — see the coverage table`, { italic: true, size: 10, color: C.muted }));
  return out;
}

// ---------- architecture ----------

export function contextDiagram(t: any, name: string, sub: string): Shape[] {
  const out: Shape[] = [];
  const entries = (t?.entry_points ?? []).slice(0, 7);
  const ext = (t?.externals ?? []).slice(0, 5);
  const stores = (t?.data_stores ?? []).slice(0, 4);
  const colW = 3.1, sysW = 3.3, sysH = 2.0;
  const sx = X0 + (W - sysW) / 2, sy = Y0 + (H - 0.5 - sysH) / 2 + 0.3;
  out.push(label(X0, Y0, colW, 0.3, "ENTRY POINTS", { bold: true, size: 10, color: C.accent }));
  out.push(label(X0 + W - colW, Y0, colW, 0.3, "EXTERNAL SYSTEMS & DATA", { bold: true, size: 10, color: C.accent, align: "r" }));
  out.push(box(sx, sy, sysW, sysH, { geom: "roundRect", fill: C.navy, anchor: "ctr", inset: 0.2, paras: [P(clip(name, 40), { bold: true, color: C.white, align: "ctr", space: 0 }), P(sub, { color: C.navyText, align: "ctr", size: 11, space: 6 })], size: 18 }));
  const col = (items: { title: string; sub: string; geom: "roundRect" | "can"; fill: string; line: string }[], x: number, inbound: boolean) => {
    const top = Y0 + 0.45, avail = H - 0.55;
    const pitch = Math.min(0.78, avail / Math.max(1, items.length));
    const bh = Math.min(0.62, pitch - 0.12);
    items.forEach((it, i) => {
      const y = top + i * pitch + (avail - pitch * items.length) / 2;
      out.push(box(x, y, colW, bh, { geom: it.geom, fill: it.fill, line: it.line, anchor: "ctr", inset: 0.08, size: 11,
        paras: [P(clip(it.title, 34), { bold: true, align: "ctr", space: 0 }), P(clip(it.sub, 40), { align: "ctr", size: 9, color: C.muted, space: 1 })] }));
      const ay = sy + sysH / 2 + (i - (items.length - 1) / 2) * Math.min(0.25, sysH / Math.max(1, items.length));
      if (inbound) out.push(arrow(x + colW, y + bh / 2, sx, ay, C.faint));
      else out.push(arrow(sx + sysW, ay, x, y + bh / 2, C.faint));
    });
  };
  col(entries.map((p: any) => ({ title: String(p.name), sub: `${p.kind ?? ""} · ${tailPath(`${p.file}:${p.line}`, 30)}`, geom: "roundRect", fill: C.white, line: C.navy })), X0, true);
  col([...ext.map((x: any) => ({ title: String(x.name), sub: String(x.kind ?? "external"), geom: "roundRect" as const, fill: C.accentSoft, line: C.accent })),
    ...stores.map((s: any) => ({ title: String(s.name), sub: String(s.kind ?? "data store"), geom: "can" as const, fill: C.lowSoft, line: C.low }))], X0 + W - colW, false);
  if (!entries.length && !ext.length && !stores.length) out.push(label(X0, Y0 + H - 0.5, W, 0.4, "The map stage recorded no entry points, externals or data stores.", { italic: true, color: C.muted, size: 11, align: "ctr" }));
  return out;
}

const DISP_COLORS: [RegExp, string, string][] = [
  [/keep|retain|healthy|maintain|invest/i, C.okSoft, C.ok], [/refactor|improve|harden|split/i, C.warnSoft, C.med],
  [/replace|rewrite|rebuild|migrate/i, C.critSoft, C.crit], [/retire|remove|delete|deprecat/i, C.panel, C.muted],
];
function dispColor(d: unknown): [string, string] {
  const s = String(d ?? "");
  for (const [re, fill, line] of DISP_COLORS) if (re.test(s)) return [fill, line];
  return [C.white, C.navy];
}

/** Layered module dependency graph: sources left, dependants right; capped at 16 nodes by degree. */
export function moduleGraph(t: any, a: any): { shapes: Shape[]; shown: number; total: number; edges: number } {
  const mods: any[] = t?.modules ?? [];
  const names = new Set(mods.map((m) => String(m.name)));
  const seen = new Set<string>();
  const edges = (t?.edges ?? []).filter((x: any) => names.has(String(x.from)) && names.has(String(x.to)) && x.from !== x.to)
    .filter((x: any) => { const k = `${x.from}>${x.to}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const deg = new Map<string, number>();
  for (const x of edges) for (const n of [x.from, x.to]) deg.set(String(n), (deg.get(String(n)) ?? 0) + 1);
  const keep = mods.slice().sort((p, q) => (deg.get(q.name) ?? 0) - (deg.get(p.name) ?? 0) || (Number(q.lines) || 0) - (Number(p.lines) || 0) || String(p.name).localeCompare(String(q.name))).slice(0, 16);
  const kn = new Set(keep.map((m) => String(m.name)));
  const es = edges.filter((x: any) => kn.has(String(x.from)) && kn.has(String(x.to))).slice(0, 48);
  // Longest-path layering with a pass cap (cycles stop growing after n passes).
  const layer = new Map<string, number>(keep.map((m) => [String(m.name), 0]));
  for (let pass = 0; pass < keep.length; pass++) {
    let changed = false;
    for (const x of es) { const want = Math.min(keep.length - 1, layer.get(String(x.from))! + 1); if (want > layer.get(String(x.to))!) { layer.set(String(x.to), want); changed = true; } }
    if (!changed) break;
  }
  const distinct = [...new Set(layer.values())].sort((p, q) => p - q);
  const maxCols = 5;
  const colOf = (n: string) => Math.floor((distinct.indexOf(layer.get(n)!) * Math.min(maxCols, distinct.length)) / distinct.length);
  let columns: string[][] = [];
  for (const m of keep) { const c = colOf(String(m.name)); (columns[c] ??= []).push(String(m.name)); }
  columns = columns.filter(Boolean).flatMap((col) => { const parts: string[][] = []; for (let i = 0; i < col.length; i += 6) parts.push(col.slice(i, i + 6)); return parts; });
  const shapes: Shape[] = [];
  const legendH = 0.45, gh = H - legendH;
  const cw = W / Math.max(1, columns.length);
  const nw = Math.min(2.5, cw - 0.55);
  const pos = new Map<string, { x: number; y: number; w: number; h: number; col: number }>();
  const byName = new Map(keep.map((m) => [String(m.name), m]));
  const disp = new Map<string, any>((a?.dispositions ?? []).map((x: any) => [String(x.module), x.disposition]));
  columns.forEach((col, ci) => {
    const pitch = Math.min(0.95, gh / col.length), nh = Math.min(0.72, pitch - 0.16);
    col.forEach((n, ri) => {
      const x = X0 + ci * cw + (cw - nw) / 2, y = Y0 + (gh - pitch * col.length) / 2 + ri * pitch + (pitch - nh) / 2;
      pos.set(n, { x, y, w: nw, h: nh, col: ci });
    });
  });
  for (const x of es) {
    const s = pos.get(String(x.from))!, d = pos.get(String(x.to))!;
    const dashed = ["read", "write", "event"].includes(String(x.type));
    if (s.col < d.col) shapes.push(arrow(s.x + s.w, s.y + s.h / 2, d.x, d.y + d.h / 2, C.faint, dashed));
    else if (s.col > d.col) shapes.push(arrow(s.x, s.y + s.h / 2, d.x + d.w, d.y + d.h / 2, C.faint, dashed));
    else shapes.push(arrow(s.x + s.w / 2, s.y + (d.y > s.y ? s.h : 0), d.x + d.w / 2, d.y + (d.y > s.y ? 0 : d.h), C.faint, dashed));
  }
  for (const [n, p] of pos) {
    const m = byName.get(n);
    const [fill, line] = dispColor(disp.get(n));
    shapes.push(box(p.x, p.y, p.w, p.h, { geom: "roundRect", fill, line, lineW: 1.25, anchor: "ctr", inset: 0.06, size: 11,
      paras: [P(clip(n, 26), { bold: true, align: "ctr", space: 0 }), P([m?.lines ? `${m.lines} lines` : "", disp.get(n) ? clip(disp.get(n), 14) : ""].filter(Boolean).join(" · ") || clip(m?.kind ?? "", 24), { align: "ctr", size: 9, color: C.muted, space: 1 })] }));
  }
  const used = new Map<string, [string, string]>();
  for (const n of pos.keys()) { const d = disp.get(n); if (d) used.set(clip(d, 18), dispColor(d)); }
  let lx = X0;
  const ly = Y0 + H - 0.32;
  for (const [d, [fill, line]] of [...used].slice(0, 6)) {
    shapes.push(box(lx, ly + 0.04, 0.3, 0.2, { geom: "roundRect", fill, line }), label(lx + 0.38, ly - 0.02, 1.6, 0.32, d, { size: 10, color: C.muted }));
    lx += 2.0;
  }
  shapes.push({ t: "line", x1: lx + 0.1, y1: ly + 0.14, x2: lx + 0.6, y2: ly + 0.14, color: C.faint, arrow: true }, label(lx + 0.7, ly - 0.02, 1.4, 0.32, "depends on", { size: 10, color: C.muted }));
  shapes.push({ t: "line", x1: lx + 2.1, y1: ly + 0.14, x2: lx + 2.6, y2: ly + 0.14, color: C.faint, arrow: true, dash: true }, label(lx + 2.7, ly - 0.02, 2.4, 0.32, "reads / writes / events", { size: 10, color: C.muted }));
  return { shapes, shown: pos.size, total: mods.length, edges: es.length };
}

export function qualityMeters(qa: any[]): Shape[] {
  const out: Shape[] = [];
  const rows = qa.slice(0, 8);
  const pitch = Math.min(0.66, H / Math.max(1, rows.length));
  const lw = 2.9, seg = 0.42, sg = 0.07, mw = 5 * seg + 4 * sg;
  rows.forEach((q, i) => {
    const y = Y0 + i * pitch, bh = Math.min(0.3, pitch * 0.45);
    const name = String(q.name ?? "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
    const r = Number(q.rating);
    const ok = q.rating !== "unavailable" && Number.isFinite(r);
    const col = !ok ? C.faint : r <= 2 ? C.crit : r === 3 ? C.med : C.ok;
    out.push(label(X0, y, lw - 0.15, bh + 0.1, clip(name, 30), { bold: true, size: 12, align: "r" }));
    for (let s = 0; s < 5; s++) out.push(box(X0 + lw + s * (seg + sg), y + 0.05, seg, bh, { geom: "roundRect", fill: ok && s < r ? col : C.panel }));
    out.push(label(X0 + lw + mw + 0.15, y, 1.2, bh + 0.1, ok ? `${r} / 5` : "unavailable", { bold: ok, size: 11, color: ok ? col : C.muted, italic: !ok }));
    const rx = X0 + lw + mw + 1.4;
    out.push(box(rx, y - 0.02, W - (rx - X0), pitch - 0.08, { paras: [P(fit(String(q.rationale ?? ""), W - (rx - X0), pitch - 0.08, 10), { color: C.muted, space: 0 })], size: 10, anchor: "ctr" }));
  });
  return out;
}

// ---------- security ----------

export function securityPosture(sec: Finding[], needsHumanSec: number): Shape[] {
  const out: Shape[] = [];
  const tw = 2.85;
  const urgent = sec.filter((f) => ["Blocker", "Critical", "High"].includes(f.severity)).length;
  const unanimous = sec.filter((f) => (f.votes ?? []).length >= 3 && (f.votes ?? []).every((v) => v.verdict === "confirmed")).length;
  const tiles: [string, string, string][] = [[String(sec.length), "confirmed security findings", C.navy], [String(urgent), "Blocker / Critical / High", urgent ? C.crit : C.ok], [String(unanimous), "confirmed by all 3 lenses", C.indigo], [String(needsHumanSec), "security questions for a human", needsHumanSec ? C.med : C.ok]];
  tiles.forEach(([v, l, c], i) => out.push(...tile(X0, Y0 + i * 1.32, tw, 1.15, v, l, c)));
  const byCat = new Map<string, Finding[]>();
  for (const f of sec) { const k = f.cwe ? categoryOf(f.cwe).name : f.category || "Other"; (byCat.get(k) ?? byCat.set(k, []).get(k)!).push(f); }
  const rows = [...byCat].sort((p, q) => q[1].length - p[1].length || p[0].localeCompare(q[0])).slice(0, 9)
    .map(([k, fs]) => { const worst = SEVERITIES.find((s) => fs.some((f) => f.severity === s)) ?? "Low"; return { label: clip(k, 34), value: fs.length, color: SEV_COLOR[worst]!, note: `${fs.length} · worst ${worst}` }; });
  const x = X0 + tw + 0.5;
  out.push(label(x, Y0 - 0.05, W - tw - 0.5, 0.3, "Confirmed security findings by weakness category (colour = worst severity)", { bold: true, size: 13, color: C.navy }));
  out.push(...hbars(x, Y0 + 0.45, W - tw - 0.5, H - 0.6, rows, { labelW: 3.2 }));
  return out;
}

// ---------- roadmap ----------

export function roadmapLanes(now: Finding[], next: Finding[], later: Finding[]): Shape[] {
  const out: Shape[] = [];
  const gap = 0.3, lw = (W - 2 * gap) / 3;
  const lanes: [string, string, Finding[], string][] = [["NOW", "Blocker · Critical · High", now, C.crit], ["NEXT", "Medium", next, C.med], ["LATER", "Low · Nit", later, C.low]];
  lanes.forEach(([name, sub, fs, col], i) => {
    const x = X0 + i * (lw + gap);
    out.push(box(x, Y0, lw, H, { geom: "roundRect", fill: C.surface, line: C.line, lineW: 0.75 }));
    out.push(box(x, Y0, lw, 0.75, { geom: "roundRect", fill: col, anchor: "ctr", inset: 0.18, size: 16,
      paras: [{ runs: [{ text: name, bold: true, color: C.white }, { text: `   ${fs.length} finding${fs.length === 1 ? "" : "s"}`, color: C.white, size: 12 }], space: 0 }, P(sub, { color: C.white, size: 10, space: 1 })] }));
    const cards = fs.slice(0, 6), ch = 0.66;
    cards.forEach((f, j) => {
      const y = Y0 + 0.95 + j * (ch + 0.1);
      out.push(box(x + 0.15, y, lw - 0.3, ch, { fill: C.white, line: C.line, lineW: 0.75 }), box(x + 0.15, y, 0.06, ch, { fill: SEV_COLOR[f.severity] ?? col }));
      out.push(box(x + 0.3, y + 0.04, lw - 0.55, ch - 0.08, { anchor: "ctr", size: 10, paras: [
        { runs: [{ text: f.id, bold: true, color: C.navy }, { text: `   ${f.severity} · effort ${f.effort}`, color: C.muted, size: 9 }], space: 0 },
        P(clip(f.title, Math.floor((lw - 0.55) * 11)), { space: 1 })] }));
    });
    if (fs.length > cards.length) out.push(label(x + 0.15, Y0 + 0.95 + cards.length * (ch + 0.1), lw - 0.3, 0.32, `+${fs.length - cards.length} more — see the roadmap tables`, { italic: true, size: 10, color: C.muted }));
    if (!fs.length) out.push(label(x + 0.15, Y0 + 1.0, lw - 0.3, 0.4, "Nothing in this lane.", { italic: true, size: 11, color: C.muted, align: "ctr" }));
  });
  return out;
}

export function priorityMatrix(fs: Finding[]): Shape[] {
  const out: Shape[] = [];
  const rows: [string, string[]][] = [["Blocker / Critical", ["Blocker", "Critical"]], ["High", ["High"]], ["Medium", ["Medium"]], ["Low / Nit", ["Low", "Nit"]]];
  const efforts = ["S", "M", "L", "XL"];
  const lw = 1.9, top = Y0 + 0.4, cw = (W - lw) / 4, rh = (H - 0.85) / 4;
  efforts.forEach((ef, j) => out.push(label(X0 + lw + j * cw, Y0, cw, 0.35, `Effort ${ef}`, { bold: true, size: 12, color: C.navy, align: "ctr" })));
  rows.forEach(([name, sevs], i) => {
    const y = top + i * rh;
    out.push(label(X0, y, lw - 0.15, rh, name, { bold: true, size: 12, color: SEV_COLOR[sevs[0]!], align: "r" }));
    efforts.forEach((ef, j) => {
      const cell = fs.filter((f) => sevs.includes(f.severity) && f.effort === ef);
      const quick = i <= 1 && j <= 1;
      out.push(box(X0 + lw + j * cw + 0.04, y + 0.04, cw - 0.08, rh - 0.08, { geom: "roundRect", fill: quick ? C.okSoft : C.surface, line: quick ? C.ok : C.line, lineW: 0.75 }));
      if (quick && cell.length) out.push(label(X0 + lw + j * cw + 0.15, y + 0.08, cw - 0.3, 0.25, "QUICK WIN", { bold: true, size: 8, color: C.ok }));
      const ids = cell.slice(0, 6).map((f) => f.id).join("   ") + (cell.length > 6 ? `   +${cell.length - 6}` : "");
      out.push(box(X0 + lw + j * cw + 0.15, y + 0.3, cw - 0.3, rh - 0.4, { anchor: "ctr", size: 10, paras: [P(ids || "—", { bold: !!cell.length, color: cell.length ? C.ink : C.faint, align: "ctr", space: 0 })] }));
    });
  });
  out.push(label(X0, Y0 + H - 0.4, W, 0.35, "Start top-left: high severity at small effort. Cell contents are finding IDs; details are on the finding slides.", { italic: true, size: 10, color: C.muted }));
  return out;
}

export function nextSteps(top: Finding[], oneThing?: string): Shape[] {
  const out: Shape[] = [];
  let y = Y0;
  if (oneThing) {
    out.push(box(X0, y, W, 1.05, { geom: "roundRect", fill: C.navy, inset: 0.22, anchor: "ctr", size: 15, paras: [P("THE ONE CHANGE THAT MATTERS MOST", { bold: true, color: "5EEAD4", size: 10, space: 0 }), P(fit(oneThing, W - 0.5, 0.6, 15), { color: C.white, space: 3 })] }));
    y += 1.3;
  }
  const n = Math.min(3, top.length);
  if (!n) { out.push(label(X0, y, W, 0.5, "No Blocker, Critical or High findings were confirmed — work through the Next lane of the roadmap.", { size: 14, color: C.muted })); return out; }
  const gap = 0.3, cw = (W - gap * (n - 1)) / n, ch = H - (y - Y0);
  top.slice(0, n).forEach((f, i) => {
    const x = X0 + i * (cw + gap);
    out.push(box(x, y, cw, ch, { geom: "roundRect", fill: C.surface, line: C.line, lineW: 0.75 }));
    out.push(box(x + 0.25, y + 0.25, 0.6, 0.6, { geom: "ellipse", fill: C.accent, anchor: "ctr", size: 18, paras: [P(String(i + 1), { bold: true, color: C.white, align: "ctr", space: 0 })] }));
    out.push(pill(x + 1.05, y + 0.38, 1.2, 0.34, f.severity, SEV_COLOR[f.severity] ?? C.navy));
    out.push(label(x + 0.25, y + 1.0, cw - 0.5, 0.3, `${f.id}  ·  effort ${f.effort}  ·  ${f.dimension}`, { bold: true, size: 11, color: C.muted }));
    out.push(box(x + 0.25, y + 1.35, cw - 0.5, 0.95, { size: 15, paras: [P(fit(f.title, cw - 0.5, 0.95, 15), { bold: true, color: C.navy, space: 0 })] }));
    out.push(box(x + 0.25, y + 2.4, cw - 0.5, ch - 2.55, { size: 12, paras: [P("FIX", { bold: true, color: C.accent, size: 10, space: 0 }), P(fit(f.recommendation, cw - 0.5, ch - 2.9, 12), { space: 3 })] }));
  });
  return out;
}

export function agenda(items: { title: string; slide: number }[]): Shape[] {
  const out: Shape[] = [];
  const pitch = Math.min(0.72, H / Math.max(1, items.length));
  items.forEach((it, i) => {
    const y = Y0 + i * pitch;
    out.push(box(X0, y, 0.52, 0.52, { geom: "ellipse", fill: i % 2 ? C.navy2 : C.navy, anchor: "ctr", size: 14, paras: [P(String(i + 1).padStart(2, "0"), { bold: true, color: C.white, align: "ctr", space: 0 })] }));
    out.push(label(X0 + 0.8, y, 8, 0.52, it.title, { size: 18, bold: true, color: C.ink }));
    out.push(label(X0 + W - 2, y, 2, 0.52, `slide ${it.slide}`, { size: 12, color: C.muted, align: "r" }));
    if (i < items.length - 1) out.push({ t: "line", x1: X0 + 0.8, y1: y + pitch - 0.1, x2: X0 + W, y2: y + pitch - 0.1, color: C.line, w: 0.75 });
  });
  return out;
}

export function hotspotChart(hs: any[]): Shape[] {
  const rows = hs.slice(0, 9).map((h) => ({ label: tailPath(h.file, 36), value: Number(h.score) || 0, color: C.high, note: `${h.churn} × ${h.complexity}` }));
  return hbars(X0, Y0 + 0.1, W, H - 0.6, rows, { labelW: 3.8 });
}

/** Finding detail: severity pill + meta chips, evidence/impact left, fix card right. Returns null if it cannot fit. */
export function findingCanvas(f: Finding, corrections: string[], where: string): Shape[] | null {
  for (const size of [15, 13, 12]) { const r = findingLayout(f, corrections, where, size); if (r) return r; }
  return null;
}

function findingLayout(f: Finding, corrections: string[], where: string, size: number): Shape[] | null {
  const out: Shape[] = [];
  out.push(pill(X0, Y0, 1.25, 0.38, f.severity, SEV_COLOR[f.severity] ?? C.navy, C.white, 11));
  const chips = [`confidence ${f.confidence}`, `effort ${f.effort}`, f.dimension, ...(f.votes?.length ? [`panel ${f.votes.filter((v) => v.verdict === "confirmed").length}/${f.votes.length}`] : []), ...(f.cwe ? [String(f.cwe)] : [])];
  let cx = X0 + 1.4;
  for (const c of chips) { const w = 0.3 + c.length * 0.085; out.push(pill(cx, Y0, w, 0.38, c, C.panel, C.ink, 10)); cx += w + 0.12; }
  out.push(box(X0, Y0 + 0.5, W, 0.36, { anchor: "ctr", size: 12, paras: [{ runs: [{ text: "Where  ", bold: true, color: C.muted }, { text: where, mono: true, color: C.navy }], space: 0 }] }));
  const top = Y0 + 1.05, avail = H - 1.05 - 0.35, lw = 6.6, rx = X0 + lw + 0.4, rw = W - lw - 0.4;
  const section = (title: string, body: string, first: boolean): Para[] => [P(title.toUpperCase(), { bold: true, color: C.accent, size: 10, space: first ? 0 : 12 }), P(body, { space: 3, size })];
  const leftText: [string, string][] = [["Evidence", String(f.evidence ?? "—")], ["Impact", String(f.impact ?? "—")]];
  const rightText: [string, string][] = [["Recommendation", String(f.recommendation ?? "—")], ...(f.exploit_scenario ? [["Exploit scenario", String(f.exploit_scenario)] as [string, string]] : [])];
  const hOf = (items: [string, string][], w: number) => items.reduce((n, [, b]) => n + 0.38 + (textLines(b, w, size) * size * 1.22) / 72, 0);
  const corrH = corrections.length ? 0.5 + corrections.reduce((n, c) => n + (textLines(c, rw - 0.4, 11) * 13.5) / 72, 0) : 0;
  const rightH = hOf(rightText, rw - 0.5) + 0.4;
  if (hOf(leftText, lw) > avail || rightH + corrH + 0.15 > avail) return null;
  out.push(box(X0, top, lw, avail, { paras: leftText.flatMap(([t, b], i) => section(t, b, i === 0)), size }));
  let ry = top;
  if (corrections.length) {
    out.push(box(rx, ry, rw, corrH, { geom: "roundRect", fill: C.critSoft, line: C.crit, lineW: 0.75, inset: 0.15, size: 11,
      paras: [P("⚠ CORRECTED BY VERIFICATION — act on these, not the text below", { bold: true, color: C.crit, size: 9, space: 0 }), ...corrections.map((c) => P(c, { space: 3 }))] }));
    ry += corrH + 0.15;
  }
  const ch = Math.max(1.5, rightH);
  out.push(box(rx, ry, rw, ch, { fill: C.accentSoft, inset: 0.22, size, paras: rightText.flatMap(([t, b], i) => section(t, b, i === 0)) }));
  out.push(box(rx, ry, 0.07, ch, { fill: C.accent }));
  return out;
}
