import type { CollectionMetadataResolver } from "@semprec/data";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  createTestTenant,
  getTenantZeroId,
  inTenantZero,
  getTestPool,
  resetDatabase,
  registerRelationEdgeWriteHook,
  registerItemUpdateHook,
} from "@semprec/data/testSupport";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { countJobsByIdentifier } from "@semprec/queue/testSupport";
import {
  ApprovalRequiredError,
  ApprovalResourceBusyError,
  ValueLinkBusyError,
  VALUE_LINKS_OWNER_PROCESS,
  createRelationWithClient,
  requireApprovalForWrite,
  setInvalidationHook,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  createAgentRun,
  createChokePoint,
  createCoreTaskList,
  computePageRestoreProjection,
  computeDestructiveResourceProjection,
  createDocStore,
  createUser as createBoundUser,
  createViewTypeRegistry,
  decideAndEnqueueApprovalRequest,
  getApprovalRequest,
  getDatabaseByModuleId,
  isGenericOperationApprovalRequestPayload,
  insertValueLink,
  loadYDoc,
  mutateYDoc,
  rebaselineDocHistory,
  seedSystem,
  withTransaction,
  type ApprovalRequest,
  type ChokePoint,
  type GenericOperationApprovalRequestPayload,
} from "@semprec/data";
import {
  CAPABILITY_IDS,
  canonicalizeJson,
  GENERIC_OPERATION_NAMES,
  OPERATION_METADATA,
  runInTenant,
  runAsSystem,
  type AuthenticatedActor,
  type GenericOperationName,
} from "@semprec/shared";
import { createGenericOperationGateway, replayApprovedGenericOperation } from "../genericOperationGateway.js";

