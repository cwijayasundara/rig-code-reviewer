// `review.ts digest <name>`: the compact view of the analysis that the prose stages
// (architecture, report) and their agents work from. findings.json, evidence.json and
// topology.json grow with the repository and soon exceed what one Read returns; a stage
// told to read them whole then has to slice them with a script, which the headless
// allowlist denies. Everything here is derived from those files; nothing is recomputed.
import { join } from "node:path";
import { SEV_RANK, type Finding, type Severity } from "./types.ts";
import { readJson } from "./util.ts";

/** Default cap on listed findings per verdict; the rest are counted, never dropped silently. */
export const DIGEST_LIMIT = 150;

type Obj = Record<string, any>;
const one = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

export function digest(analysis: string, opts: { limit?: number } = {}): string {
  const limit = opts.limit ?? DIGEST_LIMIT;
  const ev = readJson<Obj>(join(analysis, "evidence.json"), {});
  const topo = readJson<Obj>(join(analysis, "topology.json"), {});
  const cov = readJson<Obj | null>(join(analysis, "coverage.json"), null);
  const findings = readJson<{ findings?: Finding[] }>(join(analysis, "findings.json"), {}).findings ?? [];
  const L: string[] = [];
  const list = (title: string, rows: string[]) => { if (rows.length) L.push("", `## ${title}`, ...rows); };
  const capped = (rows: string[], what: string) =>
    rows.length > limit ? [...rows.slice(0, limit), `- … ${rows.length - limit} more ${what} (digest --limit N, or Grep findings.json for an id)`] : rows;

  L.push("# Analysis digest");
  if (Object.keys(ev).length) {
    L.push("", "## Evidence", `- files ${ev.total_files ?? "?"} (source ${ev.source_files ?? "?"}, tests ${ev.test_files ?? "?"}) · code lines ${ev.total_code_lines ?? "?"} · functions analysed ${ev.functions_analysed ?? "?"}`);
    const langs = Object.entries((ev.languages ?? {}) as Record<string, { files: number; lines: number }>).sort((a, b) => b[1].lines - a[1].lines);
    if (langs.length) L.push(`- languages: ${langs.map(([l, v]) => `${l} ${v.lines} lines/${v.files} files`).join(" · ")}`);
    if (Array.isArray(ev.manifests) && ev.manifests.length) L.push(`- manifests (${ev.manifests.length}): ${ev.manifests.slice(0, 30).join(", ")}${ev.manifests.length > 30 ? ", …" : ""}`);
    if (ev.churn) L.push(`- churn: ${ev.churn.available ? `${ev.churn.commits} commits over ${ev.churn.months} months, ${ev.churn.files_changed} files changed` : "unavailable"}`);
    list("Top-level directories", (ev.top_level_dirs ?? []).map((d: Obj) => `- ${d.dir} (${d.kind}): ${d.files} files, ${d.sloc} lines`));
    list(`Hotspots (${one(ev.hotspot_formula) || "churn x complexity"})`, (ev.hotspots ?? []).map((h: Obj) => `- ${h.file} score ${h.score} (churn ${h.churn}, complexity ${h.complexity})`));
    list("Most complex files", (ev.complexity_top ?? []).slice(0, 25).map((c: Obj) => `- ${c.file} complexity ${c.complexity}, worst function ${c.max_function}, ${c.functions} functions`));
    list("Largest files", (ev.largest_files ?? []).slice(0, 15).map((f: Obj) => `- ${f.file} ${f.lines} lines`));
    list("Ownership (bus factor)", (ev.ownership ?? []).slice(0, 25).map((o: Obj) => `- ${o.dir}: ${o.authors} authors, bus factor ${o.bus_factor}, top author ${Math.round((o.top_author_share ?? 0) * 100)}%`));
  }

  if (Array.isArray(topo.modules)) {
    list(`Modules (${topo.modules.length})`, topo.modules.map((m: Obj) => `- ${m.name} — ${m.path}${m.kind ? ` (${m.kind})` : ""}${typeof m.lines === "number" ? `, ${m.lines} lines` : ""}${m.description ? `: ${one(m.description).slice(0, 160)}` : ""}`));
    const edges = (topo.edges ?? []) as Obj[];
    list(`Edges (${edges.length})`, capped(edges.map((e) => `- ${e.from} -${e.type}-> ${e.to} (${e.evidence})`), "edges"));
    list("Entry points", capped((topo.entry_points ?? []).map((e: Obj) => `- ${e.name}${e.kind ? ` (${e.kind})` : ""} ${e.file}:${e.line}`), "entry points"));
    list("Data stores", (topo.data_stores ?? []).map((d: Obj) => `- ${d.name}${d.kind ? ` (${d.kind})` : ""} ${d.evidence}`));
    list("Externals", (topo.externals ?? []).map((d: Obj) => `- ${d.name}${d.kind ? ` (${d.kind})` : ""} ${d.evidence}`));
    list("Flows", (topo.flows ?? []).map((f: Obj) => `- ${f.name}: ${(f.steps ?? []).join(" → ")}`));
  }

  if (findings.length) {
    const count = (key: (f: Finding) => string) => {
      const m = new Map<string, number>();
      for (const f of findings) m.set(key(f), (m.get(key(f)) ?? 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" · ");
    };
    L.push("", "## Findings", `- ${findings.length} total · by verdict: ${count((f) => f.accepted ? "accepted" : f.verdict ?? "pending")}`, `- by dimension: ${count((f) => f.dimension)}`);
    const rank = (a: Finding, b: Finding) => SEV_RANK[a.severity as Severity] - SEV_RANK[b.severity as Severity] || a.id.localeCompare(b.id);
    const row = (f: Finding) => `- ${f.id} [${f.severity}] ${f.dimension}${f.cwe ? ` ${f.cwe}` : ""} ${f.file}:${f.line} — ${one(f.title)}`;
    const of = (v: string) => findings.filter((f) => !f.accepted && f.verdict === v).sort(rank);
    list("Confirmed findings", capped(of("confirmed").map(row), "confirmed findings"));
    list("Needs a human", capped(of("needs-human").map((f) => `${row(f)}. Question: ${one(f.verifier_note).slice(0, 300)}`), "needs-human findings"));
    const accepted = findings.filter((f) => f.accepted);
    if (accepted.length) list("Accepted risk (excluded)", capped(accepted.sort(rank).map(row), "accepted findings"));
    const counted = ["refuted", "deferred", "unverified", "pending"].map((v) => [v, findings.filter((f) => !f.accepted && (f.verdict ?? "pending") === v).length] as const).filter(([, n]) => n);
    if (counted.length) L.push("", `Not listed: ${counted.map(([v, n]) => `${v} ${n}`).join(" · ")} (never in the report's roadmap).`);
  }

  if (cov) {
    L.push("", "## Coverage", `- files read by agents: ${cov.files_read} of ${cov.files_total} (${cov.files_read_pct}%)`);
    if (cov.lost_shards?.length) L.push(`- lost shards (${cov.lost_shards.length}): ${cov.lost_shards.slice(0, 40).join(", ")}${cov.lost_shards.length > 40 ? ", …" : ""}`);
    if (cov.deferred_shards?.length) L.push(`- deferred shards (${cov.deferred_shards.length}): ${cov.deferred_shards.slice(0, 40).join(", ")}${cov.deferred_shards.length > 40 ? ", …" : ""}`);
    const sc = cov.scanners ?? {};
    if (sc.failed?.length || sc.missing?.length) L.push(`- scanners failed: ${(sc.failed ?? []).map((s: Obj) => s.id).join(", ") || "none"} · missing: ${(sc.missing ?? []).join(", ") || "none"}`);
  }
  return L.join("\n");
}
