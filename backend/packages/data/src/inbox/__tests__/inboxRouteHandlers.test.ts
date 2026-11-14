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
import { getDatabaseByModuleId, renameDatabase } from "../../chokePoint/databasesStore.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { createBlob } from "../../blobs/blobsStore.js";
import { createActionQueueAffinity } from "../../scheduler/actions.js";
import { createDocStore } from "../../docs/docStore.js";
import { deleteDocByItemId } from "../../docs/docsStore.js";
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
  createConfirmProposalRouteHandler,
  createInboxCardsRouteHandler,
  createInboxTypesRouteHandler,
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
import { ConflictError, NotFoundError, ValidationError } from "../../errors.js";
import { createAgentRun } from "../../agentRuns/agentRunsStore.js";
import { createPendingApprovalRequest } from "../../mcp/approvalRequestsStore.js";
import { SYSTEM_DATABASES_EDITOR_SCHEMAS } from "../../seed/systemDatabasesEditorSchemas.js";
import type { ItemRow } from "../../types.js";

let pool: Pool;
let viewTypeRegistry: ViewTypeRegistry;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

/**
 * Issue #239's `inboxPipeline`-owned custom-route handler factories, exercised directly against
 * the real functions they thinly wrap (#105's `confirmProposalWithClient`, #101's
 * `listActiveInboxTypes`) — the HTTP-level auth/mounting mechanics these are cast into an
 * `AdapterHandler` for are covered separately by `customRouteMount.test.ts` and
 * `routeMatrix.test.ts` in `semprec-api`.
 */

/** The `file` value of a Files item (a blob that exists): the Files editor schema requires it, so a Files card needs one to confirm (issue #1928). */
async function newFileValue(client: PoolClient): Promise<{ blobId: string }> {
  const blob = await createBlob(client, {
    mimeType: "application/pdf",
    byteSize: 12,
    storageKey: `blobs/${randomUUID()}`,
  });
  return { blobId: blob.id };
}

const PROJECT_ID = "00000000-0000-4000-8000-0000000000a1";

