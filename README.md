# Code Review Harness

A Claude Code plugin for a **read-only, whole-codebase evaluation** of an existing repository: architecture, code quality and security, ending in a report you can trust and a prioritised roadmap. It never fixes, transforms or commits anything.

It builds on the staged assess → map → review flow of Anthropic's Apache-2.0 [code-modernization](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/code-modernization) plugin (see [NOTICE.md](NOTICE.md)), adds an independently written threat-model → sweep → three-angle verification pipeline for security, and follows the engineering conventions of the `rig` SDLC harness: **models advise, scripts decide**.

```text
/plugin marketplace add cwijayasundara/rig-code-reviewer
/plugin install code-review-harness@rig-code-reviewer
```

Requirements: Claude Code ≥ 2.1.287, Node ≥ 22.18 (no npm install needed at runtime; zero dependencies). Optional scanners: `gitleaks`, `osv-scanner`, `semgrep`.

## Use

```text
/code-review-harness:review-run <name> --source . --max-usd 25
```

**Budget:** each stage process carries ~$0.25–0.35 of fixed overhead, then agents scale with modules × dimensions and with findings (security findings cost three verifier votes each). Live runs measured ~$4–6 for a 20-line seeded repository with all eight dimensions; set `--max-usd` and read the per-stage estimate the driver prints before each sharded stage (estimates self-calibrate from `usage.json`). When the cap is reached mid-stage, unfinished panels become needs-human — never silently confirmed.

One fresh headless Claude process per stage (context isolation by construction), with deterministic steps run by the driver in between. Re-run the same command to resume. Step by step instead: `/code-review-harness:review <name> --source <path>` then follow the printed next command (type `/clear` between stages). `/code-review-harness:review-status <name>` works any time, in any session.

| Stage | What happens | Owner |
|---|---|---|
| scope | `scope.json`, review dir `<source>/.code-review/<name>/` (git-ignored) | script |
| preflight | stack, scope boundary, missing source, execution status → `PREFLIGHT.md` | model |
| assess | inventory, SLOC, complexity, churn × complexity hotspots, ownership/bus factor, scanner packs → `evidence.json`; tree fingerprint → `REVISION.json`; analyst `ASSESSMENT.md` | script + model |
| map | modules (oversized dirs auto-split), typed edges, entry points, data stores, flows → `topology.json` (validated) | model |
| deep | one specialist per module × dimension, from a script-computed plan → `raw/deep/*` | agents |
| security | threat model per component, component × category sweep, gap-fill sweeps → `raw/security/*` | agents |
| consolidate | duplicates across dimensions removed: script groups co-located findings, a consolidator decides which share one root cause, script validates and merges → `consolidate/*` | agents + script |
| verify | merge (dedupe, fingerprint, stable ids) → independent verifier per finding; security: REACHABILITY / IMPACT / DEFENSES panel → `votes/*` → verdicts computed | agents + script |
| architecture | ISO 25010 scorecard (evidence or "unavailable"), reconstructed ADRs, per-module dispositions → `architecture.json` (validated) | model |
| report | analyst notes, then deterministic `ANALYSIS_REPORT.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `REPORT.html`, `findings.sarif`, `findings.jsonl` | script |

## Why trust the output

- **Deterministic evidence first.** Every figure in `evidence.json` names the tool that computed it. A failed or missing scanner is reported as a coverage gap, never as "clean".
- **Nothing reaches the roadmap without a verdict.** Security: 2 of 3 lenses must confirm; final severity = median of confirming votes, never raised; `high` confidence only on 3/3; incomplete panels become needs-human. Other dimensions: one verifier on a different model tier, which may lower but never raise severity.
- **One defect, one finding.** Exact duplicates are merged by script (same path and CWE-1003 category within 3 lines; security-shaped reports from other dimensions fold into the security finding); co-located findings from different dimensions are consolidated by a decision the script validates before applying. The report lists what each finding was "also reported as".
- **Scripts own every number.** Findings are merged, deduplicated, fingerprinted (`v1:sha256(category|path|±3 lines)` — survives line shifts) and given stable ids (`SEC-1a2b3c4d`) by `scripts/review.ts`; the guard denies the model writing any script-owned file.
- **Honest coverage.** Every top-level directory is scanned or set aside with a reason; agents report `filesRead` / `notReached`; lost and deferred shards are named. A dimension with gaps says "not fully covered", not "no findings".
- **Reports are tied to code.** `render` refuses if the tree changed since assess (or renders with a STALE banner on `--allow-stale`).
- **Repeat reviews.** `scope --baseline <name>` adds "new / no longer reported / persisting" by fingerprint. `/code-review-harness:review-accept` (human-only) records accepted risk; SARIF marks it suppressed.

## Safety

The code under review is untrusted input. While a review is active the hooks:
- allow Edit/Write only inside the review dir (absolute, symlink-resolved paths), never on script-owned files;
- deny mutating git, package installs, `find -exec/-delete`, in-place edits, `curl | sh`, and rm/mv/cp/tee/redirects into the source tree;
- validate every agent output on write.

Outside a review the hooks do nothing. They are a seatbelt, not isolation — review hostile repositories in a container. See [SECURITY.md](SECURITY.md).

## Develop

```bash
npm install          # typescript + @types/node (dev only)
npm run check        # tsc + node:test (unit, invariants, guard, $0 scripted end-to-end)
npm run validate     # claude plugin validate
npm run eval:dry     # list seeded-defect cases ($0)
node --disable-warning=ExperimentalWarning eval/run.ts --live --max-usd 5   # paid: recall / false positives per case
```

Layout: `scripts/review.ts` (one CLI, command table) · `scripts/lib/*` · `skills/*` (thin prompts) · `agents/*` · `workflows/review-tasks.js` · `hooks/` (guards + status Mod) · `data/stacks/*.json` (scanner packs as data) · `data/cwe-categories.json` · `schemas/` · `eval/` · `tests/`. Design: [docs/DESIGN.md](docs/DESIGN.md).
