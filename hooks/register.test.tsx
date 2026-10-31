// `claude plugin test .` — the status Mod against the engine's test kit.
// Hooks here stand for the engine: they answer the Mod's $.fs / $.clock /
// $.session calls from a seeded in-memory review dir.
import { expect, test } from "claude-code/testing";

const NOW = 1_800_000_000_000;
const DIR = "/repo/.code-review/demo";

const status = {
  name: "demo", analysis_dir: DIR, complete: false, next_stage: "deep",
  stages: ["scope", "preflight", "assess", "map", "deep", "security", "consolidate", "verify", "architecture", "report"]
    .map((stage, i) => ({ stage, status: i < 4 ? "done" : "pending", command: `/code-review-harness:review-${stage} demo` })),
  findings: { total: 3, by_verdict: { confirmed: 1, "needs-human": 1, refuted: 1, pending: 0 }, by_severity: { High: 1 } },
  shards: { lost: [], deferred: [] },
  usage: { stages: [{ stage: "preflight", total_cost_usd: 0.55, duration_ms: 74766 }], totals: { input_tokens: 1000, output_tokens: 100, total_cost_usd: 1.19 } },
};
const progress = {
  name: "demo", pid: 1, state: "running", stage: "deep", stage_started_at: NOW - 125_000, started_at: NOW - 600_000,
  updated_at: NOW - 1_000, tool_calls: 42, agents_started: 6, last: "↳ Read src/app.py", log: `${DIR}/run.log`,
};
const files: Record<string, string> = {
  [`${DIR}/status.json`]: JSON.stringify(status),
  [`${DIR}/progress.json`]: JSON.stringify(progress),
  [`${DIR}/run.log`]: "16:30:01 ==> deep: fresh process (context-isolated)\n16:30:02       ↳ Read src/app.py\n",
};

function engine(on: any, seen: { status?: string; opened?: boolean }) {
  on("command.register", () => ({ value: { command: "review-dashboard" } }));
  on("ui.open", () => { seen.opened = true; return { value: { isPlaced: true } }; });
  on("ui.status", (_: any, e: any) => { seen.status = e.text; return { value: undefined }; });
  on("session.start", (_: any, e: any) => ({ cwd: e.cwd }));
  on("session.cwd", () => ({ value: "/repo" }));
  on("session.usage", () => ({ value: { context: { tokens: 1000, window: 200000, percent: 1 }, cost: { usd: 0.1 } } }));
  on("clock.now", () => ({ value: NOW }));
  on("fs.exists", (_: any, e: any) => ({ value: e.path === "/repo/.code-review" || e.path in files }));
  on("fs.list", () => ({ value: [{ name: "demo", path: DIR, kind: "dir" }] }));
  on("fs.stat", (_: any, e: any) => (e.path in files ? { value: { kind: "file", size: 1, mtimeMs: NOW - 1000, isSymbolicLink: false } } : { deny: "ENOENT" }));
  on("fs.read", (_: any, e: any) => (e.path in files ? { value: files[e.path] } : { deny: "ENOENT" }));
}

const PANE = {
  plugin: "code-review-harness", component: "Pane", requestId: "code-review",
  props: { title: "Code review", isFocused: false, bodyColumns: 120, placement: "dock", scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const;

test("a running review shows in the status line without a turn, and opens the pane", async ($, on) => {
  const seen: { status?: string; opened?: boolean } = {};
  engine(on, seen);
  await $.session.start({ cwd: "/repo", surface: "terminal", isInteractive: true });
  expect(seen.status).toContain("review demo · deep 5/10 2m05s");
  expect(seen.status).toContain("42 tools · 6 agents");
  expect(seen.status).toContain("$1.190");
  expect(seen.opened).toBe(true);
});

test("the pane draws stages, the live stage, findings and the run.log tail", async ($, on) => {
  engine(on, {});
  await $.session.start({ cwd: "/repo", surface: "terminal", isInteractive: true });
  for (const surface of ["terminal", "desktop"] as const) {
    const ui = await $.ui.mount({ ...PANE, surface });
    expect((await ui.find({ type: "Text", text: /^Code review — demo/ }))?.text).toBe("Code review — demo");
    expect((await ui.find({ type: "Text", text: /▶ deep/ }))?.text).toContain("▶ deep");
    expect((await ui.find({ type: "Text", text: /✓ preflight/ }))?.text).toContain("$0.550");
    expect((await ui.find({ type: "Text", text: /Live log/ }))?.text).toContain(`${DIR}/run.log`);
    expect((await ui.find({ type: "Text", text: /Findings: 3/ }))?.text).toContain("needs-human 1");
    expect((await ui.find({ type: "Text", text: /==> deep: fresh process/ }))).toBeTruthy();
    await ui.unmount();
  }
});
