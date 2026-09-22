---
id: merge-pull-request
name: Merge pull request
on:
  pull-requests:
    label: review:passed
    exclude-labels: [agent:blocked, agent:needs-human-action, relay:needs-human-action]   # park labels are consumed by humans (plan §4.4)
steps:
  - { id: guard, uses: guard-paths }
  - id: rebase
    uses: rebase                                 # deterministic; no model involved
    on-failure: { goto: resolve, max-rounds: 2 } # conflict
  - id: requeue                                  # a rebased head must be reviewed again: draft FIRST, so the push below
    uses: pull-request-draft                     # never reaches CI's own code-review job on a ready pull request (§5.2)
    if: "{{steps.rebase.changed}}"               # skipped when already on top of base → checks
    on-success: { goto: relabel2 }               # → relabel → push → ready, at the end of the file
  - id: checks
    uses: wait-checks
    names: [ci, review, code-review, protected-paths]   # every required context on the base branch; keep in step with branch protection
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
  # a fresh BB worktree carries no node_modules, so each verify installs its own workspace first
  - { id: verify, uses: command, run: "pnpm install --frozen-lockfile && pnpm run verify", cwd: backend, on-failure: { goto: fix, max-rounds: 3 } }
  - { id: verify-web, uses: command, run: "pnpm install --frozen-lockfile && pnpm run verify", cwd: web, on-failure: { goto: fix, max-rounds: 3 } }
  - { id: rebased-check, uses: command, run: "git fetch origin {{baseBranch}} && git merge-base --is-ancestor origin/{{baseBranch}} HEAD", on-failure: blocked }
  - { id: guard2, uses: guard-paths }
  - { id: draft, uses: pull-request-draft }
  - { id: relabel, uses: labels, remove: [review:passed, review:changes-requested, relay:needs-human-action], add: [review:ready] }
  - { id: push, uses: push, force-with-lease: true }
  - { id: ready, uses: pull-request-ready, on-success: end }   # the review workflow's own trigger decides what happens next
  # --- after a clean rebase: same hand-off as the fix path (draft → relabel → push → ready), no agent involved
  - { id: relabel2, uses: labels, remove: [review:passed, relay:needs-human-action], add: [review:ready] }
  - { id: push-rebased, uses: push, force-with-lease: true }
  - { id: ready2, uses: pull-request-ready }
on-failure:
  - { uses: labels, remove: [review:passed], add: [relay:needs-human-action] }
  - { uses: comment, body: "Relay could not merge this pull request.{{errorLine}}" }
on-blocked:
  - { uses: labels, remove: [review:passed], add: [agent:blocked] }
  - { uses: comment, body: "Relay merge run is blocked.{{errorLine}}\n\nThe `recover-blocked-issue` workflow picks this pull request up on its existing branch while it carries `agent:blocked`; remove the label to stop that." }
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

This is one line per failing check — name, conclusion, link and the check's own summary — from `wait-checks`, or the merge step's reason (`unresolved-threads`, `behind`, `conflicted`, `protection`). It does not include review comments: when the failing check is `code-review`, or the reason is `unresolved-threads`, read the pull request's review threads and inline comments yourself before changing anything. Fix the cause in this worktree, committing locally as you go; reply to and resolve the review threads you address. Never change anything under `.relay/` or `.github/workflows/`. Do not push. Run every command in the foreground and wait for its exit status; never end your turn waiting to be notified that something finished. End your final answer with `Relay-Step-Status: pass` once the cause is fixed, or `Relay-Step-Status: fail` with the reason if you cannot fix it. Answer in English — it is posted directly to GitHub.
