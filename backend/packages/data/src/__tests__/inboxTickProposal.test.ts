import { z } from "zod";
import { writeBlock } from "@semprec/block-model";
import { mutateDoc } from "../docs/docPersistence.js";
import { createDocStore } from "../docs/docStore.js";
import { getOrCreateJournalItem } from "../journal/journalStore.js";
import {
  buildProposalEnvelope,
  resolveModelPagePlacement,
  type ProposalComputationResult,
  type TickSnapshot,
} from "../inbox/inboxTickSnapshot.js";
import { buildProposalSteps } from "../inbox/proposalOperations.js";
import "../domainWriteHooks.js";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { AiGatewayFailedError, type AiGatewayFailureReason, runInTenant } from "@semprec/shared";
import { createUser } from "../auth/usersStore.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { createInboxTypeWithClient, deleteInboxTypeWithClient } from "../inbox/inboxTypesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import {
  filterRecognitionCandidates,
  recognitionClarificationPatch,
  RECOGNITION_TARGETS,
} from "../inbox/inboxRecognition.js";
import {
  assertRelationTargetLinkableWithClient,
  createRelationWithClient,
  deleteRelationWithClient,
} from "../chokePoint/relationOps.js";
import { createBlob } from "../blobs/blobsStore.js";
import {
  deleteInboxAttachment as deleteWithClient,
  insertInboxAttachments as insertWithClient,
  listInboxAttachments,
} from "../inbox/inboxAttachmentsStore.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { registerItemPreWriteTransform } from "../chokePoint/hooks.js";
import { ValidationError } from "../errors.js";
import { referencedItemIdsOf } from "../inbox/proposalReferences.js";
import {
  aiProposalPatch,
  assertValidProposalEnvelope,
  createSemprecTickAction,
  parseStoredProposalEnvelope,
  readAiProposal,
  type ComputeSemprecProposalFn,
  type ProposalComputationInput,
  type ProposalEnvelope,
  type ProposalStep,
} from "../inbox/inboxTickAction.js";
import {
  confirmProposalWithClient,
  reviseProposalWithClient,
  updateProposalValuesWithClient,
} from "../inbox/proposalActions.js";
import { linkSourceInboxRelation } from "../inbox/inboxCardSourceLink.js";
import { splitInboxSourceWithClient } from "../inbox/proposalSplit.js";

let pool: Pool;
let viewTypeRegistry: ViewTypeRegistry;
let inboxId: string;
let typesId: string;
let proposalsId: string;
let databaseIds: TickDatabaseIds;

// pg 8.23.0 reports these two finite owned-release paths with plain, uncoded errors.
function isOwnedPgClosure(
  error: unknown,
  message: "Connection terminated" | "Client was closed and is not queryable",
): boolean {
  return error instanceof Error && error.constructor === Error && !("code" in error) && error.message === message;
}

function ownOverlap(
  runtime: Pool,
  cancel: () => void,
  onCancellation?: (client: PoolClient, generation: object) => void,
  onGeneration?: (client: PoolClient, generation: object) => void,
) {
  runtime.options.connectionTimeoutMillis = 2500;
  runtime.options.statement_timeout = 5000;
  const active = new Map<PoolClient, object>();
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
      onCancellation?.(client, token);
      client.release(true);
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
    active.delete(client);
    client.removeListener("error", onClientError);
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
    bounded(
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
      "Overlap cleanup timed out",
    );
  const finish = (bodyFailed = false): Promise<void> => {
    if (closingPromise) return closingPromise;
    closing = true;
    clearTimeout(timer);
    const detach = () => {
      runtime.removeListener("acquire", onAcquire);
      runtime.removeListener("release", onRelease);
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
        await bounded(joined, 8000, "Overlap cleanup timed out");
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

async function bounded<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
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
  throw error;
}

const boundedBarrier = <T>(promise: Promise<T>) => bounded(promise, 5000, "Concurrency barrier timed out");

/** A one-shot gate: `reached` signals that a participant arrived, `release` lets it continue. */
function barrier() {
  let release = () => {};
  let reached = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const ready = new Promise<void>((resolve) => (reached = resolve));
  return { gate, ready, release: () => release(), reached: () => reached() };
}

/** Wraps `query` of a client (or pool) while passing every other member through. */
function interceptQuery<T extends object>(
  target: T,
  query: (args: unknown[], original: (...args: unknown[]) => Promise<unknown>) => unknown,
): T {
  return new Proxy(target, {
    get(inner, key, receiver) {
      const value: unknown = Reflect.get(inner, key, receiver);
      if (typeof value !== "function") return value;
      if (key !== "query") return value.bind(inner);
      return (...args: unknown[]) =>
        query(args, (...forwarded) => Reflect.apply(value, inner, forwarded) as Promise<unknown>);
    },
  });
}

/** A pool whose checked-out clients are wrapped by `wrap`. */
function interceptConnect(target: Pool, wrap: (client: PoolClient) => PoolClient): Pool {
  return new Proxy(target, {
    get(inner, key, receiver) {
      if (key === "connect") return async () => wrap(await inner.connect());
      const value: unknown = Reflect.get(inner, key, receiver);
      return typeof value === "function" ? value.bind(inner) : value;
    },
  });
}

const pidOf = async (client: { query: PoolClient["query"] }) =>
  (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;

function insertInboxAttachments(owner: Pool, itemId: string, attachments: Parameters<typeof insertWithClient>[2]) {
  return withTransaction(owner, (client) => insertWithClient(client, itemId, attachments));
}
function deleteInboxAttachment(owner: Pool, id: string) {
  return withTransaction(owner, (client) => deleteWithClient(client, id));
}

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

/**
 * The version 2 fingerprint written out by hand: canonical JSON with keys in code-point order, attachment
 * hashes sorted and `transcribedText` empty. The test does not reuse the production function it checks.
 */
function fingerprintV2Of(input: {
  typeId: string;
  text: string;
  date?: string;
  time?: string;
  attachmentHashes?: string[];
}): string {
  const canonical = JSON.stringify({
    attachmentHashes: [...(input.attachmentHashes ?? [])].sort(),
    date: input.date ?? "2026-08-28",
    text: input.text,
    time: input.time ?? "09:00",
    transcribedText: "",
    typeId: input.typeId,
    v: 2,
  });
  return `v2:${createHash("sha256").update(canonical).digest("hex")}`;
}

type TickDatabaseIds = {
  inboxDatabaseId: string;
  inboxItemTypesDatabaseId: string;
  processingProposalsDatabaseId: string;
};

async function findProposalForItem(tickPool: Pool, proposalsDatabaseId: string, itemId: string) {
  return withTransaction(tickPool, async (client) => {
    const sourceInboxProperty = await propertiesStore.getPropertyByKey(client, proposalsDatabaseId, "sourceInbox");
    const relationDefinition = await relationsStore.getRelationDefinitionByPropertyId(client, sourceInboxProperty!.id);
    // Every edge, not `edges[0]`: as production's `findExistingProposal` does, a soft-deleted proposal still
    // linked to the item is skipped.
    const edges = await relationsStore.listRelationsForItem(client, relationDefinition!.id, itemId);
    for (const edge of edges) {
      const proposal = await itemsStore.getItemById(
        client,
        proposalsDatabaseId,
        relationsStore.otherSide(edge, itemId),
      );
      if (proposal && !proposal.deletedAt) return proposal;
    }
    return null;
  });
}

async function runTick(
  tickPool: Pool,
  ids: TickDatabaseIds,
  itemId: string,
  computeProposal: ComputeSemprecProposalFn,
): Promise<void> {
  const handler = createSemprecTickAction(tickPool, async (input) => {
    const targets = input.recognition
      ? await withTransaction(tickPool, async (client) => {
          const rows = await Promise.all(
            RECOGNITION_TARGETS.map((key) => databasesStore.getDatabaseByModuleId(client, key)),
          );
          return new Map(RECOGNITION_TARGETS.map((key, index) => [key, rows[index]?.id ?? null]));
        })
      : new Map<string, string | null>();
    const result = await computeProposal(input);
    if (!input.recognition || result.recognitionBinding) return result;
    const best = filterRecognitionCandidates(result.candidates, input.activeTypes ?? [])[0];
    if (!best) return result;
    const type = "typeId" in best ? (input.activeTypes?.find((entry) => entry.id === best.typeId) ?? null) : null;
    const targetModuleId = type?.targetDatabaseKey ?? ("targetDatabaseKey" in best ? best.targetDatabaseKey : null);
    return {
      ...result,
      recognitionBinding: {
        candidate: best,
        type,
        targetModuleId,
        targetDatabaseId: targetModuleId ? (targets.get(targetModuleId) ?? null) : null,
      },
    };
  });
  await handler(ids, { heartbeatId: "hb", projectItemId: "proj", itemId });
}

/** Resets the database, seeds the system and points the shared ids at the seeded Inbox databases. */
async function resetTickDatabases(): Promise<void> {
  pool ??= getTestPool();
  viewTypeRegistry = createViewTypeRegistry();
  await resetDatabase(pool);
  await seedSystem(pool, viewTypeRegistry);
  inboxId = await databaseIdFor("inbox");
  typesId = await databaseIdFor("inboxItemTypes");
  proposalsId = await databaseIdFor("processingProposals");
  databaseIds = {
    inboxDatabaseId: inboxId,
    inboxItemTypesDatabaseId: typesId,
    processingProposalsDatabaseId: proposalsId,
  };
}

type TypeInput = Omit<Parameters<typeof createInboxTypeWithClient>[1], "inboxItemTypesDatabaseId">;
const PAGE_TYPE = { name: "Thought", emoji: "💭", processingMethod: "pageContent" } as const;

/** An Inbox type; a `database` type targets Tasks unless the input names another target. */
function createType(input: Partial<TypeInput> = {}) {
  const processingMethod = input.processingMethod ?? "database";
  return withTransaction(pool, (client) =>
    createInboxTypeWithClient(client, {
      inboxItemTypesDatabaseId: typesId,
      name: "Task",
      emoji: "☑️",
      ...(processingMethod === "database" ? { targetDatabase: "tasks" } : {}),
      ...input,
      processingMethod,
    }),
  );
}

function createSource(input: { text?: string; type?: string } = {}) {
  return withTransaction(pool, (client) =>
    createInboxItemWithClient(client, {
      inboxDatabaseId: inboxId,
      date: "2026-08-28",
      time: "09:00",
      text: "Buy milk",
      ...input,
    }),
  );
}

async function typedSource(text = "Buy milk", type: Partial<TypeInput> = {}) {
  const created = await createType(type);
  return { type: created, item: await createSource({ text, type: created.id }) };
}

const cardOf = (itemId: string) => findProposalForItem(pool, proposalsId, itemId);
async function requireCard(itemId: string) {
  const card = await cardOf(itemId);
  if (!card) throw new Error(`No proposal card for ${itemId}`);
  return card;
}
const historyOf = (card: { properties: Record<string, unknown> }) =>
  z.array(z.record(z.string(), z.unknown())).parse(card.properties.history);
const tick = (itemId: string, compute: ComputeSemprecProposalFn, tickPool: Pool = pool) =>
  runTick(tickPool, databaseIds, itemId, compute);
const propose =
  (properties: Record<string, unknown>, extra: Partial<ProposalComputationResult> = {}): ComputeSemprecProposalFn =>
  async () => ({ properties, ...extra });
const noCompute =
  (why = "computeProposal must not be called"): ComputeSemprecProposalFn =>
  async () => {
    throw new Error(why);
  };
const unrecognized: ComputeSemprecProposalFn = async () => ({ properties: {}, candidates: [] });
/** A computation that counts its calls and answers `result` each time. */
function counted(result: ProposalComputationResult | ((input: ProposalComputationInput) => ProposalComputationResult)) {
  const counter = {
    calls: 0,
    compute: (async (input) => {
      counter.calls++;
      return typeof result === "function" ? result(input) : result;
    }) as ComputeSemprecProposalFn,
  };
  return counter;
}

/** A write through the choke point's item writer. */
const editItem = (
  databaseId: string,
  itemId: string,
  propertiesPatch: Record<string, unknown>,
  options?: Parameters<typeof updateItemWithClient>[2],
) => withTransaction(pool, (client) => updateItemWithClient(client, { databaseId, itemId, propertiesPatch }, options));
/** A write straight through the items store, for system-owned keys no writer accepts. */
const storeEdit = (databaseId: string, itemId: string, propertiesPatch: Record<string, unknown>) =>
  withTransaction(pool, (client) => itemsStore.updateItemProperties(client, { databaseId, itemId, propertiesPatch }));
const trashSource = (itemId: string) =>
  withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, itemId));
const restoreSource = (itemId: string) =>
  withTransaction(pool, (client) => itemsStore.restoreItem(client, inboxId, itemId));
const countItems = async (databaseId: string) =>
  (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [databaseId]))
    .rows[0]!.n;

async function inboxTypePropertyId(client: PoolClient): Promise<string> {
  const property = await propertiesStore.getPropertyByKey(client, inboxId, "type");
  if (!property) throw new Error("Missing Inbox type property");
  return property.id;
}
/** Adds and removes type edges of a source through the relation writer. */
function setSourceType(itemId: string, change: { add?: string; remove?: string }) {
  return withTransaction(pool, async (client) => {
    const relationPropertyId = await inboxTypePropertyId(client);
    if (change.remove)
      await deleteRelationWithClient(client, { relationPropertyId, callerItemId: itemId, targetItemId: change.remove });
    if (change.add)
      await createRelationWithClient(client, { relationPropertyId, callerItemId: itemId, targetItemId: change.add });
  });
}
function sourceTypeEdges(itemId: string) {
  return withTransaction(pool, async (client) => {
    const definition = await relationsStore.getRelationDefinitionByPropertyId(
      client,
      await inboxTypePropertyId(client),
    );
    if (!definition) throw new Error("Missing Inbox type definition");
    return relationsStore.listRelationsForItem(client, definition.id, itemId);
  });
}
/** Archives every Inbox type except `keep`. */
async function archiveTypesExcept(keep: Array<string | undefined>) {
  const types = await withTransaction(pool, (client) => itemsStore.listItems(client, typesId, { limit: 200 }));
  for (const row of types.items) if (!keep.includes(row.id)) await editItem(typesId, row.id, { status: "archived" });
}

