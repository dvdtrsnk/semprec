import type { Pool } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { requireAffectedRows, withTransaction } from "../db/pool.js";
import { PEOPLE_MODULE_ID } from "./tenDatabaseKeys.js";

const addedKeys = ["colleague", "craftsman", "doctor"];

export async function runPeopleRelationshipOptionsCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const people = await getDatabaseByModuleId(client, PEOPLE_MODULE_ID);
    if (!people) return;
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const { rows } = await client.query<Record<string, unknown>>(
      "SELECT id, config FROM properties WHERE database_id = $1 AND key = 'relationship'",
      [people.id],
    );
    if (!rows[0]) return;
    const property = z
      .object({
        id: z.string(),
        config: z.object({ options: z.array(z.object({ key: z.string() }).passthrough()).optional() }).passthrough(),
      })
      .parse(rows[0]);
    const options = property.config.options ?? [];
    const missing = addedKeys.filter((key) => !options.some((option) => option.key === key));
    if (missing.length === 0) return;
    const result = await client.query(
      "UPDATE properties SET config = jsonb_set(config, '{options}', $2::jsonb) WHERE id = $1",
      [property.id, JSON.stringify([...options, ...missing.map((key) => ({ key }))])],
    );
    requireAffectedRows(result, "properties.people.relationship option backfill");
  });
}
