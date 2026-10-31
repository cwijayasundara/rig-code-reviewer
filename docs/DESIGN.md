# Design (v2)

Read-only, whole-codebase **architecture + code + security evaluation** of an
existing repository. It never fixes, transforms or commits. Built on the
the staged assessment pattern of Anthropic's Apache-2.0 `code-modernization`
plugin (see NOTICE.md) and the conventions of the `rig` SDLC harness.

## Principles

1. **Models advise, scripts decide.** Every count, verdict, severity clamp,
   dedupe, fingerprint, ID, coverage figure and report table is computed by
   `scripts/review.ts`. Models write prose and raw candidate findings only.
2. **Evidence first.** Deterministic evidence (inventory, complexity, churn,
   hotspots, external scanners) runs before any agent, and every agent finding
   must cite `file:line`.
3. **Adversarial verification.** Nothing reaches the roadmap without a verdict.
   Security: three-lens panel (REACHABILITY / IMPACT / DEFENSES), 2-of-3,
   median severity of confirming votes, never raised, `high` confidence only on
   3/3. Other dimensions: one independent verifier on a different model tier.
4. **Honest coverage.** Every top-level directory is scanned or set aside with
   a reason; failed scanners, lost shards and deferred work are reported as
   gaps. "No findings" is never printed where a finder died.
5. **Untrusted target.** Repository text is data, never instructions; it is
   fenced as `<untrusted-…>` in prompts and instruction-shaped text is filed as
   a `prompt-injection` finding.
6. **Language neutral core.** Scanner commands live in `data/stacks/*.json`,
   not in code. A missing/broken tool is recorded (`missing`/`failed`), never
   silently treated as clean.

## Layout of a review

```
<source>/.code-review/            # .gitignore = "*" ; never part of the evidence
  active.json                     # guard is strict only while a review is active
  accepted-risk.json              # human-only (REVIEW_HUMAN=1 via /review-accept)
  <name>/
    scope.json  REVIEW_SCOPE.md   # init (script)
    PREFLIGHT.md                  # model
    evidence.json                 # script: inventory, complexity, churn, hotspots, scanners
    scanners/<tool>.json          # script: raw tool output (secrets redacted)
    ASSESSMENT.md                 # model prose
    topology.json                 # model, validated by `review.ts validate-topology`
    plan/<stage>.json             # script: shards to run / deferred / skipped + estimate
    raw/<stage>/<shard>.json      # agents (Write, guarded) : {shard, filesRead, notReached, findings[]}
    THREAT_MODEL.md               # model
    findings.json                 # script (merge): deduped, fingerprinted, verdicts computed
    votes/<id>--<lens>.json       # verifier agents: {id, lens, verdict, severity?, note, evidence}
    coverage.json                 # script
    architecture.json             # model, validated (every rating needs evidence or is "unavailable")
    ANALYSIS_NOTES.md             # model prose
    ANALYSIS_REPORT.md ARCHITECTURE.md ROADMAP.md REPORT.html  # script renders
    findings.sarif findings.jsonl diagrams/*.mmd DIFF.md       # script renders
    REVISION.json                 # script: tree fingerprint at assess; report refuses if stale
    status.json usage.json        # script
```

Script-owned files (`findings.json`, `coverage.json`, `evidence.json`,
`REVISION.json`, `status.json`, `usage.json`, `plan/*`, renders,
`accepted-risk.json`) cannot be written by the model: the guard denies it.

## Stages (one fresh `claude -p` per stage under `/review-run`)

| stage | produces | gate (status.ts) |
|---|---|---|
| scope | scope.json | file valid |
| preflight | PREFLIGHT.md | exists |
| assess | evidence.json, REVISION.json, ASSESSMENT.md, raw/scanner/* | all exist |
| map | topology.json | validates |
| deep | raw/deep/* per plan/deep.json | every planned shard valid or lost-recorded |
| security | THREAT_MODEL.md, raw/security/* per plan/security.json | same |
| consolidate | consolidate/* per plan/consolidate.json | every planned group decided (or retried once) |
| verify | votes/* per plan/verify.json, findings.json | every finding has a verdict |
| architecture | architecture.json | validates |
| report | ANALYSIS_NOTES.md + renders | REVISION fresh, renders exist |

The driver computes plans itself (`review.ts plan`) before spawning deep,
security and verify, so the cost estimate and `--max-usd` check precede spend.
`plan` also writes one brief per task (`briefs/<stage>/<key>.md`: scope, output
path, JSON contract, fenced repository content) and compact workflow args
(`[key, agent]` pairs). The single workflow `review-tasks.js` dispatches one agent
per task (threat models first); each agent writes its own output file, which the
PostToolUse hook validates. Missing outputs are lost shards: retried once by the
driver, then reported as coverage gaps. Shards older than `REVISION.json` are
stale and re-run. `--from <stage>` forces that stage and the rest to re-run.

## Finding contract (raw → merged)

Raw (agent-written): `dimension, severity, confidence, file, line, title,
evidence, impact, recommendation, effort` + optional `end_line, symbol,
snippet, cwe, category, exploit_scenario, preconditions, attack_surface,
source (agent|semgrep|gitleaks|osv|…), rule_id`.

Merged (script): adds `id` (`<PREFIX>-<8 hex of fingerprint>`, stable across
runs), `fingerprint` (`v1:sha256(category|path|±3 normalised source lines)`),
`category` (CWE-1003 rollup for CWE-tagged findings, else dimension),
`reporters`, `verdict` (`confirmed|refuted|needs-human|deferred`), `votes`,
`accepted`, `also_reported_as`. Dedupe: (1) same path, same category, lines within 3
(script); (2) security-shaped non-security findings within 3 lines of a security
finding fold into it (script); (3) co-located findings across dimensions (same
file, lines within 5) are grouped by script and merged only on a consolidator's
validated decision (`keep` + `merge` ids from that group, with a root-cause reason).

## Guard (hooks)

Active only when `CODE_REVIEW_ACTIVE=1` (driver) or `<cwd>/.code-review/active.json`
exists, so installing the plugin never blocks ordinary editing elsewhere.

- Edit/Write: allowed only under `<cwd>/.code-review/<name>/` (or
  `$CODE_REVIEW_OUT`), resolved absolutely (no substring matching), never on
  script-owned files.
- Bash (seatbelt, not isolation): denies mutating git, package installs,
  `find -delete/-exec`, `sed -i`, and rm/mv/cp/tee/touch/mkdir/redirects whose
  target resolves inside the source tree outside the review dir; denies any
  command mentioning `REVIEW_HUMAN`.
- PostToolUse: raw shards, votes, topology and architecture are validated on
  write and the agent is told what to fix.

Run untrusted repositories in a sandbox/container anyway (SECURITY.md).

## Non-goals

No fixes/patches, no PR-diff mode, no telemetry, no network calls from the
core (scanner packs may use the network; it is recorded per tool).
