---
id: review-pull-request
name: Review pull request
on:
  pull-requests: { label: review:ready }
steps:
  - { id: claim, uses: labels, remove: [review:ready], add: [review:in-progress] }
  - { id: guard, uses: guard-paths }
  - id: review
    uses: review-pipeline
    bot: { repo: dvdtrsnk/code-review-bot, ref: fc7d3fe86c6c0a6a7d1c63f5378846d96fba3982 }
    check-name: code-review
    env: { REVIEW_BLOCK_SEVERITY: medium, PROMOTION_SOURCE: develop, PROMOTION_TARGET: main }
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
