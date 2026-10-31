// Code-review status dashboard (Claude Code Mod).
//
// Read-only. Polls, every 2 s from session.start, two driver-written files
// beside the code under review:
//   <cwd>/.code-review/<name>/status.json    gates, findings, usage (per stage)
//   <cwd>/.code-review/<name>/progress.json  the live run: stage, tool calls,
//                                            agents, last activity (review.ts run)
// and shows them in three places that do not need a turn to be running:
//   - a status line under the prompt (always, while a review exists),
//   - the "Code review" pane: opened by /review-dashboard, and automatically
//     when a run starts (unasked panes seat from 144 columns),
//   - the spinner suffix while a turn is running.
// Uses only the mods API ($) — hooks modules may not import node: builtins.
// Every read is best effort: a missing or half-written file never breaks the
// session, and headless `claude -p` runs are unaffected.

import type { Register } from "claude-code";
import { fmtUsd, usageDetail, usageSummary } from "./usage.ts";

const PANE = "code-review";
const POLL_MS = 2000;
const STALE_MS = 20 * 60 * 1000; // no driver event for this long: say so

type Any = any; // status.json / progress.json are driver-owned JSON

let status: Any = null;
let progress: Any = null;
let logTail: string[] = [];
let liveUsage: Any = null;
let now = 0;
let lastKey = "";
let autoOpenedFor: number | null = null;
let paneOpen = false; // once opened, keep the run.log tail fresh for it

async function cwdOf($: Any): Promise<string> {
  try {
    const c = await $.session.cwd();
    return typeof c === "string" ? c : (c && (c.cwd || c.path)) || ".";
  } catch { return "."; }
}

async function readText($: Any, path: string): Promise<string | null> {
  try {
    const r = await $.fs.read(path);
    return typeof r === "string" ? r : (r && (r.text ?? r.content)) ?? null;
  } catch { return null; }
}

async function readJson($: Any, path: string): Promise<Any> {
  const t = await readText($, path);
  if (!t) return null;
  try { return JSON.parse(t); } catch { return undefined; } // undefined: half-written, keep last
}

async function mtimeOf($: Any, path: string): Promise<number> {
  try { return (await $.fs.stat(path)).mtimeMs || 0; } catch { return 0; }
}

/** The review dir under <cwd>/.code-review touched most recently (status or progress). */
async function newestReviewDir($: Any): Promise<string | null> {
  const root = (await cwdOf($)) + "/.code-review";
  try {
    if (!(await $.fs.exists(root))) return null;
    const entries = (await $.fs.list(root)) || [];
    let best: { dir: string; t: number } | null = null;
    for (const e of entries) {
      const name = typeof e === "string" ? e : e && (e.name || e.path);
      if (!name || name.startsWith(".")) continue;
      const dir = name.startsWith("/") ? name : `${root}/${name}`;
      const t = Math.max(await mtimeOf($, `${dir}/status.json`), await mtimeOf($, `${dir}/progress.json`));
      if (t && (!best || t >= best.t)) best = { dir, t };
    }
    return best ? best.dir : null;
  } catch { return null; }
}

async function refresh($: Any): Promise<void> {
  try { now = await $.clock.now(); } catch { now = Date.now(); }
  const dir = await newestReviewDir($);
  if (!dir) { status = null; progress = null; logTail = []; return; }
  const s = await readJson($, `${dir}/status.json`);
  if (s !== undefined) status = s;
  const p = await readJson($, `${dir}/progress.json`);
  if (p !== undefined) progress = p;
  if (paneOpen) {
    const log = await readText($, `${dir}/run.log`);
    if (log !== null) logTail = log.trimEnd().split("\n").slice(-40);
  }
  try { liveUsage = await $.session.usage(); } catch { /* keep last */ }
}

const isRunning = () => !!progress && progress.state === "running";
const isStale = () => isRunning() && now - (progress.updated_at || 0) > STALE_MS;

function dur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h ? `${h}h${String(m % 60).padStart(2, "0")}m` : m ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

function stagePos(stage: string | null): string {
  const list: Any[] = status?.stages || [];
  const i = list.findIndex((x) => x.stage === stage);
  return i >= 0 ? ` ${i + 1}/${list.length}` : "";
}

function spentUsd(): number | null {
  const t = status?.usage?.totals?.total_cost_usd;
  return typeof t === "number" ? t : null;
}

/** One line: the status line and the spinner suffix. */
function oneLine(): string {
  if (!status && !progress) return "";
  const name = progress?.name || status?.name || "";
  const f = status?.findings || {}, v = f.by_verdict || {};
  const findings = `findings ${f.total ?? 0} (✓${v.confirmed ?? 0} ?${v["needs-human"] ?? 0} ✗${v.refuted ?? 0})`;
  const usd = spentUsd();
  const cost = usd !== null ? ` · ${fmtUsd(usd)}` : "";
  if (isRunning()) {
    const st = progress.stage || "starting";
    const el = dur(now - (progress.stage_started_at || progress.started_at || now));
    const act = `${progress.tool_calls ?? 0} tools · ${progress.agents_started ?? 0} agents`;
    const last = progress.last ? ` · ${String(progress.last).slice(0, 60)}` : "";
    const stale = isStale() ? ` · no activity for ${dur(now - progress.updated_at)} — is the driver still running?` : "";
    return `▶ review ${name} · ${st}${stagePos(st)} ${el} · ${act}${last} · ${findings}${cost}${stale}`;
  }
  if (progress && progress.state !== "done") {
    return `■ review ${name} ${progress.state}${progress.message ? ` (${progress.message})` : ""} at ${progress.stage || "?"} · ${findings}${cost} · resume: re-run /code-review-harness:review-run`;
  }
  const stage = status?.complete ? "complete" : `next ${status?.next_stage || "?"}`;
  return `review ${name} ${stage} · ${findings}${cost}`;
}

