import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import { TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import {
  FILES_TRANSCRIPTION_TRIGGER_ACTION_ID,
  TRANSCRIPTION_REQUEUE_HEARTBEAT,
  TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID,
} from "./transcriptionActions.js";

/**
 * One-time populated-upgrade cutover for issue #186's daily requeue heartbeat. `seedSystem`
 * creates it only on a fresh install, since its seed transaction never re-runs once the system
 * databases exist; an instance seeded by an older build gets it here instead, on the Semprec
 * project that already owns the Files transcription trigger (issue #180). A no-op when the
 * heartbeat already exists, and when there is no Transcripts database or trigger to anchor it to
 * yet — a fresh install, where `seedSystem` creates both.
 */
export async function runTranscriptionRequeueHeartbeatCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    // Serializes two concurrent runs, so neither sees the other's heartbeat missing and both insert it.
    await client.query(`LOCK TABLE project_heartbeats IN SHARE ROW EXCLUSIVE MODE`);

    const existing = await client.query(`SELECT 1 FROM project_heartbeats WHERE action_id = $1`, [
      TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID,
    ]);
    if ((existing.rowCount ?? 0) > 0) return;

    const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
    if (!transcripts) return;
    const { rows } = await client.query<{ project_item_id: string }>(
      `SELECT project_item_id FROM project_heartbeats WHERE action_id = $1 ORDER BY created_at LIMIT 1`,
      [FILES_TRANSCRIPTION_TRIGGER_ACTION_ID],
    );
    const projectItemId = rows[0]?.project_item_id;
    if (!projectItemId) return;

    await createHeartbeat(client, {
      projectItemId,
      name: TRANSCRIPTION_REQUEUE_HEARTBEAT.name,
      rule: TRANSCRIPTION_REQUEUE_HEARTBEAT.rule,
      actionId: TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID,
      actionConfig: { transcriptsDatabaseId: transcripts.id },
    });
  });
}
