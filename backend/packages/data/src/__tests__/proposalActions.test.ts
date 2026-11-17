import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser } from "../auth/usersStore.js";
import { insertPageMarkdown, readPageMarkdown } from "../docs/pageMarkdown.js";
import { getDocByItemId } from "../docs/docsStore.js";
import { ensureJournalPeriodDoc } from "../journal/journalStore.js";
import { z } from "zod";
import { readPageBlocks, writeBlock, type BlockInput } from "@semprec/block-model";
import "../domainWriteHooks.js";
import { DateTime } from "luxon";
import type { Pool, PoolClient } from "pg";
import { getSystemSettingsDatabaseId, getSystemSettingsItemId, getSystemTimezone } from "../systemSettings.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { runInTenant } from "@semprec/shared";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { ChokePointError, ConflictError, NotFoundError, ProposalLockedError, ValidationError } from "../errors.js";
import { randomUUID } from "node:crypto";
import { createItemWithClient, prepareUserItemPatch, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { reopenProposalWithClient } from "../inbox/proposalReopen.js";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import {
  setInboxCardsInvalidationHook,
  setInvalidationHook,
  type InboxCardsInvalidationEvent,
  type InvalidationEvent,
} from "../realtimeHook.js";
import { runOnce, type TaskList } from "@semprec/queue";
import { heartbeatFireJobKey } from "../scheduler/schedulerStore.js";
import { COMPUTING_TIMEOUT_MS } from "../inbox/inboxCardsStore.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { prepareComputedUpdates } from "../inbox/proposalComputedUpdates.js";
import { createInboxTypeWithClient } from "../inbox/inboxTypesStore.js";
import { referencedItemIdsOf } from "../inbox/proposalReferences.js";
import { createMarkdownPageContentProposal } from "../testSupport/pageProposalFixtures.js";
import {
  appendHistoryEntry,
  assertValidProposalEnvelope,
  createSemprecTickAction,
  parseStoredProposalEnvelope,
  storedEnvelopeStillValid,
  type ComputeSemprecProposalFn,
  type ProposalEnvelope,
} from "../inbox/inboxTickAction.js";
import {
  confirmProposalWithClient,
  readConfirmationResults,
  recomputeProposalWithClient,
  rejectProposalWithClient,
  resetProposalOverridesWithClient,
  reviseProposalFromThreadWithClient,
  reviseProposalWithClient,
  updateProposalValuesWithClient,
} from "../inbox/proposalActions.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import {
  insertValueLink,
  listValueLinkSourcesByLinkIds,
  listValueLinksByItemIds,
} from "../chokePoint/valueLinksStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { createDocStore, type DocStore } from "../docs/docStore.js";
import { loadDoc, loadDocWithClient, mutateDoc } from "../docs/docPersistence.js";
import { createSubpageWithClient } from "../docs/pageOperations.js";
import { proposalBlockId } from "../inbox/proposalPageContent.js";
import { confirmJournalEntry } from "../inbox/journalEntryConfirm.js";
import { listPageChanges } from "../docs/pageChanges.js";
import { matchTranscriptToEvent } from "../transcription/transcriptEventMatch.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcription/transcriptionJob.js";
import type { ItemRow } from "../types.js";
import { createBlob } from "../blobs/blobsStore.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { createMailThread, reassignThread } from "../mail/mailMessageMetaStore.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { purgeExpiredTrash } from "../trash/purgeExpiredTrash.js";
import { confirmMailThreadCard } from "../inbox/mailThreadCard.js";
import { PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";

let pool: Pool;
let viewTypeRegistry: ViewTypeRegistry;
let docStore: DocStore;

/**
 * Owns the clients of an overlap on `runtime`: every operation started through `run` settles, and `finish` destroys
 * what is still checked out, ends the pool and reports any failure nobody asserted.
 */
function ownOverlap(runtime: Pool, cancel: () => void) {
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
  const onClientError = (error: Error) => errors.push(error);
  const destroy = (client: PoolClient, token: object) => {
    if (active.get(client) !== token) return;
    try {
      destroyed.add(token);
      client.release(true);
    } catch (error) {
      errors.push(error);
    }
  };
  const onAcquire = (client: PoolClient) => {
    const token = {};
    active.set(client, token);
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
  return { run, wait, finish, consume };
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

async function docUpdateAuthors(itemId: string): Promise<string[]> {
  const { rows } = await pool.query<{ created_by: string }>(
    `SELECT u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1 ORDER BY u.id`,
    [itemId],
  );
  return rows.map((row) => row.created_by);
}

function resultBlockIds(confirmed: { properties: Record<string, unknown> }): string[] {
  const results = z
    .array(z.object({ role: z.string(), blockIds: z.array(z.string()) }))
    .parse(confirmed.properties.results);
  return results.find((result) => result.role === "primary")?.blockIds ?? [];
}

/** The Files editor schema requires a `file` value, so a Files card needs one to confirm. */
async function newFileValue(client: PoolClient): Promise<{ blobId: string }> {
  const blob = await createBlob(client, {
    mimeType: "application/pdf",
    byteSize: 12,
    storageKey: `blobs/${randomUUID()}`,
  });
  return { blobId: blob.id };
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

  type Step = NonNullable<ProposalEnvelope["operations"]>[number];
  const config = () => ({ processingProposalsDatabaseId: proposalsId });
  /** The tenant scope of the routes; a relation write queues value-link propagation, which needs it. */
  const scoped = <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> =>
    runInTenant(getTenantZeroId(), () => withTransaction(pool, fn));
  const confirmCard = (cardId: string, actingUserId?: string) =>
    scoped((client) => confirmProposalWithClient(client, config(), cardId, undefined, actingUserId));
  const rejectCard = (cardId: string, reason?: string) =>
    withTransaction(pool, (client) => rejectProposalWithClient(client, config(), cardId, reason));
  const reviseCard = (cardId: string, input: Parameters<typeof reviseProposalWithClient>[3]) =>
    withTransaction(pool, (client) => reviseProposalWithClient(client, config(), cardId, input));
  const editWithWarnings = (cardId: string, set: Record<string, Record<string, unknown>>, ifVersion?: string) =>
    withTransaction(pool, (client) =>
      updateProposalValuesWithClient(client, config(), cardId, {
        set,
        ...(ifVersion === undefined ? {} : { ifVersion }),
      }),
    );
  const edit = async (cardId: string, set: Record<string, Record<string, unknown>>, ifVersion?: string) =>
    (await editWithWarnings(cardId, set, ifVersion)).item;
  async function readCard(id: string): Promise<ItemRow> {
    const card = await withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, id));
    if (!card) throw new Error(`Card ${id} not found`);
    return card;
  }
  const readItem = async (itemId: string) =>
    (await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [itemId])))[0];
  /** Stores system properties of a card that no route writes. */
  const storeProps = (cardId: string, patch: Record<string, unknown>) =>
    withTransaction(pool, (client) =>
      updateItemWithClient(
        client,
        { databaseId: proposalsId, itemId: cardId, propertiesPatch: patch },
        { allowedSystemKeys: Object.keys(patch) },
      ),
    );
  /** A card whose envelope is stored as the assistant's output. */
  async function storeCard(envelope: Record<string, unknown>): Promise<string> {
    const card = await createDatabaseProposal("seed");
    await storeProps(card.id, { proposal: envelope, aiProposal: envelope });
    return card.id;
  }
  const historyOf = (card: { properties: Record<string, unknown> }) =>
    z.array(z.record(z.string(), z.unknown())).parse(card.properties.history);
  const taskEnvelope = (name: string) => ({ entityKind: "database", target: tasksId, properties: { name } });
  /** Expects the refusal and proves nothing was written to the card. */
  async function expectRefusedUnchanged(cardId: string, attempt: () => Promise<unknown>): Promise<unknown> {
    const before = await readCard(cardId);
    const error = await attempt().then(
      () => null,
      (err: unknown) => err,
    );
    expect(await readCard(cardId)).toEqual(before);
    return error;
  }
  const createIn = async (moduleId: string, properties: Record<string, unknown>): Promise<string> => {
    const databaseId = await databaseIdFor(moduleId);
    return withTransaction(pool, async (client) => (await createItemWithClient(client, { databaseId, properties })).id);
  };
  const countIn = async (moduleId: string): Promise<number> =>
    (
      await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
        await databaseIdFor(moduleId),
      ])
    ).rows[0]?.n ?? 0;
  const countEdges = async (): Promise<number> =>
    (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM item_relations")).rows[0]?.n ?? 0;
  const edgeCount = async (a: string, b: string): Promise<number> =>
    (
      await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM item_relations WHERE (item_a = $1 AND item_b = $2) OR (item_a = $2 AND item_b = $1)",
        [a, b],
      )
    ).rows[0]?.n ?? 0;
  const edgeExists = async (a: string, b: string) => (await edgeCount(a, b)) === 1;
  const sourceOf = (cardId: string): Promise<string> =>
    withTransaction(pool, async (client) => {
      const property = await propertiesStore.getPropertyByKey(client, proposalsId, "sourceInbox");
      const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property!.id);
      const edges = await relationsStore.listRelationsForItem(client, definition!.id, cardId);
      expect(edges).toHaveLength(1);
      return relationsStore.otherSide(edges[0]!, cardId);
    });
  const updateStep = (ref: string, itemId: string, rest: Partial<Step>): Step => ({
    ref,
    op: "update",
    itemId,
    role: "primary",
    ...rest,
  });
  const areaProperty = async () => {
    const projectsDb = await databaseIdFor("projects");
    const property = await withTransaction(pool, (client) =>
      propertiesStore.getPropertyByKey(client, projectsDb, "area"),
    );
    if (!property) throw new Error("Missing Projects.area");
    return property;
  };
  const linkArea = async (project: string, area: string) => {
    const relationPropertyId = (await areaProperty()).id;
    await withTransaction(pool, (client) =>
      createRelationWithClient(client, { relationPropertyId, callerItemId: project, targetItemId: area }),
    );
  };
  /** The key of the inverse side of the relation property `key` of `databaseId`. */
  async function inverseKeyOf(databaseId: string, key: string): Promise<string> {
    return withTransaction(pool, async (client) => {
      const property = await propertiesStore.getPropertyByKey(client, databaseId, key);
      if (!property) throw new Error(`Missing relation property ${key}`);
      const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property.id);
      if (!definition?.propertyIdB) throw new Error("Missing inverse relation property");
      const inverseId = definition.propertyIdA === property.id ? definition.propertyIdB : definition.propertyIdA;
      const inverse = await propertiesStore.getProperty(client, inverseId);
      if (!inverse) throw new Error("Missing inverse property");
      return inverse.key;
    });
  }
  const addValueLink = (itemId: string, propertyKey: string) =>
    withTransaction(pool, (client) => insertValueLink(client, { itemId, propertyKey, ruleKey: "test", sources: [] }));
  const valueLinkOf = async (itemId: string) =>
    (await withTransaction(pool, (client) => listValueLinksByItemIds(client, [itemId])))[0];
  /** Runs `fn` with the realtime invalidations of the item writes collected. */
  async function captureInvalidations<T>(fn: (events: InvalidationEvent[]) => Promise<T>): Promise<T> {
    const events: InvalidationEvent[] = [];
    setInvalidationHook((event) => events.push(event));
    try {
      return await fn(events);
    } finally {
      setInvalidationHook(() => {});
    }
  }
  const itemEventsOf = (events: InvalidationEvent[], itemId: string) =>
    events.filter((event) => event.scope === "item" && event.itemId === itemId);
  /** A confirm whose transaction fails afterwards announces nothing, before or after the rollback. */
  async function expectConfirmRolledBack(cardId: string, actorId: string, events: InvalidationEvent[]) {
    const failure = new Error("rollback after the confirm");
    await expect(
      scoped(async (client) => {
        await confirmProposalWithClient(client, config(), cardId, undefined, actorId);
        expect(events).toEqual([]);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(events).toEqual([]);
  }
  const errorShape = (error: unknown) => {
    if (!(error instanceof ChokePointError)) throw new Error("Expected a ChokePointError", { cause: error });
    return {
      status: error.status,
      code: error.code,
      field: z.object({ field: z.string() }).parse(error.details).field,
    };
  };
  /** Raises 'test trigger failure' on the `event` writes of `table` that `condition` selects, while `run` runs. */
  async function withFailingTrigger(
    table: "items" | "item_relations" | "item_origins" | "doc_updates",
    event: "INSERT" | "UPDATE" | "DELETE",
    condition: string,
    run: () => Promise<void>,
  ): Promise<void> {
    // Table, event and condition are test constants.
    await pool.query(`CREATE FUNCTION zz_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF ${condition} THEN RAISE EXCEPTION 'test trigger failure'; END IF;
        RETURN COALESCE(NEW, OLD);
      END $$`);
    try {
      await pool.query(
        `CREATE TRIGGER zz_test_fail BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION zz_test_fail()`,
      );
      await run();
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS zz_test_fail ON ${table}`);
      await pool.query("DROP FUNCTION zz_test_fail()");
    }
  }
  /** Runs `fn` on a pool of the runtime role, which row-level security applies to, and closes it. */
  async function withRuntimePool(fn: (runtime: Pool) => Promise<void>): Promise<void> {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    let failure: { error: unknown } | undefined;
    try {
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      await fn(runtime);
    } catch (error) {
      failure = { error };
    }
    try {
      await runtime.end();
    } catch (cleanupError) {
      if (failure)
        throw new AggregateError([failure.error, cleanupError], "Runtime pool test and cleanup failed", {
          // The test failure is primary; the cleanup failure is kept in the aggregate.
          // eslint-disable-next-line preserve-caught-error
          cause: failure.error,
        });
      throw cleanupError;
    }
    if (failure) throw failure.error;
  }

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

  const taskType = async (targetDatabase: "tasks" | "files" = "tasks") =>
    (
      await withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name: "Task",
          emoji: "☑️",
          processingMethod: "database",
          targetDatabase,
        }),
      )
    ).id;
  const inboxItem = (text: string, type?: string) =>
    withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text,
        ...(type === undefined ? {} : { type }),
      }),
    );

  async function createDatabaseProposal(text = "Buy milk", targetDatabase: "tasks" | "files" = "tasks") {
    const item = await inboxItem(text, await taskType(targetDatabase));
    await runTick(item.id, async () => ({ properties: { name: text } }));
    return (await findProposalForItem(item.id))!;
  }

  /** A card of an Inbox item without a type, which the tick leaves needing clarification and without an envelope. */
  async function untypedCard(text = "no type") {
    const item = await inboxItem(text);
    await runTick(item.id, async () => ({ properties: {}, candidates: [] }));
    const card = (await findProposalForItem(item.id))!;
    expect(card.properties.status).toBe("needsClarification");
    return { card, sourceId: item.id };
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
    const item = await inboxItem(text, type.id);
    // The Inbox item type itself stands in for a "page" target here — confirm only needs an existing item id.
    await runTick(item.id, async () => ({
      target: type.id,
      properties: { flavour: "paragraph", fields: { content: text } },
    }));
    return { proposal: (await findProposalForItem(item.id))!, targetPageId: type.id };
  }

  /** A `kind = 'transcript'` card as the match step emits it: no Event in the window, so a create-Event proposal. */
  async function createTranscript(durationSeconds = 3600): Promise<{ cardId: string; transcriptId: string }> {
    const transcriptsId = await databaseIdFor("transcripts");
    const transcript = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: transcriptsId, properties: { name: "Meeting", date: "2024-03-01T12:00:00.000Z" } },
        { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
      ),
    );
    expect(
      await withTransaction(pool, (client) =>
        matchTranscriptToEvent(client, { transcriptId: transcript.id, durationSeconds }),
      ),
    ).toBe("suggested");
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM items WHERE database_id = $1 AND properties->>'kind' = 'transcript'",
      [proposalsId],
    );
    if (rows.length !== 1 || !rows[0]) throw new Error(`Expected one transcript card, found ${rows.length}`);
    return { cardId: rows[0].id, transcriptId: transcript.id };
  }
  const createTranscriptCard = async (durationSeconds?: number) => (await createTranscript(durationSeconds)).cardId;

  async function setStoredProperty(proposalId: string, key: string, value: unknown): Promise<void> {
    await pool.query(`UPDATE items SET properties = jsonb_set(properties, $2::text[], $3::jsonb) WHERE id = $1`, [
      proposalId,
      `{${key}}`,
      JSON.stringify(value),
    ]);
  }

  // The overlap harness destroys a participant's connection inside its transaction; the body's failure must survive.
  it("rethrows the body's failure of a transaction whose connection was destroyed, though ROLLBACK and release fail", async () => {
    const runtime = getTestPool({ max: 1 });
    const body = new Error("body failure");
    try {
      await expect(
        withTransaction(runtime, async (client) => {
          client.release(true);
          throw body;
        }),
      ).rejects.toBe(body);
    } finally {
      await runtime.end();
    }
  });

  it("confirm on a 'database' proposal creates the target item, locks confirmed, records resultItemId/resultLabel, and is idempotent under retry", async () => {
    const proposal = await createDatabaseProposal("Buy milk");

    const confirmed = await confirmCard(proposal.id);

    expect(confirmed.properties.status).toBe("confirmed");
    expect(typeof confirmed.properties.resultItemId).toBe("string");
    expect(confirmed.properties.resultLabel).toBe("Buy milk");
    const history = historyOf(confirmed);
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({ author: "user" });
    const createdTask = await withTransaction(pool, (client) =>
      itemsStore.getItemById(client, tasksId, confirmed.properties.resultItemId as string),
    );
    expect(createdTask?.properties.name).toBe("Buy milk");

    const second = await confirmCard(proposal.id);
    expect(second.properties.resultItemId).toBe(confirmed.properties.resultItemId);
    expect(second.updatedAt).toBe(confirmed.updatedAt);
    expect(await countIn("tasks")).toBe(1);
  });

  it("writes one editable Inbox origin paragraph on a created item", async () => {
    const proposal = await createDatabaseProposal("Buy milk");
    const confirmed = await confirmCard(proposal.id);
    const itemId = z.string().parse(confirmed.properties.resultItemId);
    const first = await docStore.readPageMarkdown(itemId);
    expect(first.markdown).toBe("Vytvořeno ze schránky: Buy milk");
    const confirmAgainKeeps = async (markdown: string) => {
      await confirmCard(proposal.id);
      expect((await docStore.readPageMarkdown(itemId)).markdown).toBe(markdown);
    };
    await confirmAgainKeeps(first.markdown);
    const blocks = await docStore.listBlocks(itemId);
    expect(blocks).toHaveLength(1);
    const blockId = z.string().parse(blocks[0]?.["sys:id"]);
    if (!first.docId) throw new Error("Missing origin document");
    await mutateDoc(pool, first.docId, "user", (doc) =>
      writeBlock(doc, { id: blockId, type: "text", text: "Edited by user" }),
    );
    await confirmAgainKeeps("Edited by user");
    await docStore.deleteBlock(itemId, blockId, "user");
    await confirmAgainKeeps("");
  });

  it("uses the confirming user's English locale and user author for the created page", async () => {
    const actor = await createUser(pool, {
      email: "english-origin@example.test",
      passwordHash: "hash",
      tenantId: getTenantZeroId(),
      locale: "en",
    });
    const proposal = await createDatabaseProposal("English capture\nSecond line", "files");
    const file = await withTransaction(pool, (client) => newFileValue(client));
    await storeProps(proposal.id, {
      proposal: {
        ...z.record(z.string(), z.unknown()).parse(proposal.properties.proposal),
        properties: { name: "English capture\nSecond line", file },
      },
    });
    await withRuntimePool((runtime) =>
      runInTenant(getTenantZeroId(), async () => {
        const confirmed = await withTransaction(runtime, (client) =>
          confirmProposalWithClient(client, config(), proposal.id, undefined, actor.id),
        );
        const itemId = z.string().parse(confirmed.properties.resultItemId);
        const page = await withTransaction(runtime, (client) => readPageMarkdown(client, itemId));
        expect(page.markdown).toBe("Created from Inbox: English capture<br>Second line");
        const docId = page.docId;
        if (!docId) throw new Error("Missing origin page");
        const blocks = await withTransaction(runtime, async (client) => {
          const doc = await loadDocWithClient(client, docId);
          try {
            return readPageBlocks(doc);
          } finally {
            doc.destroy();
          }
        });
        expect(blocks.map((block) => block.text.map((run) => run.insert).join(""))).toEqual([
          "Created from Inbox: English capture\nSecond line",
        ]);
        const updates = await runtime.query<{ created_by: string }>(
          "SELECT created_by FROM doc_updates WHERE doc_id = $1 ORDER BY id",
          [docId],
        );
        expect(updates.rows).toEqual([{ created_by: "user" }]);
      }),
    );
  });

  it("rolls back confirmation when the origin page write fails", async () => {
    const proposal = await createDatabaseProposal("Rollback origin");
    const snapshot = async () => ({
      card: await readCard(proposal.id),
      tasks: (await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1 ORDER BY id", [tasksId]))
        .rows,
      jobs: (
        await pool.query<{ id: string; key: string | null }>("SELECT id, key FROM graphile_worker.jobs ORDER BY id")
      ).rows,
      origins: (
        await pool.query<{ item_id: string }>("SELECT item_id FROM item_origins WHERE proposal_id = $1", [proposal.id])
      ).rows,
      docs: (await pool.query<{ id: string; item_id: string }>("SELECT id, item_id FROM docs ORDER BY id")).rows,
      snapshots: (
        await pool.query<{ doc_id: string; state: Buffer; state_vector: Buffer }>(
          "SELECT doc_id, state, state_vector FROM doc_snapshots ORDER BY doc_id",
        )
      ).rows,
    });
    const before = await snapshot();
    expect(before.origins).toEqual([]);
    await withRuntimePool(async (runtime) => {
      await captureInvalidations(async (invalidations) => {
        await withFailingTrigger("doc_updates", "INSERT", "TRUE", async () => {
          await expect(
            runInTenant(getTenantZeroId(), () =>
              withTransaction(runtime, (client) => confirmProposalWithClient(client, config(), proposal.id)),
            ),
          ).rejects.toThrow("test trigger failure");
        });
        expect(invalidations).toEqual([]);
      });
    });
    expect(await snapshot()).toEqual(before);
  });

  it("revises a Markdown proposal and then confirms it into the page as the user, through the runtime role", async () => {
    const proposal = await createDatabaseProposal("Page proposal");
    await withRuntimePool(async (runtime) => {
      const tenant = getTenantZeroId();
      const projectsId = await databaseIdFor("projects");
      const inScope = <T>(fn: (client: PoolClient) => Promise<T>) =>
        runInTenant(tenant, () => withTransaction(runtime, fn));
      const project = await inScope((client) =>
        createItemWithClient(client, { databaseId: projectsId, properties: { name: "Project" } }),
      );
      const revise = (properties: Record<string, unknown>) =>
        inScope((client) =>
          reviseProposalWithClient(client, config(), proposal.id, {
            message: "Revise",
            entityKind: "pageContent",
            target: project.id,
            properties,
          }),
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
      // The revised card confirms and writes its content.
      const confirmed = await inScope((client) => confirmProposalWithClient(client, config(), proposal.id));
      expect(confirmed.properties).toMatchObject({ status: "confirmed", resultItemId: project.id });
      const written = await runInTenant(tenant, () =>
        runtime.query<{ created_by: string }>(
          `SELECT u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1`,
          [project.id],
        ),
      );
      expect(written.rows).toEqual([{ created_by: "user" }]);
    });
  });

  it("refuses a Markdown page revision on a real transcript proposal without effects", async () => {
    const cardId = await createTranscriptCard(60);
    const project = await createIn("projects", { name: "Project" });
    await withRuntimePool((runtime) =>
      runInTenant(getTenantZeroId(), async () => {
        const snapshot = () =>
          runtime.query<{ card: unknown; docs: number; edges: number }>(
            "SELECT (SELECT row_to_json(card) FROM (SELECT properties, updated_at FROM items WHERE id = $1) card) AS card, (SELECT count(*)::int FROM docs WHERE item_id = $2) AS docs, (SELECT count(*)::int FROM item_relations) AS edges",
            [cardId, project],
          );
        const before = await snapshot();
        await expect(
          withTransaction(runtime, (client) =>
            reviseProposalWithClient(client, config(), cardId, {
              message: "Revise",
              entityKind: "pageContent",
              target: project,
              properties: { markdown: "A paragraph", placement: "end" },
            }),
          ),
        ).rejects.toMatchObject({ status: 400, details: { field: "entityKind" } });
        expect((await snapshot()).rows).toEqual(before.rows);
      }),
    );
  });

  it("confirm on an old-shape 'pageContent' proposal appends the block authored by the user, locks confirmed and lists its block id", async () => {
    const { proposal, targetPageId } = await createPageContentProposal("A thought");

    const confirmed = await confirmCard(proposal.id);

    expect(confirmed.properties.status).toBe("confirmed");
    expect(confirmed.properties.resultItemId).toBe(targetPageId);
    expect(await docStore.getBlock(targetPageId, proposal.id)).toMatchObject({
      "sys:flavour": "paragraph",
      content: "A thought",
    });
    expect(await docUpdateAuthors(targetPageId)).toEqual(["user"]);
    expect(resultBlockIds(confirmed)).toEqual([proposal.id]);
  });

  describe("v2 page content (issue #1681)", () => {
    const HEADING_ID = "h-tiles";

    async function projectWithPage(blocks: BlockInput[]): Promise<string> {
      const project = await createIn("projects", { name: "Host project" });
      if (blocks.length > 0) {
        const doc = await docStore.getOrCreateDoc(project, "page");
        await mutateDoc(pool, doc.id, "user", (ydoc) => blocks.forEach((block) => writeBlock(ydoc, block)));
      }
      return project;
    }

    async function pageBlocks(itemId: string): Promise<Array<[string, string, string]>> {
      const doc = await docStore.getDoc(itemId);
      if (!doc) return [];
      const ydoc = await loadDoc(pool, doc.id);
      return readPageBlocks(ydoc)
        .filter((block) => !block.synthetic)
        .map((block) => [block.id ?? "", block.type, block.text.map((run) => run.insert).join("")]);
    }
    const typesAndTexts = async (itemId: string) => (await pageBlocks(itemId)).map(([, type, text]) => [type, text]);
    const texts = async (itemId: string) => (await pageBlocks(itemId)).map(([, , text]) => text);
    const pageState = async (itemId: string) => ({
      blocks: await pageBlocks(itemId),
      authors: await docUpdateAuthors(itemId),
    });

    const createV2Proposal = (target: string, properties: Record<string, unknown>) =>
      createMarkdownPageContentProposal(pool, { inboxId, typesId, proposalsId }, target, properties);
    const confirm = confirmCard;
    const statusOf = async (proposalId: string) => (await readCard(proposalId)).properties.status;

    const sectioned: BlockInput[] = [
      { id: "h-intro", type: "h1", text: "Intro" },
      { id: "i1", type: "text", text: "Intro text" },
      { id: HEADING_ID, type: "h2", text: "Tiles" },
      { id: "t1", type: "text", text: "Tile one" },
      { id: "t2", type: "text", text: "Tile two" },
      { id: "h-other", type: "h2", text: "Other" },
      { id: "o1", type: "text", text: "Other text" },
    ];
    const newTiles = { markdown: "- first\n- second", placement: { afterHeading: HEADING_ID }, heading: "New tiles" };

    it("inserts the optional heading and the bullets at the end of the chosen section as the user's changes, leaving other blocks in order", async () => {
      const target = await projectWithPage(sectioned);
      // Taken after the page and its blocks exist, so only the confirm below is stored after it.
      const since = new Date();
      const proposal = await createV2Proposal(target, newTiles);

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
      const doc = await docStore.getDoc(target);
      if (!doc) throw new Error("Missing page document");
      expect(await listPageChanges(pool, doc.id, { since, by: "user", limit: 100 })).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "insert", blockIds: ids })]),
      );
      expect(await listPageChanges(pool, doc.id, { since, by: "ai_agent", limit: 100 })).toEqual([]);
    });

    it("adds no block when the same proposal is confirmed again, and returns the stored result", async () => {
      const target = await projectWithPage(sectioned);
      const proposal = await createV2Proposal(target, { markdown: "Once", placement: "end" });
      const first = await confirm(proposal.id);
      const afterFirst = await pageState(target);

      const second = await confirm(proposal.id);

      expect(second.properties.results).toEqual(first.properties.results);
      expect(await pageState(target)).toEqual(afterFirst);
    });

    it.each([
      [
        "was removed",
        (ydoc: import("yjs").Doc) => {
          ydoc.getMap("blocks").delete(HEADING_ID);
          const order = ydoc.getArray<string>("order");
          order.delete(order.toArray().indexOf(HEADING_ID), 1);
        },
      ],
      [
        "is still there but no longer a heading",
        (ydoc: import("yjs").Doc) => {
          ydoc.getMap<import("yjs").Map<unknown>>("blocks").get(HEADING_ID)?.set("sys:flavour", "text");
        },
      ],
    ])("answers 409 when the chosen heading %s, keeps the card proposed and writes nothing", async (_label, change) => {
      const target = await projectWithPage(sectioned);
      const proposal = await createV2Proposal(target, { markdown: "Late", placement: { afterHeading: HEADING_ID } });
      const doc = await docStore.getDoc(target);
      await mutateDoc(pool, doc!.id, "user", change);
      const before = await pageState(target);

      await expect(confirm(proposal.id)).rejects.toBeInstanceOf(ConflictError);

      expect(await statusOf(proposal.id)).toBe("proposed");
      expect(await pageState(target)).toEqual(before);
    });

    it("creates the page document of a target that has none and the content is its only content", async () => {
      const target = await projectWithPage([]);
      expect(await docStore.getDoc(target)).toBeNull();
      const proposal = await createV2Proposal(target, { markdown: "Fresh\n\nPage", placement: "end" });

      await confirm(proposal.id);

      expect(await typesAndTexts(target)).toEqual([
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
      expect(await texts(target)).toEqual(["Start", "Existing", "End"]);
    });

    it.each([
      ["h1", "h2"],
      ["h2", "h3"],
      ["h3", "h3"],
    ] as const)(
      "writes the heading of a card under an %s section as %s, one level below and never below h3",
      async (section, heading) => {
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
        expect(await typesAndTexts(target)).toEqual([
          [section, "Section"],
          ["text", "Inside"],
          [heading, "Added"],
          ["text", "Body"],
        ]);
      },
    );

    it("writes the heading as h2 when the placement is not under a heading", async () => {
      const target = await projectWithPage([{ id: "x", type: "text", text: "Existing" }]);
      const proposal = await createV2Proposal(target, { markdown: "Body", placement: "end", heading: "Added" });
      await confirm(proposal.id);
      expect(await typesAndTexts(target)).toEqual([
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
      expect(await texts(target)).toEqual(["Section", "Deeper", "Deeper text", "Appended", "Higher"]);
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
      expect(await texts(subpage)).toEqual(["Into the subpage"]);
    });

    it("leaves no partial block and the card proposed when a later step of the confirm fails", async () => {
      const target = await projectWithPage([{ id: "x", type: "text", text: "Existing" }]);
      const proposal = await createV2Proposal(target, { markdown: "Never kept", placement: "end", heading: "Gone" });
      const before = await pageState(target);
      // A trigger refuses the status write that locks the card `confirmed`, after the blocks were inserted.
      await withFailingTrigger("items", "UPDATE", "NEW.properties->>'status' = 'confirmed'", async () => {
        await expect(confirm(proposal.id)).rejects.toThrow(/test trigger failure/);
      });
      expect(await statusOf(proposal.id)).toBe("proposed");
      expect(await pageState(target)).toEqual(before);
    });

    it("refuses a link to an item that was deleted after the card was computed, keeping the card proposed", async () => {
      const target = await projectWithPage([]);
      const linked = await createIn("projects", { name: "Linked" });
      const proposal = await createV2Proposal(target, {
        markdown: `See [it](semprec://items/${linked})`,
        placement: "end",
      });
      await pool.query(`UPDATE items SET deleted_at = now() WHERE id = $1`, [linked]);

      await expect(confirm(proposal.id)).rejects.toBeInstanceOf(ValidationError);

      expect(await statusOf(proposal.id)).toBe("proposed");
      expect(await docStore.getDoc(target)).toBeNull();
    });
  });

  it.each([
    ["a needsClarification proposal (no computed envelope)", "needsClarification"],
    ["an already-rejected proposal", "rejected"],
  ])("confirm refuses %s", async (_label, status) => {
    const card = status === "rejected" ? await createDatabaseProposal("Buy milk") : (await untypedCard()).card;
    if (status === "rejected") await rejectCard(card.id);

    await expect(confirmCard(card.id)).rejects.toThrow(`Cannot confirm a proposal in status '${status}'`);
  });

  it("confirm rejects a stored envelope that is not { entityKind, target, properties }, and a null one as having no computed envelope", async () => {
    const malformed = await createDatabaseProposal("Buy milk");
    const missing = await createDatabaseProposal("Buy milk");
    await setStoredProperty(malformed.id, "proposal", { entityKind: "database" });
    await setStoredProperty(missing.id, "proposal", null);

    await expect(confirmCard(malformed.id)).rejects.toThrow(`Malformed proposal envelope on proposal ${malformed.id}`);
    await expect(confirmCard(missing.id)).rejects.toThrow("Proposal has no computed envelope to confirm");
    expect(await countIn("tasks")).toBe(0);
  });

  describe("unknown stored entityKind", () => {
    const futureEnvelope = { entityKind: "someFutureKind", target: "future-target", properties: { a: 1 } };

    async function createFutureKindProposal() {
      const proposal = await createDatabaseProposal("Buy milk");
      await setStoredProperty(proposal.id, "proposal", futureEnvelope);
      return proposal;
    }

    it("lists and reads the card with the stored envelope untouched", async () => {
      const proposal = await createFutureKindProposal();

      const card = await readCard(proposal.id);
      expect(card.properties.proposal).toEqual(futureEnvelope);
      expect(card.properties.status).toBe("proposed");
      const page = await createChokePoint(pool).listItems(proposalsId);
      expect(page.items.find((item) => item.id === proposal.id)?.properties.proposal).toEqual(futureEnvelope);
      expect(parseStoredProposalEnvelope(card.properties.proposal, proposal.id)).toEqual({
        unknownKind: true,
        ...futureEnvelope,
      });
    });

    it.each([
      ["confirm", (cardId: string) => confirmCard(cardId)],
      [
        "revise",
        (cardId: string) =>
          reviseCard(cardId, {
            message: "fix it",
            entityKind: "database",
            target: tasksId,
            properties: { name: "Buy bread" },
          }),
      ],
    ])("%s answers 409 naming the kind, leaves the card as it was and writes nothing", async (action, attempt) => {
      const proposal = await createFutureKindProposal();

      const error = await expectRefusedUnchanged(proposal.id, () => attempt(proposal.id));

      expect(error).toBeInstanceOf(ConflictError);
      if (action === "confirm") {
        expect(error).toMatchObject({ details: { field: "entityKind", entityKind: "someFutureKind" } });
      }
      expect((error as ConflictError).status).toBe(409);
      expect((error as ConflictError).message).toContain("someFutureKind");
      expect(await countIn("tasks")).toBe(0);
    });

    it("revise still rejects writing an unknown entityKind as before", async () => {
      const proposal = await createDatabaseProposal("Buy milk");

      await expect(
        reviseCard(proposal.id, {
          message: "x",
          entityKind: "someFutureKind" as never,
          target: tasksId,
          properties: {},
        }),
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

  describe("appendHistoryEntry", () => {
    it("treats a history holding a malformed entry as empty", async () => {
      const proposal = await createDatabaseProposal("Buy milk");
      await setStoredProperty(proposal.id, "history", [
        { author: "ai", message: "Created a proposal for the source item.", at: "2026-08-28T09:00:00.000Z" },
        { author: "robot", message: 42 },
      ]);

      const history = appendHistoryEntry((await readCard(proposal.id)).properties.history, "Not needed", "user");

      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ author: "user", message: "Not needed" });
    });

    it("keeps legacy entries byte-identical and adds no kind without extra", () => {
      const legacy = { author: "user", message: "Old", at: "2026-08-28T09:00:00.000Z" };

      const history = appendHistoryEntry([legacy], "New");

      expect(JSON.stringify(history[0])).toBe(JSON.stringify(legacy));
      expect(Object.keys(history[1]!).sort()).toEqual(["at", "author", "message"]);
    });

    it.each([
      ["a userEdit entry with keys", "user" as const, { kind: "userEdit" as const, keys: ["primary.title"] }],
      [
        "threadRevision thread and message ids",
        "ai" as const,
        { kind: "threadRevision" as const, threadId: "t1", messageId: "m1" },
      ],
    ])("keeps %s across further appends", (_label, author, extra) => {
      let history = appendHistoryEntry([], "Edited", author, extra);
      const first = JSON.stringify(history[0]);
      history = appendHistoryEntry(history, "Second");
      history = appendHistoryEntry(history, "Third", "user");

      expect(history).toHaveLength(3);
      expect(JSON.stringify(history[0])).toBe(first);
      expect(history[0]).toMatchObject({ ...extra, author });
    });
  });

  it("reject locks rejected, writes no target and is idempotent under retry", async () => {
    const proposal = await createDatabaseProposal("Buy milk");

    const rejected = await rejectCard(proposal.id, "Not needed");
    const again = await rejectCard(proposal.id);

    expect(rejected.properties.status).toBe("rejected");
    expect(rejected.properties.resultItemId).toBeUndefined();
    expect(historyOf(rejected)[1]).toMatchObject({ author: "user", message: "Not needed", kind: "rejected" });
    expect(again.updatedAt).toBe(rejected.updatedAt);
    expect(await countIn("tasks")).toBe(0);
  });

  it("reject refuses an already-confirmed proposal", async () => {
    const proposal = await createDatabaseProposal("Buy milk");
    await confirmCard(proposal.id);

    await expect(rejectCard(proposal.id)).rejects.toThrow(/already been confirmed/);
  });

  it("revise can switch a proposal from 'database' to 'pageContent' atomically and records the message", async () => {
    const proposal = await createDatabaseProposal("Buy milk");
    const { targetPageId } = await createPageContentProposal("Unused");
    const pageEnvelope = {
      entityKind: "pageContent",
      target: targetPageId,
      properties: { flavour: "paragraph", fields: { content: "Buy milk" } },
    } as const;

    const revised = await reviseCard(proposal.id, { message: "Actually this is a note", ...pageEnvelope });

    expect(revised.properties.status).toBe("proposed");
    expect(revised.properties.proposal).toEqual(pageEnvelope);
    expect(historyOf(revised).at(-1)).toMatchObject({ author: "user", message: "Actually this is a note" });
  });

  it("revise stores a valid relations map and refuses a malformed or deleted target without touching the card (issue #1426)", async () => {
    const proposal = await createDatabaseProposal("Buy milk");
    const project = await createIn("projects", { name: "Home" });
    const revise = (relations: Record<string, string[]>) =>
      reviseCard(proposal.id, {
        message: "link it",
        entityKind: "database",
        target: tasksId,
        properties: { name: "Buy milk" },
        relations,
      });

    const revised = await revise({ project: [project] });
    expect(revised.properties.proposal).toEqual({ ...taskEnvelope("Buy milk"), relations: { project: [project] } });

    const malformed = await expectRefusedUnchanged(proposal.id, () => revise({ project: ["not-a-uuid"] }));
    expect(malformed).toBeInstanceOf(ValidationError);
    expect(malformed).toMatchObject({ status: 400, details: { field: "project" } });
    expect((malformed as ValidationError).details).toEqual({ field: "project" });

    const projectsId = await databaseIdFor("projects");
    await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, projectsId, project));
    const deleted = await expectRefusedUnchanged(proposal.id, () => revise({ project: [project] }));
    expect(deleted).toBeInstanceOf(ValidationError);
    expect((deleted as ValidationError).details).toEqual({ field: "project", code: "targetDeleted" });
    expect((await readCard(proposal.id)).properties.proposal).toEqual(revised.properties.proposal);
  });

  it("revise refuses a relation the project derives and leaves the card as it was, and accepts it without a project (issue gh-1991)", async () => {
    const proposal = await createDatabaseProposal("Buy milk");
    const eventsId = await databaseIdFor("events");
    const project = await createIn("projects", { name: "Home" });
    const company = await createIn("companies", { name: "Acme" });
    const revise = (relations: Record<string, string[]>) =>
      reviseCard(proposal.id, {
        message: "make it an event",
        entityKind: "database",
        target: eventsId,
        properties: { name: "Meeting" },
        relations,
      });

    const accepted = await revise({ company: [company] });
    const error = await expectRefusedUnchanged(proposal.id, () => revise({ project: [project], company: [company] }));

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ status: 400, details: { field: "company", code: "derivedRelation" } });
    expect((await readCard(proposal.id)).properties.proposal).toMatchObject({ relations: { company: [company] } });
    expect(accepted.properties.proposal).toMatchObject({ relations: { company: [company] } });
  });

  describe("relations on confirm (issue #1476)", () => {
    async function proposalWithRelations(relations: Record<string, string[]>) {
      const proposal = await createDatabaseProposal("Buy milk");
      await reviseCard(proposal.id, {
        message: "link it",
        entityKind: "database",
        target: tasksId,
        properties: { name: "Buy milk" },
        relations,
      });
      return proposal;
    }
    const createProject = (name: string) => createIn("projects", { name });

    it("writes the task and its project edge in one transaction, once even when confirmed again", async () => {
      const project = await createProject("Home");
      const proposal = await proposalWithRelations({ project: [project] });
      const before = await countEdges();
      await addValueLink(project, await inverseKeyOf(tasksId, "project"));
      const actorId = randomUUID();
      const confirmed = await captureInvalidations(async (events) => {
        await expectConfirmRolledBack(proposal.id, actorId, events);
        expect((await valueLinkOf(project))?.state).toBe("on");
        const result = await confirmCard(proposal.id, actorId);
        expect(itemEventsOf(events, project)).toEqual([expect.objectContaining({ userId: actorId })]);
        events.length = 0;
        await confirmCard(proposal.id);
        expect(events).toEqual([]);
        return result;
      });
      expect(await countIn("tasks")).toBe(1);
      expect(await countEdges()).toBe(before + 1);
      expect(await edgeExists(z.string().parse(confirmed.properties.resultItemId), project)).toBe(true);
    });

    it("rolls back item and edge with field 'project' when a target disappears before confirm", async () => {
      const project = await createProject("Home");
      const proposal = await proposalWithRelations({ project: [project] });
      const projectsId = await databaseIdFor("projects");
      await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, projectsId, project));
      const before = await countEdges();

      const error = await confirmCard(proposal.id).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toMatchObject({ field: "project" });
      expect(await countIn("tasks")).toBe(0);
      expect(await countEdges()).toBe(before);
      expect((await readCard(proposal.id)).properties.status).toBe("proposed");
    });

    it("rolls back the item and the first edge when the second edge violates cardinality", async () => {
      const proposal = await proposalWithRelations({
        project: [await createProject("Home"), await createProject("Work")],
      });
      const before = await countEdges();

      const error = await confirmCard(proposal.id).catch((e: unknown) => e);
      expect(error).toMatchObject({ status: 409, details: { field: "project" } });
      expect(await countIn("tasks")).toBe(0);
      expect(await countEdges()).toBe(before);
      expect((await readCard(proposal.id)).properties.status).toBe("proposed");
    });
  });

  describe("multi-step proposals on confirm (issue #1486)", () => {
    const confirm = confirmCard;
    const cardStatus = async (cardId: string) => (await readCard(cardId)).properties.status;
    const updateIn = async (moduleId: string, itemId: string, propertiesPatch: Record<string, unknown>) => {
      const databaseId = await databaseIdFor(moduleId);
      return withTransaction(pool, (client) => updateItemWithClient(client, { databaseId, itemId, propertiesPatch }));
    };
    /** A pinned project without a pin order, as rows from before automatic pin-order allocation are. */
    const legacyPin = async (project: string) => {
      const databaseId = await databaseIdFor("projects");
      await withTransaction(pool, (client) =>
        itemsStore.updateItemProperties(client, {
          databaseId,
          itemId: project,
          propertiesPatch: { pinned: true, pinnedOrder: null },
        }),
      );
    };

    async function cardWithSteps(primaryDatabase: string, steps: Step[]): Promise<string> {
      const card = await createDatabaseProposal("seed");
      const primary = steps.find((step) => step.role === "primary")!;
      await storeProps(card.id, {
        proposal: {
          entityKind: "database",
          target: await databaseIdFor(primaryDatabase),
          properties: primary.properties ?? {},
          operations: steps,
        },
      });
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

    it("creates company, person and the People.companies edge in one transaction; the result is the primary's", async () => {
      // The person is listed before the company it refers to, so execution order must come from the refs.
      const card = await cardWithSteps("companies", companyAndPerson().reverse());
      const confirmed = await confirm(card);

      expect(await countIn("companies")).toBe(1);
      expect(await countIn("people")).toBe(1);
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
      await addValueLink(project, await inverseKeyOf(tasksId, "project"));
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
      await captureInvalidations(async (events) => {
        await expectConfirmRolledBack(card, actorId, events);
        expect(await countIn("tasks")).toBe(0);
        expect(await cardStatus(card)).toBe("proposed");
        expect((await valueLinkOf(project))?.state).toBe("on");
        const result = await confirm(card, actorId);
        const taskId = result.properties.resultItemId;
        if (typeof taskId !== "string") throw new Error("Missing task result");
        expect(await edgeExists(taskId, project)).toBe(true);
        expect(await valueLinkOf(project)).toMatchObject({ state: "broken", brokenBy: "user" });
        expect(itemEventsOf(events, project)).toEqual([expect.objectContaining({ userId: actorId })]);
        events.length = 0;
        await confirm(card, actorId);
        expect(events).toEqual([]);
      });
    });

    it("rolls back company and edge when the person fails, and the 400 names the person step", async () => {
      // A wrong value type passes envelope validation and fails only in the choke point's write.
      const failing = companyAndPerson();
      failing[1] = { ...failing[1]!, properties: { name: 42 } };
      const failingCard = await cardWithSteps("companies", failing);
      const edgesBefore = await countEdges();

      const error = await confirm(failingCard).catch((e: unknown) => e);
      expect(error).toMatchObject({ status: 400, details: { ref: "person", field: "name" } });
      expect(await countIn("companies")).toBe(0);
      expect(await countIn("people")).toBe(0);
      expect(await countEdges()).toBe(edgesBefore);
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
      expect(await countIn("healthRecords")).toBe(1);
      expect(await countIn("tasks")).toBe(0);
    });

    it("creates no person when the optional new person is not referenced", async () => {
      const steps = companyAndPerson();
      steps[1] = { ...steps[1]!, optional: true, relations: {} };
      await confirm(await cardWithSteps("companies", steps));
      expect(await countIn("companies")).toBe(1);
      expect(await countIn("people")).toBe(0);
    });

    it("an update step moves a project to another area: old edge gone, new edge present", async () => {
      const oldArea = await createIn("areas", { name: "Home" });
      const newArea = await createIn("areas", { name: "Work" });
      const project = await createIn("projects", { name: "Move" });
      await linkArea(project, oldArea);
      const card = await cardWithSteps("projects", [
        updateStep("project", project, {
          properties: { name: "Move" },
          relations: { area: [newArea] },
          before: { properties: { name: "Move" }, relations: { area: [oldArea] } },
          after: { properties: { name: "Move" }, relations: { area: [newArea] } },
        }),
      ]);

      const confirmed = await confirm(card);
      expect(confirmed.properties.resultItemId).toBe(project);
      expect(await edgeExists(project, oldArea)).toBe(false);
      expect(await edgeExists(project, newArea)).toBe(true);
    });

    describe("a primary update that changes nothing, for an existing record (issue gh-1992)", () => {
      const reopen = (cardId: string) =>
        runInTenant(getTenantZeroId(), () =>
          withTransaction(pool, (client) => reopenProposalWithClient(client, config(), cardId, {})),
        );
      async function confirmedForExistingCompany() {
        const companyId = await createIn("companies", { name: "Bakery", ico: "07654321" });
        const before = await readItem(companyId);
        const card = await cardWithSteps("companies", [
          updateStep("company", companyId, {
            before: { properties: {}, relations: {} },
            after: { properties: {}, relations: {} },
          }),
        ]);
        const confirmed = await confirm(card);
        return { companyId, before, card, confirmed };
      }

      it("creates no item, writes nothing to the existing one and answers it as the result", async () => {
        const { companyId, before, confirmed } = await confirmedForExistingCompany();

        expect(confirmed.properties).toMatchObject({ status: "confirmed", resultItemId: companyId });
        expect(await countIn("companies")).toBe(1);
        const after = await readItem(companyId);
        expect(after?.properties).toEqual(before?.properties);
        expect(after?.updatedAt).toBe(before?.updatedAt);
      });

      it("is undone without touching the existing item while it is unchanged", async () => {
        const { companyId, card } = await confirmedForExistingCompany();

        const reopened = await reopen(card);

        expect(reopened.item.properties.status).toBe("proposed");
        expect((await readItem(companyId))?.properties).toMatchObject({ name: "Bakery", ico: "07654321" });
        expect(await countIn("companies")).toBe(1);
      });

      it("refuses the undo with 409 version_conflict once the existing item changed after the confirm", async () => {
        const { companyId, card } = await confirmedForExistingCompany();
        await updateIn("companies", companyId, { name: "Bakery & Cafe" });

        await expect(reopen(card)).rejects.toMatchObject({ status: 409, code: "version_conflict" });

        expect(await cardStatus(card)).toBe("confirmed");
        expect((await readItem(companyId))?.properties).toMatchObject({ name: "Bakery & Cafe" });
      });
    });

    it("guards an unchanged declared relation and rolls back an earlier create when it is stale", async () => {
      const oldArea = await createIn("areas", { name: "Old" });
      const newArea = await createIn("areas", { name: "New" });
      const project = await createIn("projects", { name: "Before" });
      const oldEdge = { relationPropertyId: (await areaProperty()).id, callerItemId: project, targetItemId: oldArea };
      await withTransaction(pool, (client) => createRelationWithClient(client, oldEdge));
      const card = await cardWithSteps("companies", [
        { ref: "company", op: "create", databaseKey: "companies", role: "primary", properties: { name: "Acme" } },
        updateStep("project", project, {
          role: "secondary",
          properties: { name: "After" },
          before: { properties: { name: "Before" }, relations: { area: [oldArea] } },
          after: { properties: { name: "After" } },
        }),
      ]);
      await withTransaction(pool, async (client) => {
        await deleteRelationWithClient(client, oldEdge);
        await createRelationWithClient(client, { ...oldEdge, targetItemId: newArea });
      });
      await expect(confirm(card)).rejects.toMatchObject({ status: 400, details: { ref: "project", field: "area" } });
      expect(await countIn("companies")).toBe(0);
      expect(await cardStatus(card)).toBe("proposed");
      expect((await readItem(project))?.properties.name).toBe("Before");
      expect(await edgeExists(project, newArea)).toBe(true);
    });

    it("rejects duplicate targets in an unchanged declared before relation without writing", async () => {
      const area = await createIn("areas", { name: "Area" });
      const project = await createIn("projects", { name: "Before" });
      const card = await cardWithSteps("projects", [
        updateStep("project", project, {
          properties: { name: "After" },
          before: { properties: { name: "Before" }, relations: { area: [area, area] } },
          after: { properties: { name: "After" } },
        }),
      ]);
      await expect(confirm(card)).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining("contains duplicate targets"),
        details: { ref: "project", field: "area" },
      });
      expect((await readItem(project))?.properties.name).toBe("Before");
      expect(await cardStatus(card)).toBe("proposed");
      expect(await edgeExists(project, area)).toBe(false);
    });

    it("links an existing person to a created company once and rolls back a later failure", async () => {
      const person = await createIn("people", { name: "Jane" });
      const personPageBefore = await docStore.readPageMarkdown(person);
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
      expect(await countIn("companies")).toBe(0);
      expect(await countIn("people")).toBe(1);
      expect(await cardStatus(failing)).toBe("proposed");
      const card = await cardWithSteps("companies", steps);
      const first = await confirm(card);
      const company = first.properties.resultItemId;
      if (typeof company !== "string") throw new Error("Expected created company");
      expect(await edgeExists(person, company)).toBe(true);
      expect(await docStore.readPageMarkdown(person)).toEqual(personPageBefore);
      const repeated = await confirm(card);
      expect(repeated.id).toBe(first.id);
      expect(repeated.properties).toEqual(first.properties);
      expect(repeated.updatedAt).toBe(first.updatedAt);
      expect(await countIn("companies")).toBe(1);
      expect(await edgeCount(person, company)).toBe(1);
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
      expect(await countIn("companies")).toBe(0);
      expect(await countIn("people")).toBe(1);
      expect(await cardStatus(card)).toBe("proposed");
      expect(await edgeExists(person, missing)).toBe(false);
    });

    it("writes a relation declared only in after using the validated targets", async () => {
      const oldArea = await createIn("areas", { name: "Old" });
      const newArea = await createIn("areas", { name: "New" });
      const project = await createIn("projects", { name: "Move" });
      await linkArea(project, oldArea);
      const card = await cardWithSteps("projects", [
        updateStep("project", project, {
          properties: {},
          before: { relations: { area: [oldArea] } },
          after: { relations: { area: [newArea] } },
        }),
      ]);
      await addValueLink(project, "area");
      await addValueLink(newArea, await inverseKeyOf(await databaseIdFor("projects"), "area"));
      const actorId = randomUUID();
      await captureInvalidations(async (events) => {
        await expectConfirmRolledBack(card, actorId, events);
        expect((await valueLinkOf(project))?.state).toBe("on");
        expect((await valueLinkOf(newArea))?.state).toBe("on");
        await confirm(card, actorId);
        expect(await valueLinkOf(newArea)).toMatchObject({ state: "broken", brokenBy: "user" });
        expect(itemEventsOf(events, newArea)).toEqual([expect.objectContaining({ userId: actorId })]);
        expect(itemEventsOf(events, project)).toContainEqual(expect.objectContaining({ userId: actorId }));
      });
      expect(await edgeExists(project, oldArea)).toBe(false);
      expect(await edgeExists(project, newArea)).toBe(true);
    });

    it("moves relations on a legacy pinned project without preparing an item write", async () => {
      const oldArea = await createIn("areas", { name: "Old" });
      const newArea = await createIn("areas", { name: "New" });
      const project = await createIn("projects", { name: "Project", pinned: false });
      await legacyPin(project);
      await linkArea(project, oldArea);
      const card = await cardWithSteps("projects", [
        updateStep("project", project, {
          properties: {},
          before: { relations: { area: [oldArea] } },
          after: { relations: { area: [newArea] } },
        }),
      ]);
      await confirm(card);
      expect((await readItem(project))?.properties).toMatchObject({ pinned: true, pinnedOrder: null });
      expect(await edgeExists(project, oldArea)).toBe(false);
      expect(await edgeExists(project, newArea)).toBe(true);
    });

    it("requires before and no predicted after for implicit task completion, then confirms", async () => {
      const task = await createIn("tasks", { name: "Task", status: "notDone" });
      const base = updateStep("task", task, {
        properties: { status: "done" },
        before: { properties: { status: "notDone" } },
        after: { properties: { status: "done" } },
      });
      const completedOnRefused = { status: 400, details: { ref: "task", field: "completedOn" } };
      const missing = await cardWithSteps("tasks", [base]);
      await expect(confirm(missing)).rejects.toMatchObject(completedOnRefused);
      expect(await cardStatus(missing)).toBe("proposed");
      const predicted = await cardWithSteps("tasks", [
        {
          ...base,
          before: { properties: { status: "notDone", completedOn: null } },
          after: { properties: { status: "done", completedOn: "2020-01-01" } },
        },
      ]);
      await expect(confirm(predicted)).rejects.toMatchObject(completedOnRefused);
      const unchanged = await readItem(task);
      expect(unchanged?.properties).toMatchObject({ status: "notDone" });
      expect(unchanged?.properties.completedOn).toBeUndefined();
      await confirm(
        await cardWithSteps("tasks", [{ ...base, before: { properties: { status: "notDone", completedOn: null } } }]),
      );
      const done = await readItem(task);
      expect(done?.properties.status).toBe("done");
      expect(typeof done?.properties.completedOn).toBe("string");
    });

    it("requires ordinary before and after values for explicit completion and clearing", async () => {
      const task = await createIn("tasks", { name: "Task", status: "notDone" });
      await confirm(
        await cardWithSteps("tasks", [
          updateStep("task", task, {
            properties: { status: "done", completedOn: "2020-01-01" },
            before: { properties: { status: "notDone", completedOn: null } },
            after: { properties: { status: "done", completedOn: "2020-01-01" } },
          }),
        ]),
      );
      const clear = updateStep("task", task, {
        properties: { status: "notDone" },
        before: { properties: { status: "done" } },
        after: { properties: { status: "notDone" } },
      });
      const missing = await cardWithSteps("tasks", [clear]);
      await expect(confirm(missing)).rejects.toMatchObject({
        status: 400,
        details: { ref: "task", field: "completedOn" },
      });
      expect((await readItem(task))?.properties.completedOn).toBe("2020-01-01");
      await confirm(
        await cardWithSteps("tasks", [
          {
            ...clear,
            before: { properties: { status: "done", completedOn: "2020-01-01" } },
            after: { properties: { status: "notDone", completedOn: null } },
          },
        ]),
      );
      expect((await readItem(task))?.properties).toMatchObject({
        status: "notDone",
        completedOn: null,
        completedAt: null,
      });
    });

    it("clears task times only with explicit before and after coverage", async () => {
      const task = await createIn("tasks", { name: "Task", date: "2026-11-01", timeFrom: "09:00", timeTo: "10:00" });
      const missing = await cardWithSteps("tasks", [
        updateStep("task", task, {
          properties: { date: null },
          before: { properties: { date: "2026-11-01" } },
          after: { properties: { date: null } },
        }),
      ]);
      await expect(confirm(missing)).rejects.toMatchObject({
        status: 400,
        details: { ref: "task", field: "timeFrom" },
      });
      expect(await cardStatus(missing)).toBe("proposed");
      expect((await readItem(task))?.properties).toMatchObject({
        date: "2026-11-01",
        timeFrom: "09:00",
        timeTo: "10:00",
      });
      await confirm(await clearTimesCard(task));
      expect((await readItem(task))?.properties).toMatchObject({
        date: null,
        timeFrom: null,
        timeTo: null,
        time: null,
      });
    });

    it.each([
      ["a stale implicitly cleared task time", { timeTo: "10:00" }, { timeFrom: "09:30" }],
      [
        "an implicit time precondition after the current time is cleared",
        { timeTo: null },
        { timeFrom: null, timeTo: null },
      ],
    ])("rejects %s without writing the card", async (_label, times, change) => {
      const task = await createIn("tasks", { name: "Task", date: "2026-11-01", timeFrom: "09:00", ...times });
      const timeTo = times.timeTo === null ? {} : { timeTo: "10:00" };
      const card = await cardWithSteps("tasks", [
        updateStep("task", task, {
          properties: { date: null },
          before: { properties: { date: "2026-11-01", timeFrom: "09:00", ...timeTo } },
          after: { properties: { date: null, timeFrom: null, ...(times.timeTo === null ? {} : { timeTo: null }) } },
        }),
      ]);
      await updateIn("tasks", task, change);
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
        updateStep("project", project, {
          properties: { status: "done" },
          before: { properties: { status: "inProgress", pinned: true, pinnedOrder: order } },
          after: { properties: { status: "done", pinned: false, pinnedOrder: null } },
        }),
      ]);
      await updateIn("projects", project, { pinned: false });
      const later = await prepare();
      expect(Object.hasOwn(later.prepared.patch, "pinned")).toBe(false);
      const cardBefore = await readItem(card);
      await expect(confirm(card)).rejects.toMatchObject({ status: 400, details: { ref: "project", field: "pinned" } });
      expect(await readItem(project)).toEqual(later.item);
      expect(await readItem(card)).toEqual(cardBefore);
    });

    /** A card that clears the date of a task together with both of its times, as they were when it was formed. */
    const clearTimesCard = async (task: string) =>
      cardWithSteps("tasks", [
        updateStep("task", task, {
          properties: { date: null },
          before: { properties: { date: "2026-11-01", timeFrom: "09:00", timeTo: "10:00" } },
          after: { properties: { date: null, timeFrom: null, timeTo: null } },
        }),
      ]);
    const timedTask = () => createIn("tasks", { name: "Task", date: "2026-11-01", timeFrom: "09:00", timeTo: "10:00" });

    it("waits for an overlapping task time change and rejects the stale implicit clear", async () => {
      const task = await timedTask();
      const card = await clearTimesCard(task);
      const cardBefore = await readItem(card);
      const refused = { status: "rejected", reason: { status: 400, details: { ref: "task", field: "timeFrom" } } };
      const [writer, contender] = await runPreconditionOverlap(
        (client) =>
          updateItemWithClient(client, { databaseId: tasksId, itemId: task, propertiesPatch: { timeFrom: "09:30" } }),
        (client) => confirmProposalWithClient(client, config(), card),
        (pid, observer) => assertItemHeld(task, pid, observer),
        ([first, second]) => {
          expect(first.status).toBe("fulfilled");
          expect(second).toMatchObject(refused);
        },
      );
      if (writer.status === "rejected") throw writer.reason;
      expect(contender).toMatchObject(refused);
      expect(await readItem(card)).toEqual(cardBefore);
      expect((await readItem(task))?.properties).toMatchObject({
        date: "2026-11-01",
        timeFrom: "09:30",
        timeTo: "10:00",
      });
    }, 25000);

    it("holds the Tasks precondition against a later valid schedule writer", async () => {
      const task = await timedTask();
      const card = await clearTimesCard(task);
      const [confirmation, writer] = await runPreconditionOverlap(
        async (client) => {
          const confirmed = await confirmProposalWithClient(client, config(), card);
          const [cleared] = await itemsStore.getItemsByIds(client, [task]);
          expect(cleared?.properties).toMatchObject({ date: null, timeFrom: null, timeTo: null, time: null });
          return confirmed;
        },
        (client) =>
          updateItemWithClient(client, {
            databaseId: tasksId,
            itemId: task,
            propertiesPatch: { date: "2026-11-02", timeFrom: "09:30" },
          }),
        (pid, observer) => assertItemHeld(task, pid, observer),
      );
      if (confirmation.status === "rejected") throw confirmation.reason;
      if (writer.status === "rejected") throw writer.reason;
      expect(confirmation.value.properties.status).toBe("confirmed");
      expect(await cardStatus(card)).toBe("confirmed");
      const rescheduled = { date: "2026-11-02", timeFrom: "09:30", timeTo: null, time: "09:30" };
      expect(writer.value.properties).toMatchObject(rescheduled);
      expect((await readItem(task))?.properties).toMatchObject(rescheduled);
    }, 25000);

    it("rolls back an earlier created item when a later update has stale before values", async () => {
      const task = await createIn("tasks", { name: "Actual" });
      const card = await cardWithSteps("companies", [
        { ref: "company", op: "create", databaseKey: "companies", role: "primary", properties: { name: "Acme" } },
        updateStep("task", task, {
          role: "secondary",
          properties: { name: "After" },
          before: { properties: { name: "Old" } },
          after: { properties: { name: "After" } },
        }),
      ]);
      await expect(confirm(card)).rejects.toMatchObject({ status: 400, details: { ref: "task", field: "name" } });
      expect(await countIn("companies")).toBe(0);
      expect(await cardStatus(card)).toBe("proposed");
      expect((await readItem(task))?.properties.name).toBe("Actual");
    });

    it("allocates a project pin order after another project is pinned", async () => {
      const project = await createIn("projects", { name: "First", pinned: false });
      const other = await createIn("projects", { name: "Other", pinned: false });
      const card = await cardWithSteps("projects", [
        updateStep("project", project, {
          properties: { pinned: true },
          before: { properties: { pinned: false, pinnedOrder: null } },
          after: { properties: { pinned: true } },
        }),
      ]);
      const earlier = await updateIn("projects", other, { pinned: true });
      await confirm(card);
      expect(typeof earlier.properties.pinnedOrder).toBe("number");
      expect((await readItem(project))?.properties.pinnedOrder).toBe(Number(earlier.properties.pinnedOrder) + 1);
    });

    it("forms and confirms project completion without predicting its system date", async () => {
      const project = await createIn("projects", { name: "Project", status: "inProgress", pinned: false });
      const projectsDb = await databaseIdFor("projects");
      const step = updateStep("project", project, { properties: { status: "done" } });
      const form = (properties: Record<string, unknown>) =>
        withTransaction(pool, (client) =>
          prepareComputedUpdates(
            client,
            { entityKind: "database", target: projectsDb, properties, operations: [{ ...step, properties }] },
            null,
          ),
        );
      const before = await readItem(project);
      await expect(form({ completedAt: "2000-01-01" })).rejects.toMatchObject({ status: 400 });
      expect(await readItem(project)).toEqual(before);
      const formedStep = (await form({ status: "done" })).operations?.[0];
      if (!formedStep) throw new Error("Missing formed project step");
      expect(formedStep.before?.properties).not.toHaveProperty("completedAt");
      expect(formedStep.after?.properties).not.toHaveProperty("completedAt");
      await confirm(await cardWithSteps("projects", [formedStep]));
      expect((await readItem(project))?.properties).toMatchObject({
        status: "done",
        completedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      });
    });

    describe("an Event update whose date carries an offset (issues #1598, C7)", () => {
      /** Forms the update step of a Sync meeting moved to an instant, and stores nothing. */
      const formed = async () => {
        const event = await createIn("events", { name: "Sync", type: "meeting", date: "2026-10-16" });
        const eventsDb = await databaseIdFor("events");
        const offsetStep = updateStep("event", event, { properties: { date: "2026-10-16T08:00:00Z" } });
        const envelope = await withTransaction(pool, (client) =>
          prepareComputedUpdates(
            client,
            {
              entityKind: "database",
              target: eventsDb,
              properties: offsetStep.properties ?? {},
              operations: [offsetStep],
            },
            "2026-10-16",
          ),
        );
        const step = envelope.operations?.[0];
        if (!step) throw new Error("Missing formed Event step");
        return { event, envelope, step };
      };

      it("forms before/after values with the tenant zone, validates the envelope and confirms the converted values", async () => {
        const { event, envelope, step } = await formed();
        expect(step.before?.properties).toEqual({ date: "2026-10-16", timeFrom: null, timeTo: null });
        expect(step.after?.properties).toEqual({ date: "2026-10-16", timeFrom: "10:00", timeTo: "11:00" });
        await withTransaction(pool, (client) => assertValidProposalEnvelope(client, envelope));

        const card = await cardWithSteps("events", [step]);
        await confirm(card);
        expect((await readItem(event))?.properties).toMatchObject({
          date: "2026-10-16",
          timeFrom: "10:00",
          timeTo: "11:00",
          time: "10:00–11:00",
        });
        expect(await cardStatus(card)).toBe("confirmed");
      });

      it("refuses an envelope whose after values ignore the conversion, at validation and at confirmation", async () => {
        const { event, envelope, step } = await formed();
        const raw: Step = {
          ...step,
          after: { ...step.after, properties: { date: "2026-10-16T08:00:00Z", timeFrom: null, timeTo: null } },
        };
        await expect(
          withTransaction(pool, (client) => assertValidProposalEnvelope(client, { ...envelope, operations: [raw] })),
        ).rejects.toMatchObject({ status: 400, details: { ref: "event" } });
        const before = await readItem(event);
        const card = await cardWithSteps("events", [raw]);
        await expect(confirm(card)).rejects.toMatchObject({ status: 400, details: { ref: "event" } });
        expect(await readItem(event)).toEqual(before);
        expect(await cardStatus(card)).toBe("proposed");
      });

      it("refuses confirmation without writes when the tenant zone changed after the proposal was formed", async () => {
        const { event, step } = await formed();
        const card = await cardWithSteps("events", [step]);
        const before = await readItem(event);
        await withTransaction(pool, async (client) =>
          updateItemWithClient(client, {
            databaseId: await getSystemSettingsDatabaseId(client),
            itemId: await getSystemSettingsItemId(client),
            propertiesPatch: { timezone: "America/New_York" },
          }),
        );
        await expect(confirm(card)).rejects.toMatchObject({
          status: 400,
          details: { ref: "event", field: "timeFrom" },
        });
        expect(await readItem(event)).toEqual(before);
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
        const type = await taskType();
        const ids: string[] = [];
        for (const text of texts) ids.push((await inboxItem(text, type)).id);
        return ids;
      }

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

      function expectSettingsFailure(failure: unknown): void {
        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBeInstanceOf(ValidationError);
        if (!(failure instanceof Error)) return;
        expect(failure.message).toBe("The tenant time zone setting is invalid");
        expect(failure.cause).toBeInstanceOf(ValidationError);
        expect(failure.cause).toMatchObject({ details: { field: "timezone" } });
      }
      const failureOf = (promise: Promise<void>) =>
        promise.then(
          () => null,
          (error: unknown) => error,
        );

      it("propagates from the computed update preparation of a tick and writes no card", async () => {
        const existing = await createIn("tasks", { name: "Buy milk" });
        const [control, source] = await taskInboxItems("Buy milk", "Buy milk again");
        await runTick(control!, twoSteps(existing));
        expect((await findProposalForItem(control!))?.properties.status).toBe("proposed");

        await corruptTenantZone();
        const cardsBefore = await proposalRows();
        const taskBefore = await readItem(existing);
        expectSettingsFailure(await failureOf(runTick(source!, twoSteps(existing))));
        expect(await findProposalForItem(source!)).toBeNull();
        expect(await proposalRows()).toEqual(cardsBefore);
        expect(await readItem(existing)).toEqual(taskBefore);
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
        const failure = await failureOf(
          runTick(source!, async () => {
            throw new Error("computeProposal must not be called before the stored card is revalidated");
          }),
        );
        expectSettingsFailure(failure);
        expect(await findProposalForItem(source!)).toEqual(invalid);
        expect(await proposalRows()).toEqual(cardsBefore);
        expect(await readItem(existing)).toMatchObject({ properties: { name: "Buy milk" } });
      });

      it("still turns an invalid computed update into a clarification card while the stored zone is valid", async () => {
        const existing = await createIn("tasks", { name: "Buy milk" });
        const [source] = await taskInboxItems("Buy milk");
        const taskBefore = await readItem(existing);
        await runTick(source!, twoSteps(existing, { notAProperty: "x" }));
        expect((await findProposalForItem(source!))?.properties.status).toBe("needsClarification");
        expect(await readItem(existing)).toEqual(taskBefore);
      });
    });

    it("requires coverage for automatic project unpinning and order clearing", async () => {
      const project = await createIn("projects", { name: "Project", status: "inProgress", pinned: true });
      const order = (await readItem(project))?.properties.pinnedOrder;
      if (typeof order !== "number") throw new Error("Missing allocated pin order");
      const step = updateStep("project", project, {
        properties: { status: "done" },
        before: { properties: { status: "inProgress" } },
        after: { properties: { status: "done" } },
      });
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
      const updated = await readItem(project);
      expect(updated?.properties).toMatchObject({ status: "done", pinned: false, pinnedOrder: null });
      expect(updated?.properties.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("retains a declared pin-order precondition when a concurrent pin removes the deferred allocation", async () => {
      const project = await createIn("projects", { name: "Project", pinned: false });
      await legacyPin(project);
      const card = await cardWithSteps("projects", [
        updateStep("project", project, {
          properties: { pinned: true },
          before: { properties: { pinnedOrder: null, pinned: true } },
          after: { properties: { pinned: true } },
        }),
      ]);
      await updateIn("projects", project, { pinned: true });
      await expect(confirm(card)).rejects.toMatchObject({
        status: 400,
        details: { ref: "project", field: "pinnedOrder" },
      });
      expect(await cardStatus(card)).toBe("proposed");
    });

    it("an update step's status goes through the choke point; a failing later step restores the old status and edge", async () => {
      const project = await createIn("projects", { name: "Ship" });
      const area = await createIn("areas", { name: "Work" });
      const update = updateStep("project", project, {
        properties: { status: "done" },
        relations: { area: [area] },
        before: { properties: { status: "inProgress" }, relations: { area: [] } },
        after: { properties: { status: "done" }, relations: { area: [area] } },
      });
      const statusOf = async () => (await readItem(project))?.properties.status;

      const failingCard = await cardWithSteps("projects", [
        update,
        { ref: "person", op: "create", databaseKey: "people", role: "secondary", properties: { name: 42 } },
      ]);
      await expect(confirm(failingCard)).rejects.toMatchObject({ details: { ref: "person" } });
      expect(await statusOf()).toBe("inProgress");
      expect(await edgeExists(project, area)).toBe(false);

      await confirm(await cardWithSteps("projects", [update]));
      expect(await statusOf()).toBe("done");
    });

    type Change = "property" | "insert" | "delete" | "insert-extra" | "delete-extra";
    const CHANGES = ["property", "insert", "delete", "insert-extra", "delete-extra"] as const;
    /** A project whose update step declares its name and its area edges as they were when the card was formed. */
    async function areaPreconditionCard(change: Change) {
      const project = await createIn("projects", { name: "Before" });
      const area = await createIn("areas", { name: "Area" });
      const property = await areaProperty();
      const edge = { relationPropertyId: property.id, callerItemId: project, targetItemId: area };
      const deletes = change === "delete" || change === "delete-extra";
      if (deletes) await withTransaction(pool, (client) => createRelationWithClient(client, edge));
      const beforeTargets = deletes ? [area] : [];
      const extraOnly = change.endsWith("-extra");
      const card = await cardWithSteps("projects", [
        updateStep("project", project, {
          properties: { name: "After" },
          ...(extraOnly ? {} : { relations: { area: beforeTargets } }),
          before: { properties: { name: "Before" }, relations: { area: beforeTargets } },
          after: { properties: { name: "After" }, ...(extraOnly ? {} : { relations: { area: beforeTargets } }) },
        }),
      ]);
      const definition = await withTransaction(pool, (client) =>
        relationsStore.getRelationDefinitionByPropertyId(client, property.id),
      );
      if (!definition) throw new Error("Missing relation definition");
      const apply = async (client: PoolClient, name: string) => {
        if (change === "property") {
          await updateItemWithClient(client, {
            databaseId: await databaseIdFor("projects"),
            itemId: project,
            propertiesPatch: { name },
          });
        } else if (change === "insert" || change === "insert-extra") {
          await createRelationWithClient(client, edge);
        } else {
          await deleteRelationWithClient(client, edge);
        }
      };
      const inserts = change === "insert" || change === "insert-extra";
      return { project, area, card, definition, apply, deletes, inserts };
    }

    it.each(CHANGES)(
      "rejects stale before state after an overlapping %s commits",
      async (change) => {
        const { project, area, card, definition, apply, inserts } = await areaPreconditionCard(change);
        const cardBefore = await readItem(card);
        const refused = {
          status: "rejected",
          reason: { status: 400, details: { ref: "project", field: change === "property" ? "name" : "area" } },
        };
        const [writer, contender] = await runPreconditionOverlap(
          (client) => apply(client, "Changed"),
          (client) => confirmProposalWithClient(client, config(), card),
          (pid, observer) =>
            change === "property"
              ? assertItemHeld(project, pid, observer)
              : inserts
                ? assertDefinitionHeld(definition.id, pid, observer)
                : assertEdgeHeld(definition.id, project, area, pid, observer),
          ([first, second]) => {
            expect(first.status).toBe("fulfilled");
            expect(second).toMatchObject(refused);
          },
        );
        if (writer.status === "rejected") throw writer.reason;
        expect(contender).toMatchObject(refused);
        expect(await readItem(card)).toEqual(cardBefore);
        expect((await readItem(project))?.properties.name).toBe(change === "property" ? "Changed" : "Before");
        expect(await edgeExists(project, area)).toBe(inserts);
      },
      25000,
    );

    it.each(CHANGES)(
      "holds precondition locks against a later overlapping %s",
      async (change) => {
        const { project, area, card, definition, apply, deletes, inserts } = await areaPreconditionCard(change);
        const [confirmation, writer] = await runPreconditionOverlap(
          (client) => confirmProposalWithClient(client, config(), card),
          (client) => apply(client, "Later"),
          async (pid, observer) => {
            await assertItemHeld(project, pid, observer);
            await assertDefinitionHeld(definition.id, pid, observer);
            if (deletes) await assertEdgeHeld(definition.id, project, area, pid, observer);
          },
        );
        if (confirmation.status === "rejected") throw confirmation.reason;
        if (writer.status === "rejected") throw writer.reason;
        expect(await cardStatus(card)).toBe("confirmed");
        expect((await readItem(project))?.properties.name).toBe(change === "property" ? "Later" : "After");
        expect(await edgeExists(project, area)).toBe(inserts);
      },
      25000,
    );

    it("returns the Inbox flag on a Files query after a real confirmation", async () => {
      const file = await withTransaction(pool, (client) => newFileValue(client));
      const card = await cardWithSteps("files", [
        { ref: "file", op: "create", databaseKey: "files", role: "primary", properties: { name: "From Inbox", file } },
      ]);
      const confirmed = await confirm(card);
      const createdId = z.string().parse(confirmed.properties.resultItemId);
      expect((await docStore.readPageMarkdown(createdId)).markdown).toBe("Vytvořeno ze schránky: seed");
      const manual = await createIn("files", { name: "Manual" });
      const page = await createChokePoint(pool).queryDatabaseItems(await databaseIdFor("files"), {});
      expect(page.items.find((item) => item.id === confirmed.properties.resultItemId)?.fromInbox).toBe(true);
      expect(page.items.find((item) => item.id === manual)?.fromInbox).toBe(false);
    });

    it("addresses every realtime invalidation of a confirm to the acting user", async () => {
      const card = await cardWithSteps("companies", companyAndPerson());
      const actingUserId = randomUUID();
      const events = await captureInvalidations(async (captured) => {
        await confirm(card, actingUserId);
        return captured;
      });
      const itemEvents = events.filter((event) => event.scope === "item");
      expect(itemEvents.length).toBeGreaterThanOrEqual(3);
      expect(itemEvents.every((event) => event.userId === actingUserId)).toBe(true);
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
      const createdIds = async () =>
        (
          await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = ANY($1)", [
            [await databaseIdFor("companies"), await databaseIdFor("people")],
          ])
        ).rows.map((row) => row.id);
      const confirmedCompany = async () => {
        const confirmed = await confirm(await cardWithSteps("companies", companyAndPerson()));
        const itemId = z.string().parse(confirmed.properties.resultItemId);
        const row = await readItem(itemId);
        if (!row) throw new Error("Expected created item row");
        await createChokePoint(pool).softDeleteItem(row.databaseId, itemId);
        return itemId;
      };
      const purge = (itemId: string) =>
        createChokePoint(pool).purgeExpiredTrashSubtree(itemId, new Date(Date.now() + 1000));

      it("writes one row per created item with the card, the source Inbox item and its capture time, and a repeated confirm creates and changes nothing", async () => {
        const card = await cardWithSteps("companies", companyAndPerson());
        await confirm(card);

        const inboxItemId = await sourceOf(card);
        const inboxItem = await readItem(inboxItemId);
        const rows = await originRows();
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.item_id).sort()).toEqual((await createdIds()).sort());
        for (const row of rows) {
          expect((await docStore.readPageMarkdown(row.item_id)).markdown).toBe("Vytvořeno ze schránky: seed");
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
        await confirm(card);
        expect(await originRows()).toEqual(rows);
        expect(await countIn("companies")).toBe(1);
        expect(await countIn("people")).toBe(1);
      });

      it.each([
        ["date", null],
        ["date", "invalid"],
        ["time", null],
        ["time", "invalid"],
      ])("records an unknown time for an Inbox capture %s %s", async (key, value) => {
        const card = await cardWithSteps("companies", companyAndPerson());
        await withTransaction(pool, async (client) =>
          updateItemWithClient(client, {
            databaseId: inboxId,
            itemId: await sourceOf(card),
            propertiesPatch: { [key]: value },
          }),
        );
        await confirm(card);
        expect((await originRows()).map((row) => [row.captured_at, row.capture_time_basis])).toEqual([
          [null, "unknown"],
          [null, "unknown"],
        ]);
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

      it("records no guessed time for a revised transcript card", async () => {
        const { cardId, transcriptId } = await createTranscript(60);
        await reviseCard(cardId, {
          message: "Revised",
          entityKind: "database",
          target: await databaseIdFor("events"),
          properties: { name: "Meeting", date: "2024-03-01" },
        });
        await confirm(cardId);
        const [row] = await originRows();
        expect(row).toMatchObject({
          source_transcript_id: transcriptId,
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
          updateStep("company", existing, {
            properties: { name: "Renamed" },
            before: { properties: { name: "Existing" } },
            after: { properties: { name: "Renamed" } },
          }),
          companyAndPerson()[1]!,
        ]);
        await confirm(card);
        const rows = await originRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.item_id).not.toBe(existing);
        expect((await docStore.readPageMarkdown(existing)).docId).toBeNull();
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
        const cardBefore = await readCard(card);
        const edgeCountBefore = await countEdges();
        await withFailingTrigger(
          "item_origins",
          "INSERT",
          "EXISTS (SELECT 1 FROM item_origins WHERE proposal_id = NEW.proposal_id)",
          async () => {
            await expect(confirm(card)).rejects.toThrow("test trigger failure");
          },
        );
        expect(await countIn("companies")).toBe(0);
        expect(await countIn("people")).toBe(0);
        expect(await originRows()).toEqual([]);
        expect(await countEdges()).toBe(edgeCountBefore);
        expect(await readCard(card)).toEqual(cardBefore);
      });

      it("permanent deletion removes the item's row and keeps the other item's", async () => {
        const resultId = await confirmedCompany();

        const result = await purge(resultId);

        expect(result.purgedItemIds).toContain(resultId);
        expect(
          await withTransaction(pool, (client) => itemsStore.getItemsByIdsIncludingDeleted(client, [resultId])),
        ).toEqual([]);
        const rows = await originRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.item_id).not.toBe(resultId);
      });

      it("rolls back the hard deletion if origin cleanup fails", async () => {
        const itemId = await confirmedCompany();
        const before = await originRows();
        await withFailingTrigger("item_origins", "DELETE", "TRUE", async () => {
          await expect(purge(itemId)).rejects.toThrow("test trigger failure");
        });
        const remaining = await withTransaction(pool, (client) =>
          itemsStore.getItemsByIdsIncludingDeleted(client, [itemId]),
        );
        expect(remaining).toHaveLength(1);
        expect(remaining[0]?.deletedAt).not.toBeNull();
        expect(await originRows()).toEqual(before);
      });
    });
  });

  it("revise transitions a 'needsClarification' proposal (no type at all) to 'proposed' with a valid envelope", async () => {
    const { card: needsClarification } = await untypedCard();

    const revised = await reviseCard(needsClarification.id, {
      message: "Filed this under Tasks myself",
      entityKind: "database",
      target: tasksId,
      properties: { name: "Buy milk" },
    });

    expect(revised.properties.status).toBe("proposed");
    expect(revised.properties.proposal).toEqual(taskEnvelope("Buy milk"));
    expect(historyOf(revised).at(-1)).toMatchObject({ author: "user", message: "Filed this under Tasks myself" });
  });

  it("revise refuses a locked (confirmed) proposal and an envelope that does not fit the destination's current state", async () => {
    const invalid = await createDatabaseProposal("Buy milk");
    await expect(
      reviseCard(invalid.id, {
        message: "typo fix",
        entityKind: "database",
        target: tasksId,
        properties: { notAKey: "x" },
      }),
    ).rejects.toThrow();

    const locked = await createDatabaseProposal("Buy milk");
    await confirmCard(locked.id);
    await expect(
      reviseCard(locked.id, {
        message: "too late",
        entityKind: "database",
        target: tasksId,
        properties: { name: "Buy milk again" },
      }),
    ).rejects.toThrow(/Cannot revise a locked proposal/);
  });

  it("revise cannot retarget a proposal at Inbox or Inbox item types — the agent's grant excludes them even via a user-supplied envelope", async () => {
    const proposal = await createDatabaseProposal("Buy milk");

    for (const target of [inboxId, typesId]) {
      await expect(
        reviseCard(proposal.id, { message: "retarget", entityKind: "database", target, properties: {} }),
      ).rejects.toThrow(/not a writable target database/);
    }

    expect((await readCard(proposal.id)).properties.proposal).toMatchObject({ target: tasksId });
  });

  describe("revise with an optional envelope, a message alone and ifVersion (issue #1870)", () => {
    const revise = reviseCard;
    /** A history write by another writer, which moves the card's version on. */
    const concurrentEdit = (card: ItemRow) =>
      storeProps(card.id, { history: appendHistoryEntry(card.properties.history, "A concurrent edit", "user") });
    const lastEntry = (card: ItemRow) => historyOf(card).at(-1);

    it("appends the message to a transcript card's history and changes nothing else", async () => {
      const cardId = await createTranscriptCard();
      const before = await readCard(cardId);

      const revised = await revise(cardId, { message: "Use the planning meeting instead" });

      const { history: historyBefore, ...restBefore } = before.properties;
      const { history: historyAfter, ...restAfter } = revised.properties;
      expect(restAfter).toEqual(restBefore);
      expect(revised.properties.status).toBe("proposed");
      expect(historyAfter).toEqual([
        ...(historyBefore as unknown[]),
        { id: expect.any(String), author: "user", message: "Use the planning meeting instead", at: expect.any(String) },
      ]);
      const stored = await readCard(cardId);
      expect({ properties: stored.properties, updatedAt: stored.updatedAt }).toEqual({
        properties: revised.properties,
        updatedAt: revised.updatedAt,
      });
    });

    it("refuses a message alone on a card that is not a transcript card, or on a locked transcript card, and writes nothing", async () => {
      const card = await createDatabaseProposal("Buy milk");
      const transcript = await createTranscriptCard();
      await rejectCard(transcript);

      const notTranscript = await expectRefusedUnchanged(card.id, () =>
        revise(card.id, { message: "Use the planning meeting instead" }),
      );
      const locked = await expectRefusedUnchanged(transcript, () => revise(transcript, { message: "Too late" }));

      expect(notTranscript).toBeInstanceOf(ValidationError);
      expect(notTranscript).toMatchObject({ code: "validation_failed", details: { field: "message" } });
      expect(locked).toMatchObject({ code: "validation_failed", details: { field: "status" } });
    });

    it("records 'Revised by user.' when an envelope comes without a message, and applies one whose ifVersion is current", async () => {
      const card = await createDatabaseProposal("Buy milk");

      const revised = await revise(card.id, {
        ifVersion: card.version,
        entityKind: "database",
        target: tasksId,
        properties: { name: "Buy bread" },
      });

      expect(lastEntry(revised)).toMatchObject({ author: "user", message: "Revised by user." });
      expect(revised.properties.proposal).toMatchObject({ properties: { name: "Buy bread" } });
    });

    it("applies a message alone whose ifVersion equals the card's updatedAt", async () => {
      const cardId = await createTranscriptCard();
      const card = await readCard(cardId);

      const revised = await revise(cardId, { ifVersion: card.version, message: "Note this" });

      expect(lastEntry(revised)).toMatchObject({ author: "user", message: "Note this" });
    });

    it.each([
      ["an envelope revise", false],
      ["a message alone", true],
    ])(
      "refuses %s with a stale ifVersion as version_conflict carrying the current card, writing nothing",
      async (_label, messageAlone) => {
        const card = messageAlone
          ? await readCard(await createTranscriptCard())
          : await createDatabaseProposal("Buy milk");
        await concurrentEdit(card);
        const current = await readCard(card.id);
        expect(current.updatedAt).not.toBe(card.updatedAt);

        const error = await revise(
          card.id,
          messageAlone
            ? { ifVersion: card.version, message: "Stale note" }
            : { ifVersion: card.version, entityKind: "database", target: tasksId, properties: { name: "Buy bread" } },
        ).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ConflictError);
        expect(error).toMatchObject({ status: 409, code: "version_conflict", details: { current } });
        expect(await readCard(card.id)).toEqual(current);
      },
    );

    describe("revise by the assistant of an item thread (issue #1906)", () => {
      const thread = { author: "ai", threadId: randomUUID(), messageId: randomUUID() } as const;
      const threadEntry = { kind: "threadRevision", threadId: thread.threadId, messageId: thread.messageId };
      const bread = () => ({ entityKind: "database", target: tasksId, properties: { name: "Buy bread" } }) as const;

      function reviseAs(cardId: string, input: Parameters<typeof reviseProposalWithClient>[3]) {
        return withTransaction(pool, (client) =>
          reviseProposalWithClient(client, config(), cardId, input, undefined, thread),
        );
      }

      it("writes an ai threadRevision entry with the thread and message ids, and the same envelope a user revise stores", async () => {
        const card = await createDatabaseProposal("Buy milk");

        const revised = await reviseAs(card.id, { ...bread(), message: "It is bread" });

        expect(lastEntry(revised)).toEqual({
          author: "ai",
          message: "It is bread",
          at: expect.any(String),
          ...threadEntry,
        });
        const byUser = await createDatabaseProposal("Buy milk");
        const revisedByUser = await revise(byUser.id, { ...bread(), message: "It is bread" });
        expect(revised.properties.proposal).toEqual(revisedByUser.properties.proposal);
        expect(revised.properties.status).toBe(revisedByUser.properties.status);
      });

      it("records 'Revised by assistant.' without a message, and writes the ai entry for a message alone on a transcript card", async () => {
        const card = await createDatabaseProposal("Buy milk");
        const cardId = await createTranscriptCard();

        const revised = await reviseAs(card.id, bread());
        const messaged = await reviseAs(cardId, { message: "Use the planning meeting instead" });

        expect(lastEntry(revised)).toMatchObject({ author: "ai", message: "Revised by assistant." });
        expect(lastEntry(messaged)).toMatchObject({
          author: "ai",
          message: "Use the planning meeting instead",
          ...threadEntry,
        });
      });

      it("keeps the refusal of a locked card for the assistant and writes nothing", async () => {
        const card = await createDatabaseProposal("Buy milk");
        await rejectCard(card.id);

        const error = await expectRefusedUnchanged(card.id, () => reviseAs(card.id, bread()));

        expect(error).toMatchObject({ code: "validation_failed", details: { field: "status" } });
      });
    });
  });

  describe("invalidReason on revise (issue #1482)", () => {
    const markInvalid = (proposalId: string, invalidReason?: Record<string, unknown>) =>
      storeProps(proposalId, { status: "invalid", ...(invalidReason ? { invalidReason } : {}) });
    const reviseToTask = (cardId: string, name = "Buy milk") =>
      reviseCard(cardId, {
        message: "Use Tasks instead",
        entityKind: "database",
        target: tasksId,
        properties: { name },
      });

    /** A card whose source Inbox item was soft-deleted, so the tick makes it `invalid` with `sourceDeleted`. */
    async function createSourceDeletedCard(prior: "targetArchived" | "targetDeleted" | "legacy") {
      const card = await createDatabaseProposal("Buy milk");
      const itemId = await sourceOf(card.id);
      await markInvalid(
        card.id,
        prior === "legacy" ? undefined : { code: prior, field: "project", itemId: randomUUID(), label: "Project" },
      );
      await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, itemId));
      await runTick(itemId, async () => {
        throw new Error("computeProposal must not be called for a deleted source");
      });
      return readCard(card.id);
    }

    it.each(["targetArchived", "targetDeleted", "legacy"] as const)(
      "a deleted source supersedes %s and revise is refused without changes",
      async (prior) => {
        const card = await createSourceDeletedCard(prior);
        expect(card.properties.status).toBe("invalid");
        expect(card.properties.invalidReason).toMatchObject({ code: "sourceDeleted" });

        const error = await expectRefusedUnchanged(card.id, () => reviseToTask(card.id));

        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toHaveProperty("details", { field: "status" });
      },
    );

    it.each([
      [
        "a fixable targetArchived card",
        { code: "targetArchived", field: "project", itemId: randomUUID(), label: "Website redesign" },
      ],
      ["a legacy invalid card with no invalidReason, treated as fixable,", undefined],
    ])("revising %s returns it to proposed and clears its reason in the same write", async (_label, reason) => {
      const card = await createDatabaseProposal("Buy milk");
      await markInvalid(card.id, reason);
      expect((await readCard(card.id)).properties.invalidReason).toEqual(reason);

      const revised = await reviseToTask(card.id, "Buy oat milk");

      expect(revised.properties.status).toBe("proposed");
      expect(revised.properties.invalidReason).toBeNull();
      expect(revised.properties.proposal).toEqual(taskEnvelope("Buy oat milk"));
    });
  });

  describe("editing proposal values (issue #1892)", () => {
    const setStatus = storeProps;
    const cardWithSteps = async (steps: Step[]): Promise<string> =>
      storeCard({
        entityKind: "database",
        target: await databaseIdFor("companies"),
        properties: steps.find((step) => step.role === "primary")?.properties ?? {},
        operations: steps,
      });
    const companyAndPerson: Step[] = [
      { ref: "company", op: "create", databaseKey: "companies", role: "primary", properties: { name: "Acme" } },
      {
        ref: "person",
        op: "create",
        databaseKey: "people",
        role: "secondary",
        properties: { name: "Jane" },
        relations: { companies: [{ ref: "company" }] },
      },
    ];
    const mcpCard = async () =>
      storeCard({
        entityKind: "database",
        target: await databaseIdFor("mcpServers"),
        properties: { name: "Remote tool" },
      });

    it("stores the typed title in proposal, lists it as edited and adds a userEdit history entry", async () => {
      const card = await createDatabaseProposal("Send the invoice");
      const before = await readCard(card.id);

      const edited = await edit(card.id, { primary: { name: "Poslat fakturu Alze" } });

      expect(edited.properties.proposal).toEqual(taskEnvelope("Poslat fakturu Alze"));
      expect(edited.properties.userOverrides).toEqual({ primary: { name: "Poslat fakturu Alze" } });
      expect(edited.properties.userEditedKeys).toEqual(["primary.name"]);
      expect(edited.properties.aiProposal).toEqual(taskEnvelope("Send the invoice"));
      expect(edited.properties.aiVersion).toBe(before.properties.aiVersion);
      expect(edited.properties.status).toBe("proposed");
      const history = historyOf(edited);
      expect(history).toHaveLength(2);
      expect(history[1]).toMatchObject({ author: "user", kind: "userEdit", keys: ["primary.name"] });

      const confirmed = await confirmCard(card.id);
      expect(confirmed.properties.resultLabel).toBe("Poslat fakturu Alze");
      const created = await withTransaction(pool, (client) =>
        itemsStore.getItemById(client, tasksId, z.string().parse(confirmed.properties.resultItemId)),
      );
      expect(created?.properties.name).toBe("Poslat fakturu Alze");
    });

    it("merges a second edit with the first and compares against the assistant's value, not the effective one", async () => {
      const card = await createDatabaseProposal("Send the invoice");
      await edit(card.id, { primary: { name: "Poslat fakturu Alze" } });

      const second = await edit(card.id, { primary: { flagged: true } });
      expect(second.properties.userOverrides).toEqual({ primary: { name: "Poslat fakturu Alze", flagged: true } });
      expect(second.properties.userEditedKeys).toEqual(["primary.flagged", "primary.name"]);
      expect(second.properties.proposal).toEqual({
        ...taskEnvelope("Poslat fakturu Alze"),
        properties: { name: "Poslat fakturu Alze", flagged: true },
      });
      expect(historyOf(second)[2]).toMatchObject({ keys: ["primary.flagged"] });

      // Setting the stored effective value again is still an edit: the assistant's value is another one.
      const again = await edit(card.id, { primary: { name: "Poslat fakturu Alze" } });
      expect(again.properties.userEditedKeys).toEqual(["primary.flagged", "primary.name"]);
    });

    it("drops the key from userEditedKeys and userOverrides when the title is set back to the assistant's", async () => {
      const card = await createDatabaseProposal("Send the invoice");
      await edit(card.id, { primary: { name: "Poslat fakturu Alze" } });

      const reverted = await edit(card.id, { primary: { name: "Send the invoice" } });

      expect(reverted.properties.userEditedKeys).toEqual([]);
      expect(reverted.properties.userOverrides).toEqual({});
      expect(reverted.properties.proposal).toEqual(taskEnvelope("Send the invoice"));
      expect(historyOf(reverted)[2]).toMatchObject({ kind: "userEdit", keys: ["primary.name"] });
    });

    it("accepts a current ifVersion and answers a stale one with a ConflictError carrying the current card, writing nothing", async () => {
      const card = await createDatabaseProposal("Send the invoice");
      const stale = (await readCard(card.id)).version;
      await edit(card.id, { primary: { name: "First edit" } }, stale);
      const current = await readCard(card.id);

      const error = await expectRefusedUnchanged(card.id, () => edit(card.id, { primary: { name: "Second" } }, stale));

      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({ status: 409, code: "version_conflict" });
      expect(error).toHaveProperty("details.current.id", card.id);
      expect(error).toHaveProperty("details.current.updatedAt", current.updatedAt);
      expect(current.properties.userOverrides).toEqual({ primary: { name: "First edit" } });
    });

    it.each(["confirm", "reject"] as const)(
      "refuses a card that was %sed with a ValidationError and writes nothing",
      async (action) => {
        const card = await createDatabaseProposal("Send the invoice");
        await (action === "confirm" ? confirmCard : rejectCard)(card.id);

        const error = await expectRefusedUnchanged(card.id, () => edit(card.id, { primary: { name: "Late" } }));

        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toHaveProperty("details", { field: "status" });
        expect((error as Error).message).toContain("locked");
      },
    );

    it.each([
      ["in the status computing", { status: "computing" }, undefined],
      ["in the status computeFailed", { status: "computeFailed" }, undefined],
      [
        "whose source was deleted",
        {
          status: "invalid",
          invalidReason: { code: "sourceDeleted", field: "", itemId: randomUUID(), label: "Send the invoice" },
        },
        "source Inbox item was deleted",
      ],
    ])("refuses a card %s and writes nothing", async (_label, patch, message) => {
      const card = await createDatabaseProposal("Send the invoice");
      await storeProps(card.id, patch);

      const error = await expectRefusedUnchanged(card.id, () => edit(card.id, { primary: { name: "Early" } }));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toHaveProperty("details", { field: "status" });
      if (message) expect((error as Error).message).toContain(message);
    });

    it.each([
      ["a needsClarification card that holds an envelope", { status: "needsClarification" }],
      [
        "a fixable invalid card, clearing its invalidReason in the same write",
        {
          status: "invalid",
          invalidReason: { code: "targetArchived", field: "project", itemId: randomUUID(), label: "Website" },
        },
      ],
    ])("moves %s to proposed", async (_label, patch) => {
      const card = await createDatabaseProposal("Send the invoice");
      await storeProps(card.id, patch);

      const edited = await edit(card.id, { primary: { name: "Chosen" } });

      expect(edited.properties.status).toBe("proposed");
      expect(edited.properties.userEditedKeys).toEqual(["primary.name"]);
      if ("invalidReason" in patch) expect(edited.properties.invalidReason).toBeNull();
    });

    it("refuses a needsClarification card with no envelope to edit and writes nothing", async () => {
      const { card } = await untypedCard("Something without a type");

      const error = await expectRefusedUnchanged(card.id, () => edit(card.id, { primary: { name: "Chosen" } }));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toHaveProperty("details", { field: "proposal" });
    });

    it("materializes aiProposal from proposal on a legacy card and leaves aiVersion absent", async () => {
      const card = await createDatabaseProposal("Send the invoice");
      // No current writer can produce a card without aiProposal and aiVersion.
      await pool.query("UPDATE items SET properties = properties - 'aiProposal' - 'aiVersion' WHERE id = $1", [
        card.id,
      ]);

      const edited = await edit(card.id, { primary: { name: "Typed" } });

      expect(edited.properties.aiProposal).toEqual(taskEnvelope("Send the invoice"));
      expect(edited.properties.proposal).toEqual(taskEnvelope("Typed"));
      expect(edited.properties.userEditedKeys).toEqual(["primary.name"]);
      expect(edited.properties).not.toHaveProperty("aiVersion");
    });

    it.each([
      ["an unknown ref, naming it", { second: { name: "Typed" } }, { ref: "second", field: "second" }, "'second'"],
      [
        "a key that is not a property of the target database",
        { primary: { colour: "red" } },
        { field: "colour" },
        "'colour'",
      ],
      [
        "a system-owned key through the confirm validation",
        { primary: { time: "10:00" } },
        { field: "time" },
        undefined,
      ],
      ["an empty set", {}, { field: "set" }, undefined],
      ["a set whose refs hold no values", { primary: {} }, { field: "set" }, undefined],
    ])("refuses %s, and writes nothing", async (_label, set, details, message) => {
      const card = await createDatabaseProposal("Send the invoice");

      const error = await expectRefusedUnchanged(card.id, () => edit(card.id, set));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toHaveProperty("details", details);
      if (message) expect((error as Error).message).toContain(message);
    });

    it("answers an unknown proposal id with NotFoundError", async () => {
      await expect(edit(randomUUID(), { primary: { name: "Typed" } })).rejects.toBeInstanceOf(NotFoundError);
    });

    describe("an MCP server card", () => {
      it("edits a plain field", async () => {
        const card = await mcpCard();

        const edited = await edit(card, { primary: { name: "Renamed tool" } });

        expect(edited.properties.userEditedKeys).toEqual(["primary.name"]);
      });

      it.each([
        ["the credential key 'credential'", "credential", "shh"],
        ["the credential key 'token'", "token", "shh"],
        ["the credential key 'apiKey'", "apiKey", "shh"],
        ["a stdio connectionConfig", "connectionConfig", { transport: "stdio", command: "my-mcp-server" }],
      ])("refuses %s with a ValidationError and writes nothing", async (_label, key, value) => {
        const card = await mcpCard();

        const error = await expectRefusedUnchanged(card, () => edit(card, { primary: { [key]: value } }));

        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toHaveProperty("details", { field: key });
      });
    });

    describe("a multi-step card", () => {
      it("edits a secondary step's field and leaves the primary step and the top-level properties alone", async () => {
        const card = await cardWithSteps(companyAndPerson);

        const edited = await edit(card, { person: { name: "Janet" } });

        const effective = parseStoredProposalEnvelope(edited.properties.proposal, card);
        expect(effective).toMatchObject({ properties: { name: "Acme" } });
        expect(effective && "operations" in effective ? effective.operations : null).toEqual([
          companyAndPerson[0],
          { ...companyAndPerson[1], properties: { name: "Janet" } },
        ]);
        expect(edited.properties.userEditedKeys).toEqual(["person.name"]);
        expect(edited.properties.userOverrides).toEqual({ person: { name: "Janet" } });
      });

      it("mirrors an edit of the primary step into the top-level properties", async () => {
        const card = await cardWithSteps(companyAndPerson);

        const edited = await edit(card, { company: { name: "Acme Corp" } });

        expect(edited.properties.proposal).toMatchObject({
          properties: { name: "Acme Corp" },
          operations: [{ ref: "company", properties: { name: "Acme Corp" } }, { ref: "person" }],
        });
        expect(edited.properties.userEditedKeys).toEqual(["company.name"]);
      });

      it.each([
        ["the ref 'primary' when no step has it, naming it", { primary: { name: "Typed" } }, "'primary'", undefined],
        [
          "a key of a step that the step's database does not have, naming the step and the key",
          { person: { colour: "red" } },
          undefined,
          { ref: "person", field: "colour" },
        ],
      ])("refuses %s", async (_label, set, message, details) => {
        const card = await cardWithSteps(companyAndPerson);

        const error = await expectRefusedUnchanged(card, () => edit(card, set));

        expect(error).toBeInstanceOf(ValidationError);
        if (message) expect((error as Error).message).toContain(message);
        if (details) expect(error).toHaveProperty("details", details);
      });

      describe("a step the proposal does not carry out", () => {
        const mcpStep = (extra: Partial<Step>): Step => ({
          ref: "server",
          op: "create",
          databaseKey: "mcpServers",
          role: "secondary",
          properties: { name: "Remote tool" },
          ...extra,
        });
        const skipped: Array<[string, Partial<Step>]> = [
          ["a disabled step", { enabled: false }],
          ["an optional step that no active step refers to", { optional: true }],
        ];

        it.each(skipped)(
          "refuses a credential typed into %s, naming its ref, and writes nothing",
          async (_label, extra) => {
            const card = await cardWithSteps([companyAndPerson[0]!, mcpStep(extra)]);

            const error = await expectRefusedUnchanged(card, () => edit(card, { server: { authToken: "secret" } }));

            expect(error).toBeInstanceOf(ValidationError);
            expect(error).toHaveProperty("details", { ref: "server", field: "server" });
            const stored = await readCard(card);
            expect(JSON.stringify(stored.properties)).not.toContain("secret");
          },
        );

        it.each(skipped)("refuses an unknown key typed into %s and writes nothing", async (_label, extra) => {
          const card = await cardWithSteps([companyAndPerson[0]!, mcpStep(extra)]);

          const error = await expectRefusedUnchanged(card, () => edit(card, { server: { colour: "red" } }));

          expect(error).toBeInstanceOf(ValidationError);
          expect((error as Error).message).toContain("'server'");
        });

        it("refuses the skipped step even when the same request also edits an active one, and writes nothing", async () => {
          const card = await cardWithSteps([companyAndPerson[0]!, mcpStep({ enabled: false })]);

          const error = await expectRefusedUnchanged(card, () =>
            edit(card, { company: { name: "Acme Corp" }, server: { name: "Renamed" } }),
          );

          expect(error).toBeInstanceOf(ValidationError);
        });

        it("still refuses a credential typed into the same step while it is active", async () => {
          const card = await cardWithSteps([companyAndPerson[0]!, mcpStep({})]);

          const error = await expectRefusedUnchanged(card, () => edit(card, { server: { authToken: "secret" } }));

          expect(error).toBeInstanceOf(ValidationError);
          expect(error).toHaveProperty("details.ref", "server");
        });
      });

      it("confirms every step with the typed values", async () => {
        const card = await cardWithSteps(companyAndPerson);
        await edit(card, { person: { name: "Janet" }, company: { name: "Acme Corp" } });

        const confirmed = await confirmCard(card);

        expect(confirmed.properties.resultLabel).toBe("Acme Corp");
        const people = await pool.query<{ name: string }>(
          "SELECT properties->>'name' AS name FROM items WHERE database_id = $1",
          [await databaseIdFor("people")],
        );
        expect(people.rows).toEqual([{ name: "Janet" }]);
      });
    });

    describe("a page content card", () => {
      it("replaces a field the assistant's envelope holds, and refuses one it does not hold, naming it", async () => {
        const { proposal } = await createPageContentProposal("A thought");

        const error = await expectRefusedUnchanged(proposal.id, () =>
          edit(proposal.id, { primary: { colour: "red" } }),
        );
        const edited = await edit(proposal.id, { primary: { flavour: "heading" } });

        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toHaveProperty("details", { ref: "primary", field: "colour" });
        expect(edited.properties.proposal).toMatchObject({ properties: { flavour: "heading" } });
        expect(edited.properties.userEditedKeys).toEqual(["primary.flavour"]);
      });
    });

    it("refuses a card with an entityKind this release does not know", async () => {
      const card = await storeCard({ entityKind: "futureKind", target: tasksId, properties: { name: "x" } });

      const error = await expectRefusedUnchanged(card, () => edit(card, { primary: { name: "Typed" } }));

      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toHaveProperty("details.entityKind", "futureKind");
    });

    it("waits for a concurrent confirm that holds the card's row lock, then refuses the confirmed card", async () => {
      const card = await createDatabaseProposal("Send the invoice");

      const [holder, contender] = await runPreconditionOverlap(
        (client) => confirmProposalWithClient(client, config(), card.id),
        (client) => updateProposalValuesWithClient(client, config(), card.id, { set: { primary: { name: "Late" } } }),
        (pid, observer) => assertItemHeld(card.id, pid, observer),
        ([confirmOutcome, editOutcome]) => {
          expect(confirmOutcome.status).toBe("fulfilled");
          expect(editOutcome.status).toBe("rejected");
          if (editOutcome.status === "rejected") expect(editOutcome.reason).toBeInstanceOf(ValidationError);
        },
      );

      expect(holder.status).toBe("fulfilled");
      expect(contender.status).toBe("rejected");
      const after = await readCard(card.id);
      expect(after.properties.status).toBe("confirmed");
      expect(after.properties.userEditedKeys).toBeUndefined();
    });

    describe("revising a card that has manual values (issue #1924)", () => {
      const revise = (
        cardId: string,
        input: Omit<Extract<Parameters<typeof reviseProposalWithClient>[3], { target: string }>, "message">,
      ) =>
        withTransaction(pool, (client) =>
          reviseProposalWithClient(client, config(), cardId, { message: "Chat correction", ...input }),
        );
      /** Overrides no edit can produce (a key the target database lacks), as left by a removed property. */
      const storeOverrides = (cardId: string, overrides: Record<string, Record<string, unknown>>, keys: string[]) =>
        setStatus(cardId, { userOverrides: overrides, userEditedKeys: keys });

      it("clears the overrides and adds a reset entry when the card is revised to another destination", async () => {
        const card = await createDatabaseProposal("Send the invoice");
        await edit(card.id, { primary: { name: "Poslat fakturu Alze" } });
        const eventsId = await databaseIdFor("events");

        const revised = await revise(card.id, {
          entityKind: "database",
          target: eventsId,
          properties: { name: "Invoice meeting" },
        });

        expect(revised.properties.userOverrides).toEqual({});
        expect(revised.properties.userEditedKeys).toEqual([]);
        expect(revised.properties.proposal).toEqual({
          entityKind: "database",
          target: eventsId,
          properties: { name: "Invoice meeting" },
        });
        const history = historyOf(revised);
        expect(history.map((entry) => entry.kind)).toEqual([undefined, "userEdit", undefined, "reset"]);
        expect(history[2]).toMatchObject({ author: "user", message: "Chat correction" });
        expect(history[3]).toMatchObject({ author: "user", keys: ["primary.name"] });
        expect(history[3]!.message).toContain("destination changed");
        expect(history[3]!.message).toContain("primary.name");
      });

      it("clears the overrides when only the entityKind changes", async () => {
        const { proposal } = await createPageContentProposal("A thought");
        await edit(proposal.id, { primary: { flavour: "heading" } });

        const revised = await revise(proposal.id, {
          entityKind: "database",
          target: tasksId,
          properties: { name: "A thought" },
        });

        expect(revised.properties.userOverrides).toEqual({});
        expect(revised.properties.userEditedKeys).toEqual([]);
        expect(historyOf(revised).at(-1)).toMatchObject({ kind: "reset", keys: ["primary.flavour"] });
      });

      it("keeps only the override whose key is a property of the same target and reports the other as dropped", async () => {
        const card = await createDatabaseProposal("Send the invoice");
        await storeOverrides(card.id, { primary: { name: "Typed", colour: "red" } }, [
          "primary.colour",
          "primary.name",
        ]);

        const revised = await revise(card.id, {
          entityKind: "database",
          target: tasksId,
          properties: { name: "Send the invoice today" },
        });

        expect(revised.properties.userOverrides).toEqual({ primary: { name: "Typed" } });
        expect(revised.properties.userEditedKeys).toEqual(["primary.name"]);
        const history = historyOf(revised);
        expect(history.at(-1)).toMatchObject({ kind: "reset", keys: ["primary.colour"] });
        expect(history.at(-1)!.message).toContain("do not fit the new proposal");
        expect(history.at(-1)!.message).toContain("primary.colour");
        expect(revised.properties.proposal).toEqual({
          entityKind: "database",
          target: tasksId,
          properties: { name: "Typed" },
        });
        expect(revised.properties.aiProposal).toEqual(taskEnvelope("Send the invoice today"));
        expect(history.at(-2)).toMatchObject({ message: "Chat correction" });
      });

      it("keeps the overrides of the same target and adds no reset entry when every key is still a property", async () => {
        const card = await createDatabaseProposal("Send the invoice");
        await edit(card.id, { primary: { name: "Poslat fakturu Alze", flagged: true } });

        const revised = await revise(card.id, {
          entityKind: "database",
          target: tasksId,
          properties: { name: "Send the invoice today" },
        });

        expect(revised.properties.userOverrides).toEqual({ primary: { name: "Poslat fakturu Alze", flagged: true } });
        expect(revised.properties.userEditedKeys).toEqual(["primary.flagged", "primary.name"]);
        expect(historyOf(revised).map((entry) => entry.kind)).toEqual([undefined, "userEdit", undefined]);
      });

      it("stores the kept values in the effective proposal, so a confirm and a later edit of another key keep them", async () => {
        const card = await createDatabaseProposal("Send the invoice");
        await edit(card.id, { primary: { name: "Poslat fakturu Alze", flagged: true } });

        const revised = await revise(card.id, {
          entityKind: "database",
          target: tasksId,
          properties: { name: "Send the invoice today" },
        });

        expect(revised.properties.aiProposal).toEqual(taskEnvelope("Send the invoice today"));
        expect(revised.properties.proposal).toEqual({
          ...taskEnvelope("Poslat fakturu Alze"),
          properties: { name: "Poslat fakturu Alze", flagged: true },
        });

        const edited = await edit(card.id, { primary: { flagged: false } });
        expect(edited.properties.proposal).toMatchObject({ properties: { name: "Poslat fakturu Alze" } });

        const confirmed = await withTransaction(pool, (client) => confirmProposalWithClient(client, config(), card.id));
        expect(confirmed.properties.resultLabel).toBe("Poslat fakturu Alze");
      });

      it("adds no reset entry for a card with nothing edited, even when the destination changes", async () => {
        const card = await createDatabaseProposal("Send the invoice");
        const sameTarget = await revise(card.id, {
          entityKind: "database",
          target: tasksId,
          properties: { name: "Send the invoice today" },
        });
        expect(sameTarget.properties.userOverrides).toEqual({});
        expect(sameTarget.properties.userEditedKeys).toEqual([]);
        expect(historyOf(sameTarget).map((entry) => entry.kind)).toEqual([undefined, undefined]);

        const otherTarget = await revise(card.id, {
          entityKind: "database",
          target: await databaseIdFor("events"),
          properties: { name: "Invoice meeting" },
        });
        expect(otherTarget.properties.userEditedKeys).toEqual([]);
        expect(historyOf(otherTarget).map((entry) => entry.kind)).toEqual([undefined, undefined, undefined]);
      });

      it("does not count a kept value that now equals the new assistant value, and reports nothing dropped", async () => {
        const card = await createDatabaseProposal("Send the invoice");
        await edit(card.id, { primary: { name: "Poslat fakturu Alze" } });

        const revised = await revise(card.id, {
          entityKind: "database",
          target: tasksId,
          properties: { name: "Poslat fakturu Alze" },
        });

        expect(revised.properties.userOverrides).toEqual({});
        expect(revised.properties.userEditedKeys).toEqual([]);
        expect(historyOf(revised).map((entry) => entry.kind)).toEqual([undefined, "userEdit", undefined]);
      });

      it("matches a pageContent revise against the keys of the new envelope's properties", async () => {
        const { proposal, targetPageId } = await createPageContentProposal("A thought");
        await edit(proposal.id, { primary: { flavour: "heading" } });
        await storeOverrides(proposal.id, { primary: { flavour: "heading", fields: { content: "typed" } } }, [
          "primary.fields",
          "primary.flavour",
        ]);

        const revised = await revise(proposal.id, {
          entityKind: "pageContent",
          target: targetPageId,
          properties: { flavour: "paragraph" },
        });

        expect(revised.properties.userOverrides).toEqual({ primary: { flavour: "heading" } });
        expect(revised.properties.userEditedKeys).toEqual(["primary.flavour"]);
        expect(historyOf(revised).at(-1)).toMatchObject({ kind: "reset", keys: ["primary.fields"] });
        expect(revised.properties.proposal).toMatchObject({ properties: { flavour: "heading" } });
        expect(revised.properties.aiProposal).toMatchObject({ properties: { flavour: "paragraph" } });
      });

      it("drops the overrides of the steps of a multi-step card that a single-step revise no longer has", async () => {
        const card = await cardWithSteps(companyAndPerson);
        await edit(card, { company: { name: "Acme Corp" }, person: { name: "Janet" } });

        const revised = await revise(card, {
          entityKind: "database",
          target: await databaseIdFor("companies"),
          properties: { name: "Acme Corp" },
        });

        expect(revised.properties.userOverrides).toEqual({});
        expect(revised.properties.userEditedKeys).toEqual([]);
        expect(historyOf(revised).at(-1)).toMatchObject({ kind: "reset", keys: ["company.name", "person.name"] });
        expect(historyOf(revised).at(-1)!.message).toContain("do not fit the new proposal");
        expect(historyOf(revised).at(-1)!.message).not.toContain("no such fields");
      });

      it("leaves a card with no previous envelope without overrides and without a reset entry", async () => {
        const { card } = await untypedCard("Something without a type");

        const revised = await revise(card.id, {
          entityKind: "database",
          target: tasksId,
          properties: { name: "Chosen" },
        });

        expect(revised.properties.userOverrides).toEqual({});
        expect(revised.properties.userEditedKeys).toEqual([]);
        expect(historyOf(revised).filter((entry) => entry.kind === "reset")).toEqual([]);
      });

      it("still revises a card whose stored envelope is malformed, and reports no reset", async () => {
        const card = await createDatabaseProposal("Send the invoice");
        // A stored envelope no writer produces; the revise is how such a card is repaired.
        await setStatus(card.id, { proposal: { broken: true }, aiProposal: null });

        const revised = await revise(card.id, {
          entityKind: "database",
          target: tasksId,
          properties: { name: "Repaired" },
        });

        expect(revised.properties.proposal).toEqual(taskEnvelope("Repaired"));
        expect(revised.properties.userEditedKeys).toEqual([]);
        expect(historyOf(revised).filter((entry) => entry.kind === "reset")).toEqual([]);
      });

      it("leaves the overrides and the history untouched when the envelope validation refuses the revise", async () => {
        const card = await createDatabaseProposal("Send the invoice");
        await edit(card.id, { primary: { name: "Poslat fakturu Alze" } });

        const eventsId = await databaseIdFor("events");
        const error = await expectRefusedUnchanged(card.id, () =>
          revise(card.id, { entityKind: "database", target: eventsId, properties: { colour: "red" } }),
        );

        expect(error).toBeInstanceOf(ValidationError);
        expect((await readCard(card.id)).properties.userEditedKeys).toEqual(["primary.name"]);
      });
    });

    describe("revising from an item thread (issue #1938)", () => {
      const thread = { threadId: randomUUID(), messageId: randomUUID() };
      const reviseFromThread = (
        cardId: string,
        subjectItemId: string,
        input: Omit<
          Parameters<typeof reviseProposalFromThreadWithClient>[2],
          "proposalId" | "subjectItemId" | "threadId" | "messageId"
        >,
      ) =>
        withTransaction(pool, (client) =>
          reviseProposalFromThreadWithClient(client, config(), {
            proposalId: cardId,
            subjectItemId,
            ...thread,
            ...input,
          }),
        );
      /** A card the user has edited: the title typed over the assistant's. */
      async function editedCard() {
        const card = await createDatabaseProposal("Send the invoice");
        await edit(card.id, { primary: { name: "Poslat fakturu Alze" } });
        return { cardId: card.id, sourceId: await sourceOf(card.id) };
      }
      const itemCounts = async () =>
        (
          await pool.query<{ database_id: string; count: number }>(
            "SELECT database_id, count(*)::int AS count FROM items WHERE database_id = ANY($1::uuid[]) GROUP BY database_id",
            [[tasksId, await databaseIdFor("events")]],
          )
        ).rows;

      it("turns a Task card into an Event proposal, records the thread and message, and creates nothing in a target database", async () => {
        const card = await createDatabaseProposal("Meet the accountant");
        const eventsId = await databaseIdFor("events");
        const before = await itemCounts();

        const revised = await reviseFromThread(card.id, await sourceOf(card.id), {
          entityKind: "database",
          target: eventsId,
          properties: { name: "Meet the accountant", type: "meeting", date: "2026-11-20" },
          message: "It is an event, not a task",
        });

        expect(revised.properties.proposal).toEqual({
          entityKind: "database",
          target: eventsId,
          properties: { name: "Meet the accountant", type: "meeting", date: "2026-11-20" },
        });
        expect(revised.properties.aiProposal).toEqual(revised.properties.proposal);
        expect(revised.properties.status).toBe("proposed");
        expect(historyOf(revised).at(-1)).toMatchObject({
          author: "ai",
          kind: "threadRevision",
          message: "It is an event, not a task",
          ...thread,
        });
        expect(await itemCounts()).toEqual(before);
      });

      it("increments aiVersion and keeps the destination of the card when the call names none", async () => {
        const card = await createDatabaseProposal("Send the invoice");
        const before = await readCard(card.id);

        const revised = await reviseFromThread(card.id, await sourceOf(card.id), {
          properties: { name: "Send the invoice today" },
        });

        expect(revised.properties.proposal).toEqual(taskEnvelope("Send the invoice today"));
        expect(revised.properties.aiVersion).toBe(Number(before.properties.aiVersion) + 1);
        expect(historyOf(revised).at(-1)).toMatchObject({ author: "ai", message: "Revised by assistant." });
      });

      it("stores the new value of an edited title as the user's and leaves it in userEditedKeys", async () => {
        const { cardId, sourceId } = await editedCard();

        const revised = await reviseFromThread(cardId, sourceId, { properties: { name: "Poslat fakturu Alze zítra" } });

        expect(revised.properties.proposal).toEqual(taskEnvelope("Poslat fakturu Alze zítra"));
        expect(revised.properties.userOverrides).toEqual({ primary: { name: "Poslat fakturu Alze zítra" } });
        expect(revised.properties.userEditedKeys).toEqual(["primary.name"]);
        // The assistant's own value stays, so the card still shows the title as the user's.
        expect(revised.properties.aiProposal).toEqual(taskEnvelope("Send the invoice"));
      });

      it("leaves an edited title that the instruction did not touch as it was and protected", async () => {
        const { cardId, sourceId } = await editedCard();

        const revised = await reviseFromThread(cardId, sourceId, {
          properties: { name: "Poslat fakturu Alze", description: "Due on Friday" },
        });

        expect(revised.properties.proposal).toEqual({
          ...taskEnvelope("Poslat fakturu Alze"),
          properties: { name: "Poslat fakturu Alze", description: "Due on Friday" },
        });
        expect(revised.properties.userOverrides).toEqual({ primary: { name: "Poslat fakturu Alze" } });
        expect(revised.properties.userEditedKeys).toEqual(["primary.name"]);
        expect(revised.properties.aiProposal).toEqual({
          ...taskEnvelope("Send the invoice"),
          properties: { name: "Send the invoice", description: "Due on Friday" },
        });
      });

      it("stops treating the title as edited when the instruction sets it back to the assistant's own value", async () => {
        const { cardId, sourceId } = await editedCard();

        const revised = await reviseFromThread(cardId, sourceId, { properties: { name: "Send the invoice" } });

        expect(revised.properties.userOverrides).toEqual({});
        expect(revised.properties.userEditedKeys).toEqual([]);
        expect(revised.properties.proposal).toEqual(taskEnvelope("Send the invoice"));
      });

      it("drops the manual values and adds a reset entry when the instruction changes the target database", async () => {
        const { cardId, sourceId } = await editedCard();
        const eventsId = await databaseIdFor("events");

        const revised = await reviseFromThread(cardId, sourceId, {
          entityKind: "database",
          target: eventsId,
          properties: { name: "Invoice meeting", type: "meeting", date: "2026-11-20" },
        });

        expect(revised.properties.userOverrides).toEqual({});
        expect(revised.properties.userEditedKeys).toEqual([]);
        expect(revised.properties.proposal).toMatchObject({
          target: eventsId,
          properties: { name: "Invoice meeting" },
        });
        const history = historyOf(revised);
        expect(history.at(-2)).toMatchObject({ author: "ai", kind: "threadRevision" });
        expect(history.at(-1)).toMatchObject({ kind: "reset", keys: ["primary.name"] });
      });

      it("keeps an edited key that the revised envelope leaves out, as it keeps one the instruction did not touch", async () => {
        const card = await createDatabaseProposal("Send the invoice");
        await edit(card.id, { primary: { description: "Typed note" } });

        const revised = await reviseFromThread(card.id, await sourceOf(card.id), {
          properties: { name: "Send the invoice, today" },
        });

        expect(revised.properties.userOverrides).toEqual({ primary: { description: "Typed note" } });
        expect(revised.properties.userEditedKeys).toEqual(["primary.description"]);
        expect(revised.properties.proposal).toEqual({
          ...taskEnvelope("Send the invoice, today"),
          properties: { name: "Send the invoice, today", description: "Typed note" },
        });
        expect(historyOf(revised).map((entry) => entry.kind)).not.toContain("reset");
      });

      it("refuses a revision whose ifVersion is not the card's current version, and writes nothing", async () => {
        const card = await createDatabaseProposal("Send the invoice");
        const sourceId = await sourceOf(card.id);
        const seen = (await readCard(card.id)).version;
        await edit(card.id, { primary: { name: "Poslat fakturu Alze" } });
        const before = await readCard(card.id);

        const stale = await reviseFromThread(card.id, sourceId, {
          properties: { name: "Send the invoice" },
          ifVersion: seen,
        }).catch((error: unknown) => error);

        expect(stale).toBeInstanceOf(ConflictError);
        expect(await readCard(card.id)).toEqual(before);

        const current = await reviseFromThread(card.id, sourceId, {
          properties: { name: "Poslat fakturu Alze" },
          ifVersion: before.version,
        });
        expect(current.properties.userOverrides).toEqual({ primary: { name: "Poslat fakturu Alze" } });
      });

      it("refuses a card whose source is another Inbox item exactly as it refuses a missing card, and writes nothing", async () => {
        const own = await createDatabaseProposal("Send the invoice");
        const other = await createDatabaseProposal("Buy milk");
        const ownSource = await sourceOf(own.id);
        const before = await readCard(other.id);
        const input = { properties: { name: "Changed from the other thread" } };

        const foreign = await reviseFromThread(other.id, ownSource, input).catch((error: unknown) => error);
        const missing = await reviseFromThread(randomUUID(), ownSource, input).catch((error: unknown) => error);

        expect(foreign).toBeInstanceOf(NotFoundError);
        expect(missing).toBeInstanceOf(NotFoundError);
        expect((foreign as NotFoundError).message).toBe(`Processing proposal ${other.id} not found`);
        expect((missing as NotFoundError).message).toMatch(/^Processing proposal .* not found$/);
        expect(await readCard(other.id)).toEqual(before);
      });

      it("refuses a subject that is not an Inbox item of the card, such as the card itself or a random id", async () => {
        const card = await createDatabaseProposal("Send the invoice");
        const before = await readCard(card.id);

        for (const subject of [card.id, randomUUID()]) {
          const error = await reviseFromThread(card.id, subject, { properties: { name: "x" } }).catch(
            (err: unknown) => err,
          );
          expect(error).toBeInstanceOf(NotFoundError);
        }
        expect(await readCard(card.id)).toEqual(before);
      });

      it.each(["confirmed", "rejected"] as const)("refuses a %s card and writes nothing", async (decision) => {
        const card = await createDatabaseProposal("Send the invoice");
        const sourceId = await sourceOf(card.id);
        await withTransaction(pool, (client) =>
          decision === "confirmed"
            ? confirmProposalWithClient(client, config(), card.id)
            : rejectProposalWithClient(client, config(), card.id),
        );
        const counts = await itemCounts();

        const error = await expectRefusedUnchanged(card.id, () =>
          reviseFromThread(card.id, sourceId, { properties: { name: "Too late" } }),
        );

        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toMatchObject({ details: { field: "status" } });
        expect(await itemCounts()).toEqual(counts);
      });

      it("refuses a card whose source Inbox item was deleted and writes nothing", async () => {
        const card = await createDatabaseProposal("Send the invoice");
        const sourceId = await sourceOf(card.id);
        await setStatus(card.id, {
          status: "invalid",
          invalidReason: { code: "sourceDeleted", field: "", itemId: sourceId, label: "Send the invoice" },
        });

        const error = await expectRefusedUnchanged(card.id, () =>
          reviseFromThread(card.id, sourceId, { properties: { name: "x" } }),
        );

        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toMatchObject({ details: { field: "status" } });
      });

      it("lets a fixable invalid card leave invalid with its reason cleared", async () => {
        const card = await createDatabaseProposal("Send the invoice");
        await setStatus(card.id, {
          status: "invalid",
          invalidReason: { code: "targetDeleted", field: "project", itemId: randomUUID(), label: "Project" },
        });

        const revised = await reviseFromThread(card.id, await sourceOf(card.id), { properties: { name: "Fixed" } });

        expect(revised.properties.status).toBe("proposed");
        expect(revised.properties.invalidReason).toBeNull();
      });

      it("refuses an invalid envelope without writing anything", async () => {
        const { cardId, sourceId } = await editedCard();

        const error = await expectRefusedUnchanged(cardId, () =>
          reviseFromThread(cardId, sourceId, { properties: { notAKey: "x" } }),
        );

        expect(error).toBeInstanceOf(ValidationError);
      });

      it("refuses a target that is not a writable database without writing anything", async () => {
        const card = await createDatabaseProposal("Send the invoice");
        const sourceId = await sourceOf(card.id);

        const error = await expectRefusedUnchanged(card.id, () =>
          reviseFromThread(card.id, sourceId, { entityKind: "database", target: inboxId, properties: {} }),
        );

        expect(error).toBeInstanceOf(ValidationError);
      });

      it("applies the credential guard of an MCP server card and writes nothing", async () => {
        const cardId = await storeCard({
          entityKind: "database",
          target: await databaseIdFor("mcpServers"),
          properties: { name: "Remote tool" },
        });
        const sourceId = await sourceOf(cardId);

        const error = await expectRefusedUnchanged(cardId, () =>
          reviseFromThread(cardId, sourceId, { properties: { name: "Remote tool", apiKey: "shh" } }),
        );
        const revised = await reviseFromThread(cardId, sourceId, { properties: { name: "Renamed tool" } });

        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toHaveProperty("details", { field: "apiKey" });
        expect(revised.properties.proposal).toMatchObject({ properties: { name: "Renamed tool" } });
      });

      describe("a card that has no proposal yet", () => {
        async function createClarificationCard() {
          const { card, sourceId } = await untypedCard();
          return { cardId: card.id, sourceId };
        }

        it("gives it its first envelope when the call names the whole destination", async () => {
          const { cardId, sourceId } = await createClarificationCard();

          const revised = await reviseFromThread(cardId, sourceId, {
            entityKind: "database",
            target: tasksId,
            properties: { name: "Buy milk" },
          });

          expect(revised.properties.status).toBe("proposed");
          expect(revised.properties.proposal).toEqual(taskEnvelope("Buy milk"));
          expect(revised.properties.aiProposal).toEqual(taskEnvelope("Buy milk"));
        });

        it.each([
          ["neither", {}, "entityKind"],
          ["no target", { entityKind: "database" as const }, "target"],
          ["no entity kind", { target: "tasks" }, "entityKind"],
        ])("refuses a call with %s, naming the missing field, and writes nothing", async (_label, named, field) => {
          const { cardId, sourceId } = await createClarificationCard();
          const target = "target" in named ? tasksId : undefined;

          const error = await expectRefusedUnchanged(cardId, () =>
            reviseFromThread(cardId, sourceId, {
              ...("entityKind" in named ? { entityKind: named.entityKind } : {}),
              ...(target === undefined ? {} : { target }),
              properties: { name: "Buy milk" },
            }),
          );

          expect(error).toBeInstanceOf(ValidationError);
          expect(error).toHaveProperty("details", { field });
        });
      });

      it("refuses a card whose stored envelope has a kind this release does not know", async () => {
        const card = await createDatabaseProposal("Send the invoice");
        const sourceId = await sourceOf(card.id);
        const unknown = { entityKind: "widget", target: tasksId, properties: {} };
        await setStatus(card.id, { proposal: unknown, aiProposal: unknown });

        const error = await expectRefusedUnchanged(card.id, () =>
          reviseFromThread(card.id, sourceId, { properties: { name: "x" } }),
        );

        expect(error).toBeInstanceOf(ConflictError);
        expect(error).toHaveProperty("details", { field: "entityKind", entityKind: "widget" });
      });

      it("waits for a removal of the card's source link that is still open, and then refuses the card", async () => {
        const card = await createDatabaseProposal("Send the invoice");
        const sourceId = await sourceOf(card.id);
        const before = await readCard(card.id);
        let release: () => void = () => {};
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let removed: () => void = () => {};
        const removalDone = new Promise<void>((resolve) => {
          removed = resolve;
        });
        const removal = withTransaction(pool, async (client) => {
          const property = await propertiesStore.getPropertyByKey(client, proposalsId, "sourceInbox");
          const deleted = await deleteRelationWithClient(
            client,
            { relationPropertyId: property!.id, callerItemId: card.id, targetItemId: sourceId },
            { ownerProcess: "processingProposals" },
          );
          expect(deleted).not.toBeNull();
          removed();
          await released;
        });
        await removalDone;

        const attempt = reviseFromThread(card.id, sourceId, { properties: { name: "Late" } }).catch(
          (error: unknown) => error,
        );
        // The call waits on the edge row that the open removal holds, in the statement that reads it.
        const deadline = Date.now() + 10_000;
        let waiting = false;
        while (!waiting && Date.now() < deadline) {
          const activity = await pool.query<{ waiting: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM pg_stat_activity
                WHERE wait_event_type = 'Lock' AND query LIKE 'SELECT id FROM item_relations%' AND pid <> pg_backend_pid()
             ) AS waiting`,
          );
          waiting = activity.rows[0]?.waiting === true;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        release();
        await removal;

        expect(waiting).toBe(true);
        expect(await attempt).toBeInstanceOf(NotFoundError);
        expect(await readCard(card.id)).toEqual(before);
      });
    });

    describe("the editor schema's rules (issue #1928)", () => {
      const taskCard = (properties: Record<string, unknown>) =>
        storeCard({ entityKind: "database", target: tasksId, properties });
      async function fileCard(withFile: boolean): Promise<string> {
        const properties = withFile
          ? { name: "Scan", file: await withTransaction(pool, (client) => newFileValue(client)) }
          : { name: "Scan" };
        return storeCard({ entityKind: "database", target: await databaseIdFor("files"), properties });
      }
      /** A card whose destination no module maps to a card kind, so it has no editor schema. */
      const clarifyCard = async (properties: Record<string, unknown> = { name: "Remote tool" }) =>
        storeCard({ entityKind: "database", target: await databaseIdFor("mcpServers"), properties });
      const confirmsAs = async (cardId: string, status = "confirmed") =>
        expect((await confirmCard(cardId)).properties.status).toBe(status);
      const nameless = { ...companyAndPerson[0]!, properties: { name: "" } };

      describe("confirm", () => {
        it.each([
          ["has no name", {}],
          ["has an empty name", { name: "" }],
          ["has a whitespace-only name", { name: "  \t " }],
        ])("refuses a task that %s, naming the field, and creates no item", async (_label, properties) => {
          const card = await taskCard(properties);
          const tasksBefore = await countIn("tasks");

          const error = await expectRefusedUnchanged(card, () => confirmCard(card));

          expect(error).toBeInstanceOf(ValidationError);
          expect((error as Error).message).toBe("Required field 'name' has no value");
          expect(error).toHaveProperty("details", { field: "name" });
          expect(await countIn("tasks")).toBe(tasksBefore);
          expect((await readCard(card)).properties.status).toBe("proposed");
        });

        it("refuses a card whose name was cleared by an edit, which the edit saved, and confirms a task whose name is set", async () => {
          const card = await taskCard({ name: "Send the invoice" });
          await edit(card, { primary: { name: "" } });

          const error = await expectRefusedUnchanged(card, () => confirmCard(card));
          expect(error).toHaveProperty("details", { field: "name" });

          await edit(card, { primary: { name: "Send the invoice" } });
          await confirmsAs(card);
        });

        it("fails on stored userOverrides that are malformed, as a server error and not as a validation error", async () => {
          const card = await taskCard({ name: "Send the invoice" });
          await storeProps(card, { userOverrides: "not an object" });

          const error = await expectRefusedUnchanged(card, () => confirmCard(card));

          expect(error).not.toBeInstanceOf(ValidationError);
          expect((error as Error).message).toContain("Malformed userOverrides");
        });

        it("refuses a file card without a file and confirms it once the file is there, also with its follow-up switched off", async () => {
          const missing = await fileCard(false);
          const error = await expectRefusedUnchanged(missing, () => confirmCard(missing));
          expect(error).toHaveProperty("details", { field: "file" });

          await confirmsAs(await fileCard(true));
          const switchedOff = await fileCard(true);
          await edit(switchedOff, { primary: { followupTask: false } });
          await confirmsAs(switchedOff);
        });

        it("requires the follow-up date only once the follow-up task is switched on, and confirms when it is set", async () => {
          await confirmsAs(await taskCard({ name: "Never touched" }));
          const card = await taskCard({ name: "Send the invoice" });
          await edit(card, { primary: { followupTask: true } });

          const error = await expectRefusedUnchanged(card, () => confirmCard(card));
          expect(error).toHaveProperty("details", { field: "followDate" });

          await edit(card, { primary: { followDate: "2026-12-01" } });
          await confirmsAs(card);
        });

        it("names the step and the field of a multi-step card that lacks a required value, whether its other step is on, off or switched back on", async () => {
          const cards = [
            await cardWithSteps([nameless, companyAndPerson[1]!]),
            await cardWithSteps([nameless, { ...companyAndPerson[1]!, enabled: false }]),
          ];
          const switchedOn = await cardWithSteps([nameless, { ...companyAndPerson[1]!, enabled: false }]);
          await withTransaction(pool, (client) =>
            updateProposalValuesWithClient(client, config(), switchedOn, { steps: { person: { enabled: true } } }),
          );

          for (const card of [...cards, switchedOn]) {
            const error = await expectRefusedUnchanged(card, () => confirmCard(card));
            expect(error).toHaveProperty("details", { ref: "company", field: "name" });
          }
        });

        it("does not check a clarify card", async () => {
          const card = await clarifyCard({
            name: "Remote tool",
            active: false,
            connectionConfig: { transport: "http", url: "https://mcp.example.com/mcp" },
          });

          await confirmsAs(card);
        });
      });

      describe("pseudo fields", () => {
        it("stores a pseudo field in userOverrides, keeps it out of the envelope, counts it as edited and keeps it beside a later edit", async () => {
          const card = await taskCard({ name: "Send the invoice" });

          const edited = await edit(card, { primary: { allDay: true } });

          expect(edited.properties.userOverrides).toEqual({ primary: { allDay: true } });
          expect(edited.properties.userEditedKeys).toEqual(["primary.allDay"]);
          expect(edited.properties.proposal).toEqual(taskEnvelope("Send the invoice"));

          const second = await edit(card, { primary: { name: "Send it" } });

          expect(second.properties.userOverrides).toEqual({ primary: { allDay: true, name: "Send it" } });
          expect(second.properties.userEditedKeys).toEqual(["primary.allDay", "primary.name"]);
        });

        it("never writes a pseudo field to the item a confirm creates", async () => {
          const card = await taskCard({ name: "Send the invoice" });
          await edit(card, { primary: { allDay: true, followupTask: false } });

          const confirmed = await confirmCard(card);

          const itemId = z.string().parse(confirmed.properties.resultItemId);
          const created = await withTransaction(pool, (client) => itemsStore.getItemById(client, tasksId, itemId));
          expect(created?.properties).toMatchObject({ name: "Send the invoice" });
          expect(created?.properties).not.toHaveProperty("allDay");
          expect(created?.properties).not.toHaveProperty("followupTask");
        });

        it.each([
          [
            "a key of another card's schema as an unknown property",
            () => cardWithSteps(companyAndPerson),
            "company",
            { ref: "company", field: "allDay" },
            "allDay",
          ],
          ["a pseudo key on a clarify card", () => clarifyCard(), "primary", { field: "followupTask" }, "followupTask"],
        ] as const)("refuses %s, and writes nothing", async (_label, create, ref, details, key) => {
          const card = await create();

          const error = await expectRefusedUnchanged(card, () => edit(card, { [ref]: { [key]: true } }));

          expect(error).toBeInstanceOf(ValidationError);
          expect(error).toHaveProperty("details", details);
        });
      });

      describe("hidden fields", () => {
        it("stops counting an edited follow-up date once the follow-up task is switched off, and counts it again when it is back on", async () => {
          const card = await taskCard({ name: "Send the invoice" });
          const on = await edit(card, { primary: { followupTask: true, followDate: "2026-12-01" } });
          expect(on.properties.userEditedKeys).toEqual(["primary.followDate", "primary.followupTask"]);

          const off = await edit(card, { primary: { followupTask: false } });
          expect(off.properties.userEditedKeys).toEqual(["primary.followupTask"]);
          expect(off.properties.userOverrides).toEqual({ primary: { followupTask: false, followDate: "2026-12-01" } });

          const back = await edit(card, { primary: { followupTask: true } });
          expect(back.properties.userEditedKeys).toEqual(["primary.followDate", "primary.followupTask"]);
        });

        it("counts every edited key of a clarify card", async () => {
          const card = await clarifyCard();

          const edited = await edit(card, { primary: { name: "Renamed tool" } });

          expect(edited.properties.userEditedKeys).toEqual(["primary.name"]);
        });
      });

      describe("warnings", () => {
        it("saves a card whose required name was cleared and answers a required warning for it", async () => {
          const card = await taskCard({ name: "Send the invoice" });

          const { item, warnings } = await editWithWarnings(card, { primary: { name: "" } });

          expect(warnings).toEqual([{ field: "name", code: "required" }]);
          expect(item.properties.proposal).toEqual(taskEnvelope(""));
          expect(item.properties.userOverrides).toEqual({ primary: { name: "" } });
          expect(item.properties.userEditedKeys).toEqual(["primary.name"]);
          expect(item.properties.status).toBe("proposed");
        });

        it("warns about the follow-up date when the follow-up task is on, and not when it is set, off or the card is complete", async () => {
          const card = await taskCard({ name: "Send the invoice" });

          expect((await editWithWarnings(card, { primary: { name: "Send it" } })).warnings).toEqual([]);
          expect((await editWithWarnings(card, { primary: { followupTask: false } })).warnings).toEqual([]);
          expect((await editWithWarnings(card, { primary: { followupTask: true } })).warnings).toEqual([
            { field: "followDate", code: "required" },
          ]);
          expect((await editWithWarnings(card, { primary: { followDate: "2026-12-01" } })).warnings).toEqual([]);
        });

        it("names the step of a multi-step card in the warning, also when its other step is switched off", async () => {
          for (const steps of [companyAndPerson, [companyAndPerson[0]!, { ...companyAndPerson[1]!, enabled: false }]]) {
            const card = await cardWithSteps(steps);

            const { warnings } = await editWithWarnings(card, { company: { name: " " } });

            expect(warnings).toEqual([{ ref: "company", field: "name", code: "required" }]);
          }
        });

        it("refuses a card whose stored target is not an id with a validation error naming the target", async () => {
          const card = await storeCard({
            entityKind: "database",
            target: "not-an-id",
            properties: { name: "Send the invoice" },
          });

          const error = await expectRefusedUnchanged(card, () => edit(card, { primary: { name: "Send it" } }));

          expect(error).toBeInstanceOf(ValidationError);
          expect(error).toHaveProperty("details", { field: "target" });
        });

        it("answers no warning for a clarify card", async () => {
          const { warnings } = await editWithWarnings(await clarifyCard(), { primary: { name: "" } });

          expect(warnings).toEqual([]);
        });
      });
    });
    describe("what confirm writes is what the editor shows (issue #1934)", () => {
      const cardFor = async (moduleId: string, properties: Record<string, unknown>): Promise<string> =>
        storeCard({ entityKind: "database", target: await databaseIdFor(moduleId), properties });
      async function confirmedItem(cardId: string, moduleId: string): Promise<ItemRow> {
        const confirmed = await confirmCard(cardId);
        const itemId = z.string().parse(confirmed.properties.resultItemId);
        const databaseId = await databaseIdFor(moduleId);
        const created = await withTransaction(pool, (client) => itemsStore.getItemById(client, databaseId, itemId));
        if (!created) throw new Error(`created item ${itemId} not found`);
        return created;
      }
      const TIMES = { timeFrom: "09:00", timeTo: "10:00" };
      const NO_TIMES = ["timeFrom", "timeTo", "time"];

      it.each([
        [
          "a task",
          "stores empty times when the card is all-day, though the envelope carried them",
          "tasks",
          { date: "2026-12-01", ...TIMES },
          true,
          { date: "2026-12-01" },
          NO_TIMES,
        ],
        [
          "a task",
          "stores the calendar date when the card is all-day and its date carries a time of day",
          "tasks",
          { date: "2026-12-01T10:00" },
          true,
          { date: "2026-12-01" },
          ["timeFrom", "timeTo"],
        ],
        [
          "a task",
          "stores the times when the card is not all-day",
          "tasks",
          { date: "2026-12-01", ...TIMES },
          false,
          { ...TIMES, date: "2026-12-01" },
          [],
        ],
        [
          "a task",
          "stores the times when allDay was never set",
          "tasks",
          { date: "2026-12-01", ...TIMES },
          undefined,
          TIMES,
          [],
        ],
        [
          "an event",
          "stores null times when the card is all-day, though the envelope carried them",
          "events",
          { date: "2026-12-01", ...TIMES },
          true,
          { date: "2026-12-01", timeFrom: null, timeTo: null },
          [],
        ],
        [
          "an event",
          "stores null times for an all-day card whose envelope carried none",
          "events",
          { date: "2026-12-01" },
          true,
          { timeFrom: null, timeTo: null },
          [],
        ],
        [
          "an event",
          "stores the calendar date and null times when the card is all-day and its date carries a wall-clock time",
          "events",
          { date: "2026-12-01T10:00" },
          true,
          { date: "2026-12-01", timeFrom: null, timeTo: null },
          ["time"],
        ],
        // 23:30 UTC is 00:30 the next day in the default tenant zone, Europe/Prague.
        [
          "an event",
          "stores the date in the tenant zone and null times when the card is all-day and its date is an instant",
          "events",
          { date: "2026-12-01T23:30:00Z", ...TIMES },
          true,
          { date: "2026-12-02", timeFrom: null, timeTo: null },
          ["time"],
        ],
        [
          "an event",
          "stores the time of day of the date when the card is not all-day",
          "events",
          { date: "2026-12-01T10:00" },
          false,
          { date: "2026-12-01", timeFrom: "10:00", timeTo: "11:00" },
          [],
        ],
        [
          "an event",
          "stores the times when the card is not all-day",
          "events",
          { date: "2026-12-01", ...TIMES },
          false,
          TIMES,
          [],
        ],
        [
          "an event",
          "stores no times when it was never marked all-day and has none",
          "events",
          { date: "2026-12-01" },
          undefined,
          {},
          ["timeFrom"],
        ],
      ] as const)("%s %s", async (_kind, _label, moduleId, properties, allDay, expected, absent) => {
        const card = await cardFor(moduleId, { name: "Call", ...properties });
        if (allDay !== undefined) await edit(card, { primary: { allDay } });

        const item = await confirmedItem(card, moduleId);

        expect(item.properties).toMatchObject({ name: "Call", ...expected });
        for (const key of absent) expect(item.properties[key] ?? null, key).toBeNull();
      });

      it("stores the same properties for an all-day task whose envelope carried no times as for a task without allDay", async () => {
        const plain = await cardFor("tasks", { name: "Call", date: "2026-12-01" });
        const allDay = await cardFor("tasks", { name: "Call", date: "2026-12-01" });
        await edit(allDay, { primary: { allDay: true } });

        const plainTask = await confirmedItem(plain, "tasks");
        const allDayTask = await confirmedItem(allDay, "tasks");

        expect(Object.keys(allDayTask.properties).sort()).toEqual(Object.keys(plainTask.properties).sort());
        expect(allDayTask.properties).toEqual({ ...plainTask.properties });
      });

      it("drops the times of the primary step of a multi-step task card and leaves another step alone", async () => {
        const operations: Step[] = [
          {
            ref: "task",
            op: "create",
            databaseKey: "tasks",
            role: "primary",
            properties: { name: "Call", date: "2026-12-01", ...TIMES },
          },
          {
            ref: "followup",
            op: "create",
            databaseKey: "tasks",
            role: "secondary",
            properties: { name: "Follow up", date: "2026-12-01", ...TIMES },
          },
        ];
        const card = await storeCard({
          entityKind: "database",
          target: tasksId,
          properties: operations[0]!.properties,
          operations,
        });
        await edit(card, { task: { allDay: true } });

        const confirmed = await confirmCard(card);

        const created = z.array(z.object({ ref: z.string(), itemId: z.string() })).parse(confirmed.properties.results);
        const byRef = Object.fromEntries(created.map((result) => [result.ref, result.itemId]));
        const read = (ref: string) =>
          withTransaction(pool, (client) => itemsStore.getItemById(client, tasksId, byRef[ref]!));
        expect((await read("task"))?.properties.timeFrom ?? null).toBeNull();
        expect((await read("task"))?.properties.timeTo ?? null).toBeNull();
        expect((await read("followup"))?.properties).toMatchObject(TIMES);
      });

      it.each([
        ["stores no date when its status is longTerm", { status: "longTerm" }, undefined, null],
        ["stores no date once an edit made the status longTerm", { status: "inProgress" }, "longTerm", null],
        ["stores the date for any other status", { status: "inProgress" }, undefined, "2026-12-31"],
        ["stores the date of a project that has no status, which shows its date", {}, undefined, "2026-12-31"],
      ] as const)("a project %s", async (_label, properties, editedStatus, date) => {
        const card = await cardFor("projects", { name: "Garden", date: "2026-12-31", ...properties });
        if (editedStatus) await edit(card, { primary: { status: editedStatus } });

        const project = await confirmedItem(card, "projects");

        expect(project.properties).toMatchObject({
          name: "Garden",
          ...properties,
          ...(editedStatus ? { status: editedStatus } : {}),
        });
        expect(project.properties.date ?? null).toBe(date);
      });

      it("leaves a card with no editor schema as it is", async () => {
        const card = await cardFor("mcpServers", { name: "Remote tool", active: false });

        const server = await confirmedItem(card, "mcpServers");

        expect(server.properties).toEqual({ name: "Remote tool", active: false });
      });

      it.each([
        // Raw write: the API refuses a proposal holding a stdio connection.
        ["a stdio MCP server card with a validation error on transport", "mcpServers", "transport"],
        ["a connectionConfig on another destination through the envelope validation", "tasks", "connectionConfig"],
      ])("refuses %s, and writes nothing", async (_label, moduleId, field) => {
        const card = await cardFor(moduleId, {
          name: "Local tool",
          connectionConfig: { transport: "stdio", command: "my-mcp-server" },
        });
        const itemsBefore = await countIn(moduleId);

        const error = await expectRefusedUnchanged(card, () => confirmCard(card));

        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toHaveProperty("details", { field });
        expect(await countIn(moduleId)).toBe(itemsBefore);
      });
    });
    describe("relation lists and step switches (issue #1920)", () => {
      const editParts = async (
        cardId: string,
        parts: Pick<Parameters<typeof updateProposalValuesWithClient>[3], "set" | "relations" | "steps">,
      ): Promise<ItemRow> =>
        (await withTransaction(pool, (client) => updateProposalValuesWithClient(client, config(), cardId, parts))).item;
      const followupTask: Step = {
        ref: "followup",
        op: "create",
        databaseKey: "tasks",
        role: "secondary",
        properties: { name: "Follow up" },
      };
      const companyWithFollowup = async (extra: Partial<Step> = {}): Promise<string> =>
        storeCard({
          entityKind: "database",
          target: await databaseIdFor("companies"),
          properties: { name: "Acme" },
          operations: [
            { ref: "company", op: "create", databaseKey: "companies", role: "primary", properties: { name: "Acme" } },
            { ...followupTask, ...extra },
          ],
        });
      const effectiveSteps = (card: ItemRow): Step[] => {
        const envelope = parseStoredProposalEnvelope(card.properties.proposal, card.id);
        return envelope && "operations" in envelope ? (envelope.operations ?? []) : [];
      };
      const switchFollowup = (cardId: string, enabled: boolean) =>
        editParts(cardId, { steps: { followup: { enabled } } });

      describe("step switches", () => {
        it("switches a step off: the effective envelope drops it, the key is counted, and confirm does not run it", async () => {
          const card = await companyWithFollowup();

          const edited = await switchFollowup(card, false);

          expect(edited.properties.userEditedKeys).toEqual(["followup.enabled"]);
          expect(edited.properties.userOverrides).toEqual({ followup: { enabled: false } });
          expect(effectiveSteps(edited).find((step) => step.ref === "followup")?.enabled).toBe(false);
          expect(historyOf(edited).at(-1)).toMatchObject({
            author: "user",
            kind: "userEdit",
            keys: ["followup.enabled"],
          });
          await confirmCard(card);
          expect(await countIn("companies")).toBe(1);
          expect(await countIn("tasks")).toBe(0);
        });

        it("runs the step on confirm when it was never switched off", async () => {
          await confirmCard(await companyWithFollowup());

          expect(await countIn("tasks")).toBe(1);
        });

        it("drops the key and the override again when the step is switched back on", async () => {
          const card = await companyWithFollowup();
          await switchFollowup(card, false);

          const back = await switchFollowup(card, true);

          expect(back.properties.userEditedKeys).toEqual([]);
          expect(back.properties.userOverrides).toEqual({});
          expect(effectiveSteps(back).find((step) => step.ref === "followup")).toEqual(followupTask);
          await confirmCard(card);
          expect(await countIn("tasks")).toBe(1);
        });

        it("switches on a step the assistant proposed switched off, and counts the switch", async () => {
          const card = await companyWithFollowup({ enabled: false });

          const edited = await switchFollowup(card, true);

          expect(edited.properties.userEditedKeys).toEqual(["followup.enabled"]);
          await confirmCard(card);
          expect(await countIn("tasks")).toBe(1);
        });

        it("does not count the fields of a step once it is switched off, and counts them again when it is back on", async () => {
          const card = await companyWithFollowup();
          const typed = await editParts(card, { set: { followup: { name: "Call them" } } });
          expect(typed.properties.userEditedKeys).toEqual(["followup.name"]);

          const off = await switchFollowup(card, false);
          expect(off.properties.userEditedKeys).toEqual(["followup.enabled"]);
          expect(off.properties.userOverrides).toEqual({ followup: { name: "Call them", enabled: false } });

          const back = await switchFollowup(card, true);
          expect(back.properties.userEditedKeys).toEqual(["followup.name"]);
        });

        it("accepts a value for a step that the same request switches on", async () => {
          const card = await companyWithFollowup({ enabled: false });

          const edited = await editParts(card, {
            set: { followup: { name: "Call them" } },
            steps: { followup: { enabled: true } },
          });

          expect(edited.properties.userEditedKeys).toEqual(["followup.enabled", "followup.name"]);
        });

        it.each([
          [
            "a value for a step that the same request switches off, naming the step",
            { set: { followup: { name: "Call them" } }, steps: { followup: { enabled: false } } },
            { ref: "followup", field: "followup" },
          ],
          [
            "to switch off the primary step of a multi-step card, whatever its ref",
            { steps: { company: { enabled: false } } },
            { ref: "company", field: "enabled" },
          ],
          [
            "a switch for a step the card does not have, naming it",
            { steps: { nowhere: { enabled: false } } },
            { ref: "nowhere", field: "nowhere" },
          ],
        ])("refuses %s, and writes nothing", async (_label, parts, details) => {
          const card = await companyWithFollowup();

          const error = await expectRefusedUnchanged(card, () => editParts(card, parts));

          expect(error).toBeInstanceOf(ValidationError);
          expect(error).toHaveProperty("details", details);
        });

        it("refuses to switch off the step of a single-step card, and switching it on is no edit", async () => {
          const card = await storeCard(taskEnvelope("Send the invoice"));

          const error = await expectRefusedUnchanged(card, () =>
            editParts(card, { steps: { primary: { enabled: false } } }),
          );
          expect(error).toBeInstanceOf(ValidationError);
          expect(error).toHaveProperty("details", { ref: "primary", field: "enabled" });

          const on = await editParts(card, { steps: { primary: { enabled: true } } });
          expect(on.properties.userEditedKeys).toEqual([]);
          expect(on.properties.userOverrides).toEqual({});
        });
      });

      describe("relation lists", () => {
        const taskWith = async (relations: Record<string, string[]>): Promise<string> =>
          storeCard({
            ...taskEnvelope("Send the invoice"),
            ...(Object.keys(relations).length > 0 ? { relations } : {}),
          });
        const taskWithProject = (projectIds: string[]) =>
          taskWith(projectIds.length > 0 ? { project: projectIds } : {});

        it("replaces a relation list on a single-step card: the effective envelope carries it, the key is counted, and confirm writes the edge", async () => {
          const project = await createIn("projects", { name: "Invoices" });
          const card = await taskWithProject([]);

          const edited = await editParts(card, { relations: { primary: { project: [project] } } });

          expect(edited.properties.proposal).toEqual({
            ...taskEnvelope("Send the invoice"),
            relations: { project: [project] },
          });
          expect(edited.properties.aiProposal).toEqual(taskEnvelope("Send the invoice"));
          expect(edited.properties.userOverrides).toEqual({ primary: { relations: { project: [project] } } });
          expect(edited.properties.userEditedKeys).toEqual(["primary.relations.project"]);
          expect(historyOf(edited).at(-1)).toMatchObject({ kind: "userEdit", keys: ["primary.relations.project"] });
          const confirmed = await confirmCard(card);
          expect(await edgeExists(z.string().parse(confirmed.properties.resultItemId), project)).toBe(true);
        });

        it.each([
          ["a company typed into an Event card that has a project", "project", "company"],
          ["a project typed into an Event card that has a company", "company", "project"],
        ] as const)("refuses %s, and writes nothing (issue gh-1991)", async (_label, stored, typed) => {
          const linked = {
            project: await createIn("projects", { name: "Invoices" }),
            company: await createIn("companies", { name: "Acme" }),
          };
          const card = await storeCard({
            entityKind: "database",
            target: await databaseIdFor("events"),
            properties: { name: "Meeting" },
            relations: { [stored]: [linked[stored]] },
          });

          const error = await expectRefusedUnchanged(card, () =>
            editParts(card, { relations: { primary: { [typed]: [linked[typed]] } } }),
          );

          expect(error).toBeInstanceOf(ValidationError);
          expect(error).toMatchObject({ status: 400, details: { field: "company", code: "derivedRelation" } });
        });

        it("accepts a company typed into an Event card that has no project (issue gh-1991)", async () => {
          const company = await createIn("companies", { name: "Acme" });
          const card = await storeCard({
            entityKind: "database",
            target: await databaseIdFor("events"),
            properties: { name: "Meeting" },
            relations: {},
          });

          const edited = await editParts(card, { relations: { primary: { company: [company] } } });

          expect(edited.properties.proposal).toMatchObject({ relations: { company: [company] } });
        });

        it("replaces the whole list, so a target the user removed is not written", async () => {
          const kept = await createIn("projects", { name: "Kept" });
          const removed = await createIn("projects", { name: "Removed" });
          const card = await taskWithProject([removed]);

          const edited = await editParts(card, { relations: { primary: { project: [kept] } } });

          expect(edited.properties.proposal).toMatchObject({ relations: { project: [kept] } });
          const confirmed = await confirmCard(card);
          const taskId = z.string().parse(confirmed.properties.resultItemId);
          expect(await edgeExists(taskId, kept)).toBe(true);
          expect(await edgeExists(taskId, removed)).toBe(false);
        });

        it("saves an emptied list when the assistant had a target, and counts it", async () => {
          const project = await createIn("projects", { name: "Invoices" });
          const card = await taskWithProject([project]);

          const edited = await editParts(card, { relations: { primary: { project: [] } } });

          expect(edited.properties.proposal).toMatchObject({ relations: { project: [] } });
          expect(edited.properties.userEditedKeys).toEqual(["primary.relations.project"]);
        });

        it("does not count a list that holds the assistant's targets, in any order, and drops it", async () => {
          const first = await createIn("companies", { name: "Acme" });
          const second = await createIn("companies", { name: "Beta" });
          const card = await storeCard({
            entityKind: "database",
            target: await databaseIdFor("people"),
            properties: { name: "Jane" },
            relations: { companies: [first, second] },
          });

          const unchanged = await editParts(card, { relations: { primary: { companies: [second, first] } } });

          expect(unchanged.properties.userEditedKeys).toEqual([]);
          expect(unchanged.properties.userOverrides).toEqual({});
        });

        it("drops a list again when it is set back to what the assistant had, and keeps the lists of other keys", async () => {
          const project = await createIn("projects", { name: "Invoices" });
          const person = await createIn("people", { name: "Jane" });
          const card = await taskWithProject([]);
          await editParts(card, { relations: { primary: { project: [project] } } });

          const second = await editParts(card, { relations: { primary: { people: [person] } } });
          expect(second.properties.userOverrides).toEqual({
            primary: { relations: { project: [project], people: [person] } },
          });
          expect(second.properties.userEditedKeys).toEqual(["primary.relations.people", "primary.relations.project"]);

          await editParts(card, { relations: { primary: { people: [] } } });
          const cleared = await editParts(card, { relations: { primary: { project: [] } } });
          expect(cleared.properties.userEditedKeys).toEqual([]);
          expect(cleared.properties.userOverrides).toEqual({});
          expect(cleared.properties.proposal).toEqual(taskEnvelope("Send the invoice"));
        });

        it("saves a list together with a value of the same step in one write", async () => {
          const project = await createIn("projects", { name: "Invoices" });
          const card = await taskWithProject([]);

          const edited = await editParts(card, {
            set: { primary: { name: "Poslat fakturu" } },
            relations: { primary: { project: [project] } },
          });

          expect(edited.properties.userEditedKeys).toEqual(["primary.name", "primary.relations.project"]);
          expect(edited.properties.proposal).toEqual({
            ...taskEnvelope("Poslat fakturu"),
            relations: { project: [project] },
          });
        });

        it("replaces the relation of a secondary step, dropping its reference to another step", async () => {
          const company = await createIn("companies", { name: "Existing" });
          const card = await cardWithSteps(companyAndPerson);

          const edited = await editParts(card, { relations: { person: { companies: [company] } } });

          expect(effectiveSteps(edited).find((step) => step.ref === "person")?.relations).toEqual({
            companies: [company],
          });
          expect(edited.properties.userEditedKeys).toEqual(["person.relations.companies"]);
        });

        it("replaces a relation of an update step in both copies its validation compares", async () => {
          const oldArea = await createIn("areas", { name: "Old" });
          const newArea = await createIn("areas", { name: "New" });
          const otherArea = await createIn("areas", { name: "Other" });
          const project = await createIn("projects", { name: "Move" });
          await linkArea(project, oldArea);
          const card = await storeCard({
            entityKind: "database",
            target: await databaseIdFor("projects"),
            properties: { name: "Move" },
            operations: [
              updateStep("project", project, {
                properties: { name: "Move" },
                relations: { area: [newArea] },
                before: { properties: { name: "Move" }, relations: { area: [oldArea] } },
                after: { properties: { name: "Move" }, relations: { area: [newArea] } },
              }),
            ],
          });

          const edited = await editParts(card, { relations: { project: { area: [otherArea] } } });

          expect(effectiveSteps(edited)[0]).toMatchObject({
            relations: { area: [otherArea] },
            after: { properties: { name: "Move" }, relations: { area: [otherArea] } },
          });
          expect(edited.properties.userEditedKeys).toEqual(["project.relations.area"]);
          await confirmCard(card);
          expect(await edgeExists(project, oldArea)).toBe(false);
          expect(await edgeExists(project, otherArea)).toBe(true);
        });

        it.each([
          ["a target that does not exist", "project", true, { field: "project", code: "targetNotFound" }],
          ["a relation the target database does not have", "notARelation", false, { field: "notARelation" }],
          [
            "the relation key 'constructor', named like an Object member",
            "constructor",
            false,
            { field: "constructor" },
          ],
          ["the relation key 'toString', named like an Object member", "toString", false, { field: "toString" }],
          [
            "the relation key 'hasOwnProperty', named like an Object member",
            "hasOwnProperty",
            false,
            { field: "hasOwnProperty" },
          ],
        ])(
          "refuses %s with the error a confirm of the same envelope raises, and writes nothing",
          async (_label, key, missingTarget, details) => {
            const target = missingTarget ? randomUUID() : await createIn("projects", { name: "Invoices" });
            const lists = { [key]: [target] };
            const card = await taskWithProject([]);

            const refused = await expectRefusedUnchanged(card, () =>
              editParts(card, { relations: { primary: lists } }),
            );
            const stored = await taskWith(lists);
            const confirmError = await expectRefusedUnchanged(stored, () => confirmCard(stored));

            expect(refused).toBeInstanceOf(ValidationError);
            expect(refused).toHaveProperty("details", details);
            expect(confirmError).toBeInstanceOf(ValidationError);
            expect((refused as ValidationError).details).toEqual((confirmError as ValidationError).details);
            expect((refused as ValidationError).message).toBe((confirmError as ValidationError).message);
          },
        );

        it("refuses a relation list on a card that cannot carry relations, writing nothing", async () => {
          const { proposal: card } = await createPageContentProposal();
          const project = await createIn("projects", { name: "Invoices" });

          const error = await expectRefusedUnchanged(card.id, () =>
            editParts(card.id, { relations: { primary: { project: [project] } } }),
          );

          expect(error).toBeInstanceOf(ValidationError);
          expect(error).toHaveProperty("details", { field: "relations" });
        });

        it.each([
          ["a step the card does not have, naming it", "nowhere", { ref: "nowhere", field: "nowhere" }],
          ["a step the card has switched off, naming the step", "followup", { ref: "followup", field: "followup" }],
        ])("refuses a list for %s, and writes nothing", async (_label, ref, details) => {
          const project = await createIn("projects", { name: "Invoices" });
          const card = await companyWithFollowup();
          await switchFollowup(card, false);

          const error = await expectRefusedUnchanged(card, () =>
            editParts(card, { relations: { [ref]: { project: [project] } } }),
          );

          expect(error).toBeInstanceOf(ValidationError);
          expect(error).toHaveProperty("details", details);
        });
      });

      describe("the request", () => {
        it.each(["relations", "enabled"])(
          "refuses '%s' as a value in set, naming the step and the key",
          async (key) => {
            const card = await companyWithFollowup();

            const error = await expectRefusedUnchanged(card, () => edit(card, { company: { [key]: [] } }));

            expect(error).toBeInstanceOf(ValidationError);
            expect(error).toHaveProperty("details", { ref: "company", field: key });
          },
        );

        it("edits with relations or steps alone, and with an empty set beside them", async () => {
          const project = await createIn("projects", { name: "Invoices" });
          const card = await storeCard(taskEnvelope("Send the invoice"));

          const edited = await editParts(card, { set: {}, relations: { primary: { project: [project] } } });

          expect(edited.properties.userEditedKeys).toEqual(["primary.relations.project"]);
        });

        it.each([
          ["no part", {}, "set"],
          ["an empty set", { set: {} }, "set"],
          ["an empty relations", { relations: {} }, "relations"],
          ["an empty steps", { steps: {} }, "steps"],
          ["an empty list map for a ref", { relations: { primary: {} } }, "relations"],
        ])("refuses %s, naming the part, and writes nothing", async (_label, parts, field) => {
          const card = await storeCard(taskEnvelope("Send the invoice"));

          const error = await expectRefusedUnchanged(card, () => editParts(card, parts));

          expect(error).toBeInstanceOf(ValidationError);
          expect(error).toHaveProperty("details", { field });
        });

        it("fails every part when one is refused: the values of the request are not written either", async () => {
          const card = await storeCard(taskEnvelope("Send the invoice"));

          const error = await expectRefusedUnchanged(card, () =>
            editParts(card, {
              set: { primary: { name: "Typed" } },
              relations: { primary: { project: [randomUUID()] } },
            }),
          );

          expect(error).toBeInstanceOf(ValidationError);
          expect((await readCard(card)).properties.userEditedKeys).toBeUndefined();
        });
      });
    });
  });

  describe("returning a card to the assistant's proposal (issue #1912)", () => {
    const reset = (cardId: string, ifVersion?: string): Promise<ItemRow> =>
      withTransaction(pool, (client) =>
        resetProposalOverridesWithClient(client, config(), cardId, ifVersion === undefined ? {} : { ifVersion }),
      );
    /** A card with two manual values on top of the assistant's "Send the invoice". */
    async function editedCard(): Promise<ItemRow> {
      const card = await createDatabaseProposal("Send the invoice");
      await edit(card.id, { primary: { name: "Poslat fakturu Alze", flagged: true } });
      return readCard(card.id);
    }

    it("restores the assistant's envelope, empties userOverrides and userEditedKeys and adds one reset entry", async () => {
      const edited = await editedCard();
      expect(edited.properties.userEditedKeys).toEqual(["primary.flagged", "primary.name"]);

      const restored = await reset(edited.id);

      expect(restored.properties.proposal).toEqual(taskEnvelope("Send the invoice"));
      expect(restored.properties.proposal).toEqual(restored.properties.aiProposal);
      expect(restored.properties.userOverrides).toEqual({});
      expect(restored.properties.userEditedKeys).toEqual([]);
      expect(restored.properties.status).toBe("proposed");
      expect(restored.properties.aiVersion).toBe(edited.properties.aiVersion);
      expect(restored.properties).not.toHaveProperty("invalidReason");
      const history = historyOf(restored);
      expect(history).toHaveLength(historyOf(edited).length + 1);
      expect(history.at(-1)).toMatchObject({
        author: "user",
        kind: "reset",
        keys: ["primary.flagged", "primary.name"],
      });
      const stored = await readCard(edited.id);
      expect(stored.properties).toEqual(restored.properties);
      expect(stored.updatedAt).toBe(restored.updatedAt);
    });

    it("confirms the assistant's value after a reset, not the typed one", async () => {
      const edited = await editedCard();
      await reset(edited.id);

      const confirmed = await confirmCard(edited.id);

      expect(confirmed.properties.resultLabel).toBe("Send the invoice");
    });

    it("returns the values of the assistant's latest computation, not the first one", async () => {
      const edited = await editedCard();
      await reviseCard(edited.id, {
        message: "Chosen type",
        entityKind: "database",
        target: tasksId,
        properties: { name: "Send the invoice today" },
      });
      const revised = await readCard(edited.id);
      expect(revised.properties.userEditedKeys).toEqual(["primary.flagged", "primary.name"]);

      const restored = await reset(edited.id);

      expect(restored.properties.proposal).toEqual(taskEnvelope("Send the invoice today"));
      expect(restored.properties.aiProposal).toEqual(taskEnvelope("Send the invoice today"));
      expect(restored.properties.userEditedKeys).toEqual([]);
    });

    it("resets a card that has userEditedKeys but no userOverrides", async () => {
      const card = await createDatabaseProposal("Send the invoice");
      await storeProps(card.id, { userEditedKeys: ["primary.name"] });

      const restored = await reset(card.id);

      expect(restored.properties.userEditedKeys).toEqual([]);
      expect(historyOf(restored).at(-1)).toMatchObject({ kind: "reset", keys: ["primary.name"] });
    });

    it("resets a card that has userOverrides but no userEditedKeys, as when a hidden field was edited", async () => {
      const card = await createDatabaseProposal("Send the invoice");
      await storeProps(card.id, { userOverrides: { primary: { name: "Typed" } }, proposal: taskEnvelope("Typed") });

      const restored = await reset(card.id);

      expect(restored.properties.proposal).toEqual(taskEnvelope("Send the invoice"));
      expect(restored.properties.userOverrides).toEqual({});
      expect(historyOf(restored).at(-1)).toMatchObject({ kind: "reset", keys: [] });
    });

    it("returns the card unchanged and writes no history entry when nothing is edited", async () => {
      const card = await createDatabaseProposal("Send the invoice");
      const before = await readCard(card.id);

      const answered = await reset(card.id);

      expect(answered).toEqual(before);
      expect(historyOf(answered)).toEqual(historyOf(before));
      expect((await readCard(card.id)).updatedAt).toBe(before.updatedAt);
    });

    it("returns the card unchanged after a reset that already happened", async () => {
      const edited = await editedCard();
      const first = await reset(edited.id);

      const second = await reset(edited.id);

      expect(second.properties).toEqual(first.properties);
      expect(second.updatedAt).toBe(first.updatedAt);
      expect(historyOf(second).filter((entry) => entry.kind === "reset")).toHaveLength(1);
    });

    it("accepts a current ifVersion", async () => {
      const edited = await editedCard();

      const restored = await reset(edited.id, edited.version);

      expect(restored.properties.userEditedKeys).toEqual([]);
    });

    it("answers a stale ifVersion with a ConflictError carrying the current card, and writes nothing", async () => {
      const card = await createDatabaseProposal("Send the invoice");
      const stale = (await readCard(card.id)).version;
      await edit(card.id, { primary: { name: "First edit" } });
      const current = await readCard(card.id);

      const error = await expectRefusedUnchanged(card.id, () => reset(card.id, stale));

      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({ status: 409, code: "version_conflict" });
      expect(error).toHaveProperty("details.current.id", card.id);
      expect(error).toHaveProperty("details.current.updatedAt", current.updatedAt);
      expect(current.properties.userOverrides).toEqual({ primary: { name: "First edit" } });
    });

    it("answers a stale ifVersion with a ConflictError also when nothing is edited", async () => {
      const card = await createDatabaseProposal("Send the invoice");
      const stale = (await readCard(card.id)).version;
      await storeProps(card.id, { reason: "changed since" });

      const error = await expectRefusedUnchanged(card.id, () => reset(card.id, stale));

      expect(error).toBeInstanceOf(ConflictError);
    });

    it.each(["confirm", "reject"] as const)(
      "refuses a card that was %sed with a ValidationError and writes nothing",
      async (action) => {
        const edited = await editedCard();
        await (action === "confirm" ? confirmCard : rejectCard)(edited.id);

        const error = await expectRefusedUnchanged(edited.id, () => reset(edited.id));

        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toHaveProperty("details", { field: "status" });
        expect((error as Error).message).toContain("locked");
      },
    );

    it("refuses a confirmed card with nothing edited as it refuses an edited one", async () => {
      const card = await createDatabaseProposal("Send the invoice");
      await confirmCard(card.id);

      const error = await expectRefusedUnchanged(card.id, () => reset(card.id));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toHaveProperty("details", { field: "status" });
    });

    it.each(["computing", "computeFailed"])("refuses a card in the status %s", async (status) => {
      const edited = await editedCard();
      await storeProps(edited.id, { status });

      const error = await expectRefusedUnchanged(edited.id, () => reset(edited.id));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toHaveProperty("details", { field: "status" });
    });

    it("moves a fixable invalid card back to proposed and clears its invalidReason", async () => {
      const edited = await editedCard();
      await storeProps(edited.id, {
        status: "invalid",
        invalidReason: { code: "targetArchived", field: "project", itemId: randomUUID(), label: "Project" },
      });

      const restored = await reset(edited.id);

      expect(restored.properties.status).toBe("proposed");
      expect(restored.properties.invalidReason).toBeNull();
      expect(restored.properties.proposal).toEqual(taskEnvelope("Send the invoice"));
    });

    it("refuses a card that is final invalid because its source was deleted, and writes nothing", async () => {
      const edited = await editedCard();
      await storeProps(edited.id, {
        status: "invalid",
        invalidReason: { code: "sourceDeleted", field: "", itemId: randomUUID(), label: "Source" },
      });

      const error = await expectRefusedUnchanged(edited.id, () => reset(edited.id));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toHaveProperty("details", { field: "status" });
    });

    it("moves a needsClarification card that holds an envelope to proposed", async () => {
      const edited = await editedCard();
      await storeProps(edited.id, { status: "needsClarification" });

      const restored = await reset(edited.id);

      expect(restored.properties.status).toBe("proposed");
      expect(restored.properties.proposal).toEqual(taskEnvelope("Send the invoice"));
    });

    it("returns a needsClarification card with no envelope and nothing edited unchanged", async () => {
      const card = await createDatabaseProposal("Send the invoice");
      await storeProps(card.id, { status: "needsClarification", proposal: null, aiProposal: null });
      const before = await readCard(card.id);

      const answered = await reset(card.id);

      expect(answered).toEqual(before);
    });

    it("refuses a card whose manual values have no assistant envelope to return to, and writes nothing", async () => {
      const card = await createDatabaseProposal("Send the invoice");
      await storeProps(card.id, {
        status: "needsClarification",
        proposal: null,
        aiProposal: null,
        userOverrides: { primary: { name: "Typed" } },
        userEditedKeys: ["primary.name"],
      });

      const error = await expectRefusedUnchanged(card.id, () => reset(card.id));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toHaveProperty("details", { field: "proposal" });
    });

    it("refuses a card whose assistant envelope has an unknown entityKind with a ConflictError, and writes nothing", async () => {
      const edited = await editedCard();
      await storeProps(edited.id, {
        aiProposal: { entityKind: "someFutureKind", target: "future-target", properties: { a: 1 } },
      });

      const error = await expectRefusedUnchanged(edited.id, () => reset(edited.id));

      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({ details: { field: "entityKind", entityKind: "someFutureKind" } });
    });

    it("refuses an assistant envelope that no longer fits its destination, and keeps the manual values", async () => {
      const edited = await editedCard();
      await storeProps(edited.id, { aiProposal: { ...taskEnvelope("Send the invoice"), target: randomUUID() } });

      const error = await expectRefusedUnchanged(edited.id, () => reset(edited.id));

      expect(error).toBeInstanceOf(ValidationError);
      expect((await readCard(edited.id)).properties.userEditedKeys).toEqual(["primary.flagged", "primary.name"]);
    });

    it("fails on a malformed stored userEditedKeys instead of resetting it", async () => {
      const card = await createDatabaseProposal("Send the invoice");
      await storeProps(card.id, { userEditedKeys: { primary: "name" } });

      const error = await expectRefusedUnchanged(card.id, () => reset(card.id));

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Malformed userEditedKeys");
    });

    it("answers an unknown card id with a NotFoundError", async () => {
      await expect(reset(randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    });

    it("answers a card in the trash with a NotFoundError and leaves it as it was", async () => {
      const edited = await editedCard();
      await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, proposalsId, edited.id));

      await expect(reset(edited.id)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("recomputing a card (issue gh-1955)", () => {
    const recompute = (cardId: string, input: { ifVersion?: string; actingUserId?: string } = {}): Promise<ItemRow> =>
      withTransaction(pool, (client) => recomputeProposalWithClient(client, config(), cardId, input));
    const plain = (card: ItemRow) => ({ id: card.id, updatedAt: card.updatedAt, properties: card.properties });
    const bareCard = (kind: string | undefined, status: string) =>
      withTransaction(
        pool,
        async (client) =>
          (
            await createItemWithClient(
              client,
              {
                databaseId: proposalsId,
                properties: { ...(kind === undefined ? {} : { kind }), status, proposal: null },
              },
              { allowedSystemKeys: [...(kind === undefined ? [] : ["kind"]), "status", "proposal"] },
            )
          ).id,
      );
    const queuedJobs = async () =>
      (
        await pool.query<{ key: string | null; revision: number }>(
          "SELECT key, revision FROM graphile_worker.jobs ORDER BY id",
        )
      ).rows;
    /** Empties the queue through the worker, so that a job enqueued afterwards is a new row of revision 0. */
    async function discardQueuedJobs(): Promise<void> {
      let remaining = Number.POSITIVE_INFINITY;
      for (;;) {
        const { rows } = await pool.query<{ task_identifier: string }>(
          "SELECT task_identifier FROM graphile_worker.jobs ORDER BY id",
        );
        if (rows.length === 0) return;
        if (rows.length >= remaining) throw new Error(`Queued jobs stopped draining: ${JSON.stringify(rows)}`);
        remaining = rows.length;
        const taskList: TaskList = Object.fromEntries(rows.map((row) => [row.task_identifier, async () => {}]));
        await runOnce({ pgPool: pool }, taskList);
      }
    }
    async function tickJobKey(itemId: string): Promise<string> {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM project_heartbeats
         WHERE rule ->> 'kind' = 'onItemEvent' AND rule ->> 'databaseId' = $1 AND rule ->> 'event' = 'update'`,
        [inboxId],
      );
      if (!rows[0]) throw new Error("The Inbox 'update' heartbeat was not seeded");
      return heartbeatFireJobKey(rows[0].id, itemId);
    }
    const expectOneTickJob = async (itemId: string) =>
      expect(await queuedJobs()).toEqual([{ key: await tickJobKey(itemId), revision: 0 }]);
    /** A card with a manual title over the assistant's "Buy milk", its source item, and an empty queue. */
    async function editedCard() {
      const card = await createDatabaseProposal("Buy milk");
      await withTransaction(pool, (client) =>
        updateProposalValuesWithClient(client, config(), card.id, { set: { primary: { name: "My own title" } } }),
      );
      const itemId = await sourceOf(card.id);
      await discardQueuedJobs();
      return { card: await readCard(card.id), itemId };
    }
    /** Expects failure and proves nothing was written: the card, its `updatedAt` and the queue unchanged. */
    async function expectNothingWritten(cardId: string, attempt: () => Promise<unknown>): Promise<unknown> {
      const jobsBefore = await queuedJobs();
      const error = await expectRefusedUnchanged(cardId, attempt);
      expect(error).not.toBeNull();
      expect(await queuedJobs()).toEqual(jobsBefore);
      return error;
    }

    it("sends a card with an edited title to the tick, which proposes the other fields again and keeps the title", async () => {
      const { card, itemId } = await editedCard();
      expect(card.properties.userEditedKeys).toEqual(["primary.name"]);

      const answered = await recompute(card.id);

      expect(answered.properties.status).toBe("computing");
      expect(plain(answered)).toEqual(plain(await readCard(card.id)));
      for (const key of ["proposal", "aiProposal", "aiVersion", "userOverrides", "userEditedKeys"]) {
        expect(answered.properties[key], key).toEqual(card.properties[key]);
      }
      expect(historyOf(answered).slice(0, -1)).toEqual(historyOf(card));
      expect(historyOf(answered).at(-1)).toMatchObject({ author: "user", kind: "recompute" });
      await expectOneTickJob(itemId);

      await runTick(itemId, async () => ({ properties: { name: "Buy oat milk", description: "From the shop" } }));

      const proposed = await readCard(card.id);
      expect(proposed.properties).toMatchObject({
        status: "proposed",
        aiProposal: {
          entityKind: "database",
          target: tasksId,
          properties: { name: "Buy oat milk", description: "From the shop" },
        },
        proposal: {
          entityKind: "database",
          target: tasksId,
          properties: { name: "My own title", description: "From the shop" },
        },
        userOverrides: { primary: { name: "My own title" } },
        userEditedKeys: ["primary.name"],
      });
      expect(historyOf(proposed).filter((entry) => entry.kind === "recompute" && entry.author === "user")).toHaveLength(
        1,
      );
    });

    it("answers a card that is computing already unchanged, and a second call queues no job", async () => {
      const { card, itemId } = await editedCard();
      const first = await recompute(card.id);
      await expectOneTickJob(itemId);
      await discardQueuedJobs();

      const second = await recompute(card.id);

      expect(plain(second)).toEqual(plain(first));
      expect(plain(await readCard(card.id))).toEqual(plain(first));
      expect(historyOf(second).filter((entry) => entry.kind === "recompute")).toHaveLength(1);
      expect(await queuedJobs()).toEqual([]);
    });

    it("answers a computing card unchanged also when the ifVersion it carries is stale", async () => {
      const { card } = await editedCard();
      const first = await recompute(card.id);
      await discardQueuedJobs();

      const second = await recompute(card.id, { ifVersion: card.version });

      expect(card.updatedAt).not.toBe(first.updatedAt);
      expect(plain(second)).toEqual(plain(first));
      expect(await queuedJobs()).toEqual([]);
    });

    it.each(["needsClarification", "computeFailed"])("accepts a card in status %s", async (status) => {
      const { card, itemId } = await editedCard();
      await storeProps(card.id, { status });
      await discardQueuedJobs();

      const answered = await recompute(card.id);

      expect(answered.properties.status).toBe("computing");
      expect(historyOf(answered).at(-1)).toMatchObject({ author: "user", kind: "recompute" });
      await expectOneTickJob(itemId);
    });

    it("accepts a fixable invalid card and clears its invalid reason with the status", async () => {
      const { card, itemId } = await editedCard();
      await storeProps(card.id, {
        status: "invalid",
        invalidReason: { code: "targetArchived", field: "", itemId: tasksId, label: "Tasks" },
      });
      await discardQueuedJobs();

      const answered = await recompute(card.id);

      expect(answered.properties.status).toBe("computing");
      expect(answered.properties.invalidReason).toBeNull();
      await expectOneTickJob(itemId);
    });

    it("refuses a card whose source Inbox item was deleted with a ValidationError on status, and writes nothing", async () => {
      const { card, itemId } = await editedCard();
      await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, itemId));
      await runTick(itemId, async () => {
        throw new Error("The tick must not compute a card whose source was deleted");
      });
      expect(await readCard(card.id)).toMatchObject({
        properties: { status: "invalid", invalidReason: { code: "sourceDeleted" } },
      });
      await discardQueuedJobs();

      const error = await expectNothingWritten(card.id, () => recompute(card.id));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toHaveProperty("details.field", "status");
    });

    it.each([
      ["of kind transcript", "transcript"],
      ["of kind mailThread", "mailThread"],
      ["without a kind, so only a card of an Inbox item is recomputed", undefined],
    ])("refuses a card %s with a ValidationError on kind", async (_label, kind) => {
      const cardId = await bareCard(kind, "proposed");

      const error = await expectNothingWritten(cardId, () => recompute(cardId));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toHaveProperty("details.field", "kind");
    });

    it.each(["confirmed", "rejected"])(
      "refuses a %s card with the 409 proposal_locked, and writes nothing",
      async (status) => {
        const { card } = await editedCard();
        await (status === "confirmed" ? confirmCard : rejectCard)(card.id);

        const error = await expectNothingWritten(card.id, () => recompute(card.id));

        expect(error).toBeInstanceOf(ProposalLockedError);
        expect(error).toMatchObject({ status: 409, code: "proposal_locked" });
      },
    );

    it("refuses a stale ifVersion with the 409 version_conflict that carries the current card, and writes nothing", async () => {
      const { card } = await editedCard();
      await withTransaction(pool, (client) =>
        updateProposalValuesWithClient(client, config(), card.id, { set: { primary: { name: "Edited again" } } }),
      );
      const current = await readCard(card.id);
      expect(current.updatedAt).not.toBe(card.updatedAt);

      const error = await expectNothingWritten(card.id, () => recompute(card.id, { ifVersion: card.version }));

      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({ status: 409, code: "version_conflict", details: { current } });
    });

    it("accepts the current ifVersion", async () => {
      const { card, itemId } = await editedCard();

      const answered = await recompute(card.id, { ifVersion: card.version });

      expect(answered.properties.status).toBe("computing");
      await expectOneTickJob(itemId);
    });

    it("refuses an unknown card with a NotFoundError", async () => {
      await expect(recompute(randomUUID())).rejects.toThrow(NotFoundError);
    });

    it("refuses a card of an Inbox item that has no source edge with a NotFoundError, and writes nothing", async () => {
      const cardId = await bareCard("inbox", "proposed");

      const error = await expectNothingWritten(cardId, () => recompute(cardId));

      expect(error).toBeInstanceOf(NotFoundError);
    });

    it("refuses a card whose source Inbox item is in the Trash but whose status the tick has not changed yet, and writes nothing", async () => {
      const { card, itemId } = await editedCard();
      // Raw SQL: the production trash leaves the card to the tick, which this test does not run.
      await pool.query("UPDATE items SET deleted_at = now() WHERE id = $1", [itemId]);

      const error = await expectNothingWritten(card.id, () => recompute(card.id));

      expect(error).toBeInstanceOf(NotFoundError);
    });

    it("announces the change of the card once after the commit, and nothing for a refusal", async () => {
      const { card } = await editedCard();
      const events: InboxCardsInvalidationEvent[] = [];
      setInboxCardsInvalidationHook((event) => events.push(event));
      try {
        await expect(recompute(card.id, { ifVersion: "2000-01-01T00:00:00.000Z" })).rejects.toThrow(ConflictError);
        expect(events).toEqual([]);

        await recompute(card.id);
        expect(events).toEqual([{ op: "updated", cardId: card.id }]);
      } finally {
        setInboxCardsInvalidationHook(() => {});
      }
    });

    it("addresses the invalidation of the card write to the acting user", async () => {
      const { card } = await editedCard();
      const actingUserId = randomUUID();
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await recompute(card.id, { actingUserId });
      } finally {
        setInvalidationHook(() => {});
      }

      const cardEvents = events.filter((event) => event.scope === "item" && event.itemId === card.id);
      expect(cardEvents).toHaveLength(1);
      expect(cardEvents[0]).toMatchObject({ op: "update", userId: actingUserId });
    });

    describe("a card that stays computing past the timeout (issue gh-2026)", () => {
      const MINUTE_MS = 60_000;

      /** Only `Date` is faked, so the database and pool timers run normally. */
      function clockAfter(ms: number): void {
        const base = Date.now();
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(base + ms);
      }

      afterEach(() => {
        vi.useRealTimers();
      });

      /** A card sent back by the user once, its source item, and an empty queue. */
      async function computingCard() {
        const { card, itemId } = await editedCard();
        const computing = await recompute(card.id);
        await discardQueuedJobs();
        return { card: computing, itemId };
      }

      it("sends a card that has been computing for longer than the timeout back again: a new updatedAt, a second recompute entry and exactly one tick job", async () => {
        const { card, itemId } = await computingCard();
        clockAfter(COMPUTING_TIMEOUT_MS + MINUTE_MS);

        const answered = await recompute(card.id);

        expect(answered.properties.status).toBe("computing");
        expect(answered.updatedAt).not.toBe(card.updatedAt);
        expect(plain(answered)).toEqual(plain(await readCard(card.id)));
        expect(historyOf(answered).slice(0, -1)).toEqual(historyOf(card));
        expect(historyOf(answered).at(-1)).toMatchObject({ author: "user", kind: "recompute" });
        expect(historyOf(answered).filter((entry) => entry.kind === "recompute")).toHaveLength(2);
        await expectOneTickJob(itemId);
      });

      it("returns a card that has been computing for less than the timeout unchanged and queues no job", async () => {
        const { card } = await computingCard();
        clockAfter(COMPUTING_TIMEOUT_MS - MINUTE_MS);

        const answered = await recompute(card.id);

        expect(plain(answered)).toEqual(plain(card));
        expect(plain(await readCard(card.id))).toEqual(plain(card));
        expect(await queuedJobs()).toEqual([]);
      });

      it("checks the ifVersion of a timed-out card, which is no longer answered as computing: a stale one is the 409 version_conflict", async () => {
        const { card } = await computingCard();
        clockAfter(COMPUTING_TIMEOUT_MS + MINUTE_MS);

        const error = await expectNothingWritten(card.id, () =>
          recompute(card.id, { ifVersion: "2000-01-01T00:00:00.000Z" }),
        );

        expect(error).toBeInstanceOf(ConflictError);
        expect(error).toMatchObject({ status: 409, code: "version_conflict" });
      });

      it("accepts the current ifVersion of a timed-out card", async () => {
        const { card } = await computingCard();
        clockAfter(COMPUTING_TIMEOUT_MS + MINUTE_MS);

        const answered = await recompute(card.id, { ifVersion: card.version });

        expect(answered.updatedAt).not.toBe(card.updatedAt);
      });

      it("lets a late tick turn a timed-out card into a proposed one, whose title stays the user's", async () => {
        const { card, itemId } = await computingCard();
        clockAfter(COMPUTING_TIMEOUT_MS + MINUTE_MS);

        await runTick(itemId, async () => ({ properties: { name: "Buy oat milk", description: "From the shop" } }));

        const proposed = await readCard(card.id);
        expect(proposed.properties).toMatchObject({
          status: "proposed",
          proposal: { properties: { name: "My own title", description: "From the shop" } },
        });
      });
    });
  });

  describe("referencedItemIds on the card actions (issue #1916)", () => {
    const createProject = (name: string) => createIn("projects", { name });
    const revise = (cardId: string, name: string, relations?: Record<string, string[]>) =>
      reviseCard(cardId, {
        message: "Chat correction",
        entityKind: "database",
        target: tasksId,
        properties: { name },
        ...(relations === undefined ? {} : { relations }),
      });
    const editRelations = (cardId: string, projects: string[]) =>
      withTransaction(pool, (client) =>
        updateProposalValuesWithClient(client, config(), cardId, { relations: { primary: { project: projects } } }),
      );
    /** The ids the card's stored `proposal` refers to, which `referencedItemIds` has to equal. */
    const referencedBy = (card: ItemRow) =>
      referencedItemIdsOf(parseStoredProposalEnvelope(card.properties.proposal, card.id) as ProposalEnvelope);

    it("reviseProposalWithClient stores the ids of the revised envelope's relation targets and clears them again", async () => {
      const project = await createProject("Alpha");
      const card = await createDatabaseProposal("Send the invoice");
      expect((await readCard(card.id)).properties.referencedItemIds).toEqual([]);

      const withProject = await revise(card.id, "Send the invoice", { project: [project] });
      expect(withProject.properties.referencedItemIds).toEqual([project]);
      expect(referencedBy(withProject)).toEqual([project]);

      const withoutProject = await revise(card.id, "Send the invoice today");
      expect(withoutProject.properties.referencedItemIds).toEqual([]);
    });

    it("reviseProposalWithClient stores the ids of the effective envelope, so a project the user chose stays referenced", async () => {
      const [assistant, chosen] = [await createProject("Alpha"), await createProject("Beta")];
      const card = await createDatabaseProposal("Send the invoice");
      await editRelations(card.id, [chosen]);

      const revised = await revise(card.id, "Send the invoice today", { project: [assistant] });

      expect(revised.properties.aiProposal).toMatchObject({ relations: { project: [assistant] } });
      expect(revised.properties.referencedItemIds).toEqual(referencedBy(revised));
    });

    it("the values route stores the ids of the edited relation list, an emptied list clears them, and the reset stores the assistant's again", async () => {
      const [assistant, chosen] = [await createProject("Alpha"), await createProject("Beta")];
      const card = await createDatabaseProposal("Send the invoice");
      await revise(card.id, "Send the invoice", { project: [assistant] });

      expect((await editRelations(card.id, [])).item.properties.referencedItemIds).toEqual([]);
      expect((await editRelations(card.id, [chosen])).item.properties.referencedItemIds).toEqual([chosen]);

      const restored = await withTransaction(pool, (client) =>
        resetProposalOverridesWithClient(client, config(), card.id, {}),
      );
      expect(restored.properties.referencedItemIds).toEqual([assistant]);
      expect(referencedBy(restored)).toEqual([assistant]);
    });

    it("a revision from an item thread stores the ids of the effective envelope", async () => {
      const chosen = await createProject("Alpha");
      const card = await createDatabaseProposal("Send the invoice");
      await editRelations(card.id, [chosen]);

      const revised = await withTransaction(pool, async (client) =>
        reviseProposalFromThreadWithClient(client, config(), {
          proposalId: card.id,
          subjectItemId: await sourceOf(card.id),
          threadId: randomUUID(),
          messageId: randomUUID(),
          entityKind: "database",
          target: tasksId,
          properties: { name: "Send the invoice today" },
        }),
      );

      expect(revised.properties.referencedItemIds).toEqual(referencedBy(revised));
      expect(revised.properties.referencedItemIds).toEqual([chosen]);
    });
  });

  describe("aiProposal and aiVersion (issue #1471)", () => {
    const rename = (cardId: string, name: string) =>
      reviseCard(cardId, {
        message: "Renamed the task",
        entityKind: "database",
        target: tasksId,
        properties: { name },
      });

    it("a revise through reviseProposalWithClient stores the new envelope in aiProposal and counts a version", async () => {
      const proposal = await createDatabaseProposal("Buy milk");
      expect(proposal.properties.aiVersion).toBe(1);

      const first = await rename(proposal.id, "Buy oat milk");
      expect(first.properties.aiProposal).toEqual(taskEnvelope("Buy oat milk"));
      expect(first.properties.aiProposal).toEqual(first.properties.proposal);
      expect(first.properties.aiVersion).toBe(2);

      const second = await rename(proposal.id, "Buy soy milk");
      expect(second.properties.aiProposal).toEqual(second.properties.proposal);
      expect(second.properties.aiVersion).toBe(3);
    });

    it("a revise of a legacy card without aiProposal stores aiProposal and sets aiVersion to 1", async () => {
      const proposal = await createDatabaseProposal("Buy milk");
      // No current writer can produce a card without aiProposal and aiVersion.
      await pool.query("UPDATE items SET properties = properties - 'aiProposal' - 'aiVersion' WHERE id = $1", [
        proposal.id,
      ]);

      const revised = await rename(proposal.id, "Buy oat milk");

      expect(revised.properties.aiProposal).toEqual(revised.properties.proposal);
      expect(revised.properties.aiVersion).toBe(1);
    });

    it.each([
      ["confirmed", confirmCard],
      ["rejected", rejectCard],
    ] as const)("a proposal %s leaves its aiProposal and aiVersion unchanged", async (status, decide) => {
      const proposal = await createDatabaseProposal("Buy milk");
      const before = await readCard(proposal.id);

      await decide(proposal.id);

      const after = await readCard(proposal.id);
      expect(after.properties.status).toBe(status);
      expect(after.properties.aiProposal).toEqual(before.properties.aiProposal);
      expect(after.properties.aiVersion).toBe(1);
    });
  });

  describe("thread task cards (issue gh-2034)", () => {
    const USER = { writerKind: "user" } as const;

    const storage: BlobStorageWriter = {
      writeStream() {
        throw new Error("writeStream is not used by this test");
      },
      async delete() {},
      readStream() {
        throw new Error("readStream is not used by this test");
      },
    };
    let inbox: { mailboxId: string; folderId: string };
    let eventsDatabaseId: string;

    beforeEach(async () => {
      eventsDatabaseId = await databaseIdFor("events");
      inbox = await scoped(async (client) => {
        const mailbox = await createItemWithClient(client, {
          databaseId: await databaseIdFor("mailboxes"),
          properties: { name: "Personal", provider: "generic" },
        });
        const folder = await createItemWithClient(
          client,
          {
            databaseId: await databaseIdFor("folders"),
            properties: { name: "Inbox", behavior: "folder", specialPurpose: "inbox" },
          },
          { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
        );
        return { mailboxId: mailbox.id, folderId: folder.id };
      });
    });

    async function propertyId(moduleId: string, key: string): Promise<string> {
      const databaseId = await databaseIdFor(moduleId);
      const property = await scoped((client) => propertiesStore.getPropertyByKey(client, databaseId, key));
      if (!property) throw new Error(`Property ${moduleId}.${key} was not seeded`);
      return property.id;
    }

    async function newMessage(messageId: string): Promise<{ threadId: string; itemId: string; emailItemId: string }> {
      return scoped(async (client) => {
        const ingested = await ingestEmailMessage(client, {
          emailsDatabaseId: await databaseIdFor("emails"),
          filesDatabaseId: await databaseIdFor("files"),
          folderRelationPropertyId: await propertyId("emails", "folder"),
          attachmentsRelationPropertyId: await propertyId("emails", "attachments"),
          mailboxItemId: inbox.mailboxId,
          folderItemId: inbox.folderId,
          messageId,
          inReplyTo: null,
          references: [],
          subject: `Subject of ${messageId}`,
          bodyText: `body of ${messageId}`,
          envelope: { from: { name: "Client", address: "client@example.test" }, to: [{ address: "me@example.test" }] },
          attachments: [],
          storage,
          storageKeyPrefix: "thread-task-card",
        });
        const { rows } = await client.query<{ id: string; item_id: string | null }>(
          "SELECT t.id, t.item_id FROM mail_message_meta m JOIN mail_threads t ON t.id = m.thread_id WHERE m.item_id = $1",
          [ingested.itemId],
        );
        const row = rows[0];
        if (!row?.item_id) throw new Error("The ingested message has no thread item");
        return { threadId: row.id, itemId: row.item_id, emailItemId: ingested.itemId };
      });
    }

    async function newItem(moduleId: string, properties: Record<string, unknown>): Promise<string> {
      const databaseId = await databaseIdFor(moduleId);
      return (await scoped((client) => createItemWithClient(client, { databaseId, properties }))).id;
    }

    /** A thread with a project and a conversation of a sender and a recipient, linked the way production links them. */
    async function newConversation() {
      const thread = await newMessage("<invoice@example.test>");
      const project = await newItem("projects", { name: "Web" });
      const alice = await newItem("people", { name: "Alice" });
      const bob = await newItem("people", { name: "Bob" });
      const threadProject = await propertyId("threads", "project");
      const sender = await propertyId("emails", "senderPeople");
      const recipients = await propertyId("emails", "recipientsPeople");
      await scoped(async (client) => {
        await createRelationWithClient(
          client,
          { relationPropertyId: threadProject, callerItemId: thread.itemId, targetItemId: project },
          undefined,
          USER,
        );
        for (const [relationPropertyId, personId] of [
          [sender, alice],
          [recipients, bob],
        ] as const) {
          await createRelationWithClient(
            client,
            { relationPropertyId, callerItemId: thread.emailItemId, targetItemId: personId },
            { ownerProcess: "emails" },
          );
        }
      });
      return { thread, project, people: [alice, bob].sort() };
    }

    /** A `mailThread` card as its producer writes it; `threadItemId` null omits the `sourceThread` edge. */
    async function createThreadCard(
      threadItemId: string | null,
      proposalProperties: Record<string, unknown> = { name: "Pay the invoice" },
      envelope: Record<string, unknown> = { entityKind: "database", target: tasksId, properties: proposalProperties },
    ): Promise<ItemRow> {
      return scoped(async (client) => {
        const card = await createItemWithClient(
          client,
          {
            databaseId: proposalsId,
            properties: {
              kind: "mailThread",
              status: "proposed",
              proposal: envelope,
              aiProposal: envelope,
              aiVersion: 1,
              history: [],
            },
          },
          { allowedSystemKeys: ["kind", "proposal", "aiProposal", "aiVersion", "history", "status"] },
        );
        if (threadItemId !== null) {
          await createRelationWithClient(
            client,
            {
              relationPropertyId: await propertyId("processingProposals", "sourceThread"),
              callerItemId: card.id,
              targetItemId: threadItemId,
            },
            { ownerProcess: PROCESSING_PROPOSALS_MODULE_ID },
          );
        }
        return card;
      });
    }

    function confirm(cardId: string, credential?: Parameters<typeof confirmProposalWithClient>[3]) {
      return scoped((client) => confirmProposalWithClient(client, config(), cardId, credential));
    }

    function revise(cardId: string, input: Parameters<typeof reviseProposalWithClient>[3]) {
      return scoped((client) => reviseProposalWithClient(client, config(), cardId, input));
    }

    async function relatedIds(moduleId: string, key: string, itemId: string): Promise<string[]> {
      const id = await propertyId(moduleId, key);
      return scoped(async (client) => {
        const definition = await relationsStore.getRelationDefinitionByPropertyId(client, id);
        if (!definition) throw new Error(`Relation ${moduleId}.${key} has no definition`);
        const edges = await relationsStore.listRelationsForItem(client, definition.id, itemId);
        return edges.map((edge) => relationsStore.otherSide(edge, itemId)).sort();
      });
    }

    async function writtenState() {
      const tasks = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1 ORDER BY id", [
        tasksId,
      ]);
      const edges = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM item_relations");
      const links = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM value_links");
      return { tasks: tasks.rows.map((row) => row.id), edges: edges.rows[0]?.count, links: links.rows[0]?.count };
    }

    async function linksOfTask(taskId: string) {
      return scoped(async (client) => {
        const links = await listValueLinksByItemIds(client, [taskId]);
        const sources = await listValueLinkSourcesByLinkIds(
          client,
          links.map((link) => link.id),
        );
        return links.map((link) => ({
          propertyKey: link.propertyKey,
          state: link.state,
          sourceItemIds: sources.flatMap((source) =>
            source.linkId === link.id && source.kind === "item" ? [source.sourceItemId] : [],
          ),
        }));
      });
    }

    it("confirm creates the task with the card's name and date, its Threads.tasks edge and the thread's project and people as inherited values", async () => {
      const { thread, project, people } = await newConversation();
      const card = await createThreadCard(thread.itemId, { name: "Pay the invoice", date: "2026-11-20" });

      const confirmed = await confirm(card.id);

      expect(confirmed.properties.status).toBe("confirmed");
      const taskId = z.string().parse(confirmed.properties.resultItemId);
      expect(confirmed.properties.resultLabel).toBe("Pay the invoice");
      expect(confirmed.properties.results).toEqual([
        expect.objectContaining({ ref: "primary", itemId: taskId, databaseKey: "tasks", label: "Pay the invoice" }),
      ]);
      const history = confirmed.properties.history as Array<Record<string, unknown>>;
      expect(history[history.length - 1]).toMatchObject({ author: "user", message: "Confirmed by user." });
      const task = await scoped((client) => itemsStore.getItemById(client, tasksId, taskId));
      expect(task?.properties).toMatchObject({ name: "Pay the invoice", date: "2026-11-20" });
      expect((await writtenState()).tasks).toEqual([taskId]);
      expect(await relatedIds("threads", "tasks", thread.itemId)).toEqual([taskId]);
      expect(await relatedIds("tasks", "project", taskId)).toEqual([project]);
      expect(await relatedIds("tasks", "people", taskId)).toEqual(people);
      expect(await linksOfTask(taskId)).toEqual([
        { propertyKey: "people", state: "on", sourceItemIds: [thread.itemId] },
        { propertyKey: "project", state: "on", sourceItemIds: [thread.itemId] },
      ]);
      // The card has no Inbox item or transcript to take an origin from.
      const origins = await pool.query("SELECT 1 FROM item_origins WHERE item_id = $1", [taskId]);
      expect(origins.rowCount).toBe(0);
    });

    it("confirm leaves the task without a date when the card has none", async () => {
      const { thread } = await newConversation();
      const card = await createThreadCard(thread.itemId, { name: "Pay the invoice" });

      const taskId = z.string().parse((await confirm(card.id)).properties.resultItemId);

      const task = await scoped((client) => itemsStore.getItemById(client, tasksId, taskId));
      expect(task?.properties.name).toBe("Pay the invoice");
      expect(task?.properties.date ?? null).toBeNull();
    });

    it("writes the task, its edge, its links and the card's confirmation in the caller's one transaction", async () => {
      const { thread } = await newConversation();
      const card = await createThreadCard(thread.itemId, { name: "Pay the invoice" });
      const before = await writtenState();

      await expect(
        scoped(async (client) => {
          await confirmProposalWithClient(client, config(), card.id);
          const inside = await client.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM items WHERE database_id = $1",
            [tasksId],
          );
          expect(inside.rows[0]?.count).toBe(1);
          throw new Error("abort after confirm");
        }),
      ).rejects.toThrow("abort after confirm");

      expect(await writtenState()).toEqual(before);
      expect((await readCard(card.id)).properties.status).toBe("proposed");
    });

    it("a card edited before confirm uses the edited name and date", async () => {
      const { thread } = await newConversation();
      const card = await createThreadCard(thread.itemId, { name: "Pay the invoice", date: "2026-11-20" });

      const revised = await revise(card.id, {
        entityKind: "database",
        target: tasksId,
        properties: { name: "Pay the November invoice", date: "2026-12-01" },
      });
      expect(revised.properties.proposal).toMatchObject({ properties: { name: "Pay the November invoice" } });
      const confirmed = await confirm(card.id);

      expect(confirmed.properties.resultLabel).toBe("Pay the November invoice");
      const task = await scoped((client) =>
        itemsStore.getItemById(client, tasksId, z.string().parse(confirmed.properties.resultItemId)),
      );
      expect(task?.properties).toMatchObject({ name: "Pay the November invoice", date: "2026-12-01" });
    });

    const longName = "n".repeat(501);
    const invalidRevisions: Array<[string, () => Parameters<typeof reviseProposalWithClient>[3], string]> = [
      [
        "a relations entry",
        () => ({
          entityKind: "database",
          target: tasksId,
          properties: { name: "X" },
          relations: { project: [randomUUID()] },
        }),
        "relations",
      ],
      [
        "an empty relations object",
        () => ({ entityKind: "database", target: tasksId, properties: { name: "X" }, relations: {} }),
        "relations",
      ],
      [
        "another property",
        () => ({ entityKind: "database", target: tasksId, properties: { name: "X", status: "done" } }),
        "properties",
      ],
      [
        "no name",
        () => ({ entityKind: "database", target: tasksId, properties: { date: "2026-11-20" } }),
        "properties",
      ],
      ["an empty name", () => ({ entityKind: "database", target: tasksId, properties: { name: "" } }), "properties"],
      [
        "a name over 500 characters",
        () => ({ entityKind: "database", target: tasksId, properties: { name: longName } }),
        "properties",
      ],
      [
        "a date that is not a calendar date",
        () => ({ entityKind: "database", target: tasksId, properties: { name: "X", date: "20.11.2026" } }),
        "properties",
      ],
      [
        "a date that is not a string",
        () => ({ entityKind: "database", target: tasksId, properties: { name: "X", date: 20261120 } }),
        "properties",
      ],
      [
        "another target",
        () => ({ entityKind: "database", target: eventsDatabaseId, properties: { name: "X" } }),
        "target",
      ],
      [
        "a target that is not a database id",
        () => ({ entityKind: "database", target: "not-a-database", properties: { name: "X" } }),
        "target",
      ],
      [
        "the page content entity kind",
        () => ({ entityKind: "pageContent", target: tasksId, properties: { flavour: "paragraph" } }),
        "entityKind",
      ],
      [
        "the relation entity kind",
        () => ({ entityKind: "relation", target: randomUUID(), properties: { propertyKey: "tasks" } }),
        "entityKind",
      ],
    ];
    it.each(invalidRevisions)(
      "revise rejects %s with a validation error and writes nothing",
      async (_name, input, field) => {
        const { thread } = await newConversation();
        const card = await createThreadCard(thread.itemId, { name: "Pay the invoice" });
        const before = await readCard(card.id);

        const error = await revise(card.id, input()).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toMatchObject({ code: "validation_failed", details: { field } });
        expect(await readCard(card.id)).toEqual(before);
        expect((await writtenState()).tasks).toEqual([]);
      },
    );

    it.each([
      [
        "a relations entry",
        { entityKind: "database", target: "$tasks", properties: { name: "X" }, relations: {} },
        "relations",
      ],
      [
        "another property",
        { entityKind: "database", target: "$tasks", properties: { name: "X", status: "done" } },
        "properties",
      ],
      ["another target", { entityKind: "database", target: "$events", properties: { name: "X" } }, "target"],
      [
        "another entity kind",
        { entityKind: "relation", target: randomUUID(), properties: { propertyKey: "tasks" } },
        "entityKind",
      ],
      [
        "a list of steps",
        {
          entityKind: "database",
          target: "$tasks",
          properties: { name: "X" },
          operations: [
            { ref: "primary", role: "primary", op: "create", databaseKey: "tasks", properties: { name: "X" } },
          ],
        },
        "operations",
      ],
    ])(
      "confirm rejects a stored envelope with %s with a validation error and writes nothing",
      async (_name, stored, field) => {
        const { thread } = await newConversation();
        const card = await createThreadCard(thread.itemId, { name: "Pay the invoice" });
        await setStoredProperty(
          card.id,
          "proposal",
          JSON.parse(JSON.stringify(stored).replace("$tasks", tasksId).replace("$events", eventsDatabaseId)),
        );
        const before = await writtenState();

        const error = await confirm(card.id).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toMatchObject({ code: "validation_failed", details: { field } });
        expect(await writtenState()).toEqual(before);
        expect((await readCard(card.id)).properties.status).toBe("proposed");
      },
    );

    const deleteThread = (threadItemId: string) =>
      scoped(async (client) =>
        itemDeleteWithClient(client, await databaseIdFor("threads"), threadItemId, {
          queueAffinity: createActionQueueAffinity(),
        }),
      );
    async function expectSourceThreadRefused(cardId: string): Promise<void> {
      const before = { card: await readCard(cardId), written: await writtenState() };

      const revised = await revise(cardId, {
        entityKind: "database",
        target: tasksId,
        properties: { name: "Pay it" },
      }).catch((e: unknown) => e);
      const confirmed = await confirm(cardId).catch((e: unknown) => e);

      for (const error of [revised, confirmed]) {
        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toMatchObject({ code: "validation_failed", details: { field: "sourceThread" } });
      }
      expect({ card: await readCard(cardId), written: await writtenState() }).toEqual(before);
      expect(before.written.tasks).toEqual([]);
    }

    it("revise and confirm refuse a card without a sourceThread edge, naming sourceThread", async () => {
      await expectSourceThreadRefused((await createThreadCard(null, { name: "Pay the invoice" })).id);
    });

    it("confirm answers 409 conflict and writes nothing when the source thread was deleted, and the card stays proposed", async () => {
      const { thread } = await newConversation();
      const card = await createThreadCard(thread.itemId, { name: "Pay the invoice" });
      await deleteThread(thread.itemId);
      const before = await writtenState();

      const error = await confirm(card.id).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({ status: 409, code: "conflict", details: { field: "sourceThread" } });
      expect(await writtenState()).toEqual(before);
      expect(before.tasks).toEqual([]);
      expect((await readCard(card.id)).properties.status).toBe("proposed");
    });

    it("a card whose source thread was purged from the Trash has lost its sourceThread edge, so revise and confirm answer the sourceThread validation error and write nothing", async () => {
      const { thread } = await newConversation();
      const card = await createThreadCard(thread.itemId, { name: "Pay the invoice" });
      await deleteThread(thread.itemId);
      expect(await runInTenant(getTenantZeroId(), () => purgeExpiredTrash(pool, storage, 0))).toBeGreaterThan(0);
      expect(await relatedIds("processingProposals", "sourceThread", card.id)).toEqual([]);

      await expectSourceThreadRefused(card.id);
    });

    it("the confirm function answers 409 conflict and writes nothing for a thread item whose row the lock does not find", async () => {
      const before = await writtenState();

      const error = await scoped((client) =>
        confirmMailThreadCard(client, randomUUID(), { name: "Pay the invoice" }),
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({ status: 409, code: "conflict", details: { field: "sourceThread" } });
      expect(await writtenState()).toEqual(before);
      expect(before.tasks).toEqual([]);
    });

    it("the merge of two threads moves the card's sourceThread edge, so the card of the merged-away thread confirms for the survivor", async () => {
      const newBareThread = (subject: string) =>
        scoped(async (client) => {
          const created = await createMailThread(client, subject);
          const { rows } = await client.query<{ item_id: string }>("SELECT item_id FROM mail_threads WHERE id = $1", [
            created.id,
          ]);
          if (!rows[0]) throw new Error("Missing thread item");
          return { threadId: created.id, itemId: rows[0].item_id };
        });
      const loser = await newBareThread("Losing");
      const winner = await newBareThread("Winning");
      const loserCard = await createThreadCard(loser.itemId, { name: "Reply to the loser" });
      await scoped((client) => reassignThread(client, loser.threadId, winner.threadId));
      expect(await relatedIds("processingProposals", "sourceThread", loserCard.id)).toEqual([winner.itemId]);

      const taskId = z.string().parse((await confirm(loserCard.id)).properties.resultItemId);

      expect(await relatedIds("threads", "tasks", winner.itemId)).toEqual([taskId]);
    });

    it("a repeated confirm returns the confirmed card and creates nothing twice", async () => {
      const { thread } = await newConversation();
      const card = await createThreadCard(thread.itemId, { name: "Pay the invoice" });
      const first = await confirm(card.id);
      const afterFirst = await writtenState();

      const second = await confirm(card.id);

      expect(second.properties.resultItemId).toBe(first.properties.resultItemId);
      expect(second.updatedAt).toBe(first.updatedAt);
      expect(await writtenState()).toEqual(afterFirst);
      expect(afterFirst.tasks).toHaveLength(1);
    });

    it("confirm refuses a credential on a thread task card and writes nothing", async () => {
      const { thread } = await newConversation();
      const card = await createThreadCard(thread.itemId, { name: "Pay the invoice" });
      const before = await writtenState();

      const error = await confirm(card.id, { credentialType: "api_key", plaintext: "secret" }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ details: { field: "credential" } });
      expect(await writtenState()).toEqual(before);
      expect((await readCard(card.id)).properties.status).toBe("proposed");
    });

    it("reject locks the card as rejected without writing a task, and a rejected card cannot be confirmed", async () => {
      const { thread } = await newConversation();
      const card = await createThreadCard(thread.itemId, { name: "Pay the invoice" });
      const before = await writtenState();

      const rejected = await scoped((client) => rejectProposalWithClient(client, config(), card.id));

      expect(rejected.properties.status).toBe("rejected");
      expect(await writtenState()).toEqual(before);
      await expect(confirm(card.id)).rejects.toThrow(/Cannot confirm a proposal in status 'rejected'/);
      expect((await writtenState()).tasks).toEqual([]);
    });

    it("an Inbox card confirms as before: through the generic item create, with an Inbox origin and no thread edge", async () => {
      const proposal = await createDatabaseProposal("Buy milk");

      const confirmed = await confirm(proposal.id);

      const taskId = z.string().parse(confirmed.properties.resultItemId);
      const origins = await pool.query<{ capture_channel: string }>(
        "SELECT capture_channel FROM item_origins WHERE item_id = $1",
        [taskId],
      );
      expect(origins.rows).toEqual([{ capture_channel: "inbox" }]);
      const edges = await pool.query("SELECT 1 FROM item_relations WHERE item_a = $1 OR item_b = $1", [taskId]);
      expect(edges.rowCount).toBe(0);
    });
  });

  describe("journal entry proposals (issues gh-1975 and gh-1981)", () => {
    const PAGE_LINK = "[Sub page](semprec://page/00000000-0000-4000-8000-000000000001)";
    let journalId: string;
    let areasId: string;
    let projectsId: string;

    beforeEach(async () => {
      journalId = await databaseIdFor("journal");
      areasId = await databaseIdFor("areas");
      projectsId = await databaseIdFor("projects");
    });

    async function createLiveItem(databaseId: string, name: string): Promise<ItemRow> {
      return withTransaction(pool, (client) => createItemWithClient(client, { databaseId, properties: { name } }));
    }

    async function trash(databaseId: string, itemId: string): Promise<void> {
      await withTransaction(pool, (client) =>
        itemDeleteWithClient(client, databaseId, itemId, { queueAffinity: createActionQueueAffinity() }),
      );
    }

    async function archive(databaseId: string, itemId: string): Promise<void> {
      await runInTenant(getTenantZeroId(), () =>
        withTransaction(pool, (client) =>
          updateItemWithClient(client, { databaseId, itemId, propertiesPatch: { status: "archived" } }),
        ),
      );
    }

    function entry(properties: Record<string, unknown> = {}, target = journalId): ProposalEnvelope {
      return {
        entityKind: "journalEntry",
        target,
        properties: { date: "2026-10-16", markdown: "Went for a run.", ...properties },
      };
    }

    function entryWithout(key: "date" | "markdown"): ProposalEnvelope {
      const { [key]: _removed, ...rest } = entry().properties;
      return { ...entry(), properties: rest };
    }

    function tickWrite(envelope: ProposalEnvelope) {
      return withTransaction(pool, (client) => assertValidProposalEnvelope(client, envelope));
    }

    function revise(cardId: string, envelope: ProposalEnvelope) {
      return reviseCard(cardId, {
        entityKind: envelope.entityKind,
        target: envelope.target,
        properties: envelope.properties,
        ...(envelope.relations === undefined ? {} : { relations: envelope.relations }),
      });
    }

    /** Counts of what a confirm of a Journal entry could write, for asserting that nothing was. */
    async function writtenState() {
      const count = async (sql: string, params: unknown[] = []) =>
        (await pool.query<{ n: number }>(sql, params)).rows[0]?.n;
      return {
        journalItems: await count("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [journalId]),
        docs: await count("SELECT count(*)::int AS n FROM docs"),
        docUpdates: await count("SELECT count(*)::int AS n FROM doc_updates"),
        edges: await count("SELECT count(*)::int AS n FROM item_relations"),
      };
    }

    async function areaAndProject(): Promise<ProposalEnvelope> {
      const area = await createLiveItem(areasId, "Health");
      const project = await createLiveItem(projectsId, "Website");
      return entry({ areaId: area.id, projectId: project.id });
    }

    const refusal = (field: string, code?: string) => ({
      status: 400,
      details: { field, ...(code === undefined ? {} : { code }) },
    });

    describe("validation of the envelope, when the tick writes it and when revise supplies it", () => {
      const inTrash = (databaseId: () => string, field: "areaId" | "projectId") => async () => {
        const item = await createLiveItem(databaseId(), "Old");
        await trash(databaseId(), item.id);
        return entry({ [field]: item.id });
      };
      const INVALID: ReadonlyArray<
        readonly [label: string, build: () => ProposalEnvelope | Promise<ProposalEnvelope>, field: string]
      > = [
        ["no markdown", () => entryWithout("markdown"), "markdown"],
        ["an empty markdown", () => entry({ markdown: "" }), "markdown"],
        ["a blank markdown", () => entry({ markdown: " \n  " }), "markdown"],
        ["a markdown that is not a string", () => entry({ markdown: 5 }), "markdown"],
        ["a page block", () => entry({ markdown: `A line\n\n${PAGE_LINK}` }), "markdown"],
        ["no date", () => entryWithout("date"), "date"],
        ["a date that is not a string", () => entry({ date: 20261016 }), "date"],
        ["a date that is not a calendar day", () => entry({ date: "2026-02-30" }), "date"],
        ["a date in another format", () => entry({ date: "16.10.2026" }), "date"],
        ["a date with a time", () => entry({ date: "2026-10-16T08:00:00Z" }), "date"],
        ["an unknown property", () => entry({ mood: "good" }), "mood"],
        ["an areaId that is not an id", () => entry({ areaId: "area" }), "areaId"],
        ["a projectId that is not an id", () => entry({ projectId: "project" }), "projectId"],
        ["an areaId that names no item", () => entry({ areaId: randomUUID() }), "areaId"],
        ["a projectId that names no item", () => entry({ projectId: randomUUID() }), "projectId"],
        [
          "an areaId that is a Projects item",
          async () => entry({ areaId: (await createLiveItem(projectsId, "Website")).id }),
          "areaId",
        ],
        [
          "a projectId that is an Areas item",
          async () => entry({ projectId: (await createLiveItem(areasId, "Health")).id }),
          "projectId",
        ],
        ["an areaId that is in the Trash", inTrash(() => areasId, "areaId"), "areaId"],
        ["a projectId that is in the Trash", inTrash(() => projectsId, "projectId"), "projectId"],
        [
          "a projectId that is archived, which the day's edge could not point at",
          async () => {
            const project = await createLiveItem(projectsId, "Shelved project");
            await archive(projectsId, project.id);
            return entry({ projectId: project.id });
          },
          "projectId",
        ],
        ["a target that is another database", () => entry({}, tasksId), "target"],
        ["a target that is not an id", () => entry({}, "journal"), "target"],
        ["an area together with a project (issue gh-1991)", areaAndProject, "area"],
      ];

      it.each(INVALID)("refuses %s when the tick writes it", async (_label, build, field) => {
        const error: unknown = await tickWrite(await build()).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toMatchObject(refusal(field, field === "area" ? "derivedRelation" : undefined));
      });

      it.each(INVALID)(
        "refuses %s when revise supplies it, and leaves the card as it was",
        async (_label, build, field) => {
          const card = await createDatabaseProposal("Buy milk");
          const before = await readCard(card.id);

          const error: unknown = await revise(card.id, await build()).catch((e: unknown) => e);

          expect(error).toBeInstanceOf(ValidationError);
          expect(error).toMatchObject(refusal(field, field === "area" ? "derivedRelation" : undefined));
          expect(await readCard(card.id)).toEqual(before);
        },
      );

      it("refuses steps and relations, which a journal entry has none of", async () => {
        const card = await createDatabaseProposal("Buy milk");
        const step = { ref: "primary", op: "create" as const, role: "primary" as const, databaseKey: "journal" };

        await expect(tickWrite({ ...entry(), operations: [step] })).rejects.toMatchObject(refusal("operations"));
        await expect(tickWrite({ ...entry(), relations: { areas: [] } })).rejects.toMatchObject(refusal("relations"));
        await expect(revise(card.id, { ...entry(), relations: { areas: [] } })).rejects.toMatchObject(
          refusal("relations"),
        );
      });

      it("accepts a date with a Markdown body alone, with several blocks, with an area alone and with a project alone", async () => {
        const area = await createLiveItem(areasId, "Health");
        const project = await createLiveItem(projectsId, "Website");
        const markdown = "# Evening\n\n- ran 5 km\n- called the bank\n\nA closing thought.";

        for (const properties of [{}, { markdown }, { areaId: area.id }, { projectId: project.id }]) {
          const card = await createDatabaseProposal("Buy milk");
          expect(await tickWrite(entry(properties))).toBeNull();
          const revised = await revise(card.id, entry(properties));
          expect(revised.properties.status).toBe("proposed");
          expect(revised.properties.proposal).toEqual(entry(properties));
          expect(revised.properties.aiProposal).toEqual(entry(properties));
        }
      });

      it("refuses an area together with a project at confirm for a card that already holds it, and nothing is written", async () => {
        const card = await createDatabaseProposal("Buy milk");
        // Stored without checks: revise can no longer produce this pair.
        await setStoredProperty(card.id, "proposal", await areaAndProject());
        const before = await writtenState();

        const error: unknown = await confirmCard(card.id).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toMatchObject(refusal("area", "derivedRelation"));
        expect(await writtenState()).toEqual(before);
        expect((await readCard(card.id)).properties.status).toBe("proposed");
      });

      it("revise replaces a stored journal entry, a changed date and markdown included, and refuses one without a date", async () => {
        const card = await createDatabaseProposal("Buy milk");
        await revise(card.id, entry());
        const before = await readCard(card.id);

        const error: unknown = await revise(card.id, entryWithout("date")).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toMatchObject(refusal("date"));
        expect(await readCard(card.id)).toEqual(before);
        expect(before.properties.proposal).toEqual(entry());

        const revised = await revise(card.id, entry({ date: "2026-10-17", markdown: "A different day." }));
        expect(revised.properties.proposal).toEqual(entry({ date: "2026-10-17", markdown: "A different day." }));
        const stored = await readCard(card.id);
        expect(stored.properties.proposal).toEqual(revised.properties.proposal);
        expect(stored.properties.aiProposal).toEqual(stored.properties.proposal);
      });

      it("the stored card still validates for the tick's recheck, and stops validating once its project is deleted", async () => {
        const project = await createLiveItem(projectsId, "Website");
        const card = await createDatabaseProposal("Buy milk");
        const revised = await revise(card.id, entry({ projectId: project.id }));
        const stillValid = () => withTransaction(pool, (client) => storedEnvelopeStillValid(client, revised));
        expect(await stillValid()).toBe(true);

        await trash(projectsId, project.id);

        expect(await stillValid()).toBe(false);
      });
    });

    it("refuses a journal entry on a transcript card with a ValidationError on entityKind and leaves the card as it was", async () => {
      const cardId = await createTranscriptCard();
      const before = await readCard(cardId);

      const error: unknown = await revise(cardId, entry()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject(refusal("entityKind"));
      expect(await readCard(cardId)).toEqual(before);
    });

    describe("confirming a journal entry (issue gh-1981)", () => {
      const DAY = "2026-10-16";

      async function dayItemId(day: string): Promise<string | null> {
        const { rows } = await pool.query<{ id: string }>(
          "SELECT id FROM items WHERE database_id = $1 AND properties->>'type' = 'day' AND properties->>'period' = $2",
          [journalId, day],
        );
        return rows[0]?.id ?? null;
      }
      const theDay = async () => (await dayItemId(DAY)) ?? "";

      async function dayCount(day: string): Promise<number> {
        const { rows } = await pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM items WHERE database_id = $1 AND properties->>'type' = 'day' AND properties->>'period' = $2 AND deleted_at IS NULL",
          [journalId, day],
        );
        return rows[0]?.n ?? 0;
      }

      async function pageBlockIds(itemId: string): Promise<string[]> {
        return withTransaction(pool, async (client) => {
          const row = await getDocByItemId(client, itemId);
          if (!row) return [];
          const doc = await loadDocWithClient(client, row.id);
          try {
            return readPageBlocks(doc).flatMap((block) => (block.synthetic || block.id === null ? [] : [block.id]));
          } finally {
            doc.destroy();
          }
        });
      }

      async function edgesOf(itemId: string): Promise<Array<{ key: string; other: string }>> {
        const { rows } = await pool.query<{ key: string; other: string }>(
          `SELECT p.key, CASE WHEN r.item_a = $1 THEN r.item_b ELSE r.item_a END AS other
             FROM item_relations r
             JOIN relation_definitions d ON d.id = r.relation_definition_id
             JOIN properties p ON p.id = d.property_id_a OR p.id = d.property_id_b
            WHERE (r.item_a = $1 OR r.item_b = $1) AND p.database_id = $2`,
          [itemId, journalId],
        );
        return rows;
      }

      async function journalCard(envelope: ProposalEnvelope = entry()): Promise<ItemRow> {
        const card = await createDatabaseProposal("Buy milk");
        await revise(card.id, envelope);
        return readCard(card.id);
      }

      /** The day with blocks written by an agent, as an earlier entry of the day would leave it. */
      async function dayWithBlocks(day: string, markdown: string): Promise<{ itemId: string; blockIds: string[] }> {
        const itemId = await withTransaction(pool, async (client) => {
          const ensured = await ensureJournalPeriodDoc(client, "day", day);
          await insertPageMarkdown(client, ensured.itemId, { placement: "end", markdown, origin: "ai_agent" });
          return ensured.itemId;
        });
        return { itemId, blockIds: await pageBlockIds(itemId) };
      }

      it("creates the day, its page and the entry, authored by the user and without an origin note, for a date that has no day yet", async () => {
        const card = await journalCard(entry({ markdown: "Went for a run.\n\nFelt good." }));
        expect(await dayItemId(DAY)).toBeNull();

        const confirmed = await confirmCard(card.id);

        expect(confirmed.properties.status).toBe("confirmed");
        const itemId = await dayItemId(DAY);
        if (itemId === null) throw new Error("The day was not created");
        expect(confirmed.properties.resultItemId).toBe(itemId);
        expect(confirmed.properties.resultLabel).toBe(DAY);
        const page = await withTransaction(pool, (client) => readPageMarkdown(client, itemId));
        expect(page.markdown).toBe("Went for a run.\n\nFelt good.");
        expect(await pageBlockIds(itemId)).toEqual([proposalBlockId(card.id, 0), proposalBlockId(card.id, 1)]);
        expect(await docUpdateAuthors(itemId)).toEqual(["user"]);
      });

      it("appends the entry after the blocks the day already has, keeps their order and authors it as the user", async () => {
        const existing = await dayWithBlocks(DAY, "Morning.\n\nNoon.");
        expect(existing.blockIds).toHaveLength(2);
        const card = await journalCard(entry({ markdown: "Evening." }));

        const confirmed = await confirmCard(card.id);

        expect(confirmed.properties.resultItemId).toBe(existing.itemId);
        expect(await pageBlockIds(existing.itemId)).toEqual([...existing.blockIds, proposalBlockId(card.id, 0)]);
        const page = await withTransaction(pool, (client) => readPageMarkdown(client, existing.itemId));
        expect(page.markdown).toBe("Morning.\n\nNoon.\n\nEvening.");
        expect(await dayCount(DAY)).toBe(1);
        expect(await docUpdateAuthors(existing.itemId)).toEqual(["ai_agent", "user"]);
      });

      it("persists the inserted block ids exactly in the primary result, without the blocks the day already had", async () => {
        const existing = await dayWithBlocks(DAY, "Morning.");
        const card = await journalCard(entry({ markdown: "Evening.\n\n- ran\n- read" }));

        const confirmed = await confirmCard(card.id);

        const inserted = [0, 1, 2].map((index) => proposalBlockId(card.id, index));
        expect(resultBlockIds(confirmed)).toEqual(inserted);
        expect(await pageBlockIds(existing.itemId)).toEqual([...existing.blockIds, ...inserted]);
        const stored = await readCard(card.id);
        expect(resultBlockIds(stored)).toEqual(inserted);
        expect(readConfirmationResults(stored.properties)).toEqual([
          expect.objectContaining({
            ref: "primary",
            role: "primary",
            itemId: existing.itemId,
            databaseKey: "journal",
            date: DAY,
            followUp: null,
            linkLabels: [],
          }),
        ]);
      });

      it("returns the stored result for a card that is already confirmed and writes nothing", async () => {
        const card = await journalCard(entry({ markdown: "One.\n\nTwo." }));
        const first = await confirmCard(card.id);
        const itemId = await theDay();
        const before = await writtenState();
        const updatesBefore = await docUpdateAuthors(itemId);

        const second = await confirmCard(card.id);

        expect(second.properties.status).toBe("confirmed");
        expect(second.properties.resultItemId).toBe(first.properties.resultItemId);
        expect(second.properties.resultLabel).toBe(first.properties.resultLabel);
        expect(second.properties.results).toEqual(first.properties.results);
        expect(second.updatedAt).toBe(first.updatedAt);
        expect(await writtenState()).toEqual(before);
        expect(await docUpdateAuthors(itemId)).toEqual(updatesBefore);
        expect(await pageBlockIds(itemId)).toHaveLength(2);
      });

      it("refuses to write the entry of a proposal a second time, so its blocks cannot be added twice", async () => {
        const card = await journalCard(entry({ markdown: "One.\n\nTwo." }));
        const confirmed = await confirmCard(card.id);
        const itemId = await theDay();
        const before = await writtenState();

        // The write itself, past the card's confirmed status, which is what makes a replayed confirm a no-op.
        const error: unknown = await withTransaction(pool, (client) =>
          confirmJournalEntry(client, card.id, entry(), { writerKind: "user" }, undefined),
        ).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ConflictError);
        expect(await pageBlockIds(itemId)).toEqual(resultBlockIds(confirmed));
        expect(await writtenState()).toEqual(before);
      });

      it("adds the entry once when two confirms of the same card run at the same time", async () => {
        const card = await journalCard(entry({ markdown: "One.\n\nTwo." }));

        const [first, second] = await Promise.all([confirmCard(card.id), confirmCard(card.id)]);

        expect(first.properties.resultItemId).toBe(second.properties.resultItemId);
        expect(first.properties.results).toEqual(second.properties.results);
        const itemId = await theDay();
        expect(await pageBlockIds(itemId)).toEqual([proposalBlockId(card.id, 0), proposalBlockId(card.id, 1)]);
        expect(await dayCount(DAY)).toBe(1);
        expect(await docUpdateAuthors(itemId)).toEqual(["user"]);
      });

      describe("relations of the day", () => {
        it.each([
          ["a project edge and no area edge of its own when the entry names a project", "project"],
          ["an area edge when the entry names only an area", "area"],
          ["no edge when the entry names neither", null],
        ] as const)("gives the day %s", async (_label, key) => {
          const linked = key === null ? null : await createLiveItem(key === "project" ? projectsId : areasId, "Linked");
          const card = await journalCard(linked && key ? entry({ [`${key}Id`]: linked.id }) : entry());

          await confirmCard(card.id);

          expect(await edgesOf(await theDay())).toEqual(linked && key ? [{ key, other: linked.id }] : []);
        });

        it("records the edge in the history entry of the confirmation, as inserted or as found, and never duplicates it", async () => {
          const project = await createLiveItem(projectsId, "Website");
          const first = await journalCard(entry({ projectId: project.id, markdown: "First." }));
          const second = await journalCard(entry({ projectId: project.id, markdown: "Second." }));
          const written = async (cardId: string) => {
            const history = z
              .array(z.object({ writtenRelations: z.array(z.unknown()).optional() }))
              .parse((await readCard(cardId)).properties.history);
            return history.at(-1)?.writtenRelations;
          };

          await confirmCard(first.id);
          await confirmCard(second.id);
          await confirmCard(second.id);

          const itemId = await theDay();
          expect(await written(first.id)).toEqual([
            expect.objectContaining({ callerItemId: itemId, targetItemId: project.id, previousMetadata: null }),
          ]);
          // The second entry found the day's edge, so the undo of it must leave the edge.
          expect(await written(second.id)).toEqual([
            expect.objectContaining({ callerItemId: itemId, targetItemId: project.id, previousMetadata: {} }),
          ]);
          expect(await edgesOf(itemId)).toEqual([{ key: "project", other: project.id }]);
          expect(await pageBlockIds(itemId)).toEqual([proposalBlockId(first.id, 0), proposalBlockId(second.id, 0)]);
        });
      });

      describe("when something it needs is gone, the answer is 409 and nothing is written", () => {
        it.each([
          ["a project in the Trash", "projectId", "trash"],
          ["an area in the Trash", "areaId", "trash"],
          [
            "a project archived since the card was computed, which the edge write would refuse with a 400",
            "projectId",
            "archive",
          ],
        ] as const)("%s", async (_label, field, removal) => {
          const gone = await createLiveItem(field === "projectId" ? projectsId : areasId, "Gone");
          const card = await journalCard(entry({ [field]: gone.id }));
          await (removal === "trash" ? trash : archive)(gone.databaseId, gone.id);
          const before = await readCard(card.id);
          const written = await writtenState();

          const error: unknown = await confirmCard(card.id).catch((e: unknown) => e);

          expect(error).toBeInstanceOf(ConflictError);
          expect(error).toMatchObject({ status: 409, details: { field } });
          expect(await readCard(card.id)).toEqual(before);
          expect(await writtenState()).toEqual(written);
          expect(await dayItemId(DAY)).toBeNull();
        });

        it("a Journal database that is no longer the card's target", async () => {
          const card = await journalCard();
          // Stored without revise's checks: only an older card can hold a stale target.
          await setStoredProperty(card.id, "proposal", { ...entry(), target: tasksId });
          const written = await writtenState();

          const error: unknown = await confirmCard(card.id).catch((e: unknown) => e);

          expect(error).toBeInstanceOf(ConflictError);
          expect(error).toMatchObject({ status: 409, details: { field: "target" } });
          expect((await readCard(card.id)).properties.status).toBe("proposed");
          expect(await writtenState()).toEqual(written);
        });
      });

      describe("when a step of the confirm fails, the card stays proposed and no part of the entry remains", () => {
        const CONFIRMED = "NEW.properties ->> 'status' = 'confirmed'";

        it.each([
          ["its edge write", "item_relations", "INSERT", "TRUE"],
          ["the write of the card's confirmed status", "items", "UPDATE", CONFIRMED],
        ] as const)("fails at %s", async (_label, table, event, condition) => {
          const project = await createLiveItem(projectsId, "Website");
          const existing = await dayWithBlocks(DAY, "Morning.");
          const card = await journalCard(entry({ projectId: project.id, markdown: "Evening." }));
          const before = await readCard(card.id);
          const written = await writtenState();

          await withFailingTrigger(table, event, condition, async () => {
            await expect(confirmCard(card.id)).rejects.toThrow(/test trigger failure/);
          });

          expect(await readCard(card.id)).toEqual(before);
          expect(await writtenState()).toEqual(written);
          expect(await pageBlockIds(existing.itemId)).toEqual(existing.blockIds);
          expect(await edgesOf(existing.itemId)).toEqual([]);
        });

        it("fails after creating a day that did not exist, and leaves no day", async () => {
          const card = await journalCard();
          const before = await readCard(card.id);
          const written = await writtenState();

          await withFailingTrigger("items", "UPDATE", CONFIRMED, async () => {
            await expect(confirmCard(card.id)).rejects.toThrow(/test trigger failure/);
          });

          expect(await readCard(card.id)).toEqual(before);
          expect(await dayItemId(DAY)).toBeNull();
          expect(await writtenState()).toEqual(written);
        });
      });

      it("confirms in the tenant's own scope through the runtime role, and answers another tenant's project as a project that does not exist", async () => {
        const own = getTenantZeroId();
        const ownCard = await journalCard(entry({ markdown: "Own entry." }));
        const foreignCard = await journalCard(entry({ markdown: "Foreign reference." }));
        const randomCard = await journalCard(entry({ markdown: "Random reference." }));
        await withRuntimePool(async (runtime) => {
          const other = await createTestTenant(pool);
          await runInTenant(other, () => seedSystem(runtime, createViewTypeRegistry()));
          const foreignProject = await runInTenant(other, () =>
            withTransaction(runtime, async (client) => {
              const database = await databasesStore.getDatabaseByModuleId(client, "projects");
              if (!database) throw new Error("Projects was not seeded");
              return createItemWithClient(client, { databaseId: database.id, properties: { name: "Foreign project" } });
            }),
          );
          // Stored without revise's checks: only an older card can hold a stale reference.
          for (const [card, projectId] of [
            [foreignCard, foreignProject.id],
            [randomCard, randomUUID()],
          ] as const) {
            await setStoredProperty(card.id, "proposal", entry({ projectId, markdown: "Stale." }));
          }
          const confirmAs = (cardId: string) =>
            runInTenant(own, () =>
              withTransaction(runtime, (client) => confirmProposalWithClient(client, config(), cardId)),
            );

          const foreignError: unknown = await confirmAs(foreignCard.id).catch((e: unknown) => e);
          const randomError: unknown = await confirmAs(randomCard.id).catch((e: unknown) => e);
          const confirmed = await confirmAs(ownCard.id);

          expect(foreignError).toBeInstanceOf(ConflictError);
          expect(errorShape(foreignError)).toEqual(errorShape(randomError));
          expect(errorShape(foreignError).field).toBe("projectId");
          expect(confirmed.properties.status).toBe("confirmed");
        });
        expect(await dayCount(DAY)).toBe(1);
        const itemId = await theDay();
        expect(await edgesOf(itemId)).toEqual([]);
        expect(await pageBlockIds(itemId)).toEqual([proposalBlockId(ownCard.id, 0)]);
      });
    });

    it("answers another tenant's area, project and Journal database exactly as a random id, through the runtime role", async () => {
      await withRuntimePool(async (runtime) => {
        const own = getTenantZeroId();
        const other = await createTestTenant(pool);
        await runInTenant(other, () => seedSystem(runtime, createViewTypeRegistry()));
        const inScope = <T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> =>
          runInTenant(tenantId, () => withTransaction(runtime, fn));
        const moduleDatabaseId = (tenantId: string, moduleId: string) =>
          inScope(tenantId, async (client) => {
            const database = await databasesStore.getDatabaseByModuleId(client, moduleId);
            if (!database) throw new Error(`Database '${moduleId}' was not seeded`);
            return database.id;
          });
        const createInTenant = (tenantId: string, moduleId: string, name: string) =>
          inScope(tenantId, async (client) =>
            createItemWithClient(client, {
              databaseId: await moduleDatabaseId(tenantId, moduleId),
              properties: { name },
            }),
          );
        const foreignArea = await createInTenant(other, "areas", "Foreign area");
        const foreignProject = await createInTenant(other, "projects", "Foreign project");
        const ownArea = await createInTenant(own, "areas", "Own area");
        const ownJournalId = await moduleDatabaseId(own, "journal");
        const foreignJournalId = await moduleDatabaseId(other, "journal");
        const check = (envelope: ProposalEnvelope) =>
          inScope(own, (client) => assertValidProposalEnvelope(client, envelope)).catch((e: unknown) => e);
        const shape = async (envelope: ProposalEnvelope) => {
          const error = await check(envelope);
          expect(error).toBeInstanceOf(ValidationError);
          return errorShape(error);
        };

        expect(await shape(entry({ areaId: foreignArea.id }, ownJournalId))).toEqual(
          await shape(entry({ areaId: randomUUID() }, ownJournalId)),
        );
        expect(await shape(entry({ projectId: foreignProject.id }, ownJournalId))).toEqual(
          await shape(entry({ projectId: randomUUID() }, ownJournalId)),
        );
        expect(await shape(entry({}, foreignJournalId))).toEqual(await shape(entry({}, randomUUID())));
        expect((await shape(entry({ areaId: foreignArea.id }, ownJournalId))).field).toBe("areaId");
        // The same envelope with the tenant's own area is accepted, so the refusals above are about the tenant.
        expect(await check(entry({ areaId: ownArea.id }, ownJournalId))).toBeNull();
      });
    });
  });

  describe("an MCP server card queues the sync of its tools (issue gh-1976)", () => {
    const serverProperties = {
      name: "Remote tool",
      connectionConfig: { transport: "http", url: "https://mcp.example.com/mcp" },
    };
    let actingUserId: string;
    let mcpServersId: string;

    beforeEach(async () => {
      mcpServersId = await databaseIdFor("mcpServers");
      actingUserId = (
        await createUser(pool, {
          email: "owner@example.test",
          passwordHash: "unused",
          tenantId: getTenantZeroId(),
          role: "admin",
        })
      ).id;
    });

    const serverCard = (properties: Record<string, unknown> = serverProperties) =>
      storeCard({ entityKind: "database", target: mcpServersId, properties });
    /** The confirm route's tenant scope: the job envelope takes the tenant from it. */
    const confirmAs = (
      cardId: string,
      user: string | undefined,
      credential?: Parameters<typeof confirmProposalWithClient>[3],
    ) => scoped((client) => confirmProposalWithClient(client, config(), cardId, credential, user));
    async function queuedSyncs(): Promise<Array<{ key: string | null; payload: Record<string, unknown> }>> {
      const { rows } = await pool.query<{ key: string | null; payload: { payload: Record<string, unknown> } }>(
        // The public `jobs` view has no payload column.
        `SELECT j.key, j.payload FROM graphile_worker._private_jobs j
           JOIN graphile_worker._private_tasks t ON t.id = j.task_id
          WHERE t.identifier = 'mcpServerSync' ORDER BY j.key`,
      );
      return rows.map((row) => ({ key: row.key, payload: row.payload.payload }));
    }
    const resultsOf = (card: ItemRow) =>
      z.array(z.object({ followUp: z.string().nullable() }).loose()).parse(card.properties.results);
    const syncJob = (serverId: string) => ({
      key: `mcp-server-sync-${serverId}`,
      payload: { mcpServerItemId: serverId, actingUserId },
    });

    it("queues one job after the commit and reports mcpSyncQueued on the result of the server", async () => {
      const cardId = await serverCard();

      const confirmed = await confirmAs(cardId, actingUserId);

      const serverId = z.string().parse(confirmed.properties.resultItemId);
      expect(await queuedSyncs()).toEqual([syncJob(serverId)]);
      expect(resultsOf(confirmed)).toEqual([expect.objectContaining({ itemId: serverId, followUp: "mcpSyncQueued" })]);
      expect(resultsOf(await readCard(cardId))).toEqual(resultsOf(confirmed));
    });

    it("queues the job for a server confirmed with a credential and keeps the credential out of the payload", async () => {
      const cardId = await serverCard();

      const confirmed = await confirmAs(cardId, actingUserId, {
        credentialType: "api_key",
        plaintext: "sk-never-queued",
      });

      const serverId = z.string().parse(confirmed.properties.resultItemId);
      const queued = await queuedSyncs();
      expect(queued).toEqual([syncJob(serverId)]);
      expect(JSON.stringify(queued)).not.toContain("sk-never-queued");
      expect((await pool.query("SELECT 1 FROM external_credentials WHERE item_id = $1", [serverId])).rowCount).toBe(1);
      expect(resultsOf(confirmed)).toEqual([expect.objectContaining({ followUp: "mcpSyncQueued" })]);
    });

    it("leaves no job, no server, no credential and no result when the confirm rolls back", async () => {
      const cardId = await serverCard();
      const serversBefore = await countIn("mcpServers");

      await expect(
        scoped(async (client) => {
          await confirmProposalWithClient(
            client,
            config(),
            cardId,
            { credentialType: "api_key", plaintext: "sk-rolled-back" },
            actingUserId,
          );
          throw new Error("the transaction fails after the confirm");
        }),
      ).rejects.toThrow("the transaction fails after the confirm");

      expect(await queuedSyncs()).toEqual([]);
      expect(await countIn("mcpServers")).toBe(serversBefore);
      expect((await pool.query("SELECT 1 FROM external_credentials")).rowCount).toBe(0);
      const card = await readCard(cardId);
      expect(card.properties.status).toBe("proposed");
      expect(card.properties.results ?? []).toEqual([]);
    });

    it("leaves no job when the confirm is refused", async () => {
      const cardId = await serverCard({ name: "Remote tool", notAProperty: "x" });

      await expect(confirmAs(cardId, actingUserId)).rejects.toBeInstanceOf(ValidationError);

      expect(await queuedSyncs()).toEqual([]);
    });

    it("leaves one pending job when the same card is confirmed twice, and enqueues nothing for a replay after the job ran", async () => {
      const cardId = await serverCard();
      const first = await confirmAs(cardId, actingUserId);
      const serverId = z.string().parse(first.properties.resultItemId);

      const second = await confirmAs(cardId, actingUserId);

      expect(second.properties.results).toEqual(first.properties.results);
      expect(second.properties.resultItemId).toBe(first.properties.resultItemId);
      expect((await queuedSyncs()).map((job) => job.key)).toEqual([`mcp-server-sync-${serverId}`]);

      await pool.query("SELECT graphile_worker.remove_job($1)", [`mcp-server-sync-${serverId}`]);
      const replay = await confirmAs(cardId, actingUserId);

      expect(replay.properties.results).toEqual(first.properties.results);
      expect(resultsOf(replay)).toEqual([expect.objectContaining({ followUp: "mcpSyncQueued" })]);
      expect(await queuedSyncs()).toEqual([]);
    });

    it("enqueues nothing for a confirm whose target is not the MCP servers database", async () => {
      const card = await createDatabaseProposal("Buy milk");

      const confirmed = await confirmAs(card.id, actingUserId);

      expect(confirmed.properties.status).toBe("confirmed");
      expect(await queuedSyncs()).toEqual([]);
      expect(resultsOf(confirmed)).toEqual([expect.objectContaining({ followUp: null })]);
    });

    it("enqueues nothing without an acting user, creates the server and reports no follow-up", async () => {
      const cardId = await serverCard();

      const confirmed = await confirmAs(cardId, undefined);

      expect(await queuedSyncs()).toEqual([]);
      expect(resultsOf(confirmed)).toEqual([expect.objectContaining({ followUp: null })]);
      expect(await readItem(z.string().parse(confirmed.properties.resultItemId))).toBeDefined();
    });
  });
});

afterAll(async () => {
  await pool?.end();
});
