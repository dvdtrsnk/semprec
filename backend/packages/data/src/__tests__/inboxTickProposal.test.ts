import { z } from "zod";
import { writeBlock } from "@semprec/block-model";
import { mutateDoc } from "../docs/docPersistence.js";
import { createDocStore } from "../docs/docStore.js";
import { getOrCreateJournalItem } from "../journal/journalStore.js";
import { resolveModelPagePlacement } from "../inbox/inboxTickSnapshot.js";
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
import {
  aiProposalPatch,
  assertValidProposalEnvelope,
  createSemprecTickAction,
  parseStoredProposalEnvelope,
  readAiProposal,
  type ComputeSemprecProposalFn,
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

async function boundedBarrier<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Concurrency barrier timed out")), 5000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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

/** The version 1 fingerprint (issue #223), pinned by formula: the tick no longer writes it (issue #1606). */
function legacyFingerprintOf(emoji: string, text: string): string {
  return createHash("sha256").update(JSON.stringify({ emoji, text })).digest("hex");
}

/**
 * The version 2 fingerprint (issue #1606) written out by hand: canonical JSON with the keys in code-point
 * order and the attachment hashes sorted, and `transcribedText` empty. The test does not reuse the
 * production function it checks.
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

async function findProposalForItem(tickPool: Pool, proposalsId: string, itemId: string) {
  return withTransaction(tickPool, async (client) => {
    const sourceInboxProperty = await propertiesStore.getPropertyByKey(client, proposalsId, "sourceInbox");
    const relationDefinition = await relationsStore.getRelationDefinitionByPropertyId(client, sourceInboxProperty!.id);
    // Every edge, not `edges[0]`: the same scan production's `findExistingProposal` does, so a
    // soft-deleted proposal still linked to the item is skipped here as it is there.
    const edges = await relationsStore.listRelationsForItem(client, relationDefinition!.id, itemId);
    for (const edge of edges) {
      const proposal = await itemsStore.getItemById(client, proposalsId, relationsStore.otherSide(edge, itemId));
      if (proposal && !proposal.deletedAt) return proposal;
    }
    return null;
  });
}

async function runTick(
  tickPool: Pool,
  databaseIds: TickDatabaseIds,
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
  await handler(databaseIds, { heartbeatId: "hb", projectItemId: "proj", itemId });
}

describe("semprec.tick fingerprinting and proposal create/revise/skip (issue #223)", () => {
  let inboxId: string;
  let typesId: string;
  let proposalsId: string;
  let databaseIds: TickDatabaseIds;

  beforeEach(async () => {
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
  });

  it("creates exactly one proposed row with the generic envelope and correct fingerprint for a 'database' type", async () => {
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

    let calls = 0;
    await runTick(pool, databaseIds, item.id, async (input) => {
      calls++;
      expect(input.projectItemId).toBe("proj");
      expect(input.entityKind).toBe("database");
      expect(input.targetDatabaseId).toBeTruthy();
      return { properties: { name: "Buy milk" } };
    });
    expect(calls).toBe(1);

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal).toBeTruthy();
    expect(proposal!.properties.status).toBe("proposed");
    expect(proposal!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk" }));
    expect(proposal!.properties.history).toHaveLength(1);
    const entry = (proposal!.properties.history as Array<Record<string, unknown>>)[0]!;
    expect(entry).toMatchObject({ author: "ai" });
    expect(typeof entry.message).toBe("string");
    expect(typeof entry.at).toBe("string");

    const tasksDbId = await databaseIdFor("tasks");
    expect(proposal!.properties.proposal).toEqual({
      entityKind: "database",
      target: tasksDbId,
      properties: { name: "Buy milk" },
    });
    expect(Object.keys(proposal!.properties.proposal as object).sort()).toEqual(["entityKind", "properties", "target"]);
  });

  describe("untyped recognition", () => {
    async function fixture() {
      const type = await withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name: "Recognized task",
          status: "active",
          emoji: "T",
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
        }),
      );
      return { type, item };
    }
    it.each(["type", "direct"])(
      "recognizes a %s candidate without writing the source type and reuses the fingerprint",
      async (kind) => {
        const { type, item } = await fixture();
        let calls = 0;
        const compute: ComputeSemprecProposalFn = async (input) => {
          calls++;
          expect(input.recognition).toBe(true);
          return {
            properties: { name: "Buy milk" },
            candidates: [
              kind === "type" ? { typeId: type.id, confidence: 0.9 } : { targetDatabaseKey: "tasks", confidence: 0.9 },
            ],
          };
        };
        await runTick(pool, databaseIds, item.id, compute);
        const card = await findProposalForItem(pool, proposalsId, item.id);
        expect(card?.properties).toMatchObject({
          status: "proposed",
          recognizedTypeId: kind === "type" ? type.id : null,
          typeCandidates: [],
          fingerprint: fingerprintV2Of({ typeId: "", text: "Buy milk" }),
        });
        await runTick(pool, databaseIds, item.id, compute);
        expect(calls).toBe(1);
        expect(await findProposalForItem(pool, proposalsId, item.id)).toEqual(card);
        const property = await withTransaction(pool, (client) =>
          propertiesStore.getPropertyByKey(client, inboxId, "type"),
        );
        if (!property) throw new Error("Missing type property");
        const definition = await withTransaction(pool, (client) =>
          relationsStore.getRelationDefinitionByPropertyId(client, property.id),
        );
        if (!definition) throw new Error("Missing type definition");
        expect(
          await withTransaction(pool, (client) => relationsStore.listRelationsForItem(client, definition.id, item.id)),
        ).toEqual([]);
      },
    );
    it("reuses recognition after a real unrelated historical property edit under the runtime role", async () => {
      const { type, item } = await fixture();
      const owner = getTenantZeroId();
      const propertyId = randomUUID();
      // Synthetic historical schema: the normal schema API refuses additions to the locked Inbox.
      const inserted = await pool.query(
        `INSERT INTO properties (id, tenant_id, database_id, key, name, type, config, locked, owner)
         SELECT $1, $2, id, $3, $4, 'text', '{}'::jsonb, false, 'user'
         FROM databases WHERE tenant_id = $2 AND id = $5`,
        [propertyId, owner, "testNote", "Test note", inboxId],
      );
      expect(inserted.rowCount).toBe(1);
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      try {
        const role = await runtime.query<{ bypass: boolean; superuser: boolean }>(
          "SELECT rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
        );
        expect(role.rows).toEqual([{ bypass: false, superuser: false }]);
        await runInTenant(owner, () =>
          withTransaction(runtime, (client) =>
            updateItemWithClient(client, {
              databaseId: inboxId,
              itemId: item.id,
              propertiesPatch: { testNote: "before" },
            }),
          ),
        );
        let calls = 0;
        const compute: ComputeSemprecProposalFn = async () => {
          calls++;
          return { properties: { name: "Buy milk" }, candidates: [{ typeId: type.id, confidence: 0.9 }] };
        };
        await runTick(pool, databaseIds, item.id, compute);
        const card = await findProposalForItem(pool, proposalsId, item.id);
        const before = await runInTenant(owner, () => createChokePoint(runtime).getItem(inboxId, item.id));
        await runInTenant(owner, () =>
          withTransaction(runtime, (client) =>
            updateItemWithClient(client, {
              databaseId: inboxId,
              itemId: item.id,
              propertiesPatch: { testNote: "after" },
            }),
          ),
        );
        const after = await runInTenant(owner, () => createChokePoint(runtime).getItem(inboxId, item.id));
        expect(after?.properties.testNote).toBe("after");
        expect(after?.updatedAt).not.toBe(before?.updatedAt);
        await runTick(pool, databaseIds, item.id, compute);
        expect(calls).toBe(1);
        expect(await findProposalForItem(pool, proposalsId, item.id)).toEqual(card);
        expect(card?.properties.fingerprint).toBe(fingerprintV2Of({ typeId: "", text: "Buy milk" }));
        const property = await withTransaction(pool, (client) =>
          propertiesStore.getPropertyByKey(client, inboxId, "type"),
        );
        const definition =
          property &&
          (await withTransaction(pool, (client) =>
            relationsStore.getRelationDefinitionByPropertyId(client, property.id),
          ));
        if (!definition) throw new Error("Missing Inbox type definition");
        expect(
          await withTransaction(pool, (client) => relationsStore.listRelationsForItem(client, definition.id, item.id)),
        ).toEqual([]);
      } finally {
        await runtime.end();
      }
    });
    it.each(["type", "direct"])("reruns %s recognition after text changes", async (kind) => {
      const { type, item } = await fixture();
      let calls = 0;
      const compute: ComputeSemprecProposalFn = async () => {
        calls++;
        return {
          properties: { name: "Task" },
          candidates: [
            kind === "type" ? { typeId: type.id, confidence: 0.7 } : { targetDatabaseKey: "tasks", confidence: 0.7 },
          ],
        };
      };
      await runTick(pool, databaseIds, item.id, compute);
      await withTransaction(pool, (client) =>
        updateItemWithClient(client, { databaseId: inboxId, itemId: item.id, propertiesPatch: { text: "Buy eggs" } }),
      );
      await runTick(pool, databaseIds, item.id, compute);
      expect(calls).toBe(2);
      expect((await findProposalForItem(pool, proposalsId, item.id))?.properties).toMatchObject({
        status: "proposed",
        recognizedTypeId: kind === "type" ? type.id : null,
        typeCandidates: [],
      });
    });
    it("offers padded distinct candidates and the model reason below threshold", async () => {
      const { type, item } = await fixture();
      const second = await withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name: "Alternative task",
          status: "active",
          emoji: "A",
          processingMethod: "database",
          targetDatabase: "tasks",
        }),
      );
      await runTick(pool, databaseIds, item.id, async () => ({
        properties: {},
        reason: "Choose a type",
        candidates: [
          { typeId: type.id, confidence: 0.5 },
          { typeId: "unknown", confidence: 1 },
        ],
      }));
      const card = await findProposalForItem(pool, proposalsId, item.id);
      expect(card?.properties).toMatchObject({ status: "needsClarification", recognizedTypeId: null, proposal: null });
      const choices = z.array(z.object({ typeId: z.string() })).parse(card?.properties.typeCandidates);
      expect(choices.map((choice) => choice.typeId)).toEqual([type.id, second.id]);
      expect(card?.properties.reason).toBe("Choose a type");
      expect(new Set(choices.map((choice) => choice.typeId)).size).toBe(choices.length);
      expect(choices.map((choice) => choice.typeId)).not.toContain("unknown");
      await withTransaction(pool, (client) =>
        updateItemWithClient(client, {
          databaseId: inboxId,
          itemId: item.id,
          propertiesPatch: { text: "A different uncertain item" },
        }),
      );
      await runTick(pool, databaseIds, item.id, async () => ({
        properties: {},
        candidates: [{ typeId: second.id, confidence: 0.5 }],
        reason: "Another choice",
      }));
      const revised = await findProposalForItem(pool, proposalsId, item.id);
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
      await runTick(pool, databaseIds, item.id, async () => {
        await withTransaction(pool, (client) =>
          updateItemWithClient(client, { databaseId: inboxId, itemId: item.id, propertiesPatch: { text: "Changed" } }),
        );
        return { properties: { name: "Stale" }, candidates: [{ typeId: type.id, confidence: 0.9 }] };
      });
      expect(await findProposalForItem(pool, proposalsId, item.id)).toBeNull();
    });
    it.each(["archived", "targetChanged", "deleted"] as const)(
      "does not promote another candidate when the selected type is %s during computation",
      async (change) => {
        const { type, item } = await fixture();
        const alternate = await withTransaction(pool, (client) =>
          createInboxTypeWithClient(client, {
            inboxItemTypesDatabaseId: typesId,
            name: "Alternative",
            status: "active",
            emoji: "A",
            processingMethod: "database",
            targetDatabase: "projects",
          }),
        );
        const tasks = await databaseIdFor("tasks");
        const projects = await databaseIdFor("projects");
        const beforeTasks = (await createChokePoint(pool).listItems(tasks)).items;
        const beforeProjects = (await createChokePoint(pool).listItems(projects)).items;
        await runTick(pool, databaseIds, item.id, async () => {
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
            await withTransaction(pool, (client) =>
              updateItemWithClient(client, {
                databaseId: typesId,
                itemId: type.id,
                propertiesPatch: change === "archived" ? { status: "archived" } : { targetDatabase: "projects" },
              }),
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
        const card = await findProposalForItem(pool, proposalsId, item.id);
        expect(card?.properties).toMatchObject({
          status: "needsClarification",
          recognizedTypeId: null,
          proposal: null,
        });
        expect(card?.properties.reason).toBeTruthy();
        expect((await createChokePoint(pool).listItems(tasks)).items).toEqual(beforeTasks);
        expect((await createChokePoint(pool).listItems(projects)).items).toEqual(beforeProjects);
        const property = await withTransaction(pool, (client) =>
          propertiesStore.getPropertyByKey(client, inboxId, "type"),
        );
        const definition =
          property &&
          (await withTransaction(pool, (client) =>
            relationsStore.getRelationDefinitionByPropertyId(client, property.id),
          ));
        if (!definition) throw new Error("Missing Inbox type definition");
        expect(
          await withTransaction(pool, (client) => relationsStore.listRelationsForItem(client, definition.id, item.id)),
        ).toEqual([]);
      },
    );
    it("clarifies a selected page-content type when the computation has no target", async () => {
      const item = (await fixture()).item;
      const pageType = await withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name: "Page",
          status: "active",
          emoji: "P",
          processingMethod: "pageContent",
        }),
      );
      await runTick(pool, databaseIds, item.id, async () => ({
        properties: { flavour: "paragraph" },
        candidates: [{ typeId: pageType.id, confidence: 0.9 }],
      }));
      expect((await findProposalForItem(pool, proposalsId, item.id))?.properties).toMatchObject({
        status: "needsClarification",
        recognizedTypeId: null,
        proposal: null,
      });
    });
    it.each([false, true])("handles page target database archive during computation: %s", async (archive) => {
      const { item } = await fixture();
      const pageType = await withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name: "Page",
          status: "active",
          emoji: "P",
          processingMethod: "pageContent",
        }),
      );
      const api = createChokePoint(pool);
      const database = await api.createDatabase({ name: "Page target" });
      const page = await api.createItem({ databaseId: database.id, properties: {} });
      await runTick(pool, databaseIds, item.id, async () => {
        if (archive) await api.archiveDatabase(database.id);
        return {
          target: page.id,
          properties: { flavour: "paragraph", fields: { content: "Proposed" } },
          candidates: [{ typeId: pageType.id, confidence: 0.9 }],
        };
      });
      const card = await findProposalForItem(pool, proposalsId, item.id);
      if (archive) {
        expect(card?.properties).toMatchObject({
          status: "needsClarification",
          recognizedTypeId: null,
          proposal: null,
        });
      } else {
        expect(card?.properties).toMatchObject({ status: "proposed", recognizedTypeId: pageType.id });
      }
      expect(await withTransaction(pool, (client) => itemsStore.getItemById(client, database.id, page.id))).toEqual(
        page,
      );
      const property = await withTransaction(pool, (client) =>
        propertiesStore.getPropertyByKey(client, inboxId, "type"),
      );
      const definition =
        property &&
        (await withTransaction(pool, (client) =>
          relationsStore.getRelationDefinitionByPropertyId(client, property.id),
        ));
      if (!definition) throw new Error("Missing Inbox type definition");
      expect(
        await withTransaction(pool, (client) => relationsStore.listRelationsForItem(client, definition.id, item.id)),
      ).toEqual([]);
    });
    it.each([0, 1])("explains a changed selection and a shortage of %s choices in both locales", async (count) => {
      const choices = count ? [{ typeId: randomUUID(), label: "Available", targetDatabaseKey: "tasks" }] : [];
      for (const [locale, shortage, changed] of [
        ["cs", "Jsou dostupné méně než dva platné aktivní typy.", "Vybraný typ nebo cíl není dostupný nebo se změnil."],
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
      const alternative = count
        ? await withTransaction(pool, (client) =>
            createInboxTypeWithClient(client, {
              inboxItemTypesDatabaseId: typesId,
              name: "Remaining",
              status: "active",
              emoji: "R",
              processingMethod: "database",
              targetDatabase: "projects",
            }),
          )
        : null;
      const types = await withTransaction(pool, (client) => itemsStore.listItems(client, typesId, { limit: 200 }));
      for (const row of types.items) {
        if (row.id === type.id || row.id === alternative?.id) continue;
        await withTransaction(pool, (client) =>
          updateItemWithClient(client, {
            databaseId: typesId,
            itemId: row.id,
            propertiesPatch: { status: "archived" },
          }),
        );
      }
      await runTick(pool, databaseIds, item.id, async () => {
        await withTransaction(pool, (client) =>
          updateItemWithClient(client, {
            databaseId: typesId,
            itemId: type.id,
            propertiesPatch: { status: "archived" },
          }),
        );
        return { properties: { name: "Stale" }, candidates: [{ typeId: type.id, confidence: 0.9 }] };
      });
      const card = await findProposalForItem(pool, proposalsId, item.id);
      expect(card?.properties).toMatchObject({ status: "needsClarification", proposal: null, recognizedTypeId: null });
      expect(z.array(z.unknown()).parse(card?.properties.typeCandidates)).toHaveLength(count);
      expect(card?.properties.reason).toEqual(
        expect.stringContaining("Jsou dostupné méně než dva platné aktivní typy."),
      );
      expect(card?.properties.reason).toEqual(
        expect.stringContaining("Vybraný typ nebo cíl není dostupný nebo se změnil."),
      );
    });
    it("keeps the changed-selection reason without a shortage when two choices remain", async () => {
      const choices = ["One", "Two"].map((label) => ({
        typeId: randomUUID(),
        label,
        targetDatabaseKey: "tasks",
      }));
      const patch = await recognitionClarificationPatch("en", choices, true);
      expect(patch.reason).toBe("The selected type or destination is unavailable or changed. Please clarify.");
    });
    it("clarifies when a direct target resolves to a different historical fixture database", async () => {
      const { type, item } = await fixture();
      const api = createChokePoint(pool);
      const original = await databaseIdFor("tasks");
      const replacement = await api.createDatabase({ name: "Replacement target" });
      const originalItems = (await api.listItems(original)).items;
      const replacementItems = (await api.listItems(replacement.id)).items;
      let release = () => {};
      let reached = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const ready = new Promise<void>((resolve) => (reached = resolve));
      const tick = runInTenant(getTenantZeroId(), () =>
        runTick(pool, databaseIds, item.id, async () => {
          reached();
          await gate;
          return {
            properties: { name: "Must not move" },
            candidates: [
              { targetDatabaseKey: "tasks", confidence: 0.9 },
              { typeId: type.id, confidence: 0.8 },
            ],
          };
        }),
      );
      let failure: { error: unknown } | undefined;
      let fixtureChanged = false;
      try {
        await Promise.race([
          ready,
          tick.then(() => {
            throw new Error("Tick ended before computation barrier");
          }),
        ]);
        // Synthetic historical configuration: no public writer replaces a system module mapping.
        await runInTenant(getTenantZeroId(), () =>
          withTransaction(pool, async (client) => {
            const cleared = await client.query(
              "UPDATE databases SET owner_module_id = NULL WHERE tenant_id = $1 AND id = $2 AND system = true AND owner_module_id = $3",
              [getTenantZeroId(), original, "tasks"],
            );
            expect(cleared.rowCount).toBe(1);
            const assigned = await client.query(
              "UPDATE databases SET system = true, owner_module_id = $3 WHERE tenant_id = $1 AND id = $2 AND system = false AND owner_module_id IS NULL",
              [getTenantZeroId(), replacement.id, "tasks"],
            );
            expect(assigned.rowCount).toBe(1);
          }),
        );
        fixtureChanged = true;
        const resolved = await runInTenant(getTenantZeroId(), () =>
          withTransaction(pool, (client) => databasesStore.getDatabaseByModuleId(client, "tasks")),
        );
        expect(resolved?.id).toBe(replacement.id);
        expect(resolved?.id).not.toBe(original);
        process.stdout.write(`recognition target fixture: original=${original} replacement=${replacement.id}\n`);
      } catch (error) {
        failure = { error };
      } finally {
        release();
      }
      const [settled] = await Promise.allSettled([tick]);
      if (settled.status === "rejected") failure = combineOverlapFailure(failure, settled.reason);
      if (!failure) {
        try {
          expect((await findProposalForItem(pool, proposalsId, item.id))?.properties).toMatchObject({
            status: "needsClarification",
            recognizedTypeId: null,
            proposal: null,
          });
          expect((await api.listItems(original)).items).toEqual(originalItems);
          expect((await api.listItems(replacement.id)).items).toEqual(replacementItems);
          const property = await withTransaction(pool, (client) =>
            propertiesStore.getPropertyByKey(client, inboxId, "type"),
          );
          const definition =
            property &&
            (await withTransaction(pool, (client) =>
              relationsStore.getRelationDefinitionByPropertyId(client, property.id),
            ));
          if (!definition) throw new Error("Missing Inbox type definition");
          expect(
            await withTransaction(pool, (client) =>
              relationsStore.listRelationsForItem(client, definition.id, item.id),
            ),
          ).toEqual([]);
        } catch (error) {
          failure = { error };
        }
      }
      if (fixtureChanged) {
        try {
          await runInTenant(getTenantZeroId(), () =>
            withTransaction(pool, async (client) => {
              const cleared = await client.query(
                "UPDATE databases SET system = false, owner_module_id = NULL WHERE tenant_id = $1 AND id = $2 AND system = true AND owner_module_id = $3",
                [getTenantZeroId(), replacement.id, "tasks"],
              );
              expect(cleared.rowCount).toBe(1);
              const restored = await client.query(
                "UPDATE databases SET owner_module_id = $3 WHERE tenant_id = $1 AND id = $2 AND system = true AND owner_module_id IS NULL",
                [getTenantZeroId(), original, "tasks"],
              );
              expect(restored.rowCount).toBe(1);
            }),
          );
        } catch (error) {
          failure = combineOverlapFailure(failure, error);
        }
      }
      if (failure) throw failure.error;
    });
    it("clarifies a direct target archived during computation without writing the target", async () => {
      const { type, item } = await fixture();
      const tasks = await databaseIdFor("tasks");
      const api = createChokePoint(pool);
      const before = (await api.listItems(tasks)).items;
      const beforeDatabase = await pool.query<{ row: unknown }>(
        "SELECT to_jsonb(d) AS row FROM databases d WHERE id = $1",
        [tasks],
      );
      await expect(api.archiveDatabase(tasks)).rejects.toMatchObject({ code: "forbidden" });
      expect(
        (await pool.query<{ row: unknown }>("SELECT to_jsonb(d) AS row FROM databases d WHERE id = $1", [tasks])).rows,
      ).toEqual(beforeDatabase.rows);
      let release = () => {};
      let reached = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const ready = new Promise<void>((resolve) => (reached = resolve));
      const tick = runInTenant(getTenantZeroId(), () =>
        runTick(pool, databaseIds, item.id, async () => {
          reached();
          await gate;
          return {
            properties: { name: "Not written" },
            candidates: [
              { targetDatabaseKey: "tasks", confidence: 0.9 },
              { typeId: type.id, confidence: 0.8 },
            ],
          };
        }),
      );
      let failure: { error: unknown } | undefined;
      let fixtureChanged = false;
      try {
        await Promise.race([
          ready,
          tick.then(() => {
            throw new Error("Tick ended before computation barrier");
          }),
        ]);
        // Synthetic historical/corrupt state: the public writer cannot archive a system database.
        await runInTenant(getTenantZeroId(), () =>
          withTransaction(pool, async (client) => {
            const changed = await client.query(
              "UPDATE databases SET archived_at = now() WHERE tenant_id = $1 AND id = $2 AND system = true AND archived_at IS NULL",
              [getTenantZeroId(), tasks],
            );
            expect(changed.rowCount).toBe(1);
            fixtureChanged = true;
          }),
        );
      } catch (error) {
        failure = { error };
      } finally {
        release();
      }
      const [settled] = await Promise.allSettled([tick]);
      if (settled.status === "rejected") {
        if (!failure) failure = { error: settled.reason };
        else if (failure.error !== settled.reason) failure = combineOverlapFailure(failure, settled.reason);
      }
      if (!failure) {
        try {
          expect((await findProposalForItem(pool, proposalsId, item.id))?.properties).toMatchObject({
            status: "needsClarification",
            recognizedTypeId: null,
            proposal: null,
          });
          expect((await api.listItems(tasks)).items).toEqual(before);
          const property = await withTransaction(pool, (client) =>
            propertiesStore.getPropertyByKey(client, inboxId, "type"),
          );
          const definition =
            property &&
            (await withTransaction(pool, (client) =>
              relationsStore.getRelationDefinitionByPropertyId(client, property.id),
            ));
          if (!definition) throw new Error("Missing Inbox type definition");
          expect(
            await withTransaction(pool, (client) =>
              relationsStore.listRelationsForItem(client, definition.id, item.id),
            ),
          ).toEqual([]);
        } catch (error) {
          failure = { error };
        }
      }
      if (fixtureChanged) {
        try {
          await runInTenant(getTenantZeroId(), () =>
            withTransaction(pool, async (client) => {
              const restored = await client.query(
                "UPDATE databases SET archived_at = NULL WHERE tenant_id = $1 AND id = $2 AND system = true AND archived_at IS NOT NULL",
                [getTenantZeroId(), tasks],
              );
              expect(restored.rowCount).toBe(1);
            }),
          );
        } catch (error) {
          failure = combineOverlapFailure(failure, error);
        }
      }
      if (failure) throw failure.error;
    });
    it("clarifies a typed page-content result with no target", async () => {
      const pageType = await withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name: "Page",
          status: "active",
          emoji: "P",
          processingMethod: "pageContent",
        }),
      );
      const item = await withTransaction(pool, (client) =>
        createInboxItemWithClient(client, {
          inboxDatabaseId: inboxId,
          date: "2026-08-28",
          time: "09:00",
          text: "Page",
          type: pageType.id,
        }),
      );
      await runTick(pool, databaseIds, item.id, async () => ({ properties: { flavour: "paragraph" } }));
      expect((await findProposalForItem(pool, proposalsId, item.id))?.properties).toMatchObject({
        status: "needsClarification",
        proposal: null,
      });
    });
    it("ignores foreign and random type candidates under the tenant runtime role", async () => {
      const { type, item } = await fixture();
      const owner = getTenantZeroId();
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
        await runInTenant(owner, () =>
          runTick(runtime, databaseIds, item.id, async () => ({
            properties: { name: "Owner" },
            candidates: [
              { typeId: foreignType.id, confidence: 1 },
              { typeId: unknown, confidence: 0.95 },
              { typeId: type.id, confidence: 0.9 },
            ],
          })),
        );
        const card = await findProposalForItem(pool, proposalsId, item.id);
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
        let release = () => {};
        let reached = () => {};
        const gate = new Promise<void>((resolve) => (release = resolve));
        const ready = new Promise<void>((resolve) => (reached = resolve));
        let holderPid = 0;
        let contenderPid = 0;
        const observed = new Proxy(runtime, {
          get(target, key, receiver) {
            if (key !== "connect") {
              const value: unknown = Reflect.get(target, key, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            }
            return async () => {
              const client = await target.connect();
              return new Proxy(client, {
                get(inner, field, receiver2) {
                  if (field !== "query") {
                    const value: unknown = Reflect.get(inner, field, receiver2);
                    return typeof value === "function" ? value.bind(inner) : value;
                  }
                  return async (...args: unknown[]) => {
                    const reservation =
                      typeof args[0] === "string" &&
                      args[0].includes("id = ANY($2::uuid[]) ORDER BY id FOR SHARE NOWAIT");
                    if (reservation && order === "type-first")
                      contenderPid = (await inner.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!
                        .pid;
                    const result: unknown = await Reflect.apply(inner.query.bind(inner), inner, args);
                    if (order === "recognition-first" && reservation) {
                      holderPid = (await inner.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
                      reached();
                      await gate;
                    }
                    return result;
                  };
                },
              });
            };
          },
        });
        const owned = ownOverlap(runtime, release);
        let failure: { error: unknown } | undefined;
        try {
          if (order === "type-first") {
            const writer = owned.run(() =>
              runInTenant(getTenantZeroId(), () =>
                withTransaction(runtime, async (client) => {
                  holderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
                  await updateItemWithClient(client, {
                    databaseId: typesId,
                    itemId: type.id,
                    propertiesPatch: { status: "archived" },
                  });
                  reached();
                  await gate;
                }),
              ),
            );
            await owned.wait(ready, writer);
            const tick = owned.run(() =>
              runInTenant(getTenantZeroId(), () =>
                runTick(observed, databaseIds, item.id, async () => ({
                  properties: { name: "Task" },
                  candidates: [{ typeId: type.id, confidence: 0.9 }],
                })),
              ),
            );
            await owned.wait(tick, writer);
            expect(contenderPid).toBeGreaterThan(0);
            expect(contenderPid).not.toBe(holderPid);
            process.stdout.write(`type-first: holder=${holderPid} contender=${contenderPid}\n`);
            expect(await findProposalForItem(pool, proposalsId, item.id)).toBeNull();
            release();
            await writer;
          } else {
            const tick = owned.run(() =>
              runInTenant(getTenantZeroId(), () =>
                runTick(observed, databaseIds, item.id, async () => ({
                  properties: { name: "Task" },
                  candidates: [{ typeId: type.id, confidence: 0.9 }],
                })),
              ),
            );
            await owned.wait(ready, tick);
            const writer = owned.run(() =>
              runInTenant(getTenantZeroId(), () =>
                withTransaction(runtime, async (client) => {
                  contenderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
                  await updateItemWithClient(client, {
                    databaseId: typesId,
                    itemId: type.id,
                    propertiesPatch: { status: "archived" },
                  });
                }),
              ),
            );
            await vi.waitFor(async () => {
              expect(contenderPid).toBeGreaterThan(0);
              const blocked = await pool.query<{ pids: number[] }>("SELECT pg_blocking_pids($1) AS pids", [
                contenderPid,
              ]);
              expect(blocked.rows[0]?.pids).toContain(holderPid);
            });
            process.stdout.write(`recognition-first: holder=${holderPid} contender=${contenderPid}\n`);
            release();
            await tick;
            await writer;
            expect((await findProposalForItem(pool, proposalsId, item.id))?.properties.status).toBe("proposed");
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
      },
      20000,
    );
    it.each(["date", "time", "attachment"])("reruns recognition after a %s change", async (field) => {
      const { type, item } = await fixture();
      let calls = 0;
      const compute: ComputeSemprecProposalFn = async () => {
        calls++;
        return { properties: { name: "Task" }, candidates: [{ typeId: type.id, confidence: 0.9 }] };
      };
      await runTick(pool, databaseIds, item.id, compute);
      if (field === "attachment") {
        const blob = await createBlob(pool, {
          mimeType: "image/png",
          byteSize: 1,
          storageKey: "recognition-attachment",
          contentHash: "a".repeat(64),
        });
        await insertInboxAttachments(pool, item.id, [{ blobId: blob.id, source: "camera" }]);
      } else
        await withTransaction(pool, (client) =>
          updateItemWithClient(client, {
            databaseId: inboxId,
            itemId: item.id,
            propertiesPatch: field === "date" ? { date: "2026-08-29" } : { time: "10:00" },
          }),
        );
      await runTick(pool, databaseIds, item.id, compute);
      expect(calls).toBe(2);
    });
    it("keeps legacy v1 compatibility for an untyped source", async () => {
      const { type, item } = await fixture();
      await runTick(pool, databaseIds, item.id, async () => ({
        properties: { name: "Task" },
        candidates: [{ typeId: type.id, confidence: 0.9 }],
      }));
      const card = await findProposalForItem(pool, proposalsId, item.id);
      if (!card) throw new Error("Missing card");
      await withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          {
            databaseId: proposalsId,
            itemId: card.id,
            propertiesPatch: { fingerprint: legacyFingerprintOf("", "Buy milk") },
          },
          { allowedSystemKeys: ["fingerprint"] },
        ),
      );
      await runTick(pool, databaseIds, item.id, async () => {
        throw new Error("Unchanged legacy source must not compute");
      });
    });
    it("discards recognition after a source type-edge change", async () => {
      const { type, item } = await fixture();
      await runTick(pool, databaseIds, item.id, async () => {
        await withTransaction(pool, async (client) => {
          const property = await propertiesStore.getPropertyByKey(client, inboxId, "type");
          if (!property) throw new Error("Missing type property");
          await createRelationWithClient(client, {
            relationPropertyId: property.id,
            callerItemId: item.id,
            targetItemId: type.id,
          });
        });
        return { properties: { name: "Stale" }, candidates: [{ typeId: type.id, confidence: 0.9 }] };
      });
      expect(await findProposalForItem(pool, proposalsId, item.id)).toBeNull();
    });
    it("never recomputes a locked recognized card", async () => {
      const { type, item } = await fixture();
      await runTick(pool, databaseIds, item.id, async () => ({
        properties: { name: "Task" },
        candidates: [{ typeId: type.id, confidence: 0.9 }],
      }));
      const card = await findProposalForItem(pool, proposalsId, item.id);
      if (!card) throw new Error("Missing card");
      await withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          { databaseId: proposalsId, itemId: card.id, propertiesPatch: { status: "rejected" } },
          { allowedSystemKeys: ["status"] },
        ),
      );
      await withTransaction(pool, (client) =>
        updateItemWithClient(client, { databaseId: inboxId, itemId: item.id, propertiesPatch: { text: "Changed" } }),
      );
      await runTick(pool, databaseIds, item.id, async () => {
        throw new Error("Locked card must not compute");
      });
    });
    it.each([0, 1])("offers only %s existing valid types and explains the shortage", async (count) => {
      const { type, item } = await fixture();
      const types = await withTransaction(pool, (client) => itemsStore.listItems(client, typesId, { limit: 200 }));
      for (const row of types.items) {
        if (count === 1 && row.id === type.id) continue;
        await withTransaction(pool, (client) =>
          updateItemWithClient(client, {
            databaseId: typesId,
            itemId: row.id,
            propertiesPatch: { status: "archived" },
          }),
        );
      }
      await runTick(pool, databaseIds, item.id, async () => ({
        properties: {},
        candidates: [{ typeId: type.id, confidence: count === 0 ? 0.9 : 0.5 }],
      }));
      const card = await findProposalForItem(pool, proposalsId, item.id);
      expect(card?.properties.status).toBe("needsClarification");
      expect(card?.properties.proposal).toBeNull();
      expect(z.array(z.unknown()).parse(card?.properties.typeCandidates)).toHaveLength(count);
      expect(card?.properties.reason).toEqual(
        expect.stringContaining("Jsou dostupné méně než dva platné aktivní typy."),
      );
    });
    it("makes no call without text", async () => {
      const { item } = await fixture();
      await withTransaction(pool, (client) =>
        updateItemWithClient(client, { databaseId: inboxId, itemId: item.id, propertiesPatch: { text: "" } }),
      );
      await runTick(pool, databaseIds, item.id, async () => {
        throw new Error("Unexpected computation");
      });
      expect((await findProposalForItem(pool, proposalsId, item.id))?.properties.status).toBe("needsClarification");
    });
  });

  describe("locale passed to computeProposal", () => {
    async function createTaskInboxItem(): Promise<string> {
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
      return item.id;
    }

    it.each(["cs", "en", "fr"] as const)(
      "passes the %s user's locale and replaces the reason on recompute",
      async (locale) => {
        await runInTenant(getTenantZeroId(), () =>
          createUser(pool, { email: `${locale}@example.com`, passwordHash: "x", locale, tenantId: getTenantZeroId() }),
        );
        const itemId = await createTaskInboxItem();
        await runInTenant(getTenantZeroId(), () =>
          runTick(pool, databaseIds, itemId, async (input) => {
            expect(input.locale).toBe(locale);
            return { properties: { name: "Buy milk" }, reason: "  Úkol s termínem.  " };
          }),
        );
        const card = await findProposalForItem(pool, proposalsId, itemId);
        expect(card?.properties.reason).toBe("Úkol s termínem.");
        await withTransaction(pool, (client) =>
          updateItemWithClient(client, { databaseId: inboxId, itemId, propertiesPatch: { text: "Buy eggs" } }),
        );
        await runInTenant(getTenantZeroId(), () =>
          runTick(pool, databaseIds, itemId, async () => ({ properties: { name: "Buy eggs" }, reason: "Nový úkol." })),
        );
        expect((await findProposalForItem(pool, proposalsId, itemId))?.properties.reason).toBe("Nový úkol.");
      },
    );
    it.each([
      [undefined, null],
      ["", null],
      ["   ", null],
      ["x".repeat(501), "x".repeat(500)],
    ] as const)("normalizes reason %s", async (reason, expected) => {
      const itemId = await createTaskInboxItem();
      await runTick(pool, databaseIds, itemId, async () => ({ properties: { name: "Task" }, reason }));
      const card = await findProposalForItem(pool, proposalsId, itemId);
      expect(card?.properties.reason).toBe(expected);
    });

    it("clears the model reason when the source is deleted", async () => {
      const itemId = await createTaskInboxItem();
      await runTick(pool, databaseIds, itemId, async () => ({ properties: { name: "Task" }, reason: "A task." }));
      await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, itemId));
      await runTick(pool, databaseIds, itemId, async () => {
        throw new Error("Deleted source must not compute");
      });
      expect((await findProposalForItem(pool, proposalsId, itemId))?.properties).toMatchObject({
        status: "invalid",
        reason: null,
      });
    });
    it("does not store the reason of an invalid computed proposal", async () => {
      const itemId = await createTaskInboxItem();
      await runTick(pool, databaseIds, itemId, async () => ({
        properties: { notAProperty: true },
        reason: "Discard me",
      }));
      expect((await findProposalForItem(pool, proposalsId, itemId))?.properties).toMatchObject({
        status: "needsClarification",
        reason: null,
      });
    });
    it("refuses a client write of reason", async () => {
      const itemId = await createTaskInboxItem();
      await runTick(pool, databaseIds, itemId, async () => ({ properties: { name: "Task" }, reason: "Original" }));
      const card = await findProposalForItem(pool, proposalsId, itemId);
      if (!card) throw new Error("Missing proposal");
      await expect(
        withTransaction(pool, (client) =>
          updateItemWithClient(client, {
            databaseId: proposalsId,
            itemId: card.id,
            propertiesPatch: { reason: "Changed" },
          }),
        ),
      ).rejects.toMatchObject({ code: "owner_violation" });
      expect((await findProposalForItem(pool, proposalsId, itemId))?.properties.reason).toBe("Original");
    });
    it("passes the bound user's locale", async () => {
      await runInTenant(getTenantZeroId(), () =>
        createUser(pool, { email: "en@example.com", passwordHash: "x", locale: "en", tenantId: getTenantZeroId() }),
      );
      const itemId = await createTaskInboxItem();

      const locales: string[] = [];
      await runInTenant(getTenantZeroId(), () =>
        runTick(pool, databaseIds, itemId, async (input) => {
          locales.push(input.locale);
          return { properties: { name: "Buy milk" } };
        }),
      );
      expect(locales).toEqual(["en"]);
    });

    it("falls back to cs when the tenant has no bound user", async () => {
      const itemId = await createTaskInboxItem();

      const locales: string[] = [];
      await runInTenant(getTenantZeroId(), () =>
        runTick(pool, databaseIds, itemId, async (input) => {
          locales.push(input.locale);
          return { properties: { name: "Buy milk" } };
        }),
      );
      expect(locales).toEqual(["cs"]);
    });
  });

  it("uses the injected function's target for a 'pageContent' type", async () => {
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
        text: "A thought",
        type: type.id,
      }),
    );

    await runTick(pool, databaseIds, item.id, async (input) => {
      expect(input.entityKind).toBe("pageContent");
      expect(input.targetDatabaseId).toBeUndefined();
      return { target: type.id, properties: { flavour: "paragraph", fields: { content: "A thought" } } };
    });

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties.proposal).toEqual({
      entityKind: "pageContent",
      target: type.id,
      properties: { flavour: "paragraph", fields: { content: "A thought" } },
    });
  });

  it("an unchanged fingerprint makes no AI call and no proposal write", async () => {
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

    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    const first = await findProposalForItem(pool, proposalsId, item.id);

    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called for an unchanged fingerprint");
    });
    const second = await findProposalForItem(pool, proposalsId, item.id);
    expect(second!.updatedAt).toBe(first!.updatedAt);
  });

  it("an edit that changes the fingerprint revises the same row rather than creating a second one", async () => {
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
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    const first = await findProposalForItem(pool, proposalsId, item.id);

    await withTransaction(pool, (client) =>
      itemsStore.updateItemProperties(client, {
        databaseId: inboxId,
        itemId: item.id,
        propertiesPatch: { text: "Buy milk and eggs" },
      }),
    );

    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk and eggs" } }));
    const revised = await findProposalForItem(pool, proposalsId, item.id);

    expect(revised!.id).toBe(first!.id);
    expect(revised!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk and eggs" }));
    expect(revised!.properties.proposal).toEqual({
      entityKind: "database",
      target: await databaseIdFor("tasks"),
      properties: { name: "Buy milk and eggs" },
    });
    expect(revised!.properties.history).toHaveLength(2);

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [proposalsId]);
    expect(rows[0].n).toBe(1);
  });

  describe("version 2 fingerprint inputs and the version 1 compatibility rule (issue #1606)", () => {
    async function createInboxType(name: string, emoji: string) {
      return withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name,
          emoji,
          processingMethod: "database",
          targetDatabase: "tasks",
        }),
      );
    }

    async function createInboxItemOfType(text: string, typeId: string) {
      return withTransaction(pool, (client) =>
        createInboxItemWithClient(client, {
          inboxDatabaseId: inboxId,
          date: "2026-08-28",
          time: "09:00",
          text,
          type: typeId,
        }),
      );
    }

    async function editInboxItem(itemId: string, propertiesPatch: Record<string, unknown>) {
      await withTransaction(pool, (client) =>
        itemsStore.updateItemProperties(client, { databaseId: inboxId, itemId, propertiesPatch }),
      );
    }

    /** Creates a blob whose content hash is derived from `label` and attaches it to the Inbox item. */
    async function attachNewBlob(itemId: string, label: string) {
      const contentHash = createHash("sha256").update(label).digest("hex");
      const blob = await createBlob(pool, {
        mimeType: "image/jpeg",
        byteSize: 3,
        storageKey: `t/blobs/${label}`,
        contentHash,
      });
      await insertInboxAttachments(pool, itemId, [{ blobId: blob.id, source: "camera" }]);
      return { blobId: blob.id, contentHash };
    }

    async function detachBlob(itemId: string, blobId: string) {
      const attachments = await listInboxAttachments(pool, [itemId]);
      const attachment = attachments.find((row) => row.blobId === blobId);
      if (!attachment) throw new Error(`Inbox item ${itemId} has no attachment of blob ${blobId}`);
      await deleteInboxAttachment(pool, attachment.attachmentId);
    }

    /**
     * Sets the stored fingerprint of a proposal. The tick no longer writes version 1 values, so a
     * card that holds one (as a card written before issue #1606 does) is built by setting it here.
     */
    async function setProposalFingerprint(proposalId: string, fingerprint: string) {
      await withTransaction(pool, (client) =>
        itemsStore.updateItemProperties(client, {
          databaseId: proposalsId,
          itemId: proposalId,
          propertiesPatch: { fingerprint },
        }),
      );
    }

    it.each([
      { field: "time", patch: { time: "10:30" } },
      { field: "date", patch: { date: "2026-08-29" } },
    ])("a changed capture $field recomputes the proposal", async ({ patch }) => {
      const type = await createInboxType("Task", "☑️");
      const item = await createInboxItemOfType("Buy milk", type.id);
      let calls = 0;
      const compute: ComputeSemprecProposalFn = async () => {
        calls++;
        return { properties: { name: "Buy milk" } };
      };
      await runTick(pool, databaseIds, item.id, compute);
      expect(calls).toBe(1);

      await editInboxItem(item.id, patch);
      await runTick(pool, databaseIds, item.id, compute);

      expect(calls).toBe(2);
      const proposal = await findProposalForItem(pool, proposalsId, item.id);
      expect(proposal!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk", ...patch }));
    });

    it("adding an attachment to the item and then removing it each recomputes the proposal", async () => {
      const type = await createInboxType("Task", "☑️");
      const item = await createInboxItemOfType("Buy milk", type.id);
      let calls = 0;
      const compute: ComputeSemprecProposalFn = async () => {
        calls++;
        return { properties: { name: "Buy milk" } };
      };
      await runTick(pool, databaseIds, item.id, compute);
      expect(calls).toBe(1);

      const photo = await attachNewBlob(item.id, "photo");
      await runTick(pool, databaseIds, item.id, compute);
      expect(calls).toBe(2);
      const withPhoto = await findProposalForItem(pool, proposalsId, item.id);
      expect(withPhoto!.properties.fingerprint).toBe(
        fingerprintV2Of({ typeId: type.id, text: "Buy milk", attachmentHashes: [photo.contentHash] }),
      );

      await detachBlob(item.id, photo.blobId);
      await runTick(pool, databaseIds, item.id, compute);
      expect(calls).toBe(3);
      const withoutPhoto = await findProposalForItem(pool, proposalsId, item.id);
      expect(withoutPhoto!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk" }));
    });

    it("reordering the attachments of an item does not recompute the proposal", async () => {
      const type = await createInboxType("Task", "☑️");
      const item = await createInboxItemOfType("Buy milk", type.id);
      const first = await attachNewBlob(item.id, "first");
      const second = await attachNewBlob(item.id, "second");
      await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
      const before = await findProposalForItem(pool, proposalsId, item.id);

      // Attachments are ordered by position, so moving `first` behind `second` reverses the pair.
      await detachBlob(item.id, first.blobId);
      await insertInboxAttachments(pool, item.id, [{ blobId: first.blobId, source: "camera" }]);
      const attachments = await listInboxAttachments(pool, [item.id]);
      expect(attachments.map((row) => row.blobId)).toEqual([second.blobId, first.blobId]);

      await runTick(pool, databaseIds, item.id, async () => {
        throw new Error("computeProposal must not be called when only the attachment order changed");
      });

      const after = await findProposalForItem(pool, proposalsId, item.id);
      expect(after!.properties.fingerprint).toBe(before!.properties.fingerprint);
      expect(after!.updatedAt).toBe(before!.updatedAt);
    });

    it("uses legacy blob IDs for missing hashes on add, reorder and removal at an invoked tick", async () => {
      const type = await createInboxType("Task", "☑️");
      const item = await createInboxItemOfType("Buy milk", type.id);
      let calls = 0;
      const compute: ComputeSemprecProposalFn = async () => {
        calls++;
        return { properties: { name: "Buy milk" } };
      };
      await runTick(pool, databaseIds, item.id, compute);
      const first = await createBlob(pool, {
        mimeType: "image/jpeg",
        byteSize: 1,
        storageKey: `legacy/${randomUUID()}`,
      });
      const second = await createBlob(pool, {
        mimeType: "image/jpeg",
        byteSize: 1,
        storageKey: `legacy/${randomUUID()}`,
      });
      await insertInboxAttachments(pool, item.id, [
        { blobId: first.id, source: "camera" },
        { blobId: second.id, source: "camera" },
      ]);
      await runTick(pool, databaseIds, item.id, compute);
      expect(calls).toBe(2);
      const before = await findProposalForItem(pool, proposalsId, item.id);
      expect(before?.properties.fingerprint).toBe(
        fingerprintV2Of({ typeId: type.id, text: "Buy milk", attachmentHashes: [first.id, second.id] }),
      );
      await detachBlob(item.id, first.id);
      await insertInboxAttachments(pool, item.id, [{ blobId: first.id, source: "camera" }]);
      await runTick(pool, databaseIds, item.id, compute);
      expect(calls).toBe(2);
      expect((await findProposalForItem(pool, proposalsId, item.id))?.updatedAt).toBe(before?.updatedAt);
      await detachBlob(item.id, second.id);
      await runTick(pool, databaseIds, item.id, compute);
      expect(calls).toBe(3);
      expect((await findProposalForItem(pool, proposalsId, item.id))?.properties.fingerprint).toBe(
        fingerprintV2Of({ typeId: type.id, text: "Buy milk", attachmentHashes: [first.id] }),
      );
    });

    it("choosing another type that shares the emoji recomputes the proposal", async () => {
      const task = await createInboxType("Task", "☑️");
      const errand = await createInboxType("Errand", "☑️");
      const item = await createInboxItemOfType("Buy milk", task.id);
      let calls = 0;
      const compute: ComputeSemprecProposalFn = async () => {
        calls++;
        return { properties: { name: "Buy milk" } };
      };
      await runTick(pool, databaseIds, item.id, compute);
      const before = await findProposalForItem(pool, proposalsId, item.id);

      await withTransaction(pool, async (client) => {
        const typeProperty = await propertiesStore.getPropertyByKey(client, inboxId, "type");
        await deleteRelationWithClient(client, {
          relationPropertyId: typeProperty!.id,
          callerItemId: item.id,
          targetItemId: task.id,
        });
        await createRelationWithClient(client, {
          relationPropertyId: typeProperty!.id,
          callerItemId: item.id,
          targetItemId: errand.id,
        });
      });
      await runTick(pool, databaseIds, item.id, compute);

      expect(calls).toBe(2);
      const after = await findProposalForItem(pool, proposalsId, item.id);
      expect(after!.id).toBe(before!.id);
      expect(after!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: errand.id, text: "Buy milk" }));
      expect(after!.properties.fingerprint).not.toBe(before!.properties.fingerprint);
    });

    it("a version 1 card whose emoji and text are unchanged is not recomputed, even when its time changes", async () => {
      const type = await createInboxType("Task", "☑️");
      const item = await createInboxItemOfType("Buy milk", type.id);
      await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
      const created = await findProposalForItem(pool, proposalsId, item.id);
      await setProposalFingerprint(created!.id, legacyFingerprintOf("☑️", "Buy milk"));
      const legacyCard = await findProposalForItem(pool, proposalsId, item.id);

      await runTick(pool, databaseIds, item.id, async () => {
        throw new Error("computeProposal must not be called for an unchanged version 1 fingerprint");
      });

      await editInboxItem(item.id, { time: "10:30" });
      await runTick(pool, databaseIds, item.id, async () => {
        throw new Error("computeProposal must not be called when only the time of a version 1 card changed");
      });

      const after = await findProposalForItem(pool, proposalsId, item.id);
      expect(after!.properties.fingerprint).toBe(legacyFingerprintOf("☑️", "Buy milk"));
      expect(after!.updatedAt).toBe(legacyCard!.updatedAt);
    });

    it("a version 1 card whose text changed is recomputed and stored as a version 2 fingerprint", async () => {
      const type = await createInboxType("Task", "☑️");
      const item = await createInboxItemOfType("Buy milk", type.id);
      await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
      const created = await findProposalForItem(pool, proposalsId, item.id);
      await setProposalFingerprint(created!.id, legacyFingerprintOf("☑️", "Buy milk"));

      await editInboxItem(item.id, { text: "Buy bread" });
      let calls = 0;
      await runTick(pool, databaseIds, item.id, async () => {
        calls++;
        return { properties: { name: "Buy bread" } };
      });

      expect(calls).toBe(1);
      const revised = await findProposalForItem(pool, proposalsId, item.id);
      expect(revised!.id).toBe(created!.id);
      expect(revised!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy bread" }));
    });

    it("a version 1 card whose type emoji changed is recomputed and stored as a version 2 fingerprint", async () => {
      const type = await createInboxType("Task", "☑️");
      const item = await createInboxItemOfType("Buy milk", type.id);
      await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
      const created = await findProposalForItem(pool, proposalsId, item.id);
      await setProposalFingerprint(created!.id, legacyFingerprintOf("☑️", "Buy milk"));

      await withTransaction(pool, (client) =>
        itemsStore.updateItemProperties(client, {
          databaseId: typesId,
          itemId: type.id,
          propertiesPatch: { emoji: "📌" },
        }),
      );
      let calls = 0;
      await runTick(pool, databaseIds, item.id, async () => {
        calls++;
        return { properties: { name: "Buy milk" } };
      });

      expect(calls).toBe(1);
      const revised = await findProposalForItem(pool, proposalsId, item.id);
      expect(revised!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk" }));
    });
  });

  it.each(["confirmed", "rejected"] as const)(
    "a %s proposal is never modified by a later tick, even when the source changes",
    async (lockedStatus) => {
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
      await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
      const proposal = await findProposalForItem(pool, proposalsId, item.id);

      await withTransaction(pool, (client) =>
        itemsStore.updateItemProperties(client, {
          databaseId: proposalsId,
          itemId: proposal!.id,
          propertiesPatch: { status: lockedStatus },
        }),
      );
      await withTransaction(pool, (client) =>
        itemsStore.updateItemProperties(client, {
          databaseId: inboxId,
          itemId: item.id,
          propertiesPatch: { text: "Something totally different" },
        }),
      );

      await runTick(pool, databaseIds, item.id, async () => {
        throw new Error("computeProposal must not be called for a locked proposal");
      });

      const stillLocked = await findProposalForItem(pool, proposalsId, item.id);
      expect(stillLocked!.properties.status).toBe(lockedStatus);
      expect(stillLocked!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk" }));
    },
  );

  it("a soft-deleted existing proposal is treated as absent — a later tick creates a fresh one instead of throwing", async () => {
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
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    const original = await findProposalForItem(pool, proposalsId, item.id);
    await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, proposalsId, original!.id));

    // The relation edge to the now-deleted proposal is still there, so this must not throw
    // NotFoundError from trying to update a deleted item — it must fall through and create.
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk (retry)" } }));

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [proposalsId]);
    expect(rows[0].n).toBe(2);

    const stillDeleted = await itemsStore.getItemById(pool, proposalsId, original!.id);
    expect(stillDeleted!.deletedAt).not.toBeNull();

    // Now two `sourceInbox` edges exist for this item: one to the soft-deleted original, one
    // to the live replacement. A further tick must find the live one regardless of which edge
    // comes back first from the relation lookup — reviving it rather than creating a third row.
    await withTransaction(pool, (client) =>
      itemsStore.updateItemProperties(client, {
        databaseId: inboxId,
        itemId: item.id,
        propertiesPatch: { text: "Buy milk and eggs" },
      }),
    );
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk and eggs" } }));

    const { rows: afterThirdTick } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
      proposalsId,
    ]);
    expect(afterThirdTick[0].n).toBe(2);

    const { rows: liveRows } = await pool.query(
      "SELECT id, properties FROM items WHERE database_id = $1 AND deleted_at IS NULL",
      [proposalsId],
    );
    expect(liveRows).toHaveLength(1);
    expect(liveRows[0].properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk and eggs" }));
  });

  describe("a source split into several cards (issue #1939)", () => {
    async function createSplitSource(text: string) {
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
      return { type, item };
    }

    /** Every Processing proposals row as stored, so a test can prove a card was not written. */
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
    async function createSiblingCard(sourceId: string, primaryId: string, name: string): Promise<string> {
      const envelope: ProposalEnvelope = {
        entityKind: "database",
        target: await databaseIdFor("tasks"),
        properties: { name },
      };
      return withTransaction(pool, async (client) => {
        const sibling = await createItemWithClient(
          client,
          {
            databaseId: proposalsId,
            properties: {
              kind: "inbox",
              proposal: envelope,
              ...aiProposalPatch({}, envelope),
              history: [],
              status: "proposed",
              splitFromProposalId: primaryId,
            },
          },
          {
            allowedSystemKeys: [
              "kind",
              "proposal",
              "aiProposal",
              "aiVersion",
              "history",
              "status",
              "splitFromProposalId",
            ],
          },
        );
        await linkSourceInboxRelation(client, { processingProposalsDatabaseId: proposalsId }, sibling.id, sourceId);
        return sibling.id;
      });
    }

    async function editSource(itemId: string, text: string) {
      await withTransaction(pool, (client) =>
        itemsStore.updateItemProperties(client, {
          databaseId: inboxId,
          itemId,
          propertiesPatch: { text },
        }),
      );
    }

    it("recomputes only the primary card when the source text is edited, and makes no call while the source is unchanged", async () => {
      const { type, item } = await createSplitSource("Buy milk and renew the passport");
      await runTick(pool, databaseIds, item.id, async () => ({
        properties: { name: "Buy milk and renew the passport" },
      }));
      const primaryId = (await findProposalForItem(pool, proposalsId, item.id))!.id;
      const tasksId = await databaseIdFor("tasks");
      const { siblings } = await withTransaction(pool, (client) =>
        splitInboxSourceWithClient(
          client,
          { processingProposalsDatabaseId: proposalsId },
          {
            proposalId: primaryId,
            subjectItemId: item.id,
            threadId: randomUUID(),
            messageId: randomUUID(),
            cards: [
              { entityKind: "database", target: tasksId, properties: { name: "Buy milk" } },
              { entityKind: "database", target: tasksId, properties: { name: "Renew the passport" } },
              { entityKind: "database", target: tasksId, properties: { name: "Call mom" } },
            ],
          },
        ),
      );
      expect(siblings).toHaveLength(2);
      const afterSplit = await storedCards();
      expect(afterSplit.size).toBe(3);

      let calls = 0;
      const compute: ComputeSemprecProposalFn = async () => {
        calls++;
        return { properties: { name: "Buy milk and eggs" } };
      };
      await runTick(pool, databaseIds, item.id, compute);
      expect(calls).toBe(0);
      expect(await storedCards()).toEqual(afterSplit);

      await editSource(item.id, "Buy milk and eggs, renew the passport");
      await runTick(pool, databaseIds, item.id, compute);

      expect(calls).toBe(1);
      const afterEdit = await storedCards();
      expect(afterEdit.size).toBe(3);
      const primary = afterEdit.get(primaryId)!;
      expect(primary.properties.proposal).toEqual({
        entityKind: "database",
        target: tasksId,
        properties: { name: "Buy milk and eggs" },
      });
      expect(primary.properties.fingerprint).toBe(
        fingerprintV2Of({ typeId: type.id, text: "Buy milk and eggs, renew the passport" }),
      );
      for (const sibling of siblings) expect(afterEdit.get(sibling.id)).toEqual(afterSplit.get(sibling.id));
    });

    it("sees no sibling whichever edge comes first: it creates its own card beside the siblings of a source and later revises that one", async () => {
      const { type, item } = await createSplitSource("Buy milk");
      // The edges of both siblings exist before the tick's card has one, so a scan that took the first live card
      // of the source would take a sibling.
      const siblingIds = [
        await createSiblingCard(item.id, randomUUID(), "Sibling one"),
        await createSiblingCard(item.id, randomUUID(), "Sibling two"),
      ];
      const siblingsBefore = await storedCards();
      let calls = 0;
      const compute: ComputeSemprecProposalFn = async () => {
        calls++;
        return { properties: { name: "Buy milk" } };
      };

      await runTick(pool, databaseIds, item.id, compute);

      expect(calls).toBe(1);
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

      await editSource(item.id, "Buy milk and eggs");
      await runTick(pool, databaseIds, item.id, compute);

      expect(calls).toBe(2);
      const revised = await storedCards();
      expect(revised.size).toBe(3);
      expect(revised.get(primaryId)!.properties.fingerprint).toBe(
        fingerprintV2Of({ typeId: type.id, text: "Buy milk and eggs" }),
      );
      for (const id of siblingIds) expect(revised.get(id)).toEqual(siblingsBefore.get(id));
    });
  });

  it("an item with no type is marked needsClarification, not silently skipped (issue #104)", async () => {
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text: "no type",
      }),
    );

    await runTick(pool, databaseIds, item.id, async () => {
      return { properties: {}, candidates: [] };
    });

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal).toBeTruthy();
    expect(proposal!.properties.status).toBe("needsClarification");
    expect(proposal!.properties.proposal).toBeNull();
    expect(proposal!.properties.history).toHaveLength(1);
    expect((proposal!.properties.history as Array<Record<string, unknown>>)[0]).toMatchObject({ author: "ai" });
  });

  it("a repeated tick on the same untyped item stays needsClarification without a second history entry", async () => {
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text: "no type",
      }),
    );

    const throwing: ComputeSemprecProposalFn = async () => {
      return { properties: {}, candidates: [] };
    };
    await runTick(pool, databaseIds, item.id, throwing);
    await runTick(pool, databaseIds, item.id, throwing);

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties.status).toBe("needsClarification");
    expect(proposal!.properties.history).toHaveLength(1);
  });

  it("never writes a row into any database other than processingProposals", async () => {
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

    const tasksDbId = await databaseIdFor("tasks");
    const { rows: before } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
      tasksDbId,
    ]);

    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));

    const { rows: after } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
      tasksDbId,
    ]);
    expect(after[0].n).toBe(before[0].n);
  });
});

