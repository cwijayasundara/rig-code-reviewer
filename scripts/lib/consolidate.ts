// Cross-dimension duplicate removal. Live runs showed one defect reported by
// several dimensions (e.g. "connection never closed" from architecture, data,
// operability, performance and quality). Wording-based merging is unreliable,
// so: the script proposes candidate groups (same file, lines within WINDOW,
// single linkage); a consolidator agent says which members share one root
// cause; the script validates the decision and applies it. Nothing is merged
// without a decision, and nothing outside a group can be touched.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { SEVERITIES, type Finding, type Severity } from "./types.ts";
import { readJson, sha256 } from "./util.ts";

export const WINDOW = 5;

export interface Group { key: string; file: string; members: string[] }
export interface Decision { group: string; merges: { keep: string; merge: string[]; reason: string }[] }

export function candidateGroups(findings: Finding[]): Group[] {
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) (byFile.get(f.file) ?? byFile.set(f.file, []).get(f.file)!).push(f);
  const groups: Group[] = [];
  for (const [file, fs] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sorted = [...fs].sort((a, b) => a.line - b.line || a.id.localeCompare(b.id));
    let cur: Finding[] = [];
    const flush = () => {
      if (cur.length >= 2) {
        const members = cur.map((f) => f.id).sort();
        groups.push({ key: `G-${sha256(members.join(",")).slice(0, 10)}`, file, members });
      }
      cur = [];
    };
    for (const f of sorted) {
      if (cur.length && f.line - cur[cur.length - 1]!.line > WINDOW) flush();
      cur.push(f);
    }
    flush();
  }
  return groups;
}

export function validateDecision(obj: unknown, group?: Group): string[] {
  if (!obj || typeof obj !== "object") return ["decision must be an object {group, merges}"];
  const d = obj as Record<string, unknown>;
  const e: string[] = [];
  if (typeof d.group !== "string") e.push("missing 'group'");
  if (group && d.group !== group.key) e.push(`group must be ${group.key}`);
  if (!Array.isArray(d.merges)) return [...e, "'merges' must be an array (empty when nothing should merge)"];
  const used = new Set<string>();
  const members = new Set(group?.members ?? []);
  (d.merges as unknown[]).forEach((m, i) => {
    const x = (m ?? {}) as Record<string, unknown>;
    if (typeof x.keep !== "string") { e.push(`merges[${i}]: 'keep' (finding id) required`); return; }
    if (!Array.isArray(x.merge) || !x.merge.length || x.merge.some((y) => typeof y !== "string")) { e.push(`merges[${i}]: 'merge' must be a non-empty array of ids`); return; }
    if (typeof x.reason !== "string" || !x.reason.trim()) e.push(`merges[${i}]: 'reason' required (the shared root cause)`);
    for (const id of [x.keep as string, ...(x.merge as string[])]) {
      if (group && !members.has(id)) e.push(`merges[${i}]: ${id} is not a member of ${group.key}`);
      if (used.has(id)) e.push(`merges[${i}]: ${id} appears in more than one merge`);
      used.add(id);
    }
  });
  return e;
}

const order = (s: Severity) => SEVERITIES.indexOf(s);

/** Apply valid decisions for the current groups; stale or invalid decision files are ignored. */
export function applyConsolidation(findings: Finding[], analysis: string): { findings: Finding[]; merged: number; invalid: { path: string; errors: string[] }[] } {
  const groups = new Map(candidateGroups(findings).map((g) => [g.key, g]));
  const byId = new Map(findings.map((f) => [f.id, f]));
  const drop = new Set<string>();
  const invalid: { path: string; errors: string[] }[] = [];
  let names: string[] = [];
  try { names = readdirSync(join(analysis, "consolidate")).filter((n) => n.endsWith(".json")).sort(); } catch { /* none yet */ }
  for (const n of names) {
    const g = groups.get(n.replace(/\.json$/, ""));
    if (!g) continue; // membership changed since the decision: the group is re-planned
    const p = join(analysis, "consolidate", n);
    const d = readJson<unknown>(p, undefined);
    const errors = d === undefined ? ["invalid JSON"] : validateDecision(d, g);
    if (errors.length) { invalid.push({ path: p, errors }); continue; }
    for (const m of (d as Decision).merges) {
      const keep = byId.get(m.keep)!;
      const others = m.merge.map((id) => byId.get(id)!);
      keep.severity = [keep, ...others].reduce<Severity>((s, f) => (order(f.severity) < order(s) ? f.severity : s), keep.severity);
      keep.shards = [...new Set([keep, ...others].flatMap((f) => f.shards))].sort();
      keep.reporters = keep.shards.length;
      keep.aliases = [...new Set([...(keep.aliases ?? []), ...others.flatMap((f) => [f.fingerprint, ...(f.aliases ?? [])])])].sort();
      keep.also_reported_as = [...new Set([...(keep.also_reported_as ?? []), ...others.map((f) => `${f.id} (${f.dimension})`)])].sort();
      keep.consolidation_note = m.reason;
      for (const o of others) drop.add(o.id);
    }
  }
  return { findings: findings.filter((f) => !drop.has(f.id)), merged: drop.size, invalid };
}
