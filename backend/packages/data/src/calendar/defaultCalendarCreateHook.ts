// Gives a new Event its calendar (issue #1761): the choke point's item-create hook that links a new Event
// to the tenant's default calendar, the scope through which a caller names another calendar, and the
// helper that creates an Event inside that scope. The hook runs inside the create's transaction after a
// real insert and not on an idempotency-key replay, so the calendar edge commits or rolls back with the Event.
// Constrained by: docs/adr/2026-11-11-new-events-get-their-calendar-in-a-create-hook.md,
// docs/adr/2026-10-09-item-create-domain-hooks.md
import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "pg";
import { z } from "zod";
import * as databasesStore from "../chokePoint/databasesStore.js";
import type { ItemCreateHook } from "../chokePoint/hooks.js";
import {
  createItemWithClient,
  type CreateItemInput,
  type CreateItemWithClientOptions,
} from "../chokePoint/itemWrites.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { ItemRow } from "../types.js";
import { logger } from "./logger.js";

/** The Events side of the `Calendars.events` relation: the one calendar an Event belongs to. */
const EVENT_CALENDAR_PROPERTY_KEY = "calendar";

/** The calendar id a caller chose for the Events that are inserted inside `withChosenCalendar`. */
const chosenCalendarScope = new AsyncLocalStorage<string>();

/**
 * Runs `fn` with `calendarId` as the calendar the hook links, in place of the default calendar, to each
 * Event that is inserted inside it. The id is checked when the hook writes the edge, not here. An inner
 * call replaces the outer one's calendar for its own `fn`.
 */
export function withChosenCalendar<T>(calendarId: string, fn: () => T): T {
  return chosenCalendarScope.run(calendarId, fn);
}

/**
 * Creates an Event in the calendar `calendarId` inside the caller's transaction: `createItemWithClient` for
 * the tenant's Events database, run inside `withChosenCalendar`. A calendar the hook refuses fails the
 * create with `validation_failed` on `calendarId`. The default calendar is not read, so a tenant without a
 * live default calendar does not fail this create. An idempotency-key replay returns the Event stored
 * earlier with the calendar it has: the hook does not run and `calendarId` is not checked. In a tenant
 * without a calendars database the Event is created without a calendar and `calendarId` is not checked
 * either. Throws `NotFoundError` in a tenant without an Events database.
 */
export async function createEventInCalendar(
  client: PoolClient,
  input: Omit<CreateItemInput, "databaseId">,
  calendarId: string,
  options: CreateItemWithClientOptions = {},
): Promise<ItemRow> {
  const events = await databasesStore.getDatabaseByModuleId(client, EVENTS_MODULE_ID);
  if (!events) throw new NotFoundError(`Database for module '${EVENTS_MODULE_ID}' not found`);
  return withChosenCalendar(calendarId, () =>
    createItemWithClient(client, { ...input, databaseId: events.id }, options),
  );
}

const calendarIdSchema = z.uuid();

/**
 * The id of the chosen calendar when it is a live item of the tenant's calendars database whose `kind` is
 * empty or `own`, with its row locked `FOR SHARE` until the caller's transaction ends. Anything else is
 * refused with the same `validation_failed` on `calendarId`: an id that is not a UUID, an unknown id,
 * another tenant's calendar (row-level security hides it), a calendar in the trash, and a system or
 * subscription calendar.
 */
async function lockChosenCalendar(
  client: PoolClient,
  calendarsDatabaseId: string,
  calendarId: string,
): Promise<string> {
  const { rows } = calendarIdSchema.safeParse(calendarId).success
    ? await client.query<{ id: string; kind: string | null }>(
        `SELECT id, properties->>'kind' AS kind FROM items
          WHERE database_id = $1 AND id = $2 AND deleted_at IS NULL
          FOR SHARE`,
        [calendarsDatabaseId, calendarId],
      )
    : { rows: [] };
  const calendar = rows[0];
  if (!calendar || !(calendar.kind === null || calendar.kind === "" || calendar.kind === "own")) {
    throw new ValidationError("The chosen calendar must be one of the tenant's own live calendars", {
      field: "calendarId",
    });
  }
  return calendar.id;
}

