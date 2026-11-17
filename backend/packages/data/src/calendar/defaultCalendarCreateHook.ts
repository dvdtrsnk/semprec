// Links a new Event to a calendar: the create hook, the scope through which a caller names another calendar, and
// a helper creating an Event inside that scope. The hook runs in the create's transaction after a real insert, not
// on an idempotency-key replay, so the edge commits or rolls back with the Event.
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

const EVENT_CALENDAR_PROPERTY_KEY = "calendar";

const chosenCalendarScope = new AsyncLocalStorage<string>();

/** The id is checked when the hook writes the edge, not here. An inner call overrides the outer one. */
export function withChosenCalendar<T>(calendarId: string, fn: () => T): T {
  return chosenCalendarScope.run(calendarId, fn);
}

/**
 * A refused calendar fails with `validation_failed` on `calendarId`. The default calendar is not read, so a tenant
 * without one does not fail this. An idempotency-key replay returns the stored Event without checking
 * `calendarId`; so does a tenant without a calendars database.
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
 * Locked `FOR SHARE`. Non-UUID, unknown, other tenant's (hidden by RLS), trashed, and system or subscription
 * calendars all get the same `validation_failed`.
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
 * Should several be marked, the lowest id wins. The statement runs a second time when the first returns nothing:
 * a statement that waited on a concurrent change rechecks only the row it read, so it returns nothing when the
 * mark moved; the second statement reads the committed rows.
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
 * - An Event already having a calendar edge keeps it.
 * - A create naming `calendar` in its initial relations gets no edge here; that create writes it after the hooks.
 * - Otherwise the edge goes to the chosen calendar, or to the default calendar.
 *
 * Only the last case reads the default; a missing default then fails the create after logging
 * `default_calendar_missing`. A missing calendars database or Events `calendar` relation fails every create (the
 * seed creates both). The edge is written as a system write.
 */
export const defaultCalendarCreateHook: ItemCreateHook = async ({ client, database, item, initialRelations }) => {
  if (!database.system || database.ownerModuleId !== EVENTS_MODULE_ID) return;
  const calendars = await databasesStore.getDatabaseByModuleId(client, CALENDARS_MODULE_ID);
  if (!calendars) throw new Error("Calendars database not found");

  const property = await propertiesStore.getPropertyByKey(client, database.id, EVENT_CALENDAR_PROPERTY_KEY);
  const definition = property ? await relationsStore.getRelationDefinitionByPropertyId(client, property.id) : null;
  if (!property || !definition) throw new Error("Events 'calendar' relation not found");
  const edges = await relationsStore.listRelationsForItem(client, definition.id, item.id);
  if (edges.length > 0) return;
  if (initialRelations?.some((relation) => relation.relationPropertyId === property.id)) return;

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
