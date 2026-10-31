// Topology / architecture validation and Mermaid generation.
// Models write topology.json + architecture.json; these validators decide
// whether they are evidence-backed enough to render.

export const EDGE_TYPES = ["call", "dispatch", "read", "write", "import", "http", "event"] as const;
export const QUALITY_ATTRIBUTES = [
  "functional_suitability", "performance_efficiency", "compatibility", "usability",
  "reliability", "security", "maintainability", "portability",
] as const;
export const DISPOSITIONS = ["retain", "refactor", "rearchitect", "rebuild", "replace", "retire"] as const;

const CITE = /\S+:\d+/;

type Obj = Record<string, any>;

function isObj(v: unknown): v is Obj { return !!v && typeof v === "object" && !Array.isArray(v); }
function arr(v: unknown): any[] { return Array.isArray(v) ? v : []; }
function cited(list: unknown): boolean { return arr(list).some((e) => typeof e === "string" && CITE.test(e)); }
function nonEmpty(v: unknown): boolean { return typeof v === "string" && v.trim().length > 0; }

export function validateTopology(t: unknown): string[] {
  const errs: string[] = [];
  if (!isObj(t)) return ["topology: must be an object"];
  if (!Array.isArray(t.modules) || t.modules.length === 0) errs.push("topology.modules: non-empty array required");
  const names = new Set<string>();
  arr(t.modules).forEach((m, i) => {
    if (!isObj(m)) { errs.push(`modules[${i}]: must be an object`); return; }
    if (!nonEmpty(m.name)) errs.push(`modules[${i}]: name required`);
    if (!nonEmpty(m.path)) errs.push(`modules[${i}] (${m.name ?? "?"}): path required`);
    if (m.lines !== undefined && (typeof m.lines !== "number" || m.lines < 0)) errs.push(`modules[${i}]: lines must be a non-negative number`);
    if (nonEmpty(m.name)) names.add(m.name);
  });
  arr(t.edges).forEach((e, i) => {
    if (!isObj(e)) { errs.push(`edges[${i}]: must be an object`); return; }
    if (!nonEmpty(e.from) || !nonEmpty(e.to)) errs.push(`edges[${i}]: from and to required`);
    if (!(EDGE_TYPES as readonly string[]).includes(e.type)) errs.push(`edges[${i}]: unknown type ${JSON.stringify(e.type)} (allowed: ${EDGE_TYPES.join(", ")})`);
    if (typeof e.evidence !== "string" || !CITE.test(e.evidence)) errs.push(`edges[${i}] (${e.from}->${e.to}): evidence must cite file:line`);
  });
  arr(t.entry_points).forEach((e, i) => {
    if (!isObj(e) || !nonEmpty(e.name) || !nonEmpty(e.file)) errs.push(`entry_points[${i}]: name and file required`);
    else if (typeof e.line !== "number" || e.line < 1) errs.push(`entry_points[${i}] (${e.name}): line must be a positive integer`);
  });
  for (const key of ["data_stores", "externals"] as const) {
    arr(t[key]).forEach((d, i) => {
      if (!isObj(d) || !nonEmpty(d.name)) errs.push(`${key}[${i}]: name required`);
      else if (typeof d.evidence !== "string" || !CITE.test(d.evidence)) errs.push(`${key}[${i}] (${d.name}): evidence must cite file:line`);
    });
  }
  arr(t.flows).forEach((f, i) => {
    if (!isObj(f) || !nonEmpty(f.name) || !Array.isArray(f.steps)) errs.push(`flows[${i}]: name and steps[] required`);
    else if (!cited(f.evidence)) errs.push(`flows[${i}] (${f.name}): evidence needs at least one file:line`);
  });
  if (t.observations !== undefined && !Array.isArray(t.observations)) errs.push("observations: must be an array of strings");
  return errs;
}

export function validateArchitecture(a: unknown): string[] {
  const errs: string[] = [];
  if (!isObj(a)) return ["architecture: must be an object"];
  if (!nonEmpty(a.summary)) errs.push("summary: required");
  if (!nonEmpty(a.style)) errs.push("style: required");
  arr(a.quality_attributes).forEach((q, i) => {
    if (!isObj(q)) { errs.push(`quality_attributes[${i}]: must be an object`); return; }
    if (!(QUALITY_ATTRIBUTES as readonly string[]).includes(q.name)) errs.push(`quality_attributes[${i}]: unknown name ${JSON.stringify(q.name)} (ISO 25010: ${QUALITY_ATTRIBUTES.join(", ")})`);
    if (q.rating === "unavailable") return;
    if (typeof q.rating !== "number" || !Number.isInteger(q.rating) || q.rating < 1 || q.rating > 5) {
      errs.push(`quality_attributes[${i}] (${q.name}): rating must be an integer 1..5 or "unavailable"`);
    } else if (!cited(q.evidence)) {
      errs.push(`quality_attributes[${i}] (${q.name}): a numeric rating needs file:line evidence — cite it or use "unavailable"`);
    }
  });
  arr(a.decisions).forEach((d, i) => {
    if (!isObj(d) || !nonEmpty(d.title) || !nonEmpty(d.decision)) errs.push(`decisions[${i}]: title and decision required`);
    else if (!cited(d.evidence)) errs.push(`decisions[${i}] (${d.title}): evidence needs at least one file:line`);
  });
  arr(a.dispositions).forEach((d, i) => {
    if (!isObj(d) || !nonEmpty(d.module)) { errs.push(`dispositions[${i}]: module required`); return; }
    if (!(DISPOSITIONS as readonly string[]).includes(d.disposition)) errs.push(`dispositions[${i}] (${d.module}): unknown disposition ${JSON.stringify(d.disposition)} (allowed: ${DISPOSITIONS.join(", ")})`);
    if (!cited(d.evidence)) errs.push(`dispositions[${i}] (${d.module}): evidence needs at least one file:line`);
  });
  arr(a.risks).forEach((r, i) => {
    if (!isObj(r) || !nonEmpty(r.title)) errs.push(`risks[${i}]: title required`);
    else if (!cited(r.evidence) && arr(r.finding_ids).length === 0) errs.push(`risks[${i}] (${r.title}): needs file:line evidence or finding_ids`);
  });
  return errs;
}

