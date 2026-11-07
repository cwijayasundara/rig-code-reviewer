import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPlan, unitKind } from "../scripts/lib/plan.ts";
import { writeBriefs, SCOPE_FILES } from "../scripts/lib/briefs.ts";
import { buildStatus } from "../scripts/lib/status.ts";
import { isInfraFile } from "../scripts/lib/evidence.ts";
import { LEGACY_UNIT_LOC, MAX_UNIT_LOC, MIN_UNIT_LOC } from "../scripts/lib/modules.ts";
import { LimitTracker } from "../scripts/lib/run.ts";
import { APP, cli, put, tree } from "./testkit.ts";

/** A review with an application module, an IaC-only module and a test-only module. */
function mixed(dims = "quality,performance,testing,operability,security") {
  const src = tree({ "src/app.py": APP });
  assert.equal(cli(["init", "p", "--source", src, "--dimensions", dims]).code, 0);
  const a = join(src, ".code-review", "p");
  const files = ["svc/api/handler.py", "svc/api/db.py", "infra/stack/main.tf", "infra/stack/vars.tfvars", "infra/stack/values.yaml", "qa/test_api.py", "qa/conftest.py"];
  const file_sloc = Object.fromEntries(files.map((f) => [f, 4000]));
  put(a, "evidence.json", { languages: { Python: { files: 4, lines: 16000 } }, files, file_sloc, hotspots: [{ file: "svc/api/handler.py", churn: 3, complexity: 9, score: 1 }], complexity_top: [] });
  put(a, "topology.json", {
    modules: [{ name: "api", path: "svc/api" }, { name: "stack", path: "infra/stack" }, { name: "qa", path: "qa" }],
    edges: [{ from: "api", to: "db", type: "read", evidence: "svc/api/db.py:3" }],
    entry_points: [{ name: "POST /x", kind: "http", file: "svc/api/handler.py", line: 7 }],
  });
  return { src, a };
}

test("unit kind is derived from the evidence file list, never from names", () => {
  assert.equal(isInfraFile("deploy/main.tf"), true);
  assert.equal(isInfraFile("charts/values.yaml"), true);
  assert.equal(isInfraFile("pkg/Dockerfile"), true, "not a counted source language");
  assert.equal(isInfraFile("pkg/server.go"), false);
  assert.equal(isInfraFile("bin/run.sh"), false, "shell scripts are code");
  const u = (paths: string[]) => ({ name: "u", paths, modules: ["u"], lines: 1 });
  const files = ["a/x.py", "a/tests/test_x.py", "b/main.tf", "c/test_y.py"];
  assert.equal(unitKind(u(["a"]), files), "code");
  assert.equal(unitKind(u(["b"]), files), "infra");
  assert.equal(unitKind(u(["c"]), files), "test");
  assert.equal(unitKind(u(["missing"]), files), "code", "unknown files: full treatment");
});

test("deep: an infra-only unit gets no code-local reviewer; the plan says who covers it", () => {
  const { a } = mixed();
  const p = buildPlan(a, "deep");
  assert.deepEqual(p.run.map((t) => t.key), ["operability--system", "quality+performance+testing--qa", "quality+performance+testing--api"]);
  assert.match(p.estimate.formula, /1 infra-only unit\(s\) \(stack\) left to operability \+ security/);
});

test("security: infra-only units get a config/secrets auditor, test-only units are left to the secrets sweep", () => {
  const { a } = mixed();
  const p = buildPlan(a, "security");
  const keys = p.run.map((t) => t.key);
  assert.ok(keys.includes("api--all-categories"));
  assert.ok(keys.includes("stack--infra"));
  assert.ok(!keys.some((k) => k.startsWith("qa--")), "no per-unit auditor for a test-only unit");
  assert.ok(keys.includes("sweep--secrets-everywhere"), "the sweep covers the skipped test unit");
  const infra = p.run.find((t) => t.key === "stack--infra")!;
  assert.equal(infra.input.category, "crypto-and-secrets, config-and-exposure");
  assert.match(p.estimate.formula, /1 infra-only unit\(s\) x 1 config\/secrets auditor/);
  assert.match(p.estimate.formula, /1 test-only unit\(s\) covered by the secrets sweep/);
  // Low effort still sweeps for secrets when a test-only unit was skipped.
  put(a, "scope.json", { ...JSON.parse(readFileSync(join(a, "scope.json"), "utf8")), security_effort: "low" });
  const low = buildPlan(a, "security");
  assert.ok(low.run.some((t) => t.key === "sweep--secrets-everywhere"));
  assert.ok(!low.run.some((t) => t.key === "stack--infra"));
  assert.match(low.estimate.formula, /1 infra-only unit\(s\) not audited/);
});