/**
 * The id of the live calendar marked `isDefault`, with the row of every live calendar so marked locked
 * `FOR SHARE` until the caller's transaction ends, or `null` when there is none. Should several be marked,
 * the one with the lowest id is taken, the choice `calendarsCutoverMigration.ts` makes for the Events it
 * links.
 *
 * The statement runs a second time when the first returns nothing. A statement that waited for a
 * concurrent change of the calendar it read as the default checks that row again and no other, so it
 * returns nothing when the mark moved to another calendar in that change; the second statement reads the
 * committed rows.
 */
async function lockDefaultCalendar(client: PoolClient, calendarsDatabaseId: string): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM items
        WHERE database_id = $1 AND deleted_at IS NULL AND properties->'isDefault' = 'true'::jsonb
        ORDER BY id
        FOR SHARE`,
      [calendarsDatabaseId],
    );
    if (rows[0]) return rows[0].id;
  }
  return null;
}

/**
 * The choke point's item-create hook for the Events database (registered by `../domainWriteHooks.ts`):
 * links the new Event to one calendar through its `calendar` relation.
 *
 * - A tenant without a calendars database (its calendars cutover has not run yet) gets no edge, and a
 *   chosen calendar is not checked.
 * - An Event that already has a calendar edge when the hook runs keeps it and gets no other, and a chosen
 *   calendar is not checked.
 * - Otherwise the edge goes to the calendar chosen with `withChosenCalendar`, as `lockChosenCalendar`
 *   accepts it, or without a choice to the default calendar of `lockDefaultCalendar`.
 *
 * The default calendar is read only in the third case, when no calendar was chosen. There, a calendars
 * database without a live default calendar fails the create with a plain error, which a transport answers
 * as a server error, after the error log line `default_calendar_missing` that carries the two ids. A
 * create with a chosen calendar is judged by that calendar alone, and one whose Event already has a
 * calendar edge writes nothing: neither reads the default, so a missing default fails neither. A calendars
 * database whose Events `calendar` relation is missing fails the create with a plain error in every case,
 * with a chosen calendar or without. The edge is written through `createRelationWithClient` without a
 * writer, so as a system write, with that write's guards and hooks.
 */
export const defaultCalendarCreateHook: ItemCreateHook = async ({ client, database, item }) => {
  if (!database.system || database.ownerModuleId !== EVENTS_MODULE_ID) return;
  const calendars = await databasesStore.getDatabaseByModuleId(client, CALENDARS_MODULE_ID);
  if (!calendars) return;

  const property = await propertiesStore.getPropertyByKey(client, database.id, EVENT_CALENDAR_PROPERTY_KEY);
  const definition = property ? await relationsStore.getRelationDefinitionByPropertyId(client, property.id) : null;
  if (!property || !definition) throw new Error("Events 'calendar' relation not found");
  const edges = await relationsStore.listRelationsForItem(client, definition.id, item.id);
  if (edges.length > 0) return;

  const chosen = chosenCalendarScope.getStore();
  let calendarId: string;
  if (chosen !== undefined) {
    calendarId = await lockChosenCalendar(client, calendars.id, chosen);
  } else {
    const defaultCalendarId = await lockDefaultCalendar(client, calendars.id);
    if (defaultCalendarId === null) {
      logger.error({ calendarsDatabaseId: calendars.id, eventId: item.id }, "default_calendar_missing");
      throw new Error("The tenant has no live default calendar");
    }
    calendarId = defaultCalendarId;
  }
  await createRelationWithClient(client, {
    relationPropertyId: property.id,
    callerItemId: item.id,
    targetItemId: calendarId,
  });
};
