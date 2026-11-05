# Batch 30 — page capability and evidence-owner reconciliation

Owner-delegated controller decision for aggregate
`sp-c7d74d78-a59f-4453-b2d6-3c9c31f8b235`, based on accepted batch 29 completion
`b43a3c0a43fb020becbf673150667e5e1d51f767`. This applies existing architecture;
accepted ADR bodies remain unchanged. Local acceptance exceptions from batch 29
do not transfer to batch 30.

## Page operations

Follow `docs/adr/2026-10-28-page-operation-family.md`, section 3:
`page.get` requires `core.page.read`; `page.ensure` requires `core.page.write`.
Register both capability identifiers in gh1615. Existing item-only grants must
not acquire either capability implicitly. Preserve the existing human-session
composition from registered module capabilities; do not add agent grants,
credential migrations or the policies deferred to gh1400/1844.

The already implemented `page.restoreVersion` currently uses `core.item.write`.
Correct that single metadata entry to the ADR's `core.page.write` while retaining
its destructive classification and approval flow. Prove discovery and refusal
for item-only grants and continued explicit page-write authorization. Do not
register any other unimplemented page operation.

ADR section 1 assigns exact response schemas to the implementing issue. Thus
gh1615 keeps its flattened `lastEditedAt` and `lastEditedBy` fields without a
second `lastEdited` alias. Consume the delivered gh1405 DocRow, including its
document-created-at fallback and nullable author; no document means null edit
fields. Count actual root blocks before limiting, excluding the synthetic empty
block. Count existing page blocks and expose their existing pageId without
implementing subpage creation or its deferred ancestry model.

The conditional gh1615 placeholder predates delivered gh1608. Consume the
existing canonical inline Markdown conversion for block text and h1-h3 headings.
Export the existing `serializeInline` implementation from block-model through
its barrel, with its algorithm unchanged. Do not duplicate conversion logic or
implement the deferred full Markdown page response. Existing inline database
ancestry uses `getItemPath`, with Journal type/period metadata; unsupported
subpage ancestry stays null until gh1676/2014.

Read-only document summary belongs to the existing data/docs owner behind its
public factory; no application SQL or private cross-package imports. It must
not use a read path that compacts or writes. Page ensure uses one managed
transaction through that same owner, reserving/rechecking the live item before
getOrCreateDoc even when the document already exists. Preserve unrelated callers
of getOrCreateDoc and the existing wrong-kind conflict. No new global lock or
isolation protocol is authorized.

## Existing owners and finite test scope

Per-member Touches lists include the exact existing REST, MCP, agent and closed
catalog harnesses required by their named scenarios. Permissions do not transfer
between members. Tests must execute actual dispatch/owner paths with the
production runtime role and owner-positive, foreign/random and no-effect
controls where applicable. Catalog assertions retain exhaustive checks; no
filtering out new entries or weakening safety scanners.

Gh1583 may export only its requested active-session reader. Gh1584 may extend
the actual schema and generic-property HTTP harnesses for color behavior.
Gh1586 keeps completion inside the existing Projects preparation/transaction
transform, deferring only implicit time-dependent proposal values and retaining
ordinary owner refusal/preconditions/replay. Its HTTP/MCP cases prove the same
response and localized property projection. Gh1997 uses the actual deletion
and query transports to verify the system-area marker without changing its
existing deletion protection or introducing statistic behavior.

Gh1587 preserves the existing item-before-link reservation order and existing
value-link owner/propagation semantics. The historical count of 29 is replaced
by the current base count of 32; add exactly two operations here and one in each
page member. Closed contract files and route/public export catalogs may change
only for each member's sanctioned entries and scenarios. No propagation rewrite
or new cross-domain registry is authorized.

## Evidence and release limits

The batch30 advisory was pinned before batch29. Parent compared all 80 recorded
mode/blob identities at the accepted base: 75 unchanged and five changed
(tenant cutover registry, generic port/rows/schemas, REST contract test). The new
gh1575 handover is read separately. This is static preparation, not completed
worker intake, a new test result or release certification.

Retain the original six aggregate criteria, source Task/AC provenance and every
actual FAIL/NOT RUN. Use one complete R1 and one same-context focused R2, then
parent disposition. A final verify plan must pin the actual coherent candidate;
do not pre-run a second full pipeline. No production rollout, live provider,
push, environment retirement or change to gh1086 is authorized.

## Gh1578 existing People fixture compatibility

The existing peopleRelationshipOptionsCutoverMigration.test.ts calls the full
registered runner and compares its output with a fresh seed. Gh1578 necessarily
changes that resulting order. Authorize only its required target-order assertion
and corresponding fresh-seed comparison alignment. Keep the old-order synthetic
input, full equality check, preserved option metadata, added-key write controls
and repeated-run idempotence. The test that invokes only the original People
option-extension owner keeps its existing order-preservation expectation. No
production behavior or source Task/acceptance criterion changes in this delta.
