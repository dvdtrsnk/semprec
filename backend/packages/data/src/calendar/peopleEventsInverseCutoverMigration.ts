import type { Pool } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { requireAffectedRows, requireSingleRow, withTransaction } from "../db/pool.js";
import { EVENTS_MODULE_ID, PEOPLE_MODULE_ID } from "../seed/tenDatabaseKeys.js";

const definitionRow = z.object({ id: z.string(), property_id_b: z.string().nullable() });

/**
 * Per-tenant cutover of issue #1664: gives the existing `Events.people` relation its inverse `People.events`, the
 * shape `seedTenDatabases.ts` now creates for a fresh tenant. People and Events are `schema_locked`, and a relation's
 * inverse is fixed when it is created, so the API cannot add it; this step writes the People property and points the
 * existing definition's `property_id_b` at it with SQL, mirroring `transcriptsCatalogCutoverMigration.ts`. The
 * participant edges in `item_relations` are keyed by the definition and are not touched, so every existing edge reads
 * from the person's side as soon as this commits.
 *
 * A no-op when the tenant has no Events or People database, no `Events.people` property or relation definition, or
 * when the definition already points at `People.events`; a second run therefore changes nothing. A `People.events`
 * property that exists without being this definition's inverse, or a definition whose inverse is another property,
 * is a schema this step does not know how to reconcile and fails the tenant's cutover instead of guessing.
 *
 * Runs once per tenant, in that tenant's scope and under row-level security, via `runTenantCutoverMigrations`.
 */
export async function runPeopleEventsInverseCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
    const people = await getDatabaseByModuleId(client, PEOPLE_MODULE_ID);
    if (!events || !people) return;

    // Blocks concurrent writes to `properties` (and other lockers of a mode EXCLUSIVE conflicts with) until this
    // transaction ends. Ordinary reads (ACCESS SHARE) continue; they see neither change until this transaction commits,
    // and then the `People.events` property and the definition pointing at it are committed together.
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");

    const { rows: sourceRows } = await client.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = 'people' AND type = 'relation'",
      [events.id],
    );
    const source = sourceRows[0];
    if (!source) return;
    const { rows: definitionRows } = await client.query<Record<string, unknown>>(
      "SELECT id, property_id_b FROM relation_definitions WHERE property_id_a = $1",
      [source.id],
    );
    if (!definitionRows[0]) return;
    const definition = definitionRow.parse(definitionRows[0]);

    const { rows: inverseRows } = await client.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = 'events'",
      [people.id],
    );
    const existing = inverseRows[0];
    if (existing && definition.property_id_b === existing.id) return;
    if (existing) throw new Error("People.events exists but is not the inverse of Events.people");
    if (definition.property_id_b !== null) throw new Error("Events.people already has another inverse property");

    // `name` is NULL like the seed's (`relate` passes `name: null`); the label comes from the seed i18n catalogs.
    const { rows: propertyRows } = await client.query<{ id: string }>(
      `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
       VALUES ($1, 'events', NULL, 'relation', jsonb_build_object('relationDefinitionId', $2::uuid, 'targetDatabaseId', $3::uuid), false, 'user', NULL)
       RETURNING id`,
      [people.id, definition.id, events.id],
    );
    const inverseId = requireSingleRow(propertyRows, "People.events property").id;
    const pointed = await client.query(
      "UPDATE relation_definitions SET property_id_b = $2 WHERE id = $1 AND property_id_b IS NULL",
      [definition.id, inverseId],
    );
    requireAffectedRows(pointed, "Events.people relation definition inverse");
  });
}
