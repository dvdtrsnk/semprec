---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# Card actions replay the stored response of an Idempotency-Key

## Context

The iOS app queues Inbox card actions offline and replays them. `Idempotency-Key` is honored today only when an item is created: `idempotency_keys` maps a key to the item that create made (`insertItemWithReplay`), and a repeat answers that item. A card action is not a creation. A repeated `PATCH /api/proposals/:id/values` would apply twice and add a second history entry. Confirm and reject are already idempotent through the card state, so they need nothing.

## Decision

**A table of first responses.** `idempotent_responses` holds, for one user of one tenant, the status and the JSON body that a route answered the first time for an `Idempotency-Key`. Its primary key is `(tenant_id, user_id, key, route)`, where `route` is the route template (`PATCH /api/proposals/:id/values`), so the same key on another route, from another user or in another tenant is another row. `request_hash` is the SHA-256 of the canonical JSON of the request, the resolved path parameters included. `idempotency_keys` and its create-only meaning are not changed.

**One entry point, `runIdempotent` in `inbox/idempotentResponsesStore.ts`.** It runs in the route's own managed transaction and the action runs in that same transaction. It first takes `pg_advisory_xact_lock` on a hash of (tenant, user, key, route). Under that lock it reads the live row (not expired) of the tuple and then:

- a live row with the same `request_hash`: answers the stored status and body and does not call the action;
- a live row with another `request_hash`: throws `ValidationError` (`400 validation_failed`, field `Idempotency-Key`) and nothing is applied;
- no live row: runs the action. A status below 400 is stored and answered as the database holds it; a status of 400 or above is answered and not stored, and an error the action throws propagates and rolls the route's transaction back, so the key stays free.

A concurrent call with the same tuple waits on the lock until the first call commits or rolls back, then takes the same branch with what it finds. Calls with different tuples wait for each other only when their hashes collide. This serializes only the calls of one tuple; the action takes its own row locks as before.

**24 hours, swept opportunistically.** A row expires `expires_at = now() + 24 hours` after it is written and is ignored from then on; a new response for an expired tuple replaces the row. No job deletes rows. Each stored response deletes one batch of at most 100 expired rows of its tenant, and the permanent purge of a card of the Processing proposals database does the same through an item purge hook ([[2026-11-10-item-purge-domain-hooks]]). A tenant that stops sending keys keeps its last rows until its next stored response or card purge; the tenant erase deletes them with the tenant.

**Transient data.** The table is excluded from the tenant export archive (`EXPORT_EXCLUDED_TABLES`) and stays in the purge set, which the tenant catalog derives from the table's `semprec:tenancy=tenant` classification.

**Routes opt in.** A route reads the header and calls `runIdempotent`; a request without the header runs as before. Gh-1894 applies it to `PATCH /api/proposals/:id/values`; each other card route applies the same helper in the issue that mounts it.

## Consequences

- A repeated key answers the first response even when the card changed since; a client that wants a fresh evaluation sends a new key.
- A stored body is the response as the database returns it (`jsonb` orders object keys), so the first answer and its replays are the same bytes.
- A response is stored in the action's transaction, so a failure after the action rolls the stored row back with the action's own writes.
- The route that stores an item body parses it back through a schema at the replay, so a changed item shape needs the stored rows of the last 24 hours read as the old shape.
