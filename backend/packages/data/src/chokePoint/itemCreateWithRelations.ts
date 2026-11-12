import type { PoolClient } from "pg";
import { ValidationError } from "../errors.js";
import { withTransaction } from "../db/pool.js";
import type { ItemRow } from "../types.js";
import type { ChokePointDeps } from "./chokePointDeps.js";
import { projectItemsForRead } from "./itemReadProjection.js";
import { createItemReportingReplay, type CreateItemInput, type CreateItemWithClientOptions } from "./itemWrites.js";
import { createRelationWithClient } from "./relationOps.js";
import { assertRelationPropertyWritable } from "./relationEdgeContext.js";
import * as propertiesStore from "./propertiesStore.js";
import * as relationsStore from "./relationsStore.js";
import type { WriterIdentity } from "./writerKind.js";

export type InitialItemRelation =
  { kind: "resolved"; relationPropertyId: string; targetItemIds: string[] } | { kind: "unresolved" };

/**
 * Creates an item and the edges of `input.relations` on the caller's client. The item is inserted and its
 * create hooks run first; the hooks are given the resolved relations as `initialRelations`
 * (docs/adr/2026-11-12-create-hooks-are-given-the-initial-relations-of-their-create.md). The relations are
 * checked and written after the hooks returned, and the first one that is refused throws. An
 * idempotency-key replay returns the stored item and writes no edge.
 */
export async function createItemWithRelationsWithClient(
  client: PoolClient,
  input: CreateItemInput & { relations: InitialItemRelation[] },
  options: CreateItemWithClientOptions = {},
): Promise<ItemRow> {
  const { item, created } = await createItemReportingReplay(
    client,
    input,
    options,
    input.relations.filter((relation) => relation.kind === "resolved"),
  );
  if (!created) return item;
  for (const relation of input.relations) {
    if (relation.kind === "unresolved") throw new ValidationError("Unknown relation property", { field: "relations" });
    const property = await propertiesStore.getProperty(client, relation.relationPropertyId);
    const definition = await relationsStore.getRelationDefinitionByPropertyId(client, relation.relationPropertyId);
    if (!property || property.databaseId !== input.databaseId || property.type !== "relation" || !definition)
      throw new ValidationError("Invalid initial relation", { field: "relations" });
    assertRelationPropertyWritable(property, undefined);
    const single =
      definition.cardinality === "one_to_one" ||
      (definition.cardinality === "one_to_many" && definition.propertyIdB === property.id);
    if (single && relation.targetItemIds.length !== 1)
      throw new ValidationError("Single-valued relation requires one target", { field: "relations" });
    for (const targetItemId of relation.targetItemIds) {
      await createRelationWithClient(
        client,
        {
          relationPropertyId: relation.relationPropertyId,
          callerItemId: item.id,
          targetItemId,
        },
        undefined,
        options.writer,
        options.actingUserId,
      );
    }
  }
  return item;
}

export function createItemWithRelationsOps(deps: Pick<ChokePointDeps, "pool" | "queueAffinity">) {
  const { pool, queueAffinity } = deps;
  return {
    async createItemWithRelations(
      input: CreateItemInput & { relations: InitialItemRelation[] },
      actingUserId?: string,
      humanWriterUserId?: string,
      writer?: WriterIdentity,
    ): Promise<ItemRow> {
      return withTransaction(pool, async (client) => {
        const item = await createItemWithRelationsWithClient(client, input, {
          queueAffinity,
          actingUserId,
          humanWriterUserId,
          writer,
        });
        return (await projectItemsForRead(client, [item]))[0]!;
      });
    },
  };
}
