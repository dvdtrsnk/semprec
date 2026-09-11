---
status: accepted
date: 2026-09-10
area: [backend]
supersedes: []
superseded-by: null
---

# An agent's write identity is verified against a live Projects item, not trusted from the caller

## Context

Issue #87 needed a way to tell two concrete AI agents apart so that Agent A
cannot mutate a view Agent B created. Issue #30 established that every
agent run corresponds to a stable Projects module item — `agentProjectItemId`
— but nothing before this issue checked that identity against anything
before recording it as a view's owner. A caller-supplied
`agentProjectItemId` that names a deleted or nonexistent Projects item would
silently become an unwritable, un-adoptable orphan owner, and any actor
context library bug (or malicious client) could stamp an arbitrary UUID as
"the" agent identity with nothing to catch it.

`views.creator_project_item_id` cannot be a foreign key: `items` is
partitioned by database, so Postgres cannot enforce a cross-partition FK
here (see the choke-point/`items` schema). The check therefore has to run
in application code, at the same boundary that already validates everything
else about a choke-point write.

## Decision

Every choke-point call that would record or check `ai_agent` ownership
first calls `assertAuthenticatedAgentIdentity`, which:

1. Rejects an `ai_agent` actor with no `agentProjectItemId` at all
   (`403 owner_violation`, `reason: 'missing_authenticated_agent_identity'`).
2. Looks up that id as an item in the Projects module's database and rejects
   it if the item doesn't exist or is soft-deleted
   (`403 owner_violation`, `reason: 'unknown_authenticated_agent_identity'`).

This runs before any row or membership write, so an unverifiable identity
never gets a chance to become a stored owner. It is an application-layer
substitute for the FK Postgres can't express here — a live existence check,
not a snapshot, run fresh on every mutating call.

## Consequences

- Any future feature that records `agentProjectItemId` (or an equivalent
  concrete-agent identity) on a row should verify it the same way — via a
  fresh existence lookup against the Projects module at the choke-point
  boundary — rather than trusting the value the caller/actor context
  supplies.
- This is a per-call database read on every agent-originated mutating view
  call, accepted as the cost of not having a real FK across the partitioned
  `items` table.
- The check only proves the id names a live Projects item; it does not
  prove the calling process is authorized to *act as* that item. Caller
  authentication that produces `actor.agentProjectItemId` in the first place
  is a separate, existing concern outside this ADR's scope.
