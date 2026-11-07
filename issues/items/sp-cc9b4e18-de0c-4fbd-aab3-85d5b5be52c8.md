---
schemaVersion: 1
id: "sp-cc9b4e18-de0c-4fbd-aab3-85d5b5be52c8"
title: "[backend-delivery 34/74] Implement data/tasks, data/journal, data/chokePoint changes"
kind: "implementation"
state: "open"
stateReason: null
labels: ["execution:batch","execution:sequential","spec:approved"]
parent: "sp-62331d42-78af-4b93-ae97-d5ccbe3324df"
assignees: []
milestone: null
createdAt: "2026-10-31T17:31:01.976Z"
updatedAt: "2026-11-07T19:28:42.079Z"
closedAt: null
source: null
approval: {"specSha256":"dc9eed09653bbd9d28e87f638cb6d06fef48bebce02046936cad4861e7ce392d","source":"repository","actor":"Owner-delegated controller: batch34 grouped seam reconciliation, exact paired owners and actual entrypoint evidence; preserve all production gates","at":"2026-11-07T19:28:42.079Z"}
resolution: null
---
**Blocked by:** sp-1385289a-c057-4dcf-a42f-b2aaded63f7b
**Model tier:** high

## Context

Model tier rationale: This delivery combines several existing backend specifications across typed storage, API and runtime boundaries; preserving their contracts and verifying the combined behavior requires cross-module reasoning.

Use one working tree and one source-writing agent at a time. Implement the complete batch before independent review, AC acceptance and full backend verification. Original feature epics remain reporting groups, not execution units. Preserve every embedded Task, decision and acceptance criterion. Each member's Out of scope limits that member; it does not prohibit another explicitly included member's Task. Do not add behavior beyond the union of member Tasks.

Web and mobile implementation, client catalogs, client builds and client tests are excluded. Backend contracts and server-side tests for device/platform behavior remain included. Product UI descriptions are context only. Do not remove existing client-required backend data merely because client work is deferred.

Follow the scoped execution exception in docs/adr/2026-10-31-sequential-backend-delivery-batches.md. Before starting, reconcile this checkout with any newer local integration history; already-delivered work needs evidence and handover reconciliation, not reimplementation. No source or batch is completed by this planning change.

This is a proposed specification, not execution authorization. Obtain owner approval for this exact batch before queueing. Included unapproved source specifications also remain unapproved.

Execution order: gh-1605 → gh-1670 → gh-1672 → gh-1673 → gh-1609 → gh-2016 → gh-1603 → gh-1612 → gh-1619 → gh-1622. Internal prerequisites are included earlier in this order; prerequisites assigned to previous batches must have passed their gates first. Preserve declared source dependencies; no shared-file dependency has been discarded.

## Task

Implement the following immutable requirement snapshots in the listed order. Load each snapshot's required topic skills. Keep an AC evidence matrix keyed by source ID and criterion, with production entry point, implementation SHA, test/scenario, log path and verdict. Write required tests with the implementation and use targeted checks during development; perform independent review and the complete backend gate after the batch is implemented.

### Requirement gh-1605: [tasks-recurrence 02/11] Give recurring tasks a series identity, template and occurrence date

#### Context

Model tier rationale: It changes a persisted table in place with an idempotent per-tenant backfill and a row-lock contract that other writers must follow, so a mistake corrupts data or deadlocks concurrent completions.

Today every recurring task instance has its own `task_recurrence` row (`item_id` primary key, `mode`, `rule`, `active`; `backend/packages/data/src/db/migrations/0004_ten_databases.sql`). `advanceTaskRecurrenceWithClient` (`backend/packages/data/src/tasks/advanceTaskRecurrenceWithClient.ts`) runs in the same transaction as the `done` write: it creates the next instance through `createItemWithClient`, inserts a fresh row for it and sets `active = false` on the old one. Instances carry no series identity and no occurrence date, so nothing can say "this is the 16 October occurrence of series X". The data migration converter (`backend/packages/data/src/migrationJob/moduleDataMigration.ts`) sees only item properties, not `task_recurrence`, so existing rows need a SQL backfill.

The model is fixed by #1365: one `task_recurrence` row per series, the row follows the current instance, and each occurrence is an item. The Tasks schema for the new properties is added by #1540; the pre-write transform that lets the Tasks module write system-owned properties is #1422. This issue builds the storage and the identity; the HTTP API for rules is #1665 and #1667, the advance logic rewrite is #1670, projection is #1672.

Decision: tasks that were already done before the backfill stay without `seriesId` (their series history is not reconstructed). The product accepted that the history of old series is not shown for them.

Shared-file ordering: this issue also waits for #1600 because both edit the same registry, manifest, cutover, route matrix or hook files listed in Touches.

Batch 34 reconciliation: A successful cutover covers every eligible active, non-done row. A missing Tasks instance or invalid/missing date must fail the tenant transaction unchanged, not invent an anchor or report a skipped row as success. Presets use the written definitions of #1665; that route is not implemented here. Included #1670 replaces computeNextDueDate.

#### Task

Load `db-migrations`, `state-writes`, `canonical-keys` and `testing`.

