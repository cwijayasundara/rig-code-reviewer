// Deterministic evidence pack. No model, no network, no timestamps:
// the same tree yields byte-identical JSON. Every figure names the method
// that produced it (`tool`), so a report can never claim a tool it did not run.
import { join } from "node:path";
import { git, isGitRepo, listFiles, readText } from "./util.ts";

export interface FileStat { file: string; lines: number }
export interface Fn { file: string; name: string; line: number; end_line: number; lines: number; complexity: number }
export interface Hotspot { file: string; churn: number; complexity: number; score: number }
export interface Ownership { dir: string; commits: number; authors: number; top_author_share: number; bus_factor: number }
export type DirKind = "source" | "test" | "docs" | "vendor" | "generated" | "config" | "ci" | "scripts" | "other";

export interface Evidence {
  tool: { files: string; lines: string; functions: string; churn: string };
  total_files: number;
  total_code_lines: number;
  source_files: number;
  test_files: number;
  test_file_list: string[];
  languages: Record<string, { files: number; lines: number }>;
  manifests: string[];
  largest_files: FileStat[];
  god_class_candidates: FileStat[];
  long_method_candidates: Fn[];
  functions_analysed: number;
  complexity_top: { file: string; complexity: number; max_function: number; functions: number }[];
  churn: { available: boolean; months: number; commits: number; files_changed: number; top: { file: string; commits: number; authors: number }[] };
  hotspots: Hotspot[];
  hotspot_formula: string;
  ownership: Ownership[];
  top_level_dirs: { dir: string; files: number; sloc: number; kind: DirKind }[];
  thresholds: { god_file_lines: number; long_method_lines: number; churn_months: number };
  files: string[];
  /** SLOC per code file (sorted keys) — used by suggest-modules and coverage. */
  file_sloc: Record<string, number>;
}

// extension -> [language, line-comment prefixes, block comment [open, close] | null]
type LangDef = [string, string[], [string, string] | null];
const C: [string, string] = ["/*", "*/"];
const LANGS: Record<string, LangDef> = {
  ".py": ["Python", ["#"], null], ".pyi": ["Python", ["#"], null],
  ".js": ["JavaScript", ["//"], C], ".mjs": ["JavaScript", ["//"], C], ".cjs": ["JavaScript", ["//"], C], ".jsx": ["JavaScript", ["//"], C],
  ".ts": ["TypeScript", ["//"], C], ".tsx": ["TypeScript", ["//"], C], ".mts": ["TypeScript", ["//"], C], ".cts": ["TypeScript", ["//"], C],
  ".java": ["Java", ["//"], C], ".kt": ["Kotlin", ["//"], C], ".kts": ["Kotlin", ["//"], C], ".scala": ["Scala", ["//"], C],
  ".groovy": ["Groovy", ["//"], C], ".go": ["Go", ["//"], C], ".rs": ["Rust", ["//"], C], ".swift": ["Swift", ["//"], C],
  ".c": ["C", ["//"], C], ".h": ["C", ["//"], C], ".cc": ["C++", ["//"], C], ".cpp": ["C++", ["//"], C], ".cxx": ["C++", ["//"], C],
  ".hpp": ["C++", ["//"], C], ".hh": ["C++", ["//"], C], ".cs": ["C#", ["//"], C], ".fs": ["F#", ["//"], ["(*", "*)"]],
  ".php": ["PHP", ["//", "#"], C], ".rb": ["Ruby", ["#"], ["=begin", "=end"]], ".pl": ["Perl", ["#"], null],
  ".lua": ["Lua", ["--"], null], ".r": ["R", ["#"], null], ".dart": ["Dart", ["//"], C], ".ex": ["Elixir", ["#"], null],
  ".exs": ["Elixir", ["#"], null], ".erl": ["Erlang", ["%"], null], ".clj": ["Clojure", [";"], null], ".hs": ["Haskell", ["--"], ["{-", "-}"]],
  ".sql": ["SQL", ["--"], C], ".sh": ["Shell", ["#"], null], ".bash": ["Shell", ["#"], null], ".zsh": ["Shell", ["#"], null],
  ".ps1": ["PowerShell", ["#"], ["<#", "#>"]], ".tf": ["Terraform", ["#", "//"], C], ".hcl": ["Terraform", ["#", "//"], C],
  ".yaml": ["YAML (config)", ["#"], null], ".yml": ["YAML (config)", ["#"], null], ".toml": ["TOML (config)", ["#"], null],
  ".vue": ["Vue", ["//"], C], ".svelte": ["Svelte", ["//"], C], ".cob": ["COBOL", ["*>"], null], ".cbl": ["COBOL", ["*>"], null],
  ".html": ["HTML", [], ["<!--", "-->"]], ".css": ["CSS", [], C], ".scss": ["SCSS", ["//"], C],
};
const BRACE_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".java", ".kt", ".kts", ".scala", ".groovy",
  ".go", ".rs", ".swift", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".cs", ".php", ".dart"]);
