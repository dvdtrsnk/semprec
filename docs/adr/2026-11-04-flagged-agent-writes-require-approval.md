---
status: accepted
date: 2026-11-04
area: [backend]
supersedes: []
superseded-by: null
---

# Flagged agent writes require approval

## Context

[[2026-09-18-non-destructive-generic-operations-bypass-agent-approval]]
exempts non-destructive generic operations from approval. Some otherwise
non-destructive writes can have effects that require a person's decision. The
write itself has the transactional context needed to identify such a case;
a gateway pre-check cannot substitute for that decision.

## Decision

A non-destructive generic write by an agent with a run is deferred when the
choke point flags that write inside its transaction. The write rolls back and
an approval request records a resource snapshot. An approved operation is
revalidated and replayed through the existing exactly-once mechanism in
[[2026-09-18-exactly-once-execution-of-approved-destructive-operations]].
An agent write without a run, including an MCP call using a human session,
is not deferred by this mechanism. User and system writes are not deferred.

The approved executor retains the agent writer identity. After locking the
approved request and revalidating its provenance and resource snapshot, it
passes that request's id as server-only `approvedRequestId` on the writer for
the one approved mutation. The managed-transaction deferral helper recognizes
that marker for this invocation. Ordinary actor conversion does not supply it;
it is neither client input nor an ambient or retained transaction setting, and
it is not propagated to unrelated nested writes. Hooks remain active on replay.

A plain `relation.set`, including replacement of an existing edge, is not a
flagged case: its risk class remains `write` and it executes immediately. All
other non-destructive generic writes remain immediate unless a write flags
them. Each issue introducing a flagged case records it in a new ADR narrowing
this decision. Issue #1758 owns the first planned case, a value-link break.
This decision does not introduce a production trigger.

## Consequences

The approval gateway must handle a transactional refusal as well as operations
marked for approval in the generic catalog. The snapshot is rechecked before
execution; a conflicting resource is not written. A domain error during that
revalidation terminalizes as conflict, except that the transient reservation
refusal in [[2026-11-04-approval-relation-snapshots-reserve-inserts-and-existing-rows]]
propagates for a fresh retry. A mutation-stage failure also escapes the
transaction, rolling back the write and its after-commit effects; the request
remains queued for the existing retry mechanism. The flagged cases and their
specific risk and description remain owned by the issues that introduce them.
