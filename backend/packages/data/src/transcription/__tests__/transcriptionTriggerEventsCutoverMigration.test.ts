import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../../testSupport/testDb.js";
import { FILES_TRANSCRIPTION_TRIGGER_ACTION_ID } from "../transcriptionActions.js";
import { runTranscriptionTriggerEventsCutoverMigration } from "../transcriptionTriggerEventsCutoverMigration.js";

let adminPool: Pool;
let dataPool: Pool;

const triggerSchema = z.array(
  z.object({
    id: z.uuid(),
    name: z.string(),
    action_config: z.record(z.string(), z.unknown()),
    // The row version: it changes whenever the row is written, also by a write of the same values.
    version: z.string(),
  }),
);
type Trigger = z.infer<typeof triggerSchema>[number];

/** The tenant's `core.filesTranscriptionTrigger` heartbeats, read under row-level security. */
async function triggers(tenantId: string): Promise<Trigger[]> {
  return runInTenant(tenantId, async () => {
    const { rows } = await dataPool.query<Record<string, unknown>>(
      `SELECT id, name, action_config, xmin::text AS version FROM project_heartbeats
        WHERE action_id = $1 ORDER BY id`,
      [FILES_TRANSCRIPTION_TRIGGER_ACTION_ID],
    );
    return triggerSchema.parse(rows);
  });
}

async function onlyTrigger(tenantId: string): Promise<Trigger> {
  const rows = await triggers(tenantId);
  if (rows.length !== 1 || !rows[0]) throw new Error(`Expected one trigger heartbeat, found ${rows.length}`);
  return rows[0];
}

const anchorsSchema = z.object({
  files: z.uuid(),
  attachments: z.uuid(),
  // NULL while the tenant's Files database has no `events` property.
  events: z.uuid().nullable(),
});

/** The ids the trigger's config is built from: the Files database, Emails.attachments and Files.events. */
async function anchors(tenantId: string): Promise<z.infer<typeof anchorsSchema>> {
  return runInTenant(tenantId, async () => {
    const { rows } = await dataPool.query<Record<string, unknown>>(
      `SELECT files.id AS files,
              (SELECT p.id FROM properties p JOIN databases d ON d.id = p.database_id
                WHERE d.owner_module_id = 'emails' AND p.key = 'attachments') AS attachments,
              (SELECT p.id FROM properties p WHERE p.database_id = files.id AND p.key = 'events') AS events
         FROM databases files WHERE files.owner_module_id = 'files'`,
    );
    return anchorsSchema.parse(rows[0]);
  });
}

async function seed(tenantId: string): Promise<void> {
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
}

/**
 * Removes `eventsRelationPropertyId` from the tenant's trigger heartbeat, reproducing a tenant seeded
 * before issue #1698. The current seed always writes the key and the scheduler store has no function
 * that removes a key from a heartbeat's `action_config`, so this is raw SQL on the admin pool.
 */
async function revertToOldConfig(tenantId: string): Promise<void> {
  const result = await adminPool.query(
    `UPDATE project_heartbeats SET action_config = action_config - 'eventsRelationPropertyId'
      WHERE tenant_id = $1 AND action_id = $2`,
    [tenantId, FILES_TRANSCRIPTION_TRIGGER_ACTION_ID],
  );
  expect(result.rowCount).toBe(1);
}

/**
 * Removes the `Events.files` / `Files.events` pair, reproducing a tenant seeded before issue #1588. The
 * locked Events and Files schemas have no public path that deletes a property, so this is raw SQL on the
 * admin pool.
 */
async function removeEventsFilesPair(tenantId: string): Promise<void> {
  const { events } = await anchors(tenantId);
  if (!events) throw new Error("Seeded tenant has no Files.events property");
  const definition = await adminPool.query<{ id: string }>(
    "SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1",
    [events],
  );
  const definitionId = definition.rows[0]?.id;
  if (!definitionId) throw new Error("Files.events has no relation definition");
  const removed = await adminPool.query(
    "DELETE FROM properties WHERE tenant_id = $1 AND config->>'relationDefinitionId' = $2",
    [tenantId, definitionId],
  );
  expect(removed.rowCount).toBe(2);
  await adminPool.query("DELETE FROM relation_definitions WHERE id = $1", [definitionId]);
}

