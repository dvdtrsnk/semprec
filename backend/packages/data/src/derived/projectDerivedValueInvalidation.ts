// Issue #1710: the queued fan-out that announces a project's items after the project's area or company
// changed. Those items show the area, and an Event the company, as a derived value read through the project
// (`derivedValueReads.ts`); the change writes none of them, so each gets a thin `item` invalidation and
// clients refetch. The job only reads, so it takes no row lock. It pages through the items in id order, one
// transaction per batch (the keyset pages of
// docs/adr/2026-09-28-chunked-transactions-for-large-background-sweeps.md, without a cap on the number of
// batches: a run pages until a batch comes back short), and announces a batch's items once that batch has
// committed (docs/adr/2026-09-10-side-effects-follow-the-commit.md).
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

/** A project relation of `DERIVED_VALUE_SOURCES` resolved in the current tenant. */
interface SourceRelation {
  relationDefinitionId: string;
  /** The system database whose items the relation links to their projects. */
  databaseId: string;
  /** `a` when the database's project property is side A of the definition, so the project is `item_b`. */
  itemSide: "a" | "b";
}

/**
 * The current tenant's relations behind the project properties of `DERIVED_VALUE_SOURCES`. A database or
 * property the tenant does not have is simply absent. Row-level security and the explicit tenant filter
 * confine the read to the current tenant.
 */
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

/**
 * One batch in its own transaction: the next `BATCH_SIZE` live items linked to the project through a source
 * relation, in id order after `afterItemId`, each announced once the transaction has committed. Returns the
 * ids it queued for announcement; none when the project is missing or in the Trash.
 */
async function announceBatch(pool: Pool, projectItemId: string, afterItemId: string | null): Promise<string[]> {
  return withTransaction(pool, async (client) => {
    const [project] = await getItemsByIds(client, [projectItemId]);
    if (!project) return [];
    const relations = await listSourceRelations(client);
    // Each configured database has one project property, so an item has at most one edge to the project
    // among these definitions and appears once.
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

/**
 * `derivedValuesInvalidate`: runs in the job envelope's tenant and announces every live item linked to the
 * project through a `DERIVED_VALUE_SOURCES` relation, batch by batch until a batch comes back short. The
 * job writes nothing and keeps no cursor between runs: a batch that throws fails the job, the batches before
 * it stay announced, and the retry starts again from the first item, so an item can be announced more than
 * once.
 */
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
