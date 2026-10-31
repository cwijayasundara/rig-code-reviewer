import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contextMermaid, lineageMermaid, MAX_EDGES, mermaidId, mermaidLabel, modulesMermaid, validateArchitecture, validateTopology,
} from "../scripts/lib/architecture.ts";

export const goodTopology = {
  modules: [{ name: "api", path: "src/api", lines: 1200 }, { name: "core-lib", path: "src/core" }],
  edges: [
    { from: "api", to: "core-lib", type: "call", evidence: "src/api/routes.py:12" },
    { from: "core-lib", to: "orders_db", type: "write", evidence: "src/core/repo.py:40" },
    { from: "api", to: "orders_db", type: "read", evidence: "src/api/q.py:7" },
  ],
  entry_points: [{ name: "POST /orders", kind: "http", file: "src/api/routes.py", line: 10 }],
  data_stores: [{ name: "orders_db", kind: "postgres", evidence: "config/db.yml:3" }],
  externals: [{ name: "Stripe", kind: "http", evidence: "src/core/pay.py:5" }],
  flows: [{ name: "place order", steps: ["route", "repo.save"], evidence: ["src/api/routes.py:10"] }],
  observations: ["single database shared by all modules"],
};

export const goodArchitecture = {
  summary: "A layered monolith.",
  style: "layered monolith",
  quality_attributes: [
    { name: "maintainability", rating: 3, rationale: "some god files", evidence: ["src/core/repo.py:1"] },
    { name: "security", rating: "unavailable", rationale: "not enough evidence", evidence: [] },
  ],
  decisions: [{ title: "ORM-free SQL", context: "c", decision: "raw SQL in repo", consequences: "injection risk", evidence: ["src/core/repo.py:40"] }],
  dispositions: [{ module: "api", disposition: "refactor", rationale: "r", evidence: ["src/api/routes.py:1"] }],
  risks: [{ title: "shared db", evidence: [], finding_ids: ["ARC-1a2b3c4d"] }],
  one_thing: "Split the repo module.",
};

test("validateTopology accepts a well-cited topology", () => {
  assert.deepEqual(validateTopology(goodTopology), []);
});

test("validateTopology rejects uncited edges, unknown edge types, missing module path", () => {
  const bad = structuredClone(goodTopology) as any;
  bad.edges[0].evidence = "somewhere";
  bad.edges[1].type = "teleport";
  delete bad.modules[1].path;
  bad.data_stores[0].evidence = "";
  const errs = validateTopology(bad);
  assert.ok(errs.some((e) => e.includes("edges[0]") && e.includes("file:line")), errs.join("\n"));
  assert.ok(errs.some((e) => e.includes("teleport")));
  assert.ok(errs.some((e) => e.includes("modules[1]") && e.includes("path")));
  assert.ok(errs.some((e) => e.includes("data_stores[0]")));
  assert.deepEqual(validateTopology(null), ["topology: must be an object"]);
  assert.ok(validateTopology({ modules: [] }).some((e) => e.includes("non-empty")));
});

test("validateArchitecture accepts evidence-backed ratings and 'unavailable'", () => {
  assert.deepEqual(validateArchitecture(goodArchitecture), []);
});

test("validateArchitecture rejects uncited numeric ratings, decisions, dispositions and bad enums", () => {
  const bad = structuredClone(goodArchitecture) as any;
  bad.quality_attributes[0].evidence = ["trust me"];
  bad.quality_attributes.push({ name: "beauty", rating: 4, evidence: ["a.py:1"] });
  bad.quality_attributes.push({ name: "reliability", rating: 9, evidence: ["a.py:1"] });
  bad.decisions[0].evidence = [];
  bad.dispositions[0].disposition = "nuke";
  bad.dispositions[0].evidence = [];
  bad.risks.push({ title: "vibes" });
  const errs = validateArchitecture(bad);
  assert.ok(errs.some((e) => e.includes("maintainability") && e.includes("unavailable")), errs.join("\n"));
  assert.ok(errs.some((e) => e.includes("beauty")));
  assert.ok(errs.some((e) => e.includes("1..5")));
  assert.ok(errs.some((e) => e.startsWith("decisions[0]")));
  assert.ok(errs.some((e) => e.includes("nuke")));
  assert.ok(errs.some((e) => e.includes("dispositions[0]") && e.includes("evidence")));
  assert.ok(errs.some((e) => e.includes("vibes")));
  assert.ok(validateArchitecture({}).includes("summary: required"));
});

test("mermaid ids are sanitised and labels escaped", () => {
  assert.equal(mermaidId("core-lib/v2.x"), "core_lib_v2_x");
  assert.equal(mermaidId("9lives"), "n_9lives");
  assert.match(mermaidId('a"b]c'), /^[A-Za-z0-9_]+$/);
  const lbl = mermaidLabel('say "hi" [x] <script>');
  assert.ok(!/["[\]<>]/.test(lbl), lbl);
  assert.ok(lbl.includes("#quot;"));
});

test("module graph keeps at most MAX_EDGES and reports dropped count", () => {
  const modules = Array.from({ length: 80 }, (_, i) => ({ name: `m${i}`, path: `src/m${i}` }));
  const edges = Array.from({ length: 79 }, (_, i) => ({ from: `m${i}`, to: `m${i + 1}`, type: "call", evidence: `a.py:${i + 1}` }));
  const r = modulesMermaid({ modules, edges });
  assert.equal(r.dropped, 79 - MAX_EDGES);
  assert.equal(r.text.split("\n").filter((l) => l.includes("-->")).length, MAX_EDGES);
});

test("context and lineage diagrams reference sanitised nodes", () => {
  const ctx = contextMermaid(goodTopology, "my app");
  assert.match(ctx, /ep_POST__orders/);
  assert.match(ctx, /ext_Stripe/);
  assert.match(ctx, /ds_orders_db/);
  const lin = lineageMermaid(goodTopology);
  assert.match(lin, /core_lib -->\|write\| ds_orders_db/);
  assert.match(lin, /ds_orders_db -\.->\|read\| api/);
  assert.match(lineageMermaid({ modules: [] }), /no data stores/);
});
