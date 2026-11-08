---
id: review-pull-request
name: Review pull request
model-tier: high
priority: 80   # a finished pull request waiting on its verdict; until it has one, nothing downstream of it can move
on:
  pull-requests:
    label: review:ready
    exclude-labels: [agent:blocked, agent:needs-human-action, relay:needs-human-action]   # park labels are consumed by humans (plan §4.4)
steps:
  - { id: claim, uses: labels, remove: [review:ready, relay:needs-human-action], add: [review:in-progress] }   # drops a stale park label from a prior failed round
  - { id: guard, uses: guard-paths }
  - id: review-policy
    uses: command
    in: checkout
    ref: base
    run: node .github/scripts/review-bot-disabled.mjs
  - id: review-paused
    uses: check-run
    if: "{{steps.review-policy.output}}"
    name: code-review
    conclusion: neutral
    summary: "Automated review is paused by the repository owner (.relay/review-policy.json). No bot verdict was produced. Build/test gates remain required. Set enabled to true in the policy to restore automated review."
    on-success: { goto: passed }
  - id: review
    uses: review-pipeline             # bot pin, check name and env come from config.yml's `review:` — one place to bump
    max-reruns: 2                     # timeout-minutes defaults to 150 for this step
  - { id: passed, uses: labels, remove: [review:in-progress], add: [review:passed] }
on-failure:                           # findings at/above the blocking severity
  - { uses: labels, remove: [review:in-progress], add: [review:changes-requested] }
on-blocked:                           # guard hit, or the pipeline could not run
  - { uses: labels, remove: [review:in-progress], add: [relay:needs-human-action] }
  - { uses: comment, body: "Relay could not review this pull request.{{errorLine}}" }
---

## What this workflow does

Runs the pinned code-review-bot revision against a pull request labelled
`review:ready`, exactly as CI would, and leaves one of `review:passed` or
`review:changes-requested` behind. It has no prompt sections: every model
call is made by the bot itself, through Relay's review broker.

While the owner pause is active, `review:passed` means the review gate was explicitly waived, not that the bot reviewed the code. The policy is read from the base branch; malformed or missing policy blocks this workflow.
