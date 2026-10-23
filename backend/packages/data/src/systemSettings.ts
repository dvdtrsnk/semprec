import type { PoolClient } from "pg";
import { NotFoundError } from "./errors.js";
import { assertShape } from "./dbRowValidation.js";
import type { Queryable } from "./db/pool.js";

/** Stable identifier for the singleton "System settings" database — see seed/seedSystem.ts. */
export const SYSTEM_SETTINGS_MODULE_ID = "systemSettings";
export const DEFAULT_TIMEZONE = "Europe/Prague";

export async function getSystemSettingsDatabaseId(client: Queryable): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM databases WHERE owner_module_id = $1 AND system = true`,
    [SYSTEM_SETTINGS_MODULE_ID],
  );
  if (!rows[0]) throw new NotFoundError("System settings database has not been seeded");
  return rows[0].id;
}

export async function getSystemSettingsItemId(client: PoolClient): Promise<string> {
  const databaseId = await getSystemSettingsDatabaseId(client);
  const { rows } = await client.query<{ id: string }>(`SELECT id FROM items WHERE database_id = $1 LIMIT 1`, [
    databaseId,
  ]);
  if (!rows[0]) throw new NotFoundError("System settings row has not been seeded");
  return rows[0].id;
}

export async function getSystemTimezone(client: Queryable): Promise<string> {
  const databaseId = await getSystemSettingsDatabaseId(client).catch((err) => {
    if (err instanceof NotFoundError) return null; // system not seeded yet (e.g. a bare test pool) — fall back to the default below
    throw err;
  });
  if (databaseId === null) return DEFAULT_TIMEZONE;

  const { rows } = await client.query<{ properties: Record<string, unknown> }>(
    `SELECT properties FROM items WHERE database_id = $1 LIMIT 1`,
    [databaseId],
  );
  if (!rows[0]) return DEFAULT_TIMEZONE;
  return toSettingsProperties(rows[0].properties).timezone ?? DEFAULT_TIMEZONE;
}

type SettingsProperties = { timezone?: string };

/**
 * Validates the settings row's JSONB `properties` at the read boundary instead of trusting the row
 * type: `timezone` is narrowed to a string, and a present value that is not a string throws.
 */
function toSettingsProperties(raw: Record<string, unknown>): SettingsProperties {
  const timezone = typeof raw.timezone === "string" ? raw.timezone : undefined;
  assertShape(timezone === raw.timezone, "system settings properties");
  return { timezone };
}
