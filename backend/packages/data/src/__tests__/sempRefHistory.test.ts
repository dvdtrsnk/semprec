import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant, type SempMessageRef } from "@semprec/shared";
import { CORE_TASK_NAMES, enqueueJob, runOnce } from "@semprec/queue";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import {
  createAgentRun,
  createChokePoint,
  createItemWithClient,
  createPendingApprovalRequest,
  createDocStore,
  decideAndEnqueueApprovalRequest,
  finishAgentRun,
  createUser,
  getDatabaseByModuleId,
  listSempThreadMessages,
  listPropertiesByDatabase,
  LocalFsBlobStorageWriter,
  resolveMailModuleIds,
  seedSystem,
  sendSempMessage,
  withTransaction,
  writeComputed,
} from "../index.js";
import { ensureFolderItem } from "../mail/folderDiscovery.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { createCoreTaskList } from "../worker.js";
import { createActionRegistry } from "../scheduler/actions.js";

async function withQueryRestored<T>(
  client: PoolClient,
  descriptor: PropertyDescriptor | undefined,
  queries: Promise<unknown>[],
  work: () => Promise<T>,
): Promise<T> {
  const outcome = await work().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const queryOutcomes = await Promise.allSettled(queries);
  const queryFailures = queryOutcomes.flatMap((result) =>
    result.status === "rejected" && (outcome.ok || result.reason !== outcome.error) ? [result.reason] : [],
  );
  let restoration: { error: unknown } | undefined;
  try {
    if (descriptor) Object.defineProperty(client, "query", descriptor);
    else if (!Reflect.deleteProperty(client, "query")) throw new Error("Cannot restore query descriptor");
  } catch (error) {
    try {
      await client.end();
      restoration = { error };
    } catch (endError) {
      restoration = {
        error: new AggregateError([error, endError], "Observer restoration and client retirement failed", {
          cause: error,
        }),
      };
    }
  }
  const failures: unknown[] = [...(!outcome.ok ? [outcome.error] : []), ...queryFailures];
  if (restoration) failures.push(restoration.error);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "History read and observer cleanup failed", { cause: failures[0] });
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
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
          const descriptor = Object.getOwnPropertyDescriptor(client, "query");
          const queries: Promise<unknown>[] = [];
          const query = client.query;
          client.query = new Proxy(query, {
            apply(target, receiver, args: unknown[]) {
              if (typeof args[0] === "string" && args[0].includes("AS r(item_id, database_id, ordinal)")) {
                const values: unknown = args[1];
                if (Array.isArray(values) && Array.isArray(values[0])) batchSizes.push(values[0].length);
              }
              const result: unknown = Reflect.apply(target, receiver, args);
              if (result instanceof Promise) {
                queries.push(result);
                void result.catch(() => {});
              }
              return result;
            },
          });
          /* eslint-enable @typescript-eslint/unbound-method */
          return withQueryRestored(client, descriptor, queries, async () => {
            return await listSempThreadMessages(client, sent.threadId, 50, null);
          });
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
        { ...blockRef, resolved: { label: "New", databaseKey: "tasks", state: "trashed" } },
        { ...segmentRef, resolved: { label: "New", databaseKey: "tasks", state: "trashed" } },
      ]),
    );
    await runInTenant(tenant, () => cp.purgeExpiredTrashSubtree(item.id, new Date("9999-01-01T00:00:00Z")));
    history = await read();
    user = history.rows.find((row) => row.id === sent.messageId);
    expect(user?.context).toEqual(
      expect.arrayContaining([
        { ...ref, label: "Historic", resolved: { label: null, databaseKey: null, state: "purged" } },
        { ...blockRef, resolved: { label: null, databaseKey: null, state: "purged" } },
        { ...segmentRef, resolved: { label: null, databaseKey: null, state: "purged" } },
      ]),
    );
  });

  it("resolves purged history after the registered tenant-fanout purge job", async () => {
    const tenant = await createTestTenant(admin);
    const foreign = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    await runInTenant(foreign, () => seedSystem(runtime));
    const cp = createChokePoint(runtime);
    const database = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => getDatabaseByModuleId(client, "tasks")),
    );
    const foreignDatabase = await runInTenant(foreign, () =>
      withTransaction(runtime, (client) => getDatabaseByModuleId(client, "tasks")),
    );
    if (!database || !foreignDatabase) throw new Error("Missing tasks database");
    const create = (owner: string, databaseId: string, name: string) =>
      runInTenant(owner, () => cp.createItem({ databaseId, properties: { name } }));
    const target = await create(tenant, database.id, "Expired target");
    const recent = await create(tenant, database.id, "Recent target");
    const live = await create(tenant, database.id, "Live target");
    const foreignRecent = await create(foreign, foreignDatabase.id, "Foreign recent");
    const foreignLive = await create(foreign, foreignDatabase.id, "Foreign live");
    await runInTenant(tenant, () => cp.softDeleteItem(database.id, target.id));
    await runInTenant(tenant, () => cp.softDeleteItem(database.id, recent.id));
    await runInTenant(foreign, () => cp.softDeleteItem(foreignDatabase.id, foreignRecent.id));
    const aged = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) =>
        // The production owner stamps now and cannot construct 31-day-old trash without waiting.
        client.query<{ id: string; eligible: boolean }>(
          `UPDATE items SET deleted_at = now() - interval '31 days'
           WHERE id = $1 AND database_id = $2 AND tenant_id = app_current_tenant() AND deleted_at IS NOT NULL
           RETURNING id, deleted_at <= now() - interval '30 days' AS eligible`,
          [target.id, database.id],
        ),
      ),
    );
    expect(aged.rowCount).toBe(1);
    expect(aged.rows).toEqual([{ id: target.id, eligible: true }]);
    const ref = { kind: "item" as const, itemId: target.id, databaseId: database.id };
    const context = [{ ...ref, label: "Historic target" }, ref];
    const sent = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => sendSempMessage(client, { text: "Question", context, hasContext: true })),
    );
    const directory = await mkdtemp(join(tmpdir(), "semp-history-purge-"));
    let failure: unknown;
    let failed = false;
    try {
      const filesDir = join(directory, "files");
      const mailDir = join(directory, "mail");
      const files = new LocalFsBlobStorageWriter(filesDir);
      const mail = new LocalFsBlobStorageWriter(mailDir);
      const tasks = createCoreTaskList(
        runtime,
        createActionRegistry(),
        undefined,
        undefined,
        mail,
        undefined,
        undefined,
        undefined,
        undefined,
        files,
        { files: filesDir, mailAttachments: mailDir },
      );
      const task = tasks[CORE_TASK_NAMES.ITEM_TRASH_PURGE_SWEEP];
      if (!task) throw new Error("Missing registered purge task");
      const jobKey = `history-purge:${randomUUID()}`;
      const pending = await admin.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM graphile_worker.jobs WHERE task_identifier = $1",
        [CORE_TASK_NAMES.ITEM_TRASH_PURGE_SWEEP],
      );
      expect(pending.rows).toEqual([{ count: 0 }]);
      await runAsSystem("test registered history purge", () =>
        enqueueJob(admin, CORE_TASK_NAMES.ITEM_TRASH_PURGE_SWEEP, {}, { jobKey }),
      );
      const queued = await admin.query<{ id: string; key: string; task_identifier: string }>(
        "SELECT id, key, task_identifier FROM graphile_worker.jobs WHERE key = $1",
        [jobKey],
      );
      expect(queued.rows).toHaveLength(1);
      expect(queued.rows[0]).toMatchObject({ key: jobKey, task_identifier: CORE_TASK_NAMES.ITEM_TRASH_PURGE_SWEEP });
      await runOnce({ pgPool: admin, taskList: { [CORE_TASK_NAMES.ITEM_TRASH_PURGE_SWEEP]: task } });
      const completed = await admin.query<{ id: string }>("SELECT id FROM graphile_worker.jobs WHERE id = $1", [
        queued.rows[0]?.id,
      ]);
      expect(completed.rows).toEqual([]);
      const ownRows = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          client.query<{ id: string; deleted: boolean }>(
            "SELECT id, deleted_at IS NOT NULL AS deleted FROM items WHERE id = ANY($1::uuid[]) ORDER BY id",
            [[target.id, recent.id, live.id]],
          ),
        ),
      );
      expect(ownRows.rows).toEqual(
        expect.arrayContaining([
          { id: recent.id, deleted: true },
          { id: live.id, deleted: false },
        ]),
      );
      expect(ownRows.rows).toHaveLength(2);
      const foreignRows = await runInTenant(foreign, () =>
        withTransaction(runtime, (client) =>
          client.query<{ id: string; deleted: boolean }>(
            "SELECT id, deleted_at IS NOT NULL AS deleted FROM items WHERE id = ANY($1::uuid[]) ORDER BY id",
            [[foreignRecent.id, foreignLive.id]],
          ),
        ),
      );
      expect(foreignRows.rows).toEqual(
        expect.arrayContaining([
          { id: foreignRecent.id, deleted: true },
          { id: foreignLive.id, deleted: false },
        ]),
      );
      expect(foreignRows.rows).toHaveLength(2);
      const observed = await runInTenant(tenant, () =>
        withTransaction(runtime, async (client) => ({
          page: await listSempThreadMessages(client, sent.threadId, 50, null),
          stored: await client.query<{ context: unknown }>("SELECT context FROM semp_messages WHERE id = $1", [
            sent.messageId,
          ]),
        })),
      );
      expect(observed.page.rows.find((row) => row.id === sent.messageId)?.context).toEqual(
        context.map((entry) => ({ ...entry, resolved: { label: null, databaseKey: null, state: "purged" } })),
      );
      expect(observed.stored.rows).toEqual([{ context }]);
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      await rm(directory, { recursive: true });
    } catch (cleanupError) {
      if (failed)
        // Preserve the original test failure as cause; cleanup failure is retained in the aggregate.
        // eslint-disable-next-line preserve-caught-error
        throw new AggregateError([failure, cleanupError], "History purge test and cleanup failed", { cause: failure });
      throw cleanupError;
    }
    if (failed) throw failure instanceof Error ? failure : new Error("History purge test failed", { cause: failure });
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
        const descriptor = Object.getOwnPropertyDescriptor(client, "query");
        const queries: Promise<unknown>[] = [];
        const query = client.query;
        client.query = new Proxy(query, {
          apply(target, receiver, args: unknown[]) {
            if (typeof args[0] === "string" && args[0].includes("AS r(item_id, database_id, ordinal)"))
              resolverQueries += 1;
            const result: unknown = Reflect.apply(target, receiver, args);
            if (result instanceof Promise) {
              queries.push(result);
              void result.catch(() => {});
            }
            return result;
          },
        });
        /* eslint-enable @typescript-eslint/unbound-method */
        return withQueryRestored(client, descriptor, queries, async () => {
          return await listSempThreadMessages(client, first.threadId, 50, null);
        });
      }),
    );
    expect(page.rows).toHaveLength(50);
    expect(page.rows.filter((row) => row.role === "user")).toHaveLength(25);
    expect(resolverQueries).toBe(1);
  });

  it("batches two distinct live references of each kind across repeated messages", async () => {
    const tenant = await createTestTenant(admin);
    await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
    await runInTenant(tenant, () => seedSystem(runtime));
    const db = (moduleId: string) =>
      runInTenant(tenant, () => withTransaction(runtime, (client) => getDatabaseByModuleId(client, moduleId)));
    const tasks = await db("tasks");
    const transcripts = await db("transcripts");
    if (!tasks || !transcripts) throw new Error("Missing fixture databases");
    const cp = createChokePoint(runtime);
    const firstItem = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: tasks.id, properties: { name: "First item" } }),
    );
    const secondItem = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: tasks.id, properties: { name: "Second item" } }),
    );
    const firstBlock = randomUUID();
    const secondBlock = randomUUID();
    await runInTenant(tenant, async () => {
      const docs = createDocStore(runtime);
      await docs.putBlock(firstItem.id, { id: firstBlock, flavour: "paragraph", fields: { text: "First" } }, "user");
      await docs.putBlock(secondItem.id, { id: secondBlock, flavour: "paragraph", fields: { text: "Second" } }, "user");
    });
    const firstTranscript = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: transcripts.id, properties: { name: "First recording" } }),
    );
    const secondTranscript = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: transcripts.id, properties: { name: "Second recording" } }),
    );
    await runInTenant(tenant, () =>
      withTransaction(runtime, async (client) => {
        const segments = [{ speaker: "SPEAKER_00", text: "Fixture", startsAt: 0, endsAt: 1 }];
        await writeComputed(client, transcripts.id, firstTranscript.id, "segments", segments);
        await writeComputed(client, transcripts.id, secondTranscript.id, "segments", segments);
      }),
    );
    const firstRun = await runInTenant(tenant, () =>
      createAgentRun(runtime, { triggeredBy: "user", task: "First run" }),
    );
    const secondRun = await runInTenant(tenant, () =>
      createAgentRun(runtime, { triggeredBy: "user", task: "Second run" }),
    );
    const firstDescription = { key: "approval.itemDelete", params: { itemName: "First" } };
    const secondDescription = { key: "approval.itemDelete", params: { itemName: "Second" } };
    const approval = (agentRunId: string, description: typeof firstDescription) =>
      runInTenant(tenant, () =>
        createPendingApprovalRequest(runtime, {
          agentRunId,
          toolName: "test",
          riskClass: "unclassified",
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
          resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
          description,
        }),
      );
    const firstApproval = await approval(firstRun.id, firstDescription);
    const secondApproval = await approval(secondRun.id, secondDescription);
    const directory = await mkdtemp(join(tmpdir(), "semp-history-batch-"));
    let failure: unknown;
    let failed = false;
    try {
      const attachments = await runInTenant(tenant, () =>
        withTransaction(runtime, async (client) => {
          const ids = await resolveMailModuleIds(client);
          const properties = await listPropertiesByDatabase(client, ids.emailsDatabaseId);
          const folderProperties = await listPropertiesByDatabase(client, ids.foldersDatabaseId);
          const attachment = properties.find((property) => property.key === "attachments");
          const folder = properties.find((property) => property.key === "folder");
          const mailboxProperty = folderProperties.find((property) => property.key === "mailbox");
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
          const email = await ingestEmailMessage(client, {
            emailsDatabaseId: ids.emailsDatabaseId,
            filesDatabaseId: ids.filesDatabaseId,
            folderRelationPropertyId: folder.id,
            attachmentsRelationPropertyId: attachment.id,
            folderItemId: folderId,
            mailboxItemId: mailbox.id,
            messageId: `<${randomUUID()}@example.test>`,
            subject: "Mail",
            envelope: {},
            attachments: ["first.txt", "second.txt"].map((filename) => ({
              filename,
              contentType: "text/plain",
              contentId: null,
              disposition: "attachment",
              openStream: () => Readable.from([filename]),
            })),
            storage: new LocalFsBlobStorageWriter(directory),
            storageKeyPrefix: "history-batch",
          });
          return (
            await client.query<{ id: string; filename: string }>(
              "SELECT id, filename FROM mail_attachments WHERE message_item_id = $1 ORDER BY filename",
              [email.itemId],
            )
          ).rows;
        }),
      );
      if (attachments.length !== 2 || !attachments[0] || !attachments[1]) throw new Error("Missing mail attachments");
      const cases: Array<{
        refs: [SempMessageRef, SempMessageRef];
        labels: [unknown, unknown];
        keys: [string | null, string | null];
        query: string;
      }> = [
        {
          refs: [
            { kind: "item", itemId: firstItem.id, databaseId: tasks.id },
            { kind: "item", itemId: secondItem.id, databaseId: tasks.id },
          ],
          labels: ["First item", "Second item"],
          keys: ["tasks", "tasks"],
          query: "AS r(item_id, database_id, ordinal)",
        },
        {
          refs: [
            { kind: "block", itemId: firstItem.id, blockId: firstBlock },
            { kind: "block", itemId: secondItem.id, blockId: secondBlock },
          ],
          labels: ["First item", "Second item"],
          keys: ["tasks", "tasks"],
          query: "AS r(item_id, database_id, ordinal)",
        },
        {
          refs: [
            { kind: "transcriptSegment", itemId: firstTranscript.id, startsAt: 0, endsAt: 1 },
            { kind: "transcriptSegment", itemId: secondTranscript.id, startsAt: 0, endsAt: 1 },
          ],
          labels: ["First recording 0:00-0:01", "Second recording 0:00-0:01"],
          keys: ["transcripts", "transcripts"],
          query: "AS r(item_id, database_id, ordinal)",
        },
        {
          refs: [
            { kind: "mailAttachment", attachmentId: attachments[0].id },
            { kind: "mailAttachment", attachmentId: attachments[1].id },
          ],
          labels: ["first.txt", "second.txt"],
          keys: ["emails", "emails"],
          query: "LEFT JOIN mail_attachments a ON a.id = r.id",
        },
        {
          refs: [
            { kind: "agentRun", agentRunId: firstRun.id },
            { kind: "agentRun", agentRunId: secondRun.id },
          ],
          labels: ["First run", "Second run"],
          keys: [null, null],
          query: "LEFT JOIN agent_runs a ON a.id = r.id",
        },
        {
          refs: [
            { kind: "approvalRequest", approvalRequestId: firstApproval.id },
            { kind: "approvalRequest", approvalRequestId: secondApproval.id },
          ],
          labels: [firstDescription, secondDescription],
          keys: [null, null],
          query: "LEFT JOIN approval_requests a ON a.id = r.id",
        },
      ];
      for (const fixture of cases) {
        const context = [{ ...fixture.refs[0], label: "Preserved label" }, fixture.refs[1]];
        const first = await runInTenant(tenant, () =>
          withTransaction(runtime, (client) => sendSempMessage(client, { text: "First", context, hasContext: true })),
        );
        const second = await runInTenant(tenant, () =>
          withTransaction(runtime, (client) =>
            sendSempMessage(client, { threadId: first.threadId, text: "Second", context, hasContext: true }),
          ),
        );
        let resolverQueries = 0;
        const observed = await runInTenant(tenant, () =>
          withTransaction(runtime, async (client) => {
            /* eslint-disable @typescript-eslint/unbound-method */
            const descriptor = Object.getOwnPropertyDescriptor(client, "query");
            const queries: Promise<unknown>[] = [];
            const query = client.query;
            client.query = new Proxy(query, {
              apply(target, receiver, args: unknown[]) {
                if (typeof args[0] === "string" && args[0].includes(fixture.query)) resolverQueries += 1;
                const result: unknown = Reflect.apply(target, receiver, args);
                if (result instanceof Promise) {
                  queries.push(result);
                  void result.catch(() => {});
                }
                return result;
              },
            });
            /* eslint-enable @typescript-eslint/unbound-method */
            return withQueryRestored(client, descriptor, queries, async () => {
              const page = await listSempThreadMessages(client, first.threadId, 50, null);
              const stored = await client.query<{ id: string; context: unknown }>(
                "SELECT id, context FROM semp_messages WHERE id = ANY($1::uuid[])",
                [[first.messageId, second.messageId]],
              );
              return { page, stored };
            });
          }),
        );
        expect(resolverQueries).toBe(1);
        expect(observed.page.rows).toHaveLength(4);
        const expected = context.map((entry, index) => ({
          ...entry,
          resolved: { label: fixture.labels[index], databaseKey: fixture.keys[index], state: "active" },
        }));
        const users = observed.page.rows.filter((row) => row.role === "user");
        expect(users).toHaveLength(2);
        expect(users.map((row) => row.context)).toEqual([expected, expected]);
        expect(observed.stored.rows).toHaveLength(2);
        expect(observed.stored.rows.map((row) => row.context)).toEqual([context, context]);
      }
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      await rm(directory, { recursive: true });
    } catch (cleanupError) {
      if (failed)
        // Preserve the original test failure as cause; cleanup failure is retained in the aggregate.
        // eslint-disable-next-line preserve-caught-error
        throw new AggregateError([failure, cleanupError], "History batch test and cleanup failed", { cause: failure });
      throw cleanupError;
    }
    if (failed) throw failure instanceof Error ? failure : new Error("History batch test failed", { cause: failure });
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
    const owner = await createUser(admin, {
      tenantId: tenant,
      email: `${randomUUID()}@example.test`,
      passwordHash: "unused",
    });
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
        const descriptor = Object.getOwnPropertyDescriptor(client, "query");
        const queries: Promise<unknown>[] = [];
        const query = client.query;
        client.query = new Proxy(query, {
          apply(target, receiver, args: unknown[]) {
            if (typeof args[0] === "string" && args[0].includes("LEFT JOIN agent_runs a ON a.id = r.id"))
              runQueries += 1;
            if (typeof args[0] === "string" && args[0].includes("LEFT JOIN approval_requests a ON a.id = r.id"))
              approvalQueries += 1;
            const result: unknown = Reflect.apply(target, receiver, args);
            if (result instanceof Promise) {
              queries.push(result);
              void result.catch(() => {});
            }
            return result;
          },
        });
        /* eslint-enable @typescript-eslint/unbound-method */
        return withQueryRestored(client, descriptor, queries, async () => {
          return await listSempThreadMessages(client, sent.threadId, 50, null);
        });
      }),
    );
    expect(runQueries).toBe(1);
    expect(approvalQueries).toBe(1);
    const expected = [
      { ...context[0], resolved: { label: "😀".repeat(120), databaseKey: null, state: "active" } },
      { ...context[1], resolved: { label: description, databaseKey: null, state: "active" } },
      { ...context[2], resolved: { label: null, databaseKey: null, state: "active" } },
      { ...context[3], resolved: { label: null, databaseKey: null, state: "purged" } },
      { ...context[4], resolved: { label: null, databaseKey: null, state: "purged" } },
      { ...context[5], resolved: { label: null, databaseKey: null, state: "purged" } },
    ];
    expect(page.rows.find((row) => row.id === sent.messageId)?.context).toEqual(expected);
    await runInTenant(tenant, () =>
      withTransaction(runtime, async (client) => {
        expect(await finishAgentRun(client, run.id, "done", null)).toBe(true);
        const decision = await decideAndEnqueueApprovalRequest(client, {
          approvalRequestId: legacy.id,
          decision: "rejected",
          decidedByUserId: owner.id,
        });
        expect(decision?.request.status).toBe("rejected");
      }),
    );
    const afterDecision = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => listSempThreadMessages(client, sent.threadId, 50, null)),
    );
    expect(afterDecision.rows.find((row) => row.id === sent.messageId)?.context).toEqual(expected);
    // Synthetic corrupt stored JSON exercises the existing approval-owner validator.
    await runInTenant(tenant, () =>
      runtime.query<Record<string, never>>("UPDATE approval_requests SET description = $1::jsonb WHERE id = $2", [
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
            const descriptor = Object.getOwnPropertyDescriptor(client, "query");
            const queries: Promise<unknown>[] = [];
            const query = client.query;
            client.query = new Proxy(query, {
              apply(target, receiver, args: unknown[]) {
                if (typeof args[0] === "string" && args[0].includes("LEFT JOIN mail_attachments a ON a.id = r.id"))
                  attachmentQueries += 1;
                const result: unknown = Reflect.apply(target, receiver, args);
                if (result instanceof Promise) {
                  queries.push(result);
                  void result.catch(() => {});
                }
                return result;
              },
            });
            /* eslint-enable @typescript-eslint/unbound-method */
            return withQueryRestored(client, descriptor, queries, async () => {
              return await listSempThreadMessages(client, sent.threadId, 50, null);
            });
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
