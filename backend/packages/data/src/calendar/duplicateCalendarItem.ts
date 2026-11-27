// Duplicates an Event or Task to a new date and time: the copy is created through the choke point with a
// whitelist of properties and relation edges, in the caller's transaction, so copy and edges commit together.
import { isDeepStrictEqual } from "node:util";
import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { z } from "zod";
import * as databasesStore from "../chokePoint/databasesStore.js";
import {
  createItemReportingReplay,
  updateItemWithClient,
  type CreateItemWithClientOptions,
} from "../chokePoint/itemWrites.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { EVENTS_MODULE_ID, TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { createTaskRecurrence, getTaskRecurrenceBySeriesId } from "../tasks/taskRecurrenceStore.js";
import { templateOf } from "../tasks/taskRecurrenceOwner.js";
import type { DatabaseRow, ItemRow } from "../types.js";
import { withChosenCalendar } from "./defaultCalendarCreateHook.js";
import { isCalendarDate } from "./eventValidationHook.js";
import { EVENT_PEOPLE_PROPERTY_KEY } from "./eventParticipantEdgeHook.js";

const EVENT_PROJECT_RELATION_KEY = "project";

/** Date and times come from the request. */
export const EVENT_PROPERTY_KEYS = [
  "name",
  "type",
  "place",
  "url",
  "description",
  "alertMinutes",
  "travelMinutes",
] as const;

/** Besides the calendar edge, which the create gives the copy. A key the database lacks is skipped. */
const EVENT_RELATION_KEYS = [EVENT_PROJECT_RELATION_KEY, EVENT_PEOPLE_PROPERTY_KEY, "files"] as const;

const EVENT_COMPANY_RELATION_KEY = "company";

export const EVENT_CALENDAR_RELATION_KEY = "calendar";

/** `status` is `notDone`; times as in `taskTimes`. */
const TASK_PROPERTY_KEYS = ["name", "flagged", "description", "notifications"] as const;

/** A key the database lacks is skipped. */
const TASK_RELATION_KEYS = ["project", "people", "files"] as const;

const SERIES_PROPERTY_KEYS = ["seriesId", "occurrenceDate", "recurrence"] as const;

/** As `tasks/taskRecurrenceOwner.ts` writes it. */
const storedRecurrenceSchema = z.object({ preset: z.string().nullable(), mode: z.string(), rule: z.unknown() });

export interface DuplicateCalendarItemInput {
  itemId: string;
  date: string;
  timeFrom?: string;
  timeTo?: string;
  /** Without it the source's `endDate` moves by as many days as `date` does. */
  endDate?: string;
  idempotencyKey?: string;
  /** The copy and its edges are written as that user. */
  actor: { userId: string };
}

type CalendarItemKind = "event" | "task";

interface CalendarItemSource {
  kind: CalendarItemKind;
  database: DatabaseRow;
  item: ItemRow;
}

/**
 * Locked until the caller's transaction ends. Unknown, trashed, other tenant's (RLS) and other-database items are
 * not found alike.
 */
async function lockSource(client: PoolClient, itemId: string): Promise<CalendarItemSource> {
  const kinds: [CalendarItemKind, string][] = [
    ["event", EVENTS_MODULE_ID],
    ["task", TASKS_MODULE_ID],
  ];
  for (const [kind, moduleId] of kinds) {
    const database = await databasesStore.getDatabaseByModuleId(client, moduleId);
    if (!database) continue;
    const item = await itemsStore.lockItemById(client, database.id, itemId);
    if (item && item.deletedAt === null) return { kind, database, item };
  }
  throw new NotFoundError(`Calendar item ${itemId} not found`);
}

interface SourceEdge {
  counterpartId: string;
  metadata: Record<string, unknown>;
}

/** `null` when the database has no such relation property. Edges to trashed, archived or gone items are left out. */
export async function liveEdgesOf(
  client: PoolClient,
  databaseId: string,
  itemId: string,
  key: string,
): Promise<{ propertyId: string; edges: SourceEdge[] } | null> {
  const property = await propertiesStore.getPropertyByKey(client, databaseId, key);
  if (!property || property.type !== "relation") return null;
  const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property.id);
  if (!definition) return null;
  const stored = await relationsStore.listRelationsForItem(client, definition.id, itemId);
  const live = new Set(
    (
      await relationsStore.listLiveRelationTargets(
        client,
        stored.map((edge) => relationsStore.otherSide(edge, itemId)),
      )
    ).map((target) => target.id),
  );
  const edges = stored
    .map((edge) => ({ counterpartId: relationsStore.otherSide(edge, itemId), metadata: edge.metadata }))
    .filter((edge) => live.has(edge.counterpartId));
  return { propertyId: property.id, edges };
}

