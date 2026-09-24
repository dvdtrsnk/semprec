---
# Optional recovery workflow: one bounded worker run on a pull request that
# another Relay workflow parked with `agent:blocked` (merge-pull-request's
# or fix-review-findings' on-blocked chain, or a claim budget spent on it).
# It works the EXISTING pull request on its EXISTING branch — it has no
# `pull-request` step, so it cannot open a second one — and hands the new
# head back to the review workflow with `review:ready`.
#
# Why the trigger is `pull-requests`, not `issues`: a run started on an
# issue subject begins with no branch and no pull request (`branch: null`,
# `prNumber: null` in dispatchWorkflowRun.ts; subjectOf() in
# src/server/runs/context.ts only learns them from a `pull-request` step run
# by that same walk), so `workspace: pr-branch` would fail with "this run
# has no branch" and nothing in the format looks an issue's open pull request
# up. A pull-request subject carries its head branch and SHA from the
# listing, which is exactly what recovery needs. An issue parked by
# implement-issue has no pull request to recover in the first place (every
# step that can block there runs before `pull-request`), so labelling the
# issue is the right terminal for that workflow and this one leaves it alone.
#
# Bounds: a run that ends `escalate` (the worker has no credential for the
# needed action) or `blocked` walks the on-blocked chain below, which swaps
# `agent:blocked` for `agent:needs-human-action` — the trigger excludes that
# label, so the pull request is never dispatched to recovery again. A run
# that fails backs off and is retried on the same head until the claim
# budget (MAX_CLAIM_ATTEMPTS) is spent, after which the claim is parked for
# as long as the pull request carries a park label. Because `agent:blocked`
# is itself a park label, re-adding it after an escalation does not re-arm
# recovery on the same head by design: a human who has taken the action
# labels the pull request `review:ready` (review → merge) or pushes a new
# head, which replaces the claim.
#
# A draft pull request is never eligible for a pull-requests trigger, so a
# pull request parked while still a draft needs a human to mark it ready.
# That is also why the on-failure chain starts with `pull-request-ready`:
# the hand-off below converts the pull request to a draft before the push
# and marks it ready only once the new head is relabelled, so a failure in
# between (a refused force-with-lease push, a refused relabel) would
# otherwise leave a draft that no retry can ever pick up. The chain undoes
# the draft first, then comments; the retry it promises is real only while
# the claim budget lasts.
id: recover-blocked-issue
name: Recover blocked issue
priority: 60   # parked work: rarer than the rest, and worth unparking before another issue is begun
on:
  pull-requests:
    label: agent:blocked
    exclude-labels: [agent:needs-human-action, relay:needs-human-action]
steps:
  - id: pickup
    uses: comment
    body: "Relay picked up this pull request for automatic recovery on its existing branch `{{branch}}`."
  - id: recover
    uses: agent
    workspace: pr-branch                         # thread + BB worktree on the PR's existing branch
    prompt: "#recover"
  # a fresh BB worktree carries no node_modules, so each verify installs its own workspace first
  - { id: verify, uses: command, run: "pnpm install --frozen-lockfile && pnpm run verify", cwd: backend, on-failure: { goto: fix, max-rounds: 3 } }
  - { id: verify-web, uses: command, run: "pnpm install --frozen-lockfile && pnpm run verify", cwd: web, on-failure: { goto: fix, max-rounds: 3 } }
  - { id: guard, uses: guard-paths }
  - { id: draft, uses: pull-request-draft }
  - { id: push, uses: push, force-with-lease: true }   # before the relabel: a rejected push leaves agent:blocked in place, and on-failure lifts the draft, so the retry is eligible
  - { id: relabel, uses: labels, remove: [agent:blocked, review:passed, review:changes-requested], add: [review:ready] }
  - { id: ready, uses: pull-request-ready, on-success: end }   # the review workflow's own trigger picks the new head up
  - id: fix
    uses: agent
    workspace: pr-branch
    prompt: "#fix-verify"
    on-success: { goto: verify }
on-failure:
  - { uses: pull-request-ready }   # a draft is never eligible: undo the hand-off's draft so the retry below can happen
  - { uses: comment, body: "Relay's automatic recovery run failed; the pull request is not left as a draft. While it still carries `agent:blocked`, Relay retries recovery after a back-off until the claim budget for this head is spent; after that it stays parked until a human removes `agent:blocked` or pushes a new head.{{errorLine}}" }
