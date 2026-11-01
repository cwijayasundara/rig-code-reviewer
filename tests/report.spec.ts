import { test } from "node:test";
import assert from "node:assert/strict";
import { FAKE_AWS_KEY } from "./testkit.ts";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderAll } from "../scripts/lib/report.ts";
import { writeExports } from "../scripts/lib/exports.ts";
import type { Finding } from "../scripts/lib/types.ts";

const SECRET = FAKE_AWS_KEY;

function f(id: string, over: Partial<Finding> = {}): Finding {
  return {
    id, fingerprint: `v1:${id}`, category: "quality", reporters: 1, shards: ["deep:quality:core"],
    dimension: "quality", severity: "Medium", confidence: "high", file: "src/a.py", line: 3,
    title: `title ${id}`, evidence: "e", impact: "i", recommendation: "r", effort: "M", verdict: "confirmed", ...over,
  };
}

function dir(files: Record<string, unknown>): string {
  const d = mkdtempSync(join(tmpdir(), "crh-report-"));
  for (const [rel, v] of Object.entries(files)) {
    mkdirSync(join(d, rel, ".."), { recursive: true });
    writeFileSync(join(d, rel), typeof v === "string" ? v : JSON.stringify(v));
  }
  return d;
}

const read = (d: string, rel: string) => readFileSync(join(d, rel), "utf8");

