---
status: accepted
date: 2026-11-15
area: [backend]
supersedes: []
superseded-by: null
---

# Default Inbox item types are seeded once per default, under the System settings row lock

## Context

Issue gh-1977 gives every tenant a starting set of Inbox item types (Idea, Task, Event, Thought, Mood, Note, Contact).
Two paths must create them: the per-tenant cutover `inbox/defaultInboxTypesCutoverMigration.ts`, which runs for every
maintained tenant on every deploy, and `provisionTenant`, which seeds a new tenant without running the cutovers. Both
call `seedDefaultInboxItemTypes` (`inbox/defaultInboxTypes.ts`).

Because the cutover repeats on every deploy and a user may delete or rename a seeded type, the seeding has to remember
what it already created. An existence check on the types database cannot do that: it would create a deleted type again
at the next deploy.

The memory has no table of its own. It is a property of the singleton System settings item, a database that another
owner declares and that is `schema_locked`. [[2026-09-10-single-writer-ownership-model]] requires that a field of
persisted state have exactly one owning process, and
[[2026-09-10-expand-contract-forward-only-migrations]] requires the new property to be an additive change a rolled-back
release can ignore. The step also adds a lock choice, an ordering position and a contract that later modules will
follow, none of which an existing record covers.

## Decision

1. **The marker is per default.** The System settings item holds a `json` property `seededDefaultInboxTypes`, a list of
   the stable English camelCase keys (`idea`, `task`, ...) of the defaults already created. The seeding creates exactly
   the defaults whose key is not in the list and appends their keys in the same transaction as the types. A default
   whose key is listed is never created again, whether or not its type still exists, so a type the user deleted or
   renamed never returns. The key is used only by the marker; it is not stored on the type.
2. **The Inbox process owns the property.** It is `owner: 'system'` with `owner_process` `inbox`. The only writer is
   `seedDefaultInboxItemTypes`, which writes it through `updateItemWithClient` with
   `allowedSystemKeys: ['seededDefaultInboxTypes']` and `systemOwnerProcess: 'inbox'`, so the choke point validates,
   records and announces the write like any other. The property is hosted on another owner's database because a tenant
   has one settings item and a per-tenant marker needs no other table; the hosting database's owner does not write it.
   `seedSystem.ts` declares the property with an empty list for a fresh tenant; the cutover inserts it with raw SQL
   when it is missing (the settings database is `schema_locked`, so the choke point cannot add a property). A tenant
   without the settings database is skipped. The seeding throws when the settings database lacks the property or the
   value is not a list of strings, instead of treating a damaged marker as empty and creating every default again.
3. **The settings row lock is the serialization point.** `seedDefaultInboxItemTypes` reads the marker with
   `lockItemById`, a `SELECT ... FOR UPDATE` of the settings item that returns the properties in the same statement,
   in a READ COMMITTED transaction. A second seeder (a cutover and a provisioning, or two cutover runs) waits on the
   row, then reads the keys the first one committed, so it creates only what is still missing and both transactions
   cannot create the same default. The choice is the row lock, not a table lock or an advisory lock, because the
   marker lives on that row: the lock is held exactly where the state is read and written, and any other choke-point
   write to the settings item also takes it.
4. **The cutover adds a table lock only for the property insert.** `runDefaultInboxTypesCutoverMigration` runs in one
   transaction and, when the settings database exists, takes `LOCK TABLE properties IN EXCLUSIVE MODE` before it looks
   for the marker property and inserts it. EXCLUSIVE conflicts with every mode except ACCESS SHARE, so a concurrent
   run waits and finds the property the first inserted; plain `SELECT`s of `properties`, which the choke point's item
   writes use to validate keys (see [[2026-11-09-persistent-removal-drains-validated-writers-with-a-properties-lock]]),
   are not blocked. The seeding then takes the settings row lock. The order is always table lock first, row lock
   second; `provisionTenant` takes only the row lock and no table lock, so the two cannot wait on each other in a
   cycle.
5. **The marker is written only when a type was created.** A run that creates nothing (every default already listed,
   no Inbox item types database, or every missing default skipped) writes nothing, so a repeated deploy leaves the
   settings item's `updated_at` and version alone. The types and the keys commit together or not at all.
6. **A default whose target database is absent is skipped without recording.** The key stays out of the marker, so the
   first run after that database exists creates the type. A tenant without the Inbox item types database creates
   nothing.
7. **Names are fixed at seeding time.** The names come from the Inbox catalog `seed.inboxTypes.<key>.name` in the locale
   of the tenant's user, Czech while the tenant has no user. A later locale change does not rename a type.
8. **Ordering in the cutover list.** The step stands after the journal-method step, because the defaults Thought and
   Mood use the `journal` method that step makes valid, and after the steps of the sources it declares as blockers; the
   area-note step stays last. `provisionTenant` calls the seeding after the system seed and the module data migrations,
   because the defaults target databases those create.
9. **Contract for a later module.** A module that brings its own default type appends one row to `DEFAULT_INBOX_TYPES`
   (a new key, its emoji, method and target). Existing tenants receive that one type once at the next deploy, new
   tenants with the rest, and nothing else changes: no cutover, marker or lock is added. A key is never renamed or
   reused for another meaning, because a renamed key would be seeded again for a tenant that holds the old one. A key
   is never removed from the marker; removing a row from the table leaves existing types and keys in place.

## Alternatives rejected

- **One boolean flag ("defaults seeded").** A default added by a later module would never reach a tenant that was
  already seeded.
- **Existence check by name or by emoji on the types database.** A type the user deleted or renamed would be created
  again at the next deploy, and a user type with the same name would block the default.
- **A key stored on each type.** The default would be created again when its type is deleted, which is the case the
  marker exists for; a stored key would also expose an identifier users can edit.
- **A table lock or an advisory lock around the seeding.** Either would add a second lock for state that already has
  a row to lock, and the table lock would block every concurrent write to `items` for the length of the type writes.
- **A dedicated marker table.** The tenant already has a singleton settings row for per-tenant system state; a table
  would need its own row-level-security policy and migration for one list.

## Consequences

- A second seeder, such as a repair job or another provisioning path, reuses `seedDefaultInboxItemTypes` and takes the
  same row lock. A seeder that creates default types without it can duplicate them.
- A deleted default stays deleted for good; restoring it is a user action or a new default key, never a re-run.
- The marker grows by one key per default and is read in full on every deploy; at one short string per default this is
  negligible.
- A key written to the marker without its type (a manual repair) leaves that default permanently uncreated, so the
  marker is changed only by the seeding.
