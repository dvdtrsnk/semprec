// Refuses a Journal entry without a non-blank `type` or `period`: `getOrCreateJournalItem` finds entries again by an
// idempotency key built from them. Runs after the insert in the create's transaction, so a refusal rolls it back.
import type { ItemCreateHook } from "../chokePoint/hooks.js";
import { ForbiddenError } from "../errors.js";
import { JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";

const REQUIRED_KEYS = ["type", "period"] as const;

function isNonBlankText(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

export const journalItemCreateHook: ItemCreateHook = async ({ database, properties }) => {
  if (database.ownerModuleId !== JOURNAL_MODULE_ID) return;
  const missing = REQUIRED_KEYS.find((key) => !isNonBlankText(properties[key]));
  if (missing === undefined) return;
  throw new ForbiddenError(`Journal entries require a non-blank '${missing}'`, { field: missing });
};
