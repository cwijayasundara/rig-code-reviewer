// Seeded-defect eval: runs the real harness on each case in a fresh temp git
// repo and scores the confirmed findings deterministically.
//   node eval/run.ts --dry                       # $0: list cases + planned stages (default)
//   node eval/run.ts --live --max-usd 5 [--case py-sqli] [--runner cmd]
// Live runs spend money; each case is capped by --max-usd (required).
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, readJson, str, writeText } from "../scripts/lib/util.ts";
import { gate, scoreDir, type Gate } from "./score.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CLI = join(ROOT, "scripts", "review.ts");

function sh(cmd: string, args: string[], cwd: string) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
}

export function main(argv: string[]): number {
  const { flags } = parseArgs(argv);
  const live = flags.live === true;
  const only = str(flags.case);
  const cases = readdirSync(join(HERE, "cases")).filter((c) => !only || c === only).sort();
  const baseline = readJson<{ cases?: Record<string, Gate> }>(join(HERE, "baseline.json"), {}).cases ?? {};
  if (!live) {
    console.log(`eval (dry): ${cases.length} case(s) — nothing is spent. Live: node eval/run.ts --live --max-usd <per-case cap>`);
    for (const c of cases) {
      const exp = readJson<{ description: string; must: unknown[]; mustNot: unknown[] }>(join(HERE, "cases", c, "expected.json"), { description: "", must: [], mustNot: [] });
      console.log(`  ${c}: ${exp.description} · must ${exp.must.length} · mustNot ${exp.mustNot.length} · gate ${baseline[c] ? JSON.stringify(baseline[c]) : "not enforced"}`);
    }
    return 0;
  }
  const maxUsd = str(flags["max-usd"]);
  if (!maxUsd) { console.error("--live requires --max-usd <per-case cap>"); return 2; }
  const rows: Record<string, unknown>[] = [];
  let failed = 0;
  for (const c of cases) {
    const work = mkdtempSync(join(tmpdir(), `crh-eval-${c}-`));
    cpSync(join(HERE, "cases", c, "src"), join(work, "src"), { recursive: true });
    sh("git", ["init", "-q"], work); sh("git", ["add", "."], work);
    sh("git", ["-c", "user.name=eval", "-c", "user.email=eval@local", "commit", "-qm", "seed"], work);
    const args = ["--disable-warning=ExperimentalWarning", CLI, "run", "eval", "--source", work, "--max-usd", maxUsd, "--offline"];
    if (str(flags.runner)) args.push("--runner", str(flags.runner)!);
    console.log(`==> ${c} (${work})`);
    const r = spawnSync(process.execPath, args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const analysis = join(work, ".code-review", "eval");
    const usd = readJson<{ totals?: { total_cost_usd?: number } }>(join(analysis, "usage.json"), {}).totals?.total_cost_usd ?? 0;
    const s = scoreDir(analysis, join(HERE, "cases", c));
    const g = gate(s, usd, baseline[c]);
    if (g.status === "fail" || r.status !== 0) failed++;
    rows.push({ case: c, exit: r.status, usd, ...s, gate: g.status, reasons: g.reasons });
    console.log(`    exit ${r.status} · recall ${s.recall ?? "n/a"} · caught [${s.caught}] missed [${s.missed}] · FP ${s.falsePositives.length} · dup ${s.duplicatesOfMust} · co-located ${s.colocated} · $${usd.toFixed(2)} · gate ${g.status}${g.reasons.length ? ` (${g.reasons.join("; ")})` : ""}`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeText(join(HERE, "results", `${stamp}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const md = ["# Eval run " + stamp, "", "| case | exit | recall | caught | missed | FP | dup | co-located | $ | gate |", "|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r: any) => `| ${r.case} | ${r.exit} | ${r.recall ?? "n/a"} | ${r.caught.join(", ")} | ${r.missed.join(", ")} | ${r.falsePositives.length} | ${r.duplicatesOfMust} | ${r.colocated} | ${Number(r.usd).toFixed(2)} | ${r.gate} |`)];
  writeText(join(HERE, "results", `${stamp}.md`), md.join("\n") + "\n");
  console.log(`results: eval/results/${stamp}.{jsonl,md}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