/** Every heartbeat of every tenant with its row version, so a run that writes any of them is seen. */
async function snapshotHeartbeats(): Promise<unknown[]> {
  const { rows } = await adminPool.query<Record<string, unknown>>(
    "SELECT xmin::text AS version, to_jsonb(t) AS row FROM project_heartbeats t ORDER BY id",
  );
  return rows;
}

function runRegisteredCutovers(): Promise<void> {
  return runAsSystem("test transcription trigger cutover", () => runTenantCutoverMigrations(dataPool));
}

describe("Files transcription trigger eventsRelationPropertyId (issue #1698)", () => {
  let zero: string;
  let other: string;

  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    const role = await runAsSystem("check transcription trigger cutover role", () =>
      dataPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    zero = getTenantZeroId();
    other = await createTestTenant(adminPool);
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  it("a fresh seed gives the trigger heartbeat the Files.events property id", async () => {
    await seed(zero);
    const ids = await anchors(zero);
    expect(ids.events).not.toBeNull();

    const trigger = await onlyTrigger(zero);
    expect(trigger.name).toBe("Files transcription trigger");
    expect(trigger.action_config).toEqual({
      filesDatabaseId: ids.files,
      attachmentsRelationPropertyId: ids.attachments,
      eventsRelationPropertyId: ids.events,
    });
  });

  it("gives a tenant seeded earlier its own Files.events property id and leaves another tenant's heartbeat alone", async () => {
    for (const tenantId of [zero, other]) {
      await seed(tenantId);
      await revertToOldConfig(tenantId);
    }
    const zeroIds = await anchors(zero);
    const otherIds = await anchors(other);
    expect(zeroIds.events).not.toBe(otherIds.events);
    const otherBefore = await onlyTrigger(other);
    expect(otherBefore.action_config).toEqual({
      filesDatabaseId: otherIds.files,
      attachmentsRelationPropertyId: otherIds.attachments,
    });

    await runInTenant(zero, () => runTranscriptionTriggerEventsCutoverMigration(dataPool));

    expect((await onlyTrigger(zero)).action_config).toEqual({
      filesDatabaseId: zeroIds.files,
      attachmentsRelationPropertyId: zeroIds.attachments,
      eventsRelationPropertyId: zeroIds.events,
    });
    expect(await onlyTrigger(other)).toEqual(otherBefore);
  });

  it("the registered cutover makes every earlier tenant's heartbeat equal to a fresh seed's, and a second run writes nothing", async () => {
    for (const tenantId of [zero, other]) await seed(tenantId);
    const fresh = { zero: await onlyTrigger(zero), other: await onlyTrigger(other) };
    for (const tenantId of [zero, other]) await revertToOldConfig(tenantId);

    await runRegisteredCutovers();

    const upgraded = { zero: await onlyTrigger(zero), other: await onlyTrigger(other) };
    expect(upgraded.zero.action_config).toEqual(fresh.zero.action_config);
    expect(upgraded.other.action_config).toEqual(fresh.other.action_config);
    expect(upgraded.zero.action_config.eventsRelationPropertyId).toBe((await anchors(zero)).events);
    expect(upgraded.other.action_config.eventsRelationPropertyId).toBe((await anchors(other)).events);

    await runRegisteredCutovers();
    expect({ zero: await onlyTrigger(zero), other: await onlyTrigger(other) }).toEqual(upgraded);
  });

  it("does not rewrite a heartbeat that already carries the key", async () => {
    await seed(zero);
    const before = await snapshotHeartbeats();

    await runInTenant(zero, () => runTranscriptionTriggerEventsCutoverMigration(dataPool));

    expect(await snapshotHeartbeats()).toEqual(before);
  });

  it("waits for a concurrent writer of the heartbeat and keeps the key that writer committed", async () => {
    await seed(zero);
    await revertToOldConfig(zero);
    const trigger = await onlyTrigger(zero);
    const committedByWriter = randomUUID();
    // A dedicated connection: its open transaction holds the heartbeat's row lock until it ends.
    const writer = await adminPool.connect();
    let writerOpen = false;
    let cutover: Promise<PromiseSettledResult<void>[]> | undefined;
    const failures: unknown[] = [];
    try {
      const { rows } = await writer.query<Record<string, unknown>>("SELECT pg_backend_pid() AS pid");
      const writerPid = z.object({ pid: z.number().int() }).parse(rows[0]).pid;
      await writer.query("BEGIN");
      writerOpen = true;
      // The scheduler store has no function that sets this key, so the concurrent writer is raw SQL.
      const written = await writer.query(
        `UPDATE project_heartbeats
            SET action_config = jsonb_set(action_config, '{eventsRelationPropertyId}', to_jsonb($2::text))
          WHERE id = $1`,
        [trigger.id, committedByWriter],
      );
      expect(written.rowCount).toBe(1);

      cutover = Promise.allSettled([runInTenant(zero, () => runTranscriptionTriggerEventsCutoverMigration(dataPool))]);
      await vi.waitFor(
        async () => {
          const waiting = await adminPool.query<{ waiting: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                             WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))) AS waiting`,
            [writerPid],
          );
          expect(waiting.rows[0]?.waiting).toBe(true);
        },
        { timeout: 10_000, interval: 25 },
      );
      await writer.query("COMMIT");
      writerOpen = false;
    } catch (error) {
      failures.push(error);
    }
    // On a failure above the writer still holds the row; ending its transaction lets the cutover finish.
    let discardWriter = false;
    if (writerOpen) {
      try {
        await writer.query("ROLLBACK");
      } catch (error) {
        failures.push(error);
        discardWriter = true;
      }
    }
    writer.release(discardWriter);
    const [outcome] = cutover ? await cutover : [];
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Concurrent cutover test and cleanup failed");

    expect(outcome).toEqual({ status: "fulfilled", value: undefined });
    expect((await onlyTrigger(zero)).action_config.eventsRelationPropertyId).toBe(committedByWriter);
  });

  it("one registered run sets the key on a tenant that also gets Files.events from that run", async () => {
    await seed(zero);
    await revertToOldConfig(zero);
    await removeEventsFilesPair(zero);
    expect((await anchors(zero)).events).toBeNull();

    await runRegisteredCutovers();

    const ids = await anchors(zero);
    expect(ids.events).not.toBeNull();
    expect((await onlyTrigger(zero)).action_config).toEqual({
      filesDatabaseId: ids.files,
      attachmentsRelationPropertyId: ids.attachments,
      eventsRelationPropertyId: ids.events,
    });
  });

  it("leaves the old config in place while the Files database has no events property", async () => {
    await seed(zero);
    await revertToOldConfig(zero);
    await removeEventsFilesPair(zero);
    const before = await snapshotHeartbeats();

    await expect(
      runInTenant(zero, () => runTranscriptionTriggerEventsCutoverMigration(dataPool)),
    ).resolves.toBeUndefined();

    expect(await snapshotHeartbeats()).toEqual(before);
    expect((await onlyTrigger(zero)).action_config).not.toHaveProperty("eventsRelationPropertyId");
  });

  it("leaves a seeded tenant without the trigger heartbeat alone", async () => {
    await seed(zero);
    // The seed always creates the trigger heartbeat and the scheduler store has no function that deletes
    // one, so a tenant without it is reproduced with raw SQL on the admin pool.
    const removed = await adminPool.query("DELETE FROM project_heartbeats WHERE tenant_id = $1 AND action_id = $2", [
      zero,
      FILES_TRANSCRIPTION_TRIGGER_ACTION_ID,
    ]);
    expect(removed.rowCount).toBe(1);
    const before = await snapshotHeartbeats();

    await expect(
      runInTenant(zero, () => runTranscriptionTriggerEventsCutoverMigration(dataPool)),
    ).resolves.toBeUndefined();

    expect(await triggers(zero)).toEqual([]);
    expect(await snapshotHeartbeats()).toEqual(before);
  });

  it("does nothing for a tenant that has not been seeded", async () => {
    await expect(
      runInTenant(other, () => runTranscriptionTriggerEventsCutoverMigration(dataPool)),
    ).resolves.toBeUndefined();

    expect(await snapshotHeartbeats()).toEqual([]);
  });
});
