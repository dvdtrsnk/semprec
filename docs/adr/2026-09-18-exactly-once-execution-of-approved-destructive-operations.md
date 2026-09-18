---
status: accepted
date: 2026-09-18
area: [backend]
supersedes: []
superseded-by: null
---

# Exactly-once execution of approved destructive operations via resource-snapshot revalidation

## Context

[[2026-09-18-non-destructive-generic-operations-bypass-agent-approval]] keeps
the five destructive generic operations (`database.archive`, `property.delete`,
`view.delete`, `item.delete`, `relation.delete`) inside
[[2026-09-10-agent-writes-are-proposals-not-direct-writes]]'s approval queue: a
full agent actor's call queues a pending `approval_requests` row instead of
executing. Before issue #89, replaying an approved request
(`replayApprovedGenericOperation`, formerly a thin binding-replay call) had no
protection against the resource having changed between the moment a human
granted approval and the moment the queued `approvalExecute` job actually ran
— an approver could authorize deleting item A as they saw it, only for a since
-edited or already-deleted item A to be deleted (or silently no-op) without
the approver ever having seen what they were actually approving. Nor did a
redelivered queue job (graphile-worker's own retry, or two workers racing the
same job) have anything ruling out a second, real execution of an
already-executed destructive mutation — the pre-#89 `executed_at IS NULL`
claim (`claimApprovalRequestExecution`) existed for the non-destructive
mcpInvoke path and was reused for generic operations only as a stopgap, per
its own doc comment.

Issue #89's Task requires both of these closed at once: an approved request
must execute *exactly once*, and it must execute only against the resource
shape the approver actually saw. A plausible alternative — re-running the
same authorization checks the choke-point already runs on direct writes, with
no persisted record of what was authorized — cannot distinguish "the resource
is still fine" from "the resource changed to something that happens to still
pass the checks"; only comparing against a snapshot taken *at approval time*
catches the latter.

## Decision

**Resource-snapshot hashing.** `computeDestructiveResourceProjection`
(`packages/data/src/chokePoint/chokePoint.ts`) is the single authorization-and
-projection function both approval-request creation and later execution call:
it runs the same existence/ownership/locked/archived checks the direct
`*WithClient` mutation would run, and returns a deterministic `{ kind,
resourceId, sha256 }` snapshot hashed off a read-only projection of the
resource. `DestructiveApprovalPreflight` persists that snapshot on the
`approval_requests` row at request time; `ApprovedOperationExecutor`
recomputes it at execution time and requires an exact match before mutating
anything. A mismatch (or any authorization failure the same checks now
raise) terminalizes the request as `conflict` rather than executing — the
approver's decision is never carried out against a resource they didn't
actually see.

**A two-phase preflight/executor state machine**, independent of the human
decision (`approval_requests.status`): a new `execution_status` column
(`not_approved -> queued -> succeeded | conflict`, plus `legacy_terminal` for
rows that predate the protocol) tracks exactly-once execution separately from
approve/reject. `ApprovedOperationExecutor`
(`replayApprovedGenericOperation`) opens one transaction, row-locks the
request, and is idempotent by construction: a request already in a terminal
`execution_status` returns its persisted result unmutated instead of
re-authorizing or re-executing, so a redelivered `approvalExecute` job is a
safe no-op rather than a second mutation. The mutation itself and the
`succeeded` terminal write happen inside that same locked transaction and
commit together — a crash before commit leaves the row `queued` for
graphile-worker's own retry, a crash after commit has nothing left to redo.

**A cross-package `*WithClient` contract.** Each destructive operation's
choke-point mutation is factored into a `*WithClient` function
(`databaseArchiveWithClient`, `propertyDeleteWithClient`, `viewDeleteWithClient`,
`itemDeleteWithClient`, `deleteRelationWithClient`) that takes an already-open
`PoolClient` instead of opening its own transaction. The choke-point's public
API (`packages/data`) calls these directly for an immediate write; `packages/
application`'s `genericOperationGateway.ts` calls the exact same functions,
on its own transaction and client, from inside `ApprovedOperationExecutor` —
so an approval-gated execution and a direct call share one mutation
implementation, never two. `packages/application` may call a `*WithClient`
function exported from `packages/data`'s public facade for this purpose, but
still owns no `approval_requests` write itself: every write to that table
goes through `approvalRequestsStore.ts`'s own exported functions (per
[[2026-09-10-single-writer-ownership-model]]), never a raw SQL statement
issued from `packages/application`.

## Consequences

- Adding a sixth destructive operation to the generic catalog means adding a
  case to `computeDestructiveResourceProjection`'s switch (the projection to
  hash) and a `*WithClient` function for its mutation — not inventing a new
  approval/execution mechanism.
- Any code outside `approvalRequestsStore.ts` that needs to transition
  `approval_requests.execution_status` needs a new exported store function for
  that transition, never a raw `UPDATE approval_requests` of its own — the
  same rule [[2026-09-10-single-writer-ownership-model]] already states, made
  concrete for this table's two new terminal states.
- A resource-snapshot mismatch is reported as `conflict`, not silently
  executed against the resource's new shape and not silently treated as
  success — a future destructive operation's projection must include every
  field whose drift should block replay, since only fields the projection
  captures affect the hash.