describe("semprec.tick needsClarification, invalid, history, and envelope validation (issue #104)", () => {
  let inboxId: string;
  let typesId: string;
  let proposalsId: string;
  let databaseIds: TickDatabaseIds;

  beforeEach(async () => {
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
  });

  async function createTypedItem(text: string) {
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
    return { type, item };
  }

  it("validates an uncreated Inbox type edge without locking a placeholder source", async () => {
    const { type } = await createTypedItem("Type validation fixture");
    const property = await withTransaction(pool, (client) => propertiesStore.getPropertyByKey(client, inboxId, "type"));
    if (!property) throw new Error("Missing Inbox type property");
    const statements: string[] = [];
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      await withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
        const observed = new Proxy(client, {
          get(target, key, receiver) {
            if (key !== "query") {
              const value: unknown = Reflect.get(target, key, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            }
            return (...args: unknown[]) => {
              if (typeof args[0] === "string") statements.push(args[0]);
              return Reflect.apply(target.query.bind(target), undefined, args);
            };
          },
        });
        await assertRelationTargetLinkableWithClient(observed, {
          relationPropertyId: property.id,
          targetItemId: type.id,
        });
      });
    } finally {
      await runtime.end();
    }
    expect(statements.some((sql) => sql.includes("FOR UPDATE OF i"))).toBe(false);
  });

  it("a source whose type was deleted out from under it is marked needsClarification, the same path as no type at all", async () => {
    const { type, item } = await createTypedItem("Buy milk");

    await withTransaction(pool, (client) =>
      deleteInboxTypeWithClient(client, {
        inboxDatabaseId: inboxId,
        inboxItemTypesDatabaseId: typesId,
        processingProposalsDatabaseId: proposalsId,
        typeItemId: type.id,
      }),
    );

    await runTick(pool, databaseIds, item.id, async () => {
      return { properties: {}, candidates: [] };
    });

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: "", text: "Buy milk" }));
    expect(proposal!.properties.status).toBe("needsClarification");
    expect(proposal!.properties.proposal).toBeNull();
    expect(proposal!.properties.history).toHaveLength(1);
  });

  it("an item that gains a recognized type after needsClarification transitions to proposed on the next tick", async () => {
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text: "Buy milk",
      }),
    );

    await runTick(pool, databaseIds, item.id, async () => {
      return { properties: {}, candidates: [] };
    });
    const needsClarification = await findProposalForItem(pool, proposalsId, item.id);
    expect(needsClarification!.properties.status).toBe("needsClarification");
    expect(needsClarification!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: "", text: "Buy milk" }));

    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Task",
        emoji: "☑️",
        processingMethod: "database",
        targetDatabase: "tasks",
      }),
    );
    await withTransaction(pool, async (client) => {
      const typeProperty = await propertiesStore.getPropertyByKey(client, inboxId, "type");
      await createRelationWithClient(client, {
        relationPropertyId: typeProperty!.id,
        callerItemId: item.id,
        targetItemId: type.id,
      });
    });

    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));

    const proposed = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposed!.id).toBe(needsClarification!.id);
    expect(proposed!.properties.status).toBe("proposed");
    expect(proposed!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk" }));
    expect(proposed!.properties.proposal).toEqual({
      entityKind: "database",
      target: await databaseIdFor("tasks"),
      properties: { name: "Buy milk" },
    });
    expect(proposed!.properties.history).toHaveLength(2);
  });

  it("deleting a source item invalidates its unlocked proposal", async () => {
    const { item } = await createTypedItem("Buy milk");
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    const proposed = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposed!.properties.status).toBe("proposed");

    await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, item.id));
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called for a deleted source");
    });

    const invalidated = await findProposalForItem(pool, proposalsId, item.id);
    expect(invalidated!.id).toBe(proposed!.id);
    expect(invalidated!.properties.status).toBe("invalid");
    expect(invalidated!.properties.history).toHaveLength(2);
    expect((invalidated!.properties.history as Array<Record<string, unknown>>)[1]).toMatchObject({
      author: "ai",
      kind: "invalidated",
    });
    expect(invalidated!.properties.invalidReason).toEqual({
      code: "sourceDeleted",
      field: "",
      itemId: item.id,
      label: "Buy milk",
    });
  });

  it("a deleted source's reason label is its trimmed first line, cut by code point to 80 characters", async () => {
    // Emoji are two UTF-16 units each: a cut by unit would split one at the 79th position.
    const longFirstLine = `  ${"🙂".repeat(120)}  `;
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
        text: `${longFirstLine}\nsecond line`,
        type: type.id,
      }),
    );
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Long" } }));
    await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, item.id));
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called for a deleted source");
    });

    const invalidated = await findProposalForItem(pool, proposalsId, item.id);
    const reason = invalidated!.properties.invalidReason as { label: string };
    expect(reason.label).toBe(`${"🙂".repeat(79)}…`);
  });

  it("a confirmed proposal keeps its status when its source item is deleted", async () => {
    const { item } = await createTypedItem("Buy milk");
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    await withTransaction(pool, (client) =>
      itemsStore.updateItemProperties(client, {
        databaseId: proposalsId,
        itemId: proposal!.id,
        propertiesPatch: { status: "confirmed" },
      }),
    );

    await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, item.id));
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called for a deleted source");
    });

    const stillConfirmed = await findProposalForItem(pool, proposalsId, item.id);
    expect(stillConfirmed!.properties.status).toBe("confirmed");
  });

  it("a rejected proposal keeps its status when its source item is deleted", async () => {
    const { item } = await createTypedItem("Buy milk");
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    await withTransaction(pool, (client) =>
      itemsStore.updateItemProperties(client, {
        databaseId: proposalsId,
        itemId: proposal!.id,
        propertiesPatch: { status: "rejected" },
      }),
    );
    const historyLengthBeforeDelete = (proposal!.properties.history as unknown[]).length;

    await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, item.id));
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called for a deleted source");
    });

    const stillRejected = await findProposalForItem(pool, proposalsId, item.id);
    expect(stillRejected!.properties.status).toBe("rejected");
    expect((stillRejected!.properties.history as unknown[]).length).toBe(historyLengthBeforeDelete);
  });

  it("deleting a source with no proposal at all is a harmless no-op", async () => {
    const { item } = await createTypedItem("Buy milk");
    await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, item.id));

    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called for a deleted source");
    });

    expect(await findProposalForItem(pool, proposalsId, item.id)).toBeNull();
  });

  // Restoring a source returns its `sourceDeleted` card (issue #1604). Each test trashes and restores with the
  // store calls, so the tick runs explicitly here; the heartbeat that runs it is covered in inboxTick.test.ts.
  async function trashSource(itemId: string): Promise<void> {
    await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, itemId));
  }

  async function restoreSource(itemId: string): Promise<void> {
    await withTransaction(pool, (client) => itemsStore.restoreItem(client, inboxId, itemId));
  }

  it.each(["confirmed", "rejected"] as const)(
    "leaves a %s card unchanged when its source is restored",
    async (status) => {
      const { item } = await createTypedItem("Buy milk");
      await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
      const proposal = await findProposalForItem(pool, proposalsId, item.id);
      if (!proposal) throw new Error("Expected proposal");
      await withTransaction(pool, (client) =>
        itemsStore.updateItemProperties(client, {
          databaseId: proposalsId,
          itemId: proposal.id,
          propertiesPatch: { status },
        }),
      );
      const chokePoint = createChokePoint(pool);
      await runInTenant(getTenantZeroId(), () => chokePoint.softDeleteItem(inboxId, item.id));
      await runTick(pool, databaseIds, item.id, async () => {
        throw new Error("computeProposal must not run for a deleted source");
      });
      const beforeRestore = await findProposalForItem(pool, proposalsId, item.id);
      expect(beforeRestore?.properties.status).toBe(status);
      await runInTenant(getTenantZeroId(), () => chokePoint.restoreItem(inboxId, item.id));
      await runTick(pool, databaseIds, item.id, async () => {
        throw new Error("computeProposal must not run for a locked card");
      });
      expect(await findProposalForItem(pool, proposalsId, item.id)).toEqual(beforeRestore);
    },
  );

  it("restoring an unchanged source returns its invalid card to proposed with no reason and no recompute", async () => {
    const { item } = await createTypedItem("Buy milk");
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    const proposed = await findProposalForItem(pool, proposalsId, item.id);

    await trashSource(item.id);
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called for a deleted source");
    });
    await restoreSource(item.id);
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called when the source fingerprint is unchanged");
    });

    const reopened = await findProposalForItem(pool, proposalsId, item.id);
    expect(reopened!.id).toBe(proposed!.id);
    expect(reopened!.properties.status).toBe("proposed");
    expect(reopened!.properties.invalidReason).toBeNull();
    expect(reopened!.properties.proposal).toEqual(proposed!.properties.proposal);
    expect(reopened!.properties.history).toHaveLength(3);
    expect((reopened!.properties.history as Array<Record<string, unknown>>)[2]).toMatchObject({
      author: "ai",
      kind: "reopened",
    });
  });

  it("a source whose text changed before it was trashed is recomputed when it is restored", async () => {
    const { type, item } = await createTypedItem("Buy milk");
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    await withTransaction(pool, (client) =>
      itemsStore.updateItemProperties(client, {
        databaseId: inboxId,
        itemId: item.id,
        propertiesPatch: { text: "Buy milk and eggs" },
      }),
    );
    await trashSource(item.id);
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called for a deleted source");
    });
    await restoreSource(item.id);

    const computedFor: unknown[] = [];
    await runTick(pool, databaseIds, item.id, async (input) => {
      computedFor.push(input.sourceItem.properties.text);
      return { properties: { name: "Buy milk and eggs" } };
    });

    expect(computedFor).toEqual(["Buy milk and eggs"]);
    const recomputed = await findProposalForItem(pool, proposalsId, item.id);
    expect(recomputed!.properties.status).toBe("proposed");
    expect(recomputed!.properties.invalidReason).toBeNull();
    expect(recomputed!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk and eggs" }));
    expect(recomputed!.properties.proposal).toEqual({
      entityKind: "database",
      target: await databaseIdFor("tasks"),
      properties: { name: "Buy milk and eggs" },
    });
  });

  it("a historical text change while trashed is recomputed when the source is restored", async () => {
    const { type, item } = await createTypedItem("Buy milk");
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    const chokePoint = createChokePoint(pool);
    await runInTenant(getTenantZeroId(), () => chokePoint.softDeleteItem(inboxId, item.id));
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called for a deleted source");
    });
    // Historical persisted state only: the supported writer refuses edits to trashed items.
    const changed = await pool.query(
      `UPDATE items SET properties = jsonb_set(properties, '{text}', to_jsonb($1::text))
       WHERE tenant_id = $2 AND database_id = $3 AND id = $4 AND deleted_at IS NOT NULL`,
      ["Buy milk and eggs", getTenantZeroId(), inboxId, item.id],
    );
    expect(changed.rowCount).toBe(1);
    await runInTenant(getTenantZeroId(), () => chokePoint.restoreItem(inboxId, item.id));

    const computedFor: unknown[] = [];
    await runTick(pool, databaseIds, item.id, async (input) => {
      computedFor.push(input.sourceItem.properties.text);
      return { properties: { name: "Buy milk and eggs" } };
    });

    expect(computedFor).toEqual(["Buy milk and eggs"]);
    const recomputed = await findProposalForItem(pool, proposalsId, item.id);
    expect(recomputed!.properties.status).toBe("proposed");
    expect(recomputed!.properties.invalidReason).toBeNull();
    expect(recomputed!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk and eggs" }));
    expect(recomputed!.properties.proposal).toEqual({
      entityKind: "database",
      target: await databaseIdFor("tasks"),
      properties: { name: "Buy milk and eggs" },
    });
  });

  it("a restored card whose stored envelope no longer validates goes to needsClarification, keeping its fingerprint", async () => {
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
        text: "A thought",
        type: type.id,
      }),
    );
    // Any existing item is a valid page target until it is trashed, so the envelope's page can go missing.
    const page = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text: "The page",
      }),
    );
    await runTick(pool, databaseIds, item.id, async () => ({
      target: page.id,
      properties: { flavour: "paragraph", fields: { content: "A thought" } },
    }));
    const proposed = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposed!.properties.status).toBe("proposed");

    await trashSource(item.id);
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called for a deleted source");
    });
    await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, page.id));
    await restoreSource(item.id);
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called when the source fingerprint is unchanged");
    });

    const card = await findProposalForItem(pool, proposalsId, item.id);
    expect(card!.properties).toMatchObject({
      status: "needsClarification",
      proposal: null,
      aiProposal: null,
      aiVersion: 2,
      invalidReason: null,
      fingerprint: proposed!.properties.fingerprint,
    });
  });

  it("reopens a restored card as needsClarification when a relation target became occupied", async () => {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Project",
        emoji: "📁",
        processingMethod: "database",
        targetDatabase: "projects",
      }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text: "Create project",
        type: type.id,
      }),
    );
    const api = createChokePoint(pool);
    const projectsId = await databaseIdFor("projects");
    const tasksId = await databaseIdFor("tasks");
    const task = await api.createItem({ databaseId: tasksId, properties: { name: "Task" } });
    await runTick(pool, databaseIds, item.id, async () => ({
      properties: { name: "Project" },
      relations: { tasks: [task.id] },
    }));
    const proposed = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposed?.properties.status).toBe("proposed");
    await trashSource(item.id);
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("Deleted source must not be computed");
    });
    const other = await api.createItem({ databaseId: projectsId, properties: { name: "Other" } });
    const property = await withTransaction(pool, (client) =>
      propertiesStore.getPropertyByKey(client, projectsId, "tasks"),
    );
    if (!property) throw new Error("Missing Projects.tasks relation");
    await api.createRelation({ relationPropertyId: property.id, callerItemId: other.id, targetItemId: task.id });
    await restoreSource(item.id);
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("Unchanged source must not be recomputed");
    });
    const restored = await findProposalForItem(pool, proposalsId, item.id);
    expect(restored?.properties).toMatchObject({
      status: "needsClarification",
      proposal: null,
      invalidReason: null,
      fingerprint: proposed?.properties.fingerprint,
    });
    expect(await api.listItemRelations(other.id, property.id)).toMatchObject([{ targetItemId: task.id }]);
  });

  it("a restored source with no recognized type makes its invalid card needsClarification with no reason", async () => {
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text: "Buy milk",
      }),
    );
    await runTick(pool, databaseIds, item.id, async () => {
      return { properties: {}, candidates: [] };
    });

    await trashSource(item.id);
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called for a deleted source");
    });
    expect((await findProposalForItem(pool, proposalsId, item.id))!.properties.invalidReason).toMatchObject({
      code: "sourceDeleted",
    });

    await restoreSource(item.id);
    await runTick(pool, databaseIds, item.id, async () => {
      return { properties: {}, candidates: [] };
    });

    const card = await findProposalForItem(pool, proposalsId, item.id);
    expect(card!.properties).toMatchObject({ status: "needsClarification", invalidReason: null });
    expect(card!.properties.history).toHaveLength(3);
  });

  it.each(["targetArchived", "targetDeleted", "legacy", "otherSource"] as const)(
    "source deletion supersedes %s invalidity and repeated deletion is a no-op",
    async (kind) => {
      const { item } = await createTypedItem("Buy milk");
      await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
      const proposed = await findProposalForItem(pool, proposalsId, item.id);
      const reason = {
        code: kind === "legacy" ? "targetArchived" : kind === "otherSource" ? "sourceDeleted" : kind,
        field: "target",
        itemId: await databaseIdFor("tasks"),
        label: "Tasks",
      };
      await withTransaction(pool, (client) =>
        itemsStore.updateItemProperties(client, {
          databaseId: proposalsId,
          itemId: proposed!.id,
          propertiesPatch: { status: "invalid", ...(kind === "legacy" ? {} : { invalidReason: reason }) },
        }),
      );
      const before = await findProposalForItem(pool, proposalsId, item.id);

      await trashSource(item.id);
      await runTick(pool, databaseIds, item.id, async () => {
        throw new Error("computeProposal must not be called for a deleted source");
      });
      const deleted = await findProposalForItem(pool, proposalsId, item.id);
      expect(deleted?.properties.status).toBe("invalid");
      expect(deleted!.properties.invalidReason).toEqual({
        code: "sourceDeleted",
        field: "",
        itemId: item.id,
        label: "Buy milk",
      });
      const previousHistory = before?.properties.history;
      const history = deleted?.properties.history;
      if (!Array.isArray(previousHistory) || !Array.isArray(history)) throw new Error("expected proposal history");
      expect(history).toHaveLength(previousHistory.length + 1);
      expect(history.at(-1)).toMatchObject({ author: "ai", kind: "invalidated" });
      await runTick(pool, databaseIds, item.id, async () => {
        throw new Error("computeProposal must not be called for a deleted source");
      });
      expect(await findProposalForItem(pool, proposalsId, item.id)).toEqual(deleted);
      await restoreSource(item.id);
      await runTick(pool, databaseIds, item.id, async () => {
        throw new Error("computeProposal must not be called when the source fingerprint is unchanged");
      });

      const after = await findProposalForItem(pool, proposalsId, item.id);
      expect(after!.properties.status).toBe("proposed");
      expect(after!.properties.invalidReason).toBeNull();
      expect(after!.properties.proposal).toEqual(proposed!.properties.proposal);
    },
  );

  it("a restore tick leaves targetArchived unchanged when no deletion transition occurred", async () => {
    const { item } = await createTypedItem("Buy milk");
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    const proposed = await findProposalForItem(pool, proposalsId, item.id);
    const reason = { code: "targetArchived", field: "target", itemId: await databaseIdFor("tasks"), label: "Tasks" };
    await withTransaction(pool, (client) =>
      itemsStore.updateItemProperties(client, {
        databaseId: proposalsId,
        itemId: proposed!.id,
        propertiesPatch: { status: "invalid", invalidReason: reason },
      }),
    );
    const before = await findProposalForItem(pool, proposalsId, item.id);
    await trashSource(item.id);
    await restoreSource(item.id);
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("unchanged source must not recompute");
    });
    expect(await findProposalForItem(pool, proposalsId, item.id)).toEqual(before);
  });

  it.each(["confirmed", "rejected"] as const)(
    "a %s card keeps its status and history when its source is deleted and restored",
    async (status) => {
      const { item } = await createTypedItem("Buy milk");
      await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
      const proposal = await findProposalForItem(pool, proposalsId, item.id);
      await withTransaction(pool, (client) =>
        itemsStore.updateItemProperties(client, {
          databaseId: proposalsId,
          itemId: proposal!.id,
          propertiesPatch: { status },
        }),
      );
      const before = await findProposalForItem(pool, proposalsId, item.id);

      await trashSource(item.id);
      await runTick(pool, databaseIds, item.id, async () => {
        throw new Error("computeProposal must not be called for a deleted source");
      });
      await restoreSource(item.id);
      await runTick(pool, databaseIds, item.id, async () => {
        throw new Error("computeProposal must not be called for a locked card");
      });

      const after = await findProposalForItem(pool, proposalsId, item.id);
      expect(after!.properties).toEqual(before!.properties);
    },
  );

  it("a proposed envelope naming an unknown property on the target database fails validation and is stored as needsClarification, never as proposed", async () => {
    const { item } = await createTypedItem("Buy milk");

    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk", notAKey: "x" } }));

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties.status).toBe("needsClarification");
    expect(proposal!.properties.proposal).toBeNull();
    expect(proposal!.properties.history).toHaveLength(1);

    const { rows: taskRows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
      await databaseIdFor("tasks"),
    ]);
    expect(taskRows[0].n).toBe(0);
  });

  it("a proposed envelope trying to set a relation property directly fails validation", async () => {
    const { item } = await createTypedItem("Buy milk");

    await runTick(pool, databaseIds, item.id, async () => ({
      properties: { name: "Buy milk", project: "some-project-id" },
    }));

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties.status).toBe("needsClarification");
  });

  it("a pageContent envelope whose target is not an existing item fails validation", async () => {
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
        text: "A thought",
        type: type.id,
      }),
    );

    await runTick(pool, databaseIds, item.id, async () => ({
      target: "00000000-0000-0000-0000-000000000000",
      properties: { flavour: "paragraph" },
    }));

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties.status).toBe("needsClarification");
  });

  it("a pageContent envelope missing block content (flavour) fails validation", async () => {
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
        text: "A thought",
        type: type.id,
      }),
    );

    await runTick(pool, databaseIds, item.id, async () => ({
      target: type.id,
      properties: { note: "no flavour here" },
    }));

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties.status).toBe("needsClarification");
  });

  it("a pageContent envelope whose 'fields' is not a plain object fails validation (issue #105 review fix)", async () => {
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
        text: "A thought",
        type: type.id,
      }),
    );

    await runTick(pool, databaseIds, item.id, async () => ({
      target: type.id,
      properties: { flavour: "paragraph", fields: "not an object" },
    }));

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties.status).toBe("needsClarification");
  });

  it("a pageContent envelope whose 'children' is not an array of strings fails validation (issue #105 review fix)", async () => {
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
        text: "A thought",
        type: type.id,
      }),
    );

    await runTick(pool, databaseIds, item.id, async () => ({
      target: type.id,
      properties: { flavour: "paragraph", children: [1, 2, 3] },
    }));

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties.status).toBe("needsClarification");
  });

  it("a repeated tick with the same invalid envelope does not call computeProposal again", async () => {
    const { item } = await createTypedItem("Buy milk");

    let calls = 0;
    const compute: ComputeSemprecProposalFn = async () => {
      calls++;
      return { properties: { notAKey: "x" } };
    };
    await runTick(pool, databaseIds, item.id, compute);
    await runTick(pool, databaseIds, item.id, compute);
    expect(calls).toBe(1);

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties.status).toBe("needsClarification");
    expect(proposal!.properties.history).toHaveLength(1);
  });
});

