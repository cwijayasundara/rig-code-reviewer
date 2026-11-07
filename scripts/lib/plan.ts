// `review.ts plan <stage>`: the shard list for deep / security / verify,
// computed before any spend. Completed shards are skipped (resume); work over
// the agent cap is deferred and named, never dropped silently.
import { statSync } from "node:fs";
import { join } from "node:path";
import { validateShard, validateVote } from "./findings.ts";
import { loadScope } from "./paths.ts";
import { DIMENSIONS, SYSTEM_DIMENSIONS, LENSES, SEV_RANK, CONF_RANK, taskOuts, type Finding, type Plan, type PlanTask, type ShardedStage } from "./types.ts";
import { candidateGroups, validateDecision } from "./consolidate.ts";
import { preConsolidation } from "./merge.ts";
import { exists, readJson, writeJson } from "./util.ts";
import { packUnits, type ReviewUnit } from "./modules.ts";
import { isInfraFile, isTestFile } from "./evidence.ts";
import type { Scope } from "./types.ts";

/** Review units for this review, at the packing frozen in its scope. */
export function reviewUnits(scope: Scope, modules: { name: string; path: string; lines?: number }[], sloc?: Record<string, number>): ReviewUnit[] {
  const [min, max] = scope.unit_loc ?? [undefined, undefined];
  return packUnits(modules, sloc, { min, max });
}

/**
 * What a unit holds, from evidence's file list: "test" when every file is a test,
 * "infra" when every file is IaC/deploy config (Terraform, YAML, Docker…), else "code"
 * (also when the unit's files are unknown). Test-only and infra-only units do not get the
 * full per-unit treatment: there is no performance or unit-testing review of Terraform,
 * and a test tree's real security risk is committed credentials, which a sweep covers.
 */
export function unitKind(u: ReviewUnit, files: string[]): "code" | "test" | "infra" {
  const roots = u.paths.map((p) => p.replace(/\/+$/, ""));
  if (roots.some((r) => r === "." || r === "")) return "code";
  const mine = files.filter((f) => roots.some((r) => f === r || f.startsWith(r + "/")));
  if (!mine.length) return "code";
  if (mine.every(isTestFile)) return "test";
  if (mine.every(isInfraFile)) return "infra";
  return "code";
}

/** Security categories that apply to infrastructure-as-code. */
const INFRA_CATEGORIES = ["crypto-and-secrets", "config-and-exposure"];

export const AGENT: Record<string, string> = {
  architecture: "architecture-critic", quality: "quality-reviewer", performance: "performance-reviewer",
  testing: "test-analyst", dependencies: "dependency-analyst", operability: "operability-reviewer", data: "codebase-analyst",
};

// Rough per-agent cost (USD) used only for the up-front estimate; calibrated
// from usage.json when a previous stage recorded real spend.
const USD_PER_AGENT = { deep: 0.45, security: 0.6, consolidate: 0.12, verify: 0.4 } as const;

/**
 * A review unit under this many source lines gets one security auditor for all
 * categories, instead of one per category. Each agent pays a fixed start-up cost before reading any
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

/** Findings one verify agent judges together (same review unit, same lens). */
export const VERIFY_BATCH = 5;
/** Co-located groups one consolidator decides together (same review unit). */
export const CONSOLIDATE_BATCH = 8;

/** The review unit that owns a file (longest matching path), or "outside" when none does. */
function unitOf(units: ReviewUnit[]): (file: string) => string {
  const roots = units.flatMap((u) => u.paths.map((p) => ({ unit: slug(u.name), root: p.replace(/\/+$/, "") })))
    .sort((a, b) => b.root.length - a.root.length);
  return (file) => roots.find((r) => r.root === "." || r.root === "" || file === r.root || file.startsWith(r.root + "/"))?.unit ?? "outside";
}

/**
 * Items grouped by owner, then chunked at `size`, in order of first appearance (so a
 * severity-sorted input keeps its order). Keys are "<owner>" then "<owner>-2", ...
 */
function batchBy<T>(items: T[], ownerOf: (x: T) => string, size: number): { key: string; items: T[] }[] {
  const out: { key: string; items: T[] }[] = [];
  const open = new Map<string, { key: string; items: T[] }>();
  const seq = new Map<string, number>();
  for (const x of items) {
    const o = ownerOf(x);
    let c = open.get(o);
    if (!c || c.items.length >= size) {
      const n = (seq.get(o) ?? 0) + 1;
      seq.set(o, n);
      c = { key: `${o}${n > 1 ? `-${n}` : ""}`, items: [] };
      open.set(o, c); out.push(c);
    }
    c.items.push(x);
  }
  return out;
}

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

