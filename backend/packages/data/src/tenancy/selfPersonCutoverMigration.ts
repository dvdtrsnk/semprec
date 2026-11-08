import type { Pool } from "pg";
import { requireSingleRow, withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createRelationDefinition } from "../chokePoint/relationsStore.js";
import { lookupPersonIdByEmail } from "../mail/personEmailIndexStore.js";
import { getSelfPersonId, setSelfPersonId } from "../selfPerson.js";

/** Adds the locked singleton's relation schema and fills an unset link from this tenant's user. */
export async function runSelfPersonCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const settings = await getDatabaseByModuleId(client, "systemSettings");
    const people = await getDatabaseByModuleId(client, "people");
    if (!settings || !people) return;
    // Code-level schema migration, matching the other populated system-database cutovers.
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = 'selfPerson'",
      [settings.id],
    );
    if (!rows[0]) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO properties (database_id, key, name, type, config, locked, owner)
         VALUES ($1, 'selfPerson', NULL, 'relation', '{}'::jsonb, true, 'user') RETURNING id`,
        [settings.id],
      );
      const property = requireSingleRow(inserted.rows, "selfPerson property");
      const definition = await createRelationDefinition(client, {
        propertyIdA: property.id,
        cardinality: "one_to_one",
      });
      const updated = await client.query("UPDATE properties SET config = $2::jsonb WHERE id = $1", [
        property.id,
        JSON.stringify({ relationDefinitionId: definition.id, targetDatabaseId: people.id }),
      ]);
      if (updated.rowCount !== 1) throw new Error("selfPerson property disappeared during cutover");
    }
    // Same row lock as the endpoint, so filling cannot replace a concurrently chosen person.
    await client.query("SELECT id FROM items WHERE database_id = $1 FOR UPDATE", [settings.id]);
    if (await getSelfPersonId(client)) return;
    // users is global: explicitly confine this read to the active tenant (users.tenant_id is unique).
    const users = await client.query<{ email: string }>(
      "SELECT email FROM users WHERE tenant_id = app_current_tenant()",
    );
    if (!users.rows[0]) return;
    const personId = await lookupPersonIdByEmail(client, users.rows[0].email);
    if (personId === null) return;
    const live = await client.query<{ id: string }>(
      "SELECT id FROM items WHERE database_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE",
      [people.id, personId],
    );
    if (live.rows[0]) await setSelfPersonId(client, personId);
  });
}
