import type { PoolClient } from "pg";
import { NotFoundError } from "./errors.js";
import { requireSingleRow } from "./db/pool.js";
import { createRelationWithClient, deleteRelationWithClient } from "./chokePoint/relationOps.js";
import { SYSTEM_WRITER, type WriterIdentity } from "./chokePoint/writerKind.js";

/** Reads only live People targets; missing seed/schema and a trashed target both mean unset. */
export async function getSelfPersonId(client: PoolClient): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT person.id FROM databases settings
     JOIN items singleton ON singleton.database_id = settings.id AND singleton.deleted_at IS NULL
     JOIN properties p ON p.database_id = settings.id AND p.key = 'selfPerson'
     JOIN relation_definitions rd ON rd.property_id_a = p.id
     JOIN item_relations edge ON edge.relation_definition_id = rd.id AND edge.item_a = singleton.id
     JOIN items person ON person.id = edge.item_b AND person.deleted_at IS NULL
     JOIN databases people ON people.id = person.database_id AND people.owner_module_id = 'people'
     WHERE settings.owner_module_id = 'systemSettings' AND settings.system = true`,
  );
  return rows[0]?.id ?? null;
}

/** Replaces the singleton's edge inside the caller's tenant transaction, through relation writes. */
export async function setSelfPersonId(
  client: PoolClient,
  personId: string | null,
  writer: WriterIdentity = SYSTEM_WRITER,
  actingUserId?: string,
): Promise<void> {
  // The singleton row serializes replacements, including two concurrent requests with no edge yet.
  const { rows } = await client.query<{ item_id: string; property_id: string; definition_id: string }>(
    `SELECT singleton.id AS item_id, p.id AS property_id, rd.id AS definition_id
     FROM databases settings
     JOIN items singleton ON singleton.database_id = settings.id AND singleton.deleted_at IS NULL
     JOIN properties p ON p.database_id = settings.id AND p.key = 'selfPerson'
     JOIN relation_definitions rd ON rd.property_id_a = p.id
     WHERE settings.owner_module_id = 'systemSettings' AND settings.system = true
     FOR UPDATE OF singleton`,
  );
  const settings = requireSingleRow(rows, "System settings.selfPerson");
  if (personId !== null) {
    const target = await client.query<{ id: string }>(
      `SELECT person.id FROM items person JOIN databases people ON people.id = person.database_id
       WHERE people.owner_module_id = 'people' AND person.id = $1 AND person.deleted_at IS NULL
       FOR UPDATE OF person`,
      [personId],
    );
    if (!target.rows[0]) throw new NotFoundError("Person not found");
  }
  const existing = await client.query<{ item_b: string }>(
    `SELECT item_b FROM item_relations WHERE relation_definition_id = $1 AND item_a = $2`,
    [settings.definition_id, settings.item_id],
  );
  for (const edge of existing.rows) {
    await deleteRelationWithClient(
      client,
      {
        relationPropertyId: settings.property_id,
        callerItemId: settings.item_id,
        targetItemId: edge.item_b,
      },
      undefined,
      writer,
      actingUserId,
    );
  }
  if (personId !== null) {
    await createRelationWithClient(
      client,
      {
        relationPropertyId: settings.property_id,
        callerItemId: settings.item_id,
        targetItemId: personId,
      },
      undefined,
      writer,
      actingUserId,
    );
  }
}
