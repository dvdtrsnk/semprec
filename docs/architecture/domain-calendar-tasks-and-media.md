# Calendar, tasks and media domains

The rules that hold today for calendars, Events, recurrence and the calendar timeline, Tasks, the Journal, Sleep,
transcription (recordings, transcripts, speakers), the Library and blobs/uploads/files. All code paths are under
`backend/packages/data/src/` unless stated otherwise.

General mechanisms are only referenced here: choke point, hooks, value links and trash in
[data-model-and-writes.md](data-model-and-writes.md); transactions, locks and queue in
[transactions-and-side-effects.md](transactions-and-side-effects.md); tenancy in
[tenancy-and-security.md](tenancy-and-security.md); edges and errors in [edges-io-and-errors.md](edges-io-and-errors.md);
agents, approvals and the AI gateway in [agents-approvals-and-ai.md](agents-approvals-and-ai.md).

## Calendar

### Tenancy

- Calendars, Events and invitations are private to their tenant: no cross-tenant reads, writes or calendar sharing.
- Meetings arrive by email invitation (iMIP, `calendar/invitationIngestAction.ts`); external calendars arrive by ICS
  subscription (`calendar/subscribedEventsImport.ts`), read-only, and through internet accounts, synced both ways.
  All stay inside one tenant.
- An internet account's calendar is a Calendars row of `kind` `account` linked to its Mailboxes item by the
  `Calendars.account` ↔ `Mailboxes.calendars` relation (one-to-many). Its remote identity lives in tenant side tables
  keyed by item: `calendar_remote_state` (per calendar: `remote_id`, `remote_url`, `sync_token`, `ctag`,
  `last_synced_at`, `last_error_code`) and `event_remote_state` (per Event: its calendar, `remote_id`, `remote_href`,
  `etag`, `base_snapshot`, the field values of the last sync; `remote_id` unique per calendar). Both cascade with their
  items and are exported with the tenant (they hold no secret).
- The calendar sync is the system writer `CALENDAR_SYNC_WRITER` (`systemProcess: "calendarSync"`,
  `chokePoint/writerKind.ts`). It alone creates `account` calendars and writes `remoteName`, `remoteColor` and
  `readOnly` (system-owned, owner process `calendar`, checked against the writer in `calendarItemCreateHook` /
  `calendarItemUpdateHook`, `403 owner_violation` otherwise) and the `account` relation.

### Calendars and the default mark

Rules live in `calendar/calendarRowHooks.ts` and `calendar/calendarTrashHooks.ts`, registered in `domainWriteHooks.ts`.

- A calendar's `kind` is `own` (or empty), `system`, `subscription` or `account`. Only own calendars may be made
  default; only own and account calendars renamed. Own calendars may be deleted; an account calendar only by a
  `system` writer (it leaves when the provider or the account removes it). Other cases answer `403 forbidden` /
  `400 validation_failed`.
- An account calendar's `name`, `color`, `notify` and `hidden` are the user's: `name` and `color` override the
  provider's `remoteName` and `remoteColor`, and `null` means the provider's value.
- `color` must be `#RRGGBB`, `name` a non-blank title; `null` is refused for both except on an account calendar.
- Exactly one live own calendar holds `isDefault: true`. Marking one clears the others through `updateItemWithClient`;
  writing `isDefault` to anything else is refused unless another live own calendar holds the mark.
- **Lock order:** every reader/writer of the mark takes the advisory lock
  `pg_advisory_xact_lock(hashtextextended('calendars-default:' || <calendars database id>, 0))` first, then the
  calendar rows (`FOR UPDATE`, id order). An update takes it in `calendarItemUpdatePreLockHook`; delete and restore
  take it in `calendarItemDeletePreLockHook` / `calendarItemRestorePreLockHook` (pre-lock registries in
  `chokePoint/hooks.ts`), before the root row is locked.
- Deleting an own calendar: refused with `409 last_own_calendar` when no other live own calendar exists; when it was
  the default, the oldest other own calendar becomes default (system writer); every live Event on it is trashed with the
  calendar's deletion epoch. Restoring brings back exactly the Events of that epoch and clears the restored calendar's
  default mark.

### Event creation and calendar assignment

- `defaultCalendarCreateHook` (`calendar/defaultCalendarCreateHook.ts`), registered after the Events validation
  hooks, links every new Event that has no `calendar` edge to the chosen calendar or the live default calendar
  (lowest id if several). The edge is a system write in the create transaction.
- A caller chooses a calendar with `createEventInCalendar` / `withChosenCalendar` (a module-private
  `AsyncLocalStorage`). The chosen calendar must be a live own or account calendar of the tenant; anything else is
  the same `validation_failed` on `calendarId`. A read-only account calendar answers `403 calendar_read_only` unless
  the writer is `system`.
- The Events of a read-only account calendar follow the provider (`calendar/accountCalendarWriteGuard.ts`): a user's
  or agent's update, trash, or move into or out of it (an `Events.calendar` edge written or deleted) answers
  `403 calendar_read_only`; an agent's `item.delete` is refused the same way before an approval is stored. System
  writers pass: the calendar sync, and the internal writers of derived fields (`nextOccurrenceDate`) and cascades
  (a calendar trash). Lock order: the account calendar's row `FOR SHARE` before the Event's row, taken by the Events
  update and delete pre-lock hooks, the order a calendar trash takes them in.
- The hook reads the chosen or default calendar `FOR SHARE`; the default read is retried once when the mark moved
  while it waited. A missing default fails the create (`default_calendar_missing` log line).

