// The choke point's item-create hook for the Journal database (registered by `../domainWriteHooks.ts`):
// refuses an entry whose written properties lack a non-blank `type` or `period`, the two values
// `getOrCreateJournalItem` always writes. That function finds an entry again through its idempotency
// key, which is built from `type` and `period`, so an entry without them could not be found that way.
// The hook runs inside the create's transaction after the insert, so a refusal rolls the row back.
// See docs/adr/2026-10-09-item-create-domain-hooks.md.
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
