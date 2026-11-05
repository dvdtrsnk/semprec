import type { Pool } from "pg";
import { z } from "zod";
import { ValidationError } from "../errors.js";

export function parseSenderKnownFilterConfig(raw: unknown): Record<string, never> | null {
  if (raw === undefined) return null;
  const result = z.object({}).strict().safeParse(raw);
  if (!result.success) throw new ValidationError("Invalid sender-known filter", { field: "senderKnownFilter" });
  return result.data;
}

export async function passesSenderKnownFilter(
  pool: Pool,
  itemId: string,
  _config: Record<string, never>,
): Promise<boolean> {
  const { rows } = await pool.query<{ allowed: boolean }>(
    String.raw`
    SELECT EXISTS (
      SELECT 1 FROM mail_message_meta m
      WHERE m.tenant_id = app_tenant_default() AND m.item_id = $1 AND m.is_bulk = false
        AND jsonb_typeof(m.envelope->'from'->'address') = 'string'
        AND btrim(m.envelope->'from'->>'address', E' \t\n\r') <> ''
        AND EXISTS (SELECT 1 FROM person_email_index p
          WHERE p.tenant_id = app_tenant_default()
            AND p.email = lower(btrim(m.envelope->'from'->>'address', E' \t\n\r')))
        AND NOT EXISTS (
          SELECT 1 FROM items mailbox
          JOIN databases d ON d.id = mailbox.database_id AND d.tenant_id = app_tenant_default() AND d.owner_module_id = 'mailboxes'
          CROSS JOIN LATERAL regexp_split_to_table(CASE WHEN jsonb_typeof(mailbox.properties->'addresses') = 'string'
            THEN mailbox.properties->>'addresses' ELSE '' END, E'[,\n\r]+') a(address)
          WHERE mailbox.tenant_id = app_tenant_default() AND mailbox.deleted_at IS NULL
            AND lower(btrim(a.address, E' \t\n\r')) = lower(btrim(m.envelope->'from'->>'address', E' \t\n\r'))
        )
    ) AS allowed`,
    [itemId],
  );
  return rows[0]?.allowed === true;
}
