import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { topologyData, topologyHtml } from "../scripts/lib/topology-html.ts";
import { mergeTopology } from "../scripts/lib/topology.ts";
import { renderAll } from "../scripts/lib/report.ts";
import type { Finding } from "../scripts/lib/types.ts";
import { put } from "./testkit.ts";

const TOPO = {
  modules: [
    { name: "api", path: "src/api", lines: 120, kind: "service", description: "HTTP layer" },
    { name: "db", path: "src/db", lines: 40, kind: "library" },
  ],
  edges: [
    { from: "api", to: "db", type: "call", evidence: "src/api/a.ts:3" },
    { from: "api", to: "db", type: "import", evidence: "src/api/a.ts:1" },
    { from: "db", to: "pg", type: "write", evidence: "src/db/x.ts:9" },
  ],
  entry_points: [{ name: "GET /orders", kind: "http", file: "src/api/a.ts", line: 12 }],
  data_stores: [{ name: "pg", kind: "postgres", evidence: "src/db/x.ts:1" }],
  externals: [{ name: "stripe", evidence: "src/api/pay.ts:4" }],
  flows: [{ name: "place order", steps: ["api receives order", "db writes order"], evidence: ["src/api/a.ts:12"] }],
  observations: ["note"],
};

const f = (id: string, file: string, severity: Finding["severity"], verdict?: string): Finding => ({
  id, dimension: "quality", severity, confidence: "high", file, line: 5, title: `t-${id}`, evidence: "e", impact: "i", recommendation: "r", effort: "S",
  fingerprint: `v1:${id}`, category: "x", reporters: 1, shards: [], ...(verdict ? { verdict } : {}),
} as Finding);

test("topology data: findings land on their module (refuted left out), edge targets that are stores get nodes, entry points attach", () => {
  const d = topologyData(TOPO, {
    name: "shop",
    findings: [f("QUA-1", "src/api/a.ts", "Medium", "confirmed"), f("QUA-2", "src/api/b.ts", "Critical", "needs-human"), f("QUA-3", "src/db/x.ts", "High", "refuted")],
    architecture: { dispositions: [{ module: "api", disposition: "refactor", rationale: "god handler", evidence: ["src/api/a.ts:1"] }] },
  });
  const api = d.nodes.find((n) => n.id === "api")!, db = d.nodes.find((n) => n.id === "db")!;
  assert.deepEqual([api.worst, api.counts], ["Critical", { Medium: 1, Critical: 1 }]);
  assert.deepEqual(api.findings.map((x) => x.id), ["QUA-2", "QUA-1"], "worst first");
  assert.equal(db.worst, undefined, "a refuted finding is not a problem");
  assert.equal(api.disposition, "refactor");
  assert.deepEqual(api.entries, [{ name: "GET /orders", kind: "http", file: "src/api/a.ts", line: 12 }]);
  assert.equal(d.nodes.find((n) => n.id === "pg")!.type, "store");
  assert.equal(d.nodes.some((n) => n.id === "stripe"), false, "an external no edge touches stays in the side list only");
  assert.equal(d.generated, "report");
  assert.equal(topologyData(TOPO, { name: "shop" }).generated, "map");
});

test("topology page: repository text cannot break out of the data block, and the page script compiles", () => {
  const evil = { ...TOPO, modules: [...TOPO.modules, { name: "x</script><script>alert(1)</script>", path: "src/x", description: "<img src=x onerror=alert(1)>" }] };
  const html = topologyHtml(topologyData(evil, { name: "<b>shop</b>" }));
  assert.equal((html.match(/<\/script>/g) ?? []).length, 2, "only the page's own two script blocks close");
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<b>shop<\/b>/, "the review name is escaped");
  assert.doesNotMatch(html, /innerHTML/, "the page builds the DOM with textContent only");
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=/, "self-contained: no external code or styles");
  const data = html.match(/<script type="application\/json" id="topo-data">([\s\S]*?)<\/script>/)![1]!;
  assert.equal(JSON.parse(data).nodes.length, 4, "3 modules + the store an edge points at");
  const js = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  assert.doesNotThrow(() => new Script(js), "page script is valid JavaScript");
});

test("TOPOLOGY.html is written by merge-topology and rewritten by render with findings", () => {
  const a = mkdtempSync(join(tmpdir(), "crh-topohtml-"));
  put(a, "fragments/all.json", TOPO);
  assert.equal(mergeTopology(a).written, true);
  const atMap = readFileSync(join(a, "TOPOLOGY.html"), "utf8");
  assert.match(atMap, /from the map stage/);
  put(a, "findings.json", { version: 1, findings: [f("QUA-1", "src/api/a.ts", "High", "confirmed")] });
  renderAll(a);
  const atReport = readFileSync(join(a, "TOPOLOGY.html"), "utf8");
  assert.match(atReport, /with verified findings/);
  assert.match(atReport, /"worst":"High"/);
  assert.match(readFileSync(join(a, "REPORT.html"), "utf8"), /href="TOPOLOGY.html"/);
  const none = mkdtempSync(join(tmpdir(), "crh-topohtml-"));
  put(none, "findings.json", { version: 1, findings: [] });
  renderAll(none);
  assert.equal(existsSync(join(none, "TOPOLOGY.html")), false, "no topology, no page");
});
