// Structural invariants (rig's self-test pattern): the plugin's parts agree
// with each other, stay small, and every gate can actually fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../scripts/review.ts";
import { allowedTools, recordUsage, stageArgs } from "../scripts/lib/run.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { AGENT } from "../scripts/lib/plan.ts";
import { hasSecret, redact } from "../scripts/lib/redact.ts";
import { FAKE_AWS_KEY, ROOT } from "./testkit.ts";

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
