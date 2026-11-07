// Shared contracts. Every module imports from here; docs/DESIGN.md is the prose twin.

export const DIMENSIONS = ["architecture", "security", "quality", "performance", "testing", "dependencies", "operability", "data"] as const;
export type Dimension = (typeof DIMENSIONS)[number];
/** Dimensions judged once over the whole system in the deep stage, not per review unit. */
export const SYSTEM_DIMENSIONS = ["architecture", "dependencies", "operability", "data"] as const;

export const SEVERITIES = ["Blocker", "Critical", "High", "Medium", "Low", "Nit"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CONFIDENCES = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const EFFORTS = ["S", "M", "L", "XL"] as const;
export type Effort = (typeof EFFORTS)[number];

export const VERDICTS = ["confirmed", "refuted", "needs-human", "deferred", "unverified"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const LENSES = ["REACHABILITY", "IMPACT", "DEFENSES"] as const;
export type Lens = (typeof LENSES)[number] | "VERIFY";

/** Parts of a finding's text a verifier can correct. title/location are its core claim. */
export const CORRECTABLE = ["title", "location", "evidence", "impact", "recommendation", "exploit_scenario"] as const;
export type Correctable = (typeof CORRECTABLE)[number];
export const CORE_FIELDS: readonly Correctable[] = ["title", "location"];
/** A factual error a verifier found in a finding's text: the wrong claim, quoted, and what is true. */
export interface Correction { field: Correctable; claim: string; correction: string; lens?: Lens }

export const STAGES = ["scope", "preflight", "assess", "map", "deep", "security", "consolidate", "verify", "architecture", "report"] as const;
export type Stage = (typeof STAGES)[number];
export const SHARDED = ["map", "deep", "security", "consolidate", "verify"] as const;
export type ShardedStage = (typeof SHARDED)[number];

/** What an agent (or scanner adapter) writes into raw/<stage>/<shard>.json. */
export interface RawFinding {
  dimension: Dimension;
  severity: Severity;
  confidence: Confidence;
  file: string;
  line: number;
  title: string;
  evidence: string;
  impact: string;
  recommendation: string;
  effort: Effort;
  end_line?: number;
  symbol?: string;
  snippet?: string;
  cwe?: string;
  category?: string;
  exploit_scenario?: string;
  preconditions?: string;
  attack_surface?: string;
  source?: string;
  rule_id?: string;
}

export interface RawShard {
  shard: string;
  filesRead: string[];
  notReached: string[];
  findings: RawFinding[];
}

export interface Vote {
  id: string;
  lens: Lens;
  verdict: "confirmed" | "refuted" | "needs-human";
  severity?: Severity;
  note: string;
  evidence?: string;
  /** Required on every vote ([] when the finding's text is accurate). */
  corrections: Correction[];
}

export interface Accepted { fingerprint: string; reason: string; by: string; at: string }

/** Script-owned merged finding (findings.json). */
export interface Finding extends RawFinding {
  id: string;
  fingerprint: string;
  category: string;
  reporters: number;
  shards: string[];
  aliases?: string[];
  verdict?: Verdict;
  votes?: { lens: Lens; verdict: string; severity?: Severity; note: string; evidence?: string; corrections?: Correction[] }[];
  verifier_note?: string;
  /** Factual errors confirming verifiers found in this finding's text; rendered beside it. */
  corrections?: Correction[];
  original_severity?: Severity;
  accepted?: Accepted;
  also_reported_as?: string[];
  consolidation_note?: string;
}

export interface Scope {
  name: string;
  source: string;
  analysis_dir: string;
  dimensions: Dimension[];
  module?: string;
  max_agents: number;
  security_effort: "low" | "medium" | "high";
  exclude: string[];
  off_limits: string[];
  no_execution: boolean;
  max_usd?: number;
  baseline?: string;
  /** Review-unit packing [min, max] SLOC, frozen at first init so a resume never re-keys finished shards. */
  unit_loc?: [number, number];
  /** Least severe finding the verify stage judges; anything below it is reported as "unverified". */
  verify_min_severity?: Severity;
  /** Most findings kept per agent shard (most severe first); the excess is recorded in coverage. */
  max_findings_per_shard?: number;
  created_at: string;
}

/** `out` is the task's (first) output; a batched verify task writes one vote per finding, listed in `outs`. */
export interface PlanTask { key: string; agent: string; out: string; outs?: string[]; input: Record<string, unknown> }
export const taskOuts = (t: PlanTask): string[] => t.outs ?? [t.out];
export interface Plan {
  stage: ShardedStage;
  run: PlanTask[];
  skipped: string[];
  deferred: string[];
  /** usd: this batch; stage_usd: every task the stage still has to run (this batch + deferred, unless accepted). */
  estimate: { agents: number; usd: number; formula: string; usd_per_agent: number; stage_usd: number };
  /** Set only by `run --allow-deferred`: the stage may pass with deferred work, reported as a coverage gap. */
  deferred_accepted?: boolean;
}

export const SEV_RANK: Record<Severity, number> = { Blocker: 0, Critical: 0, High: 1, Medium: 2, Low: 3, Nit: 4 };
/**
 * Default verification floor. Every verifier is an evaluator-tier agent and the security
 * panel is three of them, so verifying Low and Nit findings typically costs more than the
 * findings are worth; they are reported as filed, marked "unverified". `--verify-min Nit`
 * verifies everything.
 */
export const DEFAULT_VERIFY_MIN: Severity = "Medium";
/**
 * Default tasks per batch. A workflow already runs at most ~16 agents at once and queues
 * the rest, so a small batch adds no cost control, only waits: every batch ends with its
 * slowest agent, and the next starts after it. Budget is enforced by the up-front stage
 * projection and the stage process's --max-budget-usd, not by batching.
 */
export const DEFAULT_MAX_AGENTS = 100;
/**
 * Default most findings one agent shard may file. Every finding is paid for again by
 * consolidation and verification, so a reviewer that files dozens of minor findings
 * multiplies downstream cost; past the cap, merge keeps the most severe and records the
 * shard in coverage. `--max-findings` changes it.
 */
export const DEFAULT_MAX_FINDINGS = 25;
/** True when a finding's filed severity is below the review's verification floor. */
export const belowVerifyFloor = (severity: Severity, floor: Severity | undefined) => SEV_RANK[severity] > SEV_RANK[floor ?? DEFAULT_VERIFY_MIN];
export const CONF_RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
export const EFFORT_RANK: Record<Effort, number> = { S: 0, M: 1, L: 2, XL: 3 };

export const DIM_PREFIX: Record<Dimension, string> = {
  architecture: "ARC", security: "SEC", quality: "QUA", performance: "PRF",
  testing: "TST", dependencies: "DEP", operability: "OPS", data: "DAT",
};
