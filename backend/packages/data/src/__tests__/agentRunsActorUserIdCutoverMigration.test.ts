import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAgentRunsActorUserIdCutoverMigration } from "../agentRuns/agentRunsActorUserIdCutoverMigration.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { createTestTenant, getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const TASK = "cutover test";

let adminPool: Pool;

/** Writes a run raw: a NULL actor is the pre-cutover state the production store no longer produces. */
async function insertRun(tenantId: string, actorUserId: string | null, parentRunId: string | null): Promise<string> {
  const { rows } = await adminPool.query<{ id: string }>(
    `INSERT INTO agent_runs (tenant_id, triggered_by, task, actor_user_id, parent_run_id)
     VALUES ($1, 'user', $2, $3, $4) RETURNING id`,
    [tenantId, TASK, actorUserId, parentRunId],
  );
  const row = rows[0];
  if (!row) throw new Error("insertRun: INSERT INTO agent_runs returned no row");
  return row.id;
}

async function insertRootRun(tenantId: string, actorUserId: string | null): Promise<string> {
  return insertRun(tenantId, actorUserId, null);
}

async function readActor(runId: string): Promise<string | null> {
  const { rows } = await adminPool.query<{ actor_user_id: string | null }>(
    `SELECT actor_user_id FROM agent_runs WHERE id = $1`,
    [runId],
  );
  const row = rows[0];
  if (!row) throw new Error(`readActor: no agent_runs row ${runId}`);
  return row.actor_user_id;
}

