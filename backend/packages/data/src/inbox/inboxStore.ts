import type { PoolClient } from "pg";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import type { ActionQueueAffinity } from "../scheduler/actions.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { NotFoundError } from "../errors.js";
import type { ItemRow } from "../types.js";

export interface CreateInboxItemInput {
  inboxDatabaseId: string;
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
 * Creates an Inbox item and, when the caller names one, its optional `type` edge. The `date` and
 * `time` are passed through verbatim, never replaced with the server's current date/time: delayed,
 * offline-captured batches must keep the moment the user actually meant. Validating them, and
 * linking the item to its Journal day (`journalDay`), happen in the item-create hook
 * (`inboxCreateHook.ts`, issue #1432), which runs inside `createItemWithClient` for every writer,
 * so this helper does not repeat either.
 */
export async function createInboxItemWithClient(client: PoolClient, input: CreateInboxItemInput): Promise<ItemRow> {
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
    await createRelationWithClient(client, {
      relationPropertyId: typeProperty.id,
      callerItemId: item.id,
      targetItemId: input.type,
    });
  }

  return item;
}
