import type { ItemRestoreHook } from "../chokePoint/hooks.js";
import { JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { repointJournalPeriodReservation } from "./journalStore.js";

/**
 * The choke point's restore hook for the Journal database (issue #1666), registered by `../domainWriteHooks.ts`. It
 * runs inside the restore cascade's transaction, after the entry's restore: when another live entry already holds the
 * entry's `type` and `period`, the restore is refused with 409 and rolls back, so the entry stays in the Trash;
 * otherwise the period reservation is pointed at the restored entry, so the next write for that period finds it
 * instead of creating a further entry. Restoring an item of any other database is unaffected. An entry without a text
 * `type` and `period` cannot hold a reservation (`journalItemCreateHook` refuses to create one) and is restored as
 * before. See `repointJournalPeriodReservation` for the lock order.
 */
export const journalItemRestoreHook: ItemRestoreHook = async ({ client, database, item }) => {
  if (!database.system || database.ownerModuleId !== JOURNAL_MODULE_ID) return;
  const { type, period } = item.properties;
  if (typeof type !== "string" || typeof period !== "string") return;
  await repointJournalPeriodReservation(client, { journalDatabaseId: database.id, type, period, itemId: item.id });
};
