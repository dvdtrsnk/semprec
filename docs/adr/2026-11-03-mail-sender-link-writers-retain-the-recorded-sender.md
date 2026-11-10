---
status: accepted
date: 2026-11-03
area: [backend]
supersedes: []
superseded-by: null
---

# Mail sender-link writers retain the recorded sender

## Context

Gh-1457 deliberately uses many-to-many relation storage so a person can send many
messages, while module writers retain one sender per message. Gh-1571 preserves
historical edges after an address is removed. Reassigning that address must not
both retain its old sender and add a new sender to the same message. A per-person
duplicate check does not establish this rule, and an unlocked empty-edge read can
race another participating writer.

## Decision

For the shared linkEmailEnvelopeToPeople writer (arrived-mail heartbeat and sent
mail finalization) and gh-1571's historical-link job, any existing senderPeople
edge on a message prevents adding another sender edge, even when current address
ownership points to a different person. Preserve existing edges; do not replace,
remove or reinterpret a historical sender when an address changes ownership.
Recipient links retain their many-person, duplicate-edge-idempotent behavior.

These participating writers use the caller-owned managed withTransaction at
READ COMMITTED and the existing itemsStore.lockItemById FOR UPDATE on the Emails
item before reading its sender edges. Retain that row lock through the existing
createRelationWithClient call and caller commit/rollback. Recheck live/deleted
item state from the locked row. Reject unsupported unmanaged transactions or
isolation before relying on this protocol; do not open another transaction. At
READ COMMITTED a later holder reads committed sender edges after acquiring the
item lock, so an earlier empty observation cannot authorize a second edge.

For gh-1571 retain its existing ordered current-index FOR SHARE acquisition before
the page's per-message lock; process message ids in keyset order. A shared linker
may already hold the item lock through its caller's write. This decision introduces
no new advisory guard, mail-thread guard, table constraint or queue mode. Do not
acquire the tenant mail-thread guard inside this linker. Keep send's provider call
and its existing finalization phases unchanged: no new external work occurs under
this row lock. Unexpected SQL, deadlock, rollback and cleanup failures remain
failures under the existing retry/identity rules.

This narrows sender eligibility alongside
[[2026-11-03-person-mail-link-jobs-reconcile-current-index-ownership]] and uses the
transaction owner of [[2026-09-29-withtransaction-is-the-sole-transaction-opener]].
Neither accepted record's body changes.

## Consequences

A reassigned address can link an as-yet-unlinked message to its current owner, but
cannot replace a message's earlier recorded sender. Recipient history can retain
multiple people after ownership changes. Pre-existing malformed multiple sender
edges are preserved without adding another, not silently repaired. The guarantee
covers these participating module writers; arbitrary SQL, old binaries and other
relation writers are not fenced by this contract. No general deadlock-freedom or
unbounded-progress guarantee is made.

Finite runtime-role controls must cover retaining A after reassignment to B,
linking an unlinked message to B, recipient behavior and replay. One controlled
same-message job/shared-linker overlap must show actual owned backend blocking,
settlement and exactly one final sender; preserve failure cleanup. Test managed
transaction/isolation admission without a new production test hook or a broad
concurrency matrix. These are required evidence, not claims of completed tests.
