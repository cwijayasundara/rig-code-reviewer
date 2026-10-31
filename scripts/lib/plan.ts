// `review.ts plan <stage>`: the shard list for deep / security / verify,
// computed before any spend. Completed shards are skipped (resume); work over
// the agent cap is deferred and named, never dropped silently.
import { statSync } from "node:fs";
import { join } from "node:path";
import { validateShard, validateVote } from "./findings.ts";
import { loadScope } from "./paths.ts";
import { DIMENSIONS, LENSES, SEV_RANK, CONF_RANK, type Finding, type Plan, type PlanTask, type ShardedStage } from "./types.ts";
import { candidateGroups, validateDecision } from "./consolidate.ts";
import { preConsolidation } from "./merge.ts";
import { exists, readJson, writeJson } from "./util.ts";

export const AGENT: Record<string, string> = {
  architecture: "architecture-critic", quality: "quality-reviewer", performance: "performance-reviewer",
  testing: "test-analyst", dependencies: "dependency-analyst", operability: "operability-reviewer", data: "codebase-analyst",
};

// Rough per-agent cost (USD) used only for the up-front estimate; calibrated
// from usage.json when a previous stage recorded real spend.
const USD_PER_AGENT = { deep: 0.45, security: 0.6, consolidate: 0.12, verify: 0.3 } as const;

export const SECURITY_CATEGORIES = {
  "injection-and-input": "SQL/NoSQL/OS command/LDAP/template injection, XSS (incl. javascript: URLs), XXE, unsafe deserialization, SSTI, ReDoS, path traversal, prompt injection into LLM calls",
  "auth-and-access": "authentication bypass, session flaws, IDOR / missing object-level authorization, privilege escalation, CSRF, SSRF, open redirect, race conditions on security checks",
  "crypto-and-secrets": "hardcoded credentials, weak/misused crypto, predictable randomness for security, secrets in logs, missing TLS verification",
  "config-and-exposure": "security misconfiguration, debug endpoints, permissive CORS, missing security headers, verbose errors, PII exposure, insecure defaults in deployment config",
  "memory-and-unsafe": "buffer overflows, use-after-free, integer overflow into allocation, unsafe blocks, format strings (unmanaged languages only)",
} as const;
const UNMANAGED = /^(C|C\+\+|Objective-C|Rust|Zig|Assembly)$/;

function slug(s: string): string { return s.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80) || "root"; }

function mtime(p: string): number { try { return statSync(p).mtimeMs; } catch { return 0; } }

/** A shard counts as done only if valid AND written after the current assess stamp. */
function shardDone(analysis: string, out: string, source: string): boolean {
  const p = join(analysis, out);
  if (!exists(p)) return false;
  if (mtime(p) < mtime(join(analysis, "REVISION.json"))) return false; // stale: the tree was re-assessed
  if (out.endsWith(".md")) return true;
  const obj = readJson<unknown>(p, undefined);
  if (obj === undefined) return false;
  if (out.startsWith("votes/")) return validateVote(obj, out.split("/").pop()).length === 0;
  if (out.startsWith("consolidate/")) return validateDecision(obj).length === 0;
  return validateShard(obj, source).length === 0;
}

function calibrated(analysis: string, stage: keyof typeof USD_PER_AGENT): number {
  const u = readJson<{ stages?: { stage: string; total_cost_usd: number; agents?: number }[] }>(join(analysis, "usage.json"), {});
  const rec = (u.stages ?? []).find((s) => s.stage === stage && s.agents && s.total_cost_usd > 0);
  return rec ? rec.total_cost_usd / rec.agents! : USD_PER_AGENT[stage];
}

