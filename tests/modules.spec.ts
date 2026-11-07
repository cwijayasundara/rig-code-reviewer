import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_UNIT_LOC, MIN_UNIT_LOC, packUnits } from "../scripts/lib/modules.ts";

// The 14-module topology of a real 2,457-line review (deep_agents_utils): one module per file.
const SAMPLE = [
  ["decisions_client", "src/decision_harness/decisions.py", 361], ["model_selector", "src/decision_harness/selector.py", 126],
  ["escalation_policy", "src/decision_harness/policy.py", 121], ["heuristic_classifier", "src/decision_harness/heuristic.py", 78],
  ["model_catalog", "src/decision_harness/catalog.py", 138], ["tool_selector", "src/decision_harness/tools.py", 122],
  ["cost_ledger", "src/decision_harness/ledger.py", 85], ["core_types", "src/decision_harness/types.py", 115],
  ["errors", "src/decision_harness/errors.py", 19], ["package_api", "src/decision_harness/__init__.py", 58],
  ["middleware", "src/decision_harness/middleware", 472], ["examples", "examples", 121], ["tests", "tests", 894], ["ci", ".github", 23],
].map(([name, path, lines]) => ({ name: name as string, path: path as string, lines: lines as number }));

test("packUnits: a small repo mapped one module per file becomes one review unit", () => {
  const u = packUnits(SAMPLE);
  assert.equal(u.length, 1);
  assert.equal(u[0]!.modules.length, 14);
  assert.equal(u[0]!.lines, 2733);
  assert.match(u[0]!.name, /\+13-more$/);
});

test("packUnits: modules at or above the floor, or of unknown size, are never packed", () => {
  const u = packUnits([
    { name: "big", path: "src/big", lines: MIN_UNIT_LOC },
    { name: "a", path: "src/a", lines: 100 }, { name: "b", path: "src/b", lines: 100 },
    { name: "unknown", path: "src/c" },
  ]);
  assert.deepEqual(u.map((x) => x.modules), [["a", "b"], ["big"], ["unknown"]]);
});

test("packUnits: units close at the floor, never exceed the ceiling, and a small tail joins its neighbour", () => {
  const m = (n: number, lines: number) => ({ name: `m${n}`, path: `src/m${n}`, lines });
  const u = packUnits([m(1, 1600), m(2, 1600), m(3, 1600), m(4, 1600), m(5, 400)]);
  assert.deepEqual(u.map((x) => x.modules), [["m1", "m2"], ["m3", "m4", "m5"]]);
  const capped = packUnits([m(1, 2800), m(2, 2800), m(3, 2800)], undefined, { min: 10000, max: MAX_UNIT_LOC });
  assert.ok(capped.every((x) => x.lines <= MAX_UNIT_LOC), JSON.stringify(capped));
  assert.deepEqual(capped.map((x) => x.modules.length), [2, 1]);
});

test("packUnits: evidence SLOC outranks the map's own line counts", () => {
  const u = packUnits([{ name: "a", path: "src/a", lines: 10 }, { name: "b", path: "src/b", lines: 10 }], { "src/a/x.py": MIN_UNIT_LOC, "src/b/y.py": 20 });
  assert.deepEqual(u.map((x) => x.modules), [["a"], ["b"]]);
});

test("map units: suggested modules are packed for the map stage, so a small repo gets one analyst", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { put } = await import("./testkit.ts");
  const { suggestMapUnits, MAP_MAX_LOC } = await import("../scripts/lib/modules.ts");
  const a = mkdtempSync(join(tmpdir(), "mapunits-"));
  const file_sloc: Record<string, number> = {};
  for (let i = 0; i < 12; i++) file_sloc[`src/m${i}/x.py`] = 600;
  put(a, "evidence.json", { files: Object.keys(file_sloc), file_sloc });
  let r = suggestMapUnits(a);
  assert.equal(r.modules.length > 1, true);
  assert.equal(r.units.length, 1, "7,200 lines across 12 modules: one analyst");
  for (let i = 0; i < 60; i++) file_sloc[`lib/d${i}/y.py`] = 1000;
  put(a, "evidence.json", { files: Object.keys(file_sloc), file_sloc });
  r = suggestMapUnits(a);
  assert.ok(r.units.length < r.modules.length / 4, `${r.units.length} units for ${r.modules.length} modules`);
  assert.ok(r.units.every((u) => u.lines <= MAP_MAX_LOC));
});
