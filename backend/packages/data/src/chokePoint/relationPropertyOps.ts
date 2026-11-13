// Owns the public `createRelationProperty` facade; the transaction-scoped creation of a paired relation
// property it wraps lives in relationPropertyWrites.ts and is re-exported from here.
// Relation edges (relationOps.ts), relation-edge context loading and guards (relationEdgeContext.ts)
// and deleting a relation property (propertyOps.ts) do not belong here.
// Constrained by: docs/adr/2026-09-10-choke-point-api-for-state-writes.md
import { runAfterCommit, withTransaction } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
import type { PropertyRow } from "../types.js";
import {
  createRelationPropertyWithClient,
  type CreateRelationPropertyInput,
  type RelationPropertySideInput,
} from "./relationPropertyWrites.js";
import type { ChokePointDeps } from "./chokePointDeps.js";
import { assertReaderDatabaseAccess, type DatabaseReader } from "../agentGrants/agentDatabaseAccess.js";
export { createRelationPropertyWithClient, type CreateRelationPropertyInput, type RelationPropertySideInput };

export function createRelationPropertyOps(deps: Pick<ChokePointDeps, "pool" | "computedKeyRegistry">) {
  const { pool, computedKeyRegistry } = deps;
  return {
    /**
     * Public facade: never passes a `SystemRelationWriteContext`, so an `owner: 'system'` side is always rejected (`owner_violation`).
     * An external client (a `reader`, issue #1998) needs `write` access to the source and the target database, because
     * the paired property is created in the target: checked first in this transaction.
     */
    async createRelationProperty(
      input: CreateRelationPropertyInput,
      actingUserId?: string,
      reader?: DatabaseReader,
    ): Promise<{ property: PropertyRow; inverseProperty: PropertyRow | null }> {
      return withTransaction(pool, async (client) => {
        if (reader !== undefined) {
          await assertReaderDatabaseAccess(client, reader, input.sourceDatabaseId, "write");
          await assertReaderDatabaseAccess(client, reader, input.targetDatabaseId, "write");
        }
        const result = await createRelationPropertyWithClient(client, input, undefined, computedKeyRegistry);
        const invalidatedDatabaseIds = new Set([result.property.databaseId]);
        if (result.inverseProperty) invalidatedDatabaseIds.add(result.inverseProperty.databaseId);
        runAfterCommit(client, () => {
          for (const databaseId of invalidatedDatabaseIds)
            notifyInvalidation({ scope: "schema", databaseId, userId: actingUserId });
        });
        return result;
      });
    },
  };
}