on-blocked:
  - { uses: labels, remove: [agent:blocked], add: [agent:needs-human-action] }
  - { uses: comment, body: "Relay's automatic recovery could not proceed without a human action.{{errorLine}}\n\nOnce that action has been taken, remove `agent:needs-human-action` and label this pull request `review:ready` to send it through review and merge again (or push a new head)." }
  - { uses: comment, subject: linked-issue, body: "Automatic recovery of pull request #{{prNumber}} needs a human action — see the pull request.{{errorLine}}" }
---

## What this workflow does

A pull request another workflow parked with `agent:blocked` gets one worker
run on its own branch: the worker reads the pull request's Relay run log,
review threads and check state, fixes whatever stopped it (a conflict, a
failing check, review feedback), and Relay's deterministic steps verify,
push and relabel the pull request `review:ready`. The worker may end the run
`escalate` for the one case a human must handle; the on-blocked chain then
leaves `agent:needs-human-action` and recovery never picks the pull request
up again.

## prompt: recover

You are Relay's recovery worker for pull request #{{prNumber}} in {{repo}} (base branch {{baseBranch}}), which resolves issue #{{issueNumber}}: {{issueTitle}}. An earlier Relay run on this pull request got stuck and parked it with the `{{blockedLabel}}` label; your job is to get this EXISTING pull request back on track — never open a second pull request, never create, switch or rename branches. Your workspace is a BB-managed git worktree already checked out on the pull request's own branch, `{{branch}}`: stay on it.

What is known about why it got stuck: read the pull request's Relay run log (the comment that starts with `Relay run log`) — its last entries name the step that blocked and the reason — and its review threads. Failing checks on the current head and inline review comments:{{reviewFeedbackLine}}

Diagnose the actual blocker and fix it yourself: rebase onto `origin/{{baseBranch}}` and resolve conflicts (keep the intent of both sides, never take one side wholesale), address review feedback (reply to and resolve the threads you address), repair a broken check — whatever it takes, within your own permissions and this repository's tools. If a rebase or the `ci` check surfaces a duplicate migration ordinal under `backend/packages/data/src/db/migrations/`, renumber only this branch's migration to the next free ordinal — never renumber one that already merged into `{{baseBranch}}` (`.bb/skills/db-migrations/SKILL.md`, "Ordinal collisions between parallel issues"). Where a judgment call has more than one reasonable option, make the call yourself and say what you chose and why in your final answer — "I'm not sure which option is better" is never, on its own, a reason to stop. The ONLY thing that justifies stopping for a human is an action that cannot be performed with any credential available to you at all (e.g. a permission or access grant only a human holds, done through a UI you cannot reach). Never change anything under `.relay/` or `.github/workflows/` — those paths are protected and a change there blocks the run. Commit locally as you go; do not push — Relay's own steps run `pnpm run verify` in `backend/` and in `web/`, push this branch with force-with-lease and relabel the pull request after this turn. Run every command in the foreground and wait for its exit status; **never end your turn waiting to be notified that something finished**. Never expose credentials. Always answer in English — every message here is posted directly to GitHub as-is.

End your final answer with exactly one of: `Relay-Step-Status: pass` once the fix is committed and the pull request is ready to be re-evaluated; `Relay-Step-Status: escalate` if (and only if) the one case above applies, stating precisely what action is needed and why no credential you have can perform it; or `Relay-Step-Status: fail` with the reason if your turn itself failed for reasons unrelated to a judgment call (e.g. a tool crashed).

## prompt: fix-verify

`{{steps.failed.id}}` failed with exit code {{steps.failed.exitCode}}. Its output (last 200 lines):

```
{{steps.failed.outputTail}}
```

Fix the cause in this worktree, committing locally as you go. Run the failing command yourself in the foreground and wait for its exit status before you answer; never end your turn waiting to be notified that something finished. Do not push. End your final answer with `Relay-Step-Status: pass` once the command passes, or `Relay-Step-Status: fail` with the reason if you cannot make it pass. Answer in English — it is posted directly to GitHub.