const testMetadataResolver: CollectionMetadataResolver = {
  resolve: () => ({ icon: null, color: null, overviewOrder: null, switcherOrder: null, clientVisible: true }),
};

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
  const gateway = createGenericOperationGateway(pool, testMetadataResolver);
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

  it("defers a flagged relation replacement and replays once with the same active hook", async () =>
    inTenantZero(async () => {
      const source = await chokePoint.createDatabase({ name: "Flag source" });
      const target = await chokePoint.createDatabase({ name: "Flag target" });
      const { property } = await chokePoint.createRelationProperty({
        sourceDatabaseId: source.id,
        targetDatabaseId: target.id,
        key: "target",
        name: "Target",
        cardinality: "one_to_one",
      });
      const caller = await chokePoint.createItem({ databaseId: source.id, properties: {} });
      const first = await chokePoint.createItem({ databaseId: target.id, properties: {} });
      const second = await chokePoint.createItem({ databaseId: target.id, properties: {} });
      const third = await chokePoint.createItem({ databaseId: target.id, properties: {} });
      const original = await chokePoint.setRelation({
        relationPropertyId: property.id,
        callerItemId: caller.id,
        targetItemId: first.id,
      });
      if (!original) throw new Error("Expected initial relation");
      await chokePoint.createProperty({
        databaseId: source.id,
        key: "targetCount",
        name: "Target count",
        type: "rollup",
        config: { relationPropertyKey: "target", aggregation: "count" },
      });
      await withTransaction(pool, (client) =>
        insertValueLink(client, { itemId: caller.id, propertyKey: "target", ruleKey: "test", sources: [] }),
      );
      const projectItemId = randomUUID();
      // No public chat-thread creator exists on this tip.
      const thread = await pool.query<{ id: string }>("INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id");
      const run = await createAgentRun(pool, {
        projectItemId,
        triggeredBy: "user",
        task: "change relation",
        threadId: thread.rows[0]!.id,
      });
      const actor: AuthenticatedActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
      const seen: Array<{ writerKind: string; approvedRequestId?: string }> = [];
      const delivered: unknown[] = [];
      const mutationError = new ValidationError("forced mutation failure");
      let failMutation = false;
      let sawDeleted = false;
      let sawMutationJob = false;
      let jobCount = 0;
      let active = true;
      registerRelationEdgeWriteHook(async ({ client, edgeContext, writer }) => {
        if (!active || edgeContext.property.id !== property.id) return;
        seen.push({ writerKind: writer.writerKind, approvedRequestId: writer.approvedRequestId });
        requireApprovalForWrite(client, writer, [{ kind: "testReason" }]);
        if (failMutation && writer.approvedRequestId) {
          const edges = await client.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM item_relations WHERE id = $1",
            [original.id],
          );
          sawDeleted = edges.rows[0]?.count === "0";
          const jobs = await client.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM graphile_worker.jobs WHERE task_identifier = $1",
            [CORE_TASK_NAMES.ROLLUP_RECOMPUTE],
          );
          sawMutationJob = Number(jobs.rows[0]?.count) > jobCount;
          throw mutationError;
        }
      });
      try {
        const input = {
          relationPropertyId: property.id.toUpperCase(),
          callerItemId: caller.id,
          targetItemId: second.id,
        };
        let requestId = "";
        try {
          await gateway.invoke("relation.set", actor, ALL_CAPABILITIES, input);
          expect.unreachable("Expected approval");
        } catch (err) {
          if (!(err instanceof ApprovalRequiredError)) throw err;
          requestId = err.details.approvalRequestId;
        }
        expect((await chokePoint.listItemRelations(caller.id, property.id))?.map((edge) => edge.targetItemId)).toEqual([
          first.id,
        ]);
        const pending = await getApprovalRequest(pool, requestId);
        expect(pending?.description).toEqual({
          key: "approval.relationSet",
          params: { fromItemName: null, fromDatabaseKey: source.key, propertyName: "Target" },
        });
        expect(JSON.stringify(pending?.description)).not.toContain(second.id);
        expect(pending?.riskClass).toBe("write");
        await inTenantZero(() =>
          withTransaction(pool, (client) =>
            decideAndEnqueueApprovalRequest(client, {
              approvalRequestId: requestId,
              decision: "approved",
              decidedByUserId: run.actorUserId,
            }),
          ),
        );
        const request = await getApprovalRequest(pool, requestId);
        if (!request || !isGenericOperationApprovalRequestPayload(request.payload))
          throw new Error("Expected generic request");
        const typed = { ...request, payload: request.payload };
        const baselineActivity = new Date("2020-01-01T00:00:00.000Z");
        await pool.query("UPDATE semp_threads SET last_activity_at = $2 WHERE id = $1", [
          thread.rows[0]!.id,
          baselineActivity,
        ]);
        jobCount = await countJobsByIdentifier(pool, CORE_TASK_NAMES.ROLLUP_RECOMPUTE);
        setInvalidationHook((event) => delivered.push(event));
        failMutation = true;
        await expect(replayApprovedGenericOperation(pool, typed)).rejects.toBe(mutationError);
        expect(sawDeleted).toBe(true);
        expect(sawMutationJob).toBe(true);
        expect(await chokePoint.listItemRelations(caller.id, property.id)).toMatchObject([{ targetItemId: first.id }]);
        const originalEdge = await pool.query<{ id: string; metadata: unknown }>(
          "SELECT id, metadata FROM item_relations WHERE id = $1",
          [original.id],
        );
        expect(originalEdge.rows).toEqual([{ id: original.id, metadata: original.metadata }]);
        const link = await pool.query<{ state: string }>(
          "SELECT state FROM value_links WHERE item_id = $1 AND property_key = $2",
          [caller.id, "target"],
        );
        expect(link.rows).toEqual([{ state: "on" }]);
        expect(await countJobsByIdentifier(pool, CORE_TASK_NAMES.ROLLUP_RECOMPUTE)).toBe(jobCount);
        expect(delivered).toEqual([]);
        const rolledBack = await getApprovalRequest(pool, requestId);
        expect(rolledBack).toMatchObject({ status: "approved", executionStatus: "queued", executionResult: null });
        const messages = await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM semp_messages WHERE thread_id = $1",
          [thread.rows[0]!.id],
        );
        expect(messages.rows[0]?.count).toBe("0");
        failMutation = false;
        const outcomeError = new Error("forced outcome rollback");
        let sawOutcome = false;
        const failAfterOutcomePool = new Proxy(pool, {
          get(targetPool, key, receiver) {
            if (key !== "connect") {
              const value: unknown = Reflect.get(targetPool, key, receiver);
              return typeof value === "function" ? value.bind(targetPool) : value;
            }
            return async () => {
              const client = await targetPool.connect();
              return new Proxy(client, {
                get(targetClient, field, clientReceiver) {
                  if (field !== "query") {
                    const value: unknown = Reflect.get(targetClient, field, clientReceiver);
                    return typeof value === "function" ? value.bind(targetClient) : value;
                  }
                  return async (...args: unknown[]) => {
                    const result: unknown = await Reflect.apply(
                      targetClient.query.bind(targetClient),
                      targetClient,
                      args,
                    );
                    if (typeof args[0] === "string" && args[0].includes("UPDATE semp_threads SET last_activity_at")) {
                      const inserted = await targetClient.query<{ count: string }>(
                        "SELECT count(*)::text AS count FROM semp_messages WHERE thread_id = $1",
                        [thread.rows[0]!.id],
                      );
                      const activity = await targetClient.query<{ last_activity_at: Date }>(
                        "SELECT last_activity_at FROM semp_threads WHERE id = $1",
                        [thread.rows[0]!.id],
                      );
                      sawOutcome =
                        inserted.rows[0]?.count === "1" &&
                        (activity.rows[0]?.last_activity_at.getTime() ?? 0) > baselineActivity.getTime();
                      throw outcomeError;
                    }
                    return result;
                  };
                },
              });
            };
          },
        });
        await expect(replayApprovedGenericOperation(failAfterOutcomePool, typed)).rejects.toBe(outcomeError);
        expect(sawOutcome).toBe(true);
        expect(
          (
            await pool.query<{ last_activity_at: Date }>("SELECT last_activity_at FROM semp_threads WHERE id = $1", [
              thread.rows[0]!.id,
            ])
          ).rows[0]?.last_activity_at,
        ).toEqual(baselineActivity);
        expect((await getApprovalRequest(pool, requestId))?.executionStatus).toBe("queued");
        expect(await chokePoint.listItemRelations(caller.id, property.id)).toMatchObject([{ targetItemId: first.id }]);
        expect(
          (
            await pool.query<{ count: string }>(
              "SELECT count(*)::text AS count FROM semp_messages WHERE thread_id = $1",
              [thread.rows[0]!.id],
            )
          ).rows[0]?.count,
        ).toBe("0");
        expect(await countJobsByIdentifier(pool, CORE_TASK_NAMES.ROLLUP_RECOMPUTE)).toBe(jobCount);
        expect(delivered).toEqual([]);
        expect((await replayApprovedGenericOperation(pool, typed)).error).toBe(false);
        expect((await replayApprovedGenericOperation(pool, typed)).error).toBe(false);
        expect(delivered.length).toBeGreaterThan(0);
        expect(delivered).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ scope: "item", itemId: caller.id }),
            expect.objectContaining({ scope: "relation", itemId: caller.id }),
          ]),
        );
        const afterSuccess = [...delivered];
        const successMessages = await pool.query<{ system_key: string }>(
          "SELECT system_key FROM semp_messages WHERE thread_id = $1",
          [thread.rows[0]!.id],
        );
        expect(successMessages.rows).toEqual([{ system_key: "approval.outcome.executed" }]);
        expect((await chokePoint.listItemRelations(caller.id, property.id))?.map((edge) => edge.targetItemId)).toEqual([
          second.id,
        ]);
        expect(seen).toEqual([
          { writerKind: "agent", approvedRequestId: undefined },
          { writerKind: "agent", approvedRequestId: requestId },
          { writerKind: "agent", approvedRequestId: requestId },
          { writerKind: "agent", approvedRequestId: requestId },
        ]);
        await expect(
          gateway.invoke("relation.set", actor, ALL_CAPABILITIES, { ...input, targetItemId: third.id }),
        ).rejects.toBeInstanceOf(ApprovalRequiredError);
        expect(delivered).toEqual(afterSuccess);
        expect((await chokePoint.listItemRelations(caller.id, property.id))?.map((edge) => edge.targetItemId)).toEqual([
          second.id,
        ]);
      } finally {
        active = false;
        setInvalidationHook(() => {});
      }
    }));

  it.each(["insert", "upsert", "metadata", "delete"] as const)(
    "reserves relation snapshots against ordinary inverse %s in both orders",
    async (kind) => {
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      const cp = createChokePoint(runtime);
      const foreignTenant = await createTestTenant(pool);
      const foreignFixture = await runInTenant(foreignTenant, async () => {
        const foreignSource = await cp.createDatabase({ name: "Foreign source" });
        const foreignTarget = await cp.createDatabase({ name: "Foreign target" });
        const foreignPair = await cp.createRelationProperty({
          sourceDatabaseId: foreignSource.id,
          targetDatabaseId: foreignTarget.id,
          key: "target",
          name: "Target",
        });
        const left = await cp.createItem({ databaseId: foreignSource.id, properties: {} });
        const right = await cp.createItem({ databaseId: foreignTarget.id, properties: {} });
        return { property: foreignPair.property, left, right };
      });
      let startForeign!: (execute: boolean) => void;
      const foreignGate = new Promise<boolean>((resolve) => (startForeign = resolve));
      const foreignWork = (async () => {
        if (!(await foreignGate)) return;
        await runInTenant(foreignTenant, () =>
          cp.createRelation({
            relationPropertyId: foreignFixture.property.id,
            callerItemId: foreignFixture.left.id,
            targetItemId: foreignFixture.right.id,
          }),
        );
      })();
      return inTenantZero(async () => {
        let active = true;
        let pauseApproval = false;
        let approvalPid = 0;
        let reachedApproval!: () => void;
        let releaseApproval!: () => void;
        const atApproval = new Promise<void>((resolve) => (reachedApproval = resolve));
        const approvalGate = new Promise<void>((resolve) => (releaseApproval = resolve));
        try {
          const source = await cp.createDatabase({ name: "Reservation source" });
          const target = await cp.createDatabase({ name: "Reservation target" });
          const pair = await cp.createRelationProperty({
            sourceDatabaseId: source.id,
            targetDatabaseId: target.id,
            key: "target",
            name: "Target",
            cardinality: "many_to_many",
            inverse: { key: "sources", name: "Sources" },
          });
          if (!pair.inverseProperty) throw new Error("Expected inverse property");
          const caller = await cp.createItem({ databaseId: source.id, properties: {} });
          const first = await cp.createItem({ databaseId: target.id, properties: {} });
          const second = await cp.createItem({ databaseId: target.id, properties: {} });
          const unrelatedPair = await cp.createRelationProperty({
            sourceDatabaseId: source.id,
            targetDatabaseId: target.id,
            key: "unrelated",
            name: "Unrelated",
          });
          const original = await cp.createRelation({
            relationPropertyId: pair.property.id,
            callerItemId: caller.id,
            targetItemId: first.id,
            metadata: { version: "original" },
          });
          await cp.createProperty({
            databaseId: source.id,
            key: "targetCount",
            name: "Target count",
            type: "rollup",
            config: { relationPropertyKey: "target", aggregation: "count" },
          });
          // No production chat-thread creator exists on this tip.
          const thread = await withTransaction(pool, (client) =>
            client.query<{ id: string }>("INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id"),
          );
          const projectItemId = randomUUID();
          const run = await createAgentRun(runtime, {
            projectItemId,
            triggeredBy: "user",
            task: "reserve relation",
            threadId: thread.rows[0]!.id,
          });
          const actor: AuthenticatedActor = {
            userId: run.actorUserId,
            runId: run.id,
            agentProjectItemId: projectItemId,
          };
          registerRelationEdgeWriteHook(async ({ client, edgeContext, writer }) => {
            if (!active || edgeContext.property.id !== pair.property.id) return;
            requireApprovalForWrite(client, writer, [{ kind: "testReason" }]);
            if (pauseApproval && writer.approvedRequestId) {
              const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
              approvalPid = result.rows[0]!.pid;
              reachedApproval();
              await approvalGate;
            }
          });
          const gateway = createGenericOperationGateway(runtime, testMetadataResolver);
          async function request() {
            let id = "";
            try {
              await gateway.invoke("relation.put", actor, ALL_CAPABILITIES, {
                relationPropertyId: pair.property.id,
                callerItemId: caller.id,
                targetItemId: first.id,
                metadata: { version: "approved" },
              });
              expect.unreachable("Expected approval");
            } catch (error) {
              if (!(error instanceof ApprovalRequiredError)) throw error;
              id = error.details.approvalRequestId;
            }
            await withTransaction(runtime, (client) =>
              decideAndEnqueueApprovalRequest(client, {
                approvalRequestId: id,
                decision: "approved",
                decidedByUserId: run.actorUserId,
              }),
            );
            const result = await getApprovalRequest(runtime, id);
            if (!result || !isGenericOperationApprovalRequestPayload(result.payload))
              throw new Error("Expected request");
            return { ...result, payload: result.payload };
          }
          const input = {
            relationPropertyId: pair.inverseProperty.id,
            callerItemId: kind === "insert" ? second.id : first.id,
            targetItemId: caller.id,
          };
          const ordinary = (handle: ChokePoint) => {
            if (kind === "insert" || kind === "upsert")
              return handle.createRelation({ ...input, metadata: { version: "normal" } });
            if (kind === "metadata") return handle.updateRelation({ ...input, metadata: { version: "normal" } });
            return handle.deleteRelation(input);
          };
          const firstRequest = await request();
          const baselineJobs = await countJobsByIdentifier(pool, CORE_TASK_NAMES.ROLLUP_RECOMPUTE);
          const delivered: unknown[] = [];
          setInvalidationHook((event) => delivered.push(event));
          let normalPid = 0;
          let atCommit!: () => void;
          let releaseCommit!: () => void;
          const commitReached = new Promise<void>((resolve) => (atCommit = resolve));
          const commitGate = new Promise<void>((resolve) => (releaseCommit = resolve));
          const heldPool = new Proxy(runtime, {
            get(targetPool, property, receiver) {
              if (property !== "connect") {
                const value: unknown = Reflect.get(targetPool, property, receiver);
                return typeof value === "function" ? value.bind(targetPool) : value;
              }
              return async () => {
                const client = await targetPool.connect();
                const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
                normalPid = result.rows[0]!.pid;
                return new Proxy(client, {
                  get(targetClient, key, clientReceiver) {
                    if (key !== "query") {
                      const value: unknown = Reflect.get(targetClient, key, clientReceiver);
                      return typeof value === "function" ? value.bind(targetClient) : value;
                    }
                    return async (...args: unknown[]) => {
                      if (args[0] === "COMMIT") {
                        atCommit();
                        await commitGate;
                      }
                      return Reflect.apply(targetClient.query.bind(targetClient), targetClient, args);
                    };
                  },
                });
              };
            },
          });
          let replayPid = 0;
          const observedReplayPool = new Proxy(runtime, {
            get(targetPool, property, receiver) {
              if (property !== "connect") {
                const value: unknown = Reflect.get(targetPool, property, receiver);
                return typeof value === "function" ? value.bind(targetPool) : value;
              }
              return async () => {
                const client = await targetPool.connect();
                const identity = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
                replayPid = identity.rows[0]!.pid;
                return client;
              };
            },
          });
          const normalFirst = ordinary(createChokePoint(heldPool));
          let normalFailure: { error: unknown } | undefined;
          try {
            await Promise.race([
              commitReached,
              normalFirst.then(() => {
                throw new Error("Ordinary writer ended before its commit barrier");
              }),
            ]);
            expect(normalPid).toBeGreaterThan(0);
            if (kind === "insert") {
              const count = async () =>
                (await runtime.query<{ count: string }>("SELECT count(*)::text AS count FROM approval_requests"))
                  .rows[0]?.count;
              const before = await count();
              await expect(
                gateway.invoke("relation.put", actor, ALL_CAPABILITIES, {
                  relationPropertyId: pair.property.id,
                  callerItemId: caller.id,
                  targetItemId: first.id,
                }),
              ).rejects.toBeInstanceOf(ApprovalResourceBusyError);
              expect(await count()).toBe(before);
            }
            let busy: unknown;
            try {
              await replayApprovedGenericOperation(observedReplayPool, firstRequest);
              expect.unreachable("Expected busy reservation");
            } catch (error) {
              busy = error;
            }
            expect(replayPid).toBeGreaterThan(0);
            expect(replayPid).not.toBe(normalPid);
            process.stdout.write(`reservation normal-first ${kind}: holder=${normalPid} contender=${replayPid}\n`);
            expect(busy).toBeInstanceOf(ApprovalResourceBusyError);
            expect(busy).toMatchObject({
              status: 409,
              code: "approval_resource_busy",
              message: "Approval resource is busy",
              details: undefined,
            });
            expect(await countJobsByIdentifier(pool, CORE_TASK_NAMES.ROLLUP_RECOMPUTE)).toBe(baselineJobs);
            expect(delivered).toEqual([]);
            expect(
              (
                await pool.query<{ count: string }>(
                  "SELECT count(*)::text AS count FROM semp_messages WHERE thread_id = $1",
                  [thread.rows[0]!.id],
                )
              ).rows[0]?.count,
            ).toBe("0");
            expect(await getApprovalRequest(runtime, firstRequest.id)).toMatchObject({
              status: "approved",
              executionStatus: "queued",
              executionResult: null,
            });
          } catch (error) {
            normalFailure = { error };
          } finally {
            releaseCommit();
          }
          const [normalSettled] = await Promise.allSettled([normalFirst]);
          if (normalSettled.status === "rejected") {
            if (normalFailure && normalFailure.error !== normalSettled.reason)
              throw new AggregateError(
                [normalFailure.error, normalSettled.reason],
                "Ordinary contender and cleanup failed",
              );
            throw normalSettled.reason;
          }
          if (normalFailure) throw normalFailure.error;
          expect(await countJobsByIdentifier(pool, CORE_TASK_NAMES.ROLLUP_RECOMPUTE)).toBeGreaterThan(baselineJobs);
          expect(delivered.length).toBeGreaterThan(0);
          const conflict = await replayApprovedGenericOperation(runtime, firstRequest);
          expect(conflict.error).toBe(true);
          expect((await getApprovalRequest(runtime, firstRequest.id))?.executionStatus).toBe("conflict");
          if (kind === "delete")
            await cp.createRelation({
              relationPropertyId: pair.property.id,
              callerItemId: caller.id,
              targetItemId: first.id,
              metadata: { version: "reset" },
            });
          if (kind === "insert")
            await cp.deleteRelation({
              relationPropertyId: pair.inverseProperty.id,
              callerItemId: second.id,
              targetItemId: caller.id,
            });
          if (kind === "upsert") {
            await withTransaction(runtime, (client) =>
              insertValueLink(client, { itemId: caller.id, propertyKey: "target", ruleKey: "test", sources: [] }),
            );
          }
          const secondRequest = await request();
          pauseApproval = true;
          const replay = replayApprovedGenericOperation(runtime, secondRequest);
          let normalLater: ReturnType<typeof ordinary> | undefined;
          let approvalFailure: { error: unknown } | undefined;
          try {
            await Promise.race([
              atApproval,
              replay.then(() => {
                throw new Error("Approval replay ended before its mutation barrier");
              }),
            ]);
            if (kind === "insert") {
              await cp.createRelation({
                relationPropertyId: unrelatedPair.property.id,
                callerItemId: caller.id,
                targetItemId: second.id,
              });
              startForeign(true);
              await foreignWork;
            }
            if (kind === "upsert") {
              let protectedPid = 0;
              await expect(
                withTransaction(runtime, async (client) => {
                  const identity = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
                  protectedPid = identity.rows[0]!.pid;
                  return createRelationWithClient(
                    client,
                    { relationPropertyId: pair.property.id, callerItemId: caller.id, targetItemId: second.id },
                    { ownerProcess: VALUE_LINKS_OWNER_PROCESS },
                  );
                }),
              ).rejects.toBeInstanceOf(ValueLinkBusyError);
              expect(protectedPid).toBeGreaterThan(0);
              expect(protectedPid).not.toBe(approvalPid);
              process.stdout.write(`reservation protected: holder=${approvalPid} contender=${protectedPid}\n`);
              const protectedEdges = await cp.listItemRelations(caller.id, pair.property.id);
              expect(protectedEdges).toHaveLength(1);
            }
            normalPid = 0;
            // This gate is already open; the proxy still records the actual contender backend.
            normalLater = ordinary(createChokePoint(heldPool));
            void normalLater.catch(() => {});
            await vi.waitFor(async () => {
              expect(normalPid).toBeGreaterThan(0);
              const result = await pool.query<{ blocked: number[] }>("SELECT pg_blocking_pids($1) AS blocked", [
                normalPid,
              ]);
              expect(result.rows[0]?.blocked).toContain(approvalPid);
            });
            process.stdout.write(`reservation approval-first ${kind}: holder=${approvalPid} contender=${normalPid}\n`);
          } catch (error) {
            approvalFailure = { error };
          } finally {
            releaseApproval();
          }
          const settled = await Promise.allSettled(normalLater ? [replay, normalLater] : [replay]);
          const failures: unknown[] = approvalFailure ? [approvalFailure.error] : [];
          for (const result of settled) {
            if (result.status === "rejected" && !failures.includes(result.reason)) failures.push(result.reason);
          }
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1) throw new AggregateError(failures, "Approval contender and cleanup failed");
          expect((await getApprovalRequest(runtime, secondRequest.id))?.executionStatus).toBe("succeeded");
          const outcomes = await pool.query<{ system_key: string }>(
            "SELECT system_key FROM semp_messages WHERE thread_id = $1 ORDER BY created_at, id",
            [thread.rows[0]!.id],
          );
          expect(outcomes.rows.map((row) => row.system_key).sort()).toEqual([
            "approval.outcome.conflict",
            "approval.outcome.executed",
          ]);
          const edges = await cp.listItemRelations(caller.id, pair.property.id);
          if (kind === "delete") expect(edges).toEqual([]);
          else if (kind === "insert") expect(edges).toHaveLength(2);
          else {
            expect(edges).toMatchObject([{ targetItemId: first.id, metadata: { version: "normal" } }]);
            const stored = await runtime.query<{ id: string; metadata: unknown }>(
              "SELECT id, metadata FROM item_relations WHERE id = $1 AND tenant_id = $2",
              [original.id, getTenantZeroId()],
            );
            expect(stored.rows).toEqual([{ id: original.id, metadata: { version: "normal" } }]);
          }
          if (kind === "upsert") {
            await withTransaction(runtime, (client) =>
              createRelationWithClient(
                client,
                { relationPropertyId: pair.property.id, callerItemId: caller.id, targetItemId: second.id },
                { ownerProcess: VALUE_LINKS_OWNER_PROCESS },
              ),
            );
            expect(await cp.listItemRelations(caller.id, pair.property.id)).toHaveLength(2);
          }
        } finally {
          active = false;
          startForeign(false);
          await foreignWork;
          setInvalidationHook(() => {});
          releaseApproval();
          await runtime.end();
        }
      });
    },
  );

  it("releases relation projection reservations after a managed rollback", async () => {
    const firstPool = await createRuntimeRolePool(pool, "semprec_data");
    const secondPool = await createRuntimeRolePool(pool, "semprec_data");
    const delivered: unknown[] = [];
    let failure: unknown;
    try {
      await inTenantZero(async () => {
        const cp = createChokePoint(firstPool);
        const source = await cp.createDatabase({ name: "Rollback source" });
        const target = await cp.createDatabase({ name: "Rollback target" });
        const { property } = await cp.createRelationProperty({
          sourceDatabaseId: source.id,
          targetDatabaseId: target.id,
          key: "target",
          name: "Target",
        });
        const caller = await cp.createItem({ databaseId: source.id, properties: {} });
        const destination = await cp.createItem({ databaseId: target.id, properties: {} });
        const edge = await cp.createRelation({
          relationPropertyId: property.id,
          callerItemId: caller.id,
          targetItemId: destination.id,
        });
        const beforeRelations = await cp.listItemRelations(caller.id, property.id);
        const readEdge = () =>
          withTransaction(firstPool, (client) =>
            client.query<{ id: string; metadata: unknown }>("SELECT id, metadata FROM item_relations WHERE id = $1", [
              edge.id,
            ]),
          );
        const beforeEdge = await readEdge();
        expect(beforeEdge.rowCount).toBe(1);
        const check = {
          operation: "relation.put",
          input: { relationPropertyId: property.id, callerItemId: caller.id, targetItemId: destination.id },
        } as const;
        const counts = async () =>
          (
            await pool.query<{ requests: string; messages: string; jobs: string }>(
              "SELECT (SELECT count(*) FROM approval_requests)::text AS requests, (SELECT count(*) FROM semp_messages)::text AS messages, (SELECT count(*) FROM graphile_worker.jobs)::text AS jobs",
            )
          ).rows[0];
        const before = await counts();
        const originalError = new Error("forced reservation rollback");
        let firstPid = 0;
        let secondPid = 0;
        setInvalidationHook((event) => delivered.push(event));
        await expect(
          withTransaction(firstPool, async (client) => {
            firstPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
            await computeDestructiveResourceProjection(client, check);
            throw originalError;
          }),
        ).rejects.toBe(originalError);
        await withTransaction(secondPool, async (client) => {
          secondPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
          await computeDestructiveResourceProjection(client, check);
        });
        expect(firstPid).toBeGreaterThan(0);
        expect(secondPid).toBeGreaterThan(0);
        expect(secondPid).not.toBe(firstPid);
        process.stdout.write(`reservation rollback: first=${firstPid} second=${secondPid}\n`);
        expect(await cp.listItemRelations(caller.id, property.id)).toEqual(beforeRelations);
        expect((await readEdge()).rows).toEqual(beforeEdge.rows);
        expect(await counts()).toEqual(before);
        expect(delivered).toEqual([]);
      });
    } catch (error) {
      failure = error;
    }
    setInvalidationHook(() => {});
    const cleanup = await Promise.allSettled([firstPool.end(), secondPool.end()]);
    const errors = [
      ...(failure === undefined ? [] : [failure]),
      ...cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    ];
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Reservation test and cleanup failed");
  });

  it("rejects relation reservations outside a managed READ COMMITTED tenant transaction", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      await inTenantZero(async () => {
        const cp = createChokePoint(runtime);
        const source = await cp.createDatabase({ name: "Isolation source" });
        const target = await cp.createDatabase({ name: "Isolation target" });
        const { property } = await cp.createRelationProperty({
          sourceDatabaseId: source.id,
          targetDatabaseId: target.id,
          key: "target",
          name: "Target",
        });
        const caller = await cp.createItem({ databaseId: source.id, properties: {} });
        const destination = await cp.createItem({ databaseId: target.id, properties: {} });
        const check = {
          operation: "relation.put",
          input: {
            relationPropertyId: property.id,
            callerItemId: caller.id,
            targetItemId: destination.id,
          },
        } as const;
        await expect(
          withTransaction(runtime, (client) => computeDestructiveResourceProjection(client, check), {
            isolation: "repeatable_read",
          }),
        ).rejects.toThrow("tenant-scoped READ COMMITTED transaction");
        const unmanaged = await runtime.connect();
        try {
          await unmanaged.query("BEGIN");
          await expect(computeDestructiveResourceProjection(unmanaged, check)).rejects.toThrow(
            "active managed transaction",
          );
        } finally {
          await unmanaged.query("ROLLBACK");
          unmanaged.release();
        }
        expect(await cp.listItemRelations(caller.id, property.id)).toEqual([]);
      });
      await expect(
        runAsSystem("test relation reservation scope", () =>
          withTransaction(runtime, (client) =>
            computeDestructiveResourceProjection(client, {
              operation: "relation.put",
              input: {
                relationPropertyId: randomUUID(),
                callerItemId: randomUUID(),
                targetItemId: randomUUID(),
              },
            }),
          ),
        ),
      ).rejects.toThrow("Relation approval requires a tenant scope");
    } finally {
      await runtime.end();
    }
  });

  it("refuses foreign and random relation endpoints without changing either tenant", async () => {
    const foreignTenant = await createTestTenant(pool);
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      const cp = createChokePoint(runtime);
      const foreignItem = await runInTenant(foreignTenant, async () => {
        const database = await cp.createDatabase({ name: "Foreign" });
        return cp.createItem({ databaseId: database.id, properties: {} });
      });
      await inTenantZero(async () => {
        const source = await cp.createDatabase({ name: "Owner source" });
        const target = await cp.createDatabase({ name: "Owner target" });
        const { property } = await cp.createRelationProperty({
          sourceDatabaseId: source.id,
          targetDatabaseId: target.id,
          key: "target",
          name: "Target",
          cardinality: "one_to_one",
        });
        const caller = await cp.createItem({ databaseId: source.id, properties: {} });
        const validTarget = await cp.createItem({ databaseId: target.id, properties: {} });
        const projectItemId = randomUUID();
        const run = await createAgentRun(runtime, { projectItemId, triggeredBy: "user", task: "relation isolation" });
        const actor: AuthenticatedActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
        const gateway = createGenericOperationGateway(runtime, testMetadataResolver);
        for (const operation of ["relation.put", "relation.set"] as const) {
          for (const endpoint of [foreignItem.id, randomUUID()]) {
            await expect(
              gateway.invoke(operation, actor, ALL_CAPABILITIES, {
                relationPropertyId: property.id,
                callerItemId: caller.id,
                targetItemId: endpoint,
              }),
            ).rejects.toMatchObject({ code: "validation_failed", details: { field: "targetItemId" } });
          }
        }
        expect(await cp.listItemRelations(caller.id, property.id)).toEqual([]);
        await cp.createRelation({
          relationPropertyId: property.id,
          callerItemId: caller.id,
          targetItemId: validTarget.id,
        });
        expect(await cp.listItemRelations(caller.id, property.id)).toMatchObject([{ targetItemId: validTarget.id }]);
        const requests = await runtime.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM approval_requests",
        );
        expect(requests.rows[0]?.count).toBe("0");
      });
      await runInTenant(foreignTenant, async () => {
        const visible = await cp.getItem(foreignItem.databaseId, foreignItem.id);
        expect(visible?.id).toBe(foreignItem.id);
      });
    } finally {
      await runtime.end();
    }
  });

  it.each(["archive-first", "approval-first"] as const)(
    "reserves an item patch against archive in %s order",
    async (order) =>
      inTenantZero(async () => {
        const scoped = await createRuntimeRolePool(pool, "semprec_data");
        let active = true;
        let release!: () => void;
        let reached!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const barrier = new Promise<void>((resolve) => (reached = resolve));
        let approvalPid = 0;
        let archivePid = 0;
        let replayPid = 0;
        let pause = false;
        const cp = createChokePoint(scoped);
        try {
          const db = await cp.createDatabase({ name: "Archive reservation" });
          await cp.createProperty({ databaseId: db.id, key: "note", name: "Note", type: "text" });
          const item = await cp.createItem({ databaseId: db.id, properties: { note: "before" } });
          const projectItemId = randomUUID();
          const run = await createAgentRun(scoped, { projectItemId, triggeredBy: "user", task: "patch" });
          const actor: AuthenticatedActor = {
            userId: run.actorUserId,
            runId: run.id,
            agentProjectItemId: projectItemId,
          };
          registerItemUpdateHook(async ({ client, item: changed, writer }) => {
            if (!active || changed.id !== item.id) return;
            requireApprovalForWrite(client, writer, [{ kind: "testReason" }]);
            if (pause && writer.approvedRequestId) {
              approvalPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
              reached();
              await gate;
            }
          });
          const gateway = createGenericOperationGateway(scoped, testMetadataResolver);
          const input = { itemId: item.id, properties: { note: "after" }, ifVersion: item.updatedAt };
          let requestId = "";
          try {
            await gateway.invoke("item.patch", actor, ALL_CAPABILITIES, input);
            expect.unreachable("Expected approval");
          } catch (error) {
            if (!(error instanceof ApprovalRequiredError)) throw error;
            requestId = error.details.approvalRequestId;
          }
          await withTransaction(scoped, (client) =>
            decideAndEnqueueApprovalRequest(client, {
              approvalRequestId: requestId,
              decision: "approved",
              decidedByUserId: run.actorUserId,
            }),
          );
          const request = await getApprovalRequest(scoped, requestId);
          if (!request || !isGenericOperationApprovalRequestPayload(request.payload))
            throw new Error("Missing request");
          const typed = { ...request, payload: request.payload };
          const observedReplayPool = new Proxy(scoped, {
            get(target, key, receiver) {
              if (key !== "connect") {
                const value: unknown = Reflect.get(target, key, receiver);
                return typeof value === "function" ? value.bind(target) : value;
              }
              return async () => {
                const client = await target.connect();
                replayPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
                return client;
              };
            },
          });
          const archivePool = new Proxy(scoped, {
            get(target, key, receiver) {
              if (key !== "connect") {
                const value: unknown = Reflect.get(target, key, receiver);
                return typeof value === "function" ? value.bind(target) : value;
              }
              return async () => {
                const client = await target.connect();
                archivePid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
                return new Proxy(client, {
                  get(inner, field, receiver2) {
                    if (field !== "query") {
                      const value: unknown = Reflect.get(inner, field, receiver2);
                      return typeof value === "function" ? value.bind(inner) : value;
                    }
                    return async (...args: unknown[]) => {
                      if (order === "archive-first" && args[0] === "COMMIT") {
                        reached();
                        await gate;
                      }
                      return Reflect.apply(inner.query.bind(inner), inner, args);
                    };
                  },
                });
              };
            },
          });
          if (order === "archive-first") {
            const archive = createChokePoint(archivePool).archiveDatabase(db.id);
            let failure: { error: unknown } | undefined;
            try {
              await Promise.race([
                barrier,
                archive.then(() => {
                  throw new Error("Archive ended before barrier");
                }),
              ]);
              await expect(replayApprovedGenericOperation(observedReplayPool, typed)).rejects.toBeInstanceOf(
                ApprovalResourceBusyError,
              );
              expect(replayPid).toBeGreaterThan(0);
              expect(replayPid).not.toBe(archivePid);
              process.stdout.write(`item archive-first: holder=${archivePid} contender=${replayPid}\n`);
              const beforeCount = (
                await scoped.query<{ count: string }>("SELECT count(*)::text AS count FROM approval_requests")
              ).rows[0]?.count;
              await expect(gateway.invoke("item.patch", actor, ALL_CAPABILITIES, input)).rejects.toBeInstanceOf(
                ApprovalResourceBusyError,
              );
              expect(
                (await scoped.query<{ count: string }>("SELECT count(*)::text AS count FROM approval_requests")).rows[0]
                  ?.count,
              ).toBe(beforeCount);
              await expect(
                withTransaction(scoped, async (client) => {
                  try {
                    await computeDestructiveResourceProjection(client, {
                      operation: "item.patch",
                      input: { itemId: item.id },
                    });
                  } catch (error) {
                    expect(error).toBeInstanceOf(ApprovalResourceBusyError);
                  }
                }),
              ).rejects.toBeInstanceOf(ApprovalResourceBusyError);
              expect((await getApprovalRequest(scoped, requestId))?.executionStatus).toBe("queued");
            } catch (error) {
              failure = { error };
            } finally {
              release();
            }
            const [done] = await Promise.allSettled([archive]);
            if (done.status === "rejected") {
              if (failure && failure.error !== done.reason) throw new AggregateError([failure.error, done.reason]);
              throw done.reason;
            }
            if (failure) throw failure.error;
            expect((await replayApprovedGenericOperation(scoped, typed)).error).toBe(true);
            expect((await getApprovalRequest(scoped, requestId))?.executionStatus).toBe("conflict");
            expect((await cp.getItem(db.id, item.id))?.properties.note).toBe("before");
          } else {
            pause = true;
            const replay = replayApprovedGenericOperation(scoped, typed);
            let archive: Promise<unknown> | undefined;
            let failure: { error: unknown } | undefined;
            try {
              await Promise.race([
                barrier,
                replay.then(() => {
                  throw new Error("Replay ended before barrier");
                }),
              ]);
              archive = createChokePoint(archivePool).archiveDatabase(db.id);
              void archive.catch(() => {});
              await vi.waitFor(async () => {
                expect(archivePid).toBeGreaterThan(0);
                const blocked = await pool.query<{ pids: number[] }>("SELECT pg_blocking_pids($1) AS pids", [
                  archivePid,
                ]);
                expect(blocked.rows[0]?.pids).toContain(approvalPid);
              });
              process.stdout.write(`item approval-first: holder=${approvalPid} contender=${archivePid}\n`);
            } catch (error) {
              failure = { error };
            } finally {
              release();
            }
            const results = await Promise.allSettled(archive ? [replay, archive] : [replay]);
            const errors: unknown[] = failure ? [failure.error] : [];
            for (const result of results)
              if (result.status === "rejected" && !errors.includes(result.reason)) errors.push(result.reason);
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) throw new AggregateError(errors);
            expect((await getApprovalRequest(scoped, requestId))?.executionStatus).toBe("succeeded");
            expect((await cp.getItem(db.id, item.id))?.properties.note).toBe("after");
          }
        } finally {
          active = false;
          release();
          await scoped.end();
        }
      }),
  );

  it("approves a recurrence change exactly once", async () =>
    inTenantZero(async () => {
      const tasks = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "tasks"));
      if (!tasks) throw new Error("Tasks missing");
      const item = await chokePoint.createItem({
        databaseId: tasks.id,
        properties: { name: "Task", date: "2026-10-22" },
      });
      const weekly = await chokePoint.updateItem({
        databaseId: tasks.id,
        itemId: item.id,
        propertiesPatch: { recurrence: { preset: "weekly" } },
      });
      const projectItemId = randomUUID();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "change recurrence" });
      const actor: AuthenticatedActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
      let requestId = "";
      try {
        await gateway.invoke("item.patch", actor, ALL_CAPABILITIES, {
          itemId: item.id,
          properties: { recurrence: { preset: "monthly" } },
          ifVersion: weekly.updatedAt,
        });
        expect.unreachable("Expected approval");
      } catch (error) {
        if (!(error instanceof ApprovalRequiredError)) throw error;
        requestId = error.details.approvalRequestId;
      }
      expect((await chokePoint.findItem(item.id))?.properties.recurrence).toEqual(weekly.properties.recurrence);
      const pending = await getApprovalRequest(pool, requestId);
      expect(pending?.description?.key).toBe("approval.changesSeries");
      await withTransaction(pool, (client) =>
        decideAndEnqueueApprovalRequest(client, {
          approvalRequestId: requestId,
          decision: "approved",
          decidedByUserId: run.actorUserId,
        }),
      );
      const request = await getApprovalRequest(pool, requestId);
      if (!request || !isGenericOperationApprovalRequestPayload(request.payload)) throw new Error("Missing request");
      expect((await replayApprovedGenericOperation(pool, { ...request, payload: request.payload })).error).toBe(false);
      const after = await chokePoint.findItem(item.id);
      expect(after?.properties.recurrence).toMatchObject({
        preset: "monthly",
        rule: { kind: "monthDates", dates: [22] },
      });
      expect((await replayApprovedGenericOperation(pool, { ...request, payload: request.payload })).error).toBe(false);
      expect(await chokePoint.findItem(item.id)).toEqual(after);
    }));

  it("executes a new series immediately, leaves a rejected ending unchanged, and conflicts on a stale series", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let failure: { error: unknown } | undefined;
    try {
      await runInTenant(getTenantZeroId(), async () => {
        const tasks = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "tasks"));
        if (!tasks) throw new Error("Tasks missing");
        const cp = createChokePoint(runtime);
        const item = await cp.createItem({ databaseId: tasks.id, properties: { name: "Task", date: "2026-10-22" } });
        const projectItemId = randomUUID();
        const run = await withTransaction(runtime, (client) =>
          createAgentRun(client, { projectItemId, triggeredBy: "user", task: "recurrence" }),
        );
        const actor: AuthenticatedActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
        const gateway = createGenericOperationGateway(runtime, testMetadataResolver);
        const initial = await cp.findItem(item.id);
        await expect(
          gateway.invoke("item.patch", actor, NO_CAPABILITIES, {
            itemId: item.id,
            properties: { recurrence: { preset: "weekly" } },
            ifVersion: item.updatedAt,
          }),
        ).rejects.toMatchObject({ status: 404, code: "not_found" });
        expect(await cp.findItem(item.id)).toEqual(initial);
        const created = await gateway.invoke("item.patch", actor, ALL_CAPABILITIES, {
          itemId: item.id,
          properties: { recurrence: { preset: "weekly" } },
          ifVersion: item.updatedAt,
        });
        expect(created.properties.recurrence).toMatchObject({ preset: "weekly" });
        expect(created.properties.seriesId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
        const seriesSnapshot = () =>
          runtime.query<{
            item_id: string;
            series_id: string;
            active: boolean;
            mode: string;
            rule: unknown;
            anchor_date: Date | null;
            template: unknown;
          }>(
            "SELECT item_id, series_id, active, mode, rule, anchor_date, template FROM task_recurrence WHERE series_id = $1",
            [created.properties.seriesId],
          );
        const originalSeries = await seriesSnapshot();
        expect(originalSeries.rows).toMatchObject([
          { active: true, mode: "fixed", rule: { kind: "weekdays", days: ["thu"] } },
        ]);
        const weekly = await cp.findItem(item.id);
        if (!weekly) throw new Error("Task missing");
        expect(weekly.properties.recurrence).toMatchObject({ preset: "weekly" });
        const requestFor = async (value: unknown, version: string, ordinary: Record<string, unknown> = {}) => {
          try {
            await gateway.invoke("item.patch", actor, ALL_CAPABILITIES, {
              itemId: item.id,
              properties: { ...ordinary, recurrence: value },
              ifVersion: version,
            });
          } catch (error) {
            if (error instanceof ApprovalRequiredError) return error.details.approvalRequestId;
            throw error;
          }
          throw new Error("Approval was not requested");
        };
        const rejected = await requestFor(null, weekly.updatedAt);
        expect((await seriesSnapshot()).rows).toEqual(originalSeries.rows);
        await withTransaction(runtime, (client) =>
          decideAndEnqueueApprovalRequest(client, {
            approvalRequestId: rejected,
            decision: "rejected",
            decidedByUserId: actor.userId,
          }),
        );
        expect(await cp.findItem(item.id)).toEqual(weekly);
        expect((await seriesSnapshot()).rows).toEqual(originalSeries.rows);
        const seriesOnly = await requestFor({ preset: "monthly" }, weekly.updatedAt);
        expect((await seriesSnapshot()).rows).toEqual(originalSeries.rows);
        // Synthetic intervening state: normal recurrence owners update the item projection too.
        const seriesOnlyRule = { kind: "weekdays", days: ["mon"] };
        await runtime.query("UPDATE task_recurrence SET rule = $2::jsonb WHERE series_id = $1", [
          created.properties.seriesId,
          JSON.stringify(seriesOnlyRule),
        ]);
        expect(await cp.findItem(item.id)).toEqual(weekly);
        await withTransaction(runtime, (client) =>
          decideAndEnqueueApprovalRequest(client, {
            approvalRequestId: seriesOnly,
            decision: "approved",
            decidedByUserId: actor.userId,
          }),
        );
        const seriesOnlyRequest = await withTransaction(runtime, (client) => getApprovalRequest(client, seriesOnly));
        if (!seriesOnlyRequest || !isGenericOperationApprovalRequestPayload(seriesOnlyRequest.payload))
          throw new Error("Missing series-only request");
        const jobsBeforeConflict = await pool.query<{ id: string; key: string | null }>(
          "SELECT id, key FROM graphile_worker.jobs ORDER BY id",
        );
        const conflictInvalidations: unknown[] = [];
        setInvalidationHook((event) => conflictInvalidations.push(event));
        try {
          expect(
            (
              await replayApprovedGenericOperation(runtime, {
                ...seriesOnlyRequest,
                payload: seriesOnlyRequest.payload,
              })
            ).error,
          ).toBe(true);
        } finally {
          setInvalidationHook(() => {});
        }
        expect(await cp.findItem(item.id)).toEqual(weekly);
        expect(
          (
            await runtime.query<{ rule: unknown }>("SELECT rule FROM task_recurrence WHERE series_id = $1", [
              created.properties.seriesId,
            ])
          ).rows,
        ).toEqual([{ rule: seriesOnlyRule }]);
        expect(
          (await withTransaction(runtime, (client) => getApprovalRequest(client, seriesOnly)))?.executionStatus,
        ).toBe("conflict");
        expect(
          (await pool.query<{ id: string; key: string | null }>("SELECT id, key FROM graphile_worker.jobs ORDER BY id"))
            .rows,
        ).toEqual(jobsBeforeConflict.rows);
        expect(conflictInvalidations).toEqual([]);
        await runtime.query("UPDATE task_recurrence SET rule = $2::jsonb WHERE series_id = $1", [
          created.properties.seriesId,
          JSON.stringify({ kind: "weekdays", days: ["thu"] }),
        ]);
        const stale = await requestFor({ preset: "monthly" }, weekly.updatedAt, {
          name: "Changed only after approval",
        });
        expect(await cp.findItem(item.id)).toEqual(weekly);
        const pending = await withTransaction(runtime, (client) => getApprovalRequest(client, stale));
        expect(pending).toMatchObject({
          riskClass: "write",
          description: {
            key: "approval.changesSeries",
            params: {
              taskName: "Task",
              fromRule: JSON.stringify({ kind: "weekdays", days: ["thu"] }),
              toRule: JSON.stringify({ kind: "monthDates", dates: [22] }),
            },
          },
        });
        const notifications = await runtime.query<{ id: string; kind: string; body: string | null }>(
          "SELECT id, kind, body FROM notifications WHERE source_table = $1 AND source_id = $2",
          ["approval_requests", stale],
        );
        expect(notifications.rows).toEqual([
          {
            id: expect.any(String),
            kind: "approval_pending",
            body: `Změnit opakování úkolu „Task“ z ${JSON.stringify({ kind: "weekdays", days: ["thu"] })} na ${JSON.stringify({ kind: "monthDates", dates: [22] })}. Lze ji později vzít zpět.`,
          },
        ]);
        const notificationId = notifications.rows[0]?.id;
        if (!notificationId) throw new Error("Missing approval notification");
        const fanout = await pool.query<{ key: string }>("SELECT key FROM graphile_worker.jobs WHERE key = $1", [
          `notification-fanout:${notificationId}`,
        ]);
        expect(fanout.rows).toEqual([{ key: `notification-fanout:${notificationId}` }]);
        const changed = await gateway.invoke(
          "item.patch",
          { userId: actor.userId, restSession: true },
          ALL_CAPABILITIES,
          {
            itemId: item.id,
            properties: { recurrence: { preset: "daily" } },
            ifVersion: weekly.updatedAt,
          },
        );
        const changedProjection = await cp.findItem(item.id);
        expect(changedProjection?.updatedAt).toBe(changed.updatedAt);
        await withTransaction(runtime, (client) =>
          decideAndEnqueueApprovalRequest(client, {
            approvalRequestId: stale,
            decision: "approved",
            decidedByUserId: actor.userId,
          }),
        );
        const request = await withTransaction(runtime, (client) => getApprovalRequest(client, stale));
        if (!request || !isGenericOperationApprovalRequestPayload(request.payload)) throw new Error("Missing request");
        expect((await replayApprovedGenericOperation(runtime, { ...request, payload: request.payload })).error).toBe(
          true,
        );
        expect(await cp.findItem(item.id)).toEqual(changedProjection);
        expect((await withTransaction(runtime, (client) => getApprovalRequest(client, stale)))?.executionStatus).toBe(
          "conflict",
        );
        const changeRequest = await requestFor({ preset: "monthly" }, changed.updatedAt, {
          name: "Approved together",
        });
        await withTransaction(runtime, (client) =>
          decideAndEnqueueApprovalRequest(client, {
            approvalRequestId: changeRequest,
            decision: "approved",
            decidedByUserId: actor.userId,
          }),
        );
        const approvedChange = await withTransaction(runtime, (client) => getApprovalRequest(client, changeRequest));
        if (!approvedChange || !isGenericOperationApprovalRequestPayload(approvedChange.payload))
          throw new Error("Missing change request");
        expect(
          (await replayApprovedGenericOperation(runtime, { ...approvedChange, payload: approvedChange.payload })).error,
        ).toBe(false);
        const changedTogether = await cp.findItem(item.id);
        expect(changedTogether?.properties).toMatchObject({
          name: "Approved together",
          recurrence: { preset: "monthly", mode: "fixed", rule: { kind: "monthDates", dates: [22] } },
        });
        expect(
          (
            await runtime.query<{ rule: unknown }>("SELECT rule FROM task_recurrence WHERE series_id = $1", [
              created.properties.seriesId,
            ])
          ).rows,
        ).toEqual([{ rule: { kind: "monthDates", dates: [22] } }]);
        const seriesAfterChange = await seriesSnapshot();
        const jobsAfterChange = await pool.query<{ id: string; key: string | null }>(
          "SELECT id, key FROM graphile_worker.jobs ORDER BY id",
        );
        const replayInvalidations: unknown[] = [];
        setInvalidationHook((event) => replayInvalidations.push(event));
        try {
          expect(
            (await replayApprovedGenericOperation(runtime, { ...approvedChange, payload: approvedChange.payload }))
              .error,
          ).toBe(false);
        } finally {
          setInvalidationHook(() => {});
        }
        expect(await cp.findItem(item.id)).toEqual(changedTogether);
        expect((await seriesSnapshot()).rows).toEqual(seriesAfterChange.rows);
        expect(
          (await pool.query<{ id: string; key: string | null }>("SELECT id, key FROM graphile_worker.jobs ORDER BY id"))
            .rows,
        ).toEqual(jobsAfterChange.rows);
        expect(replayInvalidations).toEqual([]);
        if (!changedTogether) throw new Error("Missing changed task");
        const ending = await requestFor(null, changedTogether.updatedAt);
        await withTransaction(runtime, (client) =>
          decideAndEnqueueApprovalRequest(client, {
            approvalRequestId: ending,
            decision: "approved",
            decidedByUserId: actor.userId,
          }),
        );
        const approvedEnd = await withTransaction(runtime, (client) => getApprovalRequest(client, ending));
        if (!approvedEnd || !isGenericOperationApprovalRequestPayload(approvedEnd.payload))
          throw new Error("Missing ending request");
        expect(
          (await replayApprovedGenericOperation(runtime, { ...approvedEnd, payload: approvedEnd.payload })).error,
        ).toBe(false);
        const ended = await cp.findItem(item.id);
        expect(ended?.properties).toMatchObject({ recurrence: null, seriesId: null, occurrenceDate: null });
        const rowsAfterEnd = await runtime.query<{ active: boolean }>(
          "SELECT active FROM task_recurrence WHERE series_id = $1",
          [created.properties.seriesId],
        );
        expect(rowsAfterEnd.rows).toEqual([{ active: false }]);
        const jobsAfterEnd = await pool.query<{ id: string; key: string | null }>(
          "SELECT id, key FROM graphile_worker.jobs ORDER BY id",
        );
        expect(
          (await replayApprovedGenericOperation(runtime, { ...approvedEnd, payload: approvedEnd.payload })).error,
        ).toBe(false);
        expect(await cp.findItem(item.id)).toEqual(ended);
        expect(
          (await pool.query<{ id: string; key: string | null }>("SELECT id, key FROM graphile_worker.jobs ORDER BY id"))
            .rows,
        ).toEqual(jobsAfterEnd.rows);
      });
    } catch (error) {
      failure = { error };
    }
    try {
      await runtime.end();
    } catch (cleanupError) {
      if (failure)
        throw new AggregateError([failure.error, cleanupError], "Recurrence test and cleanup failed", {
          // The test failure is primary; the cleanup error remains in the aggregate.
          // eslint-disable-next-line preserve-caught-error
          cause: failure.error,
        });
      throw cleanupError;
    }
    if (failure) throw failure.error;
  });

  it("rolls back a recurrence approval request if its notification insert fails", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let failure: { error: unknown } | undefined;
    let triggerCreated = false;
    const invalidations: unknown[] = [];
    try {
      await runInTenant(getTenantZeroId(), async () => {
        const tasks = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "tasks"));
        if (!tasks) throw new Error("Tasks missing");
        const cp = createChokePoint(runtime);
        const item = await cp.createItem({
          databaseId: tasks.id,
          properties: { name: "Atomic task", date: "2026-10-22" },
        });
        const weekly = await cp.updateItem({
          databaseId: tasks.id,
          itemId: item.id,
          propertiesPatch: { recurrence: { preset: "weekly" } },
        });
        const projectItemId = randomUUID();
        const run = await createAgentRun(runtime, {
          projectItemId,
          triggeredBy: "user",
          task: "change recurrence",
        });
        const actor: AuthenticatedActor = {
          userId: run.actorUserId,
          runId: run.id,
          agentProjectItemId: projectItemId,
        };
        const gateway = createGenericOperationGateway(runtime, testMetadataResolver);
        const beforeItem = await cp.findItem(item.id);
        const beforeSeries = await runtime.query<{ item_id: string; mode: string; rule: unknown; active: boolean }>(
          "SELECT item_id, mode, rule, active FROM task_recurrence WHERE item_id = $1",
          [item.id],
        );
        const beforeRequests = await runtime.query<{ id: string }>("SELECT id FROM approval_requests ORDER BY id");
        const beforeNotifications = await runtime.query<{ id: string }>("SELECT id FROM notifications ORDER BY id");
        const beforeJobs = await pool.query<{ id: string; key: string | null }>(
          "SELECT id, key FROM graphile_worker.jobs ORDER BY id",
        );
        await pool.query(`CREATE FUNCTION reject_recurrence_notification_test() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'injected recurrence notification failure'; END $$`);
        await pool.query(`CREATE TRIGGER reject_recurrence_notification_test BEFORE INSERT ON notifications
          FOR EACH ROW WHEN (NEW.kind = 'approval_pending') EXECUTE FUNCTION reject_recurrence_notification_test()`);
        triggerCreated = true;
        setInvalidationHook((event) => invalidations.push(event));
        await expect(
          gateway.invoke("item.patch", actor, ALL_CAPABILITIES, {
            itemId: item.id,
            properties: { recurrence: { preset: "monthly" }, name: "Not committed" },
            ifVersion: weekly.updatedAt,
          }),
        ).rejects.toThrow("injected recurrence notification failure");
        expect(await cp.findItem(item.id)).toEqual(beforeItem);
        expect(
          (
            await runtime.query<{ item_id: string; mode: string; rule: unknown; active: boolean }>(
              "SELECT item_id, mode, rule, active FROM task_recurrence WHERE item_id = $1",
              [item.id],
            )
          ).rows,
        ).toEqual(beforeSeries.rows);
        expect((await runtime.query<{ id: string }>("SELECT id FROM approval_requests ORDER BY id")).rows).toEqual(
          beforeRequests.rows,
        );
        expect((await runtime.query<{ id: string }>("SELECT id FROM notifications ORDER BY id")).rows).toEqual(
          beforeNotifications.rows,
        );
        expect(
          (await pool.query<{ id: string; key: string | null }>("SELECT id, key FROM graphile_worker.jobs ORDER BY id"))
            .rows,
        ).toEqual(beforeJobs.rows);
        expect(invalidations).toEqual([]);
      });
    } catch (error) {
      failure = { error };
    }
    setInvalidationHook(() => {});
    const cleanup: unknown[] = [];
    for (const step of [
      async () => {
        if (triggerCreated) await pool.query("DROP TRIGGER reject_recurrence_notification_test ON notifications");
      },
      async () => {
        await pool.query("DROP FUNCTION IF EXISTS reject_recurrence_notification_test()");
      },
      async () => {
        await runtime.end();
      },
    ]) {
      try {
        await step();
      } catch (error) {
        cleanup.push(error);
      }
    }
    if (cleanup.length)
      throw new AggregateError(
        failure ? [failure.error, ...cleanup] : cleanup,
        "Recurrence notification cleanup failed",
        { cause: failure ? failure.error : cleanup[0] },
      );
    if (failure) throw failure.error;
  });

  it("snapshots and replays a flagged item patch without the original version guard", async () =>
    inTenantZero(async () => {
      const database = await chokePoint.createDatabase({ name: "Flag patch" });
      await chokePoint.createProperty({ databaseId: database.id, key: "note", name: "Note", type: "text" });
      await chokePoint.createProperty({ databaseId: database.id, key: "headline", name: "Headline", type: "title" });
      const item = await chokePoint.createItem({
        databaseId: database.id,
        properties: { note: "before", headline: "Patch title" },
      });
      const projectItemId = randomUUID();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "patch item" });
      const actor: AuthenticatedActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
      let active = true;
      registerItemUpdateHook(async ({ client, item: changed, writer }) => {
        if (active && changed.id === item.id) requireApprovalForWrite(client, writer, [{ kind: "testReason" }]);
      });
      try {
        let requestId = "";
        try {
          await gateway.invoke("item.patch", actor, ALL_CAPABILITIES, {
            itemId: item.id,
            properties: { note: "after" },
            ifVersion: item.updatedAt,
          });
          expect.unreachable("Expected approval");
        } catch (err) {
          if (!(err instanceof ApprovalRequiredError)) throw err;
          requestId = err.details.approvalRequestId;
        }
        expect((await chokePoint.findItem(item.id))?.properties.note).toBe("before");
        const pending = await getApprovalRequest(pool, requestId);
        expect(pending?.description).toEqual({
          key: "approval.itemPatch",
          params: { itemName: "Patch title", databaseKey: database.key, databaseName: "Flag patch" },
        });
        expect(JSON.stringify(pending?.description)).not.toContain("after");
        expect(JSON.stringify(pending?.description)).not.toContain(item.id);
        expect(pending?.resourceSnapshot.kind).toBe("item_patch");
        await inTenantZero(() =>
          withTransaction(pool, (client) =>
            decideAndEnqueueApprovalRequest(client, {
              approvalRequestId: requestId,
              decision: "approved",
              decidedByUserId: run.actorUserId,
            }),
          ),
        );
        // Simulate a stored stale client token without changing the snapshotted resource.
        await pool.query(
          "UPDATE approval_requests SET payload = jsonb_set(payload, '{canonicalInput,ifVersion}', to_jsonb($2::text)) WHERE id = $1",
          [requestId, "2000-01-01T00:00:00.000Z"],
        );
        const request = await getApprovalRequest(pool, requestId);
        if (!request || !isGenericOperationApprovalRequestPayload(request.payload))
          throw new Error("Expected generic request");
        expect((await replayApprovedGenericOperation(pool, { ...request, payload: request.payload })).error).toBe(
          false,
        );
        expect((await chokePoint.findItem(item.id))?.properties.note).toBe("after");
        await chokePoint.updateItem({
          databaseId: database.id,
          itemId: item.id,
          propertiesPatch: { headline: "Renamed" },
        });
        expect((await getApprovalRequest(pool, requestId))?.description).toEqual(pending?.description);
      } finally {
        active = false;
      }
    }));

  it("keeps a flagged relation-set description after the source is renamed", async () =>
    inTenantZero(async () => {
      const source = await chokePoint.createDatabase({ name: "Named source" });
      const target = await chokePoint.createDatabase({ name: "Named target" });
      await chokePoint.createProperty({ databaseId: source.id, key: "headline", name: "Headline", type: "title" });
      const { property } = await chokePoint.createRelationProperty({
        sourceDatabaseId: source.id,
        targetDatabaseId: target.id,
        key: "target",
        name: "Target",
        cardinality: "one_to_one",
      });
      const caller = await chokePoint.createItem({ databaseId: source.id, properties: { headline: "Original title" } });
      const destination = await chokePoint.createItem({ databaseId: target.id, properties: {} });
      const projectItemId = randomUUID();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "link" });
      const actor: AuthenticatedActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
      let active = true;
      registerRelationEdgeWriteHook(async ({ client, edgeContext, writer }) => {
        if (active && edgeContext.property.id === property.id)
          requireApprovalForWrite(client, writer, [{ kind: "testReason" }]);
      });
      try {
        let requestId = "";
        try {
          await createGenericOperationGateway(pool, testMetadataResolver).invoke(
            "relation.set",
            actor,
            ALL_CAPABILITIES,
            {
              relationPropertyId: property.id,
              callerItemId: caller.id,
              targetItemId: destination.id,
            },
          );
          expect.unreachable("Expected approval");
        } catch (error) {
          if (!(error instanceof ApprovalRequiredError)) throw error;
          requestId = error.details.approvalRequestId;
        }
        const description = (await getApprovalRequest(pool, requestId))?.description;
        expect(description).toEqual({
          key: "approval.relationSet",
          params: { fromItemName: "Original title", fromDatabaseKey: source.key, propertyName: "Target" },
        });
        await chokePoint.updateItem({
          databaseId: source.id,
          itemId: caller.id,
          propertiesPatch: { headline: "Renamed" },
        });
        expect((await getApprovalRequest(pool, requestId))?.description).toEqual(description);
      } finally {
        active = false;
      }
    }));

  it("snapshots and replays a flagged relation put", async () =>
    inTenantZero(async () => {
      const source = await chokePoint.createDatabase({ name: "Put source" });
      const target = await chokePoint.createDatabase({ name: "Put target" });
      await chokePoint.createProperty({ databaseId: source.id, key: "headline", name: "Headline", type: "title" });
      await chokePoint.createProperty({ databaseId: source.id, key: "name", name: "Name", type: "text" });
      await chokePoint.createProperty({ databaseId: target.id, key: "name", name: "Name", type: "text" });
      const { property } = await chokePoint.createRelationProperty({
        sourceDatabaseId: source.id,
        targetDatabaseId: target.id,
        key: "target",
        name: "Target",
      });
      const caller = await chokePoint.createItem({
        databaseId: source.id,
        properties: { headline: "Declared title", name: "Other name" },
      });
      const destination = await chokePoint.createItem({ databaseId: target.id, properties: { name: "Fallback name" } });
      const projectItemId = randomUUID();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "link items" });
      const actor: AuthenticatedActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
      let active = true;
      registerRelationEdgeWriteHook(async ({ client, edgeContext, writer }) => {
        if (active && edgeContext.property.id === property.id)
          requireApprovalForWrite(client, writer, [{ kind: "testReason" }]);
      });
      try {
        const requestId = await approveDestructive("relation.put", actor, {
          relationPropertyId: property.id,
          callerItemId: caller.id.toUpperCase(),
          targetItemId: destination.id.toUpperCase(),
        });
        expect(await chokePoint.listItemRelations(caller.id, property.id)).toEqual([]);
        const request = await getApprovalRequest(pool, requestId);
        if (!request || !isGenericOperationApprovalRequestPayload(request.payload))
          throw new Error("Expected generic request");
        expect(request.description).toEqual({
          key: "approval.relationPut",
          params: {
            fromItemName: "Declared title",
            fromDatabaseKey: source.key,
            toItemName: "Fallback name",
            toDatabaseKey: target.key,
          },
        });
        expect(JSON.stringify(request.description)).not.toContain(destination.id);
        expect(request.resourceSnapshot.kind).toBe("relation_put");
        expect((await replayApprovedGenericOperation(pool, { ...request, payload: request.payload })).error).toBe(
          false,
        );
        expect(await chokePoint.listItemRelations(caller.id, property.id)).toMatchObject([
          { targetItemId: destination.id },
        ]);
        await chokePoint.updateItem({
          databaseId: source.id,
          itemId: caller.id,
          propertiesPatch: { headline: "Renamed" },
        });
        await chokePoint.updateItem({
          databaseId: target.id,
          itemId: destination.id,
          propertiesPatch: { name: "Renamed" },
        });
        expect((await getApprovalRequest(pool, requestId))?.description).toEqual(request.description);
      } finally {
        active = false;
      }
    }));

  it("keeps unflagged relation sets immediate and permits flagged user and system writers", async () => {
    const source = await chokePoint.createDatabase({ name: "Immediate source" });
    const target = await chokePoint.createDatabase({ name: "Immediate target" });
    const { property } = await chokePoint.createRelationProperty({
      sourceDatabaseId: source.id,
      targetDatabaseId: target.id,
      key: "target",
      name: "Target",
      cardinality: "one_to_one",
    });
    const caller = await chokePoint.createItem({ databaseId: source.id, properties: {} });
    const first = await chokePoint.createItem({ databaseId: target.id, properties: {} });
    const second = await chokePoint.createItem({ databaseId: target.id, properties: {} });
    const third = await chokePoint.createItem({ databaseId: target.id, properties: {} });
    const projectItemId = randomUUID();
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "link" });
    const actor: AuthenticatedActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
    const gateway = createGenericOperationGateway(pool, testMetadataResolver);
    const input = { relationPropertyId: property.id, callerItemId: caller.id };
    await expect(
      gateway.invoke("relation.set", actor, ALL_CAPABILITIES, {
        ...input,
        targetItemId: first.id,
        approvedRequestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await gateway.invoke("relation.set", actor, ALL_CAPABILITIES, { ...input, targetItemId: first.id });
    await gateway.invoke("relation.set", actor, ALL_CAPABILITIES, { ...input, targetItemId: first.id });
    await gateway.invoke("relation.set", actor, ALL_CAPABILITIES, { ...input, targetItemId: second.id });
    expect(await chokePoint.listItemRelations(caller.id, property.id)).toMatchObject([{ targetItemId: second.id }]);
    let active = true;
    const writers: string[] = [];
    registerRelationEdgeWriteHook(async ({ client, edgeContext, writer }) => {
      if (!active || edgeContext.property.id !== property.id) return;
      writers.push(writer.writerKind);
      requireApprovalForWrite(client, writer, [{ kind: "testReason" }]);
    });
    try {
      await gateway.invoke("relation.set", { userId: run.actorUserId, restSession: true }, ALL_CAPABILITIES, {
        ...input,
        targetItemId: third.id,
      });
      await chokePoint.setRelation({ ...input, targetItemId: first.id });
      expect(writers).toEqual(["user", "system"]);
      expect(await chokePoint.listItemRelations(caller.id, property.id)).toMatchObject([{ targetItemId: first.id }]);
      const requests = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM approval_requests");
      expect(requests.rows[0]?.count).toBe("0");
    } finally {
      active = false;
    }
  });

  it.each(["changed", "sourceDeleted", "targetDeleted", "rejected"] as const)(
    "leaves the relation unchanged when a flagged request is %s",
    async (scenario) =>
      inTenantZero(async () => {
        const source = await chokePoint.createDatabase({ name: "Conflict source" });
        const target = await chokePoint.createDatabase({ name: "Conflict target" });
        const { property } = await chokePoint.createRelationProperty({
          sourceDatabaseId: source.id,
          targetDatabaseId: target.id,
          key: "target",
          name: "Target",
          cardinality: "one_to_one",
        });
        const caller = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const first = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const second = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const third = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const input = { relationPropertyId: property.id, callerItemId: caller.id };
        const original = await chokePoint.setRelation({ ...input, targetItemId: first.id });
        if (!original) throw new Error("Expected initial edge");
        // No production chat-thread creator exists on this tip.
        const thread = await pool.query<{ id: string }>("INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id");
        const projectItemId = randomUUID();
        const run = await createAgentRun(pool, {
          projectItemId,
          triggeredBy: "user",
          task: "replace",
          threadId: thread.rows[0]!.id,
        });
        const actor: AuthenticatedActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
        const gateway = createGenericOperationGateway(pool, testMetadataResolver);
        let active = true;
        registerRelationEdgeWriteHook(async ({ client, edgeContext, writer }) => {
          if (active && edgeContext.property.id === property.id)
            requireApprovalForWrite(client, writer, [{ kind: "testReason" }]);
        });
        try {
          let requestId = "";
          try {
            await gateway.invoke("relation.set", actor, ALL_CAPABILITIES, { ...input, targetItemId: second.id });
            expect.unreachable("Expected approval");
          } catch (err) {
            if (!(err instanceof ApprovalRequiredError)) throw err;
            requestId = err.details.approvalRequestId;
          }
          if (scenario === "changed") await chokePoint.setRelation({ ...input, targetItemId: third.id });
          if (scenario === "sourceDeleted") await chokePoint.softDeleteItem(source.id, caller.id);
          if (scenario === "targetDeleted") await chokePoint.softDeleteItem(target.id, second.id);
          const expected = scenario === "changed" ? third.id : first.id;
          await inTenantZero(() =>
            withTransaction(pool, (client) =>
              decideAndEnqueueApprovalRequest(client, {
                approvalRequestId: requestId,
                decision: scenario === "rejected" ? "rejected" : "approved",
                decidedByUserId: run.actorUserId,
              }),
            ),
          );
          const request = await getApprovalRequest(pool, requestId);
          if (!request || !isGenericOperationApprovalRequestPayload(request.payload))
            throw new Error("Expected generic request");
          if (scenario !== "rejected") {
            const outcome = await replayApprovedGenericOperation(pool, { ...request, payload: request.payload });
            expect(outcome.error).toBe(true);
            expect((await getApprovalRequest(pool, requestId))?.executionStatus).toBe("conflict");
          }
          if (scenario === "sourceDeleted") {
            const edges = await pool.query<{ id: string }>("SELECT id FROM item_relations WHERE id = $1", [
              original.id,
            ]);
            expect(edges.rows).toEqual([{ id: original.id }]);
          } else {
            expect(await chokePoint.listItemRelations(caller.id, property.id)).toMatchObject([
              { targetItemId: expected },
            ]);
          }
          const messages = await pool.query<{ system_key: string }>(
            "SELECT system_key FROM semp_messages WHERE thread_id = $1",
            [thread.rows[0]!.id],
          );
          expect(messages.rows).toEqual([
            { system_key: scenario === "rejected" ? "approval.outcome.rejected" : "approval.outcome.conflict" },
          ]);
        } finally {
          active = false;
        }
      }),
  );

  it("uses the actor's locale for database and view queries through the application gateway", async () => {
    await inTenantZero(async () => {
      const users = await pool.query<{ id: string }>("SELECT id FROM users WHERE tenant_id = $1", [getTenantZeroId()]);
      const user = users.rows[0];
      if (!user) throw new Error("Missing tenant user");
      const actor: AuthenticatedActor = { userId: user.id };
      const database = await chokePoint.createDatabase({ name: "Collation" });
      await chokePoint.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "title" });
      for (const name of ["Hrad", "Chalupa", "Rybník", "Řeka"]) {
        await chokePoint.createItem({ databaseId: database.id, properties: { name } });
      }
      const view = await chokePoint.createView({ databaseId: database.id, type: "table", name: "Names" });
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
      const sort = [{ property: "name", direction: "asc" }] as const;
      for (const [locale, expected] of [
        ["cs", ["Hrad", "Chalupa", "Rybník", "Řeka"]],
        ["en", ["Chalupa", "Hrad", "Řeka", "Rybník"]],
      ] as const) {
        // There is no user locale update operation in this fixture's application port.
        await pool.query("UPDATE users SET locale = $1 WHERE id = $2", [locale, user.id]);
        for (const operation of ["database.query", "view.query"] as const) {
          const names: string[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < 3; page++) {
            const input =
              operation === "database.query"
                ? { databaseId: database.id, sort, cursor, limit: 2 }
                : { viewId: view.id, sort, cursor, limit: 2 };
            const result =
              operation === "database.query"
                ? await gateway.invoke("database.query", actor, ALL_CAPABILITIES, input)
                : await gateway.invoke("view.query", actor, ALL_CAPABILITIES, input);
            names.push(...result.items.map((item) => String(item.properties.name)));
            if (result.nextCursor === null) break;
            cursor = result.nextCursor;
          }
          expect(names).toEqual(expected);
        }
      }
    });
  });

  it("item.patch carries the transactional pre-image through the production gateway and service", async () => {
    await inTenantZero(async () => {
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
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
      const gateway = createGenericOperationGateway(runtimePool, testMetadataResolver);
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

  it("requires explicit page capabilities independently of item capabilities", async () => {
    const actor: AuthenticatedActor = { userId: await createUser() };
    const database = await chokePoint.createDatabase({ name: "Pages" });
    const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
    const gateway = createGenericOperationGateway(pool, testMetadataResolver);
    const itemOnly = new Set<(typeof CAPABILITY_IDS)[number]>(["core.item.read", "core.item.write"]);
    expect(gateway.listOperations(itemOnly)).not.toContain("page.get");
    expect(gateway.listOperations(itemOnly)).not.toContain("page.restoreVersion");
    await expect(
      gateway.invoke("page.get", actor, itemOnly, { itemId: item.id, format: "summary" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      gateway.invoke("page.restoreVersion", actor, itemOnly, { itemId: item.id, at: new Date().toISOString() }),
    ).rejects.toMatchObject({ status: 404 });
    const pages = new Set<(typeof CAPABILITY_IDS)[number]>(["core.page.read", "core.page.write"]);
    expect(gateway.listOperations(pages)).toContain("page.get");
    expect(gateway.listOperations(pages)).toContain("page.restoreVersion");
    expect(await gateway.invoke("page.get", actor, pages, { itemId: item.id, format: "summary" })).toMatchObject({
      docId: null,
    });
    expect((await pool.query("SELECT id FROM docs WHERE item_id = $1", [item.id])).rows).toHaveLength(0);
  });

  describe("listOperations", () => {
    it("returns only the operations whose capability is granted, never present-but-forbidden", () => {
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);

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
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
      const actor: AuthenticatedActor = { userId: await createUser() };

      await expect(gateway.invoke("item.get", actor, NO_CAPABILITIES, { itemId: randomUUID() })).rejects.toThrow(
        NotFoundError,
      );
    });

    it("rejects an agent actor carrying runId without agentProjectItemId as owner_violation", async () => {
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
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
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
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
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
      const actor: AuthenticatedActor = { userId: await createUser() };

      await expect(gateway.invoke("item.get", actor, ALL_CAPABILITIES, {})).rejects.toThrow(ValidationError);
    });

    it("names the offending field when property.create fails its union schema", async () => {
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
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
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
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
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
      const actor: AuthenticatedActor = { userId: await createUser() };
      const database = await chokePoint.createDatabase({ name: "Gateway DB 2" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });

      await gateway.invoke("item.delete", actor, ALL_CAPABILITIES, { itemId: item.id });

      expect(await chokePoint.findItem(item.id)).toBeNull();
      const { rows } = await pool.query(`SELECT count(*)::int AS count FROM approval_requests`);
      expect(rows[0].count).toBe(0);
    });

    it("defers a destructive operation for a full agent actor: no execution, one pending approval_requests row, ApprovalRequiredError", async () => {
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
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
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
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
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
      const database = await chokePoint.createDatabase({ name: "Gateway DB tool call" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      const projectItemId = randomUUID();
      // No public writer creates a chat thread with a historical activity timestamp.
      const thread = await withTransaction(pool, (client) =>
        client.query<{ id: string }>(
          "INSERT INTO semp_threads (kind, last_activity_at) VALUES ('chat', '2020-01-01') RETURNING id",
        ),
      );
      const threadId = thread.rows[0]!.id;
      const run = await createAgentRun(pool, { projectItemId, threadId, triggeredBy: "user", task: "delete it" });
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
      const activity = await withTransaction(pool, (client) =>
        client.query<{ last_activity_at: Date; requested_at: Date }>(
          "SELECT t.last_activity_at, r.requested_at FROM semp_threads t JOIN approval_requests r ON r.id = $2 WHERE t.id = $1",
          [threadId, unlinked.details.approvalRequestId],
        ),
      );
      expect(activity.rows).toHaveLength(1);
      expect(activity.rows[0]!.last_activity_at.getTime()).toBe(activity.rows[0]!.requested_at.getTime());
    });

    it("still rejects a reason field inside the operation input as strict-schema ValidationError (issue #1420)", async () => {
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
      const actor: AuthenticatedActor = { userId: randomUUID() };
      await expect(
        gateway.invoke("item.delete", actor, ALL_CAPABILITIES, { itemId: randomUUID(), reason: "x" }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("executes a non-destructive operation immediately for a full agent actor (no approval gate)", async () => {
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
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
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
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
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
      const projectItemId = randomUUID();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "delete a ghost" });
      const actor: AuthenticatedActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };

      await expect(gateway.invoke("item.delete", actor, ALL_CAPABILITIES, { itemId: randomUUID() })).rejects.toThrow(
        NotFoundError,
      );

      await expectNoApprovalOrNotification();
    });

    it("creates no approval_requests row and no notification when the actor's persisted provenance no longer matches (owner_violation)", async () => {
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
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
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
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
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
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
      await chokePoint.createProperty({ databaseId: tasks.id, key: "title", name: "Title", type: "title" });
      const { property: assignedTo } = await chokePoint.createRelationProperty({
        sourceDatabaseId: tasks.id,
        key: "assignedTo",
        name: "Assigned To",
        targetDatabaseId: people.id,
        inverse: { key: "assignedTasks", name: "Assigned Tasks" },
      });
      const { property: reviewedBy } = await chokePoint.createRelationProperty({
        sourceDatabaseId: tasks.id,
        key: "reviewedBy",
        name: "Reviewed By",
        targetDatabaseId: people.id,
        inverse: { key: "reviewedTasks", name: "Reviewed Tasks" },
      });
      const task = await chokePoint.createItem({ databaseId: tasks.id, properties: { title: "Tax return" } });
      const person = await chokePoint.createItem({ databaseId: people.id, properties: {} });
      await chokePoint.createRelation({
        relationPropertyId: assignedTo.id,
        callerItemId: task.id,
        targetItemId: person.id,
      });
      await chokePoint.createRelation({
        relationPropertyId: reviewedBy.id,
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
      await chokePoint.createProperty({ databaseId: tasks.id, key: "title", name: "Title", type: "title" });
      await chokePoint.createProperty({ databaseId: people.id, key: "title", name: "Title", type: "title" });
      const { property: assignedTo } = await chokePoint.createRelationProperty({
        sourceDatabaseId: tasks.id,
        key: "assignedTo",
        name: "Assigned To",
        targetDatabaseId: people.id,
        inverse: { key: "assignedTasks", name: "Assigned Tasks" },
      });
      const task = await chokePoint.createItem({ databaseId: tasks.id, properties: { title: "Tax return" } });
      const person = await chokePoint.createItem({ databaseId: people.id, properties: { title: "Eva" } });
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

    it("retains legacy name and null fallback when no declared title exists", async () => {
      const database = await chokePoint.createDatabase({ name: "Legacy" });
      await chokePoint.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "text" });
      const named = await chokePoint.createItem({ databaseId: database.id, properties: { name: "Legacy name" } });
      const unnamed = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      const actor = await makeActor();
      const namedRequest = await approveDestructive("item.delete", actor, { itemId: named.id });
      const unnamedRequest = await approveDestructive("item.delete", actor, { itemId: unnamed.id });
      expect(await descriptionOf(namedRequest)).toMatchObject({ params: { itemName: "Legacy name" } });
      expect(await descriptionOf(unnamedRequest)).toMatchObject({ params: { itemName: null } });
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

    it("gives every approval the fixed title, and property.delete the no-app-undo sentence", async () => {
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
        body: 'Delete "Mood" from "Journal" (unnamed); 0 items affected. Semp cannot undo this action.',
      });
    });

    it("gives item.delete a body that ends with the undo sentence, because the item goes to the trash", async () => {
      const tasks = await chokePoint.createDatabase({ name: "Tasks" });
      await chokePoint.createProperty({ databaseId: tasks.id, key: "name", name: "Name", type: "text" });
      const task = await chokePoint.createItem({ databaseId: tasks.id, properties: { name: "Tax return" } });
      const actor = await makeActor();

      const requestId = await raiseInEnglish("item.delete", actor, { itemId: task.id });

      expect((await notificationOf(requestId)).body).toBe(
        'Delete "Tax return" from "Tasks" (unnamed); 0 linked items, retained for 30 days. This can be undone later.',
      );
    });

    it("renders an item without a name as the unnamed label, never as a placeholder", async () => {
      const tasks = await chokePoint.createDatabase({ name: "Tasks" });
      const task = await chokePoint.createItem({ databaseId: tasks.id, properties: {} });
      const actor = await makeActor();

      const requestId = await raiseInEnglish("item.delete", actor, { itemId: task.id });

      expect((await notificationOf(requestId)).body).toBe(
        'Delete "unnamed" from "Tasks" (unnamed); 0 linked items, retained for 30 days. This can be undone later.',
      );
    });

    it("gives database.archive an undo sentence and view.delete and relation.delete the no-app-undo one", async () => {
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
      expect((await notificationOf(archiveId)).body).toBe(
        'Archive "Tasks"; 1 items affected. This can be undone later.',
      );

      const viewId = await raiseInEnglish("view.delete", actor, { viewId: view.id });
      expect((await notificationOf(viewId)).body).toBe(
        'Delete view "Open tasks" from "Tasks". Semp cannot undo this action.',
      );

      const relationId = await raiseInEnglish("relation.delete", actor, {
        relationPropertyId: assignedTo.id,
        callerItemId: task.id,
        targetItemId: person.id,
      });
      expect((await notificationOf(relationId)).body).toBe(
        'Remove the link from "Tax return" (unnamed) to "Eva" (unnamed). Semp cannot undo this action.',
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

    it("recounts dependent rollups after approved database.archive replay through the worker", async () => {
      const { projects, tasks, project } = await inTenantZero(async () => {
        const projects = await chokePoint.createDatabase({ name: "Rollup parents" });
        const tasks = await chokePoint.createDatabase({ name: "Rollup source" });
        await chokePoint.createProperty({ databaseId: tasks.id, key: "hours", name: "Hours", type: "number" });
        const { property: relation } = await chokePoint.createRelationProperty({
          sourceDatabaseId: projects.id,
          targetDatabaseId: tasks.id,
          key: "tasks",
          name: "Tasks",
        });
        await chokePoint.createProperty({
          databaseId: projects.id,
          key: "taskCount",
          name: "Count",
          type: "rollup",
          config: { relationPropertyKey: "tasks", aggregation: "count" },
        });
        await chokePoint.createProperty({
          databaseId: projects.id,
          key: "totalHours",
          name: "Sum",
          type: "rollup",
          config: { relationPropertyKey: "tasks", aggregation: "sum", targetPropertyKey: "hours" },
        });
        const project = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
        for (const hours of [3, 4]) {
          const task = await chokePoint.createItem({ databaseId: tasks.id, properties: { hours } });
          await chokePoint.createRelation({
            relationPropertyId: relation.id,
            callerItemId: project.id,
            targetItemId: task.id,
          });
        }
        return { projects, tasks, project };
      });
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
      const drainUntil = async (count: number, sum: number | null) => {
        for (let pass = 0; pass < 10; pass++) {
          await runOnce({ pgPool: pool, taskList });
          const current = await inTenantZero(() => chokePoint.getItem(projects.id, project.id));
          const pending = await Promise.all(
            [
              CORE_TASK_NAMES.ROLLUP_RECOMPUTE,
              CORE_TASK_NAMES.ROLLUP_RECOMPUTE_FULL,
              CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE,
            ].map((name) => countJobsByIdentifier(pool, name)),
          );
          if (
            current?.computed.taskCount === count &&
            current.computed.totalHours === sum &&
            pending.every((n) => n === 0)
          )
            return;
        }
        throw new Error(`Rollup worker did not reach count ${count} and sum ${String(sum)}`);
      };
      await drainUntil(2, 7);
      const actor = await inTenantZero(() => makeAgentActor());
      const requestId = await inTenantZero(() =>
        approveDestructive("database.archive", actor, { databaseId: tasks.id }),
      );
      const { outcome, finished } = await inTenantZero(() => replay(requestId));
      expect(outcome.error).toBe(false);
      expect(finished?.executionStatus).toBe("succeeded");
      expect((await chokePoint.getDatabase(tasks.id))?.archivedAt).not.toBeNull();
      expect(await countJobsByIdentifier(pool, CORE_TASK_NAMES.ROLLUP_RECOMPUTE_FULL)).toBe(2);
      await drainUntil(0, null);
      const current = await inTenantZero(() => chokePoint.getItem(projects.id, project.id));
      expect(current?.computed).toMatchObject({ taskCount: 0, totalHours: null });
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

    it("rejects an approved restore after a same-author edit with the same timestamp", async () => {
      const page = await pageWithFirstBlock();
      const actor = await makeAgentActor();
      const before = await pool.query<{ last_edited_at: Date; last_edited_by: string }>(
        "SELECT last_edited_at, last_edited_by FROM docs WHERE id = $1",
        [page.docId],
      );
      const previous = before.rows[0];
      if (!previous) throw new Error("missing page fixture");
      const requestId = await approveDestructive("page.restoreVersion", actor, {
        itemId: page.itemId,
        at: page.at.toISOString(),
      });
      await createDocStore(pool).putBlock(
        page.itemId,
        { id: "b2", flavour: "paragraph", fields: { content: "second" } },
        "user",
      );
      // Reproduce a timestamp collision independently of wall-clock scheduling.
      await pool.query("UPDATE docs SET last_edited_at = $2, last_edited_by = $3 WHERE id = $1", [
        page.docId,
        previous.last_edited_at,
        previous.last_edited_by,
      ]);
      const { finished } = await replayRequest(requestId);
      expect(finished?.executionStatus).toBe("conflict");
      expect(await blockIdsOf(page.itemId)).toEqual(["b1", "b2"]);
    });

    it("keeps approval identity through real compaction and retention, then detects a later edit", async () => {
      const page = await pageWithFirstBlock();
      const actor = await makeAgentActor();
      const oldBaseline = new Date(page.at.getTime() - 48 * 60 * 60 * 1000);
      await pool.query("UPDATE docs SET history_available_from = $2 WHERE id = $1", [page.docId, oldBaseline]);
      await pool.query(
        "UPDATE doc_snapshot_history SET represented_at = $2 WHERE doc_id = $1 AND through_update_id = 0",
        [page.docId, oldBaseline],
      );
      const oldUpdate = new Date(page.at.getTime() - 36 * 60 * 60 * 1000);
      const ids = await pool.query<{ update_id: string }>(
        "UPDATE doc_history_updates SET created_at = $2 WHERE doc_id = $1 RETURNING update_id::text",
        [page.docId, oldUpdate],
      );
      expect(ids.rows).toHaveLength(1);
      const updateId = ids.rows[0]?.update_id;
      if (!updateId || updateId === "0") throw new Error("missing nonzero history update");
      await pool.query("UPDATE doc_updates SET created_at = $2 WHERE doc_id = $1", [page.docId, oldUpdate]);
      const input = { itemId: page.itemId, at: page.at.toISOString() };
      const requestId = await approveDestructive("page.restoreVersion", actor, input);
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      try {
        await runInTenant(getTenantZeroId(), () => loadYDoc(runtime, page.docId, 1, 1));
        const pending = await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM doc_updates WHERE doc_id = $1",
          [page.docId],
        );
        expect(pending.rows[0]?.count).toBe("0");
        expect(await runInTenant(getTenantZeroId(), () => rebaselineDocHistory(runtime, page.docId, 1))).toBe(true);
        const history = await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM doc_history_updates WHERE doc_id = $1 AND update_id = $2::bigint",
          [page.docId, updateId],
        );
        expect(history.rows[0]?.count).toBe("0");
        const baseline = await pool.query<{ through_update_id: string }>(
          "SELECT through_update_id::text FROM doc_snapshot_history WHERE doc_id = $1 AND expires_at IS NULL",
          [page.docId],
        );
        expect(baseline.rows).toEqual([{ through_update_id: updateId }]);
        const firstRequest = await getApprovalRequest(pool, requestId);
        if (!firstRequest || !isGenericOperationApprovalRequestPayload(firstRequest.payload))
          throw new Error("missing generic approval");
        const firstReplay = { ...firstRequest, payload: firstRequest.payload };
        await runInTenant(getTenantZeroId(), () => replayApprovedGenericOperation(runtime, firstReplay));
        expect((await getApprovalRequest(pool, requestId))?.executionStatus).toBe("succeeded");
        expect(await blockIdsOf(page.itemId)).toEqual(["b1"]);
        const secondRequest = await approveDestructive("page.restoreVersion", actor, input);
        await createDocStore(pool).putBlock(
          page.itemId,
          { id: "b2", flavour: "paragraph", fields: { content: "later" } },
          "user",
        );
        const secondApproval = await getApprovalRequest(pool, secondRequest);
        if (!secondApproval || !isGenericOperationApprovalRequestPayload(secondApproval.payload))
          throw new Error("missing generic approval");
        const secondReplay = { ...secondApproval, payload: secondApproval.payload };
        await runInTenant(getTenantZeroId(), () => replayApprovedGenericOperation(runtime, secondReplay));
        expect((await getApprovalRequest(pool, secondRequest))?.executionStatus).toBe("conflict");
        expect(await blockIdsOf(page.itemId)).toEqual(["b1", "b2"]);
      } finally {
        await runtime.end();
      }
    });

    it("rejects an approval whose snapshot was created before update identity was added", async () => {
      const page = await pageWithFirstBlock();
      const actor = await makeAgentActor();
      const input = { itemId: page.itemId, at: page.at.toISOString() };
      const requestId = await approveDestructive("page.restoreVersion", actor, input);
      const projection = await withTransaction(pool, (client) =>
        computePageRestoreProjection(client, { operation: "page.restoreVersion", input }),
      );
      const current = projection.currentResource;
      if (typeof current !== "object" || current === null || !("updateVersion" in current)) {
        throw new Error("missing update version in current projection");
      }
      const legacy = Object.fromEntries(Object.entries(current).filter(([key]) => key !== "updateVersion"));
      const sha256 = createHash("sha256").update(canonicalizeJson(legacy), "utf8").digest("hex");
      const changed = await pool.query(
        `UPDATE approval_requests SET resource_snapshot = jsonb_set(resource_snapshot, '{sha256}', to_jsonb($2::text)),
         payload = jsonb_set(payload, '{resourceSnapshot,sha256}', to_jsonb($2::text)) WHERE id = $1`,
        [requestId, sha256],
      );
      expect(changed.rowCount).toBe(1);
      const { finished } = await replayRequest(requestId);
      expect(finished?.executionStatus).toBe("conflict");
      expect(await blockIdsOf(page.itemId)).toEqual(["b1"]);
    });

    it("rejects replay after an edit from an earlier-started transaction", async () => {
      const page = await pageWithFirstBlock();
      const actor = await makeAgentActor();
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      let release!: () => void;
      let signal!: (at: Date) => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<Date>((resolve) => {
        signal = resolve;
      });
      const originals = new Map<PoolClient, PoolClient["query"]>();
      const instrument = (client: PoolClient) => {
        if (originals.has(client)) return;
        // The proxy forwards the original receiver and the method is restored before the pool closes.
        /* eslint-disable @typescript-eslint/unbound-method */
        originals.set(client, client.query);
        client.query = new Proxy(client.query, {
          apply(target, receiver, args: unknown[]) {
            const result: unknown = Reflect.apply(target, receiver, args);
            if (args[0] !== "BEGIN") return result;
            return Promise.resolve(result).then(async (value: unknown) => {
              const at = (await client.query<{ at: Date }>("SELECT transaction_timestamp() AS at")).rows[0]?.at;
              if (!at) throw new Error("missing transaction timestamp");
              signal(at);
              await hold;
              return value;
            });
          },
        });
        /* eslint-enable @typescript-eslint/unbound-method */
      };
      runtime.on("acquire", instrument);
      const writer = runInTenant(getTenantZeroId(), () =>
        mutateYDoc(runtime, page.docId, "user", (doc) => {
          doc.getMap("approval-test").set("edit", "later");
        }),
      );
      const settled = Promise.allSettled([writer]);
      try {
        const at = await Promise.race([
          started,
          writer.then(() => {
            throw new Error("writer ended before barrier");
          }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("barrier timed out")), 5000)),
        ]);
        // Force the existing timestamp and author to collide with the transaction's real timestamp.
        await pool.query("UPDATE docs SET last_edited_at = $2, last_edited_by = 'user' WHERE id = $1", [
          page.docId,
          at,
        ]);
        const requestId = await approveDestructive("page.restoreVersion", actor, {
          itemId: page.itemId,
          at: page.at.toISOString(),
        });
        release();
        await writer;
        const after = (
          await pool.query<{ at: Date; author: string }>(
            "SELECT last_edited_at AS at, last_edited_by AS author FROM docs WHERE id = $1",
            [page.docId],
          )
        ).rows[0];
        expect(after).toEqual({ at, author: "user" });
        const { finished } = await replayRequest(requestId);
        expect(finished?.executionStatus).toBe("conflict");
      } finally {
        release();
        await settled;
        runtime.off("acquire", instrument);
        for (const [client, original] of originals) client.query = original;
        await runtime.end();
      }
    }, 15000);

    it.each(["replay-first", "delete-first"] as const)(
      "coordinates actual approved replay and deletion with %s",
      async (order) => {
        const page = await pageWithFirstBlock();
        const actor = await makeAgentActor();
        const requestId = await approveDestructive("page.restoreVersion", actor, {
          itemId: page.itemId,
          at: page.at.toISOString(),
        });
        const request = (await getApprovalRequest(pool, requestId)) as ApprovalRequest & {
          payload: GenericOperationApprovalRequestPayload;
        };
        const databaseId = (
          await pool.query<{ database_id: string }>("SELECT database_id FROM items WHERE id = $1", [page.itemId])
        ).rows[0]?.database_id;
        if (!databaseId) throw new Error("missing page database");
        const replayPool = await createRuntimeRolePool(pool, "semprec_data");
        const deletePool = await createRuntimeRolePool(pool, "semprec_data");
        let release!: () => void;
        let signal!: (pid: number) => void;
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        const ready = new Promise<number>((resolve) => {
          signal = resolve;
        });
        const originals = new Map<PoolClient, PoolClient["query"]>();
        const instrument = (client: PoolClient) => {
          if (originals.has(client)) return;
          // The proxy forwards the receiver and is removed before the pool closes.
          /* eslint-disable @typescript-eslint/unbound-method */
          originals.set(client, client.query);
          client.query = new Proxy(client.query, {
            apply(target, receiver, args: unknown[]) {
              const result: unknown = Reflect.apply(target, receiver, args);
              if (typeof args[0] !== "string" || !args[0].startsWith("UPDATE items SET deleted_at = now()"))
                return result;
              return Promise.resolve(result).then(async (value: unknown) => {
                const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
                if (pid === undefined) throw new Error("missing deletion pid");
                signal(pid);
                await hold;
                return value;
              });
            },
          });
          /* eslint-enable @typescript-eslint/unbound-method */
        };
        let holder: Promise<unknown> | undefined;
        if (order === "replay-first") {
          holder = withTransaction(pool, async (client) => {
            const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
            if (pid === undefined) throw new Error("missing document holder pid");
            await client.query("SELECT doc_id FROM doc_snapshots WHERE doc_id = $1 FOR UPDATE", [page.docId]);
            signal(pid);
            await hold;
          });
        } else deletePool.on("acquire", instrument);
        const settledHolder = holder ? Promise.allSettled([holder]) : undefined;
        const doReplay = () =>
          runInTenant(getTenantZeroId(), () => replayApprovedGenericOperation(replayPool, request));
        const doDelete = () =>
          runInTenant(getTenantZeroId(), () => createChokePoint(deletePool).softDeleteItem(databaseId, page.itemId));
        let replay: ReturnType<typeof doReplay> | undefined;
        let deletion: ReturnType<typeof doDelete> | undefined;
        let replaySettled: Promise<PromiseSettledResult<Awaited<ReturnType<typeof doReplay>>>[]> | undefined;
        let deleteSettled: Promise<PromiseSettledResult<Awaited<ReturnType<typeof doDelete>>>[]> | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (order === "delete-first") {
            deletion = doDelete();
            deleteSettled = Promise.allSettled([deletion]);
          }
          const ownerPid = await Promise.race([
            ready,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("barrier timed out")), 5000);
            }),
          ]);
          replay = doReplay();
          replaySettled = Promise.allSettled([replay]);
          let waitingPid: number | undefined;
          for (let i = 0; i < 100 && waitingPid === undefined; i++) {
            waitingPid = (
              await pool.query<{ pid: number }>(
                "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
                [ownerPid],
              )
            ).rows[0]?.pid;
            if (waitingPid === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
          }
          expect(waitingPid).toBeDefined();
          if (order === "replay-first") {
            deletion = doDelete();
            deleteSettled = Promise.allSettled([deletion]);
            let blocked = false;
            for (let i = 0; i < 100 && !blocked; i++) {
              blocked =
                (
                  await pool.query<{ blocked: boolean }>(
                    "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked",
                    [waitingPid],
                  )
                ).rows[0]?.blocked === true;
              if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
            }
            expect(blocked).toBe(true);
          }
          release();
          await replay;
          await deletion;
          expect((await getApprovalRequest(pool, requestId))?.executionStatus).toBe(
            order === "replay-first" ? "succeeded" : "conflict",
          );
        } finally {
          release();
          if (timer) clearTimeout(timer);
          if (settledHolder !== undefined) await settledHolder;
          if (replaySettled !== undefined) await replaySettled;
          if (deleteSettled !== undefined) await deleteSettled;
          deletePool.off("acquire", instrument);
          for (const [client, original] of originals) client.query = original;
          await Promise.all([replayPool.end(), deletePool.end()]);
        }
      },
      15000,
    );

    it("refuses a request for an unknown page without queuing an approval", async () => {
      const actor = await makeAgentActor();
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);

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
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
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
        await createGenericOperationGateway(runtimePool, testMetadataResolver).invoke(
          "item.delete",
          actor,
          ALL_CAPABILITIES,
          {
            itemId: item.id,
          },
        );
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

  it("refuses a foreign destructive target like a missing target without approval side effects", async () => {
    const tenantA = getTenantZeroId();
    const tenantB = await runInTenant(tenantA, () => createTestTenant(pool));
    await runInTenant(tenantA, () =>
      createBoundUser(pool, { email: "foreign-a@example.test", passwordHash: "x", tenantId: tenantA }),
    );
    await runInTenant(tenantB, () =>
      createBoundUser(pool, { email: "foreign-b@example.test", passwordHash: "x", tenantId: tenantB }),
    );
    const foreign = await runInTenant(tenantA, async () => {
      const cp = createChokePoint(runtimePool);
      const db = await cp.createDatabase({ name: "Foreign" });
      return cp.createItem({ databaseId: db.id, properties: {} });
    });
    const run = await runInTenant(tenantB, () =>
      createAgentRun(runtimePool, { projectItemId: randomUUID(), triggeredBy: "user", task: "delete" }),
    );
    const actor: AuthenticatedActor = {
      userId: run.actorUserId,
      runId: run.id,
      agentProjectItemId: run.projectItemId!,
    };
    const snapshot = async () =>
      (
        await pool.query<{ requests: string; notifications: string; item: unknown }>(
          "SELECT (SELECT count(*)::text FROM approval_requests) requests, (SELECT count(*)::text FROM notifications) notifications, (SELECT to_jsonb(i) FROM items i WHERE id = $1) item",
          [foreign.id],
        )
      ).rows[0];
    const before = await snapshot();
    expect(before?.item).toBeTruthy();
    const invoke = (itemId: string) =>
      runInTenant(tenantB, () =>
        createGenericOperationGateway(runtimePool, testMetadataResolver)
          .invoke("item.delete", actor, ALL_CAPABILITIES, { itemId })
          .then(
            () => {
              throw new Error("unexpected approval");
            },
            (error: unknown) => error,
          ),
      );
    const foreignError = await invoke(foreign.id);
    const missingId = randomUUID();
    const missingError = await invoke(missingId);
    expect(foreignError).toBeInstanceOf(Error);
    expect(missingError).toBeInstanceOf(Error);
    if (!(foreignError instanceof Error) || !(missingError instanceof Error)) throw new Error("Expected refusal");
    expect(foreignError.name).toBe(missingError.name);
    expect(foreignError.message.replace(foreign.id, "<id>")).toBe(missingError.message.replace(missingId, "<id>"));
    expect(await snapshot()).toEqual(before);
  });

  it("defers an owned patch but refuses foreign and random targets identically under the runtime role", async () => {
    const tenantA = getTenantZeroId();
    const tenantB = await createTestTenant(pool);
    await runInTenant(tenantA, () =>
      createBoundUser(pool, { email: "patch-a@example.test", passwordHash: "x", tenantId: tenantA }),
    );
    await runInTenant(tenantB, () =>
      createBoundUser(pool, { email: "patch-b@example.test", passwordHash: "x", tenantId: tenantB }),
    );
    const makeItem = (tenantId: string) =>
      runInTenant(tenantId, async () => {
        const cp = createChokePoint(runtimePool);
        const db = await cp.createDatabase({ name: "Scoped patches" });
        await cp.createProperty({ databaseId: db.id, key: "note", name: "Note", type: "text" });
        return cp.createItem({ databaseId: db.id, properties: { note: "before" } });
      });
    const foreign = await makeItem(tenantA);
    const own = await makeItem(tenantB);
    const run = await runInTenant(tenantB, () =>
      createAgentRun(runtimePool, { projectItemId: randomUUID(), triggeredBy: "user", task: "patch" }),
    );
    if (!run.projectItemId) throw new Error("Missing project id");
    const actor: AuthenticatedActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: run.projectItemId };
    const gateway = createGenericOperationGateway(runtimePool, testMetadataResolver);
    let active = true;
    registerItemUpdateHook(async ({ client, item, writer }) => {
      if (active && item.id === own.id) requireApprovalForWrite(client, writer, [{ kind: "testReason" }]);
    });
    try {
      const invoke = (itemId: string) =>
        runInTenant(tenantB, () =>
          gateway.invoke("item.patch", actor, ALL_CAPABILITIES, {
            itemId,
            properties: { note: "after" },
            ifVersion: own.updatedAt,
          }),
        );
      const missing = randomUUID();
      const errors: Error[] = [];
      for (const id of [foreign.id, missing]) {
        try {
          await invoke(id);
          throw new Error("Expected refusal");
        } catch (err) {
          if (!(err instanceof NotFoundError)) throw err;
          errors.push(err);
        }
      }
      expect(errors[0]?.message.replace(foreign.id, "<id>")).toBe(errors[1]?.message.replace(missing, "<id>"));
      const count = () =>
        runInTenant(tenantB, () =>
          runtimePool.query<{ count: string }>("SELECT count(*)::text AS count FROM approval_requests"),
        );
      expect((await count()).rows[0]?.count).toBe("0");
      await expect(invoke(own.id)).rejects.toBeInstanceOf(ApprovalRequiredError);
      expect((await count()).rows[0]?.count).toBe("1");
      expect(
        (await runInTenant(tenantA, () => createChokePoint(runtimePool).findItem(foreign.id)))?.properties.note,
      ).toBe("before");
      expect((await runInTenant(tenantB, () => createChokePoint(runtimePool).findItem(own.id)))?.properties.note).toBe(
        "before",
      );
    } finally {
      active = false;
    }
  });
});
