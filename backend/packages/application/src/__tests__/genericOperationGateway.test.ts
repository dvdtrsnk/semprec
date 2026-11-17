import type { CollectionMetadataResolver } from "@semprec/data";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  createTestTenant,
  getOrCreateTickThread,
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
  CORE_AGENT_RUN_ACTION_ID,
  ValueLinkBusyError,
  VALUE_LINKS_OWNER_PROCESS,
  createRelationWithClient,
  requireApprovalForWrite,
  setInvalidationHook,
  setSempThreadInvalidationHook,
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
  createHeartbeat,
  createSempChatThread,
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
  type AgentRunRow,
  type ApprovalRequest,
  type ChokePoint,
  type GenericOperationApprovalRequestPayload,
} from "@semprec/data";
import {
  CAPABILITY_IDS,
  canonicalizeJson,
  GENERIC_OPERATION_NAMES,
  OPERATION_METADATA,
  REST_ONLY_OPERATION_NAMES,
  runInTenant,
  runAsSystem,
  type AuthenticatedActor,
  type GenericOperationName,
} from "@semprec/shared";
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

let pool: Pool;
let chokePoint: ChokePoint;

const ALL_CAPABILITIES = new Set(CAPABILITY_IDS);
const NO_CAPABILITIES = new Set<(typeof CAPABILITY_IDS)[number]>();
const COUNT_REQUESTS = "SELECT count(*)::int AS count FROM approval_requests";
const COUNT_NOTIFICATIONS = "SELECT count(*)::int AS count FROM notifications";

type GenericRequest = ApprovalRequest & { payload: GenericOperationApprovalRequestPayload };
type RelationHookContext = Parameters<Parameters<typeof registerRelationEdgeWriteHook>[0]>[0];
type ItemHookContext = Parameters<Parameters<typeof registerItemUpdateHook>[0]>[0];
type Decision = Parameters<typeof decideAndEnqueueApprovalRequest>[1]["decision"];

// Write hooks cannot be unregistered, so each test's hook acts only until the `afterEach` below clears its flag.
const hookFlags: Array<{ active: boolean }> = [];

afterEach(() => {
  for (const flag of hookFlags.splice(0)) flag.active = false;
  setInvalidationHook(() => {});
});

/** Requires approval for every write to `propertyId`'s edges; `observe` runs first, for every writer. */
function gateRelationWrites(propertyId: string, observe?: (context: RelationHookContext) => Promise<void> | void) {
  const flag = { active: true };
  hookFlags.push(flag);
  registerRelationEdgeWriteHook(async (context) => {
    if (!flag.active || context.edgeContext.property.id !== propertyId) return;
    await observe?.(context);
    requireApprovalForWrite(context.client, context.writer, [{ kind: "testReason" }]);
  });
}

/** Requires approval for every update of `itemId`; `observe` runs first, for every writer. */
function gateItemUpdates(itemId: string, observe?: (context: ItemHookContext) => Promise<void> | void) {
  const flag = { active: true };
  hookFlags.push(flag);
  registerItemUpdateHook(async (context) => {
    if (!flag.active || context.item.id !== itemId) return;
    await observe?.(context);
    requireApprovalForWrite(context.client, context.writer, [{ kind: "testReason" }]);
  });
}

function captureInvalidations(): unknown[] {
  const events: unknown[] = [];
  setInvalidationHook((event) => events.push(event));
  return events;
}

function signal<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}

/** Waits for `barrier`, failing if `work` ends first. */
function reachBarrier(barrier: Promise<unknown>, work: Promise<unknown>, label: string): Promise<unknown> {
  return Promise.race([
    barrier,
    work.then(() => {
      throw new Error(`${label} ended before its barrier`);
    }),
  ]);
}

