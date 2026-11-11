import "../../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, runOnce, type TaskList } from "@semprec/queue";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { getPropertyByKey } from "../../chokePoint/propertiesStore.js";
import { assertRelationCreatableWithClient, createRelationWithClient } from "../../chokePoint/relationOps.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../../chokePoint/relationsStore.js";
import { withTransaction } from "../../db/pool.js";
import { createHeartbeat } from "../../scheduler/schedulerStore.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  INBOX_ITEM_TYPES_MODULE_ID,
  INBOX_MODULE_ID,
  PROCESSING_PROPOSALS_MODULE_ID,
} from "../../seed/inboxPipelineKeys.js";
import {
  createInboxItemWithClient,
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTestPool,
  resetDatabase,
} from "../../testSupport/testDb.js";
import { SEMPREC_TICK_ACTION_ID } from "../inboxTickKeys.js";
import { createInboxTypeWithClient, deleteInboxTypeWithClient } from "../inboxTypesStore.js";

/**
 * Issue #1718: the edge-changed hook of the Inbox `type` relation. Every relation edge write under test goes
 * through the choke point on a `semprec_data` pool inside a tenant, so row-level security applies to the hook's
 * own reads. The side-B fixture writes a `properties` row and the `relation_definitions` swap with raw SQL on
 * that same pool, because no writer can produce that definition. The queued jobs are read through the superuser
 * pool, which sees the jobs of every tenant.
 */

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;

const TICK_TASK = CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE;
const RECOMPUTE_TASK = CORE_TASK_NAMES.JOURNAL_INBOX_RECOMPUTE;
const DAY = "2026-10-16";

/** What a test needs to know of one tenant's seeded Inbox pipeline. */
interface Pipeline {
  tenant: string;
  inboxId: string;
  typesId: string;
  proposalsId: string;
  typePropertyId: string;
  typeDefinitionId: string;
  journalDayDefinitionId: string;
  /** The seeded `semprec.tick` heartbeats of the Inbox database, by the item event they watch. */
  heartbeatIds: { create: string; update: string };
}

async function pipelineOf(tenantId: string): Promise<Pipeline> {
  return runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
      const inbox = await getDatabaseByModuleId(client, INBOX_MODULE_ID);
      const types = await getDatabaseByModuleId(client, INBOX_ITEM_TYPES_MODULE_ID);
      const proposals = await getDatabaseByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
      if (!inbox || !types || !proposals) throw new Error("The Inbox pipeline was not seeded");
      const typeProperty = await getPropertyByKey(client, inbox.id, "type");
      const journalDayProperty = await getPropertyByKey(client, inbox.id, "journalDay");
      if (!typeProperty || !journalDayProperty) throw new Error("The Inbox relations were not seeded");
      const typeDefinition = await getRelationDefinitionByPropertyId(client, typeProperty.id);
      const journalDayDefinition = await getRelationDefinitionByPropertyId(client, journalDayProperty.id);
      if (!typeDefinition || !journalDayDefinition) throw new Error("The Inbox relation definitions are missing");
      const heartbeats = await client.query<{ id: string; event: string }>(
        `SELECT id, rule ->> 'event' AS event FROM project_heartbeats
         WHERE rule ->> 'kind' = 'onItemEvent' AND rule ->> 'databaseId' = $1`,
        [inbox.id],
      );
      const heartbeatOf = (event: string): string => {
        const row = heartbeats.rows.find((heartbeat) => heartbeat.event === event);
        if (!row) throw new Error(`The Inbox '${event}' heartbeat was not seeded`);
        return row.id;
      };
      return {
        tenant: tenantId,
        inboxId: inbox.id,
        typesId: types.id,
        proposalsId: proposals.id,
        typePropertyId: typeProperty.id,
        typeDefinitionId: typeDefinition.id,
        journalDayDefinitionId: journalDayDefinition.id,
        heartbeatIds: { create: heartbeatOf("create"), update: heartbeatOf("update") },
      };
    }),
  );
}

async function createType(p: Pipeline, name: string): Promise<string> {
  const type = await runInTenant(p.tenant, () =>
    withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: p.typesId,
        name,
        emoji: "x",
        processingMethod: "pageContent",
      }),
    ),
  );
  return type.id;
}

/** Captures one Inbox item of `DAY` through the production Inbox writer, with its type edge when `typeId` is given. */
async function capture(p: Pipeline, text: string, typeId?: string): Promise<string> {
  const item = await runInTenant(p.tenant, () =>
    withTransaction(pool, (client) =>
      createInboxItemWithClient(client, { inboxDatabaseId: p.inboxId, date: DAY, time: "09:00", text, type: typeId }),
    ),
  );
  return item.id;
}

