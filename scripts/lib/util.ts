// Small, dependency-free helpers shared by every command.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export const REVIEW_DIR = ".code-review";

/** Directories that are never part of the code under review. */
export const SKIP_DIRS = new Set([
  ".git", REVIEW_DIR, "node_modules", "__pycache__", ".venv", "venv", ".tox", "dist", "build",
  "target", ".next", ".nuxt", "out", "coverage", ".gradle", ".idea", ".vscode", "vendor",
  "bower_components", ".mypy_cache", ".pytest_cache", ".terraform",
]);

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function readJson<T>(p: string, fallback: T): T {
  try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return fallback; }
}

export function readText(p: string): string | null {
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

/** Atomic write: a reader (dashboard, hook) never sees a half-written file. */
export function writeText(p: string, s: string | Uint8Array): void {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, s);
  renameSync(tmp, p);
}

export function writeJson(p: string, v: unknown): void {
  writeText(p, JSON.stringify(v, null, 2) + "\n");
}

/** Read-only git with a fixed environment (no user config, no prompts). */
export function git(dir: string, args: string[], timeoutMs = 30_000): string | null {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8", timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
  } catch { return null; }
}

export function isGitRepo(dir: string): boolean {
  return git(dir, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
}

/** Glob subset: `**`, `*`, `?`. Matched against a POSIX relative path. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function excluded(rel: string, patterns: RegExp[]): boolean {
  const parts = rel.split("/");
  if (parts.slice(0, -1).some((p) => SKIP_DIRS.has(p))) return true;
  return patterns.some((re) => re.test(rel));
}

/**
 * Files under review as POSIX relative paths, sorted. Uses `git ls-files`
 * (tracked + untracked, respecting .gitignore) when possible, else a walk.
 * Symlinks are never followed; the review dir and SKIP_DIRS are always out.
 */
export function listFiles(src: string, exclude: string[] = []): { files: string[]; method: string } {
  const pats = exclude.map(globToRegExp);
  let files: string[] | null = null;
  let method = "walk";
  if (isGitRepo(src)) {
    const out = git(src, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    if (out !== null) {
      files = out.split("\0").filter(Boolean).filter((f) => {
        try { return statSync(join(src, f)).isFile(); } catch { return false; }
      });
      method = "git ls-files";
    }
  }
  if (!files) {
    files = [];
    const walk = (d: string) => {
      let ents;
      try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.isSymbolicLink()) continue;
        const p = join(d, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); }
        else if (e.isFile()) files!.push(relative(src, p).split(sep).join("/"));
      }
    };
    walk(src);
  }
  return { files: [...new Set(files)].filter((f) => !excluded(f, pats)).sort(), method };
}

export function exists(p: string): boolean { return existsSync(p); }

export function nowIso(): string { return new Date().toISOString(); }

/** Parse `--flag value` / `--flag=value` / `--bool` arguments. */
export function parseArgs(argv: string[]): { pos: string[]; flags: Record<string, string | true> } {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) flags[a.slice(2)] = argv[++i]!;
      else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

export function str(v: string | true | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}
