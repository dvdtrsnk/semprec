import type { PoolClient } from "pg";
import type { ItemCreateHook, ItemUpdateHook } from "../chokePoint/hooks.js";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import { ValidationError } from "../errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function lockReferences(client: PoolClient, databaseId: string, values: Record<string, unknown>): Promise<void> {
  const references = new Map<string, string>();
  for (const property of await listPropertiesByDatabase(client, databaseId)) {
    if ((property.type !== "file" && property.type !== "image") || !Object.hasOwn(values, property.key)) continue;
    const value = values[property.key];
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, "blobId")) continue;
    const id: unknown = Reflect.get(value, "blobId");
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      throw new ValidationError("Invalid blob reference", { field: property.key });
    }
    if (!references.has(id.toLowerCase())) references.set(id.toLowerCase(), property.key);
  }
  for (const [id, field] of [...references.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM blobs WHERE tenant_id = app_tenant_default() AND id = $1::uuid FOR KEY SHARE",
      [id],
    );
    if (rows.length === 0) throw new ValidationError("Invalid blob reference", { field });
  }
}

export const blobReferenceItemCreateHook: ItemCreateHook = async ({ client, database, properties }) => {
  await lockReferences(client, database.id, properties);
};

export const blobReferenceItemUpdateHook: ItemUpdateHook = async ({ client, database, propertiesPatch }) => {
  await lockReferences(client, database.id, propertiesPatch);
};