describe("semprec.tick fingerprinting and proposal create/revise/skip", () => {
  beforeEach(resetTickDatabases);

  it("creates exactly one proposed row with the generic envelope and correct fingerprint for a 'database' type", async () => {
    const { type, item } = await typedSource();
    let calls = 0;
    await tick(item.id, async (input) => {
      calls++;
      expect(input.projectItemId).toBe("proj");
      expect(input.entityKind).toBe("database");
      expect(input.targetDatabaseId).toBeTruthy();
      return { properties: { name: "Buy milk" } };
    });
    expect(calls).toBe(1);

    const proposal = await requireCard(item.id);
    expect(proposal.properties.status).toBe("proposed");
    expect(proposal.properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk" }));
    const history = historyOf(proposal);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ author: "ai", message: expect.any(String), at: expect.any(String) });
    // toEqual on the whole envelope also proves it carries no other key.
    expect(proposal.properties.proposal).toEqual({
      entityKind: "database",
      target: await databaseIdFor("tasks"),
      properties: { name: "Buy milk" },
    });
  });

  describe("untyped recognition", () => {
    async function fixture() {
      const type = await createType({ name: "Recognized task", status: "active", emoji: "T" });
      return { type, item: await createSource() };
    }
    const activeType = (name: string, extra: Partial<TypeInput> = {}) =>
      createType({ name, status: "active", emoji: name[0]!, ...extra });
    const candidate = (kind: string, typeId: string, confidence: number) =>
      kind === "type" ? { typeId, confidence } : { targetDatabaseKey: "tasks" as const, confidence };
    const clarified = { status: "needsClarification", recognizedTypeId: null, proposal: null };

    it.each(["type", "direct"])(
      "recognizes a %s candidate without writing the source type and reuses the fingerprint",
      async (kind) => {
        const { type, item } = await fixture();
        const counter = counted({ properties: { name: "Buy milk" }, candidates: [candidate(kind, type.id, 0.9)] });
        const compute: ComputeSemprecProposalFn = async (input) => {
          expect(input.recognition).toBe(true);
          return counter.compute(input);
        };
        await tick(item.id, compute);
        const card = await cardOf(item.id);
        expect(card?.properties).toMatchObject({
          status: "proposed",
          recognizedTypeId: kind === "type" ? type.id : null,
          typeCandidates: [],
          fingerprint: fingerprintV2Of({ typeId: "", text: "Buy milk" }),
        });
        await tick(item.id, compute);
        expect(counter.calls).toBe(1);
        expect(await cardOf(item.id)).toEqual(card);
        expect(await sourceTypeEdges(item.id)).toEqual([]);
      },
    );

    it("reuses recognition after a real unrelated historical property edit under the runtime role", async () => {
      const { type, item } = await fixture();
      const owner = getTenantZeroId();
      // Synthetic historical schema: the normal schema API refuses additions to the locked Inbox.
      const inserted = await pool.query(
        `INSERT INTO properties (id, tenant_id, database_id, key, name, type, config, locked, owner)
         SELECT $1, $2, id, $3, $4, 'text', '{}'::jsonb, false, 'user'
         FROM databases WHERE tenant_id = $2 AND id = $5`,
        [randomUUID(), owner, "testNote", "Test note", inboxId],
      );
      expect(inserted.rowCount).toBe(1);
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      const editNote = (testNote: string) =>
        runInTenant(owner, () =>
          withTransaction(runtime, (client) =>
            updateItemWithClient(client, { databaseId: inboxId, itemId: item.id, propertiesPatch: { testNote } }),
          ),
        );
      const read = () => runInTenant(owner, () => createChokePoint(runtime).getItem(inboxId, item.id));
      try {
        const role = await runtime.query<{ bypass: boolean; superuser: boolean }>(
          "SELECT rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
        );
        expect(role.rows).toEqual([{ bypass: false, superuser: false }]);
        await editNote("before");
        const counter = counted({
          properties: { name: "Buy milk" },
          candidates: [{ typeId: type.id, confidence: 0.9 }],
        });
        await tick(item.id, counter.compute);
        const card = await cardOf(item.id);
        const before = await read();
        await editNote("after");
        const after = await read();
        expect(after?.properties.testNote).toBe("after");
        expect(after?.updatedAt).not.toBe(before?.updatedAt);
        await tick(item.id, counter.compute);
        expect(counter.calls).toBe(1);
        expect(await cardOf(item.id)).toEqual(card);
        expect(card?.properties.fingerprint).toBe(fingerprintV2Of({ typeId: "", text: "Buy milk" }));
        expect(await sourceTypeEdges(item.id)).toEqual([]);
      } finally {
        await runtime.end();
      }
    });

    it.each(["type", "direct"])("reruns %s recognition after text changes", async (kind) => {
      const { type, item } = await fixture();
      const counter = counted({ properties: { name: "Task" }, candidates: [candidate(kind, type.id, 0.7)] });
      await tick(item.id, counter.compute);
      await editItem(inboxId, item.id, { text: "Buy eggs" });
      await tick(item.id, counter.compute);
      expect(counter.calls).toBe(2);
      expect((await cardOf(item.id))?.properties).toMatchObject({
        status: "proposed",
        recognizedTypeId: kind === "type" ? type.id : null,
        typeCandidates: [],
      });
    });

    it("offers padded distinct candidates and the model reason below threshold", async () => {
      const { type, item } = await fixture();
      const second = await activeType("Alternative task");
      await tick(
        item.id,
        propose(
          {},
          {
            reason: "Choose a type",
            candidates: [
              { typeId: type.id, confidence: 0.5 },
              { typeId: "unknown", confidence: 1 },
            ],
          },
        ),
      );
      const card = await cardOf(item.id);
      expect(card?.properties).toMatchObject({ ...clarified, reason: "Choose a type" });
      const choices = z.array(z.object({ typeId: z.string() })).parse(card?.properties.typeCandidates);
      // Exact list: distinct, padded with the second type and without the unknown id.
      expect(choices.map((choice) => choice.typeId)).toEqual([type.id, second.id]);
      await editItem(inboxId, item.id, { text: "A different uncertain item" });
      await tick(
        item.id,
        propose({}, { candidates: [{ typeId: second.id, confidence: 0.5 }], reason: "Another choice" }),
      );
      const revised = await cardOf(item.id);
      expect(revised?.id).toBe(card?.id);
      expect(revised?.properties).toMatchObject({
        status: "needsClarification",
        recognizedTypeId: null,
        reason: "Another choice",
        typeCandidates: [{ typeId: second.id }, { typeId: type.id }],
      });
    });

    it("discards recognition when text changes during the call", async () => {
      const { type, item } = await fixture();
      await tick(item.id, async () => {
        await editItem(inboxId, item.id, { text: "Changed" });
        return { properties: { name: "Stale" }, candidates: [{ typeId: type.id, confidence: 0.9 }] };
      });
      expect(await cardOf(item.id)).toBeNull();
    });

    it.each(["archived", "targetChanged", "deleted"] as const)(
      "does not promote another candidate when the selected type is %s during computation",
      async (change) => {
        const { type, item } = await fixture();
        const alternate = await activeType("Alternative", { targetDatabase: "projects" });
        const api = createChokePoint(pool);
        const tasks = await databaseIdFor("tasks");
        const projects = await databaseIdFor("projects");
        const beforeTasks = (await api.listItems(tasks)).items;
        const beforeProjects = (await api.listItems(projects)).items;
        await tick(item.id, async () => {
          if (change === "deleted") {
            await withTransaction(pool, (client) =>
              deleteInboxTypeWithClient(client, {
                inboxItemTypesDatabaseId: typesId,
                inboxDatabaseId: inboxId,
                processingProposalsDatabaseId: proposalsId,
                typeItemId: type.id,
              }),
            );
          } else {
            await editItem(
              typesId,
              type.id,
              change === "archived" ? { status: "archived" } : { targetDatabase: "projects" },
            );
          }
          return {
            properties: { name: "Must not move" },
            candidates: [
              { typeId: type.id, confidence: 0.9 },
              { typeId: alternate.id, confidence: 0.8 },
            ],
          };
        });
        const card = await cardOf(item.id);
        expect(card?.properties).toMatchObject(clarified);
        expect(card?.properties.reason).toBeTruthy();
        expect((await api.listItems(tasks)).items).toEqual(beforeTasks);
        expect((await api.listItems(projects)).items).toEqual(beforeProjects);
        expect(await sourceTypeEdges(item.id)).toEqual([]);
      },
    );

    it("clarifies a selected page-content type when the computation has no target", async () => {
      const { item } = await fixture();
      const pageType = await activeType("Page", { processingMethod: "pageContent" });
      await tick(
        item.id,
        propose({ flavour: "paragraph" }, { candidates: [{ typeId: pageType.id, confidence: 0.9 }] }),
      );
      expect((await cardOf(item.id))?.properties).toMatchObject(clarified);
    });

    it.each([false, true])("handles page target database archive during computation: %s", async (archive) => {
      const { item } = await fixture();
      const pageType = await activeType("Page", { processingMethod: "pageContent" });
      const api = createChokePoint(pool);
      const database = await api.createDatabase({ name: "Page target" });
      const page = await api.createItem({ databaseId: database.id, properties: {} });
      await tick(item.id, async () => {
        if (archive) await api.archiveDatabase(database.id);
        return {
          target: page.id,
          properties: { flavour: "paragraph", fields: { content: "Proposed" } },
          candidates: [{ typeId: pageType.id, confidence: 0.9 }],
        };
      });
      expect((await cardOf(item.id))?.properties).toMatchObject(
        archive ? clarified : { status: "proposed", recognizedTypeId: pageType.id },
      );
      expect(await withTransaction(pool, (client) => itemsStore.getItemById(client, database.id, page.id))).toEqual(
        page,
      );
      expect(await sourceTypeEdges(item.id)).toEqual([]);
    });

    const SHORTAGE_CS = "Jsou dostupné méně než dva platné aktivní typy.";
    const CHANGED_CS = "Vybraný typ nebo cíl není dostupný nebo se změnil.";

    it.each([0, 1])("explains a changed selection and a shortage of %s choices in both locales", async (count) => {
      const choices = count ? [{ typeId: randomUUID(), label: "Available", targetDatabaseKey: "tasks" }] : [];
      for (const [locale, shortage, changed] of [
        ["cs", SHORTAGE_CS, CHANGED_CS],
        [
          "en",
          "Fewer than two valid active types are available.",
          "The selected type or destination is unavailable or changed.",
        ],
      ] as const) {
        const patch = await recognitionClarificationPatch(locale, choices, true);
        expect(patch.reason).toContain(shortage);
        expect(patch.reason).toContain(changed);
        expect(patch.reason.length).toBeLessThanOrEqual(500);
      }
      const { type, item } = await fixture();
      const alternative = count ? await activeType("Remaining", { targetDatabase: "projects" }) : null;
      await archiveTypesExcept([type.id, alternative?.id]);
      await tick(item.id, async () => {
        await editItem(typesId, type.id, { status: "archived" });
        return { properties: { name: "Stale" }, candidates: [{ typeId: type.id, confidence: 0.9 }] };
      });
      const card = await cardOf(item.id);
      expect(card?.properties).toMatchObject(clarified);
      expect(z.array(z.unknown()).parse(card?.properties.typeCandidates)).toHaveLength(count);
      expect(card?.properties.reason).toEqual(expect.stringContaining(SHORTAGE_CS));
      expect(card?.properties.reason).toEqual(expect.stringContaining(CHANGED_CS));
    });

    it("keeps the changed-selection reason without a shortage when two choices remain", async () => {
      const choices = ["One", "Two"].map((label) => ({ typeId: randomUUID(), label, targetDatabaseKey: "tasks" }));
      const patch = await recognitionClarificationPatch("en", choices, true);
      expect(patch.reason).toBe("The selected type or destination is unavailable or changed. Please clarify.");
    });

    /**
     * Holds the tick inside its computation, applies `change` (a synthetic database state), lets the tick finish,
     * runs `verify`, and always runs `undo` once `change` committed. Failures of every phase are kept.
     */
    async function changeDuringComputation(
      itemId: string,
      result: ProposalComputationResult,
      change: () => Promise<void>,
      verify: () => Promise<void>,
      undo: () => Promise<void>,
    ) {
      const held = barrier();
      const running = runInTenant(getTenantZeroId(), () =>
        tick(itemId, async () => {
          held.reached();
          await held.gate;
          return result;
        }),
      );
      let failure: { error: unknown } | undefined;
      let changed = false;
      try {
        await Promise.race([
          held.ready,
          running.then(() => {
            throw new Error("Tick ended before computation barrier");
          }),
        ]);
        await change();
        changed = true;
      } catch (error) {
        failure = { error };
      } finally {
        held.release();
      }
      const [settled] = await Promise.allSettled([running]);
      if (settled.status === "rejected" && failure?.error !== settled.reason)
        failure = combineOverlapFailure(failure, settled.reason);
      if (!failure) {
        try {
          await verify();
        } catch (error) {
          failure = { error };
        }
      }
      if (changed) {
        try {
          await undo();
        } catch (error) {
          failure = combineOverlapFailure(failure, error);
        }
      }
      if (failure) throw failure.error;
    }
    const updateOneDatabase = (sql: string, params: unknown[]) =>
      runInTenant(getTenantZeroId(), () =>
        withTransaction(pool, async (client) => {
          expect((await client.query(sql, params)).rowCount).toBe(1);
        }),
      );
    const directThenType = (typeId: string, name: string) => ({
      properties: { name },
      candidates: [
        { targetDatabaseKey: "tasks" as const, confidence: 0.9 },
        { typeId, confidence: 0.8 },
      ],
    });

    it("clarifies when a direct target resolves to a different historical fixture database", async () => {
      const { type, item } = await fixture();
      const api = createChokePoint(pool);
      const original = await databaseIdFor("tasks");
      const replacement = await api.createDatabase({ name: "Replacement target" });
      const originalItems = (await api.listItems(original)).items;
      const replacementItems = (await api.listItems(replacement.id)).items;
      const tenant = getTenantZeroId();
      await changeDuringComputation(
        item.id,
        directThenType(type.id, "Must not move"),
        async () => {
          // Synthetic historical configuration: no public writer replaces a system module mapping.
          await updateOneDatabase(
            "UPDATE databases SET owner_module_id = NULL WHERE tenant_id = $1 AND id = $2 AND system = true AND owner_module_id = $3",
            [tenant, original, "tasks"],
          );
          await updateOneDatabase(
            "UPDATE databases SET system = true, owner_module_id = $3 WHERE tenant_id = $1 AND id = $2 AND system = false AND owner_module_id IS NULL",
            [tenant, replacement.id, "tasks"],
          );
          const resolved = await runInTenant(tenant, () =>
            withTransaction(pool, (client) => databasesStore.getDatabaseByModuleId(client, "tasks")),
          );
          expect(resolved?.id).toBe(replacement.id);
        },
        async () => {
          expect((await cardOf(item.id))?.properties).toMatchObject(clarified);
          expect((await api.listItems(original)).items).toEqual(originalItems);
          expect((await api.listItems(replacement.id)).items).toEqual(replacementItems);
          expect(await sourceTypeEdges(item.id)).toEqual([]);
        },
        async () => {
          await updateOneDatabase(
            "UPDATE databases SET system = false, owner_module_id = NULL WHERE tenant_id = $1 AND id = $2 AND system = true AND owner_module_id = $3",
            [tenant, replacement.id, "tasks"],
          );
          await updateOneDatabase(
            "UPDATE databases SET owner_module_id = $3 WHERE tenant_id = $1 AND id = $2 AND system = true AND owner_module_id IS NULL",
            [tenant, original, "tasks"],
          );
        },
      );
    });

    it("clarifies a direct target archived during computation without writing the target", async () => {
      const { type, item } = await fixture();
      const tasks = await databaseIdFor("tasks");
      const api = createChokePoint(pool);
      const before = (await api.listItems(tasks)).items;
      const databaseRow = async () =>
        (await pool.query<{ row: unknown }>("SELECT to_jsonb(d) AS row FROM databases d WHERE id = $1", [tasks])).rows;
      const beforeDatabase = await databaseRow();
      await expect(api.archiveDatabase(tasks)).rejects.toMatchObject({ code: "forbidden" });
      expect(await databaseRow()).toEqual(beforeDatabase);
      const tenant = getTenantZeroId();
      await changeDuringComputation(
        item.id,
        directThenType(type.id, "Not written"),
        // Synthetic historical/corrupt state: the public writer cannot archive a system database.
        () =>
          updateOneDatabase(
            "UPDATE databases SET archived_at = now() WHERE tenant_id = $1 AND id = $2 AND system = true AND archived_at IS NULL",
            [tenant, tasks],
          ),
        async () => {
          expect((await cardOf(item.id))?.properties).toMatchObject(clarified);
          expect((await api.listItems(tasks)).items).toEqual(before);
          expect(await sourceTypeEdges(item.id)).toEqual([]);
        },
        () =>
          updateOneDatabase(
            "UPDATE databases SET archived_at = NULL WHERE tenant_id = $1 AND id = $2 AND system = true AND archived_at IS NOT NULL",
            [tenant, tasks],
          ),
      );
    });

    it("clarifies a typed page-content result with no target", async () => {
      const { item } = await typedSource("Page", {
        name: "Page",
        status: "active",
        emoji: "P",
        processingMethod: "pageContent",
      });
      await tick(item.id, propose({ flavour: "paragraph" }));
      expect((await cardOf(item.id))?.properties).toMatchObject({ status: "needsClarification", proposal: null });
    });

    it("ignores foreign and random type candidates under the tenant runtime role", async () => {
      const { type, item } = await fixture();
      const foreign = await createTestTenant(pool);
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      try {
        const foreignType = await runInTenant(foreign, async () => {
          await seedSystem(runtime, createViewTypeRegistry());
          const types = await withTransaction(runtime, (client) =>
            databasesStore.getDatabaseByModuleId(client, "inboxItemTypes"),
          );
          if (!types) throw new Error("Missing foreign Inbox types");
          return withTransaction(runtime, (client) =>
            createInboxTypeWithClient(client, {
              inboxItemTypesDatabaseId: types.id,
              name: "Foreign",
              emoji: "F",
              status: "active",
              processingMethod: "database",
              targetDatabase: "tasks",
            }),
          );
        });
        const unknown = randomUUID();
        await runInTenant(getTenantZeroId(), () =>
          tick(
            item.id,
            propose(
              { name: "Owner" },
              {
                candidates: [
                  { typeId: foreignType.id, confidence: 1 },
                  { typeId: unknown, confidence: 0.95 },
                  { typeId: type.id, confidence: 0.9 },
                ],
              },
            ),
            runtime,
          ),
        );
        const card = await cardOf(item.id);
        expect(card?.properties).toMatchObject({ status: "proposed", recognizedTypeId: type.id });
        expect(JSON.stringify(card?.properties)).not.toContain(foreignType.id);
        expect(JSON.stringify(card?.properties)).not.toContain(unknown);
        expect(await runInTenant(foreign, () => createChokePoint(runtime).findItem(foreignType.id))).toMatchObject({
          id: foreignType.id,
        });
      } finally {
        await runtime.end();
      }
    });

    it.each(["type-first", "recognition-first"] as const)(
      "reserves the selected type without waiting in %s order",
      async (order) => {
        const { type, item } = await fixture();
        const runtime = await createRuntimeRolePool(pool, "semprec_data");
        const held = barrier();
        let holderPid = 0;
        let contenderPid = 0;
        const observed = interceptConnect(runtime, (client) =>
          interceptQuery(client, async (args, original) => {
            const reservation =
              typeof args[0] === "string" && args[0].includes("id = ANY($2::uuid[]) ORDER BY id FOR SHARE NOWAIT");
            if (reservation && order === "type-first") contenderPid = await pidOf(client);
            const result = await original(...args);
            if (order === "recognition-first" && reservation) {
              holderPid = await pidOf(client);
              held.reached();
              await held.gate;
            }
            return result;
          }),
        );
        const owned = ownOverlap(runtime, held.release);
        const archiveType = (onClient: (client: PoolClient) => Promise<void>, afterWrite?: () => Promise<void>) =>
          owned.run(() =>
            runInTenant(getTenantZeroId(), () =>
              withTransaction(runtime, async (client) => {
                await onClient(client);
                await updateItemWithClient(client, {
                  databaseId: typesId,
                  itemId: type.id,
                  propertiesPatch: { status: "archived" },
                });
                await afterWrite?.();
              }),
            ),
          );
        const runRecognition = () =>
          owned.run(() =>
            runInTenant(getTenantZeroId(), () =>
              tick(
                item.id,
                propose({ name: "Task" }, { candidates: [{ typeId: type.id, confidence: 0.9 }] }),
                observed,
              ),
            ),
          );
        let failure: { error: unknown } | undefined;
        try {
          if (order === "type-first") {
            const writer = archiveType(
              async (client) => {
                holderPid = await pidOf(client);
              },
              async () => {
                held.reached();
                await held.gate;
              },
            );
            await owned.wait(held.ready, writer);
            await owned.wait(runRecognition(), writer);
            expect(contenderPid).toBeGreaterThan(0);
            expect(contenderPid).not.toBe(holderPid);
            expect(await cardOf(item.id)).toBeNull();
            held.release();
            await writer;
          } else {
            const running = runRecognition();
            await owned.wait(held.ready, running);
            const writer = archiveType(async (client) => {
              contenderPid = await pidOf(client);
            });
            await vi.waitFor(async () => {
              expect(contenderPid).toBeGreaterThan(0);
              const blocked = await pool.query<{ pids: number[] }>("SELECT pg_blocking_pids($1) AS pids", [
                contenderPid,
              ]);
              expect(blocked.rows[0]?.pids).toContain(holderPid);
            });
            held.release();
            await running;
            await writer;
            expect((await cardOf(item.id))?.properties.status).toBe("proposed");
          }
        } catch (error) {
          failure = { error };
        } finally {
          held.release();
          try {
            await owned.finish(failure !== undefined);
          } catch (error) {
            failure = combineOverlapFailure(failure, error);
          }
        }
        if (failure) throw failure.error;
      },
      20000,
    );

    it.each(["date", "time", "attachment"])("reruns recognition after a %s change", async (field) => {
      const { type, item } = await fixture();
      const counter = counted({ properties: { name: "Task" }, candidates: [{ typeId: type.id, confidence: 0.9 }] });
      await tick(item.id, counter.compute);
      if (field === "attachment") {
        const blob = await createBlob(pool, {
          mimeType: "application/pdf",
          byteSize: 1,
          storageKey: "recognition-attachment",
          contentHash: "a".repeat(64),
        });
        await insertInboxAttachments(pool, item.id, [{ blobId: blob.id, source: "camera" }]);
      } else await editItem(inboxId, item.id, field === "date" ? { date: "2026-08-29" } : { time: "10:00" });
      await tick(item.id, counter.compute);
      expect(counter.calls).toBe(2);
    });

    it("discards recognition after a source type-edge change", async () => {
      const { type, item } = await fixture();
      await tick(item.id, async () => {
        await setSourceType(item.id, { add: type.id });
        return { properties: { name: "Stale" }, candidates: [{ typeId: type.id, confidence: 0.9 }] };
      });
      expect(await cardOf(item.id)).toBeNull();
    });

    it("never recomputes a locked recognized card", async () => {
      const { type, item } = await fixture();
      await tick(item.id, propose({ name: "Task" }, { candidates: [{ typeId: type.id, confidence: 0.9 }] }));
      const card = await requireCard(item.id);
      await editItem(proposalsId, card.id, { status: "rejected" }, { allowedSystemKeys: ["status"] });
      await editItem(inboxId, item.id, { text: "Changed" });
      await tick(item.id, noCompute("Locked card must not compute"));
    });

    it.each([0, 1])("offers only %s existing valid types and explains the shortage", async (count) => {
      const { type, item } = await fixture();
      await archiveTypesExcept(count === 1 ? [type.id] : []);
      await tick(item.id, propose({}, { candidates: [{ typeId: type.id, confidence: count === 0 ? 0.9 : 0.5 }] }));
      const card = await cardOf(item.id);
      expect(card?.properties).toMatchObject({ status: "needsClarification", proposal: null });
      expect(z.array(z.unknown()).parse(card?.properties.typeCandidates)).toHaveLength(count);
      expect(card?.properties.reason).toEqual(expect.stringContaining(SHORTAGE_CS));
    });

    it("makes no call without text", async () => {
      const { item } = await fixture();
      await editItem(inboxId, item.id, { text: "" });
      await tick(item.id, noCompute("Unexpected computation"));
      expect((await cardOf(item.id))?.properties.status).toBe("needsClarification");
    });
  });

  describe("locale passed to computeProposal", () => {
    const createTaskInboxItem = async () => (await typedSource()).item.id;
    const createTenantUser = (locale: "cs" | "en" | "fr") =>
      runInTenant(getTenantZeroId(), () =>
        createUser(pool, { email: `${locale}@example.com`, passwordHash: "x", locale, tenantId: getTenantZeroId() }),
      );

    it.each(["cs", "en", "fr"] as const)(
      "passes the %s user's locale and replaces the reason on recompute",
      async (locale) => {
        await createTenantUser(locale);
        const itemId = await createTaskInboxItem();
        await runInTenant(getTenantZeroId(), () =>
          tick(itemId, async (input) => {
            expect(input.locale).toBe(locale);
            return { properties: { name: "Buy milk" }, reason: "  Úkol s termínem.  " };
          }),
        );
        expect((await cardOf(itemId))?.properties.reason).toBe("Úkol s termínem.");
        await editItem(inboxId, itemId, { text: "Buy eggs" });
        await runInTenant(getTenantZeroId(), () =>
          tick(itemId, propose({ name: "Buy eggs" }, { reason: "Nový úkol." })),
        );
        expect((await cardOf(itemId))?.properties.reason).toBe("Nový úkol.");
      },
    );

    it.each([
      [undefined, null],
      ["", null],
      ["   ", null],
      ["x".repeat(501), "x".repeat(500)],
    ] as const)("normalizes reason %s", async (reason, expected) => {
      const itemId = await createTaskInboxItem();
      await tick(itemId, propose({ name: "Task" }, { reason }));
      expect((await cardOf(itemId))?.properties.reason).toBe(expected);
    });

    it("clears the model reason when the source is deleted", async () => {
      const itemId = await createTaskInboxItem();
      await tick(itemId, propose({ name: "Task" }, { reason: "A task." }));
      await trashSource(itemId);
      await tick(itemId, noCompute("Deleted source must not compute"));
      expect((await cardOf(itemId))?.properties).toMatchObject({ status: "invalid", reason: null });
    });

    it("does not store the reason of an invalid computed proposal", async () => {
      const itemId = await createTaskInboxItem();
      await tick(itemId, propose({ notAProperty: true }, { reason: "Discard me" }));
      expect((await cardOf(itemId))?.properties).toMatchObject({ status: "needsClarification", reason: null });
    });

    it("refuses a client write of reason", async () => {
      const itemId = await createTaskInboxItem();
      await tick(itemId, propose({ name: "Task" }, { reason: "Original" }));
      const card = await requireCard(itemId);
      await expect(editItem(proposalsId, card.id, { reason: "Changed" })).rejects.toMatchObject({
        code: "owner_violation",
      });
      expect((await cardOf(itemId))?.properties.reason).toBe("Original");
    });

    it.each([
      ["the bound user's locale", "en"],
      ["cs when the tenant has no bound user", undefined],
    ] as const)("passes %s", async (_, userLocale) => {
      if (userLocale) await createTenantUser(userLocale);
      const itemId = await createTaskInboxItem();
      const locales: string[] = [];
      await runInTenant(getTenantZeroId(), () =>
        tick(itemId, async (input) => {
          locales.push(input.locale);
          return { properties: { name: "Buy milk" } };
        }),
      );
      expect(locales).toEqual([userLocale ?? "cs"]);
    });
  });

  it("uses the injected function's target for a 'pageContent' type", async () => {
    const { type, item } = await typedSource("A thought", PAGE_TYPE);
    await tick(item.id, async (input) => {
      expect(input.entityKind).toBe("pageContent");
      expect(input.targetDatabaseId).toBeUndefined();
      return { target: type.id, properties: { flavour: "paragraph", fields: { content: "A thought" } } };
    });
    expect((await requireCard(item.id)).properties.proposal).toEqual({
      entityKind: "pageContent",
      target: type.id,
      properties: { flavour: "paragraph", fields: { content: "A thought" } },
    });
  });

  it("an unchanged fingerprint makes no AI call and no proposal write", async () => {
    const { item } = await typedSource();
    await tick(item.id, propose({ name: "Buy milk" }));
    const first = await requireCard(item.id);
    await tick(item.id, noCompute("computeProposal must not be called for an unchanged fingerprint"));
    expect((await requireCard(item.id)).updatedAt).toBe(first.updatedAt);
  });

  it("an edit that changes the fingerprint revises the same row rather than creating a second one", async () => {
    const { type, item } = await typedSource();
    await tick(item.id, propose({ name: "Buy milk" }));
    const first = await requireCard(item.id);
    await storeEdit(inboxId, item.id, { text: "Buy milk and eggs" });
    await tick(item.id, propose({ name: "Buy milk and eggs" }));
    const revised = await requireCard(item.id);
    expect(revised.id).toBe(first.id);
    expect(revised.properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk and eggs" }));
    expect(revised.properties.proposal).toEqual({
      entityKind: "database",
      target: await databaseIdFor("tasks"),
      properties: { name: "Buy milk and eggs" },
    });
    expect(revised.properties.history).toHaveLength(2);
    expect(await countItems(proposalsId)).toBe(1);
  });

  describe("version 2 fingerprint inputs", () => {
    /**
     * Creates a blob whose content hash derives from `label` and attaches it to the Inbox item. It is a PDF:
     * a tick waits for an image whose metadata job has not run.
     */
    async function attachNewBlob(itemId: string, label: string) {
      const contentHash = createHash("sha256").update(label).digest("hex");
      const blob = await createBlob(pool, {
        mimeType: "application/pdf",
        byteSize: 3,
        storageKey: `t/blobs/${label}`,
        contentHash,
      });
      await insertInboxAttachments(pool, itemId, [{ blobId: blob.id, source: "camera" }]);
      return { blobId: blob.id, contentHash };
    }
    async function detachBlob(itemId: string, blobId: string) {
      const attachment = (await listInboxAttachments(pool, [itemId])).find((row) => row.blobId === blobId);
      if (!attachment) throw new Error(`Inbox item ${itemId} has no attachment of blob ${blobId}`);
      await deleteInboxAttachment(pool, attachment.attachmentId);
    }
    /** Moves the attachment of `blobId` to the end of the item's attachments. */
    async function moveToEnd(itemId: string, blobId: string) {
      await detachBlob(itemId, blobId);
      await insertInboxAttachments(pool, itemId, [{ blobId, source: "camera" }]);
    }
    const fingerprint = async (itemId: string) => (await requireCard(itemId)).properties.fingerprint;

    it.each([
      { field: "time", patch: { time: "10:30" } },
      { field: "date", patch: { date: "2026-08-29" } },
    ])("a changed capture $field recomputes the proposal", async ({ patch }) => {
      const { type, item } = await typedSource();
      const counter = counted({ properties: { name: "Buy milk" } });
      await tick(item.id, counter.compute);
      expect(counter.calls).toBe(1);
      await storeEdit(inboxId, item.id, patch);
      await tick(item.id, counter.compute);
      expect(counter.calls).toBe(2);
      expect(await fingerprint(item.id)).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk", ...patch }));
    });

    it("adding an attachment to the item and then removing it each recomputes the proposal", async () => {
      const { type, item } = await typedSource();
      const counter = counted({ properties: { name: "Buy milk" } });
      await tick(item.id, counter.compute);
      const photo = await attachNewBlob(item.id, "photo");
      await tick(item.id, counter.compute);
      expect(counter.calls).toBe(2);
      expect(await fingerprint(item.id)).toBe(
        fingerprintV2Of({ typeId: type.id, text: "Buy milk", attachmentHashes: [photo.contentHash] }),
      );
      await detachBlob(item.id, photo.blobId);
      await tick(item.id, counter.compute);
      expect(counter.calls).toBe(3);
      expect(await fingerprint(item.id)).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk" }));
    });

    it("reordering the attachments of an item does not recompute the proposal", async () => {
      const { item } = await typedSource();
      const first = await attachNewBlob(item.id, "first");
      const second = await attachNewBlob(item.id, "second");
      await tick(item.id, propose({ name: "Buy milk" }));
      const before = await requireCard(item.id);
      await moveToEnd(item.id, first.blobId);
      expect((await listInboxAttachments(pool, [item.id])).map((row) => row.blobId)).toEqual([
        second.blobId,
        first.blobId,
      ]);
      await tick(item.id, noCompute("computeProposal must not be called when only the attachment order changed"));
      const after = await requireCard(item.id);
      expect(after.properties.fingerprint).toBe(before.properties.fingerprint);
      expect(after.updatedAt).toBe(before.updatedAt);
    });

    it("uses legacy blob IDs for missing hashes on add, reorder and removal at an invoked tick", async () => {
      const { type, item } = await typedSource();
      const counter = counted({ properties: { name: "Buy milk" } });
      await tick(item.id, counter.compute);
      const legacyBlob = () =>
        createBlob(pool, { mimeType: "application/pdf", byteSize: 1, storageKey: `legacy/${randomUUID()}` });
      const first = await legacyBlob();
      const second = await legacyBlob();
      await insertInboxAttachments(pool, item.id, [
        { blobId: first.id, source: "camera" },
        { blobId: second.id, source: "camera" },
      ]);
      await tick(item.id, counter.compute);
      expect(counter.calls).toBe(2);
      const before = await requireCard(item.id);
      expect(before.properties.fingerprint).toBe(
        fingerprintV2Of({ typeId: type.id, text: "Buy milk", attachmentHashes: [first.id, second.id] }),
      );
      await moveToEnd(item.id, first.id);
      await tick(item.id, counter.compute);
      expect(counter.calls).toBe(2);
      expect((await requireCard(item.id)).updatedAt).toBe(before.updatedAt);
      await detachBlob(item.id, second.id);
      await tick(item.id, counter.compute);
      expect(counter.calls).toBe(3);
      expect(await fingerprint(item.id)).toBe(
        fingerprintV2Of({ typeId: type.id, text: "Buy milk", attachmentHashes: [first.id] }),
      );
    });

    it("choosing another type that shares the emoji recomputes the proposal", async () => {
      const { type: task, item } = await typedSource();
      const errand = await createType({ name: "Errand" });
      const counter = counted({ properties: { name: "Buy milk" } });
      await tick(item.id, counter.compute);
      const before = await requireCard(item.id);
      await setSourceType(item.id, { remove: task.id, add: errand.id });
      await tick(item.id, counter.compute);
      expect(counter.calls).toBe(2);
      const after = await requireCard(item.id);
      expect(after.id).toBe(before.id);
      expect(after.properties.fingerprint).toBe(fingerprintV2Of({ typeId: errand.id, text: "Buy milk" }));
    });

    it("a card whose stored fingerprint is not a version 2 value is recomputed and stored as version 2", async () => {
      const { type, item } = await typedSource();
      await tick(item.id, propose({ name: "Buy milk" }));
      const created = await requireCard(item.id);
      await storeEdit(proposalsId, created.id, {
        fingerprint: String(created.properties.fingerprint).slice("v2:".length),
      });
      const counter = counted({ properties: { name: "Buy milk" } });
      await tick(item.id, counter.compute);
      expect(counter.calls).toBe(1);
      const revised = await requireCard(item.id);
      expect(revised.id).toBe(created.id);
      expect(revised.properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk" }));
    });
  });

  it.each(["confirmed", "rejected"] as const)(
    "a %s proposal is never modified by a later tick, even when the source changes",
    async (lockedStatus) => {
      const { type, item } = await typedSource();
      await tick(item.id, propose({ name: "Buy milk" }));
      await storeEdit(proposalsId, (await requireCard(item.id)).id, { status: lockedStatus });
      await storeEdit(inboxId, item.id, { text: "Something totally different" });
      await tick(item.id, noCompute("computeProposal must not be called for a locked proposal"));
      const stillLocked = await requireCard(item.id);
      expect(stillLocked.properties.status).toBe(lockedStatus);
      expect(stillLocked.properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk" }));
    },
  );

  it("a soft-deleted existing proposal is treated as absent — a later tick creates a fresh one instead of throwing", async () => {
    const { type, item } = await typedSource();
    await tick(item.id, propose({ name: "Buy milk" }));
    const original = await requireCard(item.id);
    await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, proposalsId, original.id));

    // The edge to the deleted proposal remains, so the tick must not try to update the deleted item; it
    // creates a new one.
    await tick(item.id, propose({ name: "Buy milk (retry)" }));
    expect(await countItems(proposalsId)).toBe(2);
    expect((await itemsStore.getItemById(pool, proposalsId, original.id))!.deletedAt).not.toBeNull();

    // Two `sourceInbox` edges now exist: one to the soft-deleted original, one to the live replacement. A
    // further tick must find the live one whichever edge comes back first, not create a third row.
    await storeEdit(inboxId, item.id, { text: "Buy milk and eggs" });
    await tick(item.id, propose({ name: "Buy milk and eggs" }));
    expect(await countItems(proposalsId)).toBe(2);
    const { rows: liveRows } = await pool.query<{ properties: Record<string, unknown> }>(
      "SELECT properties FROM items WHERE database_id = $1 AND deleted_at IS NULL",
      [proposalsId],
    );
    expect(liveRows).toHaveLength(1);
    expect(liveRows[0]!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk and eggs" }));
  });

  describe("a source split into several cards", () => {
    async function storedCards() {
      const { rows } = await pool.query<{ id: string; properties: Record<string, unknown>; updated_at: Date }>(
        "SELECT id, properties, updated_at FROM items WHERE database_id = $1 ORDER BY id",
        [proposalsId],
      );
      return new Map(
        rows.map((row) => [row.id, { properties: row.properties, updatedAt: row.updated_at.toISOString() }]),
      );
    }

    /** A sibling card of a split, written as the split action writes it, linked to `sourceId`. */
    async function createSiblingCard(sourceId: string, name: string): Promise<string> {
      const envelope: ProposalEnvelope = {
        entityKind: "database",
        target: await databaseIdFor("tasks"),
        properties: { name },
      };
      const properties = {
        kind: "inbox",
        proposal: envelope,
        ...aiProposalPatch({}, envelope),
        history: [],
        status: "proposed",
        splitFromProposalId: randomUUID(),
      };
      return withTransaction(pool, async (client) => {
        const sibling = await createItemWithClient(
          client,
          { databaseId: proposalsId, properties },
          { allowedSystemKeys: Object.keys(properties) },
        );
        await linkSourceInboxRelation(client, { processingProposalsDatabaseId: proposalsId }, sibling.id, sourceId);
        return sibling.id;
      });
    }

    it("recomputes only the primary card when the source text is edited, and makes no call while the source is unchanged", async () => {
      const { type, item } = await typedSource("Buy milk and renew the passport");
      await tick(item.id, propose({ name: "Buy milk and renew the passport" }));
      const primaryId = (await requireCard(item.id)).id;
      const tasksId = await databaseIdFor("tasks");
      const card = (name: string) => ({ entityKind: "database" as const, target: tasksId, properties: { name } });
      const { siblings } = await withTransaction(pool, (client) =>
        splitInboxSourceWithClient(
          client,
          { processingProposalsDatabaseId: proposalsId },
          {
            proposalId: primaryId,
            subjectItemId: item.id,
            threadId: randomUUID(),
            messageId: randomUUID(),
            cards: [card("Buy milk"), card("Renew the passport"), card("Call mom")],
          },
        ),
      );
      expect(siblings).toHaveLength(2);
      const afterSplit = await storedCards();
      expect(afterSplit.size).toBe(3);

      const counter = counted({ properties: { name: "Buy milk and eggs" } });
      await tick(item.id, counter.compute);
      expect(counter.calls).toBe(0);
      expect(await storedCards()).toEqual(afterSplit);

      await storeEdit(inboxId, item.id, { text: "Buy milk and eggs, renew the passport" });
      await tick(item.id, counter.compute);
      expect(counter.calls).toBe(1);
      const afterEdit = await storedCards();
      expect(afterEdit.size).toBe(3);
      const primary = afterEdit.get(primaryId)!;
      expect(primary.properties.proposal).toEqual(card("Buy milk and eggs"));
      expect(primary.properties.fingerprint).toBe(
        fingerprintV2Of({ typeId: type.id, text: "Buy milk and eggs, renew the passport" }),
      );
      for (const sibling of siblings) expect(afterEdit.get(sibling.id)).toEqual(afterSplit.get(sibling.id));
    });

    it("sees no sibling whichever edge comes first: it creates its own card beside the siblings of a source and later revises that one", async () => {
      const { type, item } = await typedSource();
      // The edges of both siblings exist before the tick's card has one, so a scan that took the first live card
      // of the source would take a sibling.
      const siblingIds = [
        await createSiblingCard(item.id, "Sibling one"),
        await createSiblingCard(item.id, "Sibling two"),
      ];
      const siblingsBefore = await storedCards();
      const counter = counted({ properties: { name: "Buy milk" } });
      await tick(item.id, counter.compute);
      expect(counter.calls).toBe(1);
      const created = await storedCards();
      expect(created.size).toBe(3);
      const primaryId = [...created.keys()].find((id) => !siblingIds.includes(id));
      if (!primaryId) throw new Error("The tick created no card of its own");
      expect(created.get(primaryId)!.properties).toMatchObject({
        kind: "inbox",
        status: "proposed",
        fingerprint: fingerprintV2Of({ typeId: type.id, text: "Buy milk" }),
      });
      expect(created.get(primaryId)!.properties.splitFromProposalId).toBeUndefined();
      for (const id of siblingIds) expect(created.get(id)).toEqual(siblingsBefore.get(id));

      await storeEdit(inboxId, item.id, { text: "Buy milk and eggs" });
      await tick(item.id, counter.compute);
      expect(counter.calls).toBe(2);
      const revised = await storedCards();
      expect(revised.size).toBe(3);
      expect(revised.get(primaryId)!.properties.fingerprint).toBe(
        fingerprintV2Of({ typeId: type.id, text: "Buy milk and eggs" }),
      );
      for (const id of siblingIds) expect(revised.get(id)).toEqual(siblingsBefore.get(id));
    });
  });

  it("an item with no type is marked needsClarification once, and a repeated tick adds no second history entry", async () => {
    const item = await createSource({ text: "no type" });
    await tick(item.id, unrecognized);
    const proposal = await requireCard(item.id);
    expect(proposal.properties).toMatchObject({ status: "needsClarification", proposal: null });
    expect(historyOf(proposal)).toEqual([expect.objectContaining({ author: "ai" })]);
    await tick(item.id, unrecognized);
    const repeated = await requireCard(item.id);
    expect(repeated.properties.status).toBe("needsClarification");
    expect(repeated.properties.history).toHaveLength(1);
  });

  it("never writes a row into any database other than processingProposals", async () => {
    const { item } = await typedSource();
    const tasksDbId = await databaseIdFor("tasks");
    const before = await countItems(tasksDbId);
    await tick(item.id, propose({ name: "Buy milk" }));
    expect(await countItems(tasksDbId)).toBe(before);
  });
});

describe("semprec.tick needsClarification, invalid, history, and envelope validation", () => {
  beforeEach(resetTickDatabases);
  const sourceDeletedReason = (itemId: string, label = "Buy milk") => ({
    code: "sourceDeleted",
    field: "",
    itemId,
    label,
  });
  const deletedSource = "computeProposal must not be called for a deleted source";
  const unchangedSource = "computeProposal must not be called when the source fingerprint is unchanged";

  it("validates an uncreated Inbox type edge without locking a placeholder source", async () => {
    const { type } = await typedSource("Type validation fixture");
    const relationPropertyId = await withTransaction(pool, inboxTypePropertyId);
    const statements: string[] = [];
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      await withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
        const observed = interceptQuery(client, (args, original) => {
          if (typeof args[0] === "string") statements.push(args[0]);
          return original(...args);
        });
        await assertRelationTargetLinkableWithClient(observed, { relationPropertyId, targetItemId: type.id });
      });
    } finally {
      await runtime.end();
    }
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.some((sql) => sql.includes("UPDATE OF i"))).toBe(false);
  });

  it("a source whose type was deleted out from under it is marked needsClarification, the same path as no type at all", async () => {
    const { type, item } = await typedSource();
    await withTransaction(pool, (client) =>
      deleteInboxTypeWithClient(client, {
        inboxDatabaseId: inboxId,
        inboxItemTypesDatabaseId: typesId,
        processingProposalsDatabaseId: proposalsId,
        typeItemId: type.id,
      }),
    );
    await tick(item.id, unrecognized);
    const proposal = await requireCard(item.id);
    expect(proposal.properties).toMatchObject({
      fingerprint: fingerprintV2Of({ typeId: "", text: "Buy milk" }),
      status: "needsClarification",
      proposal: null,
    });
    expect(proposal.properties.history).toHaveLength(1);
  });

  it("an item that gains a recognized type after needsClarification transitions to proposed on the next tick", async () => {
    const item = await createSource();
    await tick(item.id, unrecognized);
    const needsClarification = await requireCard(item.id);
    expect(needsClarification.properties).toMatchObject({
      status: "needsClarification",
      fingerprint: fingerprintV2Of({ typeId: "", text: "Buy milk" }),
    });
    const type = await createType();
    await setSourceType(item.id, { add: type.id });
    await tick(item.id, propose({ name: "Buy milk" }));
    const proposed = await requireCard(item.id);
    expect(proposed.id).toBe(needsClarification.id);
    expect(proposed.properties).toMatchObject({
      status: "proposed",
      fingerprint: fingerprintV2Of({ typeId: type.id, text: "Buy milk" }),
      proposal: { entityKind: "database", target: await databaseIdFor("tasks"), properties: { name: "Buy milk" } },
    });
    expect(proposed.properties.history).toHaveLength(2);
  });

  it("deleting a source item invalidates its unlocked proposal", async () => {
    const { item } = await typedSource();
    await tick(item.id, propose({ name: "Buy milk" }));
    const proposed = await requireCard(item.id);
    expect(proposed.properties.status).toBe("proposed");
    await trashSource(item.id);
    await tick(item.id, noCompute(deletedSource));
    const invalidated = await requireCard(item.id);
    expect(invalidated.id).toBe(proposed.id);
    expect(invalidated.properties.status).toBe("invalid");
    expect(historyOf(invalidated)).toHaveLength(2);
    expect(historyOf(invalidated)[1]).toMatchObject({ author: "ai", kind: "invalidated" });
    expect(invalidated.properties.invalidReason).toEqual(sourceDeletedReason(item.id));
  });

  it("a deleted source's reason label is its trimmed first line, cut by code point to 80 characters", async () => {
    // Emoji are two UTF-16 units each: a cut by unit would split one at the 79th position.
    const { item } = await typedSource(`  ${"🙂".repeat(120)}  \nsecond line`);
    await tick(item.id, propose({ name: "Long" }));
    await trashSource(item.id);
    await tick(item.id, noCompute(deletedSource));
    expect((await requireCard(item.id)).properties.invalidReason).toMatchObject({ label: `${"🙂".repeat(79)}…` });
  });

  it.each(["confirmed", "rejected"] as const)(
    "a %s proposal keeps its status and history when its source item is deleted",
    async (status) => {
      const { item } = await typedSource();
      await tick(item.id, propose({ name: "Buy milk" }));
      const proposal = await requireCard(item.id);
      await storeEdit(proposalsId, proposal.id, { status });
      await trashSource(item.id);
      await tick(item.id, noCompute(deletedSource));
      const after = await requireCard(item.id);
      expect(after.properties.status).toBe(status);
      expect(after.properties.history).toEqual(proposal.properties.history);
    },
  );

  it("deleting a source with no proposal at all is a harmless no-op", async () => {
    const { item } = await typedSource();
    await trashSource(item.id);
    await tick(item.id, noCompute(deletedSource));
    expect(await cardOf(item.id)).toBeNull();
  });

  // Restoring a source returns its `sourceDeleted` card. The tick runs explicitly here; the heartbeat that
  // runs it is covered in inboxTick.test.ts.
  it.each([
    ["confirmed", true],
    ["rejected", true],
    ["confirmed", false],
    ["rejected", false],
  ] as const)(
    "a %s card is left unchanged when its source is deleted and restored (choke point: %s)",
    async (status, viaChokePoint) => {
      const { item } = await typedSource();
      await tick(item.id, propose({ name: "Buy milk" }));
      await storeEdit(proposalsId, (await requireCard(item.id)).id, { status });
      const before = await requireCard(item.id);
      const chokePoint = createChokePoint(pool);
      if (viaChokePoint) await runInTenant(getTenantZeroId(), () => chokePoint.softDeleteItem(inboxId, item.id));
      else await trashSource(item.id);
      await tick(item.id, noCompute(deletedSource));
      const beforeRestore = await requireCard(item.id);
      expect(beforeRestore.properties.status).toBe(status);
      if (viaChokePoint) await runInTenant(getTenantZeroId(), () => chokePoint.restoreItem(inboxId, item.id));
      else await restoreSource(item.id);
      await tick(item.id, noCompute("computeProposal must not run for a locked card"));
      expect(await cardOf(item.id)).toEqual(beforeRestore);
      if (!viaChokePoint) expect(beforeRestore.properties).toEqual(before.properties);
    },
  );

  it("restoring an unchanged source returns its invalid card to proposed with no reason and no recompute", async () => {
    const { item } = await typedSource();
    await tick(item.id, propose({ name: "Buy milk" }));
    const proposed = await requireCard(item.id);
    await trashSource(item.id);
    await tick(item.id, noCompute(deletedSource));
    await restoreSource(item.id);
    await tick(item.id, noCompute(unchangedSource));
    const reopened = await requireCard(item.id);
    expect(reopened.id).toBe(proposed.id);
    expect(reopened.properties).toMatchObject({
      status: "proposed",
      invalidReason: null,
      proposal: proposed.properties.proposal,
    });
    expect(historyOf(reopened)).toHaveLength(3);
    expect(historyOf(reopened)[2]).toMatchObject({ author: "ai", kind: "reopened" });
  });

  it.each(["before it was trashed", "while trashed, as historical state"] as const)(
    "a source whose text changed %s is recomputed when it is restored",
    async (when) => {
      const { type, item } = await typedSource();
      await tick(item.id, propose({ name: "Buy milk" }));
      const chokePoint = createChokePoint(pool);
      if (when === "before it was trashed") {
        await storeEdit(inboxId, item.id, { text: "Buy milk and eggs" });
        await trashSource(item.id);
        await tick(item.id, noCompute(deletedSource));
        await restoreSource(item.id);
      } else {
        await runInTenant(getTenantZeroId(), () => chokePoint.softDeleteItem(inboxId, item.id));
        await tick(item.id, noCompute(deletedSource));
        // Historical persisted state only: the supported writer refuses edits to trashed items.
        const changed = await pool.query(
          `UPDATE items SET properties = jsonb_set(properties, '{text}', to_jsonb($1::text))
           WHERE tenant_id = $2 AND database_id = $3 AND id = $4 AND deleted_at IS NOT NULL`,
          ["Buy milk and eggs", getTenantZeroId(), inboxId, item.id],
        );
        expect(changed.rowCount).toBe(1);
        await runInTenant(getTenantZeroId(), () => chokePoint.restoreItem(inboxId, item.id));
      }
      const computedFor: unknown[] = [];
      await tick(item.id, async (input) => {
        computedFor.push(input.sourceItem.properties.text);
        return { properties: { name: "Buy milk and eggs" } };
      });
      expect(computedFor).toEqual(["Buy milk and eggs"]);
      expect((await requireCard(item.id)).properties).toMatchObject({
        status: "proposed",
        invalidReason: null,
        fingerprint: fingerprintV2Of({ typeId: type.id, text: "Buy milk and eggs" }),
        proposal: {
          entityKind: "database",
          target: await databaseIdFor("tasks"),
          properties: { name: "Buy milk and eggs" },
        },
      });
    },
  );

  it("a restored card whose stored envelope no longer validates goes to needsClarification, keeping its fingerprint", async () => {
    const { item } = await typedSource("A thought", PAGE_TYPE);
    // Any existing item is a valid page target until it is trashed, so the envelope's page can go missing.
    const page = await createSource({ text: "The page" });
    await tick(item.id, propose({ flavour: "paragraph", fields: { content: "A thought" } }, { target: page.id }));
    const proposed = await requireCard(item.id);
    expect(proposed.properties.status).toBe("proposed");
    await trashSource(item.id);
    await tick(item.id, noCompute(deletedSource));
    await trashSource(page.id);
    await restoreSource(item.id);
    await tick(item.id, noCompute(unchangedSource));
    expect((await requireCard(item.id)).properties).toMatchObject({
      status: "needsClarification",
      proposal: null,
      aiProposal: null,
      aiVersion: 2,
      invalidReason: null,
      fingerprint: proposed.properties.fingerprint,
    });
  });

  it("reopens a restored card as needsClarification when a relation target became occupied", async () => {
    const { item } = await typedSource("Create project", { name: "Project", emoji: "📁", targetDatabase: "projects" });
    const api = createChokePoint(pool);
    const projectsId = await databaseIdFor("projects");
    const task = await api.createItem({ databaseId: await databaseIdFor("tasks"), properties: { name: "Task" } });
    await tick(item.id, propose({ name: "Project" }, { relations: { tasks: [task.id] } }));
    const proposed = await requireCard(item.id);
    expect(proposed.properties.status).toBe("proposed");
    await trashSource(item.id);
    await tick(item.id, noCompute("Deleted source must not be computed"));
    const other = await api.createItem({ databaseId: projectsId, properties: { name: "Other" } });
    const property = await withTransaction(pool, (client) =>
      propertiesStore.getPropertyByKey(client, projectsId, "tasks"),
    );
    if (!property) throw new Error("Missing Projects.tasks relation");
    // In a tenant scope, as a request is: a write of a Tasks.project edge queues value-link propagation.
    await runInTenant(getTenantZeroId(), () =>
      api.createRelation({ relationPropertyId: property.id, callerItemId: other.id, targetItemId: task.id }),
    );
    await restoreSource(item.id);
    await tick(item.id, noCompute("Unchanged source must not be recomputed"));
    expect((await requireCard(item.id)).properties).toMatchObject({
      status: "needsClarification",
      proposal: null,
      invalidReason: null,
      fingerprint: proposed.properties.fingerprint,
    });
    expect(await api.listItemRelations(other.id, property.id)).toMatchObject([{ targetItemId: task.id }]);
  });

  it("a restored source with no recognized type makes its invalid card needsClarification with no reason", async () => {
    const item = await createSource();
    await tick(item.id, unrecognized);
    await trashSource(item.id);
    await tick(item.id, noCompute(deletedSource));
    expect((await requireCard(item.id)).properties.invalidReason).toMatchObject({ code: "sourceDeleted" });
    await restoreSource(item.id);
    await tick(item.id, unrecognized);
    const card = await requireCard(item.id);
    expect(card.properties).toMatchObject({ status: "needsClarification", invalidReason: null });
    expect(card.properties.history).toHaveLength(3);
  });

  async function invalidateCard(itemId: string, code?: string) {
    const card = await requireCard(itemId);
    const reason = { code, field: "target", itemId: await databaseIdFor("tasks"), label: "Tasks" };
    await storeEdit(proposalsId, card.id, { status: "invalid", ...(code ? { invalidReason: reason } : {}) });
    return card;
  }

  it.each(["targetArchived", "targetDeleted", "legacy", "otherSource"] as const)(
    "source deletion supersedes %s invalidity and repeated deletion is a no-op",
    async (kind) => {
      const { item } = await typedSource();
      await tick(item.id, propose({ name: "Buy milk" }));
      const proposed = await invalidateCard(
        item.id,
        kind === "legacy" ? undefined : kind === "otherSource" ? "sourceDeleted" : kind,
      );
      const before = await requireCard(item.id);
      await trashSource(item.id);
      await tick(item.id, noCompute(deletedSource));
      const deleted = await requireCard(item.id);
      expect(deleted.properties.status).toBe("invalid");
      expect(deleted.properties.invalidReason).toEqual(sourceDeletedReason(item.id));
      expect(historyOf(deleted)).toHaveLength(historyOf(before).length + 1);
      expect(historyOf(deleted).at(-1)).toMatchObject({ author: "ai", kind: "invalidated" });
      await tick(item.id, noCompute(deletedSource));
      expect(await cardOf(item.id)).toEqual(deleted);
      await restoreSource(item.id);
      await tick(item.id, noCompute(unchangedSource));
      expect((await requireCard(item.id)).properties).toMatchObject({
        status: "proposed",
        invalidReason: null,
        proposal: proposed.properties.proposal,
      });
    },
  );

  it("a restore tick leaves targetArchived unchanged when no deletion transition occurred", async () => {
    const { item } = await typedSource();
    await tick(item.id, propose({ name: "Buy milk" }));
    await invalidateCard(item.id, "targetArchived");
    const before = await cardOf(item.id);
    await trashSource(item.id);
    await restoreSource(item.id);
    await tick(item.id, noCompute("unchanged source must not recompute"));
    expect(await cardOf(item.id)).toEqual(before);
  });

  it("a proposed envelope naming an unknown property on the target database fails validation and is stored as needsClarification, never as proposed", async () => {
    const { item } = await typedSource();
    await tick(item.id, propose({ name: "Buy milk", notAKey: "x" }));
    const proposal = await requireCard(item.id);
    expect(proposal.properties).toMatchObject({ status: "needsClarification", proposal: null });
    expect(proposal.properties.history).toHaveLength(1);
    expect(await countItems(await databaseIdFor("tasks"))).toBe(0);
  });

  it("a proposed envelope trying to set a relation property directly fails validation", async () => {
    const { item } = await typedSource();
    await tick(item.id, propose({ name: "Buy milk", project: "some-project-id" }));
    expect((await requireCard(item.id)).properties.status).toBe("needsClarification");
  });

  it.each([
    ["whose target is not an existing item", "missing", { flavour: "paragraph" }],
    ["missing block content (flavour)", "type", { note: "no flavour here" }],
    ["whose 'fields' is not a plain object", "type", { flavour: "paragraph", fields: "not an object" }],
    ["whose 'children' is not an array of strings", "type", { flavour: "paragraph", children: [1, 2, 3] }],
  ] as const)("a pageContent envelope %s fails validation", async (_, target, properties) => {
    const { type, item } = await typedSource("A thought", PAGE_TYPE);
    await tick(
      item.id,
      propose(properties, { target: target === "type" ? type.id : "00000000-0000-0000-0000-000000000000" }),
    );
    expect((await requireCard(item.id)).properties.status).toBe("needsClarification");
  });

  it("a repeated tick with the same invalid envelope does not call computeProposal again", async () => {
    const { item } = await typedSource();
    const counter = counted({ properties: { notAKey: "x" } });
    await tick(item.id, counter.compute);
    await tick(item.id, counter.compute);
    expect(counter.calls).toBe(1);
    const proposal = await requireCard(item.id);
    expect(proposal.properties.status).toBe("needsClarification");
    expect(proposal.properties.history).toHaveLength(1);
  });
});

