---
status: accepted
date: 2026-10-17
area: [cross-cutting]
supersedes: []
superseded-by: null
---

# Pre-review draft pull requests before verify

## Context

Relay's `implement-issue` workflow used to run the full `pnpm run verify` in
`backend/` and `web/`, then open the pull request and hand it to the
`review-pull-request` workflow. Nearly every pull request then failed its first
review. On the bot revision pinned since 2026-10-15, about 85 % of first reviews
had blocking findings, about 2.2 medium-or-higher findings each. Each such review
started a separate `fix-review-findings` run in a fresh thread.

Measured over 20 such loops after 2026-10-16, one loop (findings verdict, fix,
next verdict) took a median 56 minutes. Of that, 48 were the fix run, and most of
the fix run was its own repeated verify. The hand-offs between workflows took
1–2 minutes. The fix also ran in a thread that had no memory of the
implementation, and 74 % of fixes led straight to a clean review.

Loading better skills before implementing did not change the first-review
finding rate: the implementing agents loaded them and still produced the same
kinds of findings. The cost is therefore not in what the agent knows. It is in
paying a full verify for every review round, and in a fixer without context.

## Decision

`implement-issue` reviews before it verifies:

1. After `implement`, the branch is pushed and a **draft** pull request opened.
   The GitHub Actions code-review job does not run on drafts, so only Relay's
   `review-pipeline` reviews it.
2. `pre-review-1` runs the pinned code-review bot on the draft. On findings,
   `self-fix-1` sends them to the **implementing thread**, which keeps its
   context and follows `fix-review-findings`. That thread reads the review
   through Access Hub. It fixes, replies to and resolves the threads, and
   commits. Relay pushes and runs `pre-review-2` and `self-fix-2` the same way.
3. The two rounds are unrolled, not a loop, so the step graph stays acyclic. Every
   exit continues to `verify-backend` and `verify-web`:
   - a clean review;
   - findings still open after round two;
   - a bot outage (`on-blocked`);
   - a fix that gives up (`on-failure`).
   Only then is the pull request labelled `review:ready` and marked ready.
4. `review-pull-request` stays the merge gate on the verified head. The bot's
   review memory and verdict reuse make that review incremental, as a re-review
   after a fix already is.

The `github-review-inputs` capture is not used here. On an issue run the subject
has no linked issue, so its identity check would always refuse. Capturing on
issue runs would need a change in the Relay plugin.

## Consequences

- A finding caught in pre-review costs one bot run and a fix, without a verify of
  its own. Fixes are made by the agent that wrote the code.
- Each pull request gets about one more bot run, roughly 2–4 USD.
- Code reaches the remote branch before verify, as a draft. Nothing marks it
  ready or labels it for review until verify passes.
- The pull request description is still the implement step's final answer.
  Self-fix rounds do not update it, so a description made stale by a fix can
  still draw a finding at the gate.
- The effect is measured the same way as before the change: first-review
  verdicts at the gate, blocked rounds and fix runs per pull request, and the
  time from implement to merge, over the next ~30 pull requests.
