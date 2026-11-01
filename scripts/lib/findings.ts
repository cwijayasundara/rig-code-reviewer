// The finding pipeline's deterministic core: validate raw shards and votes,
// merge (dedupe, fingerprint, stable ids), compute verdicts from votes.
// A model never edits findings.json; this module owns it.
import { readdirSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { categoryOf, normaliseCwe } from "./cwe.ts";
import { hasSecret } from "./redact.ts";
import {
  CONFIDENCES, CONF_RANK, CORE_FIELDS, CORRECTABLE, DIM_PREFIX, DIMENSIONS, EFFORTS, LENSES, SEVERITIES,
  type Accepted, type Confidence, type Correction, type Finding, type Plan, type RawFinding, type RawShard, type Severity, type Vote,
} from "./types.ts";
import { exists, readJson, readText, sha256 } from "./util.ts";

const REQUIRED = ["dimension", "severity", "confidence", "file", "line", "title", "evidence", "impact", "recommendation", "effort"] as const;
const SCANNER_SOURCES = new Set(["semgrep", "gitleaks", "osv-scanner", "npm-audit", "pip-audit"]);

// ---------- validation ----------

export function validateRawFinding(f: unknown, source?: string): string[] {
  const e: string[] = [];
  if (!f || typeof f !== "object") return ["finding is not an object"];
  const x = f as Record<string, unknown>;
  for (const k of REQUIRED) if (x[k] === undefined || x[k] === "") e.push(`missing '${k}'`);
  if (x.dimension !== undefined && !(DIMENSIONS as readonly string[]).includes(String(x.dimension))) e.push(`bad dimension ${JSON.stringify(x.dimension)}`);
  if (x.severity !== undefined && !(SEVERITIES as readonly string[]).includes(String(x.severity))) e.push(`bad severity ${JSON.stringify(x.severity)}`);
  if (x.confidence !== undefined && !(CONFIDENCES as readonly string[]).includes(String(x.confidence))) e.push(`bad confidence ${JSON.stringify(x.confidence)}`);
  if (x.effort !== undefined && !(EFFORTS as readonly string[]).includes(String(x.effort))) e.push(`bad effort ${JSON.stringify(x.effort)}`);
  if (!Number.isInteger(x.line) || (x.line as number) < 1) e.push("line must be a positive integer");
  if (x.end_line !== undefined && (!Number.isInteger(x.end_line) || (x.end_line as number) < (x.line as number))) e.push("end_line must be an integer >= line");
  const file = String(x.file ?? "");
  if (isAbsolute(file) || normalize(file).startsWith("..")) e.push(`file must be relative to the source root: ${file}`);
  else if (source && file && !exists(join(source, file))) e.push(`cited file does not exist in source: ${file}`);
  const isScanner = SCANNER_SOURCES.has(String(x.source ?? ""));
  if (x.dimension === "security" && !isScanner) {
    if (!normaliseCwe(x.cwe)) e.push("security finding needs a cwe (most specific Base/Class CWE)");
    if (!x.exploit_scenario) e.push("security finding needs an exploit_scenario (no exploit path, no finding)");
  }
  if (x.cwe !== undefined && !normaliseCwe(x.cwe)) e.push(`unparseable cwe ${JSON.stringify(x.cwe)}`);
  if (hasSecret(JSON.stringify(x))) e.push("contains an unredacted credential-shaped value: mask it (AKIA****)");
  return e;
}

export function validateShard(obj: unknown, source?: string): string[] {
  if (Array.isArray(obj)) obj = { shard: "?", filesRead: [], notReached: [], findings: obj };
  if (!obj || typeof obj !== "object") return ["shard file must be a JSON object {shard, filesRead, notReached, findings}"];
  const s = obj as Record<string, unknown>;
  const e: string[] = [];
  if (typeof s.shard !== "string") e.push("missing 'shard' (string)");
  for (const k of ["filesRead", "notReached", "findings"]) if (!Array.isArray(s[k])) e.push(`'${k}' must be an array`);
  (Array.isArray(s.findings) ? s.findings : []).forEach((f, i) => {
    for (const msg of validateRawFinding(f, source)) e.push(`findings[${i}]: ${msg}`);
  });
  return e;
}

export function validateVote(obj: unknown, filename?: string): string[] {
  if (!obj || typeof obj !== "object") return ["vote must be an object"];
  const v = obj as Record<string, unknown>;
  const e: string[] = [];
  if (filename && filename !== `${String(v.id)}--${String(v.lens)}.json`) e.push(`file name must be <id>--<lens>.json matching its content (got ${filename} for ${String(v.id)}/${String(v.lens)})`);
  if (typeof v.id !== "string" || !/^[A-Z]{3}-[0-9a-f]{8,}$/.test(v.id)) e.push("bad or missing 'id'");
  if (![...LENSES, "VERIFY"].includes(String(v.lens))) e.push(`bad lens ${JSON.stringify(v.lens)}`);
  if (!["confirmed", "refuted", "needs-human"].includes(String(v.verdict))) e.push(`bad verdict ${JSON.stringify(v.verdict)}`);
  if (v.severity !== undefined && !(SEVERITIES as readonly string[]).includes(String(v.severity))) e.push(`bad severity ${JSON.stringify(v.severity)}`);
  if (typeof v.note !== "string" || !v.note.trim()) e.push("missing 'note'");
  if (!Array.isArray(v.corrections)) e.push("missing 'corrections' (array; [] when the finding's text is accurate)");
  else v.corrections.forEach((c: unknown, i: number) => {
    const x = (c ?? {}) as Record<string, unknown>;
    if (!(CORRECTABLE as readonly string[]).includes(String(x.field))) e.push(`corrections[${i}]: bad field ${JSON.stringify(x.field)} (one of ${CORRECTABLE.join(", ")})`);
    for (const k of ["claim", "correction"]) if (typeof x[k] !== "string" || !(x[k] as string).trim()) e.push(`corrections[${i}]: missing '${k}'`);
  });
  if (hasSecret(JSON.stringify(v))) e.push("contains an unredacted credential-shaped value");
  return e;
}

// ---------- loading ----------

export function listJson(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".json")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export interface LoadedShards { shards: (RawShard & { path: string })[]; invalid: { path: string; errors: string[] }[] }

export function loadShards(analysis: string, source?: string): LoadedShards {
  const shards: LoadedShards["shards"] = [];
  const invalid: LoadedShards["invalid"] = [];
  for (const p of listJson(join(analysis, "raw"))) {
    const obj = readJson<unknown>(p, undefined);
    const errors = obj === undefined ? ["invalid JSON"] : validateShard(obj, source);
    if (errors.length) { invalid.push({ path: p, errors }); continue; }
    const s = (Array.isArray(obj) ? { shard: p, filesRead: [], notReached: [], findings: obj } : obj) as RawShard;
    shards.push({ ...s, path: p });
  }
  return { shards, invalid };
}

// ---------- fingerprint + merge ----------

export function categoryFor(f: RawFinding): string {
  const cwe = normaliseCwe(f.cwe);
  if (cwe) {
    const c = categoryOf(cwe);
    return c.id === "uncategorized" ? cwe : c.id;
  }
  return f.category ? `${f.dimension}:${f.category.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : f.dimension;
}

/** v1:sha256(category | path | ±3 normalised source lines). Survives line shifts. */
export function fingerprint(category: string, file: string, line: number, source?: string): string {
  let ctx = "";
  const text = source ? readText(join(source, file)) : null;
  if (text !== null) {
    const lines = text.split(/\r?\n/);
    ctx = lines.slice(Math.max(0, line - 4), line + 3).map((l) => l.trim().replace(/\s+/g, " ")).join("\n");
  } else ctx = `line:${line}`;
  return `v1:${sha256(`${category}|${file}|${ctx}`)}`;
}

/** Strict severity order (Blocker > Critical > … > Nit). SEV_RANK groups Blocker+Critical for roadmap buckets only. */
export const SEV_ORDER = (s: Severity): number => SEVERITIES.indexOf(s);
function worse(a: Severity, b: Severity): Severity { return SEV_ORDER(a) <= SEV_ORDER(b) ? a : b; }

export function mergeShards(shards: RawShard[], source?: string): Finding[] {
  type Item = { f: RawFinding; shard: string; cat: string; file: string };
  const groups = new Map<string, Item[]>();
  for (const s of shards) for (const f of s.findings) {
    const file = normalize(f.file).split("\\").join("/");
    const cat = categoryFor(f);
    const key = `${file}\u0000${cat}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ f: { ...f, file, cwe: normaliseCwe(f.cwe) ?? f.cwe }, shard: s.shard, cat, file });
  }
  const out: Finding[] = [];
  const used = new Set<string>();
  for (const key of [...groups.keys()].sort()) {
    const items = groups.get(key)!.sort((a, b) => a.f.line - b.f.line || a.shard.localeCompare(b.shard));
    const clusters: Item[][] = [];
    for (const it of items) {
      const last = clusters[clusters.length - 1];
      if (last && it.f.line - last[last.length - 1]!.f.line <= 3) last.push(it); // single linkage
      else clusters.push([it]);
    }
    for (const cl of clusters) {
      // Representative: worst severity, then highest confidence, then agent over scanner, then shard order.
      const rep = [...cl].sort((a, b) =>
        SEV_ORDER(a.f.severity) - SEV_ORDER(b.f.severity) ||
        CONF_RANK[a.f.confidence] - CONF_RANK[b.f.confidence] ||
        Number(SCANNER_SOURCES.has(a.f.source ?? "")) - Number(SCANNER_SOURCES.has(b.f.source ?? "")) ||
        a.shard.localeCompare(b.shard))[0]!;
      // Fingerprint the representative's own line; every member's fingerprint is kept as
      // an alias so votes / accepted risks survive when another shard joins the cluster.
      const fp = fingerprint(rep.cat, rep.file, rep.f.line, source);
      const prefix = DIM_PREFIX[rep.f.dimension];
      let id = `${prefix}-${fp.slice(3, 11)}`;
      for (let n = 2; used.has(id); n++) id = `${prefix}-${fp.slice(3, 11)}${n}`;
      used.add(id);
      const aliases = [...new Set(cl.map((c) => fingerprint(rep.cat, rep.file, c.f.line, source)))].filter((a) => a !== fp).sort();
      const shardsOf = [...new Set(cl.map((c) => c.shard))].sort();
      out.push({
        ...rep.f,
        severity: cl.reduce<Severity>((s, c) => worse(s, c.f.severity), rep.f.severity),
        cwe: rep.f.cwe ?? cl.find((c) => c.f.cwe)?.f.cwe,
        id, fingerprint: fp, category: rep.cat, reporters: shardsOf.length, shards: shardsOf,
        ...(aliases.length ? { aliases } : {}),
      });
    }
  }
  return foldIntoSecurity(out).sort((a, b) => a.id.localeCompare(b.id));
}

