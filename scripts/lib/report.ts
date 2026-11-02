// renderAll: every report file from the same loaded context, so they reconcile.
// Deterministic: no clock reads; the only timestamps come from REVISION.json.
import { join } from "node:path";
import { redact } from "./redact.ts";
import { counts, loadCtx } from "./report-ctx.ts";
import { analysisMd, roadmapMd } from "./report-md.ts";
import { architectureMd, diagrams } from "./report-arch.ts";
import { reportHtml } from "./report-html.ts";
import { writeText } from "./util.ts";
import { topologyData, topologyHtml } from "./topology-html.ts";

export { loadCtx, rank } from "./report-ctx.ts";

export interface RenderResult {
  written: string[];
  counts: ReturnType<typeof counts>;
  redactions: number;
}

export function renderAll(analysis: string, opts: { pluginVersion?: string } = {}): RenderResult {
  const c = loadCtx(analysis, opts.pluginVersion);
  const out: [string, string][] = [
    ["ROADMAP.md", roadmapMd(c)],
    ["ANALYSIS_REPORT.md", analysisMd(c)],
    ["ARCHITECTURE.md", architectureMd(c)],
    ["REPORT.html", reportHtml(c)],
  ];
  const d = diagrams(c);
  if (c.topology) out.push(["TOPOLOGY.html", topologyHtml(topologyData(c.topology, { name: c.scope?.name ?? "system", findings: c.findings, architecture: c.architecture }))]);
  if (d) out.push(["diagrams/context.mmd", d.context], ["diagrams/modules.mmd", d.modules], ["diagrams/data-lineage.mmd", d.lineage]);
  let redactions = 0;
  const written: string[] = [];
  for (const [rel, text] of out) {
    const r = redact(text); // defence in depth: nothing credential-shaped leaves the renderer
    redactions += r.count;
    const p = join(analysis, rel);
    writeText(p, r.text);
    written.push(p);
  }
  return { written, counts: counts(c), redactions };
}
