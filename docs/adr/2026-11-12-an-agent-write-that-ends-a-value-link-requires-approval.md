---
status: accepted
date: 2026-11-12
area: [backend]
supersedes: []
superseded-by: null
---

# An agent write that ends a value link requires approval

## Context

[[2026-11-04-flagged-agent-writes-require-approval]] lets the choke point defer a non-destructive agent write to approval, and leaves each flagged case, with its risk class, description and snapshot, to the issue that introduces it. It names the end of a value link as the first planned case, and it says a plain `relation.set` that replaces an edge is not flagged. A user or agent write that changes a linked value already ends the link (`broken`, with `broken_by`); without a decision here an agent would end a link, and the property would stop following its source, without anyone being asked.

## Decision

This narrows the two statements above for one case. An agent with a run (`agentRunId`) is deferred when its write would turn an `on` link into a broken one. The flag is raised inside the write's own transaction, after the written item or edge is locked and before the link is broken, and the transaction rolls back. The writes are:

- `item.patch`: a patched key whose stored value differs (deep equality) from the patched value and has an `on` link on that item.
- `relation.put`: an inserted edge (not a repeat of an existing one) when either side of the edge has an `on` link on its property.
- `relation.set`: an edge that is removed, by replacement or by clearing, when a side of a removed or an added edge has an `on` link. Writing onto an empty relation removes no value and is not deferred; the link still ends with `broken_by` agent.
- `link.unlink`: the unlink of a link that is still `on`; an unlink of a broken link stays the idempotent no-op. It becomes an operation that can be deferred and replayed, with its own snapshot kind `link_unlink`.

`relation.delete` is not a new trigger: it already requires approval, keeps the risk class `destructive` and its description, and only gains the same link lists. A user write, a system write and an agent write without a run (an `/mcp` call with a human session) are never deferred and still end the link, the last with `broken_by` agent. A write to a property without an `on` link is not deferred.

The choke point share-locks the `on` links it decided on (it waits for a concurrent holder, as the break that follows would), so a concurrent unlink waits until the write commits or rolls back. The check covers the links that exist when the write reads them; creating a link is not blocked.

The request of these four operations has risk class `breaksLink` and the description `approval.breaksLink`, which names the write that really runs (the property of the item set to the new value, a relation property written as that relation) and the link that ends with it. An owning module's own description of the write, such as the recurrence description, is kept. The lists `breaksLinks` (one entry per link and source) and `endsInheritance` (the active links that follow the broken property) are stored in the request's `description` and returned as top-level fields of the request views (`GET /api/approval-requests` and `/:id`). The `endsInheritance` entries are links that lose the value they took over through the broken one; they are not ended by the write.

The resource snapshot of these requests covers the affected links (id, rule key, sources) and, for `item.patch`, the stored values of the linked properties instead of the whole item and its version, so an unrelated change to the item does not invalidate the request. The exception is an item whose owning module contributes its own patch snapshot (the Tasks recurrence command): there the contributed snapshot is hashed together with the whole item and its version, next to the links and the values, so an unrelated change to that item does invalidate the request. The relation snapshots add the links to the edges they already cover. The `relation.delete` snapshot is unchanged and does not cover its links. The links are reserved without waiting; a held lock is the transient `ApprovalResourceBusyError` of [[2026-11-04-approval-relation-snapshots-reserve-inserts-and-existing-rows]]. A link the user removed, a source that was deleted or a value that changed makes the recomputed snapshot differ, and the approval ends as a conflict with nothing written. On a valid replay the approved executor's `approvedRequestId` lets the one mutation pass the flag, and the link ends with `broken_by` agent.

## Consequences

A `relation.set` by an agent under a run is no longer always immediate: it waits when it replaces or clears the edge of a linked relation. Choke-point code that writes an edge for an agent under a run gets the same decision as the gateway, because the decision is in the write. An operation that cannot be deferred has no snapshot to revalidate and no replay, so when its write is flagged the gateway refuses it with `validation_failed` (details: the reasons) and the transaction rolls back with nothing written and no request: the one such operation is `item.create` with initial relations that inserts an edge onto an item with an active link, and the agent writes the relation with `relation.put` instead. A user write and an `/mcp` call with a human session still create the item and end the link. The projection reproduces the decision from the operation's input; a module transform that changes the patch after the projection can make the write ask where the projection found no link, in which case the request carries no link lists and the replay still passes the flag. The links are locked after the item (`item.patch`, `link.unlink`) or the inserted edge (`relation.put`) is written, the order of the existing break, except that `relation.set` locks them after its caller item and before it deletes and inserts its edges. This is no guarantee against deadlocks with a writer that holds a relation definition lock and then breaks the same link, or with a propagation that locks a link first; [[2026-11-01-value-link-relations-use-nonblocking-admission-and-scoped-lock-waits]] records such cycles for the `valueLinks` handoff, which this decision does not change.
