import { test } from "node:test";
import assert from "node:assert/strict";
import { FAKE_AWS_KEY_2 } from "./testkit.ts";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptGitleaks, adaptNpmAudit, adaptOsv, adaptPipAudit, adaptSemgrep, loadPacks, runScanners } from "../scripts/lib/scanners.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

test("shipped packs load and are well-formed data", () => {
  const packs = loadPacks();
  assert.deepEqual(packs.map((p) => p.id).sort(), ["gitleaks", "npm-audit", "osv-scanner", "pip-audit", "semgrep"]);
  for (const p of packs) {
    assert.ok(p.command.some((a) => a.includes("{src}")), `${p.id} passes {src}`);
    assert.ok(["semgrep", "gitleaks", "osv", "npm-audit", "pip-audit"].includes(p.adapter));
  }
  const pip = packs.find((p) => p.id === "pip-audit")!;
  assert.ok(pip.command.includes("--no-deps") && pip.command.includes("--disable-pip"), "pip-audit must never install target deps");
});

test("semgrep adapter: relative paths, CWE, severity map", () => {
  const f = adaptSemgrep("/repo", { results: [{ check_id: "python.lang.security.sqli", path: "/repo/app/db.py", start: { line: 12 }, end: { line: 13 },
    extra: { severity: "ERROR", message: "SQL built with string formatting", metadata: { cwe: ["CWE-89: Improper Neutralization"], confidence: "HIGH" } } }] }, { id: "semgrep", dimension: "security" });
  assert.equal(f.length, 1);
  assert.deepEqual([f[0]!.file, f[0]!.line, f[0]!.severity, f[0]!.confidence, f[0]!.cwe, f[0]!.source], ["app/db.py", 12, "High", "high", "CWE-89", "semgrep"]);
});

test("gitleaks adapter never carries the secret", () => {
  const f = adaptGitleaks("/repo", [{ RuleID: "aws-access-token", File: "/repo/cfg.py", StartLine: 3, Secret: FAKE_AWS_KEY_2, Match: `key=${FAKE_AWS_KEY_2}` }], { id: "gitleaks", dimension: "security", cwe: "CWE-798" });
  const blob = JSON.stringify(f);
  assert.ok(!blob.includes("AKIA"));
  assert.deepEqual([f[0]!.file, f[0]!.line, f[0]!.cwe, f[0]!.title], ["cfg.py", 3, "CWE-798", "Hardcoded credential (aws-access-token)"]);
});

test("osv adapter: one finding per group, CVSS severity, fixed version, manifest line", () => {
  const src = tmp("osv-");
  writeFileSync(join(src, "requirements.txt"), "requests==2.19.0\nflask==0.12\n");
  const data = { results: [{ source: { path: join(src, "requirements.txt") }, packages: [{
    package: { name: "flask", version: "0.12.0", ecosystem: "PyPI" },
    vulnerabilities: [{ id: "PYSEC-2018-66", summary: "DoS", affected: [{ ranges: [{ events: [{ introduced: "0" }, { fixed: "0.12.3" }] }] }] }, { id: "GHSA-562c-5r94-xh97" }],
    groups: [{ ids: ["PYSEC-2018-66", "GHSA-562c-5r94-xh97"], aliases: ["CVE-2018-1000656"], max_severity: "8.7" }],
  }] }] };
  const f = adaptOsv(src, data, { id: "osv-scanner", dimension: "dependencies", cwe: "CWE-1395" });
  assert.equal(f.length, 1);
  assert.deepEqual([f[0]!.file, f[0]!.line, f[0]!.severity, f[0]!.cwe], ["requirements.txt", 2, "High", "CWE-1395"]);
  assert.match(f[0]!.title, /flask@0\.12\.0: CVE-2018-1000656/);
  assert.match(f[0]!.recommendation, /0\.12\.3/);
});

test("npm-audit and pip-audit adapters", () => {
  const n = adaptNpmAudit("/nonexistent", { vulnerabilities: { lodash: { severity: "critical", range: "<4.17.21", isDirect: true, via: [{ url: "https://x" }], fixAvailable: true } } }, { id: "npm-audit", dimension: "dependencies" });
  assert.deepEqual([n[0]!.severity, n[0]!.file, n[0]!.line], ["Critical", "package-lock.json", 1]);
  const p = adaptPipAudit("/nonexistent", { dependencies: [{ name: "flask", version: "0.12", vulns: [{ id: "PYSEC-1", fix_versions: ["0.12.3"], aliases: [] }] }] }, { id: "pip-audit", dimension: "dependencies" });
  assert.equal(p.length, 1);
  assert.match(p[0]!.recommendation, /0\.12\.3/);
});

