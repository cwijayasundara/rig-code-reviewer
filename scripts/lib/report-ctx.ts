// Loading + shared helpers for the deterministic renderers.
// Every count in a report comes from here; models never type a number.
import { join } from "node:path";
import type { Finding, Scope } from "./types.ts";
import { CONF_RANK, EFFORT_RANK, SEV_RANK } from "./types.ts";
import { readJson, readText } from "./util.ts";

type Obj = Record<string, any>;

export interface Ctx {
  analysis: string;
  scope: Scope | null;
  evidence: Obj | null;
  scanners: Obj[] | null;
  topology: Obj | null;
  architecture: Obj | null;
  coverage: Obj | null;
  revision: Obj | null;
  diff: Obj | null;
  threatModel: string | null;
  assessment: string | null;
  notes: string | null;
  findings: Finding[];
  confirmed: Finding[];   // confirmed, not accepted, ranked
  accepted: Finding[];
  needsHuman: Finding[];
  refuted: Finding[];
  deferred: Finding[];
  pending: Finding[];
  pluginVersion: string;
}

export function rank(a: Finding, b: Finding): number {
  return (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9)
    || (CONF_RANK[a.confidence] ?? 9) - (CONF_RANK[b.confidence] ?? 9)
    || (EFFORT_RANK[a.effort] ?? 9) - (EFFORT_RANK[b.effort] ?? 9)
    || String(a.id).localeCompare(String(b.id));
}

function obj(p: string): Obj | null {
  const v = readJson<unknown>(p, null);
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

export function loadCtx(analysis: string, pluginVersion = "2.0.0"): Ctx {
  const fj = readJson<unknown>(join(analysis, "findings.json"), null);
  const list: Finding[] = Array.isArray(fj) ? fj : Array.isArray((fj as Obj | null)?.findings) ? (fj as Obj).findings : [];
  const findings = list.filter((f) => f && typeof f === "object").slice().sort(rank);
  const st = readJson<unknown>(join(analysis, "scanners", "status.json"), null);
  const by = (v: string | undefined) => findings.filter((f) => f.verdict === v);
  const confirmedAll = by("confirmed");
  return {
    analysis,
    scope: obj(join(analysis, "scope.json")) as Scope | null,
    evidence: obj(join(analysis, "evidence.json")),
    scanners: Array.isArray(st) ? (st as Obj[]) : null,
    topology: obj(join(analysis, "topology.json")),
    architecture: obj(join(analysis, "architecture.json")),
    coverage: obj(join(analysis, "coverage.json")),
    revision: obj(join(analysis, "REVISION.json")),
    diff: obj(join(analysis, "diff.json")),
    threatModel: readText(join(analysis, "THREAT_MODEL.md")),
    assessment: readText(join(analysis, "ASSESSMENT.md")),
    notes: readText(join(analysis, "ANALYSIS_NOTES.md")),
    findings,
    confirmed: confirmedAll.filter((f) => !f.accepted),
    accepted: findings.filter((f) => !!f.accepted),
    needsHuman: by("needs-human").filter((f) => !f.accepted),
    refuted: by("refuted"),
    deferred: by("deferred"),
    pending: findings.filter((f) => !f.verdict),
    pluginVersion,
  };
}

// ---------- markdown helpers ----------

/** Escape a value for a markdown table cell. */
export function cell(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  return String(v).replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

export function table(head: string[], rows: unknown[][]): string[] {
  return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)];
}

export function loc(f: { file?: string; line?: number }): string {
  return `\`${String(f.file ?? "?").replace(/`/g, "'")}:${f.line ?? "?"}\``;
}

export function panel(f: Finding): string {
  const votes = f.votes ?? [];
  if (!votes.length) return "—";
  const ok = votes.filter((v) => v.verdict === "confirmed").length;
  return `${ok}/${votes.length}`;
}

export function missing(stage: string): string {
  return `_Not available (run the \`${stage}\` stage)._`;
}

export function isStale(c: Ctx): boolean {
  return c.revision?.stale === true;
}

export function verificationIncomplete(c: Ctx): boolean {
  return c.pending.length > 0;
}

/** Dimensions whose shards were lost or deferred — never "no findings" for these. */
export function uncoveredDimensions(c: Ctx): Set<string> {
  const out = new Set<string>();
  const gaps = [...(c.coverage?.lost_shards ?? []), ...(c.coverage?.deferred_shards ?? [])].map(String);
  for (const g of gaps) {
    // shard keys look like "deep:<dimension>:<module>", "<dimension>--<module>" or "security:<component>:<category>"
    const parts = g.split(/[:]|--/).filter(Boolean);
    for (const p of parts) if (["architecture", "security", "quality", "performance", "testing", "dependencies", "operability", "data"].includes(p)) out.add(p);
    if (parts[0] === "security") out.add("security");
  }
  return out;
}

export function noneLine(c: Ctx, dimension: string, what = "confirmed findings"): string {
  const dims = (c as { scope?: { dimensions?: string[] } }).scope?.dimensions;
  if (Array.isArray(dims) && !dims.includes(dimension)) return `_Not reviewed — \`${dimension}\` was outside this review's scope (not evidence of absence)._`;
  return uncoveredDimensions(c).has(dimension)
    ? `_No ${what} — but this dimension was **not fully covered** (lost/deferred shards, see Coverage). Absence of findings is not evidence of absence._`
    : `_No ${what}._`;
}

export function counts(c: Ctx) {
  return {
    total: c.findings.length, confirmed: c.confirmed.length, accepted: c.accepted.length,
    needs_human: c.needsHuman.length, refuted: c.refuted.length, deferred: c.deferred.length, pending: c.pending.length,
  };
}
