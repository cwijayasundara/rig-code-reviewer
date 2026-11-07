import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { buildPlan } from "../scripts/lib/plan.ts";
import { writeBriefs } from "../scripts/lib/briefs.ts";
import { loadShards } from "../scripts/lib/findings.ts";
import { runMerge } from "../scripts/lib/merge.ts";
import { mergeTopology } from "../scripts/lib/topology.ts";
import { buildStatus } from "../scripts/lib/status.ts";
import { watchable } from "../scripts/lib/progress.ts";
import { allowedTools, stageCwd } from "../scripts/lib/run.ts";
import { within } from "../scripts/lib/paths.ts";
import { DEFAULT_MAX_AGENTS, DEFAULT_MAX_FINDINGS } from "../scripts/lib/types.ts";
import { APP, ROOT, cli, put, tree } from "./testkit.ts";

function review(dims: string, files: Record<string, number>, modules: { name: string; path: string }[], flags: string[] = []) {
  const src = tree({ "src/app.py": APP });
  assert.equal(cli(["init", "s", "--source", src, "--dimensions", dims, ...flags]).code, 0);
  const a = join(src, ".code-review", "s");
  put(a, "evidence.json", { files: Object.keys(files), file_sloc: files });
  if (modules.length) put(a, "topology.json", { modules, edges: [] });
  return { src, a };
}

