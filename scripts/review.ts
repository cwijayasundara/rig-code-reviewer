#!/usr/bin/env node
// code-review-harness CLI. Models advise, scripts decide: every count,
// verdict, plan, render and gate lives behind one command table.
//   node scripts/review.ts <command> [args]     (Node >= 22.18, zero deps)
import { readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeBriefs } from "./lib/briefs.ts";
import { independenceWarning, loadConfig, saveResolved } from "./lib/config.ts";
import { collectEvidence } from "./lib/evidence.ts";
import { baselineDiff, loadFindings, writeExports } from "./lib/exports.ts";
import { validateShard, validateVote, listJson } from "./lib/findings.ts";
import { guardBash, guardEdit, validateOnWrite, type Decision, type HookPayload } from "./lib/guard.ts";
import { runMerge } from "./lib/merge.ts";
import { activate, artefactExcludes, deactivate, ensureReviewRoot, loadScope, locate, resolvePaths } from "./lib/paths.ts";
import { buildPlan, markAttempt } from "./lib/plan.ts";
import { renderAll } from "./lib/report.ts";
import { renderDeck } from "./lib/report-deck.ts";
import { checkFresh, finaliseRevision, stampRevision } from "./lib/revision.ts";
import { runScanners } from "./lib/scanners.ts";
import { writeStatus } from "./lib/status.ts";
import { suggestModules } from "./lib/modules.ts";
import { runDriver } from "./lib/run.ts";
import { watchRun } from "./lib/progress.ts";
import { validateArchitecture, validateTopology } from "./lib/architecture.ts";
import { DIMENSIONS, SHARDED, type Dimension, type Scope, type ShardedStage } from "./lib/types.ts";
import { nowIso, parseArgs, readJson, str, writeJson, writeText } from "./lib/util.ts";

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const VERSION = (JSON.parse(readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")) as { version: string }).version;

type Cmd = { usage: string; run: (pos: string[], flags: Record<string, string | true>) => number | Promise<number> };

function scopeOrDie(nameOrDir: string | undefined): { analysis: string; scope: Scope } {
  if (!nameOrDir) throw new Error("missing <name>");
  const analysis = locate(nameOrDir);
  const scope = loadScope(analysis);
  if (!scope) throw new Error(`no review at ${analysis} — start with: /code-review-harness:review ${nameOrDir} --source <path>`);
  return { analysis, scope };
}

function list(v: string | true | undefined): string[] {
  return typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

export function initReview(name: string, flags: Record<string, string | true>, cwd = process.cwd()): Scope {
  const { source, analysis } = resolvePaths(name, str(flags.source) ?? ".", cwd, str(flags.out));
  const prev = loadScope(analysis);
  const dims = list(flags.dimensions).length ? list(flags.dimensions) : prev?.dimensions ?? [...DIMENSIONS];
  const bad = dims.filter((d) => !(DIMENSIONS as readonly string[]).includes(d));
  if (bad.length) throw new Error(`unknown dimension(s): ${bad.join(", ")} (valid: ${DIMENSIONS.join(", ")})`);
  const effort = str(flags.effort) ?? prev?.security_effort ?? "medium";
  if (!["low", "medium", "high"].includes(effort)) throw new Error("--effort must be low|medium|high");
  const scope: Scope = {
    name, source, analysis_dir: analysis, dimensions: dims as Dimension[],
    module: str(flags.module) ?? prev?.module,
    max_agents: Number(str(flags["max-agents"]) ?? prev?.max_agents ?? 24),
    security_effort: effort as Scope["security_effort"],
    exclude: list(flags.exclude).length ? list(flags.exclude) : prev?.exclude ?? [],
    off_limits: list(flags["off-limits"]).length ? list(flags["off-limits"]) : prev?.off_limits ?? [],
    no_execution: flags["no-execution"] === true || (prev?.no_execution ?? false),
    max_usd: str(flags["max-usd"]) ? Number(flags["max-usd"]) : prev?.max_usd,
    baseline: str(flags.baseline) ?? prev?.baseline,
    created_at: prev?.created_at ?? nowIso(),
  };
  if (!Number.isInteger(scope.max_agents) || scope.max_agents < 1) throw new Error("--max-agents must be a positive integer");
  const mc = loadConfig(source, str(flags.config), cwd);
  ensureReviewRoot(source);
  writeJson(join(analysis, "scope.json"), scope);
  // Re-resolved on every init, so editing config.json takes effect on the next run or stage.
  saveResolved(analysis, mc.config, mc.files);
  const warnIndep = independenceWarning(mc.config);
  if (warnIndep) console.error(`warning: ${warnIndep}`);
  writeText(join(analysis, "REVIEW_SCOPE.md"), [
    `# Review scope — ${name}`, "",
    `- source (read-only): \`${source}\``, `- analysis_dir: \`${analysis}\``,
    `- dimensions: ${scope.dimensions.join(", ")}`, `- module: ${scope.module ?? "whole system"}`,
    `- security effort: ${scope.security_effort} · max agents per stage: ${scope.max_agents}${scope.max_usd ? ` · budget: $${scope.max_usd}` : ""}`,
    `- exclude: ${scope.exclude.join(", ") || "none"} · off-limits: ${scope.off_limits.join(", ") || "none"} · no execution: ${scope.no_execution}`,
    `- baseline: ${scope.baseline ?? "none"}`, "",
    "Written by `review.ts init` from scope.json (script-owned). Re-run `/code-review-harness:review` to change it.", "",
  ].join("\n"));
  activate(source, name, analysis);
  return scope;
}

function countVerdicts(fs: { verdict?: string }[]): { by_verdict: Record<string, number> } {
  const by_verdict: Record<string, number> = { confirmed: 0, refuted: 0, "needs-human": 0, deferred: 0, pending: 0 };
  for (const f of fs) by_verdict[f.verdict ?? "pending"]! += 1;
  return { by_verdict };
}

function printDecision(d: Decision, event: string): void {
  if (!d) return;
  if ("deny" in d) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: d.deny } }));
  else console.log(JSON.stringify({ decision: "block", reason: d.block }));
}

