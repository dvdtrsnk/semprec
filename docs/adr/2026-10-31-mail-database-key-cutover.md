---
status: proposed
date: 2026-10-31
area: [backend]
supersedes: []
superseded-by: null
---

# Repair mail database keys before serving tenants

## Context

Legacy mail seeds omit the canonical keys of Emails, Mailboxes and Folders.
Collection metadata resolves by key, so an uncorrected Emails row is hidden.
The normal SQL backfill policy is asynchronous; the existing application-code
cutover decision permits only transformations that SQL cannot express.

## Decision

As a narrow exception, the tenant cutover runner repairs only these at most
three system database rows per tenant before serving. A tenant-scoped
transaction serializes this cutover, locks the relevant rows and rejects
unexpected values or occupied keys. Missing rows and already canonical keys
need no update. New seeds provide the keys directly.

## Consequences

This bounded SQL operation runs synchronously so metadata is correct before
reads, rather than exposing incorrect visibility during an asynchronous
backfill. Unique constraints still reject concurrent conflicting inserts and
roll the transaction back. No item rows or unrelated database fields change.
