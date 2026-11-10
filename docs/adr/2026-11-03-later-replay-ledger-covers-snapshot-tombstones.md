---
status: accepted
date: 2026-11-03
area: [backend]
supersedes: []
superseded-by: null
---

# Treat the later deletion ledger as replay evidence covering the main snapshot

## Context

Backup currently dumps the main database and later reads completed-deletion
IDs. A purge between those observations can leave an older tenant in the dump
and its newer tombstone only in the ledger. The monthly exact-count/absence
check then rejects legitimate replay evidence. Corrective issue
`sp-dd171464-d76c-45f9-b113-73d81b38aad4` corrects that gh-1078 assumption without
changing historical issue or handover bytes.

Holding an exported snapshot across dump and ledger would add another long-lived
connection owner and still require newer deletion evidence for an older restore.
Instead, explicitly describe the existing command-order relationship and test
the invariant that it can actually establish.

## Decision

Keep backup order: successful main dump, independent key dump, then deletion
ledger query on the intended source. Store main dump and ledger in the same
path-selected restic snapshot only after all required steps succeed. The ledger
is a later replay artifact, not an exact-snapshot census. This is bounded
command-order/provenance evidence, not a shared MVCC snapshot, universal blob
consistency, authenticated database history, or a crash guarantee. Preserve
newer completed deletions rather than dropping them to force equality.

For the selected main snapshot, every actual tombstone ID in tenant_deletions
must occur in the validated ledger. Reject any ID simultaneously present in
the restored tenants and tombstones, since completed purge removes that tenant
in the tombstone transaction. Additional ledger IDs are permitted, whether the
older main contains that tenant or not, and remain available for actual replay.
Compare exact IDs, not counts. A single read statement supplies the database
side of the validator's checks; the restored target remains offline.

Add a private strict backup-artifact validator and native CLI. The artifact is
UTF-8 canonical lowercase UUID records, at most 8 MiB, with no duplicate or
internal blank records; an empty file and a final line terminator are valid.
Validate all input before database work. Preserve the existing replay parser's
historical blank-line/dedup behavior and idempotent manual replay contract;
strict artifact validation is a separate boundary, not an unrelated change to
that parser. Support closed file-only validation before backup snapshotting and
scoped database validation after restoration, with fixed safe diagnostics and
owned pool settlement. A non-owner role needs only the stated read privileges
on global tenants/tombstones, not a new SECURITY DEFINER helper or mutation.

The monthly offline check validates coverage and contradiction only; it does
not expose services or claim to have executed production deletion replay. Use
the owned topology and narrow temporary role described in
[[2026-11-03-offline-compatible-tenant-key-restore]]. Disaster recovery fetches
the newest explicitly path-selected replay ledger, validates it against the
selected restored main, and supplies that same protected path to actual replay
before any service activation under
[[2026-11-03-restored-services-wait-for-successful-deletion-replay]]. No older
ledger fallback is allowed after validation failure. File replacement by the
trusted privileged operator is outside this protected-file procedure; do not
claim a distributed TOCTOU fence.

## Consequences

The new exact subset test replaces a false equality premise rather than merely
removing a safety check. A controlled real dump, later production purge, later
ledger, and restored-main scenario must prove it, including omitted old ID,
different equal-count set, malformed/duplicate/missing artifact and impossible
tenant/tombstone coexistence. Existing storage, retention and RPO remain
unchanged: a deletion after the newest retained ledger has no replay evidence
there. Missing cleanup or a failed artifact/snapshot step never produces a
success signal. No historical snapshot is rewritten, and no local simulation
constitutes production restore or second-tenant approval.
