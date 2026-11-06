import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import {
  createAgentRun,
  createChokePoint,
  createItemWithClient,
  createPendingApprovalRequest,
  createUser,
  getDatabaseByModuleId,
  listSempThreadMessages,
  listPropertiesByDatabase,
  LocalFsBlobStorageWriter,
  resolveMailModuleIds,
  seedSystem,
  sendSempMessage,
  withTransaction,
} from "../index.js";
import { ensureFolderItem } from "../mail/folderDiscovery.js";
import { ingestEmailMessage } from "../mail/ingest.js";

describe("Semp history reference resolution", () => {
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

  it("resolves current names and trash/purge state while preserving mixed historical entries", async () => {
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
      cp.createItem({ databaseId: database.id, properties: { name: "Old" } }),
    );
    const foreignItem = await runInTenant(foreign, () =>
      cp.createItem({ databaseId: foreignDatabase.id, properties: { name: "Private" } }),
    );
    const ref = { kind: "item" as const, itemId: item.id, databaseId: database.id };
    const foreignRef = { kind: "item" as const, itemId: foreignItem.id, databaseId: foreignDatabase.id };
    const randomRef = { kind: "item" as const, itemId: randomUUID(), databaseId: database.id };
    const blockRef = { kind: "block" as const, itemId: item.id, blockId: randomUUID() };
    const segmentRef = { kind: "transcriptSegment" as const, itemId: item.id, startsAt: 0, endsAt: 1 };
    const secondBlock = { ...blockRef, blockId: randomUUID() };
    const secondSegment = { ...segmentRef, startsAt: 2, endsAt: 3 };
    const originalContext = [
      { ...ref, label: "Historic" },
      { kind: "future", data: "kept" },
      foreignRef,
      randomRef,
      blockRef,
      segmentRef,
      secondBlock,
      secondSegment,
    ];
    const sent = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) =>
        sendSempMessage(client, {
          text: "Question",
          context: originalContext,
          hasContext: true,
        }),
      ),
    );
    const batchSizes: number[] = [];
    const read = () =>
      runInTenant(tenant, () =>
        withTransaction(runtime, async (client) => {
          /* eslint-disable @typescript-eslint/unbound-method */
          const query = client.query;
          client.query = new Proxy(query, {
            apply(target, receiver, args: unknown[]) {
              if (typeof args[0] === "string" && args[0].includes("AS r(item_id, database_id, ordinal)")) {
                const values: unknown = args[1];
                if (Array.isArray(values) && Array.isArray(values[0])) batchSizes.push(values[0].length);
              }
              return Reflect.apply(target, receiver, args);
            },
          });
          /* eslint-enable @typescript-eslint/unbound-method */
          try {
            return await listSempThreadMessages(client, sent.threadId, 50, null);
          } finally {
            client.query = query;
          }
        }),
      );
    await runInTenant(tenant, () =>
      cp.updateItem({ databaseId: database.id, itemId: item.id, propertiesPatch: { name: "New" } }),
    );
    let history = await read();
    expect(batchSizes).toEqual([3, 2, 2]);
    let user = history.rows.find((row) => row.id === sent.messageId);
    expect(user?.context).toEqual([
      { ...ref, label: "Historic", resolved: { label: "New", databaseKey: "tasks", state: "active" } },
      { kind: "future", data: "kept" },
      { ...foreignRef, resolved: { label: null, databaseKey: null, state: "purged" } },
      { ...randomRef, resolved: { label: null, databaseKey: null, state: "purged" } },
      { ...blockRef, resolved: { label: "New", databaseKey: "tasks", state: "active" } },
      { ...segmentRef, resolved: { label: "New", databaseKey: "tasks", state: "active" } },
      { ...secondBlock, resolved: { label: "New", databaseKey: "tasks", state: "active" } },
      { ...secondSegment, resolved: { label: "New", databaseKey: "tasks", state: "active" } },
    ]);
    const stored = await runInTenant(tenant, () =>
      runtime.query<{ context: unknown }>("SELECT context FROM semp_messages WHERE id = $1", [sent.messageId]),
    );
    expect(stored.rows).toEqual([{ context: originalContext }]);
    await runInTenant(tenant, () => cp.softDeleteItem(database.id, item.id));
    history = await read();
    user = history.rows.find((row) => row.id === sent.messageId);
    expect(user?.context).toEqual(
      expect.arrayContaining([
        { ...ref, label: "Historic", resolved: { label: "New", databaseKey: "tasks", state: "trashed" } },
      ]),
    );
    await runInTenant(tenant, () => cp.purgeExpiredTrashSubtree(item.id, new Date("9999-01-01T00:00:00Z")));
    history = await read();
    user = history.rows.find((row) => row.id === sent.messageId);
    expect(user?.context).toEqual(
      expect.arrayContaining([
        { ...ref, label: "Historic", resolved: { label: null, databaseKey: null, state: "purged" } },
      ]),
    );
  });

  it("uses one item resolver statement for a 50-message page", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    const database = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => getDatabaseByModuleId(client, "tasks")),
    );
    if (!database) throw new Error("Missing tasks database");
    const item = await runInTenant(tenant, () =>
      createChokePoint(runtime).createItem({ databaseId: database.id, properties: { name: "Task" } }),
    );
    const context = [{ kind: "item", itemId: item.id, databaseId: database.id }];
    const first = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => sendSempMessage(client, { text: "First", context, hasContext: true })),
    );
    for (let index = 0; index < 24; index += 1) {
      await runInTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          sendSempMessage(client, { threadId: first.threadId, text: `Question ${index}`, context, hasContext: true }),
        ),
      );
    }
    let resolverQueries = 0;
    const page = await runInTenant(tenant, () =>
      withTransaction(runtime, async (client) => {
        /* eslint-disable @typescript-eslint/unbound-method */
        const query = client.query;
        client.query = new Proxy(query, {
          apply(target, receiver, args: unknown[]) {
            if (typeof args[0] === "string" && args[0].includes("AS r(item_id, database_id, ordinal)"))
              resolverQueries += 1;
            return Reflect.apply(target, receiver, args);
          },
        });
        /* eslint-enable @typescript-eslint/unbound-method */
        try {
          return await listSempThreadMessages(client, first.threadId, 50, null);
        } finally {
          client.query = query;
        }
      }),
    );
    expect(page.rows).toHaveLength(50);
    expect(page.rows.filter((row) => row.role === "user")).toHaveLength(25);
    expect(resolverQueries).toBe(1);
  });

  it("keeps empty and absent title values and a nullable user database key distinct", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    const cp = createChokePoint(runtime);
    const database = await runInTenant(tenant, () => cp.createDatabaseWithProperties({ name: "Personal" }, "Name", []));
    const empty = await runInTenant(tenant, () => cp.createItem({ databaseId: database.id, properties: { name: "" } }));
    const absent = await runInTenant(tenant, () => cp.createItem({ databaseId: database.id, properties: {} }));
    const context = [empty, absent].map((item) => ({ kind: "item", itemId: item.id, databaseId: database.id }));
    const sent = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => sendSempMessage(client, { text: "Question", context, hasContext: true })),
    );
    const page = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => listSempThreadMessages(client, sent.threadId, 50, null)),
    );
    expect(page.rows.find((row) => row.id === sent.messageId)?.context).toEqual([
      { ...context[0], resolved: { label: "", databaseKey: null, state: "active" } },
      { ...context[1], resolved: { label: null, databaseKey: null, state: "active" } },
    ]);
  });

  it("passes an unrecognized historical non-array context through unchanged", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    const context = { legacy: ["opaque"] };
    const sent = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => sendSempMessage(client, { text: "Question", context, hasContext: true })),
    );
    const page = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => listSempThreadMessages(client, sent.threadId, 50, null)),
    );
    expect(page.rows.find((row) => row.id === sent.messageId)?.context).toEqual(context);
  });
  it("returns code-point-bounded run labels and structured or null approval labels", async () => {
    const tenant = await createTestTenant(admin);
    const foreign = await createTestTenant(admin);
    await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
    await createUser(admin, { tenantId: foreign, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
    await runInTenant(tenant, () => seedSystem(runtime));
    await runInTenant(foreign, () => seedSystem(runtime));
    const run = await runInTenant(tenant, () =>
      createAgentRun(runtime, { triggeredBy: "user", task: "😀".repeat(121) }),
    );
    const foreignRun = await runInTenant(foreign, () =>
      createAgentRun(runtime, { triggeredBy: "user", task: "Private" }),
    );
    const description = { key: "approval.itemDelete", params: { itemName: "Example" } };
    const createApproval = (withDescription: boolean) =>
      runInTenant(tenant, () =>
        createPendingApprovalRequest(runtime, {
          agentRunId: run.id,
          toolName: "test",
          riskClass: "unclassified",
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
          resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
          ...(withDescription ? { description } : {}),
        }),
      );
    const described = await createApproval(true);
    const legacy = await createApproval(false);
    const context = [
      { kind: "agentRun", agentRunId: run.id },
      { kind: "approvalRequest", approvalRequestId: described.id },
      { kind: "approvalRequest", approvalRequestId: legacy.id },
      { kind: "approvalRequest", approvalRequestId: randomUUID() },
      { kind: "agentRun", agentRunId: randomUUID() },
      { kind: "agentRun", agentRunId: foreignRun.id },
    ];
    const sent = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => sendSempMessage(client, { text: "Question", context, hasContext: true })),
    );
    let runQueries = 0;
    let approvalQueries = 0;
    const page = await runInTenant(tenant, () =>
      withTransaction(runtime, async (client) => {
        /* eslint-disable @typescript-eslint/unbound-method */
        const query = client.query;
        client.query = new Proxy(query, {
          apply(target, receiver, args: unknown[]) {
            if (typeof args[0] === "string" && args[0].includes("LEFT JOIN agent_runs a ON a.id = r.id"))
              runQueries += 1;
            if (typeof args[0] === "string" && args[0].includes("LEFT JOIN approval_requests a ON a.id = r.id"))
              approvalQueries += 1;
            return Reflect.apply(target, receiver, args);
          },
        });
        /* eslint-enable @typescript-eslint/unbound-method */
        try {
          return await listSempThreadMessages(client, sent.threadId, 50, null);
        } finally {
          client.query = query;
        }
      }),
    );
    expect(runQueries).toBe(1);
    expect(approvalQueries).toBe(1);
    expect(page.rows.find((row) => row.id === sent.messageId)?.context).toEqual([
      { ...context[0], resolved: { label: "😀".repeat(120), databaseKey: null, state: "active" } },
      { ...context[1], resolved: { label: description, databaseKey: null, state: "active" } },
      { ...context[2], resolved: { label: null, databaseKey: null, state: "active" } },
      { ...context[3], resolved: { label: null, databaseKey: null, state: "purged" } },
      { ...context[4], resolved: { label: null, databaseKey: null, state: "purged" } },
      { ...context[5], resolved: { label: null, databaseKey: null, state: "purged" } },
    ]);
    // Synthetic corrupt stored JSON exercises the existing approval-owner validator.
    await runInTenant(tenant, () =>
      runtime.query("UPDATE approval_requests SET description = $1::jsonb WHERE id = $2", [
        JSON.stringify({ key: 5 }),
        described.id,
      ]),
    );
    await expect(
      runInTenant(tenant, () =>
        withTransaction(runtime, (client) => listSempThreadMessages(client, sent.threadId, 50, null)),
      ),
    ).rejects.toThrow("description");
  });

  it("shows the filename of a real ingested mail attachment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "semp-ref-history-"));
    let failure: unknown;
    let failed = false;
    try {
      const tenant = await createTestTenant(admin);
      await runInTenant(tenant, () => seedSystem(runtime));
      const fixture = await runInTenant(tenant, () =>
        withTransaction(runtime, async (client) => {
          const ids = await resolveMailModuleIds(client);
          const properties = await listPropertiesByDatabase(client, ids.emailsDatabaseId);
          const folderProperties = await listPropertiesByDatabase(client, ids.foldersDatabaseId);
          const attachmentProperty = properties.find((property) => property.key === "attachments");
          const folderProperty = properties.find((property) => property.key === "folder");
          const mailboxProperty = folderProperties.find((property) => property.key === "mailbox");
          if (!attachmentProperty || !folderProperty || !mailboxProperty) throw new Error("Missing mail relation");
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
          const email = await ingestEmailMessage(client, {
            emailsDatabaseId: ids.emailsDatabaseId,
            filesDatabaseId: ids.filesDatabaseId,
            folderRelationPropertyId: folderProperty.id,
            attachmentsRelationPropertyId: attachmentProperty.id,
            folderItemId: folderId,
            mailboxItemId: mailbox.id,
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
            storageKeyPrefix: "history-test",
          });
          const result = await client.query<{ id: string }>(
            "SELECT id FROM mail_attachments WHERE message_item_id = $1",
            [email.itemId],
          );
          if (!result.rows[0]) throw new Error("Missing attachment");
          return { attachmentId: result.rows[0].id, emailId: email.itemId, databaseId: ids.emailsDatabaseId };
        }),
      );
      const ref = { kind: "mailAttachment", attachmentId: fixture.attachmentId };
      const missing = { kind: "mailAttachment", attachmentId: randomUUID() };
      const sent = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          sendSempMessage(client, { text: "Question", context: [ref, missing], hasContext: true }),
        ),
      );
      let attachmentQueries = 0;
      const read = () =>
        runInTenant(tenant, () =>
          withTransaction(runtime, async (client) => {
            /* eslint-disable @typescript-eslint/unbound-method */
            const query = client.query;
            client.query = new Proxy(query, {
              apply(target, receiver, args: unknown[]) {
                if (typeof args[0] === "string" && args[0].includes("LEFT JOIN mail_attachments a ON a.id = r.id"))
                  attachmentQueries += 1;
                return Reflect.apply(target, receiver, args);
              },
            });
            /* eslint-enable @typescript-eslint/unbound-method */
            try {
              return await listSempThreadMessages(client, sent.threadId, 50, null);
            } finally {
              client.query = query;
            }
          }),
        );
      let page = await read();
      expect(attachmentQueries).toBe(1);
      expect(page.rows.find((row) => row.id === sent.messageId)?.context).toEqual([
        { ...ref, resolved: { label: "note.txt", databaseKey: "emails", state: "active" } },
        { ...missing, resolved: { label: null, databaseKey: null, state: "purged" } },
      ]);
      await runInTenant(tenant, () => createChokePoint(runtime).softDeleteItem(fixture.databaseId, fixture.emailId));
      page = await read();
      expect(page.rows.find((row) => row.id === sent.messageId)?.context).toEqual([
        { ...ref, resolved: { label: "note.txt", databaseKey: "emails", state: "active" } },
        { ...missing, resolved: { label: null, databaseKey: null, state: "purged" } },
      ]);
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      await rm(directory, { recursive: true });
    } catch (cleanupError) {
      if (failed)
        throw new AggregateError([failure, cleanupError], "Attachment history test and cleanup failed", {
          // Keep the original test failure primary and retain cleanup failure in the aggregate.
          // eslint-disable-next-line preserve-caught-error
          cause: failure,
        });
      throw cleanupError;
    }
    if (failed)
      throw failure instanceof Error ? failure : new Error("Attachment history test failed", { cause: failure });
  });
});
