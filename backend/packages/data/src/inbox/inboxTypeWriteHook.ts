// The choke point's item create and update hooks for the Inbox item types database (registered by
// `../domainWriteHooks.ts`): every write that stores an item type's `processingMethod` or
// `targetDatabase` is checked here, inside the write's own transaction, whichever writer makes it
// (REST, an agent tool, `/mcp`). A refusal rolls the write back. See
// docs/adr/2026-10-09-item-create-domain-hooks.md.
import type { ItemCreateHook, ItemUpdateHook } from "../chokePoint/hooks.js";
import { INBOX_ITEM_TYPES_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { assertValidProcessingConfig } from "./inboxTypesStore.js";

export const inboxTypeItemCreateHook: ItemCreateHook = async ({ database, properties }) => {
  if (database.ownerModuleId !== INBOX_ITEM_TYPES_MODULE_ID) return;
  assertValidProcessingConfig(properties.processingMethod, properties.targetDatabase);
};

/**
 * Judges the item as the patch leaves it (`item` is the row after the update), and only when the patch
 * writes one of the two fields. A type already stored with a disallowed pair therefore stays editable in
 * its other fields, such as its name; a write that touches `processingMethod` or `targetDatabase` is judged
 * on the pair as it would then be stored.
 */
export const inboxTypeItemUpdateHook: ItemUpdateHook = async ({ database, item, propertiesPatch }) => {
  if (database.ownerModuleId !== INBOX_ITEM_TYPES_MODULE_ID) return;
  if (!Object.hasOwn(propertiesPatch, "processingMethod") && !Object.hasOwn(propertiesPatch, "targetDatabase")) return;
  assertValidProcessingConfig(item.properties.processingMethod, item.properties.targetDatabase);
};
