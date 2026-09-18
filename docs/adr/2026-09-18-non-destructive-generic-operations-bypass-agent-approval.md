---
status: accepted
date: 2026-09-18
area: [backend]
supersedes: []
superseded-by: null
---

# Non-destructive generic operations bypass agent approval

## Context

[[2026-09-10-agent-writes-are-proposals-not-direct-writes]] requires every
agent-originated change to go through the approval queue rather than write
state directly. Issue #252 defined `OPERATION_METADATA` for the 28-operation
generic catalog (`packages/shared/src/genericOperations/capabilities.ts`),
including a `requiresApproval`/`riskClass` field per operation, with only
`database.archive`, `property.delete`, `view.delete`, `item.delete`, and
`relation.delete` marked `requiresApproval: true`/`riskClass: "destructive"`
— every other operation, including `item.create`, `item.patch`, `view.create`,
and `viewItem.add`, is `requiresApproval: false`. That data had no consumer
for this catalog until now: #252/#219 only defined and stored it.

Issue #220's own Task section is explicit about what the first consumer must
do: "the shared invocation interceptor checks approval only when
`actor.agentProjectItemId` exists, using the `requiresApproval`/`riskClass`
descriptor data of #219" and "agent AgentTool/MCP calls marked destructive
insert #32's pending request... through #32's existing approval-request
writer." `GenericOperationGateway.invoke`
(`packages/application/src/genericOperationGateway.ts`) implements exactly
that: a full agent actor's call is queued for approval only when
`OPERATION_METADATA[operation].requiresApproval` is true; every other
generic-operation write a full agent actor makes — creating an item,
patching a view, adding a view item, restoring an archived database — commits
immediately, the same as a human actor's call.

Taken literally, [[2026-09-10-agent-writes-are-proposals-not-direct-writes]]
would make every one of those direct writes a review finding. That was never
the intent for this catalog: #219/#220 were scoped and reviewed against the
Task text above, which requires exactly this split. Without a recorded
decision, the code and the blanket proposals ADR read as contradictory to any
future reader — the same gap [[2026-09-10-views-are-excluded-from-the-agent-proposal-flow]]
and [[2026-09-10-diagnostic-notifications-are-not-agent-proposals]] already
closed for their own carve-outs.

## Decision

For the generic-operation catalog, an agent actor's write is exempt from
[[2026-09-10-agent-writes-are-proposals-not-direct-writes]]'s proposal
requirement exactly when `OPERATION_METADATA[operation].requiresApproval` is
`false` — i.e. every operation except the five `riskClass: "destructive"`
ones (`database.archive`, `property.delete`, `view.delete`, `item.delete`,
`relation.delete`). Those five, and only those five, still queue a pending
`approval_requests` row and return `ApprovalRequiredError` instead of
executing, per the unchanged ADR.

The line is "does this action destroy or hide data the user can no longer see
without a separate restore step," not "does this action touch user-owned
domain state." Creating an item, patching its properties, adding it to a
view, or restoring something already archived/deleted are all writes a human
can trivially inspect and undo (delete what an agent wrongly created, patch
it back, remove it from the view) after the fact — the cost of a mistake is
low and reversible. Archiving or deleting is comparatively one-directional
from the agent's own vantage point (the record leaves the surfaces the agent
and the approving human both see) and is exactly the shape of action this
catalog's own risk classification (`packages/shared/capabilities.ts`) singles
out as `"destructive"`.

This exclusion is specific to the generic-operation catalog's own
`requiresApproval`/`riskClass` classification, owned by #219/#252. It does
not generalize to any other write path, and it does not change that
classification's substance — which operations count as destructive remains
`capabilities.ts`'s decision, out of scope for this record to relitigate.

## Consequences

- `GenericOperationGateway.invoke` executing `item.create`, `item.patch`,
  `view.create`, `viewItem.add`, `database.restore`, and the other
  twenty-three non-destructive operations immediately for a full agent actor
  is not a violation of
  [[2026-09-10-agent-writes-are-proposals-not-direct-writes]] and is not, by
  itself, a review finding under that ADR.
- Adding a new generic operation, or changing an existing one's
  `requiresApproval`/`riskClass` in `capabilities.ts`, is a decision about
  that operation's own risk, made where the metadata lives — it doesn't need
  a new ADR each time, provided it stays inside this record's "reversible via
  a trivial follow-up write" vs. "one-directional" test.
- A future generic operation whose effect is not trivially undoable by a
  later write through the same catalog (a hard delete, an external side
  effect, a send-once action) must be classified `requiresApproval: true`
  rather than assumed safe by default — this carve-out is not a general
  license for new non-destructive-by-convention operations to skip approval.
- Any future write path outside this specific catalog (a different tool, a
  different transport) that wants the same executes-directly treatment needs
  its own decision record, not an appeal to this one.
