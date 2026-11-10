import type { Pool } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { requireAffectedRows, withTransaction } from "../db/pool.js";
import { EVENTS_MODULE_ID, HEALTH_RECORDS_MODULE_ID, PEOPLE_MODULE_ID, PROJECTS_MODULE_ID } from "./tenDatabaseKeys.js";

const catalogs = [
  { moduleId: PROJECTS_MODULE_ID, property: "status", keys: ["inProgress", "longTerm", "done", "archived"] },
  { moduleId: HEALTH_RECORDS_MODULE_ID, property: "status", keys: ["monitoring", "resolved"] },
  {
    moduleId: PEOPLE_MODULE_ID,
    property: "relationship",
    keys: [
      "client",
      "closeFriend",
      "parent",
      "girlfriend",
      "therapist",
      "neighbor",
      "colleague",
      "craftsman",
      "doctor",
    ],
  },
  { moduleId: EVENTS_MODULE_ID, property: "type", keys: ["meeting", "standup", "event"] },
] as const;

export async function runSelectOptionOrderCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    for (const catalog of catalogs) {
      const database = await getDatabaseByModuleId(client, catalog.moduleId);
      if (!database) continue;
      const { rows } = await client.query<Record<string, unknown>>(
        "SELECT id, config FROM properties WHERE database_id = $1 AND key = $2",
        [database.id, catalog.property],
      );
      if (!rows[0]) continue;
      const property = z
        .object({
          id: z.string(),
          config: z.object({ options: z.array(z.object({ key: z.string() }).passthrough()).optional() }).passthrough(),
        })
        .parse(rows[0]);
      const options = property.config.options ?? [];
      const rank = new Map<string, number>(catalog.keys.map((key, index) => [key, index]));
      const reordered = [...options].sort((a, b) => (rank.get(a.key) ?? rank.size) - (rank.get(b.key) ?? rank.size));
      if (reordered.every((option, index) => option === options[index])) continue;
      const result = await client.query(
        "UPDATE properties SET config = jsonb_set(config, '{options}', $2::jsonb) WHERE id = $1",
        [property.id, JSON.stringify(reordered)],
      );
      requireAffectedRows(result, "properties select option order backfill");
    }
  });
}
