// The public `createRelationProperty` facade over relationPropertyWrites.ts, re-exported from here.
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
     * Never passes a `SystemRelationWriteContext`, so an `owner: 'system'` side is always
     * `owner_violation`. A `reader` needs `write` on the source and the target database (the paired
     * property is created in the target), checked first.
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
