// `review.ts plan <stage>`: the shard list for deep / security / verify,
// computed before any spend. Completed shards are skipped (resume); work over
// the agent cap is deferred and named, never dropped silently.
import { statSync } from "node:fs";
import { join } from "node:path";
import { validateShard, validateVote } from "./findings.ts";
import { loadScope } from "./paths.ts";
import { DIMENSIONS, LENSES, SEV_RANK, CONF_RANK, taskOuts, type Finding, type Plan, type PlanTask, type ShardedStage } from "./types.ts";
import { candidateGroups, validateDecision } from "./consolidate.ts";
import { preConsolidation } from "./merge.ts";
import { exists, readJson, writeJson } from "./util.ts";
import { packUnits, type ReviewUnit } from "./modules.ts";

export const AGENT: Record<string, string> = {
  architecture: "architecture-critic", quality: "quality-reviewer", performance: "performance-reviewer",
  testing: "test-analyst", dependencies: "dependency-analyst", operability: "operability-reviewer", data: "codebase-analyst",
};

// Rough per-agent cost (USD) used only for the up-front estimate; calibrated
// from usage.json when a previous stage recorded real spend.
const USD_PER_AGENT = { deep: 0.45, security: 0.6, consolidate: 0.12, verify: 0.4 } as const;

/**
 * A review unit under this many source lines gets one deep-review agent for all
 * dimensions and one security auditor for all categories, instead of one per
 * dimension / category. Each agent pays a fixed start-up cost before reading any
 * code; on a small unit that cost, not the reading, is most of the bill.
 */
export const COMPACT_LOC = 1000;
const isCompact = (u: ReviewUnit) => Number.isFinite(u.lines) && u.lines > 0 && u.lines < COMPACT_LOC;

/** Source files no topology module owns (build/CI config, scripts, migrations…). */
function outsideFiles(analysis: string, modules: { path: string }[]): string[] {
  const ev = readJson<{ files?: string[]; file_sloc?: Record<string, number> }>(join(analysis, "evidence.json"), {});
  const files = ev.files ?? Object.keys(ev.file_sloc ?? {});
  const roots = modules.map((m) => m.path.replace(/\/+$/, ""));
  if (roots.some((r) => r === "." || r === "")) return [];
  return files.filter((f) => !roots.some((r) => f === r || f.startsWith(r + "/")));
}

/** Findings one verify agent judges together (same file, same lens). */
export const VERIFY_BATCH = 5;

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

