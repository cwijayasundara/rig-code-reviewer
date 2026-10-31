# Changelog

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
