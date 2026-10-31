---
name: review-guide
description: Reference for the code-review harness — the eight dimensions, severity x confidence rubric, verdict rules, finding contract and what each artefact means. Load before interpreting findings or explaining a report.
---

# Dimensions
architecture · security · quality (correctness/maintainability) · performance · testing · dependencies · operability · data (ownership, lineage, integrity).

# Rubric
- Severity = how bad if real (Blocker/Critical/High/Medium/Low/Nit). Confidence = how sure (high: executable code proves it; medium: strong inference; low: plausible).
- Roadmap order: severity → confidence → effort (quick wins first). Only `confirmed`, non-accepted findings enter it.
- Security verdicts: three lenses, ≥2 confirm → confirmed, ≥2 refute → refuted, else needs-human; final severity = median of confirming votes, never raised; `high` confidence only on 3/3. Incomplete panels → needs-human. Over-cap → deferred (coverage gap).
- Other dimensions: one independent verifier (different model tier); it may lower, never raise, severity.

# Duplicates
One defect is reported once: exact duplicates and security-shaped cross-dimension reports are merged by script; co-located findings from different dimensions are merged only when a consolidator decides they share a root cause (validated by script). Merged findings keep the worst severity and list what they were "also reported as".

# Artefacts (in `<source>/.code-review/<name>/`)
evidence.json (deterministic, tool-labelled) · scanners/ · topology.json · raw/ (agent shards) · votes/ · findings.json (script-merged: stable ids `SEC-1a2b3c4d`, fingerprints survive line shifts) · coverage.json · architecture.json · ANALYSIS_REPORT.md · ARCHITECTURE.md · ROADMAP.md · REPORT.html · findings.sarif · REVISION.json (tree fingerprint; render refuses when stale).

# Honesty rules
No `file:line`, no finding. Test-file ratio is a proxy, never coverage. A failed/missing scanner or lost shard is a gap, never "clean". Thresholds (god file ≥500 SLOC, long method ≥50 lines) mark candidates, not verdicts.
