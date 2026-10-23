import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { ForbiddenError } from "../errors.js";

let pool: Pool;
let chokePoint: ChokePoint;

describe("choke-point relationOps", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function expectDatabaseArchived(promise: Promise<unknown>): Promise<void> {
    try {
      await promise;
      expect.unreachable("expected a database_archived ForbiddenError");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).code).toBe("database_archived");
    }
  }

  it("relation mutations are rejected once either side's database is archived, from either side of the pair", async () => {
    const a = await chokePoint.createDatabase({ name: "A" });
    const b = await chokePoint.createDatabase({ name: "B" });
    const { property } = await chokePoint.createRelationProperty({
      sourceDatabaseId: a.id,
      key: "bs",
      name: "Bs",
      targetDatabaseId: b.id,
    });
    const itemA1 = await chokePoint.createItem({ databaseId: a.id, properties: {} });
    const itemA2 = await chokePoint.createItem({ databaseId: a.id, properties: {} });
    const itemB = await chokePoint.createItem({ databaseId: b.id, properties: {} });
    await chokePoint.createRelation({
      relationPropertyId: property.id,
      callerItemId: itemA1.id,
      targetItemId: itemB.id,
    });

    await chokePoint.archiveDatabase(b.id);
    await expectDatabaseArchived(
      chokePoint.createRelation({ relationPropertyId: property.id, callerItemId: itemA2.id, targetItemId: itemB.id }),
    );
    await expectDatabaseArchived(
      chokePoint.updateRelation({
        relationPropertyId: property.id,
        callerItemId: itemA1.id,
        targetItemId: itemB.id,
        metadata: { x: 1 },
      }),
    );
    await expectDatabaseArchived(
      chokePoint.deleteRelation({ relationPropertyId: property.id, callerItemId: itemA1.id, targetItemId: itemB.id }),
    );

    await chokePoint.restoreDatabase(b.id);
    await chokePoint.archiveDatabase(a.id);
    await expectDatabaseArchived(
      chokePoint.createRelation({ relationPropertyId: property.id, callerItemId: itemA2.id, targetItemId: itemB.id }),
    );
    await expectDatabaseArchived(
      chokePoint.updateRelation({
        relationPropertyId: property.id,
        callerItemId: itemA1.id,
        targetItemId: itemB.id,
        metadata: { y: 2 },
      }),
    );
    await expectDatabaseArchived(
      chokePoint.deleteRelation({ relationPropertyId: property.id, callerItemId: itemA1.id, targetItemId: itemB.id }),
    );
  });
});