describe("semprec.tick re-checks the proposal under lock before writing it (issue #662)", () => {
  let inboxId: string;
  let typesId: string;
  let proposalsId: string;
  let databaseIds: TickDatabaseIds;

  beforeEach(async () => {
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
  });

  /** A typed Inbox item with one `proposed` card, then a text edit so the next tick recomputes it. */
  async function seedProposedCardWithChangedSource() {
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
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL",
      [proposalsId],
    );
    const card = await withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, rows[0]!.id));
    expect(card!.properties.status).toBe("proposed");

    await withTransaction(pool, (client) =>
      itemsStore.updateItemProperties(client, {
        databaseId: inboxId,
        itemId: item.id,
        propertiesPatch: { text: "Buy milk and eggs" },
      }),
    );
    return { item, card: card! };
  }

  async function readCard(cardId: string) {
    return withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, cardId));
  }

  /**
   * Wraps `pool` so that `beforeLock` runs, and commits on its own connection, right before the
   * tick's first `SELECT ... FOR UPDATE` on `cardId` — the gap between the tick's unlocked
   * snapshot of the card and its locked re-check, on paths that call no `computeProposal`.
   */
  function poolRunningBeforeCardLock(cardId: string, beforeLock: () => Promise<void>): Pool {
    let fired = false;
    return new Proxy(pool, {
      get(t, prop, receiver) {
        if (prop === "connect") {
          return async (...args: unknown[]) => {
            const client = await (t.connect as (...a: unknown[]) => Promise<PoolClient>)(...args);
            return new Proxy(client, {
              get(clientTarget, clientProp, clientReceiver) {
                if (clientProp === "query") {
                  return async (...queryArgs: unknown[]) => {
                    const [text, params] = queryArgs as [unknown, unknown];
                    if (
                      !fired &&
                      typeof text === "string" &&
                      text.includes("FOR UPDATE") &&
                      Array.isArray(params) &&
                      params.includes(cardId)
                    ) {
                      fired = true;
                      await beforeLock();
                    }
                    return (clientTarget.query as (...a: unknown[]) => unknown)(...queryArgs);
                  };
                }
                return Reflect.get(clientTarget, clientProp, clientReceiver);
              },
            });
          };
        }
        return Reflect.get(t, prop, receiver);
      },
    });
  }

  async function rejectCard(cardId: string): Promise<string> {
    const rejected = await withTransaction(pool, (client) =>
      itemsStore.updateItemProperties(client, {
        databaseId: proposalsId,
        itemId: cardId,
        propertiesPatch: { status: "rejected" },
      }),
    );
    return rejected.updatedAt;
  }

  async function softDeleteCard(cardId: string): Promise<string> {
    const deleted = await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, proposalsId, cardId));
    return deleted!.updatedAt;
  }

  async function softDeleteSource(itemId: string): Promise<void> {
    await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, itemId));
  }

  /** A computed envelope naming a property the `tasks` database lacks, so the tick lands in `needsClarification`. */
  const invalidEnvelope = { properties: { noSuchProperty: "x" } };

  it("needsClarification path: a reject committed while the tick computes its proposal wins — the card stays rejected and untouched", async () => {
    const { item, card } = await seedProposedCardWithChangedSource();

    let rejectedVersion: string | undefined;
    await runTick(pool, databaseIds, item.id, async () => {
      rejectedVersion = await rejectCard(card.id);
      return invalidEnvelope;
    });

    const after = await readCard(card.id);
    expect(after!.updatedAt).toBe(rejectedVersion);
    expect(after!.properties).toEqual({ ...card.properties, status: "rejected" });
  });

  it("needsClarification path: a card soft-deleted while the tick computes its proposal is skipped without writing or throwing", async () => {
    const { item, card } = await seedProposedCardWithChangedSource();

    let deletedVersion: string | undefined;
    await runTick(pool, databaseIds, item.id, async () => {
      deletedVersion = await softDeleteCard(card.id);
      return invalidEnvelope;
    });

    const after = await readCard(card.id);
    expect(after!.deletedAt).not.toBeNull();
    expect(after!.updatedAt).toBe(deletedVersion);
    expect(after!.properties).toEqual(card.properties);
  });

  it("deleted-source path: a reject committed before the tick locks the card wins — the card is not invalidated", async () => {
    const { item, card } = await seedProposedCardWithChangedSource();
    await softDeleteSource(item.id);

    let rejectedVersion: string | undefined;
    const tickPool = poolRunningBeforeCardLock(card.id, async () => {
      rejectedVersion = await rejectCard(card.id);
    });
    await runTick(tickPool, databaseIds, item.id, async () =>
      expect.unreachable("a deleted source is never recomputed"),
    );

    expect(rejectedVersion).toBeDefined();
    const after = await readCard(card.id);
    expect(after!.updatedAt).toBe(rejectedVersion);
    expect(after!.properties).toEqual({ ...card.properties, status: "rejected" });
  });

  it("restored-source path: a reject committed before the tick locks the card wins — the card is not reopened (issue #1604)", async () => {
    const { item, card } = await seedProposedCardWithChangedSource();
    await softDeleteSource(item.id);
    await runTick(pool, databaseIds, item.id, async () => expect.unreachable("a deleted source is never recomputed"));
    await withTransaction(pool, (client) => itemsStore.restoreItem(client, inboxId, item.id));
    const invalid = await readCard(card.id);
    expect(invalid!.properties.status).toBe("invalid");

    let rejectedVersion: string | undefined;
    const tickPool = poolRunningBeforeCardLock(card.id, async () => {
      rejectedVersion = await rejectCard(card.id);
    });
    await runTick(tickPool, databaseIds, item.id, async () =>
      expect.unreachable("a card that lost the lock is not recomputed"),
    );

    expect(rejectedVersion).toBeDefined();
    const after = await readCard(card.id);
    expect(after!.updatedAt).toBe(rejectedVersion);
    expect(after!.properties).toEqual({ ...invalid!.properties, status: "rejected" });
  });

  it("deleted-source path: a card soft-deleted before the tick locks it is skipped without writing or throwing", async () => {
    const { item, card } = await seedProposedCardWithChangedSource();
    await softDeleteSource(item.id);

    let deletedVersion: string | undefined;
    const tickPool = poolRunningBeforeCardLock(card.id, async () => {
      deletedVersion = await softDeleteCard(card.id);
    });
    await runTick(tickPool, databaseIds, item.id, async () =>
      expect.unreachable("a deleted source is never recomputed"),
    );

    expect(deletedVersion).toBeDefined();
    const after = await readCard(card.id);
    expect(after!.deletedAt).not.toBeNull();
    expect(after!.updatedAt).toBe(deletedVersion);
    expect(after!.properties).toEqual(card.properties);
  });

  it("deleted-source path: a lock failure other than a serialization conflict propagates and writes nothing", async () => {
    const { item, card } = await seedProposedCardWithChangedSource();
    await softDeleteSource(item.id);

    const tickPool = poolRunningBeforeCardLock(card.id, async () => {
      throw new Error("connection lost while locking the card");
    });
    await expect(
      runTick(tickPool, databaseIds, item.id, async () => expect.unreachable("a deleted source is never recomputed")),
    ).rejects.toThrow("connection lost while locking the card");

    const after = await readCard(card.id);
    expect(after!.updatedAt).toBe(card.updatedAt);
    expect(after!.properties).toEqual(card.properties);
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

    let calls = 0;
    await runTick(pool, databaseIds, item.id, async () => {
      calls++;
      await withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, card.id),
      );
      return { properties: { name: "Buy milk and eggs" } };
    });
    expect(calls).toBe(1);

    const after = await readCard(card.id);
    expect(after!.properties.status).toBe("confirmed");
    expect(after!.properties.proposal).toEqual(card.properties.proposal);
    expect(after!.properties.fingerprint).toBe(card.properties.fingerprint);
    const messages = (after!.properties.history as Array<{ message: string }>).map((entry) => entry.message);
    expect(messages).not.toContain("Revised the proposal after the source item changed.");
  });

  it("a card soft-deleted while the tick computes its proposal is skipped without writing or throwing", async () => {
    const { item, card } = await seedProposedCardWithChangedSource();

    let deletedVersion: string | undefined;
    await runTick(pool, databaseIds, item.id, async () => {
      const deleted = await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, proposalsId, card.id));
      deletedVersion = deleted!.updatedAt;
      return { properties: { name: "Buy milk and eggs" } };
    });

    const after = await readCard(card.id);
    expect(after!.deletedAt).not.toBeNull();
    expect(after!.updatedAt).toBe(deletedVersion);
    expect(after!.properties).toEqual(card.properties);
    const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
      proposalsId,
    ]);
    expect(rows[0]!.n).toBe(1);
  });
});

