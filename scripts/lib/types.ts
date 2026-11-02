// Shared contracts. Every module imports from here; docs/DESIGN.md is the prose twin.

export const DIMENSIONS = ["architecture", "security", "quality", "performance", "testing", "dependencies", "operability", "data"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const SEVERITIES = ["Blocker", "Critical", "High", "Medium", "Low", "Nit"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CONFIDENCES = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const EFFORTS = ["S", "M", "L", "XL"] as const;
export type Effort = (typeof EFFORTS)[number];

export const VERDICTS = ["confirmed", "refuted", "needs-human", "deferred"] as const;
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
export const SHARDED = ["deep", "security", "consolidate", "verify"] as const;
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
  estimate: { agents: number; usd: number; formula: string };
  /** Set only by `run --allow-deferred`: the stage may pass with deferred work, reported as a coverage gap. */
  deferred_accepted?: boolean;
}

export const SEV_RANK: Record<Severity, number> = { Blocker: 0, Critical: 0, High: 1, Medium: 2, Low: 3, Nit: 4 };
export const CONF_RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
export const EFFORT_RANK: Record<Effort, number> = { S: 0, M: 1, L: 2, XL: 3 };

export const DIM_PREFIX: Record<Dimension, string> = {
  architecture: "ARC", security: "SEC", quality: "QUA", performance: "PRF",
  testing: "TST", dependencies: "DEP", operability: "OPS", data: "DAT",
};
