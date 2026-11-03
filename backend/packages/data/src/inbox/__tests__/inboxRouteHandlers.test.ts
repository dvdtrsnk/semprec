import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { getTenantZeroId, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createPool, withTransaction } from "../../db/pool.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { runInTenant } from "@semprec/shared";
import { getDatabaseByModuleId, renameDatabase } from "../../chokePoint/databasesStore.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { createBlob } from "../../blobs/blobsStore.js";
import { createInboxItemWithClient } from "../inboxStore.js";
import { getOrCreateJournalItem } from "../../journal/journalStore.js";
import { createInboxTypeWithClient, type CreateInboxTypeInput } from "../inboxTypesStore.js";
import { createSemprecTickAction, type ComputeSemprecProposalFn } from "../inboxTickAction.js";
import { createConfirmProposalRouteHandler, createInboxTypesRouteHandler } from "../inboxRouteHandlers.js";
import { matchTranscriptToEvent } from "../../transcription/transcriptEventMatch.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../../transcription/transcriptionJob.js";
import { reviseProposalWithClient } from "../proposalActions.js";
import { NotFoundError, ValidationError } from "../../errors.js";
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

  describe("createConfirmProposalRouteHandler", () => {
    it("attributes a confirmed page block to the user through the runtime role", async () => {
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
            { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
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
          const response = await createConfirmProposalRouteHandler(dataPool)({ params: { id: proposal }, body: {} });
          expect(response.status).toBe(200);
          if (!("item" in response)) throw new Error("Expected item response");
          expect(response.results).toEqual([
            expect.objectContaining({
              ref: "primary",
              itemId: page.id,
              databaseKey: null,
              role: "primary",
              blockIds: [proposal],
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
          expect(updates).toEqual([{ created_by: "user" }]);
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
    });
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
        const operations = [
          {
            ref: "file",
            op: "create",
            databaseKey: "files",
            role: "primary",
            properties: { name: "Document" },
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
              proposal: { entityKind: "database", target: files.id, properties: { name: "Document" }, operations },
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

    it("records a secondary updated item under its own step reference", async () => {
      const proposalId = await createDatabaseProposal("Seed");
      const taskId = await withTransaction(pool, async (client) => {
        const files = await getDatabaseByModuleId(client, "files");
        const tasks = await getDatabaseByModuleId(client, "tasks");
        if (!files || !tasks) throw new Error("Files or Tasks missing");
        const task = await createItemWithClient(client, { databaseId: tasks.id, properties: { name: "Before" } });
        await updateItemWithClient(
          client,
          {
            databaseId: proposalsId,
            itemId: proposalId,
            propertiesPatch: {
              proposal: {
                entityKind: "database",
                target: files.id,
                properties: { name: "Document" },
                operations: [
                  {
                    ref: "file",
                    op: "create",
                    databaseKey: "files",
                    role: "primary",
                    properties: { name: "Document" },
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
                properties: { name: "Document" },
                operations: [
                  {
                    ref: "file",
                    op: "create",
                    databaseKey: "files",
                    role: "primary",
                    properties: { name: "Document" },
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
});
