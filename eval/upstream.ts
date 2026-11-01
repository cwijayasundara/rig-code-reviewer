// Differential eval against Anthropic's code-modernization plugin: runs its
// `modernize-assess` and `modernize-harden` headlessly on the same seeded cases,
// turns the markdown they write into findings, and scores them with the same
// deterministic scorer as the harness (eval/score.ts).
//   node eval/upstream.ts --dry --upstream <plugins/code-modernization>        # $0
//   node eval/upstream.ts --live --max-usd 6 --upstream <dir> [--case py-sqli]
//   node eval/upstream.ts --compare [--harness <results.jsonl>] [--upstream-results <results.jsonl>]
// Upstream writes markdown, not findings.json, so the parse is deliberately
// conservative: only table rows / bullets that cite `file:line` under a findings
// or debt heading count, refuted / remediation / coverage-gap sections never do,
// assess's unjudged security table is ignored once harden ran, a severity range
// takes its lower bound, and a row with no stated severity is Low.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding, Severity } from "../scripts/lib/types.ts";
import { parseArgs, readJson, readText, str, writeText } from "../scripts/lib/util.ts";
import { score, type Case, type Score } from "./score.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SYSTEM = "eval";
const COMMANDS = ["modernize-assess", "modernize-harden"] as const;
const SOURCES = ["SECURITY_FINDINGS.md", "ASSESSMENT.md"] as const;

// Sections whose rows are reported findings, and sections that only mention them.
const KEEP = /finding|debt|vulnerab|security|cwe|issue/i;
const SKIP = /gap|remediation|patch|refut|false.?positive|secret|credential|not judged|unverified|dependency cve|scorecard|summary/i;
const SEV: [RegExp, Severity][] = [[/\bcritical\b/i, "Critical"], [/\bhigh\b/i, "High"], [/\b(medium|med|moderate)\b/i, "Medium"], [/\blow\b/i, "Low"], [/\binfo(rmational)?\b/i, "Nit"]];
const CITE = /`?((?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z0-9]+):(\d+)(?:[-–]\d+)?`?/;

/** Normalises an upstream citation to the case's repo-relative path. */
export function normPath(p: string): string {
  return p.replace(/^\.?\//, "").replace(new RegExp(`^(?:legacy/${SYSTEM}/)`), "");
}

/** Extracts findings from one upstream markdown report. Pure; unit-tested. */
export function parseMarkdown(md: string, sourceName: string, dimension: string, skipSecurity = false): Finding[] {
  const out: Finding[] = [];
  let section = "", keep = false;
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) { section = h[1]!; keep = KEEP.test(section) && !SKIP.test(section) && !(skipSecurity && /security|vulnerab|cwe/i.test(section)); continue; }
    if (!keep || !(line.startsWith("|") || /^([-*]|\d+\.)\s/.test(line))) continue;
    if (/^\|[\s:|-]+\|$/.test(line)) continue; // table separator
    const cite = CITE.exec(line);
    if (!cite) continue;
    const text = line.replace(/\|/g, " ").replace(/\s+/g, " ").trim();
    const cwe = /CWE-\d+/i.exec(line)?.[0].toUpperCase();
    // A range ("Low–Medium") takes its lower bound; no stated severity is Low.
    const severity = SEV.filter(([re]) => re.test(line)).map(([, s]) => s).pop() ?? "Low";
    const security = /security/i.test(section) || sourceName === "SECURITY_FINDINGS.md" || !!cwe;
    out.push({
      id: `UP-${String(out.length + 1).padStart(4, "0")}`, fingerprint: "", category: cwe ?? "upstream", reporters: 1, shards: [],
      dimension: security ? "security" : dimension, severity, confidence: "medium",
      file: normPath(cite[1]!), line: Number(cite[2]), title: text.slice(0, 300), evidence: `${sourceName} § ${section}`,
      impact: "", recommendation: "", effort: "M", verdict: "confirmed", ...(cwe ? { cwe } : {}),
    } as Finding);
  }
  return out;
}

