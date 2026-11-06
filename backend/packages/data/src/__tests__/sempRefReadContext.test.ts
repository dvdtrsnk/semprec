import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createUser } from "../auth/usersStore.js";
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
      }));
      if (!databases.tasks || !databases.projects) throw new Error("Missing task or project database");
      const cp = createChokePoint(runtime);
      const task = await cp.createItem({ databaseId: databases.tasks.id, properties: { name: "Named task" } });
      const project = await cp.createItem({ databaseId: databases.projects.id, properties: { name: "Named project" } });
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
      });
      const ref = { kind: "item" as const, itemId: task.id, databaseId: databases.tasks.id };
      const snapshot = () =>
        runtime.query(
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
        runtime.query(
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
        details: { description: null },
      });
      await expect(read(described.id)).resolves.toMatchObject({
        label: description.key,
        state: "active",
        details: { description },
      });
      await expect(read(privateRequest.id)).resolves.toBeNull();
      await expect(read(randomUUID())).resolves.toBeNull();
      expect((await snapshot()).rows).toEqual(before.rows);
    });
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
      const attachmentId = await runInTenant(tenant, () =>
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
          const email = await ingestEmailMessage(client, {
            emailsDatabaseId: ids.emailsDatabaseId,
            filesDatabaseId: ids.filesDatabaseId,
            folderRelationPropertyId: folder.id,
            attachmentsRelationPropertyId: attachment.id,
            folderItemId: folderId,
            mailboxItemId: mailboxItem.id,
            messageId: `<${randomUUID()}@example.test>`,
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
          const rows = await client.query<{ id: string }>(
            "SELECT id FROM mail_attachments WHERE message_item_id = $1",
            [email.itemId],
          );
          if (!rows.rows[0]) throw new Error("Missing mail attachment");
          return rows.rows[0].id;
        }),
      );
      const ref = { kind: "mailAttachment" as const, attachmentId };
      await runInTenant(tenant, async () => {
        const before = await runtime.query(
          "SELECT (SELECT count(*)::int FROM mail_attachments) AS attachments, (SELECT count(*)::int FROM blobs) AS blobs",
        );
        const resolved = await withTransaction(runtime, (client) => readSempRefContext(client, ref));
        expect(resolved).toMatchObject({
          label: "note.txt",
          state: "active",
          details: { filename: "note.txt", contentType: "text/plain", byteSize: "4" },
          blob: { byteSize: "4", mimeType: "text/plain" },
        });
        await expect(
          withTransaction(runtime, (client) => readSempRefContext(client, { ...ref, attachmentId: randomUUID() })),
        ).resolves.toBeNull();
        expect(
          (
            await runtime.query(
              "SELECT (SELECT count(*)::int FROM mail_attachments) AS attachments, (SELECT count(*)::int FROM blobs) AS blobs",
            )
          ).rows,
        ).toEqual(before.rows);
      });
      await expect(
        runInTenant(foreign, () => withTransaction(runtime, (client) => readSempRefContext(client, ref))),
      ).resolves.toBeNull();
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (cleanupError) {
      if (failed)
        throw new AggregateError([failure, cleanupError], "Mail reference test and cleanup failed", { cause: failure });
      throw cleanupError;
    }
    if (failed) throw failure instanceof Error ? failure : new Error("Mail reference test failed", { cause: failure });
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
      expect((await runtime.query("SELECT count(*)::int AS count FROM agent_run_events")).rows).toEqual(before.rows);
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
