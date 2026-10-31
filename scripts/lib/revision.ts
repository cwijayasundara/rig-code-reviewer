// Tie a report to the exact tree it describes. The fingerprint is recorded at
// assess; report rendering refuses (or marks STALE) when the tree has moved.
import { statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isGitRepo, git, listFiles, nowIso, readJson, sha256, writeJson } from "./util.ts";

const EXCL = ["--", ".", ":(exclude).code-review"];

/** Review artefacts written inside the source via --out (CODE_REVIEW_OUT) never change the fingerprint. */
function excl(source: string): string[] {
  const out = process.env.CODE_REVIEW_OUT;
  const rel = out ? relative(source, resolve(out)) : "";
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? [...EXCL, `:(exclude)${rel}`] : EXCL;
}

export function treeFingerprint(source: string): { commit: string | null; dirty: boolean | null; tree: string; method: string; changed?: string[] } {
  if (isGitRepo(source)) {
    const commit = git(source, ["rev-parse", "HEAD"])?.trim() || null;
    const status = git(source, ["status", "--porcelain=v1", "-z", "--untracked-files=all", ...excl(source)]) ?? "";
    const diff = git(source, ["diff", "HEAD", "--binary", ...excl(source)]) ?? "";
    // Untracked files: content changes are invisible to `status`, so hash size+mtime.
    const untracked = status.split("\0").filter((l) => l.startsWith("?? ")).map((l) => l.slice(3)).sort()
      .map((f) => { try { const s = statSync(join(source, f)); return `${f}:${s.size}:${s.mtimeMs}`; } catch { return f; } });
    const changed = status.split("\0").filter(Boolean).map((l) => l.slice(3)).sort().slice(0, 200);
    return { commit, dirty: status.length > 0, tree: `git:${sha256([commit, status, diff, ...untracked].join("\n"))}`, method: "git", changed };
  }
  const { files } = listFiles(source);
  const parts = files.map((f) => { try { const s = statSync(join(source, f)); return `${f}:${s.size}:${s.mtimeMs}`; } catch { return f; } });
  return { commit: null, dirty: null, tree: `fs:${sha256(parts.join("\n"))}`, method: "filesystem size+mtime" };
}

export interface Revision { commit: string | null; dirty: boolean | null; tree: string; method: string; scanned_at: string; target: string; stale?: boolean; counts?: Record<string, number> }

export function stampRevision(analysis: string, source: string): Revision {
  const rev: Revision = { ...treeFingerprint(source), scanned_at: nowIso(), target: source };
  writeJson(join(analysis, "REVISION.json"), rev);
  return rev;
}

export function checkFresh(analysis: string, source: string): { fresh: boolean; recorded: string | null; current: string; hint: string } {
  const rev = readJson<(Revision & { changed?: string[] }) | null>(join(analysis, "REVISION.json"), null);
  const now = treeFingerprint(source);
  const before = new Set(rev?.changed ?? []);
  const after = new Set(now.changed ?? []);
  const moved = [...new Set([...before, ...after])].filter((p) => before.has(p) !== after.has(p));
  const commitMoved = rev && rev.commit !== now.commit ? `HEAD moved ${String(rev.commit).slice(0, 10)} -> ${String(now.commit).slice(0, 10)}` : "";
  const hint = [commitMoved, moved.length ? `paths: ${moved.slice(0, 10).join(", ")}${moved.length > 10 ? " …" : ""}` : "modified tracked/untracked content"].filter(Boolean).join("; ");
  return { fresh: !!rev && rev.tree === now.tree, recorded: rev?.tree ?? null, current: now.tree, hint };
}

/** Record final counts + staleness on the stamp (counts computed by the caller from findings.json). */
export function finaliseRevision(analysis: string, source: string, counts: Record<string, number>): Revision | null {
  const rev = readJson<Revision | null>(join(analysis, "REVISION.json"), null);
  if (!rev) return null;
  const out = { ...rev, counts, stale: !checkFresh(analysis, source).fresh };
  writeJson(join(analysis, "REVISION.json"), out);
  return out;
}
