import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, createRelationWithClient, type ChokePoint } from "../chokePoint/chokePoint.js";
import { CardinalityViolationError, ValidationError } from "../errors.js";

let pool: Pool;
let chokePoint: ChokePoint;

describe("relation cardinality enforcement (issue #82)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function makeRelation(cardinality: "one_to_one" | "one_to_many" | "many_to_many") {
    const source = await chokePoint.createDatabase({ name: `Source-${cardinality}-${randomUUID()}` });
    const target = await chokePoint.createDatabase({ name: `Target-${cardinality}-${randomUUID()}` });
    const { property } = await chokePoint.createRelationProperty({
      sourceDatabaseId: source.id,
      key: "rel",
      name: "Rel",
      targetDatabaseId: target.id,
      cardinality,
    });
    const a1 = await chokePoint.createItem({ databaseId: source.id, properties: {} });
    const a2 = await chokePoint.createItem({ databaseId: source.id, properties: {} });
    const b1 = await chokePoint.createItem({ databaseId: target.id, properties: {} });
    const b2 = await chokePoint.createItem({ databaseId: target.id, properties: {} });
    return { source, target, property, a1, a2, b1, b2 };
  }

  it("one_to_one: a second edge reusing either item_a or item_b is rejected; the identical edge stays idempotent", async () => {
    const { property, a1, a2, b1, b2 } = await makeRelation("one_to_one");

    await chokePoint.createRelation({ relationPropertyId: property.id, callerItemId: a1.id, targetItemId: b1.id });

    await expect(
      chokePoint.createRelation({ relationPropertyId: property.id, callerItemId: a1.id, targetItemId: b2.id }),
    ).rejects.toBeInstanceOf(CardinalityViolationError);

    await expect(
      chokePoint.createRelation({ relationPropertyId: property.id, callerItemId: a2.id, targetItemId: b1.id }),
    ).rejects.toBeInstanceOf(CardinalityViolationError);

    await expect(
      chokePoint.createRelation({
        relationPropertyId: property.id,
        callerItemId: a1.id,
        targetItemId: b1.id,
        metadata: { note: "same edge" },
      }),
    ).resolves.toBeDefined();
  });

  it("one_to_many: item_b gets at most one edge, but the same item_a may gain many item_b edges", async () => {
    const { property, a1, a2, b1, b2 } = await makeRelation("one_to_many");

    await chokePoint.createRelation({ relationPropertyId: property.id, callerItemId: a1.id, targetItemId: b1.id });

    await expect(
      chokePoint.createRelation({ relationPropertyId: property.id, callerItemId: a2.id, targetItemId: b1.id }),
    ).rejects.toBeInstanceOf(CardinalityViolationError);

    await expect(
      chokePoint.createRelation({ relationPropertyId: property.id, callerItemId: a1.id, targetItemId: b2.id }),
    ).resolves.toBeDefined();
  });

  it("many_to_many: both item_a and item_b may repeat freely", async () => {
    const { property, a1, a2, b1, b2 } = await makeRelation("many_to_many");

    await chokePoint.createRelation({ relationPropertyId: property.id, callerItemId: a1.id, targetItemId: b1.id });
    await expect(
      chokePoint.createRelation({ relationPropertyId: property.id, callerItemId: a1.id, targetItemId: b2.id }),
    ).resolves.toBeDefined();
    await expect(
      chokePoint.createRelation({ relationPropertyId: property.id, callerItemId: a2.id, targetItemId: b1.id }),
    ).resolves.toBeDefined();
  });

  it("rejects a nonexistent targetDatabaseId even for a one-directional relation property", async () => {
    const source = await chokePoint.createDatabase({ name: `OneWaySource-${randomUUID()}` });
    await expect(
      chokePoint.createRelationProperty({
        sourceDatabaseId: source.id,
        key: "rel",
        name: "Rel",
        targetDatabaseId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("a locked paired relation property has complete canonical config on both sides", async () => {
    const source = await chokePoint.createDatabase({ name: `LockedSource-${randomUUID()}` });
    const target = await chokePoint.createDatabase({ name: `LockedTarget-${randomUUID()}` });
    const { property, inverseProperty } = await chokePoint.createRelationProperty({
      sourceDatabaseId: source.id,
      key: "rel",
      name: "Rel",
      targetDatabaseId: target.id,
      cardinality: "one_to_many",
      locked: true,
      inverse: { key: "relInverse", name: "Rel inverse", locked: true },
    });

    expect(property.locked).toBe(true);
    expect(inverseProperty?.locked).toBe(true);
    expect(property.config).toEqual({ relationDefinitionId: expect.any(String), targetDatabaseId: target.id });
    expect(inverseProperty?.config).toEqual({
      relationDefinitionId: (property.config as { relationDefinitionId: string }).relationDefinitionId,
      targetDatabaseId: source.id,
    });
  });

  it("a locked one-way relation property has complete canonical config even with no inverse", async () => {
    const source = await chokePoint.createDatabase({ name: `OneWayLockedSource-${randomUUID()}` });
    const target = await chokePoint.createDatabase({ name: `OneWayLockedTarget-${randomUUID()}` });
    const { property, inverseProperty } = await chokePoint.createRelationProperty({
      sourceDatabaseId: source.id,
      key: "rel",
      name: "Rel",
      targetDatabaseId: target.id,
      locked: true,
    });

    expect(inverseProperty).toBeNull();
    expect(property.locked).toBe(true);
    expect(property.config).toEqual({ relationDefinitionId: expect.any(String), targetDatabaseId: target.id });
  });

  /**
   * Drives the exact race the trigger's advisory lock exists to prevent: two overlapping
   * transactions each inserting a conflicting edge for the same relation definition. Ordering
   * is made deterministic (not timing-dependent) by having `clientX` explicitly take the same
   * advisory lock the trigger itself uses (`pg_advisory_xact_lock(hashtextextended(...))`)
   * *before* `clientY`'s insert is even issued — X is then guaranteed to hold the lock when
   * Y's trigger tries to acquire it, so Y blocks until X commits or rolls back, regardless of
   * how fast either connection's earlier queries happen to run. X's own insert re-acquires the
   * same lock afterward, which succeeds immediately since Postgres advisory locks are
   * reentrant within one session/transaction.
   */
  async function assertLosesRaceOnConflict(input: {
    relationDefinitionId: string;
    winner: { relationPropertyId: string; callerItemId: string; targetItemId: string };
    loser: { relationPropertyId: string; callerItemId: string; targetItemId: string };
  }): Promise<void> {
    const clientX = await pool.connect();
    const clientY = await pool.connect();
    try {
      await clientX.query("BEGIN");
      await clientX.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.relationDefinitionId]);

      await clientY.query("BEGIN");
      const pendingY = createRelationWithClient(clientY, input.loser);

      // Each client's own transaction is closed in its own try/catch/finally — if an
      // assertion throws partway through, both clients still leave the pool with no open
      // transaction (node-postgres does not roll back on release), rather than X sitting
      // uncommitted or Y's already-failed INSERT leaving its aborted transaction unclosed.
      try {
        const resultX = await createRelationWithClient(clientX, input.winner);
        await clientX.query("COMMIT");
        expect(resultX).toBeDefined();
      } catch (err) {
        await clientX.query("ROLLBACK").catch(() => {});
        throw err;
      }

      try {
        await expect(pendingY).rejects.toBeInstanceOf(CardinalityViolationError);
      } finally {
        await clientY.query("ROLLBACK").catch(() => {});
      }

      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM item_relations WHERE relation_definition_id = $1",
        [input.relationDefinitionId],
      );
      expect(rows[0].n).toBe(1);
    } finally {
      clientX.release();
      clientY.release();
    }
  }

  it("under concurrency, a losing racer against a one_to_many conflict (same item_b, different item_a) is rejected, not silently corrupted", async () => {
    const { property, a1, a2, b1 } = await makeRelation("one_to_many");
    await assertLosesRaceOnConflict({
      relationDefinitionId: (property.config as { relationDefinitionId: string }).relationDefinitionId,
      winner: { relationPropertyId: property.id, callerItemId: a1.id, targetItemId: b1.id },
      loser: { relationPropertyId: property.id, callerItemId: a2.id, targetItemId: b1.id },
    });
  });

  it("under concurrency, a losing racer against a one_to_one conflict (same item_b, different item_a) is rejected, not silently corrupted", async () => {
    const { property, a1, a2, b1 } = await makeRelation("one_to_one");
    await assertLosesRaceOnConflict({
      relationDefinitionId: (property.config as { relationDefinitionId: string }).relationDefinitionId,
      winner: { relationPropertyId: property.id, callerItemId: a1.id, targetItemId: b1.id },
      loser: { relationPropertyId: property.id, callerItemId: a2.id, targetItemId: b1.id },
    });
  });
});
