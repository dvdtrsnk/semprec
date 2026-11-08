import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import "../../domainWriteHooks.js";
import {
  createRuntimeRolePool,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../../testSupport/testDb.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { insertValueLink, listValueLinksByItemIds } from "../../chokePoint/valueLinksStore.js";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES } from "@semprec/queue";
import { writeComputed } from "../../chokePoint/itemsStore.js";
import * as itemsStore from "../../chokePoint/itemsStore.js";
import { NotFoundError, ValidationError } from "../../errors.js";
import { listTranscriptSpeakers } from "../transcriptionSpeakerEdges.js";
import { createTranscriptSpeakersRouteHandler } from "../transcriptionRouteHandlers.js";

let pool: Pool;

interface QueuedJobKey {
  task_identifier: string;
  key: string | null;
}

/** Task, then key in code-unit order, unkeyed jobs last. */
function compareJobKeys(a: QueuedJobKey, b: QueuedJobKey): number {
  const order = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  const byTask = order(a.task_identifier, b.task_identifier);
  if (byTask !== 0 || a.key === b.key) return byTask;
  if (a.key === null) return 1;
  if (b.key === null) return -1;
  return order(a.key, b.key);
}

/** Every queued job's task and key, read through graphile-worker's public `jobs` view, in code-unit order. */
async function queuedJobKeys(): Promise<QueuedJobKey[]> {
  const { rows } = await pool.query<QueuedJobKey>("SELECT task_identifier, key FROM graphile_worker.jobs");
  return rows.map(({ task_identifier, key }) => ({ task_identifier, key })).sort(compareJobKeys);
}

/** `jobs` with the given search reindex keys added once each, as job-key deduplication leaves them. */
function withReindexKeys(jobs: QueuedJobKey[], keys: string[]): QueuedJobKey[] {
  const added = keys
    .filter((key) => !jobs.some((job) => job.key === key))
    .map((key) => ({ task_identifier: CORE_TASK_NAMES.ITEM_SEARCH_REINDEX_DEPENDENTS, key }));
  return [...jobs, ...added].sort(compareJobKeys);
}

function throwFailure(error: unknown): never {
  // Re-throw the exact value, including undefined, from a test-owned operation.
  throw error;
}

function combineFailure(
  failure: { error: unknown } | undefined,
  errors: unknown[],
  message: string,
): { error: unknown } {
  if (failure) return { error: new AggregateError([failure.error, ...errors], message, { cause: failure.error }) };
  if (errors.length === 1) return { error: errors[0] };
  return { error: new AggregateError(errors, message) };
}

function requireSuccessful(outcome: { ok: true } | { ok: false; error: unknown }): void {
  if (!outcome.ok) throwFailure(outcome.error);
}

async function bounded<T>(promise: Promise<T>, milliseconds = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Participant timed out")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface RuntimeOperations {
  run<T>(start: () => Promise<T>): Promise<T>;
  settle(): Promise<void>;
  onCancel(cancel: () => void): void;
  consume(operation: Promise<unknown>, expected: unknown): void;
}

// Local to these serial fixtures: every barrier is released if any owning pool closes early.
const fixtureCancellations = new Set<Set<() => void>>();

