import type { Pool } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { BOOKS_MODULE_ID, MOVIES_MODULE_ID } from "./libraryModuleKeys.js";
import { ratingFilterPresetsConfig } from "./seedLibraryModule.js";

const configSchema = z.record(z.string(), z.unknown());

/**
 * Per-tenant cutover of issue #1622: gives `books.rating` and `movies.rating` of an existing tenant the rating
 * filter presets a fresh install seeds (`ratingFilterPresetsConfig`), merged into the stored config so its other
 * keys stay. A missing database or property is skipped, and a property that already has `filterPresets` — the
 * seeded ones or the tenant's own — is never overwritten, so a second run changes nothing. The Library schemas are
 * locked, so the config is written with direct SQL; the update re-checks the absence of `filterPresets` itself.
 */
export async function runRatingFilterPresetsCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    for (const databaseKey of [BOOKS_MODULE_ID, MOVIES_MODULE_ID] as const) {
      const database = await getDatabaseByModuleId(client, databaseKey);
      if (!database) continue;
      const { rows } = await client.query<{ id: string; config: unknown }>(
        "SELECT id, config FROM properties WHERE database_id = $1 AND key = 'rating' AND type = 'number'",
        [database.id],
      );
      const property = rows[0];
      if (!property || Object.hasOwn(configSchema.parse(property.config), "filterPresets")) continue;
      const result = await client.query(
        "UPDATE properties SET config = config || $2::jsonb WHERE id = $1 AND NOT (config ? 'filterPresets')",
        [property.id, JSON.stringify(ratingFilterPresetsConfig(databaseKey))],
      );
      // The row was just read under the table lock, so anything but one updated row is a broken invariant.
      if (result.rowCount !== 1) throw new Error("Unexpected rating filter presets update count");
    }
  });
}