describe("semprec.tick brackets computeProposal outside any transaction (issue #676)", () => {
  let inboxId: string;
  let typesId: string;
  let proposalsId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    inboxId = await databaseIdFor("inbox");
    typesId = await databaseIdFor("inboxItemTypes");
    proposalsId = await databaseIdFor("processingProposals");
  });

  async function createTypedItem(text: string) {
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
    return { type, item };
  }

  it("holds no transaction and no pooled connection during the computeProposal call", async () => {
    const { item } = await createTypedItem("Buy milk");

    // A dedicated single-connection pool: if the tick still held its transaction's one
    // connection open across `computeProposal`, this query — issued from inside the fake
    // while it runs — would have no connection to acquire and would never resolve.
    const tickPool = getTestPool({ max: 1 });
    try {
      const handler = createSemprecTickAction(tickPool, async (input) => {
        await Promise.race([
          tickPool.query("SELECT 1"),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("computeProposal: no free pooled connection")), 2000),
          ),
        ]);
        expect(input.entityKind).toBe("database");
        return { properties: { name: "Buy milk" } };
      });
      await handler(
        { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
        { heartbeatId: "hb", projectItemId: "proj", itemId: item.id },
      );
    } finally {
      await tickPool.end();
    }

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal).toBeTruthy();
    expect(proposal!.properties.status).toBe("proposed");
  }, 10000);

  it("writes nothing for a stale envelope when the source changes during computeProposal, and the next tick produces the card for the new fingerprint", async () => {
    const { type, item } = await createTypedItem("Buy milk");

    const handler = createSemprecTickAction(pool, async () => {
      await withTransaction(pool, (client) =>
        itemsStore.updateItemProperties(client, {
          databaseId: inboxId,
          itemId: item.id,
          propertiesPatch: { text: "Buy milk and eggs" },
        }),
      );
      return { properties: { name: "Buy milk" } };
    });
    await handler(
      { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
      { heartbeatId: "hb", projectItemId: "proj", itemId: item.id },
    );

    expect(await findProposalForItem(pool, proposalsId, item.id)).toBeNull();

    let calls = 0;
    const handlerAgain = createSemprecTickAction(pool, async () => {
      calls++;
      return { properties: { name: "Buy milk and eggs" } };
    });
    await handlerAgain(
      { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
      { heartbeatId: "hb", projectItemId: "proj", itemId: item.id },
    );
    expect(calls).toBe(1);

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal).toBeTruthy();
    expect(proposal!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk and eggs" }));
    expect(proposal!.properties.proposal).toEqual({
      entityKind: "database",
      target: await databaseIdFor("tasks"),
      properties: { name: "Buy milk and eggs" },
    });
  });

  it.each([undefined, { marker: "late" }])(
    "retains a late participant failure and consumes only the asserted participant %#",
    async (late) => {
      const { item } = await createTypedItem("Tracked overlap");
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
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
      let holderPid: number | undefined;
      let competitorPid: number | undefined;
      let competitorError: { value: unknown } | undefined;
      let competitorStarted = () => {};
      const competing = new Promise<void>((resolve) => {
        competitorStarted = resolve;
      });
      let failure: { error: unknown } | undefined;
      try {
        const negative = owned.run(() =>
          withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
            await client.query<{ "?column?": number }>("SELECT 1");
            rethrowOverlap(expected);
          }),
        );
        await expect(negative).rejects.toBe(expected);
        owned.consume(negative, expected);
        const participant = owned.run(() =>
          withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
            const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
            if (!pid) throw new Error("Missing owned PID");
            holderPid = pid;
            await updateItemWithClient(client, {
              databaseId: inboxId,
              itemId: item.id,
              propertiesPatch: { text: "Held" },
            });
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
        const competitor = owned.run(() =>
          withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
            competitorPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
            competitorStarted();
            await updateItemWithClient(client, {
              databaseId: inboxId,
              itemId: item.id,
              propertiesPatch: { text: "Competing" },
            });
          }),
        );
        void competitor.catch((error: unknown) => {
          competitorError = { value: error };
        });
        await owned.wait(competing, participant, competitor);
        if (!holderPid || !competitorPid) throw new Error("Missing participant PID");
        await owned.wait(
          owned.run(() =>
            expect
              .poll(
                async () => {
                  const rows = await pool.query<{ blocked: boolean }>(
                    "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
                    [holderPid, competitorPid],
                  );
                  return rows.rows[0]?.blocked;
                },
                { timeout: 5000 },
              )
              .toBe(true),
          ),
          participant,
          competitor,
        );
        try {
          throw body;
        } catch (error) {
          failure = { error };
        }
        release();
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
      expect(competitorError).toBeUndefined();
      expect(lateSettled).toBe(true);
      expect(runtime.ended).toBe(true);
      expect(runtime.totalCount).toBe(0);
      expect(runtime.listenerCount("acquire")).toBe(0);
      expect(runtime.listenerCount("release")).toBe(0);
    },
    20000,
  );

  it("settles ownership when the first participant has the wrong rejection", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
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
        withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
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
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
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
      if (onError) client.removeListener("error", onError);
      observing.delete(client);
      generations.delete(client);
    };
    runtime.on("acquire", observeAcquire);
    runtime.on("release", observeRelease);
    let failure: { error: unknown } | undefined;
    try {
      const actor = owned.run(() => withTenantTransaction(runtime, getTenantZeroId(), async () => {}));
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
    runtime.removeListener("acquire", observeAcquire);
    runtime.removeListener("release", observeRelease);
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
      rethrowOverlap(
        cleanupFailure === undefined ? bodyFailure.error : combineOverlapFailure(bodyFailure, cleanupFailure).error,
      );
    expect(cleanupFailure).toMatchObject({ message: "Overlap cleanup failed" });
    expect(runtime.ended).toBe(true);
    expect(runtime.totalCount).toBe(0);
    expect(runtime.listenerCount("acquire")).toBe(0);
    expect(runtime.listenerCount("release")).toBe(0);
  }, 20000);

  it("settles late overlap checkout and preserves a simultaneous cleanup failure", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let deliver = () => {};
    let ready = () => {};
    const verifying = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const bodyError = new Error("body failure");
    const cleanupError = new Error("cleanup failure");
    let ran = false;
    let settled = false;
    let checkoutGeneration: object | undefined;
    runtime.options.verify = (client, done) => {
      checkoutGeneration = generations.get(client);
      deliver = () => queueMicrotask(() => done());
      ready();
    };
    const generations = new Map<PoolClient, object>();
    const cancellationRequests = new Set<object>();
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
    );
    const operation = owned.run(() =>
      withTenantTransaction(runtime, getTenantZeroId(), async () => {
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
    runtime.removeListener("acquire", observeAcquire);
    runtime.removeListener("release", observeRelease);
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
    expect(isOwnedPgClosure(new Error("unrelated post-cancel failure"), "Client was closed and is not queryable")).toBe(
      false,
    );
    for (const diagnostic of observedDiagnostics) {
      expect(diagnostic.cancelled).toBe(true);
      expect(diagnostic.operation).toBe("checkout");
      expect(diagnostic.error).toBe(operationFailure.value);
    }
    const expectedErrors = [cleanupError, ...observedDiagnostics.map((entry) => entry.error), operationFailure.value];
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
  }, 20000);

  it("holds the source through the proposal commit before a competing edit", async () => {
    const { item } = await createTypedItem("Before the race");
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let postModel = false;
    let resume = () => {};
    let reached = () => {};
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const atFingerprint = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let tickPid: number | undefined;
    const observedPool = new Proxy(runtime, {
      get(target, property, receiver) {
        if (property !== "connect") {
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(connection, key, innerReceiver) {
              if (key !== "query") {
                const value: unknown = Reflect.get(connection, key, innerReceiver);
                return typeof value === "function" ? value.bind(connection) : value;
              }
              return async (...args: unknown[]) => {
                const result: unknown = await Reflect.apply(connection.query.bind(connection), undefined, args);
                const sql = typeof args[0] === "string" ? args[0] : "";
                if (postModel && sql.includes("COALESCE(b.content_hash")) {
                  postModel = false;
                  const pid = await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
                  tickPid = pid.rows[0]?.pid;
                  reached();
                  await gate;
                }
                return result;
              };
            },
          });
        };
      },
    });
    const handler = createSemprecTickAction(observedPool, async () => {
      postModel = true;
      return { properties: { name: "Old proposal" } };
    });
    let writer: Promise<void> | undefined;
    let writerPid: number | undefined;
    let writerStarted = () => {};
    let writerUpdated = () => {};
    let releaseWriter = () => {};
    const started = new Promise<void>((resolve) => {
      writerStarted = resolve;
    });
    const updated = new Promise<void>((resolve) => {
      writerUpdated = resolve;
    });
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const owned = ownOverlap(runtime, () => {
      resume();
      releaseWriter();
      writerStarted();
      writerUpdated();
      reached();
    });
    const tick = owned.run(() =>
      runInTenant(getTenantZeroId(), () =>
        handler(
          { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
          { heartbeatId: "hb", projectItemId: "proj", itemId: item.id },
        ),
      ),
    );
    tick.catch(() => {});
    let failure: { error: unknown } | undefined;
    try {
      await owned.wait(atFingerprint, tick);
      expect(tickPid).toBeGreaterThan(0);
      writer = owned.run(() =>
        withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
          writerPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
          writerStarted();
          await updateItemWithClient(client, {
            databaseId: inboxId,
            itemId: item.id,
            propertiesPatch: { text: "After the race" },
          });
          writerUpdated();
          await writerGate;
        }),
      );
      writer.catch(() => {});
      await owned.wait(started, writer, tick);
      expect(writerPid).toBeGreaterThan(0);
      expect(writerPid).not.toBe(tickPid);
      let blocked = false;
      for (let n = 0; n < 100 && !blocked; n++) {
        const result = await owned.wait(
          owned.run(() =>
            runInTenant(getTenantZeroId(), () =>
              runtime.query<{ blocked: boolean }>("SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked", [
                tickPid,
                writerPid,
              ]),
            ),
          ),
          writer,
          tick,
        );
        blocked = result.rows[0]?.blocked === true;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      resume();
      await tick;
      await owned.wait(updated, writer);
      const card = await boundedBarrier(
        owned.run(() => runInTenant(getTenantZeroId(), () => findProposalForItem(runtime, proposalsId, item.id))),
      );
      expect(card?.properties.proposal).toMatchObject({ properties: { name: "Old proposal" } });
      releaseWriter();
      await writer;
    } catch (error) {
      failure = { error };
    } finally {
      resume();
      releaseWriter();
      try {
        await owned.finish(failure !== undefined);
      } catch (error) {
        failure = combineOverlapFailure(failure, error);
      }
    }
    if (failure !== undefined) rethrowOverlap(failure.error);
    const source = await withTransaction(pool, (client) => itemsStore.getItemById(client, inboxId, item.id));
    expect(source?.properties.text).toBe("After the race");
  }, 20000);

  it.each([false, true])(
    "rechecks fresh source data after a competing edit, rollback: %s",
    async (rollback) => {
      const { item } = await createTypedItem("Before the edit");
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      let releaseWriter = () => {};
      let writerReady = () => {};
      let tickWaiting = () => {};
      const writerGate = new Promise<void>((resolve) => {
        releaseWriter = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        writerReady = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        tickWaiting = resolve;
      });
      let writerPid: number | undefined;
      let tickPid: number | undefined;
      let postModel = false;
      const rollbackMarker = new Error("intentional edit rollback");
      const owned = ownOverlap(runtime, () => {
        releaseWriter();
        writerReady();
        tickWaiting();
      });
      const observedPool = new Proxy(runtime, {
        get(target, property, receiver) {
          if (property !== "connect") {
            const value: unknown = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async () => {
            const client = await target.connect();
            return new Proxy(client, {
              get(connection, key, innerReceiver) {
                if (key !== "query") {
                  const value: unknown = Reflect.get(connection, key, innerReceiver);
                  return typeof value === "function" ? value.bind(connection) : value;
                }
                return async (...args: unknown[]) => {
                  const sql = typeof args[0] === "string" ? args[0] : "";
                  if (postModel && sql.includes("FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE")) {
                    postModel = false;
                    tickPid = (await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
                    tickWaiting();
                  }
                  return Reflect.apply(connection.query.bind(connection), undefined, args);
                };
              },
            });
          };
        },
      });
      const writer = owned.run(() =>
        withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
          writerPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
          await updateItemWithClient(client, {
            databaseId: inboxId,
            itemId: item.id,
            propertiesPatch: { text: "After the edit" },
          });
          writerReady();
          await writerGate;
          if (rollback) throw rollbackMarker;
        }),
      );
      const writerOutcome = writer.then(
        () => null,
        (error: unknown) => error,
      );
      let tick: Promise<void> | undefined;
      let failure: { error: unknown } | undefined;
      try {
        await owned.wait(ready, writer);
        const handler = createSemprecTickAction(observedPool, async () => {
          postModel = true;
          return { properties: { name: "Old proposal" } };
        });
        tick = owned.run(() =>
          runInTenant(getTenantZeroId(), () =>
            handler(
              {
                inboxDatabaseId: inboxId,
                inboxItemTypesDatabaseId: typesId,
                processingProposalsDatabaseId: proposalsId,
              },
              { heartbeatId: "hb", projectItemId: "proj", itemId: item.id },
            ),
          ),
        );
        tick.catch(() => {});
        await owned.wait(waiting, writer, tick);
        let blocked = false;
        for (let n = 0; n < 100 && !blocked; n++) {
          const result = await owned.wait(
            owned.run(() =>
              runInTenant(getTenantZeroId(), () =>
                runtime.query<{ blocked: boolean }>("SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked", [
                  writerPid,
                  tickPid,
                ]),
              ),
            ),
            writer,
            tick,
          );
          blocked = result.rows[0]?.blocked === true;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(writerPid).not.toBe(tickPid);
        expect(blocked).toBe(true);
        releaseWriter();
        expect(await writerOutcome).toBe(rollback ? rollbackMarker : null);
        if (rollback) owned.consume(writer, rollbackMarker);
        await tick;
        const card = await boundedBarrier(
          owned.run(() => runInTenant(getTenantZeroId(), () => findProposalForItem(runtime, proposalsId, item.id))),
        );
        if (rollback) expect(card?.properties.proposal).toMatchObject({ properties: { name: "Old proposal" } });
        else expect(card).toBeNull();
      } catch (error) {
        failure = { error };
      } finally {
        releaseWriter();
        try {
          await owned.finish(failure !== undefined);
        } catch (error) {
          failure = combineOverlapFailure(failure, error);
        }
      }
      if (failure !== undefined) rethrowOverlap(failure.error);
    },
    20000,
  );

  it.each(["insert attachment", "remove attachment", "change type"] as const)(
    "serializes %s with tick in both acquisition orders",
    async (mutation) => {
      for (const writerFirst of [true, false]) {
        const { item, type } = await createTypedItem(`Source ${mutation} ${writerFirst}`);
        const blob = await createBlob(pool, { mimeType: "image/jpeg", byteSize: 3, storageKey: `t/${randomUUID()}` });
        let attachmentId: string | undefined;
        let insertedAttachmentId: string | undefined;
        if (mutation === "remove attachment") {
          await insertInboxAttachments(pool, item.id, [{ blobId: blob.id, source: "camera" }]);
          attachmentId = (await listInboxAttachments(pool, [item.id]))[0]?.attachmentId;
          if (!attachmentId) throw new Error("Missing attachment");
        }
        const alternate = await withTransaction(pool, (client) =>
          createInboxTypeWithClient(client, {
            inboxItemTypesDatabaseId: typesId,
            name: `Alternate ${randomUUID()}`,
            emoji: "🔵",
            processingMethod: "database",
            targetDatabase: "tasks",
          }),
        );
        const property = await withTransaction(pool, (client) =>
          propertiesStore.getPropertyByKey(client, inboxId, "type"),
        );
        if (!property) throw new Error("Missing Inbox type property");
        const runtime = await createRuntimeRolePool(pool, "semprec_data");
        // Since issue #1718 a type edge write queues the day's recompute under the key the tick's read phase
        // enqueues too, so a tick that starts after such a writer waits for it there, before it calls the model.
        const typeWriterFirst = writerFirst && mutation === "change type";
        const modelTypeIds: Array<string | null> = [];
        let postModel = false;
        let tickPid: number | undefined;
        let writerPid: number | undefined;
        let releaseTick = () => {};
        let releaseWriter = () => {};
        let tickReady = () => {};
        let writerReady = () => {};
        let writerDone = () => {};
        let startMutation = () => {};
        const tickGate = new Promise<void>((resolve) => {
          releaseTick = resolve;
        });
        const writerGate = new Promise<void>((resolve) => {
          releaseWriter = resolve;
        });
        const tickAtBoundary = new Promise<void>((resolve) => {
          tickReady = resolve;
        });
        const writerAtBoundary = new Promise<void>((resolve) => {
          writerReady = resolve;
        });
        const writerMutated = new Promise<void>((resolve) => {
          writerDone = resolve;
        });
        const mutationGate = new Promise<void>((resolve) => {
          startMutation = resolve;
        });
        const owned = ownOverlap(runtime, () => {
          releaseTick();
          releaseWriter();
          startMutation();
          tickReady();
          writerReady();
          writerDone();
        });
        const observed = new Proxy(runtime, {
          get(target, propertyKey, receiver) {
            if (propertyKey !== "connect") {
              const value: unknown = Reflect.get(target, propertyKey, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            }
            return async () => {
              const client = await target.connect();
              return new Proxy(client, {
                get(connection, key, innerReceiver) {
                  if (key !== "query") {
                    const value: unknown = Reflect.get(connection, key, innerReceiver);
                    return typeof value === "function" ? value.bind(connection) : value;
                  }
                  return async (...args: unknown[]) => {
                    const sql = typeof args[0] === "string" ? args[0] : "";
                    if (typeWriterFirst && tickPid === undefined && sql.includes("graphile_worker.add_job")) {
                      tickPid = (await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
                        ?.pid;
                      tickReady();
                    }
                    if (
                      postModel &&
                      writerFirst &&
                      sql.includes("FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE")
                    ) {
                      postModel = false;
                      tickPid = (await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
                        ?.pid;
                      tickReady();
                    }
                    const result: unknown = await Reflect.apply(connection.query.bind(connection), undefined, args);
                    if (postModel && !writerFirst && sql.includes("COALESCE(b.content_hash")) {
                      postModel = false;
                      tickPid = (await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
                        ?.pid;
                      tickReady();
                      await tickGate;
                    }
                    return result;
                  };
                },
              });
            };
          },
        });
        const mutate = (client: PoolClient) => {
          if (mutation === "insert attachment")
            return insertWithClient(client, item.id, [{ blobId: blob.id, source: "camera" }]);
          if (mutation === "remove attachment") return deleteWithClient(client, z.uuid().parse(attachmentId));
          return (async () => {
            await deleteRelationWithClient(client, {
              relationPropertyId: property.id,
              callerItemId: item.id,
              targetItemId: type.id,
            });
            await createRelationWithClient(client, {
              relationPropertyId: property.id,
              callerItemId: item.id,
              targetItemId: alternate.id,
            });
          })();
        };
        const writer = owned.run(() =>
          withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
            await client.query("SET LOCAL statement_timeout = '5s'");
            writerPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
            if (!writerFirst) {
              writerReady();
              await mutationGate;
            }
            await mutate(client);
            if (mutation === "insert attachment") {
              const inserted = await listInboxAttachments(client, [item.id]);
              if (inserted.length !== 1 || !inserted[0]) throw new Error("Missing inserted attachment");
              insertedAttachmentId = inserted[0].attachmentId;
            }
            writerDone();
            if (writerFirst) writerReady();
            await writerGate;
          }),
        );
        writer.catch(() => {});
        let tick: Promise<void> | undefined;
        let failure: { error: unknown } | undefined;
        try {
          if (writerFirst) await owned.wait(writerAtBoundary, writer);
          const handler = createSemprecTickAction(observed, async (input) => {
            postModel = true;
            modelTypeIds.push(input.type?.id ?? null);
            return { properties: { name: "Old proposal" } };
          });
          tick = owned.run(() =>
            runInTenant(getTenantZeroId(), () =>
              handler(
                {
                  inboxDatabaseId: inboxId,
                  inboxItemTypesDatabaseId: typesId,
                  processingProposalsDatabaseId: proposalsId,
                },
                { heartbeatId: "hb", projectItemId: "proj", itemId: item.id },
              ),
            ),
          );
          tick.catch(() => {});
          await owned.wait(tickAtBoundary, writer, tick);
          if (!writerFirst) {
            await owned.wait(writerAtBoundary, writer, tick);
            startMutation();
          }
          let blocked = false;
          for (let n = 0; n < 100 && !blocked; n++) {
            const holder = writerFirst ? writerPid : tickPid;
            const competitor = writerFirst ? tickPid : writerPid;
            const result = await owned.wait(
              owned.run(() =>
                runInTenant(getTenantZeroId(), () =>
                  runtime.query<{ blocked: boolean }>("SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked", [
                    holder,
                    competitor,
                  ]),
                ),
              ),
              writer,
              tick,
            );
            blocked = result.rows[0]?.blocked === true;
            if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
          }
          expect(tickPid).toBeGreaterThan(0);
          expect(writerPid).toBeGreaterThan(0);
          expect(tickPid).not.toBe(writerPid);
          expect(blocked).toBe(true);
          if (writerFirst) {
            releaseWriter();
            await writer;
            await tick;
            const card = await boundedBarrier(
              owned.run(() => runInTenant(getTenantZeroId(), () => findProposalForItem(runtime, proposalsId, item.id))),
            );
            if (typeWriterFirst) {
              // The tick waited in its read phase, so it asked the model about the committed type and stored the answer.
              expect(modelTypeIds).toEqual([alternate.id]);
              expect(card?.properties.status).toBe("proposed");
            } else {
              expect(card).toBeNull();
            }
          } else {
            releaseTick();
            await tick;
            await owned.wait(writerMutated, writer);
            expect(
              (
                await boundedBarrier(
                  owned.run(() =>
                    runInTenant(getTenantZeroId(), () => findProposalForItem(runtime, proposalsId, item.id)),
                  ),
                )
              )?.properties.proposal,
            ).toMatchObject({
              properties: { name: "Old proposal" },
            });
            releaseWriter();
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
                const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property.id);
                if (!definition) throw new Error("Missing type definition");
                return relationsStore.listRelationsForItem(client, definition.id, item.id);
              }),
            ),
          );
          expect(edges.map((edge) => relationsStore.otherSide(edge, item.id))).toEqual([
            mutation === "change type" ? alternate.id : type.id,
          ]);
        } catch (error) {
          failure = { error };
        } finally {
          releaseTick();
          releaseWriter();
          startMutation();
          try {
            await owned.finish(failure !== undefined);
          } catch (error) {
            failure = combineOverlapFailure(failure, error);
          }
        }
        if (failure !== undefined) rethrowOverlap(failure.error);
      }
    },
    30000,
  );

  it("skips a busy proposal card without creating another card", async () => {
    const { item } = await createTypedItem("Original");
    const config = {
      inboxDatabaseId: inboxId,
      inboxItemTypesDatabaseId: typesId,
      processingProposalsDatabaseId: proposalsId,
    };
    const context = { heartbeatId: "hb", projectItemId: "proj", itemId: item.id };
    await createSemprecTickAction(pool, async () => ({ properties: { name: "Original" } }))(config, context);
    const original = await findProposalForItem(pool, proposalsId, item.id);
    if (!original) throw new Error("Missing proposal");
    await withTransaction(pool, (client) =>
      updateItemWithClient(client, {
        databaseId: inboxId,
        itemId: item.id,
        propertiesPatch: { text: "Changed" },
      }),
    );
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let release = () => {};
    let locked = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const owned = ownOverlap(runtime, release);
    const holder = owned.run(() =>
      withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
        await itemsStore.lockItemById(client, proposalsId, original.id);
        locked();
        await gate;
      }),
    );
    let failure: { error: unknown } | undefined;
    try {
      await owned.wait(ready, holder);
      const tick = owned.run(() =>
        runInTenant(getTenantZeroId(), () =>
          createSemprecTickAction(runtime, async () => ({ properties: { name: "Changed" } }))(config, context),
        ),
      );
      await owned.wait(tick, holder);
      const current = await findProposalForItem(pool, proposalsId, item.id);
      expect(current?.id).toBe(original.id);
      expect(current?.properties).toEqual(original.properties);
      const count = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM items WHERE database_id = $1 AND deleted_at IS NULL",
        [proposalsId],
      );
      expect(count.rows[0]?.count).toBe(1);
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
  }, 20000);

  it.each(["delete", "restore"] as const)(
    "skips a busy raw type during its %s transaction",
    async (operation) => {
      const { item, type } = await createTypedItem(`Type ${operation}`);
      const setup = createChokePoint(pool);
      if (operation === "restore") await setup.softDeleteItem(typesId, type.id);
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      let release = () => {};
      let atCommit = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        atCommit = resolve;
      });
      const observed = new Proxy(runtime, {
        get(target, key, receiver) {
          if (key !== "connect") {
            const value: unknown = Reflect.get(target, key, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async () => {
            const client = await target.connect();
            return new Proxy(client, {
              get(connection, prop, innerReceiver) {
                if (prop !== "query") {
                  const value: unknown = Reflect.get(connection, prop, innerReceiver);
                  return typeof value === "function" ? value.bind(connection) : value;
                }
                return async (...args: unknown[]) => {
                  if (typeof args[0] === "string" && args[0].trim().toUpperCase() === "COMMIT") {
                    atCommit();
                    await gate;
                  }
                  return Reflect.apply(connection.query.bind(connection), undefined, args);
                };
              },
            });
          };
        },
      });
      const owned = ownOverlap(runtime, release);
      const writer = owned.run(() =>
        runInTenant(getTenantZeroId(), () => {
          const cp = createChokePoint(observed);
          return operation === "delete" ? cp.softDeleteItem(typesId, type.id) : cp.restoreItem(typesId, type.id);
        }),
      );
      let failure: { error: unknown } | undefined;
      try {
        await owned.wait(ready, writer);
        const tick = owned.run(() =>
          runInTenant(getTenantZeroId(), () =>
            createSemprecTickAction(runtime, async () => ({ properties: { name: "Old" } }))(
              {
                inboxDatabaseId: inboxId,
                inboxItemTypesDatabaseId: typesId,
                processingProposalsDatabaseId: proposalsId,
              },
              { heartbeatId: "hb", projectItemId: "proj", itemId: item.id },
            ),
          ),
        );
        await owned.wait(tick, writer);
        expect(await findProposalForItem(pool, proposalsId, item.id)).toBeNull();
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
    },
    20000,
  );

  it("allows distinct sources sharing a type to form proposals concurrently", async () => {
    const { item, type } = await createTypedItem("First source");
    const other = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text: "Second source",
        type: type.id,
      }),
    );
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let release = () => {};
    let reached = () => {};
    let postModel = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const observed = new Proxy(runtime, {
      get(target, key, receiver) {
        if (key !== "connect") {
          const value: unknown = Reflect.get(target, key, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(connection, prop, innerReceiver) {
              if (prop !== "query") {
                const value: unknown = Reflect.get(connection, prop, innerReceiver);
                return typeof value === "function" ? value.bind(connection) : value;
              }
              return async (...args: unknown[]) => {
                const result: unknown = await Reflect.apply(connection.query.bind(connection), undefined, args);
                if (postModel && typeof args[0] === "string" && args[0].includes("COALESCE(b.content_hash")) {
                  postModel = false;
                  reached();
                  await gate;
                }
                return result;
              };
            },
          });
        };
      },
    });
    const config = {
      inboxDatabaseId: inboxId,
      inboxItemTypesDatabaseId: typesId,
      processingProposalsDatabaseId: proposalsId,
    };
    const owned = ownOverlap(runtime, release);
    const first = owned.run(() =>
      runInTenant(getTenantZeroId(), () =>
        createSemprecTickAction(observed, async () => {
          postModel = true;
          return { properties: { name: "First" } };
        })(config, { heartbeatId: "hb-a", projectItemId: "proj", itemId: item.id }),
      ),
    );
    let failure: { error: unknown } | undefined;
    try {
      await owned.wait(ready, first);
      const second = owned.run(() =>
        runInTenant(getTenantZeroId(), () =>
          createSemprecTickAction(runtime, async () => ({ properties: { name: "Second" } }))(config, {
            heartbeatId: "hb-b",
            projectItemId: "proj",
            itemId: other.id,
          }),
        ),
      );
      await owned.wait(second, first);
      expect((await findProposalForItem(pool, proposalsId, other.id))?.properties.status).toBe("proposed");
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
    expect((await findProposalForItem(pool, proposalsId, item.id))?.properties.status).toBe("proposed");
  }, 20000);

  it("a proposal created by a second tick while the first is still in computeProposal is revised, not duplicated (issue #792 review fix)", async () => {
    const { item } = await createTypedItem("Buy milk");

    // Neither tick sees the other's proposal in its read snapshot: A's snapshot read happens
    // before B runs to completion inside A's computeProposal, and B's own snapshot read happens
    // while A hasn't written anything yet. So both reach `writeTickResult` believing
    // `snapshot.existingProposal` is null — the exact race `raceProposal` exists to catch.
    const handlerA = createSemprecTickAction(pool, async () => {
      const handlerB = createSemprecTickAction(pool, async () => ({ properties: { name: "Buy milk (from B)" } }));
      await handlerB(
        { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
        { heartbeatId: "hb-b", projectItemId: "proj", itemId: item.id },
      );
      return { properties: { name: "Buy milk (from A)" } };
    });
    await handlerA(
      { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
      { heartbeatId: "hb-a", projectItemId: "proj", itemId: item.id },
    );

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [proposalsId]);
    expect(rows[0].n).toBe(1);

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties.status).toBe("proposed");
    expect(proposal!.properties.proposal).toEqual({
      entityKind: "database",
      target: await databaseIdFor("tasks"),
      properties: { name: "Buy milk (from A)" },
    });
    expect(proposal!.properties.history).toHaveLength(2);
  });
});