test("roadmap ranks severity → confidence → effort → id and excludes refuted/deferred/accepted", () => {
  const d = dir({
    "findings.json": {
      version: 1, findings: [
        f("QUA-00000003", { severity: "High", confidence: "medium" }),
        f("QUA-00000002", { severity: "High", confidence: "high", effort: "L" }),
        f("QUA-00000001", { severity: "High", confidence: "high", effort: "S" }),
        f("QUA-00000004", { severity: "Critical" }),
        f("QUA-00000005", { severity: "Low" }),
        f("QUA-0000000a", { verdict: "refuted", title: "REFUTED-ONE" }),
        f("QUA-0000000b", { verdict: "deferred", title: "DEFERRED-ONE" }),
        f("QUA-0000000c", { accepted: { fingerprint: "x", reason: "known", by: "me", at: "2026-01-01" }, title: "ACCEPTED-ONE" }),
        f("QUA-0000000d", { verdict: "needs-human", verifier_note: "is X reachable?" }),
      ],
    },
  });
  renderAll(d);
  const rm = read(d, "ROADMAP.md");
  const order = ["QUA-00000004", "QUA-00000001", "QUA-00000002", "QUA-00000003"].map((id) => rm.indexOf(id));
  assert.ok(order.every((x) => x > 0), rm);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(rm.indexOf("QUA-00000005") > rm.indexOf("## Later"));
  for (const s of ["REFUTED-ONE", "DEFERRED-ONE", "ACCEPTED-ONE"]) assert.ok(!rm.includes(s), s);
  assert.match(rm, /is X reachable\?/);
  const an = read(d, "ANALYSIS_REPORT.md");
  assert.match(an, /## Accepted risks[\s\S]*ACCEPTED-ONE/);
  assert.match(an, /### Refuted[\s\S]*REFUTED-ONE/);
  assert.match(an, /### Deferred[\s\S]*DEFERRED-ONE/);
});

test("stale revision and incomplete verification produce banners", () => {
  const d = dir({
    "findings.json": { version: 1, findings: [f("QUA-00000001", { verdict: undefined })] },
    "REVISION.json": { commit: "abc", dirty: false, tree: "t", scanned_at: "2026-10-01T00:00:00Z", stale: true },
  });
  renderAll(d);
  for (const rel of ["ANALYSIS_REPORT.md", "ROADMAP.md", "ARCHITECTURE.md", "REPORT.html"]) assert.match(read(d, rel), /STALE/, rel);
  assert.match(read(d, "ANALYSIS_REPORT.md"), /VERIFICATION INCOMPLETE/);
  assert.match(read(d, "REPORT.html"), /VERIFICATION INCOMPLETE/);
});

test("test posture is labelled PROXY unless measured coverage exists", () => {
  const ev = { total_files: 10, source_files: 8, test_files: 2, total_code_lines: 100, languages: { Python: { files: 10, lines: 100 } } };
  const d = dir({ "findings.json": { version: 1, findings: [] }, "evidence.json": ev });
  renderAll(d);
  assert.match(read(d, "ANALYSIS_REPORT.md"), /PROXY, not measured coverage/);
  const d2 = dir({ "findings.json": { version: 1, findings: [] }, "evidence.json": { ...ev, measured_coverage: "81% lines (pytest-cov)" } });
  renderAll(d2);
  const an = read(d2, "ANALYSIS_REPORT.md");
  assert.match(an, /Measured coverage: 81% lines/);
  assert.ok(!an.includes("PROXY, not measured"));
});

test("lost shards make 'no findings' read as not fully covered", () => {
  const d = dir({
    "findings.json": { version: 1, findings: [] },
    "coverage.json": {
      top_level: [{ dir: "src", status: "scanned", files: 5, files_read: 4 }, { dir: "tools", status: "unaccounted", files: 2, files_read: 0 }],
      files_total: 7, files_read: 4, files_read_pct: 57, lost_shards: ["deep:performance:core"], deferred_shards: [],
      scanners: { failed: [{ id: "semgrep", status: "failed", error: "ImportError" }], missing: ["gitleaks"], skipped: [] }, not_reached: ["src/big.py"],
    },
  });
  renderAll(d);
  const an = read(d, "ANALYSIS_REPORT.md");
  assert.match(an, /### performance\n\n_No confirmed findings — but this dimension was \*\*not fully covered\*\*/);
  assert.match(an, /### quality|## Code quality/);
  assert.match(an, /Lost shard: `deep:performance:core`/);
  assert.match(an, /Scanner \*\*semgrep\*\* failed: ImportError/);
  assert.match(an, /Scanner \*\*gitleaks\*\* not installed/);
  assert.match(an, /Unaccounted directory: `tools`/);
  assert.match(an, /Not reached: `src\/big.py`/);
  assert.match(read(d, "REPORT.html"), /Not fully covered: performance/);
});

test("every interpolated value in REPORT.html is escaped", () => {
  const d = dir({ "findings.json": { version: 1, findings: [f("QUA-00000001", { title: '<script>alert("x")</script>', file: "a<b>.py" })] } });
  renderAll(d);
  const html = read(d, "REPORT.html");
  assert.ok(!html.includes('<script>alert("x")</script>'));
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /a&lt;b&gt;\.py/);
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /mermaid@11\.4\.1/);
});

test("secret-shaped strings never reach any output", () => {
  const d = dir({
    "findings.json": { version: 1, findings: [f("SEC-00000001", { dimension: "security", evidence: `key ${SECRET} in config`, title: `leak ${SECRET}` })] },
    "ANALYSIS_NOTES.md": `The prod key is ${SECRET} and password=hunter2hunter2`,
    "THREAT_MODEL.md": `assets: ${SECRET}`,
  });
  const r = renderAll(d);
  assert.ok(r.redactions > 0);
  for (const p of r.written) {
    const s = readFileSync(p, "utf8");
    assert.ok(!s.includes(SECRET), p);
    assert.ok(!s.includes("hunter2hunter2"), p);
  }
});

test("missing inputs render 'not available' sections and no diagrams", () => {
  const d = dir({ "findings.json": { version: 1, findings: [] } });
  const r = renderAll(d);
  assert.equal(r.written.length, 4);
  assert.ok(!existsSync(join(d, "diagrams")));
  const arch = read(d, "ARCHITECTURE.md");
  assert.match(arch, /Not available \(run the `map` stage\)/);
  assert.match(arch, /Not available \(run the `architecture` stage\)/);
  for (let i = 1; i <= 13; i++) assert.match(arch, new RegExp(`## ${i}\\. `));
  const an = read(d, "ANALYSIS_REPORT.md");
  assert.match(an, /Not available \(run the `assess` stage\)/);
  assert.equal(r.counts.total, 0);
});

test("full inputs render architecture sections, diagrams, security panel and baseline diff", () => {
  const topo = {
    modules: [{ name: "api", path: "src/api" }, { name: "core", path: "src/core" }],
    edges: [{ from: "api", to: "core", type: "call", evidence: "src/api/a.py:1" }, { from: "core", to: "db", type: "write", evidence: "src/core/r.py:2" }],
    entry_points: [{ name: "GET /", kind: "http", file: "src/api/a.py", line: 1 }],
    data_stores: [{ name: "db", kind: "sqlite", evidence: "src/core/r.py:1" }], externals: [], flows: [], observations: ["obs one"],
  };
  const arch = {
    summary: "Two modules.", style: "modular monolith", one_thing: "add authz",
    quality_attributes: [{ name: "security", rating: 2, rationale: "no authz", evidence: ["src/api/a.py:1"] }, { name: "portability", rating: "unavailable", rationale: "", evidence: [] }],
    decisions: [{ title: "SQLite", context: "small", decision: "embedded db", consequences: "single writer", evidence: ["src/core/r.py:1"] }],
    dispositions: [{ module: "core", disposition: "refactor", rationale: "god file", evidence: ["src/core/r.py:1"] }],
    risks: [{ title: "no authz", evidence: ["src/api/a.py:1"], finding_ids: ["SEC-00000001"] }],
  };
  const sec = f("SEC-00000001", {
    dimension: "security", severity: "High", original_severity: "Critical", cwe: "CWE-89", category: "Injection", exploit_scenario: "attacker sends ' OR 1=1",
    votes: [{ lens: "REACHABILITY", verdict: "confirmed", note: "" }, { lens: "IMPACT", verdict: "confirmed", note: "" }, { lens: "DEFENSES", verdict: "refuted", note: "" }],
  });
  const d = dir({
    "findings.json": { version: 1, findings: [sec] }, "topology.json": topo, "architecture.json": arch,
    "scope.json": { name: "demo", source: "/x", dimensions: ["security"], security_effort: "medium" },
    "diff.json": { baseline: "prev", new: ["SEC-00000001"], fixed: [{ id: "QUA-0000beef", title: "old bug", file: "a.py", line: 2 }], persisting: [] },
    "scanners/status.json": [{ id: "gitleaks", tool: "gitleaks", status: "ok", version: "8.30.1", findings: 0, network: false }],
  });
  const r = renderAll(d);
  assert.equal(r.written.length, 7);
  const md = read(d, "ARCHITECTURE.md");
  assert.match(md, /modular monolith/);
  assert.match(md, /```mermaid\ngraph LR/);
  assert.match(md, /ADR-R01: SQLite/);
  assert.match(md, /\| core \| refactor \|/);
  assert.match(md, /portability: not enough evidence to rate/);
  assert.match(read(d, "diagrams/data-lineage.mmd"), /core -->\|write\| ds_db/);
  const an = read(d, "ANALYSIS_REPORT.md");
  assert.match(an, /\| SEC-00000001 \| CWE-89 \| SQL Injection \| High \| 2\/3 \|/);
  assert.match(an, /reported Critical, lowered by verification/);
  assert.match(an, /Fixed \| Title[\s\S]*QUA-0000beef/);
  assert.match(an, /\| gitleaks \| ok \| 8\.30\.1 \|/);
  assert.match(an, /If only one thing changes: add authz/);
});

test("rendering is deterministic", () => {
  const files = { "findings.json": { version: 1, findings: [f("QUA-00000001"), f("QUA-00000002", { severity: "High" })] } };
  const a = dir(files), b = dir(files);
  renderAll(a); renderAll(b);
  for (const rel of ["ROADMAP.md", "ANALYSIS_REPORT.md", "ARCHITECTURE.md", "REPORT.html"]) assert.equal(read(a, rel), read(b, rel), rel);
});

test("verifier corrections render next to the text they correct, in every output", () => {
  const corrections = [{ field: "recommendation" as const, claim: "assert 400 for an array param", correction: "an array param is accepted (src/a.py:3)", lens: "VERIFY" as const }];
  const d = dir({ "findings.json": { version: 1, findings: [f("TST-00000001", { dimension: "testing", recommendation: "assert 400 for an array param", corrections })] } });
  renderAll(d);
  const md = read(d, "ANALYSIS_REPORT.md");
  assert.match(md, /Corrected by verification[^\n]*\n\s+- recommendation: .*assert 400 for an array param.*→ an array param is accepted/);
  assert.match(read(d, "ROADMAP.md"), /TST-00000001[\s\S]*corrected by verification/);
  assert.match(read(d, "REPORT.html"), /corrected by verification/i);
  writeExports(d, "test");
  const sarif = JSON.parse(read(d, "findings.sarif"));
  assert.match(sarif.runs[0].results[0].message.text, /Corrected by verification: recommendation/);
  assert.deepEqual(sarif.runs[0].results[0].properties.corrections, corrections);
});