export const COMMANDS: Record<string, Cmd> = {
  init: {
    usage: "init <name> --source <path> [--out dir] [--dimensions a,b] [--module p] [--max-agents N] [--effort low|medium|high] [--exclude globs] [--off-limits globs] [--no-execution] [--max-usd N] [--baseline dir]",
    run: (pos, flags) => {
      const s = initReview(pos[0] ?? "", flags);
      console.log(`source:       ${s.source}\nanalysis_dir: ${s.analysis_dir}\nnext: /code-review-harness:review-preflight ${s.name}  (or /code-review-harness:review-run ${s.name} --source ${s.source})`);
      return 0;
    },
  },
  locate: { usage: "locate <name>", run: (pos) => { console.log(scopeOrDie(pos[0]).analysis); return 0; } },
  begin: {
    usage: "begin <name>   (re-activate the guard for a manual stage; prints the analysis dir)",
    run: (pos) => { const { analysis, scope } = scopeOrDie(pos[0]); activate(scope.source, scope.name, analysis); console.log(analysis); return 0; },
  },
  end: { usage: "end <name>   (deactivate the guard)", run: (pos) => { const { scope } = scopeOrDie(pos[0]); deactivate(scope.source); console.log("review guard deactivated"); return 0; } },
  evidence: {
    usage: "evidence <name> [--offline] [--no-scanners]",
    run: (pos, flags) => {
      const { analysis, scope } = scopeOrDie(pos[0]);
      const ev = collectEvidence(scope.source, { exclude: [...scope.exclude, ...artefactExcludes(scope).map((r) => `${r}/**`)] });
      writeJson(join(analysis, "evidence.json"), ev);
      const rev = stampRevision(analysis, scope.source);
      const e = ev as unknown as Record<string, unknown>;
      console.log(`evidence: ${e.total_files} files · ${e.total_code_lines} SLOC · tree ${rev.tree.slice(0, 16)}${rev.dirty ? " (dirty)" : ""}`);
      if (flags["no-scanners"] !== true) {
        const st = runScanners(scope.source, analysis, { offline: flags.offline === true, files: (e.files as string[]) ?? [] });
        for (const s of st) console.log(`scanner ${s.id}: ${s.status}${s.version ? ` (${s.version})` : ""} · ${s.findings} finding(s)${s.error ? ` · ${s.error.slice(0, 120)}` : ""}`);
      }
      writeStatus(analysis);
      return 0;
    },
  },
  scanners: {
    usage: "scanners <name> [--offline] [--only id,id]",
    run: (pos, flags) => {
      const { analysis, scope } = scopeOrDie(pos[0]);
      const ev = readJson<{ files?: string[] }>(join(analysis, "evidence.json"), {});
      for (const s of runScanners(scope.source, analysis, { offline: flags.offline === true, only: list(flags.only), files: ev.files ?? [] })) console.log(`${s.id}: ${s.status} · ${s.findings}${s.error ? ` · ${s.error.slice(0, 160)}` : ""}`);
      return 0;
    },
  },
  "suggest-modules": {
    usage: "suggest-modules <name>   (deterministic module candidates from evidence; oversized dirs split)",
    run: (pos) => { const { analysis } = scopeOrDie(pos[0]); console.log(JSON.stringify(suggestModules(analysis), null, 2)); return 0; },
  },
  plan: {
    usage: "plan <name> <deep|security|consolidate|verify> [--max-agents N] [--continue-deferred] [--json]",
    run: (pos, flags) => {
      const { analysis, scope } = scopeOrDie(pos[0]);
      const stage = pos[1] as ShardedStage;
      if (!(SHARDED as readonly string[]).includes(stage)) throw new Error(`stage must be ${SHARDED.join("|")}`);
      if (stage === "verify" || stage === "consolidate") runMerge(analysis, { final: false });
      const plan = buildPlan(analysis, stage, { maxAgents: str(flags["max-agents"]) ? Number(flags["max-agents"]) : undefined, continueDeferred: flags["continue-deferred"] === true });
      const args = writeBriefs(analysis, scope.source, plan);
      writeJson(join(analysis, "plan", `${stage}.workflow-args.json`), args);
      if (flags.json === true) console.log(JSON.stringify(args));
      else console.log(`${stage}: ${plan.estimate.formula} · est. ~$${plan.estimate.usd} · workflow args: ${join(analysis, "plan", `${stage}.workflow-args.json`)}`);
      return 0;
    },
  },
  merge: {
    usage: "merge <name> [--final] [--after deep|security|consolidate|verify]   (raw shards + votes -> findings.json, coverage.json, THREAT_MODEL.md; --after records that the stage ran)",
    run: (pos, flags) => {
      const { analysis } = scopeOrDie(pos[0]);
      const after = str(flags.after);
      if (after) {
        if (!(SHARDED as readonly string[]).includes(after)) throw new Error(`--after must be ${SHARDED.join("|")}`);
        markAttempt(analysis, after as ShardedStage);
        // The batch is consumed: a later manual invocation re-plans (picking up deferred
        // work) instead of replaying these args. The driver writes fresh args per batch.
        rmSync(join(analysis, "plan", `${after}.workflow-args.json`), { force: true });
      }
      const r = runMerge(analysis, flags.final === true ? { final: true } : {});
      if (r.consolidated) console.log(`consolidated ${r.consolidated} duplicate finding(s) into their root-cause finding`);
      console.log(`merged ${r.findings} finding(s): ${Object.entries(r.by_verdict).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
      for (const i of [...r.invalid_shards, ...r.invalid_votes]) console.log(`INVALID ${i.path}: ${i.errors.slice(0, 3).join("; ")}`);
      writeStatus(analysis);
      return 0;
    },
  },
  validate: {
    usage: "validate <name> [--require-verdict]",
    run: (pos, flags) => {
      const { analysis, scope } = scopeOrDie(pos[0]);
      const errs: string[] = [];
      for (const p of listJson(join(analysis, "raw"))) for (const e of validateShard(readJson(p, null), scope.source)) errs.push(`${p}: ${e}`);
      for (const p of listJson(join(analysis, "votes"))) for (const e of validateVote(readJson(p, null))) errs.push(`${p}: ${e}`);
      const topo = readJson<unknown>(join(analysis, "topology.json"), undefined);
      if (topo !== undefined) for (const e of validateTopology(topo)) errs.push(`topology.json: ${e}`);
      const arch = readJson<unknown>(join(analysis, "architecture.json"), undefined);
      if (arch !== undefined) for (const e of validateArchitecture(arch)) errs.push(`architecture.json: ${e}`);
      if (flags["require-verdict"] === true) for (const f of loadFindings(analysis)) if (!f.verdict) errs.push(`${f.id}: verdict required`);
      for (const e of errs) console.log(`ERROR ${e}`);
      console.log(`validate: ${errs.length} error(s)`);
      return errs.length ? 1 : 0;
    },
  },
  render: {
    usage: "render <name> [--allow-stale] [--draft]   (ANALYSIS_REPORT.md, ARCHITECTURE.md, ROADMAP.md, REPORT.html, SARIF, JSONL)",
    run: (pos, flags) => {
      const { analysis, scope } = scopeOrDie(pos[0]);
      // Freshness first: re-merging against changed code would re-fingerprint findings
      // against lines that were never verified. A stale render uses findings.json as verified.
      const fresh = checkFresh(analysis, scope.source);
      if (!fresh.fresh && flags["allow-stale"] !== true) {
        console.error(`refusing to render: the source tree changed since assess (${fresh.hint}). Re-run assess, or pass --allow-stale to render with a STALE banner.`);
        return 1;
      }
      const merged = fresh.fresh ? runMerge(analysis) : countVerdicts(loadFindings(analysis));
      if (merged.by_verdict.pending! > 0 && flags.draft !== true) {
        console.error(`refusing to render: ${merged.by_verdict.pending} finding(s) have no verdict — run /code-review-harness:review-verify ${scope.name} (or --draft)`);
        return 1;
      }
      finaliseRevision(analysis, scope.source, merged.by_verdict);
      if (scope.baseline) baselineDiff(analysis, locate(scope.baseline, scope.source));
      const r = renderAll(analysis, { pluginVersion: VERSION });
      const x = writeExports(analysis, VERSION);
      writeStatus(analysis);
      console.log(`rendered: ${r.written.map((w) => w.slice(analysis.length + 1)).join(", ")} · sarif ${x.sarif} result(s) · redactions ${r.redactions}`);
      console.log(`open: ${join(analysis, "ANALYSIS_REPORT.md")} · ${join(analysis, "ARCHITECTURE.md")} · ${join(analysis, "REPORT.html")}`);
      return 0;
    },
  },
  deck: {
    usage: "deck <name> [--allow-stale] [--draft]   (DECK.pptx: the full analysis as a Google-Slides-friendly deck, from the rendered report's inputs)",
    run: (pos, flags) => {
      const { analysis, scope } = scopeOrDie(pos[0]);
      // The deck is a view of the final report: it needs a current render, built from the same
      // verified findings, so its numbers reconcile with ANALYSIS_REPORT.md.
      const mtime = (f: string) => { try { return statSync(join(analysis, f)).mtimeMs; } catch { return -1; } };
      const current = mtime("ANALYSIS_REPORT.md") >= 0 && mtime("ANALYSIS_REPORT.md") >= mtime("findings.json");
      if (!current && flags.draft !== true) {
        console.error(`refusing to build the deck: ANALYSIS_REPORT.md is missing or older than findings.json — run /code-review-harness:review-report ${scope.name} first (or --draft)`);
        return 1;
      }
      const fresh = checkFresh(analysis, scope.source);
      if (!fresh.fresh && flags["allow-stale"] !== true) {
        console.error(`refusing to build the deck: the source tree changed since assess (${fresh.hint}). Re-run assess, or pass --allow-stale for a STALE-marked deck.`);
        return 1;
      }
      const r = renderDeck(analysis, { pluginVersion: VERSION });
      console.log(`deck: ${r.slides} slide(s) · redactions ${r.redactions}`);
      console.log(`open: ${r.path}  (Google Slides: Drive → New → File upload, then Open with Google Slides; or Slides → File → Import slides)`);
      return 0;
    },
  },
  diff: {
    usage: "diff <name> --baseline <name|dir>",
    run: (pos, flags) => {
      const { analysis, scope } = scopeOrDie(pos[0]);
      const b = str(flags.baseline);
      if (!b) throw new Error("--baseline required");
      const d = baselineDiff(analysis, locate(b, scope.source));
      console.log(`new ${d.new.length} · no longer reported ${d.fixed.length} · persisting ${d.persisting.length}`);
      return 0;
    },
  },
  status: {
    usage: "status <name> [--json]",
    run: (pos, flags) => {
      const s = writeStatus(scopeOrDie(pos[0]).analysis);
      if (flags.json === true) { console.log(JSON.stringify(s, null, 2)); return 0; }
      const v = s.findings.by_verdict;
      console.log(`stage: ${s.next_stage ?? "complete"} · findings ${s.findings.total} (confirmed ${v.confirmed} · needs-human ${v["needs-human"]} · refuted ${v.refuted} · deferred ${v.deferred} · pending ${v.pending})`);
      for (const st of s.stages) console.log(`  ${st.status === "pending" ? "·" : "✓"} ${st.stage}${st.status === "skipped" ? " (skipped)" : ""}`);
      if (s.shards.lost.length) console.log(`lost shards (${s.shards.lost.length}): ${s.shards.lost.slice(0, 20).join(", ")}`);
      if (s.shards.deferred.length) console.log(`deferred shards (${s.shards.deferred.length}): ${s.shards.deferred.slice(0, 20).join(", ")}`);
      if (s.shards.oversized_modules.length) console.log(`oversized modules (split in topology.json): ${s.shards.oversized_modules.join(", ")}`);
      console.log(`next: ${s.next_command ?? "none — open ANALYSIS_REPORT.md / REPORT.html"}`);
      return 0;
    },
  },
  accept: {
    usage: "accept <name> <finding-id|fingerprint> --reason <text>   (human only: REVIEW_HUMAN=1)",
    run: (pos, flags) => {
      if (process.env.REVIEW_HUMAN !== "1") { console.error("accept is human-only: run /code-review-harness:review-accept yourself"); return 3; }
      if (typeof flags.raw === "string") { const w = flags.raw.trim().split(/\s+/); pos = [w[0] ?? "", w[1] ?? ""]; flags.reason = w.slice(2).join(" "); }
      const { analysis, scope } = scopeOrDie(pos[0]);
      const ref = pos[1]; const reason = str(flags.reason);
      if (!ref || !reason) throw new Error("usage: accept <name> <id|fingerprint> --reason <text>");
      const f = loadFindings(analysis).find((x) => x.id === ref || x.fingerprint === ref);
      if (!f) throw new Error(`no finding ${ref}`);
      const p = join(ensureReviewRoot(scope.source), "accepted-risk.json");
      const cur = readJson<{ accepted: { fingerprint: string }[] }>(p, { accepted: [] });
      cur.accepted = cur.accepted.filter((a) => a.fingerprint !== f.fingerprint);
      cur.accepted.push({ fingerprint: f.fingerprint, reason, by: process.env.USER ?? "human", at: nowIso(), id: f.id, title: f.title } as never);
      writeJson(p, cur);
      runMerge(analysis);
      console.log(`accepted ${f.id} (${f.fingerprint.slice(0, 15)}…): ${reason}`);
      return 0;
    },
  },
  hook: {
    usage: "hook <guard-edit|guard-bash|validate-write>   (Claude Code hook protocol: JSON on stdin)",
    run: async (pos) => {
      let payload: HookPayload = {};
      try { payload = JSON.parse(readFileSync(0, "utf8") || "{}") as HookPayload; } catch { return 0; }
      const which = pos[0];
      try {
        if (which === "guard-edit") printDecision(guardEdit(payload), "PreToolUse");
        else if (which === "guard-bash") printDecision(guardBash(payload), "PreToolUse");
        else if (which === "validate-write") printDecision(validateOnWrite(payload), "PostToolUse");
      } catch (e) {
        // Fail closed for guards during an active review; never break validation.
        if (which !== "validate-write" && (process.env.CODE_REVIEW_ACTIVE === "1")) printDecision({ deny: `guard error: ${(e as Error).message}` }, "PreToolUse");
      }
      return 0;
    },
  },
  watch: {
    usage: "watch <name> [--source path] [--out dir] [--max-minutes N]   (follow a running review-run: stage lines only; exits when it ends)",
    run: (pos, flags) => {
      const { analysis } = resolvePaths(pos[0] ?? "", str(flags.source) ?? ".", process.cwd(), str(flags.out));
      return watchRun(analysis, str(flags["max-minutes"]) ? Number(flags["max-minutes"]) : undefined);
    },
  },
  run: {
    usage: "run <name> --source <path> [--out dir] [--from stage] [--only stage] [--max-agents N (per batch)] [--allow-deferred] [--max-usd N] [--offline] [--dry-run] [--runner cmd] [--no-resume] [init flags...]",
    run: (pos, flags) => runDriver(pos[0] ?? "", flags, PLUGIN_ROOT),
  },
};

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const c = cmd ? COMMANDS[cmd] : undefined;
  if (!c) {
    console.error(`code-review-harness ${VERSION}\nusage: node scripts/review.ts <command>\n` + Object.values(COMMANDS).map((x) => `  ${x.usage}`).join("\n"));
    return cmd ? 2 : 0;
  }
  const { pos, flags } = parseArgs(rest);
  try { return await c.run(pos, flags); }
  catch (e) { console.error(`error: ${(e as Error).message}`); return 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