describe("semprec.tick records a failed proposal computation on the card (issue #1485)", () => {
  let inboxId: string;
  let typesId: string;
  let proposalsId: string;
  let databaseIds: TickDatabaseIds;

  beforeEach(async () => {
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
  });

  /** A typed Inbox item (a 'database' type targeting `tasks`) with the text `Buy milk`. */
  async function createTypedItem(): Promise<{ itemId: string; typeId: string }> {
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
    return { itemId: item.id, typeId: type.id };
  }

  /** One attempt of the tick with a stubbed computation; `isFinalAttempt` is what the heartbeat fire task passes. */
  function attempt(itemId: string, computeProposal: ComputeSemprecProposalFn, isFinalAttempt: boolean): Promise<void> {
    return createSemprecTickAction(pool, computeProposal)(databaseIds, {
      heartbeatId: "hb",
      projectItemId: "proj",
      itemId,
      isFinalAttempt,
    });
  }

  /** A computation that fails with the gateway's own error for `reason`. */
  function failingWith(reason: AiGatewayFailureReason): ComputeSemprecProposalFn {
    return async () => {
      throw new AiGatewayFailedError(reason);
    };
  }

  /** A concurrent source edit: the text changes, so the source's fingerprint no longer matches the snapshot. */
  async function editSourceText(itemId: string, text: string): Promise<void> {
    await withTransaction(pool, (client) =>
      itemsStore.updateItemProperties(client, { databaseId: inboxId, itemId, propertiesPatch: { text } }),
    );
  }

  it("a budget rejection creates a computeFailed card naming the reason, and the tick does not throw", async () => {
    const { itemId } = await createTypedItem();

    let calls = 0;
    await expect(
      attempt(
        itemId,
        async () => {
          calls++;
          throw new AiGatewayFailedError("budget_exceeded");
        },
        false,
      ),
    ).resolves.toBeUndefined();
    expect(calls).toBe(1);

    const card = await findProposalForItem(pool, proposalsId, itemId);
    expect(card).toBeTruthy();
    expect(card!.properties.status).toBe("computeFailed");
    expect(card!.properties.fingerprint ?? null).toBeNull();
    expect(card!.properties.proposal ?? null).toBeNull();
    expect(card!.properties.history).toEqual([
      expect.objectContaining({ author: "ai", message: "Computing the proposal failed: budget_exceeded." }),
    ]);
  });

  it.each(["timeout", "http", "invalid_response"] as const)(
    "a %s failure on a non-final attempt rethrows so the queue retries, and writes no card",
    async (reason) => {
      const { itemId } = await createTypedItem();

      await expect(attempt(itemId, failingWith(reason), false)).rejects.toThrow(`AI gateway call failed: ${reason}`);
      expect(await findProposalForItem(pool, proposalsId, itemId)).toBeNull();
    },
  );

  it.each(["timeout", "http", "invalid_response"] as const)(
    "a %s failure on the final attempt records the card and does not throw",
    async (reason) => {
      const { itemId } = await createTypedItem();

      await expect(attempt(itemId, failingWith(reason), true)).resolves.toBeUndefined();

      const card = await findProposalForItem(pool, proposalsId, itemId);
      expect(card!.properties.status).toBe("computeFailed");
      expect(card!.properties.history).toEqual([
        expect.objectContaining({ author: "ai", message: `Computing the proposal failed: ${reason}.` }),
      ]);
    },
  );

  it("retains the gateway failure and recording failure when the card write fails", async () => {
    const { itemId } = await createTypedItem();
    const gatewayError = new AiGatewayFailedError("budget_exceeded");
    // A fixed test trigger forces the card INSERT to fail after the model error; no user input enters DDL.
    await pool.query(`CREATE FUNCTION test_fail_compute_card() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test card write failure'; END $$`);
    const failures: unknown[] = [];
    try {
      await pool.query(
        "CREATE TRIGGER test_fail_compute_card BEFORE INSERT ON items FOR EACH ROW EXECUTE FUNCTION test_fail_compute_card()",
      );
      let received: unknown;
      try {
        await attempt(
          itemId,
          async () => {
            throw gatewayError;
          },
          false,
        );
      } catch (error) {
        received = error;
      }
      expect(received).toBeInstanceOf(AggregateError);
      if (!(received instanceof AggregateError)) throw new Error("Expected both failures");
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
    expect(await findProposalForItem(pool, proposalsId, itemId)).toBeNull();
  });

  it("an error that is not a gateway failure propagates even on the final attempt, and writes nothing", async () => {
    const { itemId } = await createTypedItem();

    await expect(
      attempt(
        itemId,
        async () => {
          throw new Error("the answer did not match the schema");
        },
        true,
      ),
    ).rejects.toThrow("the answer did not match the schema");
    expect(await findProposalForItem(pool, proposalsId, itemId)).toBeNull();
  });

  it("an item edited while the failing call is in flight writes no card, even on the final attempt", async () => {
    const { itemId } = await createTypedItem();

    await expect(
      attempt(
        itemId,
        async () => {
          await editSourceText(itemId, "Buy milk and eggs");
          throw new AiGatewayFailedError("timeout");
        },
        true,
      ),
    ).resolves.toBeUndefined();
    expect(await findProposalForItem(pool, proposalsId, itemId)).toBeNull();
  });

  it("an item deleted while the failing call is in flight writes no card", async () => {
    const { itemId } = await createTypedItem();

    await expect(
      attempt(
        itemId,
        async () => {
          await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, itemId));
          throw new AiGatewayFailedError("timeout");
        },
        true,
      ),
    ).resolves.toBeUndefined();
    expect(await findProposalForItem(pool, proposalsId, itemId)).toBeNull();
  });

  it.each(["confirmed", "rejected"] as const)(
    "a card that became %s while the failing call was in flight stays untouched",
    async (lockedStatus) => {
      const { itemId } = await createTypedItem();
      await attempt(itemId, async () => ({ properties: { name: "Buy milk" } }), false);
      const proposed = (await findProposalForItem(pool, proposalsId, itemId))!;
      expect(proposed.properties.status).toBe("proposed");
      await editSourceText(itemId, "Buy milk and eggs");

      await expect(
        attempt(
          itemId,
          async () => {
            await withTransaction(pool, (client) =>
              itemsStore.updateItemProperties(client, {
                databaseId: proposalsId,
                itemId: proposed.id,
                propertiesPatch: { status: lockedStatus },
              }),
            );
            throw new AiGatewayFailedError("timeout");
          },
          true,
        ),
      ).resolves.toBeUndefined();

      const after = await findProposalForItem(pool, proposalsId, itemId);
      expect(after!.properties.status).toBe(lockedStatus);
      expect(after!.properties.history).toEqual(proposed.properties.history);
    },
  );

  it("a card that already exists keeps its proposal and gains the failure entry", async () => {
    const { itemId } = await createTypedItem();
    await attempt(itemId, async () => ({ properties: { name: "Buy milk" } }), false);
    const proposed = (await findProposalForItem(pool, proposalsId, itemId))!;
    await editSourceText(itemId, "Buy milk and eggs");

    await attempt(itemId, failingWith("timeout"), true);

    const card = (await findProposalForItem(pool, proposalsId, itemId))!;
    expect(card.id).toBe(proposed.id);
    expect(card.properties.status).toBe("computeFailed");
    expect(card.properties.fingerprint ?? null).toBeNull();
    expect(card.properties.proposal).toEqual(proposed.properties.proposal);
    expect(card.properties.history).toEqual([
      ...(proposed.properties.history as unknown[]),
      expect.objectContaining({ author: "ai", message: "Computing the proposal failed: timeout." }),
    ]);
  });

  it("the next successful tick after a failure makes the card proposed with a fresh fingerprint", async () => {
    const { itemId, typeId } = await createTypedItem();
    await attempt(itemId, failingWith("budget_exceeded"), false);

    // The source did not change, but a null fingerprint is never current, so the tick computes again.
    let calls = 0;
    await attempt(
      itemId,
      async () => {
        calls++;
        return { properties: { name: "Buy milk" } };
      },
      false,
    );
    expect(calls).toBe(1);

    const card = await findProposalForItem(pool, proposalsId, itemId);
    expect(card!.properties.status).toBe("proposed");
    expect(card!.properties.fingerprint).toBe(fingerprintV2Of({ typeId, text: "Buy milk" }));
    expect(card!.properties.proposal).toEqual({
      entityKind: "database",
      target: await databaseIdFor("tasks"),
      properties: { name: "Buy milk" },
    });
  });
});