/**
 * Cost per completed shard, from usage.json's calib_* fields: spend of stage runs that
 * produced shards, divided by the shards they produced. Agents started but lost, and
 * batches lost wholesale, are left out (the driver never records them), so one failed
 * batch does not skew later estimates. No measurement yet → the static default.
 */
export function usdPerAgent(analysis: string, stage: keyof typeof USD_PER_AGENT): number {
  const u = readJson<{ stages?: { stage: string; calib_usd?: number; calib_agents?: number }[] }>(join(analysis, "usage.json"), {});
  const rec = (u.stages ?? []).find((s) => s.stage === stage);
  return rec?.calib_agents && rec.calib_usd && rec.calib_usd > 0 ? rec.calib_usd / rec.calib_agents : USD_PER_AGENT[stage];
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
  const units: ReviewUnit[] = stage === "deep" || stage === "security" ? reviewUnits(scope, modules, sloc) : [];
  const evFiles = readJson<{ files?: string[] }>(join(analysis, "evidence.json"), {}).files ?? Object.keys(sloc ?? {});
  const kind = (u: ReviewUnit) => unitKind(u, evFiles);
  const unitInput = (u: ReviewUnit) => ({ module: u.name, path: u.paths.join(", "), paths: u.paths, modules: u.modules, lines: u.lines });
  const unitsNote = units.length < modules.length ? ` (${modules.length} modules packed into ${units.length} review units)` : "";

  // Ordered candidate tasks; groups are capped atomically (a 3-lens panel is never split).
  const groups: PlanTask[][] = [];
  const run: PlanTask[] = [], skipped: string[] = [], deferred: string[] = [];
  let formula = "";
  if (stage === "deep") {
    const dims = scope.dimensions.filter((d) => d !== "security" && (DIMENSIONS as readonly string[]).includes(d));
    // Whole-system dimensions get one agent each over the entire codebase; judging
    // architecture or dependencies one unit at a time only sees a keyhole and files
    // the same cross-cutting issue once per unit.
    const system = dims.filter((d) => (SYSTEM_DIMENSIONS as readonly string[]).includes(d));
    for (const d of system) {
      const key = `${d}--system`;
      groups.push([{ key, agent: AGENT[d]!, out: `raw/deep/${key}.json`, input: { scope: "system", dimension: d, modules: modules.map((m) => m.name), paths: modules.map((m) => m.path) } }]);
    }
    // Code-local dimensions: one reviewer per unit reads the code once for all of
    // them; the key names every dimension so a lost shard marks each one uncovered.
    const local = dims.filter((d) => !system.includes(d));
    // Infra-only units (Terraform stacks, Helm charts) have no code-local quality,
    // performance or unit-test surface: operability reviews them system-wide and the
    // security stage audits their configuration.
    const infra = units.filter((u) => kind(u) === "infra");
    for (const u of units) {
      if (!local.length) break;
      if (infra.includes(u)) continue;
      const key = `${local.join("+")}--${slug(u.name)}`;
      groups.push([local.length > 1
        ? { key, agent: "module-reviewer", out: `raw/deep/${key}.json`, input: { ...unitInput(u), dimensions: local } }
        : { key, agent: AGENT[local[0]!]!, out: `raw/deep/${key}.json`, input: { ...unitInput(u), dimension: local[0] } }]);
    }
    formula = `${system.length} whole-system reviewer(s) (${system.join(", ") || "none"}) + ${local.length ? units.length - infra.length : 0} unit(s) x 1 reviewer (${local.join(", ") || "none"})${unitsNote}` +
      (local.length && infra.length ? `; ${infra.length} infra-only unit(s) (${infra.map((u) => u.name).join(", ")}) left to operability + security` : "");
  } else if (stage === "security") {
    const ev = readJson<{ languages?: Record<string, unknown> }>(join(analysis, "evidence.json"), {});
    const unmanaged = Object.keys(ev.languages ?? {}).some((l) => UNMANAGED.test(l));
    let cats = Object.keys(SECURITY_CATEGORIES).filter((c) => c !== "memory-and-unsafe" || unmanaged);
    if (scope.security_effort === "low") cats = cats.slice(0, 2);
    // The attack surface is a whole-system question (ways in, trust handed across
    // boundaries), so one threat-modeler maps it once; per-component maps cut every
    // cross-module data flow in half.
    const threat = "threat/system.md";
    groups.push([{ key: "threat--system", agent: "threat-modeler", out: threat, input: { scope: "system", modules: modules.map((m) => m.name), paths: modules.map((m) => m.path) } }]);
    // Code-local auditing: one auditor per unit works through every category. Only
    // high effort splits a large unit into one auditor per category.
    const allCats = { category: cats.join(", "), focus: cats.map((c) => `${c}: ${SECURITY_CATEGORIES[c as keyof typeof SECURITY_CATEGORIES]}`).join("; ") };
    let split = 0, regular = 0;
    const testOnly: string[] = [], infraUnits: string[] = [], infraSkipped: string[] = [];
    const infraCats = cats.filter((c) => INFRA_CATEGORIES.includes(c));
    for (const u of units) {
      const k = kind(u);
      // A test-only unit gets no all-category auditor: the secrets sweep below covers it.
      if (k === "test") { testOnly.push(u.name); continue; }
      if (k === "infra") {
        if (!infraCats.length) { infraSkipped.push(u.name); continue; }
        infraUnits.push(u.name);
        const key = `${slug(u.name)}--infra`;
        // Resume: a unit audited for every category before this split counts as done.
        if (shardDone(analysis, `raw/security/${slug(u.name)}--all-categories.json`, scope.source)) { skipped.push(key); continue; }
        groups.push([{ key, agent: "security-auditor", out: `raw/security/${key}.json`, input: { ...unitInput(u), threat, category: infraCats.join(", "), focus: infraCats.map((c) => `${c}: ${SECURITY_CATEGORIES[c as keyof typeof SECURITY_CATEGORIES]}`).join("; "), infra: true } }]);
        continue;
      }
      if (scope.security_effort === "high" && !isCompact(u) && cats.length > 1) {
        split++;
        for (const c of cats) {
          const key = `${slug(u.name)}--${c}`;
          groups.push([{ key, agent: "security-auditor", out: `raw/security/${key}.json`, input: { ...unitInput(u), threat, category: c, focus: SECURITY_CATEGORIES[c as keyof typeof SECURITY_CATEGORIES] } }]);
        }
        continue;
      }
      regular++;
      const key = `${slug(u.name)}--${cats.length > 1 ? "all-categories" : cats[0]}`;
      groups.push([{ key, agent: "security-auditor", out: `raw/security/${key}.json`, input: { ...unitInput(u), threat, ...(cats.length > 1 ? allCats : { category: cats[0], focus: SECURITY_CATEGORIES[cats[0] as keyof typeof SECURITY_CATEGORIES] }) } }]);
    }
    // Gap-fill sweeps only where there is a gap to fill: files no module owns. The
    // system threat model already maps cross-unit trust for every auditor; a
    // dedicated cross-boundary sweep runs only at high effort.
    const ownerless = outsideFiles(analysis, modules).length;
    const sweeps = [
      ...(ownerless && scope.security_effort !== "low" ? ["outside-components"] : []),
      ...(scope.security_effort === "high" && units.length > 1 ? ["cross-boundary"] : []),
      // Test-only units were skipped above, so the secrets sweep runs even at low effort to cover them.
      ...((ownerless && scope.security_effort !== "low") || testOnly.length ? ["secrets-everywhere"] : []),
    ];
    for (const s of sweeps) groups.push([{ key: `sweep--${s}`, agent: "security-auditor", out: `raw/security/sweep--${s}.json`, input: { sweep: s, threat, modules: modules.map((m) => m.path) } }]);
    formula = `1 whole-system threat model + ${regular} unit(s) x 1 all-category auditor + ${split} unit(s) x ${cats.length} categories (high effort) + ${infraUnits.length} infra-only unit(s) x 1 config/secrets auditor + ${sweeps.length} sweeps${unitsNote}` +
      (testOnly.length ? `; ${testOnly.length} test-only unit(s) covered by the secrets sweep` : "") +
      (infraSkipped.length ? `; ${infraSkipped.length} infra-only unit(s) not audited (security_effort low covers no config categories)` : "") + (unmanaged ? "" : " (memory-and-unsafe dropped: managed languages only)");
  } else if (stage === "consolidate") {
    // One consolidator per review unit judges up to CONSOLIDATE_BATCH co-located
    // groups, each decision in its own consolidate/<group>.json; a whole agent per
    // two-finding group spent its start-up cost on one tiny decision.
    const cands = candidateGroups(preConsolidation(analysis));
    const owner = unitOf(reviewUnits(scope, modules, sloc));
    const chunks = batchBy(cands, (g) => owner(g.file), CONSOLIDATE_BATCH);
    for (const c of chunks) {
      const todo = c.items.filter((g) => !shardDone(analysis, `consolidate/${g.key}.json`, scope.source));
      c.items.filter((g) => !todo.includes(g)).forEach((g) => skipped.push(g.key));
      if (!todo.length) continue;
      const outs = todo.map((g) => `consolidate/${g.key}.json`);
      groups.push([{ key: `cons--${c.key}`, agent: "finding-consolidator", out: outs[0]!, outs, input: { groups: todo.map((g) => ({ group: g.key, file: g.file, members: g.members })) } }]);
    }
    formula = `${cands.length} co-located group(s) (same file, lines within 5) in ${chunks.length} batch(es) per review unit x 1 consolidator (≤${CONSOLIDATE_BATCH} groups per agent)`;
  } else {
    const data = readJson<{ findings?: Finding[] }>(join(analysis, "findings.json"), {});
    const open = (data.findings ?? []).filter((f) => !f.accepted)
      .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || CONF_RANK[a.confidence] - CONF_RANK[b.confidence] || a.id.localeCompare(b.id));
    // Batched per review unit: one agent per (unit chunk, lens) votes on up to
    // VERIFY_BATCH findings, each into its own votes/<id>--<lens>.json. Every agent
    // pays a fixed start-up cost (system prompt + tools written to cache), so one
    // agent per unit beats one per file when most files carry a single finding.
    // Lenses stay separate agents, so the 2-of-3 panel stays independent. Chunks
    // keep severity order (open is sorted), so the cap still defers the least severe work.
    const owner = unitOf(reviewUnits(scope, modules, sloc));
    const chunks = [
      ...batchBy(open.filter((f) => f.dimension === "security"), (f) => owner(f.file), VERIFY_BATCH).map((c) => ({ ...c, sec: true })),
      ...batchBy(open.filter((f) => f.dimension !== "security"), (f) => owner(f.file), VERIFY_BATCH).map((c) => ({ ...c, sec: false })),
    ];
    const vote = (id: string, lens: string) => `votes/${id}--${lens}.json`;
    let sec = 0, other = 0, secAgents = 0, otherAgents = 0;
    for (const c of chunks) {
      const ids = c.items.map((f) => f.id);
      const files = [...new Set(c.items.map((f) => f.file))];
      const lenses = c.sec ? [...LENSES] : ["VERIFY"];
      const g: PlanTask[] = [];
      for (const lens of lenses) {
        // Votes already on disk are skipped individually (resume after a partial batch).
        const todo = ids.filter((id) => !shardDone(analysis, vote(id, lens), scope.source));
        ids.filter((id) => !todo.includes(id)).forEach((id) => skipped.push(`${id}--${lens}`));
        if (!todo.length) continue;
        const outs = todo.map((id) => vote(id, lens));
        g.push({ key: `${c.sec ? "sec" : "oth"}--${c.key}--${lens}`, agent: c.sec ? "security-verifier" : "finding-verifier", out: outs[0]!, outs, input: { ids: todo, lens, files } });
      }
      if (c.sec) { sec += ids.length; secAgents += lenses.length; } else { other += ids.length; otherAgents++; }
      if (g.length) groups.push(g);
    }
    formula = `${sec} security findings in ${secAgents / 3} unit batch(es) x 3 lenses + ${other} other findings in ${otherAgents} unit batch(es) x 1 verifier (≤${VERIFY_BATCH} findings per agent)`;
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
  const per = usdPerAgent(analysis, stage);
  const round = (n: number) => Math.round(n * 100) / 100;
  const usd = round(run.length * per);
  const stageUsd = round((run.length + (opts.acceptDeferred ? 0 : deferred.length)) * per);
  const plan: Plan & { attempts: number } = {
    stage, run, skipped, deferred,
    estimate: { agents: run.length, usd, usd_per_agent: round(per), stage_usd: stageUsd, formula: `${formula}; running ${run.length}, skipped ${skipped.length} (done), deferred ${deferred.length} (cap ${cap})` },
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