/** The copy's participants are linked, not invited. */
function withoutInvitation(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== "invitation"));
}

/** A missing or `null` value is left out. */
export function copiedProperties(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    keys.flatMap((key) => (source[key] === undefined || source[key] === null ? [] : [[key, source[key]]])),
  );
}

/** A source without a readable `date` and `endDate` gives the copy none. */
export function copiedEndDate(
  source: Record<string, unknown>,
  copyDate: string,
  requestedEndDate: string | undefined,
): string | undefined {
  if (requestedEndDate !== undefined) return requestedEndDate;
  const { date, endDate } = source;
  if (!isCalendarDate(date) || !isCalendarDate(endDate) || !isCalendarDate(copyDate)) return undefined;
  const days = DateTime.fromISO(copyDate, { zone: "utc" }).diff(DateTime.fromISO(date, { zone: "utc" }), "days").days;
  return DateTime.fromISO(endDate, { zone: "utc" }).plus({ days }).toFormat("yyyy-MM-dd");
}

/** An Event copy takes its times from the request alone, so a copy of an all-day Event stays all-day. */
function taskTimes(source: Record<string, unknown>, input: DuplicateCalendarItemInput): Record<string, unknown> {
  if (input.timeFrom !== undefined || input.timeTo !== undefined) {
    return {
      ...(input.timeFrom === undefined ? {} : { timeFrom: input.timeFrom }),
      ...(input.timeTo === undefined ? {} : { timeTo: input.timeTo }),
    };
  }
  return copiedProperties(source, ["timeFrom", "timeTo"]);
}

