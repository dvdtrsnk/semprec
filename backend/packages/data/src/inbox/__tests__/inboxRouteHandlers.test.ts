import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import {
  setInboxCardsInvalidationHook,
  setInvalidationHook,
  type InboxCardsInvalidationEvent,
  type InvalidationEvent,
} from "../../realtimeHook.js";
import { createTenantZeroUser, getTenantZeroId, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createPool, withTransaction } from "../../db/pool.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { runInTenant } from "@semprec/shared";
import { renameDatabase } from "../../chokePoint/databasesStore.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { createBlob } from "../../blobs/blobsStore.js";
import { createActionQueueAffinity } from "../../scheduler/actions.js";
import { createDocStore } from "../../docs/docStore.js";
import { deleteItemDependents, itemDeleteWithClient } from "../../chokePoint/itemTrash.js";
import { createInboxItemWithClient } from "../inboxStore.js";
import { insertInboxAttachments, listInboxAttachments } from "../inboxAttachmentsStore.js";
import * as propertiesStore from "../../chokePoint/propertiesStore.js";
import * as itemsStore from "../../chokePoint/itemsStore.js";
import * as relationsStore from "../../chokePoint/relationsStore.js";
import { createRelationWithClient, deleteRelationWithClient } from "../../chokePoint/relationOps.js";
import { getOrCreateJournalItem } from "../../journal/journalStore.js";
import { createInboxTypeWithClient, type CreateInboxTypeInput } from "../inboxTypesStore.js";
import { createSemprecTickAction, type ComputeSemprecProposalFn, type ProposalStep } from "../inboxTickAction.js";
import {
  createCaptureInboxItemRouteHandler,
  createConfirmProposalRouteHandler,
  createInboxCardsRouteHandler,
  createInboxTypesRouteHandler,
  createProposalOptionsRouteHandler,
  createRecomputeProposalRouteHandler,
  createRejectProposalRouteHandler,
  createReopenProposalRouteHandler,
  createResetProposalOverridesRouteHandler,
  createReviseProposalRouteHandler,
  createUpdateProposalValuesRouteHandler,
} from "../inboxRouteHandlers.js";
import { createTranscriptEventCard, matchTranscriptToEvent } from "../../transcription/transcriptEventMatch.js";
import { assignTranscriptSpeaker } from "../../transcription/transcriptSpeakerAssignment.js";
import { createTranscriptSpeakersRouteHandler } from "../../transcription/transcriptionRouteHandlers.js";
import { hasCredential } from "../../credentials/externalCredentialsStore.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../../transcription/transcriptionJob.js";
import { hashIdempotentRequest } from "../idempotentResponsesStore.js";
import {
  confirmProposalWithClient,
  readConfirmationResults,
  rejectProposalWithClient,
  reviseProposalWithClient,
} from "../proposalActions.js";
import { proposeSpeakerMappings } from "../../transcription/transcriptSpeakerSuggestion.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../errors.js";
import { createAgentRun } from "../../agentRuns/agentRunsStore.js";
import { createPendingApprovalRequest } from "../../mcp/approvalRequestsStore.js";
import { SYSTEM_DATABASES_EDITOR_SCHEMAS } from "../../seed/systemDatabasesEditorSchemas.js";
import { manifest as inboxManifest } from "../inboxModuleManifest.js";
import { PROPOSAL_OPTION_FIELDS } from "../proposalOptions.js";
import type { ItemRow } from "../../types.js";

let pool: Pool;
let viewTypeRegistry: ViewTypeRegistry;
let inboxId: string;
let typesId: string;
let proposalsId: string;

/**
 * The inbox custom-route handler factories, exercised directly against the functions they wrap; HTTP auth and mounting
 * are covered by `customRouteMount.test.ts` and `routeMatrix.test.ts` in `semprec-api`.
 */

type RouteContext = Parameters<ReturnType<typeof createConfirmProposalRouteHandler>>[0];
type RouteResult = Awaited<ReturnType<ReturnType<typeof createConfirmProposalRouteHandler>>>;
type Step = ProposalStep;

/** Higher than any version a card reaches in a test, so it never equals the version a card holds. */
const STALE_VERSION = "999999999";
const EVENT_DATE = "2024-03-01T12:00:00.000Z";
const PROJECT_ID = "00000000-0000-4000-8000-0000000000a1";
const TASK_TYPE = { name: "Task", emoji: "☑️", processingMethod: "database", targetDatabase: "tasks" } as const;

/** Runs `body` inside tenant zero, as a request does: relation writes queue value-link propagation there. */
function inTenant<T>(body: () => Promise<T>): Promise<T> {
  return runInTenant(getTenantZeroId(), body);
}

