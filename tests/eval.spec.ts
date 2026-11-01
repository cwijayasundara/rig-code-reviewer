import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gate, score, type Case } from "../eval/score.ts";
import { main } from "../eval/run.ts";
import type { Finding } from "../scripts/lib/types.ts";
import { ROOT } from "./testkit.ts";

const f = (over: Partial<Finding>): Finding => ({
  id: "SEC-00000001", fingerprint: "v1:a", category: "CWE-89", reporters: 1, shards: [], dimension: "security", severity: "High",
  confidence: "high", file: "src/app.py", line: 16, title: "SQL injection in get_user", evidence: "f-string", impact: "i",
  recommendation: "r", effort: "S", verdict: "confirmed", cwe: "CWE-89", ...over,
});
const sqli = JSON.parse(readFileSync(join(ROOT, "eval/cases/py-sqli/expected.json"), "utf8")) as Case;

test("scorer: a catch needs a confirmed finding in the right file matching the regex", () => {
  assert.deepEqual(score([f({})], sqli).caught, ["sqli"]);
  assert.deepEqual(score([f({ verdict: "refuted" })], sqli).missed, ["sqli"], "refuted findings do not count");
  assert.deepEqual(score([f({ file: "src/other.py" })], sqli).missed, ["sqli"]);
});

test("scorer: flagging the safe twin is a false positive; baseline gate is 'not enforced' when absent", () => {
  const s = score([f({ line: 23, title: "SQL injection in get_user_safe" })], sqli);
  assert.equal(s.falsePositives.length, 1);
  assert.equal(gate(s, 1, undefined).status, "not enforced");
  assert.equal(gate(s, 1, { maxFalsePositives: 0 }).status, "fail");
  assert.equal(gate(score([f({})], sqli), 1, { minRecall: 1, maxFalsePositives: 0, maxUsd: 5 }).status, "pass");
});

test("every case has src/ and a well-formed expected.json; dry run spends nothing", () => {
  for (const c of readdirSync(join(ROOT, "eval/cases"))) {
    const e = JSON.parse(readFileSync(join(ROOT, "eval/cases", c, "expected.json"), "utf8")) as Case;
    assert.ok(e.description && Array.isArray(e.must) && Array.isArray(e.mustNot), c);
    for (const x of [...e.must, ...e.mustNot]) assert.ok(x.id && x.file, `${c}: ${JSON.stringify(x)}`);
    assert.ok(readdirSync(join(ROOT, "eval/cases", c, "src")).length > 0);
  }
  assert.equal(main(["--dry"]), 0);
  assert.equal(main(["--live"]), 2, "live without a budget cap is refused");
});

test("scorer counts duplicates of a planted defect and co-located findings", () => {
  const s = score([f({}), f({ id: "DAT-00000002", dimension: "data", line: 17, title: "SQL injection via id" }), f({ id: "OPS-00000003", dimension: "operability", line: 40, title: "x", cwe: undefined, category: "operability" })], sqli);
  assert.equal(s.duplicatesOfMust, 1);
  assert.equal(s.colocated, 1);
  assert.equal(gate(s, 1, { maxDuplicatesOfMust: 0 }).status, "fail");
});

// ---- differential eval against code-modernization (eval/upstream.ts) ----
import { compare, normPath, parseMarkdown } from "../eval/upstream.ts";

const SECURITY_MD = [
  "# Security Findings — eval",
  "## Scorecard",
  "| Severity | Count |", "|---|---|", "| High | 1 |",
  "## Coverage gaps",
  "- **not judged**: SQL injection, CWE-89, `src/app.py:23`, High",
  "## Findings",
  "| ID | Severity | CWE | Location | Finding |", "|---|---|---|---|---|",
  "| SEC-001 | High | CWE-89 | `legacy/eval/src/app.py:16` | SQL injection via f-string in get_user |",
  "| SEC-002 | Medium | CWE-1427 | src/app.py:15 | Instruction-shaped comment asks AI reviewers to skip |",
  "## Remediation Log",
  "- SEC-001 `src/app.py:16`: parameterize the query",
].join("\n");