describe("assertValidProposalEnvelope resolves the target database row (issue #735)", () => {
  let typesId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    typesId = await databaseIdFor("inboxItemTypes");
  });

  it("resolves to the target database row for a valid 'database' envelope", async () => {
    const tasksDbId = await databaseIdFor("tasks");

    const targetDatabase = await withTransaction(pool, (client) =>
      assertValidProposalEnvelope(client, {
        entityKind: "database",
        target: tasksDbId,
        properties: { name: "Buy milk" },
      }),
    );

    expect(targetDatabase).not.toBeNull();
    expect(targetDatabase!.id).toBe(tasksDbId);
  });

  it("resolves to null for a valid 'pageContent' envelope", async () => {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Thought",
        emoji: "💭",
        processingMethod: "pageContent",
      }),
    );

    const targetDatabase = await withTransaction(pool, (client) =>
      assertValidProposalEnvelope(client, {
        entityKind: "pageContent",
        target: type.id,
        properties: { flavour: "paragraph" },
      }),
    );

    expect(targetDatabase).toBeNull();
  });
});

describe("assertValidProposalEnvelope validates envelope relations (issue #1426)", () => {
  let tasksDbId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    tasksDbId = await databaseIdFor("tasks");
  });

  async function createProject(properties: Record<string, unknown>): Promise<string> {
    const projectsId = await databaseIdFor("projects");
    return withTransaction(
      pool,
      async (client) => (await createItemWithClient(client, { databaseId: projectsId, properties })).id,
    );
  }

  function validate(relations: Record<string, string[]>, entityKind: "database" | "pageContent" = "database") {
    return withTransaction(pool, (client) =>
      assertValidProposalEnvelope(client, {
        entityKind,
        target: tasksDbId,
        properties: entityKind === "database" ? { name: "Buy milk" } : { flavour: "paragraph" },
        relations,
      }),
    );
  }

  it("keeps stored relations when the envelope is parsed", async () => {
    const project = await createProject({ name: "Home" });
    const stored = {
      entityKind: "database",
      target: tasksDbId,
      properties: { name: "x" },
      relations: { project: [project] },
    };

    expect(parseStoredProposalEnvelope(stored, "proposal-id")).toEqual(stored);
  });

  it("accepts an existing project and an empty array meaning no edge", async () => {
    const project = await createProject({ name: "Home" });
    const done = await createProject({ name: "Late invoice", status: "done" });

    await expect(validate({ project: [project] })).resolves.not.toBeNull();
    await expect(validate({ project: [done] })).resolves.not.toBeNull();
    await expect(validate({ project: [] })).resolves.not.toBeNull();
  });

  it("rejects a nonexistent target with the relation key as field", async () => {
    const error = await validate({ project: ["00000000-0000-4000-8000-000000000001"] }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).status).toBe(400);
    expect((error as ValidationError).details).toMatchObject({ field: "project" });
  });

  it("rejects an archived project with targetArchived", async () => {
    const project = await createProject({ name: "Old", status: "archived" });

    const error = await validate({ project: [project] }).catch((e: unknown) => e);

    expect((error as ValidationError).details).toEqual({ field: "project", code: "targetArchived" });
  });

  it("rejects a key that is not a relation property and a duplicated target", async () => {
    const project = await createProject({ name: "Home" });

    const notRelation = await validate({ name: [project] }).catch((e: unknown) => e);
    const unknown = await validate({ nope: [project] }).catch((e: unknown) => e);
    const duplicate = await validate({ project: [project, project] }).catch((e: unknown) => e);

    for (const [error, field] of [
      [notRelation, "name"],
      [unknown, "nope"],
      [duplicate, "project"],
    ] as const) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toEqual({ field });
    }
  });

  it("rejects relations on a pageContent envelope", async () => {
    const error = await validate({ project: [] }, "pageContent").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).details).toEqual({ field: "relations" });
  });
});

