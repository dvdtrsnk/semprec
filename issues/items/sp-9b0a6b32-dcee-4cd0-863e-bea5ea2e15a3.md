---
schemaVersion: 1
id: "sp-9b0a6b32-dcee-4cd0-863e-bea5ea2e15a3"
title: "[areas-removal 05/06] Remove the area filter contract, the derived area and the area fields of mail and sleep"
kind: "implementation"
state: "closed"
stateReason: "completed"
labels: ["spec:approved"]
parent: "sp-7ff00d8e-6c3e-49f2-b5a8-89ca1157e807"
assignees: []
milestone: null
createdAt: "2026-11-27T18:55:41.305Z"
updatedAt: "2026-11-27T20:13:41.547Z"
closedAt: "2026-11-27T20:13:41.547Z"
source: null
approval: {"specSha256":"bf7e54f1da712657b8fa1d5657ba18dacccb4fecfae3aa97e6d265c7a2b532ae","source":"repository","actor":"david","at":"2026-11-27T18:55:42.571Z"}
resolution: {"pullRequests":[],"commit":"14b377534c696d7b853d59a7e313746a89dff3d1","at":"2026-11-27T20:13:41.547Z"}
---
**Blocked by:** sp-ba084bcb-8d4f-4a0d-939c-06276354ce46
**Model tier:** high

## Context

Model tier rationale: Removes a cross-package manifest contract and the area half of the derived-value mechanism while keeping the Event company derivation, and renumbers positional SQL in the mail list query.
contracts while keeping the Event company derivation, the mail positional SQL and the Journal Inbox working.

Areas are removed (parent epic). The database is recreated from the baseline before deploy and the baseline has no
area DDL, so no migration is written. Consumers: the seed (`areas` database, its relations `projects.area`,
`events.area`, `companies.area`, `healthRecords.area`, `files.area`, `journal.area`, `sleepSettings.area`, the
`(unplanned)` area, `AREAS_MODULE_ID` in `TEN_DATABASE_MODULE_IDS`); `data/src/areas/` (write hook and
`GET /api/areas/:id/overview`); the `areaFilter` manifest contract (module-registry, `views/areaFilter.ts`,
collection metadata, related routes, facets incl. the project facet color taken from the area, schema endpoint); the
derived area (`derived/`, `valueLinkReads`, `derived.area` in `rows.ts`, `projectAttachmentAreaHook`); mail
(`areaId` filter in list/delta/facets, `areas` facet group, the area branch of the change hook); search (group and
subtitle kind `area`, area project counts, area titles, `projectItems` fan-out); inbox (target `areas`, card kind
`area`, proposal option field `area`, areas as page hosts, workspace context areas and project `areaId`, the journal
entry `areaId` with its AI prompt and response schema, `JournalInboxProposalSummary.areaItemId/areaName`,
`journalInboxCompute` returning null without an Areas database); sleep settings `areaId`; `area` in
`EVENT_RELATION_KEYS`; i18n; tests and `testSupport/tenantScopeWarnFiles*.json`.


The backend removal is delivered in three slices because the review bot cannot review the whole removal in one pull
request (its backend prompt overflowed at about 770 KB of diff). Each slice leaves the backend green on its own;
consumers go first and the seed last.

## Task

1. Remove the `areaFilter` contract: the module-registry type, schema and projection, `views/areaFilter.ts`, the collection metadata resolver, the area related routes, the area-filter facets and every `areaFilter` declaration in the systemDatabases manifest; `GET /api/schema` publishes no `areaFilter` and keeps `facetBarProperty`.
2. Projects facet values carry the project's own `color`.
3. Remove the derived area: its sources, reads, value-link kind, `derived.area` in the shared row type and `projectAttachmentAreaHook`; the Event company derivation with its guard, admission and invalidation job stays.
4. Mail: remove the `areaId` filter of list, delta and facets, the `areas` facet group and the area branch of the change hook, renumbering the list query's positional parameters.
5. Sleep settings no longer answer `areaId`; `area` leaves `EVENT_RELATION_KEYS`.
6. Tests of these paths follow.

## Touches

- backend/packages/module-registry/src (manifest, registry, index, tests and fixtures)
- backend/packages/data/src/views/, manifest/collectionMetadata.ts, chokePoint/ (related routes, value links), derived/, mail/, sleep/sleepRouteHandlers.ts, calendar/duplicateCalendarItem.ts, domainWriteHooks.ts, index.ts
- backend/packages/data/src/seed/systemDatabasesModuleManifest.ts (areaFilter declarations only)
- backend/packages/shared/src/genericOperations/rows.ts, backend/packages/queue/src/index.ts (comment)
- backend/services/semprec-api/src/schemaHandler.ts and tests; the tests of the touched data paths

## Scope

### In scope

- The slice specified in Task.

### Out of scope

- The Areas database, its relations, `data/src/areas/`, the overview route and docs/architecture (06/06).

## Acceptance criteria

- `GET /api/schema` has no `areaFilter` and still publishes `facetBarProperty: "tags"` for Projects.
- A Projects facet value carries the project's own color.
- An Event linked to a project still reads its company derived through the project, and a manual company edge is still refused while the event has a live project.
- Mail list, delta and facets filters for project, person, thread, thread ids, changed and search return the right threads; facets answer `{ total, projects }`.
- The sleep settings response has no `areaId`.
- `pnpm run verify` passes in backend (apart from host-only failures named in the pull request).
