---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# A task always has a status

## Context

`Tasks.status` has the `config.default` `notDone`. The default is filled in by the create in `chokePoint/itemWrites.ts` only for a key the caller did not name: it runs after the Tasks pre-write transform and keeps a key that is present. `assertSelectValuesKnown` lets a user or an agent write `null` into any select. A create that names `status: null` therefore stored no status, a patch of `status: null` cleared it, and a task stored before the default existed has none. Readers that assume a status (the thread detail of `GET /api/mail/threads/:threadId`, which sorts open tasks first) had to invent a meaning for the missing one, and the thread detail sorted such a task among the `done` ones.

[[2026-10-29-tasks-date-and-time-rules-in-pre-write-transform]] made the Tasks transform the one place that judges a Tasks write; its rule 6 limits each rule to the writes that name the key it reads. This ADR adds one rule to that transform and fills the rows stored before it.

## Decision

1. **A named status is a nonempty string.** `prepareTaskWrite` (`tasks/taskPreWriteTransform.ts`) refuses a create or an update whose patch has the key `status` with a value that is not a string with at least one character, with a `ValidationError` on `status`. This extends rule 6 of [[2026-10-29-tasks-date-and-time-rules-in-pre-write-transform]], whose text stays as it is: the status rule runs when the patch names `status`, and an update that does not name it passes through unchanged, so a write to a stored row without a status that names none still succeeds. A proposal is refused the same way, because `prepareTaskProposal` calls `prepareTaskWrite`. Which strings are allowed stays with `assertSelectValuesKnown`.
2. **The create default fills only an absent key.** A create that does not name `status` stores `notDone` through the property default. The default does not replace a named value, which is why rule 1 refuses the named ones.
3. **Stored rows are filled by a data migration.** The Tasks transition 1.3.0 to 1.4.0 (`dataMigrations` of `seed/systemDatabasesModuleManifest.ts`, converter `backfillTaskStatus`) sets `status` to `notDone` on every task of the tenant whose status is missing, `null` or not a nonempty string, trashed tasks included. A task with a status keeps its status and its `updated_at`. It runs as every module data migration does, per tenant and in row-locked batches ([[2026-09-28-two-pass-skip-locked-module-data-migration]]); the converter is pure and idempotent, which that decision requires.
4. **Readers may assume a status.** After the transition has run for a tenant, every task of the tenant has a nonempty string `status`, and a write cannot remove it. A reader of Tasks does not branch on a missing status.

## Consequences

- Between the deploy of this decision and the run of the transition for a tenant, a stored task without a status can still exist. The thread detail answers an error for a thread that lists such a task until the transition has run, because its response type has no missing status.
- A caller that clears a status by writing `null` now gets a `400` on `status`. A caller that wants a task open writes `notDone`.
- The manifest `version` of the systemDatabases module is not raised for the transition, as for the Tasks transitions before it.
- A select option that is not in the catalog is still refused by `assertSelectValuesKnown`, not by this rule.
