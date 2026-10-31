import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { writeComputedAndAnnounce } from "../chokePoint/itemWrites.js";
import { FILES_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { readTranscriptionSourceFileItemId } from "./transcriptionJob.js";
import {
  TRANSCRIPT_DURATION_SECONDS_COMPUTED_KEY,
  TRANSCRIPTION_PREPARE_COMPUTED_KEY,
} from "./transcriptionComputedKeys.js";

const checkpointSchema = z.object({ durationSeconds: z.number().finite().nonnegative() });
const PAGE_SIZE = 100;

/** Per-tenant duration backfill, in keyset pages with one transaction per page. Existing values stay untouched. */
export async function runTranscriptDurationBackfillCutoverMigration(pool: Pool): Promise<void> {
  let afterId: string | null = null;
  for (;;) {
    const next: string | null = await withTransaction(pool, async (client) => {
      const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
      const files = await getDatabaseByModuleId(client, FILES_MODULE_ID);
      if (!transcripts || !files) return null;
      const { rows } = await client.query<{ id: string; properties: unknown }>(
        `SELECT id, properties FROM items WHERE database_id = $1 AND deleted_at IS NULL
           AND ($2::uuid IS NULL OR id > $2) AND NOT (computed ? $3)
         ORDER BY id LIMIT $4 FOR UPDATE`,
        [transcripts.id, afterId, TRANSCRIPT_DURATION_SECONDS_COMPUTED_KEY, PAGE_SIZE],
      );
      for (const row of rows) {
        const properties = z.object({ link: z.unknown().optional() }).parse(row.properties);
        const fileId = readTranscriptionSourceFileItemId(properties.link);
        if (!fileId) continue;
        const file = await getItemById(client, files.id, fileId);
        const checkpoint = checkpointSchema.safeParse(file?.computed[TRANSCRIPTION_PREPARE_COMPUTED_KEY]);
        if (!checkpoint.success) continue;
        await writeComputedAndAnnounce(
          client,
          transcripts.id,
          row.id,
          TRANSCRIPT_DURATION_SECONDS_COMPUTED_KEY,
          checkpoint.data.durationSeconds,
        );
      }
      return rows.length === PAGE_SIZE ? rows[rows.length - 1]!.id : null;
    });
    if (next === null) return;
    afterId = next;
  }
}
