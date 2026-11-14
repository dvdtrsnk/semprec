// Issue gh-1882: an agent's `item.delete` on a recurring task reports what the delete reaches in its approval, and an
// approval granted for one impact is not executed once the series changed.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createSeriesOccurrence,
  createTenantZeroUser,
  getTestPool,
  inTenantZero,
  resetDatabase,
  startTaskSeries,
} from "@semprec/data/testSupport";
import {
  buildDestructiveApprovalDescription,
  createAgentRun,
  createChokePoint,
  createRelationWithClient,
  createViewTypeRegistry,
  decideAndEnqueueApprovalRequest,
  getApprovalRequest,
  getDatabaseByModuleId,
  isGenericOperationApprovalRequestPayload,
  seedSystem,
  withTransaction,
  type ApprovalRequest,
  type ApprovalRequiredError,
  type ChokePoint,
  type CollectionMetadataResolver,
  type GenericOperationApprovalRequestPayload,
} from "@semprec/data";
import { CAPABILITY_IDS, type AuthenticatedActor } from "@semprec/shared";
import { createGenericOperationGateway, replayApprovedGenericOperation } from "../genericOperationGateway.js";

const testMetadataResolver: CollectionMetadataResolver = {
  resolve: () => ({
    icon: null,
    color: null,
    overviewOrder: null,
    switcherOrder: null,
    clientVisible: true,
    overviewHidden: false,
  }),
  collectionFilter: () => undefined,
  overviewHideable: () => false,
};

const ALL_CAPABILITIES = new Set(CAPABILITY_IDS);

let pool: Pool;
let chokePoint: ChokePoint;
let tasksDatabaseId: string;

async function propertyId(databaseKey: string, key: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT p.id FROM properties p JOIN databases d ON d.id = p.database_id
     WHERE d.owner_module_id = $1 AND p.key = $2`,
    [databaseKey, key],
  );
  if (!rows[0]) throw new Error(`Property ${databaseKey}.${key} missing`);
  return rows[0].id;
}

async function makeAgentActor(): Promise<AuthenticatedActor> {
  const projects = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects"));
  const projectItemId = (await chokePoint.createItem({ databaseId: projects!.id, properties: {} })).id;
  const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "delete a series" });
  return { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
}

/** Raises the agent's `item.delete` request and approves it; the request is not replayed. */
async function raiseApprovedDelete(actor: AuthenticatedActor, itemId: string): Promise<string> {
  let requestId = "";
  try {
    await createGenericOperationGateway(pool, testMetadataResolver).invoke("item.delete", actor, ALL_CAPABILITIES, {
      itemId,
    });
    expect.unreachable("expected ApprovalRequiredError");
  } catch (err) {
    requestId = (err as ApprovalRequiredError).details.approvalRequestId;
  }
  await withTransaction(pool, (client) =>
    decideAndEnqueueApprovalRequest(client, {
      approvalRequestId: requestId,
      decision: "approved",
      decidedByUserId: actor.userId,
    }),
  );
  return requestId;
}

/** Resolves once a statement whose text contains `fragment` waits for a lock held by another transaction. */
async function waitUntilBlocked(fragment: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1",
      [`%${fragment}%`],
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No statement containing '${fragment}' ever waited for a lock`);
}

async function loadRequest(requestId: string) {
  const request = await getApprovalRequest(pool, requestId);
  if (!request || !isGenericOperationApprovalRequestPayload(request.payload)) throw new Error("Missing request");
  return request as ApprovalRequest & { payload: GenericOperationApprovalRequestPayload };
}

/**
 * A series of two instances, the first completed and the second open, with one attachment and one host Event on the
 * first. Returns the first.
 */
async function seriesWithEdges(): Promise<{ first: string; second: string; seriesId: string }> {
  const task = await chokePoint.createItem({
    databaseId: tasksDatabaseId,
    properties: { name: "Weekly review", date: "2026-10-12" },
  });
  const seriesId = await startTaskSeries(pool, {
    databaseId: tasksDatabaseId,
    itemId: task.id,
    mode: "fixed",
    rule: { kind: "weekdays", days: ["mon"] },
  });
  const events = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "events"));
  const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "files"));
  const event = await chokePoint.createItem({
    databaseId: events!.id,
    properties: { name: "Workshop", date: "2026-10-16" },
  });
  const file = await chokePoint.createItem({ databaseId: files!.id, properties: { name: "checklist.pdf" } });
  await chokePoint.createRelation({
    relationPropertyId: await propertyId("tasks", "files"),
    callerItemId: task.id,
    targetItemId: file.id,
  });
  const hostEvents = await propertyId("tasks", "hostEvents");
  await withTransaction(pool, (client) =>
    createRelationWithClient(
      client,
      {
        relationPropertyId: hostEvents,
        callerItemId: task.id,
        targetItemId: event.id,
        metadata: { addedAt: "2026-10-15T10:00:00.000Z" },
      },
      { ownerProcess: "tasks" },
    ),
  );
  await chokePoint.updateItem({ databaseId: tasksDatabaseId, itemId: task.id, propertiesPatch: { status: "done" } });
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM items WHERE properties->>'seriesId' = $1 AND id <> $2",
    [seriesId, task.id],
  );
  if (rows.length !== 1) throw new Error("The completion created no second instance");
  return { first: task.id, second: rows[0]!.id, seriesId };
}