const SEC_WORDS = /inject|travers|\bxss\b|cross-site|csrf|ssrf|deserial|idor|privilege escalation|authori[sz]ation bypass|auth(?:entication)? bypass|hard-?coded (?:password|key|token|credential|secret)|credential|arbitrary file|open redirect|remote code|\brce\b|CWE-\d+/i;

/**
 * Live runs showed one vulnerability reported by security, data and quality
 * shards alike. A non-security finding within 3 lines of a security finding in
 * the same file that describes a security weakness is folded into it (counted
 * as a reporter, kept as an alias) — one bug, one finding, one panel.
 */
export function foldIntoSecurity(fs: Finding[]): Finding[] {
  const sec = fs.filter((f) => f.dimension === "security");
  if (!sec.length) return fs;
  const out: Finding[] = [];
  for (const f of fs) {
    if (f.dimension !== "security" && SEC_WORDS.test(`${f.title} ${f.evidence} ${f.cwe ?? ""}`)) {
      const host = sec.filter((s) => s.file === f.file && Math.abs(s.line - f.line) <= 3)
        .sort((a, b) => Math.abs(a.line - f.line) - Math.abs(b.line - f.line) || a.id.localeCompare(b.id))[0];
      if (host) {
        host.shards = [...new Set([...host.shards, ...f.shards])].sort();
        host.reporters = host.shards.length;
        host.aliases = [...new Set([...(host.aliases ?? []), f.fingerprint, ...(f.aliases ?? [])])].sort();
        continue;
      }
    }
    out.push(f);
  }
  return out;
}

