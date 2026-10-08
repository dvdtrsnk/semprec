---
id: fix-review-findings
name: Fix review findings
model-tier: high
priority: 70   # work already reviewed once — finishing it is worth more than starting something new
on:
  pull-requests:
    label: review:changes-requested
    exclude-labels: [agent:blocked, agent:needs-human-action, relay:needs-human-action]   # park labels are consumed by humans (plan §4.4)
steps:
  - id: fix
    uses: agent
    workspace: pr-branch                         # thread + BB worktree on the PR's existing branch
    prompt: "#fix"
  # a fresh BB worktree carries no node_modules, so each verify installs its own workspace first
  # a failed verify goes to fix-verify, not back to fix: re-sending #fix hands the worker the review findings it already
  # addressed and never the failing command's output, so every round ends "nothing left to fix" (#798, #822)
  - { id: verify, uses: command, run: "pnpm install --frozen-lockfile && pnpm run verify", cwd: backend, on-failure: { goto: fix-verify, max-rounds: 3 } }
  - { id: verify-web, uses: command, run: "pnpm install --frozen-lockfile && pnpm run verify", cwd: web, on-failure: { goto: fix-verify, max-rounds: 3 } }
  - { id: guard, uses: guard-paths }
  - { id: draft, uses: pull-request-draft }
  - { id: relabel, uses: labels, remove: [review:changes-requested, relay:needs-human-action], add: [review:ready] }
  - { id: push, uses: push, force-with-lease: true }
  - { id: ready, uses: pull-request-ready, on-success: end }   # the review workflow's own trigger picks the new head up
  - id: fix-verify
    uses: agent
    workspace: pr-branch
    prompt: "#fix-verify"
    on-success: { goto: verify }
on-failure:
  - { uses: labels, remove: [review:changes-requested], add: [relay:needs-human-action] }
  - { uses: comment, body: "Relay could not fix the review findings on this pull request.{{errorLine}}" }
on-blocked:
  - { uses: labels, remove: [review:changes-requested], add: [agent:blocked] }
  - { uses: comment, body: "Relay fix run is blocked.{{errorLine}}\n\nThe `recover-blocked-issue` workflow picks this pull request up on its existing branch while it carries `agent:blocked`; remove the label to stop that." }
---

## prompt: fix

You are Relay, an automated fix worker for pull request #{{prNumber}} in {{repo}} (base branch {{baseBranch}}). Your workspace is a BB-managed git worktree checked out on this pull request's branch: stay on it — never create, switch or rename branches. The code review requested changes; the inline findings are:{{reviewFeedbackLine}}

Address every finding: fix the code, reply to each review thread with what you changed, and resolve the threads you addressed. Keep the change scoped to the findings and the pull request's own intent. Never change anything under `.relay/` or `.github/workflows/` — those paths are protected and a change there blocks the run. Commit locally as you go; do not push — Relay's own steps run `pnpm run verify` in `backend/` and in `web/`, push this branch and relabel the pull request after this turn, so re-running a full verify yourself only doubles the round's wall-clock. If a verify command fails, its output comes back to you as a further message in this same conversation, so you keep full context. Run every command in the foreground and wait for its exit status; **never end your turn waiting to be notified that something finished**. End your final answer with `Relay-Step-Status: pass` once every finding is addressed, `Relay-Step-Status: fail` with the reason if you cannot, or `Relay-Step-Status: blocked` if a finding needs a decision only a human can make. Answer in English — it is posted directly to GitHub.

## prompt: fix-verify

`{{steps.failed.id}}` failed with exit code {{steps.failed.exitCode}}. Its output (last 200 lines):

```
{{steps.failed.outputTail}}
```

Fix the cause in this worktree, committing locally as you go. Run the failing command yourself in the foreground and wait for its exit status before you answer; never end your turn waiting to be notified that something finished. Do not push. End your final answer with `Relay-Step-Status: pass` once the command passes, or `Relay-Step-Status: fail` with the reason if you cannot make it pass. Answer in English — it is posted directly to GitHub.
