// Test helpers: temp source trees, review dirs, and a CLI runner.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RawFinding } from "../scripts/lib/types.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = join(ROOT, "scripts", "review.ts");

export function tree(files: Record<string, string>, prefix = "crh-src-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(d, rel)), { recursive: true });
    writeFileSync(join(d, rel), body);
  }
  return d;
}

export function put(dir: string, rel: string, v: unknown): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), typeof v === "string" ? v : JSON.stringify(v, null, 2));
}

export function cli(args: string[], opts: { cwd?: string; env?: Record<string, string>; input?: string } = {}) {
  const env: Record<string, string | undefined> = { ...process.env, ...opts.env };
  for (const k of ["CODE_REVIEW_ACTIVE", "CODE_REVIEW_OUT", "CODE_REVIEW_ALLOW_ALL", "REVIEW_HUMAN"]) if (!(opts.env && k in opts.env)) delete env[k];
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { cwd: opts.cwd, env, encoding: "utf8", input: opts.input });
  return { code: r.status ?? 1, out: r.stdout, err: r.stderr };
}

export function git(dir: string, ...args: string[]): void {
  spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { stdio: "ignore" });
}

export function rf(over: Partial<RawFinding> = {}): RawFinding {
  return {
    dimension: "quality", severity: "Medium", confidence: "high", file: "src/app.py", line: 2,
    title: "Swallowed exception", evidence: "src/app.py:2 except: pass", impact: "errors vanish",
    recommendation: "log and re-raise", effort: "S", ...over,
  };
}

export const APP = ["import os", "def run(q):", "    try:", "        return db.execute('SELECT * FROM t WHERE id=' + q)", "    except Exception:", "        pass", ""].join("\n");

/** Fake credential-shaped strings, assembled at runtime so no key literal lives in the source tree. */
export const FAKE_AWS_KEY = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
export const FAKE_AWS_KEY_2 = ["AK", "IA", "IOSFODNN7EXAMPLQ"].join("");
