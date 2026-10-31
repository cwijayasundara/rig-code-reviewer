// `/review-run`: one fresh `claude -p` process per stage (context isolation by
// construction). Deterministic work (evidence, plans, merge, render) runs here
// in the driver; the model stages only write prose and agent shards.
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { runMerge } from "./merge.ts";
import { deactivate, loadScope, resolvePaths } from "./paths.ts";
import { buildPlan, markAttempt } from "./plan.ts";
import { writeBriefs } from "./briefs.ts";
import { buildStatus, writeStatus } from "./status.ts";
import { SHARDED, STAGES, type ShardedStage, type Stage } from "./types.ts";
import { exists, readJson, str, writeJson } from "./util.ts";
import { checkFresh } from "./revision.ts";
import { onStreamLine, RunLog } from "./progress.ts";

const MODEL_STAGES: Stage[] = ["preflight", "assess", "map", "deep", "security", "consolidate", "verify", "architecture", "report"];
const isSharded = (s: Stage): s is ShardedStage => (SHARDED as readonly string[]).includes(s);

/** Tools a headless stage may use. Bash is limited to read-only commands + this CLI. */
export function allowedTools(pluginRoot: string): string[] {
  const cli = `node ${join(pluginRoot, "scripts", "review.ts")}`;
  return [
    "Read", "Glob", "Grep", "Write", "Edit", "Agent", "Workflow", "Skill", "TodoWrite",
    `Bash(${cli}:*)`, `Bash(node --disable-warning=ExperimentalWarning ${join(pluginRoot, "scripts", "review.ts")}:*)`,
    "Bash(git log:*)", "Bash(git show:*)", "Bash(git blame:*)", "Bash(git diff:*)", "Bash(git ls-files:*)",
    "Bash(git rev-parse:*)", "Bash(git status:*)", "Bash(git grep:*)", "Bash(git shortlog:*)",
    "Bash(rg:*)", "Bash(grep:*)", "Bash(wc:*)", "Bash(ls:*)", "Bash(find:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(cat:*)", "Bash(file:*)",
  ];
}

interface Usage { stage: string; input_tokens: number; output_tokens: number; total_cost_usd: number; duration_ms?: number; agents?: number }

export function recordUsage(analysis: string, stage: string, data: Record<string, unknown>, agents?: number): number {
  const u = (data.usage ?? {}) as Record<string, number>;
  const entry: Usage = {
    stage,
    input_tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    output_tokens: u.output_tokens ?? 0,
    total_cost_usd: Number(data.total_cost_usd ?? 0) || 0,
    duration_ms: typeof data.duration_ms === "number" ? data.duration_ms : undefined,
    ...(agents ? { agents } : {}),
  };
  const prev = readJson<{ stages?: Usage[] }>(join(analysis, "usage.json"), {});
  // Retries of a stage accumulate (spend is real), keyed by stage.
  const stages = [...(prev.stages ?? [])];
  const i = stages.findIndex((s) => s.stage === stage);
  if (i >= 0) {
    const s = stages[i]!;
    stages[i] = { ...s, input_tokens: s.input_tokens + entry.input_tokens, output_tokens: s.output_tokens + entry.output_tokens,
      total_cost_usd: s.total_cost_usd + entry.total_cost_usd, duration_ms: (s.duration_ms ?? 0) + (entry.duration_ms ?? 0), agents: (s.agents ?? 0) + (entry.agents ?? 0) };
  } else stages.push(entry);
  const totals = {
    input_tokens: stages.reduce((n, s) => n + s.input_tokens, 0),
    output_tokens: stages.reduce((n, s) => n + s.output_tokens, 0),
    total_cost_usd: Math.round(stages.reduce((n, s) => n + s.total_cost_usd, 0) * 1e6) / 1e6,
  };
  writeJson(join(analysis, "usage.json"), { stages, totals });
  return totals.total_cost_usd;
}

function spent(analysis: string): number {
  return readJson<{ totals?: { total_cost_usd?: number } }>(join(analysis, "usage.json"), {}).totals?.total_cost_usd ?? 0;
}

function gate(analysis: string, stage: Stage): boolean {
  const st = buildStatus(analysis).stages.find((s) => s.stage === stage);
  return st?.status === "done" || st?.status === "skipped";
}

function attemptsOf(analysis: string, stage: string): number {
  return readJson<{ attempts?: number }>(join(analysis, "plan", `${stage}.json`), {}).attempts ?? 0;
}

function writeArgs(analysis: string, source: string, plan: Parameters<typeof writeBriefs>[2]): void {
  writeJson(join(analysis, "plan", `${plan.stage}.workflow-args.json`), writeBriefs(analysis, source, plan));
}

