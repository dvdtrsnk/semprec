import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { createItemWithClient, createRelationWithClient } from "../chokePoint/chokePoint.js";
import type { ActionQueueAffinity } from "../scheduler/actions.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { getOrCreateJournalItem } from "../journal/journalStore.js";
import { assertValidTimezone } from "../timezone.js";
import { ValidationError, NotFoundError } from "../errors.js";
import type { ItemRow } from "../types.js";

export interface CreateInboxItemInput {
  inboxDatabaseId: string;
  journalDatabaseId: string;
  timezone: string;
  /** ISO date, e.g. '2026-08-28' — client-supplied, never derived as "today" on the server. */
  date: string;
  /** ISO time, e.g. '14:30' — client-supplied, same reason as `date`. */
  time: string;
  text?: string;
  /** An Inbox item type's id, or omitted — an untyped item is valid (issue #100's `needsClarification`). */
  type?: string;
  idempotencyKey?: string;
  /** Queue affinity to route the `semprec.tick` onItemEvent heartbeat-fire job to (issue #103). */
  queueAffinity?: ActionQueueAffinity;
}

async function getRelationProperty(client: PoolClient, databaseId: string, key: string) {
  const property = await propertiesStore.getPropertyByKey(client, databaseId, key);
  if (!property) throw new NotFoundError(`Inbox database ${databaseId} has no '${key}' relation property`);
  return property;
}

/**
 * The Inbox item creation logic (issue #101): the one sanctioned wrapper over
 * `createItemWithClient`, mirroring `journal/journalStore.ts`'s `getOrCreateJournalItem` as
 * "this function is the declared owning process for a narrow set of concerns." Two things the
 * generic choke-point cannot express on its own:
 *
 * - `date`/`time` are mandatory — the schema engine has no generic required-field concept
 *   (see chokePoint.ts's `assertWritableProperties`), so this throws `ValidationError` before
 *   ever reaching the write path rather than silently accepting a partial capture. Both values
 *   are passed through verbatim, never replaced with the server's current date/time — delayed,
 *   offline-captured batches must keep the moment the user actually meant.
 * - `journalDay` (owner: 'system') is resolved through the exact same lazy Journal-day
 *   mechanism Journal itself uses (`getOrCreateJournalItem`), then linked via a real relation
 *   edge — never stored as a raw value, and never left unresolved.
 */
export async function createInboxItemWithClient(client: PoolClient, input: CreateInboxItemInput): Promise<ItemRow> {
  if (!input.date) throw new ValidationError("Inbox items require 'date'", { field: "date" });
  if (!input.time) throw new ValidationError("Inbox items require 'time'", { field: "time" });
  assertValidTimezone(input.timezone);

  const item = await createItemWithClient(
    client,
    {
      databaseId: input.inboxDatabaseId,
      properties: {
        date: input.date,
        time: input.time,
        ...(input.text !== undefined ? { text: input.text } : {}),
      },
      idempotencyKey: input.idempotencyKey,
    },
    { queueAffinity: input.queueAffinity },
  );

  if (input.type) {
    const typeProperty = await getRelationProperty(client, input.inboxDatabaseId, "type");
    await createRelationWithClient(client, { relationPropertyId: typeProperty.id, itemId: item.id, targetItemId: input.type });
  }

  const journalDayProperty = await getRelationProperty(client, input.inboxDatabaseId, "journalDay");
  const referenceDate = DateTime.fromISO(input.date, { zone: input.timezone }).toJSDate();
  const journalDay = await getOrCreateJournalItem(client, input.journalDatabaseId, "day", referenceDate, input.timezone);
  await createRelationWithClient(client, { relationPropertyId: journalDayProperty.id, itemId: item.id, targetItemId: journalDay.id });

  return item;
}