describe("semprec.tick re-checks the proposal under lock before writing it", () => {
  beforeEach(resetTickDatabases);

  /** A typed Inbox item with one `proposed` card, then a text edit so the next tick recomputes it. */
  async function seedProposedCardWithChangedSource() {
    const { item } = await typedSource();
    await tick(item.id, propose({ name: "Buy milk" }));
    const card = await requireCard(item.id);
    expect(card.properties.status).toBe("proposed");
    await storeEdit(inboxId, item.id, { text: "Buy milk and eggs" });
    return { item, card };
  }

  const readCard = async (cardId: string) =>
    (await withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, cardId)))!;

  /**
   * Wraps `pool` so that `beforeLock` runs and commits on its own connection right before the tick's first
   * `SELECT ... FOR UPDATE` on `cardId`: the gap between the tick's unlocked snapshot and its locked
   * re-check, on paths that call no `computeProposal`.
   */
  function poolRunningBeforeCardLock(cardId: string, beforeLock: () => Promise<void>): Pool {
    let fired = false;
    return interceptConnect(pool, (client) =>
      interceptQuery(client, async (args, original) => {
        const [text, params] = args;
        if (
          !fired &&
          typeof text === "string" &&
          /FOR (NO KEY )?UPDATE/.test(text) &&
          Array.isArray(params) &&
          params.includes(cardId)
        ) {
          fired = true;
          await beforeLock();
        }
        return original(...args);
      }),
    );
  }

  const rejectCard = async (cardId: string) => (await storeEdit(proposalsId, cardId, { status: "rejected" })).updatedAt;
  const softDeleteCard = async (cardId: string) =>
    (await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, proposalsId, cardId)))!.updatedAt;

  /** A computed envelope naming a property the `tasks` database lacks, so the tick lands in `needsClarification`. */
  const invalidEnvelope = { properties: { noSuchProperty: "x" } };
  const recomputed = { properties: { name: "Buy milk and eggs" } };

  it.each([
    ["needsClarification", invalidEnvelope],
    ["proposed", recomputed],
  ] as const)(
    "%s path: a card soft-deleted while the tick computes its proposal is skipped without writing or throwing",
    async (_, result) => {
      const { item, card } = await seedProposedCardWithChangedSource();
      let deletedVersion: string | undefined;
      await tick(item.id, async () => {
        deletedVersion = await softDeleteCard(card.id);
        return result;
      });
      const after = await readCard(card.id);
      expect(after.deletedAt).not.toBeNull();
      expect(after.updatedAt).toBe(deletedVersion);
      expect(after.properties).toEqual(card.properties);
      expect(await countItems(proposalsId)).toBe(1);
    },
  );

  it("needsClarification path: a reject committed while the tick computes its proposal wins — the card stays rejected and untouched", async () => {
    const { item, card } = await seedProposedCardWithChangedSource();
    let rejectedVersion: string | undefined;
    await tick(item.id, async () => {
      rejectedVersion = await rejectCard(card.id);
      return invalidEnvelope;
    });
    const after = await readCard(card.id);
    expect(after.updatedAt).toBe(rejectedVersion);
    expect(after.properties).toEqual({ ...card.properties, status: "rejected" });
  });

  it.each(["reject", "soft-delete"] as const)(
    "deleted-source path: a %s committed before the tick locks the card wins — the card is not invalidated",
    async (change) => {
      const { item, card } = await seedProposedCardWithChangedSource();
      await trashSource(item.id);
      let version: string | undefined;
      const tickPool = poolRunningBeforeCardLock(card.id, async () => {
        version = change === "reject" ? await rejectCard(card.id) : await softDeleteCard(card.id);
      });
      await tick(item.id, async () => expect.unreachable("a deleted source is never recomputed"), tickPool);
      expect(version).toBeDefined();
      const after = await readCard(card.id);
      expect(after.updatedAt).toBe(version);
      if (change === "reject") expect(after.properties).toEqual({ ...card.properties, status: "rejected" });
      else {
        expect(after.deletedAt).not.toBeNull();
        expect(after.properties).toEqual(card.properties);
      }
    },
  );

  it("restored-source path: a reject committed before the tick locks the card wins — the card is not reopened", async () => {
    const { item, card } = await seedProposedCardWithChangedSource();
    await trashSource(item.id);
    await tick(item.id, async () => expect.unreachable("a deleted source is never recomputed"));
    await restoreSource(item.id);
    const invalid = await readCard(card.id);
    expect(invalid.properties.status).toBe("invalid");
    let rejectedVersion: string | undefined;
    const tickPool = poolRunningBeforeCardLock(card.id, async () => {
      rejectedVersion = await rejectCard(card.id);
    });
    await tick(item.id, async () => expect.unreachable("a card that lost the lock is not recomputed"), tickPool);
    expect(rejectedVersion).toBeDefined();
    const after = await readCard(card.id);
    expect(after.updatedAt).toBe(rejectedVersion);
    expect(after.properties).toEqual({ ...invalid.properties, status: "rejected" });
  });

  it("deleted-source path: a lock failure other than a serialization conflict propagates and writes nothing", async () => {
    const { item, card } = await seedProposedCardWithChangedSource();
    await trashSource(item.id);
    const tickPool = poolRunningBeforeCardLock(card.id, async () => {
      throw new Error("connection lost while locking the card");
    });
    await expect(
      tick(item.id, async () => expect.unreachable("a deleted source is never recomputed"), tickPool),
    ).rejects.toThrow("connection lost while locking the card");
    const after = await readCard(card.id);
    expect(after.updatedAt).toBe(card.updatedAt);
    expect(after.properties).toEqual(card.properties);
  });

  it("a confirm committed while the tick computes its proposal wins — the card stays confirmed and untouched", async () => {
    const { item, card } = await seedProposedCardWithChangedSource();
    // The tick and the confirm both enqueue the source's Journal-day recompute under the same job
    // key, so a confirm issued from inside the tick would wait on the tick's own transaction. Taking
    // the source off its Journal day leaves the proposal row as the only thing the two contend on.
    await withTransaction(pool, async (client) => {
      const journalDayProperty = await propertiesStore.getPropertyByKey(client, inboxId, "journalDay");
      const relationDefinition = await relationsStore.getRelationDefinitionByPropertyId(client, journalDayProperty!.id);
      const edges = await relationsStore.listRelationsForItem(client, relationDefinition!.id, item.id);
      for (const edge of edges) {
        await relationsStore.deleteItemRelation(client, edge.relationDefinitionId, edge.itemA, edge.itemB);
      }
    });
    const counter = counted(recomputed);
    await tick(item.id, async (input) => {
      await withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, card.id),
      );
      return counter.compute(input);
    });
    expect(counter.calls).toBe(1);
    const after = await readCard(card.id);
    expect(after.properties).toMatchObject({
      status: "confirmed",
      proposal: card.properties.proposal,
      fingerprint: card.properties.fingerprint,
    });
    expect(historyOf(after).map((entry) => entry.message)).not.toContain(
      "Revised the proposal after the source item changed.",
    );
  });
});

