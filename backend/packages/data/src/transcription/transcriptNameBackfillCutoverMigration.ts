import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { FILES_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { readTranscriptionSourceFileItemId } from "./transcriptionJob.js";

const PAGE_SIZE = 100;

const transcriptPropertiesSchema = z.object({ name: z.string(), link: z.unknown().optional() });

/**
 * Per-tenant cutover of issue #1830. The create step used to copy the upload's filename into
 * `Transcripts.name`, which a user never typed. This clears `name` on every live transcript whose
 * `name` equals the `Files.name` of its source file (the Files item its `link` names), so the title
 * a reader sees comes from `resolveTranscriptDisplayName` instead. `Files.name` is left as it is.
 * A name that differs from the filename, a transcript without a readable source link and a source
 * Files item that is gone are left untouched. A name the user typed that happens to equal the
 * filename is cleared as well: the rows cannot be told apart.
 *
 * Each clear is an item update through the choke point (the default system writer), which records
 * the change and announces it after commit. Keyset pages of `PAGE_SIZE` rows, one transaction per
 * page, each page locked `FOR UPDATE` while its names are compared and cleared. A second run
 * selects no row whose name was cleared, so it changes nothing.
 */
export async function runTranscriptNameBackfillCutoverMigration(pool: Pool): Promise<void> {
  let afterId: string | null = null;
  for (;;) {
    const next: string | null = await withTransaction(pool, async (client) => {
      const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
      const files = await getDatabaseByModuleId(client, FILES_MODULE_ID);
      if (!transcripts || !files) return null;
      const { rows } = await client.query<{ id: string; properties: unknown }>(
        `SELECT id, properties FROM items
          WHERE database_id = $1 AND deleted_at IS NULL AND jsonb_typeof(properties -> 'name') = 'string'
            AND ($2::uuid IS NULL OR id > $2)
          ORDER BY id LIMIT $3 FOR UPDATE`,
        [transcripts.id, afterId, PAGE_SIZE],
      );
      for (const row of rows) {
        const properties = transcriptPropertiesSchema.parse(row.properties);
        const fileId = readTranscriptionSourceFileItemId(properties.link);
        if (!fileId) continue;
        const file = await getItemById(client, files.id, fileId);
        if (!file || file.properties.name !== properties.name) continue;
        await updateItemWithClient(client, {
          databaseId: transcripts.id,
          itemId: row.id,
          propertiesPatch: { name: null },
        });
      }
      return rows.length === PAGE_SIZE ? rows[rows.length - 1]!.id : null;
    });
    if (next === null) return;
    afterId = next;
  }
}
