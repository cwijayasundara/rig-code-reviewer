# Code Review Harness

A Claude Code plugin for a **read-only, whole-codebase evaluation** of an existing repository: architecture, code quality and security, ending in a report you can trust and a prioritised roadmap. It never fixes, transforms or commits anything.

It builds on the staged assess → map → review flow of Anthropic's Apache-2.0 [code-modernization](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/code-modernization) plugin (see [NOTICE.md](NOTICE.md)), adds an independently written threat-model → sweep → three-angle verification pipeline for security, and follows the engineering conventions of the `rig` SDLC harness: **models advise, scripts decide**.

## Install

**Requirements:** Node 22.18 or later, `git`, Claude Code 2.1.316 or later (the version this release is tested on; stage processes use `--effort`, `--strict-mcp-config` and `--setting-sources`). Optional scanners: `gitleaks`, `osv-scanner`, `semgrep` (a missing or broken one is reported as a coverage gap, never as clean).

**How it differs from rig.** rig is loaded once: `/rig:init` copies its skills, agents, hooks and scripts into the project's own `.claude/` and `.rig/`, so later sessions need no flag. This harness deliberately never copies itself into the repo under review (a reviewer must not change what it reviews), so **every session that uses a `/code-review-harness:` command needs the plugin loaded**: with a flag each time (A), or once per repo with a project-scope install (B). Either way the review's artefacts stay in the reviewed repo's git-ignored `.code-review/` folder.

Get the plugin once:

```bash
git clone https://github.com/cwijayasundara/rig-code-reviewer.git   # creates rig-code-reviewer/
```

**A. Load it per session** (writes nothing to any settings file):

```bash
PLUGIN=/abs/path/to/rig-code-reviewer          # your clone: the folder that contains .claude-plugin/plugin.json
ls "$PLUGIN/.claude-plugin/plugin.json"         # must print the file
cd /path/to/repo-under-review
claude --plugin-dir "$PLUGIN"
```

- Use the flag on **every** session that runs a review command, including the one where you resume a run or check `/code-review-harness:review-status`. A session started without it reports the commands as unknown.
- Claude Code **silently ignores a `--plugin-dir` that does not exist**: there is no error, only missing commands. Use your clone's real folder name (a renamed or versioned checkout such as `rig_code_reviewer_v1.0/` is not `rig-code-reviewer/`).
- Check in the session: typing `/code-review-harness:` lists the commands. `/code-review-harness:review-run` starts its stage processes with the same plugin directory, so nothing else needs loading.

**B. Enable it for one repo you review regularly** (no flag afterwards):

```bash
cd /path/to/repo-under-review
claude plugin marketplace add cwijayasundara/rig-code-reviewer --scope project   # or the absolute path of your clone
claude plugin install code-review-harness@rig-code-reviewer --scope project
```

- This writes `.claude/settings.json` in the reviewed repo; it is the only file the harness adds outside `.code-review/`. Commit it to share the setup, or leave it untracked.
- Never run either command without `--scope project`: the default is user scope, which loads the plugin (about 2k tokens of skill descriptions) into every session in every repo.
- If `marketplace add` fails with *"its source doesn't match its extraKnownMarketplaces entry"*, a marketplace named `rig-code-reviewer` is already registered in your user settings (for example from a local clone). Skip the `add` and run only the `install`, which uses that entry, or remove the entry from `~/.claude/settings.json` first.

**Upgrade.** A: `git pull` in the clone; the next session uses it. B: `claude plugin marketplace update rig-code-reviewer`, then `claude plugin update code-review-harness@rig-code-reviewer --scope project`.

## Use

```text
/code-review-harness:review-run <name> --source . --max-usd 25
```

