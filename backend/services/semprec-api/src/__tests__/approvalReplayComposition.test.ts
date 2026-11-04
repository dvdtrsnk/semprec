import type { CollectionMetadataResolver } from "@semprec/data";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { countJobsByIdentifier } from "@semprec/queue/testSupport";
import {
  getTenantZeroId,
  getTestPool,
  inTenantZero,
  registerRelationEdgeWriteHook,
  resetDatabase,
} from "@semprec/data/testSupport";
import {
  ApprovalRequiredError,
  createAgentRun,
  createUser as createAuthUser,
  createChokePoint,
  decideAndEnqueueApprovalRequest,
  getApprovalRequest,
  hashPassword,
  login,
  requireApprovalForWrite,
  loadFullModuleRegistry,
  type ApprovalRequest,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import { createGenericOperationGateway } from "@semprec/application";
import { CAPABILITY_IDS, type AuthenticatedActor } from "@semprec/shared";
import { createApiQueueRuntime, type ApiQueueRuntime } from "../queueRuntime.js";
import { createMcpRequestListener } from "../mcp/mcpHandler.js";

const testMetadataResolver: CollectionMetadataResolver = {
  resolve: () => ({ icon: null, color: null, overviewOrder: null, switcherOrder: null, clientVisible: true }),
};

const ALL_CAPABILITIES = new Set(CAPABILITY_IDS);
const TERMINAL_EXECUTION_STATUSES: ReadonlySet<ApprovalRequest["executionStatus"]> = new Set([
  "succeeded",
  "conflict",
  "legacy_terminal",
]);

/** Polls `check` until it returns `true` or `timeoutMs` elapses, then fails via the final assertion. */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  expect(await check()).toBe(true);
}

async function createUser(pool: Pool): Promise<string> {
  return (
    await createAuthUser(pool, {
      email: "approval@example.test",
      passwordHash: await hashPassword("test-password"),
      tenantId: getTenantZeroId(),
    })
  ).id;
}

/** Mirrors `genericOperationGateway.test.ts`'s `createPendingDeleteAndApprove`: an agent-run `item.delete`, gated, then approved (which enqueues `approvalExecute`). */
async function createPendingDeleteAndApprove(pool: Pool): Promise<{ requestId: string; itemId: string }> {
  const chokePoint = createChokePoint(pool);
  const gateway = createGenericOperationGateway(pool, testMetadataResolver);
  const database = await chokePoint.createDatabase({ name: "Approval replay composition DB" });
  const item = await inTenantZero(() => chokePoint.createItem({ databaseId: database.id, properties: {} }));
  const projectItemId = randomUUID();
  const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "delete it" });
  const actor: AuthenticatedActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };

  let requestId: string;
  try {
    await gateway.invoke("item.delete", actor, ALL_CAPABILITIES, { itemId: item.id });
    expect.unreachable("expected ApprovalRequiredError");
  } catch (err) {
    expect(err).toBeInstanceOf(ApprovalRequiredError);
    requestId = (err as ApprovalRequiredError).details.approvalRequestId;
  }

  const decided = await inTenantZero(() =>
    withTransaction(pool, (client) =>
      decideAndEnqueueApprovalRequest(client, {
        approvalRequestId: requestId,
        decision: "approved",
        decidedByUserId: run.actorUserId,
      }),
    ),
  );
  expect(decided!.request.status).toBe("approved");
  return { requestId, itemId: item.id };
}

let pool: Pool;
let runtime: ApiQueueRuntime | undefined;
let previousInternalToken: string | undefined;

