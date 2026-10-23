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
