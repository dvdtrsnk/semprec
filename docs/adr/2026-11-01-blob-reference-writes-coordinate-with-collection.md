---
status: accepted
date: 2026-11-01
area: [backend]
supersedes: []
superseded-by: null
---

# Coordinate item blob references with reference-aware collection

## Context

The standalone sweep and trash purge use `deleteBlobIfUnreferenced`. Image
and file references stored in item JSONB do not have a foreign key to `blobs`.
An uncommitted item reference can therefore be invisible when the collector
deletes its blob. Batch 07 reproduced dangling references in both acquisition
orders. It also reproduced a DELETE that waited for a writer's blob lock but
still deleted the blob using a statement snapshot predating the new reference.
These diagnostics established database behavior; their fake storage deletion
did not establish physical-byte removal.

[[2026-09-28-blob-bytes-deleted-best-effort-after-the-commit]] keeps row deletion
transactional and byte deletion after commit. This decision extends that
mechanism with coordination for item references, using the existing registries
from [[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]] and
[[2026-10-09-item-create-domain-hooks]].

## Decision

A blob-owned hook is registered first in both item create/update registries at
`domainWriteHooks.ts`. It examines final create properties, including defaults
and transforms, or only the effective update patch. For schema-declared file or
image properties carrying a blob reference, validate the present blob ID and
acquire `FOR KEY SHARE` on each distinct blob in stable ID order. Locks use the
same transaction client as the item write and remain until transaction end.
Missing and foreign blobs produce the same property-key validation error.
Null, URL and other previously supported non-blob forms are preserved; an
unrelated patch does not revalidate untouched historical references.

The hook runs after the item INSERT/UPDATE, before subsequent domain hooks and
commit. Rejection rolls back the entire transaction, as existing transactional
domain validation does. An update already holds its item-row lock before the
blob hook, retaining item-then-blob ordering with purge. Idempotent create
replays retain the existing no-new-write behavior.

`deleteBlobIfUnreferenced` first obtains `FOR UPDATE` on the tenant's blob in
a separate statement. If absent it returns without deleting anything. Only
after acquiring this lock does it obtain visible database IDs and execute a
fresh reference-checking DELETE. Under READ COMMITTED this new statement sees
references committed while lock acquisition waited. A writer acquiring its
lock after committed deletion instead finds no blob and rolls back its item
write. The implicit DELETE lock or a single combined lock/check statement
does not implement this contract.

Locks and reference scans use the transaction's trusted tenant setting through
the strict `app_tenant_default()` contract, with explicit tenant predicates and
RLS. No tenant is inferred from a referenced row. An absent scope cannot select
another tenant's blob; there is no sole-tenant fallback. No new runtime grant,
security-definer function, table or foreign key is introduced.

Count schema-declared file and image references and retain the canonical
`properties.file` fallback, visible-database/new-database guard and existing
mail/Inbox attachment counts. Writer recognition and reference counting must
agree for valid uppercase or mixed-case UUID spellings. Preserve such stored
values without a historical rewrite; reference scans must recognize them.
This can change query costs and does not promise the previous GIN lookup plan.

Existing mail and Inbox attachment foreign keys already coordinate existence
with deletion. Their writers are not rewritten. The attachment-filing blob lock
from [[2026-10-29-file-from-attachment-proposal-step]] remains. One-to-one
`deleteDerivedBlob` ownership and tenant-wide erasure are outside this
reference-aware collection protocol. This decision makes no blanket claim
about every blob-deleting path.

## Alternatives rejected

- Writer locks with only the DELETE's implicit lock: the reproduced stale
  statement snapshot still misses a newly committed reference.
- A new normalized reference table or JSONB-maintenance triggers: a wider schema
  and lifecycle change than the existing transactional hook seam requires.
- Direct blob imports in the choke point: crosses the domain composition
  boundary already covered by the hook registries.
- A tenant-wide advisory lock: serializes unrelated blobs and adds a broader
  lock ownership contract.

## Consequences

New item references participate in row-lock contention with collection; missing
blob references fail rather than committing a dangling item. Multi-reference
hooks order their own blob locks, but this is not a proof of global deadlock
freedom across arbitrary multi-item transactions. No provider or storage I/O is
added while these locks are held. Bytes remain deleted only after commit.

Acceptance requires bounded production-path overlap tests for both acquisition
orders, observed blocking and the fresh-statement recheck, plus create/update,
effective defaults/transforms, missing/foreign and mixed-case reference tests.
Rollback must leave no committed item mutation or deletion callback from the
failed write. Independent review and final frozen verification remain required.
