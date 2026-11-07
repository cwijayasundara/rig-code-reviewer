// Model configuration: main / evaluator / writer / orchestrator roles, precedence,
// validation, and that the choice actually reaches the stage processes and agents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { agentChoice, independenceWarning, loadConfig, stageChoice, validateConfig } from "../scripts/lib/config.ts";
import { buildPlan } from "../scripts/lib/plan.ts";
import { writeBriefs } from "../scripts/lib/briefs.ts";
import { APP, ROOT, cli, put, tree } from "./testkit.ts";

test("defaults: writer stages on sonnet/medium, dispatch stages on sonnet/low, agents keep their frontmatter", () => {
  assert.deepEqual(stageChoice({}, "architecture"), { model: "sonnet", effort: "medium" });
  assert.deepEqual(stageChoice({}, "verify"), { model: "sonnet", effort: "low" });
  assert.deepEqual(agentChoice({}, "security-verifier"), {}, "no override: frontmatter (opus) decides");
  assert.equal(independenceWarning({}), null);
});

test("roles: main drives finders (and writer model unless set), evaluator drives verifiers; stages/agents override", () => {
  const c = { main: { model: "opus", effort: "medium" as const }, evaluator: { model: "fable" }, stages: { report: { effort: "high" as const } }, agents: { "security-auditor": { effort: "xhigh" as const } } };
  assert.deepEqual(agentChoice(c, "quality-reviewer"), { model: "opus", effort: "medium" });
  assert.deepEqual(agentChoice(c, "security-auditor"), { model: "opus", effort: "xhigh" });
  assert.deepEqual(agentChoice(c, "finding-verifier"), { model: "fable" });
  assert.deepEqual(stageChoice(c, "preflight"), { model: "opus", effort: "medium" }, "writer follows main.model, keeps its own effort");
  assert.deepEqual(stageChoice(c, "report"), { model: "opus", effort: "high" });
  assert.deepEqual(stageChoice(c, "deep"), { model: "sonnet", effort: "low" }, "orchestrator is its own role");
  assert.deepEqual(stageChoice(c, "map"), { model: "sonnet", effort: "low" }, "map only dispatches its planned analysts");
  assert.deepEqual(stageChoice({ main: { model: "opus" }, writer: { model: "haiku" } }, "assess"), { model: "haiku", effort: "medium" });
  assert.match(independenceWarning({ main: { model: "opus" }, evaluator: { model: "opus" } })!, /different model tier/);
});

test("validation names every problem", () => {
  assert.deepEqual(validateConfig({ main: { model: "sonnet", effort: "high" }, evaluator: { model: "claude-opus-5-5" } }), []);
  const e = validateConfig({ main: { model: "gpt-5", effort: "huge", temp: 1 }, mains: {}, agents: { x: "opus" } });
  assert.equal(e.length, 5, e.join("\n"));
});

test("precedence: built-in < <source>/.code-review/config.json < --config; a bad file fails init loudly", () => {
  const src = tree({ "src/app.py": APP });
  put(src, ".code-review/config.json", { main: { model: "opus" }, evaluator: { model: "fable" } });
  const extra = join(src, "override.json");
  put(src, "override.json", { evaluator: { effort: "max" } });
  const { config, files } = loadConfig(src, extra);
  assert.deepEqual(config.evaluator, { model: "fable", effort: "max" });
  assert.deepEqual(config.main, { model: "opus" });
  assert.equal(files.length, 2);
  assert.throws(() => loadConfig(src, join(src, "missing.json")), /file not found/);

  put(src, ".code-review/config.json", { main: { model: "gpt-5" } });
  const bad = cli(["init", "x", "--source", src]);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err + bad.out, /gpt-5/);
});

test("init freezes the resolved config; agent overrides reach the workflow args and the workflow passes them to agent()", async () => {
  const src = tree({ "src/app.py": APP });
  put(src, ".code-review/config.json", { evaluator: { model: "fable", effort: "high" } });
  assert.equal(cli(["init", "p", "--source", src, "--dimensions", "security"]).code, 0);
  const a = join(src, ".code-review", "p");
  assert.deepEqual(JSON.parse(readFileSync(join(a, "config.json"), "utf8")).evaluator, { model: "fable", effort: "high" });
  put(a, "findings.json", { version: 1, findings: [{ id: "SEC-00000001", dimension: "security", severity: "High", confidence: "high", file: "src/app.py", line: 4, title: "t", evidence: "e", impact: "i", recommendation: "r", effort: "S", fingerprint: "v1:x", category: "CWE-89", reporters: 1, shards: [] }] });
  const args = writeBriefs(a, src, buildPlan(a, "verify"));
  assert.deepEqual(args.tasks[0], ["sec--outside--REACHABILITY", "security-verifier", "fable", "high"]);

  const wf = readFileSync(join(ROOT, "workflows/review-tasks.js"), "utf8").replace(/export const meta = \{[\s\S]*?\n\};/, "");
  const seen: { model?: string; effort?: string }[] = [];
  const g = {
    args: { stage: "verify", sourceDir: "/s", analysisDir: "/a", tasks: [...args.tasks, ["k2", "finding-verifier"], ["k3", "finding-verifier", "x y", "huge"]] },
    agent: async (_p: string, o: { model?: string; effort?: string }) => { seen.push({ model: o.model, effort: o.effort }); return { done: true }; },
    parallel: async (fs: (() => Promise<unknown>)[]) => Promise.all(fs.map((f) => f())),
    log: () => {}, phase: () => {},
  };
  await (runInNewContext(`(async () => {${wf}\n})()`, g) as Promise<unknown>);
  const fable = { model: "fable", effort: "high" };
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), [fable, fable, fable, {}, {}], "three lens agents on the evaluator; frontmatter when unset; malformed values dropped");
});