async function isNullable(): Promise<boolean> {
  const { rows } = await adminPool.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'agent_runs' AND column_name = 'actor_user_id'`,
  );
  return rows[0]?.is_nullable === "YES";
}

/**
 * The tenant-consistent twins of issue #1066, which did not exist before the cutover: with them, a
 * run's actor and parent must belong to the run's own tenant, so the cross-tenant states the
 * cutover has to handle could not be stored.
 */
const PRE_CUTOVER_ABSENT_CONSTRAINTS = ["agent_runs_actor_user_id_tenant_fkey", "agent_runs_parent_run_id_tenant_fkey"];

/**
 * Recreates the pre-cutover schema for the case: the column is nullable and the #1066 twins are
 * absent. `finally` deletes the rows the case inserted, then restores NOT NULL and re-adds each
 * twin from its own catalog definition, so a failing case cannot leave the shared test database
 * weakened.
 */
async function withNullableActorColumn(run: () => Promise<void>): Promise<void> {
  // Owner-pool DDL: the cutover's pre-condition is the pre-cutover schema, which only a test can set up.
  const { rows: twins } = await adminPool.query<{ name: string; definition: string }>(
    `SELECT conname::text AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid = 'agent_runs'::regclass AND conname = ANY($1::text[]) ORDER BY conname`,
    [PRE_CUTOVER_ABSENT_CONSTRAINTS],
  );
  expect(twins.map((twin) => twin.name)).toEqual([...PRE_CUTOVER_ABSENT_CONSTRAINTS].sort());
  await adminPool.query(`ALTER TABLE agent_runs ALTER COLUMN actor_user_id DROP NOT NULL`);
  // Names and definitions come from pg_constraint, never from input; ALTER TABLE takes no bind parameters.
  for (const twin of twins) await adminPool.query(`ALTER TABLE agent_runs DROP CONSTRAINT ${twin.name}`);
  try {
    await run();
  } finally {
    await adminPool.query(`DELETE FROM agent_runs WHERE task = $1`, [TASK]);
    await adminPool.query(`ALTER TABLE agent_runs ALTER COLUMN actor_user_id SET NOT NULL`);
    for (const twin of twins) {
      await adminPool.query(`ALTER TABLE agent_runs ADD CONSTRAINT ${twin.name} ${twin.definition}`);
    }
  }
}

describe("agent_runs.actor_user_id cutover (per-tenant backfill)", () => {
  beforeAll(() => {
    adminPool = getTestPool();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
  });

  afterAll(async () => {
    await adminPool.end();
  });

  it("attributes each root run to the user of its own tenant, not the earliest-created account", async () => {
    await withNullableActorColumn(async () => {
      // Tenant zero's user is created first, so it is the earliest account overall: the old
      // earliest-account fallback would have attributed tenant B's run to it.
      const zeroUser = await createUser(adminPool, {
        email: "zero@example.test",
        passwordHash: await hashPassword("s3cret-password"),
        tenantId: getTenantZeroId(),
      });
      const tenantB = await createTestTenant(adminPool);
      const bUser = await createUser(adminPool, {
        email: "b@example.test",
        passwordHash: await hashPassword("s3cret-password"),
        tenantId: tenantB,
      });

      const zeroRun = await insertRootRun(getTenantZeroId(), null);
      const bRun = await insertRootRun(tenantB, null);

      await runAgentRunsActorUserIdCutoverMigration(adminPool);

      expect(await readActor(zeroRun)).toBe(zeroUser.id);
      expect(await readActor(bRun)).toBe(bUser.id);
      expect(await isNullable()).toBe(false);
    });
  });

  it("throws and rolls back when a NULL-actor root run belongs to a tenant with no user", async () => {
    await withNullableActorColumn(async () => {
      await createUser(adminPool, {
        email: "zero@example.test",
        passwordHash: await hashPassword("s3cret-password"),
        tenantId: getTenantZeroId(),
      });
      const tenantWithoutUser = await createTestTenant(adminPool);

      const zeroRun = await insertRootRun(getTenantZeroId(), null);
      const orphanRun = await insertRootRun(tenantWithoutUser, null);

      await expect(runAgentRunsActorUserIdCutoverMigration(adminPool)).rejects.toThrow(
        "Cannot backfill agent_runs.actor_user_id: rows exist whose tenant has no user",
      );

      // The transaction rolled back, so the tenant that has a user was not written either.
      expect(await readActor(zeroRun)).toBeNull();
      expect(await readActor(orphanRun)).toBeNull();
      expect(await isNullable()).toBe(true);
    });
  });

  it("propagates a root's actor down its delegated chain before the per-tenant fallback", async () => {
    await withNullableActorColumn(async () => {
      const tenantB = await createTestTenant(adminPool);
      const bUser = await createUser(adminPool, {
        email: "b@example.test",
        passwordHash: await hashPassword("s3cret-password"),
        tenantId: tenantB,
      });
      const tenantC = await createTestTenant(adminPool);
      const cUser = await createUser(adminPool, {
        email: "c@example.test",
        passwordHash: await hashPassword("s3cret-password"),
        tenantId: tenantC,
      });

      // The attributed root's actor is deliberately not tenant B's user, so a child that took the
      // per-tenant fallback instead of the parent-chain pass would read bUser, not cUser.
      const attributedRoot = await insertRun(tenantB, cUser.id, null);
      const child = await insertRun(tenantB, null, attributedRoot);
      const grandchild = await insertRun(tenantB, null, child);
      // A delegated run under a root with no actor is left NULL by the parent-chain pass and takes
      // its own tenant's user, as its root does.
      const unattributedRoot = await insertRun(tenantB, null, null);
      const orphanedChild = await insertRun(tenantB, null, unattributedRoot);

      await runAgentRunsActorUserIdCutoverMigration(adminPool);

      expect(await readActor(child)).toBe(cUser.id);
      expect(await readActor(grandchild)).toBe(cUser.id);
      expect(await readActor(unattributedRoot)).toBe(bUser.id);
      expect(await readActor(orphanedChild)).toBe(bUser.id);
      expect(await isNullable()).toBe(false);
    });
  });

  it("does not propagate an actor from a parent run in another tenant", async () => {
    await withNullableActorColumn(async () => {
      const tenantB = await createTestTenant(adminPool);
      const bUser = await createUser(adminPool, {
        email: "b@example.test",
        passwordHash: await hashPassword("s3cret-password"),
        tenantId: tenantB,
      });
      const tenantC = await createTestTenant(adminPool);
      const cUser = await createUser(adminPool, {
        email: "c@example.test",
        passwordHash: await hashPassword("s3cret-password"),
        tenantId: tenantC,
      });

      // Before #1066 `parent_run_id` carried no tenant in its foreign key, so a parent in another
      // tenant was storable; the parent-chain pass must not hand tenant C's user to tenant B's child.
      const foreignParent = await insertRun(tenantC, cUser.id, null);
      const child = await insertRun(tenantB, null, foreignParent);

      await runAgentRunsActorUserIdCutoverMigration(adminPool);

      expect(await readActor(child)).toBe(bUser.id);
      expect(await readActor(foreignParent)).toBe(cUser.id);
      expect(await isNullable()).toBe(false);
    });
  });

  it("returns before issuing any write when actor_user_id is already NOT NULL", async () => {
    const zeroUser = await createUser(adminPool, {
      email: "zero@example.test",
      passwordHash: await hashPassword("s3cret-password"),
      tenantId: getTenantZeroId(),
    });
    const run = await insertRootRun(getTenantZeroId(), zeroUser.id);
    expect(await isNullable()).toBe(false);

    // A statement-level trigger fires even for an UPDATE that matches no row, so the cutover fails
    // here unless its idempotency check returns before the backfill statements.
    await adminPool.query(`
      CREATE OR REPLACE FUNCTION test_reject_agent_runs_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'cutover issued an UPDATE on agent_runs';
      END $$`);
    await adminPool.query(
      "CREATE TRIGGER test_reject_agent_runs_update BEFORE UPDATE ON agent_runs FOR EACH STATEMENT EXECUTE FUNCTION test_reject_agent_runs_update()",
    );
    try {
      await expect(runAgentRunsActorUserIdCutoverMigration(adminPool)).resolves.toBeUndefined();
    } finally {
      await adminPool.query("DROP TRIGGER test_reject_agent_runs_update ON agent_runs");
      await adminPool.query("DROP FUNCTION test_reject_agent_runs_update()");
    }

    expect(await readActor(run)).toBe(zeroUser.id);
    expect(await isNullable()).toBe(false);
  });
});
