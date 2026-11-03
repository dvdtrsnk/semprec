---
status: accepted
date: 2026-11-03
area: [backend]
supersedes: []
superseded-by: null
---

# Person mail-link jobs reconcile current indexed ownership

## Context

Gh-1571 requests one keyed job per person and a payload containing only addresses
newly claimed in the producer transaction. The installed Graphile Worker replaces
a pending object payload under the same key. Two additions before execution would
therefore lose the first address if that payload were the complete work list.
A locked job can also be superseded by another keyed enqueue while it runs.

## Decision

The existing tenant-stamped queue envelope, fixed key
`mail-link-person-emails:<personId>` and default replacement semantics remain.
The producer enqueues only after actual new index inserts, in that same managed
transaction, with precisely the addresses newly claimed by those inserts.
No new claim means no enqueue; removing an address does not enqueue removal work.
Use the actual inserted rows rather than a pre-check to identify successful claims.
Preserve the index writer's existing conflict result and first-writer ownership.

The payload is a validated wake-up hint, not a durable historical work list or
ownership authority. The handler reconciles the person's currently owned rows in
`person_email_index`, confined by its real tenant scope and existing task wrapper.
Each bounded mail page uses its own `withTransaction` at READ COMMITTED, discovers
current owned index rows in email order with `FOR SHARE`, and retains those row
locks through the page's relation writes. Ordinary DELETE/UPDATE of those rows
cannot complete while this page uses their ownership. An address removed or
reassigned before the page's ownership read is ineligible for new links to the
previous owner. A removal after the page commits does not remove its existing
edges: preserving those edges is the product's explicit rule.

Read the live person and the current property spelling needed by the specified
containment search, skip deleted items, confirm normalized envelope matches, and
write through `createRelationWithClient` with `EMAILS_RELATION_CONTEXT`. Keep
keyset paging by mail item id, duplicate-edge idempotence and existing relation
owner guards. A subsequent newly claimed address has its own committed wake-up;
that job starts reconciliation from the beginning, so an address added behind a
running page's cursor is not solely dependent on the older pass. Pending payload
replacement is safe only because the consumer reloads current indexed work.

This decision selects no new advisory guard, person-wide mutex, mail-thread lock,
queue merge mode, provider call or direct relation writer. It uses the existing
index mutation owner and PostgreSQL row conflicts. Preserve database, deadlock,
validation and cleanup failures and existing queue retry behavior; do not map an
unexpected failure to success. This extends the existing queue transaction pattern
and [[2026-09-29-withtransaction-is-the-sole-transaction-opener]] without changing
that accepted record or the mail-thread mutation guard's scope.

## Consequences

A job may rescan more addresses than its last payload names. Work is bounded per
mail page, not claimed to have a fixed total completion time. This is eventual
reconciliation of current ownership, not an audit history or exactly-once executor.
It does not create links for an address removed before processing merely because
an old payload once mentioned it. Different tenants keep separate RLS scopes.
No general deadlock-freedom or historical-edge exclusivity guarantee is made.

Required controls use the actual producer and Graphile worker: two committed
additions before a pass, an addition while a pass is held, replay without duplicate
edges, removal/reassignment before a page, and a held index-share versus release
with actual owned backend/blocker evidence. Existing edges survive later removal.
Runtime-role positives and foreign/no-effect controls retain tenant isolation.
