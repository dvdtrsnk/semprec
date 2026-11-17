// Every write of an item type's `processingMethod` or `targetDatabase`, from any writer, is checked here inside the
// write's own transaction; a refusal rolls it back.
import type { PoolClient } from "pg";
import type { ItemCreateHook, ItemUpdateHook } from "../chokePoint/hooks.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { ValidationError } from "../errors.js";
import { INBOX_ITEM_TYPES_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { INBOX_TYPE_MODULE_TARGET_DATABASES, assertValidProcessingConfig } from "./inboxTypesStore.js";

/**
 * A type may not target a database whose module is not delivered to the tenant. The lookup runs on the write's own
 * client, so it is tenant-scoped and sees the same transaction.
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
 * Judged only when the patch writes one of the two fields, so a type already stored with a disallowed pair stays
 * editable in its other fields.
 */
export const inboxTypeItemUpdateHook: ItemUpdateHook = async ({ client, database, item, propertiesPatch }) => {
  if (database.ownerModuleId !== INBOX_ITEM_TYPES_MODULE_ID) return;
  if (!Object.hasOwn(propertiesPatch, "processingMethod") && !Object.hasOwn(propertiesPatch, "targetDatabase")) return;
  await assertValidTypeTarget(client, item.properties.processingMethod, item.properties.targetDatabase);
};
