---
status: accepted
date: 2026-10-18
area: [backend]
supersedes: []
superseded-by: null
---

# Tenant exports search both blob roots after a missing file

## Context

[[2026-10-17-tenant-data-export-archive]] selects the mail attachments root
for a blob referenced by `mail_attachments`, and the files root otherwise.
Uploads and mail attachments share content-hash deduplication. An attachment
can therefore reuse a blob whose bytes remain in the files root, while its
duplicate mail file is deleted. A reference alone cannot identify the root
holding the bytes.

## Decision

For tenant exports, the reference-based selection remains the first root
searched. If opening that key returns `ENOENT`, try the same stored key in
the other configured root. Record the blob in `missingBlobIds` only if both
roots return `ENOENT`. Other read errors propagate and fail the export.
This is a narrow exception to the original archive ADR's root selection;
its layout, snapshot, exclusions and lifecycle stay in effect.

## Consequences

Exports include deduplicated bytes without changing blob metadata or moving
files between roots. Missing files require two lookups, and an unreadable
file remains an export failure rather than being treated as absent.
