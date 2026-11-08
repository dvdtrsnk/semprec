import type { Pool } from "pg";
import { requireAffectedRows, requireSingleRow, withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { PEOPLE_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { LAST_CONTACT_PROPERTY_KEY, enqueuePersonLastContactRecompute } from "./lastContact.js";

const RECOMPUTE_BATCH_SIZE = 500;

/**
 * Issue #1660's populated-tenant cutover for People `lastContact`. Runs once per tenant, in that tenant's
 * scope, via `runTenantCutoverMigrations`, after the People phones cutover.
 *
 * In one transaction under `LOCK TABLE properties IN EXCLUSIVE MODE` (as the Projects `completedAt` cutover
 * takes it) it adds the system-owned `date` property to the tenant's People database, or, when a `date`
 * property with that key already exists, hands it to the `people` owner process (`owner = 'system'`,
 * `owner_process = 'people'`) and keeps its name and config; the items' stored values change only through the
 * recompute queued below. An existing `lastContact` of any other type fails this tenant before anything is
 * written or queued. A tenant without a People database is
 * skipped. Afterwards a recompute is queued for every person not in the Trash, in committed batches; the
 * job key collapses a repeat, so a second run queues the same jobs again and creates no second property.
 */
export async function runPeopleLastContactCutoverMigration(pool: Pool): Promise<void> {
  const peopleDatabaseId = await withTransaction(pool, async (client) => {
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const people = await getDatabaseByModuleId(client, PEOPLE_MODULE_ID);
    if (!people) return null;
    const existing = await getPropertyByKey(client, people.id, LAST_CONTACT_PROPERTY_KEY);
    if (existing === null) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
         VALUES ($1, $2, NULL, 'date', '{}'::jsonb, false, 'system', $3) RETURNING id`,
        [people.id, LAST_CONTACT_PROPERTY_KEY, PEOPLE_MODULE_ID],
      );
      requireSingleRow(inserted.rows, "people lastContact property");
    } else if (existing.type !== "date") {
      throw new Error(`The People lastContact property has type '${existing.type}', not 'date'`);
    } else if (existing.owner !== "system" || existing.ownerProcess !== PEOPLE_MODULE_ID) {
      const handedOver = await client.query(
        "UPDATE properties SET owner = 'system', owner_process = $2 WHERE id = $1 AND database_id = $3",
        [existing.id, PEOPLE_MODULE_ID, people.id],
      );
      requireAffectedRows(handedOver, "people lastContact property ownership");
    }
    return people.id;
  });
  if (peopleDatabaseId === null) return;

  let afterId: string | null = null;
  for (;;) {
    const ids: string[] = await withTransaction(pool, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id > $2::uuid)
         ORDER BY id LIMIT $3`,
        [peopleDatabaseId, afterId, RECOMPUTE_BATCH_SIZE],
      );
      for (const row of rows) await enqueuePersonLastContactRecompute(client, row.id);
      return rows.map((row) => row.id);
    });
    const last = ids.at(-1);
    if (ids.length < RECOMPUTE_BATCH_SIZE || last === undefined) return;
    afterId = last;
  }
}