export function buildPlan(analysis: string, stage: ShardedStage, opts: { maxAgents?: number; continueDeferred?: boolean; acceptDeferred?: boolean } = {}): Plan {
  const scope = loadScope(analysis);
  if (!scope) throw new Error(`no scope.json in ${analysis}`);
  const cap = opts.maxAgents ?? scope.max_agents ?? 24;
  const prev = readJson<Plan | null>(join(analysis, "plan", `${stage}.json`), null);
  const topo = readJson<{ modules?: { name: string; path: string; lines?: number }[] }>(join(analysis, "topology.json"), {});
  const modules = (topo.modules ?? []).filter((m) => m && m.name);
  if ((stage === "deep" || stage === "security") && !modules.length) throw new Error("topology.json has no modules — run /code-review-harness:review-map first");
  // Shards are per review unit, not per module: tiny modules are packed together
  // so each agent gets a worthwhile slice (see packUnits).
  const sloc = readJson<{ file_sloc?: Record<string, number> }>(join(analysis, "evidence.json"), {}).file_sloc;
  const units: ReviewUnit[] = stage === "deep" || stage === "security" ? packUnits(modules, sloc) : [];
  const unitInput = (u: ReviewUnit) => ({ module: u.name, path: u.paths.join(", "), paths: u.paths, modules: u.modules, lines: u.lines });
  const unitsNote = units.length < modules.length ? ` (${modules.length} modules packed into ${units.length} review units)` : "";

  // Ordered candidate tasks; groups are capped atomically (a 3-lens panel is never split).
  const groups: PlanTask[][] = [];
  const run: PlanTask[] = [], skipped: string[] = [], deferred: string[] = [];
  let formula = "";
  if (stage === "deep") {
    const dims = scope.dimensions.filter((d) => d !== "security" && (DIMENSIONS as readonly string[]).includes(d));
    let compact = 0;
    for (const u of units) {
      if (isCompact(u) && dims.length > 1) {
        // One agent covers every dimension of a small unit; the key names them all so a
        // lost shard still marks each dimension as uncovered.
        compact++;
        const key = `${dims.join("+")}--${slug(u.name)}`;
        groups.push([{ key, agent: "module-reviewer", out: `raw/deep/${key}.json`, input: { ...unitInput(u), dimensions: dims } }]);
        continue;
      }
      for (const d of dims) {
        const key = `${d}--${slug(u.name)}`;
        groups.push([{ key, agent: AGENT[d]!, out: `raw/deep/${key}.json`, input: { ...unitInput(u), dimension: d } }]);
      }
    }
    formula = `${units.length - compact} units x ${dims.length} dimensions + ${compact} compact unit(s) x 1 all-dimension reviewer (< ${COMPACT_LOC} lines)${unitsNote}`;
  } else if (stage === "security") {
    const ev = readJson<{ languages?: Record<string, unknown> }>(join(analysis, "evidence.json"), {});
    const unmanaged = Object.keys(ev.languages ?? {}).some((l) => UNMANAGED.test(l));
    let cats = Object.keys(SECURITY_CATEGORIES).filter((c) => c !== "memory-and-unsafe" || unmanaged);
    if (scope.security_effort === "low") cats = cats.slice(0, 2);
    for (const u of units) groups.push([{ key: `threat--${slug(u.name)}`, agent: "threat-modeler", out: `threat/${slug(u.name)}.md`, input: unitInput(u) }]);
    let compact = 0;
    for (const u of units) {
      const threat = `threat/${slug(u.name)}.md`;
      if (isCompact(u) && cats.length > 1) {
        // A small unit gets one auditor working through every category in turn.
        compact++;
        const key = `${slug(u.name)}--all-categories`;
        groups.push([{ key, agent: "security-auditor", out: `raw/security/${key}.json`, input: { ...unitInput(u), threat, category: cats.join(", "), focus: cats.map((c) => `${c}: ${SECURITY_CATEGORIES[c as keyof typeof SECURITY_CATEGORIES]}`).join("; ") } }]);
        continue;
      }
      for (const c of cats) {
        const key = `${slug(u.name)}--${c}`;
        groups.push([{ key, agent: "security-auditor", out: `raw/security/${key}.json`, input: { ...unitInput(u), threat, category: c, focus: SECURITY_CATEGORIES[c as keyof typeof SECURITY_CATEGORIES] } }]);
      }
    }
    // Gap-fill sweeps only where there is a gap to fill: files no module owns, or
    // boundaries between units. A single unit owning every file is fully covered by
    // its own auditors (whose scope includes its tests and fixtures).
    const ownerless = outsideFiles(analysis, modules).length;
    const sweeps = scope.security_effort === "low" ? [] : [
      ...(ownerless ? ["outside-components"] : []), ...(units.length > 1 ? ["cross-boundary"] : []), ...(ownerless || units.length > 1 ? ["secrets-everywhere"] : []),
    ];
    for (const s of sweeps) groups.push([{ key: `sweep--${s}`, agent: "security-auditor", out: `raw/security/sweep--${s}.json`, input: { sweep: s, modules: modules.map((m) => m.path) } }]);
    formula = `${units.length} threat models + ${units.length - compact} units x ${cats.length} categories + ${compact} compact unit(s) x 1 all-category auditor + ${sweeps.length} sweeps${unitsNote}` + (unmanaged ? "" : " (memory-and-unsafe dropped: managed languages only)");
  } else if (stage === "consolidate") {
    const cands = candidateGroups(preConsolidation(analysis));
    for (const g of cands) groups.push([{ key: g.key, agent: "finding-consolidator", out: `consolidate/${g.key}.json`, input: { group: g.key, file: g.file, members: g.members } }]);
    formula = `${cands.length} co-located group(s) (same file, lines within 5) x 1 consolidator`;
  } else {
    const data = readJson<{ findings?: Finding[] }>(join(analysis, "findings.json"), {});
    const open = (data.findings ?? []).filter((f) => !f.accepted)
      .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || CONF_RANK[a.confidence] - CONF_RANK[b.confidence] || a.id.localeCompare(b.id));
    // Batched per file: one agent per (file chunk, lens) votes on up to VERIFY_BATCH
    // findings, each into its own votes/<id>--<lens>.json. Every agent pays a fixed
    // start-up cost (system prompt + tools written to cache), so one agent reading a
    // file once beats one agent per finding re-reading it. Lenses stay separate
    // agents, so the 2-of-3 panel stays independent. Chunks keep severity order
    // (open is sorted), so the cap still defers the least severe work.
    const chunks: { file: string; sec: boolean; ids: string[] }[] = [];
    const byKey = new Map<string, { file: string; sec: boolean; ids: string[] }>();
    for (const f of open) {
      const sec = f.dimension === "security";
      const k = `${sec}|${f.file}`;
      let c = byKey.get(k);
      if (!c || c.ids.length >= VERIFY_BATCH) { c = { file: f.file, sec, ids: [] }; byKey.set(k, c); chunks.push(c); }
      c.ids.push(f.id);
    }
    const seq = new Map<string, number>();
    const vote = (id: string, lens: string) => `votes/${id}--${lens}.json`;
    let sec = 0, other = 0, secAgents = 0, otherAgents = 0;
    for (const c of chunks) {
      const n = (seq.get(`${c.sec}|${c.file}`) ?? 0) + 1;
      seq.set(`${c.sec}|${c.file}`, n);
      const base = `${slug(c.file)}${n > 1 ? `-${n}` : ""}`;
      const lenses = c.sec ? [...LENSES] : ["VERIFY"];
      const g: PlanTask[] = [];
      for (const lens of lenses) {
        // Votes already on disk are skipped individually (resume after a partial batch).
        const todo = c.ids.filter((id) => !shardDone(analysis, vote(id, lens), scope.source));
        c.ids.filter((id) => !todo.includes(id)).forEach((id) => skipped.push(`${id}--${lens}`));
        if (!todo.length) continue;
        const outs = todo.map((id) => vote(id, lens));
        g.push({ key: `${c.sec ? "sec" : "oth"}--${base}--${lens}`, agent: c.sec ? "security-verifier" : "finding-verifier", out: outs[0]!, outs, input: { ids: todo, lens, file: c.file } });
      }
      if (c.sec) { sec += c.ids.length; secAgents += lenses.length; } else { other += c.ids.length; otherAgents++; }
      if (g.length) groups.push(g);
    }
    formula = `${sec} security findings in ${secAgents / 3} file batch(es) x 3 lenses + ${other} other findings in ${otherAgents} file batch(es) x 1 verifier (≤${VERIFY_BATCH} findings per agent)`;
  }

  const prevDeferred = new Set(opts.continueDeferred ? [] : prev?.deferred ?? []);
  let used = 0;
  for (const g of groups) {
    const todo = g.filter((t) => taskOuts(t).some((o) => !shardDone(analysis, o, scope.source)));
    g.filter((t) => !todo.includes(t)).forEach((t) => skipped.push(t.key));
    if (!todo.length) continue;
    // A group larger than the cap (a 3-lens panel under --max-agents 2) runs alone
    // in its own batch rather than waiting forever.
    if (g.some((t) => prevDeferred.has(t.key)) || (used > 0 && used + todo.length > cap)) { todo.forEach((t) => deferred.push(t.key)); continue; }
    run.push(...todo); used += todo.length;
  }
  const usd = Math.round(run.length * calibrated(analysis, stage) * 100) / 100;
  const plan: Plan & { attempts: number } = {
    stage, run, skipped, deferred,
    estimate: { agents: run.length, usd, formula: `${formula}; running ${run.length}, skipped ${skipped.length} (done), deferred ${deferred.length} (cap ${cap})` },
    // attempts counts real stage executions (markAttempt), never plan rebuilds.
    attempts: (prev as (Plan & { attempts?: number }) | null)?.attempts ?? 0,
    ...(opts.acceptDeferred && deferred.length ? { deferred_accepted: true } : {}),
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
