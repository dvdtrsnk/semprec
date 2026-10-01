import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { countJobsByIdentifier } from "@semprec/queue/testSupport";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  ApprovalRequiredError,
  createAgentRun,
  createChokePoint,
  decideAndEnqueueApprovalRequest,
  getApprovalRequest,
  loadFullModuleRegistry,
  type ApprovalRequest,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import { createGenericOperationGateway } from "@semprec/application";
import { CAPABILITY_IDS, type AuthenticatedActor } from "@semprec/shared";
import { createApiQueueRuntime, type ApiQueueRuntime } from "../queueRuntime.js";

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
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'unused') RETURNING id`,
    [`${randomUUID()}@example.com`],
  );
  return rows[0]!.id;
}

/** Mirrors `genericOperationGateway.test.ts`'s `createPendingDeleteAndApprove`: an agent-run `item.delete`, gated, then approved (which enqueues `approvalExecute`). */
async function createPendingDeleteAndApprove(pool: Pool): Promise<{ requestId: string; itemId: string }> {
  const chokePoint = createChokePoint(pool);
  const gateway = createGenericOperationGateway(pool);
  const database = await chokePoint.createDatabase({ name: "Approval replay composition DB" });
  const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
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

  const decidedByUserId = await createUser(pool);
  const decided = await withTransaction(pool, (client) =>
    decideAndEnqueueApprovalRequest(client, { approvalRequestId: requestId, decision: "approved", decidedByUserId }),
  );
  expect(decided!.status).toBe("approved");
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
    await enqueueJob(pool, CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE, { approvalRequestId: requestId });
    await waitFor(async () => (await countJobsByIdentifier(pool, CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE)) === 0);
    expect(await getApprovalRequest(pool, requestId)).toEqual(finished);
  });
});
