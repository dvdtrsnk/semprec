---
status: accepted
date: 2026-11-04
area: [backend]
supersedes: []
superseded-by: null
---

# Confirmation results hold retained file relation rows

## Context

Gh-1648 reports relations actually applied or retained by confirmation. A
fileFromAttachment step can reuse a Files item without applying requested project
relations. Filtering those requests through an unlocked relation read avoids a
false label in the sequential case, but a concurrent unlink can commit after that
read and before confirmation stores its result. The existing blob lock does not
coordinate generic relation deletion.

## Decision

Only when constructing linkLabels for a reused Files step, the existing managed
confirmation transaction reads the relevant actual item_relations rows with
FOR SHARE, in deterministic relation-definition/edge-id order for that file. Read
and lock the rows in the same SQL statement, before using them as retained target
identities. Keep the locks until the caller commits or rolls back the card/result
transaction. Apply existing tenant RLS and actual endpoint/definition predicates;
do not read unscoped edges. A missing edge produces no retained label. If an unlink
wins first, use the actual locking read's outcome or propagate its genuine database
failure, never reuse an earlier unlocked snapshot.

Use a private query in the already scoped confirmation owner. Do not add a generic
relation-store API, new advisory/item/blob lock, second transaction, arbitrary
response extension or change to relation deletion. Preserve existing proposal and
file/blob acquisition, execute-step ordering and no-mutation Files reuse. Within a
file, request the needed retained definitions in stable order and rows by id; this
is not a new transaction-wide locking protocol across all proposal operations.
PostgreSQL row deletion already conflicts with FOR SHARE. A concurrent unlink of
a retained row must wait until the confirmation transaction ends. SQL/deadlock/
serialization/rollback errors retain existing failure behavior. This introduces no
provider call or new external work under locks.

The rule follows [[2026-09-29-withtransaction-is-the-sole-transaction-opener]] and
the existing reused-item/result ownership of gh-1648; it does not alter accepted
ADR bodies. It protects the edge-existence decision, not project-title text or
all possible future item/relation changes.

## Consequences

Stored labels describe retained edges at successful confirmation commit. A later
independent unlink may remove an edge after that commit; results are historical,
not continuously recomputed. Different unrelated edges are not fenced. There is no
claim of global deadlock freedom, arbitrary-writer exclusion or immediate progress.

One finite controlled runtime-role confirm/unlink overlap must use the real
confirmation and deleteRelationWithClient owners, exact owned backend identities
and observed blocking after retained-edge acquisition. Verify committed result
before releasing the later unlink, then its actual settlement. An unlink completed
before confirmation yields no retained label. Preserve existing new/reused-empty/
reused-linked controls. No broad scheduling matrix, production test hook or third
review is introduced. These controls are required evidence, not completed tests.