/** The Journal day the Inbox item's `journalDay` edge points at. */
async function dayOf(p: Pipeline, inboxItemId: string): Promise<string> {
  return runInTenant(p.tenant, () =>
    withTransaction(pool, async (client) => {
      const [edge] = await listRelationsForItem(client, p.journalDayDefinitionId, inboxItemId);
      if (!edge) throw new Error("The Inbox item has no journalDay edge");
      return otherSide(edge, inboxItemId);
    }),
  );
}

/** The ids of the Inbox item's stored `type` edge rows. */
async function typeEdgeIdsOf(p: Pipeline, inboxItemId: string): Promise<string[]> {
  return runInTenant(p.tenant, () =>
    withTransaction(pool, async (client) => {
      const edges = await listRelationsForItem(client, p.typeDefinitionId, inboxItemId);
      return edges.map((edge) => edge.id);
    }),
  );
}

function typeEdge(p: Pipeline, inboxItemId: string, typeId: string) {
  return { relationPropertyId: p.typePropertyId, callerItemId: inboxItemId, targetItemId: typeId };
}

const jobEnvelope = z.object({ tenantId: z.string().nullable(), payload: z.record(z.string(), z.unknown()) });

/** Every queued job of `task`: the tenant its producer stamped and its business payload. */
async function queued(task: string): Promise<Array<z.infer<typeof jobEnvelope>>> {
  return (await readJobPayloadsByIdentifier(admin, task)).map((raw) => {
    const { tenantId, payload } = jobEnvelope.parse(raw);
    return { tenantId, payload };
  });
}

async function tickAndRecomputeJobs() {
  return { tick: await queued(TICK_TASK), recompute: await queued(RECOMPUTE_TASK) };
}

async function queuedJobCount(): Promise<number> {
  const { rows } = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM graphile_worker.jobs");
  return rows[0]?.n ?? -1;
}

/**
 * Empties the queue through the worker: every queued job runs a handler that does nothing. A job enqueued
 * afterwards is then a new row, where a keyed enqueue would otherwise only update the queued job of the same key
 * that the fixture's capture left behind. One run may leave jobs of a serialized lane for the next one, so it
 * repeats while it makes progress.
 */
async function discardQueuedJobs(): Promise<void> {
  let remaining = Number.POSITIVE_INFINITY;
  for (;;) {
    const { rows } = await admin.query<{ task_identifier: string }>(
      "SELECT task_identifier FROM graphile_worker.jobs ORDER BY id",
    );
    if (rows.length === 0) return;
    if (rows.length >= remaining) throw new Error(`Queued jobs stopped draining: ${JSON.stringify(rows)}`);
    remaining = rows.length;
    const taskList: TaskList = Object.fromEntries(rows.map((row) => [row.task_identifier, async () => {}]));
    await runOnce({ pgPool: admin }, taskList);
  }
}

function tickJob(p: Pipeline, inboxItemId: string) {
  return { tenantId: p.tenant, payload: { heartbeatId: p.heartbeatIds.update, itemId: inboxItemId } };
}

function recomputeJob(p: Pipeline, journalDayItemId: string) {
  return { tenantId: p.tenant, payload: { journalDayItemId } };
}

