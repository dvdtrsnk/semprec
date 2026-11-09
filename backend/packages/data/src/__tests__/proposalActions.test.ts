import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { readPageBlocks, writeBlock, type BlockInput } from "@semprec/block-model";
import "../domainWriteHooks.js";
import { DateTime } from "luxon";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { getSystemSettingsDatabaseId, getSystemSettingsItemId, getSystemTimezone } from "../systemSettings.js";
import { createRuntimeRolePool, getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { runInTenant } from "@semprec/shared";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createPool, withTransaction } from "../db/pool.js";
import { runMigrations } from "../db/migrate.js";
import { ConflictError, ValidationError } from "../errors.js";
import { randomUUID } from "node:crypto";
import { createItemWithClient, prepareUserItemPatch, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { prepareComputedUpdates } from "../inbox/proposalComputedUpdates.js";
import { createInboxTypeWithClient } from "../inbox/inboxTypesStore.js";
import { createMarkdownPageContentProposal } from "../testSupport/pageProposalFixtures.js";
import {
  appendHistoryEntry,
  assertValidProposalEnvelope,
  createSemprecTickAction,
  parseStoredProposalEnvelope,
  type ComputeSemprecProposalFn,
  type ProposalEnvelope,
} from "../inbox/inboxTickAction.js";
import {
  confirmProposalWithClient,
  rejectProposalWithClient,
  reviseProposalWithClient,
} from "../inbox/proposalActions.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { insertValueLink, listValueLinksByItemIds } from "../chokePoint/valueLinksStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { createDocStore, type DocStore } from "../docs/docStore.js";
import { loadDoc, mutateDoc } from "../docs/docPersistence.js";
import { createSubpageWithClient } from "../docs/pageOperations.js";
import { proposalBlockId } from "../inbox/proposalPageContent.js";
import { listPageChanges } from "../docs/pageChanges.js";
import { matchTranscriptToEvent } from "../transcription/transcriptEventMatch.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcription/transcriptionJob.js";

let pool: Pool;
let viewTypeRegistry: ViewTypeRegistry;
let docStore: DocStore;

// pg 8.23.0 reports these two finite owned-release paths with plain, uncoded errors.
function isOwnedPgClosure(
  error: unknown,
  message: "Connection terminated" | "Client was closed and is not queryable",
): boolean {
  return error instanceof Error && error.constructor === Error && !("code" in error) && error.message === message;
}

/** Owns only this overlap's runtime clients, gates and operations. */
function ownOverlap(
  runtime: Pool,
  cancel: () => void,
  onCancellation?: (client: PoolClient, generation: object) => void,
  onGeneration?: (client: PoolClient, generation: object) => void,
  onReleased?: (client: PoolClient, generation: object) => void,
) {
  runtime.options.connectionTimeoutMillis = 2500;
  runtime.options.statement_timeout = 5000;
  runtime.options.query_timeout = 7000;
  const active = new Map<PoolClient, object>();
  const destroyed = new Set<object>();
  const retired = new Set<PoolClient>();
  const tasks = new Set<Promise<void>>();
  const outcomes: Array<{ error?: { value: unknown }; consumed: boolean }> = [];
  const outcomeByOperation = new WeakMap<Promise<unknown>, (typeof outcomes)[number]>();
  const errors: unknown[] = [];
  let closing = false;
  let expired = false;
  let closingPromise: Promise<void> | undefined;
  let settledCleanup = false;
  const onClientError = (error: Error) => errors.push(error);
  const destroy = (client: PoolClient, token: object) => {
    if (active.get(client) !== token) return;
    try {
      onCancellation?.(client, token);
      destroyed.add(token);
      client.release(true);
      onReleased?.(client, token);
    } catch (error) {
      errors.push(error);
    }
  };
  const onAcquire = (client: PoolClient) => {
    const token = {};
    active.set(client, token);
    onGeneration?.(client, token);
    client.on("error", onClientError);
    // pg-pool 3.14 assigns release after the acquire event.
    if (closing) queueMicrotask(() => destroy(client, token));
  };
  const onRelease = (_error: Error | undefined, client: PoolClient) => {
    const generation = active.get(client);
    active.delete(client);
    if (generation && destroyed.has(generation)) retired.add(client);
    else client.removeListener("error", onClientError);
  };
  runtime.on("acquire", onAcquire);
  runtime.on("release", onRelease);
  const run = <T>(start: () => Promise<T>): Promise<T> => {
    const operation = Promise.resolve().then(() => {
      if (closing) throw new Error("Overlap is closing");
      return start();
    });
    const outcome: { error?: { value: unknown }; consumed: boolean } = { consumed: false };
    outcomes.push(outcome);
    outcomeByOperation.set(operation, outcome);
    const settled = operation.then(
      () => {},
      (error: unknown) => {
        outcome.error = { value: error };
      },
    );
    tasks.add(settled);
    void settled.then(() => tasks.delete(settled));
    return operation;
  };
  const wait = <T>(signal: Promise<T>, ...actors: Promise<unknown>[]): Promise<T> =>
    overlapBounded(
      Promise.race([
        signal,
        ...actors.map((actor) =>
          actor.then(
            () => {
              throw new Error("Overlap participant completed before its barrier");
            },
            (error: unknown) => {
              throw error;
            },
          ),
        ),
      ]),
      5000,
    );
  const finish = (bodyFailed = false): Promise<void> => {
    if (closingPromise) return closingPromise;
    closing = true;
    clearTimeout(timer);
    const detach = () => {
      runtime.removeListener("acquire", onAcquire);
      runtime.removeListener("release", onRelease);
      for (const client of retired) client.removeListener("error", onClientError);
      retired.clear();
      settledCleanup = true;
    };
    closingPromise = (async () => {
      if (!bodyFailed) {
        try {
          const deadline = Date.now() + 3000;
          while (tasks.size > 0 || active.size > 0 || runtime.waitingCount > 0) {
            if (Date.now() >= deadline) throw new Error("Overlap returned with owned work pending");
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        cancel();
      } catch (error) {
        errors.push(error);
      }
      for (const [client, token] of active) destroy(client, token);
      const end = runtime.end();
      const joined = (async () => {
        const results = await Promise.allSettled([end, ...tasks]);
        for (const result of results) if (result.status === "rejected") errors.push(result.reason);
        while (tasks.size > 0) await Promise.all([...tasks]);
        for (const outcome of outcomes) {
          if (outcome.error !== undefined && !outcome.consumed) errors.push(outcome.error.value);
        }
        const deadline = Date.now() + 3000;
        while (runtime.waitingCount > 0) {
          if (Date.now() >= deadline) throw new Error("Overlap pool waiters did not settle");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })();
      try {
        await overlapBounded(joined, 8000);
        detach();
      } catch (error) {
        errors.push(error);
        // Only an unestablished driver/host stall reaches this failure fallback.
        void joined.then(detach, detach);
      }
      if (expired) errors.unshift(new Error("Overlap timed out"));
      if (errors.length) throw new AggregateError(errors, "Overlap cleanup failed", { cause: errors[0] });
    })();
    return closingPromise;
  };
  const timer = setTimeout(() => {
    expired = true;
    void finish(true).catch(() => {});
  }, 8000);
  const consume = (operation: Promise<unknown>, expected: unknown): void => {
    const outcome = outcomeByOperation.get(operation);
    if (!outcome?.error || outcome.error.value !== expected) throw new Error("Unexpected participant outcome");
    outcome.consumed = true;
  };
  return { run, wait, finish, consume, isSettled: () => settledCleanup };
}

async function overlapBounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Overlap cleanup timed out")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function combineOverlapFailure(body: { error: unknown } | undefined, cleanup: unknown): { error: unknown } {
  return {
    error:
      body === undefined
        ? cleanup
        : new AggregateError([body.error, cleanup], "Overlap and cleanup failed", { cause: body.error }),
  };
}

function rethrowOverlap(error: unknown): never {
  // Preserve even non-Error thrown identities from the tested operation.
  throw error;
}

async function assertItemHeld(itemId: string, pid: number, observer: Pool): Promise<void> {
  const result = await observer.query<{ held: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM items i JOIN pg_locks l ON l.transactionid::text = i.xmax::text
       WHERE i.id = $1 AND l.pid = $2 AND l.locktype = 'transactionid' AND l.granted) AS held`,
    [itemId, pid],
  );
  expect(result.rows[0]?.held).toBe(true);
}

async function assertDefinitionHeld(definitionId: string, pid: number, observer: Pool): Promise<void> {
  const result = await observer.query<{ held: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND granted
       AND classid::bigint = ((hashtextextended($2::text, 0) >> 32) & 4294967295::bigint)
       AND objid::bigint = (hashtextextended($2::text, 0) & 4294967295::bigint) AND objsubid = 1) AS held`,
    [pid, definitionId],
  );
  expect(result.rows[0]?.held).toBe(true);
}

async function assertEdgeHeld(
  definitionId: string,
  itemA: string,
  itemB: string,
  pid: number,
  observer: Pool,
): Promise<void> {
  const result = await observer.query<{ held: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM item_relations e JOIN pg_locks l ON l.transactionid::text = e.xmax::text
       WHERE e.relation_definition_id = $1 AND ((e.item_a = $2 AND e.item_b = $3) OR (e.item_a = $3 AND e.item_b = $2))
       AND l.pid = $4 AND l.locktype = 'transactionid' AND l.granted) AS held`,
    [definitionId, itemA, itemB, pid],
  );
  expect(result.rows[0]?.held).toBe(true);
}

async function runPreconditionOverlap<A, B>(
  holderOperation: (client: PoolClient) => Promise<A>,
  contenderOperation: (client: PoolClient) => Promise<B>,
  assertHeld: (pid: number, observer: Pool) => Promise<void>,
  assertOutcomes?: (outcomes: [PromiseSettledResult<A>, PromiseSettledResult<B>]) => void,
): Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]> {
  const runtime = getTestPool({ max: 3 });
  let release = () => {};
  let holderReady = (_pid: number) => {};
  let contenderReady = (_pid: number) => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = new Promise<number>((resolve) => {
    holderReady = resolve;
  });
  const competing = new Promise<number>((resolve) => {
    contenderReady = resolve;
  });
  const owned = ownOverlap(runtime, release);
  let failure: { error: unknown } | undefined;
  let result: [PromiseSettledResult<A>, PromiseSettledResult<B>] | undefined;
  try {
    const holder = owned.run(() =>
      withTransaction(runtime, async (client) => {
        const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
        if (pid === undefined) throw new Error("Missing holder PID");
        const value = await holderOperation(client);
        holderReady(pid);
        await gate;
        return value;
      }),
    );
    const holderPid = await owned.wait(held, holder);
    await owned.wait(
      owned.run(() => assertHeld(holderPid, runtime)),
      holder,
    );
    const contender = owned.run(() =>
      withTransaction(runtime, async (client) => {
        const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
        if (pid === undefined) throw new Error("Missing contender PID");
        contenderReady(pid);
        return contenderOperation(client);
      }),
    );
    const contenderPid = await owned.wait(competing, holder, contender);
    await owned.wait(
      owned.run(() =>
        expect
          .poll(
            async () => {
              const rows = await runtime.query<{ blocked: boolean }>(
                "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
                [holderPid, contenderPid],
              );
              return rows.rows[0]?.blocked;
            },
            { timeout: 5000 },
          )
          .toBe(true),
      ),
      holder,
      contender,
    );
    release();
    result = await Promise.allSettled([holder, contender]);
    if (assertOutcomes) {
      assertOutcomes(result);
      if (result[0].status === "rejected") owned.consume(holder, result[0].reason);
      if (result[1].status === "rejected") owned.consume(contender, result[1].reason);
    }
  } catch (error) {
    failure = { error };
  } finally {
    release();
    try {
      await owned.finish(failure !== undefined);
    } catch (error) {
      failure = combineOverlapFailure(failure, error);
    }
  }
  if (failure) rethrowOverlap(failure.error);
  if (!result) throw new Error("Missing overlap outcomes");
  return result;
}

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

/** The authors of a page document's updates, oldest first. */
async function docUpdateAuthors(itemId: string): Promise<string[]> {
  const { rows } = await pool.query<{ created_by: string }>(
    `SELECT u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1 ORDER BY u.id`,
    [itemId],
  );
  return rows.map((row) => row.created_by);
}

/** The block ids a confirmed card's primary result lists. */
function resultBlockIds(confirmed: { properties: Record<string, unknown> }): string[] {
  const results = z
    .array(z.object({ role: z.string(), blockIds: z.array(z.string()) }))
    .parse(confirmed.properties.results);
  return results.find((result) => result.role === "primary")?.blockIds ?? [];
}

describe("Processing proposal confirm/reject/revise (issue #105)", () => {
  let inboxId: string;
  let typesId: string;
  let proposalsId: string;
  let tasksId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    docStore = createDocStore(pool);
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    inboxId = await databaseIdFor("inbox");
    typesId = await databaseIdFor("inboxItemTypes");
    proposalsId = await databaseIdFor("processingProposals");
    tasksId = await databaseIdFor("tasks");
  });

  it.each([undefined, { marker: "late" }])(
    "retains a late participant failure and consumes only the asserted participant %#",
    async (late) => {
      const runtime = getTestPool({ max: 3 });
      let release = () => {};
      let started = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const owned = ownOverlap(runtime, release);
      const expected = { marker: "asserted" };
      const body = new Error("forced observation failure");
      let lateSettled = false;
      let failure: { error: unknown } | undefined;
      try {
        const negative = owned.run(() =>
          withTransaction(runtime, async (client) => {
            await client.query<{ "?column?": number }>("SELECT 1");
            rethrowOverlap(expected);
          }),
        );
        await expect(negative).rejects.toBe(expected);
        owned.consume(negative, expected);
        const participant = owned.run(() =>
          withTransaction(runtime, async (client) => {
            const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
            if (!pid) throw new Error("Missing owned PID");
            started();
            await gate;
            rethrowOverlap(late);
          }),
        );
        void participant.then(
          () => {
            lateSettled = true;
          },
          () => {
            lateSettled = true;
          },
        );
        await owned.wait(ready, participant);
        throw body;
      } catch (error) {
        failure = { error };
      } finally {
        try {
          await owned.finish(failure !== undefined);
        } catch (error) {
          failure = combineOverlapFailure(failure, error);
        }
      }
      if (failure && (!(failure.error instanceof AggregateError) || failure.error.cause !== body)) {
        rethrowOverlap(failure.error);
      }
      const combined = failure?.error;
      expect(combined).toBeInstanceOf(AggregateError);
      if (!(combined instanceof AggregateError)) throw new Error("Expected combined failure");
      expect(combined.cause).toBe(body);
      expect(combined.errors[0]).toBe(body);
      const cleanup: unknown = combined.errors[1];
      expect(cleanup).toBeInstanceOf(AggregateError);
      if (!(cleanup instanceof AggregateError)) throw new Error("Expected cleanup failure");
      expect(combined.errors).toHaveLength(2);
      expect(cleanup.errors).toHaveLength(1);
      expect(cleanup.errors[0]).toBe(late);
      expect(cleanup.cause).toBe(late);
      expect(lateSettled).toBe(true);
      expect(runtime.ended).toBe(true);
      expect(runtime.totalCount).toBe(0);
      expect(runtime.listenerCount("acquire")).toBe(0);
      expect(runtime.listenerCount("release")).toBe(0);
    },
    20000,
  );

  it("settles ownership when the first participant has the wrong rejection", async () => {
    const runtime = getTestPool({ max: 3 });
    const wrong = { marker: "wrong" };
    const expected = { marker: "expected" };
    const cleanupError = new Error("controlled cleanup failure");
    const owned = ownOverlap(runtime, () => {
      throw cleanupError;
    });
    let assertion: { error: unknown } | undefined;
    let failure: { error: unknown } | undefined;
    try {
      const negative = owned.run(() =>
        withTransaction(runtime, async (client) => {
          await client.query<{ "?column?": number }>("SELECT 1");
          rethrowOverlap(wrong);
        }),
      );
      try {
        await expect(negative).rejects.toBe(expected);
      } catch (error) {
        assertion = { error };
        throw error;
      }
      owned.consume(negative, expected);
    } catch (error) {
      failure = { error };
    } finally {
      try {
        await owned.finish(failure !== undefined);
      } catch (error) {
        failure = combineOverlapFailure(failure, error);
      }
    }
    if (!assertion) throw new Error("Expected assertion failure");
    const combined = failure?.error;
    expect(combined).toBeInstanceOf(AggregateError);
    if (!(combined instanceof AggregateError)) throw new Error("Expected combined failure");
    expect(combined.errors).toHaveLength(2);
    expect(combined.errors[0]).toBe(assertion.error);
    expect(combined.cause).toBe(assertion.error);
    const cleanup: unknown = combined.errors[1];
    expect(cleanup).toBeInstanceOf(AggregateError);
    if (!(cleanup instanceof AggregateError)) throw new Error("Expected cleanup failure");
    expect(cleanup.errors).toHaveLength(2);
    expect(cleanup.errors[0]).toBe(cleanupError);
    expect(cleanup.errors[1]).toBe(wrong);
    expect(cleanup.cause).toBe(cleanupError);
    expect(runtime.ended).toBe(true);
    expect(runtime.totalCount).toBe(0);
    expect(runtime.waitingCount).toBe(0);
    expect(runtime.listenerCount("acquire")).toBe(0);
    expect(runtime.listenerCount("release")).toBe(0);
  }, 20000);

  it("preserves an early checkout failure together with cleanup failure", async () => {
    const runtime = getTestPool({ max: 3 });
    const actorError = new Error("pre-verify checkout failure");
    const cleanupError = new Error("cleanup failure");
    let release = () => {};
    const signal = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.options.verify = (_client, done) => done(actorError);
    const generations = new Map<PoolClient, object>();
    const cancellationRequests = new Set<object>();
    const owned = ownOverlap(
      runtime,
      () => {
        release();
        throw cleanupError;
      },
      (_client, generation) => {
        cancellationRequests.add(generation);
      },
      (client, generation) => {
        generations.set(client, generation);
      },
    );
    let operationFailure: { value: unknown } | undefined;
    const observedDiagnostics: Array<{ error: Error; generation: object; cancelled: boolean; operation: "checkout" }> =
      [];
    const observing = new Map<PoolClient, (error: Error) => void>();
    const observeAcquire = (client: PoolClient) => {
      const generation = generations.get(client);
      if (!generation) throw new Error("Missing client generation");
      const onError = (error: Error) =>
        observedDiagnostics.push({
          error,
          generation,
          cancelled: cancellationRequests.has(generation),
          operation: "checkout",
        });
      observing.set(client, onError);
      client.on("error", onError);
    };
    const observeRelease = (_reason: unknown, client: PoolClient) => {
      const onError = observing.get(client);
      const generation = generations.get(client);
      if (generation && cancellationRequests.has(generation)) return;
      if (onError) client.removeListener("error", onError);
      observing.delete(client);
      generations.delete(client);
    };
    runtime.on("acquire", observeAcquire);
    runtime.on("release", observeRelease);
    let failure: { error: unknown } | undefined;
    try {
      const actor = owned.run(() => withTransaction(runtime, async () => {}));
      void actor.catch((error: unknown) => {
        operationFailure = { value: error };
      });
      await owned.wait(signal, actor);
    } catch (error) {
      failure = { error };
    } finally {
      try {
        await owned.finish(failure !== undefined);
      } catch (error) {
        failure = combineOverlapFailure(failure, error);
      }
    }
    if (!owned.isSettled()) {
      if (failure) throw failure.error;
      throw new Error("Owned overlap did not settle");
    }
    runtime.removeListener("acquire", observeAcquire);
    runtime.removeListener("release", observeRelease);
    for (const [client, onError] of observing) client.removeListener("error", onError);
    observing.clear();
    expect(observing.size).toBe(0);
    const observed = failure?.error;
    expect(observed).toBeInstanceOf(AggregateError);
    if (!(observed instanceof AggregateError)) throw new Error("Expected combined error");
    expect(observed.cause).toBe(actorError);
    expect(observed.errors[0]).toBe(actorError);
    expect(observed.errors).toHaveLength(2);
    const cleanup: unknown = observed.errors[1];
    expect(cleanup).toBeInstanceOf(AggregateError);
    if (!(cleanup instanceof AggregateError)) throw new Error("Expected cleanup aggregate");
    expect(operationFailure).toBeDefined();
    if (!operationFailure) throw new Error("Missing operation failure");
    expect(operationFailure.value).toBe(actorError);
    for (const diagnostic of observedDiagnostics) {
      expect(diagnostic.cancelled).toBe(true);
      expect(diagnostic.operation).toBe("checkout");
      expect(diagnostic.error).toBe(operationFailure.value);
    }
    const expectedErrors = [cleanupError, ...observedDiagnostics.map((entry) => entry.error), operationFailure.value];
    expect(cleanup.errors).toHaveLength(expectedErrors.length);
    for (let i = 0; i < expectedErrors.length; i++) expect(cleanup.errors[i]).toBe(expectedErrors[i]);
    expect(cleanup.cause).toBe(cleanupError);
    expect(runtime.ended).toBe(true);
    expect(runtime.totalCount).toBe(0);
    expect(runtime.waitingCount).toBe(0);
    expect(runtime.listenerCount("acquire")).toBe(0);
    expect(runtime.listenerCount("release")).toBe(0);
  }, 20000);

  it.each([false, true])(
    "settles late overlap checkout and preserves a simultaneous cleanup failure (post-release %s)",
    async (injectPostCancel) => {
      const runtime = getTestPool({ max: 3 });
      let deliver = () => {};
      let ready = () => {};
      const verifying = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const bodyError = new Error("body failure");
      const cleanupError = new Error("cleanup failure");
      let ran = false;
      let settled = false;
      const postCancel = new Error("unrelated post-release checkout diagnostic");
      let releaseCallbackFailure: { value: unknown } | undefined;
      let checkoutGeneration: object | undefined;
      runtime.options.verify = (client, done) => {
        checkoutGeneration = generations.get(client);
        deliver = () => queueMicrotask(() => done());
        ready();
      };
      const generations = new Map<PoolClient, object>();
      const cancellationRequests = new Set<object>();
      const releaseCompletions = new Set<object>();
      const owned = ownOverlap(
        runtime,
        () => {
          deliver();
          throw cleanupError;
        },
        (_client, generation) => {
          cancellationRequests.add(generation);
        },
        (client, generation) => {
          generations.set(client, generation);
        },
        (client, generation) => {
          releaseCompletions.add(generation);
          if (injectPostCancel) {
            try {
              client.emit("error", postCancel);
            } catch (error) {
              releaseCallbackFailure = { value: error };
              throw error;
            }
          }
        },
      );
      const operation = owned.run(() =>
        withTransaction(runtime, async () => {
          ran = true;
        }),
      );
      void operation.then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          operationFailure = {
            value: error,
            generation: checkoutGeneration,
            cancelled: checkoutGeneration !== undefined && cancellationRequests.has(checkoutGeneration),
          };
          settled = true;
        },
      );
      let operationFailure: { value: unknown; generation: object | undefined; cancelled: boolean } | undefined;
      const observedDiagnostics: Array<{
        error: Error;
        generation: object;
        cancelled: boolean;
        released: boolean;
        operation: "checkout";
      }> = [];
      const observing = new Map<PoolClient, (error: Error) => void>();
      const observeAcquire = (client: PoolClient) => {
        const generation = generations.get(client);
        if (!generation) throw new Error("Missing client generation");
        const onError = (error: Error) =>
          observedDiagnostics.push({
            error,
            generation,
            cancelled: cancellationRequests.has(generation),
            released: releaseCompletions.has(generation),
            operation: "checkout",
          });
        observing.set(client, onError);
        client.on("error", onError);
      };
      const observeRelease = (_reason: unknown, client: PoolClient) => {
        const onError = observing.get(client);
        const generation = generations.get(client);
        if (generation && cancellationRequests.has(generation)) return;
        if (onError) client.removeListener("error", onError);
        observing.delete(client);
        generations.delete(client);
      };
      runtime.on("acquire", observeAcquire);
      runtime.on("release", observeRelease);
      let failure: { error: unknown } | undefined;
      try {
        await owned.wait(verifying, operation);
        failure = { error: bodyError };
      } catch (error) {
        failure = { error };
      } finally {
        try {
          await owned.finish(true);
        } catch (error) {
          failure = combineOverlapFailure(failure, error);
        }
      }
      if (!owned.isSettled()) {
        if (failure) throw failure.error;
        throw new Error("Owned overlap did not settle");
      }
      runtime.removeListener("acquire", observeAcquire);
      runtime.removeListener("release", observeRelease);
      for (const [client, onError] of observing) client.removeListener("error", onError);
      observing.clear();
      expect(observing.size).toBe(0);
      const observed = failure?.error;
      expect(observed).toBeInstanceOf(AggregateError);
      if (!(observed instanceof AggregateError)) throw new Error("Expected combined failure");
      expect(observed.cause).toBe(bodyError);
      expect(observed.errors[0]).toBe(bodyError);
      expect(observed.errors).toHaveLength(2);
      const cleanup: unknown = observed.errors[1];
      expect(cleanup).toBeInstanceOf(AggregateError);
      if (!(cleanup instanceof AggregateError)) throw new Error("Expected cleanup aggregate");
      expect(operationFailure).toBeDefined();
      if (!operationFailure) throw new Error("Missing operation failure");
      expect(operationFailure.generation).toBeDefined();
      expect(operationFailure.cancelled).toBe(true);
      expect(isOwnedPgClosure(operationFailure.value, "Client was closed and is not queryable")).toBe(true);
      expect(
        isOwnedPgClosure(new Error("unrelated post-cancel failure"), "Client was closed and is not queryable"),
      ).toBe(false);
      for (const diagnostic of observedDiagnostics) {
        expect(diagnostic.cancelled).toBe(true);
        expect(diagnostic.operation).toBe("checkout");
        if (diagnostic.error === postCancel) {
          expect(diagnostic.released).toBe(true);
          expect(injectPostCancel).toBe(true);
          expect(isOwnedPgClosure(diagnostic.error, "Client was closed and is not queryable")).toBe(false);
        } else expect(diagnostic.error).toBe(operationFailure.value);
      }
      expect(observedDiagnostics.filter((entry) => entry.error === postCancel)).toHaveLength(injectPostCancel ? 1 : 0);
      if (releaseCallbackFailure) expect(releaseCallbackFailure.value).toBe(postCancel);
      const expectedErrors = [
        cleanupError,
        ...observedDiagnostics.flatMap((entry) =>
          entry.error === postCancel && releaseCallbackFailure
            ? [entry.error, releaseCallbackFailure.value]
            : [entry.error],
        ),
        operationFailure.value,
      ];
      expect(cleanup.errors).toHaveLength(expectedErrors.length);
      for (let i = 0; i < expectedErrors.length; i++) expect(cleanup.errors[i]).toBe(expectedErrors[i]);
      expect(cleanup.cause).toBe(cleanupError);
      expect(ran).toBe(false);
      expect(settled).toBe(true);
      expect(runtime.ended).toBe(true);
      expect(runtime.totalCount).toBe(0);
      expect(runtime.waitingCount).toBe(0);
      expect(runtime.listenerCount("acquire")).toBe(0);
      expect(runtime.listenerCount("release")).toBe(0);
    },
    20000,
  );

  async function findProposalForItem(itemId: string) {
    return withTransaction(pool, async (client) => {
      const sourceInboxProperty = await propertiesStore.getPropertyByKey(client, proposalsId, "sourceInbox");
      const relationDefinition = await relationsStore.getRelationDefinitionByPropertyId(
        client,
        sourceInboxProperty!.id,
      );
      const edges = await relationsStore.listRelationsForItem(client, relationDefinition!.id, itemId);
      if (edges.length === 0) return null;
      const proposalItemId = relationsStore.otherSide(edges[0]!, itemId);
      return itemsStore.getItemById(client, proposalsId, proposalItemId);
    });
  }

  async function runTick(itemId: string, computeProposal: ComputeSemprecProposalFn): Promise<void> {
    const handler = createSemprecTickAction(pool, computeProposal);
    await handler(
      { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
      { heartbeatId: "hb", projectItemId: "proj", itemId },
    );
  }

  async function createDatabaseProposal(text = "Buy milk") {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Task",
        emoji: "☑️",
        processingMethod: "database",
        targetDatabase: "tasks",
      }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text,
        type: type.id,
      }),
    );
    await runTick(item.id, async () => ({ properties: { name: text } }));
    return (await findProposalForItem(item.id))!;
  }

  async function createPageContentProposal(text = "A thought") {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Thought",
        emoji: "💭",
        processingMethod: "pageContent",
      }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text,
        type: type.id,
      }),
    );
    // The Inbox item type itself stands in for a "page" target here — confirm only needs an existing item id.
    await runTick(item.id, async () => ({
      target: type.id,
      properties: { flavour: "paragraph", fields: { content: text } },
    }));
    return { proposal: (await findProposalForItem(item.id))!, targetPageId: type.id };
  }

  it("confirm on a 'database' proposal creates the target item, locks confirmed, and records resultItemId/resultLabel", async () => {
    const proposal = await createDatabaseProposal("Buy milk");

    const confirmed = await withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );

    expect(confirmed.properties.status).toBe("confirmed");
    expect(typeof confirmed.properties.resultItemId).toBe("string");
    expect(confirmed.properties.resultLabel).toBe("Buy milk");
    const history = confirmed.properties.history as Array<Record<string, unknown>>;
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({ author: "user" });

    const createdTask = await withTransaction(pool, (client) =>
      itemsStore.getItemById(client, tasksId, confirmed.properties.resultItemId as string),
    );
    expect(createdTask).toBeTruthy();
    expect(createdTask!.properties.name).toBe("Buy milk");
  });

  it("writes one editable Inbox origin paragraph on a created item", async () => {
    const proposal = await createDatabaseProposal("Buy milk");
    const confirmed = await withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );
    const itemId = z.string().parse(confirmed.properties.resultItemId);
    const first = await docStore.readPageMarkdown(itemId);
    expect(first.markdown).toBe("Vytvořeno ze schránky: Buy milk");
    await withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );
    expect((await docStore.readPageMarkdown(itemId)).markdown).toBe(first.markdown);
    const blocks = await docStore.listBlocks(itemId);
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (!block) throw new Error("Missing origin block");
    await docStore.deleteBlock(itemId, z.string().parse(block["sys:id"]), "user");
    expect((await docStore.readPageMarkdown(itemId)).markdown).toBe("");
    await withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );
    expect((await docStore.readPageMarkdown(itemId)).markdown).toBe("");
  });

  it("confirm is idempotent under retry: a second confirm does not create a second target item", async () => {
    const proposal = await createDatabaseProposal("Buy milk");

    const first = await withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );
    const second = await withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );

    expect(second.properties.resultItemId).toBe(first.properties.resultItemId);
    expect(second.updatedAt).toBe(first.updatedAt);

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [tasksId]);
    expect(rows[0].n).toBe(1);
  });

  it("revises a Markdown proposal and then confirms it into the page as the user, through the runtime role", async () => {
    const proposal = await createDatabaseProposal("Page proposal");
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const tenant = getTenantZeroId();
      const projectsId = await databaseIdFor("projects");
      const project = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          createItemWithClient(client, { databaseId: projectsId, properties: { name: "Project" } }),
        ),
      );
      const revise = (properties: Record<string, unknown>) =>
        runInTenant(tenant, () =>
          withTransaction(runtime, (client) =>
            reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
              message: "Revise",
              entityKind: "pageContent",
              target: project.id,
              properties,
            }),
          ),
        );
      const revised = await revise({ markdown: "Hello", placement: "end" });
      expect(revised.properties.proposal).toMatchObject({
        entityKind: "pageContent",
        target: project.id,
        properties: { markdown: "Hello", placement: "end" },
      });
      await expect(revise({ markdown: " ", placement: "end" })).rejects.toMatchObject({
        status: 400,
        details: { field: "properties" },
      });
      const docsBefore = await runInTenant(tenant, () =>
        runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM docs WHERE item_id = $1", [project.id]),
      );
      expect(docsBefore.rows).toEqual([{ count: 0 }]);
      // Issue #1681 replaced the earlier 409: the revised card now confirms and writes its content.
      const confirmed = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
        ),
      );
      expect(confirmed.properties).toMatchObject({ status: "confirmed", resultItemId: project.id });
      const written = await runInTenant(tenant, () =>
        runtime.query<{ created_by: string }>(
          `SELECT u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1`,
          [project.id],
        ),
      );
      expect(written.rows).toEqual([{ created_by: "user" }]);
    } finally {
      await runtime.end();
    }
  });

  it("refuses a Markdown page revision on a real transcript proposal without effects", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let failure: { error: unknown } | undefined;
    try {
      const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      await runInTenant(getTenantZeroId(), async () => {
        const databases = await withTransaction(runtime, async (client) => ({
          transcripts: await databasesStore.getDatabaseByModuleId(client, "transcripts"),
          projects: await databasesStore.getDatabaseByModuleId(client, "projects"),
          proposals: await databasesStore.getDatabaseByModuleId(client, "processingProposals"),
        }));
        if (!databases.transcripts || !databases.projects || !databases.proposals)
          throw new Error("Missing fixture databases");
        const transcript = await withTransaction(runtime, (client) =>
          createItemWithClient(
            client,
            {
              databaseId: databases.transcripts!.id,
              properties: { name: "Meeting", date: "2024-03-01T12:00:00.000Z" },
            },
            { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
          ),
        );
        const outcome = await withTransaction(runtime, (client) =>
          matchTranscriptToEvent(client, { transcriptId: transcript.id, durationSeconds: 60 }),
        );
        expect(outcome).toBe("suggested");
        const cards = await runtime.query<{ id: string }>(
          "SELECT id FROM items WHERE database_id = $1 AND properties->>'kind' = 'transcript'",
          [databases.proposals.id],
        );
        expect(cards.rows).toHaveLength(1);
        const cardId = cards.rows[0]?.id;
        if (!cardId) throw new Error("Missing actual transcript proposal");
        const project = await withTransaction(runtime, (client) =>
          createItemWithClient(client, { databaseId: databases.projects!.id, properties: { name: "Project" } }),
        );
        const snapshot = () =>
          runtime.query<{ card: unknown; docs: number; edges: number }>(
            "SELECT (SELECT row_to_json(card) FROM (SELECT properties, updated_at FROM items WHERE id = $1) card) AS card, (SELECT count(*)::int FROM docs WHERE item_id = $2) AS docs, (SELECT count(*)::int FROM item_relations) AS edges",
            [cardId, project.id],
          );
        const before = await snapshot();
        await expect(
          withTransaction(runtime, (client) =>
            reviseProposalWithClient(client, { processingProposalsDatabaseId: databases.proposals!.id }, cardId, {
              message: "Revise",
              entityKind: "pageContent",
              target: project.id,
              properties: { markdown: "A paragraph", placement: "end" },
            }),
          ),
        ).rejects.toMatchObject({ status: 400, details: { field: "entityKind" } });
        expect((await snapshot()).rows).toEqual(before.rows);
      });
    } catch (error) {
      failure = { error };
    }
    try {
      await runtime.end();
    } catch (cleanupError) {
      if (failure)
        throw new AggregateError([failure.error, cleanupError], "Transcript proposal test and cleanup failed", {
          // Preserve the original test failure; the cleanup failure remains in errors.
          // eslint-disable-next-line preserve-caught-error
          cause: failure.error,
        });
      throw cleanupError;
    }
    if (failure) throw failure.error;
  });

  it("confirm on a 'pageContent' proposal appends the block and locks confirmed", async () => {
    const { proposal, targetPageId } = await createPageContentProposal("A thought");

    const confirmed = await withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );

    expect(confirmed.properties.status).toBe("confirmed");
    expect(confirmed.properties.resultItemId).toBe(targetPageId);

    const block = await docStore.getBlock(targetPageId, proposal.id);
    expect(block).toMatchObject({ "sys:flavour": "paragraph", content: "A thought" });
  });

  it("confirms an old-shape page-content card as before, now authored user, and lists its block id", async () => {
    const { proposal, targetPageId } = await createPageContentProposal("Old shape");

    const confirmed = await withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );

    expect(confirmed.properties.resultItemId).toBe(targetPageId);
    expect(await docUpdateAuthors(targetPageId)).toEqual(["user"]);
    expect(resultBlockIds(confirmed)).toEqual([proposal.id]);
  });

  describe("v2 page content (issue #1681)", () => {
    const HEADING_ID = "h-tiles";

    async function projectWithPage(blocks: BlockInput[]): Promise<string> {
      const projectsId = await databaseIdFor("projects");
      const project = await withTransaction(pool, (client) =>
        createItemWithClient(client, { databaseId: projectsId, properties: { name: "Host project" } }),
      );
      if (blocks.length > 0) {
        const doc = await docStore.getOrCreateDoc(project.id, "page");
        await mutateDoc(pool, doc.id, "user", (ydoc) => blocks.forEach((block) => writeBlock(ydoc, block)));
      }
      return project.id;
    }

    /** The target page's blocks in document order, as [id, type, text]. */
    async function pageBlocks(itemId: string): Promise<Array<[string, string, string]>> {
      const doc = await docStore.getDoc(itemId);
      if (!doc) return [];
      const ydoc = await loadDoc(pool, doc.id);
      return readPageBlocks(ydoc)
        .filter((block) => !block.synthetic)
        .map((block) => [block.id ?? "", block.type, block.text.map((run) => run.insert).join("")]);
    }

    async function createV2Proposal(target: string, properties: Record<string, unknown>) {
      return createMarkdownPageContentProposal(pool, { inboxId, typesId, proposalsId }, target, properties);
    }

    const confirm = (proposalId: string) =>
      withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposalId),
      );

    const readProposal = (proposalId: string) =>
      withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, proposalId));

    const sectioned: BlockInput[] = [
      { id: "h-intro", type: "h1", text: "Intro" },
      { id: "i1", type: "text", text: "Intro text" },
      { id: HEADING_ID, type: "h2", text: "Tiles" },
      { id: "t1", type: "text", text: "Tile one" },
      { id: "t2", type: "text", text: "Tile two" },
      { id: "h-other", type: "h2", text: "Other" },
      { id: "o1", type: "text", text: "Other text" },
    ];

    it("inserts the optional heading and the bullets at the end of the chosen section, leaving other blocks in order", async () => {
      const target = await projectWithPage(sectioned);
      const proposal = await createV2Proposal(target, {
        markdown: "- first\n- second",
        placement: { afterHeading: HEADING_ID },
        heading: "New tiles",
      });

      const confirmed = await confirm(proposal.id);

      const blocks = await pageBlocks(target);
      const ids = [0, 1, 2].map((index) => proposalBlockId(proposal.id, index));
      expect(blocks.map(([, type, text]) => [type, text])).toEqual([
        ["h1", "Intro"],
        ["text", "Intro text"],
        ["h2", "Tiles"],
        ["text", "Tile one"],
        ["text", "Tile two"],
        ["h3", "New tiles"],
        ["bullet", "first"],
        ["bullet", "second"],
        ["h2", "Other"],
        ["text", "Other text"],
      ]);
      expect(blocks.filter(([id]) => ids.includes(id)).map(([id]) => id)).toEqual(ids);
      expect(blocks.map(([id]) => id).filter((id) => !ids.includes(id))).toEqual(sectioned.map((block) => block.id));
      expect(confirmed.properties.status).toBe("confirmed");
      expect(confirmed.properties.resultItemId).toBe(target);
      expect(confirmed.properties.resultLabel).toBe("Host project");
      expect(resultBlockIds(confirmed)).toEqual(ids);
      expect(await docUpdateAuthors(target)).toEqual(["user", "user"]);
    });

    it("adds no block when the same proposal is confirmed again, and returns the stored result", async () => {
      const target = await projectWithPage(sectioned);
      const proposal = await createV2Proposal(target, { markdown: "Once", placement: "end" });
      const first = await confirm(proposal.id);
      const afterFirst = { blocks: await pageBlocks(target), authors: await docUpdateAuthors(target) };

      const second = await confirm(proposal.id);

      expect(second.properties.results).toEqual(first.properties.results);
      expect({ blocks: await pageBlocks(target), authors: await docUpdateAuthors(target) }).toEqual(afterFirst);
    });

    it("answers 409 when the chosen heading was removed, keeps the card proposed and writes nothing", async () => {
      const target = await projectWithPage(sectioned);
      const proposal = await createV2Proposal(target, { markdown: "Late", placement: { afterHeading: HEADING_ID } });
      const doc = await docStore.getDoc(target);
      await mutateDoc(pool, doc!.id, "user", (ydoc) => {
        ydoc.getMap("blocks").delete(HEADING_ID);
        const order = ydoc.getArray<string>("order");
        order.delete(order.toArray().indexOf(HEADING_ID), 1);
      });
      const before = { blocks: await pageBlocks(target), authors: await docUpdateAuthors(target) };

      await expect(confirm(proposal.id)).rejects.toBeInstanceOf(ConflictError);

      expect((await readProposal(proposal.id))!.properties.status).toBe("proposed");
      expect({ blocks: await pageBlocks(target), authors: await docUpdateAuthors(target) }).toEqual(before);
    });

    it("answers 409 as well when the chosen block is still there but no longer a heading", async () => {
      const target = await projectWithPage(sectioned);
      const proposal = await createV2Proposal(target, { markdown: "Late", placement: { afterHeading: HEADING_ID } });
      const doc = await docStore.getDoc(target);
      await mutateDoc(pool, doc!.id, "user", (ydoc) => {
        ydoc.getMap<import("yjs").Map<unknown>>("blocks").get(HEADING_ID)?.set("sys:flavour", "text");
      });

      await expect(confirm(proposal.id)).rejects.toBeInstanceOf(ConflictError);
      expect((await readProposal(proposal.id))!.properties.status).toBe("proposed");
    });

    it("creates the page document of a target that has none and the content is its only content", async () => {
      const target = await projectWithPage([]);
      expect(await docStore.getDoc(target)).toBeNull();
      const proposal = await createV2Proposal(target, { markdown: "Fresh\n\nPage", placement: "end" });

      await confirm(proposal.id);

      expect((await pageBlocks(target)).map(([, type, text]) => [type, text])).toEqual([
        ["text", "Fresh"],
        ["text", "Page"],
      ]);
    });

    it("maps start and end directly", async () => {
      const target = await projectWithPage([{ id: "only", type: "text", text: "Existing" }]);
      const atEnd = await createV2Proposal(target, { markdown: "End", placement: "end" });
      const atStart = await createV2Proposal(target, { markdown: "Start", placement: "start" });
      await confirm(atEnd.id);
      await confirm(atStart.id);
      expect((await pageBlocks(target)).map(([, , text]) => text)).toEqual(["Start", "Existing", "End"]);
    });

    it.each([
      ["h1", "h2"],
      ["h2", "h3"],
      ["h3", "h3"],
    ] as const)("writes the heading of a card under an %s section as %s", async (sectionType, expected) => {
      const target = await projectWithPage([{ id: "sec", type: sectionType, text: "Section" }]);
      const proposal = await createV2Proposal(target, {
        markdown: "Body",
        placement: { afterHeading: "sec" },
        heading: "Added",
      });
      await confirm(proposal.id);
      expect((await pageBlocks(target)).map(([, type, text]) => [type, text])).toEqual([
        [sectionType, "Section"],
        [expected, "Added"],
        ["text", "Body"],
      ]);
    });

    it("writes the heading as h2 when the placement is not under a heading", async () => {
      const target = await projectWithPage([{ id: "x", type: "text", text: "Existing" }]);
      const proposal = await createV2Proposal(target, { markdown: "Body", placement: "end", heading: "Added" });
      await confirm(proposal.id);
      expect((await pageBlocks(target)).map(([, type, text]) => [type, text])).toEqual([
        ["text", "Existing"],
        ["h2", "Added"],
        ["text", "Body"],
      ]);
    });

    it("ends a section at the next heading of the same or a higher level, not at a deeper one", async () => {
      const target = await projectWithPage([
        { id: "a", type: "h2", text: "Section" },
        { id: "b", type: "h3", text: "Deeper" },
        { id: "c", type: "text", text: "Deeper text" },
        { id: "d", type: "h1", text: "Higher" },
      ]);
      const proposal = await createV2Proposal(target, { markdown: "Appended", placement: { afterHeading: "a" } });
      await confirm(proposal.id);
      expect((await pageBlocks(target)).map(([, , text]) => text)).toEqual([
        "Section",
        "Deeper",
        "Deeper text",
        "Appended",
        "Higher",
      ]);
    });

    it("writes the heading one level below its section heading and never below h3", async () => {
      const cases = [
        { section: "h1", heading: "h2" },
        { section: "h2", heading: "h3" },
        { section: "h3", heading: "h3" },
      ] as const;
      for (const { section, heading } of cases) {
        const target = await projectWithPage([
          { id: "s", type: section, text: "Section" },
          { id: "inside", type: "text", text: "Inside" },
        ]);
        const proposal = await createV2Proposal(target, {
          markdown: "Body",
          placement: { afterHeading: "s" },
          heading: "Added",
        });
        await confirm(proposal.id);
        expect((await pageBlocks(target)).map(([, type, text]) => [type, text])).toEqual([
          [section, "Section"],
          ["text", "Inside"],
          [heading, "Added"],
          ["text", "Body"],
        ]);
      }
    });

    it("lists a confirmed card's blocks as the user's changes and not as the assistant's", async () => {
      const target = await projectWithPage(sectioned);
      // Taken after the page and its blocks exist, so only the confirm below is stored after it.
      const since = new Date();
      const proposal = await createV2Proposal(target, {
        markdown: "- first\n- second",
        placement: { afterHeading: HEADING_ID },
        heading: "New tiles",
      });
      await confirm(proposal.id);
      const ids = [0, 1, 2].map((index) => proposalBlockId(proposal.id, index));
      const doc = await docStore.getDoc(target);
      if (!doc) throw new Error("Missing page document");

      expect(await listPageChanges(pool, doc.id, { since, by: "user", limit: 100 })).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "insert", blockIds: ids })]),
      );
      expect(await listPageChanges(pool, doc.id, { since, by: "ai_agent", limit: 100 })).toEqual([]);
    });

    it("writes into the page of a real subpage, the Pages host", async () => {
      const project = await projectWithPage([]);
      const page = await withTransaction(pool, (client) =>
        createSubpageWithClient(client, { parent: { itemId: project }, title: "Notes" }, "user"),
      );
      const subpage = page.pages[0]!.pageItemId;
      const proposal = await createV2Proposal(subpage, { markdown: "Into the subpage", placement: "end" });

      const confirmed = await confirm(proposal.id);

      expect(confirmed.properties.resultItemId).toBe(subpage);
      expect((await pageBlocks(subpage)).map(([, , text]) => text)).toEqual(["Into the subpage"]);
    });

    it("leaves no partial block and the card proposed when a later step of the confirm fails", async () => {
      const target = await projectWithPage([{ id: "x", type: "text", text: "Existing" }]);
      const proposal = await createV2Proposal(target, { markdown: "Never kept", placement: "end", heading: "Gone" });
      const before = { blocks: await pageBlocks(target), authors: await docUpdateAuthors(target) };
      // A trigger refuses the status write that locks the card `confirmed`, after the blocks were inserted.
      await pool.query(`CREATE FUNCTION public.zz_test_refuse_confirmed() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.properties->>'status' = 'confirmed' THEN RAISE EXCEPTION 'refused by the test trigger'; END IF;
          RETURN NEW;
        END $$`);
      await pool.query(
        `CREATE TRIGGER zz_test_refuse_confirmed BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION public.zz_test_refuse_confirmed()`,
      );
      try {
        await expect(confirm(proposal.id)).rejects.toThrow(/refused by the test trigger/);
      } finally {
        await pool.query(`DROP TRIGGER zz_test_refuse_confirmed ON items`);
        await pool.query(`DROP FUNCTION public.zz_test_refuse_confirmed()`);
      }
      expect((await readProposal(proposal.id))!.properties.status).toBe("proposed");
      expect({ blocks: await pageBlocks(target), authors: await docUpdateAuthors(target) }).toEqual(before);
    });

    it("refuses a link to an item that was deleted after the card was computed, keeping the card proposed", async () => {
      const target = await projectWithPage([]);
      const projectsId = await databaseIdFor("projects");
      const linked = await withTransaction(pool, (client) =>
        createItemWithClient(client, { databaseId: projectsId, properties: { name: "Linked" } }),
      );
      const proposal = await createV2Proposal(target, {
        markdown: `See [it](semprec://items/${linked.id})`,
        placement: "end",
      });
      await pool.query(`UPDATE items SET deleted_at = now() WHERE id = $1`, [linked.id]);

      await expect(confirm(proposal.id)).rejects.toBeInstanceOf(ValidationError);

      expect((await readProposal(proposal.id))!.properties.status).toBe("proposed");
      expect(await docStore.getDoc(target)).toBeNull();
    });
  });

  it("confirm refuses a needsClarification proposal (no computed envelope)", async () => {
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text: "no type",
      }),
    );
    await runTick(item.id, async () => {
      return { properties: {}, candidates: [] };
    });
    const proposal = (await findProposalForItem(item.id))!;

    await expect(
      withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
      ),
    ).rejects.toThrow(/Cannot confirm a proposal in status 'needsClarification'/);
  });

  it("confirm refuses an already-rejected proposal", async () => {
    const proposal = await createDatabaseProposal("Buy milk");
    await withTransaction(pool, (client) =>
      rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );

    await expect(
      withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
      ),
    ).rejects.toThrow(/Cannot confirm a proposal in status 'rejected'/);
  });

  async function setStoredProperty(proposalId: string, key: string, value: unknown): Promise<void> {
    await pool.query(`UPDATE items SET properties = jsonb_set(properties, $2::text[], $3::jsonb) WHERE id = $1`, [
      proposalId,
      `{${key}}`,
      JSON.stringify(value),
    ]);
  }

  it("confirm rejects a stored envelope that is not { entityKind, target, properties }", async () => {
    const proposal = await createDatabaseProposal("Buy milk");
    await setStoredProperty(proposal.id, "proposal", { entityKind: "database" });

    await expect(
      withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
      ),
    ).rejects.toThrow(`Malformed proposal envelope on proposal ${proposal.id}`);

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [tasksId]);
    expect(rows[0].n).toBe(0);
  });

  describe("unknown stored entityKind", () => {
    const futureEnvelope = { entityKind: "someFutureKind", target: "future-target", properties: { a: 1 } };

    async function createFutureKindProposal() {
      const proposal = await createDatabaseProposal("Buy milk");
      await setStoredProperty(proposal.id, "proposal", futureEnvelope);
      return proposal;
    }

    async function readCard(proposalId: string) {
      return withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, proposalId));
    }

    it("lists and reads the card with the stored envelope untouched", async () => {
      const proposal = await createFutureKindProposal();

      const card = await readCard(proposal.id);
      expect(card!.properties.proposal).toEqual(futureEnvelope);
      expect(card!.properties.status).toBe("proposed");
      const page = await createChokePoint(pool).listItems(proposalsId);
      expect(page.items.find((item) => item.id === proposal.id)?.properties.proposal).toEqual(futureEnvelope);
      expect(parseStoredProposalEnvelope(card!.properties.proposal, proposal.id)).toEqual({
        unknownKind: true,
        ...futureEnvelope,
      });
    });

    it("confirm answers 409 naming the kind, leaves the card proposed and writes nothing", async () => {
      const proposal = await createFutureKindProposal();

      const error = await withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({ details: { field: "entityKind", entityKind: "someFutureKind" } });
      expect((error as ConflictError).status).toBe(409);
      expect((error as ConflictError).message).toContain("someFutureKind");

      const card = await readCard(proposal.id);
      expect(card!.properties.status).toBe("proposed");
      expect(card!.properties.proposal).toEqual(futureEnvelope);
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [tasksId]);
      expect(rows[0].n).toBe(0);
    });

    it("revise answers 409 and leaves the stored envelope unchanged", async () => {
      const proposal = await createFutureKindProposal();

      const error = await withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
          message: "fix it",
          entityKind: "database",
          target: tasksId,
          properties: { name: "Buy bread" },
        }),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).status).toBe(409);
      expect((error as ConflictError).message).toContain("someFutureKind");

      const card = await readCard(proposal.id);
      expect(card!.properties.proposal).toEqual(futureEnvelope);
      expect(card!.properties.status).toBe("proposed");
    });

    it("revise still rejects writing an unknown entityKind as before", async () => {
      const proposal = await createDatabaseProposal("Buy milk");

      await expect(
        withTransaction(pool, (client) =>
          reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
            message: "x",
            entityKind: "someFutureKind" as never,
            target: tasksId,
            properties: {},
          }),
        ),
      ).rejects.toThrow(/unknown entityKind 'someFutureKind'/);
    });

    it("a structurally malformed envelope still throws on read", () => {
      expect(() => parseStoredProposalEnvelope({ entityKind: "someFutureKind", target: "t" }, "p1")).toThrow(
        "Malformed proposal envelope on proposal p1",
      );
      expect(() => parseStoredProposalEnvelope({ entityKind: 5, target: "t", properties: {} }, "p1")).toThrow(
        "Malformed proposal envelope",
      );
    });
  });

  it("confirm still reports a null stored envelope as having no computed envelope", async () => {
    const proposal = await createDatabaseProposal("Buy milk");
    await setStoredProperty(proposal.id, "proposal", null);

    await expect(
      withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
      ),
    ).rejects.toThrow("Proposal has no computed envelope to confirm");
  });

  it("appendHistoryEntry treats a history holding a malformed entry as empty", async () => {
    const proposal = await createDatabaseProposal("Buy milk");
    await setStoredProperty(proposal.id, "history", [
      { author: "ai", message: "Created a proposal for the source item.", at: "2026-08-28T09:00:00.000Z" },
      { author: "robot", message: 42 },
    ]);
    const stored = await withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, proposal.id));

    const history = appendHistoryEntry(stored!.properties.history, "Not needed", "user");

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ author: "user", message: "Not needed" });
  });

  it("appendHistoryEntry keeps legacy entries byte-identical and adds no kind without extra", () => {
    const legacy = { author: "user", message: "Old", at: "2026-08-28T09:00:00.000Z" };

    const history = appendHistoryEntry([legacy], "New");

    expect(JSON.stringify(history[0])).toBe(JSON.stringify(legacy));
    expect(Object.keys(history[1]!).sort()).toEqual(["at", "author", "message"]);
  });

  it("appendHistoryEntry keeps a userEdit entry with keys across further appends", () => {
    let history = appendHistoryEntry([], "Edited title", "user", { kind: "userEdit", keys: ["primary.title"] });
    const first = JSON.stringify(history[0]);
    history = appendHistoryEntry(history, "Second");
    history = appendHistoryEntry(history, "Third", "user");

    expect(history).toHaveLength(3);
    expect(JSON.stringify(history[0])).toBe(first);
    expect(history[0]).toMatchObject({ kind: "userEdit", keys: ["primary.title"], author: "user" });
  });

  it("appendHistoryEntry keeps threadRevision thread and message ids", () => {
    let history = appendHistoryEntry([], "Revised", "ai", { kind: "threadRevision", threadId: "t1", messageId: "m1" });
    history = appendHistoryEntry(history, "Later");

    expect(history[0]).toMatchObject({ kind: "threadRevision", threadId: "t1", messageId: "m1" });
  });

  it("reject locks rejected and writes no target", async () => {
    const proposal = await createDatabaseProposal("Buy milk");

    const rejected = await withTransaction(pool, (client) =>
      rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, "Not needed"),
    );

    expect(rejected.properties.status).toBe("rejected");
    expect(rejected.properties.resultItemId).toBeUndefined();
    const history = rejected.properties.history as Array<Record<string, unknown>>;
    expect(history[1]).toMatchObject({ author: "user", message: "Not needed" });

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [tasksId]);
    expect(rows[0].n).toBe(0);
  });

  it("reject is idempotent under retry", async () => {
    const proposal = await createDatabaseProposal("Buy milk");

    const first = await withTransaction(pool, (client) =>
      rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );
    const second = await withTransaction(pool, (client) =>
      rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );

    expect(second.updatedAt).toBe(first.updatedAt);
  });

  it("reject refuses an already-confirmed proposal", async () => {
    const proposal = await createDatabaseProposal("Buy milk");
    await withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );

    await expect(
      withTransaction(pool, (client) =>
        rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
      ),
    ).rejects.toThrow(/already been confirmed/);
  });

  it("revise can switch a proposal from 'database' to 'pageContent' atomically and records the message", async () => {
    const proposal = await createDatabaseProposal("Buy milk");
    const pageTarget = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Thought",
        emoji: "💭",
        processingMethod: "pageContent",
      }),
    );

    const revised = await withTransaction(pool, (client) =>
      reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
        message: "Actually this is a note",
        entityKind: "pageContent",
        target: pageTarget.id,
        properties: { flavour: "paragraph", fields: { content: "Buy milk" } },
      }),
    );

    expect(revised.properties.status).toBe("proposed");
    expect(revised.properties.proposal).toEqual({
      entityKind: "pageContent",
      target: pageTarget.id,
      properties: { flavour: "paragraph", fields: { content: "Buy milk" } },
    });
    const history = revised.properties.history as Array<Record<string, unknown>>;
    expect(history[history.length - 1]).toMatchObject({ author: "user", message: "Actually this is a note" });
  });

  it("revise stores a valid relations map and refuses a deleted target without touching the card (issue #1426)", async () => {
    const proposal = await createDatabaseProposal("Buy milk");
    const projectsId = await databaseIdFor("projects");
    const project = await withTransaction(
      pool,
      async (client) =>
        (await createItemWithClient(client, { databaseId: projectsId, properties: { name: "Home" } })).id,
    );
    const revise = (relations: Record<string, string[]>) =>
      withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
          message: "link it",
          entityKind: "database",
          target: tasksId,
          properties: { name: "Buy milk" },
          relations,
        }),
      );

    const revised = await revise({ project: [project] });
    expect(revised.properties.proposal).toEqual({
      entityKind: "database",
      target: tasksId,
      properties: { name: "Buy milk" },
      relations: { project: [project] },
    });

    const malformedTargetError = await revise({ project: ["not-a-uuid"] }).catch((e: unknown) => e);
    expect(malformedTargetError).toBeInstanceOf(ValidationError);
    if (!(malformedTargetError instanceof ValidationError)) throw malformedTargetError;
    expect(malformedTargetError.status).toBe(400);
    expect(malformedTargetError.details).toEqual({ field: "project" });
    const unchangedCard = await withTransaction(pool, (client) =>
      itemsStore.getItemById(client, proposalsId, proposal.id),
    );
    expect(unchangedCard).not.toBeNull();
    if (!unchangedCard) throw new Error("The rejected revision removed its proposal card");
    expect(unchangedCard.properties.proposal).toEqual(revised.properties.proposal);

    await withTransaction(pool, async (client) => {
      await itemsStore.softDeleteItem(client, projectsId, project);
    });
    const error = await revise({ project: [project] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).details).toEqual({ field: "project", code: "targetDeleted" });
    const card = await withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, proposal.id));
    expect(card!.properties.proposal).toEqual(revised.properties.proposal);
  });

  describe("relations on confirm (issue #1476)", () => {
    async function proposalWithRelations(relations: Record<string, string[]>) {
      const proposal = await createDatabaseProposal("Buy milk");
      await withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
          message: "link it",
          entityKind: "database",
          target: tasksId,
          properties: { name: "Buy milk" },
          relations,
        }),
      );
      return proposal;
    }
    async function createProject(name: string): Promise<string> {
      const projectsId = await databaseIdFor("projects");
      return withTransaction(
        pool,
        async (client) => (await createItemWithClient(client, { databaseId: projectsId, properties: { name } })).id,
      );
    }
    const confirm = (proposalId: string) =>
      withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposalId),
      );
    const countTasks = async () => {
      const result = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
        tasksId,
      ]);
      if (!result.rows[0]) throw new Error("Missing task count");
      return result.rows[0].n;
    };
    const countEdges = async () => {
      const result = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM item_relations");
      if (!result.rows[0]) throw new Error("Missing edge count");
      return result.rows[0].n;
    };

    it("writes the task and its project edge in one transaction, once even when confirmed again", async () => {
      const project = await createProject("Home");
      const proposal = await proposalWithRelations({ project: [project] });
      const before = await countEdges();
      const projectsId = await databaseIdFor("projects");
      const inverseKey = await withTransaction(pool, async (client) => {
        const property = await propertiesStore.getPropertyByKey(client, tasksId, "project");
        if (!property) throw new Error("Missing Tasks.project");
        const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property.id);
        if (!definition?.propertyIdB) throw new Error("Missing inverse relation property");
        const inverseId = definition.propertyIdA === property.id ? definition.propertyIdB : definition.propertyIdA;
        const inverse = await propertiesStore.getProperty(client, inverseId);
        if (!inverse || inverse.databaseId !== projectsId) throw new Error("Missing Projects inverse");
        return inverse.key;
      });
      await withTransaction(pool, (client) =>
        insertValueLink(client, {
          itemId: project,
          propertyKey: inverseKey,
          ruleKey: "test",
          sources: [],
        }),
      );
      const actorId = randomUUID();
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      const confirmed = await (async () => {
        try {
          const failure = new Error("rollback single-envelope confirmation");
          await expect(
            withTransaction(pool, async (client) => {
              await confirmProposalWithClient(
                client,
                { processingProposalsDatabaseId: proposalsId },
                proposal.id,
                undefined,
                actorId,
              );
              expect(events).toEqual([]);
              throw failure;
            }),
          ).rejects.toBe(failure);
          expect(events).toEqual([]);
          expect((await withTransaction(pool, (client) => listValueLinksByItemIds(client, [project])))[0]?.state).toBe(
            "on",
          );
          const result = await withTransaction(pool, (client) =>
            confirmProposalWithClient(
              client,
              { processingProposalsDatabaseId: proposalsId },
              proposal.id,
              undefined,
              actorId,
            ),
          );
          expect(events.filter((event) => event.scope === "item" && event.itemId === project)).toEqual([
            expect.objectContaining({ userId: actorId }),
          ]);
          events.length = 0;
          await confirm(proposal.id);
          expect(events).toEqual([]);
          return result;
        } finally {
          setInvalidationHook(() => {});
        }
      })();
      expect(await countTasks()).toBe(1);
      expect(await countEdges()).toBe(before + 1);
      const { rows } = await pool.query<{ "?column?": number }>(
        "SELECT 1 FROM item_relations WHERE (item_a = $1 AND item_b = $2) OR (item_a = $2 AND item_b = $1)",
        [confirmed.properties.resultItemId, project],
      );
      expect(rows).toHaveLength(1);

      await confirm(proposal.id);
      expect(await countEdges()).toBe(before + 1);
    });

    it("rolls back item and edge with field 'project' when a target disappears before confirm", async () => {
      const project = await createProject("Home");
      const proposal = await proposalWithRelations({ project: [project] });
      const projectsId = await databaseIdFor("projects");
      await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, projectsId, project));
      const before = await countEdges();

      const error = await confirm(proposal.id).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toMatchObject({ field: "project" });
      expect(await countTasks()).toBe(0);
      expect(await countEdges()).toBe(before);
      const card = await withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, proposal.id));
      expect(card!.properties.status).toBe("proposed");
    });

    it("rolls back the item and the first edge when the second edge violates cardinality", async () => {
      const first = await createProject("Home");
      const second = await createProject("Work");
      const proposal = await proposalWithRelations({ project: [first, second] });
      const before = await countEdges();

      const error = await confirm(proposal.id).catch((e: unknown) => e);
      expect(error).toMatchObject({ status: 409, details: { field: "project" } });
      expect(await countTasks()).toBe(0);
      expect(await countEdges()).toBe(before);
      const card = await withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, proposal.id));
      expect(card!.properties.status).toBe("proposed");
    });
  });

  describe("multi-step proposals on confirm (issue #1486)", () => {
    type Step = NonNullable<ProposalEnvelope["operations"]>[number];
    const confirm = (proposalId: string, actingUserId?: string) =>
      withTransaction(pool, (client) =>
        confirmProposalWithClient(
          client,
          { processingProposalsDatabaseId: proposalsId },
          proposalId,
          undefined,
          actingUserId,
        ),
      );
    const countItems = async (moduleId: string) =>
      (
        await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
          await databaseIdFor(moduleId),
        ])
      ).rows[0]!.n;
    const edgeExists = async (a: string, b: string) =>
      (
        await pool.query<{ "?column?": number }>(
          "SELECT 1 FROM item_relations WHERE (item_a = $1 AND item_b = $2) OR (item_a = $2 AND item_b = $1)",
          [a, b],
        )
      ).rows.length === 1;
    const createIn = (moduleId: string, properties: Record<string, unknown>) =>
      databaseIdFor(moduleId).then((databaseId) =>
        withTransaction(pool, async (client) => (await createItemWithClient(client, { databaseId, properties })).id),
      );
    const cardStatus = async (cardId: string) =>
      (await withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, cardId)))!.properties.status;

    /** Stores a multi-step envelope on a fresh card the way the tick will (system-owned `proposal`). */
    async function cardWithSteps(primaryDatabase: string, steps: Step[]): Promise<string> {
      const card = await createDatabaseProposal("seed");
      const primary = steps.find((step) => step.role === "primary")!;
      const target = await databaseIdFor(primaryDatabase);
      await withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          {
            databaseId: proposalsId,
            itemId: card.id,
            propertiesPatch: {
              proposal: {
                entityKind: "database",
                target,
                properties: primary.properties ?? {},
                operations: steps,
              },
            },
          },
          { allowedSystemKeys: ["proposal"] },
        ),
      );
      return card.id;
    }

    const companyAndPerson = (personName = "Jane"): Step[] => [
      { ref: "company", op: "create", databaseKey: "companies", role: "primary", properties: { name: "Acme" } },
      {
        ref: "person",
        op: "create",
        databaseKey: "people",
        role: "secondary",
        properties: { name: personName },
        relations: { companies: [{ ref: "company" }] },
      },
    ];
    // The person is listed before the company it refers to, so execution order must come from the refs.
    const personFirst = (): Step[] => companyAndPerson().reverse();

    it("creates company, person and the People.companies edge in one transaction; the result is the primary's", async () => {
      const card = await cardWithSteps("companies", personFirst());
      const confirmed = await confirm(card);

      expect(await countItems("companies")).toBe(1);
      expect(await countItems("people")).toBe(1);
      const personId = (
        await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [await databaseIdFor("people")])
      ).rows[0]!.id;
      expect(confirmed.properties.resultItemId).not.toBe(personId);
      expect(confirmed.properties.resultLabel).toBe("Acme");
      expect(await edgeExists(personId, confirmed.properties.resultItemId as string)).toBe(true);
      expect(confirmed.properties.status).toBe("confirmed");
    });

    it("attributes a multi-step create edge to its actor and rolls it back atomically", async () => {
      const project = await createIn("projects", { name: "Existing project" });
      const projectDatabase = await databaseIdFor("projects");
      const inverseKey = await withTransaction(pool, async (client) => {
        const property = await propertiesStore.getPropertyByKey(client, tasksId, "project");
        if (!property) throw new Error("Missing Tasks.project");
        const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property.id);
        if (!definition?.propertyIdB) throw new Error("Missing inverse relation property");
        const inverseId = definition.propertyIdA === property.id ? definition.propertyIdB : definition.propertyIdA;
        const inverse = await propertiesStore.getProperty(client, inverseId);
        if (!inverse || inverse.databaseId !== projectDatabase) throw new Error("Missing Projects inverse");
        return inverse.key;
      });
      await withTransaction(pool, (client) =>
        insertValueLink(client, {
          itemId: project,
          propertyKey: inverseKey,
          ruleKey: "test",
          sources: [],
        }),
      );
      const card = await cardWithSteps("tasks", [
        {
          ref: "task",
          op: "create",
          databaseKey: "tasks",
          role: "primary",
          properties: { name: "Linked task" },
          relations: { project: [project] },
        },
      ]);
      const actorId = randomUUID();
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        const failure = new Error("rollback multi-step creation");
        await expect(
          withTransaction(pool, async (client) => {
            await confirmProposalWithClient(
              client,
              { processingProposalsDatabaseId: proposalsId },
              card,
              undefined,
              actorId,
            );
            expect(events).toEqual([]);
            throw failure;
          }),
        ).rejects.toBe(failure);
        expect(events).toEqual([]);
        expect(await countItems("tasks")).toBe(0);
        expect(await cardStatus(card)).toBe("proposed");
        expect((await withTransaction(pool, (client) => listValueLinksByItemIds(client, [project])))[0]?.state).toBe(
          "on",
        );
        const result = await confirm(card, actorId);
        const taskId = result.properties.resultItemId;
        if (typeof taskId !== "string") throw new Error("Missing task result");
        expect(await edgeExists(taskId, project)).toBe(true);
        expect((await withTransaction(pool, (client) => listValueLinksByItemIds(client, [project])))[0]).toMatchObject({
          state: "broken",
          brokenBy: "user",
        });
        expect(events.filter((event) => event.scope === "item" && event.itemId === project)).toEqual([
          expect.objectContaining({ userId: actorId }),
        ]);
        events.length = 0;
        await confirm(card, actorId);
        expect(events).toEqual([]);
      } finally {
        setInvalidationHook(() => {});
      }
    });

    it("rolls back company and edge when the person fails, and the 400 names the person step", async () => {
      // A wrong value type passes envelope validation and fails only in the choke point's write.
      const failing = companyAndPerson();
      failing[1] = { ...failing[1]!, properties: { name: 42 } };
      const failingCard = await cardWithSteps("companies", failing);
      const edgesBefore = (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM item_relations")).rows[0]!.n;

      const error = await confirm(failingCard).catch((e: unknown) => e);
      expect(error).toMatchObject({ status: 400, details: { ref: "person", field: "name" } });
      expect(await countItems("companies")).toBe(0);
      expect(await countItems("people")).toBe(0);
      expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM item_relations")).rows[0]!.n).toBe(
        edgesBefore,
      );
      expect(await cardStatus(failingCard)).toBe("proposed");
    });

    it("writes only the health record when its follow-up task step is disabled", async () => {
      const card = await cardWithSteps("healthRecords", [
        { ref: "record", op: "create", databaseKey: "healthRecords", role: "primary", properties: { name: "Flu" } },
        {
          ref: "followUp",
          op: "create",
          databaseKey: "tasks",
          role: "secondary",
          enabled: false,
          properties: { name: "Call the doctor" },
        },
      ]);
      await confirm(card);
      expect(await countItems("healthRecords")).toBe(1);
      expect(await countItems("tasks")).toBe(0);
    });

    it("creates no person when the optional new person is not referenced", async () => {
      const steps = companyAndPerson();
      steps[1] = { ...steps[1]!, optional: true, relations: {} };
      const card = await cardWithSteps("companies", steps);
      await confirm(card);
      expect(await countItems("companies")).toBe(1);
      expect(await countItems("people")).toBe(0);
    });

    it("an update step moves a project to another area: old edge gone, new edge present", async () => {
      const oldArea = await createIn("areas", { name: "Home" });
      const newArea = await createIn("areas", { name: "Work" });
      const project = await createIn("projects", { name: "Move" });
      await withTransaction(pool, async (client) => {
        const projectsDb = await databaseIdFor("projects");
        const property = await propertiesStore.getPropertyByKey(client, projectsDb, "area");
        await createRelationWithClient(client, {
          relationPropertyId: property!.id,
          callerItemId: project,
          targetItemId: oldArea,
        });
      });
      const card = await cardWithSteps("projects", [
        {
          ref: "project",
          op: "update",
          itemId: project,
          role: "primary",
          properties: { name: "Move" },
          relations: { area: [newArea] },
          before: { properties: { name: "Move" }, relations: { area: [oldArea] } },
          after: { properties: { name: "Move" }, relations: { area: [newArea] } },
        },
      ]);

      const confirmed = await confirm(card);
      expect(confirmed.properties.resultItemId).toBe(project);
      expect(await edgeExists(project, oldArea)).toBe(false);
      expect(await edgeExists(project, newArea)).toBe(true);
    });

    it("guards an unchanged declared relation and rolls back an earlier create when it is stale", async () => {
      const oldArea = await createIn("areas", { name: "Old" });
      const newArea = await createIn("areas", { name: "New" });
      const project = await createIn("projects", { name: "Before" });
      const projectsDb = await databaseIdFor("projects");
      const property = await withTransaction(pool, (client) =>
        propertiesStore.getPropertyByKey(client, projectsDb, "area"),
      );
      if (!property) throw new Error("Missing Projects.area");
      const oldEdge = { relationPropertyId: property.id, callerItemId: project, targetItemId: oldArea };
      await withTransaction(pool, (client) => createRelationWithClient(client, oldEdge));
      const card = await cardWithSteps("companies", [
        { ref: "company", op: "create", databaseKey: "companies", role: "primary", properties: { name: "Acme" } },
        {
          ref: "project",
          op: "update",
          itemId: project,
          role: "secondary",
          properties: { name: "After" },
          before: { properties: { name: "Before" }, relations: { area: [oldArea] } },
          after: { properties: { name: "After" } },
        },
      ]);
      await withTransaction(pool, async (client) => {
        await deleteRelationWithClient(client, oldEdge);
        await createRelationWithClient(client, { ...oldEdge, targetItemId: newArea });
      });
      await expect(confirm(card)).rejects.toMatchObject({ status: 400, details: { ref: "project", field: "area" } });
      expect(await countItems("companies")).toBe(0);
      expect(await cardStatus(card)).toBe("proposed");
      const [current] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [project]));
      expect(current?.properties.name).toBe("Before");
      expect(await edgeExists(project, newArea)).toBe(true);
    });

    it("rejects duplicate targets in an unchanged declared before relation without writing", async () => {
      const area = await createIn("areas", { name: "Area" });
      const project = await createIn("projects", { name: "Before" });
      const card = await cardWithSteps("projects", [
        {
          ref: "project",
          op: "update",
          itemId: project,
          role: "primary",
          properties: { name: "After" },
          before: { properties: { name: "Before" }, relations: { area: [area, area] } },
          after: { properties: { name: "After" } },
        },
      ]);
      await expect(confirm(card)).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining("contains duplicate targets"),
        details: { ref: "project", field: "area" },
      });
      const [current] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [project]));
      expect(current?.properties.name).toBe("Before");
      expect(await cardStatus(card)).toBe("proposed");
      expect(await edgeExists(project, area)).toBe(false);
    });

    it("links an existing person to a created company once and rolls back a later failure", async () => {
      const person = await createIn("people", { name: "Jane" });
      const steps: Step[] = [
        { ref: "company", op: "create", databaseKey: "companies", role: "primary", properties: { name: "Acme" } },
        {
          ref: "person",
          op: "link",
          itemId: person,
          role: "secondary",
          relations: { companies: [{ ref: "company" }] },
        },
      ];
      const failing = await cardWithSteps("companies", [
        ...steps,
        { ref: "task", op: "create", databaseKey: "tasks", role: "secondary", properties: { name: 42 } },
      ]);
      await expect(confirm(failing)).rejects.toMatchObject({ status: 400, details: { ref: "task", field: "name" } });
      expect(await countItems("companies")).toBe(0);
      expect(await countItems("people")).toBe(1);
      expect(await cardStatus(failing)).toBe("proposed");
      const card = await cardWithSteps("companies", steps);
      const first = await confirm(card);
      const company = first.properties.resultItemId;
      if (typeof company !== "string") throw new Error("Expected created company");
      expect(await edgeExists(person, company)).toBe(true);
      const repeated = await confirm(card);
      expect(repeated.id).toBe(first.id);
      expect(repeated.properties).toEqual(first.properties);
      expect(repeated.updatedAt).toBe(first.updatedAt);
      expect(await countItems("companies")).toBe(1);
      const edges = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM item_relations WHERE (item_a = $1 AND item_b = $2) OR (item_a = $2 AND item_b = $1)",
        [person, company],
      );
      expect(edges.rows[0]?.n).toBe(1);
    });

    it("rejects a forged link before list during confirm without creating anything", async () => {
      const person = await createIn("people", { name: "Jane" });
      const missing = randomUUID();
      const card = await cardWithSteps("companies", [
        { ref: "company", op: "create", databaseKey: "companies", role: "primary", properties: { name: "Acme" } },
        {
          ref: "person",
          op: "link",
          itemId: person,
          role: "secondary",
          relations: { companies: [missing] },
          before: { relations: { companies: [missing] } },
        },
      ]);
      await expect(confirm(card)).rejects.toMatchObject({
        status: 400,
        details: { ref: "person", field: "companies" },
      });
      expect(await countItems("companies")).toBe(0);
      expect(await countItems("people")).toBe(1);
      expect(await cardStatus(card)).toBe("proposed");
      expect(await edgeExists(person, missing)).toBe(false);
    });

    it("writes a relation declared only in after using the validated targets", async () => {
      const oldArea = await createIn("areas", { name: "Old" });
      const newArea = await createIn("areas", { name: "New" });
      const project = await createIn("projects", { name: "Move" });
      const projectsDb = await databaseIdFor("projects");
      const property = await withTransaction(pool, (client) =>
        propertiesStore.getPropertyByKey(client, projectsDb, "area"),
      );
      if (!property) throw new Error("Missing Projects.area property");
      await withTransaction(pool, (client) =>
        createRelationWithClient(client, {
          relationPropertyId: property.id,
          callerItemId: project,
          targetItemId: oldArea,
        }),
      );
      const card = await cardWithSteps("projects", [
        {
          ref: "project",
          op: "update",
          itemId: project,
          role: "primary",
          properties: {},
          before: { relations: { area: [oldArea] } },
          after: { relations: { area: [newArea] } },
        },
      ]);
      await withTransaction(pool, (client) =>
        insertValueLink(client, { itemId: project, propertyKey: "area", ruleKey: "test", sources: [] }),
      );
      const inverseKey = await withTransaction(pool, async (client) => {
        const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property.id);
        if (!definition?.propertyIdB) throw new Error("Missing inverse relation property");
        const inverseId = definition.propertyIdA === property.id ? definition.propertyIdB : definition.propertyIdA;
        const inverse = await propertiesStore.getProperty(client, inverseId);
        if (!inverse) throw new Error("Missing inverse property");
        return inverse.key;
      });
      await withTransaction(pool, (client) =>
        insertValueLink(client, {
          itemId: newArea,
          propertyKey: inverseKey,
          ruleKey: "test",
          sources: [],
        }),
      );
      const actorId = randomUUID();
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        const failure = new Error("rollback linked confirmation");
        await expect(
          withTransaction(pool, async (client) => {
            await confirmProposalWithClient(
              client,
              { processingProposalsDatabaseId: proposalsId },
              card,
              undefined,
              actorId,
            );
            expect(events).toEqual([]);
            throw failure;
          }),
        ).rejects.toBe(failure);
        expect(events).toEqual([]);
        expect((await withTransaction(pool, (client) => listValueLinksByItemIds(client, [project])))[0]?.state).toBe(
          "on",
        );
        expect((await withTransaction(pool, (client) => listValueLinksByItemIds(client, [newArea])))[0]?.state).toBe(
          "on",
        );
        await confirm(card, actorId);
        expect((await withTransaction(pool, (client) => listValueLinksByItemIds(client, [newArea])))[0]).toMatchObject({
          state: "broken",
          brokenBy: "user",
        });
        expect(events.filter((event) => event.scope === "item" && event.itemId === newArea)).toEqual([
          expect.objectContaining({ userId: actorId }),
        ]);
        expect(events.filter((event) => event.scope === "item" && event.itemId === project)).toContainEqual(
          expect.objectContaining({ userId: actorId }),
        );
      } finally {
        setInvalidationHook(() => {});
      }
      expect(await edgeExists(project, oldArea)).toBe(false);
      expect(await edgeExists(project, newArea)).toBe(true);
    });

    it("moves relations on a legacy pinned project without preparing an item write", async () => {
      const oldArea = await createIn("areas", { name: "Old" });
      const newArea = await createIn("areas", { name: "New" });
      const project = await createIn("projects", { name: "Project", pinned: false });
      const projectsDb = await databaseIdFor("projects");
      await withTransaction(pool, (client) =>
        itemsStore.updateItemProperties(client, {
          databaseId: projectsDb,
          itemId: project,
          propertiesPatch: { pinned: true, pinnedOrder: null },
        }),
      );
      const property = await withTransaction(pool, (client) =>
        propertiesStore.getPropertyByKey(client, projectsDb, "area"),
      );
      if (!property) throw new Error("Missing Projects.area property");
      await withTransaction(pool, (client) =>
        createRelationWithClient(client, {
          relationPropertyId: property.id,
          callerItemId: project,
          targetItemId: oldArea,
        }),
      );
      const card = await cardWithSteps("projects", [
        {
          ref: "project",
          op: "update",
          itemId: project,
          role: "primary",
          properties: {},
          before: { relations: { area: [oldArea] } },
          after: { relations: { area: [newArea] } },
        },
      ]);
      await confirm(card);
      const [result] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [project]));
      expect(result?.properties).toMatchObject({ pinned: true, pinnedOrder: null });
      expect(await edgeExists(project, oldArea)).toBe(false);
      expect(await edgeExists(project, newArea)).toBe(true);
    });

    it("requires before and no predicted after for implicit task completion, then confirms", async () => {
      const task = await createIn("tasks", { name: "Task", status: "notDone" });
      const base: Step = {
        ref: "task",
        op: "update",
        itemId: task,
        role: "primary",
        properties: { status: "done" },
        before: { properties: { status: "notDone" } },
        after: { properties: { status: "done" } },
      };
      const missing = await cardWithSteps("tasks", [base]);
      await expect(confirm(missing)).rejects.toMatchObject({
        status: 400,
        details: { ref: "task", field: "completedOn" },
      });
      expect(await cardStatus(missing)).toBe("proposed");
      const predicted = await cardWithSteps("tasks", [
        {
          ...base,
          before: { properties: { status: "notDone", completedOn: null } },
          after: { properties: { status: "done", completedOn: "2020-01-01" } },
        },
      ]);
      await expect(confirm(predicted)).rejects.toMatchObject({
        status: 400,
        details: { ref: "task", field: "completedOn" },
      });
      const [unchanged] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [task]));
      expect(unchanged?.properties).toMatchObject({ status: "notDone" });
      expect(unchanged?.properties.completedOn).toBeUndefined();
      const valid = await cardWithSteps("tasks", [
        { ...base, before: { properties: { status: "notDone", completedOn: null } } },
      ]);
      await confirm(valid);
      const [done] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [task]));
      expect(done?.properties.status).toBe("done");
      expect(typeof done?.properties.completedOn).toBe("string");
    });

    it("requires ordinary before and after values for explicit completion and clearing", async () => {
      const task = await createIn("tasks", { name: "Task", status: "notDone" });
      const complete: Step = {
        ref: "task",
        op: "update",
        itemId: task,
        role: "primary",
        properties: { status: "done", completedOn: "2020-01-01" },
        before: { properties: { status: "notDone", completedOn: null } },
        after: { properties: { status: "done", completedOn: "2020-01-01" } },
      };
      await confirm(await cardWithSteps("tasks", [complete]));
      const clear: Step = {
        ref: "task",
        op: "update",
        itemId: task,
        role: "primary",
        properties: { status: "notDone" },
        before: { properties: { status: "done" } },
        after: { properties: { status: "notDone" } },
      };
      const missing = await cardWithSteps("tasks", [clear]);
      await expect(confirm(missing)).rejects.toMatchObject({
        status: 400,
        details: { ref: "task", field: "completedOn" },
      });
      const [before] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [task]));
      expect(before?.properties.completedOn).toBe("2020-01-01");
      const valid = await cardWithSteps("tasks", [
        {
          ...clear,
          before: { properties: { status: "done", completedOn: "2020-01-01" } },
          after: { properties: { status: "notDone", completedOn: null } },
        },
      ]);
      await confirm(valid);
      const [after] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [task]));
      expect(after?.properties).toMatchObject({ status: "notDone", completedOn: null, completedAt: null });
    });

    it("clears task times only with explicit before and after coverage", async () => {
      const task = await createIn("tasks", { name: "Task", date: "2026-11-01", timeFrom: "09:00", timeTo: "10:00" });
      const base: Step = {
        ref: "task",
        op: "update",
        itemId: task,
        role: "primary",
        properties: { date: null },
        before: { properties: { date: "2026-11-01" } },
        after: { properties: { date: null } },
      };
      const missing = await cardWithSteps("tasks", [base]);
      await expect(confirm(missing)).rejects.toMatchObject({
        status: 400,
        details: { ref: "task", field: "timeFrom" },
      });
      expect(await cardStatus(missing)).toBe("proposed");
      const [unchanged] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [task]));
      expect(unchanged?.properties).toMatchObject({ date: "2026-11-01", timeFrom: "09:00", timeTo: "10:00" });
      const complete = await cardWithSteps("tasks", [
        {
          ...base,
          before: { properties: { date: "2026-11-01", timeFrom: "09:00", timeTo: "10:00" } },
          after: { properties: { date: null, timeFrom: null, timeTo: null } },
        },
      ]);
      await confirm(complete);
      const [result] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [task]));
      expect(result?.properties).toMatchObject({ date: null, timeFrom: null, timeTo: null, time: null });
    });

    it("rejects a stale implicitly cleared task time without writing the card", async () => {
      const task = await createIn("tasks", { name: "Task", date: "2026-11-01", timeFrom: "09:00", timeTo: "10:00" });
      const card = await cardWithSteps("tasks", [
        {
          ref: "task",
          op: "update",
          itemId: task,
          role: "primary",
          properties: { date: null },
          before: { properties: { date: "2026-11-01", timeFrom: "09:00", timeTo: "10:00" } },
          after: { properties: { date: null, timeFrom: null, timeTo: null } },
        },
      ]);
      const tasksDb = await databaseIdFor("tasks");
      await withTransaction(pool, (client) =>
        updateItemWithClient(client, {
          databaseId: tasksDb,
          itemId: task,
          propertiesPatch: { timeFrom: "09:30" },
        }),
      );
      await expect(confirm(card)).rejects.toMatchObject({ status: 400, details: { ref: "task", field: "timeFrom" } });
      expect(await cardStatus(card)).toBe("proposed");
    });

    it("checks an implicit time precondition after the current time is cleared", async () => {
      const task = await createIn("tasks", { name: "Task", date: "2026-11-01", timeFrom: "09:00", timeTo: null });
      const card = await cardWithSteps("tasks", [
        {
          ref: "task",
          op: "update",
          itemId: task,
          role: "primary",
          properties: { date: null },
          before: { properties: { date: "2026-11-01", timeFrom: "09:00" } },
          after: { properties: { date: null, timeFrom: null } },
        },
      ]);
      const tasksDb = await databaseIdFor("tasks");
      await withTransaction(pool, (client) =>
        updateItemWithClient(client, {
          databaseId: tasksDb,
          itemId: task,
          propertiesPatch: { timeFrom: null, timeTo: null },
        }),
      );
      await expect(confirm(card)).rejects.toMatchObject({ status: 400, details: { ref: "task", field: "timeFrom" } });
      expect(await cardStatus(card)).toBe("proposed");
    });

    it("checks a declared pin precondition after the registered Projects transform stops emitting it", async () => {
      const project = await createIn("projects", { name: "Project", status: "inProgress", pinned: true });
      const projectsDb = await databaseIdFor("projects");
      const prepare = () =>
        withTransaction(pool, async (client) => {
          const db = await databasesStore.getDatabase(client, projectsDb);
          const [item] = await itemsStore.getItemsByIds(client, [project]);
          if (!db || !item) throw new Error("Missing project fixture");
          const properties = await propertiesStore.listPropertiesByDatabase(client, projectsDb);
          return {
            item,
            prepared: await prepareUserItemPatch(properties, { status: "done" }, db, item, "Europe/Prague"),
          };
        });
      const initial = await prepare();
      const order = initial.item.properties.pinnedOrder;
      if (typeof order !== "number") throw new Error("Missing project pin order");
      expect(initial.prepared.patch).toMatchObject({ status: "done", pinned: false, pinnedOrder: null });
      expect(initial.prepared.patch).not.toHaveProperty("completedAt");
      expect(initial.prepared.deferredKeys).not.toContain("completedAt");
      const card = await cardWithSteps("projects", [
        {
          ref: "project",
          op: "update",
          role: "primary",
          itemId: project,
          properties: { status: "done" },
          before: { properties: { status: "inProgress", pinned: true, pinnedOrder: order } },
          after: { properties: { status: "done", pinned: false, pinnedOrder: null } },
        },
      ]);
      await withTransaction(pool, (client) =>
        updateItemWithClient(client, { databaseId: projectsDb, itemId: project, propertiesPatch: { pinned: false } }),
      );
      const later = await prepare();
      expect(Object.hasOwn(later.prepared.patch, "pinned")).toBe(false);
      const [cardBefore] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [card]));
      await expect(confirm(card)).rejects.toMatchObject({ status: 400, details: { ref: "project", field: "pinned" } });
      const [targetAfter, cardAfter] = await withTransaction(pool, (client) =>
        itemsStore.getItemsByIds(client, [project, card]),
      );
      const byId = new Map(
        [targetAfter, cardAfter].filter((item) => item !== undefined).map((item) => [item.id, item]),
      );
      expect(byId.get(project)).toEqual(later.item);
      expect(byId.get(card)).toEqual(cardBefore);
    });

    it.each([
      [undefined, false, false],
      [{ marker: "late participant" }, false, false],
      [{ marker: "late participant" }, true, false],
      [{ marker: "late participant" }, false, true],
    ] as const)(
      "settles a blocked precondition contender after an owner failure %#",
      async (lateParticipant, injectPreCancel, injectPostCancel) => {
        const task = await createIn("tasks", { name: "Before" });
        const tasksDb = await databaseIdFor("tasks");
        const [before] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [task]));
        const runtime = getTestPool({ max: 3 });
        let release = () => {};
        let holderReady = (_pid: number) => {};
        let contenderReady = (_pid: number) => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const held = new Promise<number>((resolve) => {
          holderReady = resolve;
        });
        const competing = new Promise<number>((resolve) => {
          contenderReady = resolve;
        });
        const generations = new Map<PoolClient, object>();
        const cancellationRequests = new Set<object>();
        const releaseCompletions = new Set<object>();
        let holderClient: PoolClient | undefined;
        let contenderClient: PoolClient | undefined;
        let contenderGeneration: object | undefined;
        const preCancel = new Error("pre-cancellation diagnostic");
        const postCancel = new Error("unrelated post-cancellation diagnostic");
        let releaseCallbackFailure: { value: unknown } | undefined;
        const owned = ownOverlap(
          runtime,
          release,
          (_client, generation) => {
            cancellationRequests.add(generation);
          },
          (client, generation) => {
            generations.set(client, generation);
          },
          (client, generation) => {
            releaseCompletions.add(generation);
            if (injectPostCancel && client === holderClient) {
              try {
                client.emit("error", postCancel);
              } catch (error) {
                releaseCallbackFailure = { value: error };
                throw error;
              }
            }
          },
        );
        const bodyError = new Error("forced precondition overlap failure");
        let failure: { error: unknown } | undefined;
        let holderSettled = false;
        type ObservedClient = { generation: object; onError: (error: Error) => void };
        const observedClients = new Map<PoolClient, ObservedClient>();
        const diagnostics: Array<{
          error: Error;
          generation: object;
          cancelled: boolean;
          released: boolean;
          operation: string;
        }> = [];
        const observeAcquire = (client: PoolClient) => {
          const generation = generations.get(client);
          if (!generation) throw new Error("Missing client generation");
          const onError = (error: Error) =>
            diagnostics.push({
              error,
              generation,
              cancelled: cancellationRequests.has(generation),
              released: releaseCompletions.has(generation),
              operation: client === holderClient ? "holder" : client === contenderClient ? "contender" : "other",
            });
          observedClients.set(client, { generation, onError });
          client.on("error", onError);
        };
        const observeRelease = (_reason: unknown, client: PoolClient) => {
          const owner = observedClients.get(client);
          if (!owner) throw new Error("Unknown owned client release");
          if (cancellationRequests.has(owner.generation)) return;
          client.removeListener("error", owner.onError);
          observedClients.delete(client);
          generations.delete(client);
        };
        runtime.on("acquire", observeAcquire);
        runtime.on("release", observeRelease);
        let holderError: { value: unknown } | undefined;
        let contenderError:
          | {
              value: unknown;
              generation: object | undefined;
              cancellationRequested: boolean;
            }
          | undefined;
        let contenderSettled = false;
        let contenderFailed = false;
        try {
          const holder = owned.run(() =>
            withTransaction(runtime, async (client) => {
              holderClient = client;
              const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
              if (pid === undefined) throw new Error("Missing holder PID");
              await updateItemWithClient(client, {
                databaseId: tasksDb,
                itemId: task,
                propertiesPatch: { name: "Held" },
              });
              holderReady(pid);
              await gate;
              rethrowOverlap(lateParticipant);
            }),
          );
          void holder.then(
            () => {
              holderSettled = true;
            },
            (error: unknown) => {
              holderError = { value: error };
              holderSettled = true;
            },
          );
          const holderPid = await owned.wait(held, holder);
          await owned.wait(
            owned.run(() => assertItemHeld(task, holderPid, runtime)),
            holder,
          );
          const contender = owned.run(() =>
            withTransaction(runtime, async (client) => {
              contenderClient = client;
              contenderGeneration = generations.get(client);
              const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
              if (pid === undefined) throw new Error("Missing contender PID");
              contenderReady(pid);
              await updateItemWithClient(client, {
                databaseId: tasksDb,
                itemId: task,
                propertiesPatch: { name: "Contender" },
              });
            }),
          );
          void contender.then(
            () => {
              contenderSettled = true;
            },
            (error: unknown) => {
              contenderError = {
                value: error,
                generation: contenderGeneration,
                cancellationRequested:
                  contenderGeneration !== undefined && cancellationRequests.has(contenderGeneration),
              };
              contenderSettled = true;
              contenderFailed = true;
            },
          );
          const contenderPid = await owned.wait(competing, holder, contender);
          await owned.wait(
            owned.run(() =>
              expect
                .poll(
                  async () => {
                    const result = await runtime.query<{ blocked: boolean }>(
                      "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
                      [holderPid, contenderPid],
                    );
                    return result.rows[0]?.blocked;
                  },
                  { timeout: 5000 },
                )
                .toBe(true),
            ),
            holder,
            contender,
          );
          if (injectPreCancel) {
            if (!holderClient) throw new Error("Missing holder client");
            holderClient.emit("error", preCancel);
          }
          throw bodyError;
        } catch (error) {
          failure = { error };
        } finally {
          release();
          try {
            await owned.finish(failure !== undefined);
          } catch (error) {
            failure = combineOverlapFailure(failure, error);
          } finally {
            if (owned.isSettled()) {
              runtime.removeListener("acquire", observeAcquire);
              runtime.removeListener("release", observeRelease);
            }
          }
        }
        if (!owned.isSettled()) {
          if (failure) throw failure.error;
          throw new Error("Owned overlap did not settle");
        }
        for (const [client, owner] of observedClients) client.removeListener("error", owner.onError);
        observedClients.clear();
        const combined = failure?.error;
        expect(combined).toBeInstanceOf(AggregateError);
        if (!(combined instanceof AggregateError)) throw new Error("Expected combined failure");
        expect(combined.cause).toBe(bodyError);
        expect(combined.errors[0]).toBe(bodyError);
        const cleanup: unknown = combined.errors[1];
        expect(cleanup).toBeInstanceOf(AggregateError);
        if (!(cleanup instanceof AggregateError)) throw new Error("Expected cleanup failures");
        expect(holderError).toBeDefined();
        if (!holderError) throw new Error("Missing participant failure");
        expect(holderError.value).toBe(lateParticipant);
        expect(observedClients.size).toBe(0);
        for (const diagnostic of diagnostics) {
          expect(diagnostic.error).toBeInstanceOf(Error);
          if (diagnostic.error === preCancel) {
            expect(injectPreCancel).toBe(true);
            expect(diagnostic.released).toBe(false);
            expect(diagnostic.cancelled).toBe(false);
            expect(diagnostic.operation).toBe("holder");
          } else if (diagnostic.error === postCancel) {
            expect(diagnostic.released).toBe(true);
            expect(injectPostCancel).toBe(true);
            expect(diagnostic.cancelled).toBe(true);
            expect(diagnostic.operation).toBe("holder");
            expect(isOwnedPgClosure(diagnostic.error, "Connection terminated")).toBe(false);
          } else {
            expect(diagnostic.cancelled).toBe(true);
            expect(["holder", "contender"]).toContain(diagnostic.operation);
            expect(isOwnedPgClosure(diagnostic.error, "Connection terminated")).toBe(true);
            if (diagnostic.operation === "holder") expect(diagnostic.error).toBe(holderError.value);
            else expect(diagnostic.error).toBe(contenderError?.value);
          }
        }
        if (!contenderError) throw new Error("Missing contender failure");
        expect(contenderError.generation).toBeDefined();
        expect(isOwnedPgClosure(contenderError.value, "Connection terminated")).toBe(true);
        expect(contenderError.cancellationRequested).toBe(true);
        expect(diagnostics.filter((entry) => entry.error === preCancel)).toHaveLength(injectPreCancel ? 1 : 0);
        expect(diagnostics.filter((entry) => entry.error === postCancel)).toHaveLength(injectPostCancel ? 1 : 0);
        if (releaseCallbackFailure) expect(releaseCallbackFailure.value).toBe(postCancel);
        const expectedErrors = [
          ...diagnostics.flatMap((entry) =>
            entry.error === postCancel && releaseCallbackFailure
              ? [entry.error, releaseCallbackFailure.value]
              : [entry.error],
          ),
          holderError.value,
          contenderError.value,
        ];
        expect(combined.errors).toHaveLength(2);
        expect(cleanup.errors).toHaveLength(expectedErrors.length);
        for (let i = 0; i < expectedErrors.length; i++) expect(cleanup.errors[i]).toBe(expectedErrors[i]);
        expect(cleanup.cause).toBe(expectedErrors[0]);

        expect(holderSettled).toBe(true);
        expect(contenderSettled).toBe(true);
        expect(contenderFailed).toBe(true);
        expect(runtime.ended).toBe(true);
        expect(runtime.totalCount).toBe(0);
        expect(runtime.waitingCount).toBe(0);
        expect(runtime.listenerCount("acquire")).toBe(0);
        expect(runtime.listenerCount("release")).toBe(0);
        const [after] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [task]));
        expect(after).toEqual(before);
      },
      25000,
    );

    it("waits for an overlapping task time change and rejects the stale implicit clear", async () => {
      const task = await createIn("tasks", { name: "Task", date: "2026-11-01", timeFrom: "09:00", timeTo: "10:00" });
      const card = await cardWithSteps("tasks", [
        {
          ref: "task",
          op: "update",
          itemId: task,
          role: "primary",
          properties: { date: null },
          before: { properties: { date: "2026-11-01", timeFrom: "09:00", timeTo: "10:00" } },
          after: { properties: { date: null, timeFrom: null, timeTo: null } },
        },
      ]);
      const [cardBefore] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [card]));
      const tasksDb = await databaseIdFor("tasks");
      const [writer, contender] = await runPreconditionOverlap(
        (client) =>
          updateItemWithClient(client, {
            databaseId: tasksDb,
            itemId: task,
            propertiesPatch: { timeFrom: "09:30" },
          }),
        (client) => confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, card),
        (pid, observer) => assertItemHeld(task, pid, observer),
        ([first, second]) => {
          expect(first.status).toBe("fulfilled");
          expect(second).toMatchObject({
            status: "rejected",
            reason: { status: 400, details: { ref: "task", field: "timeFrom" } },
          });
        },
      );
      if (writer.status === "rejected") throw writer.reason;
      expect(contender).toMatchObject({
        status: "rejected",
        reason: { status: 400, details: { ref: "task", field: "timeFrom" } },
      });
      expect(await cardStatus(card)).toBe("proposed");
      const [cardAfter] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [card]));
      expect(cardAfter).toEqual(cardBefore);
      const [current] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [task]));
      expect(current?.properties).toMatchObject({ date: "2026-11-01", timeFrom: "09:30", timeTo: "10:00" });
    }, 25000);

    it("holds the Tasks precondition against a later valid schedule writer", async () => {
      const task = await createIn("tasks", { name: "Task", date: "2026-11-01", timeFrom: "09:00", timeTo: "10:00" });
      const card = await cardWithSteps("tasks", [
        {
          ref: "task",
          op: "update",
          itemId: task,
          role: "primary",
          properties: { date: null },
          before: { properties: { date: "2026-11-01", timeFrom: "09:00", timeTo: "10:00" } },
          after: { properties: { date: null, timeFrom: null, timeTo: null } },
        },
      ]);
      const tasksDb = await databaseIdFor("tasks");
      const [confirmation, writer] = await runPreconditionOverlap(
        async (client) => {
          const confirmed = await confirmProposalWithClient(
            client,
            { processingProposalsDatabaseId: proposalsId },
            card,
          );
          const [cleared] = await itemsStore.getItemsByIds(client, [task]);
          expect(cleared?.properties).toMatchObject({ date: null, timeFrom: null, timeTo: null, time: null });
          return confirmed;
        },
        (client) =>
          updateItemWithClient(client, {
            databaseId: tasksDb,
            itemId: task,
            propertiesPatch: { date: "2026-11-02", timeFrom: "09:30" },
          }),
        (pid, observer) => assertItemHeld(task, pid, observer),
      );
      if (confirmation.status === "rejected") throw confirmation.reason;
      if (writer.status === "rejected") throw writer.reason;
      expect(confirmation.value.properties.status).toBe("confirmed");
      expect(await cardStatus(card)).toBe("confirmed");
      expect(writer.value.properties).toMatchObject({
        date: "2026-11-02",
        timeFrom: "09:30",
        timeTo: null,
        time: "09:30",
      });
      const [current] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [task]));
      expect(current?.properties).toMatchObject({ date: "2026-11-02", timeFrom: "09:30", timeTo: null, time: "09:30" });
    }, 25000);

    it("rolls back an earlier created item when a later update has stale before values", async () => {
      const task = await createIn("tasks", { name: "Actual" });
      const card = await cardWithSteps("companies", [
        { ref: "company", op: "create", databaseKey: "companies", role: "primary", properties: { name: "Acme" } },
        {
          ref: "task",
          op: "update",
          itemId: task,
          role: "secondary",
          properties: { name: "After" },
          before: { properties: { name: "Old" } },
          after: { properties: { name: "After" } },
        },
      ]);
      await expect(confirm(card)).rejects.toMatchObject({ status: 400, details: { ref: "task", field: "name" } });
      expect(await countItems("companies")).toBe(0);
      expect(await cardStatus(card)).toBe("proposed");
      const [result] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [task]));
      expect(result?.properties.name).toBe("Actual");
    });

    it("allocates a project pin order after another project is pinned", async () => {
      const project = await createIn("projects", { name: "First", pinned: false });
      const other = await createIn("projects", { name: "Other", pinned: false });
      const card = await cardWithSteps("projects", [
        {
          ref: "project",
          op: "update",
          itemId: project,
          role: "primary",
          properties: { pinned: true },
          before: { properties: { pinned: false, pinnedOrder: null } },
          after: { properties: { pinned: true } },
        },
      ]);
      const projectsDb = await databaseIdFor("projects");
      const earlier = await withTransaction(pool, (client) =>
        updateItemWithClient(client, {
          databaseId: projectsDb,
          itemId: other,
          propertiesPatch: { pinned: true },
        }),
      );
      await confirm(card);
      const [result] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [project]));
      expect(typeof earlier.properties.pinnedOrder).toBe("number");
      expect(result?.properties.pinnedOrder).toBe(Number(earlier.properties.pinnedOrder) + 1);
    });

    it("forms and confirms project completion without predicting its system date", async () => {
      const project = await createIn("projects", { name: "Project", status: "inProgress", pinned: false });
      const projectsDb = await databaseIdFor("projects");
      const step: Step = {
        ref: "project",
        op: "update",
        itemId: project,
        role: "primary",
        properties: { status: "done" },
      };
      const form = (properties: Record<string, unknown>) =>
        withTransaction(pool, (client) =>
          prepareComputedUpdates(
            client,
            { entityKind: "database", target: projectsDb, properties, operations: [{ ...step, properties }] },
            null,
          ),
        );
      const [before] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [project]));
      await expect(form({ completedAt: "2000-01-01" })).rejects.toMatchObject({ status: 400 });
      expect((await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [project])))[0]).toEqual(before);
      const formed = await form({ status: "done" });
      const formedStep = formed.operations?.[0];
      if (!formedStep) throw new Error("Missing formed project step");
      expect(formedStep.before?.properties).not.toHaveProperty("completedAt");
      expect(formedStep.after?.properties).not.toHaveProperty("completedAt");
      const card = await cardWithSteps("projects", [formedStep]);
      await confirm(card);
      const [updated] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [project]));
      expect(updated?.properties).toMatchObject({
        status: "done",
        completedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      });
    });

    describe("an Event update whose date carries an offset (issues #1598, C7)", () => {
      const offsetStep = (event: string): Step => ({
        ref: "event",
        op: "update",
        itemId: event,
        role: "primary",
        properties: { date: "2026-10-16T08:00:00Z" },
      });
      const form = async (event: string) => {
        const eventsDb = await databaseIdFor("events");
        const step = offsetStep(event);
        return withTransaction(pool, (client) =>
          prepareComputedUpdates(
            client,
            { entityKind: "database", target: eventsDb, properties: step.properties ?? {}, operations: [step] },
            "2026-10-16",
          ),
        );
      };
      const readEvent = async (event: string) =>
        (await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [event])))[0];
      const setZone = (zone: string) =>
        withTransaction(pool, async (client) =>
          updateItemWithClient(client, {
            databaseId: await getSystemSettingsDatabaseId(client),
            itemId: await getSystemSettingsItemId(client),
            propertiesPatch: { timezone: zone },
          }),
        );

      it("forms before/after values with the tenant zone, validates the envelope and confirms the converted values", async () => {
        const event = await createIn("events", { name: "Sync", type: "meeting", date: "2026-10-16" });
        const formed = await form(event);
        const step = formed.operations?.[0];
        if (!step) throw new Error("Missing formed Event step");
        expect(step.before?.properties).toEqual({ date: "2026-10-16", timeFrom: null, timeTo: null });
        expect(step.after?.properties).toEqual({ date: "2026-10-16", timeFrom: "10:00", timeTo: "11:00" });
        await withTransaction(pool, (client) => assertValidProposalEnvelope(client, formed));

        const card = await cardWithSteps("events", [step]);
        await confirm(card);
        expect((await readEvent(event))?.properties).toMatchObject({
          date: "2026-10-16",
          timeFrom: "10:00",
          timeTo: "11:00",
          time: "10:00–11:00",
        });
        expect(await cardStatus(card)).toBe("confirmed");
      });

      it("refuses an envelope whose after values ignore the conversion, at validation and at confirmation", async () => {
        const event = await createIn("events", { name: "Sync", type: "meeting", date: "2026-10-16" });
        const formed = await form(event);
        const step = formed.operations?.[0];
        if (!step) throw new Error("Missing formed Event step");
        const raw: Step = {
          ...step,
          after: { ...step.after, properties: { date: "2026-10-16T08:00:00Z", timeFrom: null, timeTo: null } },
        };
        const envelope = { ...formed, operations: [raw] };
        await expect(
          withTransaction(pool, (client) => assertValidProposalEnvelope(client, envelope)),
        ).rejects.toMatchObject({
          status: 400,
          details: { ref: "event" },
        });
        const before = await readEvent(event);
        const card = await cardWithSteps("events", [raw]);
        await expect(confirm(card)).rejects.toMatchObject({ status: 400, details: { ref: "event" } });
        expect(await readEvent(event)).toEqual(before);
        expect(await cardStatus(card)).toBe("proposed");
      });

      it("refuses confirmation without writes when the tenant zone changed after the proposal was formed", async () => {
        const event = await createIn("events", { name: "Sync", type: "meeting", date: "2026-10-16" });
        const formed = await form(event);
        const step = formed.operations?.[0];
        if (!step) throw new Error("Missing formed Event step");
        const card = await cardWithSteps("events", [step]);
        const before = await readEvent(event);
        await setZone("America/New_York");
        await expect(confirm(card)).rejects.toMatchObject({
          status: 400,
          details: { ref: "event", field: "timeFrom" },
        });
        expect(await readEvent(event)).toEqual(before);
        expect(await cardStatus(card)).toBe("proposed");
      });
    });

    describe("an invalid stored tenant time zone during a tick (issue #1598)", () => {
      /** Raw SQL: the settings write refuses an invalid zone, so only a corrupted settings row holds one. */
      async function corruptTenantZone(): Promise<void> {
        const settingsDatabaseId = await withTransaction(pool, (client) => getSystemSettingsDatabaseId(client));
        const result = await pool.query(
          `UPDATE items SET properties = properties || '{"timezone": "Not/AZone"}'::jsonb WHERE database_id = $1`,
          [settingsDatabaseId],
        );
        expect(result.rowCount).toBe(1);
      }

      async function taskInboxItems(...texts: string[]): Promise<string[]> {
        const type = await withTransaction(pool, (client) =>
          createInboxTypeWithClient(client, {
            inboxItemTypesDatabaseId: typesId,
            name: "Task",
            emoji: "☑️",
            processingMethod: "database",
            targetDatabase: "tasks",
          }),
        );
        const ids: string[] = [];
        for (const text of texts) {
          const item = await withTransaction(pool, (client) =>
            createInboxItemWithClient(client, {
              inboxDatabaseId: inboxId,
              date: "2026-08-28",
              time: "09:00",
              text,
              type: type.id,
            }),
          );
          ids.push(item.id);
        }
        return ids;
      }

      /** A two-operation answer, a new Task plus an update of an existing one, so the tick prepares an update step. */
      const twoSteps =
        (
          existingTaskId: string,
          update: Record<string, unknown> = { name: "Buy oat milk" },
        ): ComputeSemprecProposalFn =>
        async () => ({
          properties: { name: "Buy milk" },
          operations: [
            { op: "create", database: "tasks", properties: { name: "Buy milk" } },
            { op: "update", itemId: existingTaskId, properties: update },
          ],
        });

      async function proposalRows() {
        const { rows } = await pool.query<{ id: string; properties: Record<string, unknown>; updated_at: string }>(
          "SELECT id, properties, updated_at::text FROM items WHERE database_id = $1 ORDER BY id",
          [proposalsId],
        );
        return rows;
      }

      const readTask = async (taskId: string) =>
        (await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [taskId])))[0];

      function expectSettingsFailure(failure: unknown): void {
        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBeInstanceOf(ValidationError);
        if (!(failure instanceof Error)) return;
        expect(failure.message).toBe("The tenant time zone setting is invalid");
        expect(failure.cause).toBeInstanceOf(ValidationError);
        expect(failure.cause).toMatchObject({ details: { field: "timezone" } });
      }

      it("propagates from the computed update preparation of a tick and writes no card", async () => {
        const existing = await createIn("tasks", { name: "Buy milk" });
        const [control, source] = await taskInboxItems("Buy milk", "Buy milk again");
        // With the stored zone valid the same answer becomes a proposed card.
        await runTick(control!, twoSteps(existing));
        expect((await findProposalForItem(control!))?.properties.status).toBe("proposed");

        await corruptTenantZone();
        const cardsBefore = await proposalRows();
        const taskBefore = await readTask(existing);
        const failure = await runTick(source!, twoSteps(existing)).then(
          () => null,
          (error: unknown) => error,
        );
        expectSettingsFailure(failure);
        expect(await findProposalForItem(source!)).toBeNull();
        expect(await proposalRows()).toEqual(cardsBefore);
        expect(await readTask(existing)).toEqual(taskBefore);
      });

      it("propagates from the step validation that reopens a restored source's card and leaves the card as it was", async () => {
        const existing = await createIn("tasks", { name: "Buy milk" });
        const [source] = await taskInboxItems("Buy milk");
        await runTick(source!, twoSteps(existing));
        expect((await findProposalForItem(source!))?.properties.status).toBe("proposed");
        await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, source!));
        await runTick(source!, async () => {
          throw new Error("computeProposal must not be called for a deleted source");
        });
        const invalid = await findProposalForItem(source!);
        expect(invalid?.properties.status).toBe("invalid");
        await withTransaction(pool, (client) => itemsStore.restoreItem(client, inboxId, source!));

        await corruptTenantZone();
        const cardsBefore = await proposalRows();
        const failure = await runTick(source!, async () => {
          throw new Error("computeProposal must not be called before the stored card is revalidated");
        }).then(
          () => null,
          (error: unknown) => error,
        );
        expectSettingsFailure(failure);
        expect(await findProposalForItem(source!)).toEqual(invalid);
        expect(await proposalRows()).toEqual(cardsBefore);
        expect(await readTask(existing)).toMatchObject({ properties: { name: "Buy milk" } });
      });

      it("still turns an invalid computed update into a clarification card while the stored zone is valid", async () => {
        const existing = await createIn("tasks", { name: "Buy milk" });
        const [source] = await taskInboxItems("Buy milk");
        const taskBefore = await readTask(existing);
        await runTick(source!, twoSteps(existing, { notAProperty: "x" }));
        expect((await findProposalForItem(source!))?.properties.status).toBe("needsClarification");
        expect(await readTask(existing)).toEqual(taskBefore);
      });
    });

    it("requires coverage for automatic project unpinning and order clearing", async () => {
      const project = await createIn("projects", { name: "Project", status: "inProgress", pinned: true });
      const [current] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [project]));
      const order = current?.properties.pinnedOrder;
      if (typeof order !== "number") throw new Error("Missing allocated pin order");
      const step: Step = {
        ref: "project",
        op: "update",
        itemId: project,
        role: "primary",
        properties: { status: "done" },
        before: { properties: { status: "inProgress" } },
        after: { properties: { status: "done" } },
      };
      const incomplete = await cardWithSteps("projects", [step]);
      await expect(confirm(incomplete)).rejects.toMatchObject({
        status: 400,
        details: { ref: "project", field: "pinned" },
      });
      expect(await cardStatus(incomplete)).toBe("proposed");
      const complete = await cardWithSteps("projects", [
        {
          ...step,
          before: { properties: { status: "inProgress", pinned: true, pinnedOrder: order } },
          after: { properties: { status: "done", pinned: false, pinnedOrder: null } },
        },
      ]);
      await confirm(complete);
      const [updated] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [project]));
      expect(updated?.properties).toMatchObject({ status: "done", pinned: false, pinnedOrder: null });
      expect(updated?.properties.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("retains a declared pin-order precondition when a concurrent pin removes the deferred allocation", async () => {
      const project = await createIn("projects", { name: "Project", pinned: false });
      const projectsDb = await databaseIdFor("projects");
      // Simulate a legacy pinned row predating automatic pin-order allocation.
      await withTransaction(pool, (client) =>
        itemsStore.updateItemProperties(client, {
          databaseId: projectsDb,
          itemId: project,
          propertiesPatch: { pinned: true, pinnedOrder: null },
        }),
      );
      const card = await cardWithSteps("projects", [
        {
          ref: "project",
          op: "update",
          itemId: project,
          role: "primary",
          properties: { pinned: true },
          before: { properties: { pinnedOrder: null, pinned: true } },
          after: { properties: { pinned: true } },
        },
      ]);
      await withTransaction(pool, (client) =>
        updateItemWithClient(client, {
          databaseId: projectsDb,
          itemId: project,
          propertiesPatch: { pinned: true },
        }),
      );
      await expect(confirm(card)).rejects.toMatchObject({
        status: 400,
        details: { ref: "project", field: "pinnedOrder" },
      });
      expect(await cardStatus(card)).toBe("proposed");
    });

    it("an update step's status goes through the choke point; a failing later step restores the old status and edge", async () => {
      const project = await createIn("projects", { name: "Ship" });
      const area = await createIn("areas", { name: "Work" });
      const update: Step = {
        ref: "project",
        op: "update",
        itemId: project,
        role: "primary",
        properties: { status: "done" },
        relations: { area: [area] },
        before: { properties: { status: "inProgress" }, relations: { area: [] } },
        after: { properties: { status: "done" }, relations: { area: [area] } },
      };
      const statusOf = async () =>
        (
          await pool.query<{ status: string }>("SELECT properties->>'status' AS status FROM items WHERE id = $1", [
            project,
          ])
        ).rows[0]!.status;

      const failingCard = await cardWithSteps("projects", [
        update,
        {
          ref: "person",
          op: "create",
          databaseKey: "people",
          role: "secondary",
          properties: { name: 42 },
        },
      ]);
      await expect(confirm(failingCard)).rejects.toMatchObject({ details: { ref: "person" } });
      expect(await statusOf()).toBe("inProgress");
      expect(await edgeExists(project, area)).toBe(false);

      const okCard = await cardWithSteps("projects", [update]);
      await confirm(okCard);
      expect(await statusOf()).toBe("done");
    });

    it.each(["property", "insert", "delete", "insert-extra", "delete-extra"] as const)(
      "rejects stale before state after an overlapping %s commits",
      async (change) => {
        const project = await createIn("projects", { name: "Before" });
        const area = await createIn("areas", { name: "Area" });
        const projectsDb = await databaseIdFor("projects");
        const property = await withTransaction(pool, (client) =>
          propertiesStore.getPropertyByKey(client, projectsDb, "area"),
        );
        if (!property) throw new Error("Missing Projects.area property");
        const edge = { relationPropertyId: property.id, callerItemId: project, targetItemId: area };
        if (change === "delete" || change === "delete-extra")
          await withTransaction(pool, (client) => createRelationWithClient(client, edge));
        const beforeTargets = change === "delete" || change === "delete-extra" ? [area] : [];
        const extraOnly = change.endsWith("-extra");
        const card = await cardWithSteps("projects", [
          {
            ref: "project",
            op: "update",
            itemId: project,
            role: "primary",
            properties: { name: "After" },
            ...(extraOnly ? {} : { relations: { area: beforeTargets } }),
            before: { properties: { name: "Before" }, relations: { area: beforeTargets } },
            after: { properties: { name: "After" }, ...(extraOnly ? {} : { relations: { area: beforeTargets } }) },
          },
        ]);
        const [cardBefore] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [card]));
        const definition = await withTransaction(pool, (client) =>
          relationsStore.getRelationDefinitionByPropertyId(client, property.id),
        );
        if (!definition) throw new Error("Missing relation definition");
        const [writer, contender] = await runPreconditionOverlap(
          async (client) => {
            if (change === "property") {
              await updateItemWithClient(client, {
                databaseId: projectsDb,
                itemId: project,
                propertiesPatch: { name: "Changed" },
              });
            } else if (change === "insert" || change === "insert-extra") {
              await createRelationWithClient(client, edge);
            } else {
              await deleteRelationWithClient(client, edge);
            }
          },
          (client) => confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, card),
          (pid, observer) =>
            change === "property"
              ? assertItemHeld(project, pid, observer)
              : change === "insert" || change === "insert-extra"
                ? assertDefinitionHeld(definition.id, pid, observer)
                : assertEdgeHeld(definition.id, project, area, pid, observer),
          ([first, second]) => {
            expect(first.status).toBe("fulfilled");
            expect(second).toMatchObject({
              status: "rejected",
              reason: { status: 400, details: { ref: "project", field: change === "property" ? "name" : "area" } },
            });
          },
        );
        if (writer.status === "rejected") throw writer.reason;
        expect(contender).toMatchObject({
          status: "rejected",
          reason: { status: 400, details: { ref: "project", field: change === "property" ? "name" : "area" } },
        });
        expect(await cardStatus(card)).toBe("proposed");
        const [cardAfter] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [card]));
        expect(cardAfter).toEqual(cardBefore);
        const [current] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [project]));
        expect(current?.properties.name).toBe(change === "property" ? "Changed" : "Before");
        expect(await edgeExists(project, area)).toBe(change === "insert" || change === "insert-extra");
      },
      25000,
    );

    it.each(["property", "insert", "delete", "insert-extra", "delete-extra"] as const)(
      "holds precondition locks against a later overlapping %s",
      async (change) => {
        const project = await createIn("projects", { name: "Before" });
        const area = await createIn("areas", { name: "Area" });
        const projectsDb = await databaseIdFor("projects");
        const property = await withTransaction(pool, (client) =>
          propertiesStore.getPropertyByKey(client, projectsDb, "area"),
        );
        if (!property) throw new Error("Missing Projects.area property");
        const edge = { relationPropertyId: property.id, callerItemId: project, targetItemId: area };
        if (change === "delete" || change === "delete-extra")
          await withTransaction(pool, (client) => createRelationWithClient(client, edge));
        const beforeTargets = change === "delete" || change === "delete-extra" ? [area] : [];
        const extraOnly = change.endsWith("-extra");
        const card = await cardWithSteps("projects", [
          {
            ref: "project",
            op: "update",
            itemId: project,
            role: "primary",
            properties: { name: "After" },
            ...(extraOnly ? {} : { relations: { area: beforeTargets } }),
            before: { properties: { name: "Before" }, relations: { area: beforeTargets } },
            after: { properties: { name: "After" }, ...(extraOnly ? {} : { relations: { area: beforeTargets } }) },
          },
        ]);
        const definition = await withTransaction(pool, (client) =>
          relationsStore.getRelationDefinitionByPropertyId(client, property.id),
        );
        if (!definition) throw new Error("Missing relation definition");
        const [confirmation, writer] = await runPreconditionOverlap(
          (client) => confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, card),
          async (client) => {
            if (change === "property") {
              await updateItemWithClient(client, {
                databaseId: projectsDb,
                itemId: project,
                propertiesPatch: { name: "Later" },
              });
            } else if (change === "insert" || change === "insert-extra") {
              await createRelationWithClient(client, edge);
            } else {
              await deleteRelationWithClient(client, edge);
            }
          },
          async (pid, observer) => {
            await assertItemHeld(project, pid, observer);
            await assertDefinitionHeld(definition.id, pid, observer);
            if (change === "delete" || change === "delete-extra")
              await assertEdgeHeld(definition.id, project, area, pid, observer);
          },
        );
        if (confirmation.status === "rejected") throw confirmation.reason;
        if (writer.status === "rejected") throw writer.reason;
        expect(await cardStatus(card)).toBe("confirmed");
        const [current] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [project]));
        expect(current?.properties.name).toBe(change === "property" ? "Later" : "After");
        expect(await edgeExists(project, area)).toBe(change === "insert" || change === "insert-extra");
      },
      25000,
    );

    it("a repeated confirm returns the confirmed card and creates nothing twice", async () => {
      const card = await cardWithSteps("companies", companyAndPerson());
      await confirm(card);
      await confirm(card);
      expect(await countItems("companies")).toBe(1);
      expect(await countItems("people")).toBe(1);
    });

    it("returns the Inbox flag on a Files query after a real confirmation", async () => {
      const card = await cardWithSteps("files", [
        { ref: "file", op: "create", databaseKey: "files", role: "primary", properties: { name: "From Inbox" } },
      ]);
      const confirmed = await confirm(card);
      const manual = await createIn("files", { name: "Manual" });
      const page = await createChokePoint(pool).queryDatabaseItems(await databaseIdFor("files"), {});
      expect(page.items.find((item) => item.id === confirmed.properties.resultItemId)?.fromInbox).toBe(true);
      expect(page.items.find((item) => item.id === manual)?.fromInbox).toBe(false);
    });

    it("addresses every realtime invalidation of a confirm to the acting user", async () => {
      const card = await cardWithSteps("companies", companyAndPerson());
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        const actingUserId = randomUUID();
        await confirm(card, actingUserId);
        const itemEvents = events.filter((event) => event.scope === "item");
        expect(itemEvents.length).toBeGreaterThanOrEqual(3);
        expect(itemEvents.every((event) => event.userId === actingUserId)).toBe(true);
      } finally {
        setInvalidationHook(() => {});
      }
    });

    describe("item origins (issue #1659)", () => {
      interface OriginRow {
        item_id: string;
        proposal_id: string;
        inbox_item_id: string | null;
        source_transcript_id: string | null;
        captured_at: Date | null;
        capture_channel: string;
        capture_time_basis: string;
      }
      const originRows = async () => (await pool.query<OriginRow>("SELECT * FROM item_origins ORDER BY item_id")).rows;
      const sourceInboxItemId = (cardId: string) =>
        withTransaction(pool, async (client) => {
          const property = await propertiesStore.getPropertyByKey(client, proposalsId, "sourceInbox");
          const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property!.id);
          const [edge] = await relationsStore.listRelationsForItem(client, definition!.id, cardId);
          return relationsStore.otherSide(edge!, cardId);
        });
      const createdIds = async () =>
        (
          await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = ANY($1)", [
            [await databaseIdFor("companies"), await databaseIdFor("people")],
          ])
        ).rows.map((row) => row.id);

      it("writes one row per created item with the card, the source Inbox item and its capture time", async () => {
        const card = await cardWithSteps("companies", companyAndPerson());
        await confirm(card);

        const inboxItemId = await sourceInboxItemId(card);
        const [inboxItem] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [inboxItemId]));
        const rows = await originRows();
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.item_id).sort()).toEqual((await createdIds()).sort());
        for (const row of rows) {
          expect(row.proposal_id).toBe(card);
          expect(row.inbox_item_id).toBe(inboxItemId);
          expect(row.source_transcript_id).toBeNull();
          expect(row.capture_channel).toBe("inbox");
          expect(row.capture_time_basis).toBe("inboxCapture");
          expect(row.captured_at?.toISOString()).toBe(
            DateTime.fromISO(`${String(inboxItem!.properties.date)}T${String(inboxItem!.properties.time)}`, {
              zone: await withTransaction(pool, getSystemTimezone),
            })
              .toUTC()
              .toISO(),
          );
        }
      });

      it.each([null, "invalid"])("records an unknown time for an Inbox capture date %s", async (date) => {
        const card = await cardWithSteps("companies", companyAndPerson());
        const inboxItemId = await sourceInboxItemId(card);
        await withTransaction(pool, (client) =>
          updateItemWithClient(client, { databaseId: inboxId, itemId: inboxItemId, propertiesPatch: { date } }),
        );
        await confirm(card);
        expect((await originRows()).map((row) => [row.captured_at, row.capture_time_basis])).toEqual([
          [null, "unknown"],
          [null, "unknown"],
        ]);
      });

      it.each([null, "invalid"])("records an unknown time for an Inbox capture time %s", async (time) => {
        const card = await cardWithSteps("companies", companyAndPerson());
        const inboxItemId = await sourceInboxItemId(card);
        await withTransaction(pool, (client) =>
          updateItemWithClient(client, { databaseId: inboxId, itemId: inboxItemId, propertiesPatch: { time } }),
        );
        await confirm(card);
        expect((await originRows()).map((row) => [row.captured_at, row.capture_time_basis])).toEqual([
          [null, "unknown"],
          [null, "unknown"],
        ]);
      });

      it("marks an old writer's timestamp unverified", async () => {
        await pool.query(
          `INSERT INTO item_origins (item_id, proposal_id, captured_at, capture_channel)
           VALUES ($1, $2, $3, 'inbox')`,
          [randomUUID(), randomUUID(), "2026-01-01T00:00:00Z"],
        );
        const [row] = await originRows();
        expect(row?.captured_at?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
        expect(row?.capture_time_basis).toBe("legacyUnverified");
      });

      it.each([
        ["inboxCapture", null],
        ["unknown", "2026-01-01T00:00:00Z"],
      ])("rejects inconsistent %s capture provenance", async (basis, capturedAt) => {
        await expect(
          pool.query(
            `INSERT INTO item_origins (item_id, proposal_id, captured_at, capture_channel, capture_time_basis)
           VALUES ($1, $2, $3, 'inbox', $4)`,
            [randomUUID(), randomUUID(), capturedAt, basis],
          ),
        ).rejects.toMatchObject({ code: "23514", constraint: "item_origins_capture_provenance_check" });
      });

      it("preserves populated legacy timestamps when the migration runs", async () => {
        const migration = await readFile(
          new URL("../db/migrations/0126_item_origin_capture_time_basis.sql", import.meta.url),
          "utf8",
        );
        await withTransaction(pool, async (client) => {
          await client.query("CREATE TEMP TABLE item_origins (captured_at timestamptz NOT NULL) ON COMMIT DROP");
          await client.query("INSERT INTO item_origins (captured_at) VALUES ($1)", ["2026-01-01T00:00:00Z"]);
          await client.query(migration);
          const { rows } = await client.query<{ captured_at: Date; capture_time_basis: string }>(
            "SELECT captured_at, capture_time_basis FROM item_origins",
          );
          expect(rows[0]?.captured_at.toISOString()).toBe("2026-01-01T00:00:00.000Z");
          expect(rows[0]?.capture_time_basis).toBe("legacyUnverified");
        });
      });

      it("upgrades populated tenant origins through the migration runner and retains runtime isolation", async () => {
        const connection = process.env.TEST_DATABASE_URL;
        if (!connection) throw new Error("Missing TEST_DATABASE_URL");
        const name = `origin_upgrade_${randomUUID().replaceAll("-", "")}`;
        const admin = createPool(connection);
        const url = new URL(connection);
        url.pathname = `/${name}`;
        const scratch = createPool(url.toString());
        const directory = await mkdtemp(path.join(tmpdir(), "semprec-origin-upgrade-"));
        const migrations = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");
        const current = "0126_item_origin_capture_time_basis.sql";
        let created = false;
        let failure: { error: unknown } | undefined;
        try {
          await admin.query(`CREATE DATABASE "${name}" ENCODING 'UTF8' TEMPLATE template0`);
          created = true;
          for (const file of (await readdir(migrations)).filter((f) => f.endsWith(".sql") && f < current).sort()) {
            await copyFile(path.join(migrations, file), path.join(directory, file));
          }
          await runMigrations(scratch, directory);
          const tenants = await scratch.query<{ id: string }>("SELECT id FROM tenants");
          const first = tenants.rows[0]?.id;
          if (!first) throw new Error("Missing migrated tenant");
          const second = randomUUID();
          await scratch.query("INSERT INTO tenants (id, status) VALUES ($1, 'active')", [second]);
          const firstItem = randomUUID();
          const secondItem = randomUUID();
          // Simulate the prior release's writer on the real tenant-scoped table.
          await scratch.query(
            `INSERT INTO item_origins (tenant_id, item_id, proposal_id, captured_at, capture_channel)
             VALUES ($1, $2, $3, '2026-01-01T00:00:00Z', 'inbox'),
                    ($4, $5, $6, '2026-02-01T00:00:00Z', 'inbox')`,
            [first, firstItem, randomUUID(), second, secondItem, randomUUID()],
          );
          await copyFile(path.join(migrations, current), path.join(directory, current));
          await runMigrations(scratch, directory);
          await withTransaction(scratch, async (client) => {
            await client.query("SET LOCAL ROLE semprec_side");
            await client.query("SELECT set_config('app.tenant_id', $1, true)", [first]);
            const { rows } = await client.query<{ item_id: string; captured_at: Date; capture_time_basis: string }>(
              "SELECT item_id, captured_at, capture_time_basis FROM item_origins",
            );
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ item_id: firstItem, capture_time_basis: "legacyUnverified" });
            expect(rows[0]?.captured_at.toISOString()).toBe("2026-01-01T00:00:00.000Z");
          });
          await withTransaction(scratch, async (client) => {
            await client.query("SET LOCAL ROLE semprec_side");
            await client.query("SELECT set_config('app.tenant_id', $1, true)", [second]);
            const { rows } = await client.query<{ item_id: string; captured_at: Date; capture_time_basis: string }>(
              "SELECT item_id, captured_at, capture_time_basis FROM item_origins",
            );
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ item_id: secondItem, capture_time_basis: "legacyUnverified" });
            expect(rows[0]?.captured_at.toISOString()).toBe("2026-02-01T00:00:00.000Z");
          });
        } catch (error) {
          failure = { error };
        }
        for (const cleanup of [
          () => scratch.end(),
          async () => {
            if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
          },
          () => admin.end(),
          () => rm(directory, { recursive: true, force: true }),
        ]) {
          try {
            await cleanup();
          } catch (error) {
            failure ??= { error };
          }
        }
        if (failure) throw failure.error;
      }, 120_000);

      it("records no guessed time for a revised transcript card", async () => {
        const transcriptsId = await databaseIdFor("transcripts");
        const transcript = await withTransaction(pool, (client) =>
          createItemWithClient(
            client,
            { databaseId: transcriptsId, properties: { name: "Meeting", date: "2024-03-01T12:00:00.000Z" } },
            { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
          ),
        );
        await withTransaction(pool, (client) =>
          matchTranscriptToEvent(client, { transcriptId: transcript.id, durationSeconds: 60 }),
        );
        const { rows } = await pool.query<{ id: string }>(
          "SELECT id FROM items WHERE database_id = $1 AND properties->>'kind' = 'transcript'",
          [proposalsId],
        );
        const cardId = rows[0]?.id;
        if (!cardId) throw new Error("Missing transcript card");
        const eventsId = await databaseIdFor("events");
        await withTransaction(pool, (client) =>
          reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId, {
            message: "Revised",
            entityKind: "database",
            target: eventsId,
            properties: { name: "Meeting", date: "2024-03-01" },
          }),
        );
        await confirm(cardId);
        const [row] = await originRows();
        expect(row).toMatchObject({
          source_transcript_id: transcript.id,
          capture_channel: "transcript",
          captured_at: null,
          capture_time_basis: "unknown",
        });
      });

      it("writes one row for a single-step database proposal", async () => {
        const card = await createDatabaseProposal("Buy milk");
        const confirmed = await confirm(card.id);
        const rows = await originRows();
        expect(rows.map((row) => row.item_id)).toEqual([confirmed.properties.resultItemId]);
        expect(rows[0]!.proposal_id).toBe(card.id);
      });

      it("writes no row for an item a step only patches", async () => {
        const existing = await createIn("companies", { name: "Existing" });
        const card = await cardWithSteps("companies", [
          {
            ref: "company",
            op: "update",
            itemId: existing,
            role: "primary",
            properties: { name: "Renamed" },
            before: { properties: { name: "Existing" } },
            after: { properties: { name: "Renamed" } },
          },
          {
            ref: "person",
            op: "create",
            databaseKey: "people",
            role: "secondary",
            properties: { name: "Jane" },
            relations: { companies: [{ ref: "company" }] },
          },
        ]);
        await confirm(card);
        const rows = await originRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.item_id).not.toBe(existing);
      });

      it("writes no row when the confirm fails and rolls back", async () => {
        const failing = companyAndPerson();
        failing[1] = { ...failing[1]!, properties: { name: 42 } };
        const card = await cardWithSteps("companies", failing);
        await confirm(card).catch(() => undefined);
        expect(await originRows()).toEqual([]);
      });

      it("rolls back created items and origins when origin insertion fails", async () => {
        const card = await cardWithSteps("companies", companyAndPerson());
        const cardBefore = await withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, card));
        const edgeCountBefore = (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM item_relations"))
          .rows[0]?.n;
        await pool.query(`CREATE FUNCTION reject_second_origin_test() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF EXISTS (SELECT 1 FROM item_origins WHERE proposal_id = NEW.proposal_id) THEN
              RAISE EXCEPTION 'injected origin insertion failure';
            END IF;
            RETURN NEW;
          END $$`);
        try {
          await pool.query(`CREATE TRIGGER reject_second_origin_test BEFORE INSERT ON item_origins
            FOR EACH ROW EXECUTE FUNCTION reject_second_origin_test()`);
          await expect(confirm(card)).rejects.toThrow("injected origin insertion failure");
          expect(await countItems("companies")).toBe(0);
          expect(await countItems("people")).toBe(0);
          expect(await originRows()).toEqual([]);
          expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM item_relations")).rows[0]?.n).toBe(
            edgeCountBefore,
          );
          expect(await withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, card))).toEqual(
            cardBefore,
          );
        } finally {
          await pool.query("DROP TRIGGER IF EXISTS reject_second_origin_test ON item_origins");
          await pool.query("DROP FUNCTION reject_second_origin_test()");
        }
      });

      it("a repeated confirm adds and changes no row", async () => {
        const card = await cardWithSteps("companies", companyAndPerson());
        await confirm(card);
        const before = await originRows();
        await confirm(card);
        expect(await originRows()).toEqual(before);
      });

      it("permanent deletion removes the item's row and keeps the other item's", async () => {
        const card = await cardWithSteps("companies", companyAndPerson());
        const confirmed = await confirm(card);
        const resultId = confirmed.properties.resultItemId;
        if (typeof resultId !== "string") throw new Error("Expected created item");
        const [row] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [resultId]));
        if (!row) throw new Error("Expected created item row");
        const chokePoint = createChokePoint(pool);
        await chokePoint.softDeleteItem(row.databaseId, resultId);
        const result = await chokePoint.purgeExpiredTrashSubtree(resultId, new Date(Date.now() + 1000));
        expect(result.purgedItemIds).toContain(resultId);
        expect(
          await withTransaction(pool, (client) => itemsStore.getItemsByIdsIncludingDeleted(client, [resultId])),
        ).toEqual([]);
        const rows = await originRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.item_id).not.toBe(resultId);
      });

      it("rolls back the hard deletion if origin cleanup fails", async () => {
        const confirmed = await confirm(await cardWithSteps("companies", companyAndPerson()));
        const itemId = confirmed.properties.resultItemId;
        if (typeof itemId !== "string") throw new Error("Expected created item");
        const [row] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [itemId]));
        if (!row) throw new Error("Expected created item row");
        const chokePoint = createChokePoint(pool);
        await chokePoint.softDeleteItem(row.databaseId, itemId);
        const before = await originRows();
        await pool.query(`CREATE FUNCTION reject_origin_cleanup_test() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'injected origin cleanup failure'; END $$`);
        try {
          await pool.query(`CREATE TRIGGER reject_origin_cleanup_test BEFORE DELETE ON item_origins
            FOR EACH ROW EXECUTE FUNCTION reject_origin_cleanup_test()`);
          await expect(chokePoint.purgeExpiredTrashSubtree(itemId, new Date(Date.now() + 1000))).rejects.toThrow(
            "injected origin cleanup failure",
          );
          const remaining = await withTransaction(pool, (client) =>
            itemsStore.getItemsByIdsIncludingDeleted(client, [itemId]),
          );
          expect(remaining).toHaveLength(1);
          expect(remaining[0]?.deletedAt).not.toBeNull();
          expect(await originRows()).toEqual(before);
        } finally {
          await pool.query("DROP TRIGGER IF EXISTS reject_origin_cleanup_test ON item_origins");
          await pool.query("DROP FUNCTION reject_origin_cleanup_test()");
        }
      });
    });
  });

  it("revise transitions a 'needsClarification' proposal (no type at all) to 'proposed' with a valid envelope", async () => {
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text: "no type",
      }),
    );
    await runTick(item.id, async () => {
      return { properties: {}, candidates: [] };
    });
    const needsClarification = (await findProposalForItem(item.id))!;
    expect(needsClarification.properties.status).toBe("needsClarification");

    const revised = await withTransaction(pool, (client) =>
      reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, needsClarification.id, {
        message: "Filed this under Tasks myself",
        entityKind: "database",
        target: tasksId,
        properties: { name: "Buy milk" },
      }),
    );

    expect(revised.properties.status).toBe("proposed");
    expect(revised.properties.proposal).toEqual({
      entityKind: "database",
      target: tasksId,
      properties: { name: "Buy milk" },
    });
    const history = revised.properties.history as Array<Record<string, unknown>>;
    expect(history[history.length - 1]).toMatchObject({ author: "user", message: "Filed this under Tasks myself" });
  });

  it("revise refuses a locked (confirmed) proposal", async () => {
    const proposal = await createDatabaseProposal("Buy milk");
    await withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );

    await expect(
      withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
          message: "too late",
          entityKind: "database",
          target: tasksId,
          properties: { name: "Buy milk again" },
        }),
      ),
    ).rejects.toThrow(/Cannot revise a locked proposal/);
  });

  it("revise validates the replacement envelope against current destination state", async () => {
    const proposal = await createDatabaseProposal("Buy milk");

    await expect(
      withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
          message: "typo fix",
          entityKind: "database",
          target: tasksId,
          properties: { notAKey: "x" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("revise cannot retarget a proposal at Inbox or Inbox item types — the agent's grant excludes them even via a user-supplied envelope (issue #105 review fix)", async () => {
    const proposal = await createDatabaseProposal("Buy milk");

    await expect(
      withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
          message: "retarget to Inbox",
          entityKind: "database",
          target: inboxId,
          properties: {},
        }),
      ),
    ).rejects.toThrow(/not a writable target database/);

    await expect(
      withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
          message: "retarget to Inbox item types",
          entityKind: "database",
          target: typesId,
          properties: {},
        }),
      ),
    ).rejects.toThrow(/not a writable target database/);

    // The proposal must be untouched by the rejected revise attempts — still pointed at Tasks.
    const untouched = await withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, proposal.id));
    expect((untouched!.properties.proposal as { target: string }).target).toBe(tasksId);
  });

  describe("invalidReason on revise (issue #1482)", () => {
    async function readCard(id: string) {
      return withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, id));
    }

    /** Stores `status` `invalid` (with `invalidReason` when given) through the choke point, the state #1916 will write reactively. */
    async function markInvalid(proposalId: string, invalidReason?: Record<string, unknown>) {
      await withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          {
            databaseId: proposalsId,
            itemId: proposalId,
            propertiesPatch: { status: "invalid", ...(invalidReason ? { invalidReason } : {}) },
          },
          { allowedSystemKeys: ["status", "invalidReason"] },
        ),
      );
    }

    /** A card whose source Inbox item was soft-deleted, so the tick makes it `invalid` with `sourceDeleted`. */
    async function createSourceDeletedCard(prior?: "targetArchived" | "targetDeleted" | "legacy") {
      const type = await withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name: "Task",
          emoji: "☑️",
          processingMethod: "database",
          targetDatabase: "tasks",
        }),
      );
      const item = await withTransaction(pool, (client) =>
        createInboxItemWithClient(client, {
          inboxDatabaseId: inboxId,
          date: "2026-08-28",
          time: "09:00",
          text: "Buy milk",
          type: type.id,
        }),
      );
      await runTick(item.id, async () => ({ properties: { name: "Buy milk" } }));
      if (prior) {
        const card = await findProposalForItem(item.id);
        if (!card) throw new Error("expected proposal");
        await markInvalid(
          card.id,
          prior === "legacy"
            ? undefined
            : {
                code: prior,
                field: "project",
                itemId: randomUUID(),
                label: "Project",
              },
        );
      }
      await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, item.id));
      await runTick(item.id, async () => {
        throw new Error("computeProposal must not be called for a deleted source");
      });
      return (await findProposalForItem(item.id))!;
    }

    it.each(["targetArchived", "targetDeleted", "legacy"] as const)(
      "a deleted source supersedes %s and revise is refused without changes",
      async (prior) => {
        const card = await createSourceDeletedCard(prior);
        expect(card.properties.status).toBe("invalid");
        expect(card.properties.invalidReason).toMatchObject({ code: "sourceDeleted" });
        const before = await readCard(card.id);

        const attempt = withTransaction(pool, (client) =>
          reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, card.id, {
            message: "Use Tasks instead",
            entityKind: "database",
            target: tasksId,
            properties: { name: "Buy milk" },
          }),
        );
        const error = await attempt.then(
          () => null,
          (err: unknown) => err,
        );
        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toHaveProperty("details", { field: "status" });

        const after = await readCard(card.id);
        expect(after!.properties).toEqual(before!.properties);
        expect(after!.updatedAt).toEqual(before!.updatedAt);
      },
    );

    it("revising a fixable targetArchived card returns it to proposed and clears its reason in the same write", async () => {
      const card = await createDatabaseProposal("Buy milk");
      await markInvalid(card.id, {
        code: "targetArchived",
        field: "project",
        itemId: randomUUID(),
        label: "Website redesign",
      });
      expect((await readCard(card.id))!.properties.invalidReason).toMatchObject({ code: "targetArchived" });

      const revised = await withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, card.id, {
          message: "Moved it to Tasks",
          entityKind: "database",
          target: tasksId,
          properties: { name: "Buy milk" },
        }),
      );

      expect(revised.properties.status).toBe("proposed");
      expect(revised.properties.invalidReason).toBeNull();
      expect(revised.properties.proposal).toEqual({
        entityKind: "database",
        target: tasksId,
        properties: { name: "Buy milk" },
      });
    });

    it("a legacy invalid card with no invalidReason is treated as fixable and can be revised", async () => {
      const card = await createDatabaseProposal("Buy milk");
      await markInvalid(card.id);
      expect((await readCard(card.id))!.properties.invalidReason).toBeUndefined();

      const revised = await withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, card.id, {
          message: "Renamed the task",
          entityKind: "database",
          target: tasksId,
          properties: { name: "Buy oat milk" },
        }),
      );

      expect(revised.properties.status).toBe("proposed");
      expect(revised.properties.invalidReason).toBeNull();
    });
  });

  describe("aiProposal and aiVersion (issue #1471)", () => {
    async function readProposal(id: string) {
      return withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, id));
    }

    it("a revise through reviseProposalWithClient stores the new envelope in aiProposal and counts a version", async () => {
      const proposal = await createDatabaseProposal("Buy milk");
      expect(proposal.properties.aiVersion).toBe(1);

      const first = await withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
          message: "Renamed the task",
          entityKind: "database",
          target: tasksId,
          properties: { name: "Buy oat milk" },
        }),
      );
      expect(first.properties.aiProposal).toEqual({
        entityKind: "database",
        target: tasksId,
        properties: { name: "Buy oat milk" },
      });
      expect(first.properties.aiProposal).toEqual(first.properties.proposal);
      expect(first.properties.aiVersion).toBe(2);

      const second = await withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
          message: "Renamed it again",
          entityKind: "database",
          target: tasksId,
          properties: { name: "Buy soy milk" },
        }),
      );
      expect(second.properties.aiProposal).toEqual(second.properties.proposal);
      expect(second.properties.aiVersion).toBe(3);
    });

    it("a revise of a legacy card without aiProposal stores aiProposal and sets aiVersion to 1", async () => {
      const proposal = await createDatabaseProposal("Buy milk");
      // A card written before aiProposal and aiVersion existed: no current writer can produce that state.
      await pool.query("UPDATE items SET properties = properties - 'aiProposal' - 'aiVersion' WHERE id = $1", [
        proposal.id,
      ]);

      const revised = await withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
          message: "Renamed the task",
          entityKind: "database",
          target: tasksId,
          properties: { name: "Buy oat milk" },
        }),
      );

      expect(revised.properties.aiProposal).toEqual(revised.properties.proposal);
      expect(revised.properties.aiVersion).toBe(1);
    });

    it("confirming a proposal leaves its aiProposal and aiVersion unchanged", async () => {
      const proposal = await createDatabaseProposal("Buy milk");
      const before = await readProposal(proposal.id);

      await withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
      );

      const after = await readProposal(proposal.id);
      expect(after!.properties.status).toBe("confirmed");
      expect(after!.properties.aiProposal).toEqual(before!.properties.aiProposal);
      expect(after!.properties.aiVersion).toBe(1);
    });

    it("rejecting a proposal leaves its aiProposal and aiVersion unchanged", async () => {
      const proposal = await createDatabaseProposal("Buy milk");
      const before = await readProposal(proposal.id);

      await withTransaction(pool, (client) =>
        rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
      );

      const after = await readProposal(proposal.id);
      expect(after!.properties.status).toBe("rejected");
      expect(after!.properties.aiProposal).toEqual(before!.properties.aiProposal);
      expect(after!.properties.aiVersion).toBe(1);
    });
  });
});

afterAll(async () => {
  await pool?.end();
});
