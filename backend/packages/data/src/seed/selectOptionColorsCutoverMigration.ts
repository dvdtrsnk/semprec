import type { Pool } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { requireAffectedRows, withTransaction } from "../db/pool.js";
import { BOOKS_MODULE_ID, MOVIES_MODULE_ID } from "./libraryModuleKeys.js";
import {
  EVENTS_MODULE_ID,
  FILES_MODULE_ID,
  HEALTH_RECORDS_MODULE_ID,
  PEOPLE_MODULE_ID,
  PROJECTS_MODULE_ID,
} from "./tenDatabaseKeys.js";

const catalogs: ReadonlyArray<{ moduleId: string; property: string; colors: Readonly<Record<string, string>> }> = [
  {
    moduleId: FILES_MODULE_ID,
    property: "type",
    colors: { pdf: "#FF3B30", xlsx: "#34C759", docx: "#007AFF", jpg: "#FF9500" },
  },
  { moduleId: HEALTH_RECORDS_MODULE_ID, property: "status", colors: { monitoring: "#FF9500", resolved: "#34C759" } },
  {
    moduleId: PEOPLE_MODULE_ID,
    property: "relationship",
    colors: {
      client: "#007AFF",
      closeFriend: "#AF52DE",
      parent: "#FF9500",
      girlfriend: "#FF2D55",
      therapist: "#34C759",
      neighbor: "#8E8E93",
      colleague: "#8E8E93",
      craftsman: "#8E8E93",
      doctor: "#8E8E93",
    },
  },
  {
    moduleId: EVENTS_MODULE_ID,
    property: "type",
    colors: { meeting: "#AF52DE", standup: "#007AFF", event: "#FF3B30" },
  },
  {
    moduleId: PROJECTS_MODULE_ID,
    property: "status",
    colors: { inProgress: "#007AFF", longTerm: "#AF52DE", done: "#34C759", archived: "#8E8E93" },
  },
  { moduleId: BOOKS_MODULE_ID, property: "status", colors: { toRead: "#8E8E93", reading: "#007AFF", read: "#34C759" } },
  {
    moduleId: MOVIES_MODULE_ID,
    property: "status",
    colors: { planned: "#8E8E93", watching: "#007AFF", watched: "#34C759" },
  },
];

export async function runSelectOptionColorsCutoverMigration(pool: Pool): Promise<void> {
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
      let changed = false;
      const options = (property.config.options ?? []).map((option) => {
        const color = Object.hasOwn(catalog.colors, option.key) ? catalog.colors[option.key] : undefined;
        if (Object.hasOwn(option, "color") || color === undefined) return option;
        changed = true;
        return { ...option, color };
      });
      if (!changed) continue;
      const result = await client.query(
        "UPDATE properties SET config = jsonb_set(config, '{options}', $2::jsonb) WHERE id = $1",
        [property.id, JSON.stringify(options)],
      );
      requireAffectedRows(result, "properties select option colors backfill");
    }
  });
}
