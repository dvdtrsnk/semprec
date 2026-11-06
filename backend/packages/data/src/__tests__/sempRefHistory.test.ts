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
import { ingestAttachments } from "../mail/attachments.js";

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
    const originalContext = [
      { ...ref, label: "Historic" },
      { kind: "future", data: "kept" },
      foreignRef,
      randomRef,
      blockRef,
      segmentRef,
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
    const read = () =>
      runInTenant(tenant, () =>
        withTransaction(runtime, (client) => listSempThreadMessages(client, sent.threadId, 50, null)),
      );
    await runInTenant(tenant, () =>
      cp.updateItem({ databaseId: database.id, itemId: item.id, propertiesPatch: { name: "New" } }),
    );
    let history = await read();
    let user = history.rows.find((row) => row.id === sent.messageId);
    expect(user?.context).toEqual([
      { ...ref, label: "Historic", resolved: { label: "New", databaseKey: "tasks", state: "active" } },
      { kind: "future", data: "kept" },
      { ...foreignRef, resolved: { label: null, databaseKey: null, state: "purged" } },
      { ...randomRef, resolved: { label: null, databaseKey: null, state: "purged" } },
      { ...blockRef, resolved: { label: "New", databaseKey: "tasks", state: "active" } },
      { ...segmentRef, resolved: { label: "New", databaseKey: "tasks", state: "active" } },
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
  it("returns code-point-bounded run labels and structured or null approval labels", async () => {
    const tenant = await createTestTenant(admin);
    await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
    await runInTenant(tenant, () => seedSystem(runtime));
    const run = await runInTenant(tenant, () =>
      createAgentRun(runtime, { triggeredBy: "user", task: "😀".repeat(121) }),
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
    ];
    const sent = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => sendSempMessage(client, { text: "Question", context, hasContext: true })),
    );
    const page = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => listSempThreadMessages(client, sent.threadId, 50, null)),
    );
    expect(page.rows.find((row) => row.id === sent.messageId)?.context).toEqual([
      { ...context[0], resolved: { label: "😀".repeat(120), databaseKey: null, state: "active" } },
      { ...context[1], resolved: { label: description, databaseKey: null, state: "active" } },
      { ...context[2], resolved: { label: null, databaseKey: null, state: "active" } },
      { ...context[3], resolved: { label: null, databaseKey: null, state: "purged" } },
    ]);
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
          const attachmentProperty = properties.find((property) => property.key === "attachments");
          if (!attachmentProperty) throw new Error("Missing attachment relation");
          const email = await createItemWithClient(client, {
            databaseId: ids.emailsDatabaseId,
            properties: { name: "Mail" },
          });
          await ingestAttachments(client, {
            messageItemId: email.id,
            filesDatabaseId: ids.filesDatabaseId,
            attachmentsRelationPropertyId: attachmentProperty.id,
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
            [email.id],
          );
          if (!result.rows[0]) throw new Error("Missing attachment");
          return { attachmentId: result.rows[0].id, emailId: email.id, databaseId: ids.emailsDatabaseId };
        }),
      );
      const ref = { kind: "mailAttachment", attachmentId: fixture.attachmentId };
      const missing = { kind: "mailAttachment", attachmentId: randomUUID() };
      const sent = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          sendSempMessage(client, { text: "Question", context: [ref, missing], hasContext: true }),
        ),
      );
      const read = () =>
        runInTenant(tenant, () =>
          withTransaction(runtime, (client) => listSempThreadMessages(client, sent.threadId, 50, null)),
        );
      let page = await read();
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
          cause: failure,
        });
      throw cleanupError;
    }
    if (failed)
      throw failure instanceof Error ? failure : new Error("Attachment history test failed", { cause: failure });
  });
});
