---
status: accepted
date: 2026-11-04
area: [backend]
supersedes: []
superseded-by: null
---

# Oversized relation keys request a full link refetch

## Context

Gh-1621 adds property-key relation invalidations. Existing properties.key text has no historical byte cap, while PostgreSQL NOTIFY has a payload limit. Exact arbitrary keys cannot always fit. A future-only key constraint does not repair historical rows; truncation invents another key, silent dropping loses the invalidation, and durable key lookup/outbox introduces a larger protocol. [[2026-09-12-thin-user-scoped-realtime-invalidations]] and [[2026-10-16-tenant-scoped-realtime-fan-out]] remain authoritative for thin references and tenant fan-out.

## Decision

For this relation message only, validate the UUID IDs, optional UUID user restriction and closed op vocabulary before publication. Measure the complete JSON-serialized relation message in UTF-8. At most 7000 bytes retains the exact propertyKey; above that budget replace only propertyKey with null. All database/item identity, op and optional user restriction remain intact. PostgreSQL still derives the tenant envelope from publisher scope. The conservative message budget leaves room under PostgreSQL's existing NOTIFY cap for that bounded envelope; test the actual received envelope byte length. Do not change stored keys, impose a new property-key limit, chunk notifications, emit partial keys, drop valid events or turn a post-commit publication issue into write rollback. Other message kinds retain their contracts.

A relation frame with propertyKey:null explicitly asks the consumer to refetch all incoming and outgoing links for the named item. This broader meaning includes the existing one-directional target (no reverse property) and oversized-key case. Normal-size keyed frames retain precise-key meaning. Null remains a distinct coalescing key, and relation frames never replace item-scope frames. Older clients still ignore the additive relation scope; no client implementation or deployment is claimed.

## Consequences

Very long historical keys cause a broader refetch rather than exact-key routing. This explicitly narrows the original universal exact-key interpretation; it is not a claim that arbitrary keys fit or that null represents a truncated key. Verify normal/boundary/oversized escaped and multibyte keys, actual bounded PostgreSQL notification and socket delivery, op preservation, tenant and acting-user restrictions. No durable delivery guarantee, outbox, retry or live-provider work is added.
