import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPlan } from "../scripts/lib/plan.ts";
import { runMerge } from "../scripts/lib/merge.ts";
import { buildStatus } from "../scripts/lib/status.ts";
import { digest } from "../scripts/lib/digest.ts";
import { loadCtx, counts } from "../scripts/lib/report-ctx.ts";
import { DEFAULT_VERIFY_MIN } from "../scripts/lib/types.ts";
import { APP, cli, put, tree } from "./testkit.ts";

const LONG = APP + Array.from({ length: 120 }, (_, i) => `x${i} = ${i}`).join("\n") + "\n";

function withFindings(flags: string[] = []) {
  const src = tree({ "src/app.py": LONG });
  assert.equal(cli(["init", "v", "--source", src, ...flags]).code, 0);
  const a = join(src, ".code-review", "v");
  put(a, "topology.json", { modules: [{ name: "core", path: "src", lines: 300 }], edges: [{ from: "core", to: "db", type: "read", evidence: "src/app.py:4" }] });
  const raw = (severity: string, line: number, title: string) => ({ dimension: "quality", severity, confidence: "high", file: "src/app.py", line, title, evidence: `src/app.py:${line}`, impact: "i", recommendation: "r", effort: "S" });
  put(a, "raw/deep/quality--core.json", { shard: "quality--core", filesRead: ["src/app.py"], notReached: [], findings: [raw("High", 2, "Broken retry"), raw("Low", 40, "Odd name"), raw("Nit", 90, "Trailing pass")] });
  runMerge(a);
  return { src, a };
}

test("findings below the verification floor are not planned for verify and are reported as unverified", () => {
  const { a } = withFindings();
  assert.equal(JSON.parse(readFileSync(join(a, "scope.json"), "utf8")).verify_min_severity, DEFAULT_VERIFY_MIN);
  const p = buildPlan(a, "verify");
  assert.equal(p.run.length, 1);
  assert.equal((p.run[0]!.input.ids as string[]).length, 1, "only the High finding goes to a verifier");
  assert.match(p.estimate.formula, /2 finding\(s\) below Medium not verified/);
  const s = buildStatus(a);
  assert.equal(s.findings.by_verdict.unverified, 2);
  assert.equal(s.findings.by_verdict.pending, 1, "the High finding still needs its verdict");
  const fs = JSON.parse(readFileSync(join(a, "findings.json"), "utf8")).findings;
  assert.match(fs.find((f: { severity: string }) => f.severity === "Low").verifier_note, /below the verification floor \(Medium\)/);
  const k = counts(loadCtx(a));
  assert.equal(k.unverified, 2);
});

test("--verify-min Nit verifies everything; an invalid floor is rejected", () => {
  const { a } = withFindings(["--verify-min", "Nit"]);
  assert.equal((buildPlan(a, "verify").run[0]!.input.ids as string[]).length, 3);
  assert.equal(buildStatus(a).findings.by_verdict.unverified, 0);
  const src = tree({ "src/app.py": APP });
  assert.notEqual(cli(["init", "x", "--source", src, "--verify-min", "Severe"]).code, 0);
});

test("votes already on disk still count for a finding below the floor", () => {
  const { a } = withFindings();
  const low = JSON.parse(readFileSync(join(a, "findings.json"), "utf8")).findings.find((f: { severity: string }) => f.severity === "Low");
  put(a, `votes/${low.id}--VERIFY.json`, { id: low.id, lens: "VERIFY", verdict: "refuted", note: "n", evidence: "src/app.py:40", corrections: [] });
  runMerge(a);
  const again = JSON.parse(readFileSync(join(a, "findings.json"), "utf8")).findings.find((f: { id: string }) => f.id === low.id);
  assert.equal(again.verdict, "refuted");
});

test("digest gives the prose stages a compact view, without per-file lists", () => {
  const { a } = withFindings();
  const files = Array.from({ length: 500 }, (_, i) => `src/f${i}.py`);
  put(a, "evidence.json", { total_files: 500, languages: { Python: { files: 500, lines: 9000 } }, files, file_sloc: Object.fromEntries(files.map((f) => [f, 18])), test_file_list: files, hotspots: [{ file: "src/app.py", churn: 2, complexity: 5, score: 1 }] });
  const d = digest(a);
  assert.match(d, /## Evidence[\s\S]*files 500/);
  assert.match(d, /Hotspots[\s\S]*src\/app\.py score 1/);
  assert.match(d, /core — src/);
  assert.match(d, /core -read-> db \(src\/app\.py:4\)/);
  assert.match(d, /by verdict: unverified 2 · pending 1/);
  assert.doesNotMatch(d, /src\/f499\.py/, "per-file lists stay out");
  assert.match(d, /Not listed: unverified 2 · pending 1/);
});

test("digest caps long lists and says how many it left out", () => {
  const { a } = withFindings(["--verify-min", "Nit"]);
  const data = JSON.parse(readFileSync(join(a, "findings.json"), "utf8"));
  for (const f of data.findings) f.verdict = "confirmed";
  put(a, "findings.json", data);
  const d = digest(a, { limit: 2 });
  assert.match(d, /… 1 more confirmed findings/);
  assert.equal(cli(["digest", "v", "--limit", "0"], { cwd: join(a, "..", "..") }).code === 0, false);
});