function cli(pluginRoot: string, args: string[], cwd: string, log: RunLog): number {
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(pluginRoot, "scripts", "review.ts"), ...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  for (const l of (r.stdout ?? "").split("\n")) if (l.trim()) log.say(`    ${l}`);
  for (const l of (r.stderr ?? "").split("\n")) if (l.trim()) log.warn(`    ${l}`);
  return r.status ?? 1;
}

export async function runDriver(name: string, flags: Record<string, string | true>, pluginRoot: string): Promise<number> {
  const ctx: { log: RunLog | null } = { log: null };
  const rc = await driveRun(name, flags, pluginRoot, ctx);
  ctx.log?.finish(rc === 0 ? "done" : rc === 4 ? "stopped" : "failed", rc === 0 ? undefined : `exit ${rc}`);
  return rc;
}

async function driveRun(name: string, flags: Record<string, string | true>, pluginRoot: string, ctx: { log: RunLog | null }): Promise<number> {
  const { initReview } = await import("../review.ts");
  const { source, analysis } = resolvePaths(name, str(flags.source) ?? ".", process.cwd(), str(flags.out));
  const dry = flags["dry-run"] === true;
  const log = new RunLog(analysis, name);
  ctx.log = log;
  const say = (l: string) => log.say(l), warn = (l: string) => log.warn(l);
  say(`source:    ${source}  (read-only)\nartefacts: ${analysis}  (beside the code, .gitignore'd — never $HOME)`);
  say(`live log:  tail -f ${log.logPath}\ndashboard: /review-dashboard (pane) · status line under the prompt while this runs`);
  const scope = initReview(name, flags);
  const maxUsd = str(flags["max-usd"]) ? Number(flags["max-usd"]) : scope.max_usd;
  const runner = str(flags.runner) ?? process.env.REVIEW_RUN_RUNNER ?? "claude";
  const env = { ...process.env, CODE_REVIEW_ACTIVE: "1", CODE_REVIEW_OUT: analysis, PYTHONDONTWRITEBYTECODE: "1" };

  if (!dry && exists(join(analysis, "REVISION.json")) && !flags.from && !flags.only) {
    const f = checkFresh(analysis, source);
    if (!f.fresh) {
      warn(`the source changed since this review's assess stage (${f.hint}). Findings would describe different code.\nRe-run from assess: /code-review-harness:review-run ${name} --source ${source} --from assess   (or start a new review name to keep this one as a baseline)`);
      return 5;
    }
  }
  let stages = MODEL_STAGES;
  const from = str(flags.from), only = str(flags.only);
  for (const s of [from, only]) if (s && !(STAGES as readonly string[]).includes(s)) { warn(`error: unknown stage ${s}`); return 2; }
  if (only) stages = [only as Stage];
  else if (from) stages = MODEL_STAGES.slice(Math.max(0, MODEL_STAGES.indexOf(from as Stage)));

  const spawnStage = async (stage: Stage, agents?: number): Promise<number> => {
    const prompt = `/code-review-harness:review-${stage} ${name}`;
    const args = ["-p", prompt];
    if (runner === "claude") {
      // stream-json: one event per line while the stage runs, so the terminal,
      // run.log and the dashboard show tool calls and agents as they happen.
      args.push("--output-format", "stream-json", "--verbose", "--plugin-dir", pluginRoot, "--permission-mode", "default", "--allowedTools", ...allowedTools(pluginRoot));
      if (maxUsd !== undefined) args.push("--max-budget-usd", String(Math.max(0.01, maxUsd - spent(analysis))));
    }
    if (dry) { say(`[dry-run] (cwd=${source}) ${runner} -p ${JSON.stringify(prompt)}`); return 0; }
    say(`==> ${stage}: fresh process (context-isolated)`);
    log.stage(stage);
    const [bin, ...pre] = runner.split(/\s+/);
    const child = spawn(bin!, [...pre, ...args], { cwd: source, env, stdio: ["ignore", "pipe", "pipe"] });
    let data: Record<string, unknown> | null = null;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (l) => { const r = onStreamLine(l, log); if (r) data = r; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => { process.stderr.write(c); for (const l of c.split("\n")) if (l.trim()) log.warn(`    ! ${l}`); });
    const rc = await new Promise<number>((res) => {
      child.on("error", (e) => { warn(`error: could not start ${bin}: ${e.message}`); res(127); });
      child.on("close", (code) => res(code ?? 1));
    });
    await new Promise<void>((res) => (lines as unknown as { closed?: boolean }).closed ? res() : lines.once("close", () => res()));
    const d = data as Record<string, unknown> | null;
    if (d) { const result = String(d.result ?? "").trim(); if (result) say(result); recordUsage(analysis, stage, d, agents); }
    return rc;
  };

  try {
    for (const stage of stages) {
      // --from/--only force their stages to run again (the code or prompts changed).
      if (flags["no-resume"] !== true && !from && !only && !dry && gate(analysis, stage)) { say(`--- ${stage}: gate passes, skipping (resume)`); continue; }
      if (maxUsd !== undefined && spent(analysis) >= maxUsd) {
        warn(`stopping before ${stage}: budget $${maxUsd} reached (spent $${spent(analysis).toFixed(2)}). Resume with --max-usd <higher>.`);
        return 4;
      }
      if (stage === "assess" && !dry) cli(pluginRoot, ["evidence", name, ...(flags.offline === true ? ["--offline"] : [])], source, log);
      let agents: number | undefined;
      if (isSharded(stage) && !dry) {
        if (stage === "verify" || stage === "consolidate") runMerge(analysis, { final: false });
        const wants = stage === "security" ? scope.dimensions.includes("security") : stage === "deep" ? scope.dimensions.some((d) => d !== "security") : true; // consolidate + verify always
        if (!wants) { say(`--- ${stage}: not in scope dimensions, skipped`); continue; }
        // One plan per stage execution: deferred work from an earlier invocation is
        // retried first (the cap applies per invocation); briefs are written here.
        const plan = buildPlan(analysis, stage, { maxAgents: str(flags["max-agents"]) ? Number(flags["max-agents"]) : undefined, continueDeferred: true });
        agents = plan.run.length;
        say(`--- ${stage} plan: ${plan.estimate.formula} · est. ~$${plan.estimate.usd}`);
        if (maxUsd !== undefined && spent(analysis) + plan.estimate.usd > maxUsd) say(`    warning: estimate exceeds remaining budget; --max-budget-usd will stop the stage at the cap`);
        if (!plan.run.length) {
          markAttempt(analysis, stage);
          runMerge(analysis, stage === "verify" ? { final: true } : {});
          writeStatus(analysis);
          if (gate(analysis, stage)) { say(`--- ${stage}: nothing to run`); continue; }
          warn(`error: ${stage} has nothing left to run but its gate is not met — see ${analysis}/status.json`);
          return 1;
        }
        writeArgs(analysis, scope.source, plan);
      }
      const sharded = isSharded(stage);
      const before = sharded ? attemptsOf(analysis, stage) : 0;
      let rc = await spawnStage(stage, agents);
      // One retry for lost shards; after that they are recorded as coverage gaps.
      if (rc === 0 && !dry && isSharded(stage)) {
        if (attemptsOf(analysis, stage) === before) markAttempt(analysis, stage); // unless the skill's `merge --after` did
        const st = buildStatus(analysis).shards.plans[stage];
        if (st && st.lost > 0) {
          say(`--- ${stage}: ${st.lost} shard(s) lost; retrying once`);
          const retry = buildPlan(analysis, stage, { maxAgents: str(flags["max-agents"]) ? Number(flags["max-agents"]) : undefined });
          writeArgs(analysis, scope.source, retry);
          const b2 = attemptsOf(analysis, stage);
          rc = await spawnStage(stage, retry.run.length);
          if (rc === 0 && attemptsOf(analysis, stage) === b2) markAttempt(analysis, stage);
        }
        runMerge(analysis, stage === "verify" ? { final: true } : {}); // THREAT_MODEL.md, coverage, findings
      }
      const status = writeStatus(analysis);
      if (dry) continue;
      if (rc !== 0) { warn(`error: stage ${stage} exited ${rc}; state in ${analysis}/status.json; resume: /code-review-harness:review-run ${name} --source ${source}`); return rc || 1; }
      if (!gate(analysis, stage)) {
        warn(`error: stage ${stage} finished but its gate is not met. Next: ${status.stages.find((s) => s.stage === stage)?.command}. Lost: ${status.shards.lost.slice(0, 10).join(", ") || "none"}`);
        return 1;
      }
      say(`--- ${stage}: done · findings ${status.findings.total} · spent $${spent(analysis).toFixed(2)}`);
    }
  } finally {
    if (!dry) deactivate(source);
  }
  const s = writeStatus(analysis);
  say(`usage: ${s.usage.totals.input_tokens} in / ${s.usage.totals.output_tokens} out tokens · $${Number(s.usage.totals.total_cost_usd).toFixed(4)}`);
  say(`open: ${join(analysis, "ANALYSIS_REPORT.md")} · ${join(analysis, "ARCHITECTURE.md")} · ${join(analysis, "REPORT.html")}`);
  return loadScope(analysis) ? 0 : 1;
}
