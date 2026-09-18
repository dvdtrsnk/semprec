import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { runOnce } from "@semprec/queue";
import {
  ApprovalRequiredError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  createAgentRun,
  createChokePoint,
  createCoreTaskList,
  createViewTypeRegistry,
  decideAndEnqueueApprovalRequest,
  getApprovalRequest,
  seedSystem,
  withTransaction,
  type ApprovalRequest,
  type ChokePoint,
  type GenericOperationApprovalRequestPayload,
} from "@semprec/data";
import { CAPABILITY_IDS, GENERIC_OPERATION_NAMES, OPERATION_METADATA, type AuthenticatedActor } from "@semprec/shared";
import { createGenericOperationGateway, replayApprovedGenericOperation } from "../genericOperationGateway.js";

let pool: Pool;
let chokePoint: ChokePoint;

const ALL_CAPABILITIES = new Set(CAPABILITY_IDS);
const NO_CAPABILITIES = new Set<(typeof CAPABILITY_IDS)[number]>();

async function createUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'unused') RETURNING id`,
    [`${randomUUID()}@example.com`],
  );
  return rows[0]!.id;
}

describe("createGenericOperationGateway (issue #220)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    await createUser();
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe("listOperations", () => {
    it("returns only the operations whose capability is granted, never present-but-forbidden", () => {
      const gateway = createGenericOperationGateway(pool);

      expect(gateway.listOperations(NO_CAPABILITIES)).toEqual([]);
      expect(gateway.listOperations(ALL_CAPABILITIES)).toEqual([...GENERIC_OPERATION_NAMES]);

      const readOnly = new Set(["core.item.read"] as const);
      const expected = GENERIC_OPERATION_NAMES.filter(
        (operation) => OPERATION_METADATA[operation].requiresCapability === "core.item.read",
      );
      expect(gateway.listOperations(readOnly)).toEqual(expected);
    });
  });

  describe("invoke", () => {
    it("throws NotFoundError for an operation whose capability isn't granted, indistinguishable from unknown", async () => {
      const gateway = createGenericOperationGateway(pool);
      const actor: AuthenticatedActor = { userId: await createUser() };

      await expect(gateway.invoke("item.get", actor, NO_CAPABILITIES, { itemId: randomUUID() })).rejects.toThrow(
        NotFoundError,
      );
    });

    it("rejects an agent actor carrying runId without agentProjectItemId as owner_violation", async () => {
      const gateway = createGenericOperationGateway(pool);
      const actor: AuthenticatedActor = { userId: await createUser(), runId: randomUUID() };

      try {
        await gateway.invoke("item.get", actor, ALL_CAPABILITIES, { itemId: randomUUID() });
        expect.unreachable("expected ForbiddenError");
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenError);
        expect((err as ForbiddenError).code).toBe("owner_violation");
      }
    });

    it("rejects an agent actor carrying agentProjectItemId without runId as owner_violation", async () => {
      const gateway = createGenericOperationGateway(pool);
      const actor: AuthenticatedActor = { userId: await createUser(), agentProjectItemId: randomUUID() };

      try {
        await gateway.invoke("item.get", actor, ALL_CAPABILITIES, { itemId: randomUUID() });
        expect.unreachable("expected ForbiddenError");
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenError);
        expect((err as ForbiddenError).code).toBe("owner_violation");
      }
    });

    it("throws ValidationError for input that fails the operation's own zod binding", async () => {
      const gateway = createGenericOperationGateway(pool);
      const actor: AuthenticatedActor = { userId: await createUser() };

      await expect(gateway.invoke("item.get", actor, ALL_CAPABILITIES, {})).rejects.toThrow(ValidationError);
    });

    it("executes a non-destructive operation immediately for a REST-style human actor", async () => {
      const gateway = createGenericOperationGateway(pool);
      const actor: AuthenticatedActor = { userId: await createUser() };
      const database = await chokePoint.createDatabase({ name: "Gateway DB" });
      await chokePoint.createProperty({ databaseId: database.id, key: "title", name: "Title", type: "title" });

      const created = await gateway.invoke("item.create", actor, ALL_CAPABILITIES, {
        databaseId: database.id,
        properties: { title: "Made by gateway" },
      });

      expect(created.id).toBeDefined();
      const persisted = await chokePoint.findItem(created.id);
      expect(persisted?.properties).toMatchObject({ title: "Made by gateway" });
    });

    it("executes a destructive operation immediately for a REST-style human actor (no runId, so never approval-gated)", async () => {
      const gateway = createGenericOperationGateway(pool);
      const actor: AuthenticatedActor = { userId: await createUser() };
      const database = await chokePoint.createDatabase({ name: "Gateway DB 2" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });

      await gateway.invoke("item.delete", actor, ALL_CAPABILITIES, { itemId: item.id });

      expect(await chokePoint.findItem(item.id)).toBeNull();
      const { rows } = await pool.query(`SELECT count(*)::int AS count FROM approval_requests`);
      expect(rows[0].count).toBe(0);
    });

    it("defers a destructive operation for a full agent actor: no execution, one pending approval_requests row, ApprovalRequiredError", async () => {
      const gateway = createGenericOperationGateway(pool);
      const userId = await createUser();
      const database = await chokePoint.createDatabase({ name: "Gateway DB 3" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      const projectItemId = randomUUID();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "delete it" });
      const actor: AuthenticatedActor = { userId, runId: run.id, agentProjectItemId: projectItemId };

      try {
        await gateway.invoke("item.delete", actor, ALL_CAPABILITIES, { itemId: item.id });
        expect.unreachable("expected ApprovalRequiredError");
      } catch (err) {
        expect(err).toBeInstanceOf(ApprovalRequiredError);
        const details = (err as ApprovalRequiredError).details;
        expect(details.approvalRequestId).toBeDefined();
        expect(details.link).toContain(details.approvalRequestId);

        const request = await getApprovalRequest(pool, details.approvalRequestId);
        expect(request).not.toBeNull();
        expect(request!.status).toBe("pending");
        expect(request!.agentRunId).toBe(run.id);
        expect(request!.toolName).toBe("item.delete");
        expect(request!.riskClass).toBe("destructive");
      }

      // The operation itself never executed.
      expect(await chokePoint.findItem(item.id)).not.toBeNull();
      const { rows } = await pool.query(`SELECT count(*)::int AS count FROM approval_requests`);
      expect(rows[0].count).toBe(1);
    });

    it("executes a non-destructive operation immediately for a full agent actor (no approval gate)", async () => {
      const gateway = createGenericOperationGateway(pool);
      const userId = await createUser();
      const database = await chokePoint.createDatabase({ name: "Gateway DB 4" });
      await chokePoint.createProperty({ databaseId: database.id, key: "title", name: "Title", type: "title" });
      const projectItemId = randomUUID();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "create it" });
      const actor: AuthenticatedActor = { userId, runId: run.id, agentProjectItemId: projectItemId };

      const created = await gateway.invoke("item.create", actor, ALL_CAPABILITIES, {
        databaseId: database.id,
        properties: { title: "Made by an agent" },
      });

      expect(await chokePoint.findItem(created.id)).not.toBeNull();
      const { rows } = await pool.query(`SELECT count(*)::int AS count FROM approval_requests`);
      expect(rows[0].count).toBe(0);
    });
  });

  describe("replayApprovedGenericOperation", () => {
    async function createPendingDelete(): Promise<{ requestId: string; run: { id: string }; item: { id: string } }> {
      const gateway = createGenericOperationGateway(pool);
      const database = await chokePoint.createDatabase({ name: "Replay DB" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      const projectItemId = randomUUID();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "delete it" });
      const actor: AuthenticatedActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };

      let requestId: string;
      try {
        await gateway.invoke("item.delete", actor, ALL_CAPABILITIES, { itemId: item.id });
        expect.unreachable("expected ApprovalRequiredError");
        return { requestId: "", run, item };
      } catch (err) {
        requestId = (err as ApprovalRequiredError).details.approvalRequestId;
      }

      // `replayApprovedGenericOperation` itself now rejects a row that isn't `approved` +
      // `queued` (issue #89's locked-execution protocol), so these direct-call tests must
      // decide the request first, same as the worker-path tests below — just without also
      // running the queue job, since they call the executor themselves.
      const decidedByUserId = await createUser();
      await withTransaction(pool, (client) =>
        decideAndEnqueueApprovalRequest(client, {
          approvalRequestId: requestId,
          decision: "approved",
          decidedByUserId,
        }),
      );

      return { requestId, run, item };
    }

    it("replays an approved, untouched request: executes the real operation and returns its result", async () => {
      const { requestId, item } = await createPendingDelete();
      const request = (await getApprovalRequest(pool, requestId)) as ApprovalRequest & {
        payload: GenericOperationApprovalRequestPayload;
      };

      const outcome = await replayApprovedGenericOperation(pool, request);

      expect(outcome.error).toBe(false);
      expect(JSON.parse(outcome.result).result).toMatchObject({ id: item.id });
      expect(await chokePoint.findItem(item.id)).toBeNull();
    });

    it("rejects a request whose payload no longer matches the run's persisted provenance (project_item_id changed) as owner_violation, without executing", async () => {
      const { requestId, run, item } = await createPendingDelete();
      const request = (await getApprovalRequest(pool, requestId)) as ApprovalRequest & {
        payload: GenericOperationApprovalRequestPayload;
      };

      await pool.query(`UPDATE agent_runs SET project_item_id = $1 WHERE id = $2`, [randomUUID(), run.id]);

      const outcome = await replayApprovedGenericOperation(pool, request);

      expect(outcome.error).toBe(true);
      expect(outcome.result).toContain("owner_violation");
      expect(await chokePoint.findItem(item.id)).not.toBeNull();

      // A drifted-provenance rejection is a terminal conflict, not a rollback that leaves the
      // row `queued` forever for graphile to retry against a request that can never revalidate.
      const persisted = await getApprovalRequest(pool, requestId);
      expect(persisted!.executionStatus).toBe("conflict");
      expect(persisted!.executedAt).not.toBeNull();
      expect((persisted!.executionResult as { error: { code: string } }).error.code).toBe("version_conflict");
    });

    it("rejects a request whose stored canonicalInput no longer satisfies the operation's current schema, without executing", async () => {
      const { requestId, item } = await createPendingDelete();
      // Simulates schema drift between queue time and replay time (e.g. a deploy landed
      // in between): the snapshot was valid when parseInput produced it, but a corrupted
      // or now-incompatible stored payload must fail cleanly, not crash inside the binding.
      await pool.query(
        `UPDATE approval_requests SET payload = jsonb_set(payload, '{canonicalInput}', '{}'::jsonb) WHERE id = $1`,
        [requestId],
      );
      const request = (await getApprovalRequest(pool, requestId)) as ApprovalRequest & {
        payload: GenericOperationApprovalRequestPayload;
      };

      const outcome = await replayApprovedGenericOperation(pool, request);

      expect(outcome.error).toBe(true);
      expect(outcome.result).toContain("validation_failed");
      expect(await chokePoint.findItem(item.id)).not.toBeNull();

      const persisted = await getApprovalRequest(pool, requestId);
      expect(persisted!.executionStatus).toBe("conflict");
      expect(persisted!.executedAt).not.toBeNull();
    });

    it("terminalizes as conflict, without executing, when the resource changed after approval (snapshot hash mismatch)", async () => {
      const { requestId, item } = await createPendingDelete();

      // Something else legitimately mutated the item between approval and execution — the
      // resource's current shape (`item_delete`'s snapshot is hashed off `updatedAt`) no longer
      // matches the sha256 snapshotted at approval time.
      await pool.query(`UPDATE items SET updated_at = now() WHERE id = $1`, [item.id]);
      const request = (await getApprovalRequest(pool, requestId)) as ApprovalRequest & {
        payload: GenericOperationApprovalRequestPayload;
      };

      const outcome = await replayApprovedGenericOperation(pool, request);

      expect(outcome.error).toBe(true);
      expect(await chokePoint.findItem(item.id)).not.toBeNull();

      const persisted = await getApprovalRequest(pool, requestId);
      expect(persisted!.executionStatus).toBe("conflict");
      expect(
        (persisted!.executionResult as { error: { code: string; details: { currentResource: unknown } } }).error.code,
      ).toBe("version_conflict");
      expect(
        (persisted!.executionResult as { error: { details: { currentResource: unknown } } }).error.details
          .currentResource,
      ).not.toBeNull();
    });

    it("replaying an already-succeeded request is a no-op: returns the persisted result without executing again", async () => {
      const { requestId, item } = await createPendingDelete();
      const request = (await getApprovalRequest(pool, requestId)) as ApprovalRequest & {
        payload: GenericOperationApprovalRequestPayload;
      };

      const first = await replayApprovedGenericOperation(pool, request);
      expect(first.error).toBe(false);
      expect(await chokePoint.findItem(item.id)).toBeNull();

      const reloaded = (await getApprovalRequest(pool, requestId)) as ApprovalRequest & {
        payload: GenericOperationApprovalRequestPayload;
      };
      const second = await replayApprovedGenericOperation(pool, reloaded);

      // `second.result` round-tripped through jsonb, so Postgres may reorder its keys — compare
      // parsed content, not the raw JSON string, to avoid a spurious key-order mismatch.
      expect(second.error).toBe(first.error);
      expect(JSON.parse(second.result)).toEqual(JSON.parse(first.result));
    });

    it("replaying an already-conflicted request is a no-op: returns the persisted conflict without re-authorizing", async () => {
      const { requestId, run, item } = await createPendingDelete();
      await pool.query(`UPDATE agent_runs SET project_item_id = $1 WHERE id = $2`, [randomUUID(), run.id]);
      const request = (await getApprovalRequest(pool, requestId)) as ApprovalRequest & {
        payload: GenericOperationApprovalRequestPayload;
      };

      const first = await replayApprovedGenericOperation(pool, request);
      expect(first.error).toBe(true);

      // Fix the provenance drift that caused the first conflict — a redelivered job must still
      // see the row as terminal and must not re-run the check, let alone the mutation.
      await pool.query(`UPDATE agent_runs SET project_item_id = $1 WHERE id = $2`, [
        request.payload.actor.agentProjectItemId,
        run.id,
      ]);
      const reloaded = (await getApprovalRequest(pool, requestId)) as ApprovalRequest & {
        payload: GenericOperationApprovalRequestPayload;
      };
      const second = await replayApprovedGenericOperation(pool, reloaded);

      expect(second.error).toBe(first.error);
      expect(JSON.parse(second.result)).toEqual(JSON.parse(first.result));
      expect(await chokePoint.findItem(item.id)).not.toBeNull();
    });
  });

  describe("DestructiveApprovalPreflight (issue #89)", () => {
    it("creates no approval_requests row and no notification when the resource is unauthorized (not found)", async () => {
      const gateway = createGenericOperationGateway(pool);
      const userId = await createUser();
      const projectItemId = randomUUID();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "delete a ghost" });
      const actor: AuthenticatedActor = { userId, runId: run.id, agentProjectItemId: projectItemId };

      await expect(gateway.invoke("item.delete", actor, ALL_CAPABILITIES, { itemId: randomUUID() })).rejects.toThrow(
        NotFoundError,
      );

      const { rows: requestRows } = await pool.query(`SELECT count(*)::int AS count FROM approval_requests`);
      expect(requestRows[0].count).toBe(0);
      const { rows: notificationRows } = await pool.query(`SELECT count(*)::int AS count FROM notifications`);
      expect(notificationRows[0].count).toBe(0);
    });
  });

  describe("handleApprovalRequestExecuteTask (worker path, issue #220)", () => {
    // `createCoreTaskList`'s later positional parameters (library metadata fetcher, mail
    // adapters, ...) are irrelevant to this task and default sensibly on their own; only the
    // trailing `genericOperationApprovalReplay` slot needs a real value here.
    function taskListWithReplay(genericOperationApprovalReplay: typeof replayApprovedGenericOperation | undefined) {
      return createCoreTaskList(
        pool,
        new Map(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        genericOperationApprovalReplay,
      );
    }

    async function createPendingDeleteAndApprove(): Promise<{ requestId: string; itemId: string }> {
      const gateway = createGenericOperationGateway(pool);
      const database = await chokePoint.createDatabase({ name: "Worker path DB" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      const projectItemId = randomUUID();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "delete it" });
      const actor: AuthenticatedActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };

      let requestId: string;
      try {
        await gateway.invoke("item.delete", actor, ALL_CAPABILITIES, { itemId: item.id });
        expect.unreachable("expected ApprovalRequiredError");
        return { requestId: "", itemId: item.id };
      } catch (err) {
        requestId = (err as ApprovalRequiredError).details.approvalRequestId;
      }

      const decidedByUserId = await createUser();
      const decided = await withTransaction(pool, (client) =>
        decideAndEnqueueApprovalRequest(client, {
          approvalRequestId: requestId,
          decision: "approved",
          decidedByUserId,
        }),
      );
      expect(decided!.status).toBe("approved");

      return { requestId, itemId: item.id };
    }

    it("routes an approved generic-operation request through the queue to the injected replay handler, executing the real operation", async () => {
      const { requestId, itemId } = await createPendingDeleteAndApprove();

      await runOnce({ pgPool: pool, taskList: taskListWithReplay(replayApprovedGenericOperation) });

      expect(await chokePoint.findItem(itemId)).toBeNull();
      const finished = await getApprovalRequest(pool, requestId);
      expect(finished!.executedAt).not.toBeNull();
      expect(finished!.executionStatus).toBe("succeeded");
      expect((finished!.executionResult as { result: { id: string } }).result).toMatchObject({ id: itemId });
    });

    it("without a configured replay handler, records a failed outcome instead of silently doing nothing", async () => {
      const { requestId, itemId } = await createPendingDeleteAndApprove();

      await runOnce({ pgPool: pool, taskList: taskListWithReplay(undefined) });

      expect(await chokePoint.findItem(itemId)).not.toBeNull();
      const finished = await getApprovalRequest(pool, requestId);
      expect(finished!.executedAt).not.toBeNull();
      expect(finished!.executionError).toBe(true);
      expect(finished!.executionResult).toContain("No generic-operation approval replay handler is configured");
    });
  });
});