### Event participants and invitations

- The participant edge (Events `people` ↔ People `events`) and its `role` are user-owned; the `invitation` object in
  the edge metadata belongs to the calendar module (handoff recorded in `calendar/calendarModuleManifest.ts`).
- `eventParticipantEdgeWriteHook` (`calendar/eventParticipantEdgeHook.ts`) enforces, for both sides of the relation:
  - non-`system` writers must send the stored invitation back unchanged (`invitationReadOnly`);
  - metadata has only `role` (`organizer` | `attendee`) and `invitation`; an organizer edge has no invitation, points
    at `System settings.selfPerson` and is the Event's only organizer;
  - item ids must be canonical 8-4-4-4-12 UUIDs (`nonCanonicalItemId`), so the hook always finds the stored edge;
  - it locks the Event row (`NOWAIT` under value-link admission) before reading edges — except for an insert-only
    write without invitation that is not an organizer edge (`createRelationIfAbsentWithClient` passes
    `insertOnly: true`), which must take no Event lock to avoid deadlocking with the People `lastContact` job key.
- An organizer's update (`invitationEventFields`) is adopted into the Event's `name`, `place`, `date`, `timeFrom`,
  `timeTo`, `endDate` field by field, only while the stored value equals what the previous invitation produced, under
  the per-tenant `UID` advisory lock and the Event row lock. Only a message from the stored `organizerEmail` may
  update (`sender_not_organizer`). `name` is never cleared. A refused Event write rolls back the whole email.
- The invitation delivery job reads its pool and transports from a binding the API queue runtime sets
  (`setEventInvitationDelivery`, `calendar/eventInvitationJob.ts`); see [Adjacent rules](#adjacent-rules).

### Event times and zones

- An Event's `date`, `timeFrom`, `endDate` and `timeTo` are wall-clock values in its `timeZone` (an IANA name);
  without one, in the tenant's zone (`getCalendarClock`). All-day days are not zoned.
- `timeZone`, `recurrenceRule`, `exceptionDates` and `recurrenceId` are the provider fields of a synced Event:
  system-owned with no owner process (the sync writes them together with `seriesId`, and an Events pre-write
  transform clears the raw rule), written only by `CALENDAR_SYNC_WRITER`. `calendar/syncedEventFields.ts` refuses
  any other writer naming them (`403 owner_violation`), except the calendar module's own two writes below, and
  judges the values for every writer (`400 validation_failed`): a valid IANA zone (no fixed offsets), non-blank
  RRULE text, a list of local starts, a local start; a raw rule never next to `recurrence` or on an occurrence item,
  `recurrenceId` only on one. A local start is `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` in the Event's zone.
- Readers convert to the tenant's wall clock before they compare or show anything (`scheduleInTenantZone`, applied
  by `toTimelineItems`): the timeline and its consumers (agenda, agent tool) and the reminders feed. Their candidate
  reads take one day more on each side for a zoned Event and filter the converted days. A stored zone that is no
  IANA name leaves the row out with a log line (`property: timeZone`).
- A user write of the time fields stores the values as sent, in the Event's zone.

### Recurrence model (Tasks and Events)

- A series is one rule plus one template. Only occurrences with state of their own (done, wontDo, missed, moved,
  edited, cancelled) are stored items; the rest are projected.
- Shared identifiers: `seriesId` and `occurrenceDate` (`YYYY-MM-DD`, never changed by moving). A virtual occurrence
  is addressed as `<seriesId>@<occurrenceDate>`.
- Editing a series updates the template and its open, unedited occurrences; done/wontDo/missed occurrences keep their
  values. Deleting a series keeps completed occurrences as history.