type Overlap = ReturnType<typeof ownOverlap>;

/** Runs `body` with an owned overlap on `runtime`, then settles it; body and cleanup failures are both kept. */
async function withOverlap(runtime: Pool, cancel: () => void, body: (owned: Overlap) => Promise<void>) {
  const owned = ownOverlap(runtime, cancel);
  let failure: { error: unknown } | undefined;
  try {
    await body(owned);
  } catch (error) {
    failure = { error };
  } finally {
    cancel();
    try {
      await owned.finish(failure !== undefined);
    } catch (error) {
      failure = combineOverlapFailure(failure, error);
    }
  }
  if (failure) throw failure.error;
}

/** Polls until `holder` blocks `competitor`, failing early if a participant settles first. */
async function expectBlocked(
  owned: Overlap,
  runtime: Pool,
  holder: number | undefined,
  competitor: number | undefined,
  ...actors: Promise<unknown>[]
) {
  let blocked = false;
  for (let n = 0; n < 100 && !blocked; n++) {
    const result = await owned.wait(
      owned.run(() =>
        runInTenant(getTenantZeroId(), () =>
          runtime.query<{ blocked: boolean }>("SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked", [
            holder,
            competitor,
          ]),
        ),
      ),
      ...actors,
    );
    blocked = result.rows[0]?.blocked === true;
    if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(blocked).toBe(true);
}

const ownedCard = (owned: Overlap, runtime: Pool, itemId: string) =>
  boundedBarrier(
    owned.run(() => runInTenant(getTenantZeroId(), () => findProposalForItem(runtime, proposalsId, itemId))),
  );

/** The tick handler called directly, as the heartbeat calls it. */
const directTick = (tickPool: Pool, itemId: string, compute: ComputeSemprecProposalFn, heartbeatId = "hb") =>
  createSemprecTickAction(tickPool, compute)(databaseIds, { heartbeatId, projectItemId: "proj", itemId });

function expectRuntimeSettled(runtime: Pool) {
  expect(runtime.ended).toBe(true);
  expect(runtime.totalCount).toBe(0);
  expect(runtime.waitingCount).toBe(0);
  expect(runtime.listenerCount("acquire")).toBe(0);
  expect(runtime.listenerCount("release")).toBe(0);
}

function expectCombined(failure: { error: unknown } | undefined, first: unknown): AggregateError {
  const combined = failure?.error;
  if (!(combined instanceof AggregateError)) throw new Error("Expected combined failure", { cause: combined });
  expect(combined.cause).toBe(first);
  expect(combined.errors).toHaveLength(2);
  expect(combined.errors[0]).toBe(first);
  const cleanup: unknown = combined.errors[1];
  if (!(cleanup instanceof AggregateError)) throw new Error("Expected cleanup failure", { cause: cleanup });
  return cleanup;
}

/** Records the `error` events of each checked-out client of `runtime`, tagged with its overlap generation. */
function observeCheckoutErrors(runtime: Pool) {
  const generations = new Map<PoolClient, object>();
  const cancellationRequests = new Set<object>();
  const diagnostics: Array<{ error: Error; cancelled: boolean }> = [];
  const observing = new Map<PoolClient, (error: Error) => void>();
  const onAcquire = (client: PoolClient) => {
    const generation = generations.get(client);
    if (!generation) throw new Error("Missing client generation");
    const onError = (error: Error) => diagnostics.push({ error, cancelled: cancellationRequests.has(generation) });
    observing.set(client, onError);
    client.on("error", onError);
  };
  const onRelease = (_reason: unknown, client: PoolClient) => {
    const onError = observing.get(client);
    if (onError) client.removeListener("error", onError);
    observing.delete(client);
    generations.delete(client);
  };
  return {
    generations,
    cancellationRequests,
    onCancellation: (_client: PoolClient, generation: object) => cancellationRequests.add(generation),
    onGeneration: (client: PoolClient, generation: object) => generations.set(client, generation),
    attach: () => {
      runtime.on("acquire", onAcquire);
      runtime.on("release", onRelease);
    },
    /** Detaches and checks the cleanup aggregate: the cancel error, every diagnostic, then the operation error. */
    detachAndExpect: (cleanup: AggregateError, cleanupError: unknown, operationError: unknown) => {
      runtime.removeListener("acquire", onAcquire);
      runtime.removeListener("release", onRelease);
      expect(observing.size).toBe(0);
      for (const diagnostic of diagnostics) {
        expect(diagnostic.cancelled).toBe(true);
        expect(diagnostic.error).toBe(operationError);
      }
      const expected = [cleanupError, ...diagnostics.map((entry) => entry.error), operationError];
      expect(cleanup.errors).toHaveLength(expected.length);
      for (const [index, error] of expected.entries()) expect(cleanup.errors[index]).toBe(error);
      expect(cleanup.cause).toBe(cleanupError);
    },
  };
}

describe("the owned-overlap test harness", () => {
  beforeEach(resetTickDatabases);

  it.each([undefined, { marker: "late" }])(
    "retains a late participant failure and consumes only the asserted participant %#",
    async (late) => {
      const { item } = await typedSource("Tracked overlap");
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      const held = barrier();
      const competing = barrier();
      const owned = ownOverlap(runtime, held.release);
      const expected = { marker: "asserted" };
      const body = new Error("forced observation failure");
      let lateSettled = false;
      let holderPid: number | undefined;
      let competitorPid: number | undefined;
      let competitorError: { value: unknown } | undefined;
      let failure: { error: unknown } | undefined;
      const editSource = (text: string, before: (client: PoolClient) => Promise<void>, after?: () => Promise<void>) =>
        owned.run(() =>
          withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
            await before(client);
            await updateItemWithClient(client, { databaseId: inboxId, itemId: item.id, propertiesPatch: { text } });
            await after?.();
          }),
        );
      try {
        const negative = owned.run(() =>
          withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
            await client.query<{ "?column?": number }>("SELECT 1");
            rethrowOverlap(expected);
          }),
        );
        await expect(negative).rejects.toBe(expected);
        owned.consume(negative, expected);
        const participant = editSource(
          "Held",
          async (client) => {
            holderPid = await pidOf(client);
          },
          async () => {
            held.reached();
            await held.gate;
            rethrowOverlap(late);
          },
        );
        void participant.then(
          () => (lateSettled = true),
          () => (lateSettled = true),
        );
        await owned.wait(held.ready, participant);
        const competitor = editSource("Competing", async (client) => {
          competitorPid = await pidOf(client);
          competing.reached();
        });
        void competitor.catch((error: unknown) => {
          competitorError = { value: error };
        });
        await owned.wait(competing.ready, participant, competitor);
        await expectBlocked(owned, runtime, holderPid, competitorPid, participant, competitor);
        failure = { error: body };
        held.release();
        await Promise.allSettled([participant, competitor]);
      } catch (error) {
        failure = { error };
      } finally {
        try {
          await owned.finish(failure !== undefined);
        } catch (error) {
          failure = combineOverlapFailure(failure, error);
        }
      }
      if (failure && (!(failure.error instanceof AggregateError) || failure.error.cause !== body)) throw failure.error;
      const cleanup = expectCombined(failure, body);
      expect(cleanup.errors).toHaveLength(1);
      expect(cleanup.errors[0]).toBe(late);
      expect(cleanup.cause).toBe(late);
      expect(competitorError).toBeUndefined();
      expect(lateSettled).toBe(true);
      expectRuntimeSettled(runtime);
    },
    20000,
  );

  it("settles ownership when the first participant has the wrong rejection", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    const wrong = { marker: "wrong" };
    const cleanupError = new Error("controlled cleanup failure");
    const owned = ownOverlap(runtime, () => {
      throw cleanupError;
    });
    let assertion: { error: unknown } | undefined;
    let failure: { error: unknown } | undefined;
    try {
      const negative = owned.run(() =>
        withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
          await client.query<{ "?column?": number }>("SELECT 1");
          rethrowOverlap(wrong);
        }),
      );
      try {
        await expect(negative).rejects.toBe({ marker: "expected" });
      } catch (error) {
        assertion = { error };
        throw error;
      }
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
    const cleanup = expectCombined(failure, assertion.error);
    expect(cleanup.errors).toHaveLength(2);
    expect(cleanup.errors[0]).toBe(cleanupError);
    expect(cleanup.errors[1]).toBe(wrong);
    expect(cleanup.cause).toBe(cleanupError);
    expectRuntimeSettled(runtime);
  }, 20000);

  it("preserves an early checkout failure together with cleanup failure", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    const actorError = new Error("pre-verify checkout failure");
    const cleanupError = new Error("cleanup failure");
    const signal = barrier();
    runtime.options.verify = (_client, done) => done(actorError);
    const observer = observeCheckoutErrors(runtime);
    const owned = ownOverlap(
      runtime,
      () => {
        signal.release();
        throw cleanupError;
      },
      observer.onCancellation,
      observer.onGeneration,
    );
    let operationFailure: { value: unknown } | undefined;
    observer.attach();
    let failure: { error: unknown } | undefined;
    try {
      const actor = owned.run(() => withTenantTransaction(runtime, getTenantZeroId(), async () => {}));
      void actor.catch((error: unknown) => {
        operationFailure = { value: error };
      });
      await owned.wait(signal.gate, actor);
    } catch (error) {
      failure = { error };
    } finally {
      try {
        await owned.finish(failure !== undefined);
      } catch (error) {
        failure = combineOverlapFailure(failure, error);
      }
    }
    const cleanup = expectCombined(failure, actorError);
    if (!operationFailure) throw new Error("Missing operation failure");
    expect(operationFailure.value).toBe(actorError);
    observer.detachAndExpect(cleanup, cleanupError, operationFailure.value);
    expectRuntimeSettled(runtime);
  }, 20000);

  it("refuses overlap success while a runtime client remains checked out", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    const owned = ownOverlap(runtime, () => {});
    let bodyFailure: { error: unknown } | undefined;
    let cleanupFailure: unknown;
    try {
      await owned.run(() => runInTenant(getTenantZeroId(), () => runtime.connect()));
    } catch (error) {
      bodyFailure = { error };
    } finally {
      try {
        await owned.finish(bodyFailure !== undefined);
      } catch (error) {
        cleanupFailure = error;
      }
    }
    if (bodyFailure)
      throw cleanupFailure === undefined ? bodyFailure.error : combineOverlapFailure(bodyFailure, cleanupFailure).error;
    expect(cleanupFailure).toMatchObject({ message: "Overlap cleanup failed" });
    expectRuntimeSettled(runtime);
  }, 20000);

  it("settles late overlap checkout and preserves a simultaneous cleanup failure", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    const verifying = barrier();
    let deliver = () => {};
    const bodyError = new Error("body failure");
    const cleanupError = new Error("cleanup failure");
    let ran = false;
    let settled = false;
    let checkoutGeneration: object | undefined;
    const observer = observeCheckoutErrors(runtime);
    runtime.options.verify = (client, done) => {
      checkoutGeneration = observer.generations.get(client);
      deliver = () => queueMicrotask(() => done());
      verifying.reached();
    };
    const owned = ownOverlap(
      runtime,
      () => {
        deliver();
        throw cleanupError;
      },
      observer.onCancellation,
      observer.onGeneration,
    );
    let operationFailure: { value: unknown; generation: object | undefined; cancelled: boolean } | undefined;
    const operation = owned.run(() =>
      withTenantTransaction(runtime, getTenantZeroId(), async () => {
        ran = true;
      }),
    );
    void operation.then(
      () => (settled = true),
      (error: unknown) => {
        operationFailure = {
          value: error,
          generation: checkoutGeneration,
          cancelled: checkoutGeneration !== undefined && observer.cancellationRequests.has(checkoutGeneration),
        };
        settled = true;
      },
    );
    observer.attach();
    let failure: { error: unknown } | undefined;
    try {
      await owned.wait(verifying.ready, operation);
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
    const cleanup = expectCombined(failure, bodyError);
    if (!operationFailure) throw new Error("Missing operation failure");
    expect(operationFailure.generation).toBeDefined();
    expect(operationFailure.cancelled).toBe(true);
    expect(isOwnedPgClosure(operationFailure.value, "Client was closed and is not queryable")).toBe(true);
    expect(isOwnedPgClosure(new Error("unrelated post-cancel failure"), "Client was closed and is not queryable")).toBe(
      false,
    );
    observer.detachAndExpect(cleanup, cleanupError, operationFailure.value);
    expect(ran).toBe(false);
    expect(settled).toBe(true);
    expectRuntimeSettled(runtime);
  }, 20000);
});

