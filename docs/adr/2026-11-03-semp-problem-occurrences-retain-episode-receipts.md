---
status: accepted
date: 2026-11-03
area: [backend]
supersedes: []
superseded-by: null
---

# Retain keyed occurrence receipts for each Semp problem episode

## Context

Gh-1506's real sync job reproduces A, B, retry A as three occurrences. The
problem store compares only last_occurrence_key. Adjacent replay protection
cannot satisfy retry identity with intervening reports. This is a narrow
correction of that existing store contract, not a new problem taxonomy.

## Decision

Add a tenant-classified additive receipt table keyed by tenant, problem id and
occurrence key, with a tenant-safe cascading relationship to its problem.
The unique key is the arbiter. Under the store's existing dedupe-key guard,
record keyed reports and adjust count in the same caller transaction. A keyed
report already recorded for that episode adds no count, even after other keys.
Unkeyed reports preserve their existing counting behavior. First report still
counts once. A duplicate can still escalate severity with the existing exactly
once escalation notification; deduplication must not hide critical information.
Preserve project attribution, first_seen_at and all prior tenant/error rules.

An episode is one persisted problem row, active until resolved. A later new
problem after recovery is a new episode. Receipts are retained for the life of
the problem, without a shorter TTL or bounded last-N cache; existing problem
pruning and tenant purge remove them by the declared relationship. Do not
introduce a second scheduler, cleanup service or cross-tenant/global receipt.

The structural migration contains no speculative full history backfill. When
an existing problem is next raised, lazily seed its known last occurrence key
under the existing guard without incrementing count. Older unknown keys cannot
be reconstructed; do not fabricate receipts or claim retrospective deduplication
for history never recorded. New post-cutover A/B/A reports are fully deduplicated.

## Consequences

This explicitly permits the limited store/schema correction excluded by the
original producer-only scope. Tests exercise actual mail job A/B/A, concurrent
same-key raises, duplicate escalation, rollback, distinct episodes, runtime-role
isolation, populated compatibility and existing prune/purge cascade. Store/API
behavior outside occurrence identity is unchanged. This does not repair every
mail error notification's own replay behavior or authorize unrelated problem UI.
