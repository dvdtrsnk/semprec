---
status: accepted
date: 2026-10-30
area: [cross-cutting]
supersedes: [2026-10-26-owner-controlled-review-bot-pause, 2026-10-08-issue-metadata-selects-relay-model-tiers]
superseded-by: null
---

# Automated issue implementation and its review-pause and model-tier mechanisms are removed

## Context

Relay dispatched repository issues to agents, ran their review and merge
workflows, and read owner-controlled policy files and model-tier metadata to
decide how each run was staffed. The repository issue store
([2026-10-27-repository-markdown-issues-with-a-guarded-cutover](2026-10-27-repository-markdown-issues-with-a-guarded-cutover.md))
and the code-review bot outlived that dispatch machinery.

## Decision

The repository no longer contains:

- the Relay configuration, its workflows and its skills (`.relay/`,
  `implement-issue`, `fix-review-findings`, `triage-review-followups`);
- the review follow-up harvest, epic closure and protected-path workflows and
  their scripts;
- the owner review-pause policy file and its reader. This supersedes
  [2026-10-26-owner-controlled-review-bot-pause](2026-10-26-owner-controlled-review-bot-pause.md);
- the `**Model tier:**` line, its validator and its CLI. This supersedes
  [2026-10-08-issue-metadata-selects-relay-model-tiers](2026-10-08-issue-metadata-selects-relay-model-tiers.md).

The code-review bot stays in CI as the `review` and `code-review` checks. It
runs on every pull request without an owner pause. Build, test and mobile
checks are unchanged.

[2026-10-25-conditional-mobile-verification-in-ci-and-relay](2026-10-25-conditional-mobile-verification-in-ci-and-relay.md)
is only narrowed, not replaced: its CI jobs (`mobile-changes`, `mobile-android`,
`mobile-apple`) still apply, and its Relay `verify-mobile` step is removed by
this decision.

The issues CLI (`.github/scripts/issues.mjs`) keeps listing, validating,
creating and approving records. It gains `complete`, which closes an approved
implementation on its branch with a handover and a resolution. Relay's
completion guard and its PR header check are not restored.

## Consequences

- Nothing dispatches issues automatically. Implementation runs are started by
  hand or by a new mechanism that needs its own ADR.
- The bot cannot be paused by an owner file. A provider outage must be handled
  by re-running the review, not by a policy change.
- `docs/operations/required-checks.md` no longer describes a review pause or a
  Relay merge step.
