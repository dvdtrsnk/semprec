// Duplicates an Event or a Task to a new date and time (issue gh-1796): the copy is created through the choke
// point with a whitelist of properties, and a whitelist of the source's relation edges is copied onto it, all
// inside the caller's transaction, so the copy and its edges commit or roll back together.
// Constrained by: docs/adr/2026-09-10-choke-point-api-for-state-writes.md,
// docs/adr/2026-11-11-new-events-get-their-calendar-in-a-create-hook.md,
// docs/adr/2026-10-25-task-and-event-recurrence-model.md
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

/** The Events relation whose edge decides whether the copy takes the source's `company` edges. */
const EVENT_PROJECT_RELATION_KEY = "project";

/** The Events properties a copy takes from its source. Its date and times come from the request. */
const EVENT_PROPERTY_KEYS = ["name", "type", "place", "url", "description", "alertMinutes", "travelMinutes"] as const;

/**
 * The Events relations whose edges a copy takes, besides the calendar edge, which the create gives it. A key
 * whose relation property the Events database does not have is skipped.
 */
const EVENT_RELATION_KEYS = [EVENT_PROJECT_RELATION_KEY, EVENT_PEOPLE_PROPERTY_KEY, "area", "files"] as const;

/** The Events relation a copy takes only from a source that has no project edge. */
const EVENT_COMPANY_RELATION_KEY = "company";

/** The Events relation whose single edge is the calendar the Event belongs to. */
const EVENT_CALENDAR_RELATION_KEY = "calendar";

/** The Tasks properties a copy takes from its source. Its `status` is `notDone`, its date and times are described at `taskTimes`. */
const TASK_PROPERTY_KEYS = ["name", "flagged", "description", "notifications"] as const;

/** The Tasks relations whose edges a copy takes. A key whose relation property the Tasks database does not have is skipped. */
const TASK_RELATION_KEYS = ["project", "people", "files"] as const;

/** The `owner: 'system'` Tasks properties the copy of a recurring Task is given as the Tasks module. */
const SERIES_PROPERTY_KEYS = ["seriesId", "occurrenceDate", "recurrence"] as const;

/** The stored shape of a Task's `recurrence` property, as `tasks/taskRecurrenceOwner.ts` writes it. */
const storedRecurrenceSchema = z.object({ preset: z.string().nullable(), mode: z.string(), rule: z.unknown() });

export interface DuplicateCalendarItemInput {
  /** The Event or Task to copy. */
  itemId: string;
  /** The copy's date. */
  date: string;
  timeFrom?: string;
  timeTo?: string;
  /** An Event's last day. Without it the source's `endDate` is moved by as many days as `date` is from the source's `date`. */
  endDate?: string;
  idempotencyKey?: string;
  /** The user whose request this is: the copy and its edges are written as that user. */
  actor: { userId: string };
}

type CalendarItemKind = "event" | "task";

interface CalendarItemSource {
  kind: CalendarItemKind;
  database: DatabaseRow;
  item: ItemRow;
}

/**
 * The live Event or Task `itemId`, with its row locked until the caller's transaction ends. An unknown id, a trashed
 * item, another tenant's item (row-level security hides it) and an item of any other database are not found alike.
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

/**
 * The live edges `itemId` holds on its relation property `key`, or `null` when the database has no relation
 * property of that key. An edge whose other end is in the trash, in an archived database or gone is left out.
 */
async function liveEdgesOf(
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

/** `metadata` without its `invitation`: the copy's participants are linked, not invited. */
function withoutInvitation(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== "invitation"));
}

/** The properties of `source` named by `keys` that hold a value; a missing or `null` one is left out of the copy. */
function copiedProperties(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    keys.flatMap((key) => (source[key] === undefined || source[key] === null ? [] : [[key, source[key]]])),
  );
}

/**
 * The `endDate` of an Event copy: the request's, or else the source's moved by as many days as `date` moves. A source
 * without a readable `date` and `endDate` gives the copy none.
 */
function copiedEndDate(source: Record<string, unknown>, input: DuplicateCalendarItemInput): string | undefined {
  if (input.endDate !== undefined) return input.endDate;
  const { date, endDate } = source;
  if (!isCalendarDate(date) || !isCalendarDate(endDate) || !isCalendarDate(input.date)) return undefined;
  const days = DateTime.fromISO(input.date, { zone: "utc" }).diff(DateTime.fromISO(date, { zone: "utc" }), "days").days;
  return DateTime.fromISO(endDate, { zone: "utc" }).plus({ days }).toFormat("yyyy-MM-dd");
}

