import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  createTenantZeroUser,
  getTestPool,
  inTenantZero,
  registerRelationEdgeDeleteHook,
  resetDatabase,
} from "@semprec/data/testSupport";
import { runOnce } from "@semprec/queue";
import * as data from "@semprec/data";
import {
  createAgentRun,
  createChokePoint,
  createCoreTaskList,
  createViewTypeRegistry,
  decideAndEnqueueApprovalRequest,
  getApprovalRequest,
  getDatabaseByModuleId,
  seedSystem,
  withTransaction,
  type ApprovalRequiredError,
  type ChokePoint,
  type WriterIdentity,
} from "@semprec/data";
import { CAPABILITY_IDS, type AuthenticatedActor } from "@semprec/shared";
import { createGenericOperationGateway, replayApprovedGenericOperation } from "../genericOperationGateway.js";

// The approved-operation executor calls these two data-layer functions by name; wrapping them
// (still running the real implementation) records the writer it passes.
vi.mock("@semprec/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@semprec/data")>();
  return {
    ...actual,
    itemDeleteWithClient: vi.fn(actual.itemDeleteWithClient),
    deleteRelationWithClient: vi.fn(actual.deleteRelationWithClient),
  };
});

const ALL_CAPABILITIES = new Set(CAPABILITY_IDS);

let pool: Pool;
let chokePoint: ChokePoint;
// Hooks cannot be unregistered; this recorder is emptied before each test.
const edgeDeletesBy: WriterIdentity[] = [];
registerRelationEdgeDeleteHook(async (context) => {
  edgeDeletesBy.push(context.writer);
});

async function makeAgentActor(): Promise<AuthenticatedActor> {
  const projects = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects"));
  const projectItemId = (await chokePoint.createItem({ databaseId: projects!.id, properties: {} })).id;
  const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "approved delete" });
  return { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
}

/** Requests a destructive operation as the agent and approves the queued request. */
async function approve(operation: "item.delete" | "relation.delete", actor: AuthenticatedActor, input: unknown) {
  let requestId = "";
  try {
    await createGenericOperationGateway(pool).invoke(operation, actor, ALL_CAPABILITIES, input);
    expect.unreachable("expected ApprovalRequiredError");
  } catch (err) {
    requestId = (err as ApprovalRequiredError).details.approvalRequestId;
  }
  await inTenantZero(() =>
    withTransaction(pool, (client) =>
      decideAndEnqueueApprovalRequest(client, {
        approvalRequestId: requestId,
        decision: "approved",
        decidedByUserId: actor.userId,
      }),
    ),
  );
  return requestId;
}

describe("approved destructive operations write as the requesting agent (issue #1415)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    vi.mocked(data.itemDeleteWithClient).mockClear();
    vi.mocked(data.deleteRelationWithClient).mockClear();
    edgeDeletesBy.length = 0;
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    await createTenantZeroUser(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("the approvalExecute job executes an approved item.delete with agent, the request's run id and project, and its user", async () => {
    await inTenantZero(async () => {
      const database = await chokePoint.createDatabase({ name: "Approved delete" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      const actor = await makeAgentActor();
      const requestId = await approve("item.delete", actor, { itemId: item.id });
      const request = await getApprovalRequest(pool, requestId);

      // Only the trailing replay slot matters; the other positional parameters default sensibly.
      const taskList = createCoreTaskList(
        pool,
        new Map(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        replayApprovedGenericOperation,
      );
      await runOnce({ pgPool: pool, taskList });

      expect(data.itemDeleteWithClient).toHaveBeenCalledTimes(1);
      expect(vi.mocked(data.itemDeleteWithClient).mock.calls[0]?.[3]).toMatchObject({
        writer: {
          writerKind: "agent",
          agentRunId: request!.agentRunId,
          agentProjectItemId: actor.agentProjectItemId,
          onBehalfOfUserId: actor.userId,
        },
      });
      expect((await getApprovalRequest(pool, requestId))?.executionStatus).toBe("succeeded");
      expect(await chokePoint.findItem(item.id)).toBeNull();
    });
  });

  it("an approved relation.delete executes with agent, the request's run id and project, and its user", async () => {
    await inTenantZero(async () => {
      const a = await chokePoint.createDatabase({ name: "A" });
      const b = await chokePoint.createDatabase({ name: "B" });
      const { property } = await chokePoint.createRelationProperty({
        sourceDatabaseId: a.id,
        key: "bs",
        name: "Bs",
        targetDatabaseId: b.id,
      });
      const itemA = await chokePoint.createItem({ databaseId: a.id, properties: {} });
      const itemB = await chokePoint.createItem({ databaseId: b.id, properties: {} });
      const input = { relationPropertyId: property.id, callerItemId: itemA.id, targetItemId: itemB.id };
      await chokePoint.createRelation(input);
      const actor = await makeAgentActor();
      const requestId = await approve("relation.delete", actor, input);
      const request = await getApprovalRequest(pool, requestId);

      const outcome = await replayApprovedGenericOperation(pool, request as never);

      expect(outcome.error).toBe(false);
      const expected: WriterIdentity = {
        writerKind: "agent",
        agentRunId: request!.agentRunId,
        agentProjectItemId: actor.agentProjectItemId,
        onBehalfOfUserId: actor.userId,
      };
      expect(vi.mocked(data.deleteRelationWithClient).mock.calls[0]?.[3]).toEqual(expected);
      // The edge-delete hook is what a consumer observes: it sees the agent and the request's run id.
      expect(edgeDeletesBy).toEqual([expected]);
    });
  });
});
