import type { PoolClient } from "pg";

export async function getKeptDate(client: PoolClient, itemId: string): Promise<unknown> {
  const { rows } = await client.query<{ kept_date: unknown }>(
    "SELECT kept_date FROM project_kept_dates WHERE item_id = $1",
    [itemId],
  );
  return rows[0]?.kept_date ?? null;
}

export async function upsertKeptDate(client: PoolClient, itemId: string, date: unknown): Promise<void> {
  await client.query(
    `INSERT INTO project_kept_dates (item_id, kept_date) VALUES ($1, $2::jsonb)
     ON CONFLICT (tenant_id, item_id) DO UPDATE SET kept_date = EXCLUDED.kept_date, updated_at = now()`,
    [itemId, JSON.stringify(date)],
  );
}

export async function deleteKeptDate(client: PoolClient, itemId: string): Promise<void> {
  await client.query("DELETE FROM project_kept_dates WHERE item_id = $1", [itemId]);
}
