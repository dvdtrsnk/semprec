import { DatabaseError, type PoolClient } from "pg";
import { markManagedTransactionRollbackOnly, requireManagedTransaction } from "../db/pool.js";
import { ConflictError } from "../errors.js";
import type { PropertyRow } from "../types.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import * as databasesStore from "./databasesStore.js";
import * as itemsStore from "./itemsStore.js";
import * as propertiesStore from "./propertiesStore.js";
import * as relationsStore from "./relationsStore.js";
import type { RelationEdgeContext } from "./relationEdgeContext.js";

function busy(): ConflictError {
  return new ConflictError("Derived relation inputs are busy", { reason: "resource_busy" });
}

export async function reserveDerivedValueInputs(
  client: PoolClient,
  manual: RelationEdgeContext,
  sides: Array<{ itemId: string; databaseKey: string; property: PropertyRow; projectContext: RelationEdgeContext }>,
): Promise<void> {
  requireManagedTransaction(client);
  const isolation = await client.query<{ isolation: string }>(
    "SELECT current_setting('transaction_isolation') AS isolation",
  );
  if (isolation.rows[0]?.isolation !== "read committed") {
    const error = new ConflictError("Derived relation requires READ COMMITTED", { reason: "unsupported_isolation" });
    markManagedTransactionRollbackOnly(client, error);
    throw error;
  }
  try {
    const contexts = [manual, ...sides.map((side) => side.projectContext)];
    const definitions = [...new Set(contexts.map((context) => context.reldef.id))].sort();
    for (const id of definitions) if (!(await relationsStore.tryLockRelationDefinition(client, id))) throw busy();
    const properties = [
      ...new Set(
        contexts.flatMap((context) =>
          [context.reldef.propertyIdA, context.reldef.propertyIdB].filter((id): id is string => id !== null),
        ),
      ),
    ].sort();
    const databases = [
      ...new Set(contexts.flatMap((context) => [context.property.databaseId, context.targetDatabaseId])),
    ].sort();
    const propertyLocks = await client.query<{ id: string }>(
      "SELECT id FROM properties WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE NOWAIT",
      [properties],
    );
    const definitionLocks = await client.query<{ id: string }>(
      "SELECT id FROM relation_definitions WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE NOWAIT",
      [definitions],
    );
    const databaseLocks = await client.query<{ id: string }>(
      "SELECT id FROM databases WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE NOWAIT",
      [databases],
    );
    if (
      propertyLocks.rows.length !== properties.length ||
      definitionLocks.rows.length !== definitions.length ||
      databaseLocks.rows.length !== databases.length
    )
      throw busy();
    for (const initial of contexts) {
      const property = await propertiesStore.getProperty(client, initial.property.id);
      const definition = await relationsStore.getRelationDefinition(client, initial.reldef.id);
      if (
        JSON.stringify(property) !== JSON.stringify(initial.property) ||
        JSON.stringify(definition) !== JSON.stringify(initial.reldef)
      )
        throw busy();
    }
    for (const side of sides) {
      const database = await databasesStore.getDatabase(client, side.projectContext.property.databaseId);
      const projectDatabase = await databasesStore.getDatabase(client, side.projectContext.targetDatabaseId);
      const property = await propertiesStore.getProperty(client, side.property.id);
      if (
        !database ||
        database.key !== side.databaseKey ||
        !projectDatabase?.system ||
        projectDatabase.ownerModuleId !== PROJECTS_MODULE_ID ||
        JSON.stringify(property) !== JSON.stringify(side.property)
      )
        throw busy();
    }
    const guardedItems = [...sides].sort(
      (a, b) =>
        a.projectContext.property.databaseId.localeCompare(b.projectContext.property.databaseId) ||
        a.itemId.localeCompare(b.itemId),
    );
    for (const side of guardedItems) {
      const item = await itemsStore.lockItemByIdNowait(client, side.projectContext.property.databaseId, side.itemId);
      if (!item || item.deletedAt) throw busy();
    }
    const projectItems: Array<{ databaseId: string; id: string }> = [];
    for (const side of guardedItems) {
      const context = side.projectContext;
      const sideA = context.reldef.propertyIdA === context.property.id;
      const edges = await relationsStore.lockRelationSnapshotEdgesNowait(
        client,
        context.reldef.id,
        side.itemId,
        sideA ? "a" : "b",
      );
      for (const edge of edges)
        projectItems.push({ databaseId: context.targetDatabaseId, id: sideA ? edge.itemB : edge.itemA });
    }
    const seen = new Set<string>();
    for (const item of projectItems.sort(
      (a, b) => a.databaseId.localeCompare(b.databaseId) || a.id.localeCompare(b.id),
    )) {
      const key = JSON.stringify([item.databaseId, item.id]);
      if (!seen.has(key)) await itemsStore.lockItemByIdNowait(client, item.databaseId, item.id);
      seen.add(key);
    }
  } catch (error) {
    const failure = error instanceof DatabaseError && error.code === "55P03" ? busy() : error;
    if (failure instanceof ConflictError) markManagedTransactionRollbackOnly(client, failure);
    throw failure;
  }
}