test("upstream parser: keeps finding rows, normalises legacy/<system>/ paths, ignores gaps and remediation", () => {
  const fs = parseMarkdown(SECURITY_MD, "SECURITY_FINDINGS.md", "quality");
  assert.deepEqual(fs.map((x) => [x.file, x.line, x.severity, x.cwe, x.dimension]), [
    ["src/app.py", 16, "High", "CWE-89", "security"],
    ["src/app.py", 15, "Medium", "CWE-1427", "security"],
  ]);
  assert.equal(normPath("./legacy/eval/src/x.js"), "src/x.js");
  const s = score(fs, sqli);
  assert.deepEqual([s.caught, s.shouldCaught, s.falsePositives.length], [["sqli"], ["prompt-injection"], 0], "the unjudged twin row is not a false positive");
});

test("upstream parser: a debt row with no severity is Low, so it can never be a High+ false positive", () => {
  const md = "## Technical Debt\n| # | Item | Location |\n|---|---|---|\n| 1 | Exception swallowed on outbound call | `src/orders.py:22` |";
  const [d] = parseMarkdown(md, "ASSESSMENT.md", "quality");
  assert.deepEqual([d?.severity, d?.dimension, d?.file], ["Low", "quality", "src/orders.py"]);
});

test("parity gate: harness must catch what upstream caught, with no more false positives", () => {
  const row = (c: string, caught: string[], fp = 0) => ({ case: c, recall: null, caught, missed: [], falsePositives: Array(fp).fill({}), confirmed: 0, usd: 0 });
  const v = compare([row("a", ["x"]), row("b", []), row("c", ["x"], 2)], [row("a", ["x"]), row("b", ["x"]), row("c", ["x"], 1), row("d", [])]);
  assert.deepEqual(v.map((x) => x.status), ["pass", "fail", "fail", "incomplete"]);
  assert.match(v[1]!.reasons[0]!, /upstream caught \[x\]/);
});

test("upstream parser: severity range takes the lower bound; skipSecurity drops assess's unjudged table", () => {
  const md = "## Security Findings\n| 5 | CWE-59 Link Following | Low–Medium | `src/server.js:14-15` |\n## Technical Debt\n| 1 | dup code | `src/server.js:3` |";
  assert.equal(parseMarkdown(md, "ASSESSMENT.md", "quality")[0]?.severity, "Low");
  assert.deepEqual(parseMarkdown(md, "ASSESSMENT.md", "quality", true).map((x) => x.line), [3]);
});

test("scorer: a finding that only cross-references the defect in its evidence is not a duplicate", () => {
  const xref = f({ id: "SEC-00000002", cwe: "CWE-1427", category: "CWE-1427", line: 15, title: "Reviewer-directed prompt injection comment", evidence: "see the SQL injection finding" });
  assert.equal(score([f({}), xref], sqli).duplicatesOfMust, 0);
  assert.equal(score([f({}), f({ id: "SEC-00000003", line: 17, title: "SQL injection via id" })], sqli).duplicatesOfMust, 1, "a second titled SQLi still counts");
});

test("bait rule: a true testing note on the guarded twin is not a false positive; a security claim on it is", () => {
  const trav = JSON.parse(readFileSync(join(ROOT, "eval/cases/js-traversal/expected.json"), "utf8")) as Case;
  const base = { file: "src/server.js", line: 15, severity: "Medium" as const, cwe: undefined, category: "testing" };
  const untested = f({ ...base, id: "TST-21e6420e", dimension: "testing", title: "Path-containment guard has no test; its branch arms and edge inputs are unpinned" });
  assert.equal(score([untested], trav).falsePositives.length, 0);
  const bait = f({ ...base, id: "SEC-00000009", dimension: "security", cwe: "CWE-22", category: "CWE-22", title: "Path traversal in /download-safe" });
  assert.equal(score([bait], trav).falsePositives.length, 1);
  assert.equal(score([f({ line: 23, title: "SQL injection in get_user_safe" })], sqli).falsePositives.length, 1, "py-sqli bait still catches a security claim on the twin");
});