export function buildPlan(analysis: string, stage: ShardedStage, opts: { maxAgents?: number; continueDeferred?: boolean } = {}): Plan {
  const scope = loadScope(analysis);
  if (!scope) throw new Error(`no scope.json in ${analysis}`);
  const cap = opts.maxAgents ?? scope.max_agents ?? 24;
  const prev = readJson<Plan | null>(join(analysis, "plan", `${stage}.json`), null);
  const topo = readJson<{ modules?: { name: string; path: string; lines?: number }[] }>(join(analysis, "topology.json"), {});
  const modules = (topo.modules ?? []).filter((m) => m && m.name);
  if ((stage === "deep" || stage === "security") && !modules.length) throw new Error("topology.json has no modules — run /code-review-harness:review-map first");

  // Ordered candidate tasks; groups are capped atomically (a 3-lens panel is never split).
  const groups: PlanTask[][] = [];
  let formula = "";
  if (stage === "deep") {
    const dims = scope.dimensions.filter((d) => d !== "security" && (DIMENSIONS as readonly string[]).includes(d));
    for (const m of modules) for (const d of dims) {
      const key = `${d}--${slug(m.name)}`;
      groups.push([{ key, agent: AGENT[d]!, out: `raw/deep/${key}.json`, input: { module: m.name, path: m.path, dimension: d } }]);
    }
    formula = `${modules.length} modules x ${dims.length} dimensions`;
  } else if (stage === "security") {
    const ev = readJson<{ languages?: Record<string, unknown> }>(join(analysis, "evidence.json"), {});
    const unmanaged = Object.keys(ev.languages ?? {}).some((l) => UNMANAGED.test(l));
    let cats = Object.keys(SECURITY_CATEGORIES).filter((c) => c !== "memory-and-unsafe" || unmanaged);
    if (scope.security_effort === "low") cats = cats.slice(0, 2);
    for (const m of modules) groups.push([{ key: `threat--${slug(m.name)}`, agent: "threat-modeler", out: `threat/${slug(m.name)}.md`, input: { module: m.name, path: m.path } }]);
    for (const m of modules) for (const c of cats) {
      const key = `${slug(m.name)}--${c}`;
      groups.push([{ key, agent: "security-auditor", out: `raw/security/${key}.json`, input: { module: m.name, path: m.path, category: c, focus: SECURITY_CATEGORIES[c as keyof typeof SECURITY_CATEGORIES] } }]);
    }
    const sweeps = scope.security_effort === "low" ? [] : ["outside-components", "cross-boundary", "secrets-everywhere"];
    for (const s of sweeps) groups.push([{ key: `sweep--${s}`, agent: "security-auditor", out: `raw/security/sweep--${s}.json`, input: { sweep: s, modules: modules.map((m) => m.path) } }]);
    formula = `${modules.length} threat models + ${modules.length} modules x ${cats.length} categories + ${sweeps.length} sweeps` + (unmanaged ? "" : " (memory-and-unsafe dropped: managed languages only)");
  } else if (stage === "consolidate") {
    const cands = candidateGroups(preConsolidation(analysis));
    for (const g of cands) groups.push([{ key: g.key, agent: "finding-consolidator", out: `consolidate/${g.key}.json`, input: { group: g.key, file: g.file, members: g.members } }]);
    formula = `${cands.length} co-located group(s) (same file, lines within 5) x 1 consolidator`;
  } else {
    const data = readJson<{ findings?: Finding[] }>(join(analysis, "findings.json"), {});
    const open = (data.findings ?? []).filter((f) => !f.accepted)
      .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || CONF_RANK[a.confidence] - CONF_RANK[b.confidence] || a.id.localeCompare(b.id));
    let sec = 0, other = 0;
    for (const f of open) {
      if (f.dimension === "security") {
        sec++;
        groups.push(LENSES.map((lens) => ({ key: `${f.id}--${lens}`, agent: "security-verifier", out: `votes/${f.id}--${lens}.json`, input: { id: f.id, lens } })));
      } else {
        other++;
        groups.push([{ key: `${f.id}--VERIFY`, agent: "finding-verifier", out: `votes/${f.id}--VERIFY.json`, input: { id: f.id, lens: "VERIFY" } }]);
      }
    }
    formula = `${sec} security findings x 3 lenses + ${other} other findings x 1 verifier`;
  }

  const run: PlanTask[] = [], skipped: string[] = [], deferred: string[] = [];
  const prevDeferred = new Set(opts.continueDeferred ? [] : prev?.deferred ?? []);
  let used = 0;
  for (const g of groups) {
    const todo = g.filter((t) => !shardDone(analysis, t.out, scope.source));
    g.filter((t) => !todo.includes(t)).forEach((t) => skipped.push(t.key));
    if (!todo.length) continue;
    if (g.some((t) => prevDeferred.has(t.key)) || used + todo.length > cap) { todo.forEach((t) => deferred.push(t.key)); continue; }
    run.push(...todo); used += todo.length;
  }
  const usd = Math.round(run.length * calibrated(analysis, stage) * 100) / 100;
  const plan: Plan & { attempts: number } = {
    stage, run, skipped, deferred,
    estimate: { agents: run.length, usd, formula: `${formula}; running ${run.length}, skipped ${skipped.length} (done), deferred ${deferred.length} (cap ${cap})` },
    // attempts counts real stage executions (markAttempt), never plan rebuilds.
    attempts: (prev as (Plan & { attempts?: number }) | null)?.attempts ?? 0,
  };
  writeJson(join(analysis, "plan", `${stage}.json`), plan);
  return plan;
}

/** Record that a stage actually ran against its plan (driver after spawn; skills via `merge --after`). */
export function markAttempt(analysis: string, stage: ShardedStage): number {
  const p = join(analysis, "plan", `${stage}.json`);
  const plan = readJson<(Plan & { attempts?: number }) | null>(p, null);
  if (!plan) return 0;
  plan.attempts = (plan.attempts ?? 0) + 1;
  writeJson(p, plan);
  return plan.attempts;
}
