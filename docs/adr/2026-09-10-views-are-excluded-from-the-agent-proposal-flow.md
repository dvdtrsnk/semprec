---
status: accepted
date: 2026-09-10
area: [backend]
supersedes: []
superseded-by: null
---

# Views are excluded from the agent-writes-are-proposals flow

## Context

[[2026-09-10-agent-writes-are-proposals-not-direct-writes]] requires every
agent-originated change to go through the approval/`confirm` flow rather
than write state directly. `views` (and their `view_items` curated
membership) predate that decision: an agent actor has always been able to
create, patch, delete, and reorder its own views' curated membership
through the choke point directly — `chokePoint.createView`/`patchView`/
`deleteView`/`addViewItem`/`removeViewItem`/`reorderViewItem` all accept an
`ai_agent` actor and commit immediately, with no proposal step.

Issue #87 (per-agent ownership of AI-created views) extends this
pre-existing direct-write path — it narrows *which* agent may write to
*which* view via `creator_project_item_id`, it does not introduce a new
direct-write surface. The issue's own Task and acceptance criteria describe
agents patching/deleting/reordering views directly, and its "Out of scope"
section explicitly excludes "Approval queues for editing another agent's
view." Without a recorded decision, this leaves the code and the proposals
ADR looking contradictory to any future reader.

## Decision

A view is an agent's own sandboxed workspace state — how it organizes and
looks at data it already has access to — not a proposal to change or create
*other* resources on the user's behalf. Direct agent writes to `views` and
`view_items` are therefore excluded from
[[2026-09-10-agent-writes-are-proposals-not-direct-writes]]'s proposal
requirement. That ADR's Decision and Consequences are otherwise unchanged
and continue to govern every other agent-originated write.

This exclusion is specific to views; it does not generalize to any other
resource. A future resource that is not an agent's own workspace state must
go through the proposal/approval flow.

## Consequences

- `chokePoint.createView`/`patchView`/`deleteView`/`addViewItem`/
  `removeViewItem`/`reorderViewItem` accepting an `ai_agent` actor and
  writing directly is not a violation of
  [[2026-09-10-agent-writes-are-proposals-not-direct-writes]] and is not,
  by itself, a review finding under that ADR.
- Ownership enforcement for these direct writes (which agent may write to
  which view) is a separate, narrower safeguard — see issue #87's
  `creator_project_item_id` ownership model — and does not by itself make
  the writes proposal-gated.
- Any new resource an agent can write to must be evaluated against whether
  it is genuinely the agent's own workspace state (view-like, this
  exclusion applies) or a change to a resource beyond that (proposal flow
  required) before assuming either precedent applies.