- Dates and times are wall-clock values (an Event's in its zone) compared as text; a DST change there moves nothing.

### Event series and occurrences

- The rule is the user-owned `json` property `recurrence` of Events, validated by `calendar/eventRecurrenceHook.ts`
  against `fixedRecurrenceRuleSchema` (`weekdays`, `monthDates`, `nthWeekday`; `yearDates`, floating rules and
  `null` are refused). The Event's `date` is the series start. Day matching is shared with
  `tasks/nextDueDate.ts` (`eventRecurrenceOccursOn`).
- An Event series has no row of its own: `seriesId` is the id of the Event carrying the rule. An occurrence item is
  never a series.
- `seriesId` and `occurrenceDate` are system-owned (owner process `calendar`); only
  `calendar/materializeEventOccurrence.ts` writes them. Materialization copies the series' fields (not invitations)
  under `pg_advisory_xact_lock('eventOccurrence:<tenant>:<seriesId>:<date>')` and the series row `FOR UPDATE`, and
  creates at most one item per occurrence. `POST /api/events/series/:seriesId/occurrences/:date` is idempotent (201
  then 200).
- Cancelling an occurrence is trashing its item; readers treat a trashed occurrence item as cancelled.
- A synced series may carry a raw `recurrenceRule` (RRULE text) and its `exceptionDates` instead of `recurrence`.
  It is expanded by `expandRecurringSeries` (`calendar/recurrenceExpansion.ts`, shared with subscribed events) in
  the series' zone, without the starts `exceptionDates` names; a rule outside the supported subset, or a zone that
  cannot be read, shows the series row once. Rule days and `occurrenceDate` are days in the series' zone; virtual
  ids are `<seriesId>@<that day>`.
- An override is an occurrence item of a synced series: `seriesId` plus `recurrenceId`, the original start it
  replaces (a day names that day's occurrence, a date-time the occurrence starting then). It replaces its occurrence
  live or trashed, wherever its own days are. The sync stores provider overrides; materializing an occurrence of a
  series with a raw rule, or of any series in an account calendar, creates one, copying `timeZone` and naming
  `recurrenceId` (a date-time for a timed series), admitted by the create hook only inside
  `withOverrideMaterialization`. A raw-rule date that the rule skips or excludes is `400 validation_failed`.
- Editing rules (`syncedRecurrenceTransform`): a `recurrence` edit of an Event with a raw rule clears
  `recurrenceRule` and `exceptionDates` in the same write, so the sync serializes the simple rule; edits that do not
  name `recurrence` keep the raw rule. A user cannot edit the raw rule itself.

### Next occurrence date

- `nextOccurrenceDate` is a locked system property of Events, computed by `computeNextOccurrenceDate`
  (`calendar/nextOccurrenceDate.ts`, 366-day lookahead through the timeline expansion).
- Three writers, all through the choke point: the pre-write transform `calendar/nextOccurrenceDateTransform.ts` (create
  and updates naming `date`, `endDate`, `recurrence`); `calendar/nextOccurrenceSeriesHooks.ts` (an occurrence moved,
  trashed or restored recomputes its series, series row locked first); the daily heartbeat
  `calendar.refreshNextOccurrence` (`calendar/nextOccurrenceRefreshAction.ts`, batches of 200, stale values only).

### Calendar timeline

- `readCalendarTimeline` (`calendar/timelineRead.ts`) is the only assembler of a calendar range; consumers (the route
  `GET /api/calendar/timeline`, the agent tool) call it and never query Events or Tasks for a range themselves.
- Sources are declared in `CALENDAR_TIMELINE_SOURCES` (`calendar/timelineSources.ts`); a new entry kind is a new
  source. The merge concatenates and sorts once. Sources read in a row-count-independent number of statements.
- A stored row with an unreadable date/time is skipped and logged with id and property name only (never the value).
- The server does not filter hidden calendars, returns multi-day Events once, reports an Event without a calendar edge
  with the default calendar id, and caches nothing. The route bounds the range to 93 days.
- Entry kinds:
  - stored Events/Tasks (`CalendarTimelineItem`);
  - Event series (a `recurrence` rule or a raw `recurrenceRule`) expanded by `expandEventOccurrences`
    (`calendar/eventOccurrences.ts`): virtual entries (`readOnly: true`, `overridden: false`) for rule dates without
    an item, real items (`overridden: true`) placed by their own dates, trashed items give nothing; at most 100
    entries per series;
  - derived entries (birthdays, holidays) with a non-item id and `readOnly: true`;
  - sleep nights: id `sleep:<night>`, `readOnly: false` (edited through the sleep module, never `/api/items`);
  - subscribed events: stored rows of `subscribedEvents`, `readOnly: true`, told apart by `databaseId`.
- A stored Event of a read-only account calendar is `readOnly: true`; one of a writable account calendar is not.
- `attachTaskInEventState` (`calendar/timelineTaskInEvent.ts`) runs once after the sources, batched, at the context's
  single instant `at`, using `taskStateInEvent` via `readEventsTasks` — the same function as the Event tasks route.
  The Tasks source places a task on `taskDisplayDay` and omits tasks still hidden in an Event or completed in one.
- `includeSleep: false` makes the sleep source read nothing. The agent timeline tool
  (`calendar/calendarTimelineTool.ts`) passes `true` only when the run's project holds read access on all three sleep
  databases (`assertSleepAccess`, decision rows `FOR SHARE`); a human `/mcp` session never does. An answer containing a
  sleep entry is marked `sensitive: true`.

### Subscribed events

- A master row stores `recurrenceRule` (RRULE text), `exceptionDates`; an override row stores `recurrenceId`. Rows are
  identified by `(calendar, uid, recurrenceId)`.
- Series are expanded on read in the subscribed source by the shared `calendar/recurrenceExpansion.ts`; nothing of
  an occurrence is stored. Supported parts: `FREQ`, `INTERVAL`,
  `COUNT`, `UNTIL`, `BYDAY`, `BYMONTHDAY`, `BYMONTH`; anything else is shown once and counted as `unsupportedRules`.
- Days are computed in the series' zone and converted to tenant wall clock; at most 100 entries per series and 20,000
  rule periods per iteration. Occurrence ids are `<row id>@<date>`.

### Internet account calendar sync

Code under `calendar/sync/`; the owner of `calendar_account_sync_state`, `calendar_remote_state` and
`event_remote_state` (`calendarSyncStore.ts` is their only writer) and the only writer as `CALENDAR_SYNC_WRITER`.

- **Adapters.** `adapter.ts` is the contract: `listCalendars`, `fetchChanges(calendar, cursor, { window })` →
  `{ full, upserts, deletions, nextSyncState }`, `putEvent`, `deleteEvent`, each honouring the pass's deadline signal
  (5 min for the whole pass). An adapter does network only and holds no database client. The registry
  (`adapters/index.ts`) has one factory per sync mode: `imap` CalDAV, `gmail_api` Google, `graph_api` Graph. Its answer
  is validated and bounded (`parseRemoteCalendars`, `parseCalendarChanges`) before anything is written; a refused
  answer is the provider error `invalidResponse`.
- **Pass** (`calendarAccountSyncJob.ts`, task `calendarAccountSync`, key `calendar-account-sync:<accountId>`, 3
  attempts, `api`). A short read transaction reads the account, its sync mode and grant, the tracked calendars (those
  with a `calendar_remote_state` row) and the window; an account that is gone, trashed, has Calendars off or whose
  OAuth grant lacks the calendar scope is skipped. Then, with no transaction open, the credential is decrypted
  (`calendar_sync` in `credential_access_log`) and every calendar fetched. A calendar without a cursor is fetched in
  full for one year back to two years ahead (tenant zone); later fetches are incremental.
- **Apply** (`calendarSyncApply.ts`), one transaction: the account's calendar sync guard (`calendarAccountSyncGuard.ts`,
  advisory lock `calendar-account-sync:v1:<tenant>:<account>`, at most 5 s, then the pass is skipped), the account and
  its tracked calendars re-read (Calendars off or gone: skipped; tracked calendars or cursors changed since the
  fetch: the fetch is discarded). Calendars first: a new remote calendar becomes a Calendars row of `kind` `account`
  with its `account` edge, a known one gets changed `remoteName`/`remoteColor`/`readOnly`, one no longer listed loses
  its remote state and the cleanup is queued. Then Events by `(calendar, remote_id)`: a deletion (or, for a full
  fetch, a stored Event of the window not listed) is trashed and its remote state deleted; an Event whose
  `base_snapshot` (fields, series, organizer, attendees) equals the fetched one writes nothing, and only its remote
  state when its href or etag changed; otherwise the fields the provider changed since the snapshot are written and
  other fields keep local edits. Overrides follow their series (`seriesId`, `recurrenceId`). Each Event runs in a
  savepoint: a `ValidationError` from an Event rule skips that Event. Event writes pass `allowedSystemKeys` for the
  provider fields and `seriesId` and no `systemOwnerProcess`; calendar writes pass `systemOwnerProcess: "calendar"`.
  The cursors, `ok` state and the resolution of the account's problem commit with the writes. The result lists the
  Events added, changed and cancelled and whether this was the account's initial sync, for notifications.
- **Status.** `calendar_account_sync_state` (`status` `ok` | `error` | `never` | `needsReauthorization` |
  `needsConsent`, `last_successful_sync_at`, `failing_since`, `last_error_code`, `initial_sync_completed_at`,
  `manual_sync_requested_at`). `calendarStatusOf` derives the rows' `calendarStatus`: `off` with Calendars off,
  `needsConsent` while the OAuth grant lacks the calendar scope, else the stored status (`never` without a row). A
  failed pass records, under the guard and only while Calendars is on, `needsReauthorization` for a refused credential
  (or none stored), `needsConsent` for a refused calendar grant, otherwise `error` with the provider's code, `timeout`
  or `unexpected`, and raises the account's Semp problem `calendarSyncError` (`calendar:<account>`, category `mail`,
  critical for the first two). Calendars and Events stay as they were. Only `error` is rethrown for the queue's retry.
