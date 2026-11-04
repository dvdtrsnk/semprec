import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { CardinalityViolationError, ValidationError } from "../errors.js";
import { withTransaction } from "../db/pool.js";

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
   * is made deterministic by holding the trigger's existing advisory lock in X and observing
   * Y's backend blocked by X before allowing X to insert and commit. Both transactions use the
   * managed owner required by after-commit effects.
   */
  async function assertLosesRaceOnConflict(input: {
    relationDefinitionId: string;
    winner: { relationPropertyId: string; callerItemId: string; targetItemId: string };
    loser: { relationPropertyId: string; callerItemId: string; targetItemId: string };
  }): Promise<void> {
    let winnerPid: number | undefined;
    let loserPid: number | undefined;
    let releaseWinner = () => {};
    const winnerGate = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    const winner = withTransaction(pool, async (client) => {
      await client.query("SET LOCAL statement_timeout = '15s'");
      const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const pid = rows[0]?.pid;
      if (pid === undefined) throw new Error("Missing winner backend PID");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.relationDefinitionId]);
      winnerPid = pid;
      await winnerGate;
      return createRelationWithClient(client, input.winner);
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let loser: Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> | undefined;
    let primary: { error: unknown } | undefined;
    try {
      await vi.waitFor(() => expect(winnerPid).toBeTypeOf("number"), { timeout: 5_000 });
      loser = withTransaction(pool, async (client) => {
        await client.query("SET LOCAL statement_timeout = '15s'");
        const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const pid = rows[0]?.pid;
        if (pid === undefined) throw new Error("Missing contender backend PID");
        loserPid = pid;
        return createRelationWithClient(client, input.loser);
      }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await vi.waitFor(
        async () => {
          if (winnerPid === undefined || loserPid === undefined) throw new Error("Waiting for both backend PIDs");
          const { rows } = await pool.query<{ blocked: boolean }>(
            "SELECT $1::integer = ANY(pg_blocking_pids($2::integer)) AS blocked",
            [winnerPid, loserPid],
          );
          expect(rows).toEqual([{ blocked: true }]);
        },
        { timeout: 5_000 },
      );
    } catch (error) {
      primary = { error };
    } finally {
      releaseWinner();
    }
    const winnerResult = await winner;
    const loserResult = loser ? await loser : undefined;
    const unexpectedLoser = loserResult && !loserResult.ok && !(loserResult.error instanceof CardinalityViolationError);
    const describeError = (error: unknown) => (error instanceof Error ? error.name : typeof error);
    if (primary) {
      if (!winnerResult.ok || unexpectedLoser)
        console.error("A concurrent relation fixture also failed during settlement", {
          winner: winnerResult.ok ? null : describeError(winnerResult.error),
          loser: unexpectedLoser && loserResult && !loserResult.ok ? describeError(loserResult.error) : null,
        });
      throw primary.error;
    }
    if (!winnerResult.ok) {
      if (unexpectedLoser && loserResult && !loserResult.ok)
        console.error("The contender also failed during settlement", { error: describeError(loserResult.error) });
      throw winnerResult.error;
    }
    expect(winnerResult.value).toBeDefined();
    if (!loserResult) throw new Error("Contender did not start");
    if (loserResult.ok) throw new Error("Contender unexpectedly succeeded");
    expect(loserResult.error).toBeInstanceOf(CardinalityViolationError);
    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM item_relations WHERE relation_definition_id = $1",
      [input.relationDefinitionId],
    );
    expect(rows).toEqual([{ n: 1 }]);
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

  it("under concurrency, a losing racer against a one_to_one conflict (same item_a, different item_b) is rejected, not silently corrupted", async () => {
    const { property, a1, b1, b2 } = await makeRelation("one_to_one");
    await assertLosesRaceOnConflict({
      relationDefinitionId: (property.config as { relationDefinitionId: string }).relationDefinitionId,
      winner: { relationPropertyId: property.id, callerItemId: a1.id, targetItemId: b1.id },
      loser: { relationPropertyId: property.id, callerItemId: a1.id, targetItemId: b2.id },
    });
  });
});
