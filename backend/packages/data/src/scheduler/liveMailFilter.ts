import type { Pool } from "pg";
import { z } from "zod";
import { ValidationError } from "../errors.js";

export function parseLiveMailFilterConfig(raw: unknown): Record<string, never> | null {
  if (raw === undefined) return null;
  const result = z.object({}).strict().safeParse(raw);
  if (!result.success) throw new ValidationError("Invalid live-mail filter", { field: "liveMailFilter" });
  return result.data;
}

/** Only a message ingested as `live` passes; backfilled history and an item without mail metadata do not. */
export async function passesLiveMailFilter(
  pool: Pool,
  itemId: string,
  _config: Record<string, never>,
): Promise<boolean> {
  const { rows } = await pool.query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM mail_message_meta
        WHERE tenant_id = app_tenant_default() AND item_id = $1 AND arrival = 'live'
     ) AS allowed`,
    [itemId],
  );
  return rows[0]?.allowed === true;
}