- **Triggers.** An account created with Calendars on or switched on queues a pass; the sweep
  `calendarAccountSyncSweep` (every 5 min) queues every account with Calendars on without a state row, not `ok`, or
  last synced 4 min ago or more; `POST /api/accounts/:id/calendars/sync` (202 `{ id, queued }`, 404 for another
  tenant's or an unknown id, 409 `calendars_disabled`) queues one at most every 60 s per account, decided by a
  conditional upsert of `manual_sync_requested_at` under the account row's share lock.
- **Off and removal** (`calendarAccountSyncLifecycle.ts`). Switching Calendars off (`mail/mailboxServiceHooks.ts`) or
  removing the account (`removeMailbox`) deletes the state row and every `calendar_remote_state` row of the account,
  resolves the problem as `sourceDeleted` and queues `calendarAccountCleanup` (key
  `calendar-account-cleanup:<account>`). Untracked calendars are no longer touched by a pass. The cleanup trashes, per
  committed chunk under the guard, the live Events of the account's untracked calendars with their remote state, then
  each calendar. Switching Calendars on again syncs the account anew into new calendars.
- **Lock order.** The Calendars switch: calendar sync guard (at most 15 s, then 409 `calendar_sync_busy`) before the
  Mailboxes row; with a Mail switch in the same write, mailbox sync guard → calendar sync guard → mail sync state row
  → Mailboxes row, the order a removal takes them in. The apply: guard → state row → calendar rows → Event rows. A
  cleanup chunk: guard → Event rows → calendar row.

### Reminders and resync pushes

- `enqueueRemindersResync` (`calendar/remindersResync.ts`) and `enqueueSleepResync` (`sleep/sleepResync.ts`) enqueue one
  debounced job per tenant (`reminders-resync:<tenantId>` / `sleep-resync:<tenantId>`, `jobKeyMode: "replace"`, run
  time +30 s) on the write's own client, from hooks registered last (`calendar/remindersResyncHooks.ts`,
  `sleep/sleepWriteHooks.ts`).
- The reminders feed (`GET /api/calendar/reminders`, `calendar/remindersFeedRouteHandler.ts`) lists stored rows and
  the occurrences of raw-rule series; the virtual occurrences of a `recurrence` series are not listed.
