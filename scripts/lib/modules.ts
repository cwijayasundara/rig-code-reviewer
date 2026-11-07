// Deterministic module candidates for the map stage: source directories by
// SLOC, splitting any directory >= SPLIT_LOC into its subdirectories (depth 4)
// so no deep-review agent gets an unbounded tree.
import { join } from "node:path";
import { readJson } from "./util.ts";

export const SPLIT_LOC = 5000;
const SKIP_KINDS = new Set(["vendor", "generated", "docs"]);

interface Ev { files?: string[]; per_file?: { file: string; lines: number }[]; file_sloc?: Record<string, number>; top_level_dirs?: { dir: string; kind?: string }[] }

export function suggestModules(analysis: string): { name: string; path: string; lines: number; files: number }[] {
  const ev = readJson<Ev>(join(analysis, "evidence.json"), {});
  const sloc: Record<string, number> = ev.file_sloc ?? Object.fromEntries((ev.per_file ?? []).map((p) => [p.file, p.lines]));
  const files = (ev.files ?? Object.keys(sloc)).filter((f) => f in sloc || !ev.file_sloc);
  const kinds = new Map((ev.top_level_dirs ?? []).map((d) => [d.dir, d.kind]));
  const out: { name: string; path: string; lines: number; files: number }[] = [];
  const size = (prefix: string) => {
    const fs = files.filter((f) => (prefix ? f.startsWith(prefix + "/") : !f.includes("/")));
    return { files: fs, lines: fs.reduce((n, f) => n + (sloc[f] ?? 0), 0) };
  };
  const visit = (prefix: string, depth: number) => {
    const { files: fs, lines } = size(prefix);
    if (!fs.length) return;
    const subdirs = [...new Set(fs.map((f) => f.slice(prefix.length + 1).split("/")).filter((p) => p.length > 1).map((p) => p[0]!))].sort();
    if (lines >= SPLIT_LOC && depth < 4 && subdirs.length > 1) {
      for (const s of subdirs) visit(`${prefix}/${s}`, depth + 1);
      const direct = fs.filter((f) => !f.slice(prefix.length + 1).includes("/"));
      if (direct.length) out.push({ name: `${prefix}/(files)`.replace(/\//g, "."), path: prefix, lines: direct.reduce((n, f) => n + (sloc[f] ?? 0), 0), files: direct.length });
      return;
    }
    out.push({ name: prefix.replace(/\//g, "."), path: prefix, lines, files: fs.length });
  };
  const tops = [...new Set(files.filter((f) => f.includes("/")).map((f) => f.split("/")[0]!))].sort();
  for (const t of tops) if (!SKIP_KINDS.has(kinds.get(t) ?? "")) visit(t, 1);
  const root = size("");
  if (root.files.length) out.push({ name: "root", path: ".", lines: root.lines, files: root.files.length });
  return out;
}

// Map units: the map stage reads for structure, not defects, so one analyst can
// cover far more code than a reviewer. Candidates are packed into units of at
// least MAP_MIN_LOC (never past MAP_MAX_LOC); a small repo gets one analyst.
export const MAP_MIN_LOC = 8000;
export const MAP_MAX_LOC = 25000;

export function suggestMapUnits(analysis: string): { modules: ReturnType<typeof suggestModules>; units: ReviewUnit[] } {
  const modules = suggestModules(analysis);
  return { modules, units: packUnits(modules, undefined, { min: MAP_MIN_LOC, max: MAP_MAX_LOC }) };
}

// Review units: the topology's modules packed into shards worth one agent each.
// A map may legitimately name a module per file (good for the architecture
// report), but sharding 14 tiny modules x 7 dimensions spends one agent's fixed
// overhead on a 19-line file. Modules are packed in path order (siblings stay
// together) until a unit reaches MIN_UNIT_LOC, never past MAX_UNIT_LOC; a module
// at or above MIN_UNIT_LOC, or of unknown size, is always its own unit.
// Every agent re-pays a fixed start-up cost (system prompt, tools, brief, threat map),
// so agent count, not lines read, dominates a large repository's bill.
export const MIN_UNIT_LOC = 3000;
export const MAX_UNIT_LOC = 8000;
/** Packing of reviews started before 2.2.0: kept so a resume finds its shards under the same keys. */
export const LEGACY_UNIT_LOC: [number, number] = [1500, 4000];

export interface ReviewUnit { name: string; paths: string[]; modules: string[]; lines: number }

/** SLOC under a module path from evidence (authoritative), else the map's own figure; undefined when unknown. */
export function moduleLines(m: { path: string; lines?: number }, sloc: Record<string, number> | undefined): number | undefined {
  if (sloc && m.path !== "." && m.path !== "") {
    const p = m.path.replace(/\/+$/, "");
    let n = 0, hit = false;
    for (const [f, l] of Object.entries(sloc)) if (f === p || f.startsWith(p + "/")) { n += l; hit = true; }
    if (hit) return n;
  }
  return typeof m.lines === "number" && Number.isFinite(m.lines) ? m.lines : undefined;
}

function unitName(ms: string[]): string {
  return ms.length === 1 ? ms[0]! : ms.length <= 3 ? ms.join("+") : `${ms[0]}+${ms.length - 1}-more`;
}

export function packUnits(
  modules: { name: string; path: string; lines?: number }[],
  sloc?: Record<string, number>,
  opts: { min?: number; max?: number } = {},
): ReviewUnit[] {
  const min = opts.min ?? MIN_UNIT_LOC, max = opts.max ?? MAX_UNIT_LOC;
  const sized = modules.map((m) => ({ ...m, size: moduleLines(m, sloc) }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
  type Slot = ReviewUnit & { packed: boolean };
  const units: Slot[] = [];
  let cur: Slot | null = null;
  for (const m of sized) {
    if (m.size === undefined || m.size >= min) {
      if (cur) units.push(cur);
      cur = null;
      units.push({ name: m.name, paths: [m.path], modules: [m.name], lines: m.size ?? 0, packed: false });
      continue;
    }
    if (cur && (cur.lines >= min || cur.lines + m.size > max)) { units.push(cur); cur = null; }
    cur ??= { name: "", paths: [], modules: [], lines: 0, packed: true };
    cur.paths.push(m.path); cur.modules.push(m.name); cur.lines += m.size;
  }
  if (cur) {
    // An undersized last unit joins the previous packed unit when it still fits.
    const prev = units[units.length - 1];
    if (cur.lines < min && prev?.packed && prev.lines + cur.lines <= max) {
      prev.paths.push(...cur.paths); prev.modules.push(...cur.modules); prev.lines += cur.lines;
    } else units.push(cur);
  }
  return units.map(({ packed: _p, ...u }) => ({ ...u, name: u.name || unitName(u.modules) }));
}
