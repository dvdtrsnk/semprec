import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createUser } from "../auth/usersStore.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { createSemprecTickAction } from "../inbox/inboxTickAction.js";
import { reviseProposalWithClient } from "../inbox/proposalActions.js";
import { ensureFolderItem } from "../mail/folderDiscovery.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import {
  createChokePoint,
  createAgentRun,
  createPendingApprovalRequest,
  insertAgentRunEvent,
  createItemWithClient,
  resolveMailModuleIds,
  createDocStore,
  createRelationWithClient,
  getDatabaseByModuleId,
  listPropertiesByDatabase,
  ingestUploadedBlob,
  LocalFsBlobStorageWriter,
  primaryRootForBlob,
  readSempRefContext,
  seedSystem,
  withTransaction,
  writeComputed,
} from "../index.js";

describe("Semp reference turn reads", () => {
  let admin: Pool;
  let runtime: Pool;
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  it("reads a real page and sibling blocks while refusing foreign, mismatched and random refs without effects", async () => {
    const tenant = await createTestTenant(admin);
    const foreign = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    await runInTenant(foreign, () => seedSystem(runtime));
    const database = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => getDatabaseByModuleId(client, "tasks")),
    );
    const foreignDatabase = await runInTenant(foreign, () =>
      withTransaction(runtime, (client) => getDatabaseByModuleId(client, "tasks")),
    );
    if (!database || !foreignDatabase) throw new Error("Missing tasks database");
    const cp = createChokePoint(runtime);
    const item = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: database.id, properties: { name: "Page" } }),
    );
    const privateItem = await runInTenant(foreign, () =>
      cp.createItem({ databaseId: foreignDatabase.id, properties: { name: "Private" } }),
    );
    const parent = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    await runInTenant(tenant, async () => {
      const docs = createDocStore(runtime);
      await docs.putBlock(item.id, { id: first, flavour: "paragraph", fields: { text: "First" } }, "user");
      await docs.putBlock(item.id, { id: second, flavour: "paragraph", fields: { text: "Second" } }, "user");
      await docs.putBlock(item.id, { id: parent, flavour: "page", children: [first, second] }, "user");
    });
    const read = (ref: Parameters<typeof readSempRefContext>[1]) =>
      runInTenant(tenant, () => withTransaction(runtime, (client) => readSempRefContext(client, ref)));
    const before = await runInTenant(tenant, () =>
      runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM doc_updates"),
    );
    const block = await read({ kind: "block", itemId: item.id, blockId: first });
    expect(block).toMatchObject({
      label: "Page",
      state: "active",
      details: {
        block: {
          block: { "sys:id": first },
          parent: { "sys:id": parent },
          siblings: [{ "sys:id": first }, { "sys:id": second }],
        },
      },
    });
    await expect(read({ kind: "block", itemId: item.id, blockId: randomUUID() })).resolves.toBeNull();
    await expect(read({ kind: "item", itemId: privateItem.id, databaseId: foreignDatabase.id })).resolves.toBeNull();
    await expect(read({ kind: "item", itemId: item.id, databaseId: foreignDatabase.id })).resolves.toBeNull();
    await expect(read({ kind: "item", itemId: randomUUID(), databaseId: database.id })).resolves.toBeNull();
    const after = await runInTenant(tenant, () =>
      runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM doc_updates"),
    );
    expect(after.rows).toEqual(before.rows);
    await runInTenant(tenant, () => cp.softDeleteItem(database.id, item.id));
    await expect(read({ kind: "item", itemId: item.id, databaseId: database.id })).resolves.toMatchObject({
      state: "trashed",
      label: "Page",
    });
  });

  it("returns the tenant-owned blob ID for a Files reference and refuses foreign references", async () => {
    const tenant = await createTestTenant(admin);
    const foreign = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    await runInTenant(foreign, () => seedSystem(runtime));
    const root = await mkdtemp(join(tmpdir(), "semp-ref-blob-"));
    try {
      const storage = new LocalFsBlobStorageWriter(root);
      const upload = await runInTenant(tenant, () =>
        ingestUploadedBlob(runtime, {
          mimeType: "image/png",
          source: Readable.from([Buffer.from("image fixture")]),
          maxBytes: 100,
          storage,
        }),
      );
      const files = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) => getDatabaseByModuleId(client, "files")),
      );
      if (!files) throw new Error("Missing Files database");
      const item = await runInTenant(tenant, () =>
        createChokePoint(runtime).createItem({
          databaseId: files.id,
          properties: { name: "Image", file: { blobId: upload.blob.id } },
        }),
      );
      const ref = { kind: "item" as const, itemId: item.id, databaseId: files.id };
      const resolved = await runInTenant(tenant, () =>
        withTransaction(runtime, async (client) => {
          const value = await readSempRefContext(client, ref);
          return { value, root: value?.blob ? await primaryRootForBlob(client, value.blob.id) : null };
        }),
      );
      expect(resolved.value?.blob).toMatchObject({ id: upload.blob.id, storageKey: upload.blob.storageKey });
      expect(resolved.root).toBe("files");
      await expect(
        runInTenant(foreign, () => withTransaction(runtime, (client) => readSempRefContext(client, ref))),
      ).resolves.toBeNull();
      await expect(
        runInTenant(tenant, () =>
          withTransaction(runtime, (client) => readSempRefContext(client, { ...ref, itemId: randomUUID() })),
        ),
      ).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads an item's properties and actual project relation names without writes", async () => {
    const tenant = await createTestTenant(admin);
    const foreign = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    await runInTenant(foreign, () => seedSystem(runtime));
    const ref = await runInTenant(tenant, async () => {
      const databases = await withTransaction(runtime, async (client) => ({
        tasks: await getDatabaseByModuleId(client, "tasks"),
        projects: await getDatabaseByModuleId(client, "projects"),
        people: await getDatabaseByModuleId(client, "people"),
        companies: await getDatabaseByModuleId(client, "companies"),
      }));
      if (!databases.tasks || !databases.projects || !databases.people || !databases.companies)
        throw new Error("Missing reference fixture database");
      const cp = createChokePoint(runtime);
      const task = await cp.createItem({ databaseId: databases.tasks.id, properties: { name: "Named task" } });
      const project = await cp.createItem({ databaseId: databases.projects.id, properties: { name: "Named project" } });
      const person = await cp.createItem({ databaseId: databases.people.id, properties: { name: "Named person" } });
      const company = await cp.createItem({
        databaseId: databases.companies.id,
        properties: { name: "Named company" },
      });
      await withTransaction(runtime, async (client) => {
        const property = (await listPropertiesByDatabase(client, databases.tasks!.id)).find(
          (entry) => entry.key === "project",
        );
        if (!property) throw new Error("Missing task project relation");
        await createRelationWithClient(client, {
          relationPropertyId: property.id,
          callerItemId: task.id,
          targetItemId: project.id,
        });
        const projectProperties = await listPropertiesByDatabase(client, databases.projects!.id);
        for (const [key, targetItemId] of [
          ["people", person.id],
          ["company", company.id],
        ] as const) {
          const relation = projectProperties.find((entry) => entry.key === key);
          if (!relation) throw new Error(`Missing project ${key} relation`);
          await createRelationWithClient(client, {
            relationPropertyId: relation.id,
            callerItemId: project.id,
            targetItemId,
          });
        }
      });
      const ref = { kind: "item" as const, itemId: task.id, databaseId: databases.tasks.id };
      const snapshot = () =>
        runtime.query<{ items: number; edges: number }>(
          "SELECT (SELECT count(*)::int FROM items) AS items, (SELECT count(*)::int FROM item_relations) AS edges",
        );
      const before = await snapshot();
      const resolved = await withTransaction(runtime, (client) => readSempRefContext(client, ref));
      expect(resolved).toMatchObject({
        label: "Named task",
        details: {
          properties: { name: "Named task" },
          relations: { project: { names: ["Named project"], truncated: false } },
        },
      });
      const projectRead = await withTransaction(runtime, (client) =>
        readSempRefContext(client, {
          kind: "item",
          databaseId: databases.projects!.id,
          itemId: project.id,
        }),
      );
      expect(projectRead).toMatchObject({
        details: {
          relations: {
            people: { names: ["Named person"], truncated: false },
            company: { names: ["Named company"], truncated: false },
          },
        },
      });
      await expect(
        withTransaction(runtime, (client) => readSempRefContext(client, { ...ref, itemId: randomUUID() })),
      ).resolves.toBeNull();
      expect((await snapshot()).rows).toEqual(before.rows);
      return ref;
    });
    await expect(
      runInTenant(foreign, () => withTransaction(runtime, (client) => readSempRefContext(client, ref))),
    ).resolves.toBeNull();
  });

  it("reads present approvals with null or structured descriptions and refuses foreign and random ids", async () => {
    const tenant = await createTestTenant(admin);
    const foreign = await createTestTenant(admin);
    for (const id of [tenant, foreign]) {
      await createUser(admin, { tenantId: id, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
      await runInTenant(id, () => seedSystem(runtime));
    }
    const description = { key: "approval.itemDelete", params: { itemName: "Example" } };
    const create = (owner: string, described: boolean) =>
      runInTenant(owner, () =>
        withTransaction(runtime, async (client) => {
          const run = await createAgentRun(client, { triggeredBy: "user", task: "Approval fixture" });
          return createPendingApprovalRequest(client, {
            agentRunId: run.id,
            toolName: "test",
            riskClass: "unclassified",
            payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
            resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
            ...(described ? { description } : {}),
          });
        }),
      );
    const missingDescription = await create(tenant, false);
    const described = await create(tenant, true);
    const privateRequest = await create(foreign, true);
    await runInTenant(tenant, async () => {
      const snapshot = () =>
        runtime.query<{ approvals: number; runs: number }>(
          "SELECT (SELECT count(*)::int FROM approval_requests) AS approvals, (SELECT count(*)::int FROM agent_runs) AS runs",
        );
      const before = await snapshot();
      const read = (id: string) =>
        withTransaction(runtime, (client) =>
          readSempRefContext(client, { kind: "approvalRequest", approvalRequestId: id }),
        );
      await expect(read(missingDescription.id)).resolves.toMatchObject({
        label: "",
        state: "active",
        details: { description: null, status: "pending" },
      });
      await expect(read(described.id)).resolves.toMatchObject({
        label: description.key,
        state: "active",
        details: { description, status: "pending" },
      });
      await expect(read(privateRequest.id)).resolves.toBeNull();
      await expect(read(randomUUID())).resolves.toBeNull();
      expect((await snapshot()).rows).toEqual(before.rows);
    });
  });

  it("reads a tick-created Inbox capture and its revised card in both directions", async () => {
    const tenant = await createTestTenant(admin);
    const foreign = await createTestTenant(admin);
    await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
    await runInTenant(tenant, () => seedSystem(runtime));
    await runInTenant(foreign, () => seedSystem(runtime));
    const refs = await runInTenant(tenant, async () => {
      const dbs = await withTransaction(runtime, async (client) => ({
        inbox: await getDatabaseByModuleId(client, "inbox"),
        types: await getDatabaseByModuleId(client, "inboxItemTypes"),
        proposals: await getDatabaseByModuleId(client, "processingProposals"),
        projects: await getDatabaseByModuleId(client, "projects"),
      }));
      if (!dbs.inbox?.ownerProjectItemId || !dbs.types || !dbs.proposals || !dbs.projects)
        throw new Error("Missing Inbox fixture databases");
      const source = await withTransaction(runtime, (client) =>
        createInboxItemWithClient(client, {
          inboxDatabaseId: dbs.inbox!.id,
          date: "2026-11-06",
          time: "12:00",
          text: "",
        }),
      );
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
      const cards = await runtime.query<{ id: string }>(
        `SELECT card.id FROM items card JOIN item_relations edge ON edge.item_a = card.id OR edge.item_b = card.id
        WHERE card.database_id = $1 AND card.deleted_at IS NULL AND (edge.item_a = $2 OR edge.item_b = $2)`,
        [dbs.proposals.id, source.id],
      );
      if (cards.rows.length !== 1 || !cards.rows[0]) throw new Error("Missing tick-created card");
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
        reviseProposalWithClient(client, { processingProposalsDatabaseId: dbs.proposals!.id }, cards.rows[0]!.id, {
          message: "Revise fixture",
          ...envelope,
        }),
      );
      const capture = { kind: "item" as const, databaseId: dbs.inbox.id, itemId: source.id };
      const card = { kind: "item" as const, databaseId: dbs.proposals.id, itemId: cards.rows[0].id };
      const before = await runtime.query<{ items: number; edges: number }>(
        "SELECT (SELECT count(*)::int FROM items) AS items, (SELECT count(*)::int FROM item_relations) AS edges",
      );
      const sourceRead = await withTransaction(runtime, (client) => readSempRefContext(client, capture));
      const cardRead = await withTransaction(runtime, (client) => readSempRefContext(client, card));
      expect(sourceRead).toMatchObject({
        details: {
          properties: { text: "" },
          inboxRelated: {
            items: [
              {
                id: card.itemId,
                properties: {
                  proposal: envelope,
                  history: expect.arrayContaining([expect.objectContaining({ message: "Revise fixture" })]),
                },
              },
            ],
          },
        },
      });
      expect(cardRead).toMatchObject({
        details: {
          properties: { proposal: envelope },
          inboxRelated: { items: [{ id: source.id, properties: { text: "" } }] },
        },
      });
      await expect(
        withTransaction(runtime, (client) => readSempRefContext(client, { ...card, itemId: randomUUID() })),
      ).resolves.toBeNull();
      expect(
        (
          await runtime.query<{ items: number; edges: number }>(
            "SELECT (SELECT count(*)::int FROM items) AS items, (SELECT count(*)::int FROM item_relations) AS edges",
          )
        ).rows,
      ).toEqual(before.rows);
      return { capture, card };
    });
    await expect(
      runInTenant(foreign, () => withTransaction(runtime, (client) => readSempRefContext(client, refs.card))),
    ).resolves.toBeNull();
    await expect(
      runInTenant(foreign, () => withTransaction(runtime, (client) => readSempRefContext(client, refs.capture))),
    ).resolves.toBeNull();
  });

  it("reads metadata of a real ingested mail attachment without foreign access or writes", async () => {
    const tenant = await createTestTenant(admin);
    const foreign = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    await runInTenant(foreign, () => seedSystem(runtime));
    const directory = await mkdtemp(join(tmpdir(), "semp-ref-mail-"));
    let failure: unknown;
    let failed = false;
    try {
      const fixture = await runInTenant(tenant, () =>
        withTransaction(runtime, async (client) => {
          const ids = await resolveMailModuleIds(client);
          const properties = await listPropertiesByDatabase(client, ids.emailsDatabaseId);
          const folders = await listPropertiesByDatabase(client, ids.foldersDatabaseId);
          const attachment = properties.find((entry) => entry.key === "attachments");
          const folder = properties.find((entry) => entry.key === "folder");
          const mailbox = folders.find((entry) => entry.key === "mailbox");
          if (!attachment || !folder || !mailbox) throw new Error("Missing mail relations");
          const mailboxItem = await createItemWithClient(client, {
            databaseId: ids.mailboxesDatabaseId,
            properties: { name: "Mail" },
          });
          const folderId = await ensureFolderItem(client, {
            foldersDatabaseId: ids.foldersDatabaseId,
            mailboxItemId: mailboxItem.id,
            mailboxRelationPropertyId: mailbox.id,
            providerId: "INBOX",
            name: "Inbox",
            behavior: "folder",
            specialPurpose: "inbox",
          });
          const firstMessageId = `<${randomUUID()}@example.test>`;
          const email = await ingestEmailMessage(client, {
            emailsDatabaseId: ids.emailsDatabaseId,
            filesDatabaseId: ids.filesDatabaseId,
            folderRelationPropertyId: folder.id,
            attachmentsRelationPropertyId: attachment.id,
            folderItemId: folderId,
            mailboxItemId: mailboxItem.id,
            messageId: firstMessageId,
            date: new Date("2026-11-01T10:00:00Z"),
            subject: "Mail",
            envelope: {},
            attachments: [
              {
                filename: "note.txt",
                contentType: "text/plain",
                contentId: null,
                disposition: "attachment",
                openStream: () => Readable.from(["note"]),
              },
            ],
            storage: new LocalFsBlobStorageWriter(directory),
            storageKeyPrefix: "ref-reader-test",
          });
          const newer = await ingestEmailMessage(client, {
            emailsDatabaseId: ids.emailsDatabaseId,
            filesDatabaseId: ids.filesDatabaseId,
            folderRelationPropertyId: folder.id,
            attachmentsRelationPropertyId: attachment.id,
            folderItemId: folderId,
            mailboxItemId: mailboxItem.id,
            messageId: `<${randomUUID()}@example.test>`,
            references: [firstMessageId],
            date: new Date("2026-11-02T10:00:00Z"),
            subject: "Reply",
            envelope: {},
            attachments: [],
            storage: new LocalFsBlobStorageWriter(directory),
            storageKeyPrefix: "ref-reader-test",
          });
          const rows = await client.query<{ id: string }>(
            "SELECT id FROM mail_attachments WHERE message_item_id = $1",
            [email.itemId],
          );
          if (!rows.rows[0]) throw new Error("Missing mail attachment");
          return {
            attachmentId: rows.rows[0].id,
            older: email.itemId,
            newer: newer.itemId,
            databaseId: ids.emailsDatabaseId,
          };
        }),
      );
      const ref = { kind: "mailAttachment" as const, attachmentId: fixture.attachmentId };
      const emailRef = { kind: "item" as const, itemId: fixture.older, databaseId: fixture.databaseId };
      await runInTenant(tenant, async () => {
        const before = await runtime.query<{ attachments: number; blobs: number; items: number; edges: number }>(
          "SELECT (SELECT count(*)::int FROM mail_attachments) AS attachments, (SELECT count(*)::int FROM blobs) AS blobs, (SELECT count(*)::int FROM items) AS items, (SELECT count(*)::int FROM item_relations) AS edges",
        );
        const resolved = await withTransaction(runtime, (client) => readSempRefContext(client, ref));
        expect(resolved).toMatchObject({
          label: "note.txt",
          state: "active",
          details: { filename: "note.txt", contentType: "text/plain", byteSize: "4" },
          blob: { byteSize: "4", mimeType: "text/plain" },
        });
        const email = await withTransaction(runtime, (client) => readSempRefContext(client, emailRef));
        expect(email).toMatchObject({
          details: { thread: { messages: [{ id: fixture.newer }, { id: fixture.older }], truncated: false } },
        });
        await expect(
          withTransaction(runtime, (client) => readSempRefContext(client, { ...ref, attachmentId: randomUUID() })),
        ).resolves.toBeNull();
        expect(
          (
            await runtime.query<{ attachments: number; blobs: number; items: number; edges: number }>(
              "SELECT (SELECT count(*)::int FROM mail_attachments) AS attachments, (SELECT count(*)::int FROM blobs) AS blobs, (SELECT count(*)::int FROM items) AS items, (SELECT count(*)::int FROM item_relations) AS edges",
            )
          ).rows,
        ).toEqual(before.rows);
      });
      await expect(
        runInTenant(foreign, () => withTransaction(runtime, (client) => readSempRefContext(client, ref))),
      ).resolves.toBeNull();
      await expect(
        runInTenant(foreign, () => withTransaction(runtime, (client) => readSempRefContext(client, emailRef))),
      ).resolves.toBeNull();
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (cleanupError) {
      if (failed)
        throw new AggregateError([failure, cleanupError], "Mail reference test and cleanup failed", {
          // Preserve the original test failure; the cleanup failure remains in errors.
          // eslint-disable-next-line preserve-caught-error
          cause: failure,
        });
      throw cleanupError;
    }
    if (failed) throw failure instanceof Error ? failure : new Error("Mail reference test failed", { cause: failure });
  });

  it("bounds a real 101-message mail thread to its newest 100 entries", async () => {
    const tenant = await createTestTenant(admin);
    const foreign = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    await runInTenant(foreign, () => seedSystem(runtime));
    const directory = await mkdtemp(join(tmpdir(), "semp-ref-thread-limit-"));
    let failure: unknown;
    let failed = false;
    try {
      const fixture = await runInTenant(tenant, () =>
        withTransaction(runtime, async (client) => {
          const ids = await resolveMailModuleIds(client);
          const properties = await listPropertiesByDatabase(client, ids.emailsDatabaseId);
          const folders = await listPropertiesByDatabase(client, ids.foldersDatabaseId);
          const attachment = properties.find((entry) => entry.key === "attachments");
          const folder = properties.find((entry) => entry.key === "folder");
          const mailboxProperty = folders.find((entry) => entry.key === "mailbox");
          if (!attachment || !folder || !mailboxProperty) throw new Error("Missing mail relations");
          const mailbox = await createItemWithClient(client, {
            databaseId: ids.mailboxesDatabaseId,
            properties: { name: "Mail" },
          });
          const folderId = await ensureFolderItem(client, {
            foldersDatabaseId: ids.foldersDatabaseId,
            mailboxItemId: mailbox.id,
            mailboxRelationPropertyId: mailboxProperty.id,
            providerId: "INBOX",
            name: "Inbox",
            behavior: "folder",
            specialPurpose: "inbox",
          });
          const firstMessageId = `<${randomUUID()}@example.test>`;
          const storage = new LocalFsBlobStorageWriter(directory);
          const itemIds: string[] = [];
          for (let index = 0; index < 101; index += 1) {
            const email = await ingestEmailMessage(client, {
              emailsDatabaseId: ids.emailsDatabaseId,
              filesDatabaseId: ids.filesDatabaseId,
              folderRelationPropertyId: folder.id,
              attachmentsRelationPropertyId: attachment.id,
              folderItemId: folderId,
              mailboxItemId: mailbox.id,
              messageId: index === 0 ? firstMessageId : `<${randomUUID()}@example.test>`,
              references: index === 0 ? [] : [firstMessageId],
              date: new Date(Date.UTC(2026, 10, 1, 0, index)),
              subject: `Thread ${index}`,
              envelope: {},
              attachments: [],
              storage,
              storageKeyPrefix: "ref-thread-limit",
            });
            itemIds.push(email.itemId);
          }
          return { databaseId: ids.emailsDatabaseId, itemIds };
        }),
      );
      const first = fixture.itemIds[0];
      if (!first) throw new Error("Missing first mail item");
      const ref = { kind: "item" as const, itemId: first, databaseId: fixture.databaseId };
      const detailsSchema = z.object({
        thread: z.object({ messages: z.array(z.object({ id: z.string() })), truncated: z.boolean() }),
      });
      const snapshot = () =>
        runInTenant(tenant, () =>
          runtime.query<{ items: number; edges: number; messages: number; search: number }>(
            "SELECT (SELECT count(*)::int FROM items) AS items, (SELECT count(*)::int FROM item_relations) AS edges, (SELECT count(*)::int FROM mail_message_meta) AS messages, (SELECT count(*)::int FROM item_search_index) AS search",
          ),
        );
      const before = await snapshot();
      await runInTenant(tenant, async () => {
        const resolved = await withTransaction(runtime, (client) => readSempRefContext(client, ref));
        if (!resolved) throw new Error("Missing own mail thread");
        const thread = detailsSchema.parse(resolved.details).thread;
        expect(thread.truncated).toBe(true);
        expect(thread.messages.map((message) => message.id)).toEqual([...fixture.itemIds].reverse().slice(0, 100));
        expect(thread.messages).toHaveLength(100);
        await expect(
          withTransaction(runtime, (client) => readSempRefContext(client, { ...ref, itemId: randomUUID() })),
        ).resolves.toBeNull();
      });
      await expect(
        runInTenant(foreign, () => withTransaction(runtime, (client) => readSempRefContext(client, ref))),
      ).resolves.toBeNull();
      expect((await snapshot()).rows).toEqual(before.rows);
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (cleanupError) {
      if (failed)
        throw new AggregateError([failure, cleanupError], "Mail thread test and cleanup failed", {
          // The operation failure remains primary; retain cleanup failure in errors.
          // eslint-disable-next-line preserve-caught-error
          cause: failure,
        });
      throw cleanupError;
    }
    if (failed) throw failure instanceof Error ? failure : new Error("Mail thread test failed", { cause: failure });
  });

  it("reads a run's actual task, status and ordered tool steps under tenant scope", async () => {
    const tenant = await createTestTenant(admin);
    const foreign = await createTestTenant(admin);
    await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
    const run = await runInTenant(tenant, () =>
      withTransaction(runtime, async (client) => {
        const created = await createAgentRun(client, { triggeredBy: "user", task: "Run reference sentinel" });
        await insertAgentRunEvent(client, created.id, "tool_use", { name: "fixtureTool" });
        await insertAgentRunEvent(client, created.id, "tool_result", { result: "fixtureResult" });
        return created;
      }),
    );
    const ref = { kind: "agentRun" as const, agentRunId: run.id };
    await runInTenant(tenant, async () => {
      const before = await runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM agent_run_events");
      const resolved = await withTransaction(runtime, (client) => readSempRefContext(client, ref));
      expect(resolved).toMatchObject({
        label: "Run reference sentinel",
        state: "active",
        details: {
          task: "Run reference sentinel",
          status: "running",
          truncated: false,
          steps: [
            { kind: "tool_use", payload: '{"name": "fixtureTool"}', truncated: false },
            { kind: "tool_result", payload: '{"result": "fixtureResult"}', truncated: false },
          ],
        },
      });
      await expect(
        withTransaction(runtime, (client) => readSempRefContext(client, { ...ref, agentRunId: randomUUID() })),
      ).resolves.toBeNull();
      expect(
        (await runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM agent_run_events")).rows,
      ).toEqual(before.rows);
    });
    await expect(
      runInTenant(foreign, () => withTransaction(runtime, (client) => readSempRefContext(client, ref))),
    ).resolves.toBeNull();
  });

  it("reads a transcript segment with three neighbors and the current speaker name", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    const transcriptDatabase = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => getDatabaseByModuleId(client, "transcripts")),
    );
    const peopleDatabase = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => getDatabaseByModuleId(client, "people")),
    );
    if (!transcriptDatabase || !peopleDatabase) throw new Error("Missing transcript or people database");
    const cp = createChokePoint(runtime);
    const transcript = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: transcriptDatabase.id, properties: { name: "Recording" } }),
    );
    const person = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: peopleDatabase.id, properties: { name: "Speaker" } }),
    );
    const segments = Array.from({ length: 9 }, (_, index) => ({
      speaker: "SPEAKER_00",
      text: `Segment ${index}`,
      startsAt: index,
      endsAt: index + 1,
    }));
    await runInTenant(tenant, () =>
      withTransaction(runtime, async (client) => {
        await writeComputed(client, transcriptDatabase.id, transcript.id, "segments", segments);
        const property = (await listPropertiesByDatabase(client, transcriptDatabase.id)).find(
          (entry) => entry.key === "speakers",
        );
        if (!property) throw new Error("Missing speakers relation");
        await createRelationWithClient(client, {
          relationPropertyId: property.id,
          callerItemId: transcript.id,
          targetItemId: person.id,
          metadata: { speaker: "SPEAKER_00" },
        });
      }),
    );
    const ref = { kind: "transcriptSegment" as const, itemId: transcript.id, startsAt: 4, endsAt: 5 };
    const resolved = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => readSempRefContext(client, ref)),
    );
    expect(resolved).toMatchObject({
      label: "Recording",
      state: "active",
      details: {
        segments: segments.slice(1, 8),
        speakers: [{ speaker: "SPEAKER_00", person: { id: person.id, name: "Speaker" } }],
      },
    });
    await expect(
      runInTenant(tenant, () =>
        withTransaction(runtime, (client) => readSempRefContext(client, { ...ref, startsAt: 40, endsAt: 41 })),
      ),
    ).resolves.toBeNull();
  });
});
