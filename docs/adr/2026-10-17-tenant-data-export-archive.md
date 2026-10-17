---
status: accepted
date: 2026-10-17
area: [backend]
supersedes: []
superseded-by: null
---

# Tenant data export archive

## Context

A user can download a complete export of their own data (issue #1043). The
export has to cover every table that holds the tenant's content, the bytes of
its blobs, and enough account detail to identify whose export it is. It must
never carry another tenant's data, and it must never carry a secret that only
the server may hold: the ciphertext of stored credentials and the wrapped
tenant data key ([[2026-10-03-tenant-isolation-through-row-level-security]]).

The tenancy catalog already classifies every table: a tenant table carries
`tenant_id`, row-level security and the comment `semprec:tenancy=tenant`.
Tenant tables are added by many issues, so a hand-maintained list of exported
tables would fall behind the schema without anyone noticing.

An export of a few gigabytes of blobs cannot be built in memory, and the
archive must be consistent: a table file and the manifest that counts its rows
must agree, and a blob listed in `tables/blobs.jsonl` must be the one whose
bytes are archived.

Alternatives considered:

- **An explicit list of exported tables.** Reviewable, but every new tenant
  table is silently left out of the export until someone remembers the list.
  Leaving user data out of "a complete export" is the worse failure.
- **One transaction per table.** Shorter transactions, but rows written between
  two tables' reads make the files disagree (an item in `items.jsonl` whose
  relation is missing from `item_relations.jsonl`).
- **A tar or JSON archive.** A tar file is not opened by default on every
  desktop; one JSON document cannot be streamed per row. ZIP is opened
  everywhere.
- **`archiver`, or buffering ZIP entries.** `archiver` brings a much larger
  dependency tree for the same result; buffering needs every entry's size up
  front, which a table read through a cursor does not know.

## Decision

**The table set is read from the catalog at export time.** Every table in
`public` with relkind `r` or `p`, not a partition, whose comment is
`semprec:tenancy=tenant`, is exported, except the tables in
`EXPORT_EXCLUDED_TABLES` (`backend/packages/data/src/tenancy/tenantExportJob.ts`):
`external_credentials` (credential ciphertext and nonces), `tenant_keys` (the
wrapped tenant data key) and `tenant_exports` (the exports themselves). A new
tenant table is therefore exported unless its migration's issue adds it to
that list; a table holding a server-only secret must be added there in the same
pull request that creates it. Each table is read with
`to_jsonb(t) WHERE t.tenant_id = app_current_tenant()`, under the runtime
role's row-level security, through a transaction-scoped cursor 500 rows at a
time.

**The archive layout, `formatVersion` 1**, is a ZIP file with:

- `account.json`: `{ email, locale, role, createdAt }` of the tenant's user,
  without the password hash;
- `tables/<table>.jsonl`: one JSON object per row, one row per line, in the
  shape `to_jsonb` gives it (a `bytea` column is a `\x`-prefixed hex string);
- `blobs/<blobId>`: the bytes of each `blobs` row, read from the mail
  attachments root when a `mail_attachments` row references the blob and from
  the files root otherwise;
- `manifest.json`, written last: `{ formatVersion, exportId, generatedAt,
tables: [{ name, file, rowCount }], blobCount, missingBlobIds }`.
  `generatedAt` is the snapshot's transaction start time, `blobCount` counts
  the `blobs/` entries in the archive, and `missingBlobIds` lists blob rows
  whose file did not exist. A missing file does not fail the export.

A change to this layout that a reader of version 1 cannot handle raises
`formatVersion`.

**One `REPEATABLE READ` snapshot per export.** Every entry is read inside one
transaction at that isolation level, strictly in sequence on its one client,
so all table files and the manifest describe the same instant. The snapshot
covers the database only: blob bytes are read from storage as they are
archived, so a file removed while the export runs is recorded in
`missingBlobIds`. The transaction takes no row locks, but it holds one pooled
connection and the snapshot's horizon for the whole build. This is a deliberate
exception to the `state-writes` guidance against long transactions, accepted
because the transaction only reads and its consistency is the point.

**Lifecycle.** `POST /api/account/exports` inserts a `pending` row and enqueues
the `tenantExport` job in the same transaction, with `maxAttempts: 1`; at most
one export per tenant is `pending` or `running`. The job marks the row
`running`, writes the archive to `<tenantId>/exports/<exportId>.zip` under the
files root (no `blobs` row), and marks it `ready`. On failure it deletes the
partial file and marks the row `failed`; the user requests a new export rather
than the queue retrying. A shutdown follows
[[2026-09-30-graceful-shutdown-for-long-running-graphile-worker-tasks]], with
one difference recorded here: the export has no checkpoints, so between two
entries it deletes the partial file, puts the row back to `pending`, queues the
job again under the same key and returns, and the next run rebuilds the
archive from the start. That is acceptable because the build makes no paid or
non-idempotent call.

**Seven-day expiry.** A `ready` export expires seven days after it completed,
after which `GET /api/account/exports/:id/download` answers the same 404 as for
an unknown or foreign id. The daily `tenantExportExpirySweep` deletes expired
rows, and `failed` rows older than seven days, tenant by tenant
([[2026-10-06-system-work-fans-out-per-tenant]]), and deletes their archives
after the commit, best effort
([[2026-09-28-blob-bytes-deleted-best-effort-after-the-commit]]).

**`yazl`** writes the ZIP. It streams, accepts entries of unknown length, and
depends only on `buffer-crc32`.

## Consequences

- Adding a tenant table needs no change to the export; adding a tenant table
  that holds a server-only secret needs an entry in `EXPORT_EXCLUDED_TABLES`,
  or the secret is exported.
- An export holds one database connection for as long as it runs. Concurrent
  exports are bounded by the worker's concurrency, not by this design.
- A process killed outright (no graceful shutdown) leaves its export `running`.
  Nothing moves such a row on, so it keeps that tenant from requesting another
  export until it is cleaned up; no sweep for stale `running` exports exists yet.
- An archive's bytes stay on disk until the sweep deletes them; a failed
  delete leaves an unreachable file, never a dangling row.
