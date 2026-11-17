---
schemaVersion: 1
id: "sp-db5e1165-5ccf-4fba-bce0-fd7a1f2bc098"
title: "[backend-delivery 17/74] Implement data/mail, data/inbox, semprec-api/adapter changes"
kind: "implementation"
state: "closed"
stateReason: "completed"
labels: ["execution:batch","execution:sequential","spec:approved"]
parent: "sp-62331d42-78af-4b93-ae97-d5ccbe3324df"
assignees: []
milestone: null
createdAt: "2026-10-31T17:31:01.915Z"
updatedAt: "2026-11-03T08:02:08.270Z"
closedAt: "2026-11-03T08:02:08.270Z"
source: null
approval: {"specSha256":"2a65785f46ee5be794cab51068240444124dadbdbf5887dde8eed418c6ab874a","source":"repository","actor":"Owner-delegated controller thr_pz39tcih5r: isolated compiled CLI evidence; native packaging remains unresolved","at":"2026-11-03T06:29:37.414Z"}
resolution: {"pullRequests":[],"commit":"7f862f56f45ff51f85f85944b0ff45ecbddef8ec","at":"2026-11-03T08:02:08.270Z"}
---
**Blocked by:** sp-e02ff8c6-d20d-4fde-be2a-e0033cf9ef91
**Model tier:** high

## Context

Model tier rationale: This delivery combines several existing backend specifications across typed storage, API and runtime boundaries; preserving their contracts and verifying the combined behavior requires cross-module reasoning.

Use one working tree and one source-writing agent at a time. Implement the complete batch before independent review, AC acceptance and full backend verification. Original feature epics remain reporting groups, not execution units. Preserve every embedded Task, decision and acceptance criterion. Each member's Out of scope limits that member; it does not prohibit another explicitly included member's Task. Do not add behavior beyond the union of member Tasks.

Web and mobile implementation, client catalogs, client builds and client tests are excluded. Backend contracts and server-side tests for device/platform behavior remain included. Product UI descriptions are context only. Do not remove existing client-required backend data merely because client work is deferred.

Follow the scoped execution exception in docs/adr/2026-10-31-sequential-backend-delivery-batches.md. Before starting, reconcile this checkout with any newer local integration history; already-delivered work needs evidence and handover reconciliation, not reimplementation. No source or batch is completed by this planning change.

This exact batch is approved for owner-delegated backend execution at dispatch. Follow issues/batches/backend/decisions/batch-17-spec-reconciliation.md and the current recorded hashes; approval does not waive review, runtime gates or completion guards.

Execution order: gh-1431 → gh-1432 → gh-1436 → gh-1439 → gh-1490 → gh-1525 → gh-1494 → gh-1498 → gh-1570 → gh-1637 → gh-1753. Internal prerequisites are included earlier in this order; prerequisites assigned to previous batches must have passed their gates first. Preserve declared source dependencies; no shared-file dependency has been discarded.

## Task

Implement the following immutable requirement snapshots in the listed order. Load each snapshot's required topic skills. Keep an AC evidence matrix keyed by source ID and criterion, with production entry point, implementation SHA, test/scenario, log path and verdict. Write required tests with the implementation and use targeted checks during development; perform independent review and the complete backend gate after the batch is implemented.

### Requirement gh-1431: [journal 03/21] Parse and describe journal period keys with ISO week-year tests

#### Context

Model tier rationale: Pure functions with no persistence, but ISO week-year edge cases (53-week years, week spanning a year boundary, midnight in a zone) are easy to get subtly wrong, so the tier is raised above the mechanical level.

