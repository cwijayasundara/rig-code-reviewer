// Hook guards. Strict only while a review is active (CODE_REVIEW_ACTIVE=1 or a
// .code-review/active.json in cwd or any parent), so installing the plugin
// never blocks ordinary work. A seatbelt, not isolation: interpreters
// (`bash -c`, `python -c`, `node -e`, `$(…)`) are out of reach by design —
// run hostile repos in a sandbox (SECURITY.md).
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { validateArchitecture, validateTopology } from "./architecture.ts";
import { validateShard, validateVote } from "./findings.ts";
import { validateDecision, type Group } from "./consolidate.ts";
import { loadScope, reviewContext, within, type ReviewContext } from "./paths.ts";
import { readJson, REVIEW_DIR } from "./util.ts";

export interface HookPayload { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string; hook_event_name?: string }
export type Decision = { deny: string } | { block: string } | null;

/** Files only scripts may write (relative to the analysis dir). Matched case-insensitively (APFS/NTFS). */
const SCRIPT_OWNED = [
  /^(findings|coverage|evidence|status|usage|scope|diff)\.json$/i, /^revision\.json$/i, /^threat_model\.md$/i,
  /^(analysis_report|architecture|roadmap|review_scope)\.md$/i, /^report\.html$/i, /^deck\.pptx$/i, /^findings\.(sarif|jsonl)$/i,
  /^plan\//i, /^briefs\//i, /^scanners\//i, /^raw\/scanner\//i, /^diagrams\//i,
];
const ROOT_OWNED = /^(accepted-risk\.json|active\.json|\.gitignore)$/i;

/** Canonical path: resolve symlinks AND on-disk case on the deepest existing ancestor. */
function real(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur) && dirname(cur) !== cur) { tail.unshift(basename(cur)); cur = dirname(cur); }
  try { cur = realpathSync.native(cur); } catch { /* keep */ }
  return join(cur, ...tail);
}

const ci = process.platform === "darwin" || process.platform === "win32";
function inside(p: string, root: string): boolean { return ci ? within(p.toLowerCase(), root.toLowerCase()) : within(p, root); }

export function guardEdit(p: HookPayload): Decision {
  if (process.env.CODE_REVIEW_ALLOW_ALL === "1") return null;
  const cwd = p.cwd || process.cwd();
  const ctx = reviewContext(cwd);
  if (!ctx) return null;
  const raw = String(p.tool_input?.file_path ?? p.tool_input?.notebook_path ?? p.tool_input?.path ?? "");
  if (!raw) return null;
  const target = real(resolve(cwd, raw));
  const roots = ctx.roots.map(real);
  const root = roots.find((r) => inside(target, r));
  if (!root) return { deny: `code-review harness: the code under review is read-only while a review is active. Write only under ${roots.join(" or ")} (the path your brief names).` };
  const parts = relative(root, target).split(sep).join("/").split("/");
  if (parts.length === 1 && ROOT_OWNED.test(parts[0]!)) return { deny: `${parts[0]} is human/script-owned; use /code-review-harness:review-accept (human only) or the review.ts CLI.` };
  const inner = parts.length > 1 && basename(root) === REVIEW_DIR ? parts.slice(1).join("/") : parts.join("/");
  if (SCRIPT_OWNED.some((re) => re.test(inner))) return { deny: `${inner} is computed by scripts/review.ts (models advise, scripts decide) — do not write it by hand; run the matching review.ts command.` };
  return null;
}

// ---------- Bash seatbelt ----------

const GIT_MUTATING = new Set(["commit", "push", "pull", "fetch", "reset", "checkout", "switch", "restore", "clean", "stash", "rebase", "merge", "cherry-pick", "revert", "apply", "am", "rm", "mv", "add", "tag", "config", "gc", "prune", "worktree", "submodule", "init", "clone", "update-ref", "update-index", "notes", "replace", "filter-branch", "lfs", "remote", "bisect", "maintenance", "sparse-checkout", "repack", "format-patch"]);
const GIT_OPT_WITH_ARG = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
const INSTALLS = /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci|add|update|upgrade|remove|uninstall|link|exec|dlx|x)\b|\bnpx\b|\bpip3?\s+(?:install|uninstall|download)\b|\buv\s+(?:pip|add|sync|run|tool)\b|\bpoetry\s+(?:install|add|update|lock|run)\b|\bgo\s+(?:get|install|run|generate|mod\s+(?:tidy|download|vendor))\b|\bcargo\s+(?:install|update|add|fetch|run|build)\b|\b(?:gem|bundle)\s+install\b|\bbrew\s+install\b|\bapt(?:-get)?\s+install\b|\bcomposer\s+(?:install|update|require)\b|\bdotnet\s+(?:add|restore|run|build)\b|\bmvn\s+(?:install|package|compile)\b|\bgradlew?\s/;
const PIPE_SHELL = /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/;
const WRITERS: Record<string, "all" | "last" | "mv"> = { rm: "all", rmdir: "all", touch: "all", mkdir: "all", chmod: "all", chown: "all", truncate: "all", tee: "all", unlink: "all", shred: "all", cp: "last", ln: "last", install: "last", rsync: "last", mv: "mv" };
const WRAPPERS = new Set(["env", "command", "nice", "nohup", "time", "xargs", "sudo", "exec", "timeout", "stdbuf", "ionice", "builtin"]);
const WRITE_FLAGS = /^(?:--output(?:=|$)|--pre(?:=|$)|--open-files-in-pager|-O$|--output-directory)/;