const PY_EXT = new Set([".py", ".pyi"]);

const MANIFEST_NAMES = new Set(["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json",
  "Pipfile", "Pipfile.lock", "poetry.lock", "pyproject.toml", "setup.py", "setup.cfg", "uv.lock", "go.mod", "go.sum",
  "Cargo.toml", "Cargo.lock", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "gradle.lockfile",
  "Gemfile", "Gemfile.lock", "composer.json", "composer.lock", "packages.config", "Directory.Packages.props",
  "mix.exs", "mix.lock", "pubspec.yaml", "pubspec.lock", "Package.swift", "Package.resolved"]);

function ext(f: string): string {
  const b = f.slice(f.lastIndexOf("/") + 1);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i).toLowerCase() : "";
}
const base = (f: string) => f.slice(f.lastIndexOf("/") + 1);

export function isManifest(f: string): boolean {
  const b = base(f);
  return MANIFEST_NAMES.has(b) || /^requirements.*\.txt$/i.test(b) || /\.csproj$|\.fsproj$|\.vbproj$/i.test(b);
}

const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs", "testdata", "test_data", "e2e", "__mocks__", "fixtures"]);
const TEST_NAME = [/^test_.+\.py$/, /.+_test\.py$/, /.+_test\.go$/, /.+\.(test|spec)\.[cm]?[jt]sx?$/, /.+Tests?\.java$/,
  /.+Tests?\.cs$/, /.+_spec\.rb$/, /.+_test\.rb$/, /.+Tests?\.kt$/, /.+Spec\.scala$/, /.+_test\.exs$/, /.+Test\.php$/, /^conftest\.py$/];

/** Test file by path segment or naming convention — never by substring (latest.py is not a test). */
export function isTestFile(f: string): boolean {
  const parts = f.split("/");
  if (parts.slice(0, -1).some((p) => TEST_DIRS.has(p.toLowerCase()))) return true;
  const b = parts[parts.length - 1]!;
  return TEST_NAME.some((re) => re.test(b));
}

/** Source lines: non-blank and not comment-only (block comments best-effort). */
export function sloc(text: string, def: LangDef | undefined): number {
  const [, line, block] = def ?? ["", [], null];
  let n = 0, inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t) continue;
    if (inBlock) { if (block && t.includes(block[1])) { inBlock = false; const rest = t.slice(t.indexOf(block[1]) + block[1].length).trim(); if (rest) n++; } continue; }
    if (line.some((p) => t.startsWith(p))) continue;
    if (block && t.startsWith(block[0])) { if (!t.includes(block[1], block[0].length)) inBlock = true; continue; }
    n++;
  }
  return n;
}

const DECISION = /\b(?:if|elif|for|foreach|while|case|catch|except|and|or)\b|&&|\|\||\?(?![.?:])/g;
function complexityOf(lines: string[]): number {
  let c = 1;
  for (const l of lines) {
    const code = l.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\/\/.*$|#.*$/, "");
    c += (code.match(DECISION) ?? []).length;
  }
  return c;
}

