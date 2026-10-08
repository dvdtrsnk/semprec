import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import {
  backfillRollup,
  enqueueRollupBackfill,
  enqueueRollupRecompute,
  rollupRecomputeFullJobKey,
  rollupRecomputeJobKey,
} from "../rollup/recompute.js";
import { enqueuePropertyTypeMigration, propertyTypeMigrationJobKey } from "../migrationJob/propertyTypeMigration.js";
import { enqueueTranscriptionJob, transcriptionJobKey } from "../transcription/transcriptionJob.js";

let pool: Pool;
let chokePoint: ChokePoint;
let tenantZero: string;

interface JobRow {
  key: string;
  queue_name: string | null;
}

async function jobs(): Promise<JobRow[]> {
  const { rows } = await pool.query<JobRow>(
    `SELECT j.key, jq.queue_name
     FROM graphile_worker._private_jobs j
     LEFT JOIN graphile_worker._private_job_queues jq ON jq.id = j.job_queue_id
     ORDER BY j.key`,
  );
  return rows;
}

async function queueNameOf(key: string): Promise<string | null | undefined> {
  const matching = (await jobs()).filter((j) => j.key === key);
  expect(matching).toHaveLength(1);
  return matching[0]?.queue_name;
}

async function enqueueAll(propertyId: string, itemId: string, fileItemId: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    await enqueueRollupRecompute(client, propertyId, itemId);
    await enqueueRollupBackfill(client, propertyId);
    await enqueuePropertyTypeMigration(client, propertyId, "text");
    await enqueueTranscriptionJob(client, { fileItemId });
  });
}

describe("per-tenant queue lanes", () => {
  const propertyId = randomUUID();
  const itemId = randomUUID();
  const fileItemId = randomUUID();

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    tenantZero = getTenantZeroId();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("puts the four bulk enqueues on their tenant lanes", async () => {
    await runInTenant(tenantZero, () => enqueueAll(propertyId, itemId, fileItemId));

    expect(await queueNameOf(rollupRecomputeJobKey(propertyId, itemId))).toBe(`rollup-recompute:${tenantZero}`);
    expect(await queueNameOf(rollupRecomputeFullJobKey(propertyId))).toBe(`rollup-backfill:${tenantZero}`);
    expect(await queueNameOf(propertyTypeMigrationJobKey(propertyId))).toBe(`property-type-migration:${tenantZero}`);
    expect(await queueNameOf(transcriptionJobKey(fileItemId))).toBe(`transcription:${tenantZero}`);
  });

  it("leaves queue_name NULL outside a tenant scope", async () => {
    await enqueueAll(propertyId, itemId, fileItemId);

    expect(await queueNameOf(rollupRecomputeJobKey(propertyId, itemId))).toBeNull();
    expect(await queueNameOf(rollupRecomputeFullJobKey(propertyId))).toBeNull();
    expect(await queueNameOf(propertyTypeMigrationJobKey(propertyId))).toBeNull();
    expect(await queueNameOf(transcriptionJobKey(fileItemId))).toBeNull();
  });

  it("keeps job keys unchanged so a repeat enqueue collapses onto one job per kind", async () => {
    await runInTenant(tenantZero, async () => {
      await enqueueAll(propertyId, itemId, fileItemId);
      await enqueueAll(propertyId, itemId, fileItemId);
    });

    const keys = (await jobs()).map((j) => j.key).sort();
    expect(keys).toEqual(
      [
        rollupRecomputeJobKey(propertyId, itemId),
        rollupRecomputeFullJobKey(propertyId),
        propertyTypeMigrationJobKey(propertyId),
        transcriptionJobKey(fileItemId),
      ].sort(),
    );
  });

  it("backfillRollup's per-cell jobs land on the tenant's rollup-recompute lane", async () => {
    const projects = await chokePoint.createDatabase({ name: "LaneProjects" });
    const tasks = await chokePoint.createDatabase({ name: "LaneTasks" });
    await chokePoint.createRelationProperty({
      sourceDatabaseId: projects.id,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: tasks.id,
      inverse: { key: "project", name: "Project" },
    });
    const rollup = await chokePoint.createProperty({
      databaseId: projects.id,
      key: "taskCount",
      name: "Task count",
      type: "rollup",
      config: { relationPropertyKey: "tasks", aggregation: "count" },
    });
    const item = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
    await pool.query("DELETE FROM graphile_worker._private_jobs");

    await runInTenant(tenantZero, () => backfillRollup(pool, rollup.id));

    expect(await queueNameOf(rollupRecomputeJobKey(rollup.id, item.id))).toBe(`rollup-recompute:${tenantZero}`);
  });
});
