// $0 scripted end-to-end: the real driver, plans, merge, panel, render and
// gates, with a stub runner standing in for `claude -p`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP, ROOT, cli, git, tree } from "./testkit.ts";

const STUB = `${process.execPath} --disable-warning=ExperimentalWarning ${join(ROOT, "tests", "fixtures", "stub-claude.ts")}`;

function repo() {
  const src = tree({ "src/app.py": APP, "README.md": "# demo\n" });
  git(src, "init", "-q"); git(src, "add", "."); git(src, "commit", "-qm", "init");
  return src;
}

test("driver runs every stage, retries a lost shard, renders reconciled reports, then resumes as a no-op", () => {
  const src = repo();
  const r = cli(["run", "e2e", "--source", src, "--runner", STUB, "--offline", "--dimensions", "security,quality", "--max-agents", "10"], { env: { STUB_LOSE_ONCE: "1" } });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /lost; retrying once/);
  const a = join(src, ".code-review", "e2e");
  for (const f of ["ANALYSIS_REPORT.md", "ARCHITECTURE.md", "ROADMAP.md", "REPORT.html", "DECK.pptx", "findings.sarif", "findings.jsonl", "REVISION.json", "THREAT_MODEL.md", "coverage.json"]) {
    assert.ok(existsSync(join(a, f)), `missing ${f}`);
  }
  const findings = JSON.parse(readFileSync(join(a, "findings.json"), "utf8")).findings as { dimension: string; verdict: string; reporters: number; severity: string }[];
  const sec = findings.filter((f) => f.dimension === "security");
  assert.equal(sec.length, 1, "SQLi reported by the injection shard is one finding");
  assert.equal(sec[0]!.verdict, "confirmed");
  assert.ok(findings.every((f) => f.verdict), "every finding has a verdict");
  const sarif = JSON.parse(readFileSync(join(a, "findings.sarif"), "utf8"));
  assert.equal(sarif.runs[0].results.length, findings.filter((f) => f.verdict === "confirmed").length);
  assert.ok(sarif.runs[0].results.every((x: { partialFingerprints: Record<string, string> }) => x.partialFingerprints["codeReviewHarness/v1"]));
  const status = JSON.parse(readFileSync(join(a, "status.json"), "utf8"));
  assert.equal(status.complete, true);
  assert.ok(status.usage.totals.total_cost_usd > 0);
  // live visibility: stage activity streamed to the terminal, run.log and progress.json
  assert.match(r.out, /live log: +tail -f .*run\.log/);
  assert.match(r.out, /· Read src\/app\.py/);
  assert.match(r.out, /↳ agent security-auditor: stub deep shard/);
  const runLog = readFileSync(join(a, "run.log"), "utf8");
  assert.match(runLog, /^\d\d:\d\d:\d\d ==> preflight: fresh process/m);
  assert.match(runLog, /· Read src\/app\.py/);
  assert.match(runLog, /=== review-run e2e done ===/);
  const progress = JSON.parse(readFileSync(join(a, "progress.json"), "utf8"));
  assert.equal(progress.state, "done");
  assert.equal(progress.stage, "report");
  assert.ok(progress.agents_started >= 1 && progress.tool_calls >= 1);
  // `watch` relays stage lines only and exits once the run is over
  const w = cli(["watch", "e2e", "--source", src]);
  assert.equal(w.code, 0, w.err);
  assert.match(w.out, /==> verify: fresh process/);
  assert.match(w.out, /=== review-run e2e done ===/);
  assert.doesNotMatch(w.out, /· Read/);
  // a killed driver is reported, not watched forever
  writeFileSync(join(a, "progress.json"), JSON.stringify({ ...progress, state: "running", pid: 2 ** 22 + 12345 }));
  const dead = cli(["watch", "e2e", "--source", src]);
  assert.equal(dead.code, 3);
  assert.match(dead.out, /driver pid \d+ is gone/);
  writeFileSync(join(a, "progress.json"), JSON.stringify(progress));
  assert.equal(existsSync(join(src, ".code-review", "active.json")), false, "guard deactivated after the run");
  assert.equal(readFileSync(join(src, ".code-review", ".gitignore"), "utf8"), "*\n!config.json\n", "everything generated is ignored; the team model config may be committed");
  // the source tree is untouched apart from the ignored review dir
  const st = spawnGit(src, ["status", "--porcelain"]);
  assert.equal(st.trim(), "", `source changed: ${st}`);
  // resume: everything skipped
  const again = cli(["run", "e2e", "--source", src, "--runner", STUB, "--offline"]);
  assert.equal(again.code, 0, again.err);
  assert.equal((again.out.match(/gate passes, skipping/g) ?? []).length, 9);
});