/** Python functions by indentation. */
export function pythonFunctions(file: string, text: string): Fn[] {
  const lines = text.split(/\r?\n/);
  const out: Fn[] = [];
  const indent = (s: string) => s.length - s.trimStart().length;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(lines[i]!);
    if (!m) continue;
    const ind = m[1]!.length;
    let end = i, j = i + 1;
    // skip a multi-line signature
    while (j < lines.length && !/:\s*(#.*)?$/.test(lines[j - 1]!) && j - i < 30) j++;
    for (; j < lines.length; j++) {
      const l = lines[j]!;
      if (!l.trim() || l.trim().startsWith("#")) continue;
      if (indent(l) <= ind) break;
      end = j;
    }
    const body = lines.slice(i, end + 1);
    out.push({ file, name: m[2]!, line: i + 1, end_line: end + 1, lines: end - i + 1, complexity: complexityOf(body) });
  }
  return out;
}

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "else", "do", "try", "new", "sizeof", "typeof", "when", "match", "using", "lock", "foreach", "synchronized", "with"]);
const HEADER = [
  /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/, // js function
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/, // arrow
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[(<[]/, // go
  /\bfn\s+([A-Za-z_]\w*)\s*[<(]/, // rust
  /\bfun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)\s*\(/, // kotlin
  /\bdef\s+([A-Za-z_]\w*)\s*[[(:=]/, // scala
  /^\s*(?:(?:public|private|protected|internal|static|final|abstract|async|override|virtual|export|default|synchronized|inline|extern|const|unsafe|open|suspend)\s+)*[\w<>[\],.?*&\s]+?\s+\**([A-Za-z_]\w*)\s*\([^;]*$/, // c-like method
  /^\s*(?:(?:public|private|protected|static|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^;{]*\)\s*(?::\s*[^{]+)?\{?\s*$/, // js/ts class method
];

/** Brace-language functions: header regex + brace matching that skips strings/comments. */
export function braceFunctions(file: string, text: string): Fn[] {
  const lines = text.split(/\r?\n/);
  const out: Fn[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    let name: string | null = null;
    if (!/^\s*(\/\/|\*|\/\*|#)/.test(l) && !/^\s*(?:return|new|throw|else|await|yield|case|if|while|for|switch|catch|do)\b/.test(l)) {
      for (const re of HEADER) { const m = re.exec(l); if (m && m[1] && !KEYWORDS.has(m[1])) { name = m[1]; break; } }
    }
    if (!name) { i++; continue; }
    // find opening brace within the next few lines
    let depth = 0, opened = false, end = -1, inBlockComment = false;
    for (let j = i; j < lines.length && (opened || j - i < 6); j++) {
      const s = lines[j]!;
      let q: string | null = null;
      for (let k = 0; k < s.length; k++) {
        const ch = s[k]!, nx = s[k + 1];
        if (inBlockComment) { if (ch === "*" && nx === "/") { inBlockComment = false; k++; } continue; }
        if (q) { if (ch === "\\") k++; else if (ch === q) q = null; continue; }
        if (ch === "/" && nx === "/") break;
        if (ch === "/" && nx === "*") { inBlockComment = true; k++; continue; }
        if (ch === '"' || ch === "'" || ch === "`") { q = ch; continue; }
        if (ch === ";" && !opened && depth === 0) { j = lines.length; break; } // declaration only
        if (ch === "{") { depth++; opened = true; }
        else if (ch === "}") { depth--; if (opened && depth === 0) { end = j; break; } }
      }
      if (end >= 0) break;
    }
    if (end < 0) { i++; continue; }
    const body = lines.slice(i, end + 1);
    out.push({ file, name, line: i + 1, end_line: end + 1, lines: end - i + 1, complexity: complexityOf(body) });
    // continue scanning inside the body so nested/class methods are found too
    i++;
  }
  // Drop outer wrappers that merely contain the same start line twice; keep innermost unique (file,line).
  const seen = new Set<number>();
  return out.filter((f) => (seen.has(f.line) ? false : (seen.add(f.line), true)));
}

const DOCS = new Set(["docs", "doc", "documentation", "site", "website", "examples", "example"]);
const CI = new Set([".github", ".gitlab", ".circleci", ".buildkite", "ci", ".azure-pipelines", ".husky"]);
const VENDOR = new Set(["vendor", "third_party", "thirdparty", "external", "deps", "node_modules"]);
const GENERATED = new Set(["generated", "gen", "__generated__", "proto_gen", "dist", "build"]);
const CONFIG = new Set(["config", "configs", "conf", "deploy", "deployment", "infra", "helm", "k8s", "terraform", ".devcontainer"]);
const SCRIPTS = new Set(["scripts", "script", "bin", "tools", "tooling"]);

export function dirKind(dir: string, files: string[]): DirKind {
  const d = dir.toLowerCase();
  if (CI.has(d)) return "ci";
  if (DOCS.has(d)) return "docs";
  if (VENDOR.has(d)) return "vendor";
  if (GENERATED.has(d)) return "generated";
  if (TEST_DIRS.has(d)) return "test";
  if (CONFIG.has(d)) return "config";
  if (SCRIPTS.has(d)) return "scripts";
  if (files.length && files.every((f) => isTestFile(f))) return "test";
  if (files.length && files.every((f) => /\.(md|rst|txt|adoc)$/i.test(f))) return "docs";
  return files.some((f) => LANGS[ext(f)] && !LANGS[ext(f)]![0].includes("config")) ? "source" : "other";
}

function topDir(f: string): string { const i = f.indexOf("/"); return i < 0 ? "." : f.slice(0, i); }

interface Churn { available: boolean; commits: number; byFile: Map<string, { commits: number; authors: Map<string, number> }> }

export function readChurn(src: string, months: number, known: Set<string>): Churn {
  const byFile = new Map<string, { commits: number; authors: Map<string, number> }>();
  if (!isGitRepo(src)) return { available: false, commits: 0, byFile };
  const out = git(src, ["log", `--since=${months}.months`, "--no-merges", "--no-renames", "--numstat", "--format=@@%an"], 120_000);
  if (out === null) return { available: false, commits: 0, byFile };
  let author = "", commits = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("@@")) { author = line.slice(2).trim() || "?"; commits++; continue; }
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    const f = m[3]!;
    if (!known.has(f)) continue;
    const e = byFile.get(f) ?? { commits: 0, authors: new Map() };
    e.commits++; e.authors.set(author, (e.authors.get(author) ?? 0) + 1);
    byFile.set(f, e);
  }
  return { available: true, commits, byFile };
}

const byName = <T extends { file: string }>(a: T, b: T) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);

export function collectEvidence(src: string, opts: { exclude?: string[]; godFileLines?: number; longMethodLines?: number; churnMonths?: number } = {}): Evidence {
  const godN = opts.godFileLines ?? 500, longN = opts.longMethodLines ?? 50, months = opts.churnMonths ?? 12;
  const { files, method } = listFiles(src, opts.exclude ?? []);
  const languages: Record<string, { files: number; lines: number }> = {};
  const perFile: FileStat[] = [];
  const fns: Fn[] = [];
  const tests: string[] = [];
  const manifests: string[] = [];
  const slocOf = new Map<string, number>();
  for (const f of files) {
    if (isManifest(f)) manifests.push(f);
    const test = isTestFile(f);
    if (test) tests.push(f);
    const e = ext(f), def = LANGS[e];
    if (!def) continue;
    const text = readText(join(src, f));
    if (text === null || text.includes("\u0000")) continue;
    const n = sloc(text, def);
    slocOf.set(f, n);
    const lang = (languages[def[0]] ??= { files: 0, lines: 0 });
    lang.files++; lang.lines += n;
    if (def[0].includes("config")) continue;
    perFile.push({ file: f, lines: n });
    if (PY_EXT.has(e)) fns.push(...pythonFunctions(f, text));
    else if (BRACE_EXT.has(e)) fns.push(...braceFunctions(f, text));
  }
  const sortStat = (a: FileStat, b: FileStat) => b.lines - a.lines || byName(a, b);
  perFile.sort(sortStat);
  const testSet = new Set(tests);
  // complexity per file
  const cx = new Map<string, { complexity: number; max_function: number; functions: number }>();
  for (const fn of fns) {
    const c = cx.get(fn.file) ?? { complexity: 0, max_function: 0, functions: 0 };
    c.complexity += fn.complexity; c.max_function = Math.max(c.max_function, fn.complexity); c.functions++;
    cx.set(fn.file, c);
  }
  const complexity_top = [...cx.entries()].map(([file, c]) => ({ file, ...c }))
    .sort((a, b) => b.complexity - a.complexity || byName(a, b)).slice(0, 25);

  const churn = readChurn(src, months, new Set(files));
  const top = [...churn.byFile.entries()].map(([file, e]) => ({ file, commits: e.commits, authors: e.authors.size }))
    .sort((a, b) => b.commits - a.commits || byName(a, b));
  const maxChurn = top[0]?.commits ?? 0;
  const maxCx = Math.max(0, ...[...cx.values()].map((c) => c.complexity));
  let hotspots: Hotspot[];
  let formula: string;
  if (churn.available && maxChurn > 0 && maxCx > 0) {
    formula = "score = (commits / max_commits) * (complexity / max_complexity), files with commits > 0 and complexity > 0, last " + months + " months";
    hotspots = top.filter((t) => (cx.get(t.file)?.complexity ?? 0) > 0).map((t) => {
      const c = cx.get(t.file)!.complexity;
      return { file: t.file, churn: t.commits, complexity: c, score: Math.round((t.commits / maxChurn) * (c / maxCx) * 1000) / 1000 };
    });
  } else {
    formula = "churn unavailable (not a git checkout or no history): score = complexity / max_complexity only";
    hotspots = [...cx.entries()].map(([file, c]) => ({ file, churn: 0, complexity: c.complexity, score: maxCx ? Math.round((c.complexity / maxCx) * 1000) / 1000 : 0 }));
  }
  hotspots.sort((a, b) => b.score - a.score || byName(a, b));

  // ownership per top-level dir
  const dirAuthors = new Map<string, Map<string, number>>();
  for (const [f, e] of churn.byFile) {
    const m = dirAuthors.get(topDir(f)) ?? new Map<string, number>();
    for (const [a, n] of e.authors) m.set(a, (m.get(a) ?? 0) + n);
    dirAuthors.set(topDir(f), m);
  }
  const ownership: Ownership[] = [...dirAuthors.entries()].map(([dir, m]) => {
    const counts = [...m.values()].sort((a, b) => b - a);
    const total = counts.reduce((s, x) => s + x, 0);
    let acc = 0, bus = 0;
    for (const c of counts) { acc += c; bus++; if (acc * 2 >= total) break; }
    return { dir, commits: total, authors: counts.length, top_author_share: total ? Math.round((counts[0]! / total) * 100) / 100 : 0, bus_factor: bus };
  }).sort((a, b) => (a.dir < b.dir ? -1 : 1));

  const groups = new Map<string, string[]>();
  for (const f of files) { const d = topDir(f); (groups.get(d) ?? groups.set(d, []).get(d)!).push(f); }
  const top_level_dirs = [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([dir, fs]) => ({
    dir, files: fs.length, sloc: fs.reduce((s, f) => s + (slocOf.get(f) ?? 0), 0), kind: dir === "." ? (dirKind(dir, fs) === "source" ? "source" : "other") as DirKind : dirKind(dir, fs),
  }));

  // A "scripts/" or "tools/" dir holding a large share of the code is the product, not glue.
  const totalSloc = top_level_dirs.reduce((s, t) => s + t.sloc, 0);
  for (const t of top_level_dirs) if (t.kind === "scripts" && totalSloc && t.sloc / totalSloc >= 0.1) t.kind = "source";

  const sortedLangs =Object.fromEntries(Object.entries(languages).sort((a, b) => b[1].lines - a[1].lines || (a[0] < b[0] ? -1 : 1)));
  return {
    tool: { files: method, lines: "builtin:sloc", functions: "builtin:indent+brace", churn: churn.available ? "git log" : "unavailable" },
    total_files: files.length,
    total_code_lines: Object.values(languages).reduce((s, l) => s + l.lines, 0),
    source_files: perFile.filter((f) => !testSet.has(f.file)).length,
    test_files: tests.length,
    test_file_list: tests,
    languages: sortedLangs,
    manifests,
    largest_files: perFile.slice(0, 25),
    god_class_candidates: perFile.filter((f) => !testSet.has(f.file) && f.lines >= godN),
    long_method_candidates: fns.filter((f) => f.lines >= longN).sort((a, b) => b.lines - a.lines || byName(a, b) || a.line - b.line),
    functions_analysed: fns.length,
    complexity_top,
    churn: { available: churn.available, months, commits: churn.commits, files_changed: churn.byFile.size, top: top.slice(0, 25) },
    hotspots: hotspots.slice(0, 25),
    hotspot_formula: formula,
    ownership,
    top_level_dirs,
    thresholds: { god_file_lines: godN, long_method_lines: longN, churn_months: months },
    files,
    file_sloc: Object.fromEntries([...slocOf.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
  };
}
