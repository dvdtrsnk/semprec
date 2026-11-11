import type { Pool } from "pg";
import { createLogger } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { FILES_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import {
  TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY,
  TRANSCRIPT_SEGMENTS_COMPUTED_KEY,
} from "./transcriptionComputedKeys.js";
import {
  enqueueTranscriptionJob,
  readTranscriptionSourceFileItemId,
  transcriptionSourceLink,
} from "./transcriptionJob.js";

const logger = createLogger("transcription");

/** The most transcripts one run selects for one tenant; the rest wait for a later run. */
export const MEETING_NOTES_BACKFILL_BATCH_SIZE = 200;

/** What every Files item link starts with: `transcriptionSourceLink` puts the item's id right after it. */
const FILES_ITEM_LINK_PREFIX = transcriptionSourceLink("");

/**
 * Issue #1712's backfill of `computed.meetingNotes` (issue #1695) for transcripts finished before the
 * pipeline stored them. Runs for the current tenant, in that tenant's scope, via
 * `runTenantCutoverMigrations`.
 *
 * One transaction selects, in id order, up to `MEETING_NOTES_BACKFILL_BATCH_SIZE` transcripts not in
 * the Trash whose `status` is `done`, that have `computed.segments` and no `computed.meetingNotes`,
 * and that have an `item_automation` row whose status is not `error`, `locked` or `pending`, and
 * enqueues the transcription job of each under its original key (`enqueueTranscriptionJob`, with the
 * Files item id read from the transcript's `link`). An `error` row is the daily requeue sweep's to
 * requeue.
 *
 * A transcript whose `link` starts like a Files item link is selected only while that link is the
 * link of an item of the tenant's Files database that is not in the Trash. The job of a transcript
 * whose source file is in the Trash or gone can store no notes: it stops at once and sets the
 * finished transcript's `item_automation` to `error`/`deleted`. Such a transcript is left out by the
 * selection itself, so it takes no place of the batch. A selected transcript whose `link` is not a
 * Files item link (`readTranscriptionSourceFileItemId`) is skipped with a warning; it still takes one
 * place of the batch.
 *
 * The selection is by the missing key, so a transcript is enqueued again by a later run only while
 * its notes are still missing, and a tenant with more transcripts than one batch is finished over
 * several runs. The jobs are the only thing written. The selection takes no row lock: the job checks
 * the user's `locked` status, the Trash and each step's checkpoint itself when it runs, so a source
 * file moved to the Trash after the selection still stops its job as described above. A tenant
 * without a Transcripts database is skipped.
 */
export async function runMeetingNotesBackfillCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
    if (!transcripts) return;
    const { rows } = await client.query<{ id: string; link: unknown }>(
      `SELECT i.id, i.properties -> 'link' AS link
       FROM items i JOIN item_automation a ON a.item_id = i.id
       WHERE i.database_id = $1 AND i.deleted_at IS NULL AND i.properties ->> 'status' = 'done'
         AND i.computed ? $2 AND NOT (i.computed ? $3)
         AND a.status NOT IN ('error', 'locked', 'pending')
         AND (NOT starts_with(COALESCE(i.properties ->> 'link', ''), $5::text)
           OR i.properties ->> 'link' IN (
             SELECT $5::text || f.id::text FROM items f JOIN databases d ON d.id = f.database_id
             WHERE d.owner_module_id = $6 AND d.system AND f.deleted_at IS NULL))
       ORDER BY i.id LIMIT $4`,
      [
        transcripts.id,
        TRANSCRIPT_SEGMENTS_COMPUTED_KEY,
        TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY,
        MEETING_NOTES_BACKFILL_BATCH_SIZE,
        FILES_ITEM_LINK_PREFIX,
        FILES_MODULE_ID,
      ],
    );
    for (const row of rows) {
      const fileItemId = readTranscriptionSourceFileItemId(row.link);
      if (!fileItemId) {
        logger.warn({ transcriptId: row.id }, "Skipping a transcript with no Files item link in the notes backfill");
        continue;
      }
      await enqueueTranscriptionJob(client, { fileItemId });
    }
  });
}
