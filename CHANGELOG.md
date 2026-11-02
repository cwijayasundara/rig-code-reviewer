# Changelog

## Unreleased

**Fixed — the map stage failed on any repo big enough for several analysts**
- The map stage fanned out one `codebase-analyst` per module but nothing combined their outputs, so the stage improvised a merge script; headless stages block `python3`, and a headless process cannot ask for approval. New `review.ts merge-topology <name>` (`scripts/lib/topology.ts`) does it in the driver: reads `fragments/*.json`, dedupes modules by name (later fragments fill empty fields), drops and counts edges with no from/to, no `file:line` evidence or an unknown type, takes module `lines` from `evidence.json`, validates, and only then writes `topology.json`.
- `review-map` now has each analyst write `fragments/<module>.json` in the topology shape and runs `R merge-topology`. The guard treats `topology.json` as script-owned and validates fragments on write.
- Every headless stage skill now says: never write or run ad-hoc scripts; if a step seems to need one, stop and report it.
- When a stage exits non-zero or misses its gate, `review-run` names the tool calls the permission check refused (from `permission_denials` and permission errors in the stream), e.g. `stage map needed Bash(python3 merge.py), which the headless allowlist denies`.

**Changed — lower token cost per review**
- Every fresh agent or `claude -p` process pays a fixed start-up cost: its system prompt and tool definitions are written to the prompt cache (1-hour TTL) before it does any work. That, not long contexts, dominated spend: a one-file eval case cost $5.60–6.70, 44% of it in verify (22 Opus agents for 8 findings).
- Verify batches per file: one agent per (file, lens) judges up to 5 findings and writes one `votes/<id>--<lens>.json` each. Lenses remain separate agents, so the 2-of-3 panel, median severity and corrections are unchanged; votes already on disk are skipped one by one on resume. Security verifier effort `xhigh` → `high`.
- Each stage's orchestrating `claude -p` pins `--model`/`--effort` (Sonnet; low for the dispatch-only sharded stages, Opus medium for architecture) instead of inheriting the user's default model, and runs with `--strict-mcp-config --setting-sources project,local` so user MCP servers and user plugins are not loaded into it. Measured on a trivial prompt: start-up cache writes 16.8k → 6.7k tokens, $0.068 → $0.028 per process. `--stage-model`, `--stage-effort` and `--user-settings` override this.
- Compact mode: a review unit under 1,000 lines gets one `module-reviewer` covering every deep dimension (its brief carries each specialist's own checklist from `agents/*.md`) and one security auditor covering every category, instead of one agent per dimension and per category. Gap-fill sweeps run only where there is a gap: `outside-components` and `secrets-everywhere` when files sit outside every module, `cross-boundary` when there is more than one unit.
- Architecture runs on Sonnet (medium) instead of Opus.
- Model configuration: `main` (finders), `evaluator` (verifiers), `writer` (prose stages) and `orchestrator` (dispatch stages), plus per-stage and per-agent overrides, from `<repo>/.code-review/config.json` (now exempt from the review dir's `.gitignore`) or `--config <file>`. Validated at init, frozen into `<analysis>/config.json`, passed to each stage process and, through the workflow's `agent()` options, to each agent. Both files are denied to models by the guard. Init warns when `main` and `evaluator` are the same model.
- Measured on the 4 seeded eval cases (2026-11-02): $19.51 → $10.14 with verify batching and pinned stages → **$5.83** with compact mode, Sonnet architecture and conditional sweeps (upstream code-modernization: $9.73). Recall 1 and 0 false positives on every case; confirmed findings 27 → 20 as one compact reviewer files each defect once. `eval/baseline.json` now gates all four cases, with cost caps at ~1.6× the measured cost.
- `usage.json` now keeps uncached input, cache reads and cache writes apart (priced 1× / 0.1× / 2× for 1-hour writes) and per-model spend, including subagents.

**Added — the review as a Google Slides deck**
- New `review.ts deck <name>` and `/code-review-harness:review-deck <name>` write `DECK.pptx` beside the report: title, executive summary, findings-at-a-glance (dimension × severity), top risks, analyst notes, scope and methodology, scanners, coverage and gaps, architecture (summary, modules, entry points, externals, flows, ISO 25010 ratings, reconstructed decisions, dispositions, risks), threat model, security findings, quality signals, hotspots, ownership, test posture, dependencies, one slide per confirmed finding (with verifier corrections), the Now/Next/Later roadmap, open questions, accepted risks, baseline diff, assessment, and the refuted/deferred appendix.
- Built from the same loaded context as `ANALYSIS_REPORT.md`, so every number reconciles; refuses until the report is current, and on a changed tree unless `--allow-stale` (every footer then says STALE). Redacted like every other render; deterministic bytes; `DECK.pptx` is script-owned in the guard.
- Diagrams, all drawn as native shapes and connectors so they stay editable after import (Google Slides flattens imported charts into pictures): executive dashboard (KPI tiles, severity bars, the one change that matters), dimension × severity heatmap, review pipeline and three-lens verification flow, coverage bars, system context (entry points → system → externals and data stores), layered module dependency graph coloured by disposition, ISO 25010 rating meters, hotspot bars, security posture by weakness category, Now/Next/Later roadmap lanes, a severity × effort priority matrix with quick wins, and a next-steps slide.
- Design: navy title and numbered section dividers, an agenda with slide numbers, a section label above every title, navy table headers with severity-coloured cells, one card-layout slide per finding (severity pill, meta chips, evidence and impact beside the fix), and short text slides set in larger type.
- Google Slides import: plain OOXML, one blank layout, Arial only, editable text boxes, shapes, connectors and tables, and pagination by estimated text height because Slides ignores autofit. No new dependencies (a small deflate ZIP writer on `node:zlib`).
- `/review-run` builds the deck after the report stage ($0); a deck failure warns and never fails the run.

**Fixed — a confirmed finding shipped with text its verifier proved wrong**
- A verifier that confirmed a finding but found factual errors in it could only say so in its free-text note, which no report shows beside the finding. A live `js-traversal` review published "assert 400 for an array-valued param" as the recommendation after the verifier had shown the code accepts that input, so the recommended test would fail.
- Every vote now carries `corrections` (`[]` when accurate): field, the wrong claim quoted, what is true. Validated on write; a vote without it is rejected.
- The script attaches confirming votes' corrections to the finding (exact repeats across lenses shown once) and sends a finding whose `title` or `location` was corrected to needs-human. Refuting lenses' corrections are not attached. Confidence is unchanged: it rates the core claim, and capping it on detail errors dropped a 3/3-confirmed Critical traversal to medium in a live run.
- ANALYSIS_REPORT.md, ROADMAP.md, the security and dependency tables, REPORT.html and SARIF (message and `properties.corrections`) show the corrections beside the text they replace.

**Added — differential eval against code-modernization**
- `eval/upstream.ts` runs Anthropic's code-modernization plugin (`modernize-assess` + `modernize-harden`) headlessly on the same seeded cases and scores its reports with the same scorer. Only findings its adversarial pass kept count: refuted rows, coverage gaps, remediation notes and assess's unjudged security table are ignored; a severity range takes its lower bound. `npm run eval:compare` is a parity gate: the harness must catch every defect upstream caught, with no more false positives. First runs (2026-11-01): parity on all 4 cases; harness $19.51 vs upstream $9.73.

**Fixed — eval scoring miscounted true findings**
- `duplicatesOfMust` counted a different finding as a duplicate when its *evidence* cross-referenced the planted defect ("see the SQL injection finding"); extra primaries now count only when their title names the defect, as the scorer's comment always said.
- The `safe-twin-flagged` bait rules (`js-traversal`, `py-sqli`) counted any Medium+ finding on the guarded twin, so a confirmed, true "path-containment guard has no test" note scored as a false positive. They now count security findings only — the bait being taken. Reason recorded in each `expected.json`.

**Fixed — a resumed review never ran its deferred work**
- A sharded stage (deep, security, consolidate, verify) passed its gate while tasks over the agent cap were still deferred, so `/review-run` moved on, and a resume skipped the stage for good. A real 2,457-line review ended with 74 of 98 deep shards, 49 of 73 security tasks and 61 of 85 verifier tasks deferred, 55% of files read, and no report. A stage now passes only when nothing is deferred. The driver runs a stage in batches of `--max-agents` until it is finished, and checks `--max-usd` before every batch; a budget stop leaves the remaining work for the resume. `--allow-deferred` keeps the old single capped batch and reports the rest as a named coverage gap.
- `merge --after <stage>` now consumes `plan/<stage>.workflow-args.json`, so a manual stage run re-plans (`plan --continue-deferred`) instead of replaying a finished batch.
- A 3-lens security panel could never fit under `--max-agents` 1 or 2 and stayed deferred forever. A group larger than the cap now runs alone in its own batch.

**Changed — shards are per review unit, not per module**
- The map may name a module per file, which is useful for the architecture report but costly for sharding: 14 modules × 7 dimensions spent one agent's fixed overhead on a 19-line file. `plan` now packs topology modules in path order into review units of at least 1,500 SLOC (never past 4,000; SLOC from `evidence.json`). A module at or above the floor, or of unknown size, stays alone. The same review now plans 7 deep tasks instead of 98, and 8 security tasks instead of 73. Briefs list every module and path in the unit, and each security audit names its own threat map.

**Fixed — a running review was invisible**
- `/review-run` buffered each stage process (`spawnSync` + `--output-format json`), so nothing appeared until a stage ended, and the model ran it in the background with no follow-up. Stages now run with `--output-format stream-json --verbose`; every tool call and agent start streams to the terminal and to `<analysis>/run.log` (timestamped, `tail -f`-able) as it happens, and the run's live state goes to `<analysis>/progress.json`.
- The status Mod drew only into the Spinner, which is not shown once a turn ends, and refreshed only on turn boundaries. It now polls every 2 s, pins a status line under the prompt (stage n/10 · elapsed · tool calls · agents · last activity · findings · cost), and opens a "Code review" pane (stages, per-stage cost, findings, run.log tail) automatically when a run starts, or on `/review-dashboard`. A run with no driver event for 20 min is flagged, not shown as healthy.
- New `review.ts watch <name>`: follows run.log, prints stage-level lines only, exits when the run ends (3 if the driver died). The `review-run` skill arms it as a Monitor and relays each stage in chat.

## 2.0.0
Rewritten in zero-dependency TypeScript (Node ≥ 22.18) behind one CLI, `scripts/review.ts`. Python removed.

**Fixed**
- Review artefacts were counted as part of the codebase (`analysis/` inside the source was walked by the evidence pack; findings files counted as tests). Artefacts now live in `<source>/.code-review/<name>/` with a `*` .gitignore, always excluded.
- Guard allowed writes to any path containing `/analysis/` and blocked any path containing `/target/`; Bash writes were unguarded; the guard was active in every session once installed. Now: absolute, symlink-resolved paths; strict only while a review is active; Bash seatbelt; script-owned files protected.
- Test detection was a substring match (`latest.py` counted as a test). Now path-segment and filename-pattern based.
- `evidence.json` claimed `scc`/`cloc` when installed but always counted with find+wc. Every figure is now labelled with the method that actually computed it.
- Finding ids collided across shards (`SEC-001` everywhere). Ids are now derived from content fingerprints: stable across runs and line shifts.
- The security panel ran candidates serially, had no cap/resume, did not dedupe before voting, and did not implement the documented severity/confidence clamps. Dedupe, median severity, confidence clamp and incomplete-panel handling are now computed by script; panels are never split across the agent cap.
- Git churn was documented but not implemented. Implemented (one `git log` pass), with hotspots and ownership.
- Headless stages ran without a tool allowlist. The driver now passes `--allowedTools` (read-only Bash + the CLI) and `--max-budget-usd`.
- Workflow syntax was checked with `node --check`, which rejects the host's top-level `return`. The workflow is now executed in tests with stubbed globals.

**Hardened after an independent review and two live runs**
- Lost shards are written off only after a real retry (plan rebuilds no longer count as attempts).
- Guard: active review found by walking up from cwd; source root from the review, not cwd; case-insensitive script-owned matching; `briefs/` protected; `REVIEW_HUMAN`/`accept` checks normalise quoting; all redirection operators; wrapper commands (`env`, `xargs`, `sudo`…); `git -c`, `--output`, `rg --pre`; git subcommand parsing past global options.
- Strict severity order (Blocker > Critical) in merge, verifier clamp and panel median.
- Fingerprint from the representative's own line, member fingerprints kept as aliases so votes and accepted risks survive new reporters; single-linkage clustering.
- Cross-dimension fold: the same vulnerability reported by security, data and quality shards becomes one security finding (seen in a live run).
- Vote files must be named after their content; sticky `final` clears when new findings appear; stale renders use the verified findings.json without re-merging; `--out` inside the source is excluded from evidence and the tree fingerprint.
- Redaction gate no longer rejects code-shaped values (`token = crypto.randomBytes(32)`).

**Added**
- Duplicate removal: a `consolidate` stage between security and verify — script-proposed co-located groups, consolidator decisions validated and applied by script (worst severity, all reporters, aliases, "also reported as" in the report); eval measures duplicates of planted defects and co-located findings.
- CWE data regenerated from MITRE's CWE 5.0 catalog by `scripts/tools/build-cwe.ts`; security prompts rewritten as original text; NOTICE corrected (claude-security is proprietary: nothing from it is included); Apache-2.0 LICENSE added.
- Scanner packs as data (`data/stacks/`): gitleaks, osv-scanner, semgrep (+ opt-in npm-audit, pip-audit); failed/missing tools are coverage gaps.
- Deterministic merge (`findings.json`), CWE-1003 rollup (CWE 4.20 data), SARIF with CWE rules, fingerprints and suppressions, JSONL.
- Coverage accounting (`coverage.json`), lost/deferred shards, one automatic retry.
- Script-written per-task briefs with `<untrusted-…>` fences; agents write their own validated shard files.
- Architecture stage: ISO 25010 scorecard with evidence, reconstructed ADRs, per-module dispositions → `ARCHITECTURE.md` with C4 context, module and data-lineage diagrams.
- `REVISION.json` freshness gate; baseline diff; human-only accepted risk; cost estimate before each stage; `--max-usd`.
- Seeded-defect eval (`eval/`) with clean and bait controls and a baseline gate; invariant specs; scripted $0 end-to-end test.
- Skills replace commands (rig convention); `review-architecture`, `review-accept`, `review-guide`.

## 1.2.2
- Fix: report/analysis stage gates keyed on prose outputs, not early renders.

## 1.2.1
- Fix: workflows in Claude Code script format; `PYTHONDONTWRITEBYTECODE=1`; ordered stage inference; `--plugin-dir` for the default runner.

## 1.2.0
- Dashboard shows token usage + cost (Mods API + per-stage run totals).

## 1.1.0
- `/review-run` automated chain, artefacts beside the source, `status.json`, Mods dashboard, shard-level resume.

## 1.0.0
- Security review stage; workflows; guard hooks; SARIF; revision stamp.

## 0.1.0
- Initial harness.
