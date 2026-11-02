// Where review artefacts live. Never $HOME, never the plugin root.
//   analysis = <source>/.code-review/<name>     (default; .gitignore "*")
//            | --out <dir>                       (explicit override, exported as CODE_REVIEW_OUT)
import { mkdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Scope } from "./types.ts";
import { exists, nowIso, readJson, REVIEW_DIR, writeJson, writeText } from "./util.ts";

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function resolvePaths(name: string, source: string, cwd = process.cwd(), out?: string): { source: string; analysis: string } {
  if (!NAME_RE.test(name || "")) throw new Error(`invalid review name ${JSON.stringify(name)}: letters, digits, '-' and '_' only`);
  const src = resolve(cwd, expandHome(source));
  const analysis = out ? resolve(cwd, expandHome(out)) : join(src, REVIEW_DIR, name);
  return { source: src, analysis };
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(process.env.HOME ?? "", p.slice(1)) : p;
}

/** Analysis dir for a review name, from the environment or the cwd. */
export function locate(nameOrDir: string, cwd = process.cwd()): string {
  if (isAbsolute(nameOrDir) || nameOrDir.includes("/")) return resolve(cwd, nameOrDir);
  if (process.env.CODE_REVIEW_OUT) return resolve(process.env.CODE_REVIEW_OUT);
  return join(resolve(cwd), REVIEW_DIR, nameOrDir);
}

export function loadScope(analysis: string): Scope | null {
  const s = readJson<Scope | null>(join(analysis, "scope.json"), null);
  return s && typeof s === "object" && typeof s.source === "string" ? s : null;
}

/** Create <source>/.code-review/ with a .gitignore that ignores everything. */
export function ensureReviewRoot(source: string): string {
  const root = join(source, REVIEW_DIR);
  mkdirSync(root, { recursive: true });
  // Everything here is generated, except the model config a team may want to commit.
  if (!exists(join(root, ".gitignore"))) writeText(join(root, ".gitignore"), "*\n!config.json\n");
  return root;
}

export function activate(source: string, name: string, analysis: string): void {
  writeJson(join(ensureReviewRoot(source), "active.json"), { name, analysis_dir: analysis, since: nowIso() });
}

export function deactivate(source: string): void {
  rmSync(join(source, REVIEW_DIR, "active.json"), { force: true });
}

export interface ReviewContext { source: string; roots: string[]; analysis?: string }

/**
 * The active review governing `cwd`, if any (guard strict mode). Walks up from
 * cwd so a `cd` into a subdirectory cannot switch the guard off, and takes the
 * source root from the review, never from cwd.
 */
export function reviewContext(cwd: string): ReviewContext | null {
  if (process.env.CODE_REVIEW_ACTIVE === "1") {
    const out = process.env.CODE_REVIEW_OUT ? resolve(process.env.CODE_REVIEW_OUT) : undefined;
    const scope = out ? loadScope(out) : null;
    const source = scope?.source ?? resolve(cwd);
    return { source, analysis: out, roots: [...new Set([join(source, REVIEW_DIR), ...(out ? [out] : [])])] };
  }
  for (let d = resolve(cwd); ; d = dirname(d)) {
    const act = readJson<{ name?: string; analysis_dir?: string } | null>(join(d, REVIEW_DIR, "active.json"), null);
    if (act) {
      const roots = [join(d, REVIEW_DIR)];
      if (act.analysis_dir) roots.push(resolve(act.analysis_dir));
      return { source: d, analysis: act.analysis_dir, roots: [...new Set(roots)] };
    }
    if (dirname(d) === d) return null;
  }
}

/** Relative paths of review artefacts that live inside the source but outside .code-review (--out). */
export function artefactExcludes(scope: { source: string; analysis_dir: string }): string[] {
  const rel = relative(scope.source, scope.analysis_dir);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(REVIEW_DIR) ? [rel.split("\\").join("/")] : [];
}

export function within(p: string, root: string): boolean {
  const a = resolve(p), r = resolve(root);
  return a === r || a.startsWith(r.endsWith("/") ? r : r + "/");
}
