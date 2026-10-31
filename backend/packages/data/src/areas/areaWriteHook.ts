import type { ItemCreateHook, ItemUpdateHook } from "../chokePoint/hooks.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { requireSingleRow } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { AREAS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

export const AREA_ICONS = ["briefcase", "heart", "house", "people", "money", "chart", "shield", "star"] as const;
export const AREA_COLORS = [
  "#5856D6",
  "#FF2D55",
  "#FF9500",
  "#30B0C7",
  "#007AFF",
  "#AF52DE",
  "#FF3B30",
  "#34C759",
  "#8E8E93",
] as const;

function validateWrittenProperties(properties: Record<string, unknown>): void {
  if (Object.hasOwn(properties, "icon") && properties.icon !== null) {
    if (!AREA_ICONS.some((icon) => icon === properties.icon)) {
      throw new ValidationError("Property 'icon' must be a supported area icon", { field: "icon" });
    }
  }
  if (Object.hasOwn(properties, "color") && properties.color !== null) {
    const color = properties.color;
    if (typeof color !== "string" || !AREA_COLORS.some((allowed) => allowed.toLowerCase() === color.toLowerCase())) {
      throw new ValidationError("Property 'color' must be a supported area color", { field: "color" });
    }
  }
}

export const areaItemCreateHook: ItemCreateHook = async ({
  client,
  database,
  item,
  properties,
  writer,
  humanWriterUserId,
}) => {
  if (database.ownerModuleId !== AREAS_MODULE_ID) return;
  validateWrittenProperties(properties);
  if (Object.hasOwn(properties, "position") && properties.position !== null) return;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('areas-position:' || $1::text, 0))", [database.id]);
  const { rows } = await client.query<{ next_position: number }>(
    `SELECT (COALESCE(MAX(CASE WHEN jsonb_typeof(properties->'position') = 'number'
      THEN (properties->>'position')::double precision END), 0) + 1) AS next_position
     FROM items WHERE database_id = $1 AND deleted_at IS NULL AND id <> $2`,
    [database.id, item.id],
  );
  const { next_position: position } = requireSingleRow(rows, "next area position");
  await updateItemWithClient(
    client,
    { databaseId: database.id, itemId: item.id, propertiesPatch: { position } },
    { writer, humanWriterUserId },
  );
};

export const areaItemUpdateHook: ItemUpdateHook = async ({ database, propertiesPatch }) => {
  if (database.ownerModuleId !== AREAS_MODULE_ID) return;
  validateWrittenProperties(propertiesPatch);
};
