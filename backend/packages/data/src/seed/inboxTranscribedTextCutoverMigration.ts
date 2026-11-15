import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { requireAffectedRows, withTransaction } from "../db/pool.js";
import { INBOX_TRANSCRIBED_TEXT_KEY } from "../inbox/inboxVoiceNote.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcription/transcriptionJob.js";
import { INBOX_MODULE_ID } from "./inboxPipelineKeys.js";

/**
 * The cutover of the Inbox `transcribedText` property (issue gh-1980): the system-owned text property that the transcribe
 * process fills with the transcript of an item's short voice notes. A populated tenant's Inbox database is
 * `schema_locked`, so the normal property writer refuses to add to it and this step inserts the property with raw SQL,
 * with the name, type, owner and owner process `seed/seedInboxPipeline.ts` gives it for a fresh install; keep the two
 * identical (`__tests__/inboxTranscribedText.test.ts` compares the shapes).
 *
 * `LOCK TABLE properties IN EXCLUSIVE MODE` comes first and is held for the length of the tenant's transaction, so the
 * existence check cannot race an insert from another session. A property that exists is left as it is, and no Inbox item
 * is touched, so the items that exist have no transcript. No-ops when the Inbox database does not exist yet.
 *
 * Runs once per tenant, in that tenant's scope and under row-level security, via `runTenantCutoverMigrations`.
 */
export async function runInboxTranscribedTextCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const inbox = await getDatabaseByModuleId(client, INBOX_MODULE_ID);
    if (!inbox) return; // not seeded yet; the fresh-install seed ships the target shape

    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = $2",
      [inbox.id, INBOX_TRANSCRIBED_TEXT_KEY],
    );
    if (rows.length > 0) return;
    // Raw SQL, not `propertiesStore.createProperty`: that refuses a schema-locked database, which is exactly the
    // database this cutover exists to change.
    const result = await client.query(
      `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
       VALUES ($1, $2, 'Transcribed text', 'text', '{}'::jsonb, false, 'system', $3)`,
      [inbox.id, INBOX_TRANSCRIBED_TEXT_KEY, TRANSCRIPTION_OWNER_PROCESS],
    );
    requireAffectedRows(result, "properties.transcribedText insert");
  });
}