async function withRuntimePool<T>(body: (runtime: Pool, operations: RuntimeOperations) => Promise<T>): Promise<T> {
  const runtime = await createRuntimeRolePool(pool, "semprec_data");
  runtime.options.connectionTimeoutMillis = 2500;
  runtime.options.statement_timeout = 5000;
  const active = new Map<PoolClient, object>();
  const clientErrors: unknown[] = [];
  const onClientError = (error: Error) => clientErrors.push(error);
  let closing = false;
  const cancellations = new Set<() => void>();
  fixtureCancellations.add(cancellations);
  const destroy = (client: PoolClient, token: object) => {
    if (active.get(client) !== token) return;
    try {
      client.release(true);
    } catch (error) {
      clientErrors.push(error);
    }
  };
  const onAcquire = (client: PoolClient) => {
    const token = {};
    active.set(client, token);
    client.on("error", onClientError);
    // pg-pool 3.14 emits acquire before assigning release; defer until that stack returns.
    if (closing) queueMicrotask(() => destroy(client, token));
  };
  const onRelease = (_error: Error | undefined, client: PoolClient) => {
    active.delete(client);
    client.removeListener("error", onClientError);
  };
  runtime.on("acquire", onAcquire);
  runtime.on("release", onRelease);
  const pending = new Set<Promise<void>>();
  const outcomes: Array<{ error?: { value: unknown }; consumed: boolean }> = [];
  const outcomeByOperation = new WeakMap<Promise<unknown>, (typeof outcomes)[number]>();
  const operations: RuntimeOperations = {
    run: <U>(start: () => Promise<U>): Promise<U> => {
      const started = Promise.resolve().then(() => {
        if (closing) throw new Error("Runtime fixture is closing");
        return start();
      });
      const entry: { error?: { value: unknown }; consumed: boolean } = { consumed: false };
      outcomes.push(entry);
      outcomeByOperation.set(started, entry);
      const settled = started.then(
        () => {},
        (error: unknown) => {
          entry.error = { value: error };
        },
      );
      pending.add(settled);
      void settled.then(() => pending.delete(settled));
      return started;
    },
    settle: async () => {
      while (pending.size > 0) await Promise.all([...pending]);
    },
    onCancel: (cancel) => {
      if (closing) cancel();
      else cancellations.add(cancel);
    },
    consume: (operation, expected) => {
      const entry = outcomeByOperation.get(operation);
      if (!entry?.error || entry.error.value !== expected) throw new Error("Unexpected participant outcome");
      entry.consumed = true;
    },
  };
  const work = Promise.resolve()
    .then(() => body(runtime, operations))
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = await bounded(work, 12000);
  } catch (error) {
    outcome = { error };
  }
  closing = true;
  for (const cancel of cancellations) {
    try {
      cancel();
    } catch (error) {
      clientErrors.push(error);
    }
  }
  if ("value" in outcome && (active.size > 0 || pending.size > 0 || runtime.waitingCount > 0)) {
    clientErrors.push(new Error("Runtime body returned with owned work still pending"));
  }
  for (const [client, token] of active) destroy(client, token);
  const end = runtime.end();
  const waiting = (async () => {
    const deadline = Date.now() + 4000;
    while (runtime.waitingCount > 0) {
      if (Date.now() >= deadline) throw new Error("Runtime pool waiters did not settle");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  const cleanup = Promise.allSettled([end, work, operations.settle(), waiting]);
  const removeListeners = () => {
    runtime.removeListener("acquire", onAcquire);
    runtime.removeListener("release", onRelease);
    fixtureCancellations.delete(cancellations);
  };
  try {
    const results = await bounded(cleanup, 10000);
    for (const result of results) if (result.status === "rejected") clientErrors.push(result.reason);
    const finished = await work;
    if ("error" in finished && (!("error" in outcome) || finished.error !== outcome.error)) {
      clientErrors.push(finished.error);
    }
    for (const entry of outcomes) {
      if (entry.error !== undefined && !entry.consumed) clientErrors.push(entry.error.value);
    }
    removeListeners();
  } catch (error) {
    clientErrors.push(error);
    // A failed watchdog must keep owning late arrivals until the actual cleanup settles.
    void cleanup.then(removeListeners);
  }
  if (clientErrors.length) {
    const errors = "error" in outcome ? [outcome.error, ...clientErrors] : clientErrors;
    throw new AggregateError(errors, "Test and runtime cleanup failed", { cause: errors[0] });
  }
  if ("error" in outcome) throwFailure(outcome.error);
  return outcome.value;
}

const SEGMENTS = [
  { speaker: "SPEAKER_01", text: "Hello.", startsAt: 0, endsAt: 1 },
  { speaker: "SPEAKER_00", text: "Hi, Alice.", startsAt: 1, endsAt: 2 },
  { speaker: "SPEAKER_01", text: "Shall we start?", startsAt: 2, endsAt: 3 },
];

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function propertyIdFor(databaseId: string, key: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM properties WHERE database_id = $1 AND key = $2", [
    databaseId,
    key,
  ]);
  if (!rows[0]) throw new Error(`Property '${key}' was not seeded`);
  return rows[0].id;
}

