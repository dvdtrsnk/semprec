---
status: accepted
date: 2026-09-10
area: [backend]
supersedes: []
superseded-by: null
---

# AI/agent code never writes state directly — it proposes, a human or grant confirms

## Context

Semprec's agent runtime (`pi-agent-core`) can act through defined,
structured mechanisms including MCP tools and heartbeats that run
unattended. An agent that can write persisted state directly, the same way
a human-initiated request does, has no point at which an unwanted or
mistaken action can be caught before it takes effect — this is the exact
"tell the AI to do a lot and hope it works out" model the project's own
README names as what Semprec is deliberately not.

## Decision

Agent-originated changes are never direct writes. They are *proposals* that
go through the approval queue / `confirm` flow, where a logged-in user or an
explicit pre-authorized grant turns the proposal into a real write inside
`confirm`'s own transaction. An agent tool or heartbeat that "should update
X" creates a proposal card / approval request, never a direct call to a
write endpoint or the data layer.

## Scope: agent-owned views are excluded

`views` (and their `view_items` curated membership) are the one resource an
agent actor writes to directly through the choke point —
`chokePoint.createView`/`patchView`/`deleteView`/`addViewItem`/
`removeViewItem`/`reorderViewItem` all accept an `ai_agent` actor and commit
immediately, with no proposal/approval step. This predates this ADR: views
already recorded `created_by = 'ai_agent'` via a direct write before this
decision was written down, and issue #87 (per-agent view ownership) extends
that pre-existing direct-write path rather than introducing a new one — its
Task and acceptance criteria describe agents patching/deleting/reordering
views directly, and its "Out of scope" section explicitly excludes
"Approval queues for editing another agent's view."

The distinction that keeps this consistent with the Decision above: a view
is an agent's own sandboxed workspace state — how it organizes and looks at
data it already has access to — not a proposal to change or create *other*
resources on the user's behalf. Issue #87 narrows *which* agent may write to
*which* view (per-owner enforcement via `creator_project_item_id`); it does
not widen what agents may already write directly.

Any future resource that is not an agent's own workspace state must go
through the proposal/approval flow this ADR describes — this carve-out is
specific to views and does not generalize.

## Consequences

- This separation of suggestion from write is what makes it safe to let
  agents run unattended (heartbeats, background processing) — the worst an
  unsupervised agent run can do is create proposals that a human never
  approves.
- Agent code calling a write endpoint or the data layer directly is a
  high-severity review finding regardless of whether the write itself would
  have been correct (`review-rules/rules.md`,
  `review-rules/tasks/architecture.md`) — same principle as
  [[2026-09-10-single-writer-ownership-model]]: the violation is structural.
- Every agent-driven feature needs a proposal/approval UI surface, which is
  more product surface area than "the agent just does it," in exchange for
  keeping unattended AI action reversible and auditable.
