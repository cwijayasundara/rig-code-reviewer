// Minimal PPTX (Office Open XML) writer, tuned for Google Slides import:
// one blank layout, 16:9, Arial only, and everything drawn as native text boxes,
// shapes, connectors and tables — Google Slides turns imported charts into flat
// images, but native shapes stay editable. Pure: slides -> bytes.
import { zip } from "./zip.ts";

export interface Run { text: string; bold?: boolean; italic?: boolean; color?: string; size?: number; mono?: boolean }
export interface Para { runs: Run[]; bullet?: boolean; level?: 0 | 1; heading?: boolean; align?: "l" | "ctr" | "r"; space?: number }
export type Geom = "rect" | "roundRect" | "ellipse" | "chevron" | "homePlate" | "can";
/** A shape on a canvas slide. Units are inches from the slide's top-left corner. */
export interface Box {
  t: "box"; x: number; y: number; w: number; h: number;
  geom?: Geom; fill?: string; line?: string; lineW?: number;
  paras?: Para[]; size?: number; color?: string; anchor?: "t" | "ctr" | "b"; inset?: number; name?: string;
}
export interface Line { t: "line"; x1: number; y1: number; x2: number; y2: number; color: string; w?: number; arrow?: boolean; dash?: boolean }
export type Shape = Box | Line;
export type Cell = string | { text: string; color?: string; bold?: boolean; fill?: string; mono?: boolean };

interface Head { title: string; kicker?: string }
export type Slide =
  | { kind: "title"; title: string; kicker?: string; subtitle: string[]; stats?: { label: string; value: string; color?: string }[] }
  | { kind: "section"; num: number; title: string; kicker?: string; subtitle?: string }
  | (Head & { kind: "bullets"; paras: Para[]; size: number })
  | (Head & { kind: "table"; head: string[]; rows: Cell[][]; widths: number[]; size: number; caption?: string })
  | (Head & { kind: "canvas"; shapes: Shape[]; caption?: string });

export interface Deck { title: string; footer: string; warning?: string; slides: Slide[] }

/** One palette for every slide: slate neutrals, navy primary, teal accent, severity scale. */
export const C = {
  ink: "1E293B", muted: "64748B", faint: "94A3B8", line: "E2E8F0", surface: "F8FAFC", panel: "F1F5F9",
  navy: "1E3A5F", navy2: "2B4C7E", navyText: "CBD5E1", accent: "0D9488", accentSoft: "E6F4F2", indigo: "4F46E5",
  white: "FFFFFF", crit: "B91C1C", high: "EA580C", med: "CA8A04", low: "2563EB", nit: "64748B", ok: "15803D",
  okSoft: "DCFCE7", warnSoft: "FEF3C7", critSoft: "FEE2E2", lowSoft: "DBEAFE",
};

/** Mix a colour with white: t = 0 → colour, t = 1 → white. */
export function tint(hex: string, t: number): string {
  const n = parseInt(hex, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(c + (255 - c) * Math.max(0, Math.min(1, t))));
  return ch.map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase();
}

const EMU = 914400;
const SLIDE_W = 12192000, SLIDE_H = 6858000; // 13.333in × 7.5in (16:9)
export const SLIDE_W_IN = SLIDE_W / EMU;
/** Body region in inches; the deck builder lays out and paginates against it. */
export const BODY_IN = { x: 0.6, y: 1.5, w: SLIDE_W_IN - 1.2, h: 5.3 };
export const BODY_W_IN = BODY_IN.w;
export const BODY_H_PT = BODY_IN.h * 72;
const FONT = "Arial";
const MONO = "Courier New";
const e = (inches: number) => Math.round(inches * EMU);