- Reminders hooks fire on a value change of `date`, `endDate`, `timeFrom`, `alertMinutes`, `travelMinutes`,
  `notifications`, `status`, `timeZone`, `recurrenceRule`, `exceptionDates` on Events/Tasks (judged against the hook context's `previous`), on calendar `notify`, on
  tenant `timezone`, and on trash/restore. Defaults and transform-set `null`s on create are not changes.
- Payload is `{ tenantId }` only; the handler checks it against the envelope tenant and sends a silent APNs push to
  active `ios` registrations, writing no `notifications` rows.
- Concurrent writes of one tenant serialize on the job key in `graphile_worker.add_job`; a resulting `40P01` is the
  accepted residual, retried with the request's transaction by the HTTP adapter.

### Calendar tools over MCP

- Calendar tools declare `mcp: { humanHandlerExport }`; `calendar.write` must be in the credential's capability list.
- A run credential's call of a `requiresApproval` tool files a `moduleTool` approval request (error -32001) and runs on
  approval as an agent writer (`agentRunId`, project grants apply). A human session runs the human handler at once as
  `{ writerKind: "agent", externalClient: true }`.

## Tasks

### Pre-write transform

`tasks/taskPreWriteTransform.ts` (registered under `TASKS_MODULE_ID`) judges the resulting state:

- `name`, when sent, is non-blank. `status`, when sent, is a non-empty string; a create without it gets `notDone`.
  Every task has a status; readers do not branch on a missing one.
- `date` is `null`/`""` (off) or an existing `YYYY-MM-DD`. Times are normalized by `normalizeWallClockTime`
  (`timeTo` accepts `24:00`). A start time needs a date; an end time needs a later start time.
- Switching the date off clears `timeFrom`, `timeTo`, `time` in the same write. Rules run on update only when the patch
  names a key they read. `time` is derived by `deriveTaskTime`.
- Completion (`completedOn`, `completedAt`) and `since`/`sinceTime` (first-planned-day rule, `tasks/taskSinceRule.ts`)
  are computed with the tenant zone and clock inside the real write. Proposal preparation marks an implicit
  `completedOn` as deferred and fabricates no system values.

### Recurring task series

- One `task_recurrence` row per series (`series_id`, `anchor_date`, `template`, `item_id` = current open instance,
  overwritten on advance). `seriesId`, `occurrenceDate`, `recurrence` are system-owned Tasks properties written only
  by the Tasks module (`tasks/taskRecurrenceOwner.ts`, `tasks/taskRecurrenceStore.ts`).
- **Lock order:** item rows first, then `task_recurrence`.
- A generic patch of `recurrence` is a registered module update command: the item is checked first, then the series
  reserved; an agent's change or end of an active series is deferred for approval; the projection contributes the
  series state to the approval snapshot.
- A series is trashed, restored and purged as one cascade through `registerItemCascadeExpansion`
  (`tasks/taskSeriesTrash.ts`, walked by `collectCascadeRows`). Delete/restore/purge pre-lock hooks lock every
  instance `FOR UPDATE` in id order, then the series row, repeating until stable. While trashed the rule is inactive;
  `task_recurrence.trashed_active_item_id` records which instance gets it back on restore.
- `registerItemDeleteImpactReader` lets Tasks report `seriesInstanceCount`, `attachmentCount`, `hostEventCount` in the
  delete preview and the `item.delete` approval snapshot, counting only what the reader may read.

### Host Events (task in event)

- `hiddenUntil` and `effectiveDate` are stored, computed by the pure `computeTaskHostState`
  (`tasks/taskHostEventState.ts`), and recomputed by `recomputeTaskHostState` in the transaction of the write that
  makes them stale: a `hostEvents` edge change, an Event schedule update (tasks in id order), the Tasks transform on
  `date`. Time passing is not a trigger; readers compare `hiddenUntil` with the clock.
- The recompute locks the task row only, never the Events (the routes lock task then edge; Event updates lock Event
  then tasks).
- Trashing an Event recomputes its hosted tasks and keeps the edges. Restoring an Event locks every hosted task row
  (id order) and then deletes their `hostedTasks` edges as the Tasks process; the task is not put back.

### Nightly rollover

- `core.tasksDayRollover` (`tasks/tasksDayRolloverAction.ts`) runs at 00:00 tenant time. Candidates: live `notDone`
  non-series tasks whose effective day is before today, not hidden, not completed in an Event, and not already in the
  result state (today, no times).
- `rolloverTaskWithClient` (`chokePoint/itemWrites.ts`) is the only system write of `date`/`timeFrom`/`timeTo`.
- Two passes of 100-row chunks (`SKIP LOCKED`, then waiting `FOR UPDATE`), each capped by
  `MAX_SWEEP_CHUNKS_PER_TENANT`.
- Recurring series: a pure SQL predicate preselects due series; the item-then-series transaction recomputes through
  the TypeScript recurrence owner and writes `missed` through a status-only handover; an existing latest occurrence is
  reserved `FOR UPDATE NOWAIT` (55P03 rolls back the batch for retry).

### Value-link inheritance

Link rules declared in the `systemDatabases` manifest (engine: [data-model-and-writes.md](data-model-and-writes.md)):

| Rule | Source → target | Via |
|------|-----------------|-----|
| `taskProjectFromEvent` / `taskPeopleFromEvent` | Events `project`/`people` → Tasks | `Tasks.sourceEvents` |
| `transcriptProjectFromEvent` / `transcriptPeopleFromEvent` | Events → Transcripts | `Transcripts.event` |
| `transcriptCompanyFromProject` | Projects `company` → Transcripts | `Transcripts.project` |
| `fileProjectsFromTasks` | Tasks `project` → `Files.projects` (union) | `Files.tasks` |

- People rules use `valueFilter: { omit: { databaseKey: "systemSettings", propertyKey: "selfPerson" } }`. Copies lock
  the System settings row `FOR SHARE`; `setSelfPersonId` (`selfPerson.ts`) and other writers of the relation lock it
  `FOR UPDATE` and queue recomputation.
- Rules run in whichever process writes the via edge (`semprec-transcribe`, `semprec-api`, `semprec-agents`); later
  source changes go through `valueLinksPropagate` (`api` affinity). Only live sources are copied.
- Removing the via edge detaches that Event from the target's links in any state (`tasks/taskSourceEventLinkDetach.ts`,
  `transcription/transcriptCompanyLinkRelease.ts`); removing a transcript's Event also deletes its `company` link.
