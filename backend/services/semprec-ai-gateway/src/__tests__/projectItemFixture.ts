import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createChokePoint, seedSystem } from "@semprec/data";

/**
 * Seeds the system databases (when `seed` is set) and creates a real Projects item in whatever
 * tenant scope the caller is in, so `reserveGatewayCall`'s attribution guard finds it. Returns its id.
 */
export async function createProjectItem(pool: Pool, options: { seed?: boolean } = {}): Promise<string> {
  if (options.seed) await seedSystem(pool);
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM databases WHERE owner_module_id = 'projects' AND system",
  );
  const databaseId = rows[0]?.id;
  if (!databaseId) throw new Error("Projects database was not seeded");
  const item = await createChokePoint(pool).createItem({
    databaseId,
    properties: { name: `Project ${randomUUID()}` },
  });
  return item.id;
}
