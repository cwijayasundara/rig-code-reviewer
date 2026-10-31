---
name: review-accept
description: Human-only — record an accepted risk for one finding (by id or fingerprint) with a reason. Accepted findings leave the roadmap and appear under Accepted risks; SARIF marks them suppressed.
argument-hint: <name> <finding-id> <reason...>
disable-model-invocation: true
allowed-tools: Bash(REVIEW_HUMAN=1 node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/review.ts accept:*)
---

!`REVIEW_HUMAN=1 node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/review.ts accept --raw '$ARGUMENTS'`

Relay the line above. Accepting risk is a human decision; never run this on your own initiative or re-run it with different arguments.