- A file holds one link per property: the first rule that links it (`fileProjectFromThread` or `fileProjectsFromTasks`)
  keeps it.

## Event trash: lock order

The Event delete hooks' order in the `itemDeleteHooks` list of `domainWriteHooks.ts` is part of the contract. Before
them, `accountCalendarEventDeletePreLockHook` locks an account calendar's row `FOR SHARE` before the Event's row, and
`accountCalendarEventDeleteHook` runs first and reads `readOnly` under that lock.

1. `valueLinkSourceDeleteHook`: locks the Tasks rows whose links the Event feeds (id order, `FOR UPDATE OF i`), then
   the links via `deleteValueLinkSourcesBySourceItem` ordered by item id, rule catalog position (`loadLinkRules`), link
   id.
2. `transcriptCompanyLinkReleaseItemDeleteHook`: each linked transcript's `company` link, last.
3. `eventHostedTasksDeleteHook` (`tasks/eventHostedTasksHooks.ts`): remaining hosted task rows.

A new delete hook that locks a row whose links the detach takes must take it in or before step 1. Transcript rows are
never locked by an Event trash (it must not wait for an open transcription match).

## Journal

- One live entry per `type` + `period`, reserved by a row in the choke point's `idempotency_keys` table, keyed by the
  private function shared with `getOrCreateJournalItem` (`journal/journalStore.ts`). The Journal module is the only
  module that writes such a row outside the choke point, for restore and merge only.
- Restore (`journal/journalRestoreHook.ts`, `repointJournalPeriodReservation`): takes the reservation with a no-op
  `INSERT … ON CONFLICT DO UPDATE`, refuses with `409` (`details.liveItemId`) when another live entry holds the period,
  else repoints it. No peer item row is locked.
- Duplicate merge (`journal/mergeJournalDuplicates.ts`, `lockJournalDuplicatePair`): requires a managed transaction;
  **lock order** reservation row, then both entries `FOR UPDATE`; the older entry survives. The duplicate's page is
  appended (`insertPageMarkdown`, origin `system`), user-owned edges move through `moveRelationEdgesWithClient`
  (`chokePoint/relationOps.ts`), `events` is rewritten by `syncJournalEventLinks`, `journalDay` by the Inbox owner
  (`inbox/moveJournalDayEdges.ts`), and the duplicate is trashed. An edge the survivor already holds is deleted from
  the duplicate, never refused. Refused edges are returned (`refusedEdges`) and logged after commit with ids, `code`,
  `field` only.
- Assistant access: `page.ensureJournalPeriod` creates or returns a period entry (needs Journal `write`, no approval);
  `page.mergeJournalDuplicates` is destructive and approval-gated for agents, its projection (`journal_merge`) pins the
  exact pair and the replay throws `ConflictError` if the merged pair differs.
- Undoing a confirmed journal-entry card removes its inserted blocks and its recorded edge (`writeRecordedEdge`), and
  never trashes the day.

## Sleep

- Sleep settings, plans and night exceptions are three sensitive system databases (`sleep/sleepModuleManifest.ts`); the
  sleep resync push is described under [Reminders and resync pushes](#reminders-and-resync-pushes).
- `keepWakeDaysInOnePlan` (create/update hook of `sleepPlans`) removes the written plan's wake days from other plans
  (`ORDER BY id FOR UPDATE`, repeated until two empty selects); a `40P01` from that select becomes `409`.
- Push hold: `findSleepMuteUntil` (`sleep/sleepMuteWindow.ts`) returns the wake time when `enabled` and `muteSemp`. A
  push inside the window (except `approvals`-category kinds) is re-enqueued as `notificationFanout` with key
  `notification-fanout-deferred:<id>:<wake ISO>`, `preserve_run_at`, run at the wake time
  (`notifications/notificationFanoutJob.ts`). A failing sleep read sends anyway.
- A `sleepNight:<night>` ref attached to a Semp message opens the settings, plans and that night's items for that one
  turn (`listSleepNightReadItemIds`); the prompt expands it only when `attachedThisTurn` or the project holds read on
  all three databases, otherwise `unavailable (no access)`. `loadSleepNights` requires REPEATABLE READ. The expansion
  is never stored.

## Transcription and recordings

### Process placement

- `services/semprec-transcribe` runs the media pipeline. It is the only process that runs `ffmpeg`/`ffprobe`, only from
  `src/mediaNormalization.ts` (system packages, fixed argv, no shell, SIGKILL timeout, zod-validated output). Others
  hand media work to it as a task with `queueAffinity: 'transcribe'`.
- `services/semprec-transcribe/src/queueRuntime.ts` runs one-slot runners: the pipeline (`transcriptionJob`), fast row
  creation (`transcriptionCreate`), short model tasks (`transcriptCardRecompute`, `transcriptSpeakerSuggestion`, voice
  notes) and Inbox attachment metadata.
- Graceful shutdown: the task polls `helpers.abortSignal` only between committed checkpoints
  (`throwIfShutdownRequested`), throws `TranscriptionInterruptedError`, re-enqueues by `fileItemId` and returns
  normally. `TimeoutStopSec` (960 s, `deploy/systemd/semprec-transcribe.service`) is sized to one ASR chunk.
- The worker writes through the choke point only. Its write surface: Transcripts items and their system properties
  and checkpoints; the requested `project` and upload `event` edges at create; the match's `event` edge (and release of
  an edge to a trashed Event); `transcript` cards and their `sourceTranscript` edge; card rewrites of its own cards;
  link-rule values that follow its own edges.