/** Estimated wrapped line count for text in a box of the given width (Arial average glyph ≈ 0.55em). */
export function textLines(text: string, widthIn: number, size: number, mono = false): number {
  const cpl = Math.max(6, Math.floor((widthIn * 72) / (size * (mono ? 0.62 : 0.55))));
  return String(text).split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / cpl)), 0);
}

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export function xmlEsc(s: string): string {
  // Strip characters XML 1.0 forbids (control chars), then escape.
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const solid = (hex: string) => `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`;

function run(r: Run, size: number, color: string): string {
  const sz = r.size ?? size;
  const face = r.mono ? MONO : FONT;
  return `<a:r><a:rPr lang="en-US" sz="${Math.round(sz * 100)}"${r.bold ? ' b="1"' : ""}${r.italic ? ' i="1"' : ""} dirty="0">${solid(r.color ?? color)}<a:latin typeface="${face}"/><a:cs typeface="${face}"/></a:rPr><a:t>${xmlEsc(r.text)}</a:t></a:r>`;
}

function para(p: Para, size: number, color: string): string {
  const lvl = p.level ?? 0;
  const sz = p.heading ? size + 2 : size;
  const algn = p.align && p.align !== "l" ? ` algn="${p.align}"` : "";
  const space = `<a:spcBef><a:spcPts val="${Math.round((p.space ?? (p.heading ? 9 : 4)) * 100)}"/></a:spcBef>`;
  const pPr = p.bullet
    ? `<a:pPr marL="${342900 + lvl * 342900}" indent="-342900"${algn}>${space}<a:buClr><a:srgbClr val="${C.accent}"/></a:buClr><a:buFont typeface="${FONT}"/><a:buChar char="${lvl ? "–" : "•"}"/></a:pPr>`
    : `<a:pPr marL="0" indent="0"${algn}>${space}<a:buNone/></a:pPr>`;
  const runs = p.runs.map((r) => run(p.heading ? { ...r, bold: true, color: r.color ?? C.navy } : r, sz, color)).join("");
  return `<a:p>${pPr}${runs}<a:endParaRPr lang="en-US" sz="${Math.round(sz * 100)}" dirty="0"/></a:p>`;
}

/** Plain-text paragraph shorthand. */
export function P(text: string, over: Partial<Para> & Omit<Run, "text"> = {}): Para {
  const { bold, italic, color, size, mono, ...pp } = over;
  return { ...pp, runs: [{ text, bold, italic, color, size, mono }] };
}

class Ids { n = 2; next() { return this.n++; } }

function geomXml(g: Geom): string {
  if (g === "roundRect") return `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 10000"/></a:avLst></a:prstGeom>`;
  return `<a:prstGeom prst="${g}"><a:avLst/></a:prstGeom>`;
}

function boxXml(b: Box, ids: Ids): string {
  const ins = e(b.inset ?? (b.fill || b.line ? 0.08 : 0));
  const fill = b.fill ? solid(b.fill) : "<a:noFill/>";
  const ln = b.line ? `<a:ln w="${Math.round((b.lineW ?? 1) * 12700)}">${solid(b.line)}</a:ln>` : "<a:ln><a:noFill/></a:ln>";
  const paras = b.paras?.length ? b.paras.map((p) => para(p, b.size ?? 12, b.color ?? C.ink)).join("") : `<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${ids.next()}" name="${xmlEsc(b.name ?? (b.paras?.length ? "Text" : "Shape"))}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${e(b.x)}" y="${e(b.y)}"/><a:ext cx="${Math.max(1, e(b.w))}" cy="${Math.max(1, e(b.h))}"/></a:xfrm>${geomXml(b.geom ?? "rect")}${fill}${ln}</p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" lIns="${ins}" tIns="${ins}" rIns="${ins}" bIns="${ins}" anchor="${b.anchor ?? "t"}" rtlCol="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody></p:sp>`;
}

function lineXml(l: Line, ids: Ids): string {
  const flipH = l.x2 < l.x1, flipV = l.y2 < l.y1;
  const x = Math.min(l.x1, l.x2), y = Math.min(l.y1, l.y2);
  return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${ids.next()}" name="Connector"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>` +
    `<p:spPr><a:xfrm${flipH ? ' flipH="1"' : ""}${flipV ? ' flipV="1"' : ""}><a:off x="${e(x)}" y="${e(y)}"/><a:ext cx="${e(Math.abs(l.x2 - l.x1))}" cy="${e(Math.abs(l.y2 - l.y1))}"/></a:xfrm>` +
    `<a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom><a:ln w="${Math.round((l.w ?? 1.25) * 12700)}">${solid(l.color)}${l.dash ? '<a:prstDash val="dash"/>' : ""}${l.arrow ? '<a:tailEnd type="triangle" w="med" len="med"/>' : ""}</a:ln></p:spPr></p:cxnSp>`;
}

function shapesXml(shapes: Shape[], ids: Ids): string {
  return shapes.map((s) => (s.t === "line" ? lineXml(s, ids) : boxXml(s, ids))).join("");
}

function cellXml(c: Cell, size: number, header: boolean, band: boolean): string {
  const o = typeof c === "string" ? { text: c } : c;
  const ln = `<a:lnB w="6350">${solid(C.line)}</a:lnB>`;
  const fill = header ? solid(C.navy) : o.fill ? solid(o.fill) : band ? solid(C.surface) : "<a:noFill/>";
  const ps = String(o.text).split("\n").map((t) => para({ runs: [{ text: t, bold: header || o.bold, mono: o.mono, color: header ? C.white : o.color }], space: 0 }, size, C.ink)).join("");
  return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${ps}</a:txBody><a:tcPr marL="73152" marR="73152" marT="45720" marB="45720" anchor="ctr">${ln}${fill}</a:tcPr></a:tc>`;
}

export function rowHeightPt(size: number): number { return size * 1.2 + 7.2; }

function tableXml(s: Extract<Slide, { kind: "table" }>, y: number, h: number, ids: Ids): string {
  const total = s.widths.reduce((a, b) => a + b, 0) || 1;
  const cols = s.widths.map((w) => Math.floor((e(BODY_IN.w) * w) / total));
  const rowH = Math.round((rowHeightPt(s.size) / 72) * EMU);
  const tr = (cells: Cell[], header: boolean, i: number) => `<a:tr h="${rowH}">${cells.map((c) => cellXml(c, s.size, header, !header && i % 2 === 1)).join("")}</a:tr>`;
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${ids.next()}" name="Table"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="${e(BODY_IN.x)}" y="${e(y)}"/><a:ext cx="${cols.reduce((a, b) => a + b, 0)}" cy="${Math.min(e(h), rowH * (s.rows.length + 1))}"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${cols.map((w) => `<a:gridCol w="${w}"/>`).join("")}</a:tblGrid>` +
    tr(s.head, true, 0) + s.rows.map((r, i) => tr(s.head.map((_, j) => r[j] ?? ""), false, i)).join("") +
    `</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

function header(title: string, kicker: string | undefined): Shape[] {
  const out: Shape[] = [];
  if (kicker) out.push(
    { t: "box", x: BODY_IN.x, y: 0.42, w: 0.08, h: 0.2, fill: C.accent },
    { t: "box", x: BODY_IN.x + 0.18, y: 0.36, w: 9, h: 0.32, paras: [P(kicker.toUpperCase(), { bold: true, color: C.accent, space: 0 })], size: 11, anchor: "ctr", name: "Kicker" });
  const size = title.length > 60 ? 20 : title.length > 45 ? 24 : 28;
  out.push({ t: "box", x: BODY_IN.x, y: 0.68, w: BODY_IN.w, h: 0.72, paras: [P(title, { bold: true, color: C.navy, space: 0 })], size, anchor: "ctr", name: "Title" });
  return out;
}

function footer(deck: Deck, n: number, total: number, dark: boolean): Shape[] {
  const color = dark ? C.navyText : C.muted;
  const runs: Run[] = [{ text: deck.footer }];
  if (deck.warning) runs.push({ text: `   ${deck.warning}`, bold: true, color: dark ? C.white : C.crit });
  const out: Shape[] = [];
  if (!dark) out.push({ t: "line", x1: BODY_IN.x, y1: 7.0, x2: BODY_IN.x + BODY_IN.w, y2: 7.0, color: C.line, w: 0.75 });
  out.push({ t: "box", x: BODY_IN.x, y: 7.05, w: BODY_IN.w - 1.2, h: 0.3, paras: [{ runs, space: 0 }], size: 9, color, anchor: "ctr", name: "Footer" },
    { t: "box", x: BODY_IN.x + BODY_IN.w - 1.2, y: 7.05, w: 1.2, h: 0.3, paras: [P(`${n} / ${total}`, { align: "r", space: 0 })], size: 9, color, anchor: "ctr", name: "Page" });
  return out;
}

function slideXml(deck: Deck, s: Slide, n: number, total: number): string {
  const ids = new Ids();
  let bg = "";
  let shapes: Shape[] = [];
  let extra = "";
  const dark = s.kind === "title" || s.kind === "section";
  if (dark) bg = `<p:bg><p:bgPr>${solid(C.navy)}<a:effectLst/></p:bgPr></p:bg>`;
  if (s.kind === "title") {
    const stats = s.stats ?? [];
    const textW = stats.length ? 7.4 : 11.5;
    shapes.push({ t: "box", x: 0, y: 0, w: 0.22, h: 7.5, fill: C.accent },
      { t: "box", x: 0.9, y: 1.55, w: textW, h: 0.4, paras: [P((s.kicker ?? "Code review").toUpperCase(), { bold: true, color: C.accent })], size: 13 },
      { t: "box", x: 0.9, y: 2.0, w: textW, h: 1.9, paras: [P(s.title, { bold: true, color: C.white })], size: s.title.length > 40 ? 34 : 40, anchor: "b", name: "Title" },
      { t: "box", x: 0.9, y: 4.1, w: 1.4, h: 0.06, fill: C.accent },
      { t: "box", x: 0.9, y: 4.35, w: textW, h: 2.2, paras: s.subtitle.map((t, i) => P(t, { color: i ? C.navyText : C.white, size: i ? 13 : 17, space: 6 })), size: 14 });
    stats.forEach((st, i) => {
      const y = 1.55 + i * 1.65;
      shapes.push({ t: "box", x: 8.9, y, w: 3.75, h: 1.4, geom: "roundRect", fill: C.navy2, inset: 0.2, anchor: "ctr",
        paras: [P(st.value, { bold: true, size: 34, color: st.color ?? C.white, space: 0 }), P(st.label, { size: 12, color: C.navyText, space: 2 })] });
    });
  } else if (s.kind === "section") {
    shapes.push({ t: "box", x: 0, y: 0, w: 0.22, h: 7.5, fill: C.accent },
      { t: "box", x: 0.9, y: 1.6, w: 4, h: 1.3, paras: [P(String(s.num).padStart(2, "0"), { bold: true, color: C.accent })], size: 66, anchor: "b" },
      { t: "box", x: 0.9, y: 3.0, w: 11.5, h: 1.2, paras: [P(s.title, { bold: true, color: C.white })], size: 40, anchor: "t", name: "Section" },
      { t: "box", x: 0.9, y: 4.3, w: 1.4, h: 0.06, fill: C.accent });
    if (s.subtitle) shapes.push({ t: "box", x: 0.9, y: 4.6, w: 11, h: 1.4, paras: [P(s.subtitle, { color: C.navyText })], size: 18 });
  } else {
    shapes.push(...header(s.title, s.kicker));
    if (s.kind === "bullets") {
      shapes.push({ t: "box", ...BODY_IN, paras: s.paras, size: s.size, name: "Body" });
    } else if (s.kind === "canvas") {
      shapes.push(...s.shapes);
      if (s.caption) shapes.push({ t: "box", x: BODY_IN.x, y: 6.6, w: BODY_IN.w, h: 0.32, paras: [P(s.caption, { italic: true, color: C.muted })], size: 10, anchor: "b", name: "Caption" });
    } else {
      let y = BODY_IN.y, h = BODY_IN.h;
      if (s.caption) {
        shapes.push({ t: "box", x: BODY_IN.x, y, w: BODY_IN.w, h: 0.36, paras: [P(s.caption, { color: C.muted })], size: 12, name: "Caption" });
        y += 0.45; h -= 0.45;
      }
      extra = tableXml(s, y, h, ids);
    }
  }
  shapes.push(...footer(deck, n, total, dark));
  return XML + `<p:sld ${NS}><p:cSld>${bg}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
    shapesXml(shapes, ids) + extra + `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

const THEME = XML + `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Review"><a:themeElements>` +
  `<a:clrScheme name="Review"><a:dk1><a:srgbClr val="${C.ink}"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="${C.navy}"/></a:dk2><a:lt2><a:srgbClr val="${C.panel}"/></a:lt2>` +
  `<a:accent1><a:srgbClr val="${C.navy}"/></a:accent1><a:accent2><a:srgbClr val="${C.accent}"/></a:accent2><a:accent3><a:srgbClr val="${C.low}"/></a:accent3><a:accent4><a:srgbClr val="${C.med}"/></a:accent4><a:accent5><a:srgbClr val="${C.crit}"/></a:accent5><a:accent6><a:srgbClr val="${C.muted}"/></a:accent6>` +
  `<a:hlink><a:srgbClr val="${C.low}"/></a:hlink><a:folHlink><a:srgbClr val="${C.muted}"/></a:folHlink></a:clrScheme>` +
  `<a:fontScheme name="Review"><a:majorFont><a:latin typeface="${FONT}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${FONT}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>` +
  `<a:fmtScheme name="Review"><a:fillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:fillStyleLst>` +
  `<a:lnStyleLst>${[6350, 12700, 19050].map((w) => `<a:ln w="${w}"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>`).join("")}</a:lnStyleLst>` +
  `<a:effectStyleLst>${"<a:effectStyle><a:effectLst/></a:effectStyle>".repeat(3)}</a:effectStyleLst>` +
  `<a:bgFillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:bgFillStyleLst></a:fmtScheme>` +
  `</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;

const EMPTY_TREE = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree>';
const MASTER = XML + `<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>${EMPTY_TREE}</p:cSld>` +
  `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
  `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`;
const LAYOUT = XML + `<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank">${EMPTY_TREE}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
function rels(list: [id: string, type: string, target: string][]): string {
  return XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type.startsWith("http") ? type : `${REL}/${type}`}" Target="${target}"/>`).join("") + `</Relationships>`;
}

