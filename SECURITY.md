# Security

## Trust model
The repository under review is **untrusted input**. Its code, comments, READMEs, CLAUDE.md files, configuration and commit messages are data, never instructions. Agents report instruction-shaped text aimed at reviewers as a `prompt-injection` finding. Repository-derived content reaches agents only inside `<untrusted-…>` fences in script-written briefs.

**Run reviews of third-party or hostile repositories in a container or VM.** The hooks below are a seatbelt, not isolation: a determined payload in a repository could still target the tools an agent runs (e.g. a malicious git config or a scanner vulnerability).

## Guarantees enforced in code
While a review is active (`CODE_REVIEW_ACTIVE=1` from `/review-run`, or `<cwd>/.code-review/active.json` from a manual stage):
- **Writes** (`Edit|Write|MultiEdit|NotebookEdit`): allowed only inside `<cwd>/.code-review/` or `$CODE_REVIEW_OUT`, checked on absolute, symlink-resolved paths. Script-owned files (`findings.json`, `coverage.json`, `evidence.json`, `REVISION.json`, `plan/`, `scanners/`, renders, `scope.json`) and human-owned files (`accepted-risk.json`, `active.json`) are denied.
- **Bash**: mutating git, package installs, `find -exec/-delete`, in-place edits, `curl | sh`, and rm/mv/cp/tee/touch/mkdir/redirects into the source tree are denied; any command mentioning `REVIEW_HUMAN` is denied.
- **Headless stages** run with an explicit `--allowedTools` list (read-only Bash + the harness CLI) and `--max-budget-usd`.
- **Validation on write**: agent shards, votes, topology and architecture are validated; credential-shaped values are rejected.
- **Redaction**: every rendered output passes through `redact()`; gitleaks runs with `--redact` and no secret value or matched line is stored; SARIF/JSONL withhold snippets for hard-coded-credential findings.
- **Git** runs with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, no prompts, no optional locks.
- **Scanners** run without a shell, with a timeout, from a temp working directory. Network-using packs are labelled and skipped with `--offline`.

- **Out of reach by design** (documented, not hidden): commands run through an interpreter or substitution — `bash -c`, `sh -c`, `python -c`, `node -e`, here-docs fed to an interpreter, `$(…)` and backticks — are not parsed. The headless allowlist does not grant those interpreters, so under `/review-run` they need a permission the stage does not have; in an interactive session your own permission prompts are the barrier. Use a container for hostile code.
- **Human-only accept**: the model can neither run `review.ts accept` nor set `REVIEW_HUMAN` (quotes and escapes are normalised before the check); `/code-review-harness:review-accept` runs as a `!` pre-execution by the person, outside the model's tool calls.

Outside an active review the hooks do nothing. The active review is found by walking up from the working directory, so changing into a subdirectory does not switch the guard off. Plugin development bypass: `CODE_REVIEW_ALLOW_ALL=1`.

## Reporting a vulnerability in this harness
Report privately to the maintainers; do not open public issues for exploitable flaws in the guard, redaction or validation code.