### Failures and diagnostics

- The outer handler converts every escaping failure into a typed error with a fixed message and stable code, no cause
  or provider text. Diagnostics are stored first; a failure while storing them never replaces the original.
- The streaming STT adapter (`services/semprec-ai-gateway/src/audioProviders/openAiStreamingTranscriptionProvider.ts`)
  refuses a frame when `bufferedAmount + frameBytes > 256 KiB` and fails the session with a content-free diagnostic.

### Pipeline locking

- **Lock order** in `services/semprec-transcribe/src/transcriptionTask.ts`: source Files item `FOR UPDATE`, transcript
  item `FOR UPDATE`, then `item_automation` `FOR UPDATE`, for every guard, checkpoint write, attempt start and failure
  record. No lock is held across gateway, storage or media work.
- A deleted source or transcript observed under these locks ends the job as a deleted stop (automation marked, items
  unchanged); it is never manufactured from a generic SQL error.
- `runPrepareStep`'s final write transaction runs at READ COMMITTED (asserted) so it sees a committed recording request;
  its read phase is REPEATABLE READ. Date precedence: `recorded_at`, media creation time, upload time.
- Match and speaker-suggestion steps do nothing for a transcript whose `status` is `done` (rechecked after the gateway
  call).

### Recording intake

- `recording_requests` (one per Files item) is written only by `transcription/recordingIntake.ts`, inside the managed
  upload transaction under the blob lock. Files row, then existing transcript, then Events (sorted) are reserved
  `FOR UPDATE NOWAIT`; 55P03 or a busy try-advisory answers `409 recording_busy`, marking the transaction
  rollback-only.
- The request is inserted `ON CONFLICT DO NOTHING`; first accepted values win. A NULL Event may get its first live
  claim; a different live Event is `recording_linked_elsewhere`. A trashed requested Event is normalized to none.
- `transcriptionCreate` and `transcriptionJob` are each enqueued only when their own key has no observed job; observed
  jobs are never replaced. A recording card's confirm records `transcriptionQueued` only for jobs it enqueued; its undo
  locks the Files row before removing jobs.
- The explicit "no Event" decision is `event_decision = 'noEvent'` (`RECORDING_EVENT_DECISION_NO_EVENT`); the default
  `'none'` means undecided. `setRecordingEventDecision` writes it in the card confirm; the match reads it first and
  returns `noEventChosen` without any write or model call.
- The create step writes the requested `project` (ordinary edge) and then the requested `event` edge (Event read with
  a row lock; trashed or missing gives no edge).

### Event match

- `Events.transcript` is one-to-many: an Event holds many transcripts, a transcript at most one Event (cardinality
  trigger). Each transcript keeps its own summary.
- Match (`transcription/transcriptEventMatch.ts`): one live candidate links directly as `system`; zero or several create
  one `kind = 'transcript'` card. With several, one bracketed paid call (`operation: 'transcript_event_match'`) may
  recommend a candidate; the recommendation only shapes the card, and the checkpoint on the Files item gates repeats.
- Recurring Events: virtual occurrences are candidates but never linked directly; the card targets
  `<seriesId>@<date>` and `confirmProposalWithClient` materializes the occurrence and writes the edge in one transaction.
- An edge to a trashed Event is no link (`readTranscriptEventEdges`); before writing a new edge the match or a pairing
  confirm deletes it (`releaseTrashedEventEdges`). A trashed Event is confirmed under `lockItemTrashEpoch`
  (`FOR SHARE`).

### Speakers

- Diarization keys stay in `computed.segments`; who a key is lives on the user-owned `speakers` edge with metadata
  exactly `{ speaker }`. `assertSpeakerEdgeWritable` (choke point) enforces a real key and one person per key, locking
  the transcript.
- Only `semprec-transcribe` creates `transcript` cards: the match step and the suggestion step
  (`transcription/transcriptSpeakerSuggestion.ts`). Only a human confirm writes a `speakers` edge.
- Confirm adds missing Event participants with `createRelationIfAbsentWithClient` (insert-only, no metadata
  replacement, records `addedRelations` in history).
- **Lock order:** card first, then transcript. A manual assignment (`transcription/transcriptSpeakerAssignment.ts`)
  locks the key's card, then the transcript, re-looks up the card and takes it `NOWAIT` (`409 version_conflict`), and
  settles it with `settleSpeakerCardWithClient`. Producers that lock the transcript first take cards only `NOWAIT`.
- Suggestions are asked again when a transcript's `event` edge or the Event's `people` edges change
  (`transcriptSpeakerSuggestionEdgeChangedHook` enqueues `transcriptSpeakerSuggestion`). The checkpoint binds the
  Event id and candidate ids; only `needsClarification` cards untouched by the user are refreshed.

### Transcript cards recompute

- A user instruction on a card enqueues `transcriptCardRecompute` (key
  `transcript-card-recompute:<proposalId>:<instructionEntryId>`) in the revise transaction.
