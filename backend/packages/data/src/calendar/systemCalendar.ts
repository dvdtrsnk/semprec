import type { PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";

/**
 * The id of the tenant's live calendar with the system key `systemKey` (`birthdays`, `holidaysCz`, ...), or `null`
 * when the tenant has no calendars database or no such live calendar. Of several rows with that key the lowest
 * id is taken, as the timeline's own calendar lookup does.
 */
export async function readSystemCalendarId(client: PoolClient, systemKey: string): Promise<string | null> {
  const calendars = await getDatabaseByModuleId(client, CALENDARS_MODULE_ID);
  if (!calendars) return null;
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM items
      WHERE database_id = $1 AND deleted_at IS NULL AND properties->>'systemKey' = $2
      ORDER BY id LIMIT 1`,
    [calendars.id, systemKey],
  );
  return rows[0]?.id ?? null;
}