describe("assertValidProposalEnvelope validates multi-step envelopes (issue #1479)", () => {
  let peopleDbId: string;
  let companiesDbId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    peopleDbId = await databaseIdFor("people");
    companiesDbId = await databaseIdFor("companies");
  });

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

  function envelopeOf(operations: ProposalStep[], primary = operations.find((s) => s.role === "primary")!) {
    return {
      entityKind: "database" as const,
      target: primary.databaseKey === "people" ? peopleDbId : companiesDbId,
      properties: primary.properties ?? {},
      operations,
    };
  }

  function validate(envelope: ProposalEnvelope) {
    return withTransaction(pool, (client) => assertValidProposalEnvelope(client, envelope));
  }

  async function failure(envelope: ProposalEnvelope): Promise<ValidationError> {
    const error = await validate(envelope).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    if (!(error instanceof ValidationError)) throw error;
    return error;
  }

  async function createItem(moduleId: string, properties: Record<string, unknown>): Promise<string> {
    const databaseId = await databaseIdFor(moduleId);
    return withTransaction(pool, async (client) => (await createItemWithClient(client, { databaseId, properties })).id);
  }

  it("parses and validates a company plus a new person", async () => {
    const stored = envelopeOf([companyStep, personStep]);

    const parsed = parseStoredProposalEnvelope(JSON.parse(JSON.stringify(stored)), "p1") as ProposalEnvelope;

    expect(parsed.operations).toEqual(stored.operations);
    expect((await validate(parsed))!.id).toBe(peopleDbId);
  });

  it("leaves a single-step envelope byte for byte unchanged by parse and stringify", () => {
    const stored = {
      entityKind: "database",
      target: peopleDbId,
      properties: { name: "Jane" },
      relations: { companies: ["a"] },
    };
    const json = JSON.stringify(stored);

    expect(JSON.stringify(parseStoredProposalEnvelope(JSON.parse(json), "p1"))).toBe(json);
  });

  it("reports the ref and field of a failing person step", async () => {
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

  it("rejects a ref to a missing step", async () => {
    const error = await failure(envelopeOf([{ ...personStep, relations: { companies: [{ ref: "nope" }] } }]));

    expect(error.details).toEqual({ ref: "person", field: "companies" });
  });

  it("rejects a forged link before list that names a missing target", async () => {
    const person = await createItem("people", { name: "Jane" });
    const missing = "00000000-0000-4000-8000-000000000001";
    const error = await failure(
      envelopeOf([
        { ...companyStep, role: "primary" },
        {
          ref: "person",
          op: "link",
          role: "secondary",
          itemId: person,
          relations: { companies: [missing] },
          before: { relations: { companies: [missing] } },
        },
      ]),
    );
    expect(error.details).toMatchObject({ ref: "person", field: "companies" });
  });

  it("rejects two primary steps and duplicate refs", async () => {
    const twoPrimaries = await failure(envelopeOf([{ ...companyStep, role: "primary" }, personStep], personStep));
    const duplicate = await failure(envelopeOf([{ ...companyStep, ref: "person" }, personStep]));

    expect(twoPrimaries.details).toMatchObject({ field: "role" });
    expect(duplicate.details).toEqual({ ref: "person", field: "ref" });
  });

  it("enforces proposal identity and primary invariants on skipped steps", async () => {
    const active = { ...personStep, relations: undefined };
    for (const skipped of [
      { ...companyStep, enabled: false, ref: "person" },
      { ...companyStep, optional: true, ref: "person" },
      { ...companyStep, enabled: false, ref: "" },
    ]) {
      expect((await failure(envelopeOf([active, skipped]))).details).toMatchObject({ field: "ref" });
    }
    const primary = { ...companyStep, enabled: false, role: "primary" as const };
    expect((await failure(envelopeOf([active, primary], active))).details).toMatchObject({ field: "role" });
  });

  it("rejects a primary step that differs from the top level", async () => {
    const envelope = { ...envelopeOf([companyStep, personStep]), properties: { name: "Other" } };

    expect((await failure(envelope)).details).toEqual({ ref: "person", field: "properties" });
  });

  it("ignores a disabled step with an invalid payload", async () => {
    const disabled = { ...companyStep, enabled: false, properties: { bogus: 1 } };

    await validate(envelopeOf([disabled, { ...personStep, relations: undefined }]));
  });

  it("ignores an optional step nobody refers to, but validates it once referred to", async () => {
    const optional = { ...companyStep, optional: true, properties: { bogus: 1 } };

    await validate(envelopeOf([optional, { ...personStep, relations: undefined }]));
    const error = await failure(envelopeOf([optional, personStep]));

    expect(error.details).toEqual({ ref: "company", field: "bogus" });
  });

  it.each(["missing", "company"])("ignores a bad %s reference on an unreferenced optional step", async (ref) => {
    const optional = { ...companyStep, optional: true, relations: { people: [{ ref }] } };
    await validate(envelopeOf([optional, { ...personStep, relations: undefined }]));
  });

  it("rejects a required step referring to an optional step skipped for a missing reference", async () => {
    const optional = { ...companyStep, optional: true, relations: { people: [{ ref: "missing" }] } };
    const error = await failure(envelopeOf([optional, personStep]));
    expect(error.details).toEqual({ ref: "person", field: "companies" });
  });

  it("skips an optional step that refers to a disabled step, but rejects a required one", async () => {
    const disabled = { ...companyStep, enabled: false };
    const optionalReferrer = {
      ref: "second",
      op: "create" as const,
      databaseKey: "companies",
      properties: { bogus: 1 },
      relations: { people: [{ ref: "company" }] },
      role: "secondary" as const,
      optional: true,
    };

    await validate(envelopeOf([disabled, optionalReferrer, { ...personStep, relations: undefined }]));
    const error = await failure(envelopeOf([disabled, personStep]));

    expect(error.details).toEqual({ ref: "person", field: "companies" });
  });

  describe("update steps", () => {
    it("prepares a project pin without taking its allocation lock", async () => {
      const project = await createItem("projects", { name: "Project", pinned: false });
      const envelope = await updateEnvelope(
        {
          properties: { pinned: true },
          before: { properties: { pinned: false, pinnedOrder: null } },
          after: { properties: { pinned: true } },
        },
        project,
      );
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

    it("validates an explicit pin order and rejects a conflicting after value", async () => {
      const project = await createItem("projects", { name: "Project", pinned: false });
      const step: Partial<ProposalStep> = {
        properties: { pinned: true, pinnedOrder: 7 },
        before: { properties: { pinned: false, pinnedOrder: null } },
        after: { properties: { pinned: true, pinnedOrder: 7 } },
      };
      await validate(await updateEnvelope(step, project));
      const error = await failure(
        await updateEnvelope({ ...step, after: { properties: { pinned: true, pinnedOrder: 8 } } }, project),
      );
      expect(error.details).toEqual({ ref: "move", field: "pinnedOrder" });
    });

    it("rejects a predicted after value for an implicitly allocated pin order", async () => {
      const project = await createItem("projects", { name: "Project", pinned: false });
      const error = await failure(
        await updateEnvelope(
          {
            properties: { pinned: true },
            before: { properties: { pinned: false, pinnedOrder: null } },
            after: { properties: { pinned: true, pinnedOrder: 1 } },
          },
          project,
        ),
      );
      expect(error.details).toEqual({ ref: "move", field: "pinnedOrder" });
    });

    it("validates a Books year through its registered preparation", async () => {
      const book = await createItem("books", { name: "Book" });
      const error = await failure(
        await updateEnvelope(
          {
            properties: { year: "invalid" },
            before: { properties: { year: null } },
            after: { properties: { year: "invalid" } },
          },
          book,
          "books",
        ),
      );
      expect(error.details).toMatchObject({ ref: "move", field: "year" });
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

    it("rejects a missing step referenced only by an update's after relations", async () => {
      const project = await createItem("projects", { name: "Home" });
      const error = await failure(
        await updateEnvelope({ after: { relations: { area: [{ ref: "missing" }] } } }, project),
      );
      expect(error.details).toEqual({ ref: "move", field: "area" });
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
      const error = await failure(envelope);
      expect(error.details).toMatchObject({ ref: "area", field: "projects" });
    });

    it("accepts an update step changing a project's status", async () => {
      const project = await createItem("projects", { name: "Home", status: "inProgress" });

      await validate(
        await updateEnvelope(
          {
            properties: { status: "done" },
            before: { properties: { status: "inProgress" } },
            after: { properties: { status: "done" } },
          },
          project,
        ),
      );
    });

    it("rejects a blank title with the update field and ref", async () => {
      const project = await createItem("projects", { name: "Home" });
      const error = await failure(
        await updateEnvelope(
          {
            properties: { name: "" },
            before: { properties: { name: "Home" } },
            after: { properties: { name: "" } },
          },
          project,
        ),
      );
      expect(error.details).toEqual({ ref: "move", field: "name" });
    });

    it.each([
      [{ date: "2026-02-30" }, { date: null }, "date"],
      [{ timeFrom: "10:00" }, { timeFrom: null }, "timeFrom"],
    ])("rejects an invalid Tasks schedule through its registered preparation", async (patch, before, field) => {
      const task = await createItem("tasks", { name: "Task" });
      const error = await failure(
        await updateEnvelope(
          {
            properties: patch,
            before: { properties: before },
            after: { properties: patch },
          },
          task,
          "tasks",
        ),
      );
      expect(error.details).toMatchObject({ ref: "move", field });
    });

    it("rejects an after-only relation with no before coverage", async () => {
      const project = await createItem("projects", { name: "Home" });
      const error = await failure(await updateEnvelope({ after: { relations: { area: [] } } }, project));
      expect(error.details).toEqual({ ref: "move", field: "area" });
    });

    it("rejects a conflicting after property", async () => {
      const project = await createItem("projects", { name: "Home" });
      const error = await failure(
        await updateEnvelope(
          {
            properties: { name: "Next" },
            before: { properties: { name: "Home" } },
            after: { properties: { name: "Other" } },
          },
          project,
        ),
      );
      expect(error.details).toEqual({ ref: "move", field: "name" });
    });

    it("rejects an unsupported redundant after property", async () => {
      const project = await createItem("projects", { name: "Home", pinned: false });
      const error = await failure(
        await updateEnvelope(
          {
            properties: { name: "Next" },
            before: { properties: { name: "Home", pinned: false } },
            after: { properties: { name: "Next", pinned: false } },
          },
          project,
        ),
      );
      expect(error.details).toEqual({ ref: "move", field: "pinned" });
    });

    it("rejects conflicting relation representations", async () => {
      const project = await createItem("projects", { name: "Home" });
      const first = await createItem("areas", { name: "First" });
      const second = await createItem("areas", { name: "Second" });
      const error = await failure(
        await updateEnvelope(
          {
            relations: { area: [first] },
            before: { relations: { area: [] } },
            after: { relations: { area: [second] } },
          },
          project,
        ),
      );
      expect(error.details).toEqual({ ref: "move", field: "area" });
    });

    it("rejects an invalid after-only relation target", async () => {
      const project = await createItem("projects", { name: "Home" });
      const error = await failure(
        await updateEnvelope(
          {
            before: { relations: { area: [] } },
            after: { relations: { area: ["00000000-0000-4000-8000-000000000001"] } },
          },
          project,
        ),
      );
      expect(error.details).toMatchObject({ ref: "move", field: "area" });
    });

    it("does not treat a forged update before target as an existing edge", async () => {
      const project = await createItem("projects", { name: "Home" });
      const missing = "00000000-0000-4000-8000-000000000001";
      const error = await failure(
        await updateEnvelope(
          {
            before: { relations: { area: [missing] } },
            after: { relations: { area: [missing] } },
          },
          project,
        ),
      );
      expect(error.details).toMatchObject({ ref: "move", field: "area" });
    });

    it("validates an actually retained edge and rejects its archived or deleted target", async () => {
      const project = await createItem("projects", { name: "Project", status: "inProgress" });
      const task = await createItem("tasks", { name: "Task" });
      const tasksDb = await databaseIdFor("tasks");
      const databaseIdForProject = await databaseIdFor("projects");
      const property = await withTransaction(pool, (client) =>
        propertiesStore.getPropertyByKey(client, tasksDb, "project"),
      );
      if (!property) throw new Error("Missing Tasks.project");
      await withTransaction(pool, (client) =>
        createRelationWithClient(client, {
          relationPropertyId: property.id,
          callerItemId: task,
          targetItemId: project,
        }),
      );
      const envelope = await updateEnvelope(
        {
          before: { relations: { project: [project] } },
          after: { relations: { project: [project] } },
        },
        task,
        "tasks",
      );
      await validate(envelope);
      // In a tenant scope, as a request is: a Projects status update queues value-link propagation (issue gh-1869).
      await runInTenant(getTenantZeroId(), () =>
        withTransaction(pool, (client) =>
          updateItemWithClient(client, {
            databaseId: databaseIdForProject,
            itemId: project,
            propertiesPatch: { status: "archived" },
          }),
        ),
      );
      expect((await failure(envelope)).details).toMatchObject({
        ref: "move",
        field: "project",
        code: "targetArchived",
      });
      await createChokePoint(pool).softDeleteItem(databaseIdForProject, project);
      expect((await failure(envelope)).details).toMatchObject({ ref: "move", field: "project", code: "targetDeleted" });
    });

    it("exempts only the retained edge from target-side cardinality", async () => {
      const first = await createItem("projects", { name: "First" });
      const second = await createItem("projects", { name: "Second" });
      const task = await createItem("tasks", { name: "Task" });
      const projectsDb = await databaseIdFor("projects");
      const property = await withTransaction(pool, (client) =>
        propertiesStore.getPropertyByKey(client, projectsDb, "tasks"),
      );
      if (!property) throw new Error("Missing Projects.tasks");
      await withTransaction(pool, (client) =>
        createRelationWithClient(client, {
          relationPropertyId: property.id,
          callerItemId: first,
          targetItemId: task,
        }),
      );
      const step = { before: { relations: { tasks: [task] } }, after: { relations: { tasks: [task] } } };
      await validate(await updateEnvelope(step, first));
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

    it("accepts an update step moving a project to another area", async () => {
      const oldArea = await createItem("areas", { name: "Old" });
      const newArea = await createItem("areas", { name: "New" });
      const project = await createItem("projects", { name: "Home" });

      await validate(
        await updateEnvelope(
          {
            relations: { area: [newArea] },
            before: { relations: { area: [oldArea] } },
            after: { relations: { area: [newArea] } },
          },
          project,
        ),
      );
    });

    it("rejects a system-owned property with the step's ref and field", async () => {
      const task = await createItem("tasks", { name: "Buy milk" });

      const error = await failure(
        await updateEnvelope(
          { properties: { time: "x" }, before: { properties: { time: null } }, after: { properties: { time: "x" } } },
          task,
          "tasks",
        ),
      );

      expect(error.details).toEqual({ ref: "move", field: "time" });
    });

    it("keeps recurrence commands unavailable to Inbox proposal envelopes", async () => {
      const task = await createItem("tasks", { name: "Task", date: "2026-10-22" });
      const error = await failure(
        await updateEnvelope(
          {
            properties: { recurrence: { preset: "weekly" } },
            before: { properties: { recurrence: null } },
            after: { properties: { recurrence: { preset: "weekly" } } },
          },
          task,
          "tasks",
        ),
      );
      expect(error.details).toEqual({ ref: "move", field: "recurrence" });
    });

    it("rejects a changed key that is missing from before", async () => {
      const project = await createItem("projects", { name: "Home", status: "inProgress" });

      const error = await failure(
        await updateEnvelope(
          { properties: { status: "done" }, before: {}, after: { properties: { status: "done" } } },
          project,
        ),
      );

      expect(error.details).toEqual({ ref: "move", field: "status" });
    });

    it("rejects an item that does not exist", async () => {
      const error = await failure(
        await updateEnvelope({ properties: { status: "done" } }, "00000000-0000-4000-8000-000000000001"),
      );

      expect(error.details).toEqual({ ref: "move", field: "itemId" });
    });
  });
});

describe("aiProposal and aiVersion on the tick's writes (issue #1471)", () => {
  let inboxId: string;
  let typesId: string;
  let proposalsId: string;
  let databaseIds: TickDatabaseIds;

  beforeEach(async () => {
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
  });

  async function createTaskType() {
    return withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Task",
        emoji: "☑️",
        processingMethod: "database",
        targetDatabase: "tasks",
      }),
    );
  }

  async function createTaskItem(text: string, typeId: string) {
    return withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text,
        type: typeId,
      }),
    );
  }

  async function editText(itemId: string, text: string) {
    await withTransaction(pool, (client) =>
      itemsStore.updateItemProperties(client, { databaseId: inboxId, itemId, propertiesPatch: { text } }),
    );
  }

  it("the tick's create stores aiProposal equal to proposal at aiVersion 1", async () => {
    const type = await createTaskType();
    const item = await createTaskItem("Buy milk", type.id);

    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties.proposal).toBeTruthy();
    expect(proposal!.properties.aiProposal).toEqual(proposal!.properties.proposal);
    expect(proposal!.properties.aiVersion).toBe(1);
  });

  it("a recompute after a source change stores the new envelope at aiVersion 2, and the next one at 3", async () => {
    const type = await createTaskType();
    const item = await createTaskItem("Buy milk", type.id);
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));

    await editText(item.id, "Buy milk and eggs");
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk and eggs" } }));
    const second = await findProposalForItem(pool, proposalsId, item.id);
    expect(second!.properties.aiProposal).toEqual({
      entityKind: "database",
      target: await databaseIdFor("tasks"),
      properties: { name: "Buy milk and eggs" },
    });
    expect(second!.properties.aiProposal).toEqual(second!.properties.proposal);
    expect(second!.properties.aiVersion).toBe(2);

    await editText(item.id, "Buy oat milk");
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy oat milk" } }));
    const third = await findProposalForItem(pool, proposalsId, item.id);
    expect(third!.properties.aiProposal).toEqual(third!.properties.proposal);
    expect(third!.properties.aiVersion).toBe(3);
  });

  it("an untyped item's needsClarification stores null aiProposal and aiVersion 1", async () => {
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text: "no type",
      }),
    );
    await runTick(pool, databaseIds, item.id, async () => {
      return { properties: {}, candidates: [] };
    });

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties).toMatchObject({
      status: "needsClarification",
      proposal: null,
      aiProposal: null,
      aiVersion: 1,
    });
  });

  it("a needsClarification written over an existing card nulls aiProposal and counts one more version", async () => {
    const type = await createTaskType();
    const item = await createTaskItem("Buy milk", type.id);
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    const before = await findProposalForItem(pool, proposalsId, item.id);
    expect(before!.properties.aiVersion).toBe(1);

    // Taking the type off the item makes it untyped, so the tick writes needsClarification over the card.
    await withTransaction(pool, async (client) => {
      const typeProperty = await propertiesStore.getPropertyByKey(client, inboxId, "type");
      await deleteRelationWithClient(client, {
        relationPropertyId: typeProperty!.id,
        callerItemId: item.id,
        targetItemId: type.id,
      });
    });
    await runTick(pool, databaseIds, item.id, async () => {
      return { properties: {}, candidates: [] };
    });

    const after = await findProposalForItem(pool, proposalsId, item.id);
    expect(after!.id).toBe(before!.id);
    expect(after!.properties).toMatchObject({
      status: "needsClarification",
      proposal: null,
      aiProposal: null,
      aiVersion: 2,
    });
  });

  it("invalidating a card for a deleted source leaves its aiProposal and aiVersion as they were", async () => {
    const type = await createTaskType();
    const item = await createTaskItem("Buy milk", type.id);
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    const before = await findProposalForItem(pool, proposalsId, item.id);

    await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, item.id));
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called for a deleted source");
    });

    const invalidated = await findProposalForItem(pool, proposalsId, item.id);
    expect(invalidated!.properties.status).toBe("invalid");
    expect(invalidated!.properties.aiProposal).toEqual(before!.properties.aiProposal);
    expect(invalidated!.properties.aiVersion).toBe(1);
  });

  it("a legacy card without aiProposal reads its proposal, and its next automated write sets aiProposal at aiVersion 1", async () => {
    const type = await createTaskType();
    const item = await createTaskItem("Buy milk", type.id);
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    const created = await findProposalForItem(pool, proposalsId, item.id);

    // A card written before aiProposal and aiVersion existed: no current writer can produce that state.
    await pool.query("UPDATE items SET properties = properties - 'aiProposal' - 'aiVersion' WHERE id = $1", [
      created!.id,
    ]);
    const legacy = await findProposalForItem(pool, proposalsId, item.id);
    expect(legacy!.properties).not.toHaveProperty("aiProposal");
    expect(legacy!.properties).not.toHaveProperty("aiVersion");
    expect(readAiProposal(legacy!.properties, legacy!.id)).toEqual(created!.properties.proposal);

    await editText(item.id, "Buy milk and eggs");
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk and eggs" } }));

    const revised = await findProposalForItem(pool, proposalsId, item.id);
    expect(revised!.properties.aiProposal).toEqual(revised!.properties.proposal);
    expect(revised!.properties.aiVersion).toBe(1);
  });
});