/** Findings from every upstream report in an analysis dir, de-duplicated by file:line:cwe. */
export function upstreamFindings(analysis: string): Finding[] {
  const seen = new Set<string>();
  // Security rows come from harden's adversarially judged SECURITY_FINDINGS.md when it exists;
  // assess's security table is an unjudged first pass (the harness counts confirmed findings only).
  const judged = readText(join(analysis, "SECURITY_FINDINGS.md")) !== null;
  return SOURCES.flatMap((s) => parseMarkdown(readText(join(analysis, s)) ?? "", s, "quality", judged && s === "ASSESSMENT.md")).filter((f) => {
    const k = `${f.file}:${f.line}:${f.cwe ?? f.title.slice(0, 40)}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

export interface Row { case: string; recall: number | null; caught: string[]; missed: string[]; shouldCaught?: string[]; falsePositives: unknown[]; confirmed: number; usd: number }
export interface Verdict { case: string; status: "pass" | "fail" | "incomplete"; reasons: string[] }

/** Parity gate: the harness must catch at least what upstream catches, with no more false positives. */
export function compare(harness: Row[], upstream: Row[]): Verdict[] {
  const cases = [...new Set([...harness, ...upstream].map((r) => r.case))].sort();
  return cases.map((c) => {
    const h = harness.find((r) => r.case === c), u = upstream.find((r) => r.case === c);
    if (!h || !u) return { case: c, status: "incomplete", reasons: [`no ${!h ? "harness" : "upstream"} result`] };
    const reasons: string[] = [];
    const lost = u.caught.filter((id) => !h.caught.includes(id));
    if (lost.length) reasons.push(`upstream caught [${lost}] the harness missed`);
    if (h.falsePositives.length > u.falsePositives.length) reasons.push(`false positives ${h.falsePositives.length} > upstream ${u.falsePositives.length}`);
    return { case: c, status: reasons.length ? "fail" : "pass", reasons };
  });
}

function sh(cmd: string, args: string[], cwd: string) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
}

const ALLOWED = [
  "Read", "Glob", "Grep", "Write", "Edit", "Agent", "Workflow", "Skill", "TodoWrite",
  "Bash(scc:*)", "Bash(cloc:*)", "Bash(readlink:*)", "Bash(git check-ignore:*)", "Bash(git log:*)", "Bash(git ls-files:*)",
  "Bash(ls:*)", "Bash(find:*)", "Bash(wc:*)", "Bash(head:*)", "Bash(cat:*)", "Bash(grep:*)", "Bash(rg:*)", "Bash(mkdir:*)",
  "Bash(python3:*)", "Bash(pip-audit:*)", "Bash(npm audit:*)", "Bash(semgrep:*)", "Bash(gitleaks:*)",
];

function runCase(c: string, plugin: string, maxUsd: number): Row & { exit: number; analysis: string; shouldCaught: string[] } {
  const ws = mkdtempSync(join(tmpdir(), `crh-upstream-${c}-`));
  const repo = join(ws, "repo");
  cpSync(join(HERE, "cases", c, "src"), join(repo, "src"), { recursive: true });
  sh("git", ["init", "-q"], repo); sh("git", ["add", "."], repo);
  sh("git", ["-c", "user.name=eval", "-c", "user.email=eval@local", "commit", "-qm", "seed"], repo);
  sh("git", ["init", "-q"], ws);
  mkdirSync(join(ws, "legacy"));
  symlinkSync(repo, join(ws, "legacy", SYSTEM));
  writeText(join(ws, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Read(**)", "Edit(analysis/**)", "Write(analysis/**)"], deny: ["Edit(legacy/**)", "Write(legacy/**)"] } }, null, 2));
  console.log(`==> ${c} (${ws})`);
  let usd = 0, exit = 0;
  for (const cmd of COMMANDS) {
    const left = maxUsd - usd;
    if (left <= 0.05) { console.log(`    ${cmd}: skipped, budget spent`); exit = 3; break; }
    const r = sh("claude", ["-p", `/code-modernization:${cmd} ${SYSTEM}`, "--plugin-dir", plugin, "--output-format", "json",
      "--permission-mode", "acceptEdits", "--max-budget-usd", left.toFixed(2), "--allowedTools", ...ALLOWED], ws);
    let cost = 0;
    try { cost = Number(JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}").total_cost_usd ?? 0); } catch { /* non-JSON output */ }
    usd += cost;
    console.log(`    ${cmd}: exit ${r.status} · $${cost.toFixed(2)}`);
    if (r.status !== 0) exit = r.status ?? 1;
  }
  const analysis = join(ws, "analysis", SYSTEM);
  const findings = upstreamFindings(analysis);
  writeText(join(analysis, "upstream-findings.json"), JSON.stringify({ findings }, null, 2));
  const s: Score = score(findings, readJson<Case>(join(HERE, "cases", c, "expected.json"), { description: "", must: [], mustNot: [] }));
  return { case: c, exit, usd, analysis, ...s };
}

/** Newest row per case across every results file of one kind (files sort by timestamp). */
function newestRows(prefix: string): { rows: Row[]; files: string[] } {
  const dir = join(HERE, "results");
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && (prefix ? f.startsWith(prefix) : /^\d/.test(f))).sort();
  const byCase = new Map<string, Row>();
  for (const f of files) for (const r of readRows(join(dir, f))) byCase.set(r.case, r);
  return { rows: [...byCase.values()], files };
}
const readRows = (p: string): Row[] => (readText(p) ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);

export function main(argv: string[]): number {
  const { flags } = parseArgs(argv);
  if (flags.compare === true) {
    const hp = str(flags.harness), up = str(flags["upstream-results"]);
    const h = hp ? readRows(hp) : newestRows("").rows, u = up ? readRows(up) : newestRows("upstream-").rows;
    if (!h.length || !u.length) { console.error("compare needs harness and upstream results (.jsonl) in eval/results/"); return 2; }
    console.log(`harness:  ${hp ?? "newest row per case in eval/results/*.jsonl"}\nupstream: ${up ?? "newest row per case in eval/results/upstream-*.jsonl"}\n`);
    console.log("| case | harness recall | upstream recall | harness FP | upstream FP | harness $ | upstream $ | parity |\n|---|---|---|---|---|---|---|---|");
    const v = compare(h, u);
    for (const x of v) {
      const a = h.find((r) => r.case === x.case), b = u.find((r) => r.case === x.case);
      console.log(`| ${x.case} | ${a?.recall ?? "n/a"} | ${b?.recall ?? "n/a"} | ${a?.falsePositives.length ?? "-"} | ${b?.falsePositives.length ?? "-"} | ${a ? a.usd.toFixed(2) : "-"} | ${b ? b.usd.toFixed(2) : "-"} | ${x.status}${x.reasons.length ? ` (${x.reasons.join("; ")})` : ""} |`);
    }
    return v.some((x) => x.status === "fail") ? 1 : 0;
  }
  const plugin = str(flags.upstream);
  const only = str(flags.case);
  const cases = readdirSync(join(HERE, "cases")).filter((c) => !only || c === only).sort();
  if (flags.live !== true) {
    console.log(`upstream eval (dry): ${cases.length} case(s) × ${COMMANDS.join(" + ")} — nothing is spent.`);
    console.log(`plugin: ${plugin ?? "(pass --upstream <path to plugins/code-modernization>)"}`);
    return 0;
  }
  const maxUsd = Number(str(flags["max-usd"]));
  if (!maxUsd) { console.error("--live requires --max-usd <per-case cap>"); return 2; }
  if (!plugin || !existsSync(join(plugin, ".claude-plugin", "plugin.json"))) { console.error("--upstream must point at the code-modernization plugin directory"); return 2; }
  const rows = cases.map((c) => runCase(c, resolve(plugin), maxUsd));
  for (const r of rows) console.log(`    ${r.case}: exit ${r.exit} · recall ${r.recall ?? "n/a"} · caught [${r.caught}] missed [${r.missed}] · FP ${r.falsePositives.length} · ${r.confirmed} parsed · $${r.usd.toFixed(2)}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeText(join(HERE, "results", `upstream-${stamp}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`results: eval/results/upstream-${stamp}.jsonl`);
  return rows.some((r) => r.exit !== 0) ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
