# Contributing

- Node ≥ 22.18, no runtime dependencies. `npm install` (dev types only), then `npm run check` (typecheck + tests) and `npm run validate`.
- **Models advise, scripts decide.** Counts, verdicts, merges, plans and renders live in `scripts/lib/*` behind `scripts/review.ts`; skills stay thin prompts (≤ 60 lines) that call the CLI.
- Every gate needs a test that makes it fail (`tests/invariants.spec.ts` selftest). New stages need a stub case in `tests/fixtures/stub-claude.ts` so the $0 end-to-end test covers them.
- Prompt or agent changes: run `npm run eval:dry`, then a capped live eval (`node --disable-warning=ExperimentalWarning eval/run.ts --live --max-usd <cap>`), and only tighten `eval/baseline.json`, never loosen it without a recorded reason.
- Keep files small (scripts ≤ 500 lines, skills/agents ≤ 60) — enforced by tests.
- Regenerate CWE data with `scripts/tools/build-cwe.ts` from MITRE's published XML; never copy third-party derived data.
- Bump the version in `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `package.json` and `CHANGELOG.md` together (a test checks they agree).
