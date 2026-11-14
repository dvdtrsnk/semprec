import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { createTenantZeroUser, getTenantZeroId, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createPool, withTransaction } from "../../db/pool.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { runInTenant } from "@semprec/shared";
import { getDatabaseByModuleId, renameDatabase } from "../../chokePoint/databasesStore.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { createBlob } from "../../blobs/blobsStore.js";
import { createDocStore } from "../../docs/docStore.js";
import { createInboxItemWithClient } from "../inboxStore.js";
import { insertInboxAttachments, listInboxAttachments } from "../inboxAttachmentsStore.js";
import * as propertiesStore from "../../chokePoint/propertiesStore.js";
import * as itemsStore from "../../chokePoint/itemsStore.js";
import * as relationsStore from "../../chokePoint/relationsStore.js";
import { createRelationWithClient, deleteRelationWithClient } from "../../chokePoint/relationOps.js";
import { getOrCreateJournalItem } from "../../journal/journalStore.js";
import { createInboxTypeWithClient, type CreateInboxTypeInput } from "../inboxTypesStore.js";
import { createSemprecTickAction, type ComputeSemprecProposalFn } from "../inboxTickAction.js";
import {
  createConfirmProposalRouteHandler,
  createInboxCardsRouteHandler,
  createInboxTypesRouteHandler,
  createRejectProposalRouteHandler,
  createReviseProposalRouteHandler,
  createUpdateProposalValuesRouteHandler,
} from "../inboxRouteHandlers.js";
import { matchTranscriptToEvent } from "../../transcription/transcriptEventMatch.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../../transcription/transcriptionJob.js";
import { hashIdempotentRequest } from "../idempotentResponsesStore.js";
import { confirmProposalWithClient, rejectProposalWithClient, reviseProposalWithClient } from "../proposalActions.js";
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