describe("an agent's item.delete of a recurring task (issue gh-1882)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    await createTenantZeroUser(pool);
    tasksDatabaseId = (await inTenantZero(() =>
      withTransaction(pool, (client) => getDatabaseByModuleId(client, "tasks")),
    ))!.id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("shows the series instance, attachment and host Event counts in the approval request", async () => {
    await inTenantZero(async () => {
      const { first } = await seriesWithEdges();
      const actor = await makeAgentActor();

      const requestId = await raiseApprovedDelete(actor, first);

      const description = (await getApprovalRequest(pool, requestId))!.description;
      expect(description).toEqual({
        key: "approval.itemDelete",
        params: {
          itemName: "Weekly review",
          databaseKey: "tasks",
          databaseName: "tasks",
          linkedCount: 2,
          restorableDays: 30,
          seriesInstanceCount: 2,
          attachmentCount: 1,
          hostEventCount: 1,
        },
      });
      // The notification the approver gets says the same, in words (the tenant's user reads Czech).
      const { rows } = await pool.query<{ body: string }>(
        "SELECT body FROM notifications WHERE source_table = 'approval_requests' AND source_id = $1",
        [requestId],
      );
      expect(rows[0]?.body).toContain("instancí v jeho řadě: 2, příloh: 1, událostí, ve kterých je zařazen: 1");
    });
  });

  it("trashes the whole series when the approved request is executed with the series as it was", async () => {
    await inTenantZero(async () => {
      const { first, second, seriesId } = await seriesWithEdges();
      const actor = await makeAgentActor();
      const requestId = await raiseApprovedDelete(actor, first);

      const outcome = await replayApprovedGenericOperation(pool, await loadRequest(requestId));

      expect(outcome.error).toBe(false);
      expect(await chokePoint.findItem(first)).toBeNull();
      expect(await chokePoint.findItem(second)).toBeNull();
      expect((await getApprovalRequest(pool, requestId))!.executionStatus).toBe("succeeded");
      const { rows } = await pool.query<{ active: boolean; trashed_active_item_id: string | null }>(
        "SELECT active, trashed_active_item_id FROM task_recurrence WHERE series_id = $1",
        [seriesId],
      );
      expect(rows).toEqual([{ active: false, trashed_active_item_id: second }]);
    });
  });

  it("refuses an approved request as a stale snapshot, with the current numbers, after the series gained an instance", async () => {
    await inTenantZero(async () => {
      const { first, second } = await seriesWithEdges();
      const actor = await makeAgentActor();
      const requestId = await raiseApprovedDelete(actor, first);
      const before = await chokePoint.findItem(first);
      // Completing the open instance stores the series' third instance and does not touch the instance the request names.
      await chokePoint.updateItem({ databaseId: tasksDatabaseId, itemId: second, propertiesPatch: { status: "done" } });
      expect((await chokePoint.findItem(first))?.updatedAt).toBe(before?.updatedAt);

      const outcome = await replayApprovedGenericOperation(pool, await loadRequest(requestId));

      expect(outcome.error).toBe(true);
      expect(await chokePoint.findItem(first)).not.toBeNull();
      expect(await chokePoint.findItem(second)).not.toBeNull();
      const persisted = await getApprovalRequest(pool, requestId);
      expect(persisted!.executionStatus).toBe("conflict");
      const failure = (
        persisted!.executionResult as {
          error: { code: string; details: { currentResource: { impact: Record<string, number> } } };
        }
      ).error;
      expect(failure.code).toBe("version_conflict");
      expect(failure.details.currentResource.impact).toEqual({
        seriesInstanceCount: 3,
        attachmentCount: 1,
        hostEventCount: 1,
      });
      const { rows } = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM items WHERE deleted_at IS NOT NULL",
      );
      expect(rows).toEqual([{ n: 0 }]);
    });
  });

  it("leaves an attachment the agent's project may not read out of the counts of the approval", async () => {
    await inTenantZero(async () => {
      const { first } = await seriesWithEdges();
      const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "files"));
      const health = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "healthRecords"));
      const sensitiveFile = await chokePoint.createItem({ databaseId: files!.id, properties: { name: "scan.pdf" } });
      const record = await chokePoint.createItem({ databaseId: health!.id, properties: { name: "Diagnosis" } });
      await chokePoint.createRelation({
        relationPropertyId: await propertyId("tasks", "files"),
        callerItemId: first,
        targetItemId: sensitiveFile.id,
      });
      await chokePoint.createRelation({
        relationPropertyId: await propertyId("files", "healthRecords"),
        callerItemId: sensitiveFile.id,
        targetItemId: record.id,
      });
      const actor = await makeAgentActor();

      const requestId = await raiseApprovedDelete(actor, first);

      // The task has two attachments, one of which inherits the sensitivity of the health record.
      expect((await getApprovalRequest(pool, requestId))!.description).toMatchObject({
        params: { seriesInstanceCount: 2, attachmentCount: 1, hostEventCount: 1 },
      });
    });
  });

  it("refuses the request as a stale snapshot when an instance is stored while the replay waits for the series", async () => {
    await inTenantZero(async () => {
      const { first, second, seriesId } = await seriesWithEdges();
      const actor = await makeAgentActor();
      const requestId = await raiseApprovedDelete(actor, first);
      const request = await loadRequest(requestId);
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let markLocked!: () => void;
      const locked = new Promise<void>((resolve) => {
        markLocked = resolve;
      });
      // A writer of the series that holds the open instance, as the advance and the materializing of an occurrence do.
      const holder = withTransaction(pool, async (client) => {
        await client.query("SELECT id FROM items WHERE id = $1 FOR UPDATE", [second]);
        markLocked();
        await released;
      });
      await locked;
      let outcome: { error: boolean; result: string };
      try {
        const replay = replayApprovedGenericOperation(pool, request);
        await waitUntilBlocked("properties->>$2");
        // The writer stores the series' third instance and commits while the replay waits.
        await createSeriesOccurrence(pool, {
          databaseId: tasksDatabaseId,
          seriesId,
          occurrenceDate: "2026-10-26",
          status: "notDone",
        });
        release();
        await holder;
        outcome = await replay;
      } finally {
        release();
        await holder;
      }

      // The instance the approval did not count is not trashed with the others.
      expect(outcome.error).toBe(true);
      expect((await getApprovalRequest(pool, requestId))!.executionStatus).toBe("conflict");
      const { rows } = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM items WHERE deleted_at IS NOT NULL",
      );
      expect(rows).toEqual([{ n: 0 }]);
    });
  });

  it("describes a task without a series with its own attachment and host Event counts", async () => {
    await inTenantZero(async () => {
      const task = await chokePoint.createItem({ databaseId: tasksDatabaseId, properties: { name: "Plain" } });
      const actor = await makeAgentActor();

      const requestId = await raiseApprovedDelete(actor, task.id);

      expect((await getApprovalRequest(pool, requestId))!.description).toMatchObject({
        key: "approval.itemDelete",
        params: { seriesInstanceCount: 0, attachmentCount: 0, hostEventCount: 0 },
      });
    });
  });

  it("describes an item of another database without the counts", async () => {
    await inTenantZero(async () => {
      const projects = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects"));
      const project = await chokePoint.createItem({ databaseId: projects!.id, properties: { name: "Household" } });
      const actor = await makeAgentActor();

      const requestId = await raiseApprovedDelete(actor, project.id);

      const params = (await getApprovalRequest(pool, requestId))!.description?.params ?? {};
      expect(Object.keys(params)).not.toContain("seriesInstanceCount");
      expect(Object.keys(params)).not.toContain("attachmentCount");
      expect(Object.keys(params)).not.toContain("hostEventCount");
    });
  });

  it("refuses to describe a request whose projection carries a malformed impact", async () => {
    await inTenantZero(async () => {
      const task = await chokePoint.createItem({ databaseId: tasksDatabaseId, properties: { name: "Plain" } });

      await expect(
        withTransaction(pool, (client) =>
          buildDestructiveApprovalDescription(
            client,
            { operation: "item.delete", input: { itemId: task.id } },
            { impact: { seriesInstanceCount: "3", attachmentCount: 0, hostEventCount: 0 } },
          ),
        ),
      ).rejects.toThrow("Invalid item delete impact in the approval projection");
    });
  });
});
