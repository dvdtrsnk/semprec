// The push of one account calendar Event's local change to its provider (task `calendarEventPush`). A short read
// transaction decides what the provider needs; the adapter calls run with no transaction open; each result is stored
// in its own transaction under the account's calendar sync guard, so a sync pass never applies in between.
//
// A conditional write the provider refuses means the Event changed there too: the provider's version is read and
// merged with the local one field by field against the base the last sync or push stored (the provider wins a field
// changed on both sides), the merge is applied here as the calendar sync, and the result is pushed once more.
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getTenantUserId } from "../../auth/usersStore.js";
import { getItemById, lockItemById, lockItemForShare } from "../../chokePoint/itemsStore.js";
import { itemDeleteWithClient } from "../../chokePoint/itemTrash.js";
import { updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { CALENDAR_SYNC_WRITER } from "../../chokePoint/writerKind.js";
import { withTransaction } from "../../db/pool.js";
import { writeNotification } from "../../notifications/notify.js";
import { createActionQueueAffinity } from "../../scheduler/actions.js";
import { getSystemTimezone } from "../../systemSettings.js";
import { assertValidTimezone } from "../../timezone.js";
import type { ItemRow } from "../../types.js";
import { EVENT_SERIES_ID_PROPERTY_KEY } from "../eventOccurrenceId.js";
import { EVENT_RECURRENCE_PROPERTY_KEY, parseEventRecurrenceRule } from "../eventRecurrenceRule.js";
import { logger } from "../logger.js";
import { readExceptionDates, readEventTimeZone, SYNCED_EVENT_PROPERTY_KEYS } from "../syncedEventFields.js";
import {
  EVENT_EXCEPTION_DATES_PROPERTY_KEY,
  EVENT_RECURRENCE_ID_PROPERTY_KEY,
  EVENT_RECURRENCE_RULE_PROPERTY_KEY,
  EVENT_TIME_ZONE_PROPERTY_KEY,
} from "../syncedEventKeys.js";
import {
  CalendarSyncEventConflictError,
  CalendarSyncWriteUnsupportedError,
  type CalendarSyncAdapter,
  type CalendarSyncAdapterRegistry,
  type CalendarSyncWindow,
  type RemoteCalendar,
  type RemoteEventFields,
  type RemoteEventRef,
  type RemoteParticipant,
} from "./adapter.js";
import { CALENDAR_SYNC_ADAPTERS } from "./adapters/index.js";
import { lockCalendarAccountSync } from "./calendarAccountSyncGuard.js";
import {
  failureRecordOf,
  openCalendarSyncAdapter,
  readCalendarSyncAccount,
  recordCalendarAccountFailure,
  syncWindow,
  type CalendarSyncAccountContext,
} from "./calendarAccountSyncJob.js";
import { REMOTE_EVENT_FIELD_KEYS, snapshotFields, snapshotOf } from "./calendarSyncApply.js";
import {
  deleteEventRemoteStates,
  findEventByRemoteId,
  getAccountOfCalendar,
  getCalendarRemoteState,
  getEventAccountCalendar,
  getEventPushState,
  getEventRemoteState,
  recordEventPushAttemptFailure,
  recordEventPushOutcome,
  resolveCalendarSyncIds,
  upsertEventRemoteState,
  type CalendarEventPushOperation,
  type CalendarSyncIds,
  type StoredRemoteEvent as StoredRemoteEventRow,
} from "./calendarSyncStore.js";
import { changedEventFields, mergeEventFields, type RemoteEventFieldKey } from "./eventMerge.js";

/** An Event's remote state with the calendar it is in at the provider. */
type StoredRemoteEvent = StoredRemoteEventRow & { calendarItemId: string };

/** Attempts of one change before its push is `failed`; the queue's own limit is higher, so this one decides. */
export const MAX_EVENT_PUSH_ATTEMPTS = 5;
/** The deadline of every adapter call of one push together. */
const EVENT_PUSH_TIMEOUT_MS = 2 * 60_000;
/**
 * How long storing a result waits for the account's guard (a running sync pass) before the attempt is retried; long,
 * since a retried push repeats a write the provider already took.
 */
const EVENT_PUSH_GUARD_WAIT_MS = 30_000;

const payloadSchema = z.strictObject({ eventItemId: z.uuid() });
const SYNC_EVENT_SYSTEM_KEYS = [...SYNCED_EVENT_PROPERTY_KEYS, EVENT_SERIES_ID_PROPERTY_KEY] as const;

const participantSchema = z.object({
  email: z.string().nullable(),
  name: z.string().nullable(),
  role: z.string().nullable(),
  status: z.string().nullable(),
});
const snapshotParticipantsSchema = z.object({
  organizer: participantSchema.nullable().catch(null),
  attendees: z.array(participantSchema).catch([]),
});

export type CalendarEventPushResult =
  /** No pending push, or nothing the provider needs. */
  | { kind: "nothing" }
  | { kind: "sent"; operation: CalendarEventPushOperation }
  /** A provider change met the local one; `overwritten` lists the local values the provider's replaced. */
  | { kind: "merged"; overwritten: RemoteEventFieldKey[] }
  /** The provider refused the merged version as well. */
  | { kind: "conflict" }
  | { kind: "failed"; code: string }
  /** The account needs a new sign-in or grant; the push stays pending until a sync pass reaches the provider. */
  | { kind: "waiting"; code: string }
  /** A newer local change was recorded meanwhile; its own push carries on. */
  | { kind: "superseded" };

export interface CalendarEventPushOptions {
  adapters?: CalendarSyncAdapterRegistry;
  /** graphile-worker's per-attempt job id, so a redelivered failure adds no Semp problem occurrence. */
  jobId?: string;
  timeoutMs?: number;
}

/** An account calendar the sync tracks, with what its adapter is opened with. */
interface Endpoint {
  calendarItemId: string;
  account: CalendarSyncAccountContext;
  remote: RemoteCalendar;
}

type Plan =
  | { kind: "nothing" }
  | { kind: "failed"; code: string }
  | { kind: "delete"; endpoint: Endpoint; stored: StoredRemoteEvent }
  | { kind: "create"; endpoint: Endpoint; fields: RemoteEventFields; icalUid: string | null; series: Series | null }
  | { kind: "update"; endpoint: Endpoint; stored: StoredRemoteEvent; fields: RemoteEventFields }
  | {
      kind: "move";
      from: Endpoint;
      to: Endpoint;
      stored: StoredRemoteEvent;
      fields: RemoteEventFields;
      icalUid: string | null;
    }
  | { kind: "cancelOccurrence"; endpoint: Endpoint; series: Series; fields: RemoteEventFields };

/** The series of an override, as the sync stored it. */
interface Series {
  eventItemId: string;
  stored: StoredRemoteEvent;
}

interface PushContext {
  pool: Pool;
  ids: CalendarSyncIds;
  eventItemId: string;
  revision: number;
  window: CalendarSyncWindow;
  signal: AbortSignal;
  adapters: CalendarSyncAdapterRegistry;
  opened: Map<string, CalendarSyncAdapter>;
}

/**
 * A failure recorded as the push's status: a provider or unexpected failure is counted and rethrown so the queue
 * retries it, until `MAX_EVENT_PUSH_ATTEMPTS` make it `failed`; a write the provider cannot represent is `failed` at
 * once; a refused credential or grant also records the account's calendar status and Semp problem and waits.
 */
export async function handleCalendarEventPushTask(
  pool: Pool,
  payload: unknown,
  options: CalendarEventPushOptions = {},
): Promise<CalendarEventPushResult> {
  const { eventItemId } = payloadSchema.parse(payload);
  const prologue = await withTransaction(pool, async (client) => {
    const ids = await resolveCalendarSyncIds(client);
    if (ids === null) return null;
    const state = await getEventPushState(client, eventItemId);
    if (state === null || state.status !== "pending") return null;
    const item = await getItemById(client, ids.eventsDatabaseId, eventItemId);
    if (item === null) return null;
    const tenantZone = await getSystemTimezone(client);
    assertValidTimezone(tenantZone);
    const plan = await planPush(client, ids, item, tenantZone);
    return { ids, revision: state.desiredRevision, tenantZone, plan };
  });
  if (prologue === null) return { kind: "nothing" };
  const { plan } = prologue;
  if (plan.kind === "nothing" || plan.kind === "failed") {
    await withTransaction(pool, (client) =>
      recordEventPushOutcome(client, eventItemId, prologue.revision, {
        status: plan.kind === "nothing" ? "sent" : "failed",
        errorCode: plan.kind === "failed" ? plan.code : null,
      }),
    );
    if (plan.kind === "failed") logger.warn({ eventItemId, code: plan.code }, "Calendar event push failed");
    return plan.kind === "nothing" ? { kind: "nothing" } : plan;
  }

  const signal = AbortSignal.timeout(options.timeoutMs ?? EVENT_PUSH_TIMEOUT_MS);
  const context: PushContext = {
    pool,
    ids: prologue.ids,
    eventItemId,
    revision: prologue.revision,
    window: syncWindow(prologue.tenantZone, new Date()),
    signal,
    adapters: options.adapters ?? CALENDAR_SYNC_ADAPTERS,
    opened: new Map(),
  };
  const accountItemId = plan.kind === "move" ? plan.from.account.accountItemId : plan.endpoint.account.accountItemId;
  try {
    const result = await executePlan(context, plan);
    logger.info({ eventItemId, outcome: result.kind }, "Calendar event push finished");
    return result;
  } catch (error) {
    return await recordPushFailure(context, accountItemId, error, options.jobId ?? randomUUID());
  }
}

async function recordPushFailure(
  context: PushContext,
  accountItemId: string,
  error: unknown,
  jobId: string,
): Promise<CalendarEventPushResult> {
  const { pool, eventItemId, revision } = context;
  const errorName = error instanceof Error ? error.name : typeof error;
  /** The push's failure is what the queue must see, also when its status cannot be written. */
  const recording = async <T>(write: (client: PoolClient) => Promise<T>): Promise<T> => {
    try {
      return await withTransaction(pool, write);
    } catch (recordError) {
      logger.error(
        { eventItemId, errorName: recordError instanceof Error ? recordError.name : typeof recordError },
        "Calendar event push could not record its failure",
      );
      throw error;
    }
  };
  if (error instanceof CalendarSyncWriteUnsupportedError) {
    await recording((client) =>
      recordEventPushOutcome(client, eventItemId, revision, { status: "failed", errorCode: "unsupported" }),
    );
    logger.warn({ eventItemId, errorName, code: "unsupported" }, "Calendar event push failed");
    return { kind: "failed", code: "unsupported" };
  }
  const failure = failureRecordOf(error, context.signal);
  // Provider errors can carry request details: only ids, the error's name and the fixed code are logged.
  logger.error({ eventItemId, accountItemId, errorName, code: failure.code }, "Calendar event push attempt failed");
  const attempts = await recording((client) =>
    recordEventPushAttemptFailure(client, eventItemId, revision, failure.code),
  );
  if (attempts === null) return { kind: "superseded" };
  if (failure.status !== "error") {
    try {
      await recordCalendarAccountFailure(pool, accountItemId, failure, jobId);
    } catch (recordError) {
      // The push's own outcome is recorded; the account's status is the next pass's to set.
      logger.error(
        { accountItemId, errorName: recordError instanceof Error ? recordError.name : typeof recordError },
        "Calendar event push could not record the account's failure",
      );
    }
    return { kind: "waiting", code: failure.code };
  }
  if (attempts >= MAX_EVENT_PUSH_ATTEMPTS) {
    await recording((client) =>
      recordEventPushOutcome(client, eventItemId, revision, { status: "failed", errorCode: failure.code }),
    );
    return { kind: "failed", code: failure.code };
  }
  throw error;
}

// ---------------------------------------------------------------------------------------------------------------
// What the provider needs

async function planPush(client: PoolClient, ids: CalendarSyncIds, item: ItemRow, tenantZone: string): Promise<Plan> {
  const stored = await getEventRemoteState(client, item.id);
  const target = await getEventAccountCalendar(client, ids, item.id);
  const targetEndpoint =
    target !== null && !target.readOnly && target.tracked ? await endpointOf(client, ids, target.calendarItemId) : null;
  const seriesId = textOf(item.properties[EVENT_SERIES_ID_PROPERTY_KEY]);

  // Still in the calendar the provider has it in, which is read-only or untracked now: there is nothing to send.
  if (
    item.deletedAt === null &&
    target !== null &&
    targetEndpoint === null &&
    stored?.calendarItemId === target.calendarItemId
  ) {
    return { kind: "failed", code: "calendarNotWritable" };
  }
  if (item.deletedAt !== null || targetEndpoint === null) {
    if (stored !== null) {
      const endpoint = await endpointOf(client, ids, stored.calendarItemId);
      return endpoint === null ? { kind: "nothing" } : { kind: "delete", endpoint, stored };
    }
    // A cancelled occurrence of a synced series that the provider never had as an override.
    if (item.deletedAt === null || seriesId === null) return { kind: "nothing" };
    const recurrenceId = textOf(item.properties[EVENT_RECURRENCE_ID_PROPERTY_KEY]);
    const series = await seriesOf(client, ids, seriesId);
    if (recurrenceId === null || series === null || series.item.deletedAt !== null) return { kind: "nothing" };
    const endpoint = await endpointOf(client, ids, series.series.stored.calendarItemId);
    const fields = localEventFields(series.item.properties, tenantZone, false);
    if (endpoint === null || fields === null) return { kind: "nothing" };
    const exceptionDates = [...new Set([...(fields.exceptionDates ?? []), recurrenceId])].sort();
    return { kind: "cancelOccurrence", endpoint, series: series.series, fields: { ...fields, exceptionDates } };
  }

  const fields = localEventFields(item.properties, tenantZone, seriesId !== null);
  if (fields === null) return { kind: "failed", code: "invalidEvent" };
  if (stored === null) {
    if (seriesId === null) {
      return {
        kind: "create",
        endpoint: targetEndpoint,
        fields,
        icalUid: textOf(item.properties.icalUid),
        series: null,
      };
    }
    const series = await seriesOf(client, ids, seriesId);
    if (series === null || fields.recurrenceId === null) return { kind: "failed", code: "seriesNotSynced" };
    if (series.series.stored.calendarItemId !== targetEndpoint.calendarItemId)
      return { kind: "failed", code: "moveUnsupported" };
    return { kind: "create", endpoint: targetEndpoint, fields, icalUid: null, series: series.series };
  }
  if (stored.calendarItemId === targetEndpoint.calendarItemId) {
    return { kind: "update", endpoint: targetEndpoint, stored, fields };
  }
  // A series moves with its overrides at the provider, which the Events here do not follow.
  if (seriesId !== null || fields.recurrenceRule !== null) return { kind: "failed", code: "moveUnsupported" };
  const from = await endpointOf(client, ids, stored.calendarItemId);
  if (from === null) {
    return { kind: "create", endpoint: targetEndpoint, fields, icalUid: textOf(item.properties.icalUid), series: null };
  }
  const sameAccount = from.account.accountItemId === targetEndpoint.account.accountItemId;
  return {
    kind: "move",
    from,
    to: targetEndpoint,
    stored,
    fields,
    // The same account keeps the Event's identity there (a CalDAV UID is its remote id).
    icalUid: sameAccount ? stored.remoteId : textOf(item.properties.icalUid),
  };
}

async function endpointOf(client: PoolClient, ids: CalendarSyncIds, calendarItemId: string): Promise<Endpoint | null> {
  const remote = await getCalendarRemoteState(client, calendarItemId);
  if (remote === null) return null;
  const accountItemId = await getAccountOfCalendar(client, ids, calendarItemId);
  if (accountItemId === null) return null;
  const account = await readCalendarSyncAccount(client, ids, accountItemId);
  if (account === null) return null;
  return {
    calendarItemId,
    account,
    remote: { remoteId: remote.remoteId, url: remote.remoteUrl, name: null, color: null, readOnly: false, ctag: null },
  };
}

async function seriesOf(
  client: PoolClient,
  ids: CalendarSyncIds,
  seriesId: string,
): Promise<{ series: Series; item: ItemRow } | null> {
  const stored = await getEventRemoteState(client, seriesId);
  const item = await getItemById(client, ids.eventsDatabaseId, seriesId);
  if (stored === null || item === null) return null;
  return { series: { eventItemId: seriesId, stored }, item };
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

const RRULE_DAYS = { mon: "MO", tue: "TU", wed: "WE", thu: "TH", fri: "FR", sat: "SA", sun: "SU" } as const;

/** The RRULE of an Events `recurrence` rule. */
function rruleOfRecurrence(raw: unknown): string {
  const rule = parseEventRecurrenceRule(raw);
  if (rule.kind === "weekdays") return `FREQ=WEEKLY;BYDAY=${rule.days.map((day) => RRULE_DAYS[day]).join(",")}`;
  if (rule.kind === "monthDates") return `FREQ=MONTHLY;BYMONTHDAY=${rule.dates.join(",")}`;
  return `FREQ=MONTHLY;BYDAY=${rule.n}${RRULE_DAYS[rule.weekday]}`;
}

/**
 * The Event as the provider should have it. A timed Event without a zone of its own is sent in the tenant's zone,
 * the zone its times are wall clock in; a `recurrence` rule is sent as its RRULE. `null` without a readable date.
 */
export function localEventFields(
  properties: Record<string, unknown>,
  tenantZone: string,
  isOverride: boolean,
): RemoteEventFields | null {
  const date = textOf(properties.date);
  if (date === null) return null;
  const timeFrom = textOf(properties.timeFrom);
  const zone = readEventTimeZone(properties);
  const rawRule = textOf(properties[EVENT_RECURRENCE_RULE_PROPERTY_KEY]);
  const recurrence = properties[EVENT_RECURRENCE_PROPERTY_KEY];
  const alertMinutes = properties.alertMinutes;
  return {
    name: textOf(properties.name),
    date,
    endDate: textOf(properties.endDate),
    timeFrom,
    timeTo: textOf(properties.timeTo),
    timeZone: zone ?? (timeFrom !== null ? tenantZone : null),
    recurrenceRule:
      rawRule ?? (recurrence === undefined || recurrence === null || isOverride ? null : rruleOfRecurrence(recurrence)),
    exceptionDates: readExceptionDates(properties[EVENT_EXCEPTION_DATES_PROPERTY_KEY]),
    recurrenceId: isOverride ? textOf(properties[EVENT_RECURRENCE_ID_PROPERTY_KEY]) : null,
    place: textOf(properties.place),
    description: textOf(properties.description),
    url: textOf(properties.url),
    alertMinutes: typeof alertMinutes === "number" && Number.isInteger(alertMinutes) ? alertMinutes : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Doing it

async function adapterFor(context: PushContext, endpoint: Endpoint): Promise<CalendarSyncAdapter> {
  const key = endpoint.account.accountItemId;
  const opened = context.opened.get(key);
  if (opened) return opened;
  const adapter = await openCalendarSyncAdapter(context.pool, endpoint.account, context.adapters);
  context.opened.set(key, adapter);
  return adapter;
}

async function executePlan(
  context: PushContext,
  plan: Exclude<Plan, { kind: "nothing" | "failed" }>,
): Promise<CalendarEventPushResult> {
  switch (plan.kind) {
    case "delete":
      return deleteRemote(context, plan.endpoint, plan.stored, "delete");
    case "create":
      return createRemote(context, plan.endpoint, plan.fields, plan.icalUid, plan.series, "create");
    case "update":
      return updateRemote(context, plan.endpoint, plan.stored, plan.fields, "update");
    case "cancelOccurrence":
      return cancelOccurrence(context, plan.endpoint, plan.series, plan.fields);
    case "move":
      return moveRemote(context, plan);
  }
}

/**
 * Stores a result under the account's guard and the Event's locks (its account calendar `FOR SHARE`, then its row),
 * the order a sync pass takes them in. `write` runs whether or not a newer change was recorded meanwhile, since the
 * provider has what was sent either way; the push's status is set only while its revision is current.
 */
async function storeResult(
  context: PushContext,
  accountItemId: string,
  write: (client: PoolClient, current: boolean) => Promise<"sent" | "conflict" | null>,
): Promise<boolean> {
  const { ids, eventItemId, revision } = context;
  return withTransaction(context.pool, async (client) => {
    await lockCalendarAccountSync(client, accountItemId, { maxWaitMs: EVENT_PUSH_GUARD_WAIT_MS });
    const calendar = await getEventAccountCalendar(client, ids, eventItemId);
    if (calendar !== null) await lockItemForShare(client, ids.calendarsDatabaseId, calendar.calendarItemId);
    await lockItemById(client, ids.eventsDatabaseId, eventItemId);
    const current = (await getEventPushState(client, eventItemId))?.desiredRevision === revision;
    const status = await write(client, current);
    if (current && status !== null) {
      await recordEventPushOutcome(client, eventItemId, revision, {
        status,
        errorCode: status === "conflict" ? "remoteConflict" : null,
      });
    }
    return current;
  });
}

function participantsOf(snapshot: Record<string, unknown>): {
  organizer: RemoteParticipant | null;
  attendees: RemoteParticipant[];
} {
  return snapshotParticipantsSchema.parse(snapshot);
}

function refOf(stored: StoredRemoteEvent): RemoteEventRef {
  return { remoteId: stored.remoteId, href: stored.href, etag: stored.etag };
}

function seriesRemoteIdOf(stored: StoredRemoteEvent): string | null {
  const value = stored.baseSnapshot.seriesRemoteId;
  return typeof value === "string" ? value : null;
}

async function deleteRemote(
  context: PushContext,
  endpoint: Endpoint,
  stored: StoredRemoteEvent,
  operation: CalendarEventPushOperation,
  finish = true,
): Promise<CalendarEventPushResult> {
  const adapter = await adapterFor(context, endpoint);
  try {
    await adapter.deleteEvent(endpoint.remote, refOf(stored), context.signal);
  } catch (error) {
    if (!(error instanceof CalendarSyncEventConflictError)) throw error;
    // Changed at the provider since: a trash here still means the Event goes, at its current version.
    const current = await adapter.getEvent(endpoint.remote, refOf(stored), {
      window: context.window,
      signal: context.signal,
    });
    if (current !== null) {
      try {
        await adapter.deleteEvent(endpoint.remote, current, context.signal);
      } catch (retryError) {
        if (!(retryError instanceof CalendarSyncEventConflictError)) throw retryError;
        await storeResult(context, endpoint.account.accountItemId, async () => "conflict");
        return { kind: "conflict" };
      }
    }
  }
  await storeResult(context, endpoint.account.accountItemId, async (client) => {
    await deleteEventRemoteStates(client, [context.eventItemId]);
    return finish ? "sent" : null;
  });
  return { kind: "sent", operation };
}

async function createRemote(
  context: PushContext,
  endpoint: Endpoint,
  fields: RemoteEventFields,
  icalUid: string | null,
  series: Series | null,
  operation: CalendarEventPushOperation,
): Promise<CalendarEventPushResult> {
  const adapter = await adapterFor(context, endpoint);
  let ref: RemoteEventRef;
  try {
    ref = await adapter.putEvent(
      endpoint.remote,
      { ref: null, fields, icalUid, ...(series ? { seriesRef: refOf(series.stored) } : {}) },
      context.signal,
    );
  } catch (error) {
    if (!(error instanceof CalendarSyncEventConflictError)) throw error;
    await storeResult(context, endpoint.account.accountItemId, async () => "conflict");
    return { kind: "conflict" };
  }
  const seriesRemoteId = series === null ? null : series.stored.remoteId;
  await storeResult(context, endpoint.account.accountItemId, async (client) => {
    // A sync pass that read the provider between the write and this store made an Event of its own for it.
    const duplicate = await findEventByRemoteId(client, endpoint.calendarItemId, ref.remoteId);
    if (duplicate !== null && duplicate !== context.eventItemId) {
      await deleteEventRemoteStates(client, [duplicate]);
      await itemDeleteWithClient(client, context.ids.eventsDatabaseId, duplicate, {
        queueAffinity: createActionQueueAffinity(),
        writer: CALENDAR_SYNC_WRITER,
      });
    }
    await upsertEventRemoteState(client, {
      eventItemId: context.eventItemId,
      calendarItemId: endpoint.calendarItemId,
      remoteId: ref.remoteId,
      href: ref.href,
      etag: ref.etag,
      baseSnapshot: snapshotOf({ fields, seriesRemoteId, organizer: null, attendees: [] }),
    });
    return "sent";
  });
  return { kind: "sent", operation };
}

async function updateRemote(
  context: PushContext,
  endpoint: Endpoint,
  stored: StoredRemoteEvent,
  fields: RemoteEventFields,
  operation: CalendarEventPushOperation,
): Promise<CalendarEventPushResult> {
  const adapter = await adapterFor(context, endpoint);
  const base = snapshotFields(stored.baseSnapshot);
  if (changedEventFields(baseFieldsOf(base), fields).length === 0) {
    await storeResult(context, endpoint.account.accountItemId, async () => "sent");
    return { kind: "sent", operation };
  }
  let ref: RemoteEventRef;
  try {
    ref = await adapter.putEvent(endpoint.remote, { ref: refOf(stored), fields }, context.signal);
  } catch (error) {
    if (!(error instanceof CalendarSyncEventConflictError)) throw error;
    return mergeWithRemote(context, endpoint, stored, fields);
  }
  await storeResult(context, endpoint.account.accountItemId, async (client) => {
    await storePushed(client, context, endpoint, stored, ref, fields);
    return "sent";
  });
  return { kind: "sent", operation };
}

/**
 * The base's fields with every missing one `null`, for comparing with `RemoteEventFields`. The values come from a
 * stored snapshot and are compared, never sent.
 */
function baseFieldsOf(base: Record<string, unknown>): RemoteEventFields {
  return Object.fromEntries(
    REMOTE_EVENT_FIELD_KEYS.map((key) => [key, base[key] ?? null]),
  ) as unknown as RemoteEventFields;
}

/** The pushed fields become the base: what the provider holds now, so the next fetch of it is not a change. */
async function storePushed(
  client: PoolClient,
  context: PushContext,
  endpoint: Endpoint,
  stored: StoredRemoteEvent,
  ref: RemoteEventRef,
  fields: RemoteEventFields,
): Promise<void> {
  await upsertEventRemoteState(client, {
    eventItemId: context.eventItemId,
    calendarItemId: endpoint.calendarItemId,
    remoteId: ref.remoteId,
    href: ref.href ?? stored.href,
    etag: ref.etag,
    baseSnapshot: snapshotOf({
      fields,
      seriesRemoteId: seriesRemoteIdOf(stored),
      ...participantsOf(stored.baseSnapshot),
    }),
  });
}

async function mergeWithRemote(
  context: PushContext,
  endpoint: Endpoint,
  stored: StoredRemoteEvent,
  local: RemoteEventFields,
): Promise<CalendarEventPushResult> {
  const adapter = await adapterFor(context, endpoint);
  const remote = await adapter.getEvent(endpoint.remote, refOf(stored), {
    window: context.window,
    signal: context.signal,
  });
  const base = snapshotFields(stored.baseSnapshot);
  const accountItemId = endpoint.account.accountItemId;

  if (remote === null) {
    // Deleted at the provider, which wins over the local change: the Event goes here too.
    const lost = changedEventFields(baseFieldsOf(base), local);
    const current = await storeResult(context, accountItemId, async (client, isCurrent) => {
      if (!isCurrent) return null;
      await itemDeleteWithClient(client, context.ids.eventsDatabaseId, context.eventItemId, {
        queueAffinity: createActionQueueAffinity(),
        writer: CALENDAR_SYNC_WRITER,
      });
      await deleteEventRemoteStates(client, [context.eventItemId]);
      if (lost.length > 0) await notifyOverwritten(client, context, endpoint, local.name, `deleted:${stored.etag}`);
      return "sent";
    });
    return current ? { kind: "merged", overwritten: lost } : { kind: "superseded" };
  }

  const merge = mergeEventFields(base, local, remote.fields);
  const needsPush = changedEventFields(remote.fields, merge.fields).length > 0;
  const current = await storeResult(context, accountItemId, async (client, isCurrent) => {
    // A newer local change is merged by its own push, with the values it wrote.
    if (!isCurrent) return null;
    await applyLocally(client, context, local, merge.fields);
    await upsertEventRemoteState(client, {
      eventItemId: context.eventItemId,
      calendarItemId: endpoint.calendarItemId,
      remoteId: remote.remoteId,
      href: remote.href,
      etag: remote.etag,
      baseSnapshot: snapshotOf(remote),
    });
    if (merge.overwritten.length > 0) {
      const version = remote.etag ?? createHash("sha256").update(JSON.stringify(remote.fields)).digest("hex");
      await notifyOverwritten(client, context, endpoint, merge.fields.name, `overwritten:${version}`);
    }
    return needsPush ? null : "sent";
  });
  if (!current) return { kind: "superseded" };
  if (needsPush) {
    const remoteStored: StoredRemoteEvent = {
      ...stored,
      remoteId: remote.remoteId,
      href: remote.href,
      etag: remote.etag,
    };
    let ref: RemoteEventRef;
    try {
      ref = await adapter.putEvent(endpoint.remote, { ref: refOf(remoteStored), fields: merge.fields }, context.signal);
    } catch (error) {
      if (!(error instanceof CalendarSyncEventConflictError)) throw error;
      await storeResult(context, accountItemId, async () => "conflict");
      return { kind: "conflict" };
    }
    await storeResult(context, accountItemId, async (client) => {
      await upsertEventRemoteState(client, {
        eventItemId: context.eventItemId,
        calendarItemId: endpoint.calendarItemId,
        remoteId: ref.remoteId,
        href: ref.href ?? remote.href,
        etag: ref.etag,
        baseSnapshot: snapshotOf({ ...remote, fields: merge.fields }),
      });
      return "sent";
    });
  }
  return { kind: "merged", overwritten: merge.overwritten };
}

/**
 * Writes the merge onto the Event as the calendar sync, which records no push. Only fields whose merged value
 * differs from the local one are written; a provider rule replacing a local `recurrence` clears it.
 */
async function applyLocally(
  client: PoolClient,
  context: PushContext,
  local: RemoteEventFields,
  merged: RemoteEventFields,
): Promise<void> {
  const patch: Record<string, unknown> = {};
  for (const key of changedEventFields(local, merged)) {
    if (key === EVENT_RECURRENCE_ID_PROPERTY_KEY && local.recurrenceId === null) continue;
    patch[key] = merged[key];
  }
  if (Object.hasOwn(patch, EVENT_RECURRENCE_RULE_PROPERTY_KEY)) {
    const item = await getItemById(client, context.ids.eventsDatabaseId, context.eventItemId);
    const recurrence = item?.properties[EVENT_RECURRENCE_PROPERTY_KEY];
    if (recurrence !== undefined && recurrence !== null) patch[EVENT_RECURRENCE_PROPERTY_KEY] = null;
  }
  if (Object.hasOwn(patch, EVENT_TIME_ZONE_PROPERTY_KEY) && patch[EVENT_TIME_ZONE_PROPERTY_KEY] === null) {
    // The local side was sent in the tenant's zone only because it had none; null keeps it so.
    delete patch[EVENT_TIME_ZONE_PROPERTY_KEY];
  }
  if (Object.keys(patch).length === 0) return;
  await updateItemWithClient(
    client,
    { databaseId: context.ids.eventsDatabaseId, itemId: context.eventItemId, propertiesPatch: patch },
    {
      writer: CALENDAR_SYNC_WRITER,
      allowedSystemKeys: SYNC_EVENT_SYSTEM_KEYS,
      queueAffinity: createActionQueueAffinity(),
    },
  );
}

async function notifyOverwritten(
  client: PoolClient,
  context: PushContext,
  endpoint: Endpoint,
  eventName: string | null,
  transitionInstance: string,
): Promise<void> {
  const userId = await getTenantUserId(client);
  if (userId === null) {
    logger.warn({ eventItemId: context.eventItemId, reason: "no_tenant_user" }, "overwritten change not notified");
    return;
  }
  const calendar = await getItemById(client, context.ids.calendarsDatabaseId, endpoint.calendarItemId);
  const account = await getItemById(client, context.ids.mailboxesDatabaseId, endpoint.account.accountItemId);
  const calendarName =
    textOf(calendar?.properties.name) ??
    textOf(calendar?.properties.remoteName) ??
    textOf(account?.properties.name) ??
    "";
  await writeNotification(client, {
    userId,
    kind: "calendar_change_overwritten",
    titleParams: { calendar: calendarName },
    bodyKey: "calendarChange.overwritten",
    bodyParams: { event: eventName === null ? null : Array.from(eventName).slice(0, 120).join("") },
    linkHref: `?page=event&id=${context.eventItemId}`,
    sourceTable: "items",
    sourceId: context.eventItemId,
    transitionInstance,
    payload: { eventId: context.eventItemId, calendarId: endpoint.calendarItemId },
  });
}

/**
 * Adds the cancelled occurrence to its series' exception dates at the provider, and here as the calendar sync, so
 * the next push of the series keeps it.
 */
async function cancelOccurrence(
  context: PushContext,
  endpoint: Endpoint,
  series: Series,
  fields: RemoteEventFields,
): Promise<CalendarEventPushResult> {
  const adapter = await adapterFor(context, endpoint);
  let ref: RemoteEventRef;
  try {
    ref = await adapter.putEvent(endpoint.remote, { ref: refOf(series.stored), fields }, context.signal);
  } catch (error) {
    if (!(error instanceof CalendarSyncEventConflictError)) throw error;
    await storeResult(context, endpoint.account.accountItemId, async () => "conflict");
    return { kind: "conflict" };
  }
  await storeResult(context, endpoint.account.accountItemId, async (client) => {
    await lockItemById(client, context.ids.eventsDatabaseId, series.eventItemId);
    await updateItemWithClient(
      client,
      {
        databaseId: context.ids.eventsDatabaseId,
        itemId: series.eventItemId,
        propertiesPatch: { [EVENT_EXCEPTION_DATES_PROPERTY_KEY]: fields.exceptionDates },
      },
      {
        writer: CALENDAR_SYNC_WRITER,
        allowedSystemKeys: SYNC_EVENT_SYSTEM_KEYS,
        queueAffinity: createActionQueueAffinity(),
      },
    );
    await upsertEventRemoteState(client, {
      eventItemId: series.eventItemId,
      calendarItemId: endpoint.calendarItemId,
      remoteId: ref.remoteId,
      href: ref.href ?? series.stored.href,
      etag: ref.etag,
      baseSnapshot: snapshotOf({ fields, seriesRemoteId: null, ...participantsOf(series.stored.baseSnapshot) }),
    });
    return "sent";
  });
  return { kind: "sent", operation: "delete" };
}

/**
 * The provider's own move where the adapter has one (Google), then the Event's changes; otherwise a delete in the old
 * calendar and a create in the new one, each stored as it succeeds so a retry carries on from there.
 */
async function moveRemote(
  context: PushContext,
  plan: Extract<Plan, { kind: "move" }>,
): Promise<CalendarEventPushResult> {
  const { from, to, stored, fields } = plan;
  const sameAccount = from.account.accountItemId === to.account.accountItemId;
  const adapter = await adapterFor(context, from);
  if (sameAccount && adapter.moveEvent) {
    const moved = await adapter.moveEvent(from.remote, to.remote, refOf(stored), context.signal);
    const movedStored: StoredRemoteEvent = { ...stored, remoteId: moved.remoteId, href: moved.href, etag: moved.etag };
    await storeResult(context, from.account.accountItemId, async (client) => {
      await upsertEventRemoteState(client, {
        eventItemId: context.eventItemId,
        calendarItemId: to.calendarItemId,
        remoteId: moved.remoteId,
        href: moved.href,
        etag: moved.etag,
        baseSnapshot: stored.baseSnapshot,
      });
      return null;
    });
    return updateRemote(context, to, movedStored, fields, "move");
  }
  const deleted = await deleteRemote(context, from, stored, "move", false);
  if (deleted.kind !== "sent") return deleted;
  return createRemote(context, to, fields, plan.icalUid, null, "move");
}
