# Handover: store event time zones and full recurrence for synced events

Implementation commit `259c0092a` on `feat/internet-accounts`.

**What changed.**
- Events seed (`seed/seedTenDatabases.ts`, labels in `seed/i18n`): `timeZone` (text), `recurrenceRule` (text), `exceptionDates` (json), `recurrenceId` (text). All are `owner: system` with **no owner process**. Key constants are in `calendar/syncedEventKeys.ts`.
- Rules (`calendar/syncedEventFields.ts`, registered in `domainWriteHooks.ts`):
  - Only `CALENDAR_SYNC_WRITER` may name these fields. Any other writer gets 403 `owner_violation`, including another `system` writer that passes `allowedSystemKeys`.
  - There are two exceptions, both calendar-module writes. (a) `syncedRecurrenceTransform`, an Events pre-write transform: a patch that names `recurrence` on an Event with a raw rule also sets `recurrenceRule: null` and `exceptionDates: null`. (b) Override materialization inside `withOverrideMaterialization`, which may set `timeZone` and `recurrenceId`.
  - Values are checked for every writer (400 `validation_failed`): `timeZone` must be an IANA zone (fixed offsets and `system` are refused); `recurrenceRule` non-blank text of at most 2000 characters; `exceptionDates` a list of at most 1000 local starts; `recurrenceId` a local start. A local start is `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` in the Event's zone.
  - Row shape: `recurrenceRule` never next to `recurrence` and never on an item with `seriesId`; `recurrenceId` only with `seriesId`.
- Display: `scheduleInTenantZone` converts a zoned timed Event to tenant wall clock in `toTimelineItems`, so it applies to the timeline, agenda, agent tool and reminders feed. All-day Events are not moved. An end on tenant midnight becomes `24:00`. Candidate reads take one extra day on each side, but only for rows with a `timeZone`.
- Expansion module (`calendar/recurrenceExpansion.ts`, which replaces `subscribedEventRecurrence.ts` and `subscribedEventOccurrences.ts`):
  - `parseRecurrenceRule(text) → RecurrenceRule | null`, covering FREQ, INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH.
  - `recurrenceDates(rule, start, until, window)`.
  - `recurrenceDatesInZone(rule, start, allDay, zone, window)`.
  - `expandRecurringSeries(series, range, tenantZone) → RecurringOccurrence[] | null`, where `RecurringOccurrence` is `{ schedule (tenant), originalStart (tenant "date Ttime"), originalLocalStart (series zone) }` and `null` means an unknown zone.
  - `shiftDays`.
  - Subscribed events use the same functions and behave as before.
- Series (`calendar/eventSeries.ts`, `calendar/eventOccurrences.ts`):
  - `readSyncedEventSeries` reads a raw-rule series row; `isEventSeriesRow` matches either kind.
  - `expandEventOccurrences` expands raw rules in the series' zone and leaves out the occurrences `exceptionDates` names (a day names that day's occurrence, a date-time the occurrence starting then).
  - An occurrence item with a matching `occurrenceDate` or `recurrenceId` (`namesLocalStart`) replaces its occurrence, whether it is live or trashed.
  - A rule outside the subset shows the series row once, as an `overridden: true` entry.
  - `occurrenceDate` and the virtual id `<seriesId>@<date>` use the day in the series' zone. `recurrence` series with a `timeZone` are expanded in that zone too.
- Materialization (`calendar/materializeEventOccurrence.ts`): a series with a raw rule, or any series in an account calendar, becomes an override with `seriesId`, `occurrenceDate`, `recurrenceId` (a date-time for a timed series) and `timeZone` copied. These writes pass no `systemOwnerProcess`. A raw-rule date that the rule skips, or that is an exception, gives 400 on `date`. An existing override is found by `occurrenceDate` or by the day of its `recurrenceId`.
- Reminders feed: it also lists the virtual occurrences of raw-rule series, with item id `<seriesId>@<date>` and the series' alert. `recurrence` series stay as before, listing materialized occurrences only. `remindersResyncHooks` now also fires on `timeZone`, `recurrenceRule` and `exceptionDates`.
- Docs: `docs/architecture/domain-calendar-tasks-and-media.md`, with a new "Event times and zones" section, plus the Recurrence model, Event series and occurrences, Calendar timeline, Subscribed events and Reminders sections.

