---
status: accepted
date: 2026-09-10
area: [backend, apple, web]
supersedes: []
superseded-by: null
---

# No abstraction, helper, or config flag beyond what the current issue asks for

## Context

Semprec is implemented by autonomous agents working a strictly sequential
queue of self-contained GitHub issues, one at a time
(`README.md`, `.claude/skills/work-issue/SKILL.md`). An agent implementing
one issue can always see a "better," more general version of what it's
building — an extra config flag, a generic helper for a case no issue has
asked for yet. Unlike a human team that might informally agree such things
are fine "since we're in there anyway," an unattended agent has no one to
push back in the moment, and speculative generality compounds silently
across a long sequential queue with no one reviewing the accumulated
architectural drift until much later.

## Decision

No new abstraction, helper, or config flag beyond what the current issue's
Task section asks for. This applies identically across all three platforms
(`backend/review-rules/rules.md`, `apple/review-rules/rules.md`,
`web/review-rules/rules.md`).

## Consequences

- A new abstraction, config flag, or generalization not required by the
  linked issue's Task section is flagged as scope creep (medium severity)
  by the automated review, not praised as forward-thinking design
  (`review-rules/tasks/architecture.md`).
- Genuine cross-cutting architecture (a new choke-point capability, a new
  gateway adapter, a new shared layer) still happens — it happens because
  an issue's Task explicitly asks for it, not as a side effect of an
  unrelated issue. A capability that's needed but not yet asked for waits
  for its own issue rather than being pre-built.
- This keeps each PR's diff auditable against exactly one issue, which
  matters more here than in a human team because the review is itself
  automated and issue-scoped (`review-rules/context.md`).