/** Issue #185: speaker-to-People mappings written through the generic relation operation and composed at read time. */
describe("Transcript speaker mappings (issue #185)", () => {
  let transcriptsId: string;
  let peopleId: string;
  let speakersPropertyId: string;
  let chokePoint: ChokePoint;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    transcriptsId = await databaseIdFor("transcripts");
    peopleId = await databaseIdFor("people");
    speakersPropertyId = await propertyIdFor(transcriptsId, "speakers");
    chokePoint = createChokePoint(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  /** `null` creates a transcript the merge step has not reached yet. */
  async function createTranscript(segments: unknown[] | null = SEGMENTS): Promise<string> {
    return withTransaction(pool, async (client) => {
      const item = await createItemWithClient(client, { databaseId: transcriptsId, properties: { name: "Sync" } });
      if (segments !== null) await writeComputed(client, transcriptsId, item.id, "segments", segments);
      return item.id;
    });
  }

  async function createPerson(name: string): Promise<string> {
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: peopleId, properties: { name } }),
    );
    return item.id;
  }

  function map(transcriptId: string, personId: string, metadata?: Record<string, unknown>) {
    return chokePoint.createRelation({
      relationPropertyId: speakersPropertyId,
      callerItemId: transcriptId,
      targetItemId: personId,
      metadata,
    });
  }

  function speakers(transcriptId: string) {
    return withTransaction(pool, (client) => listTranscriptSpeakers(client, transcriptId));
  }

  async function readSegments(transcriptId: string): Promise<unknown> {
    const { rows } = await pool.query<{ segments: unknown }>(
      "SELECT computed -> 'segments' AS segments FROM items WHERE id = $1",
      [transcriptId],
    );
    return rows[0]?.segments;
  }

  it.each([undefined, { marker: "non-error" }])("preserves owned participant failure identity %#", async (original) => {
    let settled = false;
    let runtimePool: Pool | undefined;
    const operation = withRuntimePool(async (runtime, operations) => {
      runtimePool = runtime;
      await operations.run(() =>
        withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
          await client.query<{ "?column?": number }>("SELECT 1");
          settled = true;
        }),
      );
      await operations.settle();
      throwFailure(original);
    });
    await expect(operation).rejects.toBe(original);
    expect(settled).toBe(true);
    if (!runtimePool) throw new Error("Missing runtime fixture");
    expect(runtimePool.totalCount).toBe(0);
    const cleanup = { marker: "cleanup" };
    const combined = combineFailure({ error: original }, [cleanup], "combined").error;
    expect(combined).toBeInstanceOf(AggregateError);
    if (!(combined instanceof AggregateError)) throw new Error("Expected combined failure");
    expect(combined.errors[0]).toBe(original);
    expect(combined.errors[1]).toBe(cleanup);
    expect(combined.cause).toBe(original);
  });

  describe("rendering", () => {
    it("lists every speaker key unmapped, numbered by first appearance", async () => {
      const transcriptId = await createTranscript();

      expect(await speakers(transcriptId)).toEqual([
        { speaker: "SPEAKER_01", ordinal: 1, person: null },
        { speaker: "SPEAKER_00", ordinal: 2, person: null },
      ]);
    });

    it("shows a mapping without rewriting segments, and keeps every other key's ordinal", async () => {
      const transcriptId = await createTranscript();
      const aliceId = await createPerson("Alice");

      await map(transcriptId, aliceId, { speaker: "SPEAKER_00" });

      expect(await speakers(transcriptId)).toEqual([
        { speaker: "SPEAKER_01", ordinal: 1, person: null },
        { speaker: "SPEAKER_00", ordinal: 2, person: { id: aliceId, name: "Alice" } },
      ]);
      expect(await readSegments(transcriptId)).toEqual(SEGMENTS);
    });

    it("renders a key whose mapped person was deleted as unmapped", async () => {
      const transcriptId = await createTranscript();
      const aliceId = await createPerson("Alice");
      await map(transcriptId, aliceId, { speaker: "SPEAKER_00" });

      await chokePoint.softDeleteItem(peopleId, aliceId);

      expect((await speakers(transcriptId))[1]).toEqual({ speaker: "SPEAKER_00", ordinal: 2, person: null });
    });

    it("lists no speakers before the merge step has written segments", async () => {
      const transcriptId = await createTranscript(null);

      expect(await speakers(transcriptId)).toEqual([]);
    });

    it("rejects an unknown transcript with not_found", async () => {
      await expect(speakers("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("writing through the generic relation operation", () => {
    it.each(["normal", "undefined", "combined", "late", "late-undefined"] as const)(
      "validates protected speaker metadata before refusing a busy transcript lock (%s)",
      async (control) => {
        const original = { marker: "observation" };
        const cleanup = { marker: "cleanup" };
        const late = { marker: "late contender" };
        const lateFailure = control === "late-undefined" ? undefined : late;
        const runControl = async () => {
          const transcriptId = await createTranscript();
          const personId = await createPerson("Alice");
          const otherPersonId = await createPerson("Bob");
          const tenant = getTenantZeroId();
          await withRuntimePool(async (runtime, operations) => {
            let release!: () => void;
            let acquired!: () => void;
            const ready = new Promise<void>((resolve) => {
              acquired = resolve;
            });
            const gate = new Promise<void>((resolve) => {
              release = resolve;
            });
            let releaseLate = () => {};
            let lateReached = () => {};
            const lateGate = new Promise<void>((resolve) => {
              releaseLate = resolve;
            });
            const lateReady = new Promise<void>((resolve) => {
              lateReached = resolve;
            });
            operations.onCancel(release);
            operations.onCancel(releaseLate);
            let holderPid: number | undefined;
            let contenderPid: number | undefined;
            await withTenantTransaction(runtime, tenant, (client) =>
              insertValueLink(client, { itemId: transcriptId, propertyKey: "speakers", ruleKey: "test", sources: [] }),
            );
            const beforeJobs = await queuedJobKeys();
            const beforeLinks = await withTenantTransaction(runtime, tenant, (client) =>
              listValueLinksByItemIds(client, [transcriptId]),
            );
            const beforeSpeakers = await speakers(transcriptId);
            const events: InvalidationEvent[] = [];
            setInvalidationHook((event) => events.push(event));
            const holder = operations
              .run(() =>
                runInTenant(tenant, () =>
                  withTransaction(runtime, async (client) => {
                    holderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
                    await updateItemWithClient(client, {
                      databaseId: transcriptsId,
                      itemId: transcriptId,
                      propertiesPatch: { name: "Held" },
                    });
                    acquired();
                    await bounded(gate, 10000);
                  }),
                ),
              )
              .then(
                () => ({ ok: true as const }),
                (error: unknown) => ({ ok: false as const, error }),
              );
            let failure: { error: unknown } | undefined;
            let lateParticipant: Promise<unknown> | undefined;
            let restoreAdmission = () => {};
            try {
              await bounded(ready);
              const lock = await pool.query<{ held: boolean }>(
                `SELECT EXISTS (SELECT 1 FROM items i JOIN pg_locks l ON l.transactionid::text = i.xmax::text
             WHERE i.id = $1 AND l.pid = $2 AND l.locktype = 'transactionid' AND l.granted) AS held`,
                [transcriptId, holderPid],
              );
              expect(lock.rows[0]?.held).toBe(true);
              const attempt = (metadata: Record<string, unknown>, target = personId) =>
                operations.run(() =>
                  runInTenant(tenant, () =>
                    withTransaction(runtime, async (client) => {
                      contenderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
                        ?.pid;
                      return createRelationWithClient(
                        client,
                        {
                          relationPropertyId: speakersPropertyId,
                          callerItemId: transcriptId,
                          targetItemId: target,
                          metadata,
                        },
                        { ownerProcess: "valueLinks" },
                      );
                    }),
                  ),
                );
              const expectAttempt = async (metadata: Record<string, unknown>, expected: unknown, target = personId) => {
                const operation = attempt(metadata, target);
                const outcome = await bounded(operation).then(
                  (value) => ({ value }),
                  (error: unknown) => ({ error }),
                );
                expect(outcome).toMatchObject({ error: expected });
                if (!("error" in outcome)) throw new Error("Expected participant rejection");
                operations.consume(operation, outcome.error);
              };
              await expectAttempt({}, { status: 400, code: "validation_failed" });
              await expectAttempt(
                { speaker: "SPEAKER_01" },
                {
                  status: 409,
                  code: "value_link_busy",
                },
              );
              if (control === "late" || control === "late-undefined") {
                const actualLock = itemsStore.lockItemByIdNowait;
                const lockSpy = vi.spyOn(itemsStore, "lockItemByIdNowait").mockImplementation(async (...args) => {
                  lateReached();
                  await bounded(lateGate);
                  try {
                    return await actualLock(...args);
                  } catch (error) {
                    expect(error).toMatchObject({ code: "55P03" });
                    throwFailure(lateFailure);
                  }
                });
                restoreAdmission = () => lockSpy.mockRestore();
                lateParticipant = attempt({ speaker: "SPEAKER_01" });
                void lateParticipant.catch(() => {});
                await bounded(lateReady);
                expect(holderPid).toBeTypeOf("number");
                expect(contenderPid).toBeTypeOf("number");
                throwFailure(original);
              }
              if (control === "undefined") throwFailure(undefined);
              if (control === "combined") throwFailure(original);
              expect(holderPid).toBeTypeOf("number");
              expect(contenderPid).toBeTypeOf("number");
              expect(await speakers(transcriptId)).toEqual(beforeSpeakers);
              expect(
                await withTenantTransaction(runtime, tenant, (client) =>
                  listValueLinksByItemIds(client, [transcriptId]),
                ),
              ).toEqual(beforeLinks);
              expect(await queuedJobKeys()).toEqual(beforeJobs);
              expect(events).toEqual([]);
              release();
              requireSuccessful(await bounded(holder));
              events.length = 0;
              const edge = await bounded(attempt({ speaker: "SPEAKER_01" }));
              expect(edge.metadata).toEqual({ speaker: "SPEAKER_01" });
              expect((await speakers(transcriptId))[0]?.person?.id).toBe(personId);
              expect(
                await withTenantTransaction(runtime, tenant, (client) =>
                  listValueLinksByItemIds(client, [transcriptId]),
                ),
              ).toEqual(beforeLinks);
              expect(events).toEqual([
                {
                  scope: "relation",
                  databaseId: transcriptsId,
                  itemId: transcriptId,
                  propertyKey: "speakers",
                  op: "put",
                  userId: undefined,
                },
                {
                  scope: "relation",
                  databaseId: peopleId,
                  itemId: personId,
                  propertyKey: null,
                  op: "put",
                  userId: undefined,
                },
              ]);
              events.length = 0;
              // Issue #1652's search reindex jobs, keyed as `enqueueItemSearchReindex` keys them: the held
              // rename queued the transcript's referrers, the written edge both ends' documents. Nothing else
              // was queued, and the two refusals below must add nothing.
              const afterEdgeJobs = await queuedJobKeys();
              expect(afterEdgeJobs).toEqual(
                withReindexKeys(beforeJobs, [
                  `item-search-reindex:referrers:${transcriptId}:start`,
                  `item-search-reindex:item:${transcriptId}`,
                  `item-search-reindex:item:${personId}`,
                ]),
              );
              await expectAttempt(
                { speaker: "SPEAKER_99" },
                {
                  status: 400,
                  code: "validation_failed",
                  details: { reason: "unknownSpeaker" },
                },
                otherPersonId,
              );
              await expectAttempt(
                { speaker: "SPEAKER_01" },
                {
                  status: 400,
                  code: "validation_failed",
                  details: { reason: "speakerAlreadyMapped" },
                },
                otherPersonId,
              );
              expect((await speakers(transcriptId))[0]?.person?.id).toBe(personId);
              expect(await queuedJobKeys()).toEqual(afterEdgeJobs);
              expect(events).toEqual([]);
            } catch (error) {
              failure = { error };
            } finally {
              releaseLate();
              if (lateParticipant)
                await lateParticipant.then(
                  () => {},
                  () => {},
                );
              restoreAdmission();
              release();
              try {
                await operations.settle();
                requireSuccessful(await bounded(holder));
                if (control === "combined") throwFailure(cleanup);
              } catch (error) {
                failure = combineFailure(failure, [error], "Test and participant cleanup failed");
              }
              setInvalidationHook(() => {});
            }
            if (failure !== undefined) throwFailure(failure.error);
          });
        };
        if (control === "normal") return runControl();
        const result = await runControl().then(
          () => ({ rejected: false as const }),
          (error: unknown) => ({ rejected: true as const, error }),
        );
        expect(result.rejected).toBe(true);
        if (!result.rejected) throw new Error("Expected rejection");
        if (control === "undefined") expect(result.error).toBeUndefined();
        else {
          expect(result.error).toBeInstanceOf(AggregateError);
          if (!(result.error instanceof AggregateError)) throw new Error("Expected combined failure");
          expect(result.error.errors).toHaveLength(2);
          expect(result.error.errors[0]).toBe(original);
          expect(result.error.errors[1]).toBe(
            control === "late" || control === "late-undefined" ? lateFailure : cleanup,
          );
          expect(result.error.cause).toBe(original);
        }
      },
    );

    it("replaces a person's key by writing the edge again", async () => {
      const transcriptId = await createTranscript();
      const aliceId = await createPerson("Alice");
      await map(transcriptId, aliceId, { speaker: "SPEAKER_00" });

      const edge = await map(transcriptId, aliceId, { speaker: "SPEAKER_01" });

      expect(edge.metadata).toEqual({ speaker: "SPEAKER_01" });
      expect((await speakers(transcriptId)).map((entry) => entry.person?.id ?? null)).toEqual([aliceId, null]);
    });

    it("replaces a person's key through the metadata update", async () => {
      const transcriptId = await createTranscript();
      const aliceId = await createPerson("Alice");
      await map(transcriptId, aliceId, { speaker: "SPEAKER_00" });

      await chokePoint.updateRelation({
        relationPropertyId: speakersPropertyId,
        callerItemId: transcriptId,
        targetItemId: aliceId,
        metadata: { speaker: "SPEAKER_01" },
      });

      expect((await speakers(transcriptId)).map((entry) => entry.person?.id ?? null)).toEqual([aliceId, null]);
    });

    it("rejects a metadata update to a key another person holds", async () => {
      const transcriptId = await createTranscript();
      const aliceId = await createPerson("Alice");
      const bobId = await createPerson("Bob");
      await map(transcriptId, aliceId, { speaker: "SPEAKER_00" });
      await map(transcriptId, bobId, { speaker: "SPEAKER_01" });

      await expect(
        chokePoint.updateRelation({
          relationPropertyId: speakersPropertyId,
          callerItemId: transcriptId,
          targetItemId: aliceId,
          metadata: { speaker: "SPEAKER_01" },
        }),
      ).rejects.toMatchObject({ code: "validation_failed", details: { reason: "speakerAlreadyMapped" } });
    });

    it("refuses a key another person already holds, and accepts it once that mapping is removed", async () => {
      const transcriptId = await createTranscript();
      const aliceId = await createPerson("Alice");
      const bobId = await createPerson("Bob");
      await map(transcriptId, aliceId, { speaker: "SPEAKER_00" });

      await expect(map(transcriptId, bobId, { speaker: "SPEAKER_00" })).rejects.toMatchObject({
        code: "validation_failed",
        details: { field: "metadata", reason: "speakerAlreadyMapped", personId: aliceId },
      });

      await chokePoint.deleteRelation({
        relationPropertyId: speakersPropertyId,
        callerItemId: transcriptId,
        targetItemId: aliceId,
      });
      await map(transcriptId, bobId, { speaker: "SPEAKER_00" });

      expect((await speakers(transcriptId))[1]?.person).toEqual({ id: bobId, name: "Bob" });
    });

    it("removes a mapping, leaving the key unmapped", async () => {
      const transcriptId = await createTranscript();
      const aliceId = await createPerson("Alice");
      await map(transcriptId, aliceId, { speaker: "SPEAKER_00" });

      await chokePoint.deleteRelation({
        relationPropertyId: speakersPropertyId,
        callerItemId: transcriptId,
        targetItemId: aliceId,
      });

      expect((await speakers(transcriptId)).every((entry) => entry.person === null)).toBe(true);
      expect(await readSegments(transcriptId)).toEqual(SEGMENTS);
    });

    it.each([
      ["no metadata", undefined],
      ["an empty speaker", { speaker: "" }],
      ["a non-string speaker", { speaker: 0 }],
      ["an extra key", { speaker: "SPEAKER_00", confidence: 1 }],
    ])("rejects %s with validation_failed on metadata", async (_label, metadata) => {
      const transcriptId = await createTranscript();
      const aliceId = await createPerson("Alice");

      await expect(map(transcriptId, aliceId, metadata)).rejects.toMatchObject({
        code: "validation_failed",
        details: { field: "metadata" },
      });
    });

    it("rejects a key no segment carries, including every key before segments exist", async () => {
      const transcriptId = await createTranscript();
      const unmergedId = await createTranscript(null);
      const aliceId = await createPerson("Alice");

      for (const id of [transcriptId, unmergedId]) {
        await expect(map(id, aliceId, { speaker: "SPEAKER_07" })).rejects.toMatchObject({
          code: "validation_failed",
          details: { field: "metadata", reason: "unknownSpeaker" },
        });
      }
    });

    it("keeps a system-owned speakers relation's owner_violation for add and remove", async () => {
      const transcriptId = await createTranscript();
      const aliceId = await createPerson("Alice");
      await map(transcriptId, aliceId, { speaker: "SPEAKER_00" });
      await pool.query("UPDATE properties SET owner = 'system', owner_process = 'someProcess' WHERE id = $1", [
        speakersPropertyId,
      ]);

      await expect(map(transcriptId, aliceId, { speaker: "SPEAKER_01" })).rejects.toMatchObject({
        code: "owner_violation",
      });
      await expect(
        chokePoint.deleteRelation({
          relationPropertyId: speakersPropertyId,
          callerItemId: transcriptId,
          targetItemId: aliceId,
        }),
      ).rejects.toMatchObject({ code: "owner_violation" });
    });

    it("rejects a target outside People with validation_failed on targetItemId", async () => {
      const transcriptId = await createTranscript();
      const otherTranscriptId = await createTranscript();

      await expect(map(transcriptId, otherTranscriptId, { speaker: "SPEAKER_00" })).rejects.toMatchObject({
        code: "validation_failed",
        details: { field: "targetItemId" },
      });
    });

    it("leaves other relations' metadata unconstrained", async () => {
      const eventsId = await databaseIdFor("events");
      const peoplePropertyId = await propertyIdFor(eventsId, "people");
      const eventId = (
        await withTransaction(pool, (client) =>
          createItemWithClient(client, { databaseId: eventsId, properties: { name: "Sync" } }),
        )
      ).id;
      const aliceId = await createPerson("Alice");

      const edge = await chokePoint.createRelation({
        relationPropertyId: peoplePropertyId,
        callerItemId: eventId,
        targetItemId: aliceId,
        metadata: { anything: true },
      });

      expect(edge.metadata).toEqual({ anything: true });
    });
  });

  describe("GET /api/transcripts/:id/speakers", () => {
    function get(id: string, locale: string) {
      return createTranscriptSpeakersRouteHandler(pool)({ params: { id }, identity: { user: { locale } } });
    }

    it("labels unmapped keys 'Speaker N' in English and 'Mluvčí N' in Czech, and mapped keys by name", async () => {
      const transcriptId = await createTranscript();
      const aliceId = await createPerson("Alice");
      await map(transcriptId, aliceId, { speaker: "SPEAKER_00" });

      expect(await get(transcriptId, "en")).toEqual({
        status: 200,
        body: {
          speakers: [
            { speaker: "SPEAKER_01", label: "Speaker 1", personId: null },
            { speaker: "SPEAKER_00", label: "Alice", personId: aliceId },
          ],
        },
      });
      expect(await get(transcriptId, "cs")).toMatchObject({
        body: { speakers: [{ label: "Mluvčí 1" }, { label: "Alice" }] },
      });
    });

    it("labels a mapped person with no name by the key's ordinal", async () => {
      const transcriptId = await createTranscript();
      const namelessId = await createPerson("");
      await map(transcriptId, namelessId, { speaker: "SPEAKER_00" });

      expect(await get(transcriptId, "en")).toMatchObject({
        body: { speakers: [{ label: "Speaker 1" }, { label: "Speaker 2", personId: namelessId }] },
      });
    });

    it("rejects a non-UUID id with validation_failed before any query", async () => {
      await expect(get("not-a-uuid", "en")).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects an unknown transcript with not_found", async () => {
      await expect(get("00000000-0000-0000-0000-000000000000", "en")).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
