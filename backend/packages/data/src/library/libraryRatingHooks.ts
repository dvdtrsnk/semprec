// Choke-point write hooks (registered by `../domainWriteHooks.ts`) validating the user's own
// library ratings: the `rating` property on Books and Movies/TV items (a whole number of stars,
// 0 meaning "no rating", null clearing it) and the per-person `metadata.rating` on the Movies
// `watchedWith` edge (1 to 5). They validate new writes only; stored values are not migrated.
import type { ItemCreateHook, ItemUpdateHook, RelationEdgeWriteHook } from "../chokePoint/hooks.js";
import { ValidationError } from "../errors.js";
import { BOOKS_MODULE_ID, MOVIES_MODULE_ID } from "../seed/libraryModuleKeys.js";

const RATING_KEY = "rating";
const WATCHED_WITH_KEY = "watchedWith";

function assertIntegerInRange(value: unknown, min: number, field: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > 5) {
    throw new ValidationError(`${field} must be a whole number from ${min} to 5`, { field });
  }
}

function assertItemRating(database: { ownerModuleId: string | null }, properties: Record<string, unknown>): void {
  if (database.ownerModuleId !== BOOKS_MODULE_ID && database.ownerModuleId !== MOVIES_MODULE_ID) return;
  if (!Object.hasOwn(properties, RATING_KEY)) return;
  const value = properties[RATING_KEY];
  if (value === null) return;
  assertIntegerInRange(value, 0, RATING_KEY);
}

export const libraryRatingItemCreateHook: ItemCreateHook = async ({ database, properties }) => {
  assertItemRating(database, properties);
};

/** Validates only the keys present in the patch. */
export const libraryRatingItemUpdateHook: ItemUpdateHook = async ({ database, propertiesPatch }) => {
  assertItemRating(database, propertiesPatch);
};

export const libraryWatchedWithEdgeWriteHook: RelationEdgeWriteHook = async ({ client, edgeContext, metadata }) => {
  if (edgeContext.property.key !== WATCHED_WITH_KEY || !metadata || !Object.hasOwn(metadata, RATING_KEY)) return;
  const { rows } = await client.query<{ owner_module_id: string | null }>(
    `SELECT owner_module_id FROM databases WHERE id = $1`,
    [edgeContext.property.databaseId],
  );
  if (rows[0]?.owner_module_id !== MOVIES_MODULE_ID) return;
  assertIntegerInRange(metadata[RATING_KEY], 1, "metadata.rating");
};