/**
 * The times of a Task copy: those of the request when it names a `timeFrom` or a `timeTo`, otherwise the source's. An
 * Event copy takes its times from the request alone, so a copy of an all-day Event stays all-day.
 */
function taskTimes(source: Record<string, unknown>, input: DuplicateCalendarItemInput): Record<string, unknown> {
  if (input.timeFrom !== undefined || input.timeTo !== undefined) {
    return {
      ...(input.timeFrom === undefined ? {} : { timeFrom: input.timeFrom }),
      ...(input.timeTo === undefined ? {} : { timeTo: input.timeTo }),
    };
  }
  return copiedProperties(source, ["timeFrom", "timeTo"]);
}

/**
 * Writes onto `toItemId` a copy of the live edges `fromItemId` holds on each of `keys`, as the writer of the copy.
 * `metadataOf` gives the metadata a copied edge carries.
 */
async function copyEdges(
  client: PoolClient,
  write: { databaseId: string; fromItemId: string; toItemId: string; writer: WriterIdentity; userId: string },
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
 * Gives the copy of a recurring Task its own series: the same mode and rule as the source's active series, anchored on
 * the copy's date, with the copy as its current occurrence. A source without an active series gives the copy none.
 * The source's series row is locked after the source's item row, the order of `tasks/advanceTaskRecurrenceWithClient.ts`.
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
  // The source's stored `recurrence` keeps its preset label when it still stands for the series' rule.
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
 * Copies the Event or Task `input.itemId` to `input.date` and returns the copy. Run it inside the caller's
 * transaction: a failure after the copy was created leaves no copy once that transaction rolls back.
 *
 * - The source is locked first; an unknown, trashed, another tenant's or neither Event nor Task id is a
 *   `NotFoundError`. When `input.idempotencyKey` already created a live item in the source's database, that item is
 *   returned as it is stored and nothing is copied. The read runs under the source's lock, so a request that waited
 *   for an earlier request with the same key and the same source finds that request's copy. A key that another
 *   source's request commits first is met at the insert instead: the insert returns that request's item, and nothing
 *   of this source is copied onto it.
 * - An Event copy takes `EVENT_PROPERTY_KEYS` from the source, its `date`, `timeFrom` and `timeTo` from the request,
 *   and the source's `endDate` moved with `date` (see `copiedEndDate`). It is created in the source's calendar through
 *   the default-calendar create hook's own scope (`withChosenCalendar`), so it ends with that one calendar edge and
 *   `calendar` is not copied as an edge; a source without a calendar edge gives the copy the default calendar. The
 *   edges of `EVENT_RELATION_KEYS` are copied, and `company` only from a source without a project; the `invitation` of
 *   a participant edge is dropped.
 * - A Task copy takes `TASK_PROPERTY_KEYS` and its times (see `taskTimes`), has `status` `notDone` and the request's
 *   `date`, and takes the edges of `TASK_RELATION_KEYS`. A Task has no `endDate`: one in the request is refused. The
 *   copy of a Task with an active series starts a new series of its own (`startCopySeries`).
 * - Nothing else of the source is copied: not its transcripts, action items, hosted tasks or host events, nor its
 *   completion, series, iCalendar identity, `createdAt`, page or derived values.
 *
 * The copy and every edge are written through the choke point as `input.actor`. The create validates the
 * copy's date and times with the rules of its database, so an invalid value is a `ValidationError` that
 * rolls the transaction back.
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
  const endDate = kind === "event" ? copiedEndDate(source.properties, input) : undefined;
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
    const project = await liveEdgesOf(client, database.id, source.id, EVENT_PROJECT_RELATION_KEY);
    const keys =
      project && project.edges.length > 0 ? EVENT_RELATION_KEYS : [...EVENT_RELATION_KEYS, EVENT_COMPANY_RELATION_KEY];
    await copyEdges(client, write, keys, (key, metadata) =>
      key === EVENT_PEOPLE_PROPERTY_KEY ? withoutInvitation(metadata) : metadata,
    );
  } else {
    await copyEdges(client, write, TASK_RELATION_KEYS, (_key, metadata) => metadata);
    await startCopySeries(client, { databaseId: database.id, source, copy, date: input.date, writer, userId });
  }
  const stored = await itemsStore.getItemById(client, database.id, copy.id);
  if (!stored) throw new Error(`Item ${copy.id} disappeared during its duplication`);
  return stored;
}
