// External scanners as deterministic candidate sources. Packs (what to run)
// are data in data/stacks/*.json; adapters (how to read the output) are code.
// A missing or crashing tool is recorded as such — never as "no findings".
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Dimension, RawFinding, RawShard, Severity } from "./types.ts";
import { redactValue } from "./redact.ts";
import { globToRegExp, listFiles, readJson, readText, writeJson } from "./util.ts";

export type Adapter = "semgrep" | "gitleaks" | "osv" | "npm-audit" | "pip-audit";
export interface Pack {
  id: string;
  tool: string;
  binary: string;
  versionArgs: string[];
  appliesWhen?: { anyFile: string[] };
  command: string[];
  network: boolean;
  adapter: Adapter;
  dimension: Dimension;
  cwe?: string;
  okExitCodes?: number[];
  /** Exit codes meaning "nothing to scan" (e.g. osv-scanner 128: no packages found). */
  notApplicableExitCodes?: number[];
  /** false = opt-in only (run when named in `only`); used where another pack already covers it. */
  enabledByDefault?: boolean;
  note?: string;
}
export interface ScannerStatus {
  id: string; tool: string;
  status: "ok" | "missing" | "failed" | "timeout" | "not-applicable" | "skipped";
  version?: string; findings: number; network: boolean; error?: string; command?: string;
  /** Findings dropped because their file is outside the reviewed file list (vendored, node_modules, review dir). */
  dropped?: number;
}

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadPacks(pluginRoot: string = PLUGIN_ROOT, packsDir?: string): Pack[] {
  const dir = packsDir ?? join(pluginRoot, "data", "stacks");
  let names: string[] = [];
  try { names = readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { return []; }
  return names.map((n) => readJson<Pack | null>(join(dir, n), null)).filter((p): p is Pack => !!p && typeof p.id === "string");
}

// ---------- adapters (pure: tool JSON -> RawFinding[]) ----------

function rel(src: string, p: string): string {
  const r = isAbsolute(p) ? relative(src, p) : p.replace(/^\.\//, "");
  return r.split("\\").join("/");
}
function normCwe(v: unknown): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  const m = typeof s === "string" ? /CWE-?(\d+)/i.exec(s) : null;
  return m ? `CWE-${m[1]}` : undefined;
}
const one = (s: string, n = 400) => s.replace(/\s+/g, " ").trim().slice(0, n);

/** semgrep: ERROR→High, WARNING→Medium, INFO→Low; confidence from metadata.confidence. */
export function adaptSemgrep(src: string, data: any, pack: Pick<Pack, "id" | "dimension">): RawFinding[] {
  const sev: Record<string, Severity> = { ERROR: "High", WARNING: "Medium", INFO: "Low" };
  return (data?.results ?? []).map((r: any): RawFinding => {
    const md = r.extra?.metadata ?? {};
    const conf = String(md.confidence ?? "").toLowerCase();
    const cwe = normCwe(md.cwe);
    return {
      dimension: pack.dimension, severity: sev[String(r.extra?.severity ?? "").toUpperCase()] ?? "Medium",
      confidence: conf === "high" || conf === "low" ? conf : "medium",
      file: rel(src, String(r.path ?? "")), line: Math.max(1, Number(r.start?.line) || 1),
      end_line: Number(r.end?.line) || undefined,
      title: one(`${String(r.check_id ?? "semgrep").split(".").pop()}: ${r.extra?.message ?? ""}`, 160),
      evidence: one(`semgrep rule ${r.check_id} matched at ${rel(src, String(r.path))}:${r.start?.line}. ${r.extra?.message ?? ""}`),
      impact: one(String(md.impact ?? md.category ?? "Pattern-level weakness reported by semgrep; reachability unverified.")),
      recommendation: one(String(md.fix ?? r.extra?.fix ?? "Review the matched code and apply the rule's remediation guidance.")),
      effort: "S", source: pack.id, rule_id: String(r.check_id ?? ""), ...(cwe ? { cwe } : {}),
    };
  });
}

/** gitleaks: never stores Secret/Match/line content — only rule and location. */
export function adaptGitleaks(src: string, data: any, pack: Pick<Pack, "id" | "dimension" | "cwe">): RawFinding[] {
  return (Array.isArray(data) ? data : []).map((r: any): RawFinding => {
    const file = rel(src, String(r.File ?? ""));
    const line = Math.max(1, Number(r.StartLine) || 1);
    const rule = String(r.RuleID ?? "generic");
    return {
      dimension: pack.dimension, severity: "High", confidence: "medium", file, line,
      title: `Hardcoded credential (${rule})`,
      evidence: `gitleaks rule ${rule} matched at ${file}:${line} (value withheld).`,
      impact: "A credential committed to source is exposed to everyone with repository access and should be treated as compromised.",
      recommendation: "Rotate the credential, remove it from source and history, and load it from a secret manager or environment.",
      effort: "S", source: pack.id, rule_id: rule, cwe: pack.cwe ?? "CWE-798",
    };
  });
}

function cvssToSeverity(score: unknown): Severity {
  const n = Number.parseFloat(String(score ?? ""));
  if (!Number.isFinite(n)) return "Medium";
  return n >= 9 ? "Critical" : n >= 7 ? "High" : n >= 4 ? "Medium" : n > 0 ? "Low" : "Medium";
}
function lineOf(src: string, file: string, needle: string): number {
  const text = readText(join(src, file));
  if (!text || !needle) return 1;
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`(^|[^A-Za-z0-9_.-])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_.-]|$)`, "i");
  const i = lines.findIndex((l) => re.test(l));
  return i >= 0 ? i + 1 : 1;
}