test("the agent cap batches a stage instead of leaving work deferred; --allow-deferred keeps one batch and reports the gap", () => {
  const src = repo();
  const r = cli(["run", "bt", "--source", src, "--runner", STUB, "--offline", "--dimensions", "security,quality", "--max-agents", "2"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /security plan \(batch 2\)/);
  const a = join(src, ".code-review", "bt");
  const status = JSON.parse(readFileSync(join(a, "status.json"), "utf8"));
  assert.equal(status.complete, true);
  assert.deepEqual(status.shards.deferred, [], "nothing left deferred");
  const src2 = repo();
  const p = cli(["run", "pd", "--source", src2, "--runner", STUB, "--offline", "--dimensions", "security,quality", "--max-agents", "2", "--allow-deferred"]);
  assert.equal(p.code, 0, p.out + p.err);
  assert.doesNotMatch(p.out, /batch 2/);
  const s2 = JSON.parse(readFileSync(join(src2, ".code-review", "pd", "status.json"), "utf8"));
  assert.equal(s2.complete, true);
  assert.ok(s2.shards.deferred.some((k: string) => k.startsWith("security:")), "the accepted gap is named");
});

test("render refuses when the source changed since assess, and --allow-stale banners it", () => {
  const src = repo();
  assert.equal(cli(["run", "st", "--source", src, "--runner", STUB, "--offline", "--dimensions", "quality"]).code, 0);
  writeFileSync(join(src, "src", "app.py"), APP + "# edited\n");
  const r = cli(["render", "st"], { cwd: src });
  assert.equal(r.code, 1);
  assert.match(r.err, /changed since assess/);
  const ok = cli(["render", "st", "--allow-stale"], { cwd: src });
  assert.equal(ok.code, 0, ok.err);
  assert.match(readFileSync(join(src, ".code-review", "st", "ANALYSIS_REPORT.md"), "utf8"), /stale|STALE/);
});

test("a batch that loses most of its shards stops without a retry, names the wait ceiling, and resumes", () => {
  const src = repo();
  const r = cli(["run", "ce", "--source", src, "--runner", STUB, "--offline", "--dimensions", "quality"], { env: { STUB_LOSE_ALL: "1" } });
  assert.equal(r.code, 1, r.out + r.err);
  assert.doesNotMatch(r.out, /retrying once/);
  assert.match(r.err, /deep lost \d+ of \d+ shard\(s\) in batch 1/);
  assert.match(r.err, /headless wait ceiling \(CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0\)/);
  const a = join(src, ".code-review", "ce");
  assert.equal(readFileSync(join(a, ".stub-ceiling"), "utf8"), "0", "the driver lifts the ceiling for every stage");
  const again = cli(["run", "ce", "--source", src, "--runner", STUB, "--offline"]);
  assert.equal(again.code, 0, again.out + again.err);
  assert.match(again.out, /deep: done/);
});

test("budget: a sharded stage the budget clearly cannot finish stops before spending; a tight one warns and runs", () => {
  // Stub stages cost $0.01; three before deep. Deep plans one compact task at the $0.45 default.
  const src = repo();
  const r = cli(["run", "sb", "--source", src, "--runner", STUB, "--offline", "--dimensions", "quality", "--max-usd", "0.3"]);
  assert.equal(r.code, 4, r.out + r.err);
  assert.match(r.err, /stopping before deep: deep needs ~\$0\.45 for 1 task\(s\) \(~\$0\.45 each\) and \$0\.27 of the \$0\.3 budget is left; nothing was spent on it/);
  assert.match(r.err, /--max-usd 5 or more/);
  assert.doesNotMatch(r.out, /==> deep/);
  const src2 = repo();
  const w = cli(["run", "sw", "--source", src2, "--runner", STUB, "--offline", "--dimensions", "quality", "--max-usd", "0.4"]);
  assert.match(w.out, /warning: deep needs ~\$0\.45 .* the run will likely stop inside this stage/);
  assert.match(w.out, /==> deep/);
});

test("budget: the driver stops before a stage once --max-usd is spent", () => {
  const src = repo();
  const r = cli(["run", "b", "--source", src, "--runner", STUB, "--offline", "--max-usd", "0.02"]);
  assert.equal(r.code, 4, r.out + r.err);
  assert.match(r.err, /budget \$0.02 reached/);
  const progress = JSON.parse(readFileSync(join(src, ".code-review", "b", "progress.json"), "utf8"));
  assert.equal(progress.state, "stopped", "the dashboard sees the budget stop");
});

test("dry run prints the stage plan and spends nothing", () => {
  const src = repo();
  const r = cli(["run", "d", "--source", src, "--dry-run"]);
  assert.equal(r.code, 0, r.err);
  assert.equal((r.out.match(/\[dry-run\]/g) ?? []).length, 9);
});

import { spawnSync } from "node:child_process";
function spawnGit(dir: string, args: string[]): string {
  return spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" }).stdout;
}