describe("Inbox type edge changed hook (issue #1718)", () => {
  let p: Pipeline;

  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    cp = createChokePoint(pool);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool));
    p = await pipelineOf(tenant);
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it("enqueues the Inbox item's update tick and its day's recompute when the type edge is created", async () => {
    const typeId = await createType(p, "Note");
    const itemId = await capture(p, "Buy milk");
    const dayId = await dayOf(p, itemId);
    await discardQueuedJobs();

    await runInTenant(tenant, () => cp.createRelation(typeEdge(p, itemId, typeId)));

    expect(await tickAndRecomputeJobs()).toEqual({ tick: [tickJob(p, itemId)], recompute: [recomputeJob(p, dayId)] });
  });

  it("enqueues the same two jobs when the type edge is deleted", async () => {
    const typeId = await createType(p, "Note");
    const itemId = await capture(p, "Buy milk", typeId);
    const dayId = await dayOf(p, itemId);
    await discardQueuedJobs();

    const removed = await runInTenant(tenant, () => cp.deleteRelation(typeEdge(p, itemId, typeId)));

    expect(removed).not.toBeNull();
    expect(await tickAndRecomputeJobs()).toEqual({ tick: [tickJob(p, itemId)], recompute: [recomputeJob(p, dayId)] });
  });

  it("fires the update tick besides the create tick when a capture writes the item's type edge", async () => {
    const typeId = await createType(p, "Note");

    const itemId = await capture(p, "Buy milk", typeId);

    const dayId = await dayOf(p, itemId);
    const jobs = await tickAndRecomputeJobs();
    expect(jobs.tick).toHaveLength(2);
    expect(jobs.tick).toEqual(
      expect.arrayContaining([
        { tenantId: tenant, payload: { heartbeatId: p.heartbeatIds.create, itemId } },
        tickJob(p, itemId),
      ]),
    );
    expect(jobs.recompute).toEqual([recomputeJob(p, dayId)]);
  });

  it("fires the update tick of every Inbox item whose type edge a type deletion clears", async () => {
    const typeId = await createType(p, "Note");
    const firstItemId = await capture(p, "First", typeId);
    const secondItemId = await capture(p, "Second", typeId);
    const dayId = await dayOf(p, firstItemId);
    await discardQueuedJobs();

    await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        deleteInboxTypeWithClient(client, {
          inboxDatabaseId: p.inboxId,
          inboxItemTypesDatabaseId: p.typesId,
          processingProposalsDatabaseId: p.proposalsId,
          typeItemId: typeId,
        }),
      ),
    );

    const jobs = await tickAndRecomputeJobs();
    expect(jobs.tick).toHaveLength(2);
    expect(jobs.tick).toEqual(expect.arrayContaining([tickJob(p, firstItemId), tickJob(p, secondItemId)]));
    expect(jobs.recompute).toEqual([recomputeJob(p, dayId)]);
  });

  it("enqueues nothing for the creatability dry run of the type edge", async () => {
    const typeId = await createType(p, "Note");
    const itemId = await capture(p, "Buy milk");
    await discardQueuedJobs();

    await runInTenant(tenant, () =>
      withTransaction(pool, (client) => assertRelationCreatableWithClient(client, typeEdge(p, itemId, typeId))),
    );

    expect(await queuedJobCount()).toBe(0);
  });

  it("enqueues both jobs again for a repeated create of the type edge the item already has", async () => {
    const typeId = await createType(p, "Note");
    const itemId = await capture(p, "Buy milk", typeId);
    const dayId = await dayOf(p, itemId);
    const storedBefore = await typeEdgeIdsOf(p, itemId);
    await discardQueuedJobs();

    const repeated = await runInTenant(tenant, () => cp.createRelation(typeEdge(p, itemId, typeId)));

    // No edge row was inserted and the type is as it was; the registry reports the write as `create` all the same.
    expect(storedBefore).toEqual([repeated.id]);
    expect(await typeEdgeIdsOf(p, itemId)).toEqual(storedBefore);
    expect(await tickAndRecomputeJobs()).toEqual({ tick: [tickJob(p, itemId)], recompute: [recomputeJob(p, dayId)] });
  });

  it("enqueues neither job for the metadata replacement of an existing type edge (`op: 'update'`)", async () => {
    const typeId = await createType(p, "Note");
    const itemId = await capture(p, "Buy milk", typeId);
    await discardQueuedJobs();

    const edge = await runInTenant(tenant, () =>
      cp.updateRelation({ ...typeEdge(p, itemId, typeId), metadata: { source: "replacement" } }),
    );

    expect(edge.metadata).toEqual({ source: "replacement" });
    expect(await tickAndRecomputeJobs()).toEqual({ tick: [], recompute: [] });
  });

  it("fires no update tick for the journalDay edge that a capture writes on the Inbox item", async () => {
    const itemId = await capture(p, "Buy milk");

    expect(await queued(TICK_TASK)).toEqual([
      { tenantId: tenant, payload: { heartbeatId: p.heartbeatIds.create, itemId } },
    ]);
  });

  it("enqueues neither job for a `type` relation of a database that is not the Inbox", async () => {
    const edge = await runInTenant(tenant, async () => {
      const source = await cp.createDatabase({ name: "Source" });
      const target = await cp.createDatabase({ name: "Target" });
      const { property } = await cp.createRelationProperty({
        sourceDatabaseId: source.id,
        targetDatabaseId: target.id,
        key: "type",
        name: "Type",
      });
      // An `update` heartbeat watches the source database, so a hook that took this relation for the Inbox one
      // would fire it.
      const projectItemId = await createTestProjectItem(pool);
      await withTransaction(pool, (client) =>
        createHeartbeat(client, {
          projectItemId,
          name: "Source update",
          rule: { kind: "onItemEvent", databaseId: source.id, event: "update" },
          actionId: SEMPREC_TICK_ACTION_ID,
        }),
      );
      const caller = await cp.createItem({ databaseId: source.id });
      const targetItem = await cp.createItem({ databaseId: target.id });
      return { relationPropertyId: property.id, callerItemId: caller.id, targetItemId: targetItem.id };
    });
    await discardQueuedJobs();

    await runInTenant(tenant, () => cp.createRelation(edge));
    await runInTenant(tenant, () => cp.deleteRelation(edge));

    expect(await tickAndRecomputeJobs()).toEqual({ tick: [], recompute: [] });
  });

  it("finds the Inbox item on stored side B, for a write through either property of the relation", async () => {
    const viaInboxProperty = await capture(p, "Written from the Inbox side");
    const viaTypesProperty = await capture(p, "Written from the type side");
    const dayId = await dayOf(p, viaInboxProperty);
    const firstType = await createType(p, "First");
    const secondType = await createType(p, "Second");
    // The seed creates the relation from the Inbox side and both schemas are locked, so no writer can make the
    // Inbox `type` property side B of its definition: a counterpart property and the swap are written directly.
    const counterpartPropertyId = await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO properties (database_id, key, name, type, config, owner)
           VALUES ($1, 'inboxItems', 'Inbox items', 'relation', $2::jsonb, 'user') RETURNING id`,
          [p.typesId, JSON.stringify({ relationDefinitionId: p.typeDefinitionId, targetDatabaseId: p.inboxId })],
        );
        const counterpart = inserted.rows[0];
        if (!counterpart) throw new Error("The counterpart property was not inserted");
        const swapped = await client.query(
          "UPDATE relation_definitions SET property_id_a = $2, property_id_b = $3 WHERE id = $1",
          [p.typeDefinitionId, counterpart.id, p.typePropertyId],
        );
        expect(swapped.rowCount).toBe(1);
        return counterpart.id;
      }),
    );
    await discardQueuedJobs();

    const fromInbox = await runInTenant(tenant, () => cp.createRelation(typeEdge(p, viaInboxProperty, firstType)));
    const fromTypes = await runInTenant(tenant, () =>
      cp.createRelation({
        relationPropertyId: counterpartPropertyId,
        callerItemId: secondType,
        targetItemId: viaTypesProperty,
      }),
    );

    expect(fromInbox).toMatchObject({ itemA: firstType, itemB: viaInboxProperty });
    expect(fromTypes).toMatchObject({ itemA: secondType, itemB: viaTypesProperty });
    const jobs = await tickAndRecomputeJobs();
    expect(jobs.tick).toHaveLength(2);
    expect(jobs.tick).toEqual(expect.arrayContaining([tickJob(p, viaInboxProperty), tickJob(p, viaTypesProperty)]));
    expect(jobs.recompute).toEqual([recomputeJob(p, dayId)]);
  });

  it("leaves no job behind when the transaction of the edge write rolls back", async () => {
    const typeId = await createType(p, "Note");
    const itemId = await capture(p, "Buy milk");
    await discardQueuedJobs();
    const rollback = new Error("rolled back after the edge write");

    await expect(
      runInTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          await createRelationWithClient(client, typeEdge(p, itemId, typeId));
          throw rollback;
        }),
      ),
    ).rejects.toBe(rollback);

    expect(await queuedJobCount()).toBe(0);
  });

  it("enqueues only the writing tenant's tick and day recompute", async () => {
    const other = await createTestTenant(admin);
    await runInTenant(other, () => seedSystem(pool));
    const foreign = await pipelineOf(other);
    const typeId = await createType(p, "Note");
    const itemId = await capture(p, "Buy milk");
    const dayId = await dayOf(p, itemId);
    const foreignTypeId = await createType(foreign, "Note");
    const foreignItemId = await capture(foreign, "Buy milk");
    const foreignDayId = await dayOf(foreign, foreignItemId);
    await discardQueuedJobs();

    await runInTenant(tenant, () => cp.createRelation(typeEdge(p, itemId, typeId)));

    expect(await tickAndRecomputeJobs()).toEqual({ tick: [tickJob(p, itemId)], recompute: [recomputeJob(p, dayId)] });
    await discardQueuedJobs();

    await runInTenant(other, () => cp.createRelation(typeEdge(foreign, foreignItemId, foreignTypeId)));

    expect(await tickAndRecomputeJobs()).toEqual({
      tick: [tickJob(foreign, foreignItemId)],
      recompute: [recomputeJob(foreign, foreignDayId)],
    });
  });
});