describe("semprec.tick brackets computeProposal outside any transaction", () => {
  beforeEach(resetTickDatabases);

  it("holds no transaction and no pooled connection during the computeProposal call", async () => {
    const { item } = await typedSource();
    // A dedicated single-connection pool: if the tick held its connection across `computeProposal`, this
    // query, issued from inside the fake, could never acquire one.
    const tickPool = getTestPool({ max: 1 });
    try {
      await directTick(tickPool, item.id, async (input) => {
        await bounded(tickPool.query("SELECT 1"), 2000, "computeProposal: no free pooled connection");
        expect(input.entityKind).toBe("database");
        return { properties: { name: "Buy milk" } };
      });
    } finally {
      await tickPool.end();
    }
    expect((await cardOf(item.id))?.properties.status).toBe("proposed");
  }, 10000);

  it("writes nothing for a stale envelope when the source changes during computeProposal, and the next tick produces the card for the new fingerprint", async () => {
    const { type, item } = await typedSource();
    await directTick(pool, item.id, async () => {
      await storeEdit(inboxId, item.id, { text: "Buy milk and eggs" });
      return { properties: { name: "Buy milk" } };
    });
    expect(await cardOf(item.id)).toBeNull();
    const counter = counted({ properties: { name: "Buy milk and eggs" } });
    await directTick(pool, item.id, counter.compute);
    expect(counter.calls).toBe(1);
    expect((await requireCard(item.id)).properties).toMatchObject({
      fingerprint: fingerprintV2Of({ typeId: type.id, text: "Buy milk and eggs" }),
      proposal: {
        entityKind: "database",
        target: await databaseIdFor("tasks"),
        properties: { name: "Buy milk and eggs" },
      },
    });
  });

  /** An edit of the source's text in its own runtime transaction, with hooks around the write. */
  const ownedSourceEdit = (
    owned: Overlap,
    runtime: Pool,
    itemId: string,
    text: string,
    before: (client: PoolClient) => Promise<void>,
    after: () => Promise<void>,
  ) =>
    owned.run(() =>
      withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
        await before(client);
        await updateItemWithClient(client, { databaseId: inboxId, itemId, propertiesPatch: { text } });
        await after();
      }),
    );
  const LOCKED_READ = "FROM items WHERE database_id = $1 AND id = $2 FOR NO KEY UPDATE";
  const FINGERPRINT_READ = "COALESCE(b.content_hash";

  it("holds the source through the proposal commit before a competing edit", async () => {
    const { item } = await typedSource("Before the race");
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let postModel = false;
    const atFingerprint = barrier();
    const writerStarted = barrier();
    const writerUpdated = barrier();
    const writerGate = barrier();
    let tickPid: number | undefined;
    let writerPid: number | undefined;
    const observedPool = interceptConnect(runtime, (client) =>
      interceptQuery(client, async (args, original) => {
        const result = await original(...args);
        if (postModel && typeof args[0] === "string" && args[0].includes(FINGERPRINT_READ)) {
          postModel = false;
          tickPid = await pidOf(client);
          atFingerprint.reached();
          await atFingerprint.gate;
        }
        return result;
      }),
    );
    const cancel = () => {
      for (const gate of [atFingerprint, writerStarted, writerUpdated, writerGate]) {
        gate.release();
        gate.reached();
      }
    };
    await withOverlap(runtime, cancel, async (owned) => {
      const running = owned.run(() =>
        runInTenant(getTenantZeroId(), () =>
          directTick(observedPool, item.id, async () => {
            postModel = true;
            return { properties: { name: "Old proposal" } };
          }),
        ),
      );
      running.catch(() => {});
      await owned.wait(atFingerprint.ready, running);
      expect(tickPid).toBeGreaterThan(0);
      const writer = ownedSourceEdit(
        owned,
        runtime,
        item.id,
        "After the race",
        async (client) => {
          writerPid = await pidOf(client);
          writerStarted.reached();
        },
        async () => {
          writerUpdated.reached();
          await writerGate.gate;
        },
      );
      writer.catch(() => {});
      await owned.wait(writerStarted.ready, writer, running);
      expect(writerPid).toBeGreaterThan(0);
      expect(writerPid).not.toBe(tickPid);
      await expectBlocked(owned, runtime, tickPid, writerPid, writer, running);
      atFingerprint.release();
      await running;
      await owned.wait(writerUpdated.ready, writer);
      expect((await ownedCard(owned, runtime, item.id))?.properties.proposal).toMatchObject({
        properties: { name: "Old proposal" },
      });
      writerGate.release();
      await writer;
    });
    const source = await withTransaction(pool, (client) => itemsStore.getItemById(client, inboxId, item.id));
    expect(source?.properties.text).toBe("After the race");
  }, 20000);

  it.each([false, true])(
    "rechecks fresh source data after a competing edit, rollback: %s",
    async (rollback) => {
      const { item } = await typedSource("Before the edit");
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      const writerGate = barrier();
      const tickWaiting = barrier();
      let writerPid: number | undefined;
      let tickPid: number | undefined;
      let postModel = false;
      const rollbackMarker = new Error("intentional edit rollback");
      const observedPool = interceptConnect(runtime, (client) =>
        interceptQuery(client, async (args, original) => {
          if (postModel && typeof args[0] === "string" && args[0].includes(LOCKED_READ)) {
            postModel = false;
            tickPid = await pidOf(client);
            tickWaiting.reached();
          }
          return original(...args);
        }),
      );
      const cancel = () => {
        writerGate.release();
        writerGate.reached();
        tickWaiting.reached();
      };
      await withOverlap(runtime, cancel, async (owned) => {
        const writer = ownedSourceEdit(
          owned,
          runtime,
          item.id,
          "After the edit",
          async (client) => {
            writerPid = await pidOf(client);
          },
          async () => {
            writerGate.reached();
            await writerGate.gate;
            if (rollback) throw rollbackMarker;
          },
        );
        const writerOutcome = writer.then(
          () => null,
          (error: unknown) => error,
        );
        await owned.wait(writerGate.ready, writer);
        const running = owned.run(() =>
          runInTenant(getTenantZeroId(), () =>
            directTick(observedPool, item.id, async () => {
              postModel = true;
              return { properties: { name: "Old proposal" } };
            }),
          ),
        );
        running.catch(() => {});
        await owned.wait(tickWaiting.ready, writer, running);
        expect(writerPid).not.toBe(tickPid);
        await expectBlocked(owned, runtime, writerPid, tickPid, writer, running);
        writerGate.release();
        expect(await writerOutcome).toBe(rollback ? rollbackMarker : null);
        if (rollback) owned.consume(writer, rollbackMarker);
        await running;
        const card = await ownedCard(owned, runtime, item.id);
        if (rollback) expect(card?.properties.proposal).toMatchObject({ properties: { name: "Old proposal" } });
        else expect(card).toBeNull();
      });
    },
    20000,
  );

  it.each(["insert attachment", "remove attachment", "change type"] as const)(
    "serializes %s with tick in both acquisition orders",
    async (mutation) => {
      for (const writerFirst of [true, false]) {
        const { item, type } = await typedSource(`Source ${mutation} ${writerFirst}`);
        const blob = await createBlob(pool, {
          mimeType: "application/pdf",
          byteSize: 3,
          storageKey: `t/${randomUUID()}`,
        });
        let attachmentId: string | undefined;
        let insertedAttachmentId: string | undefined;
        if (mutation === "remove attachment") {
          await insertInboxAttachments(pool, item.id, [{ blobId: blob.id, source: "camera" }]);
          attachmentId = (await listInboxAttachments(pool, [item.id]))[0]?.attachmentId;
          if (!attachmentId) throw new Error("Missing attachment");
        }
        const alternate = await createType({ name: `Alternate ${randomUUID()}`, emoji: "🔵" });
        const relationPropertyId = await withTransaction(pool, inboxTypePropertyId);
        const runtime = await createRuntimeRolePool(pool, "semprec_data");
        // A type edge write and adding or removing an attachment queue the day's recompute under the key the
        // tick's read phase enqueues too, so a tick that starts after any of these writers waits for it there,
        // before it calls the model.
        const modelTypeIds: Array<string | null> = [];
        let postModel = false;
        let tickPid: number | undefined;
        let writerPid: number | undefined;
        const tickGate = barrier();
        const writerGate = barrier();
        const writerMutated = barrier();
        const mutationGate = barrier();
        const observed = interceptConnect(runtime, (client) =>
          interceptQuery(client, async (args, original) => {
            const sql = typeof args[0] === "string" ? args[0] : "";
            const enqueue = tickPid === undefined && sql.includes("graphile_worker.add_job");
            if (writerFirst && (enqueue || (postModel && sql.includes(LOCKED_READ)))) {
              if (!enqueue) postModel = false;
              tickPid = await pidOf(client);
              tickGate.reached();
            }
            const result = await original(...args);
            if (postModel && !writerFirst && sql.includes(FINGERPRINT_READ)) {
              postModel = false;
              tickPid = await pidOf(client);
              tickGate.reached();
              await tickGate.gate;
            }
            return result;
          }),
        );
        const mutate = async (client: PoolClient) => {
          if (mutation === "insert attachment")
            await insertWithClient(client, item.id, [{ blobId: blob.id, source: "camera" }]);
          else if (mutation === "remove attachment") await deleteWithClient(client, z.uuid().parse(attachmentId));
          else {
            await deleteRelationWithClient(client, {
              relationPropertyId,
              callerItemId: item.id,
              targetItemId: type.id,
            });
            await createRelationWithClient(client, {
              relationPropertyId,
              callerItemId: item.id,
              targetItemId: alternate.id,
            });
          }
        };
        const cancel = () => {
          for (const gate of [tickGate, writerGate, writerMutated, mutationGate]) {
            gate.release();
            gate.reached();
          }
        };
        await withOverlap(runtime, cancel, async (owned) => {
          const writer = owned.run(() =>
            withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
              await client.query("SET LOCAL statement_timeout = '5s'");
              writerPid = await pidOf(client);
              if (!writerFirst) {
                writerGate.reached();
                await mutationGate.gate;
              }
              await mutate(client);
              if (mutation === "insert attachment") {
                const inserted = await listInboxAttachments(client, [item.id]);
                if (inserted.length !== 1 || !inserted[0]) throw new Error("Missing inserted attachment");
                insertedAttachmentId = inserted[0].attachmentId;
              }
              writerMutated.reached();
              if (writerFirst) writerGate.reached();
              await writerGate.gate;
            }),
          );
          writer.catch(() => {});
          if (writerFirst) await owned.wait(writerGate.ready, writer);
          const running = owned.run(() =>
            runInTenant(getTenantZeroId(), () =>
              directTick(observed, item.id, async (input) => {
                postModel = true;
                modelTypeIds.push(input.type?.id ?? null);
                return { properties: { name: "Old proposal" } };
              }),
            ),
          );
          running.catch(() => {});
          await owned.wait(tickGate.ready, writer, running);
          if (!writerFirst) {
            await owned.wait(writerGate.ready, writer, running);
            mutationGate.release();
          }
          expect(tickPid).toBeGreaterThan(0);
          expect(writerPid).toBeGreaterThan(0);
          expect(tickPid).not.toBe(writerPid);
          await expectBlocked(
            owned,
            runtime,
            writerFirst ? writerPid : tickPid,
            writerFirst ? tickPid : writerPid,
            writer,
            running,
          );
          if (writerFirst) {
            writerGate.release();
            await writer;
            await running;
            const card = await ownedCard(owned, runtime, item.id);
            // The tick waited in its read phase, so it asked the model about the committed type and stored the answer.
            expect(modelTypeIds).toEqual([mutation === "change type" ? alternate.id : type.id]);
            expect(card?.properties.status).toBe("proposed");
          } else {
            tickGate.release();
            await running;
            await owned.wait(writerMutated.ready, writer);
            expect((await ownedCard(owned, runtime, item.id))?.properties.proposal).toMatchObject({
              properties: { name: "Old proposal" },
            });
            writerGate.release();
            await writer;
          }
          const attachments = await boundedBarrier(
            owned.run(() => runInTenant(getTenantZeroId(), () => listInboxAttachments(runtime, [item.id]))),
          );
          if (mutation === "insert attachment") {
            expect(attachments).toHaveLength(1);
            expect(attachments[0]).toMatchObject({ inboxItemId: item.id, blobId: blob.id, source: "camera" });
            expect(insertedAttachmentId).toBeTruthy();
            expect(attachments[0]?.attachmentId).toBe(insertedAttachmentId);
          } else {
            expect(attachments).toEqual([]);
          }
          const edges = await boundedBarrier(
            owned.run(() =>
              withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
                const definition = await relationsStore.getRelationDefinitionByPropertyId(client, relationPropertyId);
                if (!definition) throw new Error("Missing type definition");
                return relationsStore.listRelationsForItem(client, definition.id, item.id);
              }),
            ),
          );
          expect(edges.map((edge) => relationsStore.otherSide(edge, item.id))).toEqual([
            mutation === "change type" ? alternate.id : type.id,
          ]);
        });
      }
    },
    30000,
  );

  it("skips a busy proposal card without creating another card", async () => {
    const { item } = await typedSource("Original");
    await directTick(pool, item.id, propose({ name: "Original" }));
    const original = await requireCard(item.id);
    await editItem(inboxId, item.id, { text: "Changed" });
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    const held = barrier();
    await withOverlap(runtime, held.release, async (owned) => {
      const holder = owned.run(() =>
        withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
          await itemsStore.lockItemById(client, proposalsId, original.id);
          held.reached();
          await held.gate;
        }),
      );
      await owned.wait(held.ready, holder);
      const running = owned.run(() =>
        runInTenant(getTenantZeroId(), () => directTick(runtime, item.id, propose({ name: "Changed" }))),
      );
      await owned.wait(running, holder);
      const current = await cardOf(item.id);
      expect(current?.id).toBe(original.id);
      expect(current?.properties).toEqual(original.properties);
      expect(await countItems(proposalsId)).toBe(1);
    });
  }, 20000);

  it.each(["delete", "restore"] as const)(
    "skips a busy raw type during its %s transaction",
    async (operation) => {
      const { item, type } = await typedSource(`Type ${operation}`);
      if (operation === "restore") await createChokePoint(pool).softDeleteItem(typesId, type.id);
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      const atCommit = barrier();
      const observed = interceptConnect(runtime, (client) =>
        interceptQuery(client, async (args, original) => {
          if (typeof args[0] === "string" && args[0].trim().toUpperCase() === "COMMIT") {
            atCommit.reached();
            await atCommit.gate;
          }
          return original(...args);
        }),
      );
      await withOverlap(runtime, atCommit.release, async (owned) => {
        const writer = owned.run(() =>
          runInTenant(getTenantZeroId(), () => {
            const api = createChokePoint(observed);
            return operation === "delete" ? api.softDeleteItem(typesId, type.id) : api.restoreItem(typesId, type.id);
          }),
        );
        await owned.wait(atCommit.ready, writer);
        const running = owned.run(() =>
          runInTenant(getTenantZeroId(), () => directTick(runtime, item.id, propose({ name: "Old" }))),
        );
        await owned.wait(running, writer);
        expect(await cardOf(item.id)).toBeNull();
      });
    },
    20000,
  );

  it("allows distinct sources sharing a type to form proposals concurrently", async () => {
    const { item, type } = await typedSource("First source");
    const other = await createSource({ text: "Second source", type: type.id });
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    const held = barrier();
    let postModel = false;
    const observed = interceptConnect(runtime, (client) =>
      interceptQuery(client, async (args, original) => {
        const result = await original(...args);
        if (postModel && typeof args[0] === "string" && args[0].includes(FINGERPRINT_READ)) {
          postModel = false;
          held.reached();
          await held.gate;
        }
        return result;
      }),
    );
    await withOverlap(runtime, held.release, async (owned) => {
      const first = owned.run(() =>
        runInTenant(getTenantZeroId(), () =>
          directTick(
            observed,
            item.id,
            async () => {
              postModel = true;
              return { properties: { name: "First" } };
            },
            "hb-a",
          ),
        ),
      );
      await owned.wait(held.ready, first);
      const second = owned.run(() =>
        runInTenant(getTenantZeroId(), () => directTick(runtime, other.id, propose({ name: "Second" }), "hb-b")),
      );
      await owned.wait(second, first);
      expect((await cardOf(other.id))?.properties.status).toBe("proposed");
    });
    expect((await cardOf(item.id))?.properties.status).toBe("proposed");
  }, 20000);

  it("a proposal created by a second tick while the first is still in computeProposal is revised, not duplicated", async () => {
    const { item } = await typedSource();
    // Neither tick sees the other's proposal in its snapshot: A's read precedes B's full run inside A's
    // computeProposal, and B reads before A writes. Both reach `writeTickResult` with a null
    // `snapshot.existingProposal`, the race `raceProposal` catches.
    await directTick(
      pool,
      item.id,
      async () => {
        await directTick(pool, item.id, propose({ name: "Buy milk (from B)" }), "hb-b");
        return { properties: { name: "Buy milk (from A)" } };
      },
      "hb-a",
    );
    expect(await countItems(proposalsId)).toBe(1);
    const proposal = await requireCard(item.id);
    expect(proposal.properties).toMatchObject({
      status: "proposed",
      proposal: {
        entityKind: "database",
        target: await databaseIdFor("tasks"),
        properties: { name: "Buy milk (from A)" },
      },
    });
    expect(proposal.properties.history).toHaveLength(2);
  });
});

describe("semprec.tick records a failed proposal computation on the card", () => {
  beforeEach(resetTickDatabases);

  /** One attempt of the tick with a stubbed computation; `isFinalAttempt` is what the heartbeat fire task passes. */
  const attempt = (itemId: string, computeProposal: ComputeSemprecProposalFn, isFinalAttempt: boolean) =>
    createSemprecTickAction(pool, computeProposal)(databaseIds, {
      heartbeatId: "hb",
      projectItemId: "proj",
      itemId,
      isFinalAttempt,
    });
  const failingWith =
    (reason: AiGatewayFailureReason, before?: () => Promise<unknown>): ComputeSemprecProposalFn =>
    async () => {
      await before?.();
      throw new AiGatewayFailedError(reason);
    };
  const failureEntry = (reason: string) =>
    expect.objectContaining({ author: "ai", message: `Computing the proposal failed: ${reason}.` });

  it("a budget rejection creates a computeFailed card naming the reason, and the tick does not throw", async () => {
    const { item } = await typedSource();
    let calls = 0;
    await expect(
      attempt(
        item.id,
        failingWith("budget_exceeded", async () => calls++),
        false,
      ),
    ).resolves.toBeUndefined();
    expect(calls).toBe(1);
    const card = await requireCard(item.id);
    expect(card.properties.status).toBe("computeFailed");
    expect(card.properties.fingerprint ?? null).toBeNull();
    expect(card.properties.proposal ?? null).toBeNull();
    expect(card.properties.history).toEqual([failureEntry("budget_exceeded")]);
  });

  it.each(["timeout", "http", "invalid_response"] as const)(
    "a %s failure rethrows on a non-final attempt without a card, and records the card on the final one",
    async (reason) => {
      const { item } = await typedSource();
      await expect(attempt(item.id, failingWith(reason), false)).rejects.toThrow(`AI gateway call failed: ${reason}`);
      expect(await cardOf(item.id)).toBeNull();
      await expect(attempt(item.id, failingWith(reason), true)).resolves.toBeUndefined();
      const card = await requireCard(item.id);
      expect(card.properties.status).toBe("computeFailed");
      expect(card.properties.history).toEqual([failureEntry(reason)]);
    },
  );

  it("retains the gateway failure and recording failure when the card write fails", async () => {
    const { item } = await typedSource();
    const gatewayError = new AiGatewayFailedError("budget_exceeded");
    // A fixed test trigger forces the card INSERT to fail after the model error; no user input enters DDL.
    await pool.query(`CREATE FUNCTION test_fail_compute_card() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test card write failure'; END $$`);
    const failures: unknown[] = [];
    try {
      await pool.query(
        "CREATE TRIGGER test_fail_compute_card BEFORE INSERT ON items FOR EACH ROW EXECUTE FUNCTION test_fail_compute_card()",
      );
      const received = await attempt(
        item.id,
        async () => {
          throw gatewayError;
        },
        false,
      ).catch((error: unknown) => error);
      if (!(received instanceof AggregateError)) throw new Error("Expected both failures", { cause: received });
      expect(received.errors).toHaveLength(2);
      expect(received.errors[0]).toBe(gatewayError);
      expect(received.errors[1]).toMatchObject({ code: "P0001", message: "test card write failure" });
    } catch (error) {
      failures.push(error);
    }
    for (const statement of [
      "DROP TRIGGER IF EXISTS test_fail_compute_card ON items",
      "DROP FUNCTION IF EXISTS test_fail_compute_card()",
    ]) {
      try {
        await pool.query(statement);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Failure-path test or cleanup failed");
    expect(await cardOf(item.id)).toBeNull();
  });

  it("an error that is not a gateway failure propagates even on the final attempt, and writes nothing", async () => {
    const { item } = await typedSource();
    await expect(attempt(item.id, noCompute("the answer did not match the schema"), true)).rejects.toThrow(
      "the answer did not match the schema",
    );
    expect(await cardOf(item.id)).toBeNull();
  });

  it.each(["edited", "deleted"] as const)(
    "an item %s while the failing call is in flight writes no card, even on the final attempt",
    async (change) => {
      const { item } = await typedSource();
      const before = () =>
        change === "edited" ? storeEdit(inboxId, item.id, { text: "Buy milk and eggs" }) : trashSource(item.id);
      await expect(attempt(item.id, failingWith("timeout", before), true)).resolves.toBeUndefined();
      expect(await cardOf(item.id)).toBeNull();
    },
  );

  it.each(["confirmed", "rejected"] as const)(
    "a card that became %s while the failing call was in flight stays untouched",
    async (lockedStatus) => {
      const { item } = await typedSource();
      await attempt(item.id, propose({ name: "Buy milk" }), false);
      const proposed = await requireCard(item.id);
      expect(proposed.properties.status).toBe("proposed");
      await storeEdit(inboxId, item.id, { text: "Buy milk and eggs" });
      const lock = () => storeEdit(proposalsId, proposed.id, { status: lockedStatus });
      await expect(attempt(item.id, failingWith("timeout", lock), true)).resolves.toBeUndefined();
      const after = await requireCard(item.id);
      expect(after.properties.status).toBe(lockedStatus);
      expect(after.properties.history).toEqual(proposed.properties.history);
    },
  );

  it("a card that already exists keeps its proposal and gains the failure entry", async () => {
    const { item } = await typedSource();
    await attempt(item.id, propose({ name: "Buy milk" }), false);
    const proposed = await requireCard(item.id);
    await storeEdit(inboxId, item.id, { text: "Buy milk and eggs" });
    await attempt(item.id, failingWith("timeout"), true);
    const card = await requireCard(item.id);
    expect(card.id).toBe(proposed.id);
    expect(card.properties.status).toBe("computeFailed");
    expect(card.properties.fingerprint ?? null).toBeNull();
    expect(card.properties.proposal).toEqual(proposed.properties.proposal);
    expect(card.properties.history).toEqual([...historyOf(proposed), failureEntry("timeout")]);
  });

  it("the next successful tick after a failure makes the card proposed with a fresh fingerprint", async () => {
    const { type, item } = await typedSource();
    await attempt(item.id, failingWith("budget_exceeded"), false);
    // The source did not change, but a null fingerprint is never current, so the tick computes again.
    const counter = counted({ properties: { name: "Buy milk" } });
    await attempt(item.id, counter.compute, false);
    expect(counter.calls).toBe(1);
    expect((await requireCard(item.id)).properties).toMatchObject({
      status: "proposed",
      fingerprint: fingerprintV2Of({ typeId: type.id, text: "Buy milk" }),
      proposal: { entityKind: "database", target: await databaseIdFor("tasks"), properties: { name: "Buy milk" } },
    });
  });
});

describe("assertValidProposalEnvelope resolves the target database and validates relations", () => {
  beforeEach(resetTickDatabases);
  const validateEnvelope = (envelope: Parameters<typeof assertValidProposalEnvelope>[1]) =>
    withTransaction(pool, (client) => assertValidProposalEnvelope(client, envelope));
  const refusalOf = (promise: Promise<unknown>) => promise.catch((error: unknown) => error);

  it("resolves to the target database row for a 'database' envelope and to null for a 'pageContent' one", async () => {
    const tasksDbId = await databaseIdFor("tasks");
    expect(
      (await validateEnvelope({ entityKind: "database", target: tasksDbId, properties: { name: "Buy milk" } }))?.id,
    ).toBe(tasksDbId);
    const type = await createType(PAGE_TYPE);
    expect(
      await validateEnvelope({ entityKind: "pageContent", target: type.id, properties: { flavour: "paragraph" } }),
    ).toBeNull();
  });

  describe("envelope relations", () => {
    const createProject = async (properties: Record<string, unknown>) =>
      (
        await withTransaction(pool, async (client) =>
          createItemWithClient(client, { databaseId: await databaseIdFor("projects"), properties }),
        )
      ).id;
    const validate = async (relations: Record<string, string[]>, entityKind: "database" | "pageContent" = "database") =>
      validateEnvelope({
        entityKind,
        target: await databaseIdFor("tasks"),
        properties: entityKind === "database" ? { name: "Buy milk" } : { flavour: "paragraph" },
        relations,
      });

    it("keeps stored relations when the envelope is parsed", async () => {
      const stored = {
        entityKind: "database",
        target: await databaseIdFor("tasks"),
        properties: { name: "x" },
        relations: { project: [await createProject({ name: "Home" })] },
      };
      expect(parseStoredProposalEnvelope(stored, "proposal-id")).toEqual(stored);
    });

    it("accepts an existing project, a done project and an empty array meaning no edge", async () => {
      for (const project of [
        [await createProject({ name: "Home" })],
        [await createProject({ name: "Late invoice", status: "done" })],
        [],
      ])
        await expect(validate({ project })).resolves.not.toBeNull();
    });

    it("rejects a nonexistent target, an archived project, a non-relation key, a duplicate and pageContent relations", async () => {
      const project = await createProject({ name: "Home" });
      const archived = await createProject({ name: "Old", status: "archived" });
      for (const [refusal, details, exact] of [
        [() => validate({ project: ["00000000-0000-4000-8000-000000000001"] }), { field: "project" }, false],
        [() => validate({ project: [archived] }), { field: "project", code: "targetArchived" }, true],
        [() => validate({ name: [project] }), { field: "name" }, true],
        [() => validate({ nope: [project] }), { field: "nope" }, true],
        [() => validate({ project: [project, project] }), { field: "project" }, true],
        [() => validate({ project: [] }, "pageContent"), { field: "relations" }, true],
      ] as const) {
        const error = await refusalOf(refusal());
        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toMatchObject({ status: 400, details });
        if (exact) expect((error as ValidationError).details).toEqual(details);
      }
    });
  });

  describe("relations the project derives", () => {
    const itemIn = async (moduleId: string) =>
      (
        await withTransaction(pool, async (client) =>
          createItemWithClient(client, { databaseId: await databaseIdFor(moduleId), properties: { name: moduleId } }),
        )
      ).id;
    const validate = async (moduleId: string, relations?: Record<string, string[]>) =>
      validateEnvelope({
        entityKind: "database",
        target: await databaseIdFor(moduleId),
        properties: { name: "Proposal" },
        ...(relations ? { relations } : {}),
      });

    it.each([
      [
        "an Event that sets a company and a project",
        "events",
        { project: "projects", company: "companies" },
        "company",
      ],
      ["an Event that sets an area and a project", "events", { project: "projects", area: "areas" }, "area"],
      ["a File that sets an area and a project", "files", { projects: "projects", area: "areas" }, "area"],
      [
        "a health record that sets an area and a project",
        "healthRecords",
        { projects: "projects", area: "areas" },
        "area",
      ],
    ] as const)("refuses %s, on %s", async (_, moduleId, relationModules, field) => {
      const relations = Object.fromEntries(
        await Promise.all(Object.entries(relationModules).map(async ([key, module]) => [key, [await itemIn(module)]])),
      ) as Record<string, string[]>;
      const error = await refusalOf(validate(moduleId, relations));
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ status: 400, details: { field, code: "derivedRelation" } });
    });

    it("accepts one side alone, an empty project, and databases or relations that derive nothing", async () => {
      const project = await itemIn("projects");
      const company = await itemIn("companies");
      const area = await itemIn("areas");
      const person = await itemIn("people");
      for (const [moduleId, relations] of [
        ["events", { company: [company] }],
        ["events", { area: [area] }],
        ["events", { project: [], company: [company] }],
        ["events", { project: [project], company: [] }],
        ["files", { area: [area] }],
        ["files", { projects: [project] }],
        ["tasks", { project: [project] }],
        ["events", { project: [project], people: [person] }],
        ["people", { companies: [company] }],
        // Transcripts has a `company` and a `project` relation too, under the same keys as Events, but derives neither.
        ["transcripts", { project: [project], company: [company] }],
        ["tasks", undefined],
      ] satisfies Array<[string, Record<string, string[]> | undefined]>)
        await expect(validate(moduleId, relations)).resolves.not.toBeNull();
    });

    it("refuses the same envelope the tick would write, as needsClarification with no stored envelope", async () => {
      const project = await itemIn("projects");
      const company = await itemIn("companies");
      const type = await createType({ name: "Meeting", emoji: "M", targetDatabase: "events" });
      const item = await withTransaction(pool, (client) =>
        createInboxItemWithClient(client, {
          inboxDatabaseId: inboxId,
          date: "2026-10-16",
          time: "09:00",
          text: "Meeting at Acme about the project",
          type: type.id,
        }),
      );
      await tick(item.id, propose({ name: "Meeting" }, { relations: { project: [project], company: [company] } }));
      const card = await cardOf(item.id);
      expect(card?.properties).toMatchObject({ status: "needsClarification", proposal: null });
      expect(JSON.stringify(card?.properties.history)).toContain("derived from the item's project");
    });
  });
});

