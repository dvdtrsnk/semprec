import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { createSemprecTickAction } from "../inbox/inboxTickAction.js";
import { createInboxProposalGetTool, inboxProposalGetArgsSchema } from "../inbox/inboxAgentTools.js";
import { reviseProposalWithClient } from "../inbox/proposalActions.js";
import { insertInboxAttachments } from "../inbox/inboxAttachmentsStore.js";
import { ingestUploadedBlob } from "../blobs/fileUploadStore.js";
import { LocalFsBlobStorageWriter } from "../mail/blobStorage.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { appendHistoryEntry } from "../inbox/proposalHistory.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { sendSempMessage } from "../sempThreads/sempThreadsStore.js";
import { createUser } from "../auth/usersStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";

describe("Inbox proposal tool owner", () => {
  let admin: Pool;
  let runtime: Pool;
  let root: string;
  let owner: string;
  let foreign: string;
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    owner = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    for (const tenant of [owner, foreign]) {
      await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
      await runInTenant(tenant, () => seedSystem(runtime));
    }
    root = await mkdtemp(join(tmpdir(), "semp-inbox-tool-"));
  });
  afterAll(async () => {
    const errors: unknown[] = [];
    try {
      await runtime?.end();
    } catch (error) {
      errors.push(error);
    }
    try {
      await admin?.end();
    } catch (error) {
      errors.push(error);
    }
    try {
      if (root) await rm(root, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "Inbox tool fixture cleanup failed", { cause: errors[0] });
  });

  async function createCard(tenant: string, attach: boolean) {
    return runInTenant(tenant, async () => {
      const dbs = await withTransaction(runtime, async (client) => ({
        inbox: await getDatabaseByModuleId(client, "inbox"),
        types: await getDatabaseByModuleId(client, "inboxItemTypes"),
        proposals: await getDatabaseByModuleId(client, "processingProposals"),
        projects: await getDatabaseByModuleId(client, "projects"),
      }));
      if (!dbs.inbox?.ownerProjectItemId || !dbs.types || !dbs.proposals || !dbs.projects)
        throw new Error("Missing Inbox setup");
      const source = await withTransaction(runtime, (client) =>
        createInboxItemWithClient(client, {
          inboxDatabaseId: dbs.inbox!.id,
          date: "2026-11-06",
          time: "12:00",
          text: "",
        }),
      );
      let attachmentIds: string[] = [];
      if (attach) {
        const storage = new LocalFsBlobStorageWriter(root);
        const blobs: Array<{ blobId: string; source: "files" }> = [];
        for (const bytes of ["first attachment", "second attachment"]) {
          const uploaded = await ingestUploadedBlob(runtime, {
            mimeType: "application/octet-stream",
            source: Readable.from([bytes]),
            maxBytes: 128,
            storage,
          });
          blobs.push({ blobId: uploaded.blob.id, source: "files" as const });
        }
        await withTransaction(runtime, (client) => insertInboxAttachments(client, source.id, blobs));
        const rows = await runtime.query<{ attachment_id: string }>(
          "SELECT attachment_id FROM inbox_attachments WHERE inbox_item_id = $1 ORDER BY position",
          [source.id],
        );
        attachmentIds = rows.rows.map((row) => row.attachment_id);
      }
      const tick = createSemprecTickAction(runtime, async () => {
        throw new Error("Unexpected model computation");
      });
      await tick(
        {
          inboxDatabaseId: dbs.inbox.id,
          inboxItemTypesDatabaseId: dbs.types.id,
          processingProposalsDatabaseId: dbs.proposals.id,
        },
        { heartbeatId: randomUUID(), projectItemId: dbs.inbox.ownerProjectItemId, itemId: source.id },
      );
      const card = await runtime.query<{ id: string }>(
        `SELECT card.id FROM items card JOIN item_relations edge ON edge.item_a = card.id OR edge.item_b = card.id
          WHERE card.database_id = $1 AND card.deleted_at IS NULL AND (edge.item_a = $2 OR edge.item_b = $2)`,
        [dbs.proposals.id, source.id],
      );
      if (card.rows.length !== 1 || !card.rows[0]) throw new Error("Missing tick-produced card");
      const project = await createChokePoint(runtime).createItem({
        databaseId: dbs.projects.id,
        properties: { name: "Project" },
      });
      const envelope = {
        entityKind: "pageContent" as const,
        target: project.id,
        properties: { flavour: "paragraph", fields: { content: "Note" } },
      };
      await withTransaction(runtime, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: dbs.proposals!.id }, card.rows[0]!.id, {
          message: "Revise",
          ...envelope,
        }),
      );
      const turn = await withTransaction(runtime, (client) =>
        sendSempMessage(client, {
          subject: { inboxItemId: source.id, proposalId: card.rows[0]!.id },
          text: "Question",
          context: [],
          hasContext: false,
        }),
      );
      const run = await createAgentRun(runtime, {
        projectItemId: dbs.inbox.ownerProjectItemId,
        threadId: turn.threadId,
        triggeredBy: "user",
        unit: "session",
        task: "Question",
      });
      return {
        cardId: card.rows[0].id,
        sourceId: source.id,
        runId: run.id,
        threadId: turn.threadId,
        proposalsId: dbs.proposals.id,
        envelope,
        attachmentIds,
      };
    });
  }

  it("refuses a synthetic historical stale hint after the actual association is removed", async () => {
    const fixture = await createCard(owner, false);
    const tool = createInboxProposalGetTool(runtime);
    await runInTenant(owner, async () => {
      expect((await tool(fixture.runId, { proposalId: fixture.cardId })).error).toBe(false);
      const property = await runtime.query<{ id: string }>(
        "SELECT id FROM properties WHERE database_id = $1 AND key = 'sourceInbox'",
        [fixture.proposalsId],
      );
      if (!property.rows[0]) throw new Error("Missing sourceInbox property");
      const edge = {
        relationPropertyId: property.rows[0].id,
        callerItemId: fixture.cardId,
        targetItemId: fixture.sourceId,
      };
      const before = await runtime.query<{ id: string }>(
        "SELECT edge.id FROM item_relations edge JOIN relation_definitions def ON def.id = edge.relation_definition_id WHERE (def.property_id_a = $1 OR def.property_id_b = $1) AND (($2 = edge.item_a AND $3 = edge.item_b) OR ($2 = edge.item_b AND $3 = edge.item_a))",
        [edge.relationPropertyId, fixture.cardId, fixture.sourceId],
      );
      expect(before.rows).toHaveLength(1);
      // Synthetic historical state: the actual tick-created association is removed through its owner.
      const deleted = await withTransaction(runtime, (client) =>
        deleteRelationWithClient(client, edge, { ownerProcess: "processingProposals" }),
      );
      expect(deleted?.id).toBe(before.rows[0]?.id);
      const state = await runtime.query<{
        edge_count: number;
        live_source: boolean;
        live_card: boolean;
        hint: string | null;
        status: string;
      }>(
        `SELECT (SELECT count(*)::int FROM item_relations WHERE id = $1) AS edge_count,
          EXISTS (SELECT 1 FROM items WHERE id = $2 AND deleted_at IS NULL) AS live_source,
          EXISTS (SELECT 1 FROM items WHERE id = $3 AND deleted_at IS NULL) AS live_card,
          (SELECT subject_proposal_id FROM semp_threads WHERE id = $4) AS hint,
          (SELECT properties->>'status' FROM items WHERE id = $3) AS status`,
        [deleted?.id, fixture.sourceId, fixture.cardId, fixture.threadId],
      );
      expect(state.rows).toEqual([
        { edge_count: 0, live_source: true, live_card: true, hint: fixture.cardId, status: "proposed" },
      ]);
      const baseline = await runtime.query<{ items: number; edges: number; events: number; attachments: number }>(
        "SELECT (SELECT count(*)::int FROM items) AS items, (SELECT count(*)::int FROM item_relations) AS edges, (SELECT count(*)::int FROM agent_run_events) AS events, (SELECT count(*)::int FROM inbox_attachments) AS attachments",
      );
      const missing = await tool(fixture.runId, { proposalId: randomUUID() });
      expect(await tool(fixture.runId, { proposalId: fixture.cardId })).toEqual(missing);
      expect(missing).toEqual({ error: true, result: "Proposal not found" });
      expect(
        (
          await runtime.query<{ items: number; edges: number; events: number; attachments: number }>(
            "SELECT (SELECT count(*)::int FROM items) AS items, (SELECT count(*)::int FROM item_relations) AS edges, (SELECT count(*)::int FROM agent_run_events) AS events, (SELECT count(*)::int FROM inbox_attachments) AS attachments",
          )
        ).rows,
      ).toEqual(baseline.rows);
    });
  });

  it("preserves synthetic historical keys and an existing relation descriptor without effects", async () => {
    const own = await createCard(owner, false);
    const other = await createCard(owner, false);
    const foreignCard = await createCard(foreign, false);
    const tool = createInboxProposalGetTool(runtime);
    await runInTenant(owner, async () => {
      const association = await runtime.query<{ edge_id: string; property_id: string }>(
        `SELECT edge.id AS edge_id, property.id AS property_id FROM properties property
         JOIN relation_definitions def ON def.property_id_a = property.id OR def.property_id_b = property.id
         JOIN item_relations edge ON edge.relation_definition_id = def.id
         WHERE property.database_id = $1 AND property.key = 'sourceInbox'
           AND (($2 = edge.item_a AND $3 = edge.item_b) OR ($2 = edge.item_b AND $3 = edge.item_a))`,
        [own.proposalsId, own.cardId, own.sourceId],
      );
      expect(association.rows).toHaveLength(1);
      const actual = association.rows[0];
      if (!actual) throw new Error("Missing sourceInbox association");
      const original = await runtime.query<{ properties: { history?: unknown } }>(
        "SELECT properties FROM items WHERE id = $1",
        [own.cardId],
      );
      const descriptor = {
        edgeId: actual.edge_id,
        relationPropertyId: actual.property_id,
        callerItemId: own.cardId,
        targetItemId: own.sourceId,
      };
      const history = appendHistoryEntry(original.rows[0]?.properties.history, "Synthetic historical entry", "user", {
        addedRelations: [descriptor],
      });
      expect(history.slice(0, -1)).toEqual(original.rows[0]?.properties.history);
      await withTransaction(runtime, (client) =>
        updateItemWithClient(
          client,
          {
            databaseId: own.proposalsId,
            itemId: own.cardId,
            propertiesPatch: { userEditedKeys: ["name"], history },
          },
          { allowedSystemKeys: ["userEditedKeys", "history"] },
        ),
      );
      const snapshot = () =>
        runtime.query<{
          card: unknown;
          association: unknown;
          thread: unknown;
          edges: number;
          items: number;
          events: number;
          attachments: number;
        }>(
          `SELECT (SELECT row_to_json(card) FROM (SELECT properties, updated_at FROM items WHERE id = $1) card) AS card,
         (SELECT row_to_json(edge) FROM (SELECT * FROM item_relations WHERE id = $2) edge) AS association,
         (SELECT row_to_json(thread) FROM (SELECT * FROM semp_threads WHERE id = $3) thread) AS thread,
         (SELECT count(*)::int FROM item_relations) AS edges, (SELECT count(*)::int FROM items) AS items,
         (SELECT count(*)::int FROM agent_run_events) AS events, (SELECT count(*)::int FROM inbox_attachments) AS attachments`,
          [own.cardId, actual.edge_id, own.threadId],
        );
      const baseline = await snapshot();
      const result = await tool(own.runId, { proposalId: own.cardId });
      expect(result.error).toBe(false);
      expect(z.record(z.string(), z.unknown()).parse(JSON.parse(result.result) as unknown)).toMatchObject({
        userEditedKeys: ["name"],
        history,
      });
      const missing = await tool(own.runId, { proposalId: randomUUID() });
      expect(await tool(own.runId, { proposalId: other.cardId })).toEqual(missing);
      expect(await tool(own.runId, { proposalId: foreignCard.cardId })).toEqual(missing);
      expect(missing).toEqual({ error: true, result: "Proposal not found" });
      expect((await snapshot()).rows).toEqual(baseline.rows);
    });
  });

  it("reads valid and malformed synthetic historical proposal history without effects", async () => {
    const own = await createCard(owner, false);
    const tool = createInboxProposalGetTool(runtime);
    const legacy = { author: "user", message: "Legacy", at: "2026-01-01T00:00:00.000Z" };
    const optional = { ...legacy, kind: "userEdit", keys: ["name"], threadId: own.threadId };
    const cases: Array<{ history: unknown; expected: unknown[] }> = [
      { history: [legacy], expected: [legacy] },
      { history: [optional], expected: [optional] },
      { history: null, expected: [] },
      { history: [{ author: "invalid", message: "Malformed", at: "x" }], expected: [] },
    ];
    await runInTenant(owner, async () => {
      for (const fixture of cases) {
        // Historical-state fixture: only the history field is changed through its actual owner.
        await withTransaction(runtime, (client) =>
          updateItemWithClient(
            client,
            { databaseId: own.proposalsId, itemId: own.cardId, propertiesPatch: { history: fixture.history } },
            { allowedSystemKeys: ["history"] },
          ),
        );
        const snapshot = () =>
          runtime.query<{ card: unknown; edges: number; events: number }>(
            `SELECT (SELECT row_to_json(i) FROM (SELECT properties, updated_at FROM items WHERE id = $1) i) AS card,
             (SELECT count(*)::int FROM item_relations) AS edges,
             (SELECT count(*)::int FROM agent_run_events) AS events`,
            [own.cardId],
          );
        const before = await snapshot();
        const result = await tool(own.runId, { proposalId: own.cardId });
        expect(result.error).toBe(false);
        const parsed = z
          .object({ history: z.array(z.unknown()) })
          .passthrough()
          .parse(JSON.parse(result.result) as unknown);
        expect(parsed.history).toEqual(fixture.expected);
        expect((await snapshot()).rows).toEqual(before.rows);
      }
    });
  });

  it("reads the real revised envelope and ordered unnamed attachments and uniformly refuses unrelated cards", async () => {
    const own = await createCard(owner, true);
    const other = await createCard(owner, false);
    const foreignCard = await createCard(foreign, false);
    const tool = createInboxProposalGetTool(runtime);
    expect(inboxProposalGetArgsSchema.safeParse({ proposalId: own.cardId, extra: true }).success).toBe(false);
    await runInTenant(owner, async () => {
      const before = await runtime.query<{ items: number; edges: number; attachments: number; events: number }>(
        "SELECT (SELECT count(*)::int FROM items) AS items, (SELECT count(*)::int FROM item_relations) AS edges, (SELECT count(*)::int FROM inbox_attachments) AS attachments, (SELECT count(*)::int FROM agent_run_events) AS events",
      );
      const result = await tool(own.runId, { proposalId: own.cardId });
      expect(result.error).toBe(false);
      expect(z.record(z.string(), z.unknown()).parse(JSON.parse(result.result) as unknown)).toMatchObject({
        captureText: "",
        envelope: own.envelope,
        userEditedKeys: [],
        version: (
          await runtime.query<{ updated_at: Date }>("SELECT updated_at FROM items WHERE id = $1", [own.cardId])
        ).rows[0]?.updated_at.toISOString(),
        status: "proposed",
        history: expect.arrayContaining([expect.objectContaining({ author: "user", message: "Revise" })]),
        attachments: own.attachmentIds.map((attachmentId) => ({ attachmentId, name: null })),
      });
      const missing = await tool(own.runId, { proposalId: randomUUID() });
      expect(await tool(own.runId, { proposalId: other.cardId })).toEqual(missing);
      expect(await tool(own.runId, { proposalId: foreignCard.cardId })).toEqual(missing);
      expect(missing).toEqual({ error: true, result: "Proposal not found" });
      expect(
        (
          await runtime.query<{ items: number; edges: number; attachments: number; events: number }>(
            "SELECT (SELECT count(*)::int FROM items) AS items, (SELECT count(*)::int FROM item_relations) AS edges, (SELECT count(*)::int FROM inbox_attachments) AS attachments, (SELECT count(*)::int FROM agent_run_events) AS events",
          )
        ).rows,
      ).toEqual(before.rows);
    });
    await expect(tool(own.runId, { proposalId: own.cardId })).resolves.toEqual({
      error: true,
      result: "Proposal not found",
    });
  });
});