// ---------- verdicts ----------

/** Median severity of confirming votes, lower tier on ties, never above the candidate. */
export function panelSeverity(original: Severity, confirming: (Severity | undefined)[]): Severity {
  const idx = confirming.map((s) => SEV_ORDER(s ?? original)).sort((a, b) => a - b);
  if (!idx.length) return original;
  const mid = idx.length % 2 ? idx[(idx.length - 1) / 2]! : idx[idx.length / 2]!; // even: the lower tier
  return SEVERITIES[Math.max(mid, SEV_ORDER(original))]!; // never raised
}

function capConfidence(c: Confidence, cap: Confidence): Confidence { return CONF_RANK[c] >= CONF_RANK[cap] ? c : cap; }

/**
 * A confirmed finding never ships with text a confirming verifier proved wrong: the
 * corrections ride on the finding (rendered beside the text), and a corrected title or
 * location (its core claim) goes to a human instead. Confidence is left alone: it rates the
 * core claim, which the verdict already settled; a wrong detail is shown, not averaged in.
 */
function applyCorrections(out: Finding, confirming: Vote[]): void {
  if (out.verdict !== "confirmed") return;
  const seen = new Set<string>();
  const cs: Correction[] = confirming.flatMap((v) => (v.corrections ?? []).map((c) => ({ field: c.field, claim: c.claim, correction: c.correction, lens: v.lens })))
    .filter((c) => { const k = `${c.field}|${c.claim.trim().toLowerCase()}`; return seen.has(k) ? false : (seen.add(k), true); }); // lenses often repeat one
  if (!cs.length) return;
  out.corrections = cs;
  const core = cs.filter((c) => CORE_FIELDS.includes(c.field));
  if (core.length) {
    out.verdict = "needs-human";
    out.verifier_note = `confirmed, but the verifier corrected its ${[...new Set(core.map((c) => c.field))].join(" and ")}: ` +
      core.map((c) => `"${c.claim}" → ${c.correction}`).join("; ") + `. A maintainer must restate the finding. ${out.verifier_note ?? ""}`.trimEnd();
  }
}