// ---------- Mermaid ----------

export function mermaidId(s: string): string {
  const id = String(s).replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(id) ? id : `n_${id}`;
}

export function mermaidLabel(s: string): string {
  return String(s).replace(/"/g, "#quot;").replace(/[[\]{}()<>|]/g, " ").replace(/\s+/g, " ").trim() || "?";
}

export const MAX_EDGES = 60;

/** Module dependency graph; keeps the edges touching the highest-degree nodes. */
export function modulesMermaid(t: Obj): { text: string; dropped: number } {
  const edges = arr(t.edges).filter((e) => isObj(e) && nonEmpty(e.from) && nonEmpty(e.to));
  const degree = new Map<string, number>();
  for (const e of edges) for (const n of [e.from, e.to]) degree.set(n, (degree.get(n) ?? 0) + 1);
  const score = (e: Obj) => (degree.get(e.from) ?? 0) + (degree.get(e.to) ?? 0);
  const ranked = edges.map((e, i) => ({ e, i })).sort((a, b) => score(b.e) - score(a.e) || a.i - b.i);
  const kept = ranked.slice(0, MAX_EDGES).sort((a, b) => a.i - b.i).map((x) => x.e);
  const L = ["graph LR"];
  for (const m of arr(t.modules)) if (isObj(m) && nonEmpty(m.name)) L.push(`  ${mermaidId(m.name)}["${mermaidLabel(m.name)}"]`);
  for (const e of kept) L.push(`  ${mermaidId(e.from)} -->|${mermaidLabel(e.type ?? "")}| ${mermaidId(e.to)}`);
  return { text: L.join("\n") + "\n", dropped: edges.length - kept.length };
}

/** C4-style context: entry points -> system -> externals / data stores. */
export function contextMermaid(t: Obj, systemName: string): string {
  const sys = mermaidId(`sys_${systemName}`);
  const L = ["graph LR", `  ${sys}[["${mermaidLabel(systemName)}"]]`];
  for (const e of arr(t.entry_points)) if (isObj(e) && nonEmpty(e.name)) {
    const id = mermaidId(`ep_${e.name}`);
    L.push(`  ${id}(["${mermaidLabel(`${e.name}${e.kind ? ` (${e.kind})` : ""}`)}"]) --> ${sys}`);
  }
  for (const x of arr(t.externals)) if (isObj(x) && nonEmpty(x.name)) {
    L.push(`  ${sys} --> ${mermaidId(`ext_${x.name}`)}["${mermaidLabel(`${x.name}${x.kind ? ` (${x.kind})` : ""}`)}"]`);
  }
  for (const d of arr(t.data_stores)) if (isObj(d) && nonEmpty(d.name)) {
    L.push(`  ${sys} --> ${mermaidId(`ds_${d.name}`)}[("${mermaidLabel(d.name)}")]`);
  }
  return L.join("\n") + "\n";
}

/** Data lineage: read/write edges between modules and data stores. */
export function lineageMermaid(t: Obj): string {
  const stores = new Set(arr(t.data_stores).filter(isObj).map((d) => d.name));
  const L = ["graph LR"];
  for (const d of stores) L.push(`  ${mermaidId(`ds_${d}`)}[("${mermaidLabel(d)}")]`);
  const id = (n: string) => (stores.has(n) ? mermaidId(`ds_${n}`) : mermaidId(n));
  let n = 0;
  for (const e of arr(t.edges)) {
    if (!isObj(e) || (e.type !== "read" && e.type !== "write")) continue;
    n++;
    if (e.type === "write") L.push(`  ${id(e.from)} -->|write| ${id(e.to)}`);
    else L.push(`  ${id(e.to)} -.->|read| ${id(e.from)}`);
  }
  if (n === 0 && stores.size === 0) L.push(`  none["no data stores or read/write edges mapped"]`);
  return L.join("\n") + "\n";
}