1. Add an additive migration `backend/packages/data/src/db/migrations/NNNN_task_recurrence_series.sql` (next free ordinal at commit time) that adds to `task_recurrence`: `series_id uuid`, `anchor_date date` and `template jsonb`, plus a unique index on `(tenant_id, series_id)`. The columns are nullable at this step; the backfill fills them. Follow the tenant, row-level-security and grant conventions of the existing table.
2. Add a per-tenant cutover `runTaskRecurrenceSeriesCutoverMigration` (new file under `backend/packages/data/src/tasks/`) written in SQL and registered in `runTenantCutoverMigrations`. For every active `task_recurrence` row it sets a new `series_id`, `anchor_date` = the instance's current `date`, `template` = `{name, timeFrom, timeTo, notifications, persistent, flagged, description}` taken from the instance, and writes `seriesId`, `occurrenceDate` (= the instance's `date`) and `recurrence` (`{preset, mode, rule}`; `preset` is null when the rule matches none of the presets of #1665) onto the instance item properties. It is idempotent: a row that already has `series_id` is skipped, so the second run changes nothing. Inactive rows and done instances are not given a series.
3. Extend `taskRecurrenceStore.ts`: the `TaskRecurrence` type and mapping carry `seriesId`, `anchorDate`, `template`; add `getTaskRecurrenceBySeriesId` (with a `FOR UPDATE` overload on a `PoolClient`, like `getTaskRecurrence`); `createTaskRecurrence` now creates a series (new `series_id`, anchor and template).
4. Change `advanceTaskRecurrenceWithClient.ts`: the new instance receives the old instance's `seriesId` and a `recurrence` copy, and the single `task_recurrence` row is updated in place (`item_id` = new instance) instead of inserting a new row and deactivating the old one. Write the system-owned properties `seriesId`, `occurrenceDate` and `recurrence` through the Tasks write path of #1422, or, if that is not usable inside the choke point, through `createItemWithClient` with `allowedSystemKeys` and `systemOwnerProcess: 'tasks'`. The next instance's `occurrenceDate` is the date computed by the existing `computeNextDueDate` (replacing that computation is #1670). Keep the lock order items, then `task_recurrence`.
5. Include `seriesId`, `occurrenceDate` and `recurrence` in the item response for Tasks. A client write of any of the three is rejected with 403 because the properties are owned by `system`.
6. Tests: backfill produces series data for every active row and a second run changes nothing; advancing keeps the `seriesId`, overwrites `item_id` and creates no second row; a client PATCH of `seriesId` returns 403; two concurrent `done` writes on the same instance create one next instance.

#### Touches

- backend/packages/data/src/db/migrations/NNNN_task_recurrence_series.sql (next free ordinal at commit time)
- backend/packages/data/src/db/tenantCutoverMigrations.ts (one registration line)
- backend/packages/data/src/tasks/taskRecurrenceSeriesCutoverMigration.ts (new)
- backend/packages/data/src/tasks/taskRecurrenceStore.ts
- backend/packages/data/src/tasks/advanceTaskRecurrenceWithClient.ts
- backend/packages/data/src/index.ts (barrel export if a new symbol is public)
- backend/packages/data/src/__tests__/ (new tests for the cutover, advance and ownership)

- backend/services/semprec-api/src/__tests__/batch34Contracts.test.ts
- backend/packages/data/src/testSupport/taskSeriesFixtures.ts

#### Scope

##### In scope

- Series columns, backfill, store changes, advance carrying the series, the three response fields and their `system` ownership.

##### Out of scope

- The ADR itself: #1365. The Tasks schema entries for the properties: #1540.
- Setting, changing or clearing a rule over HTTP: #1665. Editing the series template: #1667.
- Rewriting how the next occurrence is computed and making advance idempotent per date: #1670.
- Dropping inactive `task_recurrence` rows: a later contract step, not part of this issue.
- Carrying the other new Tasks fields to the next instance: #1673.

#### Acceptance criteria

- After the cutover every active recurring instance has `seriesId`, `occurrenceDate` and `recurrence`; running it again changes no row.
- GET of a recurring task returns `seriesId`, `occurrenceDate` and `recurrence`; PATCH writing any of them as a client returns 403.
- When a recurring task is set to `done`, the next instance has the same `seriesId`, the `task_recurrence` row has the new `item_id`, and no additional row exists.
- Two concurrent completions of the same instance produce exactly one open next instance.
- Done instances from before the cutover have no `seriesId`.

### Requirement gh-1670: [tasks-recurrence 06/11] Advance a series past the completed occurrence idempotently

#### Context

Model tier rationale: It replaces the core recurring-task advance with series-aware logic under a row-lock ordering that concurrent completions and the midnight job must also obey, so wrong ordering means duplicate occurrences or deadlocks.

Today `advanceTaskRecurrenceWithClient` (`backend/packages/data/src/tasks/advanceTaskRecurrenceWithClient.ts`), called by `taskRecurrenceItemUpdateHook` (`backend/packages/data/src/tasks/taskRecurrenceItemUpdateHook.ts`) in the `done` transaction, locks the `task_recurrence` row by `item_id` and returns when `active` is false. The first `done` deactivates the row, so repeated `done` and `done`, `notDone`, `done` never create a second instance. But the next date comes from `computeNextDueDate` (`backend/packages/data/src/tasks/nextDueDate.ts`), which looks strictly after the server's current day. Completing a weekly Monday task early on Friday 16 October creates the next one on Monday 19 October again, which is the same date as the one already open; completing yesterday's daily task late skips today. Also `done` then `notDone` leaves two open instances.

#1605 gave every instance a `seriesId` and an `occurrenceDate` and made `task_recurrence` one row per series whose `item_id` points at the current instance. #1544 stores the day a task was completed (`completedOn`), which floating rules count from. This issue rewrites the advance so that the next occurrence is computed from the occurrence's own date and is created at most once per date. Later issues use the same functions: #1720 (single occurrences), #1677 (midnight close) and #1673 (carrying fields to the next instance).

Decision: floating rules count from `completedOn`, fixed rules from the completed occurrence's `occurrenceDate`; an early completion never creates an occurrence on or before today's open one.

Decision (product owner): `wontDo` on an occurrence advances the series the same way `done` does; it never ends the series. `wontDo` concerns only that occurrence; the user ends a series explicitly. For a floating rule the base of a `wontDo` advance is the day of the write in the tenant time zone (a `wontDo` occurrence has no `completedOn`, #1544).

Batch 34 reconciliation: The template supplies the next instance except flagged/description, which included #1673 explicitly copies from the completed instance.

#### Task

Load `state-writes`, `canonical-keys`, `error-handling` and `testing`.

1. In `nextDueDate.ts` add two pure functions, tested on their own: `firstOccurrenceAfter(rule, occurrenceDate, notBefore, floatingBase = notBefore)` returns the first date by the rule that is after `occurrenceDate` and not before `notBefore` (pure: the caller supplies the server's today in the system timezone as `notBefore`; floating `floatingBase` is `completedOn`, or today for `wontDo`), and `latestOccurrenceOnOrBefore(rule, anchorDate, today)` returns the last date by the rule that is on or before `today` (null if none). Both are exported for #1677.
2. Rewrite `advanceTaskRecurrenceWithClient` so that: the series is found by the completed item's `seriesId` (an item without `seriesId` is a no-op, as before the series existed); the item is locked first, then the `task_recurrence` row `FOR UPDATE`; the next date is `firstOccurrenceAfter(occurrenceDate, today)`; if a non-deleted item with the same `seriesId` and `occurrenceDate` already exists, nothing is created (idempotent); otherwise the new instance is created with that `occurrenceDate` and `date`, the template properties and the same `seriesId`, and `task_recurrence.item_id` is moved to it. The relation-edge copy stays. In `taskRecurrenceItemUpdateHook.ts`, call the advance for a transition to `wontDo` as well as to `done` (today the hook reacts only to `done`, so `wontDo` silently ends the series); the same lock order and the same idempotency (at most one occurrence per date) apply.
3. Remove the use of `computeNextDueDate(new Date())` from the advance path. Keep `computeNextDueDate` exported only if another caller still uses it.
4. Tests: completing the Monday 19 October weekly occurrence on Friday 16 October creates Monday 26 October; completing the Monday 12 October occurrence on Friday 16 October creates Monday 19 October; done, notDone, done on the same occurrence leaves at most one open occurrence per date; late completion of yesterday's daily occurrence creates today's occurrence; setting the Monday 19 October weekly occurrence to `wontDo` on Friday 16 October creates Monday 26 October; setting it to `wontDo` twice, or `wontDo` then `done`, creates no second next occurrence; two concurrent completions create one instance; both date functions on fixed and floating rules, including month-end and nth-weekday rules.

#### Touches

- backend/packages/data/src/tasks/nextDueDate.ts
- backend/packages/data/src/tasks/advanceTaskRecurrenceWithClient.ts
- backend/packages/data/src/tasks/taskRecurrenceItemUpdateHook.ts
- backend/packages/data/src/tasks/taskRecurrenceStore.ts (lookup by item and series)
- backend/packages/data/src/index.ts (barrel export of the two new functions)
- backend/packages/data/src/__tests__/ (advance and date-function tests)

- backend/packages/data/src/tasks/advanceTaskRecurrence.ts (matching docstring)

#### Scope

##### In scope

- The two date functions, the series-aware idempotent advance and the lock order.

##### Out of scope

- Materializing a chosen occurrence ahead of time or moving it: #1720.
- The `missed` status and its midnight write: #1668, #1677.
- The completion day and time fields: #1544.
- Carrying the new Tasks fields to the next instance: #1673.

#### Acceptance criteria

- When the Monday 19 October occurrence is completed on Friday 16 October, the next occurrence is created for Monday 26 October; completing the Monday 12 October one on the same day creates Monday 19 October.
- When the same task is set to `done`, `notDone` and `done` again, the series has at most one open occurrence per date.
- When yesterday's daily occurrence is completed today, the next occurrence is dated today.
- When two completions of the same occurrence run concurrently, exactly one next occurrence exists.
- A floating rule counts from `completedOn`; a fixed rule from `occurrenceDate`.
- When an occurrence of a recurring task is set to `wontDo`, then the next occurrence is created as for `done` and the series stays active.

### Requirement gh-1672: [tasks-recurrence 08/11] Project virtual task occurrences in the data layer

#### Context

Model tier rationale: One read-side function in the data layer built on series data and date functions that already exist, with no new endpoint, lock or persisted contract.

The calendar timeline must show a recurring task on every day the rule gives, not only on the day of the one stored instance. Only the current open instance and occurrences with their own state exist as items (model recorded by #1365, storage by #1605). The other days are virtual: derived from the series rule and template. The timeline endpoint itself is built in #1717 and expands task occurrences in #1886; that issue consumes the function delivered here. This issue builds only the projection function, so that the calendar does not need its own recurrence logic.

Today no such function exists. The rule evaluation helpers are in `backend/packages/data/src/tasks/nextDueDate.ts`, and `task_recurrence` rows are read through `backend/packages/data/src/tasks/taskRecurrenceStore.ts`.

Decision: a virtual occurrence dated before today has the status `missed` in the projection (the state it will have when closed), and ticking it creates a real item with status `done` through #1720. The `missed` option is added to the status select by #1668; until then the projection reports the value as a plain string.

Batch 34 reconciliation: Materialized occurrences in the range remain visible off-rule. Floating virtual dates use anchor plus whole intervals; inactive series have no virtual date after their last live materialized occurrence, or any when none exists.

#### Task

Load `canonical-keys` and `testing`.

1. Add `projectTaskOccurrences(client, {from, to, today})` in a new file under `backend/packages/data/src/tasks/`. For every active series it returns, for each date by the rule within `[from, to]`, either the materialized item (existing item with that `seriesId` and `occurrenceDate`, not deleted) or a virtual occurrence `{id: "<seriesId>@<occurrenceDate>", seriesId, occurrenceDate, virtual: true, properties}` where `properties` are the series template plus `date` = `occurrenceDate` and `status`: `notDone` for dates on or after `today`, `missed` for dates before `today` (a trace of a missed occurrence).
2. Dates before `anchor_date` are not produced. A series that was turned off produces nothing after the last materialized occurrence.
3. The function reads in one query per kind (series rows, materialized items) for the range, not one query per date, and caps the range at 400 days, rejecting a larger one with a validation error.
4. Export the function from the data package barrel.
5. Tests: range 12 to 18 October of a daily series with done items on 12 to 14 October, an open item on 16 October and a missed 15 October gives done, done, done, missed, open, virtual, virtual; once the 17 October item is materialized as `done`, the projection returns the item instead of a virtual one.

#### Touches

- backend/packages/data/src/tasks/projectTaskOccurrences.ts (new)
- backend/packages/data/src/tasks/nextDueDate.ts (export of the range helper, if needed)
- backend/packages/data/src/index.ts (barrel export)
- backend/packages/data/src/__tests__/ (new projection tests)

- backend/packages/data/src/testSupport/taskSeriesFixtures.ts

#### Scope

##### In scope

- The projection function and its tests.

##### Out of scope

- The HTTP timeline and expanding occurrences into it: #1717, #1886.
- Creating the real item when a virtual occurrence is ticked or moved: #1720.
- Writing the `missed` status: #1668, #1677.
- Event occurrences: #1877.

#### Acceptance criteria

- For a daily series with done occurrences on 12 to 14 October, a missed one on 15 October, an open one on 16 October and today 16 October, the projection for 12 to 18 October returns those items and virtual occurrences for 17 and 18 October.
- A daily series whose last occurrence is 13 October with today 16 October projects 14 and 15 October as missed.
- After materializing 17 October as done the projection no longer returns a virtual occurrence for that date.
- A range longer than 400 days is rejected.

### Requirement gh-1673: [tasks-core 06/11] Carry the new Tasks fields into the next recurring instance

#### Context

Model tier rationale: One mechanism in one function (`advanceTaskRecurrenceWithClient`), with an existing recurrence test fixture, but it changes which relation edges are copied and must stay atomic with the completion write.

When a recurring task is completed, the next instance is created inside the same transaction by `advanceTaskRecurrenceWithClient` in `backend/packages/data/src/tasks/advanceTaskRecurrenceWithClient.ts`. Today it copies only `name`, `timeFrom`, `timeTo`, `notifications` and `persistent` (the derived `time` follows), computes `date` with `computeNextDueDate`, sets `status` to `notDone`, and then `copyRelationEdges` re-creates every relation edge of the old task on the new one, including `Events.actionItems` edges, except edges to a soft-deleted counterpart. A new relation therefore carries over by accident rather than by decision, and the new task fields (flag, description, people, files) would be lost.

The schema for these fields comes from #1540. The recurrence model (series identity, whether a next instance exists at all) is recorded by the ADR from #1365. Advancing past a completed occurrence idempotently is #1670, which edits the same function; this issue builds on it and adds the field and relation rules. #1764 (placing tasks into events) builds on this issue because it adds relations that must not be copied.

If the recurrence ADR from #1365 chooses virtual occurrences with no separate next task item, this issue is not needed and is closed without implementation, with that stated in the pull request.

Product rules:

- The next instance keeps the task's flag and description.
- It keeps the task's project, people and attachments (the links to the same files), nothing else.
- It is not linked to the events the previous instance was hosted in, to the event the previous instance came from, or to the event it was completed in.

Decision: people and attachments carry over to the next instance (the conservative choice, since losing them silently is worse than keeping them).

Batch 34 reconciliation: Test flagged/description edits after series creation and their absent defaults; do not substitute the original template. Value-link fixtures exercise the real store, not a claim that a Tasks link-rule producer already exists.

#### Task

Load `state-writes`, `canonical-keys` and `testing`.

1. In `advanceTaskRecurrenceWithClient.ts`, add `flagged` and `description` to the properties copied from the completed instance (`flagged` defaults to `false`, `description` to null when absent). The copy remains an explicit allowlist of property keys.
2. Replace the "copy every edge" behavior of `copyRelationEdges` with a fixed allowlist of Tasks-side relation keys, each with the metadata policy used today (edge metadata is copied unchanged): `project`, `people`, `files`. The allowlist is a named constant next to the function, with a comment stating that a new relation is not carried over until it is added here. Edges of any other relation (`hostEvents`, `completedInEvent`, `sourceEvents` and the Events-side `actionItems`) are skipped. Keep the existing skip for a counterpart that was soft-deleted, and keep using `TASKS_RELATION_CONTEXT`.
3. Value links whose source is the completed task (the inherited project of its attachments, from the value-link store introduced by #1403) are moved to the new instance in the same transaction, so the attachments of the new instance keep following the project of the instance that now carries them. When the value-link store is not yet present in the codebase, skip this step and say so in the pull request.
4. Tests (real database, extending the recurrence fixtures): completing a recurring task that has a flag, a description, a project, two people, a file and an action-item edge creates an instance with the same flag, description, project, people and file and without the action-item edge; every other relation key is skipped; the old and new instances are written in one transaction (a failure after the new item rolls back both).

#### Touches

- backend/packages/data/src/tasks/advanceTaskRecurrenceWithClient.ts
- tests under backend/packages/data/src/tasks/__tests__/

- backend/packages/data/src/chokePoint/valueLinksStore.ts (moveValueLinkItemSources only)
- backend/packages/data/src/__tests__/valueLinksStore.test.ts
- backend/packages/data/src/testSupport/taskSeriesFixtures.ts

#### Scope

##### In scope

- Carrying `flagged`, `description` and the `project`, `people`, `files` edges, and refusing every other edge, when the next instance is created.

##### Out of scope

- The decision whether a next instance is created at all, idempotent advance and missed occurrences: #1670 and #1365.
- Placing tasks into events and copying that state: #1764.
- Computing the next date.

#### Acceptance criteria

- When a recurring task with a flag, a description, a project, people and an attached file is completed, then the new instance has the same flag and description and the same project, people and file edges.
- When the completed task had action-item, host-event or completed-in-event edges, then the new instance has none of them.
- When a counterpart of a copied edge is soft-deleted, then that edge is skipped and the advance still succeeds.
- When the transaction fails after the new instance was created, then neither the completion write nor the new instance persists.

### Requirement gh-1609: [journal 11/21] Relate Journal entries to Events

#### Context

Model tier rationale: Same schema-locked cutover mechanism as the project relation, repeated for a second property, with the added constraint of sharing the same hotspot files and running after the first.

Journal entries should be linkable to calendar events (a day mentions the stand-up it is about, and the weekly clean-up adds missing links to calendar events). Journal has no relation to Events today (`backend/packages/data/src/seed/seedTenDatabases.ts`). Journal is schema-locked, so the property is added to populated tenants by a per-tenant cutover migration with direct SQL, exactly as #1545 does for `project`; both extend the same seed block, the same `runTenantCutoverMigrations` call list and the same label catalogs, so this issue follows that one.

The relation is derived from the day's text: an event link in the page adds the relation and removing the link removes it, so the text is the single source of truth. #2016 keeps the relation in sync with the links; Semp's clean-up heartbeat (#1883) adds event links to the text, not edges.

Decision: system-owned (owner `system`, owner process `journalEventLinks`, exported as `JOURNAL_EVENT_LINKS_OWNER_PROCESS` from `journal/journalOwnerProcesses.ts`), many-to-many, one-directional; no inverse property on Events. A user, agent or MCP write through the generic relation endpoint is refused with the existing `owner_violation`.

Shared-file ordering: this issue also waits for #1605 because both edit the same registry, manifest, cutover, route matrix or hook files listed in Touches.

#### Task

Load `db-migrations`, `canonical-keys` and `testing`.

1. Add `backend/packages/data/src/journal/journalOwnerProcesses.ts` with the constant `JOURNAL_EVENT_LINKS_OWNER_PROCESS = 'journalEventLinks'`. In `seedTenDatabases.ts` declare the relation `events` on Journal, target Events, `many_to_many`, owner `system` with that owner process, no inverse, after the `project` relation.
2. Add `journalEventsCutoverMigration.ts` (or extend the cutover of #1545 with a second idempotent step) and call it from `runTenantCutoverMigrations`: skip when Journal or Events is missing or the `events` property already exists, otherwise insert the property (owner `system`, the owner process above), relation definition and config with direct SQL.
3. Add the labels `property.journal.events.name` to `seed/i18n/cs.json` ("Události") and `seed/i18n/en.json` ("Events").
4. Tests: cutover adds the property to a populated tenant and is idempotent; a fresh seed has it; a write through the generic relation endpoint is refused with 403 `owner_violation`; a system caller with the owner process `journalEventLinks` can link a Journal day to an event; the Czech schema label is "Události".

#### Touches

- backend/packages/data/src/seed/seedTenDatabases.ts (Journal relations block)
- backend/packages/data/src/journal/journalOwnerProcesses.ts (new, owner process constant)
- backend/packages/data/src/journal/journalEventsCutoverMigration.ts (new)
- backend/packages/data/src/db/tenantCutoverMigrations.ts (one call added)
- backend/packages/data/src/seed/i18n/cs.json
- backend/packages/data/src/seed/i18n/en.json
- backend/packages/data/src/__tests__/ (cutover and seed tests)

- backend/packages/data/src/manifest/knownActionIds.ts (journalEventLinks owner registry)
- backend/services/semprec-api/src/__tests__/batch34Contracts.test.ts
- backend/services/semprec-api/src/mcp/__tests__/mcpGenericOperationsContract.test.ts
- backend/services/semprec-api/src/__tests__/schemaHandler.test.ts

#### Scope

##### In scope

- The Journal `events` relation: seed, tenant cutover, labels and tests.

##### Out of scope

- The `project` relation; #1545.
- Deriving the relation from event links in the page text: #2016 (#1614 keeps the link as plain content).
- The weekly clean-up that writes the relation; #1883.

#### Acceptance criteria

- When the cutover runs on an existing tenant, then Journal has the relation property `events` to Events; running it twice changes nothing.
- When a user writes the `events` relation through the generic relation endpoint, then the response is 403 `owner_violation`.
- When a system caller with the owner process `journalEventLinks` links a day to an event, then reading the day returns the link.
- When the schema is requested in Czech, then the label of `events` is "Události".

### Requirement gh-2016: [journal 16/21] Derive the Journal events relation from event links in the day's text

#### Context

Model tier rationale: One derived-value sync step hooked into an existing after-document-update job, computing a set difference of relation edges under a system owner process; the edge writes and the trigger exist, but create and delete must stay exactly in step with the text.

A Journal day often refers to calendar events in its text. #1614 lets page Markdown carry an item link `[Title](semprec://items/<itemId>)` as the link attribute of a text run, and the parser writes no relation edge. #1609 adds the Journal relation `events` to Events as a system-owned property with owner process `journalEventLinks` (`JOURNAL_EVENT_LINKS_OWNER_PROCESS` in `journal/journalOwnerProcesses.ts`), so users, agents and MCP clients cannot write it directly. #1658 runs a page-text job after a document update, and #1711 adds a call for Journal pages to that job to recompute the entry's summary from its Markdown (#1608).

Decision: the `events` relation of a Journal entry is a derived value: every link in the entry's page to an Events item adds the relation, and removing the link removes it. The text is the single source of truth; there is no other writer of the relation.

Shared-file ordering: this issue also waits for #1711 because both edit the after-document-update job for Journal pages.

Batch 34 reconciliation: No page doc means no text sync; no historical backfill is added. Generic relation refusal must also be observed at the actual entry point.

#### Task

Load `state-writes`, `canonical-keys` and `testing`.

1. Add `syncJournalEventLinks(client, journalItemId, markdown)` in `backend/packages/data/src/journal/journalEventLinks.ts`: collect the destinations `semprec://items/<id>` of the inline links in the Markdown, keep the ids that are live (not trashed) items of the tenant's Events database, and compare that set with the entry's current `events` edges.
2. Create each missing edge and delete each edge whose event is no longer linked, through the choke point relation operations with the system relation context owner process `JOURNAL_EVENT_LINKS_OWNER_PROCESS`, in one transaction. When the two sets are equal, write nothing.
3. Links to items of other databases are ignored. A link to an event that is in the trash does not count, so its edge is removed on the next sync.
4. Call it from the after-document-update job for a Journal entry's page, next to the summary recompute of #1711, with the Markdown that job already serialises; do not serialise the page a second time.
5. Tests: a day whose page gains `[Standup](semprec://items/<event id>)` has the `events` edge to that event after the job runs; removing the link removes the edge; two links to the same event give one edge; a link to a task creates no edge; an unchanged page writes no edge and announces nothing; a user write through the generic relation endpoint is still refused; another tenant's event ids are never linked.

#### Touches

- backend/packages/data/src/journal/journalEventLinks.ts (new)
- the after-document-update job delivered by #1658 (one extra call for Journal pages, next to the call of #1711)
- backend/packages/data/src/journal/__tests__/ (event link sync tests)

- backend/services/semprec-api/src/__tests__/batch34Contracts.test.ts
- backend/services/semprec-api/src/mcp/__tests__/mcpGenericOperationsContract.test.ts

#### Scope

##### In scope

- Keeping the Journal `events` relation equal to the set of event links in the entry's page.

##### Out of scope

- The item link syntax, its validation and serialization; #1614.
- The `events` property, its owner and cutover; #1609.
- Links to items other than events, which stay plain content.
- Backfilling entries that exist before this issue; they sync on their next page edit.

#### Acceptance criteria

- When a link to an event is added to a day's page, then after the job runs the day has the `events` relation to that event.
- When the link is removed from the page, then after the job runs the relation is gone.
- When the page changes without changing its event links, then no relation is written.
- When a link points to an item that is not an event, then no relation is created.

### Requirement gh-1603: [journal 10/21] Re-link a trashed day's Inbox items to its new Journal entry

#### Context

Model tier rationale: Moves relation edges between items inside the create transaction of another module's write path, across several callers, with a recompute job and system-owned relation guards.

Inbox items belong to a Journal day through the system-owned `journalDay` relation edge, which Inbox capture writes with an internal system relation context (`INBOX_RELATION_CONTEXT`, owner process `inbox`, in `backend/packages/data/src/inbox/inboxCreateHook.ts`). The day's Inbox summary (`backend/packages/data/src/inbox/journalInboxCompute.ts`) reads only the edges that point at that one day item. When a day entry is trashed, its edges are not removed (relations have no soft delete), and the next write for that day creates a different entry (`getOrCreateJournalItem`), so the Inbox items of the old entry disappear from the new day's Inbox section even though they belong to that calendar day.

New day entries are created by several callers: the lazy-create route and internal function of #1541, the Inbox create hook of #1432, journal proposal confirmation (#1981), subpage creation (#1676) and Semp writes (#1861). The choke point's create-hook registry (ADR `docs/adr/2026-10-09-item-create-domain-hooks.md`) runs after a real insert and never on an idempotency replay, so one hook on the Journal database covers all of them without changing any caller.

Decision: deleting a Journal period deletes the whole period including its entry (to the trash, restorable for 30 days), not only its page; this re-linking is therefore needed.

Decision: re-linking is done by a create hook owned by the Inbox module, because the edge and its context belong to Inbox; it applies to day entries only.

Shared-file ordering: this issue also waits for #1601 because both edit the same registry, manifest, cutover, route matrix or hook files listed in Touches.

Batch 34 reconciliation: The hook may construct the same internal Inbox process identity. Test actual delivered callers; #1981/#1676/#1861 remain absent-owner evidence limits, not runtime PASS or new producers.

#### Task

Load `state-writes`, `canonical-keys` and `testing`.

1. Add `journalDayRelinkItemCreateHook` in the Inbox module and register it in `backend/packages/data/src/domainWriteHooks.ts`. When the created item belongs to the Journal database and has `type = day`, then inside the same transaction:
   - find trashed Journal day entries with the same `period` (other than the new item);
   - find the live Inbox items whose `journalDay` edge points at those entries;
   - for each, delete the edge and create an edge to the new entry, both with the Inbox system relation context (owner process `inbox`);
   - enqueue `JOURNAL_INBOX_RECOMPUTE` for the new entry (and for the old entries, so their cached list is emptied).
2. Do nothing when no trashed entry exists for the period or when none has Inbox items.
3. Tests: delete a day with seven Inbox items, then write to the same day (through the lazy create function): the new entry's `computed.inboxItems` contains all seven; items of other days are untouched; a replayed create does not re-run the relink; the hook works when the new entry is created by Inbox capture itself.

#### Touches

- backend/packages/data/src/domainWriteHooks.ts (hook registration line)
- backend/packages/data/src/inbox/journalDayRelinkHook.ts (new)
- backend/packages/data/src/inbox/__tests__/ (relink tests)

#### Scope

##### In scope

- Moving the `journalDay` edges of a trashed day's live Inbox items to the day's new entry, with recompute.

##### Out of scope

- Refusing restore of a duplicate period; #1666.
- Weeks, months, quarters and years, which have no Inbox items.
- Making a Journal delete remove only the page and keep the entry (not planned: a delete moves the whole entry to the trash).

#### Acceptance criteria

- When a day with seven Inbox items was deleted and a new entry for that day is created, then the new entry's `computed.inboxItems` lists all seven.
- When a new day entry is created for a period with no trashed entry, then no edge is written.
- When the entry is created by any of the callers above, then the Inbox items are re-linked the same way.
- When the create is an idempotent replay, then no edge changes.

### Requirement gh-1612: [mail-items 02/15] Link tasks to their source thread

#### Context

Model tier rationale: One relation schema addition with a seed and an idempotent per-tenant cutover that follows an existing pattern, plus a test that the merge path moves its edges.

A task made from a mail thread must point back to the thread. Today the Tasks database (`seed/seedTenDatabases.ts`, schema locked) has no link to threads or emails, and Tasks gain further fields in the task schema cutover #1540. The Threads database comes from #1573. Because Tasks is locked, the relation lives on the Threads side and is one-directional (like `Emails.attachments`): Threads.tasks, `one_to_many`, Threads is the "one" side so a task has at most one thread. The relation is `owner: user` because Semp creates the edge with the generic `relation.put`. Tasks made from a thread are created by #1900 and listed by #1692.

Decision: the rule that a task has one inheritance source (a thread, or an event action item) is not enforced here; see Out of scope.

Shared-file ordering: this issue also waits for #1609 because both edit the same registry, manifest, cutover, route matrix or hook files listed in Touches.

#### Task

Load `db-migrations`, `canonical-keys` and `testing`.

1. In the shared Threads database builder (created by #1573 and used by `seed/seedEmailModule.ts` and the cutover) add the relation property `tasks` from Threads to Tasks, `one_to_many`, `owner: user`, one-directional.
2. For existing tenants add `mail/threadTasksCutoverMigration.ts` exporting `runThreadTasksCutoverMigration(pool)` registered after the Threads cutover in `db/tenantCutoverMigrations.ts`: it adds the property only if the Threads database exists and lacks it. Running it twice changes nothing; on a fresh install it is a no-op.
3. Add a test that the merge of two threads (step 6 of #1573) moves the Threads.tasks edges of the losing thread to the winner.

#### Touches

- backend/packages/data/src/seed/seedEmailModule.ts (Threads.tasks in the shared builder)
- backend/packages/data/src/mail/threadTasksCutoverMigration.ts (new)
- backend/packages/data/src/db/tenantCutoverMigrations.ts
- backend/packages/data/src/mail/__tests__/ (new tests)

- backend/packages/data/src/mail/i18n/en.json
- backend/packages/data/src/mail/i18n/cs.json

#### Scope

##### In scope

- The Threads.tasks relation for fresh and existing tenants.

##### Out of scope

- Creating tasks from a thread (#1900); keeping task people in sync (#1923); listing a thread's tasks (#1692).
- The Tasks.people relation (task schema cutover #1540).
- Rejecting a task that also has an event action-item source: this work is not planned yet and waits for a product decision.

#### Acceptance criteria

- On a fresh install and after the cutover on an existing tenant, Threads has a `tasks` relation to Tasks; running the cutover twice adds nothing.
- A second thread cannot be linked to a task that already has a thread edge (one-to-many cardinality).
- After two threads merge, a task linked to the losing thread is linked to the winner.

### Requirement gh-1619: [areas-projects 10/13] Move the area note into the area page

#### Context

Model tier rationale: The step rewrites collaborative CRDT content from a legacy text field while old clients may still write that field, so it needs a transaction-level lock, a marker that makes re-runs and late edits converge without duplicating text, and careful reconciliation, which is difficult concurrency ownership (raised from the suggested medium).

Today an area's note is the plain `note` text property of the Areas database. The product shows the note as the area's page, edited as blocks (with subpages and Markdown), like every other item page. The page itself and its editor are delivered elsewhere: #1616 lets a client ensure an item's page and obtain its doc id (`getOrCreateDoc(client, itemId, 'page')` in `backend/packages/data/src/docs/docsStore.ts` is the underlying primitive), and #1608 provides the canonical Markdown-to-blocks parser. This issue only converts existing note text into the page; it owns the Areas.`note` conversion for the whole program.

The conversion is an expand/contract step in application code, because it must write Yjs documents (`docs/adr/2026-09-10-app-code-post-migration-steps.md`, pattern `backend/packages/data/src/docs/docHistoryCutoverMigration.ts`). It runs inside `runTenantCutoverMigrations` (`backend/packages/data/src/db/tenantCutoverMigrations.ts`) for every maintained tenant, suspended ones included. Old clients keep writing `note` during the expand phase, so the step must pick up later changes without duplicating text. Removing the `note` property is a later contract release and is not part of this issue.

Decision: the marker lives inside the area's own doc, in a root `Y.Map` named `meta`, so it commits atomically with the converted content. It holds `legacyNoteSource` (the exact `note` text last converted) and `legacyNoteBlockIds` (the ids of the blocks the conversion created). The step behaves as follows per area: empty or absent `note` -> skip; marker equals current `note` -> skip; no marker -> create the blocks from the note and append them to the page; marker present but differs -> remove only the blocks listed in `legacyNoteBlockIds` that still exist, insert blocks for the new text, update the marker. Blocks a user added or edited by hand in the page are never touched by a later run except for the generated blocks being replaced.

Shared-file ordering: this issue also waits for #1612 because both edit the same registry, manifest, cutover, route matrix or hook files listed in Touches.

Batch 34 reconciliation: Use the existing document-write lock order: doc_snapshots before docs, then read/mutate. Process all areas; report collected failures afterward and register this step last. No accepted ADR body is edited.

#### Task

Load `state-writes`, `db-migrations` and `testing`.

1. Add `backend/packages/data/src/docs/areaNoteCutoverMigration.ts` exporting a step registered in `runTenantCutoverMigrations`. Per tenant, find the Areas database by owner module id; for each area item with a non-empty `note`, run in its own transaction: `getOrCreateDoc` for the item as kind `page`, take a row lock on the `docs` row (`SELECT ... FOR UPDATE`) so a concurrent second run waits and then sees the marker, then apply the marker rules above with `mutateDocWithClient` (origin `system`), converting text with the parser from #1608 and following the page root and block conventions #1616 establishes.
2. One area failing does not stop the others; the step is idempotent per area and leaves the `note` property untouched.
3. Tests: first run puts the note text into the doc; a second run does not duplicate it; a note changed after conversion replaces only the generated blocks; hand-added blocks survive; two concurrent runs produce the text once; an area with an empty note gets no doc; a tenant without Areas is a no-op; a suspended tenant is converted.

#### Touches

- backend/packages/data/src/docs/areaNoteCutoverMigration.ts (new)
- backend/packages/data/src/db/tenantCutoverMigrations.ts (register the step)
- backend/packages/data/src/__tests__/areaNoteCutoverMigration.test.ts (new)

#### Scope

##### In scope

- Converting `note` text to blocks in the area's page doc, once and idempotently, and reconciling later legacy edits.

##### Out of scope

- The page read and ensure operations and the note editor: #1616.
- The Markdown parser itself: #1608.
- Subpages of an area page: #1676.
- Removing the `note` property: a later release after all clients have switched.
- Icon, color and position of areas: #1515.

#### Acceptance criteria

- After the step runs, an area whose `note` was "Klientské zakázky a vlastní produkty. Pátky bez schůzek." has that text in its page doc.
- When the step runs a second time, then the page text is unchanged and not duplicated, including when two runs overlap.
- When an old client changes `note` afterwards and the step runs again, then the generated blocks reflect the new text and blocks added by hand remain.
- Areas with an empty `note` get no doc and no error; the `note` property values are never modified.
- The full backend `pnpm run verify` passes.

### Requirement gh-1622: [collection-schema 12/14] Store numeric filter presets on number properties

#### Context

Model tier rationale: A small validated config shape and a labels projection on top of the select-color mechanism, following existing patterns in the same three files, with no new lifecycle, authorization or isolation contract; the cutover is a short idempotent config write modelled on an existing one.

A number property such as a rating or a preparation time has no fixed set of values, so the app cannot offer it as a filter. The product filters numbers through a few named thresholds: for Books and Movies "5 stars", "4 and up", "3 and up" (greater-or-equal) plus "No rating" (empty or 0); for Recipes "Up to 15 min", "Up to 30 min", "Up to an hour" (less-or-equal). Today a property's `config` is a free `jsonObject` (`backend/packages/shared/src/genericOperations/schemas.ts`), nobody stores presets and nothing validates them, and `GET /api/schema` shows no presets. `books.rating` and `movies.rating` are plain `number` properties seeded in `backend/packages/data/src/seed/seedLibraryModule.ts`; their labels live in `backend/packages/data/src/library/i18n/{cs,en}.json`.

Builds on #1360 (a number property is `filterable` only when it has presets, and `config.filterPresets` is already passed through), #1584 (the cutover registry entry order and the property-config validation seam this extends), and #1361 (aligned Library labels in `library/i18n`, which this adds keys to). #1759 computes facet counts using each preset's `op`, and #1707 seeds `recipes.prepMinutes` with the same shape.

Decision: a preset's `labelKey` is a full catalog key resolved against the owning module's catalog for the caller's locale (same resolver as option labels, `resolveCatalogLabel`). A preset may also carry an optional literal `label` that wins over the catalog, so a user-created database without a catalog can still show readable names; without either, the label falls back to the `labelKey` text, as option labels fall back to their key today.

Decision: only `lte` and `gte` are allowed. Equality is not a preset operator; `eq` is rejected.

Shared-file ordering: this issue also waits for #1619 because both edit the same registry, manifest, cutover, route matrix or hook files listed in Touches.

Batch 34 reconciliation: Validate the final type/config pair on retype; without replacement config, presets cannot survive on a non-number type. Drop malformed stored presets without logging in the pure projection. Facade tests do not replace named HTTP contract proof.

#### Task

Load `canonical-keys`, `db-migrations`, `error-handling` and `testing`.

1. In `shared/src/genericOperations/schemas.ts` export a strict zod schema for the number-filter config part: `filterPresets`: non-empty array (at most 10) of `{ value: finite number, op: "lte" | "gte", labelKey: non-empty string, label?: non-empty string }`; `emptyPreset?`: `{ labelKey: non-empty string, label?: non-empty string, matchZero: boolean }`. Unknown keys inside these objects are rejected.
2. Validate it in the property write path: in `chokePoint/propertiesStore.ts` (the function that already validates select options for `createProperty` and `updatePropertyConfig`) apply the schema to `config.filterPresets` / `config.emptyPreset` when the property type is `number`, throwing `ValidationError` with `field: "config"` (HTTP 400) on failure. `emptyPreset` without `filterPresets` is rejected. Other config keys are left alone; for non-number types a `filterPresets` key is rejected.
3. Project it in `manifest/catalogResolution.ts` `resolveProperty` for `number`: `config.filterPresets` becomes `[{ value, op, label }]` and `config.emptyPreset` becomes `{ label, matchZero }`, labels localized for the caller's locale. A stored preset that fails the shape (legacy or direct write) is dropped from the response rather than failing it; if none remain, `filterable` is `false`.
4. Seed for fresh installs in `seed/seedLibraryModule.ts`: `books.rating` and `movies.rating` get `filterPresets` `[{5,gte},{4,gte},{3,gte}]` with label keys `property.<db>.rating.preset.5`, `.4`, `.3`, and `emptyPreset` `{ labelKey: "property.<db>.rating.preset.none", matchZero: true }`. Add the labels to `library/i18n/en.json` ("5 stars", "4 and up", "3 and up", "No rating") and `cs.json` ("5 hvězd", "4 a víc", "3 a víc", "Bez hodnocení"), for both `books` and `movies`.
5. Add a per-tenant cutover step (new file, registered in `runTenantCutoverMigrations` after the select-color step) that writes the same config to `books.rating` and `movies.rating` of existing tenants when they have no `filterPresets` yet; it skips a missing database or property, never overwrites existing presets, and a second run changes nothing.
6. Tests: valid presets accepted; `op: "eq"`, a non-numeric value, an empty array, an unknown key, and presets on a text property each rejected with 400 on `config`; `/api/schema` returns localized labels for `cs` and `en`; the cutover is idempotent.

#### Touches

- backend/packages/shared/src/genericOperations/schemas.ts (number filter config schema)
- backend/packages/data/src/chokePoint/propertiesStore.ts (number config validation)
- backend/packages/data/src/manifest/catalogResolution.ts (`resolveProperty` preset projection)
- backend/packages/data/src/seed/seedLibraryModule.ts (books and movies rating config)
- backend/packages/data/src/library/i18n/en.json
- backend/packages/data/src/library/i18n/cs.json
- backend/packages/data/src/seed/ratingFilterPresetsCutoverMigration.ts (new)
- backend/packages/data/src/db/tenantCutoverMigrations.ts (register the new step)
- backend/packages/data/src/chokePoint/__tests__/propertiesStore.unit.test.ts
- backend/packages/data/src/__tests__/manifest.test.ts
- backend/packages/data/src/__tests__/tenantCutoverMigrations.test.ts

- backend/services/semprec-api/src/__tests__/batch34Contracts.test.ts
- backend/services/semprec-api/src/__tests__/schemaHandler.test.ts
- backend/packages/data/src/__tests__/catalogResolution.unit.test.ts

#### Scope

##### In scope

- The `filterPresets` / `emptyPreset` config shape, its validation on `property.create` and `property.patch`, and its localized projection in `/api/schema`.
- Seeded presets and labels for Books and Movies ratings, for fresh installs and existing tenants.

##### Out of scope

- Recipes `prepMinutes` presets and labels (#1707).
- Applying presets to queries and computing facet counts (#1759).
- Rating range validation itself (#1402).
- Number comparison conditions in filters (#1534).

#### Acceptance criteria

- When `GET /api/schema` is requested, then `books.rating` has `filterable: true` and presets with `op: "gte"` labelled "5 stars", "4 and up", "3 and up" (en) or "5 hvězd", "4 a víc", "3 a víc" (cs), and an `emptyPreset` labelled "No rating" / "Bez hodnocení" with `matchZero: true`.
- When `property.create` or `property.patch` supplies a preset with `op: "eq"`, then the request fails with 400 and `field` `config`.
- When presets are supplied for a property that is not a number, or `emptyPreset` without `filterPresets`, then the request fails with 400.
- When a number property has no presets, then `filterable` stays `false`.
- When an existing tenant is migrated, then its `books.rating` and `movies.rating` have the presets; a second run changes nothing and a tenant's own presets are never overwritten.

## Touches

- backend/packages/data/src/db/migrations/NNNN_task_recurrence_series.sql (next free ordinal at commit time)
- backend/packages/data/src/db/tenantCutoverMigrations.ts (one registration line)
- backend/packages/data/src/tasks/taskRecurrenceSeriesCutoverMigration.ts (new)
- backend/packages/data/src/tasks/taskRecurrenceStore.ts
- backend/packages/data/src/tasks/advanceTaskRecurrenceWithClient.ts
- backend/packages/data/src/index.ts (barrel export if a new symbol is public)
- backend/packages/data/src/__tests__/ (new tests for the cutover, advance and ownership)
- backend/packages/data/src/tasks/nextDueDate.ts
- backend/packages/data/src/tasks/taskRecurrenceItemUpdateHook.ts
- backend/packages/data/src/tasks/taskRecurrenceStore.ts (lookup by item and series)
- backend/packages/data/src/index.ts (barrel export of the two new functions)
- backend/packages/data/src/__tests__/ (advance and date-function tests)
- backend/packages/data/src/tasks/projectTaskOccurrences.ts (new)
- backend/packages/data/src/tasks/nextDueDate.ts (export of the range helper, if needed)
- backend/packages/data/src/index.ts (barrel export)
- backend/packages/data/src/__tests__/ (new projection tests)
- tests under backend/packages/data/src/tasks/__tests__/
- backend/packages/data/src/seed/seedTenDatabases.ts (Journal relations block)
- backend/packages/data/src/journal/journalOwnerProcesses.ts (new, owner process constant)
- backend/packages/data/src/journal/journalEventsCutoverMigration.ts (new)
- backend/packages/data/src/db/tenantCutoverMigrations.ts (one call added)
- backend/packages/data/src/seed/i18n/cs.json
- backend/packages/data/src/seed/i18n/en.json
- backend/packages/data/src/__tests__/ (cutover and seed tests)
- backend/packages/data/src/journal/journalEventLinks.ts (new)
- the after-document-update job delivered by #1658 (one extra call for Journal pages, next to the call of #1711)
- backend/packages/data/src/journal/__tests__/ (event link sync tests)
- backend/packages/data/src/domainWriteHooks.ts (hook registration line)
- backend/packages/data/src/inbox/journalDayRelinkHook.ts (new)
- backend/packages/data/src/inbox/__tests__/ (relink tests)
- backend/packages/data/src/seed/seedEmailModule.ts (Threads.tasks in the shared builder)
- backend/packages/data/src/mail/threadTasksCutoverMigration.ts (new)
- backend/packages/data/src/db/tenantCutoverMigrations.ts
- backend/packages/data/src/mail/__tests__/ (new tests)
- backend/packages/data/src/docs/areaNoteCutoverMigration.ts (new)
- backend/packages/data/src/db/tenantCutoverMigrations.ts (register the step)
- backend/packages/data/src/__tests__/areaNoteCutoverMigration.test.ts (new)
- backend/packages/shared/src/genericOperations/schemas.ts (number filter config schema)
- backend/packages/data/src/chokePoint/propertiesStore.ts (number config validation)
- backend/packages/data/src/manifest/catalogResolution.ts (`resolveProperty` preset projection)
- backend/packages/data/src/seed/seedLibraryModule.ts (books and movies rating config)
- backend/packages/data/src/library/i18n/en.json
- backend/packages/data/src/library/i18n/cs.json
- backend/packages/data/src/seed/ratingFilterPresetsCutoverMigration.ts (new)
- backend/packages/data/src/db/tenantCutoverMigrations.ts (register the new step)
- backend/packages/data/src/chokePoint/__tests__/propertiesStore.unit.test.ts
- backend/packages/data/src/__tests__/manifest.test.ts
- backend/packages/data/src/__tests__/tenantCutoverMigrations.test.ts

## Scope

### In scope

- Exactly the combined backend Tasks and AC in the requirement snapshots above, including their named tests, migrations and production composition roots.
- Coordinating shared files and migration ordinals across members, without duplicate registration or duplicate ownership.
- Independent review of the entire batch and an explicit verdict for every source criterion.

### Out of scope

- Web/mobile source, screens, navigation, client localization and client validation.
- Requirements not included in this batch, except prerequisites already delivered by earlier batches.
- Automatic approval, automatic deployment, production security sign-off by implementers, and closing a source issue merely because its code was written.

## Acceptance criteria

- Every criterion under every embedded source Acceptance criteria section passes with recorded evidence; none may be sampled, silently omitted or treated as implemented by a stub.
- Required backend tests and functional scenarios exercise production paths, including relevant failures, tenant isolation, concurrency, idempotency and populated-tenant migrations.
- Independent review has no unresolved medium-or-higher findings. Confirmed findings are fixed and affected evidence is rerun against the final candidate SHA.
- The full backend `pnpm run verify` passes. No web or mobile verification is required. A missing external service or required live-provider check is BLOCKED/NOT RUN, never PASS.
- Only after this entire gate passes may this batch and its approved source records be completed with individual handovers pointing to the verified implementation. All source approvals must still match their specifications.
- The next sequential batch starts only after this batch's gate passes; a failure holds advancement.
