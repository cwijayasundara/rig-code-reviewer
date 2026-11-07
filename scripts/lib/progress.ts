// Live visibility for `/review-run`: every driver line goes to the terminal AND
// to <analysis>/run.log (timestamped, append-only, `tail -f`-able), and the
// running stage's state goes to <analysis>/progress.json, which the status Mod
// polls. Both are written by the driver only; nothing here decides a gate.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeJson } from "./util.ts";

export interface Progress {
  name: string;
  pid: number;
  state: "running" | "stopped" | "done" | "failed";
  stage: string | null;
  stage_started_at: number | null;
  started_at: number;
  updated_at: number;
  tool_calls: number;
  agents_started: number;
  last: string | null;
  log: string;
  message?: string;
}

const hhmmss = (t: number) => new Date(t).toTimeString().slice(0, 8);

export class RunLog {
  readonly logPath: string;
  readonly progressPath: string;
  private p: Progress;
  private lastWrite = 0;

  constructor(analysis: string, name: string) {
    mkdirSync(analysis, { recursive: true });
    this.logPath = join(analysis, "run.log");
    this.progressPath = join(analysis, "progress.json");
    const now = Date.now();
    this.p = { name, pid: process.pid, state: "running", stage: null, stage_started_at: null, started_at: now, updated_at: now, tool_calls: 0, agents_started: 0, last: null, log: this.logPath };
    this.append(`=== review-run ${name} started (pid ${process.pid}) ===`);
    this.flush(true);
  }

  private append(line: string): void {
    try { appendFileSync(this.logPath, `${hhmmss(Date.now())} ${line}\n`); } catch { /* logging never breaks a run */ }
  }

  /** Normal driver output: stdout + run.log. */
  say(line: string): void { console.log(line); this.append(line); }
  /** Errors and stops: stderr + run.log. */
  warn(line: string): void { console.error(line); this.append(line); }

  stage(stage: string): void {
    const now = Date.now();
    Object.assign(this.p, { stage, stage_started_at: now, tool_calls: 0, agents_started: 0, last: "starting" });
    this.flush(true);
  }

  /** One event from inside a stage process (a tool call, an agent start). */
  activity(text: string, kind: "tool" | "agent" = "tool"): void {
    if (kind === "agent") this.p.agents_started += 1; else this.p.tool_calls += 1;
    this.p.last = text;
    this.say(text.startsWith("↳") ? `      ${text}` : `    · ${text}`);
    this.flush(false);
  }

  finish(state: Progress["state"], message?: string): void {
    this.p.state = state;
    if (message) this.p.message = message;
    this.append(`=== review-run ${this.p.name} ${state}${message ? `: ${message}` : ""} ===`);
    this.flush(true);
  }

  /** progress.json, at most every 500 ms unless forced. */
  private flush(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastWrite < 500) return;
    this.lastWrite = now;
    this.p.updated_at = now;
    try { writeJson(this.progressPath, this.p); } catch { /* dashboard is best effort */ }
  }
}

const clip = (s: string, n = 90) => { const one = s.replace(/\s+/g, " ").trim(); return one.length > n ? one.slice(0, n - 1) + "…" : one; };

/** A short human line for one tool_use block of `claude -p --output-format stream-json`. */
export function describeTool(name: string, input: Record<string, unknown> | undefined, sub: boolean): { text: string; kind: "tool" | "agent" } {
  const i = input ?? {};
  const s = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  const prefix = sub ? "↳ " : "";
  if (name === "Agent" || name === "Task") {
    return { text: `${prefix}agent ${s("subagent_type") || "general"}: ${clip(s("description") || s("prompt"), 70)}`, kind: "agent" };
  }
  const arg = s("file_path") || s("path") || s("pattern") || s("command") || s("description") || s("skill") || s("query") || s("url");
  return { text: `${prefix}${name}${arg ? " " + clip(arg) : ""}`, kind: "tool" };
}

/**
 * Feed one stdout line of a stage process. Returns the final result object
 * (the `type: "result"` event, or a stub's single JSON) when the line is one.
 */
export function onStreamLine(line: string, log: RunLog): Record<string, unknown> | null {
  const t = line.trim();
  if (!t) return null;
  let ev: Record<string, unknown>;
  try { ev = JSON.parse(t) as Record<string, unknown>; } catch { log.say(t); return null; }
  if (ev.type === "result" || (ev.type === undefined && "result" in ev)) return ev;
  if (ev.type === "assistant") {
    const msg = ev.message as { content?: { type?: string; name?: string; input?: Record<string, unknown> }[] } | undefined;
    const sub = typeof ev.parent_tool_use_id === "string" && ev.parent_tool_use_id !== "";
    for (const c of msg?.content ?? []) {
      if (c.type === "tool_use" && c.name) { const d = describeTool(c.name, c.input, sub); log.activity(d.text, d.kind); }
    }
  }
  return null;
}

/** Driver lines worth relaying in chat (stage boundaries, stops, errors); tool-level `·` lines are not. */
export const WATCH_LINE = /==> |--- |error|warning|stopping|retrying|lost|usage: |open: |=== review-run /i;

/**
 * Whether `watch` forwards a run.log line. Every forwarded line wakes the chat session
 * that armed the Monitor for a full turn, so tool-call lines, the stage process's own
 * stderr (\`    ! …\`, which echoes whatever the model's tools printed) and the per-stage
 * "gate passes, skipping" lines of a resume stay in run.log only.
 */
export function watchable(l: string): boolean {
  // Indented lines are tool calls (·), subagent activity (↳) and stage stderr (!); match any indent.
  return WATCH_LINE.test(l) && !/^\S+ {2,}(· |↳ |! )/.test(l) && !/gate passes, skipping/.test(l);
}

/**
 * `review.ts watch`: follow run.log from the start of the latest run and print
 * only WATCH_LINE lines, so a chat Monitor sees each stage start/finish. Exits 0
 * when the run ends (progress.json leaves "running"), 3 if the driver process
 * vanished without finishing, 0 after `maxMinutes` (re-arm to keep watching).
 */
export async function watchRun(analysis: string, maxMinutes = 28): Promise<number> {
  const { existsSync, readFileSync } = await import("node:fs");
  const logPath = join(analysis, "run.log"), progressPath = join(analysis, "progress.json");
  const deadline = Date.now() + maxMinutes * 60_000;
  let offset = -1, carry = "";
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
  const readProgress = (): Progress | null => { try { return JSON.parse(readFileSync(progressPath, "utf8")) as Progress; } catch { return null; } };
  const drain = () => {
    if (!existsSync(logPath)) return;
    const buf = readFileSync(logPath);
    if (offset < 0) { const i = buf.lastIndexOf(" started (pid "); offset = i < 0 ? 0 : buf.lastIndexOf("\n", i) + 1; }
    if (buf.length < offset) offset = 0; // truncated
    const text = carry + buf.subarray(offset).toString("utf8");
    offset = buf.length;
    const parts = text.split("\n");
    carry = parts.pop() ?? "";
    for (const l of parts) if (watchable(l)) console.log(l);
  };
  for (;;) {
    drain();
    const p = readProgress();
    if (p && p.state !== "running") { drain(); if (carry) console.log(carry); return 0; }
    if (p && !alive(p.pid)) { drain(); console.log(`watch: driver pid ${p.pid} is gone but progress.json still says running (stage ${p.stage}) — the run was killed; re-run the same /review-run command to resume`); return 3; }
    if (Date.now() > deadline) { console.log(`watch: still running (stage ${p?.stage ?? "?"}, ${p?.tool_calls ?? 0} tool calls) — re-arm to keep watching`); return 0; }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
