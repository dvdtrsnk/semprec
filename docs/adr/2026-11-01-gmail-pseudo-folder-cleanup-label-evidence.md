---
status: accepted
date: 2026-11-01
area: [backend]
supersedes: []
superseded-by: null
---

# Use Gmail label evidence for pseudo-folder cleanup

## Context

Gmail label identifiers are opaque. Existing folder records retain their provider identifier but
not whether Gmail classified the label as a user or system label. Cleanup therefore cannot infer
that classification from an identifier or from its absence in an inventory.

## Decision

For each Gmail mailbox, load and validate its label inventory through the existing mailbox-scoped
OAuth adapter before opening cleanup mutation transactions. Remove only folders positively
identified as non-placement system labels. Preserve user labels, unknown identifiers, the five
placement labels and the synthetic Archive folder. An unavailable or invalid inventory fails that
mailbox before its cleanup mutations and remains an error for retry.

Cleanup uses bounded keyset pages and one transaction per page as in
[[2026-09-28-chunked-transactions-for-large-background-sweeps]]. Affected messages without a
placement folder receive Archive even if a user-label edge remains. The existing OAuth refresh and
token-lock contract is unchanged.

Gmail reconciliation and cleanup share a transaction-scoped advisory lock keyed by
`gmail-folder-state:v1:<lowercase tenant UUID>:<lowercase mailbox UUID>`, hashed using
`hashtextextended($1::text, 0)`. A missing or system tenant scope fails before the lock query.
Reconciliation takes the guard first, before mailbox state, item, folder or edge decisions.
Every cleanup mutation page and its final folder-removal transaction takes the same guard first
and rechecks the folder's current eligibility. Inventory loading stays outside those cleanup
transactions. The guard releases on commit or rollback. Different keys are independent except for
ordinary hash collisions, which can serialize unrelated work.

## Consequences

An obsolete folder absent from the provider inventory is preserved because its former type cannot
be established. A provider failure delays cleanup instead of authorizing a guessed deletion.
Gmail reconciliation already performs provider I/O in its transaction; this guard inherits that
duration and can delay cleanup for the same mailbox. This decision retains that existing boundary
for this path and does not authorize new network work inside transactions. The guard coordinates
only these participating writers; it does not guarantee deadlock freedom or control old-version or
other writers. The production pool applies a 60-second limit to each SQL statement, not to the
transaction or provider awaits as a whole. Errors propagate; the fixed-key cleanup job is enqueued
with three attempts, and no timeout is reported as success.
