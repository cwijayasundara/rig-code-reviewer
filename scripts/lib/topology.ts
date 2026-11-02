// `merge-topology`: the map stage's codebase-analysts each write one
// fragments/<module>.json in the topology shape; this combines them into
// topology.json. Deterministic work runs in the driver, so a stage never has to
// improvise a merge script (headless stages cannot run one anyway).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { EDGE_TYPES, validateTopology } from "./architecture.ts";
import { moduleLines } from "./modules.ts";
import { readJson, writeJson } from "./util.ts";
import { topologyData, writeTopologyHtml } from "./topology-html.ts";
import { loadScope } from "./paths.ts";

type Obj = Record<string, any>;
const CITE = /\S+:\d+/;
const LISTS = ["modules", "edges", "entry_points", "data_stores", "externals", "flows", "dead_ends", "observations"] as const;

export interface TopologyMerge {
  fragments: number;
  invalid_fragments: string[];
  modules: number;
  duplicate_modules: number;
  edges: number;
  dropped_edges: { missing_from_or_to: number; bad_evidence: number; bad_type: number };
  errors: string[];
  written: boolean;
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v: unknown) => typeof v === "string" && v.trim().length > 0;

/** Keep the first item per key; later duplicates only fill fields the first left empty. */
function dedupe(items: unknown[], key: (o: Obj) => string): { kept: Obj[]; dupes: number } {
  const byKey = new Map<string, Obj>();
  let dupes = 0;
  for (const it of items) {
    if (!isObj(it)) continue;
    const k = key(it);
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, { ...it }); continue; }
    dupes++;
    for (const [f, v] of Object.entries(it)) if (prev[f] === undefined || prev[f] === "") prev[f] = v;
  }
  return { kept: [...byKey.values()], dupes };
}

export function mergeFragments(fragments: unknown[], sloc?: Record<string, number>): { topology: Obj; stats: Omit<TopologyMerge, "fragments" | "invalid_fragments" | "errors" | "written"> } {
  const all: Record<(typeof LISTS)[number], unknown[]> = Object.fromEntries(LISTS.map((k) => [k, []])) as never;
  for (const f of fragments) if (isObj(f)) for (const k of LISTS) if (Array.isArray(f[k])) all[k].push(...f[k]);

  const mods = dedupe(all.modules.filter((m) => isObj(m) && nonEmpty(m.name)), (m) => m.name.trim());
  // Analysts add lines up by hand; evidence.json is authoritative where the path matches.
  for (const m of mods.kept) {
    const n = nonEmpty(m.path) ? moduleLines(m as { path: string; lines?: number }, sloc) : undefined;
    if (n !== undefined) m.lines = n; else delete m.lines;
  }

  const dropped = { missing_from_or_to: 0, bad_evidence: 0, bad_type: 0 };
  const goodEdges = all.edges.filter((e) => {
    if (!isObj(e) || !nonEmpty(e.from) || !nonEmpty(e.to)) { dropped.missing_from_or_to++; return false; }
    if (typeof e.evidence !== "string" || !CITE.test(e.evidence)) { dropped.bad_evidence++; return false; }
    if (!(EDGE_TYPES as readonly string[]).includes(e.type)) { dropped.bad_type++; return false; }
    return true;
  });
  const edges = dedupe(goodEdges, (e) => `${e.from}\0${e.to}\0${e.type}\0${e.evidence}`).kept;

  const topology: Obj = {
    modules: mods.kept,
    edges,
    entry_points: dedupe(all.entry_points, (e) => `${e.name}\0${e.file}\0${e.line}`).kept,
    data_stores: dedupe(all.data_stores, (d) => String(d.name)).kept,
    externals: dedupe(all.externals, (x) => String(x.name)).kept,
    flows: dedupe(all.flows, (f) => String(f.name)).kept,
    dead_ends: dedupe(all.dead_ends, (d) => String(d.name)).kept,
    observations: [...new Set(all.observations.filter((o): o is string => typeof o === "string"))],
  };
  return { topology, stats: { modules: mods.kept.length, duplicate_modules: mods.dupes, edges: edges.length, dropped_edges: dropped } };
}

/** fragments/*.json -> topology.json, written only when the result validates. */
export function mergeTopology(analysis: string): TopologyMerge {
  const dir = join(analysis, "fragments");
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort(); } catch { /* none */ }
  const invalid: string[] = [];
  const frags: unknown[] = [];
  for (const n of names) {
    const f = readJson<unknown>(join(dir, n), undefined);
    if (isObj(f)) frags.push(f); else invalid.push(n);
  }
  const sloc = readJson<{ file_sloc?: Record<string, number> }>(join(analysis, "evidence.json"), {}).file_sloc;
  const { topology, stats } = mergeFragments(frags, sloc);
  const errors = names.length ? validateTopology(topology) : [`no fragments in ${dir} — each codebase-analyst writes fragments/<module>.json`];
  if (!errors.length) {
    writeJson(join(analysis, "topology.json"), topology);
    writeTopologyHtml(analysis, topologyData(topology, { name: loadScope(analysis)?.name ?? "system" }));
  }
  return { fragments: frags.length, invalid_fragments: invalid, ...stats, errors, written: !errors.length };
}
