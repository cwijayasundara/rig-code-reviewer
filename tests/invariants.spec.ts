// Structural invariants (rig's self-test pattern): the plugin's parts agree
// with each other, stay small, and every gate can actually fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../scripts/review.ts";
import { allowedTools, CeilingTracker, DenialTracker, denialHint, recordUsage, stageArgs, stageEnv, systemicLoss } from "../scripts/lib/run.ts";
import { mergeTopology } from "../scripts/lib/topology.ts";
import { usdPerAgent } from "../scripts/lib/plan.ts";
import { validateTopology } from "../scripts/lib/architecture.ts";
import { guardEdit } from "../scripts/lib/guard.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { AGENT } from "../scripts/lib/plan.ts";
import { hasSecret, redact } from "../scripts/lib/redact.ts";
import { FAKE_AWS_KEY, put, ROOT } from "./testkit.ts";

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const walk = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((n) => {
  const rel = `${dir}/${n}`;
  return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : [rel];
});
const front = (md: string) => Object.fromEntries((md.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "").split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));

test("versions agree: plugin.json, marketplace.json, package.json, CHANGELOG", () => {
  const v = JSON.parse(read(".claude-plugin/plugin.json")).version;
  assert.equal(JSON.parse(read("package.json")).version, v);
  assert.equal(JSON.parse(read(".claude-plugin/marketplace.json")).plugins[0].version, v);
  assert.match(read("CHANGELOG.md"), new RegExp(`^## ${v.replace(/\./g, "\\.")}`, "m"));
});

test("size budget: scripts <= 500 lines, skills <= 60 lines, agents <= 60 lines", () => {
  for (const f of walk("scripts").filter((f) => f.endsWith(".ts"))) assert.ok(read(f).split("\n").length <= 500, `${f} too long`);
  for (const f of walk("skills")) assert.ok(read(f).split("\n").length <= 60, `${f} too long`);
  for (const f of walk("agents")) assert.ok(read(f).split("\n").length <= 60, `${f} too long`);
});

test("agents: model aliases only (never a versioned id), read-only tool set + Write for their own output", () => {
  for (const f of walk("agents")) {
    const fm = front(read(f));
    assert.ok(["sonnet", "opus", "haiku", "inherit"].includes(fm.model ?? ""), `${f}: model must be an alias, got ${fm.model}`);
    assert.equal(fm.tools, "Read, Glob, Grep, Bash, Write", `${f}: tools`);
    assert.equal(`${fm.name}.md`, f.split("/").pop());
  }
});

test("verifiers run on a different model tier than finders", () => {
  const model = (n: string) => front(read(`agents/${n}.md`)).model;
  for (const finder of [...Object.values(AGENT), "security-auditor"]) {
    assert.notEqual(model(finder), model("finding-verifier"), `${finder} vs finding-verifier`);
    assert.notEqual(model(finder), model("security-verifier"), `${finder} vs security-verifier`);
  }
});

test("every agent the planner dispatches exists", () => {
  for (const a of [...Object.values(AGENT), "security-auditor", "threat-modeler", "security-verifier", "finding-verifier", "finding-consolidator"]) {
    assert.ok(existsSync(join(ROOT, "agents", `${a}.md`)), `missing agents/${a}.md`);
  }
});

