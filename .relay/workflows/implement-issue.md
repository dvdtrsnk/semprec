---
id: implement-issue
name: Implement issue
priority: 20   # the only step that creates new work in flight, so it goes last: a full queue must never starve the four above
on:
  issues:
    label: agent:ready
    exclude-labels: [agent:blocked, agent:needs-human-action]
    respect-blocked-by: true          # "Blocked by: #12" line in the body
    skip-if-open-pull-request: true   # the duplicate-PR guard
worker: any                           # or a worker preset name; must be in project.workerIds
max-concurrent: 5                     # batches decompose as a dependency DAG (docs/adr/2026-09-24-issue-batches-as-dependency-dags.md); the choke-point-split batch routinely has 4-7 issues eligible at once
protected-paths: [".relay/**", ".github/workflows/**"]
steps:
  - id: pickup
    uses: comment
    body: "Relay picked up this issue for a BB worker run."
  - id: implement
    uses: agent
    prompt: "#implement"              # section heading in the body
  - id: verify-backend
    uses: command
    run: "pnpm install --frozen-lockfile && pnpm run verify"   # a fresh BB worktree carries no node_modules
    cwd: backend                      # timeout-minutes defaults to 120
    on-failure: { goto: fix, max-rounds: 3 }
  - id: verify-web
    uses: command
    run: "pnpm install --frozen-lockfile && pnpm run verify"
    cwd: web
    on-failure: { goto: fix, max-rounds: 3 }
  - id: guard
    uses: guard-paths
  - id: push
    uses: push
  - id: pr
    uses: pull-request
    draft: true
    title: "{{issueTitle}} (#{{issueNumber}})"
    body: "Closes #{{issueNumber}}\n\n{{steps.implement.output}}"
  - id: label
    uses: labels
    add: [review:ready]
  - id: ready
    uses: pull-request-ready
    on-success: end                   # the review workflow's own trigger takes it from here
  - id: fix
    uses: agent
    prompt: "#fix-verify"
    on-success: { goto: verify-backend }
on-failure:
  - { uses: comment, body: "Relay run failed.{{errorLine}}" }
on-blocked:
  - { uses: labels, add: [agent:blocked] }
  - { uses: comment, body: "Relay run is blocked and needs manual follow-up — it will not be retried automatically.{{errorLine}}\n\nRemove the `agent:blocked` label from this issue once it's addressed to let Relay pick it up again." }
---

## prompt: implement

You are Relay, an automated issue worker. Repository: {{repo}}; base branch: {{baseBranch}}; issue #{{issueNumber}}: {{issueTitle}} ({{issueUrl}}). Work only on this issue. Load the `implement-issue` skill first and follow its contract — it is this repository's execution contract for one issue (what to read, which topic skills to load, how to self-review and verify) — and load the other skills it names for what the Task touches. Your workspace is a BB-managed git worktree that is already checked out on the branch this run ships on: stay on it — never create, switch or rename branches — because BB links this thread's pull request and diff to that checked-out branch. Inspect the repository and implement the change, committing locally as you go; everything you want shipped must be committed on this branch before you answer, because the steps after you read the worktree's `HEAD`. Do not push and do not open a pull request — Relay's own deterministic steps do that after this turn: they run `pnpm run verify` in `backend/` and in `web/`, push your branch and open the pull request from it. If a verify command fails, its output comes back to you as a further message in this same conversation, so you keep full context. Finish the implementation within this turn. Run every command in the foreground and wait for its exit status. **Never end your turn waiting to be notified that something finished** — not a background command, not a monitor, not a scheduled wake-up, not a queued job. If something is already running in the background, wait for it here, before you answer. Relay reads the end of your turn as the end of this step, so ending it to wait reports an unfinished step and Relay retries the whole step from the start; three of those fail the run. A turn that takes a long time is fine. A turn that ends early is not. Never change anything under `.relay/` or `.github/workflows/` — those paths are protected and a change there blocks the run. End your final answer with `Relay-Step-Status: pass` once the implementation is complete and committed, `Relay-Step-Status: fail` if you genuinely cannot implement it (with the reason), or `Relay-Step-Status: blocked` if the issue cannot be implemented without a decision or a permission only a human can give. Never expose credentials. Always answer in English, regardless of the language of the issue or any other context — every message in this conversation is posted directly to GitHub as-is, and your final answer here becomes the pull request description.

## prompt: fix-verify

`{{steps.failed.id}}` failed with exit code {{steps.failed.exitCode}}. Its output (last 200 lines):

```
{{steps.failed.outputTail}}
```

Fix the cause in this worktree, committing locally as you go. Run the failing command yourself in the foreground and wait for its exit status before you answer; never end your turn waiting to be notified that something finished. Do not push. End your final answer with `Relay-Step-Status: pass` once the command passes, or `Relay-Step-Status: fail` with the reason if you cannot make it pass. Answer in English — it is posted directly to GitHub.
