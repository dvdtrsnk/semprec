---
status: accepted
date: 2026-11-01
area: [backend]
supersedes: []
superseded-by: null
---

# Coordinate mail thread mutations within a tenant transaction

## Context

Gh-1474 threads an outgoing message in its pre-SMTP claim transaction and removes
that claim after an SMTP failure. Reproduced concurrent sends show two failures:
a reply's foreign-key reference can make empty-thread cleanup fail and roll back
the failed claim's removal, or cleanup can remove a thread after another resolver
selected it but before that caller inserts its reference. The foreign keys prevent
dangling references; they do not preserve the claim/retry contract.

Resolution can merge multiple threads and aliases. Backfill processes multiple
resolutions within one page transaction. Sorting locks within each resolver call
would not establish a transaction-wide order and would need additional discovery,
alias re-resolution and retry rules.

## Decision

Participating mail thread/member/alias decisions and mutations use a
transaction-scoped advisory guard with key
`mail-thread-mutation:v1:<lowercase tenant UUID>`, hashed with
`hashtextextended($1::text, 0)`. The helper accepts a transaction's `PoolClient`,
requires a real tenant scope before any lock query and rejects other isolation
levels than READ COMMITTED with a fixed diagnostic. Pool auto-commit calls and
system/missing scopes do not satisfy this contract. The caller owns the existing
transaction; the helper neither begins nor commits one. No generic transaction
infrastructure is introduced.

Acquire the guard before membership reads, thread resolution, metadata row locks
or alias mutations. Keep resolution and its thread-bearing metadata upsert in the
same guarded transaction. The resolver, compensating cleanup and direct merge
boundaries guard their work. Backfill acquires first in both page transactions,
before candidate reads and before `lockMailMessageThreads`. Legacy migration
acquires first in its per-item transaction; raw MIME fetching stays outside.
Ingest acquires at entry before its existing-message read and provider-conflict
savepoint, so rolling back to that savepoint does not release the outer guard.
IMAP account and independently callable folder reconciliation, Gmail and Graph
acquire at entry before state, folder or item locks. Gmail takes the tenant thread
guard before its existing mailbox folder-state guard; Gmail pseudo-folder cleanup
does not start acquiring the thread guard.

SMTP cleanup acquires before reading/deleting the claim. Claim deletion and the
subsequent empty-thread check/delete are separate statements under the guard.
After a previous holder commits, READ COMMITTED statements read current membership.
If cleanup won first, a later resolver performs fresh discovery and may create a
new thread because the failed ancestor no longer exists. If another message joined
first, cleanup removes only the failed claim and retains its now-shared thread.
Preserve merge target selection, alias maintenance, tenant RLS and primary-key
claim ConflictError semantics. Missing claims retain the existing no-op behavior.
A genuine cleanup/database failure still preserves the original SMTP exception
and may leave its claim; this is not a guarantee of removal during database failure.

The guard releases with commit or rollback. It does not span outgoing SMTP: claim,
SMTP and compensation remain separate phases. No new network work is introduced
inside a transaction. This decision extends the existing mail coordination context
of [[2026-11-01-gmail-pseudo-folder-cleanup-label-evidence]] without changing that
accepted record or its cleanup eligibility rules.

## Consequences

Thread decisions across mailboxes of the same tenant serialize because threading
and alias merges span mailboxes. Different tenants use distinct logical keys;
ordinary hash collisions can serialize unrelated work. This is deliberately broader
than row locks and can delay same-tenant sends behind sync or a bounded backfill page.

Existing reconciliation transactions already include provider calls between
messages, and ingest includes attachment-storage work. The guard inherits those
existing transaction lifetimes, including later provider/storage awaits. This scoped
cost is accepted without redesigning sync transactions or authorizing additional
network work under locks. Existing SQL statement limits do not bound an entire
transaction or a provider await. Cancellation, lock/SQL failures and rollback retain
existing error/retry behavior and are never converted to success.

The protocol coordinates participating current writers, not arbitrary SQL, old
versions or future callers. It is not a guarantee of general deadlock freedom,
provider delivery, or indefinite progress. A different isolation level or a new
writer/lock acquisition order needs an explicit compatible contract. Runtime-role
and bounded overlap tests must prove the named send/send, send/ingest and merge/
backfill schedules, savepoint continuation, rollback release and tenant separation;
source inspection alone does not prove those executions.
