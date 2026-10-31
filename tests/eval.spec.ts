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