function paneLines(): string[] {
  if (!status && !progress) return ["No review found under ./.code-review.", "Start one: /code-review-harness:review-run <name> --source ."];
  const out: string[] = [];
  const name = progress?.name || status?.name;
  out.push(`Code review — ${name}`);
  if (status?.analysis_dir) out.push(`Artefacts: ${status.analysis_dir}`);
  if (progress?.log) out.push(`Live log:  tail -f ${progress.log}`);
  out.push("");
  if (isRunning()) {
    out.push(`Running ${dur(now - progress.started_at)} · stage ${progress.stage || "starting"} for ${dur(now - (progress.stage_started_at || now))} · ${progress.tool_calls ?? 0} tool calls · ${progress.agents_started ?? 0} agents started`);
    if (isStale()) out.push(`No driver event for ${dur(now - progress.updated_at)}: check the background shell or run.log.`);
  } else if (progress) {
    out.push(`Run ${progress.state}${progress.message ? ` (${progress.message})` : ""} after ${dur((progress.updated_at || now) - progress.started_at)}`);
  }
  out.push("", "Stages:");
  for (const st of status?.stages || []) {
    const live = isRunning() && progress.stage === st.stage && st.status === "pending";
    const mark = live ? "▶" : st.status === "pending" ? "·" : "✓";
    const u = (status?.usage?.stages || []).find((x: Any) => x.stage === st.stage);
    const extra = u ? `  ${fmtUsd(u.total_cost_usd)}${u.duration_ms ? ` · ${dur(u.duration_ms)}` : ""}` : "";
    out.push(`  ${mark} ${st.stage}${st.status === "skipped" ? " (skipped)" : ""}${extra}`);
  }
  const f = status?.findings;
  if (f) {
    const v = f.by_verdict || {}, sev = f.by_severity || {};
    out.push("", `Findings: ${f.total ?? 0} · confirmed ${v.confirmed ?? 0} · needs-human ${v["needs-human"] ?? 0} · refuted ${v.refuted ?? 0} · pending ${v.pending ?? 0}`);
    const sevs = Object.entries(sev).map(([k, n]) => `${k} ${n}`).join(" · ");
    if (sevs) out.push(`  confirmed by severity: ${sevs}`);
  }
  const sh = status?.shards || {};
  if (sh.lost?.length) out.push("", `Lost shards — coverage gaps (${sh.lost.length}):`, ...sh.lost.slice(0, 10).map((x: string) => `  - ${x}`));
  if (sh.deferred?.length) out.push("", `Deferred by agent cap (${sh.deferred.length}):`, ...sh.deferred.slice(0, 10).map((x: string) => `  - ${x}`));
  const ud = usageDetail(liveUsage, status?.usage || null);
  if (ud.length) out.push("", "Usage:", ...ud.map((x: string) => "  " + x));
  if (logTail.length) out.push("", "Recent activity (run.log):", ...logTail.slice(-15).map((l) => "  " + l));
  if (!isRunning()) out.push("", `Next: ${status?.next_command || "none — open ANALYSIS_REPORT.md / REPORT.html"}`);
  return out;
}

async function openPane($: Any): Promise<void> {
  paneOpen = true;
  try { await $.ui.open({ id: PANE, title: "Code review" }); } catch { /* no surface */ }
}

async function tick($: Any): Promise<void> {
  await refresh($);
  const line = oneLine();
  const key = `${line}|${logTail.length ? logTail[logTail.length - 1] : ""}`;
  if (key !== lastKey) {
    lastKey = key;
    try { $.ui.status(line || undefined); } catch { /* headless */ }
    try { $.ui.invalidate("ui.render"); } catch { /* headless */ }
  }
  // A run just started (in this or any session on this repo): offer the pane.
  if (isRunning() && autoOpenedFor !== progress.started_at) {
    autoOpenedFor = progress.started_at;
    await openPane($);
    await refresh($); // fill the run.log tail for the pane now, not a tick later
  }
}

export const register: Register = (on) => {
  try {
    on("session.start", async ($, e, next) => {
      try {
        await $.command.register({
          name: "review-dashboard",
          description: "Open the live code-review dashboard pane (stage, activity, findings, cost)",
        });
      } catch { /* command registration unavailable in this build */ }
      await tick($);
      try { $.clock.every(POLL_MS, () => { void tick($); }); } catch { /* no timers: turn.complete still refreshes */ }
      return next(e);
    });
    on("turn.complete", async ($, e, next) => {
      await tick($);
      return next(e);
    });
    on("command.run", { command: "review-dashboard" }, async ($) => {
      await openPane($);
      await tick($);
      return { text: paneLines().join("\n") };
    });
    on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
      const { Box, Text } = $.ui.resolve(e);
      return (
        <Box flexDirection="column">
          {paneLines().map((l, i) => (i === 0 ? <Text bold>{l}</Text> : <Text wrap="truncate-end">{l || " "}</Text>))}
        </Box>
      );
    });
    on("ui.render", { component: "Spinner" }, async ($, e, next) => {
      const line = oneLine();
      if (!line) return next(e);
      const u = usageSummary(liveUsage, null);
      return next({ ...e, props: { ...e.props, suffix: ` · ${line}${u ? ` · ${u}` : ""}` } });
    });
  } catch { /* Mods API unavailable: stay inert, settings hooks still guard writes */ }
};
