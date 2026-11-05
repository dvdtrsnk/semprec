---
status: accepted
date: 2026-11-05
area: [backend]
supersedes: []
superseded-by: null
---

# Mail thread identity merges transfer existing relation values

## Context

Gh1573 makes each mail-thread row refer to a Threads item. Merging two thread
identities must preserve existing values, including protected properties and
edges to trashed counterparts. Ordinary relation creation rejects deleted
endpoints and requires the declared system writer. Impersonating each encountered
owner or updating relation endpoints directly would bypass ownership or the
INSERT-only cardinality trigger from migration0013.

This is a narrow structural handoff under
[[2026-09-10-choke-point-api-for-state-writes]],
[[2026-09-10-single-writer-ownership-model]] and
[[2026-09-24-choke-point-composed-from-domain-modules]]. It extends
[[2026-11-01-mail-thread-mutations-use-a-tenant-transaction-guard]];
existing accepted bodies remain unchanged.

## Decision

Mail's existing `reassignThread` remains the coordinator. Require the existing
managed READ COMMITTED tenant transaction and acquire its existing mail-thread
mutation guard first. Recheck source/winner thread rows and their distinct item
IDs in the tenant's same canonical Threads database. Lock both item rows in
ascending UUID order before planning edges. A missing, foreign, wrong-database,
trashed winner or otherwise broken binding fails the entire merge; do not create
replacement items or restore a user's trashed item. This local order is not a
global hierarchy for arbitrary preheld transactions.

Add only an internal supplied-client structural-transfer command in existing
`chokePoint/relationOps.ts`, with SQL primitives in `relationsStore.ts`. There is
no public facade/root export, client flag, new transaction opener, hook registry
or general item-merge framework. The command independently rechecks both item
identities in the same Threads database and the exact existing source edge. Its
explicit mail-thread structural handoff is separate from `ownerProcess`: it may
only replace the proved losing Threads endpoint with the proved winner, keeping
the definition and other endpoint. It cannot invent arbitrary values, change
another database's item identity, or forge the property's ordinary writer name.
No mail-domain import is introduced into the choke point. Ordinary create,
update, delete and permission checks are unchanged.

Acquire needed definition reservations in sorted definition-ID order, after
Threads item locks, before edge mutation. Lock/re-read actual source edges and
use their current metadata. Both source and destination databases remain checked;
a physically missing counterpart or schema inconsistency fails closed. A
counterpart that still exists in Trash may retain the transferred structural
reference without being restored. This exception preserves an existing value;
it does not allow ordinary creation against Trash.

Mail owns winner selection. For Threads.project/company, an existing winner
value takes precedence, including a retained value whose counterpart is trashed;
otherwise transfer the loser's value. For other incident relations transfer all
values. Normalize either A/B side from the actual definition, including incoming
one-directional edges. An existing destination tuple keeps its exact metadata;
a new tuple receives the exact source metadata. Do not overwrite a duplicate
with the loser's payload.

Delete the old tuple and INSERT the replacement inside the same transaction,
so restricted cardinality is checked against the actual final value rather than
bypassed with UPDATE or spuriously blocked by the old tuple. Use insert-if-absent
semantics for duplicates and retain typed cardinality failures. Preserve the
existing applicable delete/write/changed hooks, value-link break bookkeeping,
rollup enqueue and keyed after-commit invalidations through their existing
owners. A domain hook may reject the transfer; do not disable it to force a
merge. Any failure marks the managed owner rollback-only and rolls back the
whole merge, including earlier edge/message/alias work and callbacks, even if an
outer callback catches the error or rolls back a savepoint. Preserve the original
failure; no retry, compensation or broad error remapping.

After relation coordination, soft-delete the loser only through
`itemDeleteWithClient` with the existing `createActionQueueAffinity()` and system
writer identity. Move messages, write/repoint aliases and delete the losing
mail-thread row in the same transaction. No direct item soft-delete SQL. Keep the
public thread identity/alias contract; `item_id` remains internal.

The Threads project/company validating hook first identifies its exact module
and property. Only for the existing nil proposed-caller sentinel may it omit the
nonexistent caller's single-value lock/read. Upstream target/schema/permission
checks still run, and actual confirmation revalidates a real caller. Ordinary
real callers use the existing item FOR UPDATE; `lockMode: nowait` uses
`runValueLinkAdmissionLock(() => lockItemByIdNowait(...))`, preserving typed55P03,
value_link_busy and the enclosing rollback-only contract. No new hook API,
timeout, catch-all busy mapping or nonblocking prediction claim.

The existing failed-SMTP-claim cleanup may delete an empty mail-thread row.
Under the same guard, recheck its existing emptiness condition and binding,
soft-delete the associated Threads item through itemDeleteWithClient before
removing the eligible row. An adopted/nonempty thread keeps its item. Preserve
existing alias/FK and primary cleanup-error behavior; no physical item purge,
new alias deletion or SMTP-I/O transaction change.

## Consequences

This supports structural preservation for future protected Threads properties
without granting mail their ordinary business writes. Future hooks still own
their domain refusals. It does not promise global deadlock freedom or automatic
retries. Runtime-role evidence must discriminate normal same/different-target
writes, the exact nil preparation and confirmation, NOWAIT/caught/savepoint
rollback, merge precedence and duplicate metadata, opposite-side and protected
edges, trashed counterparts, cardinality/hook whole rollback, aliases, soft-delete
and committed effects. Keep generic protected writes forbidden. Historical
fixtures and static owner tracing are not execution evidence or acceptance.
