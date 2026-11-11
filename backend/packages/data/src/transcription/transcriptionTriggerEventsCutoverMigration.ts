import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { requireAffectedRows, withTransaction } from "../db/pool.js";
import { FILES_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { FILES_TRANSCRIPTION_TRIGGER_ACTION_ID } from "./transcriptionActions.js";

/**
 * Populated-upgrade cutover for issue #1698: gives the existing `Files transcription trigger`
 * heartbeat (`action_id` `core.filesTranscriptionTrigger`) the `eventsRelationPropertyId` that
 * `seedSystem` writes on a fresh install, so the trigger also skips an audio file attached to an
 * Event on a tenant seeded before that key existed. The value is the id of the `events` property of
 * the tenant's Files database, the one the seed resolves.
 *
 * Idempotent, in one transaction: a heartbeat whose config already has the key is not selected, so a
 * second run writes nothing. A no-op when the tenant has no such heartbeat, no Files database, or no
 * `events` property on it yet; a heartbeat then keeps its old config, which the action still accepts.
 * That property comes from the seed or from `blobs/eventsFilesRelationCutoverMigration.ts`, which
 * `runTenantCutoverMigrations` runs before this cutover.
 *
 * Runs once per tenant, in that tenant's scope and under row-level security, via
 * `runTenantCutoverMigrations`; it sees only that tenant's heartbeats, database and property.
 */
export async function runTranscriptionTriggerEventsCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const files = await getDatabaseByModuleId(client, FILES_MODULE_ID);
    if (!files) return;
    const eventsProperty = await getPropertyByKey(client, files.id, "events");
    if (!eventsProperty) return;

    // Row-locked, so a heartbeat read here without the key is still without it when it is updated below.
    const pending = await client.query<{ id: string }>(
      `SELECT id FROM project_heartbeats
        WHERE action_id = $1 AND NOT action_config ? 'eventsRelationPropertyId'
          FOR UPDATE`,
      [FILES_TRANSCRIPTION_TRIGGER_ACTION_ID],
    );
    for (const heartbeat of pending.rows) {
      const result = await client.query(
        `UPDATE project_heartbeats
            SET action_config = jsonb_set(action_config, '{eventsRelationPropertyId}', to_jsonb($2::text))
          WHERE id = $1`,
        [heartbeat.id, eventsProperty.id],
      );
      requireAffectedRows(result, "Files transcription trigger events cutover");
    }
  });
}
