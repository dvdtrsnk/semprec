import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { EMAILS_MODULE_ID, FOLDERS_MODULE_ID, MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";

const MAIL_DATABASE_KEYS = [EMAILS_MODULE_ID, FOLDERS_MODULE_ID, MAILBOXES_MODULE_ID];

export async function runMailDatabaseKeysCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const tenant = await client.query<{ id: string | null }>("SELECT app_tenant_default() AS id");
    if (!tenant.rows[0]?.id) throw new Error("Mail database key cutover requires a tenant scope");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('mail-database-keys:' || app_tenant_default()::text, 0))",
    );
    const { rows } = await client.query<{
      id: string;
      key: string | null;
      owner_module_id: string | null;
      system: boolean;
    }>(
      `SELECT id, key, owner_module_id, system FROM databases
        WHERE tenant_id = app_tenant_default()
          AND ((system AND owner_module_id = ANY($1::text[])) OR key = ANY($1::text[]))
        FOR UPDATE`,
      [MAIL_DATABASE_KEYS],
    );
    for (const key of MAIL_DATABASE_KEYS) {
      const target = rows.find((row) => row.system && row.owner_module_id === key);
      const occupant = rows.find((row) => row.key === key);
      if (target && target.key !== null && target.key !== key) throw new Error(`Unexpected key on ${key} database`);
      if (occupant && occupant.id !== target?.id) throw new Error(`Mail database key ${key} is already occupied`);
    }
    for (const key of MAIL_DATABASE_KEYS) {
      const target = rows.find((row) => row.system && row.owner_module_id === key);
      if (target?.key === null) {
        const result = await client.query(
          `UPDATE databases SET key = $1 WHERE tenant_id = app_tenant_default()
             AND id = $2 AND system AND owner_module_id = $1 AND key IS NULL`,
          [key, target.id],
        );
        if (result.rowCount !== 1) throw new Error(`Mail database key update failed for ${key}`);
      }
    }
  });
}
