import type { ItemUpdateHook } from "../chokePoint/hooks.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { getSystemTimezone } from "../systemSettings.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { advanceTaskRecurrenceWithClient } from "./advanceTaskRecurrenceWithClient.js";

/** Statuses that advance a series (issue #1670): `wontDo` skips one occurrence, it never ends the series. */
const ADVANCING_STATUSES: readonly unknown[] = ["done", "wontDo"];

/**
 * The choke point's item-update hook for Tasks (registered by `../domainWriteHooks.ts`): setting a recurring
 * task occurrence to `done` or `wontDo` advances its series in this same transaction, so the status write and
 * the next occurrence commit or roll back together. The choke point locked the item row before this hook runs,
 * and the advance locks the series row after it. Only the series' current occurrence advances it, so a repeated,
 * alternating or later transition of an older occurrence creates nothing, and no date gets a second occurrence. See
 * docs/adr/2026-09-28-module-transactional-side-effects-inline-at-choke-point.md.
 */
export const taskRecurrenceItemUpdateHook: ItemUpdateHook = async ({ client, database, item, propertiesPatch }) => {
  if (database.ownerModuleId !== TASKS_MODULE_ID || !ADVANCING_STATUSES.includes(propertiesPatch.status)) return;
  await advanceTaskRecurrenceWithClient(
    client,
    { databaseId: item.databaseId, itemId: item.id, timezone: await getSystemTimezone(client) },
    createItemWithClient,
  );
};