// Dependency CVEs map to CWE-1395 ("Dependency on Vulnerable Third-Party
// Component"): present in data/cwe-categories.json (CWE 4.20) with no
// CWE-1003 rollup, so it reports as Uncategorized rather than a fake category.
const DEP_CWE = "CWE-1395";

/** osv-scanner v2: one finding per vulnerability group per package. CVSS → severity. */
export function adaptOsv(src: string, data: any, pack: Pick<Pack, "id" | "dimension" | "cwe">): RawFinding[] {
  const out: RawFinding[] = [];
  for (const res of data?.results ?? []) {
    const file = rel(src, String(res.source?.path ?? ""));
    for (const p of res.packages ?? []) {
      const name = String(p.package?.name ?? "?"), version = String(p.package?.version ?? "?");
      const vulns: any[] = p.vulnerabilities ?? [];
      const groups: any[] = p.groups?.length ? p.groups : vulns.map((v) => ({ ids: [v.id], max_severity: "" }));
      for (const g of groups) {
        const ids: string[] = g.ids ?? [];
        const vs = vulns.filter((v) => ids.includes(v.id));
        const fixed = new Set<string>();
        for (const v of vs) for (const a of v.affected ?? []) for (const r of a.ranges ?? []) for (const e of r.events ?? []) if (e.fixed) fixed.add(String(e.fixed));
        const cves = [...new Set([...ids, ...(g.aliases ?? [])])].sort();
        const summary = vs.map((v) => v.summary).find(Boolean) ?? "";
        out.push({
          dimension: pack.dimension, severity: cvssToSeverity(g.max_severity), confidence: "medium",
          file, line: lineOf(src, file, name),
          title: one(`${name}@${version}: ${cves.slice(0, 3).join(", ")}${summary ? ` — ${summary}` : ""}`, 160),
          evidence: one(`osv-scanner: ${name}@${version} (${p.package?.ecosystem ?? "?"}) in ${file} is affected by ${cves.join(", ")}; max CVSS ${g.max_severity || "n/a"}.`),
          impact: "Known-vulnerable dependency version; exploitability depends on whether the vulnerable code path is used (verify reachability).",
          recommendation: fixed.size ? `Upgrade ${name} to ${[...fixed].sort().join(" / ")} or later.` : `No fixed version published; evaluate replacing or isolating ${name}.`,
          effort: fixed.size ? "S" : "M", source: pack.id, rule_id: ids[0] ?? "osv", cwe: pack.cwe ?? DEP_CWE,
        });
      }
    }
  }
  return out;
}