function packDir(packs: object[]): string {
  const d = tmp("packs-");
  packs.forEach((p, i) => writeFileSync(join(d, `${i}.json`), JSON.stringify(p)));
  return d;
}
const base = { versionArgs: ["--version"], network: false, adapter: "gitleaks", dimension: "security", command: ["{src}"] };

test("missing binary is 'missing', a crashing tool is 'failed' — never clean", () => {
  const bin = tmp("bin-");
  const fake = join(bin, "crashy");
  writeFileSync(fake, "#!/bin/sh\necho 'Traceback: ImportError LogData' >&2\nexit 2\n");
  chmodSync(fake, 0o755);
  const src = tmp("src-"), out = tmp("out-");
  writeFileSync(join(src, "a.py"), "x=1\n");
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old}`;
  try {
    const st = runScanners(src, out, { packsDir: packDir([
      { ...base, id: "nope", tool: "nope", binary: "definitely-not-installed-xyz" },
      { ...base, id: "crashy", tool: "crashy", binary: "crashy" },
    ]) });
    const by = Object.fromEntries(st.map((s) => [s.id, s]));
    assert.equal(by["nope"]!.status, "missing");
    assert.equal(by["crashy"]!.status, "failed");
    assert.match(by["crashy"]!.error!, /ImportError/);
    assert.deepEqual(JSON.parse(readFileSync(join(out, "scanners", "status.json"), "utf8")).map((s: any) => s.status), ["missing", "failed"]);
  } finally { process.env.PATH = old; }
});

test("successful run writes a redacted raw shard, drops out-of-scope files, honours offline/opt-in/appliesWhen", () => {
  const bin = tmp("bin-");
  const src = tmp("src-"), out = tmp("out-");
  writeFileSync(join(src, "cfg.py"), "x=1\n");
  mkdirSync(join(src, "node_modules", "p"), { recursive: true });
  writeFileSync(join(src, "node_modules", "p", "i.js"), "x\n");
  const report = JSON.stringify([
    { RuleID: "aws", File: join(src, "cfg.py"), StartLine: 1, Secret: FAKE_AWS_KEY_2, Match: FAKE_AWS_KEY_2 },
    { RuleID: "aws", File: join(src, "node_modules", "p", "i.js"), StartLine: 1, Secret: "x", Match: "x" },
  ]);
  writeFileSync(join(bin, "fakeleaks"), `#!/bin/sh\ncat <<'EOF'\n${report}\nEOF\n`);
  chmodSync(join(bin, "fakeleaks"), 0o755);
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old}`;
  try {
    const st = runScanners(src, out, { packsDir: packDir([
      { ...base, id: "fl", tool: "fakeleaks", binary: "fakeleaks", okExitCodes: [0] },
      { ...base, id: "net", tool: "net", binary: "fakeleaks", network: true },
      { ...base, id: "optin", tool: "optin", binary: "fakeleaks", enabledByDefault: false },
      { ...base, id: "npmish", tool: "npmish", binary: "fakeleaks", appliesWhen: { anyFile: ["package-lock.json"] } },
    ]), offline: true });
    const by = Object.fromEntries(st.map((s) => [s.id, s]));
    assert.equal(by["fl"]!.status, "ok");
    assert.equal(by["fl"]!.findings, 1);
    assert.equal(by["fl"]!.dropped, 1);
    assert.equal(by["net"]!.status, "skipped");
    assert.equal(by["optin"]!.status, "skipped");
    assert.equal(by["npmish"]!.status, "not-applicable");
    const shard = JSON.parse(readFileSync(join(out, "raw", "scanner", "fl.json"), "utf8"));
    assert.equal(shard.shard, "scanner:fl");
    assert.equal(shard.findings[0].file, "cfg.py");
    const raw = readFileSync(join(out, "scanners", "fl.json"), "utf8");
    assert.ok(!raw.includes("AKIA") && !raw.includes("\"Secret\""), "raw output must not keep secrets");
  } finally { process.env.PATH = old; }
});
