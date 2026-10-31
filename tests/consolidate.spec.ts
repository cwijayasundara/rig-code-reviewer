import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyConsolidation, candidateGroups, validateDecision } from "../scripts/lib/consolidate.ts";
import { runMerge } from "../scripts/lib/merge.ts";
import { buildPlan } from "../scripts/lib/plan.ts";
import { validateOnWrite } from "../scripts/lib/guard.ts";
import type { Finding } from "../scripts/lib/types.ts";
import { APP, cli, put, tree } from "./testkit.ts";

const F = (id: string, dimension: string, line: number, over: Partial<Finding> = {}): Finding => ({
  id, dimension, line, file: "src/app.py", severity: "Low", confidence: "high", title: `t ${id}`, evidence: "e", impact: "i",
  recommendation: "r", effort: "S", fingerprint: `v1:${id}`, category: dimension, reporters: 1, shards: [`s-${id}`], ...over,
} as Finding);

test("candidate groups: same file, single-linkage within 5 lines; singletons and other files excluded", () => {
  const gs = candidateGroups([F("OPS-1", "operability", 9), F("PRF-1", "performance", 9), F("ARC-1", "architecture", 12), F("QUA-1", "quality", 40), F("DAT-1", "data", 9, { file: "src/b.py" })]);
  assert.equal(gs.length, 1);
  assert.deepEqual(gs[0]!.members, ["ARC-1", "OPS-1", "PRF-1"]);
  assert.match(gs[0]!.key, /^G-[0-9a-f]{10}$/);
});

test("decision validation: members only, each id once, reason required", () => {
  const g = candidateGroups([F("OPS-1", "operability", 9), F("PRF-1", "performance", 9)])[0]!;
  assert.deepEqual(validateDecision({ group: g.key, merges: [] }, g), []);
  assert.deepEqual(validateDecision({ group: g.key, merges: [{ keep: "OPS-1", merge: ["PRF-1"], reason: "same leak" }] }, g), []);
  assert.ok(validateDecision({ group: g.key, merges: [{ keep: "OPS-1", merge: ["SEC-9"], reason: "x" }] }, g).some((e) => e.includes("not a member")));
  assert.ok(validateDecision({ group: g.key, merges: [{ keep: "OPS-1", merge: ["OPS-1"], reason: "x" }] }, g).some((e) => e.includes("more than one")));
  assert.ok(validateDecision({ group: g.key, merges: [{ keep: "OPS-1", merge: ["PRF-1"] }] }, g).some((e) => e.includes("reason")));
});

test("applying a decision keeps one finding with worst severity, all reporters and aliases; stale decisions ignored", () => {
  const src = tree({ "src/app.py": APP });
  const fs = [F("OPS-1", "operability", 9), F("PRF-1", "performance", 9, { severity: "Medium" }), F("ARC-1", "architecture", 10)];
  const g = candidateGroups(fs)[0]!;
  put(src, `consolidate/${g.key}.json`, { group: g.key, merges: [{ keep: "OPS-1", merge: ["PRF-1", "ARC-1"], reason: "connection never closed" }] });
  put(src, "consolidate/G-0000000000.json", { group: "G-0000000000", merges: [{ keep: "X", merge: ["Y"], reason: "stale" }] });
  const r = applyConsolidation(fs.map((f) => ({ ...f })), src);
  assert.equal(r.findings.length, 1);
  const k = r.findings[0]!;
  assert.equal(k.id, "OPS-1");
  assert.equal(k.severity, "Medium");
  assert.equal(k.reporters, 3);
  assert.deepEqual(k.also_reported_as, ["ARC-1 (architecture)", "PRF-1 (performance)"]);
  assert.ok(k.aliases!.includes("v1:PRF-1"));
  assert.equal(r.merged, 2);
});

test("end to end: consolidate plan -> decision (validated on write) -> merge folds the duplicate before verify", () => {
  const src = tree({ "src/app.py": APP });
  assert.equal(cli(["init", "c", "--source", src]).code, 0);
  const a = join(src, ".code-review", "c");
  const raw = (dimension: string, title: string) => ({ dimension, severity: "Low", confidence: "high", file: "src/app.py", line: 5, title, evidence: "src/app.py:5", impact: "i", recommendation: "r", effort: "S" });
  put(a, "raw/deep/operability--core.json", { shard: "operability--core", filesRead: [], notReached: [], findings: [raw("operability", "Errors swallowed")] });
  put(a, "raw/deep/quality--core.json", { shard: "quality--core", filesRead: [], notReached: [], findings: [raw("quality", "Exception ignored")] });
  runMerge(a);
  const plan = buildPlan(a, "consolidate");
  assert.equal(plan.run.length, 1);
  const t = plan.run[0]!;
  const [keep, other] = (t.input.members as string[]);
  put(a, t.out, { group: t.key, merges: [{ keep, merge: ["NOT-A-MEMBER"], reason: "x" }] });
  const bad = validateOnWrite({ tool_input: { file_path: join(a, t.out) }, cwd: src });
  assert.ok(bad && "block" in bad && bad.block.includes("not a member"));
  put(a, t.out, { group: t.key, merges: [{ keep, merge: [other], reason: "the same swallowed exception" }] });
  assert.equal(validateOnWrite({ tool_input: { file_path: join(a, t.out) }, cwd: src }), null);
  const r = runMerge(a);
  assert.equal(r.consolidated, 1);
  assert.equal(JSON.parse(readFileSync(join(a, "findings.json"), "utf8")).findings.length, 1);
  assert.equal(buildPlan(a, "consolidate").run.length, 0, "decided groups are not re-planned");
  assert.equal(buildPlan(a, "verify").run.length, 1, "only the kept finding is verified");
});
