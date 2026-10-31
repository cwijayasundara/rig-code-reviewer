import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyVotes, categoryFor, mergeShards, panelSeverity, validateRawFinding, validateShard, validateVote } from "../scripts/lib/findings.ts";
import { categoryOf, normaliseCwe } from "../scripts/lib/cwe.ts";
import { runMerge } from "../scripts/lib/merge.ts";
import type { Finding, Vote } from "../scripts/lib/types.ts";
import { APP, FAKE_AWS_KEY, cli, put, rf, tree } from "./testkit.ts";

const sec = (over = {}) => rf({ dimension: "security", severity: "High", cwe: "CWE-89", title: "SQL injection", exploit_scenario: "attacker sends id=1 OR 1=1", line: 4, file: "src/app.py", ...over });

test("CWE normalisation + CWE-1003 rollup", () => {
  assert.equal(normaliseCwe("CWE-89: SQL Injection"), "CWE-89");
  assert.equal(normaliseCwe("cwe89"), "CWE-89");
  assert.equal(normaliseCwe("none"), undefined);
  assert.equal(categoryOf("CWE-89").name, "SQL Injection");
  assert.equal(categoryOf("CWE-99999").id, "uncategorized");
});

test("raw finding validation: enums, relative path, file exists, security needs CWE + exploit, secrets rejected", () => {
  const src = tree({ "src/app.py": APP });
  assert.deepEqual(validateRawFinding(rf(), src), []);
  assert.ok(validateRawFinding(rf({ severity: "Huge" as never }), src).some((e) => e.includes("severity")));
  assert.ok(validateRawFinding(rf({ file: "/etc/passwd" }), src).some((e) => e.includes("relative")));
  assert.ok(validateRawFinding(rf({ file: "../x.py" }), src).some((e) => e.includes("relative")));
  assert.ok(validateRawFinding(rf({ file: "src/missing.py" }), src).some((e) => e.includes("does not exist")));
  assert.ok(validateRawFinding(rf({ dimension: "security" }), src).some((e) => e.includes("cwe")));
  assert.ok(validateRawFinding(rf({ evidence: `key ${FAKE_AWS_KEY}` }), src).some((e) => e.includes("credential")));
  assert.deepEqual(validateRawFinding(rf({ evidence: "key AKIA****" }), src), []);
  assert.ok(validateShard({ findings: [] }).some((e) => e.includes("shard")));
});

test("merge: dedupes same path+category within 3 lines, keeps worst severity, counts reporters", () => {
  const src = tree({ "src/app.py": APP });
  const out = mergeShards([
    { shard: "security:a", filesRead: [], notReached: [], findings: [sec({ severity: "Medium", line: 4 })] },
    { shard: "security:b", filesRead: [], notReached: [], findings: [sec({ severity: "Critical", line: 5, cwe: "CWE-89" })] },
    { shard: "deep:quality--x", filesRead: [], notReached: [], findings: [rf({ line: 5 })] },
  ], src);
  const s = out.filter((f) => f.dimension === "security");
  assert.equal(s.length, 1);
  assert.equal(s[0]!.severity, "Critical");
  assert.equal(s[0]!.reporters, 2);
  assert.match(s[0]!.id, /^SEC-[0-9a-f]{8}$/);
  assert.equal(out.length, 2, "different category is a different finding");
});

test("ids are stable when code shifts down (fingerprint uses context, not line numbers)", () => {
  const src = tree({ "src/app.py": APP });
  const a = mergeShards([{ shard: "s", filesRead: [], notReached: [], findings: [sec()] }], src)[0]!;
  writeFileSync(join(src, "src/app.py"), "# header\n# more\n" + APP);
  const b = mergeShards([{ shard: "s", filesRead: [], notReached: [], findings: [sec({ line: 6 })] }], src)[0]!;
  assert.equal(a.id, b.id);
  assert.equal(a.fingerprint, b.fingerprint);
});

