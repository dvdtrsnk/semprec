import type { Pool } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { requireAffectedRows, withTransaction } from "../db/pool.js";
import { EMAILS_MODULE_ID, THREADS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { createThreadsDatabase } from "../seed/seedEmailModule.js";
import { COMPANIES_MODULE_ID, PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { lockMailThreadMutation } from "./mailThreadMutationGuard.js";

export async function runThreadsDatabaseCutoverMigration(pool: Pool): Promise<void> {
  const ready = await withTransaction(pool, async (client) => {
    await lockMailThreadMutation(client);
    const emails = await getDatabaseByModuleId(client, EMAILS_MODULE_ID);
    if (!emails) return false;
    if (await getDatabaseByModuleId(client, THREADS_MODULE_ID)) return true;
    const projects = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
    const companies = await getDatabaseByModuleId(client, COMPANIES_MODULE_ID);
    if (!projects || !companies || !emails.ownerProjectItemId)
      throw new Error("Threads catalog dependencies are missing");
    const owner = await getItemById(client, projects.id, emails.ownerProjectItemId);
    if (!owner || owner.deletedAt) throw new Error("Threads catalog owner is missing");
    const threads = await createThreadsDatabase(client, emails.ownerProjectItemId, projects.id, companies.id);
    const locked = await client.query("UPDATE databases SET schema_locked = true WHERE id = $1", [threads.id]);
    requireAffectedRows(locked, "Threads schema lock");
    return true;
  });
  if (!ready) return;
  for (;;) {
    const count = await withTransaction(pool, async (client) => {
      await lockMailThreadMutation(client);
      const threads = await getDatabaseByModuleId(client, THREADS_MODULE_ID);
      const emails = await getDatabaseByModuleId(client, EMAILS_MODULE_ID);
      if (!threads || !emails) throw new Error("Threads catalog disappeared");
      const result = await client.query<Record<string, unknown>>(
        `SELECT t.id, t.subject_hint,
          (SELECT min(NULLIF(i.properties->>'date', '')::timestamptz)::text
           FROM mail_message_meta m JOIN items i ON i.tenant_id = m.tenant_id AND i.id = m.item_id AND i.database_id = $1
           WHERE m.tenant_id = t.tenant_id AND m.thread_id = t.id) AS earliest
         FROM mail_threads t WHERE t.tenant_id = app_tenant_default() AND t.item_id IS NULL
         ORDER BY t.id LIMIT 200`,
        [emails.id],
      );
      const rows = z
        .array(z.object({ id: z.uuid(), subject_hint: z.string().nullable(), earliest: z.string().nullable() }))
        .parse(result.rows);
      for (const row of rows) {
        const item = await createItemWithClient(
          client,
          { databaseId: threads.id, properties: { name: row.subject_hint || "(no subject)" } },
          { allowedSystemKeys: ["name"] },
        );
        const updated = await client.query(
          "UPDATE mail_threads SET item_id = $2, created_at = COALESCE($3::timestamptz, created_at) WHERE tenant_id = app_tenant_default() AND id = $1 AND item_id IS NULL",
          [row.id, item.id, row.earliest],
        );
        requireAffectedRows(updated, "thread item backfill");
      }
      return rows.length;
    });
    if (count < 200) return;
  }
}
