import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
        const blobs = [];
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
      return { cardId: card.rows[0].id, sourceId: source.id, runId: run.id, envelope, attachmentIds };
    });
  }

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
      expect(JSON.parse(result.result)).toMatchObject({
        captureText: "",
        envelope: own.envelope,
        status: "proposed",
        attachments: own.attachmentIds.map((attachmentId) => ({ attachmentId, name: null })),
      });
      const missing = await tool(own.runId, { proposalId: randomUUID() });
      expect(await tool(own.runId, { proposalId: other.cardId })).toEqual(missing);
      expect(await tool(own.runId, { proposalId: foreignCard.cardId })).toEqual(missing);
      expect(missing).toEqual({ error: true, result: "Proposal not found" });
      expect(
        (
          await runtime.query(
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