test("no id collisions across shards (old bug #5: every shard numbered SEC-001)", () => {
  const src = tree({ "src/app.py": APP, "src/b.py": APP });
  const out = mergeShards([
    { shard: "a", filesRead: [], notReached: [], findings: [sec(), rf({ line: 6 })] },
    { shard: "b", filesRead: [], notReached: [], findings: [sec({ file: "src/b.py" }), rf({ file: "src/b.py", line: 6 })] },
  ], src);
  assert.equal(new Set(out.map((f) => f.id)).size, out.length);
});

test("panel severity: median of confirming votes, lower tier on ties, never raised", () => {
  assert.equal(panelSeverity("High", ["High", "Medium"]), "Medium");
  assert.equal(panelSeverity("High", ["Critical", "Critical", "Critical"]), "High");
  assert.equal(panelSeverity("Critical", ["Critical", "Low", "High"]), "High");
  assert.equal(panelSeverity("Medium", [undefined, undefined]), "Medium");
});

const base = (): Finding => ({ ...sec(), id: "SEC-0123abcd", fingerprint: "v1:x", category: "CWE-89", reporters: 1, shards: ["s"] } as Finding);
const vote = (lens: Vote["lens"], verdict: Vote["verdict"], severity?: Vote["severity"]): Vote => ({ id: "SEC-0123abcd", lens, verdict, severity, note: "n" });

test("panel tally computed in code: 2-of-3, confidence clamp, incomplete panels", () => {
  const c = applyVotes(base(), [vote("REACHABILITY", "confirmed"), vote("IMPACT", "confirmed", "Medium"), vote("DEFENSES", "refuted")], { deferred: false, final: false });
  assert.equal(c.verdict, "confirmed");
  assert.equal(c.severity, "Medium");
  assert.equal(c.confidence, "medium", "2/3 caps confidence at medium");
  const all = applyVotes(base(), [vote("REACHABILITY", "confirmed"), vote("IMPACT", "confirmed"), vote("DEFENSES", "confirmed")], { deferred: false, final: false });
  assert.equal(all.confidence, "high");
  const r = applyVotes(base(), [vote("REACHABILITY", "refuted"), vote("IMPACT", "refuted"), vote("DEFENSES", "confirmed")], { deferred: false, final: false });
  assert.equal(r.verdict, "refuted");
  const split = applyVotes(base(), [vote("REACHABILITY", "confirmed"), vote("IMPACT", "refuted"), vote("DEFENSES", "needs-human")], { deferred: false, final: false });
  assert.equal(split.verdict, "needs-human");
  const partial = applyVotes(base(), [vote("REACHABILITY", "confirmed")], { deferred: false, final: false });
  assert.equal(partial.verdict, undefined, "incomplete panel stays pending until final");
  assert.equal(applyVotes(base(), [vote("REACHABILITY", "confirmed")], { deferred: false, final: true }).verdict, "needs-human");
  assert.equal(applyVotes(base(), [], { deferred: true, final: true }).verdict, "deferred");
});

test("non-security verifier may lower but never raise severity", () => {
  const q = { ...base(), dimension: "quality" as const, severity: "Medium" as const };
  assert.equal(applyVotes(q, [{ ...vote("VERIFY", "confirmed", "Critical") }], { deferred: false, final: false }).severity, "Medium");
  assert.equal(applyVotes(q, [{ ...vote("VERIFY", "confirmed", "Low") }], { deferred: false, final: false }).severity, "Low");
});

test("vote validation", () => {
  assert.deepEqual(validateVote(vote("IMPACT", "confirmed")), []);
  assert.ok(validateVote({ id: "SEC-001", lens: "X", verdict: "maybe" }).length >= 3);
});

test("category: CWE wins, else dimension:category slug, else dimension", () => {
  assert.equal(categoryFor(sec()), "CWE-89");
  assert.equal(categoryFor(rf({ category: "Error Handling" })), "quality:error-handling");
  assert.equal(categoryFor(rf()), "quality");
});