/** Build the .pptx package. Deterministic: same deck, same bytes. */
export function buildPptx(deck: Deck): Buffer {
  const n = deck.slides.length;
  const ct = "application/vnd.openxmlformats-officedocument.presentationml";
  const types = XML + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/ppt/presentation.xml" ContentType="${ct}.presentation.main+xml"/>` +
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${ct}.slideMaster+xml"/>` +
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${ct}.slideLayout+xml"/>` +
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
    deck.slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="${ct}.slide+xml"/>`).join("") +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const presentation = XML + `<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
    `<p:sldIdLst>${deck.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`).join("")}</p:sldIdLst>` +
    `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  const core = XML + `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlEsc(deck.title)}</dc:title><dc:creator>code-review-harness</dc:creator></cp:coreProperties>`;
  const app = XML + `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>code-review-harness</Application><Slides>${n}</Slides></Properties>`;
  return zip([
    ["[Content_Types].xml", types],
    ["_rels/.rels", rels([["rId1", "officeDocument", "ppt/presentation.xml"],
      ["rId2", "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", "docProps/core.xml"],
      ["rId3", "extended-properties", "docProps/app.xml"]])],
    ["docProps/core.xml", core],
    ["docProps/app.xml", app],
    ["ppt/presentation.xml", presentation],
    ["ppt/_rels/presentation.xml.rels", rels([["rId1", "slideMaster", "slideMasters/slideMaster1.xml"], ["rId2", "theme", "theme/theme1.xml"],
      ...deck.slides.map((_, i) => [`rId${i + 3}`, "slide", `slides/slide${i + 1}.xml`] as [string, string, string])])],
    ["ppt/theme/theme1.xml", THEME],
    ["ppt/slideMasters/slideMaster1.xml", MASTER],
    ["ppt/slideMasters/_rels/slideMaster1.xml.rels", rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"], ["rId2", "theme", "../theme/theme1.xml"]])],
    ["ppt/slideLayouts/slideLayout1.xml", LAYOUT],
    ["ppt/slideLayouts/_rels/slideLayout1.xml.rels", rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]])],
    ...deck.slides.flatMap((s, i): [string, string][] => [
      [`ppt/slides/slide${i + 1}.xml`, slideXml(deck, s, i + 1, n)],
      [`ppt/slides/_rels/slide${i + 1}.xml.rels`, rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]])],
    ]),
  ]);
}
