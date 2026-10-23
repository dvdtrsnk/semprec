import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createPool } from "../db/pool.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcription/transcriptionJob.js";
import { TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID } from "../transcription/transcriptionActions.js";
import { createTestTenant, getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let adminPool: Pool;
let dataPool: Pool;

interface TenantState {
  statusOptions: string[];
  pipelineOwners: Array<string | null>;
  speakers: { targetDatabaseId: string } | null;
  peopleId: string;
  transcriptsId: string;
  heartbeats: Array<{ projectItemId: string; transcriptsDatabaseId: string }>;
}

async function readState(tenantId: string): Promise<TenantState> {
  return runInTenant(tenantId, async () => {
    const db = async (moduleId: string): Promise<string> => {
      const { rows } = await dataPool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [
        moduleId,
      ]);
      if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
      return rows[0].id;
    };
    const transcriptsId = await db("transcripts");
    const peopleId = await db("people");
    const { rows: props } = await dataPool.query<{
      key: string;
      owner_process: string | null;
      config: { options?: Array<{ key: string }>; targetDatabaseId?: string };
    }>("SELECT key, owner_process, config FROM properties WHERE database_id = $1", [transcriptsId]);
    const status = props.find((p) => p.key === "status");
    const speakers = props.find((p) => p.key === "speakers");
    const { rows: heartbeats } = await dataPool.query<{
      project_item_id: string;
      action_config: { transcriptsDatabaseId: string };
    }>("SELECT project_item_id, action_config FROM project_heartbeats WHERE action_id = $1", [
      TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID,
    ]);
    return {
      statusOptions: (status?.config.options ?? []).map((o) => o.key),
      pipelineOwners: ["status", "date", "link"].map((k) => props.find((p) => p.key === k)?.owner_process ?? null),
      speakers: speakers?.config.targetDatabaseId ? { targetDatabaseId: speakers.config.targetDatabaseId } : null,
      peopleId,
      transcriptsId,
      heartbeats: heartbeats.map((h) => ({
        projectItemId: h.project_item_id,
        transcriptsDatabaseId: h.action_config.transcriptsDatabaseId,
      })),
    };
  });
}

/** Seeds the tenant, then reverts its Transcripts catalog and requeue heartbeat to the pre-cutover shape. */
async function seedOldShape(tenantId: string, options: { keepHeartbeat?: boolean } = {}): Promise<void> {
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
  const { transcriptsId } = await readState(tenantId);
  await adminPool.query(
    `UPDATE properties SET config = jsonb_set(config, '{options}', '[{"key":"recording"},{"key":"processing"},{"key":"done"}]'::jsonb)
     WHERE database_id = $1 AND key = 'status'`,
    [transcriptsId],
  );
  await adminPool.query(
    `UPDATE properties SET owner_process = NULL WHERE database_id = $1 AND key = ANY('{status,date,link}')`,
    [transcriptsId],
  );
  const { rows } = await adminPool.query<{ id: string; config: { relationDefinitionId: string } }>(
    "SELECT id, config FROM properties WHERE database_id = $1 AND key = 'speakers'",
    [transcriptsId],
  );
  if (rows[0]) {
    await adminPool.query("DELETE FROM properties WHERE id = $1", [rows[0].id]);
    await adminPool.query("DELETE FROM relation_definitions WHERE id = $1", [rows[0].config.relationDefinitionId]);
  }
  if (!options.keepHeartbeat) {
    await adminPool.query(
      `DELETE FROM project_heartbeats WHERE action_id = $1
       AND project_item_id IN (SELECT id FROM items WHERE tenant_id = $2)`,
      [TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID, tenantId],
    );
  }
}