**Contracts for the sync and adapter issues.**
- The sync writes through the choke point with `{ writer: CALENDAR_SYNC_WRITER, allowedSystemKeys: ["timeZone", "recurrenceRule", "exceptionDates", "recurrenceId", "seriesId", ...] }` and **without `systemOwnerProcess`**. The new keys have no owner process, so a `systemOwnerProcess: "calendar"` write naming them is refused by the generic check.
- Times are stored as wall clock in `timeZone`. `exceptionDates` and `recurrenceId` are local starts in the series' zone. A provider override is an Events item with `seriesId` (the master's id) and `recurrenceId`; `occurrenceDate` is optional for the sync.
- To detect a user switching to a simple rule: `recurrence` is set and `recurrenceRule` is `null`. The sync serializes `recurrence` to an RRULE.

**Deviations and spec seams.**
- Ownership: the issue says "system-owned by calendarSync". Unlike I03 (owner process `calendar`), these fields have no owner process. The Events pre-write transform runs as module `events` and may only add keys whose owner process is unset or `events`, so `calendar` would block the clearing in Task 3. Exclusivity is enforced by the writer check in the hooks, the same mechanism I03 uses.
- "Synced series" for Task 4 is read as a series with a raw rule or a series in an account calendar.
- Not enforced: that `recurrenceRule` sits only on Events of an account calendar. The sync-only writer check makes that hold in practice.
- `remindersResyncHooks` is not in the Touches list. It was extended because the feed now depends on these fields.

**Open items.**
- A user's edit of `date`/`timeFrom`/`timeTo` on a zoned Event is stored as sent, in the Event's zone. Clients show tenant times, so editing a New York Event from Prague shifts it. This needs a decision: convert the input, or clear `timeZone` (which would be a second writer).
- `nextOccurrenceDate`, the task-in-event ended state (`eventEnd`), transcript event matching and `/api/items` reads still use the stored times as tenant wall clock, and ignore raw rules.
- Overrides of a series stay when the user switches its rule to a simple one; with a simple rule they match by `occurrenceDate`.

**Tests.**
- New `backend/packages/data/src/__tests__/syncedEventTimes.test.ts` (16 tests, runtime-role pool, two tenants):
  - the seed shape;
  - New York 09:00 shown at 15:00 in a Prague tenant in the timeline and the reminders feed, and a New York evening shown on the next Prague day;
  - `FREQ=WEEKLY;INTERVAL=2;COUNT=5` with one EXDATE gives four occurrences, an override replaces one, and the reminders feed lists the occurrences but not the excluded date;
  - zoned RRULE expansion;
  - a title edit keeps the rule, and switching to "every Monday" clears it;
  - an override materialized for a raw-rule series and for a simple account-calendar series, and 400 for an excluded or skipped date;
  - user and agent refused, another system writer refused, the sync allowed;
  - validation tables;
  - foreign-tenant isolation.
- New `calendar/__tests__/syncedEventFields.unit.test.ts` (12 tests).
- Unit tests renamed: `recurrenceExpansion.unit.test.ts` and `recurringSeriesExpansion.unit.test.ts`.
- Updated `tenantItemSearchBackfill.test.ts`: the provider fields are not searchable.
- Mutation checks each failed the intended tests: no zone conversion (3 tests), no clearing plus no writer check (2), no exceptions or overrides (1).

**Verification (Node 22.23.4, `backend/`).**
- `pnpm run build` pass; `pnpm run lint` pass; `pnpm run format:check` pass; `check:boundaries` and `check:write-safety` pass.
- `pnpm run test:unit`: 4799/4801. The 2 failures were 5 s timeouts in `recipesModuleManifest.unit.test.ts` and `collectionMetadata.unit.test.ts` at load average about 28; both files pass alone (16/16). That is load noise. The earlier full unit run passed 4789/4789 + 172/172.
- Integration: 174 files (every calendar, event, timeline, occurrence, reminder, agenda, subscribed, invitation, recurrence, seed, schema, property, duplicate and transcript integration file, plus the tenant isolation, search backfill, ref expansion and batch34 contract files). The final run passed 174/174 files, 4158/4158 tests.
- The first run had 3 failures. Two were fixed: `timelineRead` (the widened window logged an invalid row, so widening is now limited to zoned rows) and `tenantItemSearchBackfill` (expectation updated). The third, `invitationHandler` 413, was a port collision with an SSH banner and passes alone.
