// Deterministic scorer for seeded-defect cases. A catch counts only when a
// CONFIRMED finding names the defect's file and matches its regex — never a
// model's judgement. mustNot entries count confirmed false positives.
import { join } from "node:path";
import { SEV_RANK, type Finding, type Severity } from "../scripts/lib/types.ts";
import { readJson } from "../scripts/lib/util.ts";

export interface Expect { id: string; file: string; regex?: string; dimension?: string; lineRange?: [number, number]; minSeverity?: Severity }
export interface Case { description: string; must: Expect[]; should?: Expect[]; mustNot: Expect[] }
export interface Score { caught: string[]; missed: string[]; shouldCaught: string[]; falsePositives: { rule: string; id: string; title: string }[]; recall: number | null; confirmed: number; colocated: number; duplicatesOfMust: number }

function matches(f: Finding, e: Expect): boolean {
  if (e.file !== "*" && f.file !== e.file) return false;
  if (e.dimension && f.dimension !== e.dimension) return false;
  if (e.lineRange && (f.line < e.lineRange[0] || f.line > e.lineRange[1])) return false;
  if (e.minSeverity && SEV_RANK[f.severity] > SEV_RANK[e.minSeverity]) return false;
  if (e.regex && !new RegExp(e.regex, "i").test([f.title, f.evidence, f.cwe ?? "", f.category].join(" "))) return false;
  return true;
}

export function score(findings: Finding[], c: Case): Score {
  const live = findings.filter((f) => f.verdict === "confirmed");
  const caught = c.must.filter((e) => live.some((f) => matches(f, e))).map((e) => e.id);
  const shouldCaught = (c.should ?? []).filter((e) => live.some((f) => matches(f, e))).map((e) => e.id);
  const falsePositives = c.mustNot.flatMap((e) => live.filter((f) => matches(f, e)).map((f) => ({ rule: e.id, id: f.id, title: f.title })));
  // Label-free duplicate proxy: confirmed findings beyond the first in each same-file cluster (lines within 3).
  let colocated = 0;
  const byFile = new Map<string, number[]>();
  for (const f of live) (byFile.get(f.file) ?? byFile.set(f.file, []).get(f.file)!).push(f.line);
  for (const lines of byFile.values()) {
    lines.sort((a, b) => a - b);
    for (let i = 1; i < lines.length; i++) if (lines[i]! - lines[i - 1]! <= 3) colocated++;
  }
  // A duplicate of a planted defect: another confirmed finding (any dimension) whose TITLE names the
  // defect and that sits within 3 lines of a primary hit — not merely any text mentioning a keyword.
  const duplicatesOfMust = c.must.reduce((n, e) => {
    const primary = live.filter((f) => matches(f, e));
    if (!primary.length || !e.regex) return n;
    const re = new RegExp(e.regex, "i");
    return n + live.filter((f) => !primary.includes(f) && f.file === primary[0]!.file && re.test(f.title)
      && primary.some((p) => Math.abs(p.line - f.line) <= 3)).length + primary.length - 1;
  }, 0);
  return {
    colocated, duplicatesOfMust,
    caught, missed: c.must.map((e) => e.id).filter((id) => !caught.includes(id)), shouldCaught, falsePositives,
    recall: c.must.length ? caught.length / c.must.length : null, confirmed: live.length,
  };
}

export function scoreDir(analysis: string, casePath: string): Score {
  const findings = readJson<{ findings?: Finding[] }>(join(analysis, "findings.json"), {}).findings ?? [];
  return score(findings, readJson<Case>(join(casePath, "expected.json"), { description: "", must: [], mustNot: [] }));
}

export interface Gate { minRecall?: number; maxFalsePositives?: number; maxUsd?: number; maxDuplicatesOfMust?: number; maxColocated?: number }
export function gate(s: Score, usd: number, g: Gate | undefined): { status: "pass" | "fail" | "not enforced"; reasons: string[] } {
  if (!g) return { status: "not enforced", reasons: ["no baseline entry for this case"] };
  const reasons: string[] = [];
  if (g.minRecall !== undefined && s.recall !== null && s.recall < g.minRecall) reasons.push(`recall ${s.recall} < ${g.minRecall}`);
  if (g.maxFalsePositives !== undefined && s.falsePositives.length > g.maxFalsePositives) reasons.push(`false positives ${s.falsePositives.length} > ${g.maxFalsePositives}`);
  if (g.maxUsd !== undefined && usd > g.maxUsd) reasons.push(`cost $${usd.toFixed(2)} > $${g.maxUsd}`);
  if (g.maxDuplicatesOfMust !== undefined && s.duplicatesOfMust > g.maxDuplicatesOfMust) reasons.push(`duplicates of planted defects ${s.duplicatesOfMust} > ${g.maxDuplicatesOfMust}`);
  if (g.maxColocated !== undefined && s.colocated > g.maxColocated) reasons.push(`co-located confirmed findings ${s.colocated} > ${g.maxColocated}`);
  return { status: reasons.length ? "fail" : "pass", reasons };
}
