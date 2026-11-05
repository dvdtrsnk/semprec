---
status: accepted
date: 2026-11-05
area: [backend]
supersedes: []
superseded-by: null
---

# Threads relation mutations reserve their Threads endpoints

## Context

[[2026-11-05-mail-thread-item-merges-transfer-existing-relations]] reserves the
losing/winning items and discovered definitions, but ordinary relation writes
first validate endpoints with unlocked reads. item_relations has no item-row FK.
A new-definition edge inserted after discovery need not conflict with any of
those discovered definition reservations. Item locking alone is not a protocol
unless the competing writers participate.

This narrows that ADR's statement that ordinary writers remain unchanged:
existing generic APIs and non-Threads behavior remain unchanged, but mutations
incident on Threads participate in domain-owned endpoint reservation through
[[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]]. Existing
accepted bodies are not edited. No new database trigger or generic admission
framework is selected.

## Decision

Extend the existing Threads domain hook in mail/threadValueEdges.ts to reserve
ALL canonical Threads endpoints incident on a supported relation mutation, not
only the project/company properties. Normalize caller/target databases using the
existing edge context and canonical Threads database under tenant scope. Lock
existing Threads endpoints in ascending UUID order before the mutation. Ordinary
writes use existing FOR UPDATE, and lockMode:nowait uses the existing value-link
lock wrapper and typed busy/rollback contract. Then recheck Threads endpoint
existence/liveness from the locked result before allowing creation or metadata
replacement. Keep the specific project/company single-value check after the
reservation; other properties acquire no new value/cardinality policy.

Register a narrow companion through the EXISTING relation-edge-delete registry
in domainWriteHooks.ts. Removal reserves any existing Threads endpoint with the
same ordering/mode but does not reject a trashed or already missing endpoint,
preserving cleanup and idempotent-delete behavior. No new hook field, registry,
public export, API option, SQL trigger, advisory key, timeout or retry is added.
The existing proposed nil-caller omission remains limited to the nonexistent
proposed caller; real existing Threads targets still participate. Predictions
remain predictions and do not promise an eventual confirmation.

Merge continues to take its tenant guard then both Threads item locks before
edge discovery, then its sorted definition reservations and structural transfer.
With participating writers this orders a concurrent new edge independently of
whether its definition was visible at discovery: if its writer gets the Threads
reservation first, merge waits and discovers the committed edge in a fresh READ
COMMITTED statement. If merge gets it first, a writer's earlier unlocked endpoint
check is not authoritative; after waiting it must reject the now-trashed loser,
or propagate a genuine serialization failure under an older snapshot. It may
not insert using stale liveness. A concurrently created definition does not
change this endpoint requirement. Retained trashed counterpart transfer remains
the separate proved-existing-edge structural exception.

All production relation inserts/updates/deletes incident on Threads must use
these existing mutation owners; raw store SQL is not an alternative public path.
The scoped structural transfer itself holds both Threads reservations, and
item purge/soft-delete retain their existing item-first ownership. Privileged
schema/data migrations and arbitrary SQL are not synchronized by a JavaScript
hook. Future domain writers must join this contract rather than infer that the
old discovered-definition set protects them. Do not silently introduce direct
store callers or new schema writers in this batch.

## Consequences

This adds a finite Threads endpoint protocol while leaving generic wire/API
shapes and unrelated domains intact. It does not establish global lock ordering,
deadlock freedom or lock upgrades safe for arbitrary preheld compositions.
Existing caller locks, typed value-link nowait and actual40P01/40001 behavior
remain; no broad remapping or retry. Runtime-role tests must force both insert/
merge orders, including an incoming opposite-side edge and a definition created
after merge discovery, plus delete/update and rollback release. Identify actual
backend participants and blocking where waiting is intended. Assert transfer or
stale-loser refusal with no stranded live edge, preserved metadata/aliases,
progress for an unrelated item on a separate definition and another tenant,
and unchanged non-Threads semantics. The existing shared-definition advisory
reservation intentionally serializes that definition; no same-definition
parallel-progress promise is added. Preserve the
nil/single-value/nowait and structural cardinality/hook refusal tests. This ADR
is a policy correction, not a claim that any test or merge already passed.