**Budget:** every fresh process or agent pays a fixed start-up cost (its system prompt and tools written to the prompt cache) before reading any code, so cost tracks how many agents start, not how long their contexts get. Stages run on pinned models with user MCP servers and plugins left out; small review units (< 1,000 lines) get one all-dimension reviewer and one all-category auditor instead of one specialist each; verifiers judge up to 5 findings of one file per lens. set `--max-usd` and read the per-stage estimate the driver prints before each sharded stage (estimates self-calibrate from `usage.json`: spend divided by shards actually produced, so lost agents don't skew them). Before a sharded stage spends anything, the driver projects its whole cost: when that is over 1.5× the budget left it stops at once with a suggested `--max-usd`; when it is merely tight it warns and runs. It also checks the budget before every batch of `--max-agents` tasks; when it is reached, the run stops with the resume command and the remaining work stays queued. The budget is saved with the review, so pass a higher `--max-usd` when resuming after a budget stop. Unfinished panels become needs-human — never silently confirmed.

**Models:** every role is configurable. Put a `config.json` in `<repo>/.code-review/` (it is the one file there git does not ignore, so a team can commit it) or pass `--config <file>` to `review` / `review-run`; the file wins over the repo one, which wins over the defaults. Example: [`docs/config.example.json`](docs/config.example.json).

| Role | Runs | Default |
|---|---|---|
| `main` | the finders: deep-review specialists, threat modeler, security auditor, consolidator | each agent's frontmatter (Sonnet) |
| `evaluator` | the verifiers that confirm or refute every finding | frontmatter (Opus) |
| `writer` | the prose stages: preflight, assess, map, architecture, report | Sonnet, medium (follows `main.model` if only that is set) |
| `orchestrator` | the dispatch-only stages: deep, security, consolidate, verify | Sonnet, low |

`stages.<stage>` and `agents.<agent>` override one stage or agent. The resolved choice is frozen into `<analysis>/config.json` at init (models may not write either file), printed at the start of a run, and per-model spend lands in `usage.json`. Keep `evaluator` on a different model from `main`: a model's blind spot can pass its own check, so init warns when they match.

**Watching a run:** the driver prints `live log: tail -f <analysis>/run.log`. That log carries every tool call and agent start of every stage as it happens (type `! tail -f …` to stream it into the session). A status line under the prompt shows stage · elapsed · tool calls · agents · cost for the whole run. The "Code review" pane opens by itself when a run starts (on terminals 144 columns or wider), or any time with `/review-dashboard`. In chat, the skill relays each stage start and finish through `review.ts watch <name>`.

One fresh headless Claude process per stage (context isolation by construction), with deterministic steps run by the driver in between. Re-run the same command to resume. Step by step instead: `/code-review-harness:review <name> --source <path>` then follow the printed next command (type `/clear` between stages). `/code-review-harness:review-status <name>` works any time, in any session.

| Stage | What happens | Owner |
|---|---|---|
| scope | `scope.json`, review dir `<source>/.code-review/<name>/` (git-ignored) | script |
| preflight | stack, scope boundary, missing source, execution status → `PREFLIGHT.md` | model |
| assess | inventory, SLOC, complexity, churn × complexity hotspots, ownership/bus factor, scanner packs → `evidence.json`; tree fingerprint → `REVISION.json`; analyst `ASSESSMENT.md` | script + model |
| map | modules (oversized dirs auto-split), typed edges, entry points, data stores, flows → `topology.json` (validated) | model |
| deep | one specialist per review unit × dimension (small modules packed into units of ≥1,500 SLOC; a unit under 1,000 lines gets one all-dimension reviewer), from a script-computed plan → `raw/deep/*` | agents |
| security | threat model per review unit, unit × category sweep (one all-category auditor for a unit under 1,000 lines), gap-fill sweeps where files sit outside every module or units share a boundary → `raw/security/*` | agents |
| consolidate | duplicates across dimensions removed: script groups co-located findings, a consolidator decides which share one root cause, script validates and merges → `consolidate/*` | agents + script |
| verify | merge (dedupe, fingerprint, stable ids) → independent verifier per finding, batched up to 5 per file; security: REACHABILITY / IMPACT / DEFENSES panel, one agent per lens → `votes/*` → verdicts computed | agents + script |
| architecture | ISO 25010 scorecard (evidence or "unavailable"), reconstructed ADRs, per-module dispositions → `architecture.json` (validated) | model |
| report | analyst notes, then deterministic `ANALYSIS_REPORT.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `REPORT.html`, `findings.sarif`, `findings.jsonl` | script |
| deck | `DECK.pptx`: the whole analysis as an editable Google Slides deck with native diagrams (built automatically after report; `/code-review-harness:review-deck <name>` rebuilds it) | script |

## Why trust the output

- **Deterministic evidence first.** Every figure in `evidence.json` names the tool that computed it. A failed or missing scanner is reported as a coverage gap, never as "clean".
- **Nothing reaches the roadmap without a verdict.** Security: 2 of 3 lenses must confirm; final severity = median of confirming votes, never raised; `high` confidence only on 3/3; incomplete panels become needs-human. Other dimensions: one verifier on a different model tier, which may lower but never raise severity.
- **One defect, one finding.** Exact duplicates are merged by script (same path and CWE-1003 category within 3 lines; security-shaped reports from other dimensions fold into the security finding); co-located findings from different dimensions are consolidated by a decision the script validates before applying. The report lists what each finding was "also reported as".
- **Scripts own every number.** Findings are merged, deduplicated, fingerprinted (`v1:sha256(category|path|±3 lines)` — survives line shifts) and given stable ids (`SEC-1a2b3c4d`) by `scripts/review.ts`; the guard denies the model writing any script-owned file.
- **Honest coverage.** Every top-level directory is scanned or set aside with a reason; agents report `filesRead` / `notReached`; lost shards are named, and work over the agent cap runs in later batches (`--allow-deferred` accepts it as a named gap instead). A dimension with gaps says "not fully covered", not "no findings".
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
npm run eval:upstream -- --live --max-usd 6 --upstream <path>/plugins/code-modernization   # paid: same cases through code-modernization's assess + harden
npm run eval:compare # $0: parity gate — the harness must catch what upstream caught, with no more false positives
```

Layout: `scripts/review.ts` (one CLI, command table) · `scripts/lib/*` (`report-deck.ts` + `deck-diagrams.ts` + `pptx.ts` + `zip.ts`: the dependency-free deck writer) · `skills/*` (thin prompts) · `agents/*` · `workflows/review-tasks.js` · `hooks/` (guards + status Mod) · `data/stacks/*.json` (scanner packs as data) · `data/cwe-categories.json` · `schemas/` · `eval/` · `tests/`. Design: [docs/DESIGN.md](docs/DESIGN.md).
