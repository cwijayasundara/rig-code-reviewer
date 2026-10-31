import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { braceFunctions, collectEvidence, isManifest, isTestFile, pythonFunctions, sloc } from "../scripts/lib/evidence.ts";

function repo(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "ev-spec-"));
  for (const [f, s] of Object.entries(files)) { mkdirSync(dirname(join(d, f)), { recursive: true }); writeFileSync(join(d, f), s); }
  return d;
}
const g = (d: string, ...a: string[]) => execFileSync("git", ["-C", d, "-c", "user.name=A", "-c", "user.email=a@x", "-c", "commit.gpgsign=false", ...a], { stdio: "ignore" });

test("review output dirs are never counted as code (regression: old bug #1)", () => {
  const d = repo({
    "src/app.py": "x = 1\n",
    ".code-review/demo/helper.py": "print(1)\n",
    ".code-review/demo/findings.json": "[]\n",
    "node_modules/pkg/index.js": "module.exports = 1\n",
  });
  const ev = collectEvidence(d);
  assert.deepEqual(ev.files, ["src/app.py"]);
  assert.equal(ev.test_files, 0);
});

test("test detection is by convention, never substring (regression: old bug #3)", () => {
  for (const f of ["latest.py", "contest.js", "src/attestation.ts", "protest/x.go.txt"]) assert.equal(isTestFile(f), false, f);
  for (const f of ["test_app.py", "app_test.py", "x_test.go", "a.test.ts", "a.spec.jsx", "FooTest.java", "FooTests.cs", "a_spec.rb", "tests/helpers.py", "src/__tests__/a.js", "conftest.py"])
    assert.equal(isTestFile(f), true, f);
});

test("tool field records what actually ran (regression: old bug #4)", () => {
  const d = repo({ "a.py": "x=1\n" });
  const ev = collectEvidence(d);
  assert.deepEqual(ev.tool, { files: "walk", lines: "builtin:sloc", functions: "builtin:indent+brace", churn: "unavailable" });
  assert.match(ev.hotspot_formula, /churn unavailable/);
});

test("sloc skips blanks and comment-only lines, including block comments", () => {
  const ts = "// c\n\n/* a\n b */\nconst x = 1; // trailing\n/** doc */\nlet y = 2\n";
  assert.equal(sloc(ts, ["TypeScript", ["//"], ["/*", "*/"]]), 2);
  assert.equal(sloc("# c\n\nx = 1\n", ["Python", ["#"], null]), 1);
});

test("python functions by indentation with complexity", () => {
  const src = "def a(x):\n    if x and x > 1:\n        return 1\n    for i in x:\n        pass\n    return 0\n\nclass K:\n    def b(self):\n        return 2\n";
  const fns = pythonFunctions("m.py", src);
  assert.deepEqual(fns.map((f) => [f.name, f.line, f.end_line]), [["a", 1, 6], ["b", 9, 10]]);
  assert.equal(fns[0]!.complexity, 4); // 1 + if + and + for
});

test("brace functions skip braces in strings and comments", () => {
  const src = [
    "function outer(a) {",
    "  const s = \"}{\"; // }",
    "  if (a || b) { return 1 }",
    "  return 2;",
    "}",
    "const arrow = (x) => {",
    "  return x ? 1 : 2;",
    "};",
    "func Go(x int) int {",
    "  return x",
    "}",
  ].join("\n");
  const fns = braceFunctions("m.ts", src);
  const outer = fns.find((f) => f.name === "outer")!;
  assert.deepEqual([outer.line, outer.end_line], [1, 5]);
  assert.equal(outer.complexity, 3); // 1 + if + ||
  assert.ok(fns.find((f) => f.name === "arrow" && f.end_line === 8));
  assert.ok(fns.find((f) => f.name === "Go" && f.line === 9 && f.end_line === 11));
  assert.ok(!fns.find((f) => f.name === "if"));
});

test("god files, long methods, manifests, top-level dir kinds", () => {
  const big = Array.from({ length: 12 }, (_, i) => `x${i} = ${i}`).join("\n");
  const longFn = "def long():\n" + Array.from({ length: 8 }, (_, i) => `    y${i} = ${i}`).join("\n") + "\n";
  const d = repo({
    "src/big.py": big + "\n" + longFn, "tests/test_big.py": big, "docs/readme.md": "# x\n",
    ".github/workflows/ci.yml": "on: push\n", "package.json": "{}", "requirements-dev.txt": "x\n", "app/App.csproj": "<x/>",
  });
  const ev = collectEvidence(d, { godFileLines: 10, longMethodLines: 5 });
  assert.deepEqual(ev.god_class_candidates.map((f) => f.file), ["src/big.py"]); // test file excluded
  assert.deepEqual(ev.long_method_candidates.map((f) => f.name), ["long"]);
  assert.deepEqual(ev.manifests, ["app/App.csproj", "package.json", "requirements-dev.txt"]);
  const kinds = Object.fromEntries(ev.top_level_dirs.map((t) => [t.dir, t.kind]));
  assert.equal(kinds["src"], "source"); assert.equal(kinds["tests"], "test"); assert.equal(kinds["docs"], "docs"); assert.equal(kinds[".github"], "ci");
  assert.ok(isManifest("Cargo.lock") && isManifest("requirements.txt") && !isManifest("readme.md"));
});

test("churn, hotspots and ownership from one git log pass", () => {
  const d = repo({ "a.py": "def f(x):\n    if x:\n        return 1\n", "b.py": "def g():\n    return 2\n" });
  g(d, "init", "-q");
  g(d, "add", "."); g(d, "commit", "-qm", "1");
  writeFileSync(join(d, "a.py"), "def f(x):\n    if x and x:\n        return 1\n"); g(d, "commit", "-qam", "2");
  execFileSync("git", ["-C", d, "-c", "user.name=B", "-c", "user.email=b@x", "-c", "commit.gpgsign=false", "commit", "-qam", "3", "--allow-empty"], { stdio: "ignore" });
  writeFileSync(join(d, "a.py"), "def f(x):\n    if x and x or x:\n        return 1\n");
  execFileSync("git", ["-C", d, "-c", "user.name=B", "-c", "user.email=b@x", "-c", "commit.gpgsign=false", "commit", "-qam", "4"], { stdio: "ignore" });
  const ev = collectEvidence(d);
  assert.equal(ev.tool.files, "git ls-files");
  assert.equal(ev.tool.churn, "git log");
  assert.equal(ev.churn.available, true);
  assert.deepEqual(ev.churn.top[0], { file: "a.py", commits: 3, authors: 2 });
  assert.equal(ev.hotspots[0]!.file, "a.py");
  assert.equal(ev.hotspots[0]!.score, 1);
  const root = ev.ownership.find((o) => o.dir === ".")!;
  assert.equal(root.authors, 2);
  assert.equal(root.bus_factor, 1);
});

test("same input yields byte-identical evidence (no timestamps)", () => {
  const d = repo({ "a.ts": "export function f(a: number) {\n  return a > 1 ? 1 : 2;\n}\n", "z/b.go": "func B() {\n}\n" });
  assert.equal(JSON.stringify(collectEvidence(d)), JSON.stringify(collectEvidence(d)));
});