/** Split on ; && || | & newlines outside quotes; redirection operators become their own tokens. */
export function segments(cmd: string): string[][] {
  const segs: string[][] = [];
  let cur: string[] = [], tok = "", q: string | null = null, has = false;
  const push = () => { if (has) cur.push(tok); tok = ""; has = false; };
  const end = () => { push(); if (cur.length) segs.push(cur); cur = []; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (q) { if (c === q) q = null; else if (c === "\\" && q === '"' && i + 1 < cmd.length) tok += cmd[++i]; else tok += c; continue; }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === "\\" && i + 1 < cmd.length) { tok += cmd[++i]; has = true; continue; }
    if (c === ">" || c === "<") {
      push();
      let op = c;
      while (i + 1 < cmd.length && /[<>|&]/.test(cmd[i + 1]!) && op.length < 3) {
        if (cmd[i + 1] === "&" && op === "&") break;
        op += cmd[++i];
      }
      cur.push(op);
      continue;
    }
    if (c === ";" || c === "\n" || c === "|" || c === "&") { if ((c === "&" && cmd[i + 1] === "&") || (c === "|" && cmd[i + 1] === "|")) i++; end(); continue; }
    if (/\s/.test(c)) { push(); continue; }
    tok += c; has = true;
  }
  end();
  return segs;
}

/** Drop env assignments and wrapper commands (env, xargs, sudo, timeout…) to find the real command. */
function unwrap(words: string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue; }
    const b = basename(w);
    if (WRAPPERS.has(b)) {
      i++;
      while (i < words.length && (words[i]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || (b === "timeout" && /^\d/.test(words[i]!)))) i++;
      continue;
    }
    break;
  }
  return words.slice(i);
}