test("skills: valid frontmatter, only existing CLI commands, Bash allowed for the CLI they call", () => {
  for (const f of walk("skills")) {
    const md = read(f);
    const fm = front(md);
    assert.ok(fm.name && fm.description, `${f}: name + description`);
    const used = [...md.matchAll(/`R ([a-z-]+)/g)].map((m) => m[1]!);
    for (const c of used) assert.ok(COMMANDS[c], `${f}: unknown CLI command ${c}`);
    if (used.length) assert.match(fm["allowed-tools"] ?? "", /Bash\(node --disable-warning=ExperimentalWarning \$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/review\.ts:\*\)/, `${f}: allowed-tools must permit the CLI`);
    if (/AskUserQuestion/.test(md.replace(/^---[\s\S]*?---/, ""))) assert.match(fm["allowed-tools"] ?? "", /AskUserQuestion/, `${f}: uses AskUserQuestion`);
    if (/Workflow/.test(md.replace(/^---[\s\S]*?---/, ""))) assert.match(fm["allowed-tools"] ?? "", /Workflow\(code-review-harness:review-tasks\)/, `${f}: Workflow permission`);
  }
});

test("human-only skill cannot be model-invoked; headless allowlist never permits REVIEW_HUMAN or mutating commands", () => {
  assert.equal(front(read("skills/review-accept/SKILL.md"))["disable-model-invocation"], "true");
  const tools = allowedTools("/plugin").join(" ");
  assert.doesNotMatch(tools, /REVIEW_HUMAN|git commit|git push|npm install|rm:|Bash\(\*\)/);
  assert.match(tools, /Bash\(node --disable-warning=ExperimentalWarning \/plugin\/scripts\/review\.ts:\*\)/);
});

test("every headless stage pins its model and effort, drops user MCP/plugins, and never uses --bare (it would skip the guard hooks)", () => {
  for (const stage of ["preflight", "assess", "map", "deep", "security", "consolidate", "verify", "architecture", "report"] as const) {
    const a = stageArgs(stage, {});
    assert.match(a[a.indexOf("--model") + 1]!, /^[a-z]/, `${stage} has a pinned model`);
    assert.match(a[a.indexOf("--effort") + 1]!, /^(low|medium|high|xhigh|max)$/);
    assert.ok(a.includes("--strict-mcp-config"));
    assert.deepEqual(a.slice(a.indexOf("--setting-sources"), a.indexOf("--setting-sources") + 2), ["--setting-sources", "project,local"]);
    assert.ok(!a.includes("--bare"));
  }
  assert.deepEqual(stageArgs("architecture", {}).slice(0, 4), ["--model", "sonnet", "--effort", "medium"]);
  const o = stageArgs("verify", {}, { model: "opus", effort: "high", userSettings: true });
  assert.deepEqual(o.slice(0, 4), ["--model", "opus", "--effort", "high"]);
  assert.ok(!o.includes("--setting-sources"));
});

test("usage keeps uncached / cache-read / cache-write input apart and per-model spend, accumulated across retries", () => {
  const a = mkdtempSync(join(tmpdir(), "crh-usage-"));
  const ev = { usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 5 }, total_cost_usd: 0.5, modelUsage: { "claude-sonnet-5-5": { costUSD: 0.1 }, "claude-opus-5-5": { costUSD: 0.4 } } };
  recordUsage(a, "verify", ev, 3);
  recordUsage(a, "verify", ev, 1);
  const s = JSON.parse(readFileSync(join(a, "usage.json"), "utf8")).stages[0];
  assert.equal(s.input_tokens, 2420);
  assert.deepEqual([s.uncached_input_tokens, s.cache_read_input_tokens, s.cache_creation_input_tokens, s.agents], [20, 2000, 400, 4]);
  assert.deepEqual(s.models, { "claude-sonnet-5-5": 0.2, "claude-opus-5-5": 0.8 });
});

test("hooks.json: every hook command is a real CLI hook mode", () => {
  const h = JSON.parse(read("hooks/hooks.json"));
  const cmds = Object.values(h.hooks).flat().flatMap((e: any) => e.hooks.map((x: any) => x.command as string));
  assert.ok(cmds.length >= 3);
  for (const c of cmds) assert.match(c, /scripts\/review\.ts\\?" hook (guard-edit|guard-bash|validate-write)$/);
  assert.deepEqual(h.modules, ["./register.tsx"]);
});

test("no Python left behind; no versioned model ids anywhere in plugin text", () => {
  assert.equal(walk("scripts").filter((f) => f.endsWith(".py")).length, 0);
  for (const f of [...walk("agents"), ...walk("skills"), ...walk("workflows")]) assert.doesNotMatch(read(f), /claude-(opus|sonnet|haiku)-\d/, f);
});

test("selftest: every gate rejects a seeded violation (a check that cannot fail is not a check)", () => {
  assert.ok(hasSecret("token = ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
  assert.ok(hasSecret("postgres://admin:hunter2pass@db:5432/x"));
  assert.ok(!hasSecret("password = [REDACTED]"));
  assert.ok(!hasSecret("key AKIA****"));
  const r = redact(`aws ${FAKE_AWS_KEY} and password: s3cr3tvalue`);
  assert.equal(r.count, 2);
  assert.doesNotMatch(r.text, /AKIAABCD|s3cr3tvalue/);
});

const HEADLESS = ["preflight", "assess", "map", "deep", "security", "consolidate", "verify", "architecture", "report"] as const;

test("every headless stage skill forbids ad-hoc scripts (a missing CLI command shows up as a stop, not a refused permission)", () => {
  for (const st of HEADLESS) assert.match(read(`skills/review-${st}/SKILL.md`), /Never write or run ad-hoc scripts; if a step seems to need one, stop and report it\./, st);
  // The map stage merges analyst fragments through the CLI and never writes topology.json itself.
  const map = read("skills/review-map/SKILL.md");
  assert.match(map, /fragments\/<unit>\.json/);
  assert.match(map, /`R merge-topology \$ARGUMENTS`/);
});

test("merge-topology: fragments sharing a module merge into one schema-valid topology.json; bad edges dropped and counted", () => {
  const a = mkdtempSync(join(tmpdir(), "crh-topo-"));
  put(a, "evidence.json", { file_sloc: { "src/api/a.ts": 40, "src/api/b.ts": 60, "src/db/x.ts": 25 } });
  put(a, "fragments/api.json", {
    modules: [{ name: "api", path: "src/api", lines: 7, kind: "service" }, { name: "db", path: "src/db" }],
    edges: [{ from: "api", to: "db", type: "call", evidence: "src/api/a.ts:3" }, { from: "api", type: "call", evidence: "src/api/a.ts:9" }],
    data_stores: [{ name: "pg", evidence: "src/db/x.ts:1" }], observations: ["shared note"],
  });
  put(a, "fragments/db.json", {
    modules: [{ name: "db", path: "src/db", lines: 999, description: "persistence" }],
    edges: [{ from: "api", to: "db", type: "call", evidence: "src/api/a.ts:3" }, { from: "db", to: "pg", type: "write", evidence: "no citation" }],
    data_stores: [{ name: "pg", evidence: "src/db/x.ts:1" }], observations: ["shared note"],
  });
  const r = mergeTopology(a);
  assert.equal(r.written, true, r.errors.join("; "));
  assert.deepEqual([r.fragments, r.modules, r.duplicate_modules, r.edges], [2, 2, 1, 1]);
  assert.deepEqual(r.dropped_edges, { missing_from_or_to: 1, bad_evidence: 1, bad_type: 0 });
  const t = JSON.parse(readFileSync(join(a, "topology.json"), "utf8"));
  assert.deepEqual(validateTopology(t), []);
  const db = t.modules.find((m: { name: string }) => m.name === "db");
  assert.deepEqual([t.modules.find((m: { name: string }) => m.name === "api").lines, db.lines, db.description], [100, 25, "persistence"], "lines from evidence; later fragment fills gaps");
  assert.deepEqual([t.data_stores.length, t.observations], [1, ["shared note"]]);

  const empty = mkdtempSync(join(tmpdir(), "crh-topo-"));
  const e = mergeTopology(empty);
  assert.equal(e.written, false);
  assert.match(e.errors[0]!, /no fragments/);
  assert.equal(existsSync(join(empty, "topology.json")), false);
});

test("guard: topology.json is script-owned while a review is active", () => {
  const src = mkdtempSync(join(tmpdir(), "crh-src-"));
  const analysis = join(src, ".code-review", "r");
  put(analysis, "scope.json", { name: "r", source: src, analysis_dir: analysis });
  put(src, ".code-review/active.json", { name: "r", analysis_dir: analysis, source: src });
  const d = guardEdit({ tool_name: "Write", cwd: src, tool_input: { file_path: join(analysis, "topology.json") } });
  assert.ok(d && "deny" in d && /merge|review\.ts/.test(d.deny), JSON.stringify(d));
  assert.equal(guardEdit({ tool_name: "Write", cwd: src, tool_input: { file_path: join(analysis, "fragments", "api.json") } }), null);
});

test("per-shard cost is calibrated from completed shards; lost agents and wholesale-lost batches don't skew it", () => {
  const a = mkdtempSync(join(tmpdir(), "crh-calib-"));
  assert.equal(usdPerAgent(a, "deep"), 0.45, "no measurement: the static default");
  recordUsage(a, "deep", { total_cost_usd: 10 }, 24, 24); // batch 1: 24 started, 24 produced
  assert.equal(usdPerAgent(a, "deep"), 10 / 24);
  recordUsage(a, "deep", { total_cost_usd: 5 }, 24, 0); // batch 2 lost wholesale: totalled, not calibrated
  assert.equal(usdPerAgent(a, "deep"), 10 / 24);
  recordUsage(a, "deep", { total_cost_usd: 6 }, 24, 12); // half lost: spend over shards produced
  assert.equal(usdPerAgent(a, "deep"), 16 / 36);
  const s = JSON.parse(readFileSync(join(a, "usage.json"), "utf8")).stages[0];
  assert.deepEqual([s.total_cost_usd, s.agents, s.calib_usd, s.calib_agents], [21, 72, 16, 36]);
});

test("stage env lifts the headless wait ceiling unless the user set one", () => {
  assert.equal(stageEnv({}, "/a").CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, "0");
  assert.equal(stageEnv({ CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "1800000" }, "/a").CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, "1800000");
  assert.equal(stageEnv({}, "/a").CODE_REVIEW_OUT, "/a");
});

test("lost-shard retry: one stray loss retries, a mostly-lost batch does not", () => {
  assert.equal(systemicLoss(1, 1), false);
  assert.equal(systemicLoss(1, 24), false);
  assert.equal(systemicLoss(12, 24), false);
  assert.equal(systemicLoss(13, 24), true);
  assert.equal(systemicLoss(23, 24), true);
});

test("ceiling tracker reads the CLI's own messages, not repository content", () => {
  const t = new CeilingTracker();
  t.see(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "env CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0" }] } }));
  t.see(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "background agents were stopped" }] } }));
  assert.equal(t.hit, false);
  t.see("Background tasks still running after 600000ms were stopped");
  assert.equal(t.hit, true);
  const r = new CeilingTracker();
  r.see(JSON.stringify({ type: "result", result: "Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait longer" }));
  assert.equal(r.hit, true);
});

test("stage runner names the tool calls the permission check refused", () => {
  const t = new DenialTracker();
  t.see(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "python3 merge.py" } }] } }));
  t.see(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "Claude requested permissions to use Bash, but you haven't granted it yet." }] } }));
  t.see(JSON.stringify({ type: "result", permission_denials: [{ tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "python3 merge.py" } }] }));
  t.see("not json");
  assert.deepEqual(t.denied, ["Bash(python3 merge.py)"]);
  assert.match(denialHint("map", t.denied), /stage map needed Bash\(python3 merge\.py\), which the headless allowlist denies/);
  assert.equal(denialHint("map", []), "");
});