describe("assertValidProposalEnvelope validates multi-step envelopes", () => {
  let peopleDbId: string;
  let companiesDbId: string;

  beforeEach(async () => {
    await resetTickDatabases();
    peopleDbId = await databaseIdFor("people");
    companiesDbId = await databaseIdFor("companies");
  });

  const MISSING = "00000000-0000-4000-8000-000000000001";
  const companyStep = {
    ref: "company",
    op: "create" as const,
    databaseKey: "companies",
    properties: { name: "Acme" },
    role: "secondary" as const,
  };
  const personStep = {
    ref: "person",
    op: "create" as const,
    databaseKey: "people",
    properties: { name: "Jane" },
    relations: { companies: [{ ref: "company" }] },
    role: "primary" as const,
  };
  const lonePerson = { ...personStep, relations: undefined };

  function envelopeOf(operations: ProposalStep[], primary = operations.find((s) => s.role === "primary")!) {
    return {
      entityKind: "database" as const,
      target: primary.databaseKey === "people" ? peopleDbId : companiesDbId,
      properties: primary.properties ?? {},
      operations,
    };
  }
  const validate = (envelope: ProposalEnvelope) =>
    withTransaction(pool, (client) => assertValidProposalEnvelope(client, envelope));
  async function failure(envelope: ProposalEnvelope): Promise<ValidationError> {
    const error = await validate(envelope).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    if (!(error instanceof ValidationError)) throw error;
    return error;
  }
  const createItem = async (moduleId: string, properties: Record<string, unknown>) =>
    (
      await withTransaction(pool, async (client) =>
        createItemWithClient(client, { databaseId: await databaseIdFor(moduleId), properties }),
      )
    ).id;

  it("parses and validates a company plus a new person", async () => {
    const stored = envelopeOf([companyStep, personStep]);
    const parsed = parseStoredProposalEnvelope(JSON.parse(JSON.stringify(stored)), "p1") as ProposalEnvelope;
    expect(parsed.operations).toEqual(stored.operations);
    expect((await validate(parsed))!.id).toBe(peopleDbId);
  });

  it("leaves a single-step envelope byte for byte unchanged by parse and stringify", () => {
    const json = JSON.stringify({
      entityKind: "database",
      target: peopleDbId,
      properties: { name: "Jane" },
      relations: { companies: ["a"] },
    });
    expect(JSON.stringify(parseStoredProposalEnvelope(JSON.parse(json), "p1"))).toBe(json);
  });

  it("reports the ref and field of a failing person step with status 400", async () => {
    const error = await failure(envelopeOf([companyStep, { ...personStep, properties: { name: "Jane", bogus: 1 } }]));
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ ref: "person", field: "bogus" });
  });

  it("rejects a cycle between steps", async () => {
    const error = await failure(
      envelopeOf([{ ...companyStep, relations: { people: [{ ref: "person" }] } }, personStep]),
    );
    expect(error.details).toMatchObject({ field: expect.any(String) });
    expect(error.message).toContain("cycle");
  });

  it.each<[string, () => ProposalStep[], Record<string, string>, Partial<ProposalEnvelope>?]>([
    [
      "a ref to a missing step",
      () => [{ ...personStep, relations: { companies: [{ ref: "nope" }] } }],
      { ref: "person", field: "companies" },
    ],
    ["duplicate refs", () => [{ ...companyStep, ref: "person" }, personStep], { ref: "person", field: "ref" }],
    [
      "a primary step that differs from the top level",
      () => [companyStep, personStep],
      { ref: "person", field: "properties" },
      { properties: { name: "Other" } },
    ],
    [
      "a required step referring to an optional step skipped for a missing reference",
      () => [{ ...companyStep, optional: true, relations: { people: [{ ref: "missing" }] } }, personStep],
      { ref: "person", field: "companies" },
    ],
    [
      "an optional step once something refers to it",
      () => [{ ...companyStep, optional: true, properties: { bogus: 1 } }, personStep],
      { ref: "company", field: "bogus" },
    ],
    [
      "a required step referring to a disabled step",
      () => [{ ...companyStep, enabled: false }, personStep],
      { ref: "person", field: "companies" },
    ],
  ])("rejects %s", async (_, operations, details, override = {}) => {
    expect((await failure({ ...envelopeOf(operations()), ...override })).details).toEqual(details);
  });

  it("rejects a forged link before list that names a missing target", async () => {
    const person = await createItem("people", { name: "Jane" });
    const error = await failure(
      envelopeOf([
        { ...companyStep, role: "primary" },
        {
          ref: "person",
          op: "link",
          role: "secondary",
          itemId: person,
          relations: { companies: [MISSING] },
          before: { relations: { companies: [MISSING] } },
        },
      ]),
    );
    expect(error.details).toMatchObject({ ref: "person", field: "companies" });
  });

  it("rejects two primary steps", async () => {
    const twoPrimaries = await failure(envelopeOf([{ ...companyStep, role: "primary" }, personStep], personStep));
    expect(twoPrimaries.details).toMatchObject({ field: "role" });
  });

  it("enforces proposal identity and primary invariants on skipped steps", async () => {
    for (const skipped of [
      { ...companyStep, enabled: false, ref: "person" },
      { ...companyStep, optional: true, ref: "person" },
      { ...companyStep, enabled: false, ref: "" },
    ]) {
      expect((await failure(envelopeOf([lonePerson, skipped]))).details).toMatchObject({ field: "ref" });
    }
    const primary = { ...companyStep, enabled: false, role: "primary" as const };
    expect((await failure(envelopeOf([lonePerson, primary], lonePerson))).details).toMatchObject({ field: "role" });
  });

  it.each<[string, ProposalStep]>([
    ["a disabled step with an invalid payload", { ...companyStep, enabled: false, properties: { bogus: 1 } }],
    ["an optional step nobody refers to", { ...companyStep, optional: true, properties: { bogus: 1 } }],
    [
      "a bad missing reference on an unreferenced optional step",
      { ...companyStep, optional: true, relations: { people: [{ ref: "missing" }] } },
    ],
    [
      "a bad company reference on an unreferenced optional step",
      { ...companyStep, optional: true, relations: { people: [{ ref: "company" }] } },
    ],
  ])("ignores %s", async (_, step) => {
    await expect(validate(envelopeOf([step, lonePerson]))).resolves.not.toBeNull();
  });

  it("skips an optional step that refers to a disabled step", async () => {
    const optionalReferrer = {
      ref: "second",
      op: "create" as const,
      databaseKey: "companies",
      properties: { bogus: 1 },
      relations: { people: [{ ref: "company" }] },
      role: "secondary" as const,
      optional: true,
    };
    await expect(
      validate(envelopeOf([{ ...companyStep, enabled: false }, optionalReferrer, lonePerson])),
    ).resolves.not.toBeNull();
  });

  describe("update steps", () => {
    async function updateEnvelope(step: Partial<ProposalStep>, itemId: string, moduleId = "projects") {
      const primary: ProposalStep = {
        ref: "move",
        op: "update",
        itemId,
        properties: step.properties ?? {},
        role: "primary",
        ...step,
      };
      return {
        entityKind: "database" as const,
        target: await databaseIdFor(moduleId),
        properties: primary.properties ?? {},
        operations: [primary],
      };
    }
    /** An update step that writes `patch` over `before`, predicting `after` (the patch by default). */
    const change = (
      patch: Record<string, unknown>,
      before: Record<string, unknown>,
      after: Record<string, unknown> = patch,
    ): Partial<ProposalStep> => ({ properties: patch, before: { properties: before }, after: { properties: after } });
    const unpinned = { pinned: false, pinnedOrder: null };

    it("prepares a project pin without taking its allocation lock", async () => {
      const project = await createItem("projects", { name: "Project", pinned: false });
      const envelope = await updateEnvelope(change({ pinned: true }, unpinned), project);
      await withTransaction(pool, async (client) => {
        const spy = vi.spyOn(client, "query");
        try {
          await assertValidProposalEnvelope(client, envelope);
          expect(
            spy.mock.calls.some((args) => typeof args[0] === "string" && args[0].includes("projects-pinned-order")),
          ).toBe(false);
        } finally {
          spy.mockRestore();
        }
      });
    });

    it("validates an explicit pin order", async () => {
      const project = await createItem("projects", { name: "Project", pinned: false });
      await expect(
        validate(await updateEnvelope(change({ pinned: true, pinnedOrder: 7 }, unpinned), project)),
      ).resolves.not.toBeNull();
    });

    it("fails closed without invoking an unprepared registered transform", async () => {
      const chokePoint = createChokePoint(pool);
      const database = await chokePoint.createDatabase({
        name: "Preparation fixture",
        ownerModuleId: "unpreparedFixture",
      });
      await chokePoint.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "text" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: { name: "Before" } });
      let calls = 0;
      registerItemPreWriteTransform("unpreparedFixture", async ({ patch }) => {
        calls++;
        return patch;
      });
      const error = await failure({
        entityKind: "database",
        target: database.id,
        properties: { name: "After" },
        operations: [
          {
            ref: "item",
            op: "update",
            role: "primary",
            itemId: item.id,
            properties: { name: "After" },
            before: { properties: { name: "Before" } },
            after: { properties: { name: "After" } },
          },
        ],
      });
      expect(error.details).toEqual({ ref: "item", field: "properties" });
      expect(calls).toBe(0);
    });

    type Refusal = [
      description: string,
      moduleId: string,
      item: Record<string, unknown> | null,
      step: Partial<ProposalStep>,
      details: Record<string, string>,
      exact: boolean,
    ];
    it.each<Refusal>([
      [
        "a conflicting explicit pin order",
        "projects",
        { name: "P", pinned: false },
        change({ pinned: true, pinnedOrder: 7 }, unpinned, { pinned: true, pinnedOrder: 8 }),
        { field: "pinnedOrder" },
        true,
      ],
      [
        "a predicted after value for an implicitly allocated pin order",
        "projects",
        { name: "P", pinned: false },
        change({ pinned: true }, unpinned, { pinned: true, pinnedOrder: 1 }),
        { field: "pinnedOrder" },
        true,
      ],
      [
        "an invalid Books year through its registered preparation",
        "books",
        { name: "Book" },
        change({ year: "invalid" }, { year: null }),
        { field: "year" },
        false,
      ],
      [
        "a missing step referenced only by an update's after relations",
        "projects",
        { name: "Home" },
        { after: { relations: { area: [{ ref: "missing" }] } } },
        { field: "area" },
        true,
      ],
      ["a blank title", "projects", { name: "Home" }, change({ name: "" }, { name: "Home" }), { field: "name" }, true],
      [
        "an invalid Tasks date through its registered preparation",
        "tasks",
        { name: "Task" },
        change({ date: "2026-02-30" }, { date: null }),
        { field: "date" },
        false,
      ],
      [
        "an invalid Tasks timeFrom through its registered preparation",
        "tasks",
        { name: "Task" },
        change({ timeFrom: "10:00" }, { timeFrom: null }),
        { field: "timeFrom" },
        false,
      ],
      [
        "an after-only relation with no before coverage",
        "projects",
        { name: "Home" },
        { after: { relations: { area: [] } } },
        { field: "area" },
        true,
      ],
      [
        "a conflicting after property",
        "projects",
        { name: "Home" },
        change({ name: "Next" }, { name: "Home" }, { name: "Other" }),
        { field: "name" },
        true,
      ],
      [
        "an unsupported redundant after property",
        "projects",
        { name: "Home", pinned: false },
        change({ name: "Next" }, { name: "Home", pinned: false }, { name: "Next", pinned: false }),
        { field: "pinned" },
        true,
      ],
      [
        "an invalid after-only relation target",
        "projects",
        { name: "Home" },
        { before: { relations: { area: [] } }, after: { relations: { area: [MISSING] } } },
        { field: "area" },
        false,
      ],
      [
        "a forged update before target as an existing edge",
        "projects",
        { name: "Home" },
        { before: { relations: { area: [MISSING] } }, after: { relations: { area: [MISSING] } } },
        { field: "area" },
        false,
      ],
      [
        "a system-owned property",
        "tasks",
        { name: "Buy milk" },
        change({ time: "x" }, { time: null }),
        { field: "time" },
        true,
      ],
      [
        "recurrence commands, unavailable to Inbox proposal envelopes",
        "tasks",
        { name: "Task", date: "2026-10-22" },
        change({ recurrence: { preset: "weekly" } }, { recurrence: null }),
        { field: "recurrence" },
        true,
      ],
      [
        "a changed key that is missing from before",
        "projects",
        { name: "Home", status: "inProgress" },
        { properties: { status: "done" }, before: {}, after: { properties: { status: "done" } } },
        { field: "status" },
        true,
      ],
      ["an item that does not exist", "projects", null, { properties: { status: "done" } }, { field: "itemId" }, true],
    ])("rejects %s with the step's ref and field", async (_, moduleId, item, step, details, exact) => {
      const itemId = item ? await createItem(moduleId, item) : MISSING;
      const error = await failure(await updateEnvelope(step, itemId, moduleId));
      if (exact) expect(error.details).toEqual({ ref: "move", ...details });
      else expect(error.details).toMatchObject({ ref: "move", ...details });
    });

    it("rejects a cycle through an update's after relations", async () => {
      const project = await createItem("projects", { name: "Home" });
      const envelope = await updateEnvelope({ after: { relations: { area: [{ ref: "area" }] } } }, project);
      envelope.operations.push({
        ref: "area",
        op: "create",
        databaseKey: "areas",
        role: "secondary",
        properties: { name: "Work" },
        relations: { projects: [{ ref: "move" }] },
      });
      expect((await failure(envelope)).details).toMatchObject({ ref: "area", field: "projects" });
    });

    it("accepts an update step changing a project's status or moving it to another area", async () => {
      const project = await createItem("projects", { name: "Home", status: "inProgress" });
      await expect(
        validate(await updateEnvelope(change({ status: "done" }, { status: "inProgress" }), project)),
      ).resolves.not.toBeNull();
      const oldArea = await createItem("areas", { name: "Old" });
      const newArea = await createItem("areas", { name: "New" });
      const step = {
        relations: { area: [newArea] },
        before: { relations: { area: [oldArea] } },
        after: { relations: { area: [newArea] } },
      };
      await expect(validate(await updateEnvelope(step, project))).resolves.not.toBeNull();
    });

    it("rejects conflicting relation representations", async () => {
      const project = await createItem("projects", { name: "Home" });
      const first = await createItem("areas", { name: "First" });
      const second = await createItem("areas", { name: "Second" });
      const step = {
        relations: { area: [first] },
        before: { relations: { area: [] } },
        after: { relations: { area: [second] } },
      };
      expect((await failure(await updateEnvelope(step, project))).details).toEqual({ ref: "move", field: "area" });
    });

    /** Links `callerItemId` to `targetItemId` through `moduleId.key` in a tenant scope, as a request does. */
    async function link(moduleId: string, key: string, callerItemId: string, targetItemId: string) {
      const property = await withTransaction(pool, async (client) =>
        propertiesStore.getPropertyByKey(client, await databaseIdFor(moduleId), key),
      );
      if (!property) throw new Error(`Missing ${moduleId}.${key}`);
      // A write of a Tasks.project edge queues value-link propagation, which needs the tenant scope.
      await runInTenant(getTenantZeroId(), () =>
        withTransaction(pool, (client) =>
          createRelationWithClient(client, { relationPropertyId: property.id, callerItemId, targetItemId }),
        ),
      );
    }

    it("validates an actually retained edge and rejects its archived or deleted target", async () => {
      const project = await createItem("projects", { name: "Project", status: "inProgress" });
      const task = await createItem("tasks", { name: "Task" });
      const projectsDb = await databaseIdFor("projects");
      await link("tasks", "project", task, project);
      const retained = { before: { relations: { project: [project] } }, after: { relations: { project: [project] } } };
      const envelope = await updateEnvelope(retained, task, "tasks");
      await expect(validate(envelope)).resolves.not.toBeNull();
      // In a tenant scope, as a request is: a Projects status update queues value-link propagation.
      await runInTenant(getTenantZeroId(), () =>
        withTransaction(pool, (client) =>
          updateItemWithClient(client, {
            databaseId: projectsDb,
            itemId: project,
            propertiesPatch: { status: "archived" },
          }),
        ),
      );
      const refused = { ref: "move", field: "project" };
      expect((await failure(envelope)).details).toMatchObject({ ...refused, code: "targetArchived" });
      await createChokePoint(pool).softDeleteItem(projectsDb, project);
      expect((await failure(envelope)).details).toMatchObject({ ...refused, code: "targetDeleted" });
    });

    it("exempts only the retained edge from target-side cardinality", async () => {
      const first = await createItem("projects", { name: "First" });
      const second = await createItem("projects", { name: "Second" });
      const task = await createItem("tasks", { name: "Task" });
      await link("projects", "tasks", first, task);
      const step = { before: { relations: { tasks: [task] } }, after: { relations: { tasks: [task] } } };
      await expect(validate(await updateEnvelope(step, first))).resolves.not.toBeNull();
      await expect(validate(await updateEnvelope(step, second))).rejects.toMatchObject({
        status: 409,
        details: { ref: "move", field: "tasks" },
      });
    });

    it("rejects a foreign-tenant target under the runtime role even if before claims it", async () => {
      const foreignTenant = await createTestTenant(pool);
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      try {
        await runInTenant(foreignTenant, () => seedSystem(runtime, createViewTypeRegistry()));
        const foreignProject = await runInTenant(foreignTenant, () =>
          withTransaction(runtime, async (client) => {
            const database = await client.query<{ id: string }>(
              "SELECT id FROM databases WHERE owner_module_id = 'projects'",
            );
            if (!database.rows[0]) throw new Error("Missing foreign Projects database");
            return (
              await createItemWithClient(client, { databaseId: database.rows[0].id, properties: { name: "Foreign" } })
            ).id;
          }),
        );
        const task = await createItem("tasks", { name: "Task" });
        const envelope = await updateEnvelope(
          { before: { relations: { project: [foreignProject] } }, after: { relations: { project: [foreignProject] } } },
          task,
          "tasks",
        );
        await expect(
          withTenantTransaction(runtime, getTenantZeroId(), (client) => assertValidProposalEnvelope(client, envelope)),
        ).rejects.toMatchObject({ status: 400, details: { ref: "move", field: "project" } });
      } finally {
        await runtime.end();
      }
    });
  });
});

