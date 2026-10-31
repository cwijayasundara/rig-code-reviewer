// status.json: the single source for every dashboard (Mod, /review-status,
// REPORT.html). Artifacts on disk only, never chat history. Stages are
// ordered: a stage is done only when every earlier stage is done.
import { statSync } from "node:fs";
import { join } from "node:path";
import { validateArchitecture, validateTopology } from "./architecture.ts";
import { loadScope } from "./paths.ts";
import { STAGES, type Finding, type Plan, type Stage } from "./types.ts";
import { exists, readJson, writeJson } from "./util.ts";

const OVERSIZED_LOC = 5000;

function mtime(p: string): number { try { return statSync(p).mtimeMs; } catch { return 0; } }

function planState(analysis: string, stage: string) {
  const plan = readJson<(Plan & { attempts?: number }) | null>(join(analysis, "plan", `${stage}.json`), null);
  if (!plan) return null;
  const lost = plan.run.filter((t) => !exists(join(analysis, t.out))).map((t) => t.key);
  return { planned: plan.run.length, lost, deferred: plan.deferred, skipped: plan.skipped.length, attempts: plan.attempts ?? 0, estimate: plan.estimate };
}

export function buildStatus(analysis: string) {
  const scope = loadScope(analysis);
  const name = scope?.name ?? analysis.split("/").pop() ?? "?";
  const findings = readJson<{ findings?: Finding[] }>(join(analysis, "findings.json"), {}).findings ?? [];
  const topo = readJson<{ modules?: { name: string; lines?: number }[] } | null>(join(analysis, "topology.json"), null);
  const arch = readJson<unknown>(join(analysis, "architecture.json"), null);
  const plans = { deep: planState(analysis, "deep"), security: planState(analysis, "security"), consolidate: planState(analysis, "consolidate"), verify: planState(analysis, "verify") };
  const dims = scope?.dimensions ?? [];
  const wantsSecurity = dims.includes("security");
  const wantsDeep = dims.some((d) => d !== "security");
  // A sharded stage passes when it has run at least once and every planned shard
  // exists, or after a real retry (attempts >= 2) with the rest recorded as lost.
  const sharded = (p: ReturnType<typeof planState>) => !!p && p.attempts >= 1 && (p.lost.length === 0 || p.attempts >= 2);
  const pending = findings.filter((f) => !f.verdict).length;
  const renders = ["ANALYSIS_REPORT.md", "ARCHITECTURE.md", "REPORT.html", "ROADMAP.md"].map((f) => join(analysis, f));

  const gate: Record<Stage, boolean> = {
    scope: !!scope,
    preflight: exists(join(analysis, "PREFLIGHT.md")),
    assess: ["evidence.json", "REVISION.json", "ASSESSMENT.md"].every((f) => exists(join(analysis, f))),
    map: !!topo && validateTopology(topo).length === 0,
    deep: !wantsDeep || sharded(plans.deep),
    security: !wantsSecurity || (sharded(plans.security) && exists(join(analysis, "THREAT_MODEL.md"))),
    consolidate: sharded(plans.consolidate),
    verify: exists(join(analysis, "findings.json")) && pending === 0,
    architecture: arch !== null && validateArchitecture(arch).length === 0,
    report: renders.every(exists) && Math.min(...renders.map(mtime)) >= mtime(join(analysis, "findings.json")),
  };
  let blocked = false;
  const stages = STAGES.map((s) => {
    const done = gate[s] && !blocked;
    if (!done) blocked = true;
    const cmd = s === "scope" ? `/code-review-harness:review ${name} --source <path>` : `/code-review-harness:review-${s} ${name}`;
    const skipped = (s === "security" && !wantsSecurity) || (s === "deep" && !wantsDeep);
    return { stage: s, status: done ? (skipped ? "skipped" : "done") : "pending", command: cmd };
  });
  const next = stages.find((s) => s.status === "pending");

  const by_verdict: Record<string, number> = { confirmed: 0, refuted: 0, "needs-human": 0, deferred: 0, pending: 0 };
  const by_severity: Record<string, number> = {};
  const by_dimension: Record<string, number> = {};
  for (const f of findings) {
    by_verdict[f.verdict ?? "pending"]! += 1;
    if (f.verdict === "confirmed" && !f.accepted) by_severity[f.severity] = (by_severity[f.severity] ?? 0) + 1;
    by_dimension[f.dimension] = (by_dimension[f.dimension] ?? 0) + 1;
  }
  const lost = Object.entries(plans).flatMap(([s, p]) => (p?.lost ?? []).map((k) => `${s}:${k}`));
  const deferred = Object.entries(plans).flatMap(([s, p]) => (p?.deferred ?? []).map((k) => `${s}:${k}`));
  const expected = Object.values(plans).reduce((n, p) => n + (p ? p.planned + p.skipped : 0), 0);
  const completed = Object.values(plans).reduce((n, p) => n + (p ? p.planned - p.lost.length + p.skipped : 0), 0);
  const usage = readJson<{ stages?: unknown[]; totals?: Record<string, number> }>(join(analysis, "usage.json"), {});
  const coverage = readJson<{ files_read_pct?: number; scanners?: { failed?: unknown[]; missing?: string[] } }>(join(analysis, "coverage.json"), {});

  return {
    name, analysis_dir: analysis, source: scope?.source ?? null,
    stages, next_stage: next?.stage ?? null, next_command: next?.command ?? null, complete: !next,
    findings: { total: findings.length, by_verdict, by_severity, by_dimension, accepted: findings.filter((f) => f.accepted).length },
    shards: {
      expected, completed, lost, deferred,
      plans: Object.fromEntries(Object.entries(plans).map(([k, p]) => [k, p && { planned: p.planned, lost: p.lost.length, deferred: p.deferred.length, skipped: p.skipped, estimate: p.estimate }])),
      oversized_modules: (topo?.modules ?? []).filter((m) => typeof m.lines === "number" && m.lines >= OVERSIZED_LOC).map((m) => m.name),
    },
    coverage: { files_read_pct: coverage.files_read_pct ?? null, failed_scanners: coverage.scanners?.failed?.length ?? 0, missing_scanners: coverage.scanners?.missing ?? [] },
    usage: { stages: usage.stages ?? [], totals: { input_tokens: 0, output_tokens: 0, total_cost_usd: 0, ...(usage.totals ?? {}) } },
  };
}

export function writeStatus(analysis: string) {
  const s = buildStatus(analysis);
  writeJson(join(analysis, "status.json"), s);
  return s;
}
