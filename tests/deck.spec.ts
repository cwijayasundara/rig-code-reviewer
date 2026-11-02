import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_AWS_KEY } from "./testkit.ts";
import { renderAll } from "../scripts/lib/report.ts";
import { buildDeck, bulletSlides, mdToParas, renderDeck } from "../scripts/lib/report-deck.ts";
import { loadCtx } from "../scripts/lib/report-ctx.ts";
import { buildPptx } from "../scripts/lib/pptx.ts";
import type { Finding } from "../scripts/lib/types.ts";

function f(id: string, over: Partial<Finding> = {}): Finding {
  return {
    id, fingerprint: `v1:${id}`, category: "quality", reporters: 1, shards: ["deep:quality:core"],
    dimension: "quality", severity: "Medium", confidence: "high", file: "src/a.py", line: 3,
    title: `title ${id}`, evidence: "e", impact: "i", recommendation: "r", effort: "M", verdict: "confirmed", ...over,
  };
}

function dir(files: Record<string, unknown>): string {
  const d = mkdtempSync(join(tmpdir(), "crh-deck-"));
  for (const [rel, v] of Object.entries(files)) {
    mkdirSync(join(d, rel, ".."), { recursive: true });
    writeFileSync(join(d, rel), typeof v === "string" ? v : JSON.stringify(v));
  }
  return d;
}

/** Read every entry of a zip produced by scripts/lib/zip.ts (central directory walk). */
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, "end of central directory");
  let p = buf.readUInt32LE(eocd + 16);
  const n = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < n; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const lnameLen = buf.readUInt16LE(off + 26), extra = buf.readUInt16LE(off + 28);
    const start = off + 30 + lnameLen + extra;
    out.set(name, inflateRawSync(buf.subarray(start, start + size)).toString("utf8"));
    p += 46 + nameLen;
  }
  return out;
}

