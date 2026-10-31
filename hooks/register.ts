// Code-review status dashboard (Claude Code Mod).
// Read-only: renders <cwd>/.code-review/<name>/status.json (written deterministically
// by `scripts/review.ts status`) in the spinner suffix and via /review-dashboard,
// plus token usage + cost: live session figures from $.session.usage(), and
// the accumulated review-run totals recorded in status.json by
// `review.ts run` (per-stage `claude -p --output-format json`).
// Uses only the mods API ($) — hooks modules may not import node: builtins.
// Degrades to a no-op if the Mods API or the status file is unavailable, so
// headless `claude -p` runs are unaffected.

import { usageSummary, usageDetail } from "./usage.ts";

let cached: any = null; // last status read, shared between hooks in this module
let liveUsage: any = null; // last $.session.usage() snapshot

async function refreshUsage($: any): Promise<void> {
  try { liveUsage = await $.session.usage(); } catch { /* keep last snapshot */ }
}

async function cwdOf($: any): Promise<string> {
  try {
    const c = await $.session.cwd();
    return typeof c === "string" ? c : (c && (c.cwd || c.path)) || ".";
  } catch { return "."; }
}

async function readJson($: any, path: string): Promise<any> {
  const r = await $.fs.read(path);
  const text = typeof r === "string" ? r : (r && (r.text ?? r.content)) || "";
  return JSON.parse(text);
}

async function findStatus($: any): Promise<string | null> {
  // Status lives beside the code under review: <cwd>/.code-review/<name>/status.json
  const root = (await cwdOf($)) + "/.code-review";
  try {
    if (!(await $.fs.exists(root))) return null;
    const entries = await $.fs.list(root);
    const names = (entries || []).map((e) => (typeof e === "string" ? e : e && (e.name || e.path))).filter(Boolean);
    let best = null;
    for (const name of names) {
      const p = `${root}/${name}/status.json`;
      try {
        if (!(await $.fs.exists(p))) continue;
        const st = await $.fs.stat(p);
        const mtime = (st && (st.mtimeMs ?? st.mtime ?? 0)) || 0;
        if (!best || mtime >= best.mtime) best = { p, mtime };
      } catch { /* skip unreadable entry */ }
    }
    return best ? best.p : null;
  } catch { return null; }
}

async function readStatus($: any): Promise<any> {
  try {
    const p = await findStatus($);
    if (!p) return null;
    cached = await readJson($, p);
    return cached;
  } catch {
    return cached; // never break the session on a half-written status file
  }
}

function oneLine(s: any): string {
  if (!s) return "review: no status.json yet (run /code-review-harness:review-run)";
  const f = s.findings || {}, v = f.by_verdict || {}, sh = s.shards || {};
  const stage = s.complete ? "complete" : `stage ${s.next_stage || "?"}`;
  const base = `review ${s.name || ""} ${stage} · shards ${sh.completed ?? 0}/${sh.expected ?? 0}` +
    ` · findings ${f.total ?? 0} (\u2713${v.confirmed ?? 0} ?${v["needs-human"] ?? 0} \u2717${v.refuted ?? 0})` +
    ((sh.lost && sh.lost.length) ? ` · lost ${sh.lost.length}` : "") +
    ((sh.deferred && sh.deferred.length) ? ` · deferred ${sh.deferred.length}` : "") +
    (s.next_command ? ` · next: ${s.next_command}` : "");
  const u = usageSummary(liveUsage, s.usage || null);
  return u ? `${base} · ${u}` : base;
}

function fullText(s: any): string {
  if (!s) return "No review status found. Start one: /code-review-harness:review-run <name> --source .";
  const lines = [`Code review — ${s.name}`, `Artefacts: ${s.analysis_dir}`, oneLine(s), "", "Stages:"];
  for (const st of s.stages || []) lines.push(`  ${st.status === "pending" ? "\u00b7" : "\u2713"} ${st.stage}${st.status === "skipped" ? " (skipped)" : ""}`);
  const sh = s.shards || {};
  if (sh.lost && sh.lost.length) lines.push("", `Lost shards — coverage gaps (${sh.lost.length}):`, ...sh.lost.slice(0, 30).map((x: string) => `  - ${x}`));
  if (sh.deferred && sh.deferred.length) lines.push("", `Deferred by agent cap (${sh.deferred.length}):`, ...sh.deferred.slice(0, 30).map((x: string) => `  - ${x}`));
  if (sh.oversized_modules && sh.oversized_modules.length)
    lines.push("", `Oversized modules — split before deep review: ${sh.oversized_modules.join(", ")}`);
  const ud = usageDetail(liveUsage, s.usage || null);
  if (ud.length) lines.push("", "Usage:", ...ud.map((x: string) => "  " + x));
  lines.push("", `Next: ${s.next_command || "none — open ANALYSIS_REPORT.md / REPORT.html"}`);
  return lines.join("\n");
}

export function register(on: any): void {
  try {
    on("session.start", async ($, e, next) => {
      try {
        await $.command.register({
          name: "review-dashboard",
          description: "Show code-review stage, shard and findings status (from status.json)",
        });
      } catch { /* command registration unavailable in this build */ }
      await readStatus($); await refreshUsage($);
      return next(e);
    });
    on("turn.complete", async ($, e, next) => {
      await readStatus($); await refreshUsage($);
      try { $.ui.invalidate("ui.render"); } catch { /* no UI (headless) */ }
      return next(e);
    });
    on("command.run", { command: "review-dashboard" }, async ($) => {
      await refreshUsage($);
      return { text: fullText(await readStatus($)) };
    });
    on("ui.render", { component: "Spinner" }, async ($, e, next) => {
      const s = cached || (await readStatus($));
      if (!s) return next(e);
      return next({ ...e, props: { ...e.props, suffix: " · " + oneLine(s) } });
    });
  } catch { /* Mods API unavailable: stay inert, settings hooks still guard writes */ }
}
