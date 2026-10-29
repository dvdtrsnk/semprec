import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  createTestTenant,
  getTenantZeroId,
  inTenantZero,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import { runOnce } from "@semprec/queue";
import {
  ApprovalRequiredError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  createAgentRun,
  createChokePoint,
  createCoreTaskList,
  createDocStore,
  createUser as createBoundUser,
  createViewTypeRegistry,
  decideAndEnqueueApprovalRequest,
  getApprovalRequest,
  getDatabaseByModuleId,
  seedSystem,
  withTransaction,
  type ApprovalRequest,
  type ChokePoint,
  type GenericOperationApprovalRequestPayload,
} from "@semprec/data";
import {
  CAPABILITY_IDS,
  GENERIC_OPERATION_NAMES,
  OPERATION_METADATA,
  runInTenant,
  type AuthenticatedActor,
  type GenericOperationName,
} from "@semprec/shared";
import { createGenericOperationGateway, replayApprovedGenericOperation } from "../genericOperationGateway.js";

let pool: Pool;
let chokePoint: ChokePoint;

const ALL_CAPABILITIES = new Set(CAPABILITY_IDS);
const NO_CAPABILITIES = new Set<(typeof CAPABILITY_IDS)[number]>();

async function createUser(): Promise<string> {
  return (await createTenantZeroUser(pool)).id;
}

/** A real Projects item id (not just a random UUID) — required by `assertAuthenticatedAgentIdentity`, which `viewDeleteWithClient` enforces but the other four destructive `*WithClient` mutations do not. */
async function createRealAgentProjectItemId(): Promise<string> {
  const projectsDatabase = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects"));
  const chokePointHandle = createChokePoint(pool);
  const item = await chokePointHandle.createItem({ databaseId: projectsDatabase!.id, properties: {} });
  return item.id;
}

