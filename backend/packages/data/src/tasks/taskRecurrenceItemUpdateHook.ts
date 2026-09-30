import type { ItemUpdateHook } from "../chokePoint/hooks.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { getSystemTimezone } from "../systemSettings.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { advanceTaskRecurrenceWithClient } from "./advanceTaskRecurrenceWithClient.js";

/**
 * The choke point's item-update hook for Tasks (registered by `../domainWriteHooks.ts`):
 * completing a recurring task advances it to its next instance in this same transaction, so the
 * `done` write and the new instance commit or roll back together. A no-op when the task has no
 * active recurrence, including a repeated `done` write (the first one deactivated it). See
 * docs/adr/2026-09-28-module-transactional-side-effects-inline-at-choke-point.md.
 */
export const taskRecurrenceItemUpdateHook: ItemUpdateHook = async ({ client, database, item, propertiesPatch }) => {
  if (database.ownerModuleId !== TASKS_MODULE_ID || propertiesPatch.status !== "done") return;
  await advanceTaskRecurrenceWithClient(
    client,
    { databaseId: item.databaseId, itemId: item.id, timezone: await getSystemTimezone(client) },
    createItemWithClient,
  );
};
