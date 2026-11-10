---
status: accepted
date: 2026-11-03
area: [backend]
supersedes: []
superseded-by: null
---

# Execute mail moves outside transactions with durable step ownership

## Context

Gh-1746 adds provider moves to sync. Existing reconcile functions accept a
transaction client, and mailSyncJob encloses their entire invocation in a
transaction. Adding new move awaits there would extend locks across new
network work, which [[2026-11-01-mail-thread-mutations-use-a-tenant-transaction-guard]]
expressly did not authorize. Moving a remote message changes its identity;
discarding a stale response or repeating an uncertain command is not the pure
external computation considered by
[[2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions]].

## Decision

Add a private sync-owned move phase before the existing reconcile transaction.
Keep independently callable PoolClient reconcile signatures; they observe move
state and suppress stale edges, identities and flag writes, but do not secretly
start network moves. Existing reconcile provider awaits retain their existing
contract; this is not a redesign or endorsement of all sync transaction work.

Use short tenant READ COMMITTED transactions for claim/snapshot and outcome.
Acquire the existing thread guard before move row, membership/metadata and
related item locks. Snapshot all relevant mailbox/provider/source/target
identities, including IMAP UIDVALIDITY. Perform each bounded provider step
outside every enclosing database transaction, including new IMAP connection
open/close, with the shared connection limiter. Token acquisition retains its
existing separately owned credential transaction and privacy contract.

The new tenant move state additionally stores a monotonic desired revision,
a unique operation token and captured revision, an explicit durable step/phase,
and bounded validated provider-specific source/result evidence. Integers must
not silently lose precision at the database boundary. The representation may
use finite validated discriminated JSONB evidence, not arbitrary provider JSON,
MIME, credentials or a generic workflow framework. Claim a step atomically
under the move row lock and commit the in-flight marker before dispatch.
Only that token may record its outcome. Concurrent workers cannot dispatch it;
a job key, lease timeout or process disappearance is not remote fencing.

RecordDesired increments revision, resets the new desire's attempts/status,
and preserves any outstanding operation and its evidence. A newer desire,
including A-to-B-to-A, cannot be confirmed by an old operation. Persist a known
returned identity under source-identity compare-and-set and the established
guards even if desire changed; retain newer desire pending. Do not overwrite
a newer identity. A conflicting observation is retained as unresolved evidence,
not thrown away while claiming convergence. Reconcile/ingest/upsert/flag
participants must not recreate or target the stale source during outstanding
moves; inspect their actual lock order before introducing a new acquisition.
A concrete incompatible caller requires adjudication, not an asserted global
serialization guarantee.

Commit each acknowledged step and next safe continuation point before another
irreversible step. Another owner can resume a committed between-step state
only when no previous request can remain in flight. A known result followed
by SQL failure remains unconfirmed; the original durable in-flight marker
prevents a fresh remote submission. An in-memory result may be persisted
without repeating its provider call while its owner still has exact evidence.

Unknown acknowledgement, owner death while in flight or unproved remote
settlement leaves the operation blocked in-flight/uncertain. There is no
lease expiry, timer, new desired value or automatic restart that clears it.
A read-only observation alone does not fence an older still-running command.
This issue supplies no generic manual recovery/reset API. Arbitrary crash and
network-partition recovery is explicitly not guaranteed; a separately scoped
recovery protocol must establish quiescence and identity before release.
This fail-closed limit refines gh-1746's partial-retry acceptance contract.

Use provider-supported bounded evidence. Gmail has stable message ids and
observed labels; only established prior-step settlement permits continuation.
IMAP source identity includes folder and UIDVALIDITY; COPYUID verifies a
returned target UID. Missing COPYUID, ambiguous target identity or changed
UIDVALIDITY cannot authorize guessed flags/expunge or confirmation. In the
COPY fallback checkpoint the acknowledged copy before subsequent destructive
steps; do not repeat COPY after an uncertain result. Graph old-id 404 after a
possibly successful move is not proof of deletion. Persist a validated returned
new id; unsupported, incomplete or multiple candidate matches remain uncertain.
Do not implement a broad mailbox scan to invent identity or exactly-once proof.

The configured attempt limit applies to definite provider rejection/missing
outcomes with no earlier uncertain operation. Missing means a genuine bounded
provider lookup reports absence, not an arbitrary exception or an old id after
an uncertain move. Unknown outcomes never become a false missing diagnosis or
a falsely completed row. Purpose-already-matches needs verified identity and
location, then confirmation of the same revision without a provider write.

New move and necessary bounded observation calls get a private privacy boundary:
retain original/secondary values internally through actual settlement/cleanup,
then project unknown provider failures to fixed cause-free generic errors and
fixed durable reasons. Log closed stage/category and necessary trusted local
item ids only; never paths, arbitrary error name/code/text, tokens, MIME, upload
URLs or provider responses. Validate bounded HTTP/IMAP responses and pagination,
cancel/release/close owned resources, preserve genuine known status outcomes,
and attempt later cleanup even if diagnostics fail. SQL/domain/storage and token
acquisition stay outside provider catches. This standalone boundary does not
extend the older sync or SEND ADRs to unrelated operations.

## Consequences

Supported normal moves, known step continuation, revision races and same-purpose
no-op convergence have finite fake-provider and runtime-role overlap tests.
Tests must prove one dispatch for competing owners, unchanged newer desire,
actual observed identity persistence, blocked uncertain operations, partial
COPY/Graph/Gmail cases, rollback and no stale flags/edges, tenant separation,
and serialized privacy/cleanup. They do not prove live provider delivery or
universal recovery. The safety choice can leave an account's individual message
awaiting future explicit recovery after uncertainty; it must be disclosed in
handover and readiness evidence. Other messages/accounts can continue.

A broad sync transaction rewrite, lease-based blind retry and pretending local
rollback reverses a remote move were rejected. Existing accepted ADR bodies
remain unchanged.