/** Runs `gateway.invoke` for a destructive operation, extracts the queued `approvalRequestId`, and approves it — the shared setup every replay-parity test needs before it can call `replayApprovedGenericOperation`. */
async function approveDestructive(
  operation: GenericOperationName,
  actor: AuthenticatedActor,
  input: unknown,
): Promise<string> {
  const gateway = createGenericOperationGateway(pool);
  let requestId: string;
  try {
    await gateway.invoke(operation, actor, ALL_CAPABILITIES, input);
    expect.unreachable("expected ApprovalRequiredError");
    return "";
  } catch (err) {
    requestId = (err as ApprovalRequiredError).details.approvalRequestId;
  }
  const decidedByUserId = actor.userId;
  await inTenantZero(() =>
    withTransaction(pool, (client) =>
      decideAndEnqueueApprovalRequest(client, { approvalRequestId: requestId, decision: "approved", decidedByUserId }),
    ),
  );
  return requestId;
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

  it("item.patch carries the transactional pre-image through the production gateway and service", async () => {
    await inTenantZero(async () => {
      const gateway = createGenericOperationGateway(pool);
      const actor: AuthenticatedActor = { userId: await createUser() };
      const db = await chokePoint.createDatabase({ name: "Patch values" });
      for (const key of ["due", "note", "unset"]) {
        await chokePoint.createProperty({ databaseId: db.id, key, name: key, type: "text" });
      }
      const item = await chokePoint.createItem({
        databaseId: db.id,
        properties: { due: "2026-10-27T14:00:00Z", note: "Keep" },
      });
      const result = await gateway.invoke("item.patch", actor, ALL_CAPABILITIES, {
        itemId: item.id,
        properties: { due: "2026-10-28T09:00:00Z", unset: "Now set" },
        ifVersion: item.updatedAt,
      });
      expect(result).toMatchObject({
        id: item.id,
        properties: { due: "2026-10-28T09:00:00Z", note: "Keep", unset: "Now set" },
        previous: { due: "2026-10-27T14:00:00Z", unset: null },
      });
      expect(result.previous).toEqual({ due: "2026-10-27T14:00:00Z", unset: null });
      const rejected = await Promise.allSettled([
        gateway.invoke("item.patch", actor, ALL_CAPABILITIES, {
          itemId: item.id,
          properties: { due: "Rejected" },
          ifVersion: "2000-01-01T00:00:00.000Z",
        }),
      ]);
      expect(rejected).toEqual([{ status: "rejected", reason: expect.any(ConflictError) }]);
      const persisted = await chokePoint.getItem(db.id, item.id);
      expect(persisted?.properties).toEqual(result.properties);
      expect(persisted?.updatedAt).toBe(result.updatedAt);
    });
  });

  it("item.patch exposes previous values only inside the owning tenant on a runtime-role pool", async () => {
    const tenantA = getTenantZeroId();
    const tenantB = await createTestTenant(pool);
    const runtimePool = await inTenantZero(() => createRuntimeRolePool(pool, "semprec_data"));
    try {
      const fixture = await runInTenant(tenantA, async () => {
        const cp = createChokePoint(runtimePool);
        const db = await cp.createDatabase({ name: "Private patch" });
        await cp.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "text" });
        return { db, item: await cp.createItem({ databaseId: db.id, properties: { title: "Private" } }) };
      });
      const actor: AuthenticatedActor = { userId: await createUser() };
      const gateway = createGenericOperationGateway(runtimePool);
      const input = { itemId: fixture.item.id, properties: { title: "Changed" }, ifVersion: fixture.item.updatedAt };
      const foreign = await runInTenant(tenantB, () =>
        Promise.allSettled([
          gateway.invoke("item.patch", actor, ALL_CAPABILITIES, input),
          gateway.invoke("item.patch", actor, ALL_CAPABILITIES, { ...input, itemId: randomUUID() }),
        ]),
      );
      expect(foreign).toEqual([
        { status: "rejected", reason: expect.any(NotFoundError) },
        { status: "rejected", reason: expect.any(NotFoundError) },
      ]);
      await runInTenant(tenantA, async () => {
        expect(await createChokePoint(runtimePool).getItem(fixture.db.id, fixture.item.id)).toEqual({
          ...fixture.item,
          fromInbox: false,
        });
        const result = await gateway.invoke("item.patch", actor, ALL_CAPABILITIES, input);
        expect(result.previous).toEqual({ title: "Private" });
        expect(result.properties).toEqual({ title: "Changed" });
      });
    } finally {
      await runtimePool.end();
    }
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

    it("names the offending field when property.create fails its union schema", async () => {
      const gateway = createGenericOperationGateway(pool);
      const actor: AuthenticatedActor = { userId: await createUser() };
      const database = await chokePoint.createDatabase({ name: "Gateway DB" });
      const base = { databaseId: database.id, key: "rel", name: "Rel" };

      await expect(
        gateway.invoke("property.create", actor, ALL_CAPABILITIES, {
          ...base,
          type: "relation",
          cardinality: "one_to_many",
          locked: false,
        }),
      ).rejects.toMatchObject({ details: { field: "targetDatabaseId" } });
      await expect(
        gateway.invoke("property.create", actor, ALL_CAPABILITIES, { ...base, type: "bogus" }),
      ).rejects.toMatchObject({ details: { field: "type" } });
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
      const database = await chokePoint.createDatabase({ name: "Gateway DB 3" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      const projectItemId = randomUUID();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "delete it" });
      const actor: AuthenticatedActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };

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

    it("stores the agent's reason on the request without putting it in the canonical input or the snapshot (issue #1420)", async () => {
      const gateway = createGenericOperationGateway(pool);
      const database = await chokePoint.createDatabase({ name: "Gateway DB reason" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      const projectItemId = randomUUID();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "delete it" });
      const actor: AuthenticatedActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };

      const withReason = (await gateway
        .invoke("item.delete", actor, ALL_CAPABILITIES, { itemId: item.id }, { reason: "You never use it." })
        .catch((err: unknown) => err)) as ApprovalRequiredError;
      const withoutReason = (await gateway
        .invoke("item.delete", actor, ALL_CAPABILITIES, { itemId: item.id })
        .catch((err: unknown) => err)) as ApprovalRequiredError;

      const request = await getApprovalRequest(pool, withReason.details.approvalRequestId);
      expect(request!.reason).toBe("You never use it.");
      expect(JSON.stringify(request!.payload)).not.toContain("You never use it.");
      expect(JSON.stringify(request!.resourceSnapshot)).not.toContain("You never use it.");
      expect(request!.payload).toMatchObject({ canonicalInput: { itemId: item.id } });
      expect((await getApprovalRequest(pool, withoutReason.details.approvalRequestId))!.reason).toBeNull();
    });

    it("stores the tool call id on the request, and leaves it NULL when none is supplied (issue #1618)", async () => {
      const gateway = createGenericOperationGateway(pool);
      const database = await chokePoint.createDatabase({ name: "Gateway DB tool call" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      const projectItemId = randomUUID();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "delete it" });
      const actor: AuthenticatedActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };

      const linked = (await gateway
        .invoke("item.delete", actor, ALL_CAPABILITIES, { itemId: item.id }, { toolCallId: "call_1" })
        .catch((err: unknown) => err)) as ApprovalRequiredError;
      const redelivered = (await gateway
        .invoke("item.delete", actor, ALL_CAPABILITIES, { itemId: item.id }, { toolCallId: "call_1" })
        .catch((err: unknown) => err)) as ApprovalRequiredError;
      const unlinked = (await gateway
        .invoke("item.delete", actor, ALL_CAPABILITIES, { itemId: item.id })
        .catch((err: unknown) => err)) as ApprovalRequiredError;

      expect((await getApprovalRequest(pool, linked.details.approvalRequestId))!.toolCallId).toBe("call_1");
      expect(redelivered.details.approvalRequestId).toBe(linked.details.approvalRequestId);
      expect((await getApprovalRequest(pool, unlinked.details.approvalRequestId))!.toolCallId).toBeNull();
    });

    it("still rejects a reason field inside the operation input as strict-schema ValidationError (issue #1420)", async () => {
      const gateway = createGenericOperationGateway(pool);
      const actor: AuthenticatedActor = { userId: randomUUID() };
      await expect(
        gateway.invoke("item.delete", actor, ALL_CAPABILITIES, { itemId: randomUUID(), reason: "x" }),
      ).rejects.toBeInstanceOf(ValidationError);
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
    async function createPendingDelete(): Promise<{
      requestId: string;
      run: { id: string };
      item: { id: string; databaseId: string };
    }> {
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
      await inTenantZero(() =>
        withTransaction(pool, (client) =>
          decideAndEnqueueApprovalRequest(client, {
            approvalRequestId: requestId,
            decision: "approved",
            decidedByUserId: run.actorUserId,
          }),
        ),
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

    it("terminalizes as conflict with a populated currentResource for a non-not-found domain failure (database archived after approval)", async () => {
      const { requestId, item } = await createPendingDelete();

      // The item itself is untouched (so the snapshot hash still matches), but its database was
      // archived after approval — `computeDestructiveResourceProjection` rejects this as
      // `database_archived`, which lands in `replayApprovedGenericOperation`'s `catch (err)`
      // branch rather than the snapshot-hash-mismatch branch tested above.
      await pool.query(`UPDATE databases SET archived_at = now() WHERE id = $1`, [item.databaseId]);
      const request = (await getApprovalRequest(pool, requestId)) as ApprovalRequest & {
        payload: GenericOperationApprovalRequestPayload;
      };

      const outcome = await replayApprovedGenericOperation(pool, request);

      expect(outcome.error).toBe(true);
      const parsed = JSON.parse(outcome.result) as { error: { code: string; details: Record<string, unknown> } };
      expect(parsed.error.details.reason).toBe("database_archived");
      expect(parsed.error.details.currentResource).not.toBeNull();
      expect((parsed.error.details.currentResource as { id: string }).id).toBe(item.id);
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
    async function expectNoApprovalOrNotification(): Promise<void> {
      const { rows: requestRows } = await pool.query(`SELECT count(*)::int AS count FROM approval_requests`);
      expect(requestRows[0].count).toBe(0);
      const { rows: notificationRows } = await pool.query(`SELECT count(*)::int AS count FROM notifications`);
      expect(notificationRows[0].count).toBe(0);
    }

    it("creates no approval_requests row and no notification when the resource is unauthorized (not found)", async () => {
      const gateway = createGenericOperationGateway(pool);
      const projectItemId = randomUUID();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "delete a ghost" });
      const actor: AuthenticatedActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };

      await expect(gateway.invoke("item.delete", actor, ALL_CAPABILITIES, { itemId: randomUUID() })).rejects.toThrow(
        NotFoundError,
      );

      await expectNoApprovalOrNotification();
    });

    it("creates no approval_requests row and no notification when the actor's persisted provenance no longer matches (owner_violation)", async () => {
      const gateway = createGenericOperationGateway(pool);
      const database = await chokePoint.createDatabase({ name: "Preflight Provenance" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      const projectItemId = randomUUID();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "delete it" });
      const actor: AuthenticatedActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };

      // The run's own persisted provenance drifted from what `actor` claims — the same drift
      // `replayApprovedGenericOperation` catches at execution time, now caught before a request
      // is ever queued for a human to approve.
      await pool.query(`UPDATE agent_runs SET project_item_id = $1 WHERE id = $2`, [randomUUID(), run.id]);

      try {
        await gateway.invoke("item.delete", actor, ALL_CAPABILITIES, { itemId: item.id });
        expect.unreachable("expected ForbiddenError");
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenError);
        expect((err as ForbiddenError).code).toBe("owner_violation");
      }

      expect(await chokePoint.findItem(item.id)).not.toBeNull();
      await expectNoApprovalOrNotification();
    });

    it("creates no approval_requests row and no notification when the resource is locked (paired relation property locked)", async () => {
      const gateway = createGenericOperationGateway(pool);
      const tasks = await chokePoint.createDatabase({ name: "Preflight Locked Tasks" });
      const participants = await chokePoint.createDatabase({ name: "Preflight Locked Participants" });
      const { property: assignedTo } = await chokePoint.createRelationProperty({
        sourceDatabaseId: tasks.id,
        key: "assignedTo",
        name: "Assigned To",
        targetDatabaseId: participants.id,
        inverse: { key: "assignedTasks", name: "Assigned Tasks", locked: true },
      });
      const projectItemId = randomUUID();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "delete a property" });
      const actor: AuthenticatedActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };

      await expect(
        gateway.invoke("property.delete", actor, ALL_CAPABILITIES, { propertyId: assignedTo.id }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      expect((await chokePoint.listProperties(tasks.id)).some((p) => p.id === assignedTo.id)).toBe(true);
      await expectNoApprovalOrNotification();
    });

    it("persists resourceSnapshot inside the payload, matching the row's own resourceSnapshot column", async () => {
      const gateway = createGenericOperationGateway(pool);
      const database = await chokePoint.createDatabase({ name: "Preflight Snapshot Payload" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      const projectItemId = randomUUID();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "delete it" });
      const actor: AuthenticatedActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };

      let requestId: string;
      try {
        await gateway.invoke("item.delete", actor, ALL_CAPABILITIES, { itemId: item.id });
        expect.unreachable("expected ApprovalRequiredError");
        return;
      } catch (err) {
        requestId = (err as ApprovalRequiredError).details.approvalRequestId;
      }

      const request = (await getApprovalRequest(pool, requestId)) as ApprovalRequest & {
        payload: GenericOperationApprovalRequestPayload;
      };
      expect(request.payload.resourceSnapshot).toEqual(request.resourceSnapshot);
    });
  });

  describe("approval description snapshot (issue #1683)", () => {
    async function makeActor(): Promise<AuthenticatedActor> {
      const projectItemId = await createRealAgentProjectItemId();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "describe" });
      return { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
    }

    async function descriptionOf(requestId: string) {
      return (await getApprovalRequest(pool, requestId))!.description;
    }

    it("property.delete snapshots names and the count of items with a value, unchanged by later edits", async () => {
      const database = await chokePoint.createDatabase({ name: "Journal" });
      const property = await chokePoint.createProperty({
        databaseId: database.id,
        key: "mood",
        name: "Mood",
        type: "text",
      });
      await chokePoint.createItem({ databaseId: database.id, properties: { mood: "ok" } });
      await chokePoint.createItem({ databaseId: database.id, properties: { mood: "great" } });
      await chokePoint.createItem({ databaseId: database.id, properties: {} });
      const actor = await makeActor();

      const requestId = await approveDestructive("property.delete", actor, { propertyId: property.id });
      const expected = {
        key: "approval.propertyDelete",
        params: { propertyName: "Mood", databaseKey: null, databaseName: "Journal", affectedCount: 2 },
      };
      expect(await descriptionOf(requestId)).toEqual(expected);

      await pool.query(`UPDATE properties SET name = 'Renamed' WHERE id = $1`, [property.id]);
      await chokePoint.createItem({ databaseId: database.id, properties: { mood: "late" } });
      expect(await descriptionOf(requestId)).toEqual(expected);
    });

    it("item.delete snapshots the name, database key, linked count and trash retention, without ids", async () => {
      const tasks = await chokePoint.createDatabase({ name: "Tasks" });
      const people = await chokePoint.createDatabase({ name: "People" });
      await chokePoint.createProperty({ databaseId: tasks.id, key: "name", name: "Name", type: "text" });
      const { property: assignedTo } = await chokePoint.createRelationProperty({
        sourceDatabaseId: tasks.id,
        key: "assignedTo",
        name: "Assigned To",
        targetDatabaseId: people.id,
        inverse: { key: "assignedTasks", name: "Assigned Tasks" },
      });
      const task = await chokePoint.createItem({ databaseId: tasks.id, properties: { name: "Tax return" } });
      const person = await chokePoint.createItem({ databaseId: people.id, properties: {} });
      await chokePoint.createRelation({
        relationPropertyId: assignedTo.id,
        callerItemId: task.id,
        targetItemId: person.id,
      });
      const actor = await makeActor();

      const requestId = await approveDestructive("item.delete", actor, { itemId: task.id });
      const description = await descriptionOf(requestId);

      expect(description).toEqual({
        key: "approval.itemDelete",
        params: {
          itemName: "Tax return",
          databaseKey: null,
          databaseName: "Tasks",
          linkedCount: 1,
          restorableDays: 30,
        },
      });
      expect(JSON.stringify(description)).not.toContain(task.id);
    });

    it("database.archive, view.delete and relation.delete store their templates", async () => {
      const tasks = await chokePoint.createDatabase({ name: "Tasks" });
      const people = await chokePoint.createDatabase({ name: "People" });
      await chokePoint.createProperty({ databaseId: tasks.id, key: "name", name: "Name", type: "text" });
      await chokePoint.createProperty({ databaseId: people.id, key: "name", name: "Name", type: "text" });
      const { property: assignedTo } = await chokePoint.createRelationProperty({
        sourceDatabaseId: tasks.id,
        key: "assignedTo",
        name: "Assigned To",
        targetDatabaseId: people.id,
        inverse: { key: "assignedTasks", name: "Assigned Tasks" },
      });
      const task = await chokePoint.createItem({ databaseId: tasks.id, properties: { name: "Tax return" } });
      const person = await chokePoint.createItem({ databaseId: people.id, properties: { name: "Eva" } });
      await chokePoint.createRelation({
        relationPropertyId: assignedTo.id,
        callerItemId: task.id,
        targetItemId: person.id,
      });
      const actor = await makeActor();
      const view = await chokePoint.createView(
        { databaseId: tasks.id, type: "table", name: "Open tasks" },
        { type: "ai_agent", agentProjectItemId: actor.agentProjectItemId },
      );

      const archiveId = await approveDestructive("database.archive", actor, { databaseId: tasks.id });
      const viewId = await approveDestructive("view.delete", actor, { viewId: view.id });
      const relationId = await approveDestructive("relation.delete", actor, {
        relationPropertyId: assignedTo.id,
        callerItemId: task.id,
        targetItemId: person.id,
      });

      expect(await descriptionOf(archiveId)).toEqual({
        key: "approval.databaseArchive",
        params: { databaseName: "Tasks", affectedCount: 1 },
      });
      expect(await descriptionOf(viewId)).toEqual({
        key: "approval.viewDelete",
        params: { viewName: "Open tasks", databaseName: "Tasks" },
      });
      expect(await descriptionOf(relationId)).toEqual({
        key: "approval.relationDelete",
        params: { fromItemName: "Tax return", fromDatabaseKey: null, toItemName: "Eva", toDatabaseKey: null },
      });
    });
  });

  describe("approval notification body (issue #1773)", () => {
    async function makeActor(): Promise<AuthenticatedActor> {
      const projectItemId = await createRealAgentProjectItemId();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "notify" });
      return { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
    }

    /** Raises the request with the recipient's locale set to English, so the body can be asserted in English. */
    async function raiseInEnglish(
      operation: GenericOperationName,
      actor: AuthenticatedActor,
      input: unknown,
    ): Promise<string> {
      await pool.query(`UPDATE users SET locale = 'en'`);
      return approveDestructive(operation, actor, input);
    }

    async function notificationOf(requestId: string): Promise<{ title: string; body: string | null }> {
      const { rows } = await pool.query<{ title: string; body: string | null }>(
        `SELECT title, body FROM notifications WHERE source_id = $1 AND kind = 'approval_pending'`,
        [requestId],
      );
      expect(rows).toHaveLength(1);
      return rows[0]!;
    }

    it("gives every approval the fixed title, and property.delete a body that ends with the irreversible sentence", async () => {
      const database = await chokePoint.createDatabase({ name: "Journal" });
      const property = await chokePoint.createProperty({
        databaseId: database.id,
        key: "mood",
        name: "Mood",
        type: "text",
      });
      const actor = await makeActor();

      const requestId = await raiseInEnglish("property.delete", actor, { propertyId: property.id });

      expect(await notificationOf(requestId)).toEqual({
        title: "Semp needs approval",
        body: 'Delete the property "Mood" in the database "Journal". This action is irreversible.',
      });
    });

    it("gives item.delete a body that ends with the undo sentence, because the item goes to the trash", async () => {
      const tasks = await chokePoint.createDatabase({ name: "Tasks" });
      await chokePoint.createProperty({ databaseId: tasks.id, key: "name", name: "Name", type: "text" });
      const task = await chokePoint.createItem({ databaseId: tasks.id, properties: { name: "Tax return" } });
      const actor = await makeActor();

      const requestId = await raiseInEnglish("item.delete", actor, { itemId: task.id });

      expect((await notificationOf(requestId)).body).toBe(
        'Delete the item "Tax return" in the database "Tasks". This can be undone later.',
      );
    });

    it("renders an item without a name as the unnamed label, never as a placeholder", async () => {
      const tasks = await chokePoint.createDatabase({ name: "Tasks" });
      const task = await chokePoint.createItem({ databaseId: tasks.id, properties: {} });
      const actor = await makeActor();

      const requestId = await raiseInEnglish("item.delete", actor, { itemId: task.id });

      expect((await notificationOf(requestId)).body).toBe(
        'Delete the item "unnamed" in the database "Tasks". This can be undone later.',
      );
    });

    it("gives database.archive an undo sentence and view.delete and relation.delete the irreversible one", async () => {
      const tasks = await chokePoint.createDatabase({ name: "Tasks" });
      const people = await chokePoint.createDatabase({ name: "People" });
      await chokePoint.createProperty({ databaseId: tasks.id, key: "name", name: "Name", type: "text" });
      await chokePoint.createProperty({ databaseId: people.id, key: "name", name: "Name", type: "text" });
      const { property: assignedTo } = await chokePoint.createRelationProperty({
        sourceDatabaseId: tasks.id,
        key: "assignedTo",
        name: "Assigned To",
        targetDatabaseId: people.id,
        inverse: { key: "assignedTasks", name: "Assigned Tasks" },
      });
      const task = await chokePoint.createItem({ databaseId: tasks.id, properties: { name: "Tax return" } });
      const person = await chokePoint.createItem({ databaseId: people.id, properties: { name: "Eva" } });
      await chokePoint.createRelation({
        relationPropertyId: assignedTo.id,
        callerItemId: task.id,
        targetItemId: person.id,
      });
      const actor = await makeActor();
      const view = await chokePoint.createView(
        { databaseId: tasks.id, type: "table", name: "Open tasks" },
        { type: "ai_agent", agentProjectItemId: actor.agentProjectItemId },
      );

      const archiveId = await raiseInEnglish("database.archive", actor, { databaseId: tasks.id });
      expect((await notificationOf(archiveId)).body).toBe('Archive the database "Tasks". This can be undone later.');

      const viewId = await raiseInEnglish("view.delete", actor, { viewId: view.id });
      expect((await notificationOf(viewId)).body).toBe('Delete the view "Open tasks". This action is irreversible.');

      const relationId = await raiseInEnglish("relation.delete", actor, {
        relationPropertyId: assignedTo.id,
        callerItemId: task.id,
        targetItemId: person.id,
      });
      expect((await notificationOf(relationId)).body).toBe(
        'Remove the link between "Tax return" and "Eva". This action is irreversible.',
      );
    });
  });

  describe("replay parity for all five destructive operations (issue #89 acceptance criteria)", () => {
    async function makeAgentActor(): Promise<AuthenticatedActor> {
      const projectItemId = await createRealAgentProjectItemId();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "replay parity" });
      return { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
    }

    async function replay(requestId: string) {
      const request = (await getApprovalRequest(pool, requestId)) as ApprovalRequest & {
        payload: GenericOperationApprovalRequestPayload;
      };
      const outcome = await replayApprovedGenericOperation(pool, request);
      const finished = await getApprovalRequest(pool, requestId);
      return { outcome, finished };
    }

    it("database.archive: preflight, approve, and replay archive the database exactly once", async () => {
      const database = await chokePoint.createDatabase({ name: "Replay Parity Archive" });
      const actor = await makeAgentActor();

      const requestId = await approveDestructive("database.archive", actor, { databaseId: database.id });
      const { outcome, finished } = await replay(requestId);

      expect(outcome.error).toBe(false);
      expect(finished!.executionStatus).toBe("succeeded");
      const reloaded = await chokePoint.getDatabase(database.id);
      expect(reloaded?.archivedAt).not.toBeNull();
    });

    it("property.delete: preflight, approve, and replay delete the property exactly once", async () => {
      const database = await chokePoint.createDatabase({ name: "Replay Parity Property" });
      const property = await chokePoint.createProperty({
        databaseId: database.id,
        key: "notes",
        name: "Notes",
        type: "text",
      });
      const actor = await makeAgentActor();

      const requestId = await approveDestructive("property.delete", actor, { propertyId: property.id });
      const { outcome, finished } = await replay(requestId);

      expect(outcome.error).toBe(false);
      expect(finished!.executionStatus).toBe("succeeded");
      const remaining = await chokePoint.listProperties(database.id);
      expect(remaining.some((p) => p.id === property.id)).toBe(false);
    });

    it("view.delete: preflight, approve, and replay delete the view exactly once", async () => {
      const database = await chokePoint.createDatabase({ name: "Replay Parity View" });
      const actor = await makeAgentActor();
      const view = await chokePoint.createView(
        { databaseId: database.id, type: "table", name: "Agent View" },
        { type: "ai_agent", agentProjectItemId: actor.agentProjectItemId },
      );

      const requestId = await approveDestructive("view.delete", actor, { viewId: view.id });
      const { outcome, finished } = await replay(requestId);

      expect(outcome.error).toBe(false);
      expect(finished!.executionStatus).toBe("succeeded");
      expect(await chokePoint.getView(view.id)).toBeNull();
    });

    it("relation.delete: preflight, approve, and replay delete the edge exactly once", async () => {
      const tasks = await chokePoint.createDatabase({ name: "Replay Parity Rel Tasks" });
      const participants = await chokePoint.createDatabase({ name: "Replay Parity Rel Participants" });
      const { property: assignedTo } = await chokePoint.createRelationProperty({
        sourceDatabaseId: tasks.id,
        key: "assignedTo",
        name: "Assigned To",
        targetDatabaseId: participants.id,
        inverse: { key: "assignedTasks", name: "Assigned Tasks" },
      });
      const task = await chokePoint.createItem({ databaseId: tasks.id, properties: {} });
      const person = await chokePoint.createItem({ databaseId: participants.id, properties: {} });
      const edge = await chokePoint.createRelation({
        relationPropertyId: assignedTo.id,
        callerItemId: task.id,
        targetItemId: person.id,
      });
      const actor = await makeAgentActor();

      const requestId = await approveDestructive("relation.delete", actor, {
        relationPropertyId: assignedTo.id,
        callerItemId: task.id,
        targetItemId: person.id,
      });
      const { outcome, finished } = await replay(requestId);

      expect(outcome.error).toBe(false);
      expect(finished!.executionStatus).toBe("succeeded");
      const { rows } = await pool.query(`SELECT count(*)::int AS count FROM item_relations WHERE id = $1`, [edge.id]);
      expect(rows[0].count).toBe(0);
    });
  });

  describe("page.restoreVersion through the approval gate (issue #1617)", () => {
    async function makeAgentActor(): Promise<AuthenticatedActor> {
      const projectItemId = await createRealAgentProjectItemId();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "page restore" });
      return { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
    }

    async function replayRequest(requestId: string) {
      const request = (await getApprovalRequest(pool, requestId)) as ApprovalRequest & {
        payload: GenericOperationApprovalRequestPayload;
      };
      const outcome = await replayApprovedGenericOperation(pool, request);
      return { outcome, finished: await getApprovalRequest(pool, requestId) };
    }

    /**
     * A page whose history starts two hours before the database clock, with block `b1` written an hour
     * before it. The instant returned is half an hour before the clock, so it sits between the two.
     */
    async function pageWithFirstBlock(): Promise<{ itemId: string; docId: string; at: Date }> {
      const docStore = createDocStore(pool);
      const { rows } = await pool.query<{ now: Date }>(`SELECT transaction_timestamp() AS now`);
      const now = rows[0]!.now;
      const hoursBefore = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000);
      const database = await chokePoint.createDatabase({ name: "Pages" });
      await chokePoint.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "text" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: { name: "Chapter one" } });
      const doc = await docStore.getOrCreateDoc(item.id, "page");
      await pool.query(`UPDATE docs SET history_available_from = $2 WHERE id = $1`, [doc.id, hoursBefore(2)]);
      await pool.query(
        `UPDATE doc_snapshot_history SET represented_at = $2 WHERE doc_id = $1 AND through_update_id = 0`,
        [doc.id, hoursBefore(2)],
      );
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph", fields: { content: "first" } }, "user");
      await pool.query(`UPDATE doc_updates SET created_at = $2 WHERE doc_id = $1`, [doc.id, hoursBefore(1)]);
      await pool.query(`UPDATE doc_history_updates SET created_at = $2 WHERE doc_id = $1`, [doc.id, hoursBefore(1)]);
      return { itemId: item.id, docId: doc.id, at: hoursBefore(0.5) };
    }

    async function blockIdsOf(itemId: string): Promise<string[]> {
      const blocks = await createDocStore(pool).listBlocks(itemId);
      return blocks.map((block) => String(block["sys:id"])).sort();
    }

    it("holds an agent call for approval, and the approved replay restores the page as one user update", async () => {
      const page = await pageWithFirstBlock();
      const docStore = createDocStore(pool);
      await docStore.putBlock(page.itemId, { id: "b2", flavour: "paragraph", fields: { content: "second" } }, "user");
      const actor = await makeAgentActor();
      const input = { itemId: page.itemId, at: page.at.toISOString() };

      const requestId = await approveDestructive("page.restoreVersion", actor, input);
      // Approval alone changes nothing: the restore runs when the approved request is replayed.
      expect(await blockIdsOf(page.itemId)).toEqual(["b1", "b2"]);
      const request = await getApprovalRequest(pool, requestId);
      expect(request).toMatchObject({
        toolName: "page.restoreVersion",
        riskClass: "destructive",
        description: {
          key: "approval.pageRestore",
          params: { itemName: "Chapter one", databaseKey: null, databaseName: "Pages" },
        },
      });

      const { outcome, finished } = await replayRequest(requestId);

      expect(outcome.error).toBe(false);
      expect(finished!.executionStatus).toBe("succeeded");
      expect(await blockIdsOf(page.itemId)).toEqual(["b1"]);
      const { rows } = await pool.query<{ created_by: string }>(
        `SELECT created_by FROM doc_updates WHERE doc_id = $1 ORDER BY id DESC LIMIT 1`,
        [page.docId],
      );
      expect(rows[0]!.created_by).toBe("user");
    });

    it("ends the replay as a conflict, restoring nothing, when the page was edited after the request", async () => {
      const page = await pageWithFirstBlock();
      const actor = await makeAgentActor();
      const requestId = await approveDestructive("page.restoreVersion", actor, {
        itemId: page.itemId,
        at: page.at.toISOString(),
      });
      await createDocStore(pool).putBlock(
        page.itemId,
        { id: "b2", flavour: "paragraph", fields: { content: "second" } },
        "user",
      );

      const { finished } = await replayRequest(requestId);

      expect(finished!.executionStatus).toBe("conflict");
      expect(await blockIdsOf(page.itemId)).toEqual(["b1", "b2"]);
    });

    it("refuses a request for an unknown page without queuing an approval", async () => {
      const actor = await makeAgentActor();
      const gateway = createGenericOperationGateway(pool);

      await expect(
        gateway.invoke("page.restoreVersion", actor, ALL_CAPABILITIES, {
          itemId: randomUUID(),
          at: new Date().toISOString(),
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM approval_requests WHERE tool_name = 'page.restoreVersion'`,
      );
      expect(rows[0]!.count).toBe("0");
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
      expect(finished!.executionStatus).toBe("conflict");
      expect(finished!.executionResult).toContain("No generic-operation approval replay handler is configured");
    });
  });
});

describe("approval_pending recipient in a tenant (issue #1018)", () => {
  let runtimePool: Pool;

  // The first describe's `afterAll` ended the shared pool, so this block opens and closes its own.
  beforeAll(async () => {
    pool = getTestPool();
    runtimePool = await runInTenant(getTenantZeroId(), () => createRuntimeRolePool(pool, "semprec_data"));
  });

  beforeEach(async () => {
    await runInTenant(getTenantZeroId(), () => resetDatabase(pool));
  });

  afterAll(async () => {
    await runtimePool?.end();
    await pool?.end();
  });

  it("notifies the user of the tenant the request is created in, with a link naming that user", async () => {
    const tenantB = await runInTenant(getTenantZeroId(), () => createTestTenant(pool));
    const userA = await runInTenant(getTenantZeroId(), () =>
      createBoundUser(pool, {
        email: "a@example.test",
        passwordHash: "x",
        tenantId: getTenantZeroId(),
      }),
    );
    const userB = await runInTenant(tenantB, () =>
      createBoundUser(pool, { email: "b@example.test", passwordHash: "x", tenantId: tenantB }),
    );

    const approvalRequestId = await runInTenant(tenantB, async () => {
      const chokePointB = createChokePoint(runtimePool);
      const database = await chokePointB.createDatabase({ name: "Tenant B DB" });
      const item = await chokePointB.createItem({ databaseId: database.id, properties: {} });
      const projectItemId = randomUUID();
      const run = await createAgentRun(runtimePool, { projectItemId, triggeredBy: "user", task: "delete it" });
      const actor: AuthenticatedActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
      try {
        await createGenericOperationGateway(runtimePool).invoke("item.delete", actor, ALL_CAPABILITIES, {
          itemId: item.id,
        });
      } catch (err) {
        if (err instanceof ApprovalRequiredError) return err.details.approvalRequestId;
        throw err;
      }
      throw new Error("expected ApprovalRequiredError");
    });

    const { rows } = await pool.query<{ user_id: string; kind: string; link_href: string | null; tenant_id: string }>(
      `SELECT user_id, kind, link_href, tenant_id FROM notifications WHERE source_id = $1`,
      [approvalRequestId],
    );
    expect(rows).toEqual([
      {
        user_id: userB.id,
        kind: "approval_pending",
        link_href: `?page=approvals&user=${userB.id}`,
        tenant_id: tenantB,
      },
    ]);
    expect(rows[0]?.user_id).not.toBe(userA.id);
  });
});