async function snapshot(): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const table of ["properties", "relation_definitions", "project_heartbeats"]) {
    const { rows } = await adminPool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`);
    out.push(rows);
  }
  return out;
}

function runCutovers(pool: Pool): Promise<void> {
  return runAsSystem("test cutover", () => runTenantCutoverMigrations(pool));
}

async function expectUpgraded(tenantId: string): Promise<void> {
  const state = await readState(tenantId);
  expect(state.statusOptions).toContain("error");
  expect(state.pipelineOwners).toEqual([
    TRANSCRIPTION_OWNER_PROCESS,
    TRANSCRIPTION_OWNER_PROCESS,
    TRANSCRIPTION_OWNER_PROCESS,
  ]);
  expect(state.speakers).toEqual({ targetDatabaseId: state.peopleId });
  expect(state.heartbeats).toHaveLength(1);
  expect(state.heartbeats[0]?.transcriptsDatabaseId).toBe(state.transcriptsId);
  const { rows } = await adminPool.query<{ tenant_id: string }>("SELECT tenant_id FROM items WHERE id = $1", [
    state.heartbeats[0]?.projectItemId,
  ]);
  expect(rows[0]?.tenant_id).toBe(tenantId);
}

describe("runTenantCutoverMigrations (issue #1007)", () => {
  let zero: string;
  let b: string;

  beforeAll(() => {
    adminPool = getTestPool();
    dataPool = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    zero = getTenantZeroId();
    b = await createTestTenant(adminPool);
  });

  afterAll(async () => {
    await dataPool.end();
    await adminPool.end();
  });

  it("upgrades every tenant in its own scope", async () => {
    await seedOldShape(zero);
    await seedOldShape(b);
    expect((await readState(b)).statusOptions).not.toContain("error");

    await runCutovers(dataPool);

    await expectUpgraded(zero);
    await expectUpgraded(b);
    expect((await readState(zero)).transcriptsId).not.toBe((await readState(b)).transcriptsId);
  });

  it("is idempotent: a second call changes no row", async () => {
    await seedOldShape(zero);
    await seedOldShape(b);
    await runCutovers(dataPool);
    const before = await snapshot();

    await runCutovers(dataPool);

    expect(await snapshot()).toEqual(before);
  });

  it("creates only the missing heartbeat when just one tenant lacks it", async () => {
    await seedOldShape(zero, { keepHeartbeat: true });
    await seedOldShape(b);
    const zeroBefore = (await readState(zero)).heartbeats;
    expect(zeroBefore).toHaveLength(1);

    await runCutovers(dataPool);

    expect((await readState(zero)).heartbeats).toEqual(zeroBefore);
    await expectUpgraded(b);
  });

  it("leaves a deleting tenant untouched", async () => {
    await seedOldShape(zero);
    await seedOldShape(b);
    await adminPool.query("UPDATE tenants SET status = 'deleting' WHERE id = $1", [b]);
    const bBefore = await readState(b);

    await runCutovers(dataPool);

    await expectUpgraded(zero);
    expect(await readState(b)).toEqual(bBefore);
  });

  it("upgrades the other tenants when one tenant's cutover throws, then rejects naming it", async () => {
    await seedOldShape(zero);
    await seedOldShape(b);
    const { transcriptsId } = await readState(b);
    await adminPool.query(`
      CREATE OR REPLACE FUNCTION test_fail_b_cutover() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.database_id = '${transcriptsId}' THEN RAISE EXCEPTION 'test cutover failure'; END IF;
        RETURN NEW;
      END $$`);
    await adminPool.query(
      "CREATE TRIGGER test_fail_b_cutover BEFORE UPDATE ON properties FOR EACH ROW EXECUTE FUNCTION test_fail_b_cutover()",
    );
    try {
      const error = await runCutovers(dataPool).then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).message).toContain(b);
      expect((error as AggregateError).message).not.toContain(zero);
      expect((error as AggregateError).errors).toHaveLength(1);
    } finally {
      await adminPool.query("DROP TRIGGER test_fail_b_cutover ON properties");
      await adminPool.query("DROP FUNCTION test_fail_b_cutover()");
    }

    await expectUpgraded(zero);
    expect((await readState(b)).statusOptions).not.toContain("error");
  });

  it("refuses the owner pool and writes nothing", async () => {
    await seedOldShape(zero);
    await seedOldShape(b);
    const before = await snapshot();

    await expect(runCutovers(adminPool)).rejects.toThrow(/row-level security applies/);

    expect(await snapshot()).toEqual(before);
  });
});