export function applyVotes(f: Finding, votes: Vote[], opts: { deferred: boolean; final: boolean }): Finding {
  const out: Finding = { ...f, original_severity: f.severity };
  delete out.verdict;
  delete out.corrections; // recomputed from the current votes on every merge
  if (f.dimension === "security") {
    const byLens = new Map(votes.filter((v) => (LENSES as readonly string[]).includes(v.lens)).map((v) => [v.lens, v]));
    const vs = [...byLens.values()];
    out.votes = vs.map(({ lens, verdict, severity, note, evidence, corrections }) => ({ lens, verdict, severity, note, evidence, corrections }));
    const ok = vs.filter((v) => v.verdict === "confirmed");
    const no = vs.filter((v) => v.verdict === "refuted");
    if (vs.length === 3) {
      if (ok.length >= 2) {
        out.verdict = "confirmed";
        out.severity = panelSeverity(f.severity, ok.map((v) => v.severity));
        out.confidence = ok.length === 3 ? f.confidence : capConfidence(f.confidence, "medium");
      } else if (no.length >= 2) out.verdict = "refuted";
      else out.verdict = "needs-human";
      out.verifier_note = `${ok.length}/3 lenses confirmed` + (out.verdict === "needs-human" ? "; split panel — " + vs.map((v) => `${v.lens}: ${v.note}`).join(" | ") : "");
      applyCorrections(out, ok);
    } else if (opts.deferred && !vs.length) {
      out.verdict = "deferred"; out.verifier_note = "verification deferred (agent cap); coverage gap";
    } else if (opts.final) {
      out.verdict = "needs-human"; out.verifier_note = `panel incomplete (${vs.length}/3 votes returned)`;
    }
    return out;
  }
  const v = votes.find((x) => x.lens === "VERIFY");
  if (v) {
    out.votes = [{ lens: v.lens, verdict: v.verdict, severity: v.severity, note: v.note, evidence: v.evidence, corrections: v.corrections }];
    out.verdict = v.verdict;
    out.verifier_note = v.note;
    if (v.verdict === "confirmed" && v.severity) out.severity = SEV_ORDER(v.severity) >= SEV_ORDER(f.severity) ? v.severity : f.severity;
    applyCorrections(out, v.verdict === "confirmed" ? [v] : []);
  } else if (opts.deferred) {
    out.verdict = "deferred"; out.verifier_note = "verification deferred (agent cap); coverage gap";
  } else if (opts.final) {
    out.verdict = "needs-human"; out.verifier_note = "verifier did not return";
  }
  return out;
}

export function loadVotes(analysis: string): { votes: Map<string, Vote[]>; invalid: { path: string; errors: string[] }[] } {
  const votes = new Map<string, Vote[]>();
  const invalid: { path: string; errors: string[] }[] = [];
  for (const p of listJson(join(analysis, "votes"))) {
    const v = readJson<unknown>(p, undefined);
    const errors = v === undefined ? ["invalid JSON"] : validateVote(v, p.split("/").pop());
    if (errors.length) { invalid.push({ path: p, errors }); continue; }
    const vote = v as Vote;
    if (!votes.has(vote.id)) votes.set(vote.id, []);
    votes.get(vote.id)!.push(vote);
  }
  return { votes, invalid };
}

export function loadAccepted(source: string): Accepted[] {
  const a = readJson<{ accepted?: Accepted[] }>(join(source, ".code-review", "accepted-risk.json"), {});
  return Array.isArray(a.accepted) ? a.accepted.filter((x) => x && typeof x.fingerprint === "string") : [];
}

export function verifyDeferred(analysis: string): Set<string> {
  const plan = readJson<Plan | null>(join(analysis, "plan", "verify.json"), null);
  return new Set((plan?.deferred ?? []).map((k) => k.split("--")[0]!));
}
