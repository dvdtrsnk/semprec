---
status: accepted
date: 2026-11-04
area: [backend]
supersedes: []
superseded-by: null
---

# Reserve database state during approval-gated item patches

## Context

Gh-1713 item_patch snapshots include the item and databaseArchivedAt. An item lock alone cannot prevent a concurrent databases UPDATE from changing that projected archive state before mutation. This extends [[2026-09-18-exactly-once-execution-of-approved-destructive-operations]] and follows the transient-busy semantics of [[2026-11-04-approval-relation-snapshots-reserve-inserts-and-existing-rows]]. It does not change ordinary item.patch admission or database archive ownership.

## Decision

The dedicated item.patch approval projection requires the exact active tenant-scoped managed READ COMMITTED client. Authorize the visible item first, then reserve its database row FOR SHARE NOWAIT before taking the item's existing exclusive row lock. Re-read the typed database and locked item after reservation; require their identities to agree and check missing/deleted/archived state. Build the existing snapshot only from that fresh read, and retain the database reservation through the approved mutation and transaction settlement. Do not trust the initial discovery read for archive state.

Use the existing NOWAIT item helper so an approval attempt holding a database reservation cannot wait on an item owned by another actor. Only the narrow reservation's actual pg.DatabaseError SQLSTATE 55P03 becomes the existing fixed ApprovalResourceBusyError. Mark the exact managed invocation rollback-only before throwing. Busy remains transient, is rethrown before domain-conflict mapping, creates no preflight request and leaves an existing approved replay request queued after full rollback. Do not reinterpret arbitrary code-shaped objects, other database errors or mutation failures as busy. Preserve unknown error identity and the existing outer-transaction rollback contract.

Use database-before-item order for this projection. No database archive or generic item writer is modified, no waiting across external work is introduced, and there is no new lock key, isolation level, savepoint lifecycle, retry loop or public helper. Existing archive/restore UPDATEs conflict with the shared database row reservation. This proves stability of the declared item/database archive projection, not every schema, destination or domain input a subsequent hook might read, and not global deadlock freedom.

## Consequences

Unrelated items and tenants retain ordinary behavior. A concurrent database metadata update may cause transient busy even when it would not change the hash. Tests must prove both archive-first (busy, then fresh conflict/no item mutation) and approval-first (archive waits until settlement), with actual backend identities and joined actors. Include preflight no-request, rollback-only when caught by the outer callback, normal unflagged writes and foreign/missing controls. Historical review findings remain attributed to their reviewed SHA.