describe("createApiQueueRuntime generic-operation approval replay (issue #646)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
    // `createAgentRun` attributes the run to the earliest account, so one must exist.
    await createUser(pool);
    runtime = undefined;
    // `createApiActionRegistry` composes `core.agentGuidanceDrift` eagerly, which requires it.
    previousInternalToken = process.env.AI_GATEWAY_INTERNAL_TOKEN;
    process.env.AI_GATEWAY_INTERNAL_TOKEN = randomUUID();
  });

  afterEach(async () => {
    await runtime?.stop();
    if (previousInternalToken === undefined) delete process.env.AI_GATEWAY_INTERNAL_TOKEN;
    else process.env.AI_GATEWAY_INTERNAL_TOKEN = previousInternalToken;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("executes an approved item.delete through the real runtime, exactly once across a redelivery", async () => {
    const { requestId, itemId } = await createPendingDeleteAndApprove(pool);
    runtime = await createApiQueueRuntime(pool, await loadFullModuleRegistry());

    await waitFor(async () => {
      const request = await getApprovalRequest(pool, requestId);
      return request !== null && TERMINAL_EXECUTION_STATUSES.has(request.executionStatus);
    });

    const finished = await getApprovalRequest(pool, requestId);
    expect(finished!.executionStatus).toBe("succeeded");
    expect(finished!.executedAt).not.toBeNull();
    expect((finished!.executionResult as { result: { id: string } }).result.id).toBe(itemId);
    expect(JSON.stringify(finished!.executionResult)).not.toContain(
      "No generic-operation approval replay handler is configured",
    );
    expect(await createChokePoint(pool).findItem(itemId)).toBeNull();

    // Redelivery: a second `approvalExecute` for the same request completes without touching the row.
    await inTenantZero(() =>
      enqueueJob(pool, CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE, { approvalRequestId: requestId }),
    );
    await waitFor(async () => (await countJobsByIdentifier(pool, CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE)) === 0);
    expect(await getApprovalRequest(pool, requestId)).toEqual(finished);
  });

  it("executes a flagged relation write from a human MCP session without an approval request", async () => {
    const cp = createChokePoint(pool);
    const source = await cp.createDatabase({ name: "MCP source" });
    const target = await cp.createDatabase({ name: "MCP target" });
    const { property } = await cp.createRelationProperty({
      sourceDatabaseId: source.id,
      targetDatabaseId: target.id,
      key: "target",
      name: "Target",
      cardinality: "one_to_one",
    });
    const caller = await cp.createItem({ databaseId: source.id, properties: {} });
    const item = await cp.createItem({ databaseId: target.id, properties: {} });
    let active = true;
    const observed: string[] = [];
    registerRelationEdgeWriteHook(async ({ client, edgeContext, writer }) => {
      if (!active || edgeContext.property.id !== property.id) return;
      observed.push(writer.writerKind);
      requireApprovalForWrite(client, writer, [{ kind: "testReason" }]);
    });
    const gateway = createGenericOperationGateway(pool, testMetadataResolver);
    const server = createServer(createMcpRequestListener(pool, gateway, ALL_CAPABILITIES));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      const { token } = await login(pool, {
        email: "approval@example.test",
        password: "test-password",
        platform: "ios",
        ip: "127.0.0.1",
      });
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "semprec.relation.set",
            arguments: { relationPropertyId: property.id, callerItemId: caller.id, targetItemId: item.id },
          },
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: { content: expect.any(Array) } });
      expect(observed).toEqual(["agent"]);
      expect(await cp.listItemRelations(caller.id, property.id)).toMatchObject([{ targetItemId: item.id }]);
      const requests = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM approval_requests");
      expect(requests.rows[0]?.count).toBe("0");
    } finally {
      active = false;
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("replays a flagged relation set through the real approval worker once", async () => {
    const cp = createChokePoint(pool);
    const source = await cp.createDatabase({ name: "Worker source" });
    const target = await cp.createDatabase({ name: "Worker target" });
    const { property } = await cp.createRelationProperty({
      sourceDatabaseId: source.id,
      targetDatabaseId: target.id,
      key: "target",
      name: "Target",
      cardinality: "one_to_one",
    });
    const caller = await cp.createItem({ databaseId: source.id, properties: {} });
    const first = await cp.createItem({ databaseId: target.id, properties: {} });
    const second = await cp.createItem({ databaseId: target.id, properties: {} });
    await cp.setRelation({ relationPropertyId: property.id, callerItemId: caller.id, targetItemId: first.id });
    const projectItemId = randomUUID();
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "replace" });
    const actor: AuthenticatedActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
    let active = true;
    const writers: Array<{ kind: string; requestId?: string }> = [];
    registerRelationEdgeWriteHook(async ({ client, edgeContext, writer }) => {
      if (!active || edgeContext.property.id !== property.id) return;
      writers.push({ kind: writer.writerKind, requestId: writer.approvedRequestId });
      requireApprovalForWrite(client, writer, [{ kind: "testReason" }]);
    });
    try {
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
      let requestId = "";
      try {
        await inTenantZero(() =>
          gateway.invoke("relation.set", actor, ALL_CAPABILITIES, {
            relationPropertyId: property.id,
            callerItemId: caller.id,
            targetItemId: second.id,
          }),
        );
        expect.unreachable("Expected approval");
      } catch (err) {
        if (!(err instanceof ApprovalRequiredError)) throw err;
        requestId = err.details.approvalRequestId;
      }
      await inTenantZero(() =>
        withTransaction(pool, (client) =>
          decideAndEnqueueApprovalRequest(client, {
            approvalRequestId: requestId,
            decision: "approved",
            decidedByUserId: run.actorUserId,
          }),
        ),
      );
      runtime = await createApiQueueRuntime(pool, await loadFullModuleRegistry());
      await waitFor(async () => (await getApprovalRequest(pool, requestId))?.executionStatus === "succeeded");
      expect(await cp.listItemRelations(caller.id, property.id)).toMatchObject([{ targetItemId: second.id }]);
      expect(writers).toEqual([
        { kind: "agent", requestId: undefined },
        { kind: "agent", requestId },
      ]);
      await inTenantZero(() =>
        enqueueJob(pool, CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE, { approvalRequestId: requestId }),
      );
      await waitFor(async () => (await countJobsByIdentifier(pool, CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE)) === 0);
      expect(writers).toHaveLength(2);
    } finally {
      active = false;
    }
  });
});
