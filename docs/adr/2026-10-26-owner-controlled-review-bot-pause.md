---
status: accepted
date: 2026-10-26
area: [cross-cutting]
supersedes: []
superseded-by: null
---

# The owner can pause automated review without disabling build and test gates

## Context

The repository owner requested a temporary pause of the code-review bot because its
provider weekly quota is exhausted. Waiting for the reset blocks otherwise verified
changes. The owner explicitly authorized local review and merge of PR #1292.

This is an owner-authorized exception to
[[2026-10-17-pre-review-draft-pull-requests-before-verify]]. Its normal pre-review and
fix flow remains in place when automated review is enabled. An alternative was to
remove the required review contexts from branch protection; that would require
separate settings changes to restore the original gate.

## Decision

`.relay/review-policy.json` contains the repository's `enabled` boolean and a
non-empty `reason`. The owner has set `enabled` to `false`. Re-enable automated
review by committing `enabled: true` and a corresponding reason. This is a tracked,
protected policy change, not an automatic response to a provider error.

Actions reads the policy from its checked-out PR head. When disabled, the required
`review` job publishes a completed `code-review` Check Run with conclusion `neutral`
and an explicit owner-pause explanation. It makes no model call and does not claim
that a review took place. The publishing step verifies the current PR head still
matches the checkout. Read failures, malformed policy, changed head and failed check
publication fail the job; they never become an implicit pause.

Relay's implementation flow reads the worktree policy after its protected-path
guard and skips pre-review only on an explicit disabled result, continuing to the
normal build/test pipeline. Its review flow reads the base-branch policy from an
isolated checkout. When disabled, it publishes the same named neutral check and
continues to the existing `review:passed` routing label. During this exception that
label means the review gate was waived, not that the bot reviewed the code.

The existing branch protections and required context names stay unchanged, as do
build/test verification, protected-path guards and conversation resolution. Neutral
checks satisfy the review status requirement and Relay's existing check waiter.
Missing or invalid policy stops Relay rather than starting a success path.

## Consequences

The repository can merge verified changes during the explicit owner pause. Automatic
review findings and independent review coverage are unavailable while it is active;
manual merges must include local review. The owner will restore the bot after quota
returns. Merely reaching the quota reset time does not change policy.

The policy takes effect for future Relay runs once it reaches the base branch;
already captured workflow runs retain their own graph. Actions picks it up on the
next PR update. Restoring it requires fresh checks on open PRs (push or dispatch the
Code Review workflow); historical neutral checks remain historical.
