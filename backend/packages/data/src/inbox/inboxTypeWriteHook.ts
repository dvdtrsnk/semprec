// The choke point's item create and update hooks for the Inbox item types database (registered by
// `../domainWriteHooks.ts`): every write that stores an item type's `processingMethod` or
// `targetDatabase` is checked here, inside the write's own transaction, whichever writer makes it
// (REST, an agent tool, `/mcp`). A refusal rolls the write back. See
// docs/adr/2026-10-09-item-create-domain-hooks.md.
import type { PoolClient } from "pg";
import type { ItemCreateHook, ItemUpdateHook } from "../chokePoint/hooks.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { ValidationError } from "../errors.js";
import { INBOX_ITEM_TYPES_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { INBOX_TYPE_MODULE_TARGET_DATABASES, assertValidProcessingConfig } from "./inboxTypesStore.js";

/**
 * Judges the pair as it would be stored: the rules of `assertValidProcessingConfig`, then, for a target of
 * `INBOX_TYPE_MODULE_TARGET_DATABASES`, that the tenant has that database (issue #1973). A type may not target a
 * database whose module is not delivered to the tenant. The lookup runs on the write's own client, so it is
 * scoped to the writing tenant and sees the same transaction.
 */
async function assertValidTypeTarget(
  client: PoolClient,
  resolvedMethod: unknown,
  resolvedTarget: unknown,
): Promise<void> {
  assertValidProcessingConfig(resolvedMethod, resolvedTarget);
  if (resolvedMethod !== "database") return;
  const moduleTarget = INBOX_TYPE_MODULE_TARGET_DATABASES.find((moduleId) => moduleId === resolvedTarget);
  if (moduleTarget === undefined) return;
  if (!(await getDatabaseByModuleId(client, moduleTarget))) {
    throw new ValidationError(`'targetDatabase' '${moduleTarget}' is not a database of this tenant`, {
      field: "targetDatabase",
    });
  }
}

export const inboxTypeItemCreateHook: ItemCreateHook = async ({ client, database, properties }) => {
  if (database.ownerModuleId !== INBOX_ITEM_TYPES_MODULE_ID) return;
  await assertValidTypeTarget(client, properties.processingMethod, properties.targetDatabase);
};

/**
 * Judges the item as the patch leaves it (`item` is the row after the update), and only when the patch
 * writes one of the two fields. A type already stored with a disallowed pair therefore stays editable in
 * its other fields, such as its name; a write that touches `processingMethod` or `targetDatabase` is judged
 * on the pair as it would then be stored.
 */
export const inboxTypeItemUpdateHook: ItemUpdateHook = async ({ client, database, item, propertiesPatch }) => {
  if (database.ownerModuleId !== INBOX_ITEM_TYPES_MODULE_ID) return;
  if (!Object.hasOwn(propertiesPatch, "processingMethod") && !Object.hasOwn(propertiesPatch, "targetDatabase")) return;
  await assertValidTypeTarget(client, item.properties.processingMethod, item.properties.targetDatabase);
};
