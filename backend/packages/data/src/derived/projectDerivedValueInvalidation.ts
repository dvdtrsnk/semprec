// Announces a project's items after its company changed: they show it as a derived value read through the
// project, and the change writes none of them. Read-only (no row locks); keyset pages, one transaction each, announced
// after each commits.
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { runAfterCommit, withTransaction } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
import { DERIVED_VALUE_SOURCES } from "./derivedValueSources.js";

const BATCH_SIZE = 100;

const payloadSchema = z.object({ projectItemId: z.uuid() }).strict();

const SOURCE_RELATION_ROW = z.object({
  relation_definition_id: z.string(),
  database_id: z.string(),
  item_is_a: z.boolean(),
});

interface SourceRelation {
  relationDefinitionId: string;
  databaseId: string;
  /** `a` when the database's project property is side A, so the project is `item_b`. */
  itemSide: "a" | "b";
}

async function listSourceRelations(client: PoolClient): Promise<SourceRelation[]> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT rd.id AS relation_definition_id, d.id AS database_id, rd.property_id_a = p.id AS item_is_a
     FROM properties p
     JOIN databases d ON d.tenant_id = p.tenant_id AND d.id = p.database_id AND d.system
     JOIN relation_definitions rd ON rd.tenant_id = p.tenant_id AND (rd.property_id_a = p.id OR rd.property_id_b = p.id)
     WHERE p.tenant_id = app_tenant_default() AND p.type = 'relation'
       AND (d.owner_module_id, p.key) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
    [
      DERIVED_VALUE_SOURCES.map((source) => source.databaseKey),
      DERIVED_VALUE_SOURCES.map((source) => source.projectPropertyKey),
    ],
  );
  return rows.map((raw) => {
    const row = SOURCE_RELATION_ROW.parse(raw);
    return {
      relationDefinitionId: row.relation_definition_id,
      databaseId: row.database_id,
      itemSide: row.item_is_a ? "a" : "b",
    };
  });
}

const RELATED_ITEM_ROW = z.object({ id: z.string(), database_id: z.string(), updated_at: z.date() });

async function announceBatch(pool: Pool, projectItemId: string, afterItemId: string | null): Promise<string[]> {
  return withTransaction(pool, async (client) => {
    const [project] = await getItemsByIds(client, [projectItemId]);
    if (!project) return [];
    const relations = await listSourceRelations(client);
    // One project property per database, so each item appears at most once.
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT i.id, i.database_id, i.updated_at
       FROM item_relations ir
       JOIN items i ON i.tenant_id = ir.tenant_id AND i.database_id = ANY($4::uuid[]) AND i.deleted_at IS NULL
         AND i.id = CASE WHEN ir.relation_definition_id = ANY($2::uuid[]) THEN ir.item_a ELSE ir.item_b END
       WHERE ir.tenant_id = app_tenant_default()
         AND ((ir.relation_definition_id = ANY($2::uuid[]) AND ir.item_b = $1)
           OR (ir.relation_definition_id = ANY($3::uuid[]) AND ir.item_a = $1))
         AND ($5::uuid IS NULL OR i.id > $5)
       ORDER BY i.id LIMIT $6`,
      [
        projectItemId,
        relations.filter((relation) => relation.itemSide === "a").map((relation) => relation.relationDefinitionId),
        relations.filter((relation) => relation.itemSide === "b").map((relation) => relation.relationDefinitionId),
        [...new Set(relations.map((relation) => relation.databaseId))],
        afterItemId,
        BATCH_SIZE,
      ],
    );
    const items = rows.map((raw) => RELATED_ITEM_ROW.parse(raw));
    for (const item of items) {
      runAfterCommit(client, () =>
        notifyInvalidation({
          scope: "item",
          databaseId: item.database_id,
          itemId: item.id,
          op: "update",
          updatedAt: item.updated_at.toISOString(),
        }),
      );
    }
    return items.map((item) => item.id);
  });
}

/** No cursor survives a failure: a retry restarts from the first item, so items may be announced twice. */
export async function handleDerivedValuesInvalidateTask(pool: Pool, rawPayload: unknown): Promise<void> {
  const { projectItemId } = payloadSchema.parse(rawPayload);
  let afterItemId: string | null = null;
  for (;;) {
    const announced: string[] = await announceBatch(pool, projectItemId, afterItemId);
    const last = announced.at(-1);
    if (announced.length < BATCH_SIZE || last === undefined) return;
    afterItemId = last;
  }
}