describe("inbox custom route handlers (issue #239)", () => {
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

  afterAll(async () => {
    await pool?.end();
  });

  async function createDatabaseProposal(text: string): Promise<string> {
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
    const computeProposal: ComputeSemprecProposalFn = async () => ({ properties: { name: text } });
    const handler = createSemprecTickAction(pool, computeProposal);
    await handler(
      { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
      { heartbeatId: "hb", projectItemId: "proj", itemId: item.id },
    );
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM items WHERE database_id = $1 ORDER BY updated_at DESC LIMIT 1`,
      [proposalsId],
    );
    return rows[0]!.id;
  }

  async function confirmWhileUnlinkWaits(
    proposalId: string,
    relationPropertyId: string,
    fileId: string,
    projectId: string,
  ) {
    const confirmPool = createPool(process.env.TEST_DATABASE_URL ?? "", {
      role: "semprec_data",
      statementTimeoutMs: 8000,
    });
    const unlinkPool = createPool(process.env.TEST_DATABASE_URL ?? "", {
      role: "semprec_data",
      statementTimeoutMs: 8000,
    });
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
    let allowConfirm!: () => void;
    let allowUnlink!: () => void;
    let confirmed!: (pid: number) => void;
    let unlinking!: (pid: number) => void;
    let unlinked!: () => void;
    const confirmGate = new Promise<void>((resolve) => {
      allowConfirm = resolve;
    });
    const unlinkGate = new Promise<void>((resolve) => {
      allowUnlink = resolve;
    });
    const confirmReady = new Promise<number>((resolve) => {
      confirmed = resolve;
    });
    const unlinkReady = new Promise<number>((resolve) => {
      unlinking = resolve;
    });
    const unlinkDone = new Promise<void>((resolve) => {
      unlinked = resolve;
    });
    const wait = async <T>(promise: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Owned confirm overlap timed out")), 10000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    let confirmWork: Promise<unknown> | undefined;
    let unlinkWork: Promise<unknown> | undefined;
    let response: Awaited<ReturnType<ReturnType<typeof createConfirmProposalRouteHandler>>> | undefined;
    try {
      for (const runtime of [confirmPool, unlinkPool]) {
        const role = await runtime.query<{ name: string; bypass: boolean; superuser: boolean }>(
          "SELECT current_user AS name, rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
        );
        expect(role.rows).toEqual([{ name: "semprec_data", bypass: false, superuser: false }]);
      }
      confirmWork = runInTenant(getTenantZeroId(), () =>
        withTransaction(confirmPool, async (client) => {
          const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          await confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposalId);
          confirmed(rows[0]!.pid);
          await confirmGate;
        }),
      );
      void confirmWork.catch(() => {});
      const confirmPid = await wait(
        Promise.race([
          confirmReady,
          confirmWork.then(() => {
            throw new Error("Confirm ended before barrier");
          }),
        ]),
      );
      await capture(confirmPid);
      unlinkWork = runInTenant(getTenantZeroId(), () =>
        withTransaction(unlinkPool, async (client) => {
          const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          unlinking(rows[0]!.pid);
          await deleteRelationWithClient(client, { relationPropertyId, callerItemId: fileId, targetItemId: projectId });
          unlinked();
          await unlinkGate;
        }),
      );
      void unlinkWork.catch(() => {});
      const unlinkPid = await wait(
        Promise.race([
          unlinkReady,
          unlinkWork.then(() => {
            throw new Error("Unlink ended before barrier");
          }),
        ]),
      );
      await capture(unlinkPid);
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const { rows } = await pool.query<{ blocked: boolean }>(
          "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
          [confirmPid, unlinkPid],
        );
        if (rows[0]?.blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      allowConfirm();
      await wait(confirmWork);
      await wait(
        Promise.race([
          unlinkDone,
          unlinkWork.then(() => {
            throw new Error("Unlink committed before barrier");
          }),
        ]),
      );
      response = await runInTenant(getTenantZeroId(), () =>
        createConfirmProposalRouteHandler(confirmPool)({ params: { id: proposalId }, body: {} }),
      );
      if (!("item" in response) || !response.results) throw new Error("Missing committed result");
      expect(response.results.find((entry) => entry.ref === "file")?.linkLabels).toEqual(["Project"]);
    } catch (error) {
      failures.push(error);
    } finally {
      allowConfirm();
      allowUnlink();
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
        let absent = false;
        for (let i = 0; i < 100; i++) {
          const { rows } = await pool.query<{ present: boolean }>(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz AND datname = $3) AS present",
            [identity.pid, identity.started, identity.db],
          );
          if (rows[0]?.present === false) {
            absent = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (!absent) failures.push(new Error(`Owned confirm backend ${identity.pid} remains active`));
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Confirm overlap or settlement failed");
    if (!response) throw new Error("Missing overlap result");
    console.info(
      "Owned confirm and unlink settlement",
      JSON.stringify({ identities, blocker: identities[0]?.pid, waiter: identities[1]?.pid, absent: true }),
    );
    return response;
  }

  describe("createConfirmProposalRouteHandler", () => {
    it.each([false, true])(
      "attributes a confirmed page block to the user with existing block=%s",
      async (existingBlock) => {
        const dataPool = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
        const failures: unknown[] = [];
        try {
          const role = await dataPool.query<{ name: string; bypass: boolean; superuser: boolean }>(
            "SELECT current_user AS name, rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
          );
          expect(role.rows).toEqual([{ name: "semprec_data", bypass: false, superuser: false }]);
          await runInTenant(getTenantZeroId(), async () => {
            const type = await withTransaction(dataPool, (client) =>
              createInboxTypeWithClient(client, {
                inboxItemTypesDatabaseId: typesId,
                name: "Note",
                emoji: "N",
                processingMethod: "pageContent",
              }),
            );
            const source = await withTransaction(dataPool, (client) =>
              createInboxItemWithClient(client, {
                inboxDatabaseId: inboxId,
                date: "2026-08-28",
                time: "09:00",
                text: "A thought",
                type: type.id,
              }),
            );
            const chokePoint = createChokePoint(dataPool);
            const custom = await chokePoint.createDatabase({ name: "Custom page" });
            const page = await chokePoint.createItem({ databaseId: custom.id, properties: {} });
            const tick = createSemprecTickAction(dataPool, async () => ({
              target: page.id,
              properties: { flavour: "paragraph", fields: { content: "A thought" } },
            }));
            await tick(
              {
                inboxDatabaseId: inboxId,
                inboxItemTypesDatabaseId: typesId,
                processingProposalsDatabaseId: proposalsId,
              },
              { heartbeatId: "hb", projectItemId: "proj", itemId: source.id },
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
              await docs.putBlock(
                page.id,
                { id: proposal, flavour: "paragraph", fields: { content: "Before" } },
                "user",
              );
            }
            const response = await createConfirmProposalRouteHandler(dataPool)({ params: { id: proposal }, body: {} });
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
            const replay = await createConfirmProposalRouteHandler(dataPool)({ params: { id: proposal }, body: {} });
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
          });
        } catch (error) {
          failures.push(error);
        }
        try {
          await dataPool.end();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "Page test and settlement failed");
      },
    );
    it("records the file and follow-up task with project labels and current versions", async () => {
      const proposalId = await createDatabaseProposal("Seed");
      await withTransaction(pool, async (client) => {
        const projects = await getDatabaseByModuleId(client, "projects");
        const files = await getDatabaseByModuleId(client, "files");
        if (!projects || !files) throw new Error("Missing project or files database");
        const project = await createItemWithClient(client, {
          databaseId: projects.id,
          properties: { name: "Project" },
        });
        const file = await newFileValue(client);
        const operations = [
          {
            ref: "file",
            op: "create",
            databaseKey: "files",
            role: "primary",
            properties: { name: "Document", file },
            relations: { projects: [project.id] },
          },
          {
            ref: "task",
            op: "create",
            databaseKey: "tasks",
            role: "secondary",
            properties: { name: "Follow up" },
            relations: { project: [project.id] },
          },
        ];
        await updateItemWithClient(
          client,
          {
            databaseId: proposalsId,
            itemId: proposalId,
            propertiesPatch: {
              proposal: {
                entityKind: "database",
                target: files.id,
                properties: { name: "Document", file },
                operations,
              },
            },
          },
          { allowedSystemKeys: ["proposal"] },
        );
      });
      const handler = createConfirmProposalRouteHandler(pool);
      const response = await handler({ params: { id: proposalId }, body: {} });
      if (!("item" in response) || !response.results) throw new Error("Missing confirmed results");
      expect(response.results).toHaveLength(2);
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
      const ids = response.results.map((result) => result.itemId);
      const { rows } = await pool.query<{ id: string; updated_at: Date }>(
        "SELECT id, updated_at FROM items WHERE id = ANY($1::uuid[])",
        [ids],
      );
      for (const result of response.results)
        expect(result.updatedAt).toBe(rows.find((row) => row.id === result.itemId)?.updated_at.toISOString());
    });

    it.each(["created", "reused-empty", "reused-linked", "unlink-first", "overlap"] as const)(
      "reports only retained or created file relations: %s",
      async (mode) => {
        const reuse = mode !== "created";
        const proposalId = await createDatabaseProposal("Attachment");
        const fixture = await withTransaction(pool, async (client) => {
          const files = await getDatabaseByModuleId(client, "files");
          const tasks = await getDatabaseByModuleId(client, "tasks");
          const projects = await getDatabaseByModuleId(client, "projects");
          if (!files || !tasks || !projects) throw new Error("Missing databases");
          const sourceProperty = await propertiesStore.getPropertyByKey(client, proposalsId, "sourceInbox");
          if (!sourceProperty) throw new Error("Missing source relation");
          const sourceRelation = await relationsStore.getRelationDefinitionByPropertyId(client, sourceProperty.id);
          if (!sourceRelation) throw new Error("Missing source definition");
          const sourceEdges = await relationsStore.listRelationsForItem(client, sourceRelation.id, proposalId);
          if (sourceEdges.length !== 1) throw new Error("Missing source item");
          const sourceId = relationsStore.otherSide(sourceEdges[0]!, proposalId);
          const project = await createItemWithClient(client, {
            databaseId: projects.id,
            properties: { name: "Project" },
          });
          const blob = await createBlob(client, {
            mimeType: "application/pdf",
            byteSize: 12,
            storageKey: `test/${randomUUID()}`,
          });
          const existing = reuse
            ? await createItemWithClient(client, {
                databaseId: files.id,
                properties: { name: "Existing", file: { blobId: blob.id } },
              })
            : null;
          if (["reused-linked", "unlink-first", "overlap"].includes(mode) && existing) {
            const property = await propertiesStore.getPropertyByKey(client, files.id, "projects");
            if (!property) throw new Error("Missing projects relation");
            await createRelationWithClient(client, {
              relationPropertyId: property.id,
              callerItemId: existing.id,
              targetItemId: project.id,
            });
          }
          await insertInboxAttachments(client, sourceId, [{ blobId: blob.id, source: "camera" }]);
          const attachment = (await listInboxAttachments(client, [sourceId]))[0];
          if (!attachment) throw new Error("Missing attachment");
          await updateItemWithClient(
            client,
            {
              databaseId: proposalsId,
              itemId: proposalId,
              propertiesPatch: {
                proposal: {
                  entityKind: "database",
                  target: tasks.id,
                  properties: { name: "Task" },
                  operations: [
                    { ref: "task", op: "create", databaseKey: "tasks", role: "primary", properties: { name: "Task" } },
                    {
                      ref: "file",
                      op: "fileFromAttachment",
                      role: "secondary",
                      properties: { attachmentId: attachment.attachmentId, name: "File" },
                      relations: { projects: [project.id] },
                    },
                  ],
                },
              },
            },
            { allowedSystemKeys: ["proposal"] },
          );
          const property = await propertiesStore.getPropertyByKey(client, files.id, "projects");
          if (!property) throw new Error("Missing projects relation");
          return {
            filesId: files.id,
            projectId: project.id,
            existingId: existing?.id,
            relationPropertyId: property.id,
          };
        });
        const oldFile = fixture.existingId
          ? await pool.query<{ properties: Record<string, unknown>; updated_at: Date }>(
              "SELECT properties, updated_at FROM items WHERE id = $1",
              [fixture.existingId],
            )
          : null;
        const handler = createConfirmProposalRouteHandler(pool);
        let unlinkedFirstResult: Awaited<ReturnType<ReturnType<typeof createConfirmProposalRouteHandler>>> | undefined;
        if (mode === "unlink-first") {
          const unlinkPool = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
          const failures: unknown[] = [];
          try {
            const role = await unlinkPool.query<{ name: string; bypass: boolean; superuser: boolean }>(
              "SELECT current_user AS name, rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
            );
            expect(role.rows).toEqual([{ name: "semprec_data", bypass: false, superuser: false }]);
            await runInTenant(getTenantZeroId(), () =>
              withTransaction(unlinkPool, (client) =>
                deleteRelationWithClient(client, {
                  relationPropertyId: fixture.relationPropertyId,
                  callerItemId: fixture.existingId!,
                  targetItemId: fixture.projectId,
                }),
              ),
            );
            unlinkedFirstResult = await runInTenant(getTenantZeroId(), () =>
              createConfirmProposalRouteHandler(unlinkPool)({ params: { id: proposalId }, body: {} }),
            );
          } catch (error) {
            failures.push(error);
          }
          try {
            await unlinkPool.end();
          } catch (error) {
            failures.push(error);
          }
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1) throw new AggregateError(failures, "Unlink control or settlement failed");
        }
        const result =
          mode === "overlap"
            ? await confirmWhileUnlinkWaits(
                proposalId,
                fixture.relationPropertyId,
                fixture.existingId!,
                fixture.projectId,
              )
            : mode === "unlink-first"
              ? unlinkedFirstResult
              : await handler({ params: { id: proposalId }, body: {} });
        if (!result) throw new Error("Missing confirmation result");
        if (!("item" in result) || !result.results) throw new Error("Missing results");
        const file = result.results.find((entry) => entry.ref === "file");
        if (!file) throw new Error("Missing file result");
        expect(file.linkLabels).toEqual(mode === "reused-empty" || mode === "unlink-first" ? [] : ["Project"]);
        if (reuse) {
          expect(file.itemId).toBe(fixture.existingId);
          const unchanged = await pool.query<{ properties: Record<string, unknown>; updated_at: Date }>(
            "SELECT properties, updated_at FROM items WHERE id = $1",
            [fixture.existingId],
          );
          expect(unchanged.rows).toEqual(oldFile?.rows);
        }
        const edges = await withTransaction(pool, async (client) => {
          const property = await propertiesStore.getPropertyByKey(client, fixture.filesId, "projects");
          if (!property) throw new Error("Missing project relation");
          const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property.id);
          if (!definition) throw new Error("Missing project definition");
          return (await relationsStore.listRelationsForItem(client, definition.id, file.itemId)).map((edge) =>
            relationsStore.otherSide(edge, file.itemId),
          );
        });
        expect(edges).toEqual(
          mode === "reused-empty" || mode === "unlink-first" || mode === "overlap" ? [] : [fixture.projectId],
        );
        expect(result.item.properties.results).toEqual(result.results);
        const replay = await handler({ params: { id: proposalId }, body: {} });
        if (!("item" in replay)) throw new Error("Missing replay");
        expect(replay.results).toEqual(result.results);
      },
    );

    it("rejects malformed persisted confirmation results without changing the confirmed card", async () => {
      const proposalId = await createDatabaseProposal("Malformed stored result");
      const handler = createConfirmProposalRouteHandler(pool);
      await handler({ params: { id: proposalId }, body: {} });
      await withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          {
            databaseId: proposalsId,
            itemId: proposalId,
            propertiesPatch: { results: [{ ref: 42 }] },
          },
          { allowedSystemKeys: ["results"] },
        ),
      );
      const before = await pool.query<{ properties: Record<string, unknown>; updated_at: Date }>(
        "SELECT properties, updated_at FROM items WHERE id = $1",
        [proposalId],
      );
      const countsBefore = await pool.query<{ items: string; jobs: string }>(
        "SELECT (SELECT count(*) FROM items)::text AS items, (SELECT count(*) FROM graphile_worker.jobs)::text AS jobs",
      );
      await expect(handler({ params: { id: proposalId }, body: {} })).rejects.toThrow();
      const countsAfter = await pool.query<{ items: string; jobs: string }>(
        "SELECT (SELECT count(*) FROM items)::text AS items, (SELECT count(*) FROM graphile_worker.jobs)::text AS jobs",
      );
      expect(countsAfter.rows).toEqual(countsBefore.rows);
      const after = await pool.query<{ properties: Record<string, unknown>; updated_at: Date }>(
        "SELECT properties, updated_at FROM items WHERE id = $1",
        [proposalId],
      );
      expect(after.rows).toEqual(before.rows);
    });

    it("records a secondary updated item under its own step reference", async () => {
      const proposalId = await createDatabaseProposal("Seed");
      const taskId = await withTransaction(pool, async (client) => {
        const files = await getDatabaseByModuleId(client, "files");
        const tasks = await getDatabaseByModuleId(client, "tasks");
        if (!files || !tasks) throw new Error("Files or Tasks missing");
        const task = await createItemWithClient(client, { databaseId: tasks.id, properties: { name: "Before" } });
        const file = await newFileValue(client);
        await updateItemWithClient(
          client,
          {
            databaseId: proposalsId,
            itemId: proposalId,
            propertiesPatch: {
              proposal: {
                entityKind: "database",
                target: files.id,
                properties: { name: "Document", file },
                operations: [
                  {
                    ref: "file",
                    op: "create",
                    databaseKey: "files",
                    role: "primary",
                    properties: { name: "Document", file },
                  },
                  {
                    ref: "task",
                    op: "update",
                    itemId: task.id,
                    role: "secondary",
                    properties: { name: "After" },
                    before: { properties: { name: "Before" } },
                    after: { properties: { name: "After" } },
                  },
                ],
              },
            },
          },
          { allowedSystemKeys: ["proposal"] },
        );
        return task.id;
      });
      const response = await createConfirmProposalRouteHandler(pool)({ params: { id: proposalId }, body: {} });
      if (!("item" in response) || !response.results) throw new Error("Missing confirmed results");
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
      await withTransaction(pool, async (client) => {
        const files = await getDatabaseByModuleId(client, "files");
        if (!files) throw new Error("Files database missing");
        const blob = await createBlob(client, { mimeType: "audio/mp4", byteSize: 12, storageKey: "audio/test.m4a" });
        await updateItemWithClient(
          client,
          {
            databaseId: proposalsId,
            itemId: proposalId,
            propertiesPatch: {
              proposal: {
                entityKind: "database",
                target: files.id,
                properties: { name: "Audio", type: "audio", file: { blobId: blob.id } },
              },
            },
          },
          { allowedSystemKeys: ["proposal"] },
        );
      });
      const queued = () =>
        pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE task_identifier = 'transcriptionJob'",
        );
      const before = await queued();
      const response = await createConfirmProposalRouteHandler(pool)({ params: { id: proposalId }, body: {} });
      if (!("item" in response)) throw new Error("Missing item result");
      expect(response.results).toEqual([expect.objectContaining({ databaseKey: "files", followUp: null })]);
      expect((await queued()).rows).toEqual(before.rows);
    });

    it("returns the transcript item for a confirmed transcript relation", async () => {
      const dataPool = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
      const failures: unknown[] = [];
      try {
        const role = await dataPool.query<{ name: string; bypass: boolean; superuser: boolean }>(
          "SELECT current_user AS name, rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
        );
        expect(role.rows).toEqual([{ name: "semprec_data", bypass: false, superuser: false }]);
        await runInTenant(getTenantZeroId(), async () => {
          const transcriptId = await databaseIdFor("transcripts");
          const eventsId = await databaseIdFor("events");
          const { transcript, event, cardId } = await withTransaction(dataPool, async (client) => {
            const transcript = await createItemWithClient(
              client,
              { databaseId: transcriptId, properties: { name: "Meeting", date: "2024-03-01T12:00:00.000Z" } },
              { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
            );
            await matchTranscriptToEvent(client, { transcriptId: transcript.id, durationSeconds: 60 });
            const { rows } = await client.query<{ id: string }>(
              "SELECT id FROM items WHERE database_id = $1 AND properties->>'kind' = 'transcript'",
              [proposalsId],
            );
            if (!rows[0]) throw new Error("Missing transcript proposal");
            const event = await createItemWithClient(client, {
              databaseId: eventsId,
              properties: { name: "Meeting", type: "meeting", date: "2024-03-01T12:00:00.000Z" },
            });
            return { transcript, event, cardId: rows[0].id };
          });
          await withTransaction(dataPool, (client) =>
            reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId, {
              message: "Link the existing event",
              entityKind: "relation",
              target: event.id,
              properties: { propertyKey: "event" },
            }),
          );
          const response = await createConfirmProposalRouteHandler(dataPool)({ params: { id: cardId }, body: {} });
          if (!("item" in response)) throw new Error("Missing item result");
          expect(response.results).toEqual([
            expect.objectContaining({ itemId: transcript.id, role: "primary", linkLabels: ["Meeting"] }),
          ]);
          expect(response.item.properties.resultItemId).toBe(event.id);
        });
      } catch (error) {
        failures.push(error);
      }
      try {
        await dataPool.end();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Transcript test and settlement failed");
    });

    it("refuses a task card without a name with a ValidationError naming the field, and creates no task", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const tasks = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "tasks"));
      if (!tasks) throw new Error("Tasks database missing");
      await withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          {
            databaseId: proposalsId,
            itemId: proposalId,
            propertiesPatch: { proposal: { entityKind: "database", target: tasks.id, properties: {} } },
          },
          { allowedSystemKeys: ["proposal"] },
        ),
      );
      const countTasks = async () =>
        (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [tasks.id]))
          .rows[0]?.n;
      const before = await countTasks();

      const error = await createConfirmProposalRouteHandler(pool)({ params: { id: proposalId }, body: {} }).then(
        () => null,
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ status: 400, details: { field: "name" } });
      expect(await countTasks()).toBe(before);
    });

    it("does not report an MCP sync enqueue for a server confirm", async () => {
      const proposalId = await createDatabaseProposal("Server");
      await withTransaction(pool, async (client) => {
        const servers = await getDatabaseByModuleId(client, "mcpServers");
        if (!servers) throw new Error("MCP servers database missing");
        await updateItemWithClient(
          client,
          {
            databaseId: proposalsId,
            itemId: proposalId,
            propertiesPatch: {
              proposal: {
                entityKind: "database",
                target: servers.id,
                properties: {
                  name: "Server",
                  active: false,
                  connectionConfig: { transport: "http", url: "https://mcp.example.com/mcp" },
                },
              },
            },
          },
          { allowedSystemKeys: ["proposal"] },
        );
      });
      const queued = () =>
        pool.query<{ task_identifier: string }>(
          "SELECT task_identifier FROM graphile_worker.jobs WHERE task_identifier LIKE 'mcp%Sync%' ORDER BY task_identifier",
        );
      const before = await queued();
      const response = await createConfirmProposalRouteHandler(pool)({ params: { id: proposalId }, body: {} });
      if (!("item" in response)) throw new Error("Missing item result");
      expect(response.results).toEqual([expect.objectContaining({ databaseKey: null, followUp: null })]);
      expect((await queued()).rows).toEqual(before.rows);
    });

    it("records Event and Journal calendar days in their confirmation results", async () => {
      const eventCard = await createDatabaseProposal("Event");
      const journalCard = await createDatabaseProposal("Journal");
      await withTransaction(pool, async (client) => {
        const events = await getDatabaseByModuleId(client, "events");
        const journal = await getDatabaseByModuleId(client, "journal");
        if (!events || !journal) throw new Error("Events or Journal missing");
        const day = await getOrCreateJournalItem(client, journal.id, "day", new Date("2026-08-28T12:00:00Z"), "UTC");
        await updateItemWithClient(
          client,
          {
            databaseId: proposalsId,
            itemId: eventCard,
            propertiesPatch: {
              proposal: {
                entityKind: "database",
                target: events.id,
                properties: { name: "Meeting", type: "meeting", date: "2026-08-28T12:00:00.000Z" },
              },
            },
          },
          { allowedSystemKeys: ["proposal"] },
        );
        await updateItemWithClient(
          client,
          {
            databaseId: proposalsId,
            itemId: journalCard,
            propertiesPatch: {
              proposal: {
                entityKind: "pageContent",
                target: day.id,
                properties: { flavour: "paragraph", fields: { content: "Entry" } },
              },
            },
          },
          { allowedSystemKeys: ["proposal"] },
        );
      });
      const handler = createConfirmProposalRouteHandler(pool);
      const event = await handler({ params: { id: eventCard }, body: {} });
      const journal = await handler({ params: { id: journalCard }, body: {} });
      if (!("item" in event) || !("item" in journal)) throw new Error("Missing item result");
      expect(event.results).toEqual([expect.objectContaining({ databaseKey: "events", date: "2026-08-28" })]);
      expect(journal.results).toEqual([
        expect.objectContaining({ databaseKey: "journal", date: "2026-08-28", blockIds: [journalCard] }),
      ]);
    });

    it("rolls back all results and the created file when a later step fails", async () => {
      const proposalId = await createDatabaseProposal("Seed");
      const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "files"));
      if (!files) throw new Error("Files database missing");
      const file = await withTransaction(pool, (client) => newFileValue(client));
      await withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          {
            databaseId: proposalsId,
            itemId: proposalId,
            propertiesPatch: {
              proposal: {
                entityKind: "database",
                target: files.id,
                properties: { name: "Document", file },
                operations: [
                  {
                    ref: "file",
                    op: "create",
                    databaseKey: "files",
                    role: "primary",
                    properties: { name: "Document", file },
                  },
                  {
                    ref: "task",
                    op: "create",
                    databaseKey: "tasks",
                    role: "secondary",
                    properties: { name: "Follow up" },
                  },
                ],
              },
            },
          },
          { allowedSystemKeys: ["proposal"] },
        ),
      );
      const before = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
        files.id,
      ]);
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
      const after = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
        files.id,
      ]);
      expect(after.rows).toEqual(before.rows);
      const card = await pool.query<{ properties: Record<string, unknown> }>(
        "SELECT properties FROM items WHERE id = $1",
        [proposalId],
      );
      expect(card.rows[0]!.properties.status).toBe("proposed");
      expect(card.rows[0]!.properties.results).toBeUndefined();
    });

    it("confirms a pending proposal, a thin mapping onto confirmProposalWithClient", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const handler = createConfirmProposalRouteHandler(pool);

      const result = await handler({ params: { id: proposalId }, body: {} });

      expect(result.status).toBe(200);
      expect("item" in result && result.item.properties.status).toBe("confirmed");
      expect("item" in result && typeof result.item.properties.resultItemId).toBe("string");
    });

    it("addresses realtime invalidation to the authenticated user", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const handler = createConfirmProposalRouteHandler(pool);
      const userId = randomUUID();
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await handler({ params: { id: proposalId }, body: {}, identity: { user: { id: userId } } });
      } finally {
        setInvalidationHook(() => {});
      }
      const itemEvents = events.filter((event) => event.scope === "item");
      expect(itemEvents.length).toBeGreaterThanOrEqual(2);
      expect(itemEvents.every((event) => event.userId === userId)).toBe(true);
    });

    it("rejects a request with no `id` path parameter", async () => {
      const handler = createConfirmProposalRouteHandler(pool);
      await expect(handler({ params: {}, body: {} })).rejects.toThrow(ValidationError);
    });

    it("rejects an unknown proposal id", async () => {
      const handler = createConfirmProposalRouteHandler(pool);
      await expect(handler({ params: { id: "00000000-0000-0000-0000-000000000000" }, body: {} })).rejects.toThrow(
        NotFoundError,
      );
    });

    it("rejects a credential missing a plaintext", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const handler = createConfirmProposalRouteHandler(pool);

      await expect(
        handler({ params: { id: proposalId }, body: { credential: { credentialType: "bearer_token" } } }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("createRejectProposalRouteHandler (issue #1845)", () => {
    /** The ids of the cards `GET /api/inbox/cards` lists for the tenant's only user. */
    async function listedCardIds(): Promise<string[]> {
      const userId = (await createTenantZeroUser(pool)).id;
      const answer = await createInboxCardsRouteHandler(pool)({ identity: { user: { id: userId, locale: "en" } } });
      if (!("body" in answer)) throw new Error("expected a raw JSON body");
      const body = z.object({ cards: z.array(z.object({ cardId: z.string() })) }).parse(answer.body);
      return body.cards.map((card) => card.cardId);
    }

    /** Sets a card's stored `status` through the choke point: `needsClarification` has no producer in the tick of these tests. */
    async function setStatus(cardId: string, status: string): Promise<void> {
      await withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          { databaseId: proposalsId, itemId: cardId, propertiesPatch: { status } },
          { allowedSystemKeys: ["status"] },
        ),
      );
    }

    function historyOf(item: ItemRow): unknown[] {
      return z.array(z.unknown()).parse(item.properties.history);
    }

    async function reject(proposalId: string, body: unknown = {}): Promise<ItemRow> {
      const answer = await createRejectProposalRouteHandler(pool)({ params: { id: proposalId }, body });
      expect(answer.status).toBe(200);
      if (!("item" in answer)) throw new Error("expected an item answer");
      return answer.item;
    }

    it.each(["proposed", "needsClarification", "invalid"])(
      "closes a %s card: status rejected, one rejected history entry, gone from the card list",
      async (status) => {
        const proposalId = await createDatabaseProposal("Buy milk");
        if (status !== "proposed") await setStatus(proposalId, status);
        const before = await itemsStore.getItemById(pool, proposalsId, proposalId);
        expect(await listedCardIds()).toContain(proposalId);

        const item = await reject(proposalId);

        expect(item.id).toBe(proposalId);
        expect(item.properties.status).toBe("rejected");
        const history = historyOf(item);
        expect(history).toHaveLength(historyOf(before!).length + 1);
        expect(history.at(-1)).toMatchObject({ author: "user", message: "Rejected by user.", kind: "rejected" });
        expect(await listedCardIds()).not.toContain(proposalId);
      },
    );

    it("closes a transcript card", async () => {
      const cardId = await runInTenant(getTenantZeroId(), () =>
        withTransaction(pool, async (client) => {
          const transcriptsId = await databaseIdFor("transcripts");
          const transcript = await createItemWithClient(
            client,
            { databaseId: transcriptsId, properties: { name: "Standup", date: "2026-08-28T08:00:00.000Z" } },
            { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
          );
          await matchTranscriptToEvent(client, { transcriptId: transcript.id, durationSeconds: 60 });
          const { rows } = await client.query<{ id: string }>(
            "SELECT id FROM items WHERE database_id = $1 AND properties->>'kind' = 'transcript'",
            [proposalsId],
          );
          if (!rows[0]) throw new Error("matchTranscriptToEvent stored no card");
          return rows[0].id;
        }),
      );
      expect(await listedCardIds()).toContain(cardId);

      const item = await reject(cardId);

      expect(item.properties.status).toBe("rejected");
      expect(historyOf(item).at(-1)).toMatchObject({ author: "user", kind: "rejected" });
      expect(await listedCardIds()).not.toContain(cardId);
    });

    it("stores the supplied message as the text of the history entry", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");

      const item = await reject(proposalId, { message: "Already done by hand" });

      expect(historyOf(item).at(-1)).toMatchObject({
        author: "user",
        message: "Already done by hand",
        kind: "rejected",
      });
    });

    it("accepts a null body as a reject without a message", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");

      const item = await reject(proposalId, null);

      expect(item.properties.status).toBe("rejected");
      expect(historyOf(item).at(-1)).toMatchObject({ message: "Rejected by user." });
    });

    it("answers a repeated call with the same card and adds no second history entry", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const first = await reject(proposalId);

      const second = await reject(proposalId, { message: "Changed my mind about the reason" });

      // The first answer is the update's result and the second a read of the stored row, so only their stored fields compare.
      expect({ id: second.id, properties: second.properties, updatedAt: second.updatedAt }).toEqual({
        id: first.id,
        properties: first.properties,
        updatedAt: first.updatedAt,
      });
      expect(historyOf(second)).toHaveLength(historyOf(first).length);
    });

    it("refuses a confirmed card with validation_failed on status and writes nothing", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      await createConfirmProposalRouteHandler(pool)({ params: { id: proposalId }, body: {} });
      const before = await itemsStore.getItemById(pool, proposalsId, proposalId);

      await expect(
        createRejectProposalRouteHandler(pool)({ params: { id: proposalId }, body: {} }),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "status" } });

      expect(await itemsStore.getItemById(pool, proposalsId, proposalId)).toEqual(before);
      expect(before?.properties.status).toBe("confirmed");
    });

    it("answers 404 for an unknown card id", async () => {
      await expect(
        createRejectProposalRouteHandler(pool)({ params: { id: randomUUID() }, body: {} }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("answers 404 for a soft-deleted card", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, proposalsId, proposalId));

      await expect(
        createRejectProposalRouteHandler(pool)({ params: { id: proposalId }, body: {} }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("rejects a request with no `id` path parameter", async () => {
      await expect(createRejectProposalRouteHandler(pool)({ params: {}, body: {} })).rejects.toThrow(ValidationError);
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

    it("accepts a message of exactly the length cap", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");

      const item = await reject(proposalId, { message: "x".repeat(1000) });

      expect(item.properties.status).toBe("rejected");
    });
  });

  describe("createReopenProposalRouteHandler (issue #1937)", () => {
    /** Older than any stored `updatedAt`, so it never equals the version a card holds. */
    const STALE_VERSION = "2000-01-01T00:00:00.000Z";

    async function storedCard(cardId: string): Promise<ItemRow> {
      const card = await itemsStore.getItemById(pool, proposalsId, cardId);
      if (!card) throw new Error(`Card ${cardId} is missing`);
      return card;
    }

    function historyOf(item: ItemRow): unknown[] {
      return z.array(z.unknown()).parse(item.properties.history);
    }

    /** The stored fields of a card: an update's answer also carries the write's own metadata, which a read of the row has not. */
    function storedFields(item: ItemRow) {
      return { id: item.id, properties: item.properties, updatedAt: item.updatedAt };
    }

    /** The ids of the cards `GET /api/inbox/cards` lists for the tenant's only user. */
    async function listedCardIds(): Promise<string[]> {
      const userId = (await createTenantZeroUser(pool)).id;
      const answer = await createInboxCardsRouteHandler(pool)({ identity: { user: { id: userId, locale: "en" } } });
      if (!("body" in answer)) throw new Error("expected a raw JSON body");
      const body = z.object({ cards: z.array(z.object({ cardId: z.string() })) }).parse(answer.body);
      return body.cards.map((card) => card.cardId);
    }

    /** Writes properties the tick of these tests never produces (a status, a stored envelope), through the choke point. */
    async function patchCard(cardId: string, propertiesPatch: Record<string, unknown>): Promise<void> {
      await withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          { databaseId: proposalsId, itemId: cardId, propertiesPatch },
          { allowedSystemKeys: Object.keys(propertiesPatch) },
        ),
      );
    }

    async function reject(cardId: string): Promise<ItemRow> {
      const answer = await createRejectProposalRouteHandler(pool)({ params: { id: cardId }, body: {} });
      if (!("item" in answer)) throw new Error("expected an item answer");
      return answer.item;
    }

    async function reopen(cardId: string, body: unknown = {}): Promise<ItemRow> {
      const answer = await createReopenProposalRouteHandler(pool)({ params: { id: cardId }, body });
      expect(answer.status).toBe(200);
      if (!("item" in answer)) throw new Error("expected an item answer");
      return answer.item;
    }

    /** What a reopen may write: every item's version and every queued Journal recompute job. */
    async function writtenState(): Promise<{ items: string[]; recomputeJobs: number }> {
      const items = await pool.query<{ id: string; updated_at: Date }>("SELECT id, updated_at FROM items ORDER BY id");
      const jobs = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE task_identifier = 'journalInboxRecompute'",
      );
      return {
        items: items.rows.map((row) => `${row.id} ${row.updated_at.toISOString()}`),
        recomputeJobs: jobs.rows[0]!.n,
      };
    }

    /**
     * Removes the queued Journal recompute jobs. `graphile_worker.jobs` is a read-only view, so the delete goes to the
     * table behind it (graphile-worker 0.16, as `inboxTickRecompute.test.ts` does it); a job queued afterwards is the
     * reopen's own.
     */
    async function clearRecomputeJobs(): Promise<void> {
      await pool.query(
        `DELETE FROM graphile_worker._private_jobs
         WHERE task_id IN (SELECT id FROM graphile_worker._private_tasks WHERE identifier = 'journalInboxRecompute')`,
      );
    }

    it("returns a rejected card to proposed with the same proposal and overrides, and lists it again", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      await createUpdateProposalValuesRouteHandler(pool)({
        params: { id: cardId },
        body: { set: { primary: { name: "Buy oat milk" } } },
      });
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
      // The earlier history stays as it was and one `reopened` entry follows it.
      expect(historyOf(item).slice(0, -1)).toEqual(historyOf(rejected));
      expect(historyOf(item).at(-1)).toMatchObject({ author: "user", message: "Reopened by user.", kind: "reopened" });
      expect(await listedCardIds()).toContain(cardId);
      expect(storedFields(await storedCard(cardId))).toEqual(storedFields(item));
    });

    it("announces the card to the stack and queues the Journal recompute", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      await reject(cardId);
      await clearRecomputeJobs();
      const events: InboxCardsInvalidationEvent[] = [];
      setInboxCardsInvalidationHook((event) => events.push(event));
      try {
        await reopen(cardId);
      } finally {
        setInboxCardsInvalidationHook(() => {});
      }

      expect(events).toEqual([{ op: "updated", cardId }]);
      expect((await writtenState()).recomputeJobs).toBe(1);
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

    it("reopens a rejected card when ifVersion is its current updatedAt", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      await reject(cardId);
      const { updatedAt } = await storedCard(cardId);

      const item = await reopen(cardId, { ifVersion: updatedAt });

      expect(item.properties.status).toBe("proposed");
    });

    it("makes the card invalid when its stored envelope no longer validates, and keeps the envelope", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      const tasksId = await databaseIdFor("tasks");
      // An envelope the tick would refuse (`unknownProperty` is no Tasks property); the tick of these tests never stores one.
      const envelope = { entityKind: "database", target: tasksId, properties: { unknownProperty: "x" } };
      await patchCard(cardId, { proposal: envelope, status: "rejected" });

      const item = await reopen(cardId);

      expect(item.properties.status).toBe("invalid");
      expect(item.properties.proposal).toEqual(envelope);
      expect(historyOf(item).at(-1)).toMatchObject({ kind: "reopened" });
      expect(await listedCardIds()).toContain(cardId);
    });

    it("makes the card invalid when it holds no stored envelope", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      await patchCard(cardId, { proposal: null, status: "rejected" });

      const item = await reopen(cardId);

      expect(item.properties.status).toBe("invalid");
      expect(item.properties.proposal).toBeNull();
    });

    it("clears the invalidReason a card kept from before it was discarded", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      const invalidReason = { code: "targetDeleted", field: "project", itemId: randomUUID(), label: "Gone" };
      await patchCard(cardId, { invalidReason, status: "rejected" });

      const item = await reopen(cardId);

      expect(item.properties.status).toBe("proposed");
      expect(item.properties.invalidReason).toBeNull();
    });

    it("keeps the card invalid with its sourceDeleted reason while the source Inbox item is still deleted", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      // The id of an Inbox item that does not exist stands for the deleted source the tick marked the card with.
      const invalidReason = { code: "sourceDeleted", field: "", itemId: randomUUID(), label: "Gone" };
      await patchCard(cardId, { invalidReason, status: "rejected" });

      const item = await reopen(cardId);

      expect(item.properties.status).toBe("invalid");
      expect(item.properties.invalidReason).toEqual(invalidReason);
      expect(historyOf(item).at(-1)).toMatchObject({ kind: "reopened" });
      expect(await storedCard(cardId)).toMatchObject({ properties: { status: "invalid", invalidReason } });
    });

    it("clears a sourceDeleted reason when its Inbox item is live again, and returns the card to proposed", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      const { rows } = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [inboxId]);
      const invalidReason = { code: "sourceDeleted", field: "", itemId: rows[0]!.id, label: "Back" };
      await patchCard(cardId, { invalidReason, status: "rejected" });

      const item = await reopen(cardId);

      expect(item.properties.status).toBe("proposed");
      expect(item.properties.invalidReason).toBeNull();
    });

    it("leaves a rejected card locked for the tick: its source is not recomputed", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      const { rows } = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [inboxId]);
      const sourceId = rows[0]!.id;
      const rejected = await reject(cardId);
      await pool.query('UPDATE items SET properties = properties || \'{"text": "Buy oat milk"}\' WHERE id = $1', [
        sourceId,
      ]); // raw: the text of the source changes, which the fingerprint gate would otherwise answer with a recompute

      await createSemprecTickAction(pool, async () => {
        throw new Error("A rejected card must not be recomputed");
      })(
        { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
        { heartbeatId: "hb", projectItemId: "proj", itemId: sourceId },
      );

      expect(storedFields(await storedCard(cardId))).toEqual(storedFields(rejected));
    });

    it("answers 404 for an unknown card id", async () => {
      await expect(
        createReopenProposalRouteHandler(pool)({ params: { id: randomUUID() }, body: {} }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("answers 404 for a soft-deleted card", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      await reject(cardId);
      await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, proposalsId, cardId));

      await expect(createReopenProposalRouteHandler(pool)({ params: { id: cardId }, body: {} })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it("rejects a request with no `id` path parameter", async () => {
      await expect(createReopenProposalRouteHandler(pool)({ params: {}, body: {} })).rejects.toThrow(ValidationError);
    });

    it("accepts a null body as a reopen without ifVersion", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      await reject(cardId);

      const item = await reopen(cardId, null);

      expect(item.properties.status).toBe("proposed");
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

  describe("createReopenProposalRouteHandler on a confirmed card (issue #1943)", () => {
    /** Older than any stored `updatedAt`, so it never equals the version a card holds. */
    const STALE_VERSION = "2000-01-01T00:00:00.000Z";
    const EVENT_DATE = "2024-03-01T12:00:00.000Z";
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

    type Step = ProposalStep;

    /** A test that runs inside tenant zero, which the relation writes need for the value-link propagation they trigger. */
    function tenantIt(name: string, body: () => Promise<void>): void {
      it(name, () => runInTenant(getTenantZeroId(), body));
    }

    /** The stored fields of a card: an update's answer also carries the write's own metadata, which a read of the row has not. */
    function storedFields(item: ItemRow) {
      return { id: item.id, properties: item.properties, updatedAt: item.updatedAt };
    }

    async function storedCard(cardId: string): Promise<ItemRow> {
      const card = await itemsStore.getItemById(pool, proposalsId, cardId);
      if (!card) throw new Error(`Card ${cardId} is missing`);
      return card;
    }

    /** An item of `databaseId` in any state, the Trash included. */
    async function anyItem(itemId: string): Promise<ItemRow> {
      const [item] = await itemsStore.getItemsByIdsIncludingDeleted(pool, [itemId]);
      if (!item) throw new Error(`Item ${itemId} is missing`);
      return item;
    }

    async function createIn(databaseId: string, properties: Record<string, unknown>): Promise<string> {
      const item = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId, properties }));
      return item.id;
    }

    async function confirmCard(cardId: string, body: Record<string, unknown> = {}): Promise<ItemRow> {
      const answer = await createConfirmProposalRouteHandler(pool)({ params: { id: cardId }, body });
      if (!("item" in answer)) throw new Error("expected an item answer");
      expect(answer.item.properties.status).toBe("confirmed");
      return answer.item;
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

    async function edgeExists(a: string, b: string): Promise<boolean> {
      const { rows } = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM item_relations WHERE (item_a = $1 AND item_b = $2) OR (item_a = $2 AND item_b = $1)",
        [a, b],
      );
      return rows[0]!.n > 0;
    }

    function historyOf(item: ItemRow): unknown[] {
      return z.array(z.unknown()).parse(item.properties.history);
    }

    /** What an undo may write: every item's version and its trash state, the origin rows and the credentials. */
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

    function stepsEnvelope(target: string, steps: Step[]): Record<string, unknown> {
      const primary = steps.find((step) => step.role === "primary");
      return { entityKind: "database", target, properties: primary?.properties ?? {}, operations: steps };
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
      const userId = (await createTenantZeroUser(pool)).id;
      const listed = async (): Promise<string[]> => {
        const answer = await createInboxCardsRouteHandler(pool)({ identity: { user: { id: userId, locale: "en" } } });
        if (!("body" in answer)) throw new Error("expected a raw JSON body");
        return z
          .object({ cards: z.array(z.object({ cardId: z.string() })) })
          .parse(answer.body)
          .cards.map((card) => card.cardId);
      };
      expect(await listed()).not.toContain(cardId);

      await reopenCard(cardId);

      expect(await listed()).toContain(cardId);
    });

    tenantIt("announces the card to the stack and queues the Journal recompute", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      await confirmCard(cardId);
      await pool.query(
        `DELETE FROM graphile_worker._private_jobs
         WHERE task_id IN (SELECT id FROM graphile_worker._private_tasks WHERE identifier = 'journalInboxRecompute')`,
      ); // raw: the view over the jobs is read-only (graphile-worker 0.16); a job queued afterwards is the reopen's own
      const events: InboxCardsInvalidationEvent[] = [];
      setInboxCardsInvalidationHook((event) => events.push(event));
      try {
        await reopenCard(cardId);
      } finally {
        setInboxCardsInvalidationHook(() => {});
      }

      expect(events).toEqual([{ op: "updated", cardId }]);
      const jobs = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE task_identifier = 'journalInboxRecompute'",
      );
      expect(jobs.rows[0]!.n).toBe(1);
    });

    tenantIt(
      "answers 409 version_conflict with the task when it was edited after the confirmation, and changes nothing",
      async () => {
        const cardId = await createDatabaseProposal("Buy milk");
        const taskId = z.string().parse((await confirmCard(cardId)).properties.resultItemId);
        await withTransaction(pool, (client) =>
          updateItemWithClient(client, {
            databaseId: tasksId,
            itemId: taskId,
            propertiesPatch: { name: "Buy oat milk" },
          }),
        );
        const before = await writtenState();
        const card = await storedCard(cardId);

        await expect(callReopen(cardId)).rejects.toMatchObject({
          status: 409,
          code: "version_conflict",
          details: { itemId: taskId, databaseKey: "tasks", label: "Buy milk" },
        });

        expect(await writtenState()).toEqual(before);
        expect(await storedCard(cardId)).toEqual(card);
        expect(card.properties.status).toBe("confirmed");
        expect((await anyItem(taskId)).properties.name).toBe("Buy oat milk");
      },
    );

    tenantIt("answers 409 when the created task was moved to the trash after the confirmation", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      const taskId = z.string().parse((await confirmCard(cardId)).properties.resultItemId);
      await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, tasksId, taskId));
      const before = await writtenState();

      await expect(callReopen(cardId)).rejects.toMatchObject({
        status: 409,
        code: "version_conflict",
        details: { itemId: taskId },
      });

      expect(await writtenState()).toEqual(before);
    });

    tenantIt("answers 409 when the created task was deleted for good after the confirmation", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      const taskId = z.string().parse((await confirmCard(cardId)).properties.resultItemId);
      const task = await anyItem(taskId);
      await withTransaction(pool, async (client) => {
        await deleteItemDependents(client, task);
        await client.query("DELETE FROM items WHERE id = $1", [taskId]); // raw: the purge of an expired Trash row
      });
      const before = await writtenState();

      await expect(callReopen(cardId)).rejects.toMatchObject({
        status: 409,
        code: "version_conflict",
        details: { itemId: taskId, databaseKey: "tasks" },
      });

      expect(await writtenState()).toEqual(before);
    });

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

        const { item } = await reopenCard(cardId, { ifVersion: card.updatedAt });
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
        await withTransaction(pool, (client) => deleteDocByItemId(client, hostId));

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

    describe("transcript cards", () => {
      async function createTranscript(name: string): Promise<string> {
        return withTransaction(pool, async (client) => {
          const transcript = await createItemWithClient(
            client,
            { databaseId: transcriptsId, properties: { name, date: EVENT_DATE } },
            { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
          );
          return transcript.id;
        });
      }

      async function propertyIdFor(databaseId: string, key: string): Promise<string> {
        const { rows } = await pool.query<{ id: string }>(
          "SELECT id FROM properties WHERE database_id = $1 AND key = $2",
          [databaseId, key],
        );
        if (!rows[0]) throw new Error(`Property '${key}' was not seeded`);
        return rows[0].id;
      }

      async function onlyTranscriptCardId(): Promise<string> {
        const { rows } = await pool.query<{ id: string }>(
          "SELECT id FROM items WHERE database_id = $1 AND properties->>'kind' = 'transcript' AND deleted_at IS NULL",
          [proposalsId],
        );
        if (rows.length !== 1 || !rows[0]) throw new Error(`Expected one transcript card, found ${rows.length}`);
        return rows[0].id;
      }

      /** A transcript with one speaker, its Event with a participant person, and the card that proposes that person for the speaker. */
      async function createSpeakerCard() {
        const transcriptId = await createTranscript("Speaker fixture");
        const personId = await createIn(peopleId, { name: "Alice" });
        const eventId = await createIn(eventsId, { name: "Meeting", type: "meeting", date: EVENT_DATE });
        await withTransaction(pool, async (client) => {
          await itemsStore.writeComputed(client, transcriptsId, transcriptId, "segments", [
            { speaker: "SPEAKER_01", text: "Hello", startsAt: 0, endsAt: 1 },
          ]);
          // The suggestion is proposed only for a person who took part in the transcript's Event.
          await createRelationWithClient(client, {
            relationPropertyId: await propertyIdFor(eventsId, "people"),
            callerItemId: eventId,
            targetItemId: personId,
          });
          await createRelationWithClient(client, {
            relationPropertyId: await propertyIdFor(transcriptsId, "event"),
            callerItemId: transcriptId,
            targetItemId: eventId,
          });
          await proposeSpeakerMappings(client, {
            transcriptId,
            suggestions: [{ speaker: "SPEAKER_01", personId, reason: "Recognized from the discussion" }],
          });
        });
        return { cardId: await onlyTranscriptCardId(), transcriptId, personId, eventId };
      }

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
          // Trashing the materialized item would read as a cancelled occurrence, so it stays (the ADR of the undo says why).
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
        const areaProperty = await withTransaction(pool, (client) =>
          propertiesStore.getPropertyByKey(client, projectsDb, "area"),
        );
        if (!areaProperty) throw new Error("Projects has no area property");
        await withTransaction(pool, (client) =>
          createRelationWithClient(client, {
            relationPropertyId: areaProperty.id,
            callerItemId: projectId,
            targetItemId: oldArea,
          }),
        );
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
        const areaProperty = await withTransaction(pool, (client) =>
          propertiesStore.getPropertyByKey(client, projectsDb, "area"),
        );
        if (!areaProperty) throw new Error("Projects has no area property");
        await withTransaction(pool, (client) =>
          createRelationWithClient(client, {
            relationPropertyId: areaProperty.id,
            callerItemId: projectId,
            targetItemId: oldArea,
          }),
        );
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
        const areaProperty = await withTransaction(pool, (client) =>
          propertiesStore.getPropertyByKey(client, projectsDb, "area"),
        );
        if (!areaProperty) throw new Error("Projects has no area property");
        // The user linked the pair by hand before the card was confirmed; the confirm writes the same pair again.
        await withTransaction(pool, (client) =>
          createRelationWithClient(client, {
            relationPropertyId: areaProperty.id,
            callerItemId: projectId,
            targetItemId: areaId,
          }),
        );
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
        const peopleProperty = await withTransaction(pool, (client) =>
          propertiesStore.getPropertyByKey(client, eventsDb, "people"),
        );
        if (!peopleProperty) throw new Error("Events has no people property");
        await withTransaction(pool, (client) =>
          createRelationWithClient(client, {
            relationPropertyId: peopleProperty.id,
            callerItemId: eventId,
            targetItemId: alice,
            metadata: { role: "attendee" },
          }),
        );
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
            text: "Pay the invoice",
            type: type.id,
          }),
        );
        const attachmentId = await withTransaction(pool, async (client) => {
          const blob = await createBlob(client, {
            mimeType: "application/pdf",
            byteSize: 2048,
            storageKey: `blobs/${randomUUID()}`,
          });
          await insertInboxAttachments(client, item.id, [{ blobId: blob.id, source: "camera" }]);
          const [attachment] = await listInboxAttachments(client, [item.id]);
          if (!attachment) throw new Error("The attachment was not stored");
          return attachment.attachmentId;
        });
        await createSemprecTickAction(pool, async () => ({ properties: { name: "Pay the invoice" } }))(
          { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
          { heartbeatId: "hb", projectItemId: "proj", itemId: item.id },
        );
        const { rows } = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [proposalsId]);
        const cardId = rows[0]!.id;
        const steps: Step[] = [
          { ref: "task", op: "create", databaseKey: "tasks", role: "primary", properties: { name: "Pay the invoice" } },
          {
            ref: "file",
            op: "fileFromAttachment",
            role: "secondary",
            properties: { attachmentId, name: "Invoice" },
          },
        ];
        const envelope = stepsEnvelope(tasksId, steps);
        await withTransaction(pool, (client) =>
          updateItemWithClient(
            client,
            {
              databaseId: proposalsId,
              itemId: cardId,
              propertiesPatch: { proposal: envelope, aiProposal: envelope },
            },
            { allowedSystemKeys: ["proposal", "aiProposal"] },
          ),
        );
        return { cardId, inboxItemId: item.id };
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
      const mcpServersId = await databaseIdFor("mcpServers");
      const envelope = {
        entityKind: "database",
        target: mcpServersId,
        properties: { name: "Remote tool", connectionConfig: { transport: "sse", url: "https://mcp.example.com/sse" } },
      };
      await withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          { databaseId: proposalsId, itemId: cardId, propertiesPatch: { proposal: envelope, aiProposal: envelope } },
          { allowedSystemKeys: ["proposal", "aiProposal"] },
        ),
      );
      const confirmed = await confirmCard(cardId, { credential: { credentialType: "api_key", plaintext: "sk-test" } });
      const serverId = z.string().parse(confirmed.properties.resultItemId);
      expect(await withTransaction(pool, (client) => hasCredential(client, serverId))).toBe(true);

      await reopenCard(cardId);

      expect(await withTransaction(pool, (client) => hasCredential(client, serverId))).toBe(false);
      expect((await anyItem(serverId)).deletedAt).not.toBeNull();
    });

    tenantIt("refuses a confirmed card that recorded no results, and changes nothing", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      await withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          { databaseId: proposalsId, itemId: cardId, propertiesPatch: { status: "confirmed" } },
          { allowedSystemKeys: ["status"] },
        ),
      );
      const before = await storedCard(cardId);

      await expect(callReopen(cardId)).rejects.toMatchObject({
        status: 400,
        code: "validation_failed",
        details: { field: "results" },
      });

      expect(await storedCard(cardId)).toEqual(before);
    });

    tenantIt("refuses a confirmed card with no stored envelope", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      await confirmCard(cardId);
      await withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          { databaseId: proposalsId, itemId: cardId, propertiesPatch: { proposal: null } },
          { allowedSystemKeys: ["proposal"] },
        ),
      );

      await expect(callReopen(cardId)).rejects.toMatchObject({
        status: 400,
        code: "validation_failed",
        details: { field: "proposal" },
      });
    });

    tenantIt(
      "refuses a confirmed card whose envelope has an entityKind this release does not know with 409",
      async () => {
        const cardId = await createDatabaseProposal("Buy milk");
        await confirmCard(cardId);
        const unknown = { entityKind: "futureKind", target: "x", properties: {} };
        await withTransaction(pool, (client) =>
          updateItemWithClient(
            client,
            { databaseId: proposalsId, itemId: cardId, propertiesPatch: { proposal: unknown } },
            { allowedSystemKeys: ["proposal"] },
          ),
        );

        await expect(callReopen(cardId)).rejects.toMatchObject({ status: 409, details: { field: "entityKind" } });
      },
    );
  });

  describe("ifVersion on confirm and reject (issue #1852)", () => {
    /** Older than any stored `updatedAt`, so it never equals the version a card holds. */
    const STALE_VERSION = "2000-01-01T00:00:00.000Z";
    const handlers = { confirm: createConfirmProposalRouteHandler, reject: createRejectProposalRouteHandler } as const;
    type Action = keyof typeof handlers;
    const ACTIONS: Action[] = ["confirm", "reject"];
    const TERMINAL_STATUS: Record<Action, string> = { confirm: "confirmed", reject: "rejected" };

    async function storedCard(cardId: string): Promise<ItemRow> {
      const card = await itemsStore.getItemById(pool, proposalsId, cardId);
      if (!card) throw new Error(`Card ${cardId} is missing`);
      return card;
    }

    /** What an action may write: every item, every queued job and every history entry. */
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

    function itemOf(answer: Awaited<ReturnType<typeof call>>): ItemRow {
      if (!("item" in answer)) throw new Error("expected an item answer");
      return answer.item;
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
      const { updatedAt } = await storedCard(cardId);

      const item = itemOf(await call(action, cardId, { ifVersion: updatedAt }));

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

    it("confirm: a rejected card answers 400 on status with its current status, also with a stale ifVersion", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      await call("reject", cardId, {});
      const before = await writtenState(cardId);

      for (const body of [{}, { ifVersion: STALE_VERSION }]) {
        await expect(call("confirm", cardId, body)).rejects.toMatchObject({
          status: 400,
          code: "validation_failed",
          details: { field: "status", currentStatus: "rejected" },
        });
      }
      expect(await writtenState(cardId)).toEqual(before);
    });

    it("confirm: a card that needs clarification answers 400 on status with its current status", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      await withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          { databaseId: proposalsId, itemId: cardId, propertiesPatch: { status: "needsClarification" } },
          { allowedSystemKeys: ["status"] },
        ),
      );
      const { updatedAt } = await storedCard(cardId);

      await expect(call("confirm", cardId, { ifVersion: updatedAt })).rejects.toMatchObject({
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

    it("reject: a confirmed card answers 400 on status with its current status, also with a stale ifVersion", async () => {
      const cardId = await createDatabaseProposal("Buy milk");
      await call("confirm", cardId, {});
      const before = await writtenState(cardId);

      for (const body of [{}, { ifVersion: STALE_VERSION }]) {
        await expect(call("reject", cardId, body)).rejects.toMatchObject({
          status: 400,
          code: "validation_failed",
          details: { field: "status", currentStatus: "confirmed" },
        });
      }
      expect(await writtenState(cardId)).toEqual(before);
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

  describe("createReviseProposalRouteHandler (issue #1870)", () => {
    const EVENT_DATE = "2024-03-01T12:00:00.000Z";
    let dataPool: Pool;
    let transcriptsId: string;
    let eventsId: string;
    let peopleId: string;

    beforeEach(async () => {
      dataPool = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
      transcriptsId = await databaseIdFor("transcripts");
      eventsId = await databaseIdFor("events");
      peopleId = await databaseIdFor("people");
    });

    afterEach(async () => {
      await dataPool.end();
    });

    /** Runs `body` inside tenant zero, so everything below goes through the runtime role and its row-level security. */
    function inTenant<T>(body: () => Promise<T>): Promise<T> {
      return runInTenant(getTenantZeroId(), body);
    }

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

    function historyOf(card: { properties: Record<string, unknown> }): Array<Record<string, unknown>> {
      const history = card.properties.history;
      if (!Array.isArray(history)) throw new Error("Card has no history");
      return history as Array<Record<string, unknown>>;
    }

    async function createEvent(name: string): Promise<string> {
      const event = await inTenant(() =>
        withTransaction(dataPool, (client) =>
          createItemWithClient(client, {
            databaseId: eventsId,
            properties: { name, type: "meeting", date: EVENT_DATE },
          }),
        ),
      );
      return event.id;
    }

    async function createTranscript(name: string): Promise<string> {
      const transcript = await inTenant(() =>
        withTransaction(dataPool, (client) =>
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

    /** The card the match step emits for a recording with no Event in its window: a create-Event proposal. */
    async function createEventCard(): Promise<string> {
      const transcriptId = await createTranscript("Weekly sync");
      await inTenant(() =>
        withTransaction(dataPool, (client) => matchTranscriptToEvent(client, { transcriptId, durationSeconds: 3600 })),
      );
      return onlyTranscriptCardId();
    }

    /** The card that proposes who a transcript's speaker is. */
    async function createSpeakerCard(): Promise<{ cardId: string; personId: string }> {
      const transcriptId = await createTranscript("Speaker fixture");
      const person = await inTenant(() =>
        withTransaction(dataPool, (client) =>
          createItemWithClient(client, { databaseId: peopleId, properties: { name: "Alice" } }),
        ),
      );
      const meetingId = await createEvent("Meeting");
      const propertyIdFor = async (databaseId: string, key: string): Promise<string> => {
        const { rows } = await pool.query<{ id: string }>(
          "SELECT id FROM properties WHERE database_id = $1 AND key = $2",
          [databaseId, key],
        );
        if (!rows[0]) throw new Error(`Property '${key}' was not seeded`);
        return rows[0].id;
      };
      const eventPeopleId = await propertyIdFor(eventsId, "people");
      const transcriptEventId = await propertyIdFor(transcriptsId, "event");
      await inTenant(() =>
        withTransaction(dataPool, async (client) => {
          await itemsStore.writeComputed(client, transcriptsId, transcriptId, "segments", [
            { speaker: "SPEAKER_01", text: "Hello", startsAt: 0, endsAt: 1 },
          ]);
          // The suggestion is proposed only for a person who took part in the transcript's Event.
          await createRelationWithClient(client, {
            relationPropertyId: eventPeopleId,
            callerItemId: meetingId,
            targetItemId: person.id,
          });
          await createRelationWithClient(client, {
            relationPropertyId: transcriptEventId,
            callerItemId: transcriptId,
            targetItemId: meetingId,
          });
          await proposeSpeakerMappings(client, {
            transcriptId,
            suggestions: [{ speaker: "SPEAKER_01", personId: person.id, reason: "Recognized from the discussion" }],
          });
        }),
      );
      return { cardId: await onlyTranscriptCardId(), personId: person.id };
    }

    function linkEvent(eventId: string) {
      return { entityKind: "relation", target: eventId, properties: { propertyKey: "event" } };
    }

    it("runs through the runtime role, which neither bypasses row-level security nor is a superuser", async () => {
      const role = await dataPool.query<{ name: string; bypass: boolean; superuser: boolean }>(
        "SELECT current_user AS name, rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows).toEqual([{ name: "semprec_data", bypass: false, superuser: false }]);
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
      const other = await inTenant(() =>
        withTransaction(dataPool, (client) =>
          createItemWithClient(client, { databaseId: peopleId, properties: { name: "Bob" } }),
        ),
      );
      const envelope = {
        entityKind: "relation",
        target: other.id,
        properties: { propertyKey: "speakers", metadata: { speaker: "SPEAKER_01" } },
      };

      const response = await callRevise(cardId, envelope);

      if (!("item" in response)) throw new Error("Missing item result");
      expect(response.item.properties.proposal).toEqual(envelope);
      expect(response.item.properties.status).toBe("proposed");
    });

    it("applies an ifVersion that equals the card's updatedAt", async () => {
      const cardId = await createEventCard();
      const eventId = await createEvent("Planning");
      const card = await readCard(cardId);

      const response = await callRevise(cardId, { ...linkEvent(eventId), ifVersion: card.updatedAt });

      expect(response.status).toBe(200);
    });

    it("answers a stale ifVersion with version_conflict carrying the current card and writes nothing", async () => {
      const cardId = await createEventCard();
      const eventId = await createEvent("Planning");
      const stale = (await readCard(cardId)).updatedAt;
      await callRevise(cardId, { message: "A first note" });
      const current = await readCard(cardId);
      expect(current.updatedAt).not.toBe(stale);

      const error = await callRevise(cardId, { ...linkEvent(eventId), ifVersion: stale }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({ status: 409, code: "version_conflict", details: { current } });
      expect(await readCard(cardId)).toEqual(current);
    });

    it("answers an unknown id, an id of another database and a trashed card alike with not found", async () => {
      const cardId = await createEventCard();
      const eventId = await createEvent("Planning");
      const body = { message: "Note" };
      const answers: unknown[] = [];

      for (const id of ["00000000-0000-0000-0000-000000000000", eventId]) {
        const error = await callRevise(id, body).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(NotFoundError);
        answers.push({ status: (error as NotFoundError).status, code: (error as NotFoundError).code });
      }
      await inTenant(() =>
        withTransaction(dataPool, (client) => itemsStore.softDeleteItem(client, proposalsId, cardId)),
      );
      const trashed = await callRevise(cardId, body).catch((e: unknown) => e);
      expect(trashed).toBeInstanceOf(NotFoundError);
      answers.push({ status: (trashed as NotFoundError).status, code: (trashed as NotFoundError).code });

      expect(answers).toEqual([
        { status: 404, code: "not_found" },
        { status: 404, code: "not_found" },
        { status: 404, code: "not_found" },
      ]);
    });

    it("rejects a request with no `id` path parameter", async () => {
      await expect(
        inTenant(() => createReviseProposalRouteHandler(dataPool)({ params: {}, body: { message: "x" } })),
      ).rejects.toThrow(ValidationError);
    });

    it("addresses realtime invalidation to the authenticated user", async () => {
      const cardId = await createEventCard();
      const userId = randomUUID();
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await callRevise(cardId, { message: "Note" }, { user: { id: userId } });
      } finally {
        setInvalidationHook(() => {});
      }
      const itemEvents = events.filter((event) => event.scope === "item");
      expect(itemEvents.length).toBeGreaterThanOrEqual(1);
      expect(itemEvents.every((event) => event.userId === userId)).toBe(true);
    });
  });

  describe("createUpdateProposalValuesRouteHandler (issue #1892)", () => {
    async function readCard(id: string): Promise<ItemRow> {
      const card = await withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, id));
      if (!card) throw new Error(`card ${id} not found`);
      return card;
    }

    it("edits the card, a thin mapping onto updateProposalValuesWithClient", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const handler = createUpdateProposalValuesRouteHandler(pool);

      const result = await handler({
        params: { id: proposalId },
        body: { set: { primary: { name: "Buy oat milk" } } },
      });

      expect(result.status).toBe(200);
      expect("item" in result && result.item.id).toBe(proposalId);
      expect("item" in result && result.item.properties.userEditedKeys).toEqual(["primary.name"]);
      expect("warnings" in result && result.warnings).toEqual([]);
      expect((await readCard(proposalId)).properties.proposal).toMatchObject({ properties: { name: "Buy oat milk" } });
    });

    it("answers a required warning for a field the edit left empty, and saves the card", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const handler = createUpdateProposalValuesRouteHandler(pool);

      const result = await handler({ params: { id: proposalId }, body: { set: { primary: { name: "" } } } });

      expect(result.status).toBe(200);
      expect("warnings" in result && result.warnings).toEqual([{ field: "name", code: "required" }]);
      expect((await readCard(proposalId)).properties.proposal).toMatchObject({ properties: { name: "" } });
    });

    it("passes a current ifVersion through", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const handler = createUpdateProposalValuesRouteHandler(pool);

      const result = await handler({
        params: { id: proposalId },
        body: { set: { primary: { name: "Buy oat milk" } }, ifVersion: (await readCard(proposalId)).updatedAt },
      });

      expect(result.status).toBe(200);
    });

    it("answers a stale ifVersion with a version conflict that carries the current card, and writes nothing", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const stale = (await readCard(proposalId)).updatedAt;
      const handler = createUpdateProposalValuesRouteHandler(pool);
      await handler({ params: { id: proposalId }, body: { set: { primary: { name: "First" } } } });
      const before = await readCard(proposalId);

      const error = await handler({
        params: { id: proposalId },
        body: { set: { primary: { name: "Second" } }, ifVersion: stale },
      }).then(
        () => null,
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({ status: 409, code: "version_conflict" });
      expect(error).toHaveProperty("details.current.id", proposalId);
      expect(await readCard(proposalId)).toEqual(before);
    });

    it("rejects a request with no `id` path parameter", async () => {
      const handler = createUpdateProposalValuesRouteHandler(pool);
      await expect(handler({ params: {}, body: { set: { primary: { name: "x" } } } })).rejects.toThrow(ValidationError);
    });

    it("rejects an unknown proposal id", async () => {
      const handler = createUpdateProposalValuesRouteHandler(pool);
      await expect(
        handler({ params: { id: randomUUID() }, body: { set: { primary: { name: "x" } } } }),
      ).rejects.toThrow(NotFoundError);
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
      const before = await readCard(proposalId);
      const handler = createUpdateProposalValuesRouteHandler(pool);

      const error = await handler({ params: { id: proposalId }, body }).then(
        () => null,
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(ValidationError);
      if (field !== undefined) expect(error).toHaveProperty("details.field", field);
      expect(await readCard(proposalId)).toEqual(before);
    });

    it("edits relation lists and step switches, a thin mapping onto updateProposalValuesWithClient (issue #1920)", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const project = await withTransaction(pool, async (client) => {
        const projects = await getDatabaseByModuleId(client, "projects");
        if (!projects) throw new Error("Projects database missing");
        return createItemWithClient(client, { databaseId: projects.id, properties: { name: "Shopping" } });
      });
      const handler = createUpdateProposalValuesRouteHandler(pool);

      const result = await handler({
        params: { id: proposalId },
        body: { relations: { primary: { project: [project.id] } } },
      });

      expect(result.status).toBe(200);
      expect("item" in result && result.item.properties.userEditedKeys).toEqual(["primary.relations.project"]);
      expect("item" in result && result.item.properties.proposal).toMatchObject({
        relations: { project: [project.id] },
      });
      expect("warnings" in result && result.warnings).toEqual([]);
    });

    it("refuses to switch the primary step off with a ValidationError and writes nothing", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const before = await readCard(proposalId);

      const error = await createUpdateProposalValuesRouteHandler(pool)({
        params: { id: proposalId },
        body: { steps: { primary: { enabled: false } } },
      }).then(
        () => null,
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toHaveProperty("details", { ref: "primary", field: "enabled" });
      expect(await readCard(proposalId)).toEqual(before);
    });

    it("refuses a relation list or a step switch for a ref the card does not have, naming it", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const before = await readCard(proposalId);
      const handler = createUpdateProposalValuesRouteHandler(pool);

      for (const body of [
        { relations: { followup: { project: [PROJECT_ID] } } },
        { steps: { followup: { enabled: false } } },
      ]) {
        const error = await handler({ params: { id: proposalId }, body }).then(
          () => null,
          (err: unknown) => err,
        );
        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toHaveProperty("details", { ref: "followup", field: "followup" });
      }
      expect(await readCard(proposalId)).toEqual(before);
    });

    it("refuses a reserved key in set, and a ref named like an Object member in relations and steps", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const before = await readCard(proposalId);
      const handler = createUpdateProposalValuesRouteHandler(pool);

      await expect(
        handler({ params: { id: proposalId }, body: { set: { primary: { enabled: false } } } }),
      ).rejects.toMatchObject({ details: { ref: "primary", field: "enabled" } });
      for (const part of ["relations", "steps"]) {
        const body: unknown = JSON.parse(
          part === "relations"
            ? `{"relations":{"__proto__":{"project":["${PROJECT_ID}"]}}}`
            : '{"steps":{"__proto__":{"enabled":false}}}',
        );
        await expect(handler({ params: { id: proposalId }, body })).rejects.toThrow(/no step '__proto__'/);
      }
      expect(await readCard(proposalId)).toEqual(before);
    });

    it("passes a ref named like an Object member on as data and refuses it as an unknown ref", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const before = await readCard(proposalId);
      const handler = createUpdateProposalValuesRouteHandler(pool);
      const body: unknown = JSON.parse('{"set":{"__proto__":{"name":"x"}}}');

      await expect(handler({ params: { id: proposalId }, body })).rejects.toThrow(/no step '__proto__'/);

      expect(await readCard(proposalId)).toEqual(before);
    });

    describe("with an Idempotency-Key (issue gh-1894)", () => {
      const userId = randomUUID();
      const keyed = (key: string) => ({
        req: { headers: { "idempotency-key": key } },
        identity: { user: { id: userId } },
      });
      const storedRowCount = async (): Promise<number> => {
        const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM idempotent_responses");
        return rows[0]?.n ?? -1;
      };
      const historyKinds = (card: ItemRow): unknown[] =>
        z
          .array(z.object({ kind: z.string().optional() }))
          .parse(card.properties.history)
          .map((entry) => entry.kind);

      it("applies the edit once and answers the same card to a repeat of the key", async () => {
        const proposalId = await createDatabaseProposal("Buy milk");
        const handler = createUpdateProposalValuesRouteHandler(pool);
        const request = {
          params: { id: proposalId },
          body: { set: { primary: { name: "Buy oat milk" } } },
          ...keyed("key-1"),
        };

        const first = await runInTenant(getTenantZeroId(), () => handler(request));
        const second = await runInTenant(getTenantZeroId(), () => handler(request));

        expect(first.status).toBe(200);
        expect(second).toEqual(first);
        expect("item" in second && second.item.id).toBe(proposalId);
        expect(historyKinds(await readCard(proposalId)).filter((kind) => kind === "userEdit")).toHaveLength(1);
        expect(await storedRowCount()).toBe(1);
      });

      it("answers the required warnings of the first call to a repeat of the key (issues gh-1894, #1928)", async () => {
        const proposalId = await createDatabaseProposal("Buy milk");
        const handler = createUpdateProposalValuesRouteHandler(pool);
        const request = {
          params: { id: proposalId },
          body: { set: { primary: { name: "" } } },
          ...keyed("key-warn"),
        };

        const first = await runInTenant(getTenantZeroId(), () => handler(request));
        const second = await runInTenant(getTenantZeroId(), () => handler(request));

        expect("warnings" in first && first.warnings).toEqual([{ field: "name", code: "required" }]);
        expect(second).toEqual(first);
        expect(historyKinds(await readCard(proposalId)).filter((kind) => kind === "userEdit")).toHaveLength(1);
      });

      it("runs the edit again for another user of the tenant with the same key", async () => {
        const proposalId = await createDatabaseProposal("Buy milk");
        const handler = createUpdateProposalValuesRouteHandler(pool);
        const asOtherUser = { ...keyed("key-1"), identity: { user: { id: randomUUID() } } };
        await runInTenant(getTenantZeroId(), () =>
          handler({ params: { id: proposalId }, body: { set: { primary: { name: "First" } } }, ...keyed("key-1") }),
        );

        await runInTenant(getTenantZeroId(), () =>
          handler({ params: { id: proposalId }, body: { set: { primary: { name: "Second" } } }, ...asOtherUser }),
        );

        const card = await readCard(proposalId);
        expect(historyKinds(card).filter((kind) => kind === "userEdit")).toHaveLength(2);
        expect(card.properties.proposal).toMatchObject({ properties: { name: "Second" } });
        expect(await storedRowCount()).toBe(2);
      });

      it("refuses the key of another body and of another card with validation_failed and applies nothing", async () => {
        const proposalId = await createDatabaseProposal("Buy milk");
        const otherId = await createDatabaseProposal("Buy bread");
        const handler = createUpdateProposalValuesRouteHandler(pool);
        await runInTenant(getTenantZeroId(), () =>
          handler({ params: { id: proposalId }, body: { set: { primary: { name: "A" } } }, ...keyed("key-1") }),
        );
        const before = [await readCard(proposalId), await readCard(otherId)];

        const otherBody = await runInTenant(getTenantZeroId(), () =>
          handler({ params: { id: proposalId }, body: { set: { primary: { name: "B" } } }, ...keyed("key-1") }),
        ).then(
          () => null,
          (err: unknown) => err,
        );
        const otherCard = await runInTenant(getTenantZeroId(), () =>
          handler({ params: { id: otherId }, body: { set: { primary: { name: "A" } } }, ...keyed("key-1") }),
        ).then(
          () => null,
          (err: unknown) => err,
        );

        for (const error of [otherBody, otherCard]) {
          expect(error).toBeInstanceOf(ValidationError);
          expect(error).toHaveProperty("details.field", "Idempotency-Key");
        }
        expect([await readCard(proposalId), await readCard(otherId)]).toEqual(before);
      });

      it("stores nothing for a request without the header", async () => {
        const proposalId = await createDatabaseProposal("Buy milk");
        const handler = createUpdateProposalValuesRouteHandler(pool);

        await handler({ params: { id: proposalId }, body: { set: { primary: { name: "Buy oat milk" } } } });

        expect(await storedRowCount()).toBe(0);
      });

      it("stores nothing for a refused update, so the key can be used again", async () => {
        const proposalId = await createDatabaseProposal("Buy milk");
        const handler = createUpdateProposalValuesRouteHandler(pool);
        const stale = (await readCard(proposalId)).updatedAt;
        await handler({ params: { id: proposalId }, body: { set: { primary: { name: "First" } } } });

        await expect(
          runInTenant(getTenantZeroId(), () =>
            handler({
              params: { id: proposalId },
              body: { set: { primary: { name: "Second" } }, ifVersion: stale },
              ...keyed("key-1"),
            }),
          ),
        ).rejects.toThrow(ConflictError);
        expect(await storedRowCount()).toBe(0);
        const retried = await runInTenant(getTenantZeroId(), async () =>
          handler({
            params: { id: proposalId },
            body: { set: { primary: { name: "Second" } }, ifVersion: (await readCard(proposalId)).updatedAt },
            ...keyed("key-1"),
          }),
        );
        expect(retried.status).toBe(200);
        expect(await storedRowCount()).toBe(1);
      });

      it("refuses an Idempotency-Key longer than 255 characters before opening a transaction", async () => {
        const proposalId = await createDatabaseProposal("Buy milk");
        const before = await readCard(proposalId);
        const handler = createUpdateProposalValuesRouteHandler(pool);

        const error = await runInTenant(getTenantZeroId(), () =>
          handler({ params: { id: proposalId }, body: { set: { primary: { name: "x" } } }, ...keyed("k".repeat(256)) }),
        ).then(
          () => null,
          (err: unknown) => err,
        );

        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toHaveProperty("details.field", "Idempotency-Key");
        expect(await readCard(proposalId)).toEqual(before);
      });

      it("fails a keyed request that carries no authenticated user, and applies nothing", async () => {
        const proposalId = await createDatabaseProposal("Buy milk");
        const before = await readCard(proposalId);
        const handler = createUpdateProposalValuesRouteHandler(pool);

        await expect(
          runInTenant(getTenantZeroId(), () =>
            handler({
              params: { id: proposalId },
              body: { set: { primary: { name: "x" } } },
              req: { headers: { "idempotency-key": "key-1" } },
            }),
          ),
        ).rejects.toThrow("needs the authenticated user");

        expect(await readCard(proposalId)).toEqual(before);
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
        const handler = createUpdateProposalValuesRouteHandler(pool);

        await expect(
          runInTenant(getTenantZeroId(), () => handler({ params: { id: proposalId }, body, ...keyed("key-1") })),
        ).rejects.toThrow(z.ZodError);
      });
    });
  });

  describe("createResetProposalOverridesRouteHandler (issue #1912)", () => {
    async function readCard(id: string): Promise<ItemRow> {
      const card = await withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, id));
      if (!card) throw new Error(`card ${id} not found`);
      return card;
    }
    /** A card with a manual title over the assistant's "Buy milk". */
    async function editedCard(): Promise<string> {
      const proposalId = await createDatabaseProposal("Buy milk");
      await createUpdateProposalValuesRouteHandler(pool)({
        params: { id: proposalId },
        body: { set: { primary: { name: "Buy oat milk" } } },
      });
      return proposalId;
    }

    it("returns the card to the assistant's proposal, a thin mapping onto resetProposalOverridesWithClient", async () => {
      const proposalId = await editedCard();
      const handler = createResetProposalOverridesRouteHandler(pool);

      const result = await handler({ params: { id: proposalId }, body: {} });

      expect(result.status).toBe(200);
      expect("item" in result && result.item.id).toBe(proposalId);
      expect("item" in result && result.item.properties.userEditedKeys).toEqual([]);
      const stored = await readCard(proposalId);
      expect(stored.properties.proposal).toMatchObject({ properties: { name: "Buy milk" } });
      expect(stored.properties.userOverrides).toEqual({});
    });

    it("takes a null body as an empty one", async () => {
      const proposalId = await editedCard();

      const result = await createResetProposalOverridesRouteHandler(pool)({ params: { id: proposalId }, body: null });

      expect(result.status).toBe(200);
      expect((await readCard(proposalId)).properties.userEditedKeys).toEqual([]);
    });

    it("passes a current ifVersion through", async () => {
      const proposalId = await editedCard();

      const result = await createResetProposalOverridesRouteHandler(pool)({
        params: { id: proposalId },
        body: { ifVersion: (await readCard(proposalId)).updatedAt },
      });

      expect(result.status).toBe(200);
      expect((await readCard(proposalId)).properties.userEditedKeys).toEqual([]);
    });

    it("answers a stale ifVersion with a version conflict that carries the current card, and writes nothing", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const stale = (await readCard(proposalId)).updatedAt;
      await createUpdateProposalValuesRouteHandler(pool)({
        params: { id: proposalId },
        body: { set: { primary: { name: "First" } } },
      });
      const before = await readCard(proposalId);

      const error = await createResetProposalOverridesRouteHandler(pool)({
        params: { id: proposalId },
        body: { ifVersion: stale },
      }).then(
        () => null,
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({ status: 409, code: "version_conflict" });
      expect(error).toHaveProperty("details.current.id", proposalId);
      expect(await readCard(proposalId)).toEqual(before);
    });

    it("answers a card with nothing edited unchanged", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const before = await readCard(proposalId);

      const result = await createResetProposalOverridesRouteHandler(pool)({ params: { id: proposalId }, body: {} });

      expect(result.status).toBe(200);
      expect("item" in result && result.item).toEqual(before);
      expect(await readCard(proposalId)).toEqual(before);
    });

    it("refuses a confirmed card with a ValidationError and writes nothing", async () => {
      const proposalId = await editedCard();
      await withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposalId),
      );
      const before = await readCard(proposalId);

      const error = await createResetProposalOverridesRouteHandler(pool)({
        params: { id: proposalId },
        body: {},
      }).then(
        () => null,
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toHaveProperty("details.field", "status");
      expect(await readCard(proposalId)).toEqual(before);
    });

    it("rejects a request with no `id` path parameter", async () => {
      await expect(createResetProposalOverridesRouteHandler(pool)({ params: {}, body: {} })).rejects.toThrow(
        ValidationError,
      );
    });

    it("rejects an unknown proposal id", async () => {
      await expect(
        createResetProposalOverridesRouteHandler(pool)({ params: { id: randomUUID() }, body: {} }),
      ).rejects.toThrow(NotFoundError);
    });

    it.each([
      ["an array body", []],
      ["a string body", "reset"],
      ["a numeric ifVersion", { ifVersion: 5 }],
      ["a null ifVersion", { ifVersion: null }],
      ["an ifVersion that is no timestamp", { ifVersion: "yesterday" }],
    ])("rejects %s with a ValidationError and writes nothing", async (_label, body) => {
      const proposalId = await editedCard();
      const before = await readCard(proposalId);

      const error = await createResetProposalOverridesRouteHandler(pool)({ params: { id: proposalId }, body }).then(
        () => null,
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(ValidationError);
      expect(await readCard(proposalId)).toEqual(before);
    });
  });

  describe("createRecomputeProposalRouteHandler (issue gh-1955)", () => {
    async function readCard(id: string): Promise<ItemRow> {
      const card = await withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, id));
      if (!card) throw new Error(`card ${id} not found`);
      return card;
    }
    const historyKinds = (card: ItemRow): unknown[] =>
      z
        .array(z.object({ kind: z.string().optional() }))
        .parse(card.properties.history)
        .map((entry) => entry.kind);

    it("sends the card back to the tick, a thin mapping onto recomputeProposalWithClient", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const before = await readCard(proposalId);

      const result = await createRecomputeProposalRouteHandler(pool)({ params: { id: proposalId }, body: {} });

      expect(result.status).toBe(200);
      expect("item" in result && result.item.id).toBe(proposalId);
      expect("item" in result && result.item.properties.status).toBe("computing");
      const stored = await readCard(proposalId);
      expect(stored.properties).toMatchObject({ status: "computing", proposal: before.properties.proposal });
      expect(historyKinds(stored).at(-1)).toBe("recompute");
    });

    it("takes a null body as an empty one", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");

      const result = await createRecomputeProposalRouteHandler(pool)({ params: { id: proposalId }, body: null });

      expect(result.status).toBe(200);
      expect((await readCard(proposalId)).properties.status).toBe("computing");
    });

    it("passes a current ifVersion through", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");

      const result = await createRecomputeProposalRouteHandler(pool)({
        params: { id: proposalId },
        body: { ifVersion: (await readCard(proposalId)).updatedAt },
      });

      expect(result.status).toBe(200);
      expect((await readCard(proposalId)).properties.status).toBe("computing");
    });

    it("answers a stale ifVersion with a version conflict that carries the current card, and writes nothing", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const stale = (await readCard(proposalId)).updatedAt;
      await createUpdateProposalValuesRouteHandler(pool)({
        params: { id: proposalId },
        body: { set: { primary: { name: "First" } } },
      });
      const before = await readCard(proposalId);

      const error = await createRecomputeProposalRouteHandler(pool)({
        params: { id: proposalId },
        body: { ifVersion: stale },
      }).then(
        () => null,
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({ status: 409, code: "version_conflict" });
      expect(error).toHaveProperty("details.current.id", proposalId);
      expect(await readCard(proposalId)).toEqual(before);
    });

    it("answers a card that is computing already unchanged", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      await createRecomputeProposalRouteHandler(pool)({ params: { id: proposalId }, body: {} });
      const before = await readCard(proposalId);

      const result = await createRecomputeProposalRouteHandler(pool)({ params: { id: proposalId }, body: {} });

      expect(result.status).toBe(200);
      expect("item" in result && result.item).toEqual(before);
      expect(await readCard(proposalId)).toEqual(before);
    });

    it("refuses a confirmed card with the 409 proposal_locked and writes nothing", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      await withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposalId),
      );
      const before = await readCard(proposalId);

      const error = await createRecomputeProposalRouteHandler(pool)({ params: { id: proposalId }, body: {} }).then(
        () => null,
        (err: unknown) => err,
      );

      expect(error).toMatchObject({ status: 409, code: "proposal_locked" });
      expect(await readCard(proposalId)).toEqual(before);
    });

    it("addresses the invalidation of the card write to the caller", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const userId = randomUUID();
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await createRecomputeProposalRouteHandler(pool)({
          params: { id: proposalId },
          body: {},
          identity: { user: { id: userId } },
        });
      } finally {
        setInvalidationHook(() => {});
      }

      const cardEvents = events.filter((event) => event.scope === "item" && event.itemId === proposalId);
      expect(cardEvents).toHaveLength(1);
      expect(cardEvents[0]).toMatchObject({ op: "update", userId });
    });

    it("rejects a request with no `id` path parameter", async () => {
      await expect(createRecomputeProposalRouteHandler(pool)({ params: {}, body: {} })).rejects.toThrow(
        ValidationError,
      );
    });

    it("rejects an id that is no UUID with a ValidationError on id", async () => {
      const error = await createRecomputeProposalRouteHandler(pool)({ params: { id: "not-a-uuid" }, body: {} }).then(
        () => null,
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toHaveProperty("details.field", "id");
    });

    it("rejects an unknown proposal id", async () => {
      await expect(
        createRecomputeProposalRouteHandler(pool)({ params: { id: randomUUID() }, body: {} }),
      ).rejects.toThrow(NotFoundError);
    });

    it.each([
      ["an array body", []],
      ["a string body", "recompute"],
      ["a numeric ifVersion", { ifVersion: 5 }],
      ["a null ifVersion", { ifVersion: null }],
      ["an ifVersion that is no timestamp", { ifVersion: "yesterday" }],
      ["an unknown key", { force: true }],
    ])("rejects %s with a ValidationError, writes nothing and queues no job", async (_label, body) => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const before = await readCard(proposalId);
      const jobsBefore = (await pool.query("SELECT key, revision FROM graphile_worker.jobs ORDER BY id")).rows;

      const error = await createRecomputeProposalRouteHandler(pool)({ params: { id: proposalId }, body }).then(
        () => null,
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(ValidationError);
      expect(await readCard(proposalId)).toEqual(before);
      expect((await pool.query("SELECT key, revision FROM graphile_worker.jobs ORDER BY id")).rows).toEqual(jobsBefore);
    });
  });

  describe("createInboxTypesRouteHandler (issue #1439)", () => {
    /** The adapter always supplies the caller; this handler reads only its locale. */
    const callerIn = (locale: string) => ({ identity: { user: { locale } } });

    async function createActiveType(
      name: string,
      processing: Pick<CreateInboxTypeInput, "processingMethod" | "targetDatabase">,
    ): Promise<ItemRow> {
      return withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name,
          emoji: "☑️",
          status: "active",
          ...processing,
        }),
      );
    }

    /**
     * A raw UPDATE: since issue #1436 the choke point refuses an unknown target, so this is the stored
     * state an older write could leave behind.
     */
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
      const type = await createActiveType("Task", { processingMethod: "database", targetDatabase: "tasks" });
      const handler = createInboxTypesRouteHandler(pool);

      expect(await handler(callerIn("cs"))).toEqual({
        status: 200,
        body: {
          types: [
            {
              id: type.id,
              emoji: "☑️",
              label: "Task",
              processingMethod: "database",
              targetDatabaseKey: "tasks",
              targetLabel: "Úkoly",
            },
          ],
        },
      });
      expect(await handler(callerIn("en"))).toEqual({
        status: 200,
        body: {
          types: [
            {
              id: type.id,
              emoji: "☑️",
              label: "Task",
              processingMethod: "database",
              targetDatabaseKey: "tasks",
              targetLabel: "Tasks",
            },
          ],
        },
      });
    });

    it("returns a pageContent type with method pageContent and null target key and label", async () => {
      const type = await createActiveType("Note", { processingMethod: "pageContent" });

      expect(await createInboxTypesRouteHandler(pool)(callerIn("cs"))).toEqual({
        status: 200,
        body: {
          types: [
            {
              id: type.id,
              emoji: "☑️",
              label: "Note",
              processingMethod: "pageContent",
              targetDatabaseKey: null,
              targetLabel: null,
            },
          ],
        },
      });
    });

    it("returns the key itself as the label of a stored target the catalog does not know, without failing the list", async () => {
      const unknown = await createActiveType("Old", { processingMethod: "database", targetDatabase: "tasks" });
      await storeTargetDirectly(unknown.id, "nonsense");
      const known = await createActiveType("Task", { processingMethod: "database", targetDatabase: "tasks" });

      expect(await createInboxTypesRouteHandler(pool)(callerIn("en"))).toEqual({
        status: 200,
        body: {
          types: expect.arrayContaining([
            {
              id: unknown.id,
              emoji: "☑️",
              label: "Old",
              processingMethod: "database",
              targetDatabaseKey: "nonsense",
              targetLabel: "nonsense",
            },
            {
              id: known.id,
              emoji: "☑️",
              label: "Task",
              processingMethod: "database",
              targetDatabaseKey: "tasks",
              targetLabel: "Tasks",
            },
          ]),
        },
      });
    });

    it("labels every type that shares a target with that target's label", async () => {
      const first = await createActiveType("Task", { processingMethod: "database", targetDatabase: "tasks" });
      const second = await createActiveType("Errand", { processingMethod: "database", targetDatabase: "tasks" });

      expect(await createInboxTypesRouteHandler(pool)(callerIn("cs"))).toEqual({
        status: 200,
        body: {
          types: expect.arrayContaining([
            {
              id: first.id,
              emoji: "☑️",
              label: "Task",
              processingMethod: "database",
              targetDatabaseKey: "tasks",
              targetLabel: "Úkoly",
            },
            {
              id: second.id,
              emoji: "☑️",
              label: "Errand",
              processingMethod: "database",
              targetDatabaseKey: "tasks",
              targetLabel: "Úkoly",
            },
          ]),
        },
      });
    });

    it("uses a target database's own name over its catalog label", async () => {
      const tasksId = await databaseIdFor("tasks");
      await withTransaction(pool, (client) => renameDatabase(client, tasksId, "My tasks"));
      const type = await createActiveType("Task", { processingMethod: "database", targetDatabase: "tasks" });

      expect(await createInboxTypesRouteHandler(pool)(callerIn("cs"))).toEqual({
        status: 200,
        body: {
          types: [
            {
              id: type.id,
              emoji: "☑️",
              label: "Task",
              processingMethod: "database",
              targetDatabaseKey: "tasks",
              targetLabel: "My tasks",
            },
          ],
        },
      });
    });

    it("excludes archived types, and the list holds only the active one", async () => {
      const active = await createActiveType("Task", { processingMethod: "database", targetDatabase: "tasks" });
      await withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name: "Old",
          emoji: "🗑️",
          status: "archived",
          processingMethod: "pageContent",
        }),
      );

      expect(await createInboxTypesRouteHandler(pool)(callerIn("en"))).toEqual({
        status: 200,
        body: {
          types: [
            {
              id: active.id,
              emoji: "☑️",
              label: "Task",
              processingMethod: "database",
              targetDatabaseKey: "tasks",
              targetLabel: "Tasks",
            },
          ],
        },
      });
    });
  });

  describe("createInboxCardsRouteHandler editor schemas (issue #1825)", () => {
    async function createCard(
      text: string,
      targetDatabase: "tasks" | "projects",
      properties: Record<string, unknown>,
    ): Promise<{ itemId: string; cardId: string }> {
      const type = await withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name: `Type of ${targetDatabase}`,
          emoji: "📌",
          processingMethod: "database",
          targetDatabase,
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
      await createSemprecTickAction(pool, async () => ({ properties }))(
        { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
        { heartbeatId: "hb", projectItemId: "proj", itemId: item.id },
      );
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

    /** The cards the handler returns for the tenant's only user, read as the adapter would pass the caller. */
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

    it("gives a task card the localized task schema: name required and the time of the date hidden by allDay", async () => {
      const userId = (await createTenantZeroUser(pool)).id;
      const card = await createCard("Buy milk", "tasks", { name: "Buy milk" });

      const listed = (await listedCards(userId, "en")).find((candidate) => candidate.cardId === card.cardId)!;

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
      const userId = (await createTenantZeroUser(pool)).id;
      const card = await createCard("Buy milk", "tasks", { name: "Buy milk" });

      const listed = (await listedCards(userId, locale)).find((candidate) => candidate.cardId === card.cardId)!;

      expect(fieldOf(listed, "name")).toMatchObject({ label: name, placeholder: name });
      expect(fieldOf(listed, "date")).toMatchObject({ label: date });
    });

    it("gives an invalid task card the schema of the task it edits, follow-up fields included", async () => {
      const userId = (await createTenantZeroUser(pool)).id;
      const card = await createCard("Buy milk", "tasks", { name: "Buy milk" });
      await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, card.itemId));
      await createSemprecTickAction(pool, async () => {
        throw new Error("The tick must not compute a card whose source was deleted");
      })(
        { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
        { heartbeatId: "hb", projectItemId: "proj", itemId: card.itemId },
      );

      const listed = (await listedCards(userId, "en")).find((candidate) => candidate.cardId === card.cardId)!;

      // The card really went through the invalid path; a card left proposed would carry the same schema.
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
      const userId = (await createTenantZeroUser(pool)).id;
      const card = await createCard("Kitchen renovation", "projects", { name: "Kitchen renovation" });

      const listed = (await listedCards(userId, "en")).find((candidate) => candidate.cardId === card.cardId)!;

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
      // `area` choice, and the page content of the two page cards (issue #1825).
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
        const properties = await withTransaction(pool, async (client) => {
          const database = await getDatabaseByModuleId(client, moduleId);
          return propertiesStore.listPropertiesByDatabase(client, database!.id);
        });
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