const slideText = (parts: Map<string, string>) =>
  [...parts].filter(([k]) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort(([a], [b]) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
    .map(([, x]) => x).join("\n");

const FINDINGS = {
  version: 1, findings: [
    f("SEC-00000001", { dimension: "security", severity: "Critical", cwe: "CWE-89", title: "SQL injection in <run> & co", votes: [{ lens: "REACHABILITY", verdict: "confirmed", note: "n" }, { lens: "IMPACT", verdict: "confirmed", note: "n" }] as never }),
    f("QUA-00000002", { evidence: `key ${FAKE_AWS_KEY} in config`, corrections: [{ field: "recommendation", claim: "add a test for X", correction: "X is already rejected" }] as never }),
    f("QUA-0000000a", { verdict: "refuted", title: "REFUTED-ONE", verifier_note: "guarded upstream" }),
    f("QUA-0000000b", { verdict: "deferred", title: "DEFERRED-ONE" }),
    f("QUA-0000000d", { verdict: "needs-human", verifier_note: "is X reachable?" }),
  ],
};

test("the deck is a valid pptx package carrying every section, finding and verdict bucket", () => {
  const d = dir({ "findings.json": FINDINGS, "ANALYSIS_NOTES.md": "## Theme one\n- **bold** point with `code`\n", "THREAT_MODEL.md": "# Threats\n| a | b |\n|---|---|\n| x | y |\n" });
  renderAll(d);
  const r = renderDeck(d);
  assert.ok(r.slides > 10, `slides ${r.slides}`);
  const parts = unzip(readFileSync(r.path));
  for (const p of ["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml", "ppt/slideMasters/slideMaster1.xml", "ppt/slideLayouts/slideLayout1.xml", "ppt/theme/theme1.xml"]) assert.ok(parts.has(p), p);
  const ids = (parts.get("ppt/presentation.xml")!.match(/<p:sldId /g) ?? []).length;
  assert.equal(ids, r.slides);
  for (let i = 1; i <= r.slides; i++) assert.ok(parts.has(`ppt/slides/slide${i}.xml`) && parts.has(`ppt/slides/_rels/slide${i}.xml.rels`), `slide ${i}`);
  const text = slideText(parts);
  for (const s of ["Agenda", "Executive dashboard", "Where the findings are", "How the review works", "Analyst notes", "Theme one", "Threat model", "x · y", "SEC-00000001", "QUA-00000002",
    "Security posture", "Roadmap at a glance", "Priority matrix", "Recommended next steps",
    "Now — Blocker / Critical / High", "Open questions", "is X reachable?", "REFUTED-ONE", "DEFERRED-ONE", "CORRECTED BY VERIFICATION", "X is already rejected"]) assert.ok(text.includes(s), s);
  // Diagrams are native, editable shapes and connectors — never pictures.
  assert.ok(![...parts.keys()].some((k) => /media|chart|\.png|\.jpe?g|\.emf/i.test(k)), "no images or embedded charts");
  assert.ok((text.match(/<p:cxnSp>/g) ?? []).length > 5, "connectors present");
  assert.ok((text.match(/prst="chevron"/g) ?? []).length >= 9, "pipeline chevrons");
  assert.ok(!text.includes("**"), "inline markdown stripped");
  assert.ok(text.includes("SQL injection in &lt;run&gt; &amp; co"), "XML escaped");
  assert.ok(!text.includes(FAKE_AWS_KEY), "secret redacted");
  assert.ok(r.redactions >= 1);
  const u = spawnSync("unzip", ["-tq", r.path], { encoding: "utf8" });
  if (!u.error) assert.equal(u.status, 0, u.stdout + u.stderr);
});

test("long content paginates instead of overflowing, and nothing is dropped", () => {
  const many = Array.from({ length: 45 }, (_, i) => f(`QUA-${String(i).padStart(8, "0")}`, { title: `finding number ${i} `.repeat(4), recommendation: "do the thing ".repeat(20) }));
  const d = dir({ "findings.json": { version: 1, findings: many } });
  const deck = buildDeck(loadCtx(d));
  const next = deck.slides.filter((s) => s.kind === "table" && s.title.startsWith("Next — Medium"));
  assert.ok(next.length > 1, "roadmap split over several slides");
  assert.match(next[0]!.title, /\(1\/\d+\)/);
  const rows = next.flatMap((s) => (s.kind === "table" ? s.rows.map((r) => (typeof r[0] === "string" ? r[0] : r[0]!.text)) : []));
  assert.deepEqual(rows, many.map((x) => x.id));
  const pages = bulletSlides("Long", Array.from({ length: 80 }, (_, i) => ({ bullet: true, runs: [{ text: `line ${i}` }] })));
  assert.ok(pages.length >= 3);
  assert.equal(pages.flatMap((s) => (s.kind === "bullets" ? s.paras : [])).length, 80);
});

test("same inputs give the same bytes; stale and incomplete reviews are marked on every slide", () => {
  const d = dir({ "findings.json": { version: 1, findings: [f("QUA-00000001"), f("QUA-00000002", { verdict: undefined })] }, "REVISION.json": { commit: "abc", stale: true } });
  const deck = buildDeck(loadCtx(d));
  assert.equal(Buffer.compare(buildPptx(deck), buildPptx(buildDeck(loadCtx(d)))), 0);
  assert.match(deck.warning ?? "", /STALE/);
  const text = slideText(unzip(buildPptx(deck)));
  assert.equal((text.match(/STALE — code changed/g) ?? []).length, deck.slides.length);
  assert.match(text, /VERIFICATION INCOMPLETE/);
});

test("architecture diagrams draw every kept module and dependency as editable shapes", () => {
  const mods = ["api", "orders", "payments", "db"].map((name, i) => ({ name, path: `src/${name}`, lines: 1000 - i }));
  const edges = [["api", "orders"], ["orders", "payments"], ["payments", "db"], ["orders", "db"]].map(([from, to]) => ({ from, to, type: "call", evidence: "src/a.py:1" }));
  const d = dir({ "findings.json": { version: 1, findings: [] }, "topology.json": { modules: mods, edges, entry_points: [{ name: "REST", kind: "http", file: "a.py", line: 1 }], externals: [{ name: "Stripe", kind: "api", evidence: "a.py:1" }], data_stores: [] },
    "architecture.json": { style: "monolith", summary: "s", quality_attributes: [{ name: "security", rating: 2, rationale: "r" }], dispositions: [{ module: "orders", disposition: "refactor", rationale: "r" }] } });
  const deck = buildDeck(loadCtx(d));
  const graph = deck.slides.find((s) => s.title === "Module dependencies");
  assert.ok(graph && graph.kind === "canvas");
  const shapes = graph.kind === "canvas" ? graph.shapes : [];
  for (const m of mods) assert.ok(shapes.some((x) => x.t === "box" && x.paras?.[0]?.runs[0]?.text === m.name), m.name);
  assert.ok(shapes.filter((x) => x.t === "line" && x.arrow).length >= edges.length);
  for (const t of ["System context", "Quality attributes (ISO 25010)"]) assert.ok(deck.slides.some((s) => s.title === t && s.kind === "canvas"), t);
  // Layered: api (no inbound edges) sits left of db (deepest).
  const x = (n: string) => (shapes.find((s) => s.t === "box" && s.paras?.[0]?.runs[0]?.text === n) as { x: number }).x;
  assert.ok(x("api") < x("orders") && x("orders") < x("payments") && x("payments") < x("db"));
});

test("mdToParas keeps structure: headings, nested bullets, table rows, fenced code", () => {
  const ps = mdToParas("# H\n- a\n  - b\n| c | d |\n|---|---|\n```\nx = 1\n```\nplain [link](http://x)");
  assert.equal(ps[0]!.heading, true);
  assert.equal(ps[2]!.level, 1);
  assert.equal(ps[3]!.runs[0]!.text, "c · d");
  assert.equal(ps[4]!.runs[0]!.text, "x = 1");
  assert.equal(ps[5]!.runs[0]!.text, "plain link");
  assert.equal(ps.length, 6);
});

test("CLI deck refuses before the report is rendered and builds after", async () => {
  const { cli, tree, git } = await import("./testkit.ts");
  const src = tree({ "src/app.py": "print(1)\n" });
  git(src, "init", "-q"); git(src, "add", "."); git(src, "commit", "-qm", "init");
  assert.equal(cli(["init", "dk", "--source", src], { cwd: src }).code, 0);
  assert.equal(cli(["evidence", "dk", "--no-scanners"], { cwd: src }).code, 0);
  const a = join(src, ".code-review", "dk");
  writeFileSync(join(a, "findings.json"), JSON.stringify({ version: 1, findings: [f("QUA-00000001", { file: "src/app.py", line: 1 })] }));
  const before = cli(["deck", "dk"], { cwd: src });
  assert.equal(before.code, 1);
  assert.match(before.err, /review-report/);
  assert.equal(cli(["render", "dk"], { cwd: src }).code, 0);
  const r = cli(["deck", "dk"], { cwd: src });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /deck: \d+ slide\(s\)/);
  assert.ok(existsSync(join(a, "DECK.pptx")));
});
