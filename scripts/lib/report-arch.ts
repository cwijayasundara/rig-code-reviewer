// ARCHITECTURE.md renderer + diagram texts (pure: Ctx -> strings).
import { contextMermaid, lineageMermaid, modulesMermaid } from "./architecture.ts";
import type { Ctx } from "./report-ctx.ts";
import { cell, missing, table } from "./report-ctx.ts";

export interface Diagrams { context: string; modules: string; lineage: string; dropped: number }

export function diagrams(c: Ctx): Diagrams | null {
  const t = c.topology;
  if (!t) return null;
  const m = modulesMermaid(t);
  return { context: contextMermaid(t, c.scope?.name ?? "system"), modules: m.text, lineage: lineageMermaid(t), dropped: m.dropped };
}

function cites(list: unknown): string {
  return Array.isArray(list) && list.length ? list.map((e) => `\`${cell(e)}\``).join(", ") : "—";
}

function fence(text: string): string[] {
  return ["```mermaid", text.trimEnd(), "```", ""];
}

export function architectureMd(c: Ctx): string {
  const t = c.topology, a = c.architecture, ev = c.evidence;
  const d = diagrams(c);
  const disp = new Map<string, any>((a?.dispositions ?? []).map((x: any) => [String(x.module), x]));
  const L = [`# Architecture — ${c.scope?.name ?? "review"}`, "",
    "Rendered by `review.ts render` from `topology.json` (map stage) and `architecture.json` (architecture stage). Every rating, decision and disposition cites `file:line`; unsupported ratings are shown as *unavailable*.", ""];
  if (c.revision?.stale === true) L.push("> **STALE:** the code changed after the scan.", "");

  L.push("## 1. Summary & style", "");
  if (a) L.push(`**Style:** ${cell(a.style)}`, "", String(a.summary ?? "").trim(), "");
  else L.push(missing("architecture"), "");

  L.push("## 2. System context", "");
  if (d) L.push(...fence(d.context)); else L.push(missing("map"), "");
  if (t) {
    if ((t.entry_points ?? []).length) L.push(...table(["Entry point", "Kind", "Location"], t.entry_points.map((e: any) => [e.name, e.kind, `${e.file}:${e.line}`])), "");
    if ((t.externals ?? []).length) L.push(...table(["External system", "Kind", "Evidence"], t.externals.map((e: any) => [e.name, e.kind, e.evidence])), "");
  }

  L.push("## 3. Containers / modules", "");
  if (t?.modules?.length) L.push(...table(["Module", "Path", "Lines", "Kind", "Description", "Disposition"],
    t.modules.map((m: any) => [m.name, m.path, m.lines, m.kind, m.description, disp.get(String(m.name))?.disposition])), "");
  else L.push(missing("map"), "");

  L.push("## 4. Dependency map", "");
  if (d) {
    L.push(...fence(d.modules));
    if (d.dropped > 0) L.push(`_${d.dropped} lower-degree edge(s) omitted from the diagram (limit 60); all edges remain in \`topology.json\`._`, "");
  } else L.push(missing("map"), "");

  L.push("## 5. Data stores & lineage", "");
  if (d) {
    L.push(...fence(d.lineage));
    if ((t?.data_stores ?? []).length) L.push(...table(["Store", "Kind", "Evidence"], t!.data_stores.map((s: any) => [s.name, s.kind, s.evidence])), "");
  } else L.push(missing("map"), "");

  L.push("## 6. Key flows", "");
  if ((t?.flows ?? []).length) for (const f of t!.flows) {
    L.push(`### ${cell(f.name)}`, "", ...(f.steps ?? []).map((s: string, i: number) => `${i + 1}. ${cell(s)}`), "", `Evidence: ${cites(f.evidence)}`, "");
  } else L.push(t ? "_No flows traced._" : missing("map"), "");

  L.push("## 7. Quality attributes (ISO 25010)", "");
  if ((a?.quality_attributes ?? []).length) L.push(...table(["Attribute", "Rating", "Rationale", "Evidence"],
    a!.quality_attributes.map((q: any) => [q.name, q.rating === "unavailable" ? "unavailable" : `${q.rating}/5`, q.rationale, cites(q.evidence)])), "",
    "Ratings are evidence-anchored judgments (1 = poor, 5 = strong), not measurements. No composite score is computed.", "");
  else L.push(a ? "_No quality attributes rated._" : missing("architecture"), "");

  L.push("## 8. Reconstructed decisions", "");
  if ((a?.decisions ?? []).length) a!.decisions.forEach((x: any, i: number) => {
    L.push(`### ADR-R${String(i + 1).padStart(2, "0")}: ${cell(x.title)}`, "", `- **Context:** ${cell(x.context)}`, `- **Decision (as implemented):** ${cell(x.decision)}`,
      `- **Consequences:** ${cell(x.consequences)}`, `- **Evidence:** ${cites(x.evidence)}`, "");
  });
  else L.push(a ? "_No decisions reconstructed._" : missing("architecture"), "");

  L.push("## 9. Hotspots & ownership", "");
  if (ev) {
    if ((ev.hotspots ?? []).length) L.push(`Formula: ${cell(ev.hotspot_formula ?? "churn × complexity")}`, "", ...table(["File", "Churn", "Complexity", "Score"], ev.hotspots.slice(0, 10).map((h: any) => [h.file, h.churn, h.complexity, h.score])), "");
    else L.push("_No hotspots (no git history or no churn)._", "");
    if ((ev.ownership ?? []).length) L.push(...table(["Directory", "Authors", "Top author share", "Bus factor"], ev.ownership.map((o: any) => [o.dir, o.authors, o.top_author_share, o.bus_factor])), "");
  } else L.push(missing("assess"), "");

  L.push("## 10. Module dispositions", "");
  if ((a?.dispositions ?? []).length) L.push(...table(["Module", "Disposition", "Rationale", "Evidence"], a!.dispositions.map((x: any) => [x.module, x.disposition, x.rationale, cites(x.evidence)])), "");
  else L.push(a ? "_No dispositions given._" : missing("architecture"), "");

  L.push("## 11. Risks", "");
  if ((a?.risks ?? []).length) L.push(...table(["Risk", "Findings", "Evidence"], a!.risks.map((r: any) => [r.title, (r.finding_ids ?? []).join(", "), cites(r.evidence)])), "");
  else L.push(a ? "_No architectural risks listed._" : missing("architecture"), "");

  L.push("## 12. Dead ends & observations", "");
  const de = t?.dead_ends ?? [];
  if (de.length) L.push(...table(["Dead end", "Reason", "Evidence"], de.map((x: any) => [x.name, x.reason, x.evidence])), "");
  if ((t?.observations ?? []).length) L.push(...t!.observations.map((o: string) => `- ${cell(o)}`), "");
  if (!de.length && !(t?.observations ?? []).length) L.push(t ? "_None recorded._" : missing("map"), "");

  L.push("## 13. Open questions & gaps", "");
  const q: string[] = [];
  if (!t) q.push("- Topology not mapped.");
  if (!a) q.push("- Architecture stage not run.");
  for (const x of a?.quality_attributes ?? []) if (x.rating === "unavailable") q.push(`- ${cell(x.name)}: not enough evidence to rate.`);
  for (const f of c.needsHuman.filter((f) => f.dimension === "architecture" || f.dimension === "data")) q.push(`- ${f.id}: ${cell(f.verifier_note ?? f.title)}`);
  if (d && d.dropped > 0) q.push(`- Dependency diagram truncated (${d.dropped} edges omitted).`);
  L.push(...(q.length ? q : ["_None._"]), "");
  return L.join("\n");
}
