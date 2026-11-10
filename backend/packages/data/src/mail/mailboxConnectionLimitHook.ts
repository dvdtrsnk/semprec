import type { ItemCreateHookContext, ItemUpdateHookContext } from "../chokePoint/hooks.js";
import { ValidationError } from "../errors.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";

function assertConnectionLimit(ownerModuleId: string | null, written: Record<string, unknown>): void {
  if (ownerModuleId !== MAILBOXES_MODULE_ID || !Object.hasOwn(written, "connectionLimit")) return;
  const value = written.connectionLimit;
  if (value === null) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 15) {
    throw new ValidationError("connectionLimit must be null or an integer from 1 to 15", { field: "connectionLimit" });
  }
}

export async function mailboxConnectionLimitCreateHook({
  database,
  properties,
}: Pick<ItemCreateHookContext, "database" | "properties">): Promise<void> {
  assertConnectionLimit(database.ownerModuleId, properties);
}

export async function mailboxConnectionLimitUpdateHook({
  database,
  propertiesPatch,
}: Pick<ItemUpdateHookContext, "database" | "propertiesPatch">): Promise<void> {
  assertConnectionLimit(database.ownerModuleId, propertiesPatch);
}
