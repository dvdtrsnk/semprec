// Applies what an adapter fetched for one internet account in one transaction: account calendars created, updated or
// untracked, Events created, updated or trashed by their remote id, the remote state and cursors stored, and the
// account's sync state set to `ok`, and the provider's changes notified. Every item write goes through the choke point
// as `CALENDAR_SYNC_WRITER`.
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { z } from "zod";
import { getItemById, lockItemById, lockItemForShare } from "../../chokePoint/itemsStore.js";
import { itemDeleteWithClient } from "../../chokePoint/itemTrash.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { CALENDAR_SYNC_WRITER } from "../../chokePoint/writerKind.js";
import { withSavepoint } from "../../db/pool.js";
import { ValidationError } from "../../errors.js";
import { areCalendarsEnabled } from "../../mail/mailboxServiceHooks.js";
import { createActionQueueAffinity } from "../../scheduler/actions.js";
import { resolveProblem } from "../../semp/sempProblemsStore.js";
import { calendarProblemKey } from "../../semp/sourceProblemKeys.js";
import { CALENDAR_MODULE_ID } from "../calendarModuleId.js";
import { createEventInCalendar } from "../defaultCalendarCreateHook.js";
import { EVENT_SERIES_ID_PROPERTY_KEY } from "../eventOccurrenceId.js";
import { logger } from "../logger.js";
import { SYNCED_EVENT_PROPERTY_KEYS } from "../syncedEventFields.js";
import {
  CalendarSyncProviderError,
  type CalendarChanges,
  type CalendarSyncWindow,
  type RemoteCalendar,
  type RemoteEvent,
  type RemoteEventFields,
} from "./adapter.js";
import { lockCalendarAccountSync } from "./calendarAccountSyncGuard.js";
import {
  NOTIFIED_EVENT_FIELD_KEYS,
  notifyCalendarChanges,
  type CalendarChangeNotice,
  type NotifiedCalendar,
} from "./calendarChangeNotifications.js";
import { enqueueCalendarAccountCleanup, enqueueCalendarEventPush } from "./calendarAccountSyncEnqueue.js";
import {
  deleteCalendarRemoteStates,
  deleteEventRemoteStates,
  getCalendarAccountSyncState,
  getEventPushState,
  listEventRemoteStates,
  listAccountWaitingEventPushes,
  listSyncedAccountCalendars,
  recordCalendarSyncSuccess,
  upsertCalendarRemoteState,
  upsertEventRemoteState,
  type CalendarSyncIds,
  type StoredAccountCalendar,
  type StoredRemoteEvent,
} from "./calendarSyncStore.js";

/** Bounds of what one pass accepts from an adapter; more is refused as `invalidResponse`. */
const MAX_CALENDARS = 200;
const MAX_EVENT_CHANGES_PER_CALENDAR = 25_000;
const MAX_ID_LENGTH = 2048;
const MAX_TEXT_LENGTH = 100_000;
const MAX_PARTICIPANTS = 500;

const shortText = z.string().max(MAX_ID_LENGTH);
const nullableShortText = shortText.nullable();
const nullableText = z.string().max(MAX_TEXT_LENGTH).nullable();
const color = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/)
  .nullable();

const remoteCalendarSchema = z.strictObject({
  remoteId: shortText.min(1),
  url: nullableShortText,
  name: nullableText,
  color,
  readOnly: z.boolean(),
  ctag: nullableShortText,
});

const participantSchema = z.strictObject({
  email: nullableShortText,
  name: nullableShortText,
  role: nullableShortText,
  status: nullableShortText,
});

const fieldsSchema = z.strictObject({
  name: nullableText,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  timeFrom: nullableShortText,
  timeTo: nullableShortText,
  timeZone: nullableShortText,
  recurrenceRule: nullableText,
  exceptionDates: z.array(shortText).max(1000).nullable(),
  recurrenceId: nullableShortText,
  place: nullableText,
  description: nullableText,
  url: nullableText,
  alertMinutes: z.number().int().nullable(),
});

const remoteEventSchema = z.strictObject({
  remoteId: shortText.min(1),
  href: nullableShortText,
  etag: nullableShortText,
  seriesRemoteId: nullableShortText,
  fields: fieldsSchema,
  organizer: participantSchema.nullable(),
  attendees: z.array(participantSchema).max(MAX_PARTICIPANTS),
});

