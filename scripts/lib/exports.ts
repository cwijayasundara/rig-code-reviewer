// Machine-readable outputs: SARIF 2.1.0, JSONL, and baseline diff.
import { join } from "node:path";
import { categoryOf } from "./cwe.ts";
import { redact } from "./redact.ts";
import type { Finding } from "./types.ts";
import { readJson, writeJson, writeText } from "./util.ts";

const LEVEL: Record<string, string> = { Blocker: "error", Critical: "error", High: "error", Medium: "warning", Low: "note", Nit: "note" };
const SECRET_CATS = new Set(["CWE-798", "CWE-259", "CWE-321", "CWE-671"]);

export function loadFindings(analysis: string): Finding[] {
  return readJson<{ findings?: Finding[] }>(join(analysis, "findings.json"), {}).findings ?? [];
}

function ruleId(f: Finding): string {
  return f.cwe ?? `${f.dimension}/${f.category.replace(/^[a-z]+:/, "") || f.dimension}`;
}

export function toSarif(findings: Finding[], version: string): object {
  const reportable = findings.filter((f) => f.verdict === "confirmed");
  const rules = new Map<string, object>();
  for (const f of reportable) {
    const id = ruleId(f);
    if (rules.has(id)) continue;
    const cat = f.cwe ? categoryOf(f.cwe) : null;
    rules.set(id, {
      id, name: cat && cat.id !== "uncategorized" ? cat.name : id,
      shortDescription: { text: cat && cat.id !== "uncategorized" ? `${cat.name} (${f.dimension})` : `${f.dimension} finding` },
      ...(f.cwe ? { helpUri: `https://cwe.mitre.org/data/definitions/${f.cwe.replace("CWE-", "")}.html` } : {}),
      properties: { tags: [f.dimension, ...(f.cwe ? [f.cwe] : [])] },
    });
  }
  const results = reportable.map((f) => {
    const secret = SECRET_CATS.has(f.category) || SECRET_CATS.has(f.cwe ?? "");
    const msg = redact(`${f.title}. ${secret ? "" : f.impact + " "}Fix: ${f.recommendation}`).text;
    return {
      ruleId: ruleId(f),
      level: LEVEL[f.severity] ?? "warning",
      message: { text: msg },
      locations: [{ physicalLocation: {
        artifactLocation: { uri: f.file, uriBaseId: "%SRCROOT%" },
        region: { startLine: f.line, ...(f.end_line ? { endLine: f.end_line } : {}) },
      } }],
      partialFingerprints: { "codeReviewHarness/v1": f.fingerprint.replace(/^v1:/, "") },
      properties: { id: f.id, severity: f.severity, confidence: f.confidence, dimension: f.dimension, verdict: f.verdict, reporters: f.reporters, panel: f.verifier_note },
      ...(f.accepted ? { suppressions: [{ kind: "external", status: "accepted", justification: redact(f.accepted.reason).text }] } : {}),
    };
  });
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json", version: "2.1.0",
    runs: [{
      tool: { driver: { name: "code-review-harness", version, informationUri: "https://github.com/anthropics/claude-plugins-official", rules: [...rules.values()] } },
      originalUriBaseIds: { "%SRCROOT%": { description: { text: "Root of the reviewed source tree" } } },
      results,
    }],
  };
}

export function writeExports(analysis: string, version: string): { sarif: number; jsonl: number } {
  const findings = loadFindings(analysis);
  const sarif = toSarif(findings, version) as { runs: { results: unknown[] }[] };
  writeJson(join(analysis, "findings.sarif"), sarif);
  const lines = findings.map((f) => {
    const secret = SECRET_CATS.has(f.category) || SECRET_CATS.has(f.cwe ?? "");
    const { snippet: _s, ...rest } = f;
    return JSON.stringify(secret ? rest : f);
  });
  writeText(join(analysis, "findings.jsonl"), redact(lines.join("\n") + (lines.length ? "\n" : "")).text);
  return { sarif: sarif.runs[0]!.results.length, jsonl: lines.length };
}

export interface Diff { baseline: string; new: string[]; fixed: { id: string; title: string; file: string; line: number }[]; persisting: string[] }

/** Compare live (confirmed / needs-human) findings by fingerprint with a baseline review dir. */
export function baselineDiff(analysis: string, baselineDir: string): Diff {
  const live = (fs: Finding[]) => fs.filter((f) => f.verdict === "confirmed" || f.verdict === "needs-human");
  const cur = live(loadFindings(analysis));
  const base = live(loadFindings(baselineDir));
  const baseFp = new Set(base.map((f) => f.fingerprint));
  const curFp = new Set(cur.map((f) => f.fingerprint));
  const diff: Diff = {
    baseline: baselineDir,
    new: cur.filter((f) => !baseFp.has(f.fingerprint)).map((f) => f.id),
    fixed: base.filter((f) => !curFp.has(f.fingerprint)).map((f) => ({ id: f.id, title: f.title, file: f.file, line: f.line })),
    persisting: cur.filter((f) => baseFp.has(f.fingerprint)).map((f) => f.id),
  };
  writeJson(join(analysis, "diff.json"), diff);
  return diff;
}
