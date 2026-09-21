---
id: merge-pull-request
name: Merge pull request
on:
  pull-requests: { label: review:passed }
steps:
  - { id: guard, uses: guard-paths }
  - id: rebase
    uses: rebase                                 # deterministic; no model involved
    on-failure: { goto: resolve, max-rounds: 2 } # conflict
  - id: push-rebased
    uses: push
    force-with-lease: true
    if: "{{steps.rebase.changed}}"               # skipped when already on top of base
    on-success: { goto: requeue }                # a new head must be reviewed again
  - id: checks
    uses: wait-checks
    names: [ci, review, code-review]
    pending-timeout-minutes: 45
    on-failure: { goto: fix, max-rounds: 3 }
  - id: merge
    uses: merge
    method: rebase
    on-failure: { goto: fix, max-rounds: 2 }     # unresolved threads, protection
  - { id: notify, uses: comment, subject: linked-issue, body: "Resolved by #{{prNumber}}, merged into {{baseBranch}}." }
  - { id: cleanup, uses: archive-threads, on-success: end }

  # --- conflict path: the agent performs the rebase itself, with full context
  - id: resolve
    uses: agent
    workspace: pr-branch                         # thread + BB worktree on the PR's existing branch
    prompt: "#resolve-conflicts"
    on-success: { goto: verify }
  # --- CI / review-fix path
  - id: fix
    uses: agent
    workspace: pr-branch
    prompt: "#fix"
  - { id: verify, uses: command, run: pnpm run verify, cwd: backend, on-failure: { goto: fix, max-rounds: 3 } }
  - { id: verify-web, uses: command, run: pnpm run verify, cwd: web, on-failure: { goto: fix, max-rounds: 3 } }
  - { id: rebased-check, uses: command, run: "git fetch origin {{baseBranch}} && git merge-base --is-ancestor origin/{{baseBranch}} HEAD", on-failure: blocked }
  - { id: guard2, uses: guard-paths }
  - { id: draft, uses: pull-request-draft }
  - { id: relabel, uses: labels, remove: [review:passed, review:changes-requested], add: [review:ready] }
  - { id: push, uses: push, force-with-lease: true }
  - { id: ready, uses: pull-request-ready, on-success: end }   # the review workflow's own trigger decides what happens next
  # --- after a clean rebase push: same hand-off, no agent involved
  - { id: requeue, uses: pull-request-draft }
  - { id: relabel2, uses: labels, remove: [review:passed], add: [review:ready] }
  - { id: ready2, uses: pull-request-ready }
on-failure:
  - { uses: labels, remove: [review:passed], add: [relay:needs-human-action] }
  - { uses: comment, body: "Relay could not merge this pull request.{{errorLine}}" }
on-blocked:
  - { uses: labels, remove: [review:passed], add: [agent:blocked] }
  - { uses: comment, body: "Relay merge run is blocked and needs manual follow-up.{{errorLine}}" }
---

## prompt: resolve-conflicts

You are Relay, an automated merge worker for pull request #{{prNumber}} in {{repo}}. Your workspace is a BB-managed git worktree checked out on this pull request's branch. A deterministic `git rebase origin/{{baseBranch}}` hit conflicts in these paths:

```
{{steps.rebase.conflicts}}
```

Rebase this branch onto `origin/{{baseBranch}}` yourself (`git fetch origin {{baseBranch}}` then `git rebase origin/{{baseBranch}}`). For every conflict, read both sides and the commits that introduced them; keep the intent of both — this branch's change *and* what landed on the base — and resolve logically, never by taking one side wholesale. Continue the rebase until it completes. Never merge the base branch into this one, never create, switch or rename branches, and never change anything under `.relay/` or `.github/workflows/`. Do not push. Run every command in the foreground and wait for its exit status; never end your turn waiting to be notified that something finished. End your final answer with `Relay-Step-Status: pass` only when `git status` is clean and `git merge-base --is-ancestor origin/{{baseBranch}} HEAD` holds, or `Relay-Step-Status: fail` with the reason if you cannot complete the rebase. Answer in English — it is posted directly to GitHub.

## prompt: fix

You are Relay, an automated merge worker for pull request #{{prNumber}} in {{repo}}. Your workspace is a BB-managed git worktree checked out on this pull request's branch; stay on it. Step `{{steps.failed.id}}` failed:

```
{{steps.failed.outputTail}}
```

This is the failing check names and summaries (from `wait-checks`), the inline review comments when the failing check is `code-review`, or the merge step's reason (`unresolved-threads`, `behind`, `conflicted`, `protection`). Fix the cause in this worktree, committing locally as you go; reply to and resolve the review threads you address. Never change anything under `.relay/` or `.github/workflows/`. Do not push. Run every command in the foreground and wait for its exit status; never end your turn waiting to be notified that something finished. End your final answer with `Relay-Step-Status: pass` once the cause is fixed, or `Relay-Step-Status: fail` with the reason if you cannot fix it. Answer in English — it is posted directly to GitHub.
