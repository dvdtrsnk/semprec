import type { PoolClient } from "pg";
import { NotFoundError } from "./errors.js";

/** Stable identifier for the singleton "System settings" database — see seed/seedSystem.ts. */
export const SYSTEM_SETTINGS_MODULE_ID = "systemSettings";
export const DEFAULT_TIMEZONE = "Europe/Prague";

export async function getSystemSettingsDatabaseId(client: PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM databases WHERE owner_module_id = $1 AND system = true`,
    [SYSTEM_SETTINGS_MODULE_ID],
  );
  if (!rows[0]) throw new NotFoundError("System settings database has not been seeded");
  return rows[0].id;
}

export async function getSystemSettingsItemId(client: PoolClient): Promise<string> {
  const databaseId = await getSystemSettingsDatabaseId(client);
  const { rows } = await client.query<{ id: string }>(`SELECT id FROM items WHERE database_id = $1 LIMIT 1`, [databaseId]);
  if (!rows[0]) throw new NotFoundError("System settings row has not been seeded");
  return rows[0].id;
}

export async function getSystemTimezone(client: PoolClient): Promise<string> {
  const databaseId = await getSystemSettingsDatabaseId(client);
  const { rows } = await client.query<{ properties: { timezone?: string } }>(
    `SELECT properties FROM items WHERE database_id = $1 LIMIT 1`,
    [databaseId],
  );
  return rows[0]?.properties.timezone ?? DEFAULT_TIMEZONE;
}
