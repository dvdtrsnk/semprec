import type { ItemRestoreHook } from "../chokePoint/hooks.js";
import { JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { repointJournalPeriodReservation } from "./journalStore.js";

/**
 * Runs in the restore cascade's transaction after the entry's restore: refuses with 409 (rollback, entry stays in the
 * Trash) when another live entry holds the period, else repoints the period reservation at it. An entry without text
 * `type` and `period` holds no reservation and restores normally. Lock order: see `repointJournalPeriodReservation`.
 */
export const journalItemRestoreHook: ItemRestoreHook = async ({ client, database, item }) => {
  if (!database.system || database.ownerModuleId !== JOURNAL_MODULE_ID) return;
  const { type, period } = item.properties;
  if (typeof type !== "string" || typeof period !== "string") return;
  await repointJournalPeriodReservation(client, { journalDatabaseId: database.id, type, period, itemId: item.id });
};