function gitSubcommand(args: string[]): { sub: string | undefined; configOverride: boolean } {
  let configOverride = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-c" || a.startsWith("--config-env")) configOverride = true;
    if (GIT_OPT_WITH_ARG.has(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    return { sub: a, configOverride };
  }
  return { sub: undefined, configOverride };
}

export function guardBash(p: HookPayload): Decision {
  const cmd = String(p.tool_input?.command ?? "");
  // Normalise quoting/escapes so REVIEW_HUM''AN or REVIEW_\HUMAN cannot slip through.
  const flat = cmd.replace(/["'\\]/g, "");
  if (/REVIEW_?HUMAN|HUMAN=/.test(flat) || /review\.ts\b[^;&|]*\saccept\b/.test(flat)) {
    return { deny: "accepting risk is human-only: only /code-review-harness:review-accept (run by a person) may record it; the model may not run `accept` or set REVIEW_HUMAN." };
  }
  if (process.env.CODE_REVIEW_ALLOW_ALL === "1") return null;
  const cwd = p.cwd || process.cwd();
  const ctx = reviewContext(cwd);
  if (!ctx) return null;
  const why = (r: string) => ({ deny: `code-review harness (read-only review): ${r}. The source tree may not be modified; scratch work goes under ${ctx.roots[0]} or a temp dir outside the source.` });
  if (INSTALLS.test(flat)) return why("package installs/builds write into the tree and run third-party code; record 'not run' in PREFLIGHT.md instead");
  if (PIPE_SHELL.test(flat)) return why("piping a download into a shell is not allowed");
  return checkSegments(cmd, cwd, ctx, why);
}

function checkSegments(cmd: string, cwd: string, ctx: ReviewContext, why: (r: string) => { deny: string }): Decision {
  const src = real(ctx.source);
  const roots = ctx.roots.map(real);
  let here = cwd;
  const bad = (arg: string) => {
    if (!arg || arg.startsWith("-") || /^\/dev\/(null|stdout|stderr|tty|fd\/)/.test(arg)) return false;
    const t = real(resolve(here, arg.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")));
    return inside(t, src) && !roots.some((r) => inside(t, r));
  };
  for (const seg of segments(cmd)) {
    // Every output redirection (>, >>, >|, &>, >&, <>) targeting the source tree.
    for (let i = 0; i < seg.length; i++) {
      const op = seg[i]!;
      if (/^[<>&|]+$/.test(op) && op.includes(">") || op === "<>") {
        const target = seg[i + 1] ?? "";
        if (/^(\d+|-)$/.test(target) && op.endsWith("&")) continue; // 2>&1
        if (bad(target)) return why(`redirect into the source tree (${target})`);
      }
    }
    const words = seg.filter((w, i) => !/^[<>&|]+$/.test(w) && !/^[<>&|]+$/.test(seg[i - 1] ?? ""));
    const args = unwrap(words);
    const head = basename(args[0] ?? "");
    if (!head) continue;
    if (head === "cd") { if (args[1]) here = resolve(here, args[1]); continue; }
    if (args.some((a) => WRITE_FLAGS.test(a)) && ["git", "rg", "grep", "diff"].includes(head)) return why(`${head} with an output/pre-processor flag can write files or run commands`);
    if (head === "git") {
      const g = gitSubcommand(args);
      if (g.configOverride) return why("git -c / --config-env can run arbitrary commands via config (core.pager, …)");
      if (g.sub && (GIT_MUTATING.has(g.sub) || (g.sub === "branch" && args.some((a) => /^-[dDmMcC]$|^--(delete|move|copy)$/.test(a))))) return why(`mutating git (${g.sub}); read-only git only: log, show, blame, diff, ls-files, rev-parse, grep, shortlog`);
      continue;
    }
    if (head === "find" && args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(a))) return why("find -delete/-exec is not allowed; use find to list, then Read");
    if (["sed", "perl", "ruby"].includes(head) && args.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith("--in-place"))) return why("in-place edits are not allowed");
    if (head === "dd") { const of = args.find((a) => a.startsWith("of=")); if (of && bad(of.slice(3))) return why("dd into the source tree"); continue; }
    const mode = WRITERS[head];
    if (!mode) continue;
    const tIdx = args.findIndex((a) => a === "-t" || a.startsWith("--target-directory"));
    if (tIdx > 0) {
      const t = args[tIdx]!.includes("=") ? args[tIdx]!.split("=")[1]! : args[tIdx + 1] ?? "";
      if (bad(t)) return why(`${head} -t would write into ${t} inside the source tree`);
    }
    const operands = args.slice(1).filter((a, i, all) => !a.startsWith("-") && all[i - 1] !== "-t");
    const checked = mode === "last" && tIdx < 0 ? operands.slice(-1) : mode === "last" ? [] : operands;
    const hit = checked.find(bad);
    if (hit) return why(`${head} would modify ${hit} inside the source tree`);
  }
  return null;
}

// ---------- validate on write ----------

export function validateOnWrite(p: HookPayload): Decision {
  const cwd = p.cwd || process.cwd();
  const raw = String(p.tool_input?.file_path ?? "");
  if (!raw.endsWith(".json")) return null;
  const target = resolve(cwd, raw);
  const m = target.match(/^(.*)\/(raw\/(?:deep|security)\/[^/]+\.json|votes\/[^/]+\.json|consolidate\/[^/]+\.json|topology\.json|architecture\.json)$/);
  if (!m) return null;
  const analysis = m[1]!;
  const scope = loadScope(analysis);
  if (!scope) return null;
  const obj = readJson<unknown>(target, undefined);
  const rel = m[2]!;
  let errors = obj === undefined ? ["invalid JSON"]
    : rel.startsWith("raw/") ? validateShard(obj, scope.source)
    : rel.startsWith("votes/") ? validateVote(obj, basename(rel))
    : rel.startsWith("consolidate/") ? validateDecision(obj, planGroup(analysis, basename(rel, ".json")))
    : rel === "topology.json" ? validateTopology(obj)
    : validateArchitecture(obj);
  if (!errors.length) return null;
  if (errors.length > 25) errors = [...errors.slice(0, 25), `(+${errors.length - 25} more)`];
  return { block: `${rel} failed validation — fix and rewrite it:\n- ${errors.join("\n- ")}` };
}

/** The group a consolidation decision answers, from the plan the script wrote. */
function planGroup(analysis: string, key: string): Group | undefined {
  const plan = readJson<{ run?: { key: string; input: { file?: string; members?: string[] } }[] }>(join(analysis, "plan", "consolidate.json"), {});
  const t = (plan.run ?? []).find((x) => x.key === key);
  return t ? { key, file: t.input.file ?? "", members: t.input.members ?? [] } : undefined;
}