test("security resume: an infra unit already audited for every category is not re-run", () => {
  const { a } = mixed();
  put(a, "raw/security/stack--all-categories.json", { shard: "stack--all-categories", filesRead: [], notReached: [], findings: [] });
  const p = buildPlan(a, "security");
  assert.ok(!p.run.some((t) => t.key === "stack--infra"));
  assert.ok(p.skipped.includes("stack--infra"));
});

test("unit briefs inline the unit's own files, hotspots and topology, and name the denied shell forms", () => {
  const { src, a } = mixed();
  writeBriefs(a, src, buildPlan(a, "deep"));
  const d = readFileSync(join(a, "briefs/deep/quality+performance+testing--api.md"), "utf8");
  assert.match(d, /## Your scope/);
  assert.match(d, /- svc\/api\/handler\.py \[4000\]/);
  assert.doesNotMatch(d, /infra\/stack\/main\.tf/, "only this unit's files");
  assert.match(d, /Hotspots[\s\S]*svc\/api\/handler\.py/);
  assert.match(d, /POST \/x \(http\) svc\/api\/handler\.py:7/);
  assert.match(d, /api -read-> db/);
  assert.match(d, /Interpreters \(python, node, jq\), shell loops/);
  writeBriefs(a, src, buildPlan(a, "security"));
  const s = readFileSync(join(a, "briefs/security/stack--infra.md"), "utf8");
  assert.match(s, /infrastructure-as-code/);
  assert.match(s, /- infra\/stack\/main\.tf/);
  assert.doesNotMatch(readFileSync(join(a, "briefs/security/sweep--secrets-everywhere.md"), "utf8"), /## Your scope/);
});

test("unit briefs cap the inline file list and point at Glob for the rest", () => {
  const { src, a } = mixed("quality");
  const files = Array.from({ length: SCOPE_FILES + 7 }, (_, i) => `svc/api/f${i}.py`);
  put(a, "evidence.json", { files, file_sloc: Object.fromEntries(files.map((f) => [f, 40])) });
  writeBriefs(a, src, buildPlan(a, "deep"));
  const d = readFileSync(join(a, "briefs/deep/quality--api.md"), "utf8");
  assert.match(d, /… 7 more: list them with Glob/);
});

test("unit packing is frozen in scope: new reviews use the current sizes, older ones keep theirs", () => {
  const src = tree({ "src/app.py": APP });
  assert.equal(cli(["init", "n", "--source", src]).code, 0);
  const a = join(src, ".code-review", "n");
  assert.deepEqual(JSON.parse(readFileSync(join(a, "scope.json"), "utf8")).unit_loc, [MIN_UNIT_LOC, MAX_UNIT_LOC]);
  const scope = JSON.parse(readFileSync(join(a, "scope.json"), "utf8"));
  delete scope.unit_loc;
  put(a, "scope.json", scope);
  assert.equal(cli(["init", "n", "--source", src]).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(a, "scope.json"), "utf8")).unit_loc, LEGACY_UNIT_LOC, "a review from before the change keeps its shard keys");
});

test("status carries what stage skills report, so no stage has to tally files itself", () => {
  const { a } = mixed();
  const f = (id: string, verdict: string, cwe?: string) => ({ id, dimension: cwe ? "security" : "quality", severity: "High", confidence: "high", file: "svc/api/db.py", line: 4, title: `t-${id}`, evidence: "e", impact: "i", recommendation: "r", effort: "S", fingerprint: `v1:${id}`, category: cwe ? "injection" : "quality", cwe, verdict, reporters: 1, shards: [] });
  put(a, "findings.json", { findings: [f("S1", "needs-human", "CWE-89"), f("S2", "confirmed", "CWE-89"), f("Q1", "needs-human")] });
  const s = buildStatus(a);
  assert.deepEqual(s.findings.by_security_category, { injection: 2 });
  assert.deepEqual(s.findings.by_cwe, { "CWE-89": 2 });
  assert.deepEqual(s.findings.needs_human.map((x) => x.id), ["S1", "Q1"]);
});

test("limit tracker reads the CLI's own messages, not repository content", () => {
  const t = new LimitTracker();
  t.see(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "429 rate limit exceeded" }] } }));
  t.see(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "usage limit reached" }] } }));
  assert.equal(t.hit, false);
  t.see(JSON.stringify({ type: "result", is_error: true, result: "You've hit your limit · resets 3am" }));
  assert.equal(t.hit, true);
  assert.match(t.detail, /hit your limit/);
  const e = new LimitTracker();
  e.see("Claude AI usage limit reached");
  assert.equal(e.hit, true, "stderr counts");
});
