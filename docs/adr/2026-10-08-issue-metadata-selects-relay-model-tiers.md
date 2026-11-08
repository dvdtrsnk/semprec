---
status: accepted
date: 2026-10-08
area: [cross-cutting]
supersedes: []
superseded-by: null
---

# Issue metadata selects Relay model tiers

## Context

Issue bodies are the implementation contract. Relay runs repository-defined
workflows, while operators configure actual BB provider/model worker presets.
Hardcoding model IDs into issues would couple specifications to provider versions;
using labels or free-form prose would create multiple conflicting routing sources.

## Decision

Implementation issues carry the canonical physical second-line `**Model tier:**`
metadata after their unchanged Blocked-by line, with exactly `low`, `medium` or
`high`. `.github/ISSUE_FORMAT.md` owns the grammar and estimation rubric. An
English Context rationale records the estimate; runtime ignores its prose.
Creation, audit and follow-up publication validate the same pure parser.
Epics and harvest payloads do not implement work and are exempt.

Workflow `model-tier` may be fixed or read issue/uniquely linked issue metadata.
Relay filters allowed workers by exact tier and freezes the effective model on
admission. Missing metadata or capacity holds work without attempts or silent
cross-tier fallback. Review runs explicitly use high; review cache identity
includes the effective execution configuration and pinned bot revision.

## Consequences

Model versions can change in presets without editing specifications. Existing
issues need a reviewed metadata-only backfill before dynamic dispatch is enabled.
Difficulty estimates may be revised by maintainers; running agents preserve the
admitted model and do not rewrite their own classification. Runtime validation
proves format, while model difficulty disagreements remain advisory.
