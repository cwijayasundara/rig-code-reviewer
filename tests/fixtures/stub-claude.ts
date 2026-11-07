// Scripted stand-in for `claude -p` used by the $0 end-to-end test. It plays
// each model stage the way the skills instruct: write prose / agent shards /
// votes into the analysis dir, then (report stage) call `review.ts render`.
// STUB_LOSE_ONCE=1 drops the first deep shard on the first attempt to
// exercise the driver's lost-shard retry; STUB_LOSE_ALL=1 drops the whole
// first deep batch to exercise the no-retry stop.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const prompt = process.argv[process.argv.indexOf("-p") + 1] ?? "";
const m = prompt.match(/review-([a-z]+) (\S+)/);
const stage = m?.[1] ?? "";
const name = m?.[2] ?? "";
const A = process.env.CODE_REVIEW_OUT!;
const CLI = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."), "scripts", "review.ts");
const put = (rel: string, v: unknown) => { mkdirSync(dirname(join(A, rel)), { recursive: true }); writeFileSync(join(A, rel), typeof v === "string" ? v : JSON.stringify(v, null, 2)); };
const args = (s: string) => JSON.parse(readFileSync(join(A, "plan", `${s}.workflow-args.json`), "utf8")) as { tasks: [string, string, (string | null)?, (string | null)?][] };

const sqli = { dimension: "security", severity: "High", confidence: "high", file: "src/app.py", line: 4, title: "SQL injection in run()", evidence: "src/app.py:4 concatenates q into SQL", impact: "read any row", recommendation: "parameterise the query", effort: "S", cwe: "CWE-89", exploit_scenario: "external caller passes q=\"1 OR 1=1\"" };
const swallow = { dimension: "quality", severity: "Medium", confidence: "high", file: "src/app.py", line: 5, title: "Exception swallowed", evidence: "src/app.py:5-6 except Exception: pass", impact: "failures vanish", recommendation: "log and re-raise", effort: "S" };

switch (stage) {
  case "preflight": put("PREFLIGHT.md", "# Preflight\nPython, no build. Execution: not run.\n"); break;
  case "assess": put("ASSESSMENT.md", "# Assessment\nOne module, src/app.py:2 entry.\n"); break;
  case "map": {
    // One analyst per planned map unit writes its fragment, then the script merges them (the skill never writes topology.json).
    for (const [key] of args("map").tasks) put(`fragments/${key}.json`, { modules: [{ name: "core", path: "src", lines: 999 }], edges: [], entry_points: [{ name: "run", kind: "function", file: "src/app.py", line: 2 }], data_stores: [{ name: "db", kind: "sql", evidence: "src/app.py:4" }], externals: [], flows: [], observations: [] });
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "merge-topology", name], { encoding: "utf8", env: process.env });
    if (r.status !== 0) { process.stderr.write(r.stdout + r.stderr); process.exit(1); }
    break;
  }
  case "deep": {
    const marker = join(A, ".stub-lost");
    put(".stub-ceiling", process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS ?? "unset");
    // STUB_LOSE_ALL=1: the first deep batch loses every shard the way the headless wait ceiling does.
    if (process.env.STUB_LOSE_ALL === "1" && !existsSync(marker)) {
      writeFileSync(marker, "1");
      process.stderr.write("Background tasks still running after 600000ms were stopped (CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS)\n");
      break;
    }
    let first = true;
    args("deep").tasks.forEach(([key, agent]) => {
      if (agent === "threat-modeler") { put(`threat/${key.replace(/^threat--/, "")}.md`, "Entry: src/app.py:2 (external caller)."); return; }
      const i = first ? 0 : 1; first = false;
      if (i === 0 && process.env.STUB_LOSE_ONCE === "1" && !existsSync(marker)) { writeFileSync(marker, "1"); return; }
      put(`raw/deep/${key}.json`, { shard: key, filesRead: ["src/app.py"], notReached: [], findings: /^(quality|[a-z+]*\+quality)(\+|--)/.test(key) ? [swallow] : [] });
    });
    break;
  }
  case "security":
    for (const [key, agent] of args("security").tasks) {
      if (agent === "threat-modeler") put(`threat/${key.replace(/^threat--/, "")}.md`, "Entry: src/app.py:2 (external caller).");
      else put(`raw/security/${key}.json`, { shard: key, filesRead: ["src/app.py"], notReached: [], findings: /injection|all-categories/.test(key) ? [sqli] : [] });
    }
    break;
  case "consolidate": {
    // Simulate a consolidator: merge findings that share a title word "swallow"/"exception", else keep apart.
    const plan = JSON.parse(readFileSync(join(A, "plan", "consolidate.json"), "utf8")) as { run: { key: string; input: { members: string[] } }[] };
    for (const t of plan.run) put(`consolidate/${t.key}.json`, { group: t.key, merges: [] });
    break;
  }
  case "verify": {
    // A verify task judges a batch of findings (same file, one lens) and writes one vote each.
    const plan = JSON.parse(readFileSync(join(A, "plan", "verify.json"), "utf8")) as { run: { key: string; input: { ids: string[]; lens: string } }[] };
    const byKey = new Map(plan.run.map((t) => [t.key, t.input]));
    for (const [key] of args("verify").tasks) {
      const t = byKey.get(key)!;
      for (const id of t.ids) put(`votes/${id}--${t.lens}.json`, { id, lens: t.lens, verdict: "confirmed", note: "re-derived from src/app.py:4", evidence: "src/app.py:4", corrections: [] });
    }
    break;
  }
  case "architecture":
    put("architecture.json", { summary: "Single-module script.", style: "procedural", quality_attributes: [{ name: "security", rating: 2, rationale: "SQLi", evidence: ["src/app.py:4"] }, { name: "usability", rating: "unavailable", rationale: "no UI", evidence: [] }], decisions: [], dispositions: [{ module: "core", disposition: "refactor", rationale: "fix SQL", evidence: ["src/app.py:4"] }], risks: [], one_thing: "Parameterise queries." });
    break;
  case "report": {
    put("ANALYSIS_NOTES.md", "SQL injection at src/app.py:4 dominates.\n");
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "render", name], { encoding: "utf8", env: process.env });
    if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(r.status ?? 1); }
    break;
  }
  default: process.stderr.write(`stub: unknown stage in ${prompt}\n`); process.exit(2);
}
// Shaped like `--output-format stream-json --verbose`: activity events, then the result.
console.log(JSON.stringify({ type: "system", subtype: "init" }));
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/app.py" } }] } }));
console.log(JSON.stringify({ type: "assistant", parent_tool_use_id: "t1", message: { content: [{ type: "tool_use", name: "Agent", input: { subagent_type: "security-auditor", description: `stub ${stage} shard` } }] } }));
console.log(JSON.stringify({ type: "result", result: `stub ${stage} ok`, usage: { input_tokens: 1000, output_tokens: 100 }, total_cost_usd: 0.01, duration_ms: 5 }));
