---
status: accepted
date: 2026-11-02
area: [backend, cross-cutting]
supersedes: []
superseded-by: null
---

# Validate Markdown item links at the tenant write owner

## Context

The shared parser from [[2026-10-28-block-model-for-page-documents]] is pure
and runs without a database, including in browser consumers. Issue gh-1614
requires tenant-aware item-link checks but the recovered implementation has
only a backend guard; no production Markdown write consumer calls it. Read-only
journal parsing is not evidence of write validation. The operation family in
[[2026-10-28-page-operation-family]] assigns insertion to gh-1679 and replacement
to gh-1765. Implementing their transport surfaces early would duplicate their
capability, persistence and concurrency contracts.

## Decision

Keep shared parsing, serialization and item-link collection pure. Gh-1614 in
batch 12 delivers and tests the backend `assertItemLinksExist` guard using actual
parsed blocks and an explicitly tenant-scoped runtime-role client. It accepts
live local items and rejects malformed, missing, foreign and deleted targets
with the same safe `ValidationError` status/code/details and Markdown field path.
It writes no relation or document. This error contract is not an executed HTTP
response or proof that a production write consumer already invokes the guard.

The owners of page insertion (gh-1679) and replacement (gh-1765) must call the
guard after parsing on their own tenant-scoped write client before persistence.
A failed check rolls back all write effects, including any lazy document
creation. Those issues prove actual authenticated HTTP positive and identical
400 refusal paths, with unchanged document/update/relation state. Their declared
prerequisites and acceptance criteria include gh-1614 explicitly.

Rejected: adding database access to the shared parser or a speculative endpoint
solely to produce a transport test. Rejected: treating an unused helper or
matching exception objects as proof of an HTTP production path. Existing page
operation capabilities, approval and concurrency decisions remain unchanged;
this decision adds no new lock or guarantee against concurrent deletion after
a reference was accepted. It does not restrict ordinary non-item link schemes.

## Consequences

Batch 12 can establish the pure format and tenant guard contracts independently.
Production Markdown write integration and its HTTP evidence are explicitly
NOT RUN until the owning issues deliver them. They are not silently waived or
claimed as batch-12 HTTP passes. Original implementation handovers and accepted
ADR bodies remain unchanged; current scoped specifications carry this boundary.