const changesSchema = z.strictObject({
  full: z.boolean(),
  upserts: z.array(remoteEventSchema).max(MAX_EVENT_CHANGES_PER_CALENDAR),
  deletions: z.array(shortText).max(MAX_EVENT_CHANGES_PER_CALENDAR),
  nextSyncState: z.strictObject({ syncToken: nullableShortText, ctag: nullableShortText }),
});

function invalidResponse(): CalendarSyncProviderError {
  return new CalendarSyncProviderError("invalidResponse", "The calendar adapter's answer is invalid");
}

/** Refuses an answer outside the contract or its bounds, or with a calendar listed twice. */
export function parseRemoteCalendars(value: unknown): RemoteCalendar[] {
  const parsed = z.array(remoteCalendarSchema).max(MAX_CALENDARS).safeParse(value);
  if (!parsed.success) throw invalidResponse();
  if (new Set(parsed.data.map((calendar) => calendar.remoteId)).size !== parsed.data.length) throw invalidResponse();
  return parsed.data;
}

/** Refuses an answer outside the contract or its bounds, or with an Event listed twice. */
export function parseCalendarChanges(value: unknown): CalendarChanges {
  const parsed = changesSchema.safeParse(value);
  if (!parsed.success) throw invalidResponse();
  if (new Set(parsed.data.upserts.map((event) => event.remoteId)).size !== parsed.data.upserts.length) {
    throw invalidResponse();
  }
  return parsed.data;
}

export interface FetchedCalendar {
  calendar: RemoteCalendar;
  changes: CalendarChanges;
}

/** What the pass read before fetching; the apply goes ahead only while the tracked calendars still match it. */
export type TrackedCalendarsSnapshot = ReadonlyArray<
  Pick<StoredAccountCalendar, "calendarItemId" | "remoteId" | "syncToken" | "ctag">
>;

export function trackedCalendarsSnapshot(calendars: readonly StoredAccountCalendar[]): TrackedCalendarsSnapshot {
  return calendars.map(({ calendarItemId, remoteId, syncToken, ctag }) => ({
    calendarItemId,
    remoteId,
    syncToken,
    ctag,
  }));
}

export interface SyncedEventChange {
  eventItemId: string;
  calendarItemId: string;
  remoteId: string;
}

/**
 * The outcome of an apply. `applied` lists the Events this transaction created (`added`), changed (`changed`) and
 * trashed because the provider deleted them (`cancelled`); `initialSync` is `true` for the account's first completed
 * pass, whose Events are not news. `skipped`: the account is gone or has Calendars off. `superseded`: another pass
 * or a switch changed the tracked calendars since the fetch, which is then discarded.
 */
export type CalendarSyncApplyResult =
  | {
      kind: "applied";
      initialSync: boolean;
      added: SyncedEventChange[];
      changed: SyncedEventChange[];
      cancelled: SyncedEventChange[];
      /** Fetched Events not stored: refused by an Event rule, an override of an unknown series, or trashed here. */
      skippedEvents: number;
    }
  | { kind: "skipped" }
  | { kind: "superseded" };

export interface CalendarSyncApplyInput {
  accountItemId: string;
  ids: CalendarSyncIds;
  tracked: TrackedCalendarsSnapshot;
  fetched: readonly FetchedCalendar[];
  /** The window the fetches covered; a full fetch deletes only stored Events it could have listed. */
  window: CalendarSyncWindow;
  /** How long to wait for the account's guard before the pass is skipped. */
  guardWaitMs: number;
}

const REMOTE_CALENDAR_KEYS = ["remoteName", "remoteColor", "readOnly"] as const;
const SYNC_EVENT_SYSTEM_KEYS = [...SYNCED_EVENT_PROPERTY_KEYS, EVENT_SERIES_ID_PROPERTY_KEY] as const;
export const REMOTE_EVENT_FIELD_KEYS = [
  "name",
  "date",
  "endDate",
  "timeFrom",
  "timeTo",
  "timeZone",
  "recurrenceRule",
  "exceptionDates",
  "recurrenceId",
  "place",
  "description",
  "url",
  "alertMinutes",
] as const satisfies readonly (keyof RemoteEventFields)[];

