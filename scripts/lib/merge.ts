// `review.ts merge`: raw shards + votes + accepted risks -> findings.json,
// coverage.json, THREAT_MODEL.md. Idempotent; safe to run any time.
import { join } from "node:path";
import { applyConsolidation } from "./consolidate.ts";
import { applyVotes, loadAccepted, loadShards, loadVotes, mergeShards, verifyDeferred } from "./findings.ts";
import { loadScope } from "./paths.ts";
import { taskOuts, type Finding, type Plan } from "./types.ts";
import { exists, readJson, readText, writeJson, writeText } from "./util.ts";
import { readdirSync } from "node:fs";

export interface MergeResult {
  findings: number;
  by_verdict: Record<string, number>;
  invalid_shards: { path: string; errors: string[] }[];
  invalid_votes: { path: string; errors: string[] }[];
  consolidated: number;
}

/**
 * `final` (incomplete panels -> needs-human) persists in findings.json so a later
 * plain merge (render, status) never reverts verdicts to pending; `plan verify`
 * starts a new round with final=false explicitly.
 */
export function runMerge(analysis: string, opts: { final?: boolean } = {}): MergeResult {
  const prev = readJson<{ final?: boolean; findings?: Finding[] }>(join(analysis, "findings.json"), {});
  const scope = loadScope(analysis);
  if (!scope) throw new Error(`no scope.json in ${analysis} — run /code-review-harness:review first`);
  const { shards, invalid } = loadShards(analysis, scope.source);
  const pre = mergeShards(shards, scope.source);
  const cons = applyConsolidation(pre, analysis);
  const merged = cons.findings;
  // A sticky `final` must never pass off new, unverified findings as verified.
  const prevIds = new Set((prev.findings ?? []).map((f) => f.id));
  const final = opts.final ?? (prev.final === true && merged.every((f) => prevIds.has(f.id)));
  const { votes, invalid: badVotes } = loadVotes(analysis);
  const deferred = verifyDeferred(analysis);
  const accepted = new Map(loadAccepted(scope.source).map((a) => [a.fingerprint, a]));
  const findings: Finding[] = merged.map((f) => {
    const aliasIds = (f.aliases ?? []).map((a) => `${f.id.split("-")[0]}-${a.slice(3, 11)}`);
    const vs = votes.get(f.id) ?? aliasIds.map((i) => votes.get(i)).find((x) => x && x.length) ?? [];
    const out = applyVotes(f, vs, { deferred: deferred.has(f.id), final });
    const acc = accepted.get(f.fingerprint) ?? (f.aliases ?? []).map((a) => accepted.get(a)).find(Boolean);
    return acc ? { ...out, accepted: acc } : out;
  });
  writeJson(join(analysis, "findings.json"), { version: 1, final, findings });
  writeJson(join(analysis, "coverage.json"), buildCoverage(analysis, shards, invalid));
  mergeThreatModels(analysis);
  const by_verdict: Record<string, number> = { confirmed: 0, refuted: 0, "needs-human": 0, deferred: 0, pending: 0 };
  for (const f of findings) by_verdict[f.verdict ?? "pending"]! += 1;
  return { findings: findings.length, by_verdict, invalid_shards: invalid, invalid_votes: [...badVotes, ...cons.invalid], consolidated: cons.merged };
}

function planLost(analysis: string, stage: string): { lost: string[]; deferred: string[] } {
  const plan = readJson<Plan | null>(join(analysis, "plan", `${stage}.json`), null);
  if (!plan) return { lost: [], deferred: [] };
  return {
    lost: plan.run.filter((t) => taskOuts(t).some((o) => !exists(join(analysis, o)))).map((t) => `${stage}:${t.key}`),
    deferred: plan.deferred.map((k) => `${stage}:${k}`),
  };
}

interface Evidence {
  files?: string[];
  top_level_dirs?: { dir: string; files: number; kind?: string }[];
}