async function copyEdges(
  client: PoolClient,
  write: {
    databaseId: string;
    fromItemId: string;
    toItemId: string;
    writer: WriterIdentity;
    userId: string | undefined;
  },
  keys: readonly string[],
  metadataOf: (key: string, metadata: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  for (const key of keys) {
    const found = await liveEdgesOf(client, write.databaseId, write.fromItemId, key);
    if (!found) continue;
    for (const edge of found.edges) {
      await createRelationWithClient(
        client,
        {
          relationPropertyId: found.propertyId,
          callerItemId: write.toItemId,
          targetItemId: edge.counterpartId,
          metadata: metadataOf(key, edge.metadata),
        },
        undefined,
        write.writer,
        write.userId,
      );
    }
  }
}

/**
 * `company` only when the source has no project edge; participant `invitation`s are dropped; the calendar edge
 * comes from the create.
 */
export async function copyEventEdges(
  client: PoolClient,
  write: {
    databaseId: string;
    fromItemId: string;
    toItemId: string;
    writer: WriterIdentity;
    userId: string | undefined;
  },
): Promise<void> {
  const project = await liveEdgesOf(client, write.databaseId, write.fromItemId, EVENT_PROJECT_RELATION_KEY);
  const keys =
    project && project.edges.length > 0 ? EVENT_RELATION_KEYS : [...EVENT_RELATION_KEYS, EVENT_COMPANY_RELATION_KEY];
  await copyEdges(client, write, keys, (key, metadata) =>
    key === EVENT_PEOPLE_PROPERTY_KEY ? withoutInvitation(metadata) : metadata,
  );
}

/**
 * Same mode and rule as the source's active series, anchored on the copy's date. The series row is locked after
 * the source's item row, the order of `tasks/advanceTaskRecurrenceWithClient.ts`.
 */
async function startCopySeries(
  client: PoolClient,
  write: { databaseId: string; source: ItemRow; copy: ItemRow; date: string; writer: WriterIdentity; userId: string },
): Promise<void> {
  const seriesId = write.source.properties.seriesId;
  if (typeof seriesId !== "string") return;
  const series = await getTaskRecurrenceBySeriesId(client, seriesId, true);
  if (!series || !series.active) return;
  const created = await createTaskRecurrence(client, {
    itemId: write.copy.id,
    mode: series.mode,
    rule: series.rule,
    anchorDate: write.date,
    template: templateOf(write.copy.properties),
  });
  if (created.seriesId === null) throw new Error("createTaskRecurrence returned no series");
  // The stored preset label is kept when it still stands for the series' rule.
  const stored = storedRecurrenceSchema.safeParse(write.source.properties.recurrence);
  const recurrence =
    stored.success && stored.data.mode === series.mode && isDeepStrictEqual(stored.data.rule, series.rule)
      ? stored.data
      : { preset: null, mode: series.mode, rule: series.rule };
  await updateItemWithClient(
    client,
    {
      databaseId: write.databaseId,
      itemId: write.copy.id,
      propertiesPatch: { seriesId: created.seriesId, occurrenceDate: write.date, recurrence },
    },
    {
      allowedSystemKeys: SERIES_PROPERTY_KEYS,
      systemOwnerProcess: TASKS_MODULE_ID,
      writer: write.writer,
      actingUserId: write.userId,
      humanWriterUserId: write.userId,
    },
  );
}

/**
 * Run inside the caller's transaction: a later failure leaves no copy once it rolls back.
 *
 * - When `idempotencyKey` already created a live item in the source's database, that item is returned and nothing
 *   is copied. The read runs under the source's lock, so a request waiting on an earlier one with the same key and
 *   source finds its copy; a key another source's request commits first is met at the insert instead.
 * - An Event copy is created in the source's calendar via `withChosenCalendar` (the default calendar when the
 *   source has none), so `calendar` is not copied as an edge.
 * - A Task has no `endDate`: one in the request is refused. A Task with an active series starts a new series.
 * - Not copied: transcripts, action items, hosted tasks, host events, completion, series, iCalendar identity,
 *   `createdAt`, page or derived values.
 *
 * The create validates date and times with the database's rules; an invalid value rolls the transaction back.
 */
export async function duplicateCalendarItem(client: PoolClient, input: DuplicateCalendarItemInput): Promise<ItemRow> {
  const { kind, database, item: source } = await lockSource(client, input.itemId);
  if (input.idempotencyKey !== undefined) {
    const replay = await itemsStore.findIdempotentReplay(client, database.id, input.idempotencyKey, {
      requireLive: true,
    });
    if (replay) return replay;
  }
  if (kind === "task" && input.endDate !== undefined) {
    throw new ValidationError("A Task has no 'endDate'", { field: "endDate" });
  }

  const writer: WriterIdentity = { writerKind: "user" };
  const { userId } = input.actor;
  const options: CreateItemWithClientOptions = { writer, actingUserId: userId, humanWriterUserId: userId };
  const endDate = kind === "event" ? copiedEndDate(source.properties, input.date, input.endDate) : undefined;
  const properties: Record<string, unknown> =
    kind === "event"
      ? {
          ...copiedProperties(source.properties, EVENT_PROPERTY_KEYS),
          date: input.date,
          ...(input.timeFrom === undefined ? {} : { timeFrom: input.timeFrom }),
          ...(input.timeTo === undefined ? {} : { timeTo: input.timeTo }),
          ...(endDate === undefined ? {} : { endDate }),
        }
      : {
          ...copiedProperties(source.properties, TASK_PROPERTY_KEYS),
          ...taskTimes(source.properties, input),
          status: "notDone",
          date: input.date,
        };

  const create = () =>
    createItemReportingReplay(
      client,
      { databaseId: database.id, properties, idempotencyKey: input.idempotencyKey },
      options,
    );
  const calendar =
    kind === "event"
      ? (await liveEdgesOf(client, database.id, source.id, EVENT_CALENDAR_RELATION_KEY))?.edges[0]
      : undefined;
  const { item: copy, created } = await (calendar ? withChosenCalendar(calendar.counterpartId, create) : create());
  if (!created) return copy;

  const write = { databaseId: database.id, fromItemId: source.id, toItemId: copy.id, writer, userId };
  if (kind === "event") {
    await copyEventEdges(client, write);
  } else {
    await copyEdges(client, write, TASK_RELATION_KEYS, (_key, metadata) => metadata);
    await startCopySeries(client, { databaseId: database.id, source, copy, date: input.date, writer, userId });
  }
  const stored = await itemsStore.getItemById(client, database.id, copy.id);
  if (!stored) throw new Error(`Item ${copy.id} disappeared during its duplication`);
  return stored;
}
