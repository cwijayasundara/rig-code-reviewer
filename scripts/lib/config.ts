// Model configuration: which model (and reasoning effort) each role runs on.
//
// Roles:
//   main          the finders: deep-review specialists, threat modeler, security auditor, consolidator
//   evaluator     the verifiers that confirm or refute every finding (keep it a different tier from main)
//   writer        the prose stages: preflight, assess, map, architecture, report
//   orchestrator  the dispatch-only stages: deep, security, consolidate, verify (they run the plan, not the review)
//
// Sources, later wins: built-in defaults < <source>/.code-review/config.json < --config <file>.
// A role left out keeps its default; `writer` follows `main.model` when only main is set.
// Unset fields fall back to the agent's own frontmatter (agents/*.md), so the defaults live in one place.
import { join, resolve } from "node:path";
import { exists, readJson, writeJson } from "./util.ts";
import type { Stage } from "./types.ts";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
export interface ModelChoice { model?: string; effort?: Effort }
export interface ModelConfig {
  main?: ModelChoice; evaluator?: ModelChoice; writer?: ModelChoice; orchestrator?: ModelChoice;
  /** Per-stage process override (the `claude -p` that runs a stage). */
  stages?: Partial<Record<Stage, ModelChoice>>;
  /** Per-agent override, by agent name without the plugin prefix (e.g. "security-auditor"). */
  agents?: Record<string, ModelChoice>;
}

export const EVALUATOR_AGENTS = ["finding-verifier", "security-verifier"] as const;
const WRITER_STAGES: Stage[] = ["preflight", "assess", "map", "architecture", "report"];

/** Built-in defaults for the stage processes. Agent defaults are their frontmatter (main: sonnet, evaluator: opus). */
export const DEFAULTS = {
  writer: { model: "sonnet", effort: "medium" },
  orchestrator: { model: "sonnet", effort: "low" },
} as const satisfies Record<string, Required<ModelChoice>>;

// Aliases resolve to the newest model of that family in Claude Code; full ids pin a version.
const MODEL_RE = /^(opus|sonnet|haiku|fable|claude-[a-z0-9.-]+)$/;

export function validateConfig(c: unknown): string[] {
  const e: string[] = [];
  if (!c || typeof c !== "object" || Array.isArray(c)) return ["config must be a JSON object"];
  const choice = (where: string, v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) { e.push(`${where}: must be an object {"model": ..., "effort": ...}`); return; }
    const x = v as Record<string, unknown>;
    for (const k of Object.keys(x)) if (k !== "model" && k !== "effort") e.push(`${where}: unknown key "${k}" (model, effort)`);
    if (x.model !== undefined && (typeof x.model !== "string" || !MODEL_RE.test(x.model))) e.push(`${where}.model: ${JSON.stringify(x.model)} is not a model alias (opus, sonnet, haiku, fable) or a claude-* model id`);
    if (x.effort !== undefined && !(EFFORTS as readonly string[]).includes(String(x.effort))) e.push(`${where}.effort: ${JSON.stringify(x.effort)} (one of ${EFFORTS.join(", ")})`);
  };
  const o = c as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (["main", "evaluator", "writer", "orchestrator"].includes(k)) choice(k, o[k]);
    else if (k === "stages" || k === "agents") {
      if (!o[k] || typeof o[k] !== "object") { e.push(`${k}: must be an object`); continue; }
      for (const [n, v] of Object.entries(o[k] as object)) choice(`${k}.${n}`, v);
    } else if (k !== "$comment") e.push(`unknown key "${k}" (main, evaluator, writer, orchestrator, stages, agents)`);
  }
  return e;
}

function merge(a: ModelConfig, b: ModelConfig): ModelConfig {
  const out: ModelConfig = { ...a };
  for (const r of ["main", "evaluator", "writer", "orchestrator"] as const) if (b[r]) out[r] = { ...a[r], ...b[r] };
  if (b.stages) out.stages = { ...a.stages, ...b.stages };
  if (b.agents) out.agents = { ...a.agents, ...b.agents };
  return out;
}

export function projectConfigPath(source: string): string { return join(source, ".code-review", "config.json"); }

/** Read and merge the config sources; throws with every problem listed when a file is invalid. */
export function loadConfig(source: string, explicit?: string, cwd = process.cwd()): { config: ModelConfig; files: string[] } {
  let config: ModelConfig = {};
  const files: string[] = [];
  for (const p of [projectConfigPath(source), explicit ? resolve(cwd, explicit) : undefined]) {
    if (!p) continue;
    if (!exists(p)) { if (p !== projectConfigPath(source)) throw new Error(`--config ${p}: file not found`); continue; }
    const c = readJson<unknown>(p, undefined);
    const errs = c === undefined ? ["invalid JSON"] : validateConfig(c);
    if (errs.length) throw new Error(`${p}:\n- ${errs.join("\n- ")}`);
    config = merge(config, c as ModelConfig);
    files.push(p);
  }
  return { config, files };
}

/** The resolved config is frozen into the analysis dir so manual stages and resumes use the same models. */
export const resolvedPath = (analysis: string) => join(analysis, "config.json");
export function saveResolved(analysis: string, config: ModelConfig, files: string[]): void {
  writeJson(resolvedPath(analysis), { ...config, $comment: `resolved from ${files.length ? files.join(", ") : "built-in defaults"}` });
}
export function loadResolved(analysis: string): ModelConfig {
  const c = readJson<ModelConfig & { $comment?: string }>(resolvedPath(analysis), {});
  delete c.$comment;
  return c;
}

/** Model + effort for a stage's `claude -p` process. Always concrete: a stage never inherits the user's default model. */
export function stageChoice(c: ModelConfig, stage: Stage): Required<ModelChoice> {
  const role = WRITER_STAGES.includes(stage)
    ? { ...DEFAULTS.writer, ...(c.main?.model && !c.writer?.model ? { model: c.main.model } : {}), ...c.writer }
    : { ...DEFAULTS.orchestrator, ...c.orchestrator };
  return { ...role, ...c.stages?.[stage] } as Required<ModelChoice>;
}

/** Model/effort override for one agent; fields left undefined keep the agent's frontmatter. */
export function agentChoice(c: ModelConfig, agent: string): ModelChoice {
  const role = (EVALUATOR_AGENTS as readonly string[]).includes(agent) ? c.evaluator : c.main;
  const out = { ...role, ...c.agents?.[agent] };
  return { ...(out.model ? { model: out.model } : {}), ...(out.effort ? { effort: out.effort } : {}) };
}

/** A warning (never an error) when the evaluator is not independent of the finders. */
export function independenceWarning(c: ModelConfig): string | null {
  const main = c.main?.model ?? "sonnet", ev = c.evaluator?.model ?? "opus";
  return main === ev ? `config: main and evaluator are both "${main}" — verification is no longer on a different model tier, so a model's blind spot can pass its own check.` : null;
}
