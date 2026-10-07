import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import { createDatabase } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { handleHeartbeatSweepTask } from "../scheduler/sweep.js";
import { computeNextFireAt } from "../scheduler/nextFireAt.js";
import type { HeartbeatRule } from "../scheduler/rule.js";
import { logger } from "../tenancy/logger.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

const DAILY_RULE: HeartbeatRule = { kind: "dailyTime", at: "09:00" };

let adminPool: Pool;
let pool: Pool;
let tenantZero: string;
let tenantB: string;

/** Seeds the tenant's `systemSettings` database with one settings item carrying `timezone`. */
async function seedTimezone(tenantId: string, timezone: string): Promise<void> {
  await runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
      const db = await createDatabase(client, {
        name: `Settings ${tenantId}`,
        system: true,
        ownerModuleId: "systemSettings",
      });
      await client.query("INSERT INTO items (database_id, properties) VALUES ($1, $2::jsonb)", [
        db.id,
        JSON.stringify({ timezone }),
      ]);
    }),
  );
}

/** Inserts `count` due `dailyTime` heartbeats into the tenant; returns their ids. */
async function insertDueHeartbeats(tenantId: string, count: number): Promise<string[]> {
  return runInTenant(tenantId, async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO project_heartbeats (project_item_id, name, rule, action_id, enabled, next_fire_at)
       SELECT $1, 'Heartbeat ' || gs, $2::jsonb, 'noop', true, now() - interval '1 minute'
       FROM generate_series(1, $3) AS gs
       RETURNING id`,
      [randomUUID(), JSON.stringify(DAILY_RULE), count],
    );
    return rows.map((row) => row.id);
  });
}

interface HeartbeatState {
  id: string;
  tenant_id: string;
  due: boolean;
  next_fire_at: Date;
}

async function heartbeatStates(ids: string[]): Promise<HeartbeatState[]> {
  const { rows } = await adminPool.query<HeartbeatState>(
    "SELECT id, tenant_id, next_fire_at <= now() AS due, next_fire_at FROM project_heartbeats WHERE id = ANY($1) ORDER BY id",
    [ids],
  );
  return rows;
}

async function occurrencesOf(
  ids: string[],
): Promise<Array<{ id: string; heartbeat_id: string; tenant_id: string; status: string }>> {
  const { rows } = await adminPool.query<{ id: string; heartbeat_id: string; tenant_id: string; status: string }>(
    "SELECT id, heartbeat_id, tenant_id, status FROM heartbeat_occurrences WHERE heartbeat_id = ANY($1)",
    [ids],
  );
  return rows;
}

function sweep(maxChunksPerTenant?: number): Promise<void> {
  return runAsSystem("test", () =>
    handleHeartbeatSweepTask(pool, undefined, maxChunksPerTenant === undefined ? {} : { maxChunksPerTenant }),
  );
}

const fireJobEnvelope = z.object({
  tenantId: z.string().nullable(),
  payload: z.object({ occurrenceId: z.string() }),
});

describe("heartbeat sweep runs per tenant (issue #984)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantZero = getTenantZeroId();
    tenantB = await createTestTenant(adminPool);
    vi.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    await adminPool.query("DROP TRIGGER IF EXISTS test_reject_occurrence ON heartbeat_occurrences");
    await adminPool.query("DROP FUNCTION IF EXISTS test_reject_occurrence()");
    await adminPool.query("DROP TABLE IF EXISTS test_rejected_heartbeats");
    vi.restoreAllMocks();
  });

  it("schedules each tenant's heartbeat in its own timezone and stamps occurrences and jobs with its tenant", async () => {
    await seedTimezone(tenantZero, "Europe/Prague");
    await seedTimezone(tenantB, "America/New_York");
    const [idZero] = await insertDueHeartbeats(tenantZero, 1);
    const [idB] = await insertDueHeartbeats(tenantB, 1);

    const before = new Date();
    await sweep();

    const states = await heartbeatStates([idZero!, idB!]);
    const stateZero = states.find((s) => s.id === idZero)!;
    const stateB = states.find((s) => s.id === idB)!;
    expect(stateZero.next_fire_at.getTime()).toBe(computeNextFireAt(DAILY_RULE, "Europe/Prague", before)!.getTime());
    expect(stateB.next_fire_at.getTime()).toBe(computeNextFireAt(DAILY_RULE, "America/New_York", before)!.getTime());
    expect(stateZero.next_fire_at.getTime()).not.toBe(stateB.next_fire_at.getTime());

    const occurrences = await occurrencesOf([idZero!, idB!]);
    expect(occurrences).toHaveLength(2);
    expect(occurrences.every((o) => o.status === "queued")).toBe(true);
    expect(occurrences.find((o) => o.heartbeat_id === idZero)!.tenant_id).toBe(tenantZero);
    expect(occurrences.find((o) => o.heartbeat_id === idB)!.tenant_id).toBe(tenantB);

    const jobs = z.array(fireJobEnvelope).parse(await readJobPayloadsByIdentifier(adminPool, "heartbeatFireCore"));
    expect(jobs).toHaveLength(2);
    for (const occurrence of occurrences) {
      const job = jobs.find((j) => j.payload.occurrenceId === occurrence.id);
      expect(job?.tenantId).toBe(occurrence.tenant_id);
    }
  });

  it("caps each tenant's pass separately, whatever the iteration order", async () => {
    const idsZero = await insertDueHeartbeats(tenantZero, 101);
    const [idB] = await insertDueHeartbeats(tenantB, 1);

    await sweep(1);

    const zero = await heartbeatStates(idsZero);
    expect(zero.filter((s) => !s.due)).toHaveLength(100);
    expect(zero.filter((s) => s.due)).toHaveLength(1);
    expect((await heartbeatStates([idB!]))[0]!.due).toBe(false);

    await sweep(1);

    expect((await heartbeatStates(idsZero)).every((s) => !s.due)).toBe(true);
  });

  it("fires tenant zero's heartbeat and rejects when a page of tenant B fails", async () => {
    const [idZero] = await insertDueHeartbeats(tenantZero, 1);
    const [idB] = await insertDueHeartbeats(tenantB, 1);
    await adminPool.query("CREATE TABLE test_rejected_heartbeats (heartbeat_id uuid PRIMARY KEY)");
    await adminPool.query("INSERT INTO test_rejected_heartbeats VALUES ($1)", [idB]);
    await adminPool.query(`
      CREATE FUNCTION test_reject_occurrence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM test_rejected_heartbeats WHERE heartbeat_id = NEW.heartbeat_id) THEN
          RAISE EXCEPTION 'simulated occurrence failure';
        END IF;
        RETURN NEW;
      END $$`);
    await adminPool.query(
      "CREATE TRIGGER test_reject_occurrence BEFORE INSERT ON heartbeat_occurrences FOR EACH ROW EXECUTE FUNCTION test_reject_occurrence()",
    );

    const err: unknown = await sweep().then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors).toHaveLength(1);
    expect((err as AggregateError).errors[0]).toEqual(
      expect.objectContaining({ message: expect.stringContaining("simulated occurrence failure") }),
    );
    const states = await heartbeatStates([idZero!, idB!]);
    expect(states.find((s) => s.id === idZero)!.due).toBe(false);
    expect(states.find((s) => s.id === idB)!.due).toBe(true);
    const occurrences = await occurrencesOf([idZero!, idB!]);
    expect(occurrences.map((o) => o.heartbeat_id)).toEqual([idZero]);
  });

  it("leaves a suspended tenant's due heartbeat due", async () => {
    const suspended = await createTestTenant(adminPool, { status: "suspended" });
    const [idSuspended] = await insertDueHeartbeats(suspended, 1);
    const [idZero] = await insertDueHeartbeats(tenantZero, 1);

    await sweep();

    expect((await heartbeatStates([idSuspended!]))[0]!.due).toBe(true);
    expect(await occurrencesOf([idSuspended!])).toEqual([]);
    expect((await heartbeatStates([idZero!]))[0]!.due).toBe(false);
  });

  it("has the tenant-leading due index beside the legacy one", async () => {
    const { rows } = await adminPool.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'project_heartbeats' AND indexname LIKE 'project_heartbeats%due_idx'",
    );
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));
    expect(byName.get("project_heartbeats_tenant_due_idx")).toMatch(
      /\(tenant_id, next_fire_at\) WHERE \(enabled AND \(next_fire_at IS NOT NULL\)\)/,
    );
    expect(byName.has("project_heartbeats_due_idx")).toBe(true);
  });
});