- `semprec-transcribe` rewrites only its own `transcript` cards: snapshot, gateway call outside transactions, then a
  locked write that fails if `aiVersion` moved. The model may only choose among existing candidates or edit the
  current new-item proposal; user-edited keys are preserved. Each instruction is answered by exactly one
  `threadRevision` entry. Logs carry ids and codes only.

### Action item states and refs

- `transcript_action_item_states` is written only by `transcription/transcriptActionItemStates.ts` under the
  transcript's row lock (route `PUT /api/transcripts/:id/action-items/:actionItemId/state`); a purge removes its rows
  through their foreign keys (data-model-and-writes.md, *Storage*).
- `transcriptSegment` refs are validated and labelled in batches (`transcription/transcriptSegmentRef.ts`), labelled by
  `resolveTranscriptDisplayName` plus the time stretch.

## Library

- Books and Movies contracts (`library/libraryModuleContract.ts`) declare which user-owned fields automation may fill;
  the job fills a field only when it is empty, after rechecking the automation lock and item in its write transaction.
- `library/libraryMetadataConfig.ts` owns the supported sources (`none`, `openLibrary`, `tmdb`); an unsupported config
  fails with a fixed-message `LibraryMetadataConfigurationError` before enqueue, sweep, job processing and dispatch,
  writing nothing.
- Covers: bytes are staged before the transaction (`library/libraryCoverStorage.ts`, fresh `<tenant>/blobs/<uuid>`
  key, no I/O under locks). The transaction reserves automation, then the item, then the blob (item-before-blob). A
  `runAfterCommit` marker decides cleanup; an unknown commit outcome retains the bytes.

## Blobs, uploads and files

### Ownership and collection

- The `blobs` row (`blobs/blobsStore.ts`) is the ownership record. `deleteBlobIfUnreferenced` locks the blob
  `FOR UPDATE`, then runs a fresh reference-checking `DELETE` and returns the `storage_key`. Bytes are deleted by the
  caller after commit, best-effort (failure logged, never retried).
- A blob-owned item hook, registered first, validates every schema-declared `file`/`image` reference and takes
  `FOR KEY SHARE` on each blob in id order (item-then-blob order). Missing and foreign blobs give the same validation
  error. Reference scans accept any UUID letter case.
- An open Processing proposal (not `confirmed`/`rejected`, `CLOSED_PROPOSAL_STATUSES`) whose envelope names a blob id is
  a reference (`inbox/proposalBlobReferences.ts`); `assertValidProposalEnvelope` takes `FOR KEY SHARE` on the blobs it
  names.
- `blobs.detected_mime_type` is written only by `blobs/fileUploadStore.ts` from the bounded content detector, only
  when previously NULL, under the blob row lock. The Files create transform derives `type` only from it.

### Uploads and attach

- An upload streams outside the transaction, then takes the blob `FOR UPDATE`, looks for the live Files item and
  creates it through the choke point if absent. Duplicate bytes are cleaned after commit; a failed transaction deletes
  only its own new bytes.
- Attach (`blobs/uploadAttachTarget.ts`, `attachUploadedFileWithClient`), still under the blob lock: target row
  `FOR UPDATE NOWAIT`, then the Files row `NOWAIT`, then a recheck that the Files item's `file.blobId` is the ingested
  blob. 55P03, a trashed Files item or a mismatch answer `409 upload_attach_conflict`; every attach failure marks the
  upload transaction rollback-only.
- The upload media-type header only admits an upload; it never determines classification.

### Streams

- `BlobStorageWriter.writeStream` (`mail/blobStorage.ts`) attaches to its source before its first `await`, buffers
  bounded behind preparation, and on failure destroys the source with the first error, removes partial bytes and
  rethrows that error unchanged.
- `blobs/openBlobFromRoots.ts` observes cleanup of a stream it still owns before falling back to the other root
  (`settleBlobReadStream` in `packages/shared`, 5 s cleanup allowance); a cleanup failure, deadline or abort forbids
  fallback and keeps the original error primary.
- Tenant export (`tenancy/tenantExportJob.ts`) retries a key in the other root on `ENOENT` and records it in
  `missingBlobIds` only when both roots miss.

## Adjacent rules

Rules recorded with these domains that apply more broadly:

- **Queue affinity:** every queue task declares `queueAffinity` (`TASK_AFFINITIES = ["api", "agents", "transcribe"]`
  in `@semprec/queue`; module tasks in their manifest). `resolveTaskAffinitySets` (`moduleTasks.ts`) is the single
  resolver; `@semprec/module-registry` keeps its own literal tuple and must not import `@semprec/queue`.
- **Module task dependencies:** a module task needing composition-root objects exports `set<Name>Delivery(next | null)`;
  the runtime of its affinity binds before starting and unbinds on stop; an unbound handler throws (queue retries).
- **Queue task as agent without a run:** a queue task may write one reversible user-owned relation edge as an agent
  with no run and no project only after re-reading under lock that the property has no edge and no value link; this
  identity has no grants and no send permission.
- **Semp problem episodes:** `semp_problem_occurrences` keeps one receipt per keyed occurrence of a problem
  (`semp/sempProblemsStore.ts`); a repeated key adds no count.
- **Regenerated Semp replies:** `regenerateSempReply` (`semp/sempMessagesStore.ts`) replaces the latest done reply only
  when it made no writes and precedes no compaction; the replaced turn's event range is hidden from the model via
  `replaced_by_message_id`, never deleted.
