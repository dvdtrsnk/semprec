import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { BOOKS_MODULE_ID, MOVIES_MODULE_ID } from "../seed/libraryModuleKeys.js";
import {
  LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID,
  LIBRARY_METADATA_TRIGGER_ACTION_ID,
} from "./libraryMetadataActions.js";

/** Upgrades the existing library heartbeat configs in the current tenant. */
export async function runLibraryHeartbeatConfigCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    for (const [moduleId, changes] of [
      [BOOKS_MODULE_ID, { source: "openLibrary", authorKey: "author", yearKey: "year", isbnKey: "isbn" }],
      [MOVIES_MODULE_ID, { source: "tmdb", yearKey: "year", typeKey: "type" }],
    ] as const) {
      const database = await getDatabaseByModuleId(client, moduleId);
      if (!database) continue;
      const result = await client.query(
        `UPDATE project_heartbeats SET action_config = action_config || $3::jsonb
         WHERE action_id = ANY($1::text[]) AND action_config->>'databaseId' = $2
           AND action_config->>'source' = 'none'`,
        [
          [LIBRARY_METADATA_TRIGGER_ACTION_ID, LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID],
          database.id,
          JSON.stringify(changes),
        ],
      );
      if (result.rowCount === null) throw new Error("Could not count library heartbeat updates");
    }
  });
}