/** What `base_snapshot` stores: the provider's fields and participants as last applied. */
export function snapshotOf(event: Pick<RemoteEvent, "fields" | "seriesRemoteId" | "organizer" | "attendees">) {
  return {
    fields: event.fields,
    seriesRemoteId: event.seriesRemoteId,
    organizer: event.organizer,
    attendees: event.attendees,
  };
}

export function snapshotFields(snapshot: Record<string, unknown>): Record<string, unknown> {
  const fields = snapshot.fields;
  return typeof fields === "object" && fields !== null && !Array.isArray(fields) ? { ...fields } : {};
}

/**
 * The Event's properties on create: the provider's fields without empty ones, and for an override its series and
 * original start. A master never names `seriesId` (any value there makes a row an occurrence).
 */
function createProperties(fields: RemoteEventFields, seriesItemId: string | null): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const key of REMOTE_EVENT_FIELD_KEYS) {
    if (key === "recurrenceId" && seriesItemId === null) continue;
    if (fields[key] !== null) properties[key] = fields[key];
  }
  if (seriesItemId !== null) properties[EVENT_SERIES_ID_PROPERTY_KEY] = seriesItemId;
  return properties;
}

/** The fields the provider changed since the last applied snapshot; a local edit of any other field stays. */
function providerChanges(fields: RemoteEventFields, base: Record<string, unknown>, isOverride: boolean) {
  const patch: Record<string, unknown> = {};
  for (const key of REMOTE_EVENT_FIELD_KEYS) {
    if (key === "recurrenceId" && !isOverride) continue;
    if (!isDeepStrictEqual(fields[key], base[key] ?? null)) patch[key] = fields[key];
  }
  return patch;
}

/**
 * Whether a full fetch of `window` would have listed the stored Event: a series always (it may recur into the
 * window), any other Event when its days overlap the window.
 */
function withinWindow(event: StoredRemoteEvent, window: CalendarSyncWindow): boolean {
  const fields = snapshotFields(event.baseSnapshot);
  if (typeof fields.recurrenceRule === "string") return true;
  const start = typeof fields.date === "string" ? fields.date : null;
  if (start === null) return true;
  const end = typeof fields.endDate === "string" ? fields.endDate : start;
  return start <= window.end && end >= window.start;
}

function sameTracked(stored: readonly StoredAccountCalendar[], tracked: TrackedCalendarsSnapshot): boolean {
  return isDeepStrictEqual(trackedCalendarsSnapshot(stored), tracked);
}