test("stages run outside the source tree and reach it through --add-dir and git -C", () => {
  const src = tree({ "src/app.py": APP });
  const a = join(src, ".code-review", "x");
  const cwd = stageCwd(a);
  assert.ok(!within(cwd, src), "the source's CLAUDE.md and project settings are not on the stage's path");
  assert.equal(stageCwd(a), cwd, "stable per review");
  const tools = allowedTools("/plugin", src);
  assert.ok(tools.includes(`Bash(git -C ${src} log:*)`));
  assert.ok(!tools.some((t) => /git -C .* (commit|push|checkout)/.test(t)), "read-only git only");
  const dry = cli(["run", "d", "--source", src, "--dry-run"]);
  assert.equal(dry.code, 0, dry.out + dry.err);
  assert.doesNotMatch(dry.out, new RegExp(`\\(cwd=${src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
});

test("the threat model is planned in deep beside the reviewers; security then skips it and has no barrier", () => {
  const { src, a } = review("quality,security", { "src/m0/a.py": 4000 }, [{ name: "m0", path: "src/m0" }]);
  const deep = buildPlan(a, "deep");
  assert.deepEqual(deep.run.map((t) => t.agent), ["threat-modeler", "quality-reviewer"]);
  assert.match(deep.estimate.formula, /1 whole-system threat model \(for security\)/);
  writeBriefs(a, src, deep);
  const tb = readFileSync(join(a, "briefs/deep/threat--system.md"), "utf8");
  assert.match(tb, /Map the attack surface/);
  assert.match(tb, /review\.ts digest /, "system agents start from the digest");
  assert.match(tb, /### <module name>/);
  put(a, "threat/system.md", "### m0\n- entry src/m0/a.py:1");
  const sec = buildPlan(a, "security");
  assert.ok(!sec.run.some((t) => t.agent === "threat-modeler"));
  assert.ok(sec.skipped.includes("threat--system"));
  assert.match(sec.estimate.formula, /threat model already mapped \(deep stage\)/);
  writeBriefs(a, src, sec);
  const ab = readFileSync(join(a, "briefs/security/m0--all-categories.md"), "utf8");
  assert.match(ab, /Do not Read it whole: Grep it for your module name\(s\) \(m0\)/);
  // Security-only scope: no deep stage, so security plans its own threat model.
  const only = review("security", { "src/m0/a.py": 4000 }, [{ name: "m0", path: "src/m0" }]);
  assert.ok(buildPlan(only.a, "security").run.some((t) => t.agent === "threat-modeler"));
});

async function runWorkflow(stage: string, tasks: string[][]) {
  const src = readFileSync(join(ROOT, "workflows/review-tasks.js"), "utf8");
  const body = src.replace(/export const meta = \{[\s\S]*?\n\};/, "");
  const batches: string[][] = [];
  const g = {
    args: { stage, sourceDir: "/s", analysisDir: "/a", tasks },
    agent: async (_p: string, o: { agentType: string }) => ({ done: true, agent: o.agentType }),
    parallel: async (fs: (() => Promise<{ agent: string }>)[]) => { const r = await Promise.all(fs.map((f) => f())); batches.push(r.map((x) => x.agent.split(":")[1]!)); return r; },
    log: () => {}, phase: () => {},
  };
  await (runInNewContext(`(async () => {${body}\n})()`, g) as Promise<unknown>);
  return batches.filter((b) => b.length);
}

test("workflow: only the security stage waits for a threat model", async () => {
  assert.deepEqual(await runWorkflow("deep", [["threat--system", "threat-modeler"], ["q--m0", "module-reviewer"]]), [["threat-modeler", "module-reviewer"]], "deep: one parallel batch");
  assert.deepEqual(await runWorkflow("security", [["threat--system", "threat-modeler"], ["m0--all-categories", "security-auditor"]]), [["threat-modeler"], ["security-auditor"]]);
});

test("findings per shard are capped by severity at merge, disclosed in coverage, and stated in briefs", () => {
  const { src, a } = review("quality", { "src/app.py": 6 }, [{ name: "core", path: "src" }], ["--max-findings", "2"]);
  assert.equal(JSON.parse(readFileSync(join(a, "scope.json"), "utf8")).max_findings_per_shard, 2);
  const f = (severity: string, line: number) => ({ dimension: "quality", severity, confidence: "high", file: "src/app.py", line, title: `t${line}`, evidence: `src/app.py:${line}`, impact: "i", recommendation: "r", effort: "S" });
  writeBriefs(a, src, buildPlan(a, "deep"));
  assert.match(readFileSync(join(a, "briefs/deep/quality--core.md"), "utf8"), /File at most 2 findings, the most severe first/);
  put(a, "raw/deep/quality--core.json", { shard: "quality--core", filesRead: [], notReached: [], findings: [f("Nit", 1), f("High", 3), f("Low", 5), f("Medium", 6)] });
  const sh = loadShards(a, src, 2).shards[0]!;
  assert.deepEqual(sh.findings.map((x) => x.severity), ["High", "Medium"]);
  assert.deepEqual(sh.capped, { filed: 4, kept: 2 });
  runMerge(a);
  assert.deepEqual(JSON.parse(readFileSync(join(a, "coverage.json"), "utf8")).capped_shards, [{ shard: "quality--core", filed: 4, kept: 2 }]);
  assert.notEqual(cli(["init", "s", "--source", src, "--max-findings", "0"]).code, 0);
  const fresh = review("quality", {}, []);
  assert.equal(JSON.parse(readFileSync(join(fresh.a, "scope.json"), "utf8")).max_findings_per_shard, DEFAULT_MAX_FINDINGS);
  assert.equal(JSON.parse(readFileSync(join(fresh.a, "scope.json"), "utf8")).max_agents, DEFAULT_MAX_AGENTS);
});

test("scanner candidates are never capped", () => {
  const { src, a } = review("security", { "src/app.py": 6 }, [{ name: "core", path: "src" }]);
  const f = (line: number) => ({ dimension: "security", severity: "Low", confidence: "high", file: "src/app.py", line, title: `s${line}`, evidence: `src/app.py:${line}`, impact: "i", recommendation: "r", effort: "S", cwe: "CWE-798", exploit_scenario: "a reader of the repo uses the committed key" });
  put(a, "raw/scanner/gitleaks.json", { shard: "scanner:gitleaks", filesRead: [], notReached: [], findings: [1, 2, 3].map(f) });
  assert.equal(loadShards(a, src, 1).shards[0]!.findings.length, 3);
});

test("map is a planned stage: one analyst per map unit, resume skips valid fragments, merge takes only planned fragments", () => {
  const files = { "svc/a/x.py": 9000, "svc/b/y.py": 9000, "lib/z.py": 200 };
  const { src, a } = review("quality", files, []);
  const p = buildPlan(a, "map");
  assert.ok(p.run.length >= 2 && p.run.every((t) => t.agent === "codebase-analyst" && t.out === `fragments/${t.key}.json`));
  assert.match(p.estimate.formula, /map unit\(s\) x 1 analyst/);
  writeBriefs(a, src, p);
  const b = readFileSync(join(a, `briefs/map/${p.run[0]!.key}.md`), "utf8");
  assert.match(b, /Map the structure of ONE map unit/);
  assert.match(b, /## Your scope/);
  assert.match(b, /topology\.schema\.json/);
  const frag = (name: string, path: string) => ({ modules: [{ name, path }], edges: [], entry_points: [], data_stores: [], externals: [], flows: [], observations: [] });
  put(a, `fragments/${p.run[0]!.key}.json`, frag("first", "svc/a"));
  put(a, "fragments/stale-from-an-old-map.json", frag("stale", "svc"));
  const again = buildPlan(a, "map");
  assert.ok(again.skipped.includes(p.run[0]!.key), "a valid fragment is not re-run");
  for (const t of again.run) put(a, t.out, frag(t.key, "svc/b"));
  const m = mergeTopology(a);
  assert.ok(m.written, m.errors.join("; "));
  const names = JSON.parse(readFileSync(join(a, "topology.json"), "utf8")).modules.map((x: { name: string }) => x.name);
  assert.ok(!names.includes("stale"), "fragments the plan does not name are ignored");
  assert.ok(names.includes("first"));
  assert.ok("map" in buildStatus(a).shards.plans);
});

test("watch forwards stage events, not tool calls, stage stderr or resume skips", () => {
  const ts = "12:00:00 ";
  assert.equal(watchable(ts + "==> deep: fresh process"), true);
  assert.equal(watchable(ts + "--- deep: done · findings 3"), true);
  assert.equal(watchable(ts + "error: stage deep exited 1"), true);
  assert.equal(watchable(ts + "    · Read src/error_handler.py"), false, "a file name is not an event");
  assert.equal(watchable(ts + "      ↳ agent x: lost track"), false);
  assert.equal(watchable(ts + "    ! warning: something the model's tool printed"), false);
  assert.equal(watchable(ts + "--- deep: gate passes, skipping (resume)"), false);
});