/** npm audit --json (npm 7+). */
export function adaptNpmAudit(src: string, data: any, pack: Pick<Pack, "id" | "dimension" | "cwe">): RawFinding[] {
  const sev: Record<string, Severity> = { critical: "Critical", high: "High", moderate: "Medium", low: "Low", info: "Low" };
  const file = "package-lock.json";
  return Object.entries<any>(data?.vulnerabilities ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, v]): RawFinding => {
    const advisories = (v.via ?? []).filter((x: any) => typeof x === "object").map((x: any) => x.url ?? x.title).filter(Boolean);
    return {
      dimension: pack.dimension, severity: sev[String(v.severity)] ?? "Medium", confidence: "medium",
      file, line: lineOf(src, file, `node_modules/${name}`),
      title: one(`${name} ${v.range ?? ""}: ${v.isDirect ? "direct" : "transitive"} vulnerable dependency`, 160),
      evidence: one(`npm audit: ${name} (${v.range ?? "?"}) severity ${v.severity}. ${advisories.slice(0, 3).join(" ")}`),
      impact: "Known-vulnerable dependency; exploitability depends on usage (verify reachability).",
      recommendation: v.fixAvailable ? `Upgrade ${typeof v.fixAvailable === "object" ? `${v.fixAvailable.name}@${v.fixAvailable.version}` : name}.` : `No fix available; evaluate replacing ${name}.`,
      effort: v.fixAvailable ? "S" : "M", source: pack.id, rule_id: `npm:${name}`, cwe: pack.cwe ?? DEP_CWE,
    };
  });
}

/** pip-audit -f json. */
export function adaptPipAudit(src: string, data: any, pack: Pick<Pack, "id" | "dimension" | "cwe">): RawFinding[] {
  const out: RawFinding[] = [];
  const deps: any[] = Array.isArray(data) ? data : data?.dependencies ?? [];
  const file = "requirements.txt";
  for (const d of deps) for (const v of d.vulns ?? []) {
    const ids = [v.id, ...(v.aliases ?? [])].filter(Boolean);
    out.push({
      dimension: pack.dimension, severity: "Medium", confidence: "medium", file, line: lineOf(src, file, String(d.name)),
      title: one(`${d.name}@${d.version}: ${ids.slice(0, 3).join(", ")}`, 160),
      evidence: one(`pip-audit: ${d.name}@${d.version} affected by ${ids.join(", ")}. ${v.description ?? ""}`),
      impact: "Known-vulnerable dependency; severity not supplied by pip-audit (verify reachability and CVSS).",
      recommendation: v.fix_versions?.length ? `Upgrade ${d.name} to ${v.fix_versions.join(" / ")}.` : `No fixed version published for ${d.name}.`,
      effort: "S", source: pack.id, rule_id: String(v.id ?? "pip-audit"), cwe: pack.cwe ?? DEP_CWE,
    });
  }
  return out;
}

export const ADAPTERS: Record<Adapter, (src: string, data: any, pack: Pack) => RawFinding[]> = {
  semgrep: adaptSemgrep, gitleaks: adaptGitleaks, osv: adaptOsv, "npm-audit": adaptNpmAudit, "pip-audit": adaptPipAudit,
};

// ---------- runner ----------

const SAFE_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SystemRoot", "USERPROFILE", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "SEMGREP_RULES_CACHE"];
function scannerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of SAFE_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.SEMGREP_SEND_METRICS = "off";
  env.NO_COLOR = "1";
  return env;
}

function applies(pack: Pack, files: string[]): boolean {
  if (!pack.appliesWhen?.anyFile?.length) return true;
  const res = pack.appliesWhen.anyFile.map(globToRegExp);
  return files.some((f) => res.some((re) => re.test(f)));
}

