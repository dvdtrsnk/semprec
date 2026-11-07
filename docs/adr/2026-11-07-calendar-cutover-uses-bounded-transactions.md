---
status: accepted
date: 2026-11-07
area: [backend]
supersedes: []
superseded-by: null
---

# The calendars cutover seeds in one bounded transaction and links Events in batches under existing locks

## Context

The calendars cutover of issue #1600 (`calendar/calendarsCutoverMigration.ts`) gives a populated tenant
the calendars database, the `Calendars.events` / `Events.calendar` relation and the eight calendars, then
links every existing Event to the default calendar. It ran in one transaction. The seed it reuses
(`seedCalendarsInTransaction`) takes `LOCK TABLE properties IN EXCLUSIVE MODE`, so that one transaction
held a table lock that every tenant's schema writes wait on across an Event backfill whose size is the
tenant's Event count. [[2026-09-10-app-code-post-migration-steps]] allows a single transaction under an
exclusive table lock only for a small, bounded table and asks for batching otherwise.

The cutover also checked whether the calendars database existed before taking any lock. Two invocations
of the per-tenant cutover runner for one tenant (two deploying processes) could both see it absent and
both seed it, and one of them could then fail on the duplicate or on the lock it waits for.

## Decision

The cutover runs in bounded transactions and serializes on locks the code already takes; it introduces
no lock key, table or protocol of its own.

- **Schema transaction.** It takes the tenant's structural seed lock and admits the tenant
  (`lockTenantSeedInTransaction` in `seed/seedSystem.ts`: the advisory lock `(2331, hashtext(tenant id))`,
  then the tenant row `FOR SHARE`, refusing a missing or `deleting` tenant) before it checks for the
  calendars database. This is the lock and order `seedSystem` uses, so a concurrent cutover or seed of the
  same tenant waits and then finds the database. When the database is absent it is seeded and the
  transaction commits, which ends the `properties` lock the seed took.
- **Edge batches.** Each batch is its own transaction. It re-reads the relation definition and the default
  calendar, then takes the definition's advisory lock
  `pg_advisory_xact_lock(hashtextextended(definition id, 0))` before its no-edge check. That is the lock
  the `BEFORE INSERT` cardinality trigger of `0013_relation_cardinality.sql` takes for every edge inserted
  for the definition. The batch then admits the tenant again (`admitTenantInTransaction`), inserts at most
  500 edges to the default calendar and commits. A concurrent batch, or any other edge insert of the
  definition, waits for it and then sees its committed edges, so no Event gets a second calendar. An edge
  delete takes no such lock and does not wait.
- No `properties` table lock is held across the edge batches.

## Consequences

- An interrupted cutover leaves valid partial progress: the calendars exist and some Events have their
  default-calendar edge. That is the state an Event created after the seed is already in. The next run
  skips the seed and links the rest; a run after a complete one writes nothing.
- While a batch runs, a user's new edge on `Calendars.events` / `Events.calendar` waits for it, as it
  would wait for any other edge insert of the definition.
- Between batches other transactions see a partly linked tenant.
