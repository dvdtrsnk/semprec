---
status: accepted
date: 2026-11-05
area: [backend]
supersedes: []
superseded-by: null
---

# Preserve a monotonically increasing guidance revision across row deletion

## Context

Gh-1548 exposes updatedAt and expectedUpdatedAt as ISO millisecond strings.
Gh-1629 compares the same revision after a gateway call. The existing guidance
store assigns now() to upsert and transfer: two writes in one transaction share
that value, and separate writes can also serialize to the same millisecond.
A stale save can then succeed and a drift recheck can miss changed guidance.
Increasing only the current row's timestamp would still allow an old revision
to reappear after guidance is deleted and recreated.

This extends the guidance owner under
[[2026-09-10-single-writer-ownership-model]] and the revision recheck in
[[2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions]]. It preserves the HTTP/shared-port shapes, row deletion,
serializable save and repeatable-read drift bracket. Historical ADR bodies stay
unchanged. No generic item version, new user setting or public helper is added.

## Decision

Add the tenant-owned project_agent_guidance_versions table, keyed by
(tenant_id, project_item_id), with nullable last_version timestamptz. It is
revision bookkeeping, containing no guidance content or owner identity. A new
additive DDL migration declares its tenancy, restrictive/permissive RLS,
tenant-leading key, runtime grants and tenant-reference lifecycle according to
existing database-role conventions. There is no deploy-time tenant backfill.

A private data-layer projectAgentGuidanceVersionStore is the sole receipt
writer. Every locking guidance load and mutation first ensures and locks the
receipt for that tenant/project, then locks/reads the guidance row. This order
applies to loadForUpdate, upsert, transfer, delete and the existing legacy
insert-if-absent conversion. Ordinary load remains read-only and unlocked.
All operations use the caller's managed transaction and trusted tenant scope;
no global lock, transaction opener or caller-supplied tenant is introduced.

For a real insert, upsert or ownership transfer, allocate one millisecond-aligned
revision greater than both the receipt's prior revision and the existing
row's observable revision, and no earlier than the current database wall clock
rounded to milliseconds. Concretely use the maximum of the current rounded
clock and each non-null previous revision rounded to milliseconds plus one
millisecond. Persist the receipt and guidance updated_at together. Preserve
upsert's rule that only transfer changes an existing owner, and existing
validation, affected-row and conflict behavior. A rollback advances neither.

Delete preserves the greatest previously visible revision in the receipt,
then removes the guidance row as required; its API response still has null
updatedAt. Recreating guidance allocates after that retained revision. Keep
one receipt per tenant/project for the tenant's lifetime, including after
project/guidance removal; this intentional tombstone prevents revision reuse.
Tenant removal uses the table's normal tenant-reference lifecycle. Receipts
are never exposed over the API and are not a guidance history/audit log.

The existing legacy conversion acquires the same owner reservation before
checking for an existing row. If guidance exists it does not overwrite it or
advance its revision. A genuinely new legacy insert obtains its version through
the same private owner, preserving insert-if-absent, heartbeat and replay
semantics. Initializing a missing receipt is lazy bookkeeping, not a bulk
rewrite of existing guidance. No new exported package-root name is needed.

updatedAt is now the logical revision token used by these contracts, not an
authoritative wall-clock audit time. It can lead the clock during rapid writes
or clock regression. Old rows remain readable; new owner-mediated writes adopt
the aligned revision. An older binary remains schema-compatible but does not
implement this new version guarantee. Do not claim old-binary runtime proof.

## Consequences

The same API token distinguishes rapid upserts, ownership transfer and
remove/recreate cycles without changing client request fields. The price is
one small retained metadata row per project that reaches the locking/write
owner and a per-project lock shared by those paths. This order does not claim
universal deadlock freedom; actual serialization/deadlock errors still abort
the caller transaction under its existing policy.

Tests must fail on the old code for two upserts in one transaction followed by
a stale save, transfer away/back, and in-flight behavior recheck. Also prove
remove/recreate rejects an old token, receipt/write rollback, legacy
insert-if-absent/replay and non-bypass tenant separation. Preserve the original
R1 failures, reports and ledgers. No production acceptance is implied.