/** The account's addresses, one per line in `Mailboxes.addresses`. */
function accountAddresses(properties: Record<string, unknown>): string[] {
  const { addresses } = properties;
  if (typeof addresses !== "string") return [];
  return addresses
    .split(/[\n,\r]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function textProperty(properties: Record<string, unknown>, key: string): string | null {
  const value = properties[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function refusedField(error: ValidationError): string | null {
  const details: unknown = error.details;
  if (typeof details !== "object" || details === null || !("field" in details)) return null;
  return typeof details.field === "string" ? details.field : null;
}

/**
 * Runs in the caller's transaction. Takes the account's calendar sync guard first (at most `guardWaitMs`, else
 * `CalendarAccountSyncBusyError`), so a Calendars switch or removal of the account, its cleanup and another apply wait
 * for it. Under the guard it re-reads the account and its tracked calendars.
 *
 * A full fetch deletes the stored Events of the window it did not list; Events outside the window stay.
 * Calendars are written before any Event, the order Event writes lock them in (calendar row, then Event row).
 * Calendars the provider no longer lists lose their remote state, and the cleanup is queued to trash them with their
 * Events. An Event whose snapshot equals the fetched one writes nothing; one whose address alone changed updates only
 * its remote state. Each Event is written in a savepoint: an Event rule refusing a value (`ValidationError`) skips that
 * Event, which keeps no remote state and is offered again by a later full fetch.
 *
 * Except in the account's initial sync, the Events added, cancelled, or changed in title, time or place in a calendar
 * that was tracked before this pass and has `notify` on are notified in the same transaction. A change that leaves
 * those fields as the Event already had them locally (the echo of a local edit) is not news.
 */
export async function applyCalendarSync(
  client: PoolClient,
  input: CalendarSyncApplyInput,
): Promise<CalendarSyncApplyResult> {
  const { accountItemId, ids } = input;
  await lockCalendarAccountSync(client, accountItemId, { maxWaitMs: input.guardWaitMs });
  const account = await getItemById(client, ids.mailboxesDatabaseId, accountItemId);
  if (!account || account.deletedAt || !areCalendarsEnabled(account.properties)) return { kind: "skipped" };
  const stored = await listSyncedAccountCalendars(client, ids, accountItemId);
  if (!sameTracked(stored, input.tracked)) return { kind: "superseded" };
  const state = await getCalendarAccountSyncState(client, accountItemId, { forUpdate: true });
  const initialSync = state?.initialSyncCompletedAt == null;

  const storedByRemoteId = new Map(stored.map((calendar) => [calendar.remoteId, calendar]));
  const queueAffinity = createActionQueueAffinity();
  const targets: Array<FetchedCalendar & { calendarItemId: string; notify: boolean }> = [];
  const notifiedCalendars: NotifiedCalendar[] = [];
  const accountName = textProperty(account.properties, "name") ?? "";
  for (const { calendar, changes } of input.fetched) {
    const existing = storedByRemoteId.get(calendar.remoteId);
    const remote = { remoteName: calendar.name, remoteColor: calendar.color, readOnly: calendar.readOnly };
    if (existing) {
      const patch = Object.fromEntries(
        REMOTE_CALENDAR_KEYS.filter((key) => !isDeepStrictEqual(existing.properties[key] ?? null, remote[key])).map(
          (key) => [key, remote[key]],
        ),
      );
      if (Object.keys(patch).length > 0) {
        await updateItemWithClient(
          client,
          { databaseId: ids.calendarsDatabaseId, itemId: existing.calendarItemId, propertiesPatch: patch },
          {
            writer: CALENDAR_SYNC_WRITER,
            allowedSystemKeys: REMOTE_CALENDAR_KEYS,
            systemOwnerProcess: CALENDAR_MODULE_ID,
            queueAffinity,
          },
        );
      }
      const notify = !initialSync && existing.properties.notify === true;
      if (notify) {
        notifiedCalendars.push({
          calendarItemId: existing.calendarItemId,
          name: textProperty(existing.properties, "name") ?? calendar.name ?? accountName,
        });
      }
      targets.push({ calendar, changes, calendarItemId: existing.calendarItemId, notify });
      continue;
    }
    const created = await createItemWithClient(
      client,
      {
        databaseId: ids.calendarsDatabaseId,
        properties: {
          kind: "account",
          name: null,
          color: null,
          notify: true,
          hidden: false,
          isDefault: false,
          ...remote,
        },
      },
      {
        writer: CALENDAR_SYNC_WRITER,
        allowedSystemKeys: ["kind", ...REMOTE_CALENDAR_KEYS],
        systemOwnerProcess: CALENDAR_MODULE_ID,
        queueAffinity,
      },
    );
    await createRelationWithClient(
      client,
      { relationPropertyId: ids.accountPropertyId, callerItemId: created.id, targetItemId: accountItemId },
      { ownerProcess: CALENDAR_MODULE_ID },
      CALENDAR_SYNC_WRITER,
    );
    // A calendar new to this pass is in its own first sync: its Events are not news.
    targets.push({ calendar, changes, calendarItemId: created.id, notify: false });
  }
  const listed = new Set(input.fetched.map(({ calendar }) => calendar.remoteId));
  const vanished = stored
    .filter((calendar) => !listed.has(calendar.remoteId))
    .map((calendar) => calendar.calendarItemId);
  if (vanished.length > 0) {
    await deleteCalendarRemoteStates(client, vanished);
    await enqueueCalendarAccountCleanup(client, accountItemId);
  }

  const added: SyncedEventChange[] = [];
  const changed: SyncedEventChange[] = [];
  const cancelled: SyncedEventChange[] = [];
  const notices: CalendarChangeNotice[] = [];
  let skippedEvents = 0;
  const pushesToRequeue = new Set<string>();
  for (const { calendar, changes, calendarItemId, notify } of targets) {
    // Lock order: the calendar before its Events' rows, as an Event write takes them.
    await lockItemForShare(client, ids.calendarsDatabaseId, calendarItemId);
    const storedEvents = new Map(
      (await listEventRemoteStates(client, calendarItemId)).map((event) => [event.remoteId, event]),
    );
    const upserted = new Set(changes.upserts.map((event) => event.remoteId));
    const deletions = changes.full
      ? [...storedEvents.values()]
          .filter((event) => !upserted.has(event.remoteId) && withinWindow(event, input.window))
          .map((event) => event.remoteId)
      : changes.deletions.filter((remoteId) => !upserted.has(remoteId));
    const released: string[] = [];
    for (const remoteId of deletions) {
      const event = storedEvents.get(remoteId);
      if (!event) continue;
      if (await hasPendingPush(client, ids, event.eventItemId)) {
        pushesToRequeue.add(event.eventItemId);
        storedEvents.delete(remoteId);
        continue;
      }
      if (!event.deleted) {
        await itemDeleteWithClient(client, ids.eventsDatabaseId, event.eventItemId, {
          queueAffinity,
          writer: CALENDAR_SYNC_WRITER,
        });
        cancelled.push({ eventItemId: event.eventItemId, calendarItemId, remoteId });
        if (notify) {
          notices.push({
            kind: "cancelled",
            eventItemId: event.eventItemId,
            calendarItemId,
            snapshot: event.baseSnapshot,
            etag: event.etag,
          });
        }
      }
      released.push(event.eventItemId);
      storedEvents.delete(remoteId);
    }
    await deleteEventRemoteStates(client, released);

    const itemIdByRemoteId = new Map([...storedEvents].map(([remoteId, event]) => [remoteId, event.eventItemId]));
    // Masters before overrides, so an override finds the item of its series.
    const ordered = [
      ...changes.upserts.filter((event) => event.seriesRemoteId === null),
      ...changes.upserts.filter((event) => event.seriesRemoteId !== null),
    ];
    for (const event of ordered) {
      const outcome = await applyEvent(client, {
        ids,
        calendarItemId,
        event,
        existing: storedEvents.get(event.remoteId),
        seriesItemId: event.seriesRemoteId === null ? null : (itemIdByRemoteId.get(event.seriesRemoteId) ?? undefined),
        queueAffinity,
        notify,
      });
      if (outcome.kind === "pendingPush") {
        pushesToRequeue.add(outcome.eventItemId);
        continue;
      }
      if (outcome.kind === "skipped") {
        skippedEvents += 1;
        continue;
      }
      itemIdByRemoteId.set(event.remoteId, outcome.eventItemId);
      const change = { eventItemId: outcome.eventItemId, calendarItemId, remoteId: event.remoteId };
      if (outcome.kind === "created") added.push(change);
      if (outcome.kind === "updated") changed.push(change);
      if (notify && (outcome.kind === "created" || (outcome.kind === "updated" && outcome.news))) {
        notices.push({
          kind: outcome.kind === "created" ? "added" : "changed",
          eventItemId: outcome.eventItemId,
          calendarItemId,
          snapshot: snapshotOf(event),
          etag: event.etag,
        });
      }
    }
    await upsertCalendarRemoteState(client, {
      calendarItemId,
      remoteId: calendar.remoteId,
      remoteUrl: calendar.url,
      syncToken: changes.nextSyncState.syncToken,
      ctag: changes.nextSyncState.ctag ?? calendar.ctag,
    });
  }

  // The pushes this pass left to their job, and the ones that waited for the account to work again.
  for (const eventItemId of await listAccountWaitingEventPushes(
    client,
    ids,
    targets.map((target) => target.calendarItemId),
  )) {
    pushesToRequeue.add(eventItemId);
  }
  for (const eventItemId of [...pushesToRequeue].sort()) await enqueueCalendarEventPush(client, eventItemId);

  await notifyCalendarChanges(client, {
    accountItemId,
    calendars: notifiedCalendars,
    ownAddresses: accountAddresses(account.properties),
    notices,
  });
  await recordCalendarSyncSuccess(client, accountItemId);
  await resolveProblem(client, { dedupeKey: calendarProblemKey(accountItemId), resolutionKind: "recovered" });
  return { kind: "applied", initialSync, added, changed, cancelled, skippedEvents };
}

type EventOutcome =
  | { kind: "created" | "unchanged"; eventItemId: string }
  /** A local change of the Event waits for its push, which merges the provider's change in. */
  | { kind: "pendingPush"; eventItemId: string }
  /** `news`: the provider changed a notified field to a value the Event did not already have. */
  | { kind: "updated"; eventItemId: string; news: boolean }
  | { kind: "skipped" };

async function applyEvent(
  client: PoolClient,
  input: {
    ids: CalendarSyncIds;
    calendarItemId: string;
    event: RemoteEvent;
    existing: StoredRemoteEvent | undefined;
    /** `null` for a master; `undefined` for an override whose series is not stored. */
    seriesItemId: string | null | undefined;
    queueAffinity: ReturnType<typeof createActionQueueAffinity>;
    /** Whether a change of this Event may be notified, which needs the Event's values before the write. */
    notify: boolean;
  },
): Promise<EventOutcome> {
  const { ids, calendarItemId, event, existing, seriesItemId, queueAffinity, notify } = input;
  const log = { calendarItemId, eventItemId: existing?.eventItemId };
  if (seriesItemId === undefined) {
    logger.warn(log, "Calendar sync skipped an override whose series is not stored");
    return { kind: "skipped" };
  }
  // A synced Event the user trashed here stays in the trash; pushing that to the provider is the write-back's.
  if (existing?.deleted === true) return { kind: "skipped" };
  const snapshot = snapshotOf(event);
  const remoteState = {
    calendarItemId,
    remoteId: event.remoteId,
    href: event.href,
    etag: event.etag,
    baseSnapshot: snapshot,
  };
  if (existing && isDeepStrictEqual(existing.baseSnapshot, snapshot)) {
    if (existing.href !== event.href || existing.etag !== event.etag) {
      await upsertEventRemoteState(client, { ...remoteState, eventItemId: existing.eventItemId });
    }
    return { kind: "unchanged", eventItemId: existing.eventItemId };
  }
  if (existing && (await hasPendingPush(client, ids, existing.eventItemId))) {
    return { kind: "pendingPush", eventItemId: existing.eventItemId };
  }
  const options = { writer: CALENDAR_SYNC_WRITER, allowedSystemKeys: SYNC_EVENT_SYSTEM_KEYS, queueAffinity };
  try {
    return await withSavepoint(client, async (): Promise<EventOutcome> => {
      if (existing) {
        const patch = providerChanges(event.fields, snapshotFields(existing.baseSnapshot), seriesItemId !== null);
        const notified = notify ? NOTIFIED_EVENT_FIELD_KEYS.filter((key) => Object.hasOwn(patch, key)) : [];
        let news = false;
        if (notified.length > 0) {
          const before = await getItemById(client, ids.eventsDatabaseId, existing.eventItemId);
          news = notified.some((key) => !isDeepStrictEqual(before?.properties[key] ?? null, patch[key]));
        }
        if (Object.keys(patch).length > 0) {
          await updateItemWithClient(
            client,
            { databaseId: ids.eventsDatabaseId, itemId: existing.eventItemId, propertiesPatch: patch },
            options,
          );
        }
        await upsertEventRemoteState(client, { ...remoteState, eventItemId: existing.eventItemId });
        return Object.keys(patch).length > 0
          ? { kind: "updated", eventItemId: existing.eventItemId, news }
          : { kind: "unchanged", eventItemId: existing.eventItemId };
      }
      const created = await createEventInCalendar(
        client,
        { properties: createProperties(event.fields, seriesItemId) },
        calendarItemId,
        options,
      );
      await upsertEventRemoteState(client, { ...remoteState, eventItemId: created.id });
      return { kind: "created", eventItemId: created.id };
    });
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    logger.warn({ ...log, field: refusedField(error) }, "Calendar sync skipped an Event an Event rule refused");
    return { kind: "skipped" };
  }
}

/**
 * Read under the Event's row lock, which every writer of its push state holds, so a local change recorded after this
 * check waits for the pass to commit and is pushed against what it wrote.
 */
async function hasPendingPush(client: PoolClient, ids: CalendarSyncIds, eventItemId: string): Promise<boolean> {
  await lockItemById(client, ids.eventsDatabaseId, eventItemId);
  return (await getEventPushState(client, eventItemId))?.status === "pending";
}