export function buildCoverage(analysis: string, shards: { shard: string; filesRead: string[]; notReached: string[] }[], invalid: { path: string }[]) {
  const scope = loadScope(analysis);
  const ev = readJson<Evidence>(join(analysis, "evidence.json"), {});
  const topo = readJson<{ modules?: { name: string; path?: string }[] }>(join(analysis, "topology.json"), {});
  const files = new Set(ev.files ?? []);
  const read = new Set<string>();
  const notReached = new Set<string>();
  for (const s of shards) {
    for (const f of s.filesRead ?? []) if (files.has(f)) read.add(f);
    for (const f of s.notReached ?? []) notReached.add(f);
  }
  const modulePaths = (topo.modules ?? []).map((m) => (m.path ?? "").replace(/^\.\/?/, "").replace(/\/$/, "")).filter((p) => p !== undefined);
  const setAsideKinds: Record<string, string> = { vendor: "vendored third-party code", generated: "generated code", docs: "documentation" };
  const exclude = scope?.exclude ?? [];
  const top_level = (ev.top_level_dirs ?? []).map((d) => {
    const prefix = d.dir === "." ? "" : d.dir + "/";
    const inDir = (f: string) => (d.dir === "." ? !f.includes("/") : f.startsWith(prefix));
    const filesRead = [...read].filter(inDir).length;
    // Root-level files are covered only by a module whose path is the root itself.
    const mapped = d.dir === "." ? modulePaths.includes("")
      : modulePaths.some((p) => p === "" || p === d.dir || p.startsWith(prefix) || prefix.startsWith(p + "/"));
    let status: "scanned" | "set-aside" | "unaccounted" = "unaccounted";
    let reason: string | undefined;
    if (filesRead > 0 || mapped) status = "scanned";
    else if (d.kind && setAsideKinds[d.kind]) { status = "set-aside"; reason = setAsideKinds[d.kind]; }
    else if (exclude.some((g) => g.startsWith(d.dir + "/") || g === d.dir)) { status = "set-aside"; reason = "excluded by scope"; }
    return { dir: d.dir, kind: d.kind, status, reason, files: d.files, files_read: filesRead };
  });
  const scanners = readJson<{ id: string; status: string; error?: string }[]>(join(analysis, "scanners", "status.json"), []);
  const stages = ["deep", "security", "consolidate", "verify"].map((s) => planLost(analysis, s));
  return {
    files_total: files.size,
    files_read: read.size,
    files_read_pct: files.size ? Math.round((1000 * read.size) / files.size) / 10 : 0,
    top_level,
    lost_shards: [...stages.flatMap((s) => s.lost), ...invalid.map((i) => `invalid:${i.path.slice(analysis.length + 1)}`)],
    deferred_shards: stages.flatMap((s) => s.deferred),
    scanners: {
      failed: scanners.filter((s) => s.status === "failed" || s.status === "timeout").map((s) => ({ id: s.id, status: s.status, error: s.error })),
      missing: scanners.filter((s) => s.status === "missing").map((s) => s.id),
      skipped: scanners.filter((s) => s.status === "skipped").map((s) => s.id),
    },
    not_reached: [...notReached].sort().slice(0, 500),
  };
}

/** threat/<component>.md (agent-written) -> THREAT_MODEL.md (script-owned). */
export function mergeThreatModels(analysis: string): void {
  const dir = join(analysis, "threat");
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".md")).sort(); } catch { return; }
  if (!names.length) return;
  const parts = ["# Threat model", "", "Merged deterministically from `threat/*.md` (one threat-modeler per component). Repository-derived content; claims are cited `file:line`.", ""];
  for (const n of names) parts.push(`## ${n.replace(/\.md$/, "")}`, "", (readText(join(dir, n)) ?? "").trim(), "");
  writeText(join(analysis, "THREAT_MODEL.md"), parts.join("\n") + "\n");
}

/** Findings as merged from shards, before consolidation decisions (the consolidate stage plans from this). */
export function preConsolidation(analysis: string): Finding[] {
  const scope = loadScope(analysis);
  if (!scope) return [];
  return mergeShards(loadShards(analysis, scope.source).shards, scope.source);
}
