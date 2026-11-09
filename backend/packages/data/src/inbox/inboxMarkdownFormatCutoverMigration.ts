import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { requireAffectedRows, withTransaction } from "../db/pool.js";
import { INBOX_MODULE_ID } from "../seed/inboxPipelineKeys.js";

export async function runInboxMarkdownFormatCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const inbox = await getDatabaseByModuleId(client, INBOX_MODULE_ID);
    if (!inbox) return;
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const { rows } = await client.query<{ id: string; config: Record<string, unknown> }>(
      "SELECT id, config FROM properties WHERE database_id = $1 AND key = 'text' FOR UPDATE",
      [inbox.id],
    );
    const property = rows[0];
    if (!property || property.config.format === "markdown") return;
    const result = await client.query(
      "UPDATE properties SET config = jsonb_set(config, '{format}', to_jsonb('markdown'::text)) WHERE id = $1",
      [property.id],
    );
    requireAffectedRows(result, "Inbox text format cutover");
  });
}