describe("aiProposal, aiVersion and referencedItemIds on the tick's writes", () => {
  beforeEach(resetTickDatabases);
  const createProject = async (name: string) =>
    (
      await withTransaction(pool, async (client) =>
        createItemWithClient(client, { databaseId: await databaseIdFor("projects"), properties: { name } }),
      )
    ).id;
  const referencedOf = (card: { id: string; properties: Record<string, unknown> }) =>
    referencedItemIdsOf(parseStoredProposalEnvelope(card.properties.proposal, card.id) as ProposalEnvelope);
  /** Ticks after a text edit, proposing `name` with optional relations. */
  async function recompute(itemId: string, name: string, relations?: Record<string, string[]>) {
    await storeEdit(inboxId, itemId, { text: name });
    await tick(itemId, propose({ name }, relations ? { relations } : {}));
    return requireCard(itemId);
  }

  it("the create stores aiProposal equal to proposal at aiVersion 1, and each recompute counts one more version", async () => {
    const { item } = await typedSource();
    await tick(item.id, propose({ name: "Buy milk" }));
    const created = await requireCard(item.id);
    expect(created.properties.proposal).toBeTruthy();
    expect(created.properties.aiProposal).toEqual(created.properties.proposal);
    expect(created.properties.aiVersion).toBe(1);
    const second = await recompute(item.id, "Buy milk and eggs");
    expect(second.properties.aiProposal).toEqual({
      entityKind: "database",
      target: await databaseIdFor("tasks"),
      properties: { name: "Buy milk and eggs" },
    });
    expect(second.properties.aiProposal).toEqual(second.properties.proposal);
    expect(second.properties.aiVersion).toBe(2);
    const third = await recompute(item.id, "Buy oat milk");
    expect(third.properties.aiProposal).toEqual(third.properties.proposal);
    expect(third.properties.aiVersion).toBe(3);
  });

  it("an untyped item's needsClarification stores null aiProposal, aiVersion 1 and no references", async () => {
    const item = await createSource({ text: "no type" });
    await tick(item.id, unrecognized);
    expect((await requireCard(item.id)).properties).toMatchObject({
      status: "needsClarification",
      proposal: null,
      aiProposal: null,
      aiVersion: 1,
      referencedItemIds: [],
    });
  });

  it("a needsClarification written over a card that referenced a project nulls aiProposal, clears the ids and counts one more version", async () => {
    const project = await createProject("Alpha");
    const { type, item } = await typedSource();
    await tick(item.id, propose({ name: "Buy milk" }, { relations: { project: [project] } }));
    const before = await requireCard(item.id);
    expect(before.properties).toMatchObject({ aiVersion: 1, referencedItemIds: [project] });
    expect(before.properties.referencedItemIds).toEqual(referencedOf(before));
    // Taking the type off the item makes it untyped, so the tick writes needsClarification over the card.
    await setSourceType(item.id, { remove: type.id });
    await tick(item.id, unrecognized);
    const after = await requireCard(item.id);
    expect(after.id).toBe(before.id);
    expect(after.properties).toMatchObject({
      status: "needsClarification",
      proposal: null,
      aiProposal: null,
      aiVersion: 2,
      referencedItemIds: [],
    });
  });

  it("invalidating a card for a deleted source leaves its aiProposal and aiVersion as they were", async () => {
    const { item } = await typedSource();
    await tick(item.id, propose({ name: "Buy milk" }));
    const before = await requireCard(item.id);
    await trashSource(item.id);
    await tick(item.id, noCompute("computeProposal must not be called for a deleted source"));
    expect((await requireCard(item.id)).properties).toMatchObject({
      status: "invalid",
      aiProposal: before.properties.aiProposal,
      aiVersion: 1,
    });
  });

  it("a legacy card without aiProposal reads its proposal, and its next automated write sets aiProposal at aiVersion 1", async () => {
    const { item } = await typedSource();
    await tick(item.id, propose({ name: "Buy milk" }));
    const created = await requireCard(item.id);
    // A card without aiProposal and aiVersion: no current writer can produce that state.
    await pool.query("UPDATE items SET properties = properties - 'aiProposal' - 'aiVersion' WHERE id = $1", [
      created.id,
    ]);
    const legacy = await requireCard(item.id);
    expect(legacy.properties).not.toHaveProperty("aiProposal");
    expect(legacy.properties).not.toHaveProperty("aiVersion");
    expect(readAiProposal(legacy.properties, legacy.id)).toEqual(created.properties.proposal);
    const revised = await recompute(item.id, "Buy milk and eggs");
    expect(revised.properties.aiProposal).toEqual(revised.properties.proposal);
    expect(revised.properties.aiVersion).toBe(1);
  });

  it("an envelope without relations stores no ids, and a recompute replaces them with those of the new envelope", async () => {
    const [first, second] = [await createProject("Alpha"), await createProject("Beta")];
    const { item } = await typedSource();
    await tick(item.id, propose({ name: "Buy milk" }));
    expect((await requireCard(item.id)).properties.referencedItemIds).toEqual([]);
    expect((await recompute(item.id, "Buy milk and eggs", { project: [first] })).properties.referencedItemIds).toEqual([
      first,
    ]);
    expect((await recompute(item.id, "Buy oat milk", { project: [second] })).properties.referencedItemIds).toEqual([
      second,
    ]);
  });

  it("a recompute of a card the user edited stores the ids of the proposal it stores, not of the assistant's envelope", async () => {
    const [assistant, chosen, recomputed] = [
      await createProject("Alpha"),
      await createProject("Beta"),
      await createProject("Gamma"),
    ];
    const { item } = await typedSource();
    await tick(item.id, propose({ name: "Buy milk" }, { relations: { project: [assistant] } }));
    const card = await requireCard(item.id);
    await withTransaction(pool, (client) =>
      updateProposalValuesWithClient(client, { processingProposalsDatabaseId: proposalsId }, card.id, {
        set: { primary: { name: "Typed title" } },
        relations: { primary: { project: [chosen] } },
      }),
    );
    expect((await requireCard(item.id)).properties.referencedItemIds).toEqual([chosen]);
    const revised = await recompute(item.id, "Buy milk and eggs", { project: [recomputed] });
    expect(revised.properties.aiProposal).toMatchObject({ relations: { project: [recomputed] } });
    expect(revised.properties.referencedItemIds).toEqual(referencedOf(revised));
    expect(revised.properties.referencedItemIds).toHaveLength(1);
  });
});

describe("semprec.tick keeps user-edited keys when it recomputes a proposal", () => {
  let tasksId: string;
  beforeEach(async () => {
    await resetTickDatabases();
    tasksId = await databaseIdFor("tasks");
  });

  const config = () => ({ processingProposalsDatabaseId: proposalsId });
  const RECOMPUTE_MESSAGE = "Revised the proposal after the source item changed.";
  const recomputeEntry = { message: RECOMPUTE_MESSAGE, kind: "recompute" };

  async function seedCard() {
    const { type, item } = await typedSource();
    await tick(item.id, propose({ name: "Buy milk", description: "From the shop" }));
    return { type, item, card: await requireCard(item.id) };
  }
  async function readCard(cardId: string) {
    const card = await withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, cardId));
    if (!card) throw new Error(`card ${cardId} not found`);
    return card;
  }
  const editValues = async (cardId: string, values: Record<string, unknown>) =>
    (
      await withTransaction(pool, (client) =>
        updateProposalValuesWithClient(client, config(), cardId, { set: { primary: values } }),
      )
    ).item;
  const editText = (itemId: string, text: string) => storeEdit(inboxId, itemId, { text });
  const envelopeOf = (properties: Record<string, unknown>, target = tasksId) => ({
    entityKind: "database",
    target,
    properties,
  });
  /** A seeded card with a manual title and a changed source, ready for a recompute. */
  async function seedEditedCard(values: Record<string, unknown> = { name: "My own title" }) {
    const seeded = await seedCard();
    await editValues(seeded.card.id, values);
    await editText(seeded.item.id, "Buy milk and eggs");
    return seeded;
  }

  it.each([
    ["keeps the edited title and takes the other fields from the assistant", { name: "My own title" }],
    // A value that became equal is not "dropped": the history entry names nothing.
    [
      "drops a key whose manual value now equals the new assistant value",
      { name: "My own title", description: "Two things" },
    ],
  ])("a recompute after the source text changed %s", async (_, values) => {
    const { item, card } = await seedEditedCard(values);
    await tick(item.id, propose({ name: "Buy milk and eggs", description: "Two things" }));
    const after = await readCard(card.id);
    expect(after.properties).toMatchObject({
      aiProposal: envelopeOf({ name: "Buy milk and eggs", description: "Two things" }),
      aiVersion: 2,
      proposal: envelopeOf({ name: "My own title", description: "Two things" }),
      userOverrides: { primary: { name: "My own title" } },
      userEditedKeys: ["primary.name"],
      status: "proposed",
    });
    expect(after.properties.userOverrides).toEqual({ primary: { name: "My own title" } });
    expect(historyOf(after).at(-1)).toMatchObject({ author: "ai", ...recomputeEntry });
  });

  it("a card without manual values gets empty overrides and a plain recompute entry", async () => {
    const { item, card } = await seedCard();
    await editText(item.id, "Buy oat milk");
    await tick(item.id, propose({ name: "Buy oat milk" }));
    const after = await readCard(card.id);
    expect(after.properties.proposal).toEqual(envelopeOf({ name: "Buy oat milk" }));
    expect(after.properties.proposal).toEqual(after.properties.aiProposal);
    expect(after.properties.userOverrides).toEqual({});
    expect(after.properties.userEditedKeys).toEqual([]);
    expect(historyOf(after).at(-1)).toMatchObject(recomputeEntry);
  });

  it("a manual PATCH values committed while computeProposal runs does not discard the assistant result", async () => {
    const { item, card } = await seedCard();
    await editText(item.id, "Buy milk and eggs");
    const before = await readCard(card.id);
    let editedVersion: string | undefined;
    await tick(item.id, async () => {
      editedVersion = (await editValues(card.id, { name: "Typed during the call" })).updatedAt;
      return { properties: { name: "Computed meanwhile", description: "Two things" } };
    });
    expect(editedVersion).toBeDefined();
    expect(editedVersion).not.toBe(before.updatedAt);
    const after = await readCard(card.id);
    expect(after.properties).toMatchObject({
      aiProposal: envelopeOf({ name: "Computed meanwhile", description: "Two things" }),
      aiVersion: 2,
      proposal: envelopeOf({ name: "Typed during the call", description: "Two things" }),
      userEditedKeys: ["primary.name"],
    });
    expect(after.properties.userOverrides).toEqual({ primary: { name: "Typed during the call" } });
    expect(historyOf(after).at(-1)).toMatchObject(recomputeEntry);
  });

  it("a card rejected while computeProposal runs is left as the reject wrote it, with its manual values", async () => {
    const { item, card } = await seedEditedCard();
    const before = await readCard(card.id);
    let rejectedVersion: string | undefined;
    await tick(item.id, async () => {
      rejectedVersion = (await storeEdit(proposalsId, card.id, { status: "rejected" })).updatedAt;
      return { properties: { name: "Must not be stored" } };
    });
    const after = await readCard(card.id);
    expect(after.updatedAt).toBe(rejectedVersion);
    expect(after.properties).toEqual({ ...before.properties, status: "rejected" });
  });

  it("a card confirmed while computeProposal runs is left as the confirm wrote it, with its manual values", async () => {
    const { item, card } = await seedEditedCard();
    // The tick and the confirm share a Journal-day recompute job key, so the source leaves its Journal day first.
    await withTransaction(pool, async (client) => {
      const journalDayProperty = await propertiesStore.getPropertyByKey(client, inboxId, "journalDay");
      const relationDefinition = await relationsStore.getRelationDefinitionByPropertyId(client, journalDayProperty!.id);
      for (const edge of await relationsStore.listRelationsForItem(client, relationDefinition!.id, item.id)) {
        await relationsStore.deleteItemRelation(client, edge.relationDefinitionId, edge.itemA, edge.itemB);
      }
    });
    const before = await readCard(card.id);
    await tick(item.id, async () => {
      await withTransaction(pool, (client) => confirmProposalWithClient(client, config(), card.id));
      return { properties: { name: "Must not be stored" } };
    });
    const after = await readCard(card.id);
    expect(after.properties).toMatchObject({
      status: "confirmed",
      aiProposal: before.properties.aiProposal,
      aiVersion: before.properties.aiVersion,
      proposal: before.properties.proposal,
    });
    expect(after.properties.userOverrides).toEqual({ primary: { name: "My own title" } });
    expect(historyOf(after).map((entry) => entry.message)).not.toContain(RECOMPUTE_MESSAGE);
  });

  it.each([
    ["a second assistant write while computeProposal runs discards the older result", false],
    ["an older result is also discarded when the card had no aiVersion, which counts as 0", true],
  ])("%s", async (_, legacy) => {
    const { item, card } = await seedEditedCard();
    // A card without aiVersion: no current writer can produce that state.
    if (legacy) await pool.query("UPDATE items SET properties = properties - 'aiVersion' WHERE id = $1", [card.id]);
    await tick(item.id, async () => {
      await withTransaction(pool, (client) =>
        reviseProposalWithClient(client, config(), card.id, {
          message: "Use another description",
          entityKind: "database",
          target: tasksId,
          properties: { name: "Assistant revision", description: "From the thread" },
        }),
      );
      return { properties: { name: "Older result", description: "Must not be stored" } };
    });
    const after = await readCard(card.id);
    expect(after.properties.aiVersion).toBe(legacy ? 1 : 2);
    expect(after.properties.aiProposal).toEqual(
      envelopeOf({ name: "Assistant revision", description: "From the thread" }),
    );
    expect(JSON.stringify(after.properties)).not.toContain("Older result");
    expect(historyOf(after).map((entry) => entry.message)).not.toContain(RECOMPUTE_MESSAGE);
  });

  it("a card whose fingerprint another write moved while computeProposal runs discards the result", async () => {
    const { item, card } = await seedCard();
    await editText(item.id, "Buy milk and eggs");
    let movedVersion: string | undefined;
    await tick(item.id, async () => {
      // The fingerprint alone moves, as a failed computation clears it; aiVersion stays.
      movedVersion = (await storeEdit(proposalsId, card.id, { fingerprint: null })).updatedAt;
      return { properties: { name: "Must not be stored" } };
    });
    const after = await readCard(card.id);
    expect(after.updatedAt).toBe(movedVersion);
    expect(after.properties).toEqual({ ...card.properties, fingerprint: null });
  });

  it("an assistant envelope with another target drops the manual values and the recompute entry names them", async () => {
    const { type, item, card } = await seedCard();
    await editValues(card.id, { name: "My own title", description: "Typed note" });
    const projectsId = await databaseIdFor("projects");
    await editItem(typesId, type.id, { targetDatabase: "projects" });
    await editText(item.id, "Plan the move");
    await tick(item.id, propose({ name: "Plan the move" }));
    const after = await readCard(card.id);
    expect(after.properties.aiProposal).toEqual(envelopeOf({ name: "Plan the move" }, projectsId));
    expect(after.properties.proposal).toEqual(envelopeOf({ name: "Plan the move" }, projectsId));
    expect(after.properties.userOverrides).toEqual({});
    expect(after.properties.userEditedKeys).toEqual([]);
    expect(historyOf(after).at(-1)).toMatchObject({
      kind: "recompute",
      message: `${RECOMPUTE_MESSAGE} Manual values that no longer apply were dropped: primary.description, primary.name.`,
    });
  });

  it("an override key the target no longer has is dropped while the keys that still apply are kept", async () => {
    const { item, card } = await seedCard();
    await editValues(card.id, { name: "My own title" });
    // A key the target database does not have: the API refuses to store one, and a removed property leaves one behind.
    await pool.query(
      `UPDATE items SET properties = properties || jsonb_build_object(
         'userOverrides', jsonb_build_object('primary', jsonb_build_object('name', 'My own title', 'removedKey', 'x')),
         'userEditedKeys', jsonb_build_array('primary.name', 'primary.removedKey')) WHERE id = $1`,
      [card.id],
    );
    await editText(item.id, "Buy milk and eggs");
    await tick(item.id, propose({ name: "Buy milk and eggs" }));
    const after = await readCard(card.id);
    expect(after.properties.userOverrides).toEqual({ primary: { name: "My own title" } });
    expect(after.properties.userEditedKeys).toEqual(["primary.name"]);
    expect(after.properties.proposal).toEqual(envelopeOf({ name: "My own title" }));
    expect(historyOf(after).at(-1)?.message).toBe(
      `${RECOMPUTE_MESSAGE} Manual values that no longer apply were dropped: primary.removedKey.`,
    );
  });

  it("an assistant output that fails validation makes the card needsClarification and keeps the manual values stored", async () => {
    const { item, card } = await seedEditedCard();
    await tick(item.id, propose({ noSuchProperty: "x" }));
    expect((await readCard(card.id)).properties).toMatchObject({
      status: "needsClarification",
      proposal: null,
      aiProposal: null,
      aiVersion: 2,
      userOverrides: { primary: { name: "My own title" } },
      userEditedKeys: ["primary.name"],
    });
    // They apply again when a later valid assistant output arrives.
    await editText(item.id, "Buy milk and eggs again");
    await tick(item.id, propose({ name: "Buy milk and eggs again", description: "Two things" }));
    expect((await readCard(card.id)).properties).toMatchObject({
      status: "proposed",
      aiVersion: 3,
      proposal: envelopeOf({ name: "My own title", description: "Two things" }),
      userEditedKeys: ["primary.name"],
    });
  });
});

describe("semprec.tick computes a card that was sent back as computing, whatever its fingerprint says", () => {
  beforeEach(resetTickDatabases);

  it("skips a proposed card whose fingerprint is current, but computes the same card once it is computing", async () => {
    const { type, item } = await typedSource();
    await tick(item.id, propose({ name: "Buy milk" }));
    const card = await requireCard(item.id);
    const counter = counted({ properties: { name: "Buy oat milk" } });
    await tick(item.id, counter.compute);
    expect(counter.calls).toBe(0);
    expect((await cardOf(item.id))?.properties).toMatchObject({
      status: "proposed",
      aiVersion: card.properties.aiVersion,
    });

    await editItem(proposalsId, card.id, { status: "computing" }, { allowedSystemKeys: ["status"] });
    const fingerprint = fingerprintV2Of({ typeId: type.id, text: "Buy milk" });
    expect((await cardOf(item.id))?.properties.fingerprint).toBe(fingerprint);
    await tick(item.id, counter.compute);
    expect(counter.calls).toBe(1);
    const envelope = {
      entityKind: "database",
      target: await databaseIdFor("tasks"),
      properties: { name: "Buy oat milk" },
    };
    expect((await cardOf(item.id))?.properties).toMatchObject({
      status: "proposed",
      proposal: envelope,
      aiProposal: envelope,
      aiVersion: 2,
      fingerprint,
    });
  });
});

describe("aiProposalPatch and readAiProposal", () => {
  const envelope: ProposalEnvelope = {
    entityKind: "database",
    target: "00000000-0000-4000-8000-000000000001",
    properties: { name: "Buy milk" },
  };
  const otherEnvelope: ProposalEnvelope = { ...envelope, properties: { name: "Buy eggs" } };

  it("a new row starts at aiVersion 1 and a row with a counter adds one", () => {
    expect(aiProposalPatch({}, envelope)).toEqual({ aiProposal: envelope, aiVersion: 1 });
    expect(aiProposalPatch({ aiVersion: 4 }, null)).toEqual({ aiProposal: null, aiVersion: 5 });
  });

  it.each([
    [
      "aiProposal when it is set, even where proposal differs",
      { aiProposal: envelope, proposal: otherEnvelope },
      envelope,
    ],
    ["the stored proposal when aiProposal is absent", { proposal: envelope }, envelope],
    ["the stored proposal when aiProposal is JSON null", { aiProposal: null, proposal: envelope }, envelope],
    ["null when no property holds an envelope", {}, null],
    ["null when both properties are null", { aiProposal: null, proposal: null }, null],
  ])("readAiProposal returns %s", (_, properties, expected) => {
    expect(readAiProposal(properties, "card")).toEqual(expected);
  });
});

afterAll(async () => {
  await pool?.end();
});