describe("semprec.tick keeps user-edited keys when it recomputes a proposal (issue #1921)", () => {
  let inboxId: string;
  let typesId: string;
  let proposalsId: string;
  let tasksId: string;
  let databaseIds: TickDatabaseIds;

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    inboxId = await databaseIdFor("inbox");
    typesId = await databaseIdFor("inboxItemTypes");
    proposalsId = await databaseIdFor("processingProposals");
    tasksId = await databaseIdFor("tasks");
    databaseIds = {
      inboxDatabaseId: inboxId,
      inboxItemTypesDatabaseId: typesId,
      processingProposalsDatabaseId: proposalsId,
    };
  });

  const config = () => ({ processingProposalsDatabaseId: proposalsId });
  const RECOMPUTE_MESSAGE = "Revised the proposal after the source item changed.";

  /** A typed Task item whose first tick stored a `proposed` card; the card is returned as the tick wrote it. */
  async function seedCard() {
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
    await runTick(pool, databaseIds, item.id, async () => ({
      properties: { name: "Buy milk", description: "From the shop" },
    }));
    const card = await findProposalForItem(pool, proposalsId, item.id);
    if (!card) throw new Error("the first tick wrote no card");
    return { type, item, card };
  }

  async function readCard(cardId: string) {
    const card = await withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, cardId));
    if (!card) throw new Error(`card ${cardId} not found`);
    return card;
  }

  /** A manual `PATCH values` of the card, through the production function; answers the updated card. */
  async function editValues(cardId: string, values: Record<string, unknown>) {
    const { item } = await withTransaction(pool, (client) =>
      updateProposalValuesWithClient(client, config(), cardId, { set: { primary: values } }),
    );
    return item;
  }

  async function editText(itemId: string, text: string) {
    await withTransaction(pool, (client) =>
      itemsStore.updateItemProperties(client, { databaseId: inboxId, itemId, propertiesPatch: { text } }),
    );
  }

  function historyOf(card: { properties: Record<string, unknown> }) {
    return z
      .array(z.object({ author: z.string(), message: z.string(), kind: z.string().optional() }))
      .parse(card.properties.history);
  }

  const envelopeOf = (properties: Record<string, unknown>, target = tasksId) => ({
    entityKind: "database",
    target,
    properties,
  });

  it("a recompute after the source text changed keeps the edited title and takes the other fields from the assistant", async () => {
    const { item, card } = await seedCard();
    await editValues(card.id, { name: "My own title" });
    await editText(item.id, "Buy milk and eggs");

    await runTick(pool, databaseIds, item.id, async () => ({
      properties: { name: "Buy milk and eggs", description: "Two things" },
    }));

    const after = await readCard(card.id);
    expect(after.properties.aiProposal).toEqual(envelopeOf({ name: "Buy milk and eggs", description: "Two things" }));
    expect(after.properties.aiVersion).toBe(2);
    expect(after.properties.proposal).toEqual(envelopeOf({ name: "My own title", description: "Two things" }));
    expect(after.properties.userOverrides).toEqual({ primary: { name: "My own title" } });
    expect(after.properties.userEditedKeys).toEqual(["primary.name"]);
    expect(after.properties.status).toBe("proposed");
    const last = historyOf(after).at(-1);
    expect(last).toEqual({ author: "ai", message: RECOMPUTE_MESSAGE, kind: "recompute" });
  });

  it("a card without manual values gets empty overrides and a plain recompute entry", async () => {
    const { item, card } = await seedCard();
    await editText(item.id, "Buy oat milk");

    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy oat milk" } }));

    const after = await readCard(card.id);
    expect(after.properties.proposal).toEqual(envelopeOf({ name: "Buy oat milk" }));
    expect(after.properties.proposal).toEqual(after.properties.aiProposal);
    expect(after.properties.userOverrides).toEqual({});
    expect(after.properties.userEditedKeys).toEqual([]);
    expect(historyOf(after).at(-1)).toMatchObject({ message: RECOMPUTE_MESSAGE, kind: "recompute" });
  });

  it("a key whose manual value now equals the new assistant value drops out of the edited keys", async () => {
    const { item, card } = await seedCard();
    await editValues(card.id, { name: "My own title", description: "Two things" });
    await editText(item.id, "Buy milk and eggs");

    await runTick(pool, databaseIds, item.id, async () => ({
      properties: { name: "Buy milk and eggs", description: "Two things" },
    }));

    const after = await readCard(card.id);
    expect(after.properties.userOverrides).toEqual({ primary: { name: "My own title" } });
    expect(after.properties.userEditedKeys).toEqual(["primary.name"]);
    expect(after.properties.proposal).toEqual(envelopeOf({ name: "My own title", description: "Two things" }));
    // A value that became equal is not "dropped": the history entry names nothing.
    expect(historyOf(after).at(-1)).toMatchObject({ message: RECOMPUTE_MESSAGE, kind: "recompute" });
  });

  it("a manual PATCH values committed while computeProposal runs does not discard the assistant result", async () => {
    const { item, card } = await seedCard();
    await editText(item.id, "Buy milk and eggs");
    const before = await readCard(card.id);

    let editedVersion: string | undefined;
    await runTick(pool, databaseIds, item.id, async () => {
      editedVersion = (await editValues(card.id, { name: "Typed during the call" })).updatedAt;
      return { properties: { name: "Computed meanwhile", description: "Two things" } };
    });

    expect(editedVersion).toBeDefined();
    expect(editedVersion).not.toBe(before.updatedAt);
    const after = await readCard(card.id);
    expect(after.properties.aiProposal).toEqual(envelopeOf({ name: "Computed meanwhile", description: "Two things" }));
    expect(after.properties.aiVersion).toBe(2);
    expect(after.properties.proposal).toEqual(envelopeOf({ name: "Typed during the call", description: "Two things" }));
    expect(after.properties.userOverrides).toEqual({ primary: { name: "Typed during the call" } });
    expect(after.properties.userEditedKeys).toEqual(["primary.name"]);
    expect(historyOf(after).at(-1)).toMatchObject({ message: RECOMPUTE_MESSAGE, kind: "recompute" });
  });

  it("a card rejected while computeProposal runs is left as the reject wrote it, with its manual values", async () => {
    const { item, card } = await seedCard();
    await editValues(card.id, { name: "My own title" });
    await editText(item.id, "Buy milk and eggs");
    const before = await readCard(card.id);

    let rejectedVersion: string | undefined;
    await runTick(pool, databaseIds, item.id, async () => {
      const rejected = await withTransaction(pool, (client) =>
        itemsStore.updateItemProperties(client, {
          databaseId: proposalsId,
          itemId: card.id,
          propertiesPatch: { status: "rejected" },
        }),
      );
      rejectedVersion = rejected.updatedAt;
      return { properties: { name: "Must not be stored" } };
    });

    const after = await readCard(card.id);
    expect(after.updatedAt).toBe(rejectedVersion);
    expect(after.properties).toEqual({ ...before.properties, status: "rejected" });
  });

  it("a card confirmed while computeProposal runs is left as the confirm wrote it, with its manual values", async () => {
    const { item, card } = await seedCard();
    await editValues(card.id, { name: "My own title" });
    await editText(item.id, "Buy milk and eggs");
    // The tick and the confirm enqueue the source's Journal-day recompute under one job key, so a confirm issued
    // from inside the tick would wait on the tick's own transaction; the source leaves its Journal day first.
    await withTransaction(pool, async (client) => {
      const journalDayProperty = await propertiesStore.getPropertyByKey(client, inboxId, "journalDay");
      const relationDefinition = await relationsStore.getRelationDefinitionByPropertyId(client, journalDayProperty!.id);
      for (const edge of await relationsStore.listRelationsForItem(client, relationDefinition!.id, item.id)) {
        await relationsStore.deleteItemRelation(client, edge.relationDefinitionId, edge.itemA, edge.itemB);
      }
    });
    const before = await readCard(card.id);

    await runTick(pool, databaseIds, item.id, async () => {
      await withTransaction(pool, (client) => confirmProposalWithClient(client, config(), card.id));
      return { properties: { name: "Must not be stored" } };
    });

    const after = await readCard(card.id);
    expect(after.properties.status).toBe("confirmed");
    expect(after.properties.aiProposal).toEqual(before.properties.aiProposal);
    expect(after.properties.aiVersion).toBe(before.properties.aiVersion);
    expect(after.properties.proposal).toEqual(before.properties.proposal);
    expect(after.properties.userOverrides).toEqual({ primary: { name: "My own title" } });
    expect(historyOf(after).map((entry) => entry.message)).not.toContain(RECOMPUTE_MESSAGE);
  });

  it("a second assistant write while computeProposal runs discards the older result", async () => {
    const { item, card } = await seedCard();
    await editValues(card.id, { name: "My own title" });
    await editText(item.id, "Buy milk and eggs");

    await runTick(pool, databaseIds, item.id, async () => {
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
    expect(after.properties.aiVersion).toBe(2);
    expect(after.properties.aiProposal).toEqual(
      envelopeOf({ name: "Assistant revision", description: "From the thread" }),
    );
    expect(JSON.stringify(after.properties)).not.toContain("Older result");
    expect(historyOf(after).map((entry) => entry.message)).not.toContain(RECOMPUTE_MESSAGE);
  });

  it("an older result is also discarded when the card had no aiVersion, which counts as 0", async () => {
    const { item, card } = await seedCard();
    // A card written before aiVersion existed: no current writer can produce that state.
    await pool.query("UPDATE items SET properties = properties - 'aiVersion' WHERE id = $1", [card.id]);
    await editText(item.id, "Buy milk and eggs");

    await runTick(pool, databaseIds, item.id, async () => {
      await withTransaction(pool, (client) =>
        reviseProposalWithClient(client, config(), card.id, {
          entityKind: "database",
          target: tasksId,
          properties: { name: "Assistant revision" },
        }),
      );
      return { properties: { name: "Older result" } };
    });

    const after = await readCard(card.id);
    expect(after.properties.aiVersion).toBe(1);
    expect(after.properties.aiProposal).toEqual(envelopeOf({ name: "Assistant revision" }));
  });

  it("a card whose fingerprint another write moved while computeProposal runs discards the result", async () => {
    const { item, card } = await seedCard();
    await editText(item.id, "Buy milk and eggs");

    let movedVersion: string | undefined;
    await runTick(pool, databaseIds, item.id, async () => {
      // The fingerprint alone moves, as a failed computation clears it (issue #1485); aiVersion stays.
      const moved = await withTransaction(pool, (client) =>
        itemsStore.updateItemProperties(client, {
          databaseId: proposalsId,
          itemId: card.id,
          propertiesPatch: { fingerprint: null },
        }),
      );
      movedVersion = moved.updatedAt;
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
    await withTransaction(pool, (client) =>
      updateItemWithClient(client, {
        databaseId: typesId,
        itemId: type.id,
        propertiesPatch: { targetDatabase: "projects" },
      }),
    );
    await editText(item.id, "Plan the move");

    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Plan the move" } }));

    const after = await readCard(card.id);
    expect(after.properties.aiProposal).toEqual(envelopeOf({ name: "Plan the move" }, projectsId));
    expect(after.properties.proposal).toEqual(envelopeOf({ name: "Plan the move" }, projectsId));
    expect(after.properties.userOverrides).toEqual({});
    expect(after.properties.userEditedKeys).toEqual([]);
    const last = historyOf(after).at(-1);
    expect(last).toMatchObject({ kind: "recompute" });
    expect(last?.message).toBe(
      `${RECOMPUTE_MESSAGE} Manual values that no longer apply were dropped: primary.description, primary.name.`,
    );
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

    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk and eggs" } }));

    const after = await readCard(card.id);
    expect(after.properties.userOverrides).toEqual({ primary: { name: "My own title" } });
    expect(after.properties.userEditedKeys).toEqual(["primary.name"]);
    expect(after.properties.proposal).toEqual(envelopeOf({ name: "My own title" }));
    expect(historyOf(after).at(-1)?.message).toBe(
      `${RECOMPUTE_MESSAGE} Manual values that no longer apply were dropped: primary.removedKey.`,
    );
  });

  it("an assistant output that fails validation makes the card needsClarification and keeps the manual values stored", async () => {
    const { item, card } = await seedCard();
    await editValues(card.id, { name: "My own title" });
    await editText(item.id, "Buy milk and eggs");

    await runTick(pool, databaseIds, item.id, async () => ({ properties: { noSuchProperty: "x" } }));

    const clarifying = await readCard(card.id);
    expect(clarifying.properties).toMatchObject({
      status: "needsClarification",
      proposal: null,
      aiProposal: null,
      aiVersion: 2,
      userOverrides: { primary: { name: "My own title" } },
      userEditedKeys: ["primary.name"],
    });

    // They apply again when a later valid assistant output arrives.
    await editText(item.id, "Buy milk and eggs again");
    await runTick(pool, databaseIds, item.id, async () => ({
      properties: { name: "Buy milk and eggs again", description: "Two things" },
    }));
    const recovered = await readCard(card.id);
    expect(recovered.properties.status).toBe("proposed");
    expect(recovered.properties.aiVersion).toBe(3);
    expect(recovered.properties.proposal).toEqual(envelopeOf({ name: "My own title", description: "Two things" }));
    expect(recovered.properties.userEditedKeys).toEqual(["primary.name"]);
  });
});

describe("semprec.tick computes a card that was sent back as computing, whatever its fingerprint says (issue gh-1947)", () => {
  let inboxId: string;
  let typesId: string;
  let proposalsId: string;
  let databaseIds: TickDatabaseIds;

  beforeEach(async () => {
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
  });

  /** A typed Task item whose first tick stored a `proposed` card, which its fingerprint covers. */
  async function seedCard() {
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
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    const card = await findProposalForItem(pool, proposalsId, item.id);
    if (!card) throw new Error("the first tick wrote no card");
    return { type, item, card };
  }

  it("skips a proposed card whose fingerprint is current, the gate that a computing card does not meet", async () => {
    const { item, card } = await seedCard();
    let calls = 0;

    await runTick(pool, databaseIds, item.id, async () => {
      calls += 1;
      return { properties: { name: "Buy oat milk" } };
    });

    expect(calls).toBe(0);
    expect((await findProposalForItem(pool, proposalsId, item.id))?.properties).toMatchObject({
      status: "proposed",
      aiVersion: card.properties.aiVersion,
    });
  });

  it("computes a computing card whose fingerprint is current, and stores the result as a proposed card", async () => {
    const { type, item, card } = await seedCard();
    await withTransaction(pool, (client) =>
      updateItemWithClient(
        client,
        { databaseId: proposalsId, itemId: card.id, propertiesPatch: { status: "computing" } },
        { allowedSystemKeys: ["status"] },
      ),
    );
    expect((await findProposalForItem(pool, proposalsId, item.id))?.properties.fingerprint).toBe(
      fingerprintV2Of({ typeId: type.id, text: "Buy milk" }),
    );
    let calls = 0;

    await runTick(pool, databaseIds, item.id, async () => {
      calls += 1;
      return { properties: { name: "Buy oat milk" } };
    });

    expect(calls).toBe(1);
    const tasksId = await databaseIdFor("tasks");
    const envelope = { entityKind: "database", target: tasksId, properties: { name: "Buy oat milk" } };
    expect((await findProposalForItem(pool, proposalsId, item.id))?.properties).toMatchObject({
      status: "proposed",
      proposal: envelope,
      aiProposal: envelope,
      aiVersion: 2,
      fingerprint: fingerprintV2Of({ typeId: type.id, text: "Buy milk" }),
    });
  });
});

describe("aiProposalPatch and readAiProposal (issue #1471)", () => {
  const envelope: ProposalEnvelope = {
    entityKind: "database",
    target: "00000000-0000-4000-8000-000000000001",
    properties: { name: "Buy milk" },
  };
  const otherEnvelope: ProposalEnvelope = { ...envelope, properties: { name: "Buy eggs" } };

  it("a new row starts at aiVersion 1, a row with a counter adds one, and a row without one counts as 0", () => {
    expect(aiProposalPatch({}, envelope)).toEqual({ aiProposal: envelope, aiVersion: 1 });
    expect(aiProposalPatch({ aiVersion: 4 }, null)).toEqual({ aiProposal: null, aiVersion: 5 });
  });

  it("readAiProposal returns aiProposal when it is set, even where proposal differs", () => {
    expect(readAiProposal({ aiProposal: envelope, proposal: otherEnvelope }, "card")).toEqual(envelope);
  });

  it("readAiProposal falls back to the stored proposal when aiProposal is absent or JSON null", () => {
    expect(readAiProposal({ proposal: envelope }, "card")).toEqual(envelope);
    expect(readAiProposal({ aiProposal: null, proposal: envelope }, "card")).toEqual(envelope);
  });

  it("readAiProposal returns null when neither property holds an envelope", () => {
    expect(readAiProposal({}, "card")).toBeNull();
    expect(readAiProposal({ aiProposal: null, proposal: null }, "card")).toBeNull();
  });
});

afterAll(async () => {
  await pool?.end();
});

describe("Markdown page proposal validation", () => {
  it("stores resolved model heading and placement variants in the real tick", async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    const combineFailures = (primary: unknown, cleanup: unknown) =>
      new AggregateError([primary, cleanup], "Tick test and cleanup failed", { cause: primary });
    let primary: { error: unknown } | undefined;
    try {
      const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const tenant = await createTestTenant(pool);
      await createUser(pool, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
      await runInTenant(tenant, () => seedSystem(runtime));
      await runInTenant(tenant, async () => {
        const dbs = await withTransaction(runtime, async (client) => ({
          inbox: await databasesStore.getDatabaseByModuleId(client, "inbox"),
          types: await databasesStore.getDatabaseByModuleId(client, "inboxItemTypes"),
          proposals: await databasesStore.getDatabaseByModuleId(client, "processingProposals"),
          projects: await databasesStore.getDatabaseByModuleId(client, "projects"),
        }));
        if (!dbs.inbox?.ownerProjectItemId || !dbs.types || !dbs.proposals || !dbs.projects)
          throw new Error("Missing page proposal fixture databases");
        const cp = createChokePoint(runtime);
        const page = await cp.createItem({ databaseId: dbs.projects.id, properties: { name: "Page" } });
        const empty = await cp.createItem({ databaseId: dbs.projects.id, properties: { name: "No document" } });
        const headingId = randomUUID();
        const doc = await createDocStore(runtime).getOrCreateDoc(page.id, "page");
        await mutateDoc(runtime, doc.id, "user", (ydoc) =>
          writeBlock(ydoc, { id: headingId, type: "h2", text: "Dlažba" }),
        );
        const type = await withTransaction(runtime, (client) =>
          createInboxTypeWithClient(client, {
            inboxItemTypesDatabaseId: dbs.types!.id,
            name: "Page note",
            emoji: "N",
            processingMethod: "pageContent",
          }),
        );
        const variants = [
          { target: page.id, input: { afterHeadingText: "dlažba" }, expected: { afterHeading: headingId } },
          { target: page.id, input: { afterHeadingText: "missing" }, expected: "end" },
          { target: empty.id, input: { afterHeadingText: "dlažba" }, expected: "end" },
          { target: page.id, input: "start", expected: "start" },
          { target: page.id, input: "end", expected: "end" },
        ];
        for (const variant of variants) {
          const source = await withTransaction(runtime, (client) =>
            createInboxItemWithClient(client, {
              inboxDatabaseId: dbs.inbox!.id,
              date: "2026-11-06",
              time: "12:00",
              text: "Input",
              type: type.id,
            }),
          );
          // The model result is synthetic; the tick, storage and placement reader are actual owners.
          const tick = createSemprecTickAction(runtime, async () => ({
            target: variant.target,
            properties: { markdown: "Fixture text", placement: variant.input },
          }));
          await tick(
            {
              inboxDatabaseId: dbs.inbox.id,
              inboxItemTypesDatabaseId: dbs.types.id,
              processingProposalsDatabaseId: dbs.proposals.id,
            },
            { heartbeatId: randomUUID(), projectItemId: dbs.inbox.ownerProjectItemId, itemId: source.id },
          );
          const cards = await runtime.query<{ properties: unknown }>(
            `SELECT card.properties FROM items card JOIN item_relations edge ON edge.item_a = card.id OR edge.item_b = card.id
             WHERE card.database_id = $1 AND card.deleted_at IS NULL AND (edge.item_a = $2 OR edge.item_b = $2)`,
            [dbs.proposals.id, source.id],
          );
          expect(cards.rows).toHaveLength(1);
          const card = z
            .object({ proposal: z.unknown(), aiProposal: z.unknown() })
            .passthrough()
            .parse(cards.rows[0]?.properties);
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
    } catch (error) {
      primary = { error };
    }
    try {
      await runtime.end();
    } catch (error) {
      if (primary) throw combineFailures(primary.error, error);
      throw error;
    }
    if (primary) throw primary.error;
  });

  it("accepts current real hosts and validates headings without creating documents or exposing other tenants", async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const owner = await createTestTenant(pool);
      const foreign = await createTestTenant(pool);
      await runInTenant(owner, () => seedSystem(runtime));
      await runInTenant(foreign, () => seedSystem(runtime));
      const setup = (tenant: string) =>
        runInTenant(tenant, async () => {
          const dbs = await withTransaction(runtime, async (client) => ({
            projects: await databasesStore.getDatabaseByModuleId(client, "projects"),
            areas: await databasesStore.getDatabaseByModuleId(client, "areas"),
            tasks: await databasesStore.getDatabaseByModuleId(client, "tasks"),
            journal: await databasesStore.getDatabaseByModuleId(client, "journal"),
          }));
          if (!dbs.projects || !dbs.areas || !dbs.tasks || !dbs.journal) throw new Error("Missing system database");
          const cp = createChokePoint(runtime);
          const project = await cp.createItem({ databaseId: dbs.projects.id, properties: { name: "Project" } });
          const area = await cp.createItem({ databaseId: dbs.areas.id, properties: { name: "Area" } });
          const task = await cp.createItem({ databaseId: dbs.tasks.id, properties: { name: "Task" } });
          const day = await withTransaction(runtime, (client) =>
            getOrCreateJournalItem(client, dbs.journal!.id, "day", new Date("2026-11-06T12:00:00Z"), "UTC"),
          );
          const week = await withTransaction(runtime, (client) =>
            getOrCreateJournalItem(client, dbs.journal!.id, "week", new Date("2026-11-06T12:00:00Z"), "UTC"),
          );
          return { project, area, task, day, week };
        });
      const own = await setup(owner);
      const other = await setup(foreign);
      const validate = (target: string, properties: Record<string, unknown>) =>
        runInTenant(owner, () =>
          withTransaction(runtime, (client) =>
            assertValidProposalEnvelope(client, { entityKind: "pageContent", target, properties }),
          ),
        );
      const before = await runInTenant(owner, () =>
        runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM docs"),
      );
      for (const target of [own.project.id, own.area.id, own.day.id])
        await expect(validate(target, { markdown: "Hello", placement: "end" })).resolves.toBeNull();
      const after = await runInTenant(owner, () =>
        runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM docs"),
      );
      expect(after.rows).toEqual(before.rows);
      for (const target of [own.task.id, own.week.id, other.project.id, randomUUID()])
        await expect(validate(target, { markdown: "Hello", placement: "end" })).rejects.toMatchObject({
          status: 400,
          details: { field: "target" },
        });
      for (const properties of [
        { markdown: " ", placement: "end" },
        { markdown: "[Page](semprec://page/abc)", placement: "end" },
        { markdown: "Hello", placement: "sideways" },
        { markdown: "Hello", placement: "end", heading: "a\nb" },
        { markdown: "Hello", placement: { afterHeading: "missing" } },
      ])
        await expect(validate(own.project.id, properties)).rejects.toMatchObject({
          status: 400,
          details: { field: "properties" },
        });
      const store = createDocStore(runtime);
      const doc = await runInTenant(owner, () => store.getOrCreateDoc(own.project.id, "page"));
      await runInTenant(owner, () =>
        mutateDoc(runtime, doc.id, "user", (ydoc) => {
          writeBlock(ydoc, { id: "heading", type: "h2", text: "Heading" });
          writeBlock(ydoc, { id: "text", type: "text", text: "Paragraph" });
        }),
      );
      const resolvePlacement = (target: string, properties: Record<string, unknown>) =>
        runInTenant(owner, () =>
          withTransaction(runtime, (client) =>
            resolveModelPagePlacement(client, { entityKind: "pageContent", target, properties }),
          ),
        );
      const modelEnvelope = { markdown: "Hello", placement: { afterHeadingText: "  HEADING " } };
      const resolvedEnvelope = await resolvePlacement(own.project.id, modelEnvelope);
      expect(JSON.stringify(resolvedEnvelope)).not.toContain("afterHeadingText");
      expect(resolvedEnvelope.properties.placement).toEqual({
        afterHeading: "heading",
      });
      expect(
        (await resolvePlacement(own.project.id, { markdown: "Hello", placement: { afterHeadingText: "missing" } }))
          .properties.placement,
      ).toBe("end");
      expect(
        (await resolvePlacement(own.area.id, { markdown: "Hello", placement: { afterHeadingText: "heading" } }))
          .properties.placement,
      ).toBe("end");
      expect((await resolvePlacement(own.project.id, { flavour: "paragraph" })).properties).toEqual({
        flavour: "paragraph",
      });
      await expect(
        validate(own.project.id, { markdown: "Hello", placement: { afterHeading: "heading" } }),
      ).resolves.toBeNull();
      await expect(
        validate(own.project.id, { markdown: "Hello", placement: { afterHeading: "text" } }),
      ).rejects.toMatchObject({ status: 400 });
      await runInTenant(owner, () => createChokePoint(runtime).softDeleteItem(own.project.databaseId, own.project.id));
      await expect(validate(own.project.id, { markdown: "Hello", placement: "start" })).rejects.toMatchObject({
        status: 400,
        details: { field: "target" },
      });
    } finally {
      await runtime.end();
    }
  });

  it.each(["blank", "page block", "non-heading", "foreign heading", "non-host"] as const)(
    "keeps an invalid %s computation out of the real background tick and revise",
    async (mode) => {
      pool ??= getTestPool();
      await resetDatabase(pool);
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      let failed = false;
      let failure: unknown;
      try {
        const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        );
        expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
        const tenant = await createTestTenant(pool);
        const foreign = await createTestTenant(pool);
        for (const tenantId of [tenant, foreign]) {
          await createUser(pool, { tenantId, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
          await runInTenant(tenantId, () => seedSystem(runtime));
        }
        const foreignFixture = await runInTenant(foreign, async () => {
          const db = await withTransaction(runtime, (client) =>
            databasesStore.getDatabaseByModuleId(client, "projects"),
          );
          if (!db) throw new Error("Missing foreign Projects database");
          const page = await createChokePoint(runtime).createItem({
            databaseId: db.id,
            properties: { name: "Foreign" },
          });
          const doc = await createDocStore(runtime).getOrCreateDoc(page.id, "page");
          const id = randomUUID();
          await mutateDoc(runtime, doc.id, "user", (ydoc) => writeBlock(ydoc, { id, type: "h2", text: "Foreign" }));
          const rows = await runtime.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM doc_updates WHERE doc_id = $1",
            [doc.id],
          );
          return { id, docId: doc.id, rows: rows.rows };
        });
        await runInTenant(tenant, async () => {
          const dbs = await withTransaction(runtime, async (client) => ({
            inbox: await databasesStore.getDatabaseByModuleId(client, "inbox"),
            types: await databasesStore.getDatabaseByModuleId(client, "inboxItemTypes"),
            proposals: await databasesStore.getDatabaseByModuleId(client, "processingProposals"),
            projects: await databasesStore.getDatabaseByModuleId(client, "projects"),
            tasks: await databasesStore.getDatabaseByModuleId(client, "tasks"),
          }));
          if (!dbs.inbox?.ownerProjectItemId || !dbs.types || !dbs.proposals || !dbs.projects || !dbs.tasks)
            throw new Error("Missing page proposal fixture databases");
          const cp = createChokePoint(runtime);
          const project = await cp.createItem({ databaseId: dbs.projects.id, properties: { name: "Project" } });
          const task = await cp.createItem({ databaseId: dbs.tasks.id, properties: { name: "Task" } });
          const blockId = randomUUID();
          const doc = await createDocStore(runtime).getOrCreateDoc(project.id, "page");
          await mutateDoc(runtime, doc.id, "user", (ydoc) =>
            writeBlock(ydoc, { id: blockId, type: "text", text: "Text" }),
          );
          const type = await withTransaction(runtime, (client) =>
            createInboxTypeWithClient(client, {
              inboxItemTypesDatabaseId: dbs.types!.id,
              name: "Page note",
              emoji: "N",
              processingMethod: "pageContent",
            }),
          );
          const source = await withTransaction(runtime, (client) =>
            createInboxItemWithClient(client, {
              inboxDatabaseId: dbs.inbox!.id,
              date: "2026-11-06",
              time: "12:00",
              text: "Input",
              type: type.id,
            }),
          );
          const target = mode === "non-host" ? task.id : project.id;
          const properties =
            mode === "blank"
              ? { markdown: " ", placement: "end" }
              : mode === "page block"
                ? { markdown: "[Page](semprec://page/abc)", placement: "end" }
                : mode === "non-heading"
                  ? { markdown: "Hello", placement: { afterHeading: blockId } }
                  : mode === "foreign heading"
                    ? { markdown: "Hello", placement: { afterHeading: foreignFixture.id } }
                    : { markdown: "Hello", placement: "end" };
          let calls = 0;
          // This is a synthetic computed result passed to the real tick owner, not a model-success claim.
          const tick = createSemprecTickAction(runtime, async () => {
            calls++;
            return { target, properties };
          });
          await tick(
            {
              inboxDatabaseId: dbs.inbox.id,
              inboxItemTypesDatabaseId: dbs.types.id,
              processingProposalsDatabaseId: dbs.proposals.id,
            },
            { heartbeatId: randomUUID(), projectItemId: dbs.inbox.ownerProjectItemId, itemId: source.id },
          );
          expect(calls).toBe(1);
          const cards = await runtime.query<{ id: string; properties: unknown }>(
            `SELECT card.id, card.properties FROM items card JOIN item_relations edge ON edge.item_a = card.id OR edge.item_b = card.id
              WHERE card.database_id = $1 AND card.deleted_at IS NULL AND (edge.item_a = $2 OR edge.item_b = $2)`,
            [dbs.proposals.id, source.id],
          );
          expect(cards.rows).toHaveLength(1);
          const card = cards.rows[0];
          if (!card) throw new Error("Missing clarification card");
          expect(card.properties).toMatchObject({ status: "needsClarification", proposal: null, aiProposal: null });
          const expectedField = mode === "non-host" ? "target" : "properties";
          await expect(
            withTransaction(runtime, (client) =>
              reviseProposalWithClient(client, { processingProposalsDatabaseId: dbs.proposals!.id }, card.id, {
                message: "Revise",
                entityKind: "pageContent",
                target,
                properties,
              }),
            ),
          ).rejects.toMatchObject({ status: 400, details: { field: expectedField } });
          const after = await runtime.query<{ properties: unknown }>("SELECT properties FROM items WHERE id = $1", [
            card.id,
          ]);
          expect(after.rows).toEqual([{ properties: card.properties }]);
        });
        const foreignAfter = await runInTenant(foreign, () =>
          runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM doc_updates WHERE doc_id = $1", [
            foreignFixture.docId,
          ]),
        );
        expect(foreignAfter.rows).toEqual(foreignFixture.rows);
      } catch (error) {
        failed = true;
        failure = error;
      }
      let cleanupFailure: unknown;
      let cleanupFailed = false;
      try {
        await runtime.end();
      } catch (error) {
        cleanupFailed = true;
        cleanupFailure = error;
      }
      if (failed && cleanupFailed)
        throw new AggregateError([failure, cleanupFailure], "Tick test and cleanup failed", { cause: failure });
      if (failed) throw failure;
      if (cleanupFailed) throw cleanupFailure;
    },
  );
});