function parseJson(stdout: string): { ok: true; data: any } | { ok: false } {
  const t = stdout.trim();
  if (!t) return { ok: false };
  try { return { ok: true, data: JSON.parse(t) }; } catch { /* fall through */ }
  const i = t.search(/[[{]/); // tolerate a leading banner line
  if (i > 0) { try { return { ok: true, data: JSON.parse(t.slice(i)) }; } catch { /* no */ } }
  return { ok: false };
}

export function runScanners(src: string, analysis: string, opts: { only?: string[]; offline?: boolean; timeoutMs?: number; packsDir?: string; files?: string[] } = {}): ScannerStatus[] {
  const absSrc = resolve(src);
  const packs = loadPacks(PLUGIN_ROOT, opts.packsDir).filter((p) => !opts.only || opts.only.includes(p.id));
  const files = opts.files ?? listFiles(absSrc).files;
  const statuses: ScannerStatus[] = [];
  const cwd = mkdtempSync(join(tmpdir(), "code-review-scan-"));
  try {
    for (const pack of packs) {
      const base = { id: pack.id, tool: pack.tool, findings: 0, network: pack.network };
      const command = [pack.binary, ...pack.command.map((a) => a.split("{src}").join(absSrc))];
      const st: ScannerStatus = { ...base, status: "ok", command: command.join(" ") };
      if (!opts.only && pack.enabledByDefault === false) { statuses.push({ ...st, status: "skipped", error: `opt-in pack${pack.note ? `: ${pack.note}` : ""}` }); continue; }
      if (!applies(pack, files)) { statuses.push({ ...st, status: "not-applicable" }); continue; }
      if (opts.offline && pack.network) { statuses.push({ ...st, status: "skipped", error: "offline mode: pack needs network" }); continue; }
      const ver = spawnSync(pack.binary, pack.versionArgs, { cwd, env: scannerEnv(), encoding: "utf8", timeout: 20_000 });
      if ((ver.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") { statuses.push({ ...st, status: "missing", error: `${pack.binary} not found on PATH` }); continue; }
      const version = one(`${ver.stdout ?? ""}`.split("\n").find((l) => /\d/.test(l)) ?? "", 80) || undefined;
      const r = spawnSync(command[0]!, command.slice(1), {
        cwd, env: scannerEnv(), encoding: "utf8", timeout: opts.timeoutMs ?? 600_000, maxBuffer: 512 * 1024 * 1024,
      });
      if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || r.signal === "SIGTERM") {
        statuses.push({ ...st, version, status: "timeout", error: `exceeded ${opts.timeoutMs ?? 600_000} ms` }); continue;
      }
      if (r.status !== null && (pack.notApplicableExitCodes ?? []).includes(r.status)) {
        statuses.push({ ...st, version, status: "not-applicable", error: `exit ${r.status}: nothing for ${pack.tool} to scan` }); continue;
      }
      const parsed = parseJson(r.stdout ?? "");
      const okCodes = pack.okExitCodes ?? [0, 1];
      if (!parsed.ok || (r.status !== null && !okCodes.includes(r.status))) {
        const err = one(`exit ${r.status ?? r.signal}: ${(r.stderr || r.stdout || String(r.error ?? "")).toString()}`, 300);
        statuses.push({ ...st, version, status: "failed", error: redactValue(err).value }); continue;
      }
      if (parsed.data && !Array.isArray(parsed.data) && typeof parsed.data === "object" && parsed.data.error) {
        statuses.push({ ...st, version, status: "failed", error: redactValue(one(`tool reported error: ${JSON.stringify(parsed.data.error)}`, 300)).value }); continue;
      }
      let findings: RawFinding[];
      try { findings = ADAPTERS[pack.adapter](absSrc, parsed.data, pack); }
      catch (e) { statuses.push({ ...st, version, status: "failed", error: one(`adapter error: ${String(e)}`, 300) }); continue; }
      const reviewed = new Set(files);
      const kept = findings.filter((f) => reviewed.has(f.file));
      const dropped = findings.length - kept.length;
      findings = kept;
      const shard: RawShard = { shard: `scanner:${pack.id}`, filesRead: [], notReached: [], findings: redactValue(findings).value };
      writeJson(join(analysis, "raw", "scanner", `${pack.id}.json`), shard);
      // Raw tool output kept for audit, credentials redacted. gitleaks Secret/Match are dropped entirely.
      const rawOut = pack.adapter === "gitleaks" && Array.isArray(parsed.data)
        ? parsed.data.map(({ Secret: _s, Match: _m, ...rest }: any) => rest) : parsed.data;
      writeJson(join(analysis, "scanners", `${pack.id}.json`), redactValue(rawOut).value);
      statuses.push({ ...st, version, findings: findings.length, ...(dropped ? { dropped } : {}) });
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  writeJson(join(analysis, "scanners", "status.json"), statuses);
  return statuses;
}