describe("Markdown page proposal validation", () => {
  /** Resets the database and runs `body` with a runtime-role pool, keeping a body failure and a close failure. */
  async function withRuntime(body: (runtime: Pool) => Promise<void>) {
    pool ??= getTestPool();
    await resetDatabase(pool);
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let failure: { error: unknown } | undefined;
    try {
      const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      await body(runtime);
    } catch (error) {
      failure = { error };
    }
    try {
      await runtime.end();
    } catch (error) {
      failure = combineOverlapFailure(failure, error);
    }
    if (failure) throw failure.error;
  }
  /** A seeded tenant with a user, as a real tenant has. */
  async function seededTenant(runtime: Pool) {
    const tenant = await createTestTenant(pool);
    await createUser(pool, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
    await runInTenant(tenant, () => seedSystem(runtime));
    return tenant;
  }
  async function systemDatabases<K extends string>(runtime: Pool, keys: readonly K[]) {
    const rows = await withTransaction(runtime, (client) =>
      Promise.all(keys.map((key) => databasesStore.getDatabaseByModuleId(client, key))),
    );
    return Object.fromEntries(
      keys.map((key, index) => {
        const row = rows[index];
        if (!row) throw new Error(`Missing ${key} database`);
        return [key, row];
      }),
    ) as Record<K, NonNullable<(typeof rows)[number]>>;
  }
  /** The Inbox side of a tenant: a page-content type, one typed source per call, and the tick over it. */
  async function pageNoteInbox(runtime: Pool) {
    const dbs = await systemDatabases(runtime, ["inbox", "inboxItemTypes", "processingProposals"] as const);
    const projectItemId = dbs.inbox.ownerProjectItemId;
    if (!projectItemId) throw new Error("Missing Inbox project");
    const type = await withTransaction(runtime, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: dbs.inboxItemTypes.id,
        name: "Page note",
        emoji: "N",
        processingMethod: "pageContent",
      }),
    );
    const createPageSource = () =>
      withTransaction(runtime, (client) =>
        createInboxItemWithClient(client, {
          inboxDatabaseId: dbs.inbox.id,
          date: "2026-11-06",
          time: "12:00",
          text: "Input",
          type: type.id,
        }),
      );
    const tickPage = (itemId: string, compute: ComputeSemprecProposalFn) =>
      createSemprecTickAction(runtime, compute)(
        {
          inboxDatabaseId: dbs.inbox.id,
          inboxItemTypesDatabaseId: dbs.inboxItemTypes.id,
          processingProposalsDatabaseId: dbs.processingProposals.id,
        },
        { heartbeatId: randomUUID(), projectItemId, itemId },
      );
    const cardsOf = async (sourceId: string) =>
      (
        await runtime.query<{ id: string; properties: unknown }>(
          `SELECT card.id, card.properties FROM items card JOIN item_relations edge ON edge.item_a = card.id OR edge.item_b = card.id
           WHERE card.database_id = $1 AND card.deleted_at IS NULL AND (edge.item_a = $2 OR edge.item_b = $2)`,
          [dbs.processingProposals.id, sourceId],
        )
      ).rows;
    return { proposalsId: dbs.processingProposals.id, createPageSource, tickPage, cardsOf };
  }
  const writeHeading = async (runtime: Pool, pageId: string, blocks: Parameters<typeof writeBlock>[1][]) => {
    const doc = await createDocStore(runtime).getOrCreateDoc(pageId, "page");
    await mutateDoc(runtime, doc.id, "user", (ydoc) => {
      for (const block of blocks) writeBlock(ydoc, block);
    });
    return doc;
  };

  it("stores resolved model heading and placement variants in the real tick", async () => {
    await withRuntime(async (runtime) => {
      const tenant = await seededTenant(runtime);
      await runInTenant(tenant, async () => {
        const { projects } = await systemDatabases(runtime, ["projects"] as const);
        const inbox = await pageNoteInbox(runtime);
        const cp = createChokePoint(runtime);
        const page = await cp.createItem({ databaseId: projects.id, properties: { name: "Page" } });
        const empty = await cp.createItem({ databaseId: projects.id, properties: { name: "No document" } });
        const headingId = randomUUID();
        await writeHeading(runtime, page.id, [{ id: headingId, type: "h2", text: "Dlažba" }]);
        for (const variant of [
          { target: page.id, input: { afterHeadingText: "dlažba" }, expected: { afterHeading: headingId } },
          { target: page.id, input: { afterHeadingText: "missing" }, expected: "end" },
          { target: empty.id, input: { afterHeadingText: "dlažba" }, expected: "end" },
          { target: page.id, input: "start", expected: "start" },
          { target: page.id, input: "end", expected: "end" },
        ]) {
          const source = await inbox.createPageSource();
          // The model result is synthetic; the tick, storage and placement reader are actual owners.
          await inbox.tickPage(source.id, async () => ({
            target: variant.target,
            properties: { markdown: "Fixture text", placement: variant.input },
          }));
          const cards = await inbox.cardsOf(source.id);
          expect(cards).toHaveLength(1);
          const card = z
            .object({ proposal: z.unknown(), aiProposal: z.unknown() })
            .passthrough()
            .parse(cards[0]?.properties);
          for (const stored of [card.proposal, card.aiProposal]) {
            expect(stored).toMatchObject({
              entityKind: "pageContent",
              target: variant.target,
              properties: { markdown: "Fixture text", placement: variant.expected },
            });
            expect(JSON.stringify(stored)).not.toContain("afterHeadingText");
          }
        }
      });
    });
  });

  it("accepts current real hosts and validates headings without creating documents or exposing other tenants", async () => {
    await withRuntime(async (runtime) => {
      const owner = await createTestTenant(pool);
      const foreign = await createTestTenant(pool);
      await runInTenant(owner, () => seedSystem(runtime));
      await runInTenant(foreign, () => seedSystem(runtime));
      const setup = (tenant: string) =>
        runInTenant(tenant, async () => {
          const dbs = await systemDatabases(runtime, ["projects", "areas", "tasks", "journal"] as const);
          const cp = createChokePoint(runtime);
          const journalItem = (period: "day" | "week") =>
            withTransaction(runtime, (client) =>
              getOrCreateJournalItem(client, dbs.journal.id, period, new Date("2026-11-06T12:00:00Z"), "UTC"),
            );
          return {
            project: await cp.createItem({ databaseId: dbs.projects.id, properties: { name: "Project" } }),
            area: await cp.createItem({ databaseId: dbs.areas.id, properties: { name: "Area" } }),
            task: await cp.createItem({ databaseId: dbs.tasks.id, properties: { name: "Task" } }),
            day: await journalItem("day"),
            week: await journalItem("week"),
          };
        });
      const own = await setup(owner);
      const other = await setup(foreign);
      const asOwner = <T>(query: (client: PoolClient) => Promise<T>) =>
        runInTenant(owner, () => withTransaction(runtime, query));
      const validate = (target: string, properties: Record<string, unknown>) =>
        asOwner((client) => assertValidProposalEnvelope(client, { entityKind: "pageContent", target, properties }));
      const resolvePlacement = (target: string, properties: Record<string, unknown>) =>
        asOwner((client) => resolveModelPagePlacement(client, { entityKind: "pageContent", target, properties }));
      const docCount = () =>
        asOwner((client) => client.query<{ count: number }>("SELECT count(*)::int AS count FROM docs"));
      const hello = (placement: unknown, extra: Record<string, unknown> = {}) => ({
        markdown: "Hello",
        placement,
        ...extra,
      });

      const before = await docCount();
      for (const target of [own.project.id, own.area.id, own.day.id])
        await expect(validate(target, hello("end"))).resolves.toBeNull();
      expect((await docCount()).rows).toEqual(before.rows);
      for (const target of [own.task.id, own.week.id, other.project.id, randomUUID()])
        await expect(validate(target, hello("end"))).rejects.toMatchObject({
          status: 400,
          details: { field: "target" },
        });
      for (const properties of [
        { markdown: " ", placement: "end" },
        { markdown: "[Page](semprec://page/abc)", placement: "end" },
        hello("sideways"),
        hello("end", { heading: "a\nb" }),
        hello({ afterHeading: "missing" }),
      ])
        await expect(validate(own.project.id, properties)).rejects.toMatchObject({
          status: 400,
          details: { field: "properties" },
        });
      await runInTenant(owner, () =>
        writeHeading(runtime, own.project.id, [
          { id: "heading", type: "h2", text: "Heading" },
          { id: "text", type: "text", text: "Paragraph" },
        ]),
      );
      const resolved = await resolvePlacement(own.project.id, hello({ afterHeadingText: "  HEADING " }));
      expect(JSON.stringify(resolved)).not.toContain("afterHeadingText");
      expect(resolved.properties.placement).toEqual({ afterHeading: "heading" });
      expect(
        (await resolvePlacement(own.project.id, hello({ afterHeadingText: "missing" }))).properties.placement,
      ).toBe("end");
      expect((await resolvePlacement(own.area.id, hello({ afterHeadingText: "heading" }))).properties.placement).toBe(
        "end",
      );
      expect((await resolvePlacement(own.project.id, { flavour: "paragraph" })).properties).toEqual({
        flavour: "paragraph",
      });
      await expect(validate(own.project.id, hello({ afterHeading: "heading" }))).resolves.toBeNull();
      await expect(validate(own.project.id, hello({ afterHeading: "text" }))).rejects.toMatchObject({ status: 400 });
      await runInTenant(owner, () => createChokePoint(runtime).softDeleteItem(own.project.databaseId, own.project.id));
      await expect(validate(own.project.id, hello("start"))).rejects.toMatchObject({
        status: 400,
        details: { field: "target" },
      });
    });
  });

  it.each(["blank", "page block", "non-heading", "foreign heading", "non-host"] as const)(
    "keeps an invalid %s computation out of the real background tick and revise",
    async (mode) => {
      await withRuntime(async (runtime) => {
        const tenant = await seededTenant(runtime);
        const foreign = await seededTenant(runtime);
        const docUpdates = (docId: string) =>
          runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM doc_updates WHERE doc_id = $1", [docId]);
        const foreignFixture = await runInTenant(foreign, async () => {
          const { projects } = await systemDatabases(runtime, ["projects"] as const);
          const page = await createChokePoint(runtime).createItem({
            databaseId: projects.id,
            properties: { name: "Foreign" },
          });
          const id = randomUUID();
          const doc = await writeHeading(runtime, page.id, [{ id, type: "h2", text: "Foreign" }]);
          return { id, docId: doc.id, rows: (await docUpdates(doc.id)).rows };
        });
        await runInTenant(tenant, async () => {
          const dbs = await systemDatabases(runtime, ["projects", "tasks"] as const);
          const inbox = await pageNoteInbox(runtime);
          const cp = createChokePoint(runtime);
          const project = await cp.createItem({ databaseId: dbs.projects.id, properties: { name: "Project" } });
          const task = await cp.createItem({ databaseId: dbs.tasks.id, properties: { name: "Task" } });
          const blockId = randomUUID();
          await writeHeading(runtime, project.id, [{ id: blockId, type: "text", text: "Text" }]);
          const source = await inbox.createPageSource();
          const target = mode === "non-host" ? task.id : project.id;
          const properties = {
            blank: { markdown: " ", placement: "end" },
            "page block": { markdown: "[Page](semprec://page/abc)", placement: "end" },
            "non-heading": { markdown: "Hello", placement: { afterHeading: blockId } },
            "foreign heading": { markdown: "Hello", placement: { afterHeading: foreignFixture.id } },
            "non-host": { markdown: "Hello", placement: "end" },
          }[mode];
          let calls = 0;
          await inbox.tickPage(source.id, async () => {
            calls++;
            return { target, properties };
          });
          expect(calls).toBe(1);
          const cards = await inbox.cardsOf(source.id);
          expect(cards).toHaveLength(1);
          const card = cards[0];
          if (!card) throw new Error("Missing clarification card");
          expect(card.properties).toMatchObject({ status: "needsClarification", proposal: null, aiProposal: null });
          await expect(
            withTransaction(runtime, (client) =>
              reviseProposalWithClient(client, { processingProposalsDatabaseId: inbox.proposalsId }, card.id, {
                message: "Revise",
                entityKind: "pageContent",
                target,
                properties,
              }),
            ),
          ).rejects.toMatchObject({ status: 400, details: { field: mode === "non-host" ? "target" : "properties" } });
          const after = await runtime.query<{ properties: unknown }>("SELECT properties FROM items WHERE id = $1", [
            card.id,
          ]);
          expect(after.rows).toEqual([{ properties: card.properties }]);
        });
        expect((await runInTenant(foreign, () => docUpdates(foreignFixture.docId))).rows).toEqual(foreignFixture.rows);
      });
    },
  );
});

describe("semprec.tick proposes a journal entry for the journal method", () => {
  const PAGE_LINK = "[Sub page](semprec://page/00000000-0000-4000-8000-000000000001)";
  let journalId: string;
  let areasId: string;
  let projectsId: string;

  beforeEach(async () => {
    await resetTickDatabases();
    journalId = await databaseIdFor("journal");
    areasId = await databaseIdFor("areas");
    projectsId = await databaseIdFor("projects");
  });

  async function typedItem(method: "journal" | "pageContent" | "database", date = "2026-10-16") {
    const type = await createType({
      name: method === "journal" ? "Note" : "Task",
      emoji: "N",
      processingMethod: method,
    });
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date,
        time: "09:00",
        text: "Went for a run",
        type: type.id,
      }),
    );
    return item.id;
  }
  const liveItem = async (databaseId: string, name: string) =>
    (await withTransaction(pool, (client) => createItemWithClient(client, { databaseId, properties: { name } }))).id;
  async function tickJournal(itemId: string, properties: Record<string, unknown>, extra: { target?: string } = {}) {
    const inputs: ProposalComputationInput[] = [];
    await tick(itemId, async (input) => {
      inputs.push(input);
      return { properties, ...extra };
    });
    return { card: await cardOf(itemId), inputs };
  }
  const journalEnvelope = (properties: Record<string, unknown>) => ({
    entityKind: "journalEntry",
    target: journalId,
    properties: { date: "2026-10-16", markdown: "Went for a run.", ...properties },
  });
  const clarifiedWithoutEnvelope = { status: "needsClarification", proposal: null, aiProposal: null };

  it("creates a journalEntry card with the Journal database as target and hands the computation the database and the date", async () => {
    const itemId = await typedItem("journal");
    const { card, inputs } = await tickJournal(itemId, { date: "2026-10-15", markdown: "Went for a run." });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      entityKind: "journalEntry",
      journalDatabaseId: journalId,
      sourceDate: "2026-10-16",
    });
    expect(inputs[0]?.targetDatabaseId).toBeUndefined();
    expect(card?.properties.status).toBe("proposed");
    expect(card?.properties.proposal).toEqual(journalEnvelope({ date: "2026-10-15" }));
    expect(card?.properties.aiProposal).toEqual(journalEnvelope({ date: "2026-10-15" }));
  });

  it("stores the source item's date when the computation returns none", async () => {
    const itemId = await typedItem("journal", "2026-10-12");
    const { card } = await tickJournal(itemId, { markdown: "Went for a run." });
    expect(card?.properties.proposal).toEqual(journalEnvelope({ date: "2026-10-12" }));
  });

  it("keeps only the project when the computation returns an area and a project", async () => {
    const areaId = await liveItem(areasId, "Health");
    const projectId = await liveItem(projectsId, "Website");
    const { card } = await tickJournal(await typedItem("journal"), { markdown: "Went for a run.", areaId, projectId });
    expect(card?.properties.status).toBe("proposed");
    expect(card?.properties.proposal).toEqual(journalEnvelope({ projectId }));
  });

  it.each([
    ["an area alone", "areaId"],
    ["a project alone", "projectId"],
  ] as const)("keeps %s as the computation returned it", async (_label, key) => {
    const id = await liveItem(key === "areaId" ? areasId : projectsId, "Related");
    const { card } = await tickJournal(await typedItem("journal"), { markdown: "Went for a run.", [key]: id });
    expect(card?.properties.proposal).toEqual(journalEnvelope({ [key]: id }));
  });

  // One Inbox item per target: a second tick of the same item stops at the stored card's current fingerprint and never
  // reaches the computation, so a loop over the targets would assert on the first one only.
  it.each([
    ["the Journal database", () => journalId],
    ["an id that is no Journal database", () => randomUUID()],
  ] as const)(
    "refuses a computation result that carries %s as a target of its own and creates no journalEntry card",
    async (_label, targetOf) => {
      const itemId = await typedItem("journal");
      const { card, inputs } = await tickJournal(itemId, { markdown: "Went for a run." }, { target: targetOf() });
      expect(inputs).toHaveLength(1);
      expect(card?.properties).toMatchObject(clarifiedWithoutEnvelope);
      expect(JSON.stringify(card?.properties.history)).toContain("set by the server");
      const { rows } = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM items WHERE database_id = $1 AND properties->'proposal'->>'entityKind' = 'journalEntry'",
        [proposalsId],
      );
      expect(rows).toEqual([{ n: 0 }]);
    },
  );

  it.each([
    ["no markdown", () => ({ date: "2026-10-16" }), "markdown"],
    ["a blank markdown", () => ({ markdown: "  " }), "markdown"],
    ["a page block in the markdown", () => ({ markdown: `A line\n\n${PAGE_LINK}` }), "markdown"],
    ["an area that names no item", () => ({ markdown: "Run.", areaId: randomUUID() }), "areaId"],
    ["a project that names no item", () => ({ markdown: "Run.", projectId: randomUUID() }), "projectId"],
    ["a date that is no calendar day", () => ({ markdown: "Run.", date: "2026-02-30" }), "date"],
  ] as const)("records %s as needsClarification and stores no envelope", async (_label, build, field) => {
    const { card } = await tickJournal(await typedItem("journal"), build());
    expect(card?.properties).toMatchObject(clarifiedWithoutEnvelope);
    expect(JSON.stringify(card?.properties.history)).toContain("Computed proposal failed validation");
    expect(JSON.stringify(card?.properties.history)).toContain(field);
  });

  it("leaves pageContent and database types as they were: no Journal database or date in the input", async () => {
    const pageId = await liveItem(projectsId, "Reference page");
    const page = await tickJournal(
      await typedItem("pageContent"),
      { markdown: "A note.", placement: "end" },
      { target: pageId },
    );
    const tasksId = await databaseIdFor("tasks");
    const database = await tickJournal(await typedItem("database"), { name: "Buy milk" });
    for (const { inputs } of [page, database]) {
      expect(inputs[0]?.journalDatabaseId).toBeUndefined();
      expect(inputs[0]?.sourceDate).toBeUndefined();
    }
    expect(page.inputs[0]?.entityKind).toBe("pageContent");
    expect(page.card?.properties.proposal).toEqual({
      entityKind: "pageContent",
      target: pageId,
      properties: { markdown: "A note.", placement: "end" },
    });
    expect(database.inputs[0]).toMatchObject({ entityKind: "database", targetDatabaseId: tasksId });
    expect(database.card?.properties.proposal).toEqual({
      entityKind: "database",
      target: tasksId,
      properties: { name: "Buy milk" },
    });
  });

  it("fails the tick, writing no card, when the tenant has no Journal database", async () => {
    const itemId = await typedItem("journal");
    // Raw SQL: no API removes a system database; this is the state a tenant seeded without the Journal module has.
    await pool.query("UPDATE databases SET owner_module_id = 'journalRemoved' WHERE owner_module_id = 'journal'");
    await expect(tickJournal(itemId, { markdown: "Went for a run." })).rejects.toThrow(
      "No database seeded for owner_module_id 'journal'",
    );
    expect(await cardOf(itemId)).toBeNull();
  });

  describe("buildProposalEnvelope for a journalEntry snapshot", () => {
    async function snapshotOf(journalDatabaseId: string | undefined, dropDate = false): Promise<TickSnapshot> {
      const itemId = await typedItem("journal");
      const item = await withTransaction(pool, (client) => itemsStore.getItemById(client, inboxId, itemId));
      if (!item) throw new Error("Missing item");
      const { date: _date, ...withoutDate } = item.properties;
      return {
        sourceTypeId: null,
        item: dropDate ? { ...item, properties: withoutDate } : item,
        type: null,
        processingMethod: "journal",
        entityKind: "journalEntry",
        journalDatabaseId,
        existingProposal: null,
        fingerprint: "fingerprint",
        locale: "en",
      };
    }
    const run = { properties: { markdown: "Run." } };

    it("throws a ValidationError on target for a result that carries a target", async () => {
      const snapshot = await snapshotOf(journalId);
      const error: unknown = (() => {
        try {
          return buildProposalEnvelope(snapshot, { ...run, target: journalId });
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ details: { field: "target" } });
    });

    it("throws a plain Error, not a clarification, for a snapshot that has no Journal database", async () => {
      const snapshot = await snapshotOf(undefined);
      expect(() => buildProposalEnvelope(snapshot, run)).toThrow(/has no journalDatabaseId/);
      expect(() => buildProposalEnvelope(snapshot, run)).not.toThrow(ValidationError);
    });

    it("leaves the date out, for the envelope validation to refuse, when neither the result nor the item has one", async () => {
      expect(buildProposalEnvelope(await snapshotOf(journalId, true), run)).toEqual({
        entityKind: "journalEntry",
        target: journalId,
        properties: { markdown: "Run." },
      });
    });
  });

  it("does not accept an area of another tenant: the card is needsClarification, as for an id that names no item", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      // The own item is created while the tenant is the only one: the superuser pool resolves its tenant by that.
      const itemId = await typedItem("journal");
      const foreign = await createTestTenant(pool);
      await createUser(pool, { tenantId: foreign, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
      await runInTenant(foreign, () => seedSystem(runtime));
      const foreignAreaId = await runInTenant(foreign, () =>
        withTransaction(runtime, async (client) => {
          const areas = await databasesStore.getDatabaseByModuleId(client, "areas");
          if (!areas) throw new Error("Foreign tenant has no Areas database");
          return (await createItemWithClient(client, { databaseId: areas.id, properties: { name: "Foreign" } })).id;
        }),
      );
      const cards = await runInTenant(getTenantZeroId(), async () => {
        await directTick(runtime, itemId, propose({ markdown: "Went for a run.", areaId: foreignAreaId }));
        return withTransaction(runtime, async (client) => {
          const { rows } = await client.query<{ properties: Record<string, unknown> }>(
            "SELECT properties FROM items WHERE database_id = $1",
            [proposalsId],
          );
          return rows;
        });
      });
      expect(cards).toHaveLength(1);
      expect(cards[0]?.properties).toMatchObject({ status: "needsClarification", proposal: null });
      // The answer is the one an id that names no item gets, and nothing of the foreign item is on the card.
      expect(JSON.stringify(cards[0]?.properties.history)).toContain("is not a live item of areas");
      expect(JSON.stringify(cards[0]?.properties)).not.toContain("Foreign");
    } finally {
      await runtime.end();
    }
  });
});

describe("an operation marked primary stands for an existing record", () => {
  let companiesId: string;
  let peopleId: string;

  beforeEach(async () => {
    await resetTickDatabases();
    companiesId = await databaseIdFor("companies");
    peopleId = await databaseIdFor("people");
  });

  const existingCompany = { op: "update" as const, alias: "co", primary: true as const };
  const typedItem = async (targetDatabase: "companies" | "people") =>
    (await typedSource("Capture", { name: "Capture", emoji: "N", targetDatabase })).item.id;
  const liveItem = async (databaseId: string, properties: Record<string, unknown>) =>
    (await withTransaction(pool, (client) => createItemWithClient(client, { databaseId, properties }))).id;

  it("buildProposalSteps makes the marked operation the primary step without storing the marker, and otherwise the first create into the target", () => {
    const personCreate = { op: "create" as const, database: "people", properties: { name: "Eva" } };
    const companyCreate = { op: "create" as const, database: "companies", properties: { name: "Brainz" } };
    const steps = buildProposalSteps([personCreate, { ...existingCompany, itemId: "item-1" }], "people");
    expect(steps.map((step) => [step.ref, step.op, step.role])).toEqual([
      ["op1", "create", "secondary"],
      ["co", "update", "primary"],
    ]);
    expect(steps.flatMap((step) => Object.keys(step))).not.toContain("primary");
    expect(buildProposalSteps([companyCreate, personCreate], "people").map((step) => step.role)).toEqual([
      "secondary",
      "primary",
    ]);
  });

  it("buildProposalEnvelope stores one marked operation as a multi-step envelope, and a single unmarked one as the ordinary single write", async () => {
    const itemId = await typedItem("companies");
    const item = await withTransaction(pool, (client) => itemsStore.getItemById(client, inboxId, itemId));
    if (!item) throw new Error("Missing item");
    const snapshot: TickSnapshot = {
      sourceTypeId: null,
      item,
      type: null,
      processingMethod: "database",
      entityKind: "database",
      targetDatabaseId: companiesId,
      targetModuleId: "companies",
      existingProposal: null,
      fingerprint: "fingerprint",
      locale: "en",
    };
    expect(
      buildProposalEnvelope(snapshot, {
        properties: { name: "Ignored", ico: "07654321" },
        operations: [{ ...existingCompany, itemId: "item-1" }],
      }),
    ).toEqual({
      entityKind: "database",
      target: companiesId,
      properties: {},
      operations: [{ ref: "co", op: "update", itemId: "item-1", role: "primary", after: {} }],
    });
    expect(
      buildProposalEnvelope(snapshot, {
        properties: { name: "Acme" },
        operations: [{ op: "create", database: "companies", properties: { name: "Acme" } }],
      }),
    ).toEqual({ entityKind: "database", target: companiesId, properties: { name: "Acme" } });
  });

  it("the tick stores a proposed card whose primary step is an update that changes nothing, for the existing company", async () => {
    const companyId = await liveItem(companiesId, { name: "Bakery", ico: "07654321" });
    const itemId = await typedItem("companies");
    await tick(
      itemId,
      propose({ name: "Bakery", ico: "07654321" }, { operations: [{ ...existingCompany, itemId: companyId }] }),
    );
    const card = await requireCard(itemId);
    expect(card.properties.status).toBe("proposed");
    const unchanged = { properties: {}, relations: {} };
    expect(card.properties.proposal).toEqual({
      entityKind: "database",
      target: companiesId,
      properties: {},
      operations: [
        { ref: "co", op: "update", itemId: companyId, role: "primary", before: unchanged, after: unchanged },
      ],
    });
  });

  it("the tick stores a proposed card with the person create and a link step for the existing company", async () => {
    const companyId = await liveItem(companiesId, { name: "Bakery", ico: "07654321" });
    const itemId = await typedItem("people");
    await tick(
      itemId,
      propose(
        { name: "Eva" },
        {
          operations: [
            {
              op: "create",
              database: "people",
              properties: { name: "Eva" },
              relations: { companies: [{ alias: "co" }] },
            },
            { op: "link", itemId: companyId, alias: "co" },
          ],
        },
      ),
    );
    const card = await requireCard(itemId);
    expect(card.properties.status).toBe("proposed");
    expect(card.properties.proposal).toEqual({
      entityKind: "database",
      target: peopleId,
      properties: { name: "Eva" },
      operations: [
        {
          ref: "op1",
          op: "create",
          role: "primary",
          databaseKey: "people",
          properties: { name: "Eva" },
          relations: { companies: [{ ref: "co" }] },
        },
        { ref: "co", op: "link", role: "secondary", itemId: companyId },
      ],
    });
  });
});
