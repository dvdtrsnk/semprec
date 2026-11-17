import type { ItemUpdateHook } from "../chokePoint/hooks.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { getSystemTimezone } from "../systemSettings.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { advanceTaskRecurrenceWithClient } from "./advanceTaskRecurrenceWithClient.js";

/** `wontDo` skips one occurrence; it never ends the series. */
const ADVANCING_STATUSES: readonly unknown[] = ["done", "wontDo"];

/**
 * Setting a recurring occurrence to `done` or `wontDo` advances its series in the same transaction. The choke
 * point already locked the item; the advance locks the series row after it. Only the current occurrence
 * advances, so repeated or older transitions create nothing and no date gets a second occurrence.
 */
export const taskRecurrenceItemUpdateHook: ItemUpdateHook = async ({ client, database, item, propertiesPatch }) => {
  if (database.ownerModuleId !== TASKS_MODULE_ID || !ADVANCING_STATUSES.includes(propertiesPatch.status)) return;
  await advanceTaskRecurrenceWithClient(
    client,
    { databaseId: item.databaseId, itemId: item.id, timezone: await getSystemTimezone(client) },
    createItemWithClient,
  );
};