test("runMerge end to end: invalid shards reported, votes applied, accepted risk attached, coverage written", () => {
  const src = tree({ "src/app.py": APP, "docs/x.md": "# d" });
  const init = cli(["init", "m", "--source", src]);
  assert.equal(init.code, 0, init.err);
  const a = join(src, ".code-review", "m");
  put(a, "evidence.json", { files: ["src/app.py", "docs/x.md"], top_level_dirs: [{ dir: "src", files: 1, kind: "source" }, { dir: "docs", files: 1, kind: "docs" }] });
  put(a, "raw/security/core--injection-and-input.json", { shard: "core--injection-and-input", filesRead: ["src/app.py"], notReached: [], findings: [sec()] });
  put(a, "raw/deep/quality--core.json", { shard: "quality--core", filesRead: [], notReached: [], findings: [rf({ severity: "Bogus" as never })] });
  let r = runMerge(a);
  assert.equal(r.findings, 1);
  assert.equal(r.invalid_shards.length, 1);
  const id = JSON.parse(readFileSync(join(a, "findings.json"), "utf8")).findings[0].id as string;
  for (const lens of ["REACHABILITY", "IMPACT", "DEFENSES"]) put(a, `votes/${id}--${lens}.json`, { id, lens, verdict: "confirmed", note: "path proven" });
  r = runMerge(a, { final: true });
  assert.equal(r.by_verdict.confirmed, 1);
  const cov = JSON.parse(readFileSync(join(a, "coverage.json"), "utf8"));
  assert.equal(cov.files_read, 1);
  assert.deepEqual(cov.top_level.map((t: { status: string }) => t.status), ["scanned", "set-aside"]);
  assert.ok(cov.lost_shards.some((s: string) => s.startsWith("invalid:")));
  // human-only accept
  assert.equal(cli(["accept", "m", id, "--reason", "compensating control"], { cwd: src }).code, 3);
  const ok = cli(["accept", "m", id, "--reason", "compensating control"], { cwd: src, env: { REVIEW_HUMAN: "1" } });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(JSON.parse(readFileSync(join(a, "findings.json"), "utf8")).findings[0].accepted.reason, "compensating control");
});

test("cross-dimension fold: a data/quality report of the security bug joins the security finding (live-run regression)", () => {
  const src = tree({ "src/app.py": APP });
  const out = mergeShards([
    { shard: "security:core--injection", filesRead: [], notReached: [], findings: [sec({ line: 4 })] },
    { shard: "deep:data--core", filesRead: [], notReached: [], findings: [rf({ dimension: "data", severity: "High", line: 4, title: "Unvalidated input concatenated into SQL (injection)" })] },
    { shard: "deep:quality--core", filesRead: [], notReached: [], findings: [rf({ line: 5 })] },
  ], src);
  assert.equal(out.length, 2, "data duplicate folded; unrelated quality finding kept");
  const s = out.find((f) => f.dimension === "security")!;
  assert.equal(s.reporters, 2);
  assert.ok((s.aliases ?? []).length >= 1);
});

test("severity order: Blocker outranks Critical in merge and is never produced by a verifier raise", () => {
  const src = tree({ "src/app.py": APP });
  const out = mergeShards([
    { shard: "a", filesRead: [], notReached: [], findings: [rf({ severity: "Critical", confidence: "high" })] },
    { shard: "b", filesRead: [], notReached: [], findings: [rf({ severity: "Blocker", confidence: "low" })] },
  ], src);
  assert.equal(out[0]!.severity, "Blocker");
  const q = { ...base(), dimension: "quality" as const, severity: "Critical" as const };
  assert.equal(applyVotes(q, [vote("VERIFY", "confirmed", "Blocker")], { deferred: false, final: false }).severity, "Critical");
  assert.equal(panelSeverity("Critical", ["Blocker", "Blocker", "Blocker"]), "Critical");
});

test("vote files must be named after their content", () => {
  assert.ok(validateVote(vote("IMPACT", "confirmed"), "SEC-0123abcd--DEFENSES.json").some((e) => e.includes("file name")));
  assert.deepEqual(validateVote(vote("IMPACT", "confirmed"), "SEC-0123abcd--IMPACT.json"), []);
});

test("redaction gate: code-shaped values are not secrets, literals are", () => {
  assert.deepEqual(validateRawFinding(rf({ recommendation: "use token = crypto.randomBytes(32) and password = os.environ['DB_PASS']" })), []);
  assert.ok(validateRawFinding(rf({ evidence: "password = hunter2pass" })).some((e) => e.includes("credential")));
});
