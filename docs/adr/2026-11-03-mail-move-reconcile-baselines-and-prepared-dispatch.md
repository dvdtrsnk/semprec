---
status: accepted
date: 2026-11-03
area: [backend]
supersedes: []
superseded-by: null
---

# Protect reconcile passes with move revisions and prepare authentication before claims

## Context

[[2026-11-03-mail-moves-use-durable-step-claims-outside-transactions]]
requires durable ownership before remote mutation, while preserving the existing
reconcile transaction and thread guard. A pending-only pass snapshot loses a
move created and completed after that snapshot. Checking only current pending
state cannot distinguish that completion from an unchanged completed row.
Separately, OAuth acquisition inside an already claimed step can fail before
any provider dispatch and strand a provably undispatched operation.

## Decision

At the start of a mailSyncJob pass, before draining moves, read a tenant/mailbox
baseline of existing move rows including completed rows. Retain validated desired
revisions and enough settled/unsettled state to distinguish an unchanged completed
row. Pending, in-flight, uncertain and between-step rows at baseline remain
protected for this pass. Under the existing thread guard, before applying provider
placement, identity or flag observations, also protect any move row absent from
the baseline or changed since it, including a newly completed desire. Do not
replace this check with the initial pending set or queue-key exclusivity.

Use the established READ COMMITTED guard order. Reconcile acquires that guard
before its provider reads and holds it through its existing transaction; move
record/claim/outcome writers already participate. The baseline comparison covers
completion before that acquisition, and outstanding-state checks cover a remotely
running step whose outcome awaits the guard. No new lock is introduced and no new
provider move is placed inside the reconcile transaction. Independently callable
PoolClient reconcilers remain compatible: when no owning-job baseline is supplied,
capture the appropriate baseline under their existing guard before their provider
observations. Thread-guarded ingestion still checks current outstanding state;
job/reconcile composition supplies the older pass baseline where required.

This is pass-local stale-observation protection, not a permanent ban on provider
changes after completed moves. An unchanged completed row at baseline permits
fresh later observations. Do not infer external quiescence, rewrite cursors or
introduce a durable general-purpose generation table. Deleting/recreating move
rows within a pass is not a supported producer operation; existing item/mailbox
lifetime guards remain applicable. Validate revision precision and tenant/mailbox
identity at the database boundary.

For each Gmail or Graph mutation step, including a resumed between-step Gmail
operation, acquire its OAuth token through the existing owner before claiming the
step. Prepare a private one-use command closure holding that token and validated
arguments. After successful preparation, claim in the existing short guarded
transaction, revalidating revision, operation and source/target identity, then
invoke the prepared command outside the transaction without another token lookup.
A lost claim discards the closure without dispatch. Preparation failure retains
its existing token/SQL error contract and leaves the unclaimed pending or known
between-step state unchanged. Do not expose tokens or closures through public
barrels, persist tokens in move state, cache them for future jobs or reset an
already in-flight operation on an arbitrary rejection. Once dispatch may occur,
the established uncertainty and no-blind-replay rules remain unchanged.

## Consequences

Actual job overlap tests cover an intent inserted after baseline and completed
by that pass's drain, another owner completing before reconcile acquires its guard,
and a still-running operation. Check placement/identity/flags across participating
providers and the positive case of an unchanged completed baseline. Runtime-role
controls retain exact owned operation barriers and outcomes. Preparation tests
exercise actual coordinator continuations with token failure, unchanged durable
checkpoint, no mutation fetch and later same-fixture success; token errors retain
their identities. Existing ABA, CAS, tenant and uncertain-result tests continue.
No live provider behavior, arbitrary owner-crash recovery or downstream route
implementation is established by these local controls.