The Journal stores one entry per period, with the canonical period key in the `period` property: `2026` (year), `2026-Q4` (quarter), `2026-10` (month), `2026-W42` (ISO week) and `2026-10-16` (day). `computeJournalPeriodKey` in `backend/packages/data/src/journal/journalStore.ts` produces these keys from an instant (the week key uses luxon's `kkkk-'W'WW`). It has no unit test of its own: only the day key is exercised, indirectly, by the tests of `getOrCreateJournalItem`; week, quarter, year and the turn of the year are tested nowhere. There is no parser for a key, so any route that receives a key from a client (reading or creating a period) has no way to tell `2027-W53` or `2026-02-30` from a valid key.

Callers that build on this: #1537 reads a period and its week by key, #1541 creates a period from a key, and #1837 summarizes periods for the overview. A week has no row of its own in a month; a month shows every ISO week that overlaps it, including weeks that cross the month or year boundary.

Decision: keys stay exactly as `computeJournalPeriodKey` writes them today; nothing is migrated.

#### Task

Load `canonical-keys` and `testing`.

1. In `backend/packages/data/src/journal/journalStore.ts` (or a new `journalPeriods.ts` beside it, re-exported from the store) add `parseJournalPeriodKey(type, key)` returning `{ type, period, reference }` where `reference` is the first instant of the period at 00:00 in the given zone argument. It validates both the format and the existence of the period: `2026-W53` is valid (2026 has 53 ISO weeks, checked with luxon `weeksInWeekYear`), `2027-W53`, `2026-W54`, `2026-02-30`, `2026-Q5` and a non-canonical spelling (`2026-1`, `2026-W5`) throw `ValidationError` (HTTP 400, field `period`). Invariant: `computeJournalPeriodKey(type, parsed.reference) === key`.
2. Add `describeJournalPeriods(date, timezone)` returning `{ year, quarter, month, week, day }`, each `{ period, from, to }` with `from` and `to` as `YYYY-MM-DD` (inclusive). A week runs Monday to Sunday and may cross a month or year boundary.
3. Add `weeksOfMonth(monthKey)` returning every ISO week that overlaps the month, in order, each `{ period, from, to }`.
4. Add unit tests (no database) covering at least: 2026-12-31 and 2027-01-01 both map to week `2026-W53`; 2027-01-04 to `2027-W01`; 2026-09-28 to `2026-W40`; `weeksOfMonth('2026-10')` returns `2026-W40` (from 2026-09-28) through `2026-W44`; a midnight instant in Europe/Prague that falls on the previous UTC day; and a `computeJournalPeriodKey` case for each of the five types and the year turn.

#### Touches

- backend/packages/data/src/journal/journalStore.ts (new exports; `computeJournalPeriodKey` unchanged)
- backend/packages/data/src/journal/journalPeriods.ts (new, if the helpers are split out)
- backend/packages/data/src/journal/__tests__/journalPeriods.unit.test.ts (new)
- backend/packages/data/src/index.ts (barrel export line)

#### Scope

##### In scope

- Key parsing and validation, period description and the weeks of a month, with unit tests for the key computation.

##### Out of scope

- Any HTTP route using them; #1537 and #1541.
- Changing the stored key format or the temporal-switcher defaults (the default granularity stays as it is; the client chooses it).
- Removing the `month` type from the schema: it stays, even though a month has no note of its own.

#### Acceptance criteria

- When `parseJournalPeriodKey('week', '2027-W53')` or `('day', '2026-02-30')` is called, then it throws a validation error.
- When `parseJournalPeriodKey('week', '2026-W53')` is called, then the described range is 2026-12-28 to 2027-01-03.
- When `describeJournalPeriods` is called for 2027-01-01, then week is `2026-W53`, month `2027-01` and year `2027`.
- When `weeksOfMonth('2026-10')` is called, then it returns five weeks and the first is `2026-W40` starting 2026-09-28.
- `computeJournalPeriodKey` has unit tests for all five types and the year turn.

### Requirement gh-1432: [inbox-core 04/22] Validate capture fields and attach the Journal day in an Inbox create hook

#### Context

Model tier rationale: One choke-point create hook moving existing validation and Journal-day linking out of a helper that nothing calls, with hook ordering and the helper's callers (tests) to adjust.

An Inbox item needs a valid capture date and time and a link to the Journal day it was captured on. `createInboxItemWithClient` in `backend/packages/data/src/inbox/inboxStore.ts` does this: it checks `date` with `DateTime.fromISO`, checks `time` only for being non-empty, resolves the day through `getOrCreateJournalItem` with the system timezone passed in, writes the system-owned `journalDay` edge and enqueues a recompute of the day's Inbox list. But nothing calls it outside tests, and the generic `POST /api/databases/:id/items` can create an Inbox item without any of this: no date or time check, no `journalDay` edge. The Journal day cache and everything that groups Inbox items by day then miss the item.

Item create hooks (`registerItemCreateHook` in `backend/packages/data/src/domainWriteHooks.ts`, ADR `docs/adr/2026-10-09-item-create-domain-hooks.md`) run inside `createItemWithClient` after the row is inserted and in the same transaction, for every writer (REST, `/mcp`, agent tools, system code), and a rejection rolls the insert back. The hook context carries the database, the new item, the written properties and `humanWriterUserId`. An idempotent replay does not run the hooks, so replays never create a second edge. The hook runs before any code after `createItemWithClient` in the caller, so it must itself write the `journalDay` edge; a hook that only rejected would leave the helper's own later edge write as the only place the day is linked.

The capture route (#1961) is a thin handler over the helper and builds on this hook. The trashed-day re-link (#1603) also relies on the day edge existing for every item.

Decision: `date` must be a real calendar date written `YYYY-MM-DD`; `time` must match `HH:mm` (24 hours, `00:00` to `23:59`). Both are the user's wall clock and are stored verbatim, never replaced by the server's current time.

Decision: the Journal day is resolved in the tenant's system timezone (`getSystemTimezone`), exactly as the helper does today.

Decision: only creates are validated. Editing `date` or `time` of an existing Inbox item and moving its Journal day on such an edit are not part of this issue.

Shared-file ordering: this issue also waits for #1428 because both edit the same registry, manifest, cutover, route matrix or hook files listed in Touches.

#### Task

Load `state-writes`, `error-handling` and `testing`.

1. Add `backend/packages/data/src/inbox/inboxCreateHook.ts` exporting `inboxItemCreateHook(context)`. It does nothing unless `context.database.ownerModuleId` is the Inbox module id. Otherwise it validates `properties.date` and `properties.time` as in the Decision (missing or malformed throws `ValidationError` with `field` set to `date` or `time`), resolves the timezone with `getSystemTimezone`, gets the day with `getOrCreateJournalItem(client, journalDatabaseId, "day", referenceDate, timezone)` (Journal database resolved by module id), creates the `journalDay` edge for the new item with the Inbox system relation context, and calls `enqueueJournalInboxRecompute`.
2. Register the hook in `domainWriteHooks.ts` with `registerItemCreateHook`.
3. Reduce `createInboxItemWithClient` to what remains its own: the optional `type` edge. Remove its `date`/`time` validation, `journalDay` handling and recompute call, and remove the `journalDatabaseId` and `timezone` inputs (the hook resolves both). Update its callers in tests.
4. Tests in `backend/packages/data/src/__tests__/`: a generic create with valid date and time gets a `journalDay` edge to the day of that date in the tenant timezone and the day's recompute is enqueued; missing date, `2026-02-30`, missing time, `24:00` and `abc` are rejected with the right `field` and leave no row; a replayed idempotent create keeps exactly one edge; an agent-tool create and a `/mcp` create go through the same hook; a create in another database is untouched.

#### Touches

- backend/packages/data/src/inbox/inboxCreateHook.ts (new)
- backend/packages/data/src/domainWriteHooks.ts (register the hook)
- backend/packages/data/src/inbox/inboxStore.ts (`createInboxItemWithClient` reduced to the type edge)
- backend/packages/data/src/__tests__/inboxCreateHook.test.ts (new)
- backend/packages/data/src/__tests__/inboxTick.test.ts (callers of the helper, as needed)
- backend/packages/data/src/__tests__/journalInboxCompute.test.ts (callers of the helper, as needed)
- backend/services/semprec-api/src/__tests__/itemsHandler.test.ts (only actual Inbox capture create validation, journal-day link and Idempotency-Key replay)
- backend/packages/agent-runtime/src/__tests__/genericOperationAgentTools.test.ts (only actual agent Inbox create hook evidence)
- backend/services/semprec-api/src/__tests__/mcpRunCredentialTenancy.test.ts (only authenticated MCP Inbox create hook evidence)

#### Scope

##### In scope

- Date and time validation and the `journalDay` edge on every Inbox item create, by every writer.

##### Out of scope

- The capture route (#1961), capture channel, source app and received-at properties (#1964), attachments and the type lock (#1669).
- Validating or re-linking on an update of `date` or `time`.
- Re-linking items of a trashed Journal day (#1603).

#### Acceptance criteria

- When an Inbox item is created through the generic create with a valid `date` and `time`, then it has a `journalDay` edge to the Journal day of that date in the tenant's timezone.
- When `date` or `time` is missing or malformed, the underlying error is `ValidationError` with status 400, code `validation_failed` and the failing `field`, and no item exists. REST returns HTTP 400; agent and MCP retain their native error envelopes.
- When the same `Idempotency-Key` is used twice, then one item and one `journalDay` edge exist.
- The same validation applies to actual agent-tool and `/mcp` creates: agent returns its existing `validation_failed: ...` error result; authenticated MCP returns HTTP 200 JSON-RPC -32602 with the failing field in its error data. No new error fields or transport mapping are introduced.

### Requirement gh-1436: [inbox-core 06/22] Validate Inbox item type writes in a choke-point hook

#### Context

Model tier rationale: One validation moved into the create and update hook paths for a single database, using an existing function and the hook registry, with all writer kinds to cover in tests.

An Inbox item type says how items of that type are processed: `processingMethod` (`pageContent` or `database`) and, for `database`, a `targetDatabase` naming one system database (`backend/packages/data/src/inbox/inboxTypesStore.ts`, properties in `backend/packages/data/src/seed/seedInboxPipeline.ts`). The rules are enforced only by `assertValidProcessingConfig`, which `createInboxTypeWithClient` and `updateInboxTypeWithClient` call. Those two functions have no route or other caller, so the generic REST create and update, agent tools and `/mcp` skip the rules: both fields are `select` properties and nothing validates a select value, so any string, including a database that cannot be a processing target, can be stored. The allowed targets are also wrong in one respect: the check accepts the whole `TEN_DATABASE_MODULE_IDS`, which includes `journal` and `transcripts`. A recording is not a processing method (it is a card made by the tick for an audio attachment, #1978), and journal entries get their own processing method (#1975).

Item create and update hooks run inside the choke point for every writer, in the write's transaction, and a rejection rolls the write back (`registerItemCreateHook` and `registerItemUpdateHook` in `backend/packages/data/src/domainWriteHooks.ts`, `docs/adr/2026-10-09-item-create-domain-hooks.md`). The update hook receives the item after the patch, so it can judge the resulting state, as `updateInboxTypeWithClient` does by merging. The option for the new target `mcpServers` is added by #1973, the default type catalog by #1977 and the extended list response by #1439; all of them rely on this validation.

Decision: the allowed targets are an explicit constant, `INBOX_TYPE_TARGET_DATABASES`, equal to the ten system databases without `journal` and `transcripts` (that is `areas`, `projects`, `tasks`, `people`, `files`, `events`, `healthRecords`, `companies`). It is not derived from the module registry, because that registry does not know every target that later issues add; a module added later extends the constant together with a select option and its own cutover.

Decision: validation runs only on writes. A type already stored with `journal` or `transcripts` stays readable and is rejected only when someone writes it again.

Shared-file ordering: this issue also waits for #1432 because both edit the same registry, manifest, cutover, route matrix or hook files listed in Touches.

#### Task

Load `state-writes`, `error-handling`, `canonical-keys` and `testing`.

1. In `inboxTypesStore.ts` export `INBOX_TYPE_TARGET_DATABASES` and export `assertValidProcessingConfig`, changing its target check to use the constant (an unknown or disallowed target is `ValidationError` with `field` `targetDatabase`). Its pageContent and missing-method rules stay as they are.
2. Add `backend/packages/data/src/inbox/inboxTypeWriteHook.ts` exporting a create hook and an update hook for the Inbox item types database (ignore every other database). The create hook validates the written `processingMethod` and `targetDatabase`; the update hook validates the resulting item's pair, but only when the patch contains `processingMethod` or `targetDatabase`.
3. Register both in `domainWriteHooks.ts`.
4. Remove the now-duplicate validation call from `createInboxTypeWithClient` and `updateInboxTypeWithClient` (they keep their input shaping) so a write is validated once.
5. Tests: through the generic REST item create and update, an agent tool create and a `/mcp` create, a type with `targetDatabase` `journal`, `transcripts`, `nonsense` or a target without `processingMethod: database` is rejected with `field`; a `pageContent` type with a target is rejected; valid pairs pass; an update that changes only `name` of an already-invalid stored type succeeds; the old helper functions still behave as before for valid input.

#### Touches

- backend/packages/data/src/inbox/inboxTypesStore.ts (exported check, constant, duplicate call removed)
- backend/packages/data/src/inbox/inboxTypeWriteHook.ts (new)
- backend/packages/data/src/domainWriteHooks.ts (register the hooks)
- backend/packages/data/src/__tests__/inboxTypeWriteHook.test.ts (new)
- backend/packages/data/src/__tests__/inboxPipeline.test.ts (existing helper tests, as needed)
- backend/services/semprec-api/src/__tests__/itemsHandler.test.ts (only actual REST Inbox-type create/update validation and preserved legacy name-only update)
- backend/packages/agent-runtime/src/__tests__/genericOperationAgentTools.test.ts (only actual agent Inbox-type write validation)
- backend/services/semprec-api/src/__tests__/mcpRunCredentialTenancy.test.ts (only authenticated MCP Inbox-type write validation)

#### Scope

##### In scope

- Validating `processingMethod` and `targetDatabase` of Inbox item types on every write path, with the allowed-target constant.

##### Out of scope

- Adding `mcpServers` as a target (#1973).
- The default type catalog (#1977) and the list response (#1439).
- The `journalEntry` processing method (#1975) and a recording method.
- Migrating types already stored with a disallowed target.

#### Acceptance criteria

- When a type is created or updated through REST, an agent tool or `/mcp` with `targetDatabase` `journal`, `transcripts` or an unknown string, the underlying rejection is `ValidationError` with status 400, code `validation_failed` and field `targetDatabase`. REST returns HTTP 400; agent keeps its code-prefixed error result and authenticated MCP HTTP 200 JSON-RPC -32602 with the failing field in its error data.
- When `processingMethod` is `pageContent` and a target is set, then the write is rejected.
- When the pair is valid, then the write succeeds.
- A write that does not touch the pair on an already stored invalid type succeeds.

### Requirement gh-1439: [inbox-core 07/22] Return processing method and target from GET /api/inbox-types

#### Context

Model tier rationale: An additive change to the fields of one existing read route, using an existing localization helper and existing store reads.

`GET /api/inbox-types` (`createInboxTypesRouteHandler` in `backend/packages/data/src/inbox/inboxRouteHandlers.ts`, data from `listActiveInboxTypes` in `backend/packages/data/src/inbox/inboxTypesStore.ts`) returns only `{ id, emoji, label }` for each active type. A client that shows a clarification card needs to know, for each type, what happens with an item of that type: which processing method it has and which database it files into, including the database's display name in the user's language (for example "Tasks" or "Úkoly"). Without this the client would have to read the type items and the database catalog itself. The validated values come from #1436.

The REST contract is additive only (`docs/adr/2026-09-11-additive-only-rest-contract-no-url-versioning.md`): new fields may be added to the objects in `types`, existing ones stay. Route handlers get the caller's locale in `ctx.identity.user.locale`; `transcriptionRouteHandlers.ts` shows how a handler loads module catalogs and resolves a label in that locale (`toManifestLocale`, `resolveCatalogLabel`), and `manifest/catalogResolution.ts` provides `createCatalogResolver` and `resolveDatabaseName` for database names.

Decision: each entry gains `processingMethod` (the stored value), `targetDatabaseKey` (the stored `targetDatabase` canonical key, or `null` for a type without a target) and `targetLabel` (the target database's display name in the caller's locale, or `null`).

Decision: a stored target that is not a known database in the catalog resolves its label to the key itself rather than failing the whole list.

#### Task

Load `canonical-keys` and `testing`.

1. Extend `InboxTypeSummary` and `listActiveInboxTypes` with `processingMethod` and `targetDatabaseKey` read from the item properties (missing values are `null`).
2. In `createInboxTypesRouteHandler` accept the request context, resolve `targetLabel` for each distinct target once with the catalog resolver in the caller's locale, and return the three new fields on every entry. The handler's existing fields and the response status do not change.
3. Tests: an active `database` type returns its method, key and localized label in `cs` and `en`; a `pageContent` type returns method `pageContent` and nulls for the target; an unknown stored target returns the key as label; archived types are still excluded; the existing fields are unchanged.

#### Touches

- backend/packages/data/src/inbox/inboxTypesStore.ts (`InboxTypeSummary`, `listActiveInboxTypes`)
- backend/packages/data/src/inbox/inboxRouteHandlers.ts (`createInboxTypesRouteHandler`)
- backend/packages/data/src/inbox/__tests__/inboxRouteHandlers.test.ts
- backend/services/semprec-api/src/__tests__/tenantIsolationRoutes.test.ts (only authenticated GET /api/inbox-types additive cs/en, target fallback and archived exclusion contract)

#### Scope

##### In scope

- The three additive fields on each entry of `GET /api/inbox-types`.

##### Out of scope

- Type validation and the target options (#1436, #1973), the default catalog (#1977).
- Listing archived types or managing types over HTTP.
- A journal entry method label beyond returning the stored value.

#### Acceptance criteria

- When a type has `processingMethod: database` and `targetDatabase: tasks`, then its entry carries `processingMethod: "database"`, `targetDatabaseKey: "tasks"` and `targetLabel` "Úkoly" for a Czech user and "Tasks" for an English user.
- When a type has `processingMethod: pageContent`, then `targetDatabaseKey` and `targetLabel` are `null`.
- The fields `id`, `emoji` and `label` are unchanged and archived types are still not listed.

### Requirement gh-1490: [mail-threads 08/28] Sanitize Emails.body on every generic item read

#### Context

Model tier rationale: A cross-cutting read-side security projection that must cover every generic read path (REST, MCP, agent tools, write responses and conflict details), where one missed path leaks unsanitized HTML, so it is an isolation-style contract.

`Emails.body` holds the raw HTML of a received message. `sanitizeMailHtml` (`backend/packages/data/src/mail/htmlSanitize.ts`) exists and strips scripts, `on*` attributes and remote images, but nothing calls it. Every generic read returns the raw HTML: `item.get` (`GET /api/items/:id`), `database.query` (`POST /api/databases/:id/query`), `view.query` (`POST /api/views/:id/query`, including the default `mailbox-client` view), the MCP `semprec.*` tools and the agent's generic tools, the responses of `item.create` and `item.patch`, and `details.currentItem` of a `version_conflict` error (`backend/services/semprec-api/src/adapter/errorContract.ts`).

The choke point has hooks only for create, update and relation-edge writes (`chokePoint/hooks.ts`), registered per process from `backend/packages/data/src/domainWriteHooks.ts` (`docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md`). It has no read hook. The common read layer is `chokePoint/itemReads.ts` and `chokePoint/viewQueryOps.ts`, from which REST, MCP and the agent tools all read.

Decision: add a read projection registry of the same per-process shape. Raw HTML stays inside the data layer (sync, send, search indexing read `itemsStore` directly and are unaffected). The projection for `Emails.body` calls `sanitizeMailHtml` with `allowRemoteImages: false`; showing remote images on request is a later opt-in by the thread detail (#1632).

Shared-file ordering: this issue also waits for #1436 because both edit the same registry, manifest, cutover, route matrix or hook files listed in Touches.

#### Task

Load `state-writes`, `canonical-keys` and `testing`.

1. In `chokePoint/hooks.ts` add `registerItemReadProjection(projection)` and `projectItemForRead(item)` (a projection maps an `ItemRow` to an `ItemRow`, is keyed by the item's owning module id, and is applied synchronously), plus its reset in `clearHooksForTests`.
2. Register an Emails projection in `domainWriteHooks.ts` that replaces `properties.body` with `sanitizeMailHtml(body, { allowRemoteImages: false })` when the owning database is the Emails module database and `body` is a string.
3. Apply `projectItemForRead` to every item returned by `createItemReadOps` (`getItem`, `findItem`, `findItemIncludingDeleted`, `listItems`, `getItemPath`) and `createViewQueryOps` (`queryView`, `queryDatabaseItems`, `queryViewItems`) in `itemReads.ts` and `viewQueryOps.ts`.
4. Apply it to the items returned by the public `createItem` and `updateItem` wrappers in `chokePoint/itemWrites.ts`, and to `details.current` where `toErrorResponseBody` builds `details.currentItem` in `adapter/errorContract.ts`. The transaction-scoped functions used internally (`createItemWithClient`, `updateItemWithClient`) return raw rows and are not changed.
5. Add a test per path asserting the body has no `<script>`, no `on*` attributes and no remote image: REST item get, database query, view query, MCP item get, an agent generic tool, the `item.patch` response, and `details.currentItem`.

#### Touches

- backend/packages/data/src/chokePoint/hooks.ts
- backend/packages/data/src/domainWriteHooks.ts
- backend/packages/data/src/chokePoint/itemReads.ts
- backend/packages/data/src/chokePoint/viewQueryOps.ts
- backend/packages/data/src/chokePoint/itemWrites.ts (public `createItem` and `updateItem` wrappers only)
- backend/services/semprec-api/src/adapter/errorContract.ts
- backend/packages/data/src/index.ts (export line)
- backend/packages/data/src/__tests__/emailsBodyReadProjection.test.ts (new)
- backend/services/semprec-api/src/__tests__/itemsHandler.test.ts (only actual REST item/database/view reads, write response and version-conflict currentItem body sanitization)
- backend/packages/agent-runtime/src/__tests__/genericOperationAgentTools.test.ts (only actual agent Emails body read projection)
- backend/services/semprec-api/src/__tests__/mcpRunCredentialTenancy.test.ts (only authenticated MCP Emails body read projection)

#### Scope

##### In scope

- The read projection registry and the Emails body sanitization on all generic reads and write responses.

##### Out of scope

- A per-message "load remote images" request: #1632.
- Sanitizing at ingest, or changing what is stored.
- Projections for any other property or module.

#### Acceptance criteria

- When `Emails.body` contains `<script>`, `on*` attributes or remote images, then `item.get`, `database.query`, `view.query`, MCP `item.get`, the agent generic tools, the `item.patch` response and `details.currentItem` return the body without them; one test per path.
- When sync or send reads the same item inside the data layer, then it still sees the raw HTML.
- Items of other databases are returned unchanged.

### Requirement gh-1525: [collection-schema 08/14] Localize collection search placeholders

#### Context

Model tier rationale: A mechanical catalog addition, but it spans three module catalogs in two locales plus a new catalog lookup used by the database envelope and the schema projection, so it touches well over the one or two files of a low-tier change.

Each collection's search field in the app has its own whole-sentence placeholder, because the Czech preposition changes with the noun ("Hledat v Projektech", "Hledat ve filmech a seriálech", "Hledat ve sbírce"); it cannot be assembled from the collection name on the client. The backend resolves collection names through the module catalogs (`database.<key>.name` in `seed/i18n`, `library/i18n`, `mail/i18n`, resolved by `resolveDatabaseName` in `backend/packages/data/src/manifest/catalogResolution.ts`), but has no placeholder. This issue adds a `database.<key>.searchPlaceholder` entry per client-visible system collection in both locales, resolves it into the database envelope (`GET /api/databases`, `GET /api/databases/:id`, and the other database routes that share `toDatabaseEnvelope`) and into the `GET /api/schema` projection, and gives user-created collections one generic sentence.

It builds on #1407, which defines which system databases are client-visible and adds the metadata fields next to which `searchPlaceholder` is added, and on #1413, which edits the same Czech catalog file in the same region.

Decision: the envelope field is `searchPlaceholder: string | null`. It is `null` for a system database whose catalog has no entry (the internal databases); a missing entry is never replaced by the raw key. A user-created database (no `key`) gets the generic sentence from a catalog entry `collection.custom.searchPlaceholder` in the system databases catalog ("Hledat ve sbírce" / "Search collection"), not a string constant in code.

Decision: for the collections the product named, the Czech text is exactly as named; for the others the same pattern is applied with the noun in the locative, capitalized like the named Project, People and Files entries. The wording of those others is a proposal that a product owner may change in the catalog without code changes.

#### Task

Load `canonical-keys` and `testing`.

1. Add `database.<key>.searchPlaceholder` to both locales of the owning catalog for every client-visible system database:

   | key | cs | en |
   |---|---|---|
   | projects | Hledat v Projektech | Search projects |
   | tasks | Hledat v Úkolech | Search tasks |
   | events | Hledat v Událostech | Search events |
   | journal | Hledat v Deníku | Search journal |
   | people | Hledat v Lidech | Search people |
   | companies | Hledat ve Firmách | Search companies |
   | files | Hledat v Souborech | Search files |
   | healthRecords | Hledat v záznamech | Search records |
   | areas | Hledat v Oblastech | Search areas |
   | transcripts | Hledat v Přepisech | Search transcripts |
   | books (library catalog) | Hledat v knihách | Search books |
   | movies (library catalog) | Hledat ve filmech a seriálech | Search movies and series |
   | emails (mail catalog) | Hledat v e-mailech | Search emails |

   Add `collection.custom.searchPlaceholder` ("Hledat ve sbírce" / "Search collection") to the system databases catalog (`seed/i18n`).
2. In `catalogResolution.ts` add `resolveDatabaseSearchPlaceholder(dbKey, catalogs, locale)` (requested locale, then English, then `null`) and extend `CatalogResolver` with `getCatalogsForModuleId(moduleId)` so the generic sentence can be read from the system databases module's catalog. Export what the barrel needs from `backend/packages/data/src/index.ts` and the public-surface list in `publicSurface.test.ts`.
3. Add `searchPlaceholder` additively to `DatabaseEnvelope`/`toDatabaseEnvelope` and fill it in `resolvedDatabaseBody` in `databasesHandler.ts`; add it to `SchemaDatabaseProjection` and `generateSchemaProjection`.
4. Extend `systemI18nCatalogCoverage.test.ts`: every database whose `clientVisible` is true (from #1407) has a `searchPlaceholder` entry in both locales of its owning catalog, and the generic entry exists in both locales.
5. Handler tests: the Czech envelope of People has "Hledat v Lidech", of Movies "Hledat ve filmech a seriálech"; the English envelope of Projects has "Search projects"; a user-created database has the generic sentence in each locale; an internal database has `searchPlaceholder: null`; `/api/schema` carries the same values.

#### Touches

- backend/packages/data/src/seed/i18n/cs.json (database.<key>.searchPlaceholder entries and collection.custom.searchPlaceholder)
- backend/packages/data/src/seed/i18n/en.json (same keys)
- backend/packages/data/src/library/i18n/cs.json (books, movies)
- backend/packages/data/src/library/i18n/en.json (books, movies)
- backend/packages/data/src/mail/i18n/cs.json (emails)
- backend/packages/data/src/mail/i18n/en.json (emails)
- backend/packages/data/src/manifest/catalogResolution.ts (placeholder lookup, CatalogResolver)
- backend/packages/data/src/manifest/schemaProjection.ts (SchemaDatabaseProjection)
- backend/packages/data/src/index.ts (export line)
- backend/packages/data/src/__tests__/publicSurface.test.ts
- backend/packages/data/src/__tests__/systemI18nCatalogCoverage.test.ts
- backend/services/semprec-api/src/adapter/databaseEnvelope.ts
- backend/services/semprec-api/src/databasesHandler.ts (resolvedDatabaseBody)
- backend/services/semprec-api/src/__tests__/databasesHandler.test.ts
- backend/services/semprec-api/src/__tests__/schemaHandler.test.ts

#### Scope

##### In scope

- The placeholder catalog entries, their lookup, and the additive `searchPlaceholder` field on the database envelope and the schema projection.

##### Out of scope

- Placeholders for the Recipes collection: added by #1707 together with its catalog.
- Any other change to Czech labels of system collections: #1413.
- Which databases are client-visible and their order: #1407.
- Client-side use of the placeholder in the search field.

#### Acceptance criteria

- With a Czech user, the envelope of People has `searchPlaceholder: "Hledat v Lidech"` and of Movies `"Hledat ve filmech a seriálech"`; with an English user, of Projects `"Search projects"`.
- A user-created database returns "Hledat ve sbírce" for a Czech user and "Search collection" otherwise.
- A database with no catalog entry (for example an internal one) returns `searchPlaceholder: null`, never its key.
- `GET /api/schema` returns the same `searchPlaceholder` per database.
- The catalog coverage test fails when a client-visible system database lacks the entry in either locale.

### Requirement gh-1494: [mail-threads 10/28] Enqueue a mailbox sync when a message flag changes

#### Context

Model tier rationale: One extra enqueue call in an existing hook using an existing job and job key, with no new lifecycle or schema.

When a user or the assistant changes a message's `read` or `flagged` property, `mailMessageFlagsItemUpdateHook` (`backend/packages/data/src/mail/mailMessageFlagSyncStore.ts`, registered in `backend/packages/data/src/domainWriteHooks.ts`) stores the desired state in `mail_message_flag_sync_state` in the same transaction. Nothing then triggers the provider write-back: the change reaches the provider only at the next reconcile (the account sweep every few minutes; after a successful IMAP pass the next expected activity is pushed 30 minutes out, `mail/imapReconcile.ts`). The write-back itself (`mail/mailFlagWriteback.ts`) runs inside the reconcile.

`enqueueMailAccountSync(client, mailboxItemId)` (`mail/mailSyncJob.ts`) queues an account sync under a job key that deduplicates repeated requests. The thread actions for read and flag (#1865, #1893) rely on this, and so does the generic item patch.

Decision: the enqueue happens inside the same transaction as the desired-state write, so a crash cannot leave a desired state without a queued sync; the hook enqueues for the message's own mailbox only, and not for provider-observation writes (`skipMailDesiredStateRecording`).

Shared-file ordering: this issue also waits for #1490 because both edit the same registry, manifest, cutover, route matrix or hook files listed in Touches.

#### Task

Load `state-writes` and `testing`.

1. In `mailMessageFlagsItemUpdateHook`, after `recordDesiredMailMessageFlags` records at least one `read`/`flagged` value, read the message's `mail_message_meta.mailbox_item_id` and call `enqueueMailAccountSync(client, mailboxItemId)` on the same client. Do nothing when the item has no meta row (a Semprec draft) or no mailbox.
2. Avoid an import cycle between `mailMessageFlagSyncStore.ts` and `mailSyncJob.ts` (for example by moving the enqueue helper and job key function into a small module both import).
3. Add tests: a generic `PATCH` of `read` enqueues one account sync with the mailbox job key; two patches of different messages in one mailbox leave one queued job; the agent's `item.patch` does the same; a write with `skipMailDesiredStateRecording` enqueues nothing; a draft without meta enqueues nothing; a rolled-back patch enqueues nothing.

#### Touches

- backend/packages/data/src/mail/mailMessageFlagSyncStore.ts (the hook)
- backend/packages/data/src/mail/mailSyncJob.ts (enqueue helper location, if moved)
- backend/packages/data/src/domainWriteHooks.ts (only if the hook registration changes)
- backend/packages/data/src/mail/__tests__/mailMessageFlagsHook.test.ts
- backend/packages/data/src/mail/mailSyncEnqueue.ts (existing extracted helper/job-key module from Task 2; no new queue behavior)
- backend/services/semprec-api/src/__tests__/itemsHandler.test.ts (only actual generic flag PATCH transactional mailbox enqueue)
- backend/packages/agent-runtime/src/__tests__/genericOperationAgentTools.test.ts (only actual agent flag patch transactional mailbox enqueue)
- backend/packages/data/src/testSupport/testDb.ts (only test-support re-export of the existing upsertMailMessageMeta owner helper for the named REST/agent flag-enqueue fixtures; no production barrel/API)

#### Scope

##### In scope

- Enqueuing the mailbox sync from the flag hook, in the same transaction.

##### Out of scope

- Running the sync worker in production and the provider write-back itself.
- Thread-level read and flag routes: #1865, #1893.
- Write-back of folder moves: #1746.

#### Acceptance criteria

- When `read` or `flagged` of a mail message is patched through the generic item API, then a sync of that message's mailbox is queued in the same transaction.
- When several messages of one mailbox change, then one sync job is queued (job key deduplication).
- When a provider observation converges a flag with `skipMailDesiredStateRecording`, then no sync is queued.
- When the patch transaction rolls back, then no job is queued.

### Requirement gh-1498: [mail-accounts 09/30] Validate the IMAP connection limit range

#### Context

Model tier rationale: A single validation hook following an existing create and update hook pattern, in one module, with unit-level tests.

`Mailboxes.connectionLimit` (user-owned number, `seedEmailModule.ts`) caps simultaneous IMAP connections for an account (`imapConnectionLimitForProvider` in `backend/packages/data/src/mail/imapConnectionLimiter.ts`). It can currently be set through the generic item create and update with any number: a value of 0 or 100 is accepted by the choke point and silently ignored or abused later. The app offers 1 to 15.

Domain write hooks are composed per process in `backend/packages/data/src/domainWriteHooks.ts`; `mcpServerItemCreateHook` and `mcpServerItemUpdateHook` in `backend/packages/data/src/mcp/mcpServerWriteHook.ts` are the pattern.

Decision: an unset or null value is accepted (it means "use the provider default"); a non-null value must be an integer from 1 to 15 inclusive.

Shared-file ordering: this issue also waits for #1494 because both edit the same registry, manifest, cutover, route matrix or hook files listed in Touches.

#### Task

Load `error-handling` and `testing`.

1. Add `mailboxConnectionLimitCreateHook` and `mailboxConnectionLimitUpdateHook` in the mail module that, for items of the Mailboxes database only and only when `connectionLimit` is present in the written properties or the patch, throw `ValidationError` (field `connectionLimit`) unless the value is null or an integer from 1 to 15.
2. Register both in `domainWriteHooks.ts`.

#### Touches

- backend/packages/data/src/mail/mailboxConnectionLimitHook.ts (new)
- backend/packages/data/src/domainWriteHooks.ts
- backend/packages/data/src/__tests__/mailboxConnectionLimitHook.test.ts (new)

#### Scope

##### In scope

- The range check on create and update of Mailboxes items.

##### Out of scope

- Existing out-of-range stored values (not migrated; the limiter keeps its own tolerance).
- Showing whether the limit applies (#1572).

#### Acceptance criteria

- When a mailbox is created or updated with `connectionLimit` 0, 16, 2.5 or a string, then the request fails with 400 `validation_failed`.
- When the value is 1, 15 or null, then it is accepted.
- When another property is patched and `connectionLimit` is absent from the patch, then the hook does nothing.
- Items of other databases are unaffected.

### Requirement gh-1570: [mail-threads 13/28] Backfill missing and split mail threads per tenant

#### Context

Model tier rationale: A per-tenant background rewrite of `thread_id` across all stored mail that merges and deletes thread rows, so it needs careful batching, idempotency and tenant scoping to avoid wide data damage.

Before #1474 and #1384, two kinds of stored mail were threaded wrongly: messages sent from Semprec have `mail_message_meta.thread_id = NULL`, and copies of one message delivered to several mailboxes sit in separate threads. Those two issues fix new traffic only. This issue repairs the data that already exists.

Today `reassignThread` (`backend/packages/data/src/mail/mailMessageMetaStore.ts`) moves every message of one thread into another and deletes the emptied `mail_threads` row, and `resolveThreadId` (`mail/threading.ts`) computes a thread from `In-Reply-To`, `References` and message id. Jobs are registered in `CORE_TASK_NAMES` (`backend/packages/queue/src/index.ts`) and handled in `backend/packages/data/src/worker.ts`; per-tenant sweeps use `forEachActiveTenant`, and large sweeps follow `docs/adr/2026-09-28-chunked-transactions-for-large-background-sweeps.md` (keyset pages, one transaction per page, resumable).

Decision: the job is a core task, idempotent and safe to run repeatedly; it does not rely on a persisted cursor (the `IS NULL` and duplicate-message-id selections are themselves the idempotency check). It is enqueued once per deploy under a fixed job key.

#### Task

Load `state-writes`, `db-migrations` and `testing`.

1. Add a core task name `mailThreadBackfill` to `CORE_TASK_NAMES` and register its handler in `worker.ts`. The handler runs `forEachActiveTenant` and, for each tenant, runs the two passes below.
2. Pass 1, missing threads: page through `mail_message_meta` rows with `thread_id IS NULL` ordered by `item_id` (keyset, page size 100 to 500, one transaction per page). For each row call `resolveThreadId` with its `message_id`, `in_reply_to`, `references` and the item's subject as hint, and set `thread_id`. The row's own `thread_id` is NULL, so the lookups in `resolveThreadId` (which only consider rows with a thread) never match it; a child processed before its parent gets a new thread that the parent later merges, as in live ingest.
3. Pass 2, split copies: page through distinct `message_id` values that occur in more than one mailbox and whose rows have more than one distinct `thread_id`; for each, merge all those threads into the lowest `thread_id` with `reassignThread`.
4. Enqueue the task once at deploy with a fixed `jobKey` (for example `mail-thread-backfill`), `maxAttempts: 3`. The existing invocation is in `db/runMigrationsCli.ts`; verify its actual compiled-root composition and repeated-invocation key safety using the isolated built-export runtime in `docs/adr/2026-11-03-mail-thread-backfill-cli-evidence-uses-isolated-built-exports.md`, not another enqueue path. Preserve the observed plain native Node module-resolution failure separately: this local fixture is not the unmodified deployment command and does not establish production packaging or deployment executability. A failing tenant is logged and does not stop the others; after all tenants were tried the job fails with the aggregate error so it is retried.
5. Add tests: sent messages with NULL `thread_id` get the thread of their parent; copies in two mailboxes end in one thread and the emptied `mail_threads` rows are gone; a second run changes nothing; another tenant's rows are never touched.

#### Touches

- backend/packages/queue/src/index.ts (`CORE_TASK_NAMES` entry)
- backend/packages/data/src/worker.ts (task handler registration)
- backend/packages/data/src/mail/mailMessageMetaStore.ts (paged selection helpers)
- backend/packages/data/src/mail/mailThreadBackfillJob.ts (new)
- backend/packages/data/src/index.ts (export line)
- backend/packages/data/src/mail/__tests__/mailThreadBackfill.test.ts (new)
- backend/packages/data/src/db/runMigrationsCli.ts (only the existing mailThreadBackfill deploy enqueue composition; repair only if the Task requires it)
- backend/packages/data/src/__tests__/mailThreadBackfillCli.test.ts (new; owned compiled CLI invocation with the explicitly isolated built-export resolver, real queue key/maxAttempts/repeat evidence, no remote deploy)
- backend/packages/data/src/__tests__/fixtures/mailThreadBackfillCliRuntime.mjs (new test-only native child bootstrap for the actual compiled CLI)
- backend/packages/data/src/__tests__/fixtures/mailThreadBackfillDistResolver.mjs (new closed test-only public-export-to-built-JavaScript resolver)
- docs/adr/2026-11-03-mail-thread-backfill-cli-evidence-uses-isolated-built-exports.md (new standalone bounded local CLI evidence decision)
- issues/batches/backend/followups/native-runtime-package-resolution.md (controller-owned unresolved runtime-packaging prerequisite)

#### Scope

##### In scope

- The per-tenant, chunked backfill of NULL thread ids and of split copies, and its enqueueing.

##### Out of scope

- Threading new traffic: #1474 and #1384.
- Row-level security or schema changes; the job only uses existing columns.
- Production workspace export/packaging, compiler configuration, lockfile or deployment repair. The unresolved prerequisite is tracked in `issues/batches/backend/followups/native-runtime-package-resolution.md`; a fixture result does not clear it.
- Any change to what a thread is shown as in the thread list: #1567.

#### Acceptance criteria

- When the job runs on a tenant with sent messages that have NULL `thread_id`, then each gets the thread of its replied-to message, or a new thread if it has no ancestors.
- When one `Message-ID` exists in two mailboxes in two different threads, then after the job both rows share one thread and no empty `mail_threads` row remains.
- When the job runs a second time, then no row changes.
- When one tenant fails, then the other tenants are still processed and the job reports the failure.

### Requirement gh-1637: [mail-compose 06/12] Send mail through the Gmail API

#### Context

Model tier rationale: One more implementation of an existing transport interface against a documented REST endpoint, using the established Gmail client and token exchange, with defined threading behavior.

Mailboxes that sync through the Gmail API send through the Gmail API as well. The Gmail REST client (`backend/packages/data/src/mail/gmailRestClient.ts`) can read and label messages but cannot send. Gmail only files a sent message into an existing conversation when the request carries that conversation's thread id; the In-Reply-To header alone is not enough.

This builds on the transport interface and the SMTP transport (#1634) and the Gmail API sync transport (#1505, whose client and access-token handling it extends). Microsoft Graph sending is #1753.

#### Task

Load `io-hardening`, `error-handling` and `testing`. Apply `docs/adr/2026-11-03-oauth-mail-send-provider-failures-stay-private.md` only to its named SEND boundaries; preserve the older sync and OAuth contracts.

1. Add `sendMessage(raw, threadId?)` to `GmailRestClient` that calls `users.messages.send` with the raw MIME as base64url and the optional `threadId`, with the same timeout and error discipline as the other Gmail calls. It returns the Gmail message id and thread id.
2. Implement the `gmail_api` `MailTransport`: obtain an access token from the stored refresh token, pass `providerThreadId` (the provider thread id of the source message, when the draft is a reply) as `threadId`, and return the provider message id.
3. Map a 400 or 401 from token refresh or send to `MailReauthorizationRequiredError`, and a Gmail response that names an invalid recipient to `MailRecipientRejectedError`; anything else is an ordinary failure. At the scoped send-provider privacy boundary, unknown failures become fixed generic errors after owned settlement/cleanup; do not infer a known diagnosis or wrap unrelated SQL/token acquisition. Error text never includes the message or tokens.
4. Register the transport in the factory for the `gmail_api` sync mode.

#### Touches

- backend/packages/data/src/mail/gmailRestClient.ts
- backend/packages/data/src/mail/gmailTransport.ts (new)
- backend/packages/data/src/mail/mailTransport.ts (factory registration)
- backend/packages/data/src/__tests__/gmailRestClient.unit.test.ts
- backend/packages/data/src/__tests__/gmailTransport.test.ts (new)
- backend/packages/data/src/mail/mailSendPrivacy.ts (optional new private helper shared only by the named send operations; no public barrel/raw-error hook or general filtering framework)
- docs/adr/2026-11-03-oauth-mail-send-provider-failures-stay-private.md (new scoped send-boundary decision; historical accepted ADR bodies stay unchanged)

#### Scope

##### In scope

- Sending raw MIME through Gmail with thread id and the error mapping above.

##### Out of scope

- Saving a Sent copy (Gmail does it itself).
- The send route (#1896), Graph (#1753) and SMTP (#1634).
- Requesting additional OAuth scopes: `gmail.send` is already requested when a mailbox is connected.

#### Acceptance criteria

- When a reply is sent with a provider thread id, then the request contains that `threadId` and the message appears in the same Gmail thread.
- When the token is revoked, then the transport throws `MailReauthorizationRequiredError`.
- When Gmail rejects a recipient, then the transport throws `MailRecipientRejectedError`.
- The sent message keeps the Message-ID from the MIME, so the later synced copy deduplicates onto the same item.

- Unknown send-provider failures expose fixed cause-free generic errors and safe closed diagnostics, with original primary/secondary values retained internally through owned cleanup. Genuine typed refusals and unrelated credential/SQL failures keep their established semantics. No MIME, token, preauthenticated upload URL or arbitrary error text/name/code escapes the named privacy boundary.

### Requirement gh-1753: [mail-compose 08/12] Send mail through Microsoft Graph

#### Context

Model tier rationale: Graph has two distinct sending paths with a hard 4 MB request limit, an upload-session protocol and an uncertain Message-ID guarantee, so the behavior has to be proved by tests and the large path involves multi-step provider state.

Mailboxes that sync through Microsoft Graph send through it too. `backend/packages/data/src/mail/graphRestClient.ts` reads and patches messages but cannot send. For this Task, `POST /me/sendMail` has a configured budget of 4,000,000 bytes for its base64 MIME request body, not raw MIME. The encoded length is `4 * ceil(rawBytes / 3)`, so at most 3,000,000 raw bytes fit. A larger message is created as a provider-side draft, its attachments uploaded through upload sessions, then sent.

This builds on the Gmail transport (#1637, same interface from #1634) and the Graph sync transport (#1508), whose client and token handling it extends.

Decision: the Message-ID of the outgoing MIME must survive; if it does not on a given path, the later synced copy from the Sent folder would create a second item instead of deduplicating. A test proves it for each path, and the draft path sets `internetMessageId` explicitly when creating the message.

#### Task

Load `io-hardening`, `error-handling` and `testing`. Apply `docs/adr/2026-11-03-oauth-mail-send-provider-failures-stay-private.md` only to its named SEND boundaries; preserve the older sync and OAuth contracts.

1. Add `sendMime(raw)` to `GraphRestClient`: `POST /me/sendMail` with a base64 `text/plain` MIME body of at most 4,000,000 bytes (raw at most 3,000,000). Reject a direct oversized call before token acquisition/fetch; the transport selects the large path instead. Use this exact decimal budget and base64 padding, not a raw 4 MB or 4 MiB threshold.
2. Add the large path: create the message with `POST /me/messages` carrying the subject, body, recipients, `internetMessageId`, and the reply headers; upload each attachment through `createUploadSession` in chunks; then `POST /me/messages/{id}/send`. A failure after obtaining a validated provider draft id and before final send acceptance attempts deletion of that owned draft, best effort. After actual Graph send acceptance, response cleanup failure keeps the accepted result and never deletes or resubmits the message.
3. Implement the `graph_api` `MailTransport` choosing the path by the encoded-body budget in Task 1, mapping 400/401 token failures to `MailReauthorizationRequiredError` and a refused recipient to `MailRecipientRejectedError`. Register it in the factory. Apply the scoped send privacy ADR without changing token acquisition.
4. Prove with tests against a stubbed Graph that the Message-ID is preserved on both paths.

#### Touches

- backend/packages/data/src/mail/graphRestClient.ts
- backend/packages/data/src/mail/graphTransport.ts (new)
- backend/packages/data/src/mail/mailTransport.ts (factory registration)
- backend/packages/data/src/__tests__/graphRestClient.unit.test.ts
- backend/packages/data/src/__tests__/graphTransport.test.ts (new)
- backend/packages/data/src/mail/mailSendPrivacy.ts (optional new private helper shared only by the named send operations; no public barrel/raw-error hook or general filtering framework)
- docs/adr/2026-11-03-oauth-mail-send-provider-failures-stay-private.md (new scoped send-boundary decision; historical accepted ADR bodies stay unchanged)

#### Scope

##### In scope

- Sending through Graph for small and large messages with Message-ID preservation and error mapping.

##### Out of scope

- Saving a Sent copy (Graph does it).
- The send route (#1896), the Gmail and SMTP transports.
- Requesting additional OAuth scopes: `Mail.Send` is already requested at connection.

#### Acceptance criteria

- When the base64 MIME body fits 4,000,000 bytes (raw at most 3,000,000), it goes through `sendMail` and keeps its Message-ID. Test the exact raw limit; a direct oversized `sendMime` call fails before token/fetch work.
- When the base64 MIME body exceeds 4,000,000 bytes, a message with attachments takes the draft/upload/send path and keeps its Message-ID. Test just above the raw limit and a raw message below 4 MB whose encoded body already exceeds the budget.
- When the large path fails after obtaining a validated provider draft id and before send acceptance, deletion of that draft is attempted; the primary failure is preserved if best-effort deletion fails.
- When the token is revoked, then the transport throws `MailReauthorizationRequiredError`.

- Unknown send-provider failures expose fixed cause-free generic errors and safe closed diagnostics, with original primary/secondary values retained internally through owned cleanup. Genuine typed refusals and unrelated credential/SQL failures keep their established semantics. No MIME, token, preauthenticated upload URL or arbitrary error text/name/code escapes the named privacy boundary.
- After actual Graph send acceptance, response cleanup failure is safely diagnosed while the accepted result is retained, with no draft deletion or resubmission.

## Touches

- Exactly the union of the eleven complete current member Touches sections embedded above. Every path keeps its member's named purpose and restrictions; no additional path or unrelated directory work is authorized.
- Controller-approved corrections must update the source, exact embedded snapshot and approval before execution.

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