/** Settles `pending`, then rethrows the primary failure and every distinct rejection, aggregated when several. */
async function throwFailures(failure: { error: unknown } | undefined, pending: Promise<unknown>[]): Promise<void> {
  const errors: unknown[] = failure ? [failure.error] : [];
  for (const result of await Promise.allSettled(pending)) {
    if (result.status === "rejected" && !errors.includes(result.reason)) errors.push(result.reason);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Test and cleanup failed");
}

async function withRuntimePool(fn: (runtime: Pool) => Promise<void>): Promise<void> {
  const runtime = await createRuntimeRolePool(pool, "semprec_data");
  let failure: { error: unknown } | undefined;
  try {
    await fn(runtime);
  } catch (error) {
    failure = { error };
  }
  await throwFailures(failure, [runtime.end()]);
}

/** Wraps `target` so each checked-out client runs `connect` and every `query` goes through `query`. */
function interceptPool(
  target: Pool,
  hooks: {
    connect?: (client: PoolClient) => Promise<void>;
    query?: (client: PoolClient, args: unknown[], next: () => Promise<unknown>) => Promise<unknown>;
  },
): Pool {
  const bound = (object: object, key: string | symbol, receiver: unknown): unknown => {
    const value: unknown = Reflect.get(object, key, receiver);
    return typeof value === "function" ? value.bind(object) : value;
  };
  return new Proxy(target, {
    get(original, key, receiver) {
      if (key !== "connect") return bound(original, key, receiver);
      return async () => {
        const client = await original.connect();
        await hooks.connect?.(client);
        const query = hooks.query;
        if (!query) return client;
        return new Proxy(client, {
          get(inner, field, innerReceiver) {
            if (field !== "query") return bound(inner, field, innerReceiver);
            return (...args: unknown[]) =>
              query(inner, args, async () => {
                const result: unknown = await Reflect.apply(inner.query.bind(inner), inner, args);
                return result;
              });
          },
        });
      };
    },
  });
}

/** Runs `onMatch` after every query whose text `matches` on clients `target` hands out; returns the restore. */
function afterMatchingQuery(
  target: Pool,
  matches: (text: unknown) => boolean,
  onMatch: (client: PoolClient) => Promise<void>,
): () => void {
  const originals = new Map<PoolClient, PoolClient["query"]>();
  const instrument = (client: PoolClient) => {
    if (originals.has(client)) return;
    // The proxy forwards the original receiver, and the restore puts the method back before the pool closes.
    /* eslint-disable @typescript-eslint/unbound-method */
    originals.set(client, client.query);
    client.query = new Proxy(client.query, {
      apply(method, receiver, args: unknown[]) {
        const result: unknown = Reflect.apply(method, receiver, args);
        if (!matches(args[0])) return result;
        return Promise.resolve(result).then(async (value: unknown) => {
          await onMatch(client);
          return value;
        });
      },
    });
    /* eslint-enable @typescript-eslint/unbound-method */
  };
  target.on("acquire", instrument);
  return () => {
    target.off("acquire", instrument);
    for (const [client, original] of originals) client.query = original;
  };
}

async function backendPid(client: PoolClient): Promise<number> {
  return (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
}

/** Waits until the backend `contenderPid()` names is blocked by `holderPid`. */
async function expectBlockedBy(contenderPid: () => number, holderPid: number): Promise<void> {
  await vi.waitFor(async () => {
    expect(contenderPid()).toBeGreaterThan(0);
    const { rows } = await pool.query<{ pids: number[] }>("SELECT pg_blocking_pids($1) AS pids", [contenderPid()]);
    expect(rows[0]?.pids).toContain(holderPid);
  });
}

async function countOf(sql: string, params: unknown[] = [], db: Pool = pool): Promise<number> {
  return (await db.query<{ count: number }>(sql, params)).rows[0]?.count ?? 0;
}

async function jobRows() {
  return (await pool.query<{ id: string; key: string | null }>("SELECT id, key FROM graphile_worker.jobs ORDER BY id"))
    .rows;
}

async function threadMessages(threadId: string): Promise<string[]> {
  const { rows } = await pool.query<{ system_key: string }>(
    "SELECT system_key FROM semp_messages WHERE thread_id = $1 ORDER BY created_at, id",
    [threadId],
  );
  return rows.map((row) => row.system_key);
}

async function createUser(): Promise<string> {
  return (await createTenantZeroUser(pool)).id;
}

function chatThread(): Promise<string> {
  return withTransaction(pool, (client) => createSempChatThread(client));
}

/** A real Projects item id: `viewDeleteWithClient` enforces `assertAuthenticatedAgentIdentity`, the other destructive mutations do not. */
async function createRealAgentProjectItemId(): Promise<string> {
  const projectsDatabase = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects"));
  const item = await createChokePoint(pool).createItem({ databaseId: projectsDatabase!.id, properties: {} });
  return item.id;
}

async function agentActor(options: { db?: Pool; threadId?: string; realProject?: boolean } = {}) {
  const projectItemId = options.realProject ? await createRealAgentProjectItemId() : randomUUID();
  const run = await createAgentRun(options.db ?? pool, {
    projectItemId,
    triggeredBy: "user",
    task: "agent task",
    ...(options.threadId ? { threadId: options.threadId } : {}),
  });
  const actor: AuthenticatedActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
  return { run, projectItemId, actor };
}

/** The announcements of a request that reached a terminal state or was raised: the request, the badge and the run. */
function requestAnnouncements(approvalRequestId: unknown, run: AgentRunRow, projectItemId: string) {
  return [
    { scope: "approvalRequest", approvalRequestId, userId: run.actorUserId },
    { scope: "badgeCounts", userId: run.actorUserId },
    { scope: "agentRuns", projectItemId, agentRunId: run.id, userId: run.actorUserId },
  ];
}

function gatewayFor(db: Pool = pool) {
  return createGenericOperationGateway(db, testMetadataResolver);
}

/** Invokes an approval-gated operation and returns the id of the request it raised. */
async function requestApproval(
  operation: GenericOperationName,
  actor: AuthenticatedActor,
  input: unknown,
  { db = pool, ...options }: { db?: Pool; reason?: string; toolCallId?: string } = {},
): Promise<string> {
  try {
    await gatewayFor(db).invoke(operation, actor, ALL_CAPABILITIES, input, options);
  } catch (error) {
    if (error instanceof ApprovalRequiredError) return error.details.approvalRequestId;
    throw error;
  }
  throw new Error(`Expected ${operation} to require approval`);
}

function decide(
  approvalRequestId: string,
  decidedByUserId: string,
  { db = pool, decision = "approved" }: { db?: Pool; decision?: Decision } = {},
) {
  return inTenantZero(() =>
    withTransaction(db, (client) =>
      decideAndEnqueueApprovalRequest(client, { approvalRequestId, decision, decidedByUserId }),
    ),
  );
}

async function loadGeneric(requestId: string, db: Pool = pool): Promise<GenericRequest> {
  const request = await getApprovalRequest(db, requestId);
  if (!request || !isGenericOperationApprovalRequestPayload(request.payload)) {
    throw new Error("Expected a generic-operation approval request");
  }
  return { ...request, payload: request.payload };
}

/** Raises a request for `operation` and approves it as the actor's owner. */
async function approveAgentRequest(
  operation: GenericOperationName,
  actor: AuthenticatedActor,
  input: unknown,
  db: Pool = pool,
): Promise<string> {
  const requestId = await requestApproval(operation, actor, input, { db });
  await decide(requestId, actor.userId, { db });
  return requestId;
}

async function replayById(requestId: string, db: Pool = pool) {
  return replayApprovedGenericOperation(db, await loadGeneric(requestId, db));
}

async function statusOf(requestId: string, db: Pool = pool) {
  return (await getApprovalRequest(db, requestId))?.executionStatus;
}

async function relationFixture(
  cp: ChokePoint,
  options: Pick<Parameters<ChokePoint["createRelationProperty"]>[0], "cardinality" | "inverse"> & {
    name?: string;
  } = {},
) {
  const { name = "Relation", ...relation } = options;
  const source = await cp.createDatabase({ name: `${name} source` });
  const target = await cp.createDatabase({ name: `${name} target` });
  const pair = await cp.createRelationProperty({
    sourceDatabaseId: source.id,
    targetDatabaseId: target.id,
    key: "target",
    name: "Target",
    ...relation,
  });
  const caller = await cp.createItem({ databaseId: source.id, properties: {} });
  const first = await cp.createItem({ databaseId: target.id, properties: {} });
  const second = await cp.createItem({ databaseId: target.id, properties: {} });
  const third = await cp.createItem({ databaseId: target.id, properties: {} });
  return {
    source,
    target,
    property: pair.property,
    inverseProperty: pair.inverseProperty,
    caller,
    first,
    second,
    third,
  };
}

function addTargetCount(cp: ChokePoint, databaseId: string) {
  return cp.createProperty({
    databaseId,
    key: "targetCount",
    name: "Target count",
    type: "rollup",
    config: { relationPropertyKey: "target", aggregation: "count" },
  });
}

function coreTaskList(genericOperationApprovalReplay?: typeof replayApprovedGenericOperation) {
  // Only the trailing `genericOperationApprovalReplay` parameter matters to these tests.
  return createCoreTaskList(
    pool,
    new Map(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    genericOperationApprovalReplay,
  );
}

async function expectNoApprovalOrNotification(): Promise<void> {
  expect(await countOf(COUNT_REQUESTS)).toBe(0);
  expect(await countOf(COUNT_NOTIFICATIONS)).toBe(0);
}

describe("createGenericOperationGateway", () => {
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
      const { source, property, caller, first, second, third } = await relationFixture(chokePoint, {
        cardinality: "one_to_one",
      });
      const original = await chokePoint.setRelation({
        relationPropertyId: property.id,
        callerItemId: caller.id,
        targetItemId: first.id,
      });
      if (!original) throw new Error("Expected initial relation");
      await addTargetCount(chokePoint, source.id);
      await withTransaction(pool, (client) =>
        insertValueLink(client, { itemId: caller.id, propertyKey: "target", ruleKey: "test", sources: [] }),
      );
      const threadId = await chatThread();
      const { run, projectItemId, actor } = await agentActor({ threadId });
      const seen: Array<{ writerKind: string; approvedRequestId?: string }> = [];
      const mutationError = new ValidationError("forced mutation failure");
      let failMutation = false;
      let sawDeleted = false;
      let sawMutationJob = false;
      let jobCount = 0;
      gateRelationWrites(property.id, async ({ client, writer }) => {
        seen.push({ writerKind: writer.writerKind, approvedRequestId: writer.approvedRequestId });
        if (!failMutation || !writer.approvedRequestId) return;
        const edges = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM item_relations WHERE id = $1",
          [original.id],
        );
        sawDeleted = edges.rows[0]?.count === 0;
        const jobs = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM graphile_worker.jobs WHERE task_identifier = $1",
          [CORE_TASK_NAMES.ROLLUP_RECOMPUTE],
        );
        sawMutationJob = (jobs.rows[0]?.count ?? 0) > jobCount;
        throw mutationError;
      });
      const targetsOf = async () =>
        (await chokePoint.listItemRelations(caller.id, property.id))?.map((edge) => edge.targetItemId);
      const rollupJobs = () => countJobsByIdentifier(pool, CORE_TASK_NAMES.ROLLUP_RECOMPUTE);
      const input = { relationPropertyId: property.id.toUpperCase(), callerItemId: caller.id, targetItemId: second.id };
      const requestId = await requestApproval("relation.set", actor, input);
      expect(await targetsOf()).toEqual([first.id]);
      const pending = await getApprovalRequest(pool, requestId);
      // The active link on the replaced relation makes this a `breaksLink` request.
      expect(pending).toMatchObject({
        riskClass: "breaksLink",
        description: {
          key: "approval.breaksLink",
          params: { propertyName: "Target" },
          breaksLinks: [{ itemId: caller.id, propertyKey: "target" }],
        },
      });
      expect(JSON.stringify(pending?.description)).not.toContain(second.id);
      await decide(requestId, run.actorUserId);
      const typed = await loadGeneric(requestId);
      const baselineActivity = new Date("2020-01-01T00:00:00.000Z");
      await pool.query("UPDATE semp_threads SET last_activity_at = $2 WHERE id = $1", [threadId, baselineActivity]);
      const lastActivity = async () =>
        (await pool.query<{ at: Date }>("SELECT last_activity_at AS at FROM semp_threads WHERE id = $1", [threadId]))
          .rows[0]?.at;
      jobCount = await rollupJobs();
      const delivered = captureInvalidations();
      /** Asserts the failed replay left the relation, its link, the jobs, the request and the thread untouched. */
      const expectRolledBack = async () => {
        expect(await targetsOf()).toEqual([first.id]);
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
        expect(await rollupJobs()).toBe(jobCount);
        expect(delivered).toEqual([]);
        expect(await getApprovalRequest(pool, requestId)).toMatchObject({
          status: "approved",
          executionStatus: "queued",
          executionResult: null,
        });
        expect(await threadMessages(threadId)).toEqual([]);
        expect(await lastActivity()).toEqual(baselineActivity);
      };

      failMutation = true;
      await expect(replayApprovedGenericOperation(pool, typed)).rejects.toBe(mutationError);
      expect(sawDeleted).toBe(true);
      expect(sawMutationJob).toBe(true);
      await expectRolledBack();

      failMutation = false;
      const outcomeError = new Error("forced outcome rollback");
      let sawOutcome = false;
      const failAfterOutcomePool = interceptPool(pool, {
        query: async (client, args, next) => {
          const result = await next();
          if (typeof args[0] !== "string" || !args[0].includes("UPDATE semp_threads SET last_activity_at"))
            return result;
          const inserted = await client.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM semp_messages WHERE thread_id = $1",
            [threadId],
          );
          const activity = await client.query<{ at: Date }>(
            "SELECT last_activity_at AS at FROM semp_threads WHERE id = $1",
            [threadId],
          );
          sawOutcome =
            inserted.rows[0]?.count === 1 && (activity.rows[0]?.at.getTime() ?? 0) > baselineActivity.getTime();
          throw outcomeError;
        },
      });
      await expect(replayApprovedGenericOperation(failAfterOutcomePool, typed)).rejects.toBe(outcomeError);
      expect(sawOutcome).toBe(true);
      await expectRolledBack();

      expect((await replayApprovedGenericOperation(pool, typed)).error).toBe(false);
      expect((await replayApprovedGenericOperation(pool, typed)).error).toBe(false);
      expect(delivered).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ scope: "item", itemId: caller.id }),
          expect.objectContaining({ scope: "relation", itemId: caller.id }),
        ]),
      );
      const afterSuccess = [...delivered];
      expect(await threadMessages(threadId)).toEqual(["approval.outcome.executed"]);
      expect(await targetsOf()).toEqual([second.id]);
      // The first call never reached the hook: the replaced link asked for approval before any edge guard ran.
      expect(seen).toEqual(Array(3).fill({ writerKind: "agent", approvedRequestId: requestId }));
      await expect(
        gatewayFor().invoke("relation.set", actor, ALL_CAPABILITIES, { ...input, targetItemId: third.id }),
      ).rejects.toBeInstanceOf(ApprovalRequiredError);
      // Raising the next request announces the request and changes no item or relation.
      expect(delivered).toEqual([...afterSuccess, ...requestAnnouncements(expect.any(String), run, projectItemId)]);
      expect(await targetsOf()).toEqual([second.id]);
    }));

  it.each(["insert", "upsert", "metadata", "delete"] as const)(
    "reserves relation snapshots against ordinary inverse %s in both orders",
    async (kind) => {
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      const cp = createChokePoint(runtime);
      const foreignTenant = await createTestTenant(pool);
      const foreign = await runInTenant(foreignTenant, () => relationFixture(cp, { name: "Foreign" }));
      const foreignStart = signal<boolean>();
      const foreignWork = (async () => {
        if (!(await foreignStart.promise)) return;
        await runInTenant(foreignTenant, () =>
          cp.createRelation({
            relationPropertyId: foreign.property.id,
            callerItemId: foreign.caller.id,
            targetItemId: foreign.first.id,
          }),
        );
      })();
      return inTenantZero(async () => {
        let pauseApproval = false;
        let approvalPid = 0;
        const atApproval = signal();
        const approvalGate = signal();
        try {
          const { source, target, property, inverseProperty, caller, first, second } = await relationFixture(cp, {
            name: "Reservation",
            cardinality: "many_to_many",
            inverse: { key: "sources", name: "Sources" },
          });
          if (!inverseProperty) throw new Error("Expected inverse property");
          const { property: unrelated } = await cp.createRelationProperty({
            sourceDatabaseId: source.id,
            targetDatabaseId: target.id,
            key: "unrelated",
            name: "Unrelated",
          });
          const original = await cp.createRelation({
            relationPropertyId: property.id,
            callerItemId: caller.id,
            targetItemId: first.id,
            metadata: { version: "original" },
          });
          await addTargetCount(cp, source.id);
          const threadId = await chatThread();
          const { actor } = await agentActor({ db: runtime, threadId });
          gateRelationWrites(property.id, async ({ client, writer }) => {
            if (!pauseApproval || !writer.approvedRequestId) return;
            approvalPid = await backendPid(client);
            atApproval.resolve();
            await approvalGate.promise;
          });
          const putInput = { relationPropertyId: property.id, callerItemId: caller.id, targetItemId: first.id };
          const approvedPut = async () =>
            loadGeneric(
              await approveAgentRequest(
                "relation.put",
                actor,
                { ...putInput, metadata: { version: "approved" } },
                runtime,
              ),
              runtime,
            );
          const input = {
            relationPropertyId: inverseProperty.id,
            callerItemId: kind === "insert" ? second.id : first.id,
            targetItemId: caller.id,
          };
          const ordinary = (handle: ChokePoint) =>
            kind === "insert" || kind === "upsert"
              ? handle.createRelation({ ...input, metadata: { version: "normal" } })
              : kind === "metadata"
                ? handle.updateRelation({ ...input, metadata: { version: "normal" } })
                : handle.deleteRelation(input);
          const rollupJobs = () => countJobsByIdentifier(pool, CORE_TASK_NAMES.ROLLUP_RECOMPUTE);
          let protectedPid = 0;
          const upsertProtected = () =>
            withTransaction(runtime, async (client) => {
              protectedPid = await backendPid(client);
              return createRelationWithClient(
                client,
                { ...putInput, targetItemId: second.id },
                { ownerProcess: VALUE_LINKS_OWNER_PROCESS },
              );
            });

          const firstRequest = await approvedPut();
          const baselineJobs = await rollupJobs();
          const delivered = captureInvalidations();
          let normalPid = 0;
          const atCommit = signal();
          const commitGate = signal();
          const heldPool = interceptPool(runtime, {
            connect: async (client) => {
              normalPid = await backendPid(client);
            },
            query: async (_client, args, next) => {
              if (args[0] === "COMMIT") {
                atCommit.resolve();
                await commitGate.promise;
              }
              return next();
            },
          });
          let replayPid = 0;
          const observedReplayPool = interceptPool(runtime, {
            connect: async (client) => {
              replayPid = await backendPid(client);
            },
          });

          // Ordinary writer first: the approved replay finds the resource busy and changes nothing.
          const normalFirst = ordinary(createChokePoint(heldPool));
          let normalFailure: { error: unknown } | undefined;
          try {
            await reachBarrier(atCommit.promise, normalFirst, "Ordinary writer");
            expect(normalPid).toBeGreaterThan(0);
            if (kind === "insert") {
              const before = await countOf(COUNT_REQUESTS, [], runtime);
              await expect(
                gatewayFor(runtime).invoke("relation.put", actor, ALL_CAPABILITIES, putInput),
              ).rejects.toBeInstanceOf(ApprovalResourceBusyError);
              expect(await countOf(COUNT_REQUESTS, [], runtime)).toBe(before);
            }
            const busy = await replayApprovedGenericOperation(observedReplayPool, firstRequest).then(
              () => undefined,
              (error: unknown) => error,
            );
            expect(replayPid).toBeGreaterThan(0);
            expect(replayPid).not.toBe(normalPid);
            expect(busy).toBeInstanceOf(ApprovalResourceBusyError);
            expect(busy).toMatchObject({
              status: 409,
              code: "approval_resource_busy",
              message: "Approval resource is busy",
              details: undefined,
            });
            expect(await rollupJobs()).toBe(baselineJobs);
            expect(delivered).toEqual([]);
            expect(await threadMessages(threadId)).toEqual([]);
            expect(await getApprovalRequest(runtime, firstRequest.id)).toMatchObject({
              status: "approved",
              executionStatus: "queued",
              executionResult: null,
            });
          } catch (error) {
            normalFailure = { error };
          } finally {
            commitGate.resolve();
          }
          await throwFailures(normalFailure, [normalFirst]);
          expect(await rollupJobs()).toBeGreaterThan(baselineJobs);
          expect(delivered.length).toBeGreaterThan(0);
          expect((await replayApprovedGenericOperation(runtime, firstRequest)).error).toBe(true);
          expect(await statusOf(firstRequest.id, runtime)).toBe("conflict");

          if (kind === "delete") await cp.createRelation({ ...putInput, metadata: { version: "reset" } });
          if (kind === "insert") await cp.deleteRelation(input);
          if (kind === "upsert") {
            await withTransaction(runtime, (client) =>
              insertValueLink(client, { itemId: caller.id, propertyKey: "target", ruleKey: "test", sources: [] }),
            );
          }

          // Approved replay first: unrelated, foreign and protected writers proceed or refuse, the ordinary one waits.
          const secondRequest = await approvedPut();
          pauseApproval = true;
          const replay = replayApprovedGenericOperation(runtime, secondRequest);
          let normalLater: ReturnType<typeof ordinary> | undefined;
          let approvalFailure: { error: unknown } | undefined;
          try {
            await reachBarrier(atApproval.promise, replay, "Approval replay");
            if (kind === "insert") {
              await cp.createRelation({
                relationPropertyId: unrelated.id,
                callerItemId: caller.id,
                targetItemId: second.id,
              });
              foreignStart.resolve(true);
              await foreignWork;
            }
            if (kind === "upsert") {
              await expect(upsertProtected()).rejects.toBeInstanceOf(ValueLinkBusyError);
              expect(protectedPid).toBeGreaterThan(0);
              expect(protectedPid).not.toBe(approvalPid);
              expect(await cp.listItemRelations(caller.id, property.id)).toHaveLength(1);
            }
            normalPid = 0;
            // The commit gate is already open; the proxy still records the contender's backend.
            normalLater = ordinary(createChokePoint(heldPool));
            void normalLater.catch(() => {});
            await expectBlockedBy(() => normalPid, approvalPid);
          } catch (error) {
            approvalFailure = { error };
          } finally {
            approvalGate.resolve();
          }
          await throwFailures(approvalFailure, normalLater ? [replay, normalLater] : [replay]);
          expect(await statusOf(secondRequest.id, runtime)).toBe("succeeded");
          expect((await threadMessages(threadId)).sort()).toEqual([
            "approval.outcome.conflict",
            "approval.outcome.executed",
          ]);
          const edges = await cp.listItemRelations(caller.id, property.id);
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
            await upsertProtected();
            expect(await cp.listItemRelations(caller.id, property.id)).toHaveLength(2);
          }
        } finally {
          foreignStart.resolve(false);
          await foreignWork;
          approvalGate.resolve();
          await runtime.end();
        }
      });
    },
  );

  it("releases relation projection reservations after a managed rollback", async () => {
    const firstPool = await createRuntimeRolePool(pool, "semprec_data");
    const secondPool = await createRuntimeRolePool(pool, "semprec_data");
    let failure: { error: unknown } | undefined;
    try {
      await inTenantZero(async () => {
        const cp = createChokePoint(firstPool);
        const { property, caller, first } = await relationFixture(cp);
        const edge = await cp.createRelation({
          relationPropertyId: property.id,
          callerItemId: caller.id,
          targetItemId: first.id,
        });
        const beforeRelations = await cp.listItemRelations(caller.id, property.id);
        const readEdge = async () =>
          (
            await withTransaction(firstPool, (client) =>
              client.query<{ id: string; metadata: unknown }>("SELECT id, metadata FROM item_relations WHERE id = $1", [
                edge.id,
              ]),
            )
          ).rows;
        const beforeEdge = await readEdge();
        expect(beforeEdge).toHaveLength(1);
        const check = {
          operation: "relation.put",
          input: { relationPropertyId: property.id, callerItemId: caller.id, targetItemId: first.id },
        } as const;
        const counts = async () =>
          (
            await pool.query<{ requests: number; messages: number; jobs: number }>(
              "SELECT (SELECT count(*) FROM approval_requests)::int AS requests, (SELECT count(*) FROM semp_messages)::int AS messages, (SELECT count(*) FROM graphile_worker.jobs)::int AS jobs",
            )
          ).rows[0];
        const before = await counts();
        const originalError = new Error("forced reservation rollback");
        let firstPid = 0;
        let secondPid = 0;
        const delivered = captureInvalidations();
        await expect(
          withTransaction(firstPool, async (client) => {
            firstPid = await backendPid(client);
            await computeDestructiveResourceProjection(client, check);
            throw originalError;
          }),
        ).rejects.toBe(originalError);
        await withTransaction(secondPool, async (client) => {
          secondPid = await backendPid(client);
          await computeDestructiveResourceProjection(client, check);
        });
        expect(firstPid).toBeGreaterThan(0);
        expect(secondPid).not.toBe(firstPid);
        expect(await cp.listItemRelations(caller.id, property.id)).toEqual(beforeRelations);
        expect(await readEdge()).toEqual(beforeEdge);
        expect(await counts()).toEqual(before);
        expect(delivered).toEqual([]);
      });
    } catch (error) {
      failure = { error };
    }
    await throwFailures(failure, [firstPool.end(), secondPool.end()]);
  });

  it("rejects relation reservations outside a managed READ COMMITTED tenant transaction", () =>
    withRuntimePool(async (runtime) => {
      await inTenantZero(async () => {
        const cp = createChokePoint(runtime);
        const { property, caller, first } = await relationFixture(cp);
        const check = {
          operation: "relation.put",
          input: { relationPropertyId: property.id, callerItemId: caller.id, targetItemId: first.id },
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
              input: { relationPropertyId: randomUUID(), callerItemId: randomUUID(), targetItemId: randomUUID() },
            }),
          ),
        ),
      ).rejects.toThrow("Relation approval requires a tenant scope");
    }));

  it("refuses foreign and random relation endpoints without changing either tenant", async () => {
    const foreignTenant = await createTestTenant(pool);
    await withRuntimePool(async (runtime) => {
      const cp = createChokePoint(runtime);
      const foreignItem = await runInTenant(foreignTenant, async () => {
        const database = await cp.createDatabase({ name: "Foreign" });
        return cp.createItem({ databaseId: database.id, properties: {} });
      });
      await inTenantZero(async () => {
        const { property, caller, first } = await relationFixture(cp, { cardinality: "one_to_one" });
        const { actor } = await agentActor({ db: runtime });
        for (const operation of ["relation.put", "relation.set"] as const) {
          for (const endpoint of [foreignItem.id, randomUUID()]) {
            await expect(
              gatewayFor(runtime).invoke(operation, actor, ALL_CAPABILITIES, {
                relationPropertyId: property.id,
                callerItemId: caller.id,
                targetItemId: endpoint,
              }),
            ).rejects.toMatchObject({ code: "validation_failed", details: { field: "targetItemId" } });
          }
        }
        expect(await cp.listItemRelations(caller.id, property.id)).toEqual([]);
        await cp.createRelation({ relationPropertyId: property.id, callerItemId: caller.id, targetItemId: first.id });
        expect(await cp.listItemRelations(caller.id, property.id)).toMatchObject([{ targetItemId: first.id }]);
        expect(await countOf(COUNT_REQUESTS, [], runtime)).toBe(0);
      });
      await runInTenant(foreignTenant, async () => {
        expect((await cp.getItem(foreignItem.databaseId, foreignItem.id))?.id).toBe(foreignItem.id);
      });
    });
  });

  it.each(["archive-first", "approval-first"] as const)(
    "reserves an item patch against archive in %s order",
    async (order) =>
      inTenantZero(async () => {
        const scoped = await createRuntimeRolePool(pool, "semprec_data");
        const release = signal();
        const reached = signal();
        let approvalPid = 0;
        let archivePid = 0;
        let replayPid = 0;
        let pause = false;
        const cp = createChokePoint(scoped);
        try {
          const db = await cp.createDatabase({ name: "Archive reservation" });
          await cp.createProperty({ databaseId: db.id, key: "note", name: "Note", type: "text" });
          const item = await cp.createItem({ databaseId: db.id, properties: { note: "before" } });
          const { actor } = await agentActor({ db: scoped });
          gateItemUpdates(item.id, async ({ client, writer }) => {
            if (!pause || !writer.approvedRequestId) return;
            approvalPid = await backendPid(client);
            reached.resolve();
            await release.promise;
          });
          const input = { itemId: item.id, properties: { note: "after" }, ifVersion: item.version };
          const requestId = await approveAgentRequest("item.patch", actor, input, scoped);
          const typed = await loadGeneric(requestId, scoped);
          const observedReplayPool = interceptPool(scoped, {
            connect: async (client) => {
              replayPid = await backendPid(client);
            },
          });
          const archivePool = interceptPool(scoped, {
            connect: async (client) => {
              archivePid = await backendPid(client);
            },
            query: async (_client, args, next) => {
              if (order === "archive-first" && args[0] === "COMMIT") {
                reached.resolve();
                await release.promise;
              }
              return next();
            },
          });
          const archive = () => createChokePoint(archivePool).archiveDatabase(db.id);
          let failure: { error: unknown } | undefined;
          if (order === "archive-first") {
            const archiving = archive();
            try {
              await reachBarrier(reached.promise, archiving, "Archive");
              await expect(replayApprovedGenericOperation(observedReplayPool, typed)).rejects.toBeInstanceOf(
                ApprovalResourceBusyError,
              );
              expect(replayPid).toBeGreaterThan(0);
              expect(replayPid).not.toBe(archivePid);
              const beforeCount = await countOf(COUNT_REQUESTS, [], scoped);
              await expect(
                gatewayFor(scoped).invoke("item.patch", actor, ALL_CAPABILITIES, input),
              ).rejects.toBeInstanceOf(ApprovalResourceBusyError);
              expect(await countOf(COUNT_REQUESTS, [], scoped)).toBe(beforeCount);
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
              expect(await statusOf(requestId, scoped)).toBe("queued");
            } catch (error) {
              failure = { error };
            } finally {
              release.resolve();
            }
            await throwFailures(failure, [archiving]);
            expect((await replayApprovedGenericOperation(scoped, typed)).error).toBe(true);
            expect(await statusOf(requestId, scoped)).toBe("conflict");
            expect((await cp.getItem(db.id, item.id))?.properties.note).toBe("before");
          } else {
            pause = true;
            const replay = replayApprovedGenericOperation(scoped, typed);
            let archiving: Promise<unknown> | undefined;
            try {
              await reachBarrier(reached.promise, replay, "Replay");
              archiving = archive();
              void archiving.catch(() => {});
              await expectBlockedBy(() => archivePid, approvalPid);
            } catch (error) {
              failure = { error };
            } finally {
              release.resolve();
            }
            await throwFailures(failure, archiving ? [replay, archiving] : [replay]);
            expect(await statusOf(requestId, scoped)).toBe("succeeded");
            expect((await cp.getItem(db.id, item.id))?.properties.note).toBe("after");
          }
        } finally {
          release.resolve();
          await scoped.end();
        }
      }),
  );

  it("executes a new series immediately, leaves a rejected ending unchanged, and conflicts on a stale series", () =>
    withRuntimePool((runtime) =>
      inTenantZero(async () => {
        const tasks = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "tasks"));
        if (!tasks) throw new Error("Tasks missing");
        const cp = createChokePoint(runtime);
        const item = await cp.createItem({ databaseId: tasks.id, properties: { name: "Task", date: "2026-10-22" } });
        const { run, projectItemId, actor } = await agentActor({ db: runtime });
        const person: AuthenticatedActor = { userId: actor.userId, restSession: true };
        const patch = (properties: Record<string, unknown>, ifVersion: string, who = actor, caps = ALL_CAPABILITIES) =>
          gatewayFor(runtime).invoke("item.patch", who, caps, { itemId: item.id, properties, ifVersion });
        const findTask = () => cp.findItem(item.id);
        const thursday = { kind: "weekdays", days: ["thu"] };
        const monthly22 = { kind: "monthDates", dates: [22] };
        const everyDay = { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] };

        const initial = await findTask();
        await expect(
          patch({ recurrence: { preset: "weekly" } }, item.version, actor, NO_CAPABILITIES),
        ).rejects.toMatchObject({ status: 404, code: "not_found" });
        expect(await findTask()).toEqual(initial);
        const created = await patch({ recurrence: { preset: "weekly" } }, item.version);
        expect(created.properties.recurrence).toMatchObject({ preset: "weekly" });
        expect(created.properties.seriesId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
        const seriesRows = async (seriesId: unknown = created.properties.seriesId) =>
          (
            await runtime.query<{ active: boolean; mode: string; rule: unknown; anchor_date: Date | null }>(
              "SELECT item_id, series_id, active, mode, rule, anchor_date, template FROM task_recurrence WHERE series_id = $1",
              [seriesId],
            )
          ).rows;
        const setSeriesRule = (rule: unknown) =>
          runtime.query("UPDATE task_recurrence SET rule = $2::jsonb WHERE series_id = $1", [
            created.properties.seriesId,
            JSON.stringify(rule),
          ]);
        const originalSeries = await seriesRows();
        expect(originalSeries).toMatchObject([{ active: true, mode: "fixed", rule: thursday }]);
        const weekly = await findTask();
        if (!weekly) throw new Error("Task missing");
        expect(weekly.properties.recurrence).toMatchObject({ preset: "weekly" });
        const requestFor = (recurrence: unknown, version: string, ordinary: Record<string, unknown> = {}) =>
          requestApproval(
            "item.patch",
            actor,
            { itemId: item.id, properties: { ...ordinary, recurrence }, ifVersion: version },
            { db: runtime },
          );
        const approveAndLoad = async (requestId: string) => {
          await decide(requestId, actor.userId, { db: runtime });
          return loadGeneric(requestId, runtime);
        };
        /** Replays `request` expecting `error`, asserts it changed no task, series or job, and returns its announcements. */
        const replayChangingNothing = async (request: GenericRequest, error: boolean) => {
          const before = { task: await findTask(), series: await seriesRows(), jobs: await jobRows() };
          const events = captureInvalidations();
          expect((await replayApprovedGenericOperation(runtime, request)).error).toBe(error);
          setInvalidationHook(() => {});
          expect({ task: await findTask(), series: await seriesRows(), jobs: await jobRows() }).toEqual(before);
          return events;
        };

        const rejected = await requestFor(null, weekly.version);
        expect(await seriesRows()).toEqual(originalSeries);
        await decide(rejected, actor.userId, { db: runtime, decision: "rejected" });
        expect(await findTask()).toEqual(weekly);
        expect(await seriesRows()).toEqual(originalSeries);

        const seriesOnly = await requestFor({ preset: "monthly" }, weekly.version);
        expect(await seriesRows()).toEqual(originalSeries);
        // Synthetic intervening state: normal recurrence owners update the item projection too.
        await setSeriesRule({ kind: "weekdays", days: ["mon"] });
        expect(await findTask()).toEqual(weekly);
        // The conflict changed no data; it announces only the request that reached its terminal state, and the owner's count.
        expect(await replayChangingNothing(await approveAndLoad(seriesOnly), true)).toEqual(
          requestAnnouncements(seriesOnly, run, projectItemId),
        );
        expect(await findTask()).toEqual(weekly);
        expect(await statusOf(seriesOnly, runtime)).toBe("conflict");

        await setSeriesRule(thursday);
        const stale = await requestFor({ preset: "monthly" }, weekly.version, { name: "Changed only after approval" });
        expect(await findTask()).toEqual(weekly);
        expect(await getApprovalRequest(runtime, stale)).toMatchObject({
          riskClass: "write",
          description: {
            key: "approval.changesSeries",
            params: { taskName: "Task", fromRule: JSON.stringify(thursday), toRule: JSON.stringify(monthly22) },
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
            body: `Změnit opakování úkolu „Task“ z ${JSON.stringify(thursday)} na ${JSON.stringify(monthly22)}. Lze ji později vzít zpět.`,
          },
        ]);
        const fanoutKey = `notification-fanout:${notifications.rows[0]?.id}`;
        expect(
          (await pool.query<{ key: string }>("SELECT key FROM graphile_worker.jobs WHERE key = $1", [fanoutKey])).rows,
        ).toEqual([{ key: fanoutKey }]);

        const changed = await patch({ recurrence: { preset: "daily" } }, weekly.version, person);
        const changedProjection = await findTask();
        expect(changedProjection?.updatedAt).toBe(changed.updatedAt);
        expect(changedProjection?.properties.recurrence).toMatchObject({
          preset: "daily",
          mode: "fixed",
          rule: everyDay,
        });
        expect(await seriesRows()).toMatchObject([{ active: true, mode: "fixed", rule: everyDay }]);
        expect(await replayChangingNothing(await approveAndLoad(stale), true)).toEqual(
          requestAnnouncements(stale, run, projectItemId),
        );
        expect(await statusOf(stale, runtime)).toBe("conflict");

        const approvedChange = await approveAndLoad(
          await requestFor({ preset: "monthly" }, changed.version, { name: "Approved together" }),
        );
        expect((await replayApprovedGenericOperation(runtime, approvedChange)).error).toBe(false);
        const changedTogether = await findTask();
        if (!changedTogether) throw new Error("Missing changed task");
        expect(changedTogether.properties).toMatchObject({
          name: "Approved together",
          recurrence: { preset: "monthly", mode: "fixed", rule: monthly22 },
        });
        expect(await seriesRows()).toMatchObject([{ rule: monthly22 }]);
        expect(await replayChangingNothing(approvedChange, false)).toEqual([]);

        const approvedEnd = await approveAndLoad(await requestFor(null, changedTogether.version));
        expect((await replayApprovedGenericOperation(runtime, approvedEnd)).error).toBe(false);
        const ended = await findTask();
        if (!ended) throw new Error("Missing ended task");
        expect(ended.properties).toMatchObject({ recurrence: null, seriesId: null, occurrenceDate: null });
        expect(await seriesRows()).toMatchObject([{ active: false }]);
        await replayChangingNothing(approvedEnd, false);

        // A person starts and ends a series without any approval request.
        const requestsBeforeUser = await countOf(COUNT_REQUESTS, [], runtime);
        const userStart = await patch({ recurrence: { preset: "daily" } }, ended.version, person);
        const userStarted = await findTask();
        expect(userStarted?.updatedAt).toBe(userStart.updatedAt);
        const userSeriesId = userStarted?.properties.seriesId;
        expect(userSeriesId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
        const userEnd = await patch({ recurrence: null }, userStart.version, person);
        expect(await findTask()).toMatchObject({
          updatedAt: userEnd.updatedAt,
          properties: { recurrence: null, seriesId: null, occurrenceDate: null },
        });
        expect(await seriesRows(userSeriesId)).toMatchObject([{ active: false }]);
        expect(await countOf(COUNT_REQUESTS, [], runtime)).toBe(requestsBeforeUser);
      }),
    ));

  it("rolls back a recurrence approval request if its notification insert fails", async () => {
    let failure: { error: unknown } | undefined;
    let triggerCreated = false;
    try {
      await withRuntimePool((runtime) =>
        inTenantZero(async () => {
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
          const { actor } = await agentActor({ db: runtime });
          const snapshot = async () => ({
            item: await cp.findItem(item.id),
            series: (
              await runtime.query<{ item_id: string; mode: string; rule: unknown; active: boolean }>(
                "SELECT item_id, mode, rule, active FROM task_recurrence WHERE item_id = $1",
                [item.id],
              )
            ).rows,
            requests: (await runtime.query<{ id: string }>("SELECT id FROM approval_requests ORDER BY id")).rows,
            notifications: (await runtime.query<{ id: string }>("SELECT id FROM notifications ORDER BY id")).rows,
            jobs: await jobRows(),
          });
          const before = await snapshot();
          await pool.query(`CREATE FUNCTION reject_recurrence_notification_test() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'injected recurrence notification failure'; END $$`);
          await pool.query(`CREATE TRIGGER reject_recurrence_notification_test BEFORE INSERT ON notifications
            FOR EACH ROW WHEN (NEW.kind = 'approval_pending') EXECUTE FUNCTION reject_recurrence_notification_test()`);
          triggerCreated = true;
          const invalidations = captureInvalidations();
          await expect(
            gatewayFor(runtime).invoke("item.patch", actor, ALL_CAPABILITIES, {
              itemId: item.id,
              properties: { recurrence: { preset: "monthly" }, name: "Not committed" },
              ifVersion: weekly.version,
            }),
          ).rejects.toThrow("injected recurrence notification failure");
          expect(await snapshot()).toEqual(before);
          expect(invalidations).toEqual([]);
        }),
      );
    } catch (error) {
      failure = { error };
    }
    const cleanup = async () => {
      if (triggerCreated) await pool.query("DROP TRIGGER reject_recurrence_notification_test ON notifications");
      await pool.query("DROP FUNCTION IF EXISTS reject_recurrence_notification_test()");
    };
    await throwFailures(failure, [cleanup()]);
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
      const { run, actor } = await agentActor();
      gateItemUpdates(item.id);
      const requestId = await requestApproval("item.patch", actor, {
        itemId: item.id,
        properties: { note: "after" },
        ifVersion: item.version,
      });
      expect((await chokePoint.findItem(item.id))?.properties.note).toBe("before");
      const pending = await getApprovalRequest(pool, requestId);
      expect(pending?.description).toEqual({
        key: "approval.itemPatch",
        params: { itemName: "Patch title", databaseKey: database.key, databaseName: "Flag patch" },
      });
      expect(JSON.stringify(pending?.description)).not.toContain("after");
      expect(JSON.stringify(pending?.description)).not.toContain(item.id);
      expect(pending?.resourceSnapshot.kind).toBe("item_patch");
      await decide(requestId, run.actorUserId);
      // Simulate a stored stale client token without changing the snapshotted resource.
      await pool.query(
        "UPDATE approval_requests SET payload = jsonb_set(payload, '{canonicalInput,ifVersion}', to_jsonb($2::text)) WHERE id = $1",
        [requestId, "2000-01-01T00:00:00.000Z"],
      );
      expect((await replayById(requestId)).error).toBe(false);
      expect((await chokePoint.findItem(item.id))?.properties.note).toBe("after");
      await chokePoint.updateItem({
        databaseId: database.id,
        itemId: item.id,
        propertiesPatch: { headline: "Renamed" },
      });
      expect((await getApprovalRequest(pool, requestId))?.description).toEqual(pending?.description);
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
      const { actor } = await agentActor();
      gateRelationWrites(property.id);
      const requestId = await requestApproval("relation.set", actor, {
        relationPropertyId: property.id,
        callerItemId: caller.id,
        targetItemId: destination.id,
      });
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
      const { actor } = await agentActor();
      gateRelationWrites(property.id);
      const requestId = await approveAgentRequest("relation.put", actor, {
        relationPropertyId: property.id,
        callerItemId: caller.id.toUpperCase(),
        targetItemId: destination.id.toUpperCase(),
      });
      expect(await chokePoint.listItemRelations(caller.id, property.id)).toEqual([]);
      const request = await loadGeneric(requestId);
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
      expect((await replayApprovedGenericOperation(pool, request)).error).toBe(false);
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
    }));

  it("keeps unflagged relation sets immediate and permits flagged user and system writers", async () => {
    const { property, caller, first, second, third } = await relationFixture(chokePoint, {
      cardinality: "one_to_one",
    });
    const { run, actor } = await agentActor();
    const gateway = gatewayFor();
    const input = { relationPropertyId: property.id, callerItemId: caller.id };
    await expect(
      gateway.invoke("relation.set", actor, ALL_CAPABILITIES, {
        ...input,
        targetItemId: first.id,
        approvedRequestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    for (const target of [first, first, second]) {
      await gateway.invoke("relation.set", actor, ALL_CAPABILITIES, { ...input, targetItemId: target.id });
    }
    expect(await chokePoint.listItemRelations(caller.id, property.id)).toMatchObject([{ targetItemId: second.id }]);
    const writers: string[] = [];
    gateRelationWrites(property.id, ({ writer }) => {
      writers.push(writer.writerKind);
    });
    await gateway.invoke("relation.set", { userId: run.actorUserId, restSession: true }, ALL_CAPABILITIES, {
      ...input,
      targetItemId: third.id,
    });
    await chokePoint.setRelation({ ...input, targetItemId: first.id });
    expect(writers).toEqual(["user", "system"]);
    expect(await chokePoint.listItemRelations(caller.id, property.id)).toMatchObject([{ targetItemId: first.id }]);
    expect(await countOf(COUNT_REQUESTS)).toBe(0);
  });

  it.each(["changed", "sourceDeleted", "targetDeleted", "rejected"] as const)(
    "leaves the relation unchanged when a flagged request is %s",
    async (scenario) =>
      inTenantZero(async () => {
        const { source, target, property, caller, first, second, third } = await relationFixture(chokePoint, {
          cardinality: "one_to_one",
        });
        const input = { relationPropertyId: property.id, callerItemId: caller.id };
        const original = await chokePoint.setRelation({ ...input, targetItemId: first.id });
        if (!original) throw new Error("Expected initial edge");
        const threadId = await chatThread();
        const { run, actor } = await agentActor({ threadId });
        gateRelationWrites(property.id);
        const requestId = await requestApproval("relation.set", actor, { ...input, targetItemId: second.id });
        if (scenario === "changed") await chokePoint.setRelation({ ...input, targetItemId: third.id });
        if (scenario === "sourceDeleted") await chokePoint.softDeleteItem(source.id, caller.id);
        if (scenario === "targetDeleted") await chokePoint.softDeleteItem(target.id, second.id);
        await decide(requestId, run.actorUserId, { decision: scenario === "rejected" ? "rejected" : "approved" });
        if (scenario !== "rejected") {
          expect((await replayById(requestId)).error).toBe(true);
          expect(await statusOf(requestId)).toBe("conflict");
        }
        if (scenario === "sourceDeleted") {
          const edges = await pool.query<{ id: string }>("SELECT id FROM item_relations WHERE id = $1", [original.id]);
          expect(edges.rows).toEqual([{ id: original.id }]);
        } else {
          expect(await chokePoint.listItemRelations(caller.id, property.id)).toMatchObject([
            { targetItemId: scenario === "changed" ? third.id : first.id },
          ]);
        }
        expect(await threadMessages(threadId)).toEqual([
          scenario === "rejected" ? "approval.outcome.rejected" : "approval.outcome.conflict",
        ]);
      }),
  );

  it("uses the actor's locale for database and view queries through the application gateway", async () => {
    await inTenantZero(async () => {
      const users = await pool.query<{ id: string }>("SELECT id FROM users WHERE tenant_id = $1", [getTenantZeroId()]);
      const user = users.rows[0];
      if (!user) throw new Error("Missing tenant user");
      const database = await chokePoint.createDatabase({ name: "Collation" });
      await chokePoint.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "title" });
      for (const name of ["Hrad", "Chalupa", "Rybník", "Řeka"]) {
        await chokePoint.createItem({ databaseId: database.id, properties: { name } });
      }
      const view = await chokePoint.createView({ databaseId: database.id, type: "table", name: "Names" });
      const gateway = gatewayFor();
      const sort = [{ property: "name", direction: "asc" }] as const;
      const queryPage = (operation: "database.query" | "view.query", cursor: string | undefined) =>
        operation === "database.query"
          ? gateway.invoke(operation, { userId: user.id }, ALL_CAPABILITIES, {
              databaseId: database.id,
              sort,
              cursor,
              limit: 2,
            })
          : gateway.invoke(operation, { userId: user.id }, ALL_CAPABILITIES, {
              viewId: view.id,
              sort,
              cursor,
              limit: 2,
            });
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
            const result = await queryPage(operation, cursor);
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
      const gateway = gatewayFor();
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
        ifVersion: item.version,
      });
      expect(result).toMatchObject({
        id: item.id,
        properties: { due: "2026-10-28T09:00:00Z", note: "Keep", unset: "Now set" },
      });
      expect(result.previous).toEqual({ due: "2026-10-27T14:00:00Z", unset: null });
      await expect(
        gateway.invoke("item.patch", actor, ALL_CAPABILITIES, {
          itemId: item.id,
          properties: { due: "Rejected" },
          ifVersion: "2000-01-01T00:00:00.000Z",
        }),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(await chokePoint.getItem(db.id, item.id)).toMatchObject({
        properties: result.properties,
        updatedAt: result.updatedAt,
      });
    });
  });

  it("item.patch exposes previous values only inside the owning tenant on a runtime-role pool", async () => {
    const tenantB = await createTestTenant(pool);
    const runtimePool = await inTenantZero(() => createRuntimeRolePool(pool, "semprec_data"));
    try {
      const fixture = await inTenantZero(async () => {
        const cp = createChokePoint(runtimePool);
        const db = await cp.createDatabase({ name: "Private patch" });
        await cp.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "text" });
        return { db, item: await cp.createItem({ databaseId: db.id, properties: { title: "Private" } }) };
      });
      const actor: AuthenticatedActor = { userId: await createUser() };
      const gateway = gatewayFor(runtimePool);
      const input = { itemId: fixture.item.id, properties: { title: "Changed" }, ifVersion: fixture.item.version };
      for (const itemId of [fixture.item.id, randomUUID()]) {
        await expect(
          runInTenant(tenantB, () => gateway.invoke("item.patch", actor, ALL_CAPABILITIES, { ...input, itemId })),
        ).rejects.toBeInstanceOf(NotFoundError);
      }
      await inTenantZero(async () => {
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

  it("serves the page operations under the item capabilities and grants nothing to the page capabilities", async () => {
    const actor: AuthenticatedActor = { userId: await createUser() };
    const database = await chokePoint.createDatabase({ name: "Pages" });
    const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
    const gateway = gatewayFor();
    const itemOnly = new Set<(typeof CAPABILITY_IDS)[number]>(["core.item.read", "core.item.write"]);
    const pageOperations = GENERIC_OPERATION_NAMES.filter((operation) => operation.startsWith("page."));
    expect(pageOperations).toContain("page.restoreVersion");
    for (const operation of pageOperations) expect(gateway.listOperations(itemOnly)).toContain(operation);
    // The approval of page operations exists, so the writing ones list under the item write capability alone.
    expect(gateway.listOperations(new Set(["core.item.write"] as const))).toEqual(
      expect.arrayContaining(["page.insert", "page.replace"]),
    );
    expect(OPERATION_METADATA["page.replace"].requiresCapability).toBe("core.item.write");
    const pages = new Set<(typeof CAPABILITY_IDS)[number]>(["core.page.read", "core.page.write"]);
    expect(gateway.listOperations(pages)).toEqual([]);
    await expect(
      gateway.invoke("page.get", actor, pages, { itemId: item.id, format: "summary" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      gateway.invoke("page.restoreVersion", actor, pages, { itemId: item.id, at: new Date().toISOString() }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await gateway.invoke("page.get", actor, itemOnly, { itemId: item.id, format: "summary" })).toMatchObject({
      docId: null,
    });
    expect((await pool.query<{ id: string }>("SELECT id FROM docs WHERE item_id = $1", [item.id])).rows).toHaveLength(
      0,
    );
  });

  describe("listOperations", () => {
    it("returns only the operations whose capability is granted, never present-but-forbidden", () => {
      const gateway = gatewayFor();
      expect(gateway.listOperations(NO_CAPABILITIES)).toEqual([]);
      expect(gateway.listOperations(ALL_CAPABILITIES)).toEqual(
        GENERIC_OPERATION_NAMES.filter((operation) => !REST_ONLY_OPERATION_NAMES.some((name) => name === operation)),
      );
      expect(gateway.listOperations(new Set(["core.item.read"] as const))).toEqual(
        GENERIC_OPERATION_NAMES.filter(
          (operation) => OPERATION_METADATA[operation].requiresCapability === "core.item.read",
        ),
      );
    });

    it("lists no REST-only operation, although the capability it names lists its other operations", () => {
      const gateway = gatewayFor();
      expect(gateway.listOperations(new Set(["core.schema.write"] as const))).toEqual([
        "property.create",
        "property.patch",
        "property.delete",
      ]);
      for (const operation of REST_ONLY_OPERATION_NAMES) {
        expect(gateway.listOperations(ALL_CAPABILITIES)).not.toContain(operation);
        expect(gateway.listOperations(new Set([OPERATION_METADATA[operation].requiresCapability]))).not.toContain(
          operation,
        );
      }
    });
  });

  describe("invoke", () => {
    async function personAndAgent(): Promise<AuthenticatedActor[]> {
      return [{ userId: await createUser() }, (await agentActor({ realProject: true })).actor];
    }

    it("throws NotFoundError for an operation whose capability isn't granted, indistinguishable from unknown", async () => {
      const actor: AuthenticatedActor = { userId: await createUser() };
      await expect(gatewayFor().invoke("item.get", actor, NO_CAPABILITIES, { itemId: randomUUID() })).rejects.toThrow(
        NotFoundError,
      );
    });

    it("refuses both REST-only option operations for a person and for an agent run like an unknown operation, writing nothing", async () => {
      const gateway = gatewayFor();
      const database = await chokePoint.createDatabase({ name: "Gateway options" });
      const property = await chokePoint.createProperty({
        databaseId: database.id,
        key: "tags",
        name: "Tags",
        type: "multi_select",
        config: { options: [{ key: "herbs", label: "Herbs" }] },
      });
      for (const actor of await personAndAgent()) {
        // The same arguments run through the port for a REST caller, so only the gateway refuses them here.
        const refusals = [
          gateway.invoke("property.option.add", actor, ALL_CAPABILITIES, { propertyId: property.id, label: "Spices" }),
          gateway.invoke("property.option.update", actor, ALL_CAPABILITIES, {
            propertyId: property.id,
            key: "herbs",
            label: "Fresh herbs",
          }),
        ];
        for (const refusal of refusals) {
          await expect(refusal).rejects.toMatchObject({ name: "NotFoundError", code: "not_found", status: 404 });
        }
      }
      expect((await chokePoint.getProperty(property.id))?.config).toEqual(property.config);
      expect(await countOf(COUNT_REQUESTS)).toBe(0);
    });

    it("answers page.replace on an unknown item with not found for a person and for an agent run, creating no approval request", async () => {
      for (const actor of await personAndAgent()) {
        // Valid arguments for an item that does not exist: the replace projection answers not found for both actors.
        await expect(
          gatewayFor().invoke("page.replace", actor, ALL_CAPABILITIES, {
            itemId: randomUUID(),
            markdown: "Replacement",
            expectedEtag: "A".repeat(43),
          }),
        ).rejects.toMatchObject({ name: "NotFoundError", code: "not_found", status: 404 });
      }
      expect(await countOf(COUNT_REQUESTS)).toBe(0);
    });

    it.each([
      { carries: "runId without agentProjectItemId", partial: { runId: randomUUID() } },
      { carries: "agentProjectItemId without runId", partial: { agentProjectItemId: randomUUID() } },
    ])("rejects an agent actor carrying $carries as owner_violation", async ({ partial }) => {
      const actor: AuthenticatedActor = { userId: await createUser(), ...partial };
      const refusal = gatewayFor().invoke("item.get", actor, ALL_CAPABILITIES, { itemId: randomUUID() });
      await expect(refusal).rejects.toBeInstanceOf(ForbiddenError);
      await expect(refusal).rejects.toMatchObject({ code: "owner_violation" });
    });

    it("throws ValidationError for input that fails the operation's own strict schema, naming the field", async () => {
      const gateway = gatewayFor();
      const actor: AuthenticatedActor = { userId: await createUser() };
      const database = await chokePoint.createDatabase({ name: "Gateway DB" });
      const base = { databaseId: database.id, key: "rel", name: "Rel" };
      await expect(gateway.invoke("item.get", actor, ALL_CAPABILITIES, {})).rejects.toThrow(ValidationError);
      // A reason belongs to the invocation options, never to the operation input.
      await expect(
        gateway.invoke("item.delete", actor, ALL_CAPABILITIES, { itemId: randomUUID(), reason: "x" }),
      ).rejects.toBeInstanceOf(ValidationError);
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

    it("executes non-destructive operations for people and agents, and destructive ones for people, immediately", async () => {
      const gateway = gatewayFor();
      const userId = await createUser();
      const database = await chokePoint.createDatabase({ name: "Gateway DB" });
      await chokePoint.createProperty({ databaseId: database.id, key: "title", name: "Title", type: "title" });
      const { run, projectItemId } = await agentActor();
      for (const actor of [{ userId }, { userId, runId: run.id, agentProjectItemId: projectItemId }]) {
        const created = await gateway.invoke("item.create", actor, ALL_CAPABILITIES, {
          databaseId: database.id,
          properties: { title: "Made by gateway" },
        });
        expect((await chokePoint.findItem(created.id))?.properties).toMatchObject({ title: "Made by gateway" });
      }
      // A person carries no runId, so a destructive operation is never approval-gated for them.
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      await gateway.invoke("item.delete", { userId }, ALL_CAPABILITIES, { itemId: item.id });
      expect(await chokePoint.findItem(item.id)).toBeNull();
      expect(await countOf(COUNT_REQUESTS)).toBe(0);
    });

    it("defers a destructive operation for a full agent actor: no execution, one pending approval_requests row, ApprovalRequiredError", async () => {
      const database = await chokePoint.createDatabase({ name: "Gateway DB 3" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      const { run, actor } = await agentActor();
      const error = await gatewayFor()
        .invoke("item.delete", actor, ALL_CAPABILITIES, { itemId: item.id })
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
      if (!(error instanceof ApprovalRequiredError)) throw new Error("expected ApprovalRequiredError");
      expect(error.details.link).toContain(error.details.approvalRequestId);
      const request = await loadGeneric(error.details.approvalRequestId);
      expect(request).toMatchObject({
        status: "pending",
        agentRunId: run.id,
        toolName: "item.delete",
        riskClass: "destructive",
      });
      expect(request.payload.resourceSnapshot).toEqual(request.resourceSnapshot);
      expect(await chokePoint.findItem(item.id)).not.toBeNull();
      expect(await countOf(COUNT_REQUESTS)).toBe(1);
    });

    it("stores the agent's reason on the request without putting it in the canonical input or the snapshot", async () => {
      const database = await chokePoint.createDatabase({ name: "Gateway DB reason" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      const { actor } = await agentActor();
      const withReason = await requestApproval(
        "item.delete",
        actor,
        { itemId: item.id },
        { reason: "You never use it." },
      );
      const withoutReason = await requestApproval("item.delete", actor, { itemId: item.id });
      const request = await getApprovalRequest(pool, withReason);
      expect(request?.reason).toBe("You never use it.");
      expect(JSON.stringify(request?.payload)).not.toContain("You never use it.");
      expect(JSON.stringify(request?.resourceSnapshot)).not.toContain("You never use it.");
      expect(request?.payload).toMatchObject({ canonicalInput: { itemId: item.id } });
      expect((await getApprovalRequest(pool, withoutReason))?.reason).toBeNull();
    });

    it("stores the tool call id on the request, and leaves it NULL when none is supplied", async () => {
      const database = await chokePoint.createDatabase({ name: "Gateway DB tool call" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      const threadId = await chatThread();
      // No public writer sets a historical activity timestamp.
      await pool.query("UPDATE semp_threads SET last_activity_at = '2020-01-01' WHERE id = $1", [threadId]);
      const { actor } = await agentActor({ threadId });
      const input = { itemId: item.id };
      const linked = await requestApproval("item.delete", actor, input, { toolCallId: "call_1" });
      const redelivered = await requestApproval("item.delete", actor, input, { toolCallId: "call_1" });
      const unlinked = await requestApproval("item.delete", actor, input);
      expect((await getApprovalRequest(pool, linked))?.toolCallId).toBe("call_1");
      expect(redelivered).toBe(linked);
      expect((await getApprovalRequest(pool, unlinked))?.toolCallId).toBeNull();
      const activity = await pool.query<{ last_activity_at: Date; requested_at: Date }>(
        "SELECT t.last_activity_at, r.requested_at FROM semp_threads t JOIN approval_requests r ON r.id = $2 WHERE t.id = $1",
        [threadId, unlinked],
      );
      expect(activity.rows).toHaveLength(1);
      expect(activity.rows[0]!.last_activity_at.getTime()).toBe(activity.rows[0]!.requested_at.getTime());
    });
  });

  describe("replayApprovedGenericOperation", () => {
    /** An approved, queued item.delete request: the executor runs only such a row, so no queue job is needed. */
    async function approvedDelete() {
      const database = await chokePoint.createDatabase({ name: "Replay DB" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      const { run, actor } = await agentActor();
      return { requestId: await approveAgentRequest("item.delete", actor, { itemId: item.id }), run, item };
    }
    type Fixture = Awaited<ReturnType<typeof approvedDelete>>;
    const driftProvenance = (runId: string) =>
      pool.query("UPDATE agent_runs SET project_item_id = $1 WHERE id = $2", [randomUUID(), runId]);

    it.each<{
      when: string;
      tamper: (fixture: Fixture) => Promise<unknown>;
      result: (itemId: string) => object;
      contains?: string;
    }>([
      {
        when: "the run's persisted provenance no longer matches the payload",
        tamper: ({ run }) => driftProvenance(run.id),
        contains: "owner_violation",
        result: () => ({ error: { code: "version_conflict" } }),
      },
      {
        when: "the stored canonicalInput no longer satisfies the operation's schema",
        // A stored payload that no longer parses must fail cleanly, not crash inside the binding.
        tamper: ({ requestId }) =>
          pool.query(
            "UPDATE approval_requests SET payload = jsonb_set(payload, '{canonicalInput}', '{}'::jsonb) WHERE id = $1",
            [requestId],
          ),
        contains: "validation_failed",
        result: () => ({ error: { code: "version_conflict" } }),
      },
      {
        when: "the resource changed after approval",
        // `item_delete`'s snapshot hashes `updatedAt`, so this change makes it differ from the approved one.
        tamper: ({ item }) => pool.query("UPDATE items SET updated_at = now() WHERE id = $1", [item.id]),
        result: () => ({ error: { code: "version_conflict", details: { currentResource: expect.anything() } } }),
      },
      {
        when: "the database was archived after approval",
        // The hash still matches, but the projection rejects with a domain failure other than not found.
        tamper: ({ item }) => pool.query("UPDATE databases SET archived_at = now() WHERE id = $1", [item.databaseId]),
        result: (itemId) => ({ error: { details: { reason: "database_archived", currentResource: { id: itemId } } } }),
      },
    ])("terminalizes as conflict without executing when $when", async ({ tamper, result, contains }) => {
      const fixture = await approvedDelete();
      await tamper(fixture);
      const outcome = await replayById(fixture.requestId);
      expect(outcome.error).toBe(true);
      if (contains) expect(outcome.result).toContain(contains);
      expect(JSON.parse(outcome.result)).toMatchObject(result(fixture.item.id));
      expect(await chokePoint.findItem(fixture.item.id)).not.toBeNull();
      const persisted = await getApprovalRequest(pool, fixture.requestId);
      expect(persisted?.executionStatus).toBe("conflict");
      expect(persisted?.executedAt).not.toBeNull();
      expect(persisted?.executionResult).toMatchObject(result(fixture.item.id));
    });

    it("replaying an already-conflicted request is a no-op: returns the persisted conflict without re-authorizing", async () => {
      const { requestId, run, item } = await approvedDelete();
      await driftProvenance(run.id);
      const request = await loadGeneric(requestId);
      const first = await replayApprovedGenericOperation(pool, request);
      expect(first.error).toBe(true);
      expect(first.result).toContain("owner_violation");
      // With the drift fixed, a redelivered job must still see the row as terminal and re-run nothing.
      await pool.query("UPDATE agent_runs SET project_item_id = $1 WHERE id = $2", [
        request.payload.actor.agentProjectItemId,
        run.id,
      ]);
      const second = await replayById(requestId);
      expect(second.error).toBe(true);
      expect(JSON.parse(second.result)).toEqual(JSON.parse(first.result));
      expect(await chokePoint.findItem(item.id)).not.toBeNull();
    });
  });

  describe("DestructiveApprovalPreflight", () => {
    it.each([
      {
        when: "the actor's persisted provenance no longer matches (owner_violation)",
        arrange: async () => {
          const database = await chokePoint.createDatabase({ name: "Preflight Provenance" });
          const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
          const { run, actor } = await agentActor();
          // The run's persisted provenance drifted from what `actor` claims, caught before a request is queued.
          await pool.query("UPDATE agent_runs SET project_item_id = $1 WHERE id = $2", [randomUUID(), run.id]);
          return {
            refuse: () => gatewayFor().invoke("item.delete", actor, ALL_CAPABILITIES, { itemId: item.id }),
            code: "owner_violation",
            remains: async () => (await chokePoint.findItem(item.id)) !== null,
          };
        },
      },
      {
        when: "the resource is locked (paired relation property locked)",
        arrange: async () => {
          const tasks = await chokePoint.createDatabase({ name: "Preflight Locked Tasks" });
          const participants = await chokePoint.createDatabase({ name: "Preflight Locked Participants" });
          const { property } = await chokePoint.createRelationProperty({
            sourceDatabaseId: tasks.id,
            key: "assignedTo",
            name: "Assigned To",
            targetDatabaseId: participants.id,
            inverse: { key: "assignedTasks", name: "Assigned Tasks", locked: true },
          });
          const { actor } = await agentActor();
          return {
            refuse: () => gatewayFor().invoke("property.delete", actor, ALL_CAPABILITIES, { propertyId: property.id }),
            code: undefined,
            remains: async () => (await chokePoint.listProperties(tasks.id)).some((p) => p.id === property.id),
          };
        },
      },
    ])("creates no approval request and no notification when $when", async ({ arrange }) => {
      const { refuse, code, remains } = await arrange();
      const refusal = refuse();
      await expect(refusal).rejects.toBeInstanceOf(ForbiddenError);
      if (code) await expect(refusal).rejects.toMatchObject({ code });
      expect(await remains()).toBe(true);
      await expectNoApprovalOrNotification();
    });
  });

  describe("approval description and notification", () => {
    /** Raises and approves the request with the recipient's locale set to English, so the body reads in English. */
    async function raiseInEnglish(operation: GenericOperationName, actor: AuthenticatedActor, input: unknown) {
      await pool.query("UPDATE users SET locale = 'en'");
      return approveAgentRequest(operation, actor, input);
    }

    /** The stored description and the one notification's body; every approval carries the fixed title. */
    async function describedAs(requestId: string) {
      const { rows } = await pool.query<{ title: string; body: string | null }>(
        "SELECT title, body FROM notifications WHERE source_id = $1 AND kind = 'approval_pending'",
        [requestId],
      );
      expect(rows).toEqual([{ title: "Semp needs approval", body: expect.any(String) }]);
      return { description: (await getApprovalRequest(pool, requestId))?.description, body: rows[0]?.body };
    }

    async function tasksAndPeople() {
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
      const { actor } = await agentActor({ realProject: true });
      return { tasks, people, assignedTo, task, person, actor };
    }

    it("property.delete snapshots names and the count of items with a value, unchanged by later edits", async () => {
      const database = await chokePoint.createDatabase({ name: "Journal" });
      const property = await chokePoint.createProperty({
        databaseId: database.id,
        key: "mood",
        name: "Mood",
        type: "text",
      });
      for (const properties of [{ mood: "ok" }, { mood: "great" }, {}]) {
        await chokePoint.createItem({ databaseId: database.id, properties });
      }
      const { actor } = await agentActor({ realProject: true });
      const requestId = await raiseInEnglish("property.delete", actor, { propertyId: property.id });
      const expected = {
        key: "approval.propertyDelete",
        params: { propertyName: "Mood", databaseKey: null, databaseName: "Journal", affectedCount: 2 },
      };
      expect(await describedAs(requestId)).toEqual({
        description: expected,
        body: 'Delete "Mood" from "Journal" (unnamed); 2 items affected. Semp cannot undo this action.',
      });
      await pool.query("UPDATE properties SET name = 'Renamed' WHERE id = $1", [property.id]);
      await chokePoint.createItem({ databaseId: database.id, properties: { mood: "late" } });
      expect((await describedAs(requestId)).description).toEqual(expected);
    });

    it("item.delete snapshots the name, database key, linked count and trash retention, without ids, and says it can be undone", async () => {
      const { tasks, people, task, person, actor } = await tasksAndPeople();
      const { property: reviewedBy } = await chokePoint.createRelationProperty({
        sourceDatabaseId: tasks.id,
        key: "reviewedBy",
        name: "Reviewed By",
        targetDatabaseId: people.id,
        inverse: { key: "reviewedTasks", name: "Reviewed Tasks" },
      });
      await chokePoint.createRelation({
        relationPropertyId: reviewedBy.id,
        callerItemId: task.id,
        targetItemId: person.id,
      });
      const { description, body } = await describedAs(await raiseInEnglish("item.delete", actor, { itemId: task.id }));
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
      expect(body).toBe(
        'Delete "Tax return" from "Tasks" (unnamed); 1 linked items, retained for 30 days. This can be undone later.',
      );
    });

    it("database.archive, view.delete and relation.delete store their templates and their undo sentences", async () => {
      const { tasks, assignedTo, task, person, actor } = await tasksAndPeople();
      const view = await chokePoint.createView(
        { databaseId: tasks.id, type: "table", name: "Open tasks" },
        { type: "ai_agent", agentProjectItemId: actor.agentProjectItemId },
      );
      const cases: Array<[GenericOperationName, unknown, unknown, string]> = [
        [
          "database.archive",
          { databaseId: tasks.id },
          { key: "approval.databaseArchive", params: { databaseName: "Tasks", affectedCount: 1 } },
          'Archive "Tasks"; 1 items affected. This can be undone later.',
        ],
        [
          "view.delete",
          { viewId: view.id },
          { key: "approval.viewDelete", params: { viewName: "Open tasks", databaseName: "Tasks" } },
          'Delete view "Open tasks" from "Tasks". Semp cannot undo this action.',
        ],
        [
          "relation.delete",
          { relationPropertyId: assignedTo.id, callerItemId: task.id, targetItemId: person.id },
          {
            key: "approval.relationDelete",
            params: { fromItemName: "Tax return", fromDatabaseKey: null, toItemName: "Eva", toDatabaseKey: null },
          },
          'Remove the link from "Tax return" (unnamed) to "Eva" (unnamed). Semp cannot undo this action.',
        ],
      ];
      for (const [operation, input, description, body] of cases) {
        expect(await describedAs(await raiseInEnglish(operation, actor, input))).toEqual({ description, body });
      }
    });

    it("falls back to a legacy name, and renders an item without one as the unnamed label", async () => {
      const database = await chokePoint.createDatabase({ name: "Legacy" });
      await chokePoint.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "text" });
      const named = await chokePoint.createItem({ databaseId: database.id, properties: { name: "Legacy name" } });
      const unnamed = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      const { actor } = await agentActor({ realProject: true });
      const namedRequest = await describedAs(await raiseInEnglish("item.delete", actor, { itemId: named.id }));
      const unnamedRequest = await describedAs(await raiseInEnglish("item.delete", actor, { itemId: unnamed.id }));
      expect(namedRequest.description).toMatchObject({ params: { itemName: "Legacy name" } });
      expect(unnamedRequest.description).toMatchObject({ params: { itemName: null } });
      expect(unnamedRequest.body).toBe(
        'Delete "unnamed" from "Legacy" (unnamed); 0 linked items, retained for 30 days. This can be undone later.',
      );
    });
  });

  describe("approval notification link", () => {
    it.each<{ raisedBy: string; page: string; startRun: () => Promise<AgentRunRow> }>([
      {
        raisedBy: "a Semp chat",
        page: "?page=semp-chats&tab=semp",
        startRun: async () =>
          createAgentRun(pool, {
            projectItemId: randomUUID(),
            triggeredBy: "user",
            unit: "session",
            task: "chat",
            threadId: await chatThread(),
          }),
      },
      {
        raisedBy: "an automatic task tick",
        page: "?page=inbox",
        startRun: async () => {
          const projectItemId = randomUUID();
          const tick = await withTransaction(pool, async (client) => {
            const heartbeat = await createHeartbeat(client, {
              projectItemId,
              name: "Sunday planning",
              rule: { kind: "weekly", days: ["sun"], at: "21:00" },
              actionId: CORE_AGENT_RUN_ACTION_ID,
              actionConfig: { task: "Plan the week" },
            });
            return { heartbeatId: heartbeat.id, threadId: (await getOrCreateTickThread(client, heartbeat.id)).id };
          });
          return createAgentRun(pool, { projectItemId, triggeredBy: "heartbeat", task: "Plan the week", ...tick });
        },
      },
      {
        raisedBy: "an MCP client",
        page: "?page=inbox",
        startRun: () =>
          createAgentRun(pool, { projectItemId: randomUUID(), triggeredBy: "mcp", task: "MCP run-credential session" }),
      },
    ])("links a request raised by $raisedBy to $page, naming the request and no user", async ({ page, startRun }) => {
      const run = await startRun();
      if (run.projectItemId === null) throw new Error("The run names no project");
      const database = await chokePoint.createDatabase({ name: "Tasks" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      const actor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: run.projectItemId };
      const requestId = await requestApproval("item.delete", actor, { itemId: item.id });
      const { rows } = await pool.query<{ link_href: string | null }>(
        `SELECT link_href FROM notifications
         WHERE kind = 'approval_pending' AND source_table = 'approval_requests' AND source_id = $1`,
        [requestId],
      );
      expect(rows).toEqual([{ link_href: `${page}&approvalRequestId=${requestId}` }]);
      expect(rows[0]?.link_href).not.toContain(run.actorUserId);
    });
  });

  describe("replay parity for all destructive operations", () => {
    it.each<{
      operation: GenericOperationName;
      arrange: (actor: AuthenticatedActor) => Promise<{ input: unknown; gone: () => Promise<boolean> }>;
    }>([
      {
        operation: "database.archive",
        arrange: async () => {
          const database = await chokePoint.createDatabase({ name: "Replay Parity Archive" });
          return {
            input: { databaseId: database.id },
            gone: async () => (await chokePoint.getDatabase(database.id))?.archivedAt != null,
          };
        },
      },
      {
        operation: "property.delete",
        arrange: async () => {
          const database = await chokePoint.createDatabase({ name: "Replay Parity Property" });
          const property = await chokePoint.createProperty({
            databaseId: database.id,
            key: "notes",
            name: "Notes",
            type: "text",
          });
          return {
            input: { propertyId: property.id },
            gone: async () => !(await chokePoint.listProperties(database.id)).some((p) => p.id === property.id),
          };
        },
      },
      {
        operation: "view.delete",
        arrange: async (actor) => {
          const database = await chokePoint.createDatabase({ name: "Replay Parity View" });
          const view = await chokePoint.createView(
            { databaseId: database.id, type: "table", name: "Agent View" },
            { type: "ai_agent", agentProjectItemId: actor.agentProjectItemId },
          );
          return { input: { viewId: view.id }, gone: async () => (await chokePoint.getView(view.id)) === null };
        },
      },
      {
        operation: "relation.delete",
        arrange: async () => {
          const tasks = await chokePoint.createDatabase({ name: "Replay Parity Rel Tasks" });
          const participants = await chokePoint.createDatabase({ name: "Replay Parity Rel Participants" });
          const { property } = await chokePoint.createRelationProperty({
            sourceDatabaseId: tasks.id,
            key: "assignedTo",
            name: "Assigned To",
            targetDatabaseId: participants.id,
            inverse: { key: "assignedTasks", name: "Assigned Tasks" },
          });
          const task = await chokePoint.createItem({ databaseId: tasks.id, properties: {} });
          const person = await chokePoint.createItem({ databaseId: participants.id, properties: {} });
          const input = { relationPropertyId: property.id, callerItemId: task.id, targetItemId: person.id };
          const edge = await chokePoint.createRelation(input);
          return {
            input,
            gone: async () =>
              (await countOf("SELECT count(*)::int AS count FROM item_relations WHERE id = $1", [edge.id])) === 0,
          };
        },
      },
    ])(
      "$operation: preflight, approve, and replay apply the operation exactly once",
      async ({ operation, arrange }) => {
        const { actor } = await agentActor({ realProject: true });
        const { input, gone } = await arrange(actor);
        const requestId = await approveAgentRequest(operation, actor, input);
        expect(await gone()).toBe(false);
        expect((await replayById(requestId)).error).toBe(false);
        expect(await statusOf(requestId)).toBe("succeeded");
        expect(await gone()).toBe(true);
      },
    );

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
        for (const [key, config] of [
          ["taskCount", { relationPropertyKey: "tasks", aggregation: "count" }],
          ["totalHours", { relationPropertyKey: "tasks", aggregation: "sum", targetPropertyKey: "hours" }],
        ] as const) {
          await chokePoint.createProperty({ databaseId: projects.id, key, name: key, type: "rollup", config });
        }
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
      const taskList = coreTaskList(replayApprovedGenericOperation);
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
      const { actor } = await inTenantZero(() => agentActor({ realProject: true }));
      const requestId = await inTenantZero(() =>
        approveAgentRequest("database.archive", actor, { databaseId: tasks.id }),
      );
      expect((await inTenantZero(() => replayById(requestId))).error).toBe(false);
      expect(await statusOf(requestId)).toBe("succeeded");
      expect((await chokePoint.getDatabase(tasks.id))?.archivedAt).not.toBeNull();
      expect(await countJobsByIdentifier(pool, CORE_TASK_NAMES.ROLLUP_RECOMPUTE_FULL)).toBe(2);
      await drainUntil(0, null);
      const current = await inTenantZero(() => chokePoint.getItem(projects.id, project.id));
      expect(current?.computed).toMatchObject({ taskCount: 0, totalHours: null });
    });
  });

  describe("page.restoreVersion through the approval gate", () => {
    /**
     * A page whose history starts two hours before the database clock, with block `b1` written an hour
     * before it. The instant returned is half an hour before the clock, so it sits between the two.
     */
    async function pageWithFirstBlock() {
      const docStore = createDocStore(pool);
      const { rows } = await pool.query<{ now: Date }>("SELECT transaction_timestamp() AS now");
      const now = rows[0]!.now;
      const hoursBefore = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000);
      const database = await chokePoint.createDatabase({ name: "Pages" });
      await chokePoint.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "text" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: { name: "Chapter one" } });
      const doc = await docStore.getOrCreateDoc(item.id, "page");
      await pool.query("UPDATE docs SET history_available_from = $2 WHERE id = $1", [doc.id, hoursBefore(2)]);
      await pool.query(
        "UPDATE doc_snapshot_history SET represented_at = $2 WHERE doc_id = $1 AND through_update_id = 0",
        [doc.id, hoursBefore(2)],
      );
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph", fields: { content: "first" } }, "user");
      await pool.query("UPDATE doc_updates SET created_at = $2 WHERE doc_id = $1", [doc.id, hoursBefore(1)]);
      await pool.query("UPDATE doc_history_updates SET created_at = $2 WHERE doc_id = $1", [doc.id, hoursBefore(1)]);
      const { actor } = await agentActor({ realProject: true });
      const at = hoursBefore(0.5);
      return { itemId: item.id, docId: doc.id, at, actor, input: { itemId: item.id, at: at.toISOString() } };
    }

    function addSecondBlock(itemId: string) {
      return createDocStore(pool).putBlock(
        itemId,
        { id: "b2", flavour: "paragraph", fields: { content: "second" } },
        "user",
      );
    }

    async function blockIdsOf(itemId: string): Promise<string[]> {
      const blocks = await createDocStore(pool).listBlocks(itemId);
      return blocks.map((block) => String(block["sys:id"])).sort();
    }

    it("holds an agent call for approval, and the approved replay restores the page as one user update", async () => {
      const page = await pageWithFirstBlock();
      await addSecondBlock(page.itemId);
      const requestId = await approveAgentRequest("page.restoreVersion", page.actor, page.input);
      // Approval alone changes nothing: the restore runs when the approved request is replayed.
      expect(await blockIdsOf(page.itemId)).toEqual(["b1", "b2"]);
      expect(await getApprovalRequest(pool, requestId)).toMatchObject({
        toolName: "page.restoreVersion",
        riskClass: "destructive",
        description: {
          key: "approval.pageRestore",
          params: { itemName: "Chapter one", databaseKey: null, databaseName: "Pages" },
        },
      });
      expect((await replayById(requestId)).error).toBe(false);
      expect(await statusOf(requestId)).toBe("succeeded");
      expect(await blockIdsOf(page.itemId)).toEqual(["b1"]);
      const { rows } = await pool.query<{ created_by: string }>(
        "SELECT created_by FROM doc_updates WHERE doc_id = $1 ORDER BY id DESC LIMIT 1",
        [page.docId],
      );
      expect(rows[0]!.created_by).toBe("user");
    });

    it.each([
      { edit: "a later edit", keepStamp: false },
      { edit: "a same-author edit with the same timestamp", keepStamp: true },
    ])("ends the replay as a conflict, restoring nothing, after $edit", async ({ keepStamp }) => {
      const page = await pageWithFirstBlock();
      const previous = (
        await pool.query<{ last_edited_at: Date; last_edited_by: string }>(
          "SELECT last_edited_at, last_edited_by FROM docs WHERE id = $1",
          [page.docId],
        )
      ).rows[0];
      if (!previous) throw new Error("missing page fixture");
      const requestId = await approveAgentRequest("page.restoreVersion", page.actor, page.input);
      await addSecondBlock(page.itemId);
      if (keepStamp) {
        // Reproduce a timestamp collision independently of wall-clock scheduling.
        await pool.query("UPDATE docs SET last_edited_at = $2, last_edited_by = $3 WHERE id = $1", [
          page.docId,
          previous.last_edited_at,
          previous.last_edited_by,
        ]);
      }
      await replayById(requestId);
      expect(await statusOf(requestId)).toBe("conflict");
      expect(await blockIdsOf(page.itemId)).toEqual(["b1", "b2"]);
    });

    it("keeps approval identity through real compaction and retention, then detects a later edit", async () => {
      const page = await pageWithFirstBlock();
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
      const requestId = await approveAgentRequest("page.restoreVersion", page.actor, page.input);
      await withRuntimePool(async (runtime) => {
        await inTenantZero(() => loadYDoc(runtime, page.docId, 1, 1));
        expect(await countOf("SELECT count(*)::int AS count FROM doc_updates WHERE doc_id = $1", [page.docId])).toBe(0);
        expect(await inTenantZero(() => rebaselineDocHistory(runtime, page.docId, 1))).toBe(true);
        expect(
          await countOf(
            "SELECT count(*)::int AS count FROM doc_history_updates WHERE doc_id = $1 AND update_id = $2::bigint",
            [page.docId, updateId],
          ),
        ).toBe(0);
        const baseline = await pool.query<{ through_update_id: string }>(
          "SELECT through_update_id::text FROM doc_snapshot_history WHERE doc_id = $1 AND expires_at IS NULL",
          [page.docId],
        );
        expect(baseline.rows).toEqual([{ through_update_id: updateId }]);
        const firstReplay = await loadGeneric(requestId);
        await inTenantZero(() => replayApprovedGenericOperation(runtime, firstReplay));
        expect(await statusOf(requestId)).toBe("succeeded");
        expect(await blockIdsOf(page.itemId)).toEqual(["b1"]);
        const secondRequest = await approveAgentRequest("page.restoreVersion", page.actor, page.input);
        await createDocStore(pool).putBlock(
          page.itemId,
          { id: "b2", flavour: "paragraph", fields: { content: "later" } },
          "user",
        );
        const secondReplay = await loadGeneric(secondRequest);
        await inTenantZero(() => replayApprovedGenericOperation(runtime, secondReplay));
        expect(await statusOf(secondRequest)).toBe("conflict");
        expect(await blockIdsOf(page.itemId)).toEqual(["b1", "b2"]);
      });
    });

    it("rejects an approval whose snapshot was created before update identity was added", async () => {
      const page = await pageWithFirstBlock();
      const requestId = await approveAgentRequest("page.restoreVersion", page.actor, page.input);
      const projection = await withTransaction(pool, (client) =>
        computePageRestoreProjection(client, { operation: "page.restoreVersion", input: page.input }),
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
      await replayById(requestId);
      expect(await statusOf(requestId)).toBe("conflict");
      expect(await blockIdsOf(page.itemId)).toEqual(["b1"]);
    });

    it("rejects replay after an edit from an earlier-started transaction", async () => {
      const page = await pageWithFirstBlock();
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      const hold = signal();
      const started = signal<Date>();
      const restore = afterMatchingQuery(
        runtime,
        (text) => text === "BEGIN",
        async (client) => {
          const at = (await client.query<{ at: Date }>("SELECT transaction_timestamp() AS at")).rows[0]?.at;
          if (!at) throw new Error("missing transaction timestamp");
          started.resolve(at);
          await hold.promise;
        },
      );
      const writer = inTenantZero(() =>
        mutateYDoc(runtime, page.docId, "user", (doc) => {
          doc.getMap("approval-test").set("edit", "later");
        }),
      );
      const settled = Promise.allSettled([writer]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const at = await Promise.race([
          started.promise,
          writer.then(() => {
            throw new Error("writer ended before barrier");
          }),
          new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("barrier timed out")), 5000))),
        ]);
        // Force the existing timestamp and author to collide with the transaction's real timestamp.
        await pool.query("UPDATE docs SET last_edited_at = $2, last_edited_by = 'user' WHERE id = $1", [
          page.docId,
          at,
        ]);
        const requestId = await approveAgentRequest("page.restoreVersion", page.actor, page.input);
        hold.resolve();
        await writer;
        const after = await pool.query<{ at: Date; author: string }>(
          "SELECT last_edited_at AS at, last_edited_by AS author FROM docs WHERE id = $1",
          [page.docId],
        );
        expect(after.rows).toEqual([{ at, author: "user" }]);
        await replayById(requestId);
        expect(await statusOf(requestId)).toBe("conflict");
      } finally {
        hold.resolve();
        clearTimeout(timer);
        await settled;
        restore();
        await runtime.end();
      }
    }, 15000);

    it.each(["replay-first", "delete-first"] as const)(
      "coordinates actual approved replay and deletion with %s",
      async (order) => {
        const page = await pageWithFirstBlock();
        const requestId = await approveAgentRequest("page.restoreVersion", page.actor, page.input);
        const request = await loadGeneric(requestId);
        const databaseId = (
          await pool.query<{ database_id: string }>("SELECT database_id FROM items WHERE id = $1", [page.itemId])
        ).rows[0]?.database_id;
        if (!databaseId) throw new Error("missing page database");
        const replayPool = await createRuntimeRolePool(pool, "semprec_data");
        const deletePool = await createRuntimeRolePool(pool, "semprec_data");
        const hold = signal();
        const ready = signal<number>();
        const holdAt = async (client: PoolClient) => {
          ready.resolve(await backendPid(client));
          await hold.promise;
        };
        const pending: Promise<unknown>[] = [];
        const track = (work: Promise<unknown>) => {
          void work.catch(() => {});
          pending.push(work);
        };
        let restore = () => {};
        if (order === "replay-first") {
          track(
            withTransaction(pool, async (client) => {
              await client.query("SELECT doc_id FROM doc_snapshots WHERE doc_id = $1 FOR UPDATE", [page.docId]);
              await holdAt(client);
            }),
          );
        } else {
          restore = afterMatchingQuery(
            deletePool,
            (text) =>
              typeof text === "string" &&
              text.startsWith("UPDATE items SET deleted_at = COALESCE($3::timestamptz, now())"),
            holdAt,
          );
        }
        const doDelete = () => inTenantZero(() => createChokePoint(deletePool).softDeleteItem(databaseId, page.itemId));
        /** The backend `pid` is waiting on, polled for up to two seconds. */
        const waiterOn = async (pid: number) => {
          for (let i = 0; i < 100; i++) {
            const waiting = (
              await pool.query<{ pid: number }>(
                "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
                [pid],
              )
            ).rows[0]?.pid;
            if (waiting !== undefined) return waiting;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          return undefined;
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (order === "delete-first") track(doDelete());
          const ownerPid = await Promise.race([
            ready.promise,
            new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("barrier timed out")), 5000))),
          ]);
          track(inTenantZero(() => replayApprovedGenericOperation(replayPool, request)));
          const replayPid = await waiterOn(ownerPid);
          expect(replayPid).toBeDefined();
          if (order === "replay-first") {
            track(doDelete());
            expect(await waiterOn(replayPid!)).toBeDefined();
          }
          hold.resolve();
          await Promise.all(pending);
          expect(await statusOf(requestId)).toBe(order === "replay-first" ? "succeeded" : "conflict");
        } finally {
          hold.resolve();
          clearTimeout(timer);
          await Promise.allSettled(pending);
          restore();
          await Promise.all([replayPool.end(), deletePool.end()]);
        }
      },
      15000,
    );

    it("refuses a request for an unknown page without queuing an approval", async () => {
      const { actor } = await agentActor({ realProject: true });
      await expect(
        gatewayFor().invoke("page.restoreVersion", actor, ALL_CAPABILITIES, {
          itemId: randomUUID(),
          at: new Date().toISOString(),
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await countOf(COUNT_REQUESTS)).toBe(0);
    });
  });

  it("routes an approved generic-operation request through the queue to the injected replay handler", async () => {
    const database = await chokePoint.createDatabase({ name: "Worker path DB" });
    const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
    const { actor } = await agentActor();
    const requestId = await approveAgentRequest("item.delete", actor, { itemId: item.id });
    await runOnce({ pgPool: pool, taskList: coreTaskList(replayApprovedGenericOperation) });
    expect(await chokePoint.findItem(item.id)).toBeNull();
    const finished = await getApprovalRequest(pool, requestId);
    expect(finished?.executedAt).not.toBeNull();
    expect(finished?.executionStatus).toBe("succeeded");
    expect(finished?.executionResult).toMatchObject({ result: { id: item.id } });
  });

  describe("approval request announcements", () => {
    let approvalAnnouncements: Array<{ approvalRequestId: string; userId: string | undefined }>;
    let threadAnnouncements: Array<{ tenantId: string; threadId: string }>;

    beforeEach(() => {
      approvalAnnouncements = [];
      threadAnnouncements = [];
      setInvalidationHook((event) => {
        if (event.scope === "approvalRequest")
          approvalAnnouncements.push({ approvalRequestId: event.approvalRequestId, userId: event.userId });
      });
      setSempThreadInvalidationHook((event) => threadAnnouncements.push(event));
    });

    afterEach(() => {
      setSempThreadInvalidationHook(() => {});
    });

    async function deleteSetUp(withThread: boolean) {
      const database = await chokePoint.createDatabase({ name: "Announcement DB" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      const threadId = withThread ? await chatThread() : null;
      const { run, actor } = await agentActor(threadId ? { threadId } : {});
      const raise = (toolCallId?: string) =>
        requestApproval("item.delete", actor, { itemId: item.id }, toolCallId ? { toolCallId } : {});
      /** Raises and approves a request, then forgets what that announced. */
      const raiseApproved = async () => {
        const requestId = await raise();
        await decide(requestId, run.actorUserId);
        approvalAnnouncements.length = 0;
        threadAnnouncements.length = 0;
        return requestId;
      };
      return { item, run, actor, threadId, raise, raiseApproved };
    }

    it.each([true, false])(
      "announces a created request to its owner, pairing its run's thread: %s",
      async (withThread) => {
        const { run, threadId, raise } = await deleteSetUp(withThread);
        const requestId = await raise();
        expect(approvalAnnouncements).toEqual([{ approvalRequestId: requestId, userId: run.actorUserId }]);
        expect(threadAnnouncements).toEqual(withThread ? [{ tenantId: getTenantZeroId(), threadId }] : []);
      },
    );

    it("announces nothing, and writes no request or notification, when the preflight refuses the call", async () => {
      const { actor } = await deleteSetUp(true);
      await expect(
        gatewayFor().invoke("item.delete", actor, ALL_CAPABILITIES, { itemId: randomUUID() }),
      ).rejects.toThrow(NotFoundError);
      expect(approvalAnnouncements).toEqual([]);
      expect(threadAnnouncements).toEqual([]);
      await expectNoApprovalOrNotification();
    });

    it("announces a repeated tool call once, because the repeat writes nothing", async () => {
      const { raise } = await deleteSetUp(true);
      const first = await raise("call_announce");
      expect(await raise("call_announce")).toBe(first);
      expect(approvalAnnouncements).toHaveLength(1);
      expect(threadAnnouncements).toHaveLength(1);
    });

    it("executes and announces a successful replay once; a redelivered replay returns the stored result silently", async () => {
      const { item, run, threadId, raiseApproved } = await deleteSetUp(true);
      const requestId = await raiseApproved();
      const first = await replayById(requestId);
      expect(first.error).toBe(false);
      expect((JSON.parse(first.result) as { result: unknown }).result).toMatchObject({ id: item.id });
      expect(await chokePoint.findItem(item.id)).toBeNull();
      expect(approvalAnnouncements).toEqual([{ approvalRequestId: requestId, userId: run.actorUserId }]);
      expect(threadAnnouncements).toEqual([{ tenantId: getTenantZeroId(), threadId }]);
      const second = await replayById(requestId);
      // The stored result round-tripped through jsonb, which may reorder keys, so compare parsed content.
      expect(second.error).toBe(false);
      expect(JSON.parse(second.result)).toEqual(JSON.parse(first.result));
      expect(approvalAnnouncements).toHaveLength(1);
      expect(threadAnnouncements).toHaveLength(1);
    });

    it("announces a replay that ends in a conflict once, and a run without a thread only as the request", async () => {
      const { item, run, raiseApproved } = await deleteSetUp(false);
      const requestId = await raiseApproved();
      // The resource changed after approval, so the snapshot hash no longer matches.
      await pool.query("UPDATE items SET updated_at = now() WHERE id = $1", [item.id]);
      expect((await replayById(requestId)).error).toBe(true);
      expect(approvalAnnouncements).toEqual([{ approvalRequestId: requestId, userId: run.actorUserId }]);
      expect(threadAnnouncements).toEqual([]);
      await replayById(requestId);
      expect(approvalAnnouncements).toHaveLength(1);
    });

    it("records and announces once the failed outcome of a worker without a replay handler", async () => {
      const { item, run, threadId, raiseApproved } = await deleteSetUp(true);
      const requestId = await raiseApproved();
      await runOnce({ pgPool: pool, taskList: coreTaskList(undefined) });
      expect(await chokePoint.findItem(item.id)).not.toBeNull();
      const finished = await getApprovalRequest(pool, requestId);
      expect(finished).toMatchObject({ executionError: true, executionStatus: "conflict" });
      expect(finished?.executedAt).not.toBeNull();
      expect(finished?.executionResult).toContain("No generic-operation approval replay handler is configured");
      expect(approvalAnnouncements).toEqual([{ approvalRequestId: requestId, userId: run.actorUserId }]);
      expect(threadAnnouncements).toEqual([{ tenantId: getTenantZeroId(), threadId }]);
    });
  });
});

describe("approval_pending recipient in a tenant", () => {
  let runtimePool: Pool;

  // The first describe's `afterAll` ended the shared pool, so this block opens and closes its own.
  beforeAll(async () => {
    pool = getTestPool();
    runtimePool = await inTenantZero(() => createRuntimeRolePool(pool, "semprec_data"));
  });

  beforeEach(async () => {
    await inTenantZero(() => resetDatabase(pool));
  });

  afterAll(async () => {
    await runtimePool?.end();
    await pool?.end();
  });

  function addUser(tenantId: string, email: string) {
    return runInTenant(tenantId, () => createBoundUser(pool, { email, passwordHash: "x", tenantId }));
  }

  async function agentIn(tenantId: string): Promise<AuthenticatedActor> {
    const run = await runInTenant(tenantId, () =>
      createAgentRun(runtimePool, { projectItemId: randomUUID(), triggeredBy: "user", task: "agent task" }),
    );
    if (!run.projectItemId) throw new Error("Missing project id");
    return { userId: run.actorUserId, runId: run.id, agentProjectItemId: run.projectItemId };
  }

  it("notifies the user of the tenant the request is created in, with a link that names the request and no user", async () => {
    const tenantB = await inTenantZero(() => createTestTenant(pool));
    const userA = await addUser(getTenantZeroId(), "a@example.test");
    const userB = await addUser(tenantB, "b@example.test");
    const actor = await agentIn(tenantB);
    const approvalRequestId = await runInTenant(tenantB, async () => {
      const cp = createChokePoint(runtimePool);
      const database = await cp.createDatabase({ name: "Tenant B DB" });
      const item = await cp.createItem({ databaseId: database.id, properties: {} });
      return requestApproval("item.delete", actor, { itemId: item.id }, { db: runtimePool });
    });
    const { rows } = await pool.query<{ user_id: string; kind: string; link_href: string | null; tenant_id: string }>(
      "SELECT user_id, kind, link_href, tenant_id FROM notifications WHERE source_id = $1",
      [approvalRequestId],
    );
    expect(rows).toEqual([
      {
        user_id: userB.id,
        kind: "approval_pending",
        // The run has no thread and a person started it, which is a chat source.
        link_href: `?page=semp-chats&tab=semp&approvalRequestId=${approvalRequestId}`,
        tenant_id: tenantB,
      },
    ]);
    expect(rows[0]?.user_id).not.toBe(userA.id);
    expect(rows[0]?.link_href).not.toContain(userB.id);
  });

  it("refuses a foreign destructive target like a missing target without approval side effects", async () => {
    const tenantA = getTenantZeroId();
    const tenantB = await inTenantZero(() => createTestTenant(pool));
    await addUser(tenantA, "foreign-a@example.test");
    await addUser(tenantB, "foreign-b@example.test");
    const foreign = await runInTenant(tenantA, async () => {
      const cp = createChokePoint(runtimePool);
      const db = await cp.createDatabase({ name: "Foreign" });
      return cp.createItem({ databaseId: db.id, properties: {} });
    });
    const actor = await agentIn(tenantB);
    const snapshot = async () =>
      (
        await pool.query<{ requests: string; notifications: string; item: unknown }>(
          "SELECT (SELECT count(*)::text FROM approval_requests) requests, (SELECT count(*)::text FROM notifications) notifications, (SELECT to_jsonb(i) FROM items i WHERE id = $1) item",
          [foreign.id],
        )
      ).rows[0];
    const before = await snapshot();
    expect(before?.item).toBeTruthy();
    const refusalFor = async (itemId: string) => {
      const error = await runInTenant(tenantB, () =>
        gatewayFor(runtimePool)
          .invoke("item.delete", actor, ALL_CAPABILITIES, { itemId })
          .then(
            () => undefined,
            (thrown: unknown) => thrown,
          ),
      );
      if (!(error instanceof Error)) throw new Error("Expected refusal");
      return { name: error.name, message: error.message.replace(itemId, "<id>") };
    };
    expect(await refusalFor(foreign.id)).toEqual(await refusalFor(randomUUID()));
    expect(await snapshot()).toEqual(before);
  });

  it("defers an owned patch but refuses foreign and random targets identically under the runtime role", async () => {
    const tenantA = getTenantZeroId();
    const tenantB = await createTestTenant(pool);
    await addUser(tenantA, "patch-a@example.test");
    await addUser(tenantB, "patch-b@example.test");
    const makeItem = (tenantId: string) =>
      runInTenant(tenantId, async () => {
        const cp = createChokePoint(runtimePool);
        const db = await cp.createDatabase({ name: "Scoped patches" });
        await cp.createProperty({ databaseId: db.id, key: "note", name: "Note", type: "text" });
        return cp.createItem({ databaseId: db.id, properties: { note: "before" } });
      });
    const foreign = await makeItem(tenantA);
    const own = await makeItem(tenantB);
    const actor = await agentIn(tenantB);
    gateItemUpdates(own.id);
    const invoke = (itemId: string) =>
      runInTenant(tenantB, () =>
        gatewayFor(runtimePool).invoke("item.patch", actor, ALL_CAPABILITIES, {
          itemId,
          properties: { note: "after" },
          ifVersion: own.version,
        }),
      );
    const refusalFor = async (itemId: string) => {
      const error = await invoke(itemId).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      if (!(error instanceof NotFoundError)) throw new Error("Expected not found");
      return error.message.replace(itemId, "<id>");
    };
    expect(await refusalFor(foreign.id)).toBe(await refusalFor(randomUUID()));
    const requests = () => runInTenant(tenantB, () => countOf(COUNT_REQUESTS, [], runtimePool));
    expect(await requests()).toBe(0);
    await expect(invoke(own.id)).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(await requests()).toBe(1);
    for (const [tenantId, item] of [
      [tenantA, foreign],
      [tenantB, own],
    ] as const) {
      expect(
        (await runInTenant(tenantId, () => createChokePoint(runtimePool).findItem(item.id)))?.properties.note,
      ).toBe("before");
    }
  });
});