function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 10000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Polls `check` every 20 ms, up to 100 times; true once it held. */
async function pollUntil(check: () => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

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

function createDataPool(options: { statementTimeoutMs?: number } = {}): Pool {
  return createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data", ...options });
}

/** The runtime role neither bypasses row-level security nor is a superuser. */
async function expectRuntimeRole(runtime: Pool): Promise<void> {
  const role = await runtime.query<{ name: string; bypass: boolean; superuser: boolean }>(
    "SELECT current_user AS name, rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
  );
  expect(role.rows).toEqual([{ name: "semprec_data", bypass: false, superuser: false }]);
}

/** Runs `fn` inside tenant zero against a fresh runtime-role pool and ends the pool, reporting a failure of either. */
async function withDataPool(fn: (dataPool: Pool) => Promise<void>): Promise<void> {
  const dataPool = createDataPool();
  const failures: unknown[] = [];
  try {
    await expectRuntimeRole(dataPool);
    await inTenant(() => fn(dataPool));
  } catch (error) {
    failures.push(error);
  }
  try {
    await dataPool.end();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Runtime-role test and settlement failed");
}

type ItemInvalidation = Extract<InvalidationEvent, { scope: "item" }>;

async function itemInvalidations(run: () => Promise<unknown>): Promise<ItemInvalidation[]> {
  const events: InvalidationEvent[] = [];
  setInvalidationHook((event) => events.push(event));
  try {
    await run();
  } finally {
    setInvalidationHook(() => {});
  }
  return events.filter((event): event is ItemInvalidation => event.scope === "item");
}

async function cardInvalidations(run: () => Promise<unknown>): Promise<InboxCardsInvalidationEvent[]> {
  const events: InboxCardsInvalidationEvent[] = [];
  setInboxCardsInvalidationHook((event) => events.push(event));
  try {
    await run();
  } finally {
    setInboxCardsInvalidationHook(() => {});
  }
  return events;
}

function createInboxType(
  input: Omit<CreateInboxTypeInput, "inboxItemTypesDatabaseId">,
  runtime: Pool = pool,
): Promise<ItemRow> {
  return withTransaction(runtime, (client) =>
    createInboxTypeWithClient(client, { inboxItemTypesDatabaseId: typesId, ...input }),
  );
}

function createInboxItem(typeId: string, text: string, runtime: Pool = pool): Promise<ItemRow> {
  return withTransaction(runtime, (client) =>
    createInboxItemWithClient(client, {
      inboxDatabaseId: inboxId,
      date: "2026-08-28",
      time: "09:00",
      text,
      type: typeId,
    }),
  );
}

async function runTick(itemId: string, compute: ComputeSemprecProposalFn, runtime: Pool = pool): Promise<void> {
  await createSemprecTickAction(runtime, compute)(
    { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
    { heartbeatId: "hb", projectItemId: "proj", itemId },
  );
}

/** A Task inbox item and the card the tick proposes for it; `beforeTick` prepares the item the tick then reads. */
async function createDatabaseProposal(
  text: string,
  beforeTick: (inboxItemId: string) => Promise<void> = async () => {},
): Promise<string> {
  const type = await createInboxType(TASK_TYPE);
  const item = await createInboxItem(type.id, text);
  await beforeTick(item.id);
  await runTick(item.id, async () => ({ properties: { name: text } }));
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM items WHERE database_id = $1 ORDER BY updated_at DESC LIMIT 1`,
    [proposalsId],
  );
  return rows[0]!.id;
}

/** Attaches the blob to the Inbox item, as a camera capture does, and answers the attachment's id. */
async function attachBlob(inboxItemId: string, blobId: string): Promise<string> {
  return withTransaction(pool, async (client) => {
    await insertInboxAttachments(client, inboxItemId, [{ blobId, source: "camera" }]);
    const [attachment] = await listInboxAttachments(client, [inboxItemId]);
    if (!attachment) throw new Error("The attachment was not stored");
    return attachment.attachmentId;
  });
}

async function onlyInboxItemId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [inboxId]);
  if (rows.length !== 1 || !rows[0]) throw new Error(`Expected one Inbox item, found ${rows.length}`);
  return rows[0].id;
}

/** Writes card properties the tick of a test does not produce (a status, an envelope, results), through the choke point. */
async function patchCard(cardId: string, propertiesPatch: Record<string, unknown>): Promise<void> {
  await withTransaction(pool, (client) =>
    updateItemWithClient(
      client,
      { databaseId: proposalsId, itemId: cardId, propertiesPatch },
      { allowedSystemKeys: Object.keys(propertiesPatch) },
    ),
  );
}

async function storedCard(cardId: string): Promise<ItemRow> {
  const card = await itemsStore.getItemById(pool, proposalsId, cardId);
  if (!card) throw new Error(`Card ${cardId} is missing`);
  return card;
}

/** The stored fields of a card: an update's answer also carries the write's own metadata, which a read of the row has not. */
function storedFields(item: ItemRow) {
  return { id: item.id, properties: item.properties, updatedAt: item.updatedAt };
}

function historyOf(item: ItemRow): unknown[] {
  return z.array(z.unknown()).parse(item.properties.history);
}

function itemOf(answer: RouteResult): ItemRow {
  if (!("item" in answer)) throw new Error("expected an item answer");
  return answer.item;
}

async function listedCardIds(): Promise<string[]> {
  const userId = (await createTenantZeroUser(pool)).id;
  const answer = await createInboxCardsRouteHandler(pool)({ identity: { user: { id: userId, locale: "en" } } });
  if (!("body" in answer)) throw new Error("expected a raw JSON body");
  const body = z.object({ cards: z.array(z.object({ cardId: z.string() })) }).parse(answer.body);
  return body.cards.map((card) => card.cardId);
}

function confirm(cardId: string, body: unknown = {}): Promise<RouteResult> {
  return createConfirmProposalRouteHandler(pool)({ params: { id: cardId }, body });
}

function updateValues(cardId: string, body: unknown, extra: Partial<RouteContext> = {}): Promise<RouteResult> {
  return createUpdateProposalValuesRouteHandler(pool)({ params: { id: cardId }, body, ...extra });
}

/** A card whose primary name the user has edited. */
async function editedCard(): Promise<string> {
  const cardId = await createDatabaseProposal("Buy milk");
  await updateValues(cardId, { set: { primary: { name: "Buy oat milk" } } });
  return cardId;
}

/** `graphile_worker.jobs` is a read-only view, so the delete goes to the table behind it. */
async function clearRecomputeJobs(): Promise<void> {
  await pool.query(
    `DELETE FROM graphile_worker._private_jobs
     WHERE task_id IN (SELECT id FROM graphile_worker._private_tasks WHERE identifier = 'journalInboxRecompute')`,
  );
}

async function recomputeJobCount(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE task_identifier = 'journalInboxRecompute'",
  );
  return rows[0]!.n;
}

/** The `file` value of a Files item (a blob that exists): the Files editor schema requires it, so a Files card needs one to confirm. */
async function newFileValue(mimeType = "application/pdf"): Promise<{ blobId: string }> {
  const blob = await withTransaction(pool, (client) =>
    createBlob(client, { mimeType, byteSize: 12, storageKey: `blobs/${randomUUID()}` }),
  );
  return { blobId: blob.id };
}

async function anyItem(itemId: string): Promise<ItemRow> {
  const [item] = await itemsStore.getItemsByIdsIncludingDeleted(pool, [itemId]);
  if (!item) throw new Error(`Item ${itemId} is missing`);
  return item;
}

async function createIn(databaseId: string, properties: Record<string, unknown>): Promise<string> {
  const item = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId, properties }));
  return item.id;
}

/** Writes the edge of the relation `key` of `databaseId` from `callerItemId` to `targetItemId`. */
async function relate(
  databaseId: string,
  key: string,
  callerItemId: string,
  targetItemId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const relationPropertyId = await propertyIdFor(databaseId, key);
  await withTransaction(pool, (client) =>
    createRelationWithClient(client, {
      relationPropertyId,
      callerItemId,
      targetItemId,
      ...(metadata ? { metadata } : {}),
    }),
  );
}

async function edgeExists(a: string, b: string): Promise<boolean> {
  const { rows } = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM item_relations WHERE (item_a = $1 AND item_b = $2) OR (item_a = $2 AND item_b = $1)",
    [a, b],
  );
  return rows[0]!.n > 0;
}

function stepsEnvelope(target: string, steps: Step[]): Record<string, unknown> {
  const primary = steps.find((step) => step.role === "primary");
  return { entityKind: "database", target, properties: primary?.properties ?? {}, operations: steps };
}

function linkEvent(eventId: string) {
  return { entityKind: "relation" as const, target: eventId, properties: { propertyKey: "event" } };
}

async function createTranscript(name: string): Promise<string> {
  const transcriptsId = await databaseIdFor("transcripts");
  const transcript = await inTenant(() =>
    withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: transcriptsId, properties: { name, date: EVENT_DATE } },
        { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
      ),
    ),
  );
  return transcript.id;
}

async function onlyTranscriptCardId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM items WHERE database_id = $1 AND properties->>'kind' = 'transcript' AND deleted_at IS NULL",
    [proposalsId],
  );
  if (rows.length !== 1 || !rows[0]) throw new Error(`Expected one transcript card, found ${rows.length}`);
  return rows[0].id;
}

/** A transcript without a matching Event, and the card that proposes to create one. */
async function createUnmatchedTranscriptCard(name = "Weekly sync"): Promise<{ cardId: string; transcriptId: string }> {
  const transcriptId = await createTranscript(name);
  await inTenant(() =>
    withTransaction(pool, (client) => matchTranscriptToEvent(client, { transcriptId, durationSeconds: 3600 })),
  );
  return { cardId: await onlyTranscriptCardId(), transcriptId };
}

/** A transcript with one speaker, its Event with a participant person, and the card that proposes that person for the speaker. */
async function createSpeakerCard() {
  const transcriptsId = await databaseIdFor("transcripts");
  const eventsId = await databaseIdFor("events");
  const transcriptId = await createTranscript("Speaker fixture");
  const personId = await createIn(await databaseIdFor("people"), { name: "Alice" });
  const eventId = await createIn(eventsId, { name: "Meeting", type: "meeting", date: EVENT_DATE });
  await inTenant(async () => {
    // The suggestion is proposed only for a person who took part in the transcript's Event.
    await relate(eventsId, "people", eventId, personId);
    await relate(transcriptsId, "event", transcriptId, eventId);
    await withTransaction(pool, async (client) => {
      await itemsStore.writeComputed(client, transcriptsId, transcriptId, "segments", [
        { speaker: "SPEAKER_01", text: "Hello", startsAt: 0, endsAt: 1 },
      ]);
      await proposeSpeakerMappings(client, {
        transcriptId,
        suggestions: [{ speaker: "SPEAKER_01", personId, reason: "Recognized from the discussion" }],
      });
    });
  });
  return { cardId: await onlyTranscriptCardId(), transcriptId, personId, eventId };
}

describe("inbox custom route handlers", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    inboxId = await databaseIdFor("inbox");
    typesId = await databaseIdFor("inboxItemTypes");
    proposalsId = await databaseIdFor("processingProposals");
  });

  afterAll(async () => {
    await pool?.end();
  });

  /**
   * Confirms the card on one runtime-role connection and, while that transaction is still open, unlinks the file from
   * the project on another: the unlink waits for the confirm and commits after it. Both backends must be gone once
   * their pools end.
   */
  async function confirmWhileUnlinkWaits(
    proposalId: string,
    relationPropertyId: string,
    fileId: string,
    projectId: string,
  ): Promise<RouteResult> {
    const confirmPool = createDataPool({ statementTimeoutMs: 8000 });
    const unlinkPool = createDataPool({ statementTimeoutMs: 8000 });
    confirmPool.options.max = 1;
    unlinkPool.options.max = 1;
    const failures: unknown[] = [];
    const identities: Array<{ pid: number; started: string; db: string }> = [];
    const capture = async (pid: number) => {
      const { rows } = await pool.query<{ pid: number; started: string; db: string }>(
        "SELECT pid, backend_start::text AS started, datname AS db FROM pg_stat_activity WHERE pid = $1",
        [pid],
      );
      if (!rows[0]) throw new Error("Missing owned confirm backend");
      identities.push(rows[0]);
    };
    const confirmGate = deferred();
    const unlinkGate = deferred();
    const confirmReady = deferred<number>();
    const unlinkReady = deferred<number>();
    const unlinkDone = deferred();
    const wait = <T>(promise: Promise<T>) => withTimeout(promise, "Owned confirm overlap timed out");
    /** Waits for `ready`, failing if `work` settles first. */
    const reached = <T>(ready: Promise<T>, work: Promise<unknown>, message: string) =>
      wait(
        Promise.race([
          ready,
          work.then(() => {
            throw new Error(message);
          }),
        ]),
      );
    let confirmWork: Promise<unknown> | undefined;
    let unlinkWork: Promise<unknown> | undefined;
    let response: RouteResult | undefined;
    try {
      await expectRuntimeRole(confirmPool);
      await expectRuntimeRole(unlinkPool);
      confirmWork = inTenant(() =>
        withTransaction(confirmPool, async (client) => {
          const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          await confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposalId);
          confirmReady.resolve(rows[0]!.pid);
          await confirmGate.promise;
        }),
      );
      void confirmWork.catch(() => {});
      const confirmPid = await reached(confirmReady.promise, confirmWork, "Confirm ended before barrier");
      await capture(confirmPid);
      unlinkWork = inTenant(() =>
        withTransaction(unlinkPool, async (client) => {
          const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          unlinkReady.resolve(rows[0]!.pid);
          await deleteRelationWithClient(client, { relationPropertyId, callerItemId: fileId, targetItemId: projectId });
          unlinkDone.resolve();
          await unlinkGate.promise;
        }),
      );
      void unlinkWork.catch(() => {});
      const unlinkPid = await reached(unlinkReady.promise, unlinkWork, "Unlink ended before barrier");
      await capture(unlinkPid);
      const blocked = await pollUntil(async () => {
        const { rows } = await pool.query<{ blocked: boolean }>(
          "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
          [confirmPid, unlinkPid],
        );
        return rows[0]?.blocked === true;
      });
      expect(blocked).toBe(true);
      confirmGate.resolve();
      await wait(confirmWork);
      await reached(unlinkDone.promise, unlinkWork, "Unlink committed before barrier");
      response = await inTenant(() =>
        createConfirmProposalRouteHandler(confirmPool)({ params: { id: proposalId }, body: {} }),
      );
      if (!("item" in response) || !response.results) throw new Error("Missing committed result");
      expect(response.results.find((entry) => entry.ref === "file")?.linkLabels).toEqual(["Project"]);
    } catch (error) {
      failures.push(error);
    } finally {
      confirmGate.resolve();
      unlinkGate.resolve();
      const pending = [confirmWork, unlinkWork].filter((value): value is Promise<unknown> => value !== undefined);
      try {
        const outcomes = await wait(Promise.allSettled(pending));
        for (const outcome of outcomes) if (outcome.status === "rejected") failures.push(outcome.reason);
      } catch (error) {
        failures.push(new AggregateError([error], "Unresolved confirm overlap operations"));
      }
      for (const runtime of [confirmPool, unlinkPool]) {
        try {
          await wait(runtime.end());
        } catch (error) {
          failures.push(new AggregateError([error], "Unresolved confirm overlap pool"));
        }
      }
    }
    if (failures.length === 0) {
      for (const identity of identities) {
        const gone = await pollUntil(async () => {
          const { rows } = await pool.query<{ present: boolean }>(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz AND datname = $3) AS present",
            [identity.pid, identity.started, identity.db],
          );
          return rows[0]?.present === false;
        });
        if (!gone) failures.push(new Error(`Owned confirm backend ${identity.pid} remains active`));
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Confirm overlap or settlement failed");
    if (!response) throw new Error("Missing overlap result");
    return response;
  }

  describe("createConfirmProposalRouteHandler", () => {
    it.each([false, true])("attributes a confirmed page block to the user with existing block=%s", (existingBlock) =>
      withDataPool(async (dataPool) => {
        const type = await createInboxType({ name: "Note", emoji: "N", processingMethod: "pageContent" }, dataPool);
        const source = await createInboxItem(type.id, "A thought", dataPool);
        const chokePoint = createChokePoint(dataPool);
        const custom = await chokePoint.createDatabase({ name: "Custom page" });
        const page = await chokePoint.createItem({ databaseId: custom.id, properties: {} });
        await runTick(
          source.id,
          async () => ({ target: page.id, properties: { flavour: "paragraph", fields: { content: "A thought" } } }),
          dataPool,
        );
        const proposal = await withTransaction(dataPool, async (client) => {
          const { rows } = await client.query<{ id: string }>(
            "SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL",
            [proposalsId],
          );
          expect(rows).toHaveLength(1);
          return rows[0]!.id;
        });
        const docs = createDocStore(dataPool);
        if (existingBlock) {
          await docs.putBlock(page.id, { id: proposal, flavour: "paragraph", fields: { content: "Before" } }, "user");
        }
        const handler = createConfirmProposalRouteHandler(dataPool);
        const response = await handler({ params: { id: proposal }, body: {} });
        expect(response.status).toBe(200);
        if (!("item" in response)) throw new Error("Expected item response");
        expect(response.results).toEqual([
          expect.objectContaining({
            ref: "primary",
            itemId: page.id,
            databaseKey: null,
            role: "primary",
            blockIds: existingBlock ? [] : [proposal],
            followUp: null,
          }),
        ]);
        expect(response.item.properties.results).toEqual(response.results);
        const replay = await handler({ params: { id: proposal }, body: {} });
        if (!("item" in replay)) throw new Error("Expected item response");
        expect(replay.results).toEqual(response.results);
        expect(replay.item.updatedAt).toBe(response.item.updatedAt);
        const updates = await withTransaction(dataPool, async (client) => {
          const { rows } = await client.query<{ created_by: string }>(
            "SELECT u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1",
            [page.id],
          );
          return rows;
        });
        expect(updates).toEqual(
          existingBlock ? [{ created_by: "user" }, { created_by: "user" }] : [{ created_by: "user" }],
        );
        expect(await docs.getBlock(page.id, proposal)).toMatchObject({ content: "A thought", "sys:id": proposal });
      }),
    );

    it("records the file and follow-up task with project labels and current versions", async () => {
      const proposalId = await createDatabaseProposal("Seed");
      const projectId = await createIn(await databaseIdFor("projects"), { name: "Project" });
      const file = await newFileValue();
      await patchCard(proposalId, {
        proposal: stepsEnvelope(await databaseIdFor("files"), [
          {
            ref: "file",
            op: "create",
            databaseKey: "files",
            role: "primary",
            properties: { name: "Document", file },
            relations: { projects: [projectId] },
          },
          {
            ref: "task",
            op: "create",
            databaseKey: "tasks",
            role: "secondary",
            properties: { name: "Follow up" },
            relations: { project: [projectId] },
          },
        ]),
      });
      // In a tenant scope, as a request is: the task's Tasks.project edge queues value-link propagation.
      const response = await inTenant(() => confirm(proposalId));
      if (!("item" in response) || !response.results) throw new Error("Missing confirmed results");
      expect(response.results).toEqual([
        expect.objectContaining({
          ref: "file",
          role: "primary",
          databaseKey: "files",
          linkLabels: ["Project"],
          followUp: null,
        }),
        expect.objectContaining({
          ref: "task",
          role: "secondary",
          databaseKey: "tasks",
          linkLabels: ["Project"],
          followUp: null,
        }),
      ]);
      expect(response.item.properties.resultItemId).toBe(response.results[0]!.itemId);
      for (const result of response.results) expect(result.updatedAt).toBe((await anyItem(result.itemId)).updatedAt);
    });

    it.each(["created", "reused-empty", "reused-linked", "unlink-first", "overlap"] as const)(
      "reports only retained or created file relations: %s",
      async (mode) => {
        const unlinked = mode === "reused-empty" || mode === "unlink-first";
        const proposalId = await createDatabaseProposal("Attachment");
        const filesId = await databaseIdFor("files");
        const relationPropertyId = await propertyIdFor(filesId, "projects");
        const projectId = await createIn(await databaseIdFor("projects"), { name: "Project" });
        const { blobId } = await newFileValue();
        const existingId =
          mode === "created" ? undefined : await createIn(filesId, { name: "Existing", file: { blobId } });
        if (existingId && mode !== "reused-empty") await relate(filesId, "projects", existingId, projectId);
        const attachmentId = await attachBlob(await onlyInboxItemId(), blobId);
        await patchCard(proposalId, {
          proposal: stepsEnvelope(await databaseIdFor("tasks"), [
            { ref: "task", op: "create", databaseKey: "tasks", role: "primary", properties: { name: "Task" } },
            {
              ref: "file",
              op: "fileFromAttachment",
              role: "secondary",
              properties: { attachmentId, name: "File" },
              relations: { projects: [projectId] },
            },
          ]),
        });
        const fileRow = async (id: string) =>
          (
            await pool.query<{ properties: Record<string, unknown>; updated_at: Date }>(
              "SELECT properties, updated_at FROM items WHERE id = $1",
              [id],
            )
          ).rows;
        const oldFile = existingId ? await fileRow(existingId) : null;
        let result: RouteResult | undefined;
        if (mode === "overlap") {
          result = await confirmWhileUnlinkWaits(proposalId, relationPropertyId, existingId!, projectId);
        } else if (mode === "unlink-first") {
          await withDataPool(async (dataPool) => {
            await withTransaction(dataPool, (client) =>
              deleteRelationWithClient(client, {
                relationPropertyId,
                callerItemId: existingId!,
                targetItemId: projectId,
              }),
            );
            result = await createConfirmProposalRouteHandler(dataPool)({ params: { id: proposalId }, body: {} });
          });
        } else {
          result = await confirm(proposalId);
        }
        if (!result || !("item" in result) || !result.results) throw new Error("Missing results");
        const file = result.results.find((entry) => entry.ref === "file");
        if (!file) throw new Error("Missing file result");
        expect(file.linkLabels).toEqual(unlinked ? [] : ["Project"]);
        if (existingId) {
          expect(file.itemId).toBe(existingId);
          expect(await fileRow(existingId)).toEqual(oldFile);
        }
        expect(await edgeExists(file.itemId, projectId)).toBe(!unlinked && mode !== "overlap");
        expect(result.item.properties.results).toEqual(result.results);
        const replay = await confirm(proposalId);
        if (!("item" in replay)) throw new Error("Missing replay");
        expect(replay.results).toEqual(result.results);
      },
    );

    it("rejects malformed persisted confirmation results without changing the confirmed card", async () => {
      const proposalId = await createDatabaseProposal("Malformed stored result");
      await confirm(proposalId);
      await patchCard(proposalId, { results: [{ ref: 42 }] });
      const snapshot = async () =>
        (
          await pool.query<{ properties: Record<string, unknown>; updated_at: Date; items: string; jobs: string }>(
            `SELECT properties, updated_at, (SELECT count(*) FROM items)::text AS items,
                    (SELECT count(*) FROM graphile_worker.jobs)::text AS jobs
             FROM items WHERE id = $1`,
            [proposalId],
          )
        ).rows;
      const before = await snapshot();

      await expect(confirm(proposalId)).rejects.toThrow();

      expect(await snapshot()).toEqual(before);
    });

    it("records a secondary updated item under its own step reference", async () => {
      const proposalId = await createDatabaseProposal("Seed");
      const taskId = await createIn(await databaseIdFor("tasks"), { name: "Before" });
      const file = await newFileValue();
      await patchCard(proposalId, {
        proposal: stepsEnvelope(await databaseIdFor("files"), [
          { ref: "file", op: "create", databaseKey: "files", role: "primary", properties: { name: "Document", file } },
          {
            ref: "task",
            op: "update",
            itemId: taskId,
            role: "secondary",
            properties: { name: "After" },
            before: { properties: { name: "Before" } },
            after: { properties: { name: "After" } },
          },
        ]),
      });
      const response = await confirm(proposalId);
      if (!("item" in response)) throw new Error("Missing confirmed results");
      expect(response.results).toEqual([
        expect.objectContaining({ ref: "file", role: "primary", databaseKey: "files" }),
        expect.objectContaining({
          ref: "task",
          role: "secondary",
          databaseKey: "tasks",
          itemId: taskId,
          label: "After",
        }),
      ]);
    });

    it("does not report a transcription enqueue for an audio File confirm", async () => {
      const proposalId = await createDatabaseProposal("Audio");
      const file = await newFileValue("audio/mp4");
      const target = await databaseIdFor("files");
      await patchCard(proposalId, {
        proposal: { entityKind: "database", target, properties: { name: "Audio", type: "audio", file } },
      });
      const queued = () =>
        pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE task_identifier = 'transcriptionJob'",
        );
      const before = await queued();
      const response = await confirm(proposalId);
      if (!("item" in response)) throw new Error("Missing item result");
      expect(response.results).toEqual([expect.objectContaining({ databaseKey: "files", followUp: null })]);
      expect((await queued()).rows).toEqual(before.rows);
    });

    it("returns the transcript item for a confirmed transcript relation", () =>
      withDataPool(async (dataPool) => {
        const { cardId, transcriptId } = await createUnmatchedTranscriptCard("Meeting");
        const eventId = await createIn(await databaseIdFor("events"), {
          name: "Meeting",
          type: "meeting",
          date: EVENT_DATE,
        });
        await withTransaction(dataPool, (client) =>
          reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId, {
            message: "Link the existing event",
            ...linkEvent(eventId),
          }),
        );
        const response = await createConfirmProposalRouteHandler(dataPool)({ params: { id: cardId }, body: {} });
        if (!("item" in response)) throw new Error("Missing item result");
        expect(response.results).toEqual([
          expect.objectContaining({ itemId: transcriptId, role: "primary", linkLabels: ["Meeting"] }),
        ]);
        expect(response.item.properties.resultItemId).toBe(eventId);
      }));

    it("refuses a task card without a name with a ValidationError naming the field, and creates no task", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const tasksId = await databaseIdFor("tasks");
      await patchCard(proposalId, { proposal: { entityKind: "database", target: tasksId, properties: {} } });
      const countTasks = async () =>
        (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [tasksId]))
          .rows[0]?.n;
      const before = await countTasks();

      const error = await failureOf(confirm(proposalId));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ status: 400, details: { field: "name" } });
      expect(await countTasks()).toBe(before);
    });

    describe("an MCP server confirm", () => {
      async function createServerCard(): Promise<string> {
        const proposalId = await createDatabaseProposal("Server");
        await patchCard(proposalId, {
          proposal: {
            entityKind: "database",
            target: await databaseIdFor("mcpServers"),
            properties: {
              name: "Server",
              active: false,
              connectionConfig: { transport: "http", url: "https://mcp.example.com/mcp" },
            },
          },
        });
        return proposalId;
      }
      /** The pending `mcpServerSync` jobs: keys and the business payload (the public `jobs` view has no payload column; graphile-worker 0.17.3 keeps the envelope in `_private_jobs`). */
      async function queuedSyncs() {
        const { rows } = await pool.query<{ key: string | null; payload: { payload: Record<string, unknown> } }>(
          `SELECT j.key, j.payload FROM graphile_worker._private_jobs j
             JOIN graphile_worker._private_tasks t ON t.id = j.task_id
            WHERE t.identifier = 'mcpServerSync' ORDER BY j.key`,
        );
        return rows.map((row) => ({ key: row.key, payload: row.payload.payload }));
      }

      it("queues the tool sync as the authenticated user and reports it on the result of the server", async () => {
        const proposalId = await createServerCard();
        const userId = randomUUID();

        const response = await createConfirmProposalRouteHandler(pool)({
          params: { id: proposalId },
          body: {},
          identity: { user: { id: userId } },
        });

        const serverId = z.string().parse(itemOf(response).properties.resultItemId);
        expect(response).toMatchObject({
          results: [expect.objectContaining({ itemId: serverId, followUp: "mcpSyncQueued" })],
        });
        expect(await queuedSyncs()).toEqual([
          { key: `mcp-server-sync-${serverId}`, payload: { mcpServerItemId: serverId, actingUserId: userId } },
        ]);
      });

      it("queues nothing and reports no follow-up when the request carries no identity", async () => {
        const response = await confirm(await createServerCard());

        expect(response).toMatchObject({ results: [expect.objectContaining({ followUp: null })] });
        expect(await queuedSyncs()).toEqual([]);
      });
    });

    it("records Event and Journal calendar days in their confirmation results", async () => {
      const eventCard = await createDatabaseProposal("Event");
      const journalCard = await createDatabaseProposal("Journal");
      const journalId = await databaseIdFor("journal");
      const day = await withTransaction(pool, (client) =>
        getOrCreateJournalItem(client, journalId, "day", new Date("2026-08-28T12:00:00Z"), "UTC"),
      );
      await patchCard(eventCard, {
        proposal: {
          entityKind: "database",
          target: await databaseIdFor("events"),
          properties: { name: "Meeting", type: "meeting", date: "2026-08-28T12:00:00.000Z" },
        },
      });
      await patchCard(journalCard, {
        proposal: {
          entityKind: "pageContent",
          target: day.id,
          properties: { flavour: "paragraph", fields: { content: "Entry" } },
        },
      });
      const event = await confirm(eventCard);
      const journal = await confirm(journalCard);
      expect(event).toMatchObject({
        results: [expect.objectContaining({ databaseKey: "events", date: "2026-08-28" })],
      });
      expect(journal).toMatchObject({
        results: [expect.objectContaining({ databaseKey: "journal", date: "2026-08-28", blockIds: [journalCard] })],
      });
    });

    it("rolls back all results and the created file when a later step fails", async () => {
      const proposalId = await createDatabaseProposal("Seed");
      const filesId = await databaseIdFor("files");
      const file = await newFileValue();
      await patchCard(proposalId, {
        proposal: stepsEnvelope(filesId, [
          { ref: "file", op: "create", databaseKey: "files", role: "primary", properties: { name: "Document", file } },
          { ref: "task", op: "create", databaseKey: "tasks", role: "secondary", properties: { name: "Follow up" } },
        ]),
      });
      const fileCount = async () =>
        (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [filesId]))
          .rows;
      const before = await fileCount();
      // Fixed trigger forces the later Tasks step to fail after the Files step has written.
      await pool.query(`CREATE FUNCTION test_fail_result_task() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.database_id = (SELECT id FROM databases WHERE owner_module_id = 'tasks') THEN
          RAISE EXCEPTION 'test task failure'; END IF; RETURN NEW; END $$`);
      await pool.query(
        "CREATE TRIGGER test_fail_result_task BEFORE INSERT ON items FOR EACH ROW EXECUTE FUNCTION test_fail_result_task()",
      );
      const failures: unknown[] = [];
      try {
        await expect(createConfirmProposalRouteHandler(pool)({ params: { id: proposalId }, body: {} })).rejects.toThrow(
          "test task failure",
        );
      } catch (error) {
        failures.push(error);
      }
      for (const sql of [
        "DROP TRIGGER IF EXISTS test_fail_result_task ON items",
        "DROP FUNCTION IF EXISTS test_fail_result_task()",
      ]) {
        try {
          await pool.query(sql);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Confirm rollback test or cleanup failed");
      expect(await fileCount()).toEqual(before);
      const card = await storedCard(proposalId);
      expect(card.properties.status).toBe("proposed");
      expect(card.properties.results).toBeUndefined();
    });

    it("confirms a pending proposal, a thin mapping onto confirmProposalWithClient", async () => {
      const result = await confirm(await createDatabaseProposal("Buy milk"));

      expect(result.status).toBe(200);
      expect(itemOf(result).properties.status).toBe("confirmed");
      expect(typeof itemOf(result).properties.resultItemId).toBe("string");
    });

    it("addresses realtime invalidation to the authenticated user", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const userId = randomUUID();

      const events = await itemInvalidations(() =>
        createConfirmProposalRouteHandler(pool)({
          params: { id: proposalId },
          body: {},
          identity: { user: { id: userId } },
        }),
      );

      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events.every((event) => event.userId === userId)).toBe(true);
    });

    it("rejects a credential missing a plaintext", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");

      await expect(confirm(proposalId, { credential: { credentialType: "bearer_token" } })).rejects.toThrow(
        ValidationError,
      );
    });
  });

  describe("createRejectProposalRouteHandler", () => {
    async function reject(proposalId: string, body: unknown = {}): Promise<ItemRow> {
      const answer = await createRejectProposalRouteHandler(pool)({ params: { id: proposalId }, body });
      expect(answer.status).toBe(200);
      return itemOf(answer);
    }

    it.each(["proposed", "needsClarification", "invalid"])(
      "closes a %s card: status rejected, one rejected history entry, gone from the card list",
      async (status) => {
        const proposalId = await createDatabaseProposal("Buy milk");
        // `needsClarification` has no producer in the tick of these tests.
        if (status !== "proposed") await patchCard(proposalId, { status });
        const before = await storedCard(proposalId);
        expect(await listedCardIds()).toContain(proposalId);

        const item = await reject(proposalId);

        expect(item.id).toBe(proposalId);
        expect(item.properties.status).toBe("rejected");
        const history = historyOf(item);
        expect(history).toHaveLength(historyOf(before).length + 1);
        expect(history.at(-1)).toMatchObject({ author: "user", message: "Rejected by user.", kind: "rejected" });
        expect(await listedCardIds()).not.toContain(proposalId);
      },
    );

    it("closes a transcript card", async () => {
      const { cardId } = await createUnmatchedTranscriptCard();
      expect(await listedCardIds()).toContain(cardId);

      const item = await reject(cardId);

      expect(item.properties.status).toBe("rejected");
      expect(historyOf(item).at(-1)).toMatchObject({ author: "user", kind: "rejected" });
      expect(await listedCardIds()).not.toContain(cardId);
    });

    it.each([
      ["the supplied message", { message: "Already done by hand" }, "Already done by hand"],
      ["a null body, without a message", null, "Rejected by user."],
      ["a message of exactly the length cap", { message: "x".repeat(1000) }, "x".repeat(1000)],
    ])("rejects for %s and stores the text of the history entry", async (_label, body, message) => {
      const item = await reject(await createDatabaseProposal("Buy milk"), body);

      expect(item.properties.status).toBe("rejected");
      expect(historyOf(item).at(-1)).toMatchObject({ author: "user", message, kind: "rejected" });
    });

    it("answers a repeated call with the same card and adds no second history entry", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const first = await reject(proposalId);

      const second = await reject(proposalId, { message: "Changed my mind about the reason" });

      expect(storedFields(second)).toEqual(storedFields(first));
      expect(historyOf(second)).toHaveLength(historyOf(first).length);
    });

    it("refuses a confirmed card with validation_failed on status and writes nothing", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      await confirm(proposalId);
      const before = await storedCard(proposalId);

      await expect(
        createRejectProposalRouteHandler(pool)({ params: { id: proposalId }, body: {} }),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "status" } });

      expect(await storedCard(proposalId)).toEqual(before);
      expect(before.properties.status).toBe("confirmed");
    });

    it.each([
      ["an array body", []],
      ["a string body", "nope"],
      ["a number message", { message: 7 }],
      ["a null message", { message: null }],
      ["an empty message", { message: "" }],
      ["a blank message", { message: "   " }],
      ["a message over the length cap", { message: "x".repeat(1001) }],
    ])("refuses %s with validation_failed and leaves the card open", async (_label, body) => {
      const proposalId = await createDatabaseProposal("Buy milk");

      await expect(createRejectProposalRouteHandler(pool)({ params: { id: proposalId }, body })).rejects.toMatchObject({
        status: 400,
        code: "validation_failed",
      });

      const card = await itemsStore.getItemById(pool, proposalsId, proposalId);
      expect(card?.properties.status).toBe("proposed");
    });
  });

  describe("createReopenProposalRouteHandler", () => {
    async function reject(cardId: string): Promise<ItemRow> {
      return itemOf(await createRejectProposalRouteHandler(pool)({ params: { id: cardId }, body: {} }));
    }

    async function reopen(cardId: string, body: unknown = {}): Promise<ItemRow> {
      const answer = await createReopenProposalRouteHandler(pool)({ params: { id: cardId }, body });
      expect(answer.status).toBe(200);
      return itemOf(answer);
    }

    async function writtenState(): Promise<{ items: string[]; recomputeJobs: number }> {
      const items = await pool.query<{ id: string; updated_at: Date }>("SELECT id, updated_at FROM items ORDER BY id");
      return {
        items: items.rows.map((row) => `${row.id} ${row.updated_at.toISOString()}`),
        recomputeJobs: await recomputeJobCount(),
      };
    }

    it("returns a rejected card to proposed with the same proposal and overrides, and lists it again", async () => {
      const cardId = await editedCard();
      const open = await storedCard(cardId);
      const rejected = await reject(cardId);
      expect(await listedCardIds()).not.toContain(cardId);

      const item = await reopen(cardId);

      expect(item.id).toBe(cardId);
      expect(item.properties.status).toBe("proposed");
      expect(item.properties.proposal).toEqual(open.properties.proposal);
      expect(item.properties.aiProposal).toEqual(open.properties.aiProposal);
      expect(item.properties.userOverrides).toEqual({ primary: { name: "Buy oat milk" } });
      expect(item.properties.userEditedKeys).toEqual(["primary.name"]);
      expect(item.properties).not.toHaveProperty("results");
      expect(item.properties).not.toHaveProperty("invalidReason");
      expect(historyOf(item).slice(0, -1)).toEqual(historyOf(rejected));
      expect(historyOf(item).at(-1)).toMatchObject({ author: "user", message: "Reopened by user.", kind: "reopened" });
      expect(await listedCardIds()).toContain(cardId);
      expect(storedFields(await storedCard(cardId))).toEqual(storedFields(item));
    });

    it("announces the card to the stack and queues the Journal recompute", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      await reject(cardId);
      await clearRecomputeJobs();

      expect(await cardInvalidations(() => reopen(cardId))).toEqual([{ op: "updated", cardId }]);
      expect(await recomputeJobCount()).toBe(1);
    });

    it("answers a second reopen with the same card, adds no history entry and writes nothing", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      await reject(cardId);
      const first = await reopen(cardId);
      await clearRecomputeJobs();
      const before = await writtenState();

      const second = await reopen(cardId);

      expect(storedFields(second)).toEqual(storedFields(first));
      expect(historyOf(second)).toHaveLength(historyOf(first).length);
      expect(await writtenState()).toEqual(before);
    });

    it("answers a proposed card unchanged whatever ifVersion says, and writes nothing", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      const before = await storedCard(cardId);
      const state = await writtenState();

      const item = await reopen(cardId, { ifVersion: STALE_VERSION });

      expect(storedFields(item)).toEqual(storedFields(before));
      expect(await storedCard(cardId)).toEqual(before);
      expect(await writtenState()).toEqual(state);
    });

    it.each(["needsClarification", "invalid", "computing", "computeFailed"])(
      "refuses a %s card with validation_failed on status and leaves it as it was",
      async (status) => {
        const cardId = await createDatabaseProposal("Buy milk");
        await patchCard(cardId, { status });
        const before = await storedCard(cardId);

        await expect(
          createReopenProposalRouteHandler(pool)({ params: { id: cardId }, body: {} }),
        ).rejects.toMatchObject({
          status: 400,
          code: "validation_failed",
          details: { field: "status", currentStatus: status },
        });

        expect(await storedCard(cardId)).toEqual(before);
      },
    );

    it("answers a stale ifVersion on a rejected card with 409 and the card, which stays rejected", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      await reject(cardId);
      const before = await storedCard(cardId);
      const state = await writtenState();

      await expect(
        createReopenProposalRouteHandler(pool)({ params: { id: cardId }, body: { ifVersion: STALE_VERSION } }),
      ).rejects.toMatchObject({
        status: 409,
        code: "version_conflict",
        details: { current: { id: cardId, updatedAt: before.updatedAt } },
      });

      expect(await storedCard(cardId)).toEqual(before);
      expect(before.properties.status).toBe("rejected");
      expect(await writtenState()).toEqual(state);
    });

    it("reopens a rejected card for a null body and for an ifVersion that is its current version", async () => {
      const nullBody = await createDatabaseProposal("Buy milk");
      const current = await createDatabaseProposal("Buy bread");
      await reject(nullBody);
      await reject(current);

      expect((await reopen(nullBody, null)).properties.status).toBe("proposed");
      expect((await reopen(current, { ifVersion: (await storedCard(current)).version })).properties.status).toBe(
        "proposed",
      );
    });

    it.each<
      [string, () => Promise<Record<string, unknown>>, (patch: Record<string, unknown>) => Record<string, unknown>]
    >([
      [
        // An envelope the tick would refuse (`unknownProperty` is no Tasks property); the tick never stores one.
        "makes the card invalid when its stored envelope no longer validates, and keeps the envelope",
        async () => ({
          proposal: {
            entityKind: "database",
            target: await databaseIdFor("tasks"),
            properties: { unknownProperty: "x" },
          },
        }),
        ({ proposal }) => ({ status: "invalid", proposal }),
      ],
      [
        "makes the card invalid when it holds no stored envelope",
        async () => ({ proposal: null }),
        () => ({ status: "invalid", proposal: null }),
      ],
      [
        "clears the invalidReason a card kept from before it was discarded",
        async () => ({
          invalidReason: { code: "targetDeleted", field: "project", itemId: randomUUID(), label: "Gone" },
        }),
        () => ({ status: "proposed", invalidReason: null }),
      ],
      [
        // The id of an Inbox item that does not exist stands for the deleted source the tick marked the card with.
        "keeps the card invalid with its sourceDeleted reason while the source Inbox item is still deleted",
        async () => ({ invalidReason: { code: "sourceDeleted", field: "", itemId: randomUUID(), label: "Gone" } }),
        ({ invalidReason }) => ({ status: "invalid", invalidReason }),
      ],
      [
        "clears a sourceDeleted reason when its Inbox item is live again, and returns the card to proposed",
        async () => ({
          invalidReason: { code: "sourceDeleted", field: "", itemId: await onlyInboxItemId(), label: "Back" },
        }),
        () => ({ status: "proposed", invalidReason: null }),
      ],
    ])("%s", async (_name, build, expected) => {
      const cardId = await createDatabaseProposal("Buy milk");
      const patch = await build();
      await patchCard(cardId, { ...patch, status: "rejected" });

      const item = await reopen(cardId);

      expect(item.properties).toMatchObject(expected(patch));
      expect(historyOf(item).at(-1)).toMatchObject({ kind: "reopened" });
      expect((await storedCard(cardId)).properties).toMatchObject(expected(patch));
      expect(await listedCardIds()).toContain(cardId);
    });

    it("leaves a rejected card locked for the tick: its source is not recomputed", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      const sourceId = await onlyInboxItemId();
      const rejected = await reject(cardId);
      await pool.query('UPDATE items SET properties = properties || \'{"text": "Buy oat milk"}\' WHERE id = $1', [
        sourceId,
      ]); // raw: the text of the source changes, which the fingerprint gate would otherwise answer with a recompute

      await runTick(sourceId, async () => {
        throw new Error("A rejected card must not be recomputed");
      });

      expect(storedFields(await storedCard(cardId))).toEqual(storedFields(rejected));
    });

    it.each([
      ["an array body", []],
      ["a string body", "nope"],
      ["a number ifVersion", { ifVersion: 7 }],
      ["a null ifVersion", { ifVersion: null }],
      ["an empty ifVersion", { ifVersion: "" }],
      ["a date-only ifVersion", { ifVersion: "2026-11-14" }],
    ])("refuses %s with validation_failed and leaves the card rejected", async (_label, body) => {
      const cardId = await createDatabaseProposal("Buy milk");
      await reject(cardId);

      await expect(createReopenProposalRouteHandler(pool)({ params: { id: cardId }, body })).rejects.toMatchObject({
        status: 400,
        code: "validation_failed",
      });

      expect((await storedCard(cardId)).properties.status).toBe("rejected");
    });
  });

  describe("createReopenProposalRouteHandler on a confirmed card", () => {
    let tasksId: string;
    let transcriptsId: string;
    let eventsId: string;
    let peopleId: string;

    beforeEach(async () => {
      tasksId = await databaseIdFor("tasks");
      transcriptsId = await databaseIdFor("transcripts");
      eventsId = await databaseIdFor("events");
      peopleId = await databaseIdFor("people");
    });

    /** A test that runs inside tenant zero, which the relation writes need for the value-link propagation they trigger. */
    function tenantIt(name: string, body: () => Promise<void>): void {
      it(name, () => inTenant(body));
    }

    async function confirmCard(cardId: string, body: Record<string, unknown> = {}): Promise<ItemRow> {
      const item = itemOf(await confirm(cardId, body));
      expect(item.properties.status).toBe("confirmed");
      return item;
    }

    function callReopen(cardId: string, body: unknown = {}) {
      return createReopenProposalRouteHandler(pool)({ params: { id: cardId }, body });
    }

    async function reopenCard(cardId: string, body: unknown = {}): Promise<{ item: ItemRow; keptItems: unknown[] }> {
      const answer = await callReopen(cardId, body);
      expect(answer.status).toBe(200);
      if (!("item" in answer) || answer.keptItems === undefined) throw new Error("expected an item and keptItems");
      return { item: answer.item, keptItems: answer.keptItems };
    }

    async function originItemIds(cardId: string): Promise<string[]> {
      const { rows } = await pool.query<{ item_id: string }>(
        "SELECT item_id FROM item_origins WHERE proposal_id = $1",
        [cardId],
      );
      return rows.map((row) => row.item_id);
    }

    async function writtenState(): Promise<string[]> {
      const items = await pool.query<{ id: string; updated_at: Date; deleted_at: Date | null }>(
        "SELECT id, updated_at, deleted_at FROM items ORDER BY id",
      );
      const origins = await pool.query<{ item_id: string }>("SELECT item_id FROM item_origins ORDER BY item_id");
      const edges = await pool.query<{ id: string }>("SELECT id FROM item_relations ORDER BY id");
      return [
        ...items.rows.map((row) => `item ${row.id} ${row.updated_at.toISOString()} ${row.deleted_at?.toISOString()}`),
        ...origins.rows.map((row) => `origin ${row.item_id}`),
        ...edges.rows.map((row) => `edge ${row.id}`),
      ];
    }

    /**
     * A card the tick never produces (a page insert, a multi-step envelope), created through the choke point with
     * the system-owned keys the tick writes.
     */
    async function createCardWith(envelope: Record<string, unknown>): Promise<string> {
      const card = await withTransaction(pool, (client) =>
        createItemWithClient(
          client,
          {
            databaseId: proposalsId,
            properties: { kind: "inbox", status: "proposed", proposal: envelope, aiProposal: envelope },
          },
          { allowedSystemKeys: ["kind", "status", "proposal", "aiProposal"] },
        ),
      );
      return card.id;
    }

    tenantIt(
      "sends the created task to the trash, returns the card to proposed with its values and removes the origin row",
      async () => {
        const cardId = await createDatabaseProposal("Buy milk");
        const open = await storedCard(cardId);
        const confirmed = await confirmCard(cardId);
        const taskId = z.string().parse(confirmed.properties.resultItemId);
        expect(await originItemIds(cardId)).toEqual([taskId]);

        const { item, keptItems } = await reopenCard(cardId);

        expect(item.properties.status).toBe("proposed");
        expect(item.properties.proposal).toEqual(open.properties.proposal);
        expect(item.properties.aiProposal).toEqual(open.properties.aiProposal);
        expect(item.properties.userOverrides).toEqual(open.properties.userOverrides);
        expect(item.properties.resultItemId).toBeNull();
        expect(item.properties.resultLabel).toBeNull();
        expect(readConfirmationResults(item.properties)).toEqual([]);
        expect(keptItems).toEqual([]);
        const history = historyOf(item);
        expect(history.slice(0, -1)).toEqual(historyOf(confirmed));
        expect(history.at(-1)).toMatchObject({ author: "user", message: "Reopened by user.", kind: "reopened" });
        expect((await anyItem(taskId)).deletedAt).not.toBeNull();
        expect(await originItemIds(cardId)).toEqual([]);
        expect(storedFields(await storedCard(cardId))).toEqual(storedFields(item));
      },
    );

    tenantIt("lets the reopened card be confirmed again, which creates a new task", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      const first = z.string().parse((await confirmCard(cardId)).properties.resultItemId);
      await reopenCard(cardId);

      const second = z.string().parse((await confirmCard(cardId)).properties.resultItemId);

      expect(second).not.toBe(first);
      expect((await anyItem(first)).deletedAt).not.toBeNull();
      expect((await anyItem(second)).deletedAt).toBeNull();
      expect(await originItemIds(cardId)).toEqual([second]);
    });

    tenantIt("lists the reopened card in GET /api/inbox/cards again", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      await confirmCard(cardId);
      expect(await listedCardIds()).not.toContain(cardId);

      await reopenCard(cardId);

      expect(await listedCardIds()).toContain(cardId);
    });

    tenantIt("announces the card to the stack and queues the Journal recompute", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      await confirmCard(cardId);
      await clearRecomputeJobs(); // a job queued afterwards is the reopen's own

      expect(await cardInvalidations(() => reopenCard(cardId))).toEqual([{ op: "updated", cardId }]);
      expect(await recomputeJobCount()).toBe(1);
    });

    it.each<[string, (taskId: string) => Promise<unknown>, Record<string, unknown>]>([
      [
        "was edited",
        (taskId) =>
          withTransaction(pool, (client) =>
            updateItemWithClient(client, {
              databaseId: tasksId,
              itemId: taskId,
              propertiesPatch: { name: "Buy oat milk" },
            }),
          ),
        { databaseKey: "tasks", label: "Buy milk" },
      ],
      [
        "was moved to the trash",
        (taskId) => withTransaction(pool, (client) => itemsStore.softDeleteItem(client, tasksId, taskId)),
        {},
      ],
      [
        "was deleted for good",
        async (taskId) => {
          const task = await anyItem(taskId);
          await withTransaction(pool, async (client) => {
            await deleteItemDependents(client, task);
            await client.query("DELETE FROM items WHERE id = $1", [taskId]); // raw: the purge of an expired Trash row
          });
        },
        { databaseKey: "tasks" },
      ],
    ])(
      "answers 409 version_conflict with the created task when it %s after the confirmation, and changes nothing",
      (_name, change, details) =>
        inTenant(async () => {
          const cardId = await createDatabaseProposal("Buy milk");
          const taskId = z.string().parse((await confirmCard(cardId)).properties.resultItemId);
          await change(taskId);
          const before = await writtenState();
          const card = await storedCard(cardId);

          await expect(callReopen(cardId)).rejects.toMatchObject({
            status: 409,
            code: "version_conflict",
            details: { itemId: taskId, ...details },
          });

          expect(await writtenState()).toEqual(before);
          expect(await storedCard(cardId)).toEqual(card);
          expect(card.properties.status).toBe("confirmed");
        }),
    );

    tenantIt(
      "checks ifVersion after the status: a stale one answers 409 with the card, the current one reopens it",
      async () => {
        const cardId = await createDatabaseProposal("Buy milk");
        const taskId = z.string().parse((await confirmCard(cardId)).properties.resultItemId);
        const card = await storedCard(cardId);
        const before = await writtenState();

        await expect(callReopen(cardId, { ifVersion: STALE_VERSION })).rejects.toMatchObject({
          status: 409,
          code: "version_conflict",
          details: { current: { id: cardId, updatedAt: card.updatedAt } },
        });
        expect(await writtenState()).toEqual(before);

        const { item } = await reopenCard(cardId, { ifVersion: card.version });
        expect(item.properties.status).toBe("proposed");
        expect((await anyItem(taskId)).deletedAt).not.toBeNull();
      },
    );

    describe("page insert", () => {
      async function createPageCard(hostId: string, markdown: string): Promise<string> {
        return createCardWith({
          entityKind: "pageContent",
          target: hostId,
          properties: { markdown, placement: "end" },
        });
      }

      tenantIt("removes only the blocks the confirmation inserted", async () => {
        const hostId = await createIn(await databaseIdFor("projects"), { name: "Host" });
        const docs = createDocStore(pool);
        const first = await createPageCard(hostId, "Alpha");
        const second = await createPageCard(hostId, "Beta");
        await confirmCard(first);
        const confirmedSecond = await confirmCard(second);
        expect((await docs.readPageMarkdown(hostId)).markdown).toBe("Alpha\n\nBeta");
        const blockIds = readConfirmationResults(confirmedSecond.properties)[0]!.blockIds;
        expect(blockIds).toHaveLength(1);

        const { item } = await reopenCard(second);

        expect((await docs.readPageMarkdown(hostId)).markdown).toBe("Alpha");
        expect(item.properties.status).toBe("proposed");
        expect((await anyItem(hostId)).deletedAt).toBeNull();
        expect((await anyItem(hostId)).properties.name).toBe("Host");
      });

      tenantIt("removes the block of an old-shape envelope and keeps the neighbouring blocks", async () => {
        const hostId = await createIn(await databaseIdFor("projects"), { name: "Host" });
        const docs = createDocStore(pool);
        await confirmCard(await createPageCard(hostId, "Alpha"));
        // The old shape ({ flavour, fields }) writes one legacy block under the card's id, outside the page order.
        const legacyCardId = await createCardWith({
          entityKind: "pageContent",
          target: hostId,
          properties: { flavour: "paragraph", fields: { content: "Legacy" } },
        });
        const confirmed = await confirmCard(legacyCardId);
        expect(readConfirmationResults(confirmed.properties)[0]!.blockIds).toEqual([legacyCardId]);
        expect(await docs.getBlock(hostId, legacyCardId)).not.toBeNull();

        const { item } = await reopenCard(legacyCardId);

        expect(item.properties.status).toBe("proposed");
        expect(await docs.getBlock(hostId, legacyCardId)).toBeNull();
        expect((await docs.readPageMarkdown(hostId)).markdown).toBe("Alpha");
      });

      tenantIt("reopens when the user already deleted an inserted block", async () => {
        const hostId = await createIn(await databaseIdFor("projects"), { name: "Host" });
        const docs = createDocStore(pool);
        const cardId = await createPageCard(hostId, "Alpha");
        const confirmed = await confirmCard(cardId);
        const [blockId] = readConfirmationResults(confirmed.properties)[0]!.blockIds;
        await docs.deleteBlock(hostId, blockId!, "user");

        const { item } = await reopenCard(cardId);

        expect(item.properties.status).toBe("proposed");
        expect((await docs.readPageMarkdown(hostId)).markdown).toBe("");
      });

      tenantIt("reopens a page insert whose page document is gone, removing nothing", async () => {
        const hostId = await createIn(await databaseIdFor("projects"), { name: "Host" });
        const cardId = await createPageCard(hostId, "Alpha");
        await confirmCard(cardId);
        // A host without a doc: no production path removes a live item's doc.
        await withTransaction(pool, (client) => client.query("DELETE FROM docs WHERE item_id = $1", [hostId]));

        const { item } = await reopenCard(cardId);

        expect(item.properties.status).toBe("proposed");
      });

      tenantIt("answers 409 when the page item was changed after the confirmation", async () => {
        const hostId = await createIn(await databaseIdFor("projects"), { name: "Host" });
        const cardId = await createPageCard(hostId, "Alpha");
        await confirmCard(cardId);
        const projectsDb = await databaseIdFor("projects");
        await withTransaction(pool, (client) =>
          updateItemWithClient(client, {
            databaseId: projectsDb,
            itemId: hostId,
            propertiesPatch: { name: "Renamed" },
          }),
        );
        const before = await writtenState();

        await expect(callReopen(cardId)).rejects.toMatchObject({
          status: 409,
          details: { itemId: hostId, databaseKey: "projects" },
        });

        expect(await writtenState()).toEqual(before);
        expect((await createDocStore(pool).readPageMarkdown(hostId)).markdown).toBe("Alpha");
      });
    });

    describe("journal entry (issue gh-1981)", () => {
      const DAY = "2026-10-16";

      async function createJournalCard(properties: Record<string, unknown>): Promise<string> {
        return createCardWith({
          entityKind: "journalEntry",
          target: await databaseIdFor("journal"),
          properties: { date: DAY, markdown: "Went for a run.", ...properties },
        });
      }

      async function dayItem(): Promise<ItemRow | null> {
        const { rows } = await pool.query<{ id: string }>(
          "SELECT id FROM items WHERE database_id = $1 AND properties->>'type' = 'day' AND properties->>'period' = $2",
          [await databaseIdFor("journal"), DAY],
        );
        return rows[0] ? anyItem(rows[0].id) : null;
      }

      async function dayPage(): Promise<string> {
        const day = await dayItem();
        return day ? (await createDocStore(pool).readPageMarkdown(day.id)).markdown : "";
      }

      tenantIt(
        "removes the entry's blocks and the project edge it inserted, keeps the day, and lets the card be confirmed again",
        async () => {
          const projectId = await createIn(await databaseIdFor("projects"), { name: "Website" });
          const cardId = await createJournalCard({ projectId });
          const confirmed = await confirmCard(cardId);
          const day = (await dayItem())!;
          expect(await dayPage()).toBe("Went for a run.");
          expect(await edgeExists(day.id, projectId)).toBe(true);
          expect(readConfirmationResults(confirmed.properties)[0]!.blockIds).toHaveLength(1);

          const { item, keptItems } = await reopenCard(cardId);

          expect(item.properties.status).toBe("proposed");
          expect(item.properties.resultItemId).toBeNull();
          expect(keptItems).toEqual([]);
          expect(await dayPage()).not.toContain("Went for a run.");
          expect(await edgeExists(day.id, projectId)).toBe(false);
          // The day was created by the confirmation and stays, as every lazily created day does.
          expect((await anyItem(day.id)).deletedAt).toBeNull();

          await confirmCard(cardId);

          // Removing the page's only blocks leaves the editor's empty block, so the page is not compared whole.
          expect(await dayPage()).toContain("Went for a run.");
          expect(await edgeExists(day.id, projectId)).toBe(true);
        },
      );

      tenantIt("removes only its own blocks and leaves an edge the day already had", async () => {
        const areaId = await createIn(await databaseIdFor("areas"), { name: "Health" });
        const first = await createJournalCard({ areaId, markdown: "Morning." });
        const second = await createJournalCard({ areaId, markdown: "Evening." });
        await confirmCard(first);
        await confirmCard(second);
        const day = (await dayItem())!;
        expect(await dayPage()).toBe("Morning.\n\nEvening.");

        const { item } = await reopenCard(second);

        expect(item.properties.status).toBe("proposed");
        expect(await dayPage()).toBe("Morning.");
        expect(await edgeExists(day.id, areaId)).toBe(true);
      });

      tenantIt(
        "answers 409 when the day was moved to the Trash after the confirmation, and writes nothing",
        async () => {
          const cardId = await createJournalCard({});
          await confirmCard(cardId);
          const day = (await dayItem())!;
          await withTransaction(pool, (client) =>
            itemDeleteWithClient(client, day.databaseId, day.id, { queueAffinity: createActionQueueAffinity() }),
          );
          const before = await writtenState();

          await expect(callReopen(cardId)).rejects.toMatchObject({
            status: 409,
            details: { itemId: day.id, databaseKey: "journal" },
          });

          expect(await writtenState()).toEqual(before);
          expect((await storedCard(cardId)).properties.status).toBe("confirmed");
        },
      );
    });

    describe("transcript cards", () => {
      /** The transcript's edges to `personId` through its `speakers` relation: the derived `people` links to the same person are not these. */
      async function speakerEdgeMetadata(transcriptId: string, personId: string): Promise<unknown[]> {
        const { rows } = await pool.query<{ metadata: unknown }>(
          `SELECT r.metadata FROM item_relations r
           JOIN relation_definitions d ON d.id = r.relation_definition_id
           JOIN properties p ON p.id = d.property_id_a OR p.id = d.property_id_b
           WHERE p.key = 'speakers' AND p.database_id = $1 AND r.item_a = $2 AND r.item_b = $3`,
          [transcriptsId, transcriptId, personId],
        );
        return rows.map((row) => row.metadata);
      }

      async function speakerLabels(transcriptId: string): Promise<unknown> {
        const answer = await createTranscriptSpeakersRouteHandler(pool)({
          params: { id: transcriptId },
          identity: { user: { locale: "en" } },
        });
        if (!("body" in answer)) throw new Error("expected a raw JSON body");
        return answer.body;
      }

      tenantIt(
        "deletes the speakers edge, keeps an Event participant that existed before the confirmation, and the speakers read shows the placeholder again",
        async () => {
          const { cardId, transcriptId, personId, eventId } = await createSpeakerCard();
          const unmapped = await speakerLabels(transcriptId);
          await confirmCard(cardId);
          expect(await speakerLabels(transcriptId)).toEqual({
            speakers: [{ speaker: "SPEAKER_01", label: "Alice", personId }],
          });
          expect(await edgeExists(transcriptId, personId)).toBe(true);

          // The person is an Event participant already (the fixture put them there), so the confirm adds no edge of its own.
          const { item } = await reopenCard(cardId);

          expect(item.properties.status).toBe("proposed");
          expect(await speakerEdgeMetadata(transcriptId, personId)).toEqual([]);
          expect(await speakerLabels(transcriptId)).toEqual(unmapped);
          expect(unmapped).toEqual({ speakers: [{ speaker: "SPEAKER_01", label: "Speaker 1", personId: null }] });
          expect(await edgeExists(eventId, personId)).toBe(true);
        },
      );

      tenantIt("deletes the Event participant edge a confirmation added", async () => {
        const { cardId, transcriptId, personId, eventId } = await createSpeakerCard();
        await withTransaction(pool, async (client) => {
          await deleteRelationWithClient(client, {
            relationPropertyId: await propertyIdFor(eventsId, "people"),
            callerItemId: eventId,
            targetItemId: personId,
          });
        });
        await confirmCard(cardId);
        expect(await edgeExists(eventId, personId)).toBe(true);

        await reopenCard(cardId);

        expect(await edgeExists(eventId, personId)).toBe(false);
        expect(await speakerEdgeMetadata(transcriptId, personId)).toEqual([]);
      });

      tenantIt("keeps a speakers edge the user has since mapped to another speaker key", async () => {
        const { cardId, transcriptId, personId } = await createSpeakerCard();
        await confirmCard(cardId);
        await withTransaction(pool, async (client) => {
          await itemsStore.writeComputed(client, transcriptsId, transcriptId, "segments", [
            { speaker: "SPEAKER_01", text: "Hello", startsAt: 0, endsAt: 1 },
            { speaker: "SPEAKER_02", text: "Hi", startsAt: 1, endsAt: 2 },
          ]);
          // The one edge of the pair now maps the person to the other key; writing it again replaces the metadata.
          await createRelationWithClient(client, {
            relationPropertyId: await propertyIdFor(transcriptsId, "speakers"),
            callerItemId: transcriptId,
            targetItemId: personId,
            metadata: { speaker: "SPEAKER_02" },
          });
        });

        const { item } = await reopenCard(cardId);

        expect(item.properties.status).toBe("proposed");
        expect(await speakerEdgeMetadata(transcriptId, personId)).toEqual([{ speaker: "SPEAKER_02" }]);
      });

      tenantIt(
        "reverses nothing for a card a manual speaker assignment settled, and keeps the user's edge and participant",
        async () => {
          const { cardId, transcriptId, personId, eventId } = await createSpeakerCard();
          const userId = (await createTenantZeroUser(pool)).id;
          await withTransaction(pool, (client) =>
            assignTranscriptSpeaker(client, { transcriptId, speaker: "SPEAKER_01", personId, userId }),
          );
          expect((await storedCard(cardId)).properties.status).toBe("confirmed");
          // A later edit of the transcript would refuse an undo that checks it; a card with no write of its own does not.
          await withTransaction(pool, (client) =>
            updateItemWithClient(
              client,
              { databaseId: transcriptsId, itemId: transcriptId, propertiesPatch: { name: "Renamed" } },
              { allowedSystemKeys: ["name"] },
            ),
          );

          const { item, keptItems } = await reopenCard(cardId);

          expect(item.properties.status).toBe("proposed");
          expect(keptItems).toEqual([]);
          expect(await edgeExists(transcriptId, personId)).toBe(true);
          expect(await edgeExists(eventId, personId)).toBe(true);
          expect(await speakerLabels(transcriptId)).toEqual({
            speakers: [{ speaker: "SPEAKER_01", label: "Alice", personId }],
          });
        },
      );

      tenantIt("trashes the Event a create-Event card made and deletes the transcript's edge to it", async () => {
        const transcriptId = await createTranscript("Weekly sync");
        await withTransaction(pool, (client) =>
          matchTranscriptToEvent(client, { transcriptId, durationSeconds: 3600 }),
        );
        const cardId = await onlyTranscriptCardId();
        const confirmed = await confirmCard(cardId);
        const eventId = z.string().parse(confirmed.properties.resultItemId);
        expect(await edgeExists(transcriptId, eventId)).toBe(true);

        const { item } = await reopenCard(cardId);

        expect(item.properties.status).toBe("proposed");
        expect((await anyItem(eventId)).deletedAt).not.toBeNull();
        expect(await edgeExists(transcriptId, eventId)).toBe(false);
        expect(await originItemIds(cardId)).toEqual([]);
      });

      tenantIt(
        "keeps the participant edges of the Event a create-Event card made, which restore with the Event",
        async () => {
          const transcriptId = await createTranscript("Weekly sync");
          const personId = await createIn(peopleId, { name: "Alice" });
          const userId = (await createTenantZeroUser(pool)).id;
          await withTransaction(pool, async (client) => {
            await itemsStore.writeComputed(client, transcriptsId, transcriptId, "segments", [
              { speaker: "SPEAKER_01", text: "Hello", startsAt: 0, endsAt: 1 },
            ]);
            await assignTranscriptSpeaker(client, { transcriptId, speaker: "SPEAKER_01", personId, userId });
            await matchTranscriptToEvent(client, { transcriptId, durationSeconds: 3600 });
          });
          const confirmed = await confirmCard(await onlyTranscriptCardId());
          const eventId = z.string().parse(confirmed.properties.resultItemId);
          expect(await edgeExists(eventId, personId)).toBe(true);

          await reopenCard(confirmed.id);

          expect((await anyItem(eventId)).deletedAt).not.toBeNull();
          expect(await edgeExists(eventId, personId)).toBe(true);
        },
      );

      tenantIt("keeps a transcript event edge that existed before the confirmation", async () => {
        const transcriptId = await createTranscript("Weekly sync");
        await withTransaction(pool, (client) =>
          matchTranscriptToEvent(client, { transcriptId, durationSeconds: 3600 }),
        );
        const cardId = await onlyTranscriptCardId();
        const eventId = await createIn(eventsId, { name: "Planning", type: "meeting", date: EVENT_DATE });
        await withTransaction(pool, async (client) => {
          await createRelationWithClient(client, {
            relationPropertyId: await propertyIdFor(transcriptsId, "event"),
            callerItemId: transcriptId,
            targetItemId: eventId,
          });
        });
        await createReviseProposalRouteHandler(pool)({
          params: { id: cardId },
          body: { entityKind: "relation", target: eventId, properties: { propertyKey: "event" } },
        });
        await confirmCard(cardId);

        const { item } = await reopenCard(cardId);

        expect(item.properties.status).toBe("proposed");
        expect(await edgeExists(transcriptId, eventId)).toBe(true);
      });

      tenantIt("gives a speakers edge the user had mapped before the confirmation its metadata back", async () => {
        const { cardId, transcriptId, personId } = await createSpeakerCard();
        await withTransaction(pool, async (client) => {
          await itemsStore.writeComputed(client, transcriptsId, transcriptId, "segments", [
            { speaker: "SPEAKER_01", text: "Hello", startsAt: 0, endsAt: 1 },
            { speaker: "SPEAKER_02", text: "Hi", startsAt: 1, endsAt: 2 },
          ]);
          await createRelationWithClient(client, {
            relationPropertyId: await propertyIdFor(transcriptsId, "speakers"),
            callerItemId: transcriptId,
            targetItemId: personId,
            metadata: { speaker: "SPEAKER_02" },
          });
        });
        await confirmCard(cardId);
        expect(await speakerEdgeMetadata(transcriptId, personId)).toEqual([{ speaker: "SPEAKER_01" }]);

        const { item } = await reopenCard(cardId);

        expect(item.properties.status).toBe("proposed");
        expect(await speakerEdgeMetadata(transcriptId, personId)).toEqual([{ speaker: "SPEAKER_02" }]);
      });

      tenantIt(
        "removes the edge to the occurrence a relation card linked and leaves the Events item the confirmation materialized",
        async () => {
          const series = await createIn(eventsId, {
            name: "Standup",
            type: "standup",
            date: "2026-10-12",
            timeFrom: "09:00",
            timeTo: "09:30",
            recurrence: { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri"] },
          });
          const transcriptId = await withTransaction(pool, async (client) => {
            const transcript = await createItemWithClient(
              client,
              { databaseId: transcriptsId, properties: { date: "2026-10-14T07:01:00.000Z" } },
              { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
            );
            await itemsStore.writeComputed(client, transcriptsId, transcript.id, "segments", [
              { speaker: "SPEAKER_00", text: "Good morning everyone." },
            ]);
            await itemsStore.writeComputed(client, transcriptsId, transcript.id, "durationSeconds", 1200);
            const match = await matchTranscriptToEvent(client, { transcriptId: transcript.id, durationSeconds: 1200 });
            if (typeof match === "string" || match.outcome !== "ambiguous") throw new Error("Expected a match card");
            await createTranscriptEventCard(client, {
              transcriptId: transcript.id,
              candidates: match.candidates,
              recommendation: null,
            });
            return transcript.id;
          });
          const cardId = await onlyTranscriptCardId();
          const confirmed = await confirmCard(cardId);
          const occurrenceId = z.string().parse(confirmed.properties.resultItemId);
          expect(occurrenceId).not.toBe(series);
          expect(await edgeExists(transcriptId, occurrenceId)).toBe(true);

          const { item } = await reopenCard(cardId);

          expect(item.properties.status).toBe("proposed");
          expect(await edgeExists(transcriptId, occurrenceId)).toBe(false);
          // Trashing the materialized item would read as a cancelled occurrence, so it stays.
          const occurrence = await anyItem(occurrenceId);
          expect(occurrence.deletedAt).toBeNull();
          expect(occurrence.properties).toMatchObject({ seriesId: series, occurrenceDate: "2026-10-14" });
        },
      );

      tenantIt(
        "does not bring back the edge to a trashed Event that the confirmation released, and leaves that Event in the trash",
        async () => {
          const transcriptId = await createTranscript("Weekly sync");
          await withTransaction(pool, (client) =>
            matchTranscriptToEvent(client, { transcriptId, durationSeconds: 3600 }),
          );
          const cardId = await onlyTranscriptCardId();
          const trashedId = await createIn(eventsId, { name: "Old plan", type: "meeting", date: EVENT_DATE });
          const eventId = await createIn(eventsId, { name: "Planning", type: "meeting", date: EVENT_DATE });
          await withTransaction(pool, async (client) => {
            await createRelationWithClient(client, {
              relationPropertyId: await propertyIdFor(transcriptsId, "event"),
              callerItemId: transcriptId,
              targetItemId: trashedId,
            });
            await itemDeleteWithClient(client, eventsId, trashedId, { queueAffinity: createActionQueueAffinity() });
          });
          await createReviseProposalRouteHandler(pool)({
            params: { id: cardId },
            body: { entityKind: "relation", target: eventId, properties: { propertyKey: "event" } },
          });
          await confirmCard(cardId);
          expect(await edgeExists(transcriptId, trashedId)).toBe(false);
          expect(await edgeExists(transcriptId, eventId)).toBe(true);

          const { item } = await reopenCard(cardId);

          expect(item.properties.status).toBe("proposed");
          expect(await edgeExists(transcriptId, eventId)).toBe(false);
          expect(await edgeExists(transcriptId, trashedId)).toBe(false);
          expect((await anyItem(trashedId)).deletedAt).not.toBeNull();
        },
      );

      tenantIt("deletes the transcript's event edge of a card that linked an existing Event", async () => {
        const transcriptId = await createTranscript("Weekly sync");
        await withTransaction(pool, (client) =>
          matchTranscriptToEvent(client, { transcriptId, durationSeconds: 3600 }),
        );
        const cardId = await onlyTranscriptCardId();
        const eventId = await createIn(eventsId, { name: "Planning", type: "meeting", date: EVENT_DATE });
        await createReviseProposalRouteHandler(pool)({
          params: { id: cardId },
          body: { entityKind: "relation", target: eventId, properties: { propertyKey: "event" } },
        });
        await confirmCard(cardId);
        expect(await edgeExists(transcriptId, eventId)).toBe(true);

        await reopenCard(cardId);

        expect(await edgeExists(transcriptId, eventId)).toBe(false);
        expect((await anyItem(eventId)).deletedAt).toBeNull();
      });
    });

    describe("multi-step proposals", () => {
      tenantIt("restores the values and the relation an update step changed", async () => {
        const oldArea = await createIn(await databaseIdFor("areas"), { name: "Old" });
        const newArea = await createIn(await databaseIdFor("areas"), { name: "New" });
        const projectsDb = await databaseIdFor("projects");
        const projectId = await createIn(projectsDb, { name: "Before" });
        await relate(projectsDb, "area", projectId, oldArea);
        const cardId = await createCardWith(
          stepsEnvelope(projectsDb, [
            {
              ref: "project",
              op: "update",
              itemId: projectId,
              role: "primary",
              properties: { name: "After" },
              relations: { area: [newArea] },
              before: { properties: { name: "Before" }, relations: { area: [oldArea] } },
              after: { properties: { name: "After" }, relations: { area: [newArea] } },
            },
          ]),
        );
        await confirmCard(cardId);
        expect((await anyItem(projectId)).properties.name).toBe("After");
        expect(await edgeExists(projectId, newArea)).toBe(true);

        const { item } = await reopenCard(cardId);

        expect(item.properties.status).toBe("proposed");
        const project = await anyItem(projectId);
        expect(project.properties.name).toBe("Before");
        expect(project.deletedAt).toBeNull();
        expect(await edgeExists(projectId, oldArea)).toBe(true);
        expect(await edgeExists(projectId, newArea)).toBe(false);
      });

      tenantIt("restores the relation of an update step that changed no property", async () => {
        const oldArea = await createIn(await databaseIdFor("areas"), { name: "Old" });
        const newArea = await createIn(await databaseIdFor("areas"), { name: "New" });
        const projectsDb = await databaseIdFor("projects");
        const projectId = await createIn(projectsDb, { name: "Project" });
        await relate(projectsDb, "area", projectId, oldArea);
        const cardId = await createCardWith(
          stepsEnvelope(projectsDb, [
            {
              ref: "project",
              op: "update",
              itemId: projectId,
              role: "primary",
              properties: {},
              before: { relations: { area: [oldArea] } },
              after: { relations: { area: [newArea] } },
            },
          ]),
        );
        await confirmCard(cardId);
        expect(await edgeExists(projectId, newArea)).toBe(true);

        await reopenCard(cardId);

        expect(await edgeExists(projectId, oldArea)).toBe(true);
        expect(await edgeExists(projectId, newArea)).toBe(false);
        expect((await anyItem(projectId)).properties.name).toBe("Project");
      });

      tenantIt(
        "answers 409 for an update step whose item was edited after the confirmation, and restores nothing",
        async () => {
          const projectsDb = await databaseIdFor("projects");
          const projectId = await createIn(projectsDb, { name: "Before" });
          const cardId = await createCardWith(
            stepsEnvelope(projectsDb, [
              {
                ref: "project",
                op: "update",
                itemId: projectId,
                role: "primary",
                properties: { name: "After" },
                before: { properties: { name: "Before" } },
                after: { properties: { name: "After" } },
              },
            ]),
          );
          await confirmCard(cardId);
          await withTransaction(pool, (client) =>
            updateItemWithClient(client, {
              databaseId: projectsDb,
              itemId: projectId,
              propertiesPatch: { name: "Edited by hand" },
            }),
          );
          const before = await writtenState();

          await expect(callReopen(cardId)).rejects.toMatchObject({
            status: 409,
            details: { itemId: projectId, databaseKey: "projects", label: "After" },
          });

          expect(await writtenState()).toEqual(before);
          expect((await anyItem(projectId)).properties.name).toBe("Edited by hand");
        },
      );

      tenantIt("deletes the edge a link step wrote between existing items, and keeps both items", async () => {
        const areaId = await createIn(await databaseIdFor("areas"), { name: "Area" });
        const projectsDb = await databaseIdFor("projects");
        const projectId = await createIn(projectsDb, { name: "Project" });
        const cardId = await createCardWith(
          stepsEnvelope(await databaseIdFor("companies"), [
            { ref: "company", op: "create", databaseKey: "companies", role: "primary", properties: { name: "Acme" } },
            { ref: "link", op: "link", itemId: projectId, role: "secondary", relations: { area: [areaId] } },
          ]),
        );
        await confirmCard(cardId);
        expect(await edgeExists(projectId, areaId)).toBe(true);

        const { item } = await reopenCard(cardId);

        expect(item.properties.status).toBe("proposed");
        expect(await edgeExists(projectId, areaId)).toBe(false);
        expect((await anyItem(projectId)).deletedAt).toBeNull();
        expect((await anyItem(areaId)).deletedAt).toBeNull();
      });

      tenantIt("keeps an edge a link step proposed that existed before the confirmation", async () => {
        const areaId = await createIn(await databaseIdFor("areas"), { name: "Area" });
        const projectsDb = await databaseIdFor("projects");
        const projectId = await createIn(projectsDb, { name: "Project" });
        // The user linked the pair by hand before the card was confirmed; the confirm writes the same pair again.
        await relate(projectsDb, "area", projectId, areaId);
        const cardId = await createCardWith(
          stepsEnvelope(await databaseIdFor("companies"), [
            { ref: "company", op: "create", databaseKey: "companies", role: "primary", properties: { name: "Acme" } },
            { ref: "link", op: "link", itemId: projectId, role: "secondary", relations: { area: [areaId] } },
          ]),
        );
        await confirmCard(cardId);

        const { item } = await reopenCard(cardId);

        expect(item.properties.status).toBe("proposed");
        expect(await edgeExists(projectId, areaId)).toBe(true);
      });

      tenantIt("restores the metadata of an edge an update step removed", async () => {
        const eventsDb = await databaseIdFor("events");
        const peopleDb = await databaseIdFor("people");
        const eventId = await createIn(eventsDb, { name: "Meeting", type: "meeting", date: EVENT_DATE });
        const alice = await createIn(peopleDb, { name: "Alice" });
        const bob = await createIn(peopleDb, { name: "Bob" });
        await relate(eventsDb, "people", eventId, alice, { role: "attendee" });
        const cardId = await createCardWith(
          stepsEnvelope(eventsDb, [
            {
              ref: "event",
              op: "update",
              itemId: eventId,
              role: "primary",
              properties: {},
              before: { relations: { people: [alice] } },
              after: { relations: { people: [bob] } },
            },
          ]),
        );
        await confirmCard(cardId);
        expect(await edgeExists(eventId, alice)).toBe(false);
        expect(await edgeExists(eventId, bob)).toBe(true);

        await reopenCard(cardId);

        expect(await edgeExists(eventId, bob)).toBe(false);
        const { rows } = await pool.query<{ metadata: unknown }>(
          "SELECT metadata FROM item_relations WHERE (item_a = $1 AND item_b = $2) OR (item_a = $2 AND item_b = $1)",
          [eventId, alice],
        );
        expect(rows.map((row) => row.metadata)).toEqual([{ role: "attendee" }]);
      });

      tenantIt(
        "trashes every created item of a two-step proposal and leaves the edges between them for a restore",
        async () => {
          const cardId = await createCardWith(
            stepsEnvelope(await databaseIdFor("companies"), [
              { ref: "company", op: "create", databaseKey: "companies", role: "primary", properties: { name: "Acme" } },
              {
                ref: "person",
                op: "create",
                databaseKey: "people",
                role: "secondary",
                properties: { name: "Jane" },
                relations: { companies: [{ ref: "company" }] },
              },
            ]),
          );
          const confirmed = await confirmCard(cardId);
          const ids = readConfirmationResults(confirmed.properties).map((result) => result.itemId);
          expect(ids).toHaveLength(2);

          await reopenCard(cardId);

          for (const id of ids) expect((await anyItem(id)).deletedAt).not.toBeNull();
          expect(await edgeExists(ids[0]!, ids[1]!)).toBe(true);
          expect(await originItemIds(cardId)).toEqual([]);
        },
      );

      tenantIt("applies no step when a later reversal fails, and applies all of them once it can", async () => {
        const areaId = await createIn(await databaseIdFor("areas"), { name: "Area" });
        const projectsDb = await databaseIdFor("projects");
        const projectId = await createIn(projectsDb, { name: "Project" });
        const otherId = await createIn(projectsDb, { name: "Old restore" });
        const cardId = await createCardWith(
          stepsEnvelope(await databaseIdFor("companies"), [
            { ref: "company", op: "create", databaseKey: "companies", role: "primary", properties: { name: "Acme" } },
            { ref: "link", op: "link", itemId: projectId, role: "secondary", relations: { area: [areaId] } },
            {
              ref: "other",
              op: "update",
              itemId: otherId,
              role: "secondary",
              properties: { name: "New" },
              before: { properties: { name: "Old restore" } },
              after: { properties: { name: "New" } },
            },
          ]),
        );
        await confirmCard(cardId);
        // Fault injection: the write that restores the second step's value fails, after the first reversal deleted its edge.
        await pool.query(`CREATE FUNCTION fail_restore() RETURNS trigger LANGUAGE plpgsql AS
          $$ BEGIN RAISE EXCEPTION 'injected failure of the second reversal'; END $$`);
        await pool.query(`CREATE TRIGGER fail_restore BEFORE UPDATE ON items FOR EACH ROW
          WHEN (NEW.properties->>'name' = 'Old restore') EXECUTE FUNCTION fail_restore()`);
        try {
          const before = await writtenState();
          const card = await storedCard(cardId);

          await expect(callReopen(cardId)).rejects.toThrow(/injected failure/);

          expect(await writtenState()).toEqual(before);
          expect(await storedCard(cardId)).toEqual(card);
          expect(await edgeExists(projectId, areaId)).toBe(true);
          expect((await anyItem(otherId)).properties.name).toBe("New");
        } finally {
          await pool.query("DROP TRIGGER fail_restore ON items");
          await pool.query("DROP FUNCTION fail_restore()");
        }

        const { item } = await reopenCard(cardId);

        expect(item.properties.status).toBe("proposed");
        expect(await edgeExists(projectId, areaId)).toBe(false);
        expect((await anyItem(otherId)).properties.name).toBe("Old restore");
      });
    });

    describe("an Inbox attachment moved into Files", () => {
      async function listInboxAttachmentIds(inboxItemId: string): Promise<string[]> {
        const rows = await withTransaction(pool, (client) => listInboxAttachments(client, [inboxItemId]));
        return rows.map((row) => row.attachmentId);
      }

      async function cardWithAttachmentMove(): Promise<{ cardId: string; inboxItemId: string }> {
        const { blobId } = await newFileValue();
        let attachmentId = "";
        // The attachment exists when the tick reads the item, as it does for a capture.
        const cardId = await createDatabaseProposal("Pay the invoice", async (itemId) => {
          attachmentId = await attachBlob(itemId, blobId);
        });
        const inboxItemId = await onlyInboxItemId();
        const envelope = stepsEnvelope(tasksId, [
          { ref: "task", op: "create", databaseKey: "tasks", role: "primary", properties: { name: "Pay the invoice" } },
          { ref: "file", op: "fileFromAttachment", role: "secondary", properties: { attachmentId, name: "Invoice" } },
        ]);
        await patchCard(cardId, { proposal: envelope, aiProposal: envelope });
        return { cardId, inboxItemId };
      }

      tenantIt("reverses the other steps, keeps the Files item live and lists it in keptItems", async () => {
        const { cardId, inboxItemId } = await cardWithAttachmentMove();
        const confirmed = await confirmCard(cardId);
        const results = readConfirmationResults(confirmed.properties);
        const filesDatabaseId = await databaseIdFor("files");
        const taskId = results.find((result) => result.ref === "task")!.itemId;
        const fileId = results.find((result) => result.ref === "file")!.itemId;
        expect(await listInboxAttachmentIds(inboxItemId)).toEqual([]);
        // The Files item is not part of the precondition: an edit after the confirmation does not refuse the undo.
        await withTransaction(pool, (client) =>
          updateItemWithClient(client, {
            databaseId: filesDatabaseId,
            itemId: fileId,
            propertiesPatch: { name: "Renamed invoice" },
          }),
        );

        const { item, keptItems } = await reopenCard(cardId);

        expect(item.properties.status).toBe("proposed");
        expect(keptItems).toEqual([
          { itemId: fileId, databaseKey: "files", label: "Invoice", reason: "attachmentMovedToFiles" },
        ]);
        expect((await anyItem(taskId)).deletedAt).not.toBeNull();
        const file = await anyItem(fileId);
        expect(file.deletedAt).toBeNull();
        expect(file.properties.name).toBe("Renamed invoice");
        // The file keeps its origin row; the task's is gone. The move has no reverse, so the attachment stays moved.
        expect(await originItemIds(cardId)).toEqual([fileId]);
        expect(await listInboxAttachmentIds(inboxItemId)).toEqual([]);
      });

      tenantIt("does not list a kept Files item that the user has since moved to the trash", async () => {
        const { cardId } = await cardWithAttachmentMove();
        const confirmed = await confirmCard(cardId);
        const fileId = readConfirmationResults(confirmed.properties).find((result) => result.ref === "file")!.itemId;
        const filesDatabaseId = await databaseIdFor("files");
        await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, filesDatabaseId, fileId));

        const { keptItems } = await reopenCard(cardId);

        expect(keptItems).toEqual([]);
      });
    });

    tenantIt("removes the credential stored for a created MCP server, and trashes the server", async () => {
      const cardId = await createDatabaseProposal("seed");
      const envelope = {
        entityKind: "database",
        target: await databaseIdFor("mcpServers"),
        properties: { name: "Remote tool", connectionConfig: { transport: "sse", url: "https://mcp.example.com/sse" } },
      };
      await patchCard(cardId, { proposal: envelope, aiProposal: envelope });
      const confirmed = await confirmCard(cardId, { credential: { credentialType: "api_key", plaintext: "sk-test" } });
      const serverId = z.string().parse(confirmed.properties.resultItemId);
      expect(await withTransaction(pool, (client) => hasCredential(client, serverId))).toBe(true);

      await reopenCard(cardId);

      expect(await withTransaction(pool, (client) => hasCredential(client, serverId))).toBe(false);
      expect((await anyItem(serverId)).deletedAt).not.toBeNull();
    });

    it.each<[string, boolean, Record<string, unknown>, Record<string, unknown>]>([
      [
        "that recorded no results",
        false,
        { status: "confirmed" },
        { status: 400, code: "validation_failed", details: { field: "results" } },
      ],
      [
        "with no stored envelope",
        true,
        { proposal: null },
        { status: 400, code: "validation_failed", details: { field: "proposal" } },
      ],
      [
        "whose envelope has an entityKind this release does not know",
        true,
        { proposal: { entityKind: "futureKind", target: "x", properties: {} } },
        { status: 409, details: { field: "entityKind" } },
      ],
    ])("refuses a confirmed card %s, and changes nothing", (_name, confirmFirst, patch, refusal) =>
      inTenant(async () => {
        const cardId = await createDatabaseProposal("Buy milk");
        if (confirmFirst) await confirmCard(cardId);
        await patchCard(cardId, patch);
        const before = await storedCard(cardId);

        await expect(callReopen(cardId)).rejects.toMatchObject(refusal);

        expect(await storedCard(cardId)).toEqual(before);
      }),
    );
  });

  describe("ifVersion on confirm and reject", () => {
    const handlers = { confirm: createConfirmProposalRouteHandler, reject: createRejectProposalRouteHandler } as const;
    type Action = keyof typeof handlers;
    const ACTIONS: Action[] = ["confirm", "reject"];
    const TERMINAL_STATUS: Record<Action, string> = { confirm: "confirmed", reject: "rejected" };

    async function writtenState(cardId: string): Promise<{ items: string[]; jobs: number; card: ItemRow }> {
      const items = await pool.query<{ id: string; updated_at: Date }>("SELECT id, updated_at FROM items ORDER BY id");
      const jobs = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM graphile_worker.jobs");
      return {
        items: items.rows.map((row) => `${row.id} ${row.updated_at.toISOString()}`),
        jobs: jobs.rows[0]!.n,
        card: await storedCard(cardId),
      };
    }

    function call(action: Action, cardId: string, body: Record<string, unknown>) {
      return handlers[action](pool)({ params: { id: cardId }, body });
    }

    it.each(ACTIONS)(
      "%s: a stale ifVersion on an open card answers 409 with the card and writes nothing",
      async (action) => {
        const cardId = await createDatabaseProposal("Buy milk");
        const before = await writtenState(cardId);

        await expect(call(action, cardId, { ifVersion: STALE_VERSION })).rejects.toMatchObject({
          status: 409,
          code: "version_conflict",
          details: { current: { id: cardId, updatedAt: before.card.updatedAt } },
        });

        expect(await writtenState(cardId)).toEqual(before);
        expect(before.card.properties.status).toBe("proposed");
      },
    );

    it.each(ACTIONS)("%s: the current ifVersion of an open card succeeds", async (action) => {
      const cardId = await createDatabaseProposal("Buy milk");
      const { version } = await storedCard(cardId);

      const item = itemOf(await call(action, cardId, { ifVersion: version }));

      expect(item.properties.status).toBe(TERMINAL_STATUS[action]);
      expect((await storedCard(cardId)).properties.status).toBe(TERMINAL_STATUS[action]);
    });

    it.each(ACTIONS)(
      "%s: a stale ifVersion on a card already in the terminal state answers 200 unchanged",
      async (action) => {
        const cardId = await createDatabaseProposal("Buy milk");
        await call(action, cardId, {});
        const before = await writtenState(cardId);

        const item = itemOf(await call(action, cardId, { ifVersion: STALE_VERSION }));

        expect(item.properties).toEqual(before.card.properties);
        expect(item.updatedAt).toBe(before.card.updatedAt);
        expect(await writtenState(cardId)).toEqual(before);
      },
    );

    it.each(ACTIONS)("%s: without an ifVersion an open card is decided as before", async (action) => {
      const cardId = await createDatabaseProposal("Buy milk");

      const item = itemOf(await call(action, cardId, {}));

      expect(item.properties.status).toBe(TERMINAL_STATUS[action]);
    });

    it.each(ACTIONS)("%s: an unknown card answers 404 before the version is compared", async (action) => {
      await expect(call(action, randomUUID(), { ifVersion: STALE_VERSION })).rejects.toBeInstanceOf(NotFoundError);
    });

    it.each([
      ["confirm", "reject", "rejected"],
      ["reject", "confirm", "confirmed"],
    ] as const)(
      "%s: a card that is %sed answers 400 on status with its current status, also with a stale ifVersion",
      async (action, decided, currentStatus) => {
        const cardId = await createDatabaseProposal("Buy milk");
        await call(decided, cardId, {});
        const before = await writtenState(cardId);

        for (const body of [{}, { ifVersion: STALE_VERSION }]) {
          await expect(call(action, cardId, body)).rejects.toMatchObject({
            status: 400,
            code: "validation_failed",
            details: { field: "status", currentStatus },
          });
        }
        expect(await writtenState(cardId)).toEqual(before);
      },
    );

    it("confirm: a card that needs clarification answers 400 on status with its current status", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      await patchCard(cardId, { status: "needsClarification" });
      const { version } = await storedCard(cardId);

      await expect(call("confirm", cardId, { ifVersion: version })).rejects.toMatchObject({
        status: 400,
        code: "validation_failed",
        details: { field: "status", currentStatus: "needsClarification" },
      });
    });

    it("confirm: a card without a stored status answers 400 on status with a null current status", async () => {
      const cardId = await withTransaction(pool, async (client) => {
        const card = await createItemWithClient(
          client,
          { databaseId: proposalsId, properties: { kind: "inbox", proposal: null } },
          { allowedSystemKeys: ["kind", "proposal"] },
        );
        return card.id;
      });

      await expect(call("confirm", cardId, {})).rejects.toMatchObject({
        status: 400,
        details: { field: "status", currentStatus: null },
      });
    });

    it.each(ACTIONS)("%s: a malformed ifVersion answers 400 on the field and writes nothing", async (action) => {
      const cardId = await createDatabaseProposal("Buy milk");
      const before = await writtenState(cardId);

      for (const ifVersion of [7, null, "", "yesterday", "2026-08-28", ["2026-08-28T09:00:00.000Z"]]) {
        await expect(call(action, cardId, { ifVersion })).rejects.toMatchObject({
          status: 400,
          code: "validation_failed",
          details: { field: "ifVersion" },
        });
      }
      expect(await writtenState(cardId)).toEqual(before);
    });
  });

  describe("createReviseProposalRouteHandler", () => {
    let dataPool: Pool;
    let eventsId: string;
    let peopleId: string;

    beforeEach(async () => {
      dataPool = createDataPool();
      eventsId = await databaseIdFor("events");
      peopleId = await databaseIdFor("people");
    });

    afterEach(async () => {
      await dataPool.end();
    });

    function callRevise(cardId: string, body: unknown, identity?: { user: { id: string } }) {
      return inTenant(() =>
        createReviseProposalRouteHandler(dataPool)({ params: { id: cardId }, body, ...(identity ? { identity } : {}) }),
      );
    }

    async function readCard(cardId: string): Promise<ItemRow> {
      const card = await inTenant(() =>
        withTransaction(dataPool, (client) => itemsStore.getItemById(client, proposalsId, cardId)),
      );
      if (!card) throw new Error(`Card ${cardId} not found`);
      return card;
    }

    const createEvent = (name: string) => createIn(eventsId, { name, type: "meeting", date: EVENT_DATE });
    const createEventCard = async () => (await createUnmatchedTranscriptCard()).cardId;

    it("runs through the runtime role, which neither bypasses row-level security nor is a superuser", async () => {
      await expectRuntimeRole(dataPool);
    });

    it("revises a transcript Event card to another live Event without a message", async () => {
      const cardId = await createEventCard();
      const eventId = await createEvent("Planning");
      const before = await readCard(cardId);

      const response = await callRevise(cardId, linkEvent(eventId));

      expect(response.status).toBe(200);
      if (!("item" in response)) throw new Error("Missing item result");
      expect(response.item.properties.proposal).toEqual(linkEvent(eventId));
      expect(response.item.properties.status).toBe("proposed");
      const history = historyOf(response.item);
      expect(history).toHaveLength(historyOf(before).length + 1);
      expect(history[history.length - 1]).toMatchObject({ author: "user", message: "Revised by user." });
      expect((await readCard(cardId)).properties).toEqual(response.item.properties);
    });

    it("revises a new-item card to other values with the message as its history entry", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      const tasksId = await databaseIdFor("tasks");

      const response = await callRevise(cardId, {
        entityKind: "database",
        target: tasksId,
        properties: { name: "Buy oat milk" },
        message: "Oat, not cow",
      });

      if (!("item" in response)) throw new Error("Missing item result");
      expect(response.item.properties.proposal).toEqual({
        entityKind: "database",
        target: tasksId,
        properties: { name: "Buy oat milk" },
      });
      expect(historyOf(response.item).pop()).toMatchObject({ author: "user", message: "Oat, not cow" });
    });

    it("records a message alone on a transcript card and leaves its proposal and status untouched", async () => {
      const cardId = await createEventCard();
      const before = await readCard(cardId);

      const response = await callRevise(cardId, { message: "It was the planning meeting" });

      expect(response.status).toBe(200);
      if (!("item" in response)) throw new Error("Missing item result");
      const { history: historyBefore, ...restBefore } = before.properties;
      const { history: historyAfter, ...restAfter } = response.item.properties;
      expect(restAfter).toEqual(restBefore);
      expect(historyAfter).toEqual([
        ...(historyBefore as unknown[]),
        { id: expect.any(String), author: "user", message: "It was the planning meeting", at: expect.any(String) },
      ]);
      expect((await readCard(cardId)).properties).toEqual(response.item.properties);
    });

    it("refuses a message alone on an inbox card with validation_failed on message and writes nothing", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      const before = await readCard(cardId);

      await expect(callRevise(cardId, { message: "Make it oat milk" })).rejects.toMatchObject({
        status: 400,
        code: "validation_failed",
        details: { field: "message" },
      });

      expect(await readCard(cardId)).toEqual(before);
    });

    it.each([
      ["entityKind alone", { entityKind: "database" }, "target"],
      ["target alone", { target: "00000000-0000-0000-0000-000000000000" }, "entityKind"],
      ["properties alone", { properties: { name: "x" } }, "entityKind"],
      ["entityKind and target", { entityKind: "database", target: "t" }, "properties"],
      ["target and properties", { target: "t", properties: {} }, "entityKind"],
      ["a message and a partial envelope", { message: "Fix it", entityKind: "database", properties: {} }, "target"],
    ])("refuses a partial envelope (%s) and writes nothing", async (_name, body, field) => {
      const cardId = await createEventCard();
      const before = await readCard(cardId);

      await expect(callRevise(cardId, body)).rejects.toMatchObject({
        status: 400,
        code: "validation_failed",
        details: { field },
      });

      expect(await readCard(cardId)).toEqual(before);
    });

    it.each([
      ["an empty object", {}],
      ["only ifVersion", { ifVersion: "2026-01-01T00:00:00.000Z" }],
      ["null", null],
      ["an array", []],
      ["a string", "revise"],
    ])("refuses a body that is %s", async (_name, body) => {
      const cardId = await createEventCard();
      const before = await readCard(cardId);

      await expect(callRevise(cardId, body)).rejects.toMatchObject({ status: 400, code: "validation_failed" });

      expect(await readCard(cardId)).toEqual(before);
    });

    it.each([
      ["an unknown key", { message: "x", status: "confirmed" }, "status"],
      ["relations, which the route does not take", { message: "x", relations: {} }, "relations"],
      ["a message that is not a string", { message: 5 }, "message"],
      ["an empty message", { message: "" }, "message"],
      ["a message over the cap", { message: "x".repeat(2001) }, "message"],
      ["an ifVersion that is not a string", { message: "x", ifVersion: 5 }, "ifVersion"],
      ["an empty ifVersion", { message: "x", ifVersion: "" }, "ifVersion"],
      ["a message with a NUL character", { message: "a\u0000b" }, "message"],
      ["an ifVersion with a NUL character", { message: "x", ifVersion: "2026\u0000" }, "ifVersion"],
      ["a target with a NUL character", { entityKind: "database", target: "t\u0000", properties: {} }, "target"],
      [
        "properties with a NUL character in a value",
        { entityKind: "database", target: "t", properties: { name: "a\u0000b" } },
        "properties",
      ],
      [
        "properties with a NUL character in a key",
        { entityKind: "database", target: "t", properties: { "na\u0000me": "x" } },
        "properties",
      ],
      [
        "properties with a NUL character in a nested array",
        { entityKind: "database", target: "t", properties: { tags: [["ok"], { deep: "a\u0000" }] } },
        "properties",
      ],
      ["an entityKind that is not a string", { entityKind: 5, target: "t", properties: {} }, "entityKind"],
      ["an unknown entityKind", { entityKind: "bogus", target: "t", properties: {} }, "entityKind"],
      ["an empty target", { entityKind: "database", target: "", properties: {} }, "target"],
      ["properties that are an array", { entityKind: "database", target: "t", properties: [] }, "properties"],
      ["properties that are null", { entityKind: "database", target: "t", properties: null }, "properties"],
    ])("refuses %s", async (_name, body, field) => {
      const cardId = await createEventCard();
      const before = await readCard(cardId);

      await expect(callRevise(cardId, body)).rejects.toMatchObject({
        status: 400,
        code: "validation_failed",
        details: { field },
      });

      expect(await readCard(cardId)).toEqual(before);
    });

    it("accepts a message of exactly the cap", async () => {
      const cardId = await createEventCard();

      const response = await callRevise(cardId, { message: "x".repeat(2000) });

      expect(response.status).toBe(200);
    });

    it("refuses a confirmed or rejected card with validation_failed on status and writes nothing", async () => {
      const rejectedId = await createEventCard();
      await inTenant(() =>
        withTransaction(dataPool, (client) =>
          rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, rejectedId),
        ),
      );
      const confirmedId = await createDatabaseProposal("Buy milk");
      await inTenant(() =>
        withTransaction(dataPool, (client) =>
          confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, confirmedId),
        ),
      );
      const eventId = await createEvent("Planning");

      for (const [cardId, body] of [
        [rejectedId, linkEvent(eventId)],
        [confirmedId, { entityKind: "database", target: await databaseIdFor("tasks"), properties: { name: "x" } }],
        [rejectedId, { message: "Reconsider" }],
      ] as const) {
        const before = await readCard(cardId);
        await expect(callRevise(cardId, body)).rejects.toMatchObject({
          status: 400,
          code: "validation_failed",
          details: { field: "status" },
        });
        expect(await readCard(cardId)).toEqual(before);
      }
    });

    it("refuses a speaker-mapping card revised into an Event proposal and writes nothing", async () => {
      const { cardId, personId } = await createSpeakerCard();
      const eventId = await createEvent("Planning");
      const before = await readCard(cardId);
      expect(before.properties.proposal).toMatchObject({ entityKind: "relation", target: personId });

      for (const body of [
        linkEvent(eventId),
        { entityKind: "database", target: eventsId, properties: { name: "Planning", date: EVENT_DATE } },
      ]) {
        await expect(callRevise(cardId, body)).rejects.toMatchObject({
          status: 400,
          code: "validation_failed",
          details: { field: "entityKind" },
        });
      }

      expect(await readCard(cardId)).toEqual(before);
    });

    it("revises a speaker-mapping card to another person", async () => {
      const { cardId } = await createSpeakerCard();
      const other = await createIn(peopleId, { name: "Bob" });
      const envelope = {
        entityKind: "relation",
        target: other,
        properties: { propertyKey: "speakers", metadata: { speaker: "SPEAKER_01" } },
      };

      const response = await callRevise(cardId, envelope);

      if (!("item" in response)) throw new Error("Missing item result");
      expect(response.item.properties.proposal).toEqual(envelope);
      expect(response.item.properties.status).toBe("proposed");
    });

    it("applies an ifVersion that equals the card's version", async () => {
      const cardId = await createEventCard();
      const eventId = await createEvent("Planning");
      const card = await readCard(cardId);

      const response = await callRevise(cardId, { ...linkEvent(eventId), ifVersion: card.version });

      expect(response.status).toBe(200);
    });

    it("answers a stale ifVersion with version_conflict carrying the current card and writes nothing", async () => {
      const cardId = await createEventCard();
      const eventId = await createEvent("Planning");
      const stale = (await readCard(cardId)).version;
      await callRevise(cardId, { message: "A first note" });
      const current = await readCard(cardId);
      expect(current.version).not.toBe(stale);

      const error = await callRevise(cardId, { ...linkEvent(eventId), ifVersion: stale }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({ status: 409, code: "version_conflict", details: { current } });
      expect(await readCard(cardId)).toEqual(current);
    });

    it("answers an unknown id, an id of another database and a trashed card alike with not found", async () => {
      const cardId = await createEventCard();
      const eventId = await createEvent("Planning");
      await inTenant(() =>
        withTransaction(dataPool, (client) => itemsStore.softDeleteItem(client, proposalsId, cardId)),
      );

      for (const id of [randomUUID(), eventId, cardId]) {
        const error = await failureOf(callRevise(id, { message: "Note" }));
        expect(error).toBeInstanceOf(NotFoundError);
        expect(error).toMatchObject({ status: 404, code: "not_found" });
      }
    });

    it("addresses realtime invalidation to the authenticated user", async () => {
      const cardId = await createEventCard();
      const userId = randomUUID();

      const events = await itemInvalidations(() => callRevise(cardId, { message: "Note" }, { user: { id: userId } }));

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events.every((event) => event.userId === userId)).toBe(true);
    });
  });

  describe("createUpdateProposalValuesRouteHandler", () => {
    it("edits the card, a thin mapping onto updateProposalValuesWithClient", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");

      const result = await updateValues(proposalId, { set: { primary: { name: "Buy oat milk" } } });

      expect(result).toMatchObject({ status: 200, warnings: [] });
      expect(itemOf(result).id).toBe(proposalId);
      expect(itemOf(result).properties.userEditedKeys).toEqual(["primary.name"]);
      expect((await storedCard(proposalId)).properties.proposal).toMatchObject({
        properties: { name: "Buy oat milk" },
      });
    });

    it("answers a required warning for a field the edit left empty, and saves the card", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");

      const result = await updateValues(proposalId, { set: { primary: { name: "" } } });

      expect(result).toMatchObject({ status: 200, warnings: [{ field: "name", code: "required" }] });
      expect((await storedCard(proposalId)).properties.proposal).toMatchObject({ properties: { name: "" } });
    });

    it.each([
      ["a null body", null, undefined],
      ["an array body", [], undefined],
      ["a string body", "set", undefined],
      ["a body without set", {}, "set"],
      ["a null set", { set: null }, "set"],
      ["an array set", { set: [] }, "set"],
      ["a null ref value", { set: { primary: null } }, "set"],
      ["an array ref value", { set: { primary: [] } }, "set"],
      ["a string ref value", { set: { primary: "Buy oat milk" } }, "set"],
      ["a numeric ifVersion", { set: { primary: { name: "x" } }, ifVersion: 5 }, "ifVersion"],
      ["a null ifVersion", { set: { primary: { name: "x" } }, ifVersion: null }, "ifVersion"],
      ["a null relations", { relations: null }, "relations"],
      ["an array relations", { relations: [] }, "relations"],
      ["a string relations ref value", { relations: { primary: "p" } }, "relations"],
      ["an array relations ref value", { relations: { primary: [] } }, "relations"],
      ["a relation list that is not an array", { relations: { primary: { project: PROJECT_ID } } }, "relations"],
      ["a relation id that is not a string", { relations: { primary: { project: [5] } } }, "relations"],
      ["a relation id that is not a UUID", { relations: { primary: { project: ["not-an-id"] } } }, "relations"],
      [
        "a relation list over the cap",
        { relations: { primary: { project: Array.from({ length: 201 }, () => PROJECT_ID) } } },
        "relations",
      ],
      ["a null steps", { steps: null }, "steps"],
      ["an array steps", { steps: [] }, "steps"],
      ["a string steps ref value", { steps: { followup: "off" } }, "steps"],
      ["a step without enabled", { steps: { followup: {} } }, "steps"],
      ["a step whose enabled is not a boolean", { steps: { followup: { enabled: "no" } } }, "steps"],
      ["a step with another key beside enabled", { steps: { followup: { enabled: true, name: "x" } } }, "steps"],
    ])("rejects %s with a ValidationError and writes nothing", async (_label, body, field) => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const before = await storedCard(proposalId);

      const error = await failureOf(updateValues(proposalId, body));

      expect(error).toBeInstanceOf(ValidationError);
      if (field !== undefined) expect(error).toHaveProperty("details.field", field);
      expect(await storedCard(proposalId)).toEqual(before);
    });

    it("edits relation lists and step switches, a thin mapping onto updateProposalValuesWithClient", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const projectId = await createIn(await databaseIdFor("projects"), { name: "Shopping" });

      const result = await updateValues(proposalId, { relations: { primary: { project: [projectId] } } });

      expect(result).toMatchObject({ status: 200, warnings: [] });
      expect(itemOf(result).properties.userEditedKeys).toEqual(["primary.relations.project"]);
      expect(itemOf(result).properties.proposal).toMatchObject({ relations: { project: [projectId] } });
    });

    it.each([
      [
        "to switch the primary step off",
        { steps: { primary: { enabled: false } } },
        { ref: "primary", field: "enabled" },
      ],
      ["a reserved key in set", { set: { primary: { enabled: false } } }, { ref: "primary", field: "enabled" }],
      [
        "a relation list for a ref the card does not have",
        { relations: { followup: { project: [PROJECT_ID] } } },
        { ref: "followup", field: "followup" },
      ],
      [
        "a step switch for a ref the card does not have",
        { steps: { followup: { enabled: false } } },
        { ref: "followup", field: "followup" },
      ],
    ])("refuses %s with a ValidationError naming it, and writes nothing", async (_label, body, details) => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const before = await storedCard(proposalId);

      const error = await failureOf(updateValues(proposalId, body));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toHaveProperty("details", details);
      expect(await storedCard(proposalId)).toEqual(before);
    });

    it("passes a ref named like an Object member in set, relations and steps on as data and refuses it as an unknown ref", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const before = await storedCard(proposalId);

      for (const json of [
        '{"set":{"__proto__":{"name":"x"}}}',
        `{"relations":{"__proto__":{"project":["${PROJECT_ID}"]}}}`,
        '{"steps":{"__proto__":{"enabled":false}}}',
      ]) {
        const body: unknown = JSON.parse(json);
        await expect(updateValues(proposalId, body)).rejects.toThrow(/no step '__proto__'/);
      }
      expect(await storedCard(proposalId)).toEqual(before);
    });

    describe("with an Idempotency-Key", () => {
      const userId = randomUUID();
      const keyed = (key: string, user = userId) => ({
        req: { headers: { "idempotency-key": key } },
        identity: { user: { id: user } },
      });
      const keyedUpdate = (
        cardId: string,
        name: string,
        key: string,
        extra: Record<string, unknown> = {},
        user = userId,
      ) => inTenant(() => updateValues(cardId, { set: { primary: { name } }, ...extra }, keyed(key, user)));
      const storedRowCount = async (): Promise<number> => {
        const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM idempotent_responses");
        return rows[0]?.n ?? -1;
      };
      const userEdits = async (cardId: string): Promise<number> =>
        z
          .array(z.object({ kind: z.string().optional() }))
          .parse((await storedCard(cardId)).properties.history)
          .filter((entry) => entry.kind === "userEdit").length;

      it.each([
        ["the same card", "Buy oat milk", []],
        ["the required warnings of the first call", "", [{ field: "name", code: "required" }]],
      ])("applies the edit once and answers %s to a repeat of the key", async (_label, name, warnings) => {
        const proposalId = await createDatabaseProposal("Buy milk");

        const first = await keyedUpdate(proposalId, name, "key-1");
        const second = await keyedUpdate(proposalId, name, "key-1");

        expect(first).toMatchObject({ status: 200, warnings });
        expect(second).toEqual(first);
        expect(itemOf(second).id).toBe(proposalId);
        expect(await userEdits(proposalId)).toBe(1);
        expect(await storedRowCount()).toBe(1);
      });

      it("runs the edit again for another user of the tenant with the same key", async () => {
        const proposalId = await createDatabaseProposal("Buy milk");
        await keyedUpdate(proposalId, "First", "key-1");

        await keyedUpdate(proposalId, "Second", "key-1", {}, randomUUID());

        expect(await userEdits(proposalId)).toBe(2);
        expect((await storedCard(proposalId)).properties.proposal).toMatchObject({ properties: { name: "Second" } });
        expect(await storedRowCount()).toBe(2);
      });

      it("refuses the key of another body, of another card and one over 255 characters, and applies nothing", async () => {
        const proposalId = await createDatabaseProposal("Buy milk");
        const otherId = await createDatabaseProposal("Buy bread");
        await keyedUpdate(proposalId, "A", "key-1");
        const before = [await storedCard(proposalId), await storedCard(otherId)];

        for (const attempt of [
          () => keyedUpdate(proposalId, "B", "key-1"),
          () => keyedUpdate(otherId, "A", "key-1"),
          () => keyedUpdate(proposalId, "x", "k".repeat(256)),
        ]) {
          const error = await failureOf(attempt());
          expect(error).toBeInstanceOf(ValidationError);
          expect(error).toHaveProperty("details.field", "Idempotency-Key");
        }
        expect([await storedCard(proposalId), await storedCard(otherId)]).toEqual(before);
      });

      it("stores nothing for a request without the header, nor for a refused update, so the key can be used again", async () => {
        const proposalId = await createDatabaseProposal("Buy milk");
        const stale = (await storedCard(proposalId)).version;
        await updateValues(proposalId, { set: { primary: { name: "First" } } });
        expect(await storedRowCount()).toBe(0);

        await expect(keyedUpdate(proposalId, "Second", "key-1", { ifVersion: stale })).rejects.toThrow(ConflictError);
        expect(await storedRowCount()).toBe(0);

        const retried = await keyedUpdate(proposalId, "Second", "key-1", {
          ifVersion: (await storedCard(proposalId)).version,
        });
        expect(retried.status).toBe(200);
        expect(await storedRowCount()).toBe(1);
      });

      it("fails a keyed request that carries no authenticated user, and applies nothing", async () => {
        const proposalId = await createDatabaseProposal("Buy milk");
        const before = await storedCard(proposalId);

        await expect(
          inTenant(() =>
            updateValues(
              proposalId,
              { set: { primary: { name: "x" } } },
              { req: { headers: { "idempotency-key": "key-1" } } },
            ),
          ),
        ).rejects.toThrow("needs the authenticated user");

        expect(await storedCard(proposalId)).toEqual(before);
      });

      it("fails when the stored response is not a card, instead of answering it", async () => {
        const proposalId = await createDatabaseProposal("Buy milk");
        const body = { set: { primary: { name: "Buy oat milk" } } };
        // Fixture SQL: a stored response the store never writes for this route.
        await pool.query(
          `INSERT INTO idempotent_responses (tenant_id, user_id, key, route, request_hash, status, body, expires_at)
           VALUES ($1, $2, 'key-1', 'PATCH /api/proposals/:id/values', $3, 200, '{"unexpected":true}'::jsonb,
                   now() + interval '1 hour')`,
          [getTenantZeroId(), userId, hashIdempotentRequest({ proposalId, body })],
        );

        await expect(inTenant(() => updateValues(proposalId, body, keyed("key-1")))).rejects.toThrow(z.ZodError);
      });
    });
  });

  describe("createResetProposalOverridesRouteHandler", () => {
    const reset = (cardId: string) =>
      createResetProposalOverridesRouteHandler(pool)({ params: { id: cardId }, body: {} });

    it("returns the card to the assistant's proposal, a thin mapping onto resetProposalOverridesWithClient", async () => {
      const proposalId = await editedCard();

      const result = await reset(proposalId);

      expect(result.status).toBe(200);
      expect(itemOf(result).id).toBe(proposalId);
      expect(itemOf(result).properties.userEditedKeys).toEqual([]);
      const stored = await storedCard(proposalId);
      expect(stored.properties.proposal).toMatchObject({ properties: { name: "Buy milk" } });
      expect(stored.properties.userOverrides).toEqual({});
    });

    it("answers a card with nothing edited unchanged", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const before = await storedCard(proposalId);

      const result = await reset(proposalId);

      expect(result.status).toBe(200);
      expect(itemOf(result)).toEqual(before);
      expect(await storedCard(proposalId)).toEqual(before);
    });

    it("refuses a confirmed card with a ValidationError and writes nothing", async () => {
      const proposalId = await editedCard();
      await withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposalId),
      );
      const before = await storedCard(proposalId);

      const error = await failureOf(reset(proposalId));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toHaveProperty("details.field", "status");
      expect(await storedCard(proposalId)).toEqual(before);
    });
  });

  describe("createRecomputeProposalRouteHandler", () => {
    const recompute = (cardId: string, extra: Partial<RouteContext> = {}) =>
      createRecomputeProposalRouteHandler(pool)({ params: { id: cardId }, body: {}, ...extra });

    it("sends the card back to the tick, a thin mapping onto recomputeProposalWithClient", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const before = await storedCard(proposalId);

      const result = await recompute(proposalId);

      expect(result.status).toBe(200);
      expect(itemOf(result).id).toBe(proposalId);
      expect(itemOf(result).properties.status).toBe("computing");
      const stored = await storedCard(proposalId);
      expect(stored.properties).toMatchObject({ status: "computing", proposal: before.properties.proposal });
      expect(historyOf(stored).at(-1)).toMatchObject({ kind: "recompute" });
    });

    it("answers a card that is computing already unchanged", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      await recompute(proposalId);
      const before = await storedCard(proposalId);

      const result = await recompute(proposalId);

      expect(result.status).toBe(200);
      expect(itemOf(result)).toEqual(before);
      expect(await storedCard(proposalId)).toEqual(before);
    });

    it("refuses a confirmed card with the 409 proposal_locked and writes nothing", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      await withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposalId),
      );
      const before = await storedCard(proposalId);

      expect(await failureOf(recompute(proposalId))).toMatchObject({ status: 409, code: "proposal_locked" });
      expect(await storedCard(proposalId)).toEqual(before);
    });

    it("addresses the invalidation of the card write to the caller", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const userId = randomUUID();

      const events = await itemInvalidations(() => recompute(proposalId, { identity: { user: { id: userId } } }));

      const cardEvents = events.filter((event) => event.itemId === proposalId);
      expect(cardEvents).toHaveLength(1);
      expect(cardEvents[0]).toMatchObject({ op: "update", userId });
    });

    it("rejects an id that is no UUID with a ValidationError on id", async () => {
      const error = await failureOf(recompute("not-a-uuid"));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toHaveProperty("details.field", "id");
    });
  });

  describe("the card routes", () => {
    const CARD_ROUTES = [
      ["confirm", createConfirmProposalRouteHandler, {}],
      ["reject", createRejectProposalRouteHandler, {}],
      ["reopen", createReopenProposalRouteHandler, {}],
      ["revise", createReviseProposalRouteHandler, { message: "x" }],
      ["update", createUpdateProposalValuesRouteHandler, { set: { primary: { name: "x" } } }],
      ["reset", createResetProposalOverridesRouteHandler, {}],
      ["recompute", createRecomputeProposalRouteHandler, {}],
    ] as const;
    const EDIT_ROUTES = CARD_ROUTES.filter(([name]) => ["update", "reset", "recompute"].includes(name));

    it.each(CARD_ROUTES)(
      "%s: refuses a missing id with a ValidationError, and answers 404 for an unknown card and one in the Trash",
      async (_name, factory, body) => {
        const handler = factory(pool);
        const trashedId = await createDatabaseProposal("Buy milk");
        await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, proposalsId, trashedId));

        await expect(handler({ params: {}, body })).rejects.toThrow(ValidationError);
        for (const id of [randomUUID(), trashedId]) {
          await expect(inTenant(() => handler({ params: { id }, body }))).rejects.toBeInstanceOf(NotFoundError);
        }
      },
    );

    it.each(EDIT_ROUTES)(
      "%s: answers a stale ifVersion with a version conflict that carries the current card and writes nothing, and applies the current one",
      async (_name, factory, body) => {
        const proposalId = await createDatabaseProposal("Buy milk");
        const stale = (await storedCard(proposalId)).version;
        await updateValues(proposalId, { set: { primary: { name: "First" } } });
        const before = await storedCard(proposalId);

        const error = await failureOf(
          factory(pool)({ params: { id: proposalId }, body: { ...body, ifVersion: stale } }),
        );

        expect(error).toBeInstanceOf(ConflictError);
        expect(error).toMatchObject({
          status: 409,
          code: "version_conflict",
          details: { current: { id: proposalId } },
        });
        expect(await storedCard(proposalId)).toEqual(before);
        const applied = await factory(pool)({
          params: { id: proposalId },
          body: { ...body, ifVersion: before.version },
        });
        expect(applied.status).toBe(200);
      },
    );

    it.each([
      ["reset", createResetProposalOverridesRouteHandler, { userEditedKeys: [] }],
      ["recompute", createRecomputeProposalRouteHandler, { status: "computing" }],
    ] as const)("%s: takes a null body as an empty one", async (_name, factory, expected) => {
      const proposalId = await editedCard();

      expect((await factory(pool)({ params: { id: proposalId }, body: null })).status).toBe(200);

      expect((await storedCard(proposalId)).properties).toMatchObject(expected);
    });

    const MALFORMED_BODIES: Array<[string, unknown]> = [
      ["an array body", []],
      ["a string body", "reset"],
      ["a numeric ifVersion", { ifVersion: 5 }],
      ["a null ifVersion", { ifVersion: null }],
      ["an ifVersion that is no timestamp", { ifVersion: "yesterday" }],
    ];
    it.each([
      ...MALFORMED_BODIES.map(
        ([label, body]) => ["reset", createResetProposalOverridesRouteHandler, label, body] as const,
      ),
      ...[...MALFORMED_BODIES, ["an unknown key", { force: true }] as [string, unknown]].map(
        ([label, body]) => ["recompute", createRecomputeProposalRouteHandler, label, body] as const,
      ),
    ])(
      "%s: rejects %s with a ValidationError, writes nothing and queues no job",
      async (_name, factory, _label, body) => {
        const proposalId = await editedCard();
        const before = await storedCard(proposalId);
        const jobs = async () => (await pool.query("SELECT key, revision FROM graphile_worker.jobs ORDER BY id")).rows;
        const jobsBefore = await jobs();

        const error = await failureOf(factory(pool)({ params: { id: proposalId }, body }));

        expect(error).toBeInstanceOf(ValidationError);
        expect(await storedCard(proposalId)).toEqual(before);
        expect(await jobs()).toEqual(jobsBefore);
      },
    );
  });

  describe("createProposalOptionsRouteHandler", () => {
    const optionsContext = (id: string, query: string, locale = "en") => ({
      params: { id },
      body: null,
      identity: { user: { id: randomUUID(), locale } },
      req: { headers: {}, url: `/api/proposals/${id}/options${query}` },
    });

    it("answers the options of the field in the caller's locale, a thin mapping onto listProposalOptions", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const projectId = await createIn(await databaseIdFor("projects"), { name: "Garden" });

      const english = await createProposalOptionsRouteHandler(pool)(optionsContext(proposalId, "?field=project"));
      const czech = await createProposalOptionsRouteHandler(pool)(optionsContext(proposalId, "?field=project", "cs"));

      expect(english.status).toBe(200);
      const parse = (result: typeof english) =>
        z
          .object({ options: z.array(z.object({ id: z.string().nullable(), label: z.string() })) })
          .parse("body" in result ? result.body : null).options;
      expect(parse(english)).toContainEqual({ id: projectId, label: "Garden" });
      expect(parse(english).at(-1)).toEqual({ id: null, label: "No project" });
      expect(parse(czech).at(-1)).toEqual({ id: null, label: "Bez projektu" });
    });

    it("lists a done project only with includeDone=true", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const done = await createIn(await databaseIdFor("projects"), { name: "Done one", status: "done" });
      const idsOf = async (query: string): Promise<Array<string | null>> => {
        const result = await createProposalOptionsRouteHandler(pool)(optionsContext(proposalId, query));
        const body = z
          .object({ options: z.array(z.object({ id: z.string().nullable() })) })
          .parse("body" in result ? result.body : null);
        return body.options.map((option) => option.id);
      };

      expect(await idsOf("?field=project")).not.toContain(done);
      expect(await idsOf("?field=project&includeDone=true")).toContain(done);
    });

    it.each([
      ["", "no field"],
      ["?field=tasks", "a field outside the set"],
      ["?field=", "an empty field"],
      ["?field=Project", "a field in another case"],
    ])("is a ValidationError on field for %s (%s)", async (query) => {
      const proposalId = await createDatabaseProposal("Buy milk");

      const error = await failureOf(createProposalOptionsRouteHandler(pool)(optionsContext(proposalId, query)));

      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toMatchObject({ field: "field" });
    });

    it("accepts every field of the closed set", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      for (const field of PROPOSAL_OPTION_FIELDS) {
        const result = await createProposalOptionsRouteHandler(pool)(optionsContext(proposalId, `?field=${field}`));
        expect(result.status, field).toBe(200);
      }
    });

    it.each(["?field=project&includeDone=false", "?field=project&includeDone=", "?field=project&includeDone=1"])(
      "is a ValidationError on includeDone for %s",
      async (query) => {
        const proposalId = await createDatabaseProposal("Buy milk");

        const error = await failureOf(createProposalOptionsRouteHandler(pool)(optionsContext(proposalId, query)));

        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).details).toMatchObject({ field: "includeDone" });
      },
    );

    it("is a ValidationError on id for a path parameter that is not a UUID, and a NotFoundError for an unknown card", async () => {
      const notUuid = await failureOf(
        createProposalOptionsRouteHandler(pool)(optionsContext("nope", "?field=project")),
      );
      const unknown = await failureOf(
        createProposalOptionsRouteHandler(pool)(optionsContext(randomUUID(), "?field=project")),
      );

      expect(notUuid).toBeInstanceOf(ValidationError);
      expect((notUuid as ValidationError).details).toMatchObject({ field: "id" });
      expect(unknown).toBeInstanceOf(NotFoundError);
    });

    it("is declared by the Inbox manifest as a single-consumer read, and every optionsSource of the editor schemas is a field it answers", () => {
      const route = inboxManifest.customRoutes?.find((candidate) => candidate.path === "/api/proposals/:id/options");
      expect(route).toMatchObject({
        method: "GET",
        handlerExport: "createProposalOptionsRouteHandler",
        justification: "single-consumer-read",
      });
      const schemas = [
        ...Object.values(SYSTEM_DATABASES_EDITOR_SCHEMAS),
        ...Object.values(inboxManifest.editorSchemas ?? {}),
      ];
      const sources = schemas.flatMap((schema) =>
        schema.groups.flatMap((group) =>
          group.fields.flatMap((field) => (field.optionsSource ? [field.optionsSource] : [])),
        ),
      );
      expect(sources.length).toBeGreaterThan(0);
      expect(sources.filter((source) => !(PROPOSAL_OPTION_FIELDS as readonly string[]).includes(source))).toEqual([]);
    });
  });

  describe("createCaptureInboxItemRouteHandler", () => {
    const captureContext = (body: unknown, headers: Record<string, string> = {}) => ({
      params: {},
      body,
      req: { headers },
    });
    const validBody = { text: "Call the dentist", date: "2026-08-28", time: "09:30", captureChannel: "typed" } as const;
    const capture = (body: unknown, headers?: Record<string, string>) =>
      createCaptureInboxItemRouteHandler(pool)(captureContext(body, headers));
    const createType = (status: "active" | "archived" = "active") =>
      withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name: "Note",
          emoji: "📝",
          processingMethod: "pageContent",
          status,
        }),
      );
    const inboxItemCount = async (): Promise<number> =>
      Number(
        (await pool.query<{ n: string }>("SELECT count(*) AS n FROM items WHERE database_id = $1", [inboxId])).rows[0]!
          .n,
      );
    const targetsOf = (itemId: string): Promise<Record<string, ItemRow[]>> =>
      withTransaction(pool, async (client) => {
        const grouped: Record<string, ItemRow[]> = {};
        for (const edge of await relationsStore.listAllRelationsForItem(client, itemId)) {
          const definition = await relationsStore.getRelationDefinition(client, edge.relationDefinitionId);
          const sideOfItem = edge.itemA === itemId ? definition?.propertyIdA : definition?.propertyIdB;
          const property = sideOfItem ? await propertiesStore.getProperty(client, sideOfItem) : null;
          const [target] = await itemsStore.getItemsByIds(client, [relationsStore.otherSide(edge, itemId)]);
          if (property && target) (grouped[property.key] ??= []).push(target);
        }
        return grouped;
      });

    it("creates the item with its journalDay edge and its type edge and answers 201 with the item", async () => {
      const type = await createType();

      const result = await capture({ ...validBody, typeId: type.id });

      expect(result.status).toBe(201);
      const item = itemOf(result);
      expect(item.databaseId).toBe(inboxId);
      expect(item.properties).toMatchObject(validBody);
      const targets = await targetsOf(item.id);
      expect(targets.type?.map((target) => target.id)).toEqual([type.id]);
      expect(targets.journalDay).toHaveLength(1);
      expect(targets.journalDay?.[0]?.properties).toMatchObject({ type: "day", period: "2026-08-28" });
      expect(await inboxItemCount()).toBe(1);
    });

    it("stores the channel and the source app of a share, and an addedAt that is the server's receive time, not the sent date and time", async () => {
      const before = Date.now();
      const item = itemOf(
        await capture({
          ...validBody,
          date: "2020-01-02",
          time: "03:04",
          captureChannel: "share",
          sourceApp: "Mail",
        }),
      );
      const after = Date.now();

      expect(item.properties).toMatchObject({
        date: "2020-01-02",
        time: "03:04",
        captureChannel: "share",
        sourceApp: "Mail",
      });
      const addedAt = z.string().parse(item.properties.addedAt);
      expect(new Date(addedAt).toISOString()).toBe(addedAt);
      expect(new Date(addedAt).getTime()).toBeGreaterThanOrEqual(before);
      expect(new Date(addedAt).getTime()).toBeLessThanOrEqual(after);
      expect(addedAt.startsWith("2020-01-02")).toBe(false);
    });

    it.each(["typed", "voice", "share"] as const)("stores the channel %s", async (captureChannel) => {
      const item = itemOf(await capture({ ...validBody, captureChannel }));

      expect(item.properties.captureChannel).toBe(captureChannel);
      expect(item.properties).not.toHaveProperty("sourceApp");
    });

    it("trims the source app, keeps one of exactly 80 characters, and does not store a blank one", async () => {
      const trimmed = itemOf(await capture({ ...validBody, sourceApp: "  Mail \n" }));
      const longest = itemOf(await capture({ ...validBody, sourceApp: ` ${"a".repeat(80)} ` }));
      const blank = itemOf(await capture({ ...validBody, sourceApp: "   " }));

      expect(trimmed.properties.sourceApp).toBe("Mail");
      expect(longest.properties.sourceApp).toBe("a".repeat(80));
      expect(blank.properties).not.toHaveProperty("sourceApp");
      expect(blank.properties.captureChannel).toBe("typed");
    });

    it("keeps the first capture's channel, source app and addedAt for a replayed Idempotency-Key", async () => {
      const headers = { "idempotency-key": "capture-key-source" };
      const first = itemOf(await capture({ ...validBody, captureChannel: "share", sourceApp: "Mail" }, headers));

      const replay = itemOf(await capture({ ...validBody, captureChannel: "voice", sourceApp: "Notes" }, headers));

      expect(replay).toEqual(first);
      expect(replay.properties).toMatchObject({ captureChannel: "share", sourceApp: "Mail" });
      expect(await inboxItemCount()).toBe(1);
    });

    it("leaves addedAt empty on the generic create and refuses to let a user write it on create or update", async () => {
      const generic = await withTransaction(pool, (client) =>
        createItemWithClient(client, {
          databaseId: inboxId,
          properties: { date: "2026-08-28", time: "09:30", text: "Generic" },
        }),
      );
      expect(generic.properties).not.toHaveProperty("addedAt");
      const captured = itemOf(await capture(validBody));
      const forged = "2001-01-01T00:00:00.000Z";

      for (const write of [
        (client: PoolClient) =>
          createItemWithClient(client, {
            databaseId: inboxId,
            properties: { date: "2026-08-28", time: "09:30", text: "Forged", addedAt: forged },
          }),
        (client: PoolClient) =>
          updateItemWithClient(client, {
            databaseId: inboxId,
            itemId: captured.id,
            propertiesPatch: { addedAt: forged },
          }),
        (client: PoolClient) =>
          updateItemWithClient(client, {
            databaseId: inboxId,
            itemId: generic.id,
            propertiesPatch: { addedAt: forged },
          }),
      ]) {
        const error = await failureOf(withTransaction(pool, write));
        expect(error).toBeInstanceOf(ForbiddenError);
        expect((error as ForbiddenError).details).toMatchObject({ field: "addedAt" });
      }

      const { rows } = await pool.query<{ addedAt: string | null }>(
        "SELECT properties->>'addedAt' AS \"addedAt\" FROM items WHERE id = $1",
        [captured.id],
      );
      expect(rows[0]?.addedAt).toBe(captured.properties.addedAt);
      expect(await inboxItemCount()).toBe(2);
    });

    it("lets a user change the channel and the source app of an item through the generic update", async () => {
      const captured = itemOf(await capture({ ...validBody, sourceApp: "Mail" }));

      const updated = await withTransaction(pool, (client) =>
        updateItemWithClient(client, {
          databaseId: inboxId,
          itemId: captured.id,
          propertiesPatch: { captureChannel: "voice", sourceApp: "Notes" },
        }),
      );

      expect(updated.properties).toMatchObject({
        captureChannel: "voice",
        sourceApp: "Notes",
        addedAt: captured.properties.addedAt,
      });
    });

    it("creates an untyped item when typeId is omitted", async () => {
      const item = itemOf(await capture(validBody));

      const targets = await targetsOf(item.id);
      expect(targets.type).toBeUndefined();
      expect(targets.journalDay).toHaveLength(1);
    });

    it.each([
      ["no text", { date: "2026-08-28", time: "09:30", captureChannel: "typed" }, "text"],
      ["an empty text", { ...validBody, text: "" }, "text"],
      ["a blank text", { ...validBody, text: "  \n\t " }, "text"],
      ["a text that is not a string", { ...validBody, text: 7 }, "text"],
      ["a text with a NUL character", { ...validBody, text: "a\u0000b" }, "text"],
      ["no date", { text: "Call", time: "09:30", captureChannel: "typed" }, "date"],
      ["a date that is not a string", { ...validBody, date: 20260828 }, "date"],
      ["a date that is not a calendar date", { ...validBody, date: "2026-02-30" }, "date"],
      ["no time", { text: "Call", date: "2026-08-28", captureChannel: "typed" }, "time"],
      ["a time that is not a string", { ...validBody, time: 930 }, "time"],
      ["the time abc", { ...validBody, time: "abc" }, "time"],
      ["a typeId that is not a UUID", { ...validBody, typeId: "not-an-id" }, "typeId"],
      ["a typeId of null", { ...validBody, typeId: null }, "typeId"],
      ["an unknown key", { ...validBody, channel: "share" }, "channel"],
      ["no captureChannel", { text: "Call", date: "2026-08-28", time: "09:30" }, "captureChannel"],
      ["a captureChannel that is not an option", { ...validBody, captureChannel: "email" }, "captureChannel"],
      ["a captureChannel in another case", { ...validBody, captureChannel: "Typed" }, "captureChannel"],
      ["an empty captureChannel", { ...validBody, captureChannel: "" }, "captureChannel"],
      ["a captureChannel that is not a string", { ...validBody, captureChannel: 7 }, "captureChannel"],
      ["a captureChannel of null", { ...validBody, captureChannel: null }, "captureChannel"],
      ["a sourceApp that is not a string", { ...validBody, sourceApp: 7 }, "sourceApp"],
      ["a sourceApp of null", { ...validBody, sourceApp: null }, "sourceApp"],
      ["a sourceApp with a NUL character", { ...validBody, sourceApp: "Ma\u0000il" }, "sourceApp"],
      ["a sourceApp of 81 characters", { ...validBody, sourceApp: "a".repeat(81) }, "sourceApp"],
      ["a sourceApp of 81 characters after trimming", { ...validBody, sourceApp: ` ${"a".repeat(81)} ` }, "sourceApp"],
    ])("is a ValidationError on the field for %s, and writes nothing", async (_name, body, field) => {
      const error = await failureOf(capture(body));

      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toMatchObject({ field });
      expect(await inboxItemCount()).toBe(0);
    });

    it.each([
      ["null", null],
      ["an array", []],
      ["a string", "text"],
    ])("is a ValidationError for a body that is %s", async (_name, body) => {
      expect(await failureOf(capture(body))).toBeInstanceOf(ValidationError);
      expect(await inboxItemCount()).toBe(0);
    });

    it("refuses an archived, a trashed and an unknown type on typeId, before anything is written", async () => {
      const archived = await createType("archived");
      const trashed = await createType();
      await withTransaction(pool, (client) =>
        itemDeleteWithClient(client, typesId, trashed.id, { queueAffinity: createActionQueueAffinity() }),
      );

      for (const typeId of [archived.id, trashed.id, randomUUID()]) {
        const error = await failureOf(capture({ ...validBody, typeId }));
        expect(error, typeId).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).details, typeId).toMatchObject({ field: "typeId" });
      }
      expect(await inboxItemCount()).toBe(0);
      const { rows } = await pool.query<{ n: string }>(
        "SELECT count(*) AS n FROM items WHERE database_id = (SELECT id FROM databases WHERE owner_module_id = 'journal')",
      );
      expect(Number(rows[0]!.n)).toBe(0);
    });

    it("refuses the id of an Inbox item as a typeId", async () => {
      const first = itemOf(await capture(validBody));

      const error = await failureOf(capture({ ...validBody, typeId: first.id }));

      expect((error as ValidationError).details).toMatchObject({ field: "typeId" });
      expect(await inboxItemCount()).toBe(1);
    });

    it("answers the same Idempotency-Key with the first item: one item, one type edge, one journalDay edge", async () => {
      const type = await createType();
      const headers = { "idempotency-key": "capture-key-1" };

      const first = itemOf(await capture({ ...validBody, typeId: type.id }, headers));
      const second = await capture({ ...validBody, typeId: type.id }, headers);

      expect(second.status).toBe(201);
      expect(itemOf(second)).toEqual(first);
      expect(await inboxItemCount()).toBe(1);
      const targets = await targetsOf(first.id);
      expect(targets.type).toHaveLength(1);
      expect(targets.journalDay).toHaveLength(1);
    });

    it("answers a replay with the first item even when its type has been archived since, and checks no type", async () => {
      const type = await createType();
      const headers = { "idempotency-key": "capture-key-2" };
      const first = itemOf(await capture({ ...validBody, typeId: type.id }, headers));
      await withTransaction(pool, (client) =>
        updateItemWithClient(client, { databaseId: typesId, itemId: type.id, propertiesPatch: { status: "archived" } }),
      );

      const second = itemOf(await capture({ ...validBody, typeId: type.id }, headers));

      expect(second.id).toBe(first.id);
      expect((await targetsOf(first.id)).type).toHaveLength(1);
    });

    it("creates a new item for a key whose item is in the Trash, and a new item for another key", async () => {
      const headers = { "idempotency-key": "capture-key-3" };
      const first = itemOf(await capture(validBody, headers));
      await withTransaction(pool, (client) =>
        itemDeleteWithClient(client, inboxId, first.id, { queueAffinity: createActionQueueAffinity() }),
      );

      const again = itemOf(await capture(validBody, headers));
      const other = itemOf(await capture(validBody, { "idempotency-key": "capture-key-4" }));

      expect(again.id).not.toBe(first.id);
      expect(other.id).not.toBe(again.id);
      expect(await inboxItemCount()).toBe(3);
    });

    it("is a ValidationError on the Idempotency-Key header for a key that is too long, and writes nothing", async () => {
      const error = await failureOf(capture(validBody, { "idempotency-key": "k".repeat(300) }));

      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toMatchObject({ field: "Idempotency-Key" });
      expect(await inboxItemCount()).toBe(0);
    });

    it("creates one item without a key each time", async () => {
      await capture(validBody);
      await capture(validBody);

      expect(await inboxItemCount()).toBe(2);
    });

    it("writes no type edge when the helper replays a reserved key, whatever type the replay names", async () => {
      const type = await createType();
      const otherType = await createType();
      const input = { inboxDatabaseId: inboxId, ...validBody, idempotencyKey: "helper-key" };

      const first = await withTransaction(pool, (client) =>
        createInboxItemWithClient(client, { ...input, type: type.id }),
      );
      const replay = await withTransaction(pool, (client) =>
        createInboxItemWithClient(client, { ...input, type: otherType.id }),
      );

      expect(replay.id).toBe(first.id);
      expect((await targetsOf(first.id)).type?.map((target) => target.id)).toEqual([type.id]);
    });
  });

  describe("createInboxTypesRouteHandler", () => {
    /** The adapter always supplies the caller; this handler reads only its locale. */
    const typesIn = (locale: string) => createInboxTypesRouteHandler(pool)({ identity: { user: { locale } } });
    const listing = (
      type: ItemRow,
      label: string,
      targetDatabaseKey: string | null,
      targetLabel: string | null,
      processingMethod = "database",
    ) => ({ id: type.id, emoji: "☑️", label, processingMethod, targetDatabaseKey, targetLabel });
    const createTaskType = (name: string) => createInboxType({ ...TASK_TYPE, name, status: "active" });

    /** A raw UPDATE: the choke point refuses an unknown target, so only an older write could leave this stored state. */
    async function storeTargetDirectly(itemId: string, target: string): Promise<void> {
      const { rows } = await pool.query<{ id: string }>(
        `UPDATE items SET properties = jsonb_set(properties, '{targetDatabase}', to_jsonb($3::text))
         WHERE database_id = $1 AND id = $2
         RETURNING id`,
        [typesId, itemId, target],
      );
      if (rows.length !== 1) throw new Error(`Inbox item type ${itemId} was not found`);
    }

    it("lists an active database type with its method, target key and label in cs and en", async () => {
      const type = await createTaskType("Task");

      expect(await typesIn("cs")).toEqual({ status: 200, body: { types: [listing(type, "Task", "tasks", "Úkoly")] } });
      expect(await typesIn("en")).toEqual({ status: 200, body: { types: [listing(type, "Task", "tasks", "Tasks")] } });
    });

    it("returns a pageContent type with method pageContent and null target key and label", async () => {
      const type = await createInboxType({
        name: "Note",
        emoji: "☑️",
        processingMethod: "pageContent",
        status: "active",
      });

      expect(await typesIn("cs")).toEqual({
        status: 200,
        body: { types: [listing(type, "Note", null, null, "pageContent")] },
      });
    });

    it("returns the key itself as the label of a stored target the catalog does not know, without failing the list", async () => {
      const unknown = await createTaskType("Old");
      await storeTargetDirectly(unknown.id, "nonsense");
      const known = await createTaskType("Task");

      expect(await typesIn("en")).toEqual({
        status: 200,
        body: {
          types: expect.arrayContaining([
            listing(unknown, "Old", "nonsense", "nonsense"),
            listing(known, "Task", "tasks", "Tasks"),
          ]),
        },
      });
    });

    it("labels every type that shares a target with that target's label", async () => {
      const first = await createTaskType("Task");
      const second = await createTaskType("Errand");

      expect(await typesIn("cs")).toEqual({
        status: 200,
        body: {
          types: expect.arrayContaining([
            listing(first, "Task", "tasks", "Úkoly"),
            listing(second, "Errand", "tasks", "Úkoly"),
          ]),
        },
      });
    });

    it("uses a target database's own name over its catalog label", async () => {
      const tasksId = await databaseIdFor("tasks");
      await withTransaction(pool, (client) => renameDatabase(client, tasksId, "My tasks"));
      const type = await createTaskType("Task");

      expect(await typesIn("cs")).toEqual({
        status: 200,
        body: { types: [listing(type, "Task", "tasks", "My tasks")] },
      });
    });

    it("excludes archived types, and the list holds only the active one", async () => {
      const active = await createTaskType("Task");
      await createInboxType({ name: "Old", emoji: "🗑️", status: "archived", processingMethod: "pageContent" });

      expect(await typesIn("en")).toEqual({
        status: 200,
        body: { types: [listing(active, "Task", "tasks", "Tasks")] },
      });
    });
  });

  describe("createInboxCardsRouteHandler editor schemas", () => {
    async function createCard(
      text: string,
      targetDatabase: "tasks" | "projects",
      properties: Record<string, unknown>,
    ): Promise<{ itemId: string; cardId: string }> {
      const type = await createInboxType({
        name: `Type of ${targetDatabase}`,
        emoji: "📌",
        processingMethod: "database",
        targetDatabase,
      });
      const item = await createInboxItem(type.id, text);
      await runTick(item.id, async () => ({ properties }));
      const { rows } = await pool.query<{ id: string }>(
        "SELECT p.id FROM items p JOIN item_relations r ON r.item_a = p.id AND r.item_b = $2 WHERE p.database_id = $1",
        [proposalsId, item.id],
      );
      if (!rows[0]) throw new Error("The tick stored no card");
      return { itemId: item.id, cardId: rows[0].id };
    }

    interface ListedCard {
      cardId: string;
      cardKind: string;
      status: string;
      editorSchema: {
        baseKind: string;
        groups: Array<{ key: string; fields: Array<Record<string, unknown>> }>;
      } | null;
    }

    async function listedCards(userId: string, locale: string): Promise<ListedCard[]> {
      const answer = await createInboxCardsRouteHandler(pool)({ identity: { user: { id: userId, locale } } });
      if (!("body" in answer)) throw new Error("expected a raw JSON body");
      const body = answer.body as { cards: ListedCard[] };
      return body.cards;
    }

    function fieldsOf(card: ListedCard): Array<Record<string, unknown>> {
      return card.editorSchema?.groups.flatMap((group) => group.fields) ?? [];
    }

    function fieldOf(card: ListedCard, key: string): Record<string, unknown> {
      const field = fieldsOf(card).find((candidate) => candidate.key === key);
      if (!field) throw new Error(`The schema has no field '${key}'`);
      return field;
    }

    /** The listing of `cardId` for a new user of the tenant in `locale`. */
    async function listedCard(cardId: string, locale = "en"): Promise<ListedCard> {
      const userId = (await createTenantZeroUser(pool)).id;
      const card = (await listedCards(userId, locale)).find((candidate) => candidate.cardId === cardId);
      if (!card) throw new Error(`Card ${cardId} is not listed`);
      return card;
    }

    it("gives a task card the localized task schema: name required and the time of the date hidden by allDay", async () => {
      const card = await createCard("Buy milk", "tasks", { name: "Buy milk" });

      const listed = await listedCard(card.cardId);

      expect(listed.editorSchema?.baseKind).toBe("task");
      expect(fieldOf(listed, "name")).toMatchObject({
        control: "text",
        label: "Name",
        placeholder: "Name",
        required: true,
      });
      expect(fieldOf(listed, "date")).toMatchObject({
        control: "datetime",
        label: "Date",
        timeHiddenWhen: { field: "allDay", equals: true },
      });
      expect(fieldOf(listed, "project")).toMatchObject({ control: "select", optionsSource: "project" });
      expect(fieldOf(listed, "followDate")).toMatchObject({
        control: "date",
        required: true,
        when: { field: "followupTask", equals: true },
      });
    });

    it.each([
      ["cs", "Název", "Datum"],
      ["en", "Name", "Date"],
      ["de", "Name", "Date"],
    ])("resolves the labels in the locale %s, English for a locale without a catalog", async (locale, name, date) => {
      const card = await createCard("Buy milk", "tasks", { name: "Buy milk" });

      const listed = await listedCard(card.cardId, locale);

      expect(fieldOf(listed, "name")).toMatchObject({ label: name, placeholder: name });
      expect(fieldOf(listed, "date")).toMatchObject({ label: date });
    });

    it("gives an invalid task card the schema of the task it edits, follow-up fields included", async () => {
      const card = await createCard("Buy milk", "tasks", { name: "Buy milk" });
      await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, card.itemId));
      await runTick(card.itemId, async () => {
        throw new Error("The tick must not compute a card whose source was deleted");
      });

      const listed = await listedCard(card.cardId);

      expect(listed).toMatchObject({ cardKind: "invalid", status: "invalid" });
      expect(listed.editorSchema?.baseKind).toBe("task");
      expect(fieldsOf(listed).map((field) => field.key)).toEqual([
        "name",
        "date",
        "allDay",
        "status",
        "project",
        "area",
        "followupTask",
        "followDate",
      ]);
    });

    it("hides the date of a project card for the status longTerm", async () => {
      const card = await createCard("Kitchen renovation", "projects", { name: "Kitchen renovation" });

      const listed = await listedCard(card.cardId);

      expect(listed.editorSchema?.baseKind).toBe("project");
      expect(fieldOf(listed, "date")).toMatchObject({
        control: "date",
        when: { field: "status", notEquals: "longTerm" },
      });
      expect(fieldOf(listed, "status")).toMatchObject({ control: "seg" });
    });

    it("gives an editorSchema of null to a card whose base kind no module declares", async () => {
      const userId = (await createTenantZeroUser(pool)).id;
      const run = await createAgentRun(pool, { triggeredBy: "heartbeat", task: "probe" });
      const request = await createPendingApprovalRequest(pool, {
        agentRunId: run.id,
        toolName: "send_email",
        riskClass: "outbound",
        payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
        resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
      });
      const clarification = await createCard("Unclear", "tasks", { name: "Unclear" });
      // Raw SQL: `needsClarification` is produced only by the model's recognition, which this tick does not run.
      await pool.query(
        "UPDATE items SET properties = jsonb_set(properties, '{status}', '\"needsClarification\"') WHERE id = $1",
        [clarification.cardId],
      );

      const cards = await listedCards(userId, "en");

      expect(cards.map((card) => [card.cardId, card.editorSchema])).toEqual([
        [request.id, null],
        [clarification.cardId, null],
      ]);
    });

    it("declares only keys that are properties of the owning database, apart from the pseudo fields", async () => {
      const databaseOf: Record<string, string> = {
        task: "tasks",
        event: "events",
        project: "projects",
        area: "areas",
        company: "companies",
        person: "people",
        file: "files",
        health: "healthRecords",
      };
      // Fields without a property of their own: the all-day and step switches, the follow-up date, the Tasks
      // `area` choice, and the page content of the two page cards.
      const pseudoKeys = new Set([
        "allDay",
        "followupTask",
        "followDate",
        "area",
        "markdown",
        "day",
        "page",
        "placement",
        "heading",
      ]);
      const unknown: string[] = [];
      for (const [baseKind, moduleId] of Object.entries(databaseOf)) {
        const properties = await withTransaction(pool, async (client) =>
          propertiesStore.listPropertiesByDatabase(client, await databaseIdFor(moduleId)),
        );
        const keys = new Set(properties.map((property) => property.key));
        for (const group of SYSTEM_DATABASES_EDITOR_SCHEMAS[baseKind]!.groups) {
          for (const field of group.fields) {
            if (!keys.has(field.key) && !pseudoKeys.has(field.key)) unknown.push(`${baseKind}.${field.key}`);
          }
        }
      }
      expect(unknown).toEqual([]);
    });
  });
});
