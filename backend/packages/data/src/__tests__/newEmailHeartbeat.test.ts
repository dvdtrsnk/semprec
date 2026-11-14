import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { runOnce } from "@semprec/queue";
import type { AiGatewayClientPort } from "@semprec/shared";
import {
  bindToTenantZero,
  createTenantZeroUser,
  getTestPool,
  inTenantZero,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { createActionRegistry, CORE_AGENT_RUN_ACTION_ID, coreAgentRunAction } from "../scheduler/actions.js";
import { createNewEmailAgentRunDependencies } from "../mail/newEmailAgentRun.js";
import { createCoreTaskList } from "../worker.js";
import { listAgentRunsByHeartbeat } from "../agentRuns/agentRunsStore.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { EMAILS_RELATION_CONTEXT } from "../mail/emailsRelationContext.js";
import {
  createLinkEmailToPeopleAction,
  createPersonEmailReindexAction,
  MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID,
  MAIL_REINDEX_PERSON_EMAILS_ACTION_ID,
} from "../mail/personLinkingActions.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { hasWaitingHeartbeatFireJob } from "../scheduler/schedulerStore.js";

let pool: Pool;
let chokePoint: ChokePoint;

async function createUser(): Promise<string> {
  return (await createTenantZeroUser(pool)).id;
}

const noopStorage: BlobStorageWriter = {
  async writeStream(_key, source) {
    let byteSize = 0;
    const hash = createHash("sha256");
    for await (const chunk of source) {
      hash.update(chunk as Buffer);
      byteSize += (chunk as Buffer).length;
    }
    return { byteSize, contentHash: hash.digest("hex") };
  },
  async delete() {},
  readStream() {
    throw new Error("readStream is not used by this test");
  },
};

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function getNewEmailHeartbeatId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM project_heartbeats WHERE name = 'newEmail'");
  if (!rows[0]) throw new Error("newEmail heartbeat was not seeded");
  return rows[0].id;
}

/** The seeded heartbeat has the answer-expected gate (issue gh-1941); this gateway says that every message expects one. */
const answeringGateway: AiGatewayClientPort = {
  complete: async () => ({ content: { expectsReply: true }, usage: { inputTokens: 1, outputTokens: 1 } }),
};

function agentRunRegistry(runCalls: string[]) {
  const registry = createActionRegistry();
  registry.set(
    CORE_AGENT_RUN_ACTION_ID,
    coreAgentRunAction(
      pool,
      async ({ task }) => {
        runCalls.push(task);
        return { result: "ok" };
      },
      createNewEmailAgentRunDependencies(pool, answeringGateway),
    ),
  );
  registry.set(MAIL_REINDEX_PERSON_EMAILS_ACTION_ID, createPersonEmailReindexAction(pool));
  registry.set(MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID, createLinkEmailToPeopleAction(pool));
  return registry;
}

async function drainQueue(registry: ReturnType<typeof createActionRegistry>) {
  await runOnce({ pgPool: pool, taskList: createCoreTaskList(pool, registry) });
}

describe("newEmail heartbeat (issue #99)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= bindToTenantZero(createChokePoint(pool));
    await resetDatabase(pool);
    await seedSystem(pool);
    await createUser();
    const peopleId = await databaseIdFor("people");
    const person = await chokePoint.createItem({
      databaseId: peopleId,
      properties: { name: "Alice", emails: "alice@example.com\nbob@example.com" },
    });
    const heartbeatId = await getNewEmailHeartbeatId();
    const { rows } = await pool.query<{ project_item_id: string }>(
      "SELECT project_item_id FROM project_heartbeats WHERE id = $1",
      [heartbeatId],
    );
    if (!rows[0]) throw new Error("Missing heartbeat project");
    await inTenantZero(() =>
      createPersonEmailReindexAction(pool)(
        { peopleDatabaseId: peopleId },
        { heartbeatId, projectItemId: rows[0]!.project_item_id, itemId: person.id },
      ),
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function ingestInto(specialPurposes: string[], messageId: string, sender = "alice@example.com", bulk = false) {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const folderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "folder")!;
    const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;

    const folders = await withTransaction(pool, async (client) => {
      const created = [];
      for (const specialPurpose of specialPurposes) {
        created.push(
          await createItemWithClient(
            client,
            { databaseId: foldersId, properties: { name: specialPurpose, behavior: "folder", specialPurpose } },
            { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
          ),
        );
      }
      return created;
    });

    const result = await inTenantZero(() =>
      withTransaction(pool, async (client) => {
        const ingestResult = await ingestEmailMessage(client, {
          emailsDatabaseId: emailsId,
          filesDatabaseId: filesId,
          folderRelationPropertyId: folderProperty.id,
          attachmentsRelationPropertyId: attachmentsProperty.id,
          folderItemId: folders[0]!.id,
          mailboxItemId: randomUUID(),
          messageId,
          subject: "Hello",
          envelope: { from: { address: sender, name: "Alice" }, to: [{ address: "bob@example.com" }] },
          ...(bulk ? { bulkHeaders: { precedence: "bulk" } } : {}),
          bodyText: "hi",
          attachments: [],
          storage: noopStorage,
          storageKeyPrefix: "test",
        });
        // A message with multiple folder memberships (e.g. Gmail labels) — link the rest too.
        for (const folder of folders.slice(1)) {
          await createRelationWithClient(
            client,
            { relationPropertyId: folderProperty.id, callerItemId: ingestResult.itemId, targetItemId: folder.id },
            EMAILS_RELATION_CONTEXT,
          );
        }
        return ingestResult;
      }),
    );

    return result;
  }

  it("emits one core.agentRun for a new Inbox message", async () => {
    const heartbeatId = await getNewEmailHeartbeatId();
    const runCalls: string[] = [];
    const registry = agentRunRegistry(runCalls);

    const message = await ingestInto(["inbox"], "<inbox1@example.com>");
    await drainQueue(registry);

    const runs = await listAgentRunsByHeartbeat(pool, heartbeatId);
    expect(runs).toHaveLength(1);
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]).toContain(`Triggering item id: ${message.itemId}`);
    expect(runs[0]?.task).toContain(`Triggering item id: ${message.itemId}`);
  });

  it("does not start a run for bulk, unknown or own sender", async () => {
    const heartbeatId = await getNewEmailHeartbeatId();
    const runCalls: string[] = [];
    const registry = agentRunRegistry(runCalls);
    const mailboxes = await databaseIdFor("mailboxes");
    const mailbox = await chokePoint.createItem({
      databaseId: mailboxes,
      properties: { name: "Own", provider: "generic" },
    });
    await inTenantZero(() =>
      withTransaction(pool, (client) =>
        writeMailboxAddresses(client, {
          mailboxesDatabaseId: mailboxes,
          mailboxItemId: mailbox.id,
          address: "alice@example.com",
        }),
      ),
    );
    await ingestInto(["inbox"], "<bulk@example.com>", "bob@example.com", true);
    await drainQueue(registry);
    expect(await listAgentRunsByHeartbeat(pool, heartbeatId)).toHaveLength(0);
    await ingestInto(["inbox"], "<unknown@example.com>", "unknown@example.com");
    await drainQueue(registry);
    expect(await listAgentRunsByHeartbeat(pool, heartbeatId)).toHaveLength(0);
    await ingestInto(["inbox"], "<own@example.com>", "alice@example.com");
    await drainQueue(registry);
    expect(await listAgentRunsByHeartbeat(pool, heartbeatId)).toHaveLength(0);
    expect(runCalls).toHaveLength(0);
  });

  it("does not start a queued run when an Inbox item has no mail metadata", async () => {
    const heartbeatId = await getNewEmailHeartbeatId();
    const runCalls: string[] = [];
    const registry = agentRunRegistry(runCalls);
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const folderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "folder");
    if (!folderProperty) throw new Error("Missing email folder property");
    const item = await inTenantZero(() =>
      withTransaction(pool, async (client) => {
        const folder = await createItemWithClient(
          client,
          { databaseId: foldersId, properties: { name: "Inbox", behavior: "folder", specialPurpose: "inbox" } },
          { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
        );
        const email = await createItemWithClient(client, { databaseId: emailsId, properties: {} });
        await createRelationWithClient(
          client,
          { relationPropertyId: folderProperty.id, callerItemId: email.id, targetItemId: folder.id },
          EMAILS_RELATION_CONTEXT,
        );
        return email;
      }),
    );
    const metadata = await inTenantZero(() =>
      pool.query<{ item_id: string }>("SELECT item_id FROM mail_message_meta WHERE item_id = $1", [item.id]),
    );
    expect(metadata.rows).toEqual([]);
    expect(await inTenantZero(() => hasWaitingHeartbeatFireJob(pool, heartbeatId))).toBe(true);
    await drainQueue(registry);
    expect(await inTenantZero(() => hasWaitingHeartbeatFireJob(pool, heartbeatId))).toBe(false);
    expect(await listAgentRunsByHeartbeat(pool, heartbeatId)).toEqual([]);
    expect(runCalls).toEqual([]);
  });

  it("emits none for junk/trash-only mail", async () => {
    const heartbeatId = await getNewEmailHeartbeatId();
    const runCalls: string[] = [];
    const registry = agentRunRegistry(runCalls);

    await ingestInto(["junk"], "<junk1@example.com>");
    await ingestInto(["trash"], "<trash1@example.com>");
    await drainQueue(registry);

    const runs = await listAgentRunsByHeartbeat(pool, heartbeatId);
    expect(runs).toHaveLength(0);
    expect(runCalls).toHaveLength(0);
  });

  it("excludes a message that is in both Inbox and Junk", async () => {
    const heartbeatId = await getNewEmailHeartbeatId();
    const runCalls: string[] = [];
    const registry = agentRunRegistry(runCalls);

    await ingestInto(["inbox", "junk"], "<both1@example.com>");
    await drainQueue(registry);

    const runs = await listAgentRunsByHeartbeat(pool, heartbeatId);
    expect(runs).toHaveLength(0);
    expect(runCalls).toHaveLength(0);
  });

  it("ignores a soft-deleted Junk folder when evaluating the exclude set", async () => {
    const heartbeatId = await getNewEmailHeartbeatId();
    const runCalls: string[] = [];
    const registry = agentRunRegistry(runCalls);

    const foldersId = await databaseIdFor("folders");
    const { itemId: emailItemId } = await ingestInto(["inbox", "junk"], "<soft-deleted-junk1@example.com>");

    const { rows } = await pool.query<{ id: string }>(
      `SELECT related.id FROM item_relations r
       JOIN items related ON related.id = CASE WHEN r.item_a = $1 THEN r.item_b ELSE r.item_a END
       WHERE (r.item_a = $1 OR r.item_b = $1)
         AND related.database_id = $2 AND related.properties ->> 'specialPurpose' = 'junk'`,
      [emailItemId, foldersId],
    );
    if (!rows[0]) throw new Error(`No junk folder relation found for email item ${emailItemId}`);
    const junkFolderId = rows[0].id;
    await chokePoint.softDeleteItem(foldersId, junkFolderId);

    await drainQueue(registry);

    const runs = await listAgentRunsByHeartbeat(pool, heartbeatId);
    expect(runs).toHaveLength(1);
    expect(runCalls).toHaveLength(1);
  });

  it("does not emit a second event when an already-known message is reconciled", async () => {
    const heartbeatId = await getNewEmailHeartbeatId();
    const runCalls: string[] = [];
    const registry = agentRunRegistry(runCalls);

    const emailsId = await databaseIdFor("emails");
    const filesId = await databaseIdFor("files");
    const folderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "folder")!;
    const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;
    const foldersId = await databaseIdFor("folders");
    const inbox = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: foldersId, properties: { name: "inbox", behavior: "folder", specialPurpose: "inbox" } },
        { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
      ),
    );

    const input = {
      emailsDatabaseId: emailsId,
      filesDatabaseId: filesId,
      folderRelationPropertyId: folderProperty.id,
      attachmentsRelationPropertyId: attachmentsProperty.id,
      folderItemId: inbox.id,
      mailboxItemId: randomUUID(),
      messageId: "<resync1@example.com>",
      subject: "Hello",
      envelope: { from: { address: "alice@example.com", name: "Alice" }, to: [{ address: "bob@example.com" }] },
      bodyText: "hi",
      attachments: [],
      storage: noopStorage,
      storageKeyPrefix: "test",
    };

    await inTenantZero(() => withTransaction(pool, (client) => ingestEmailMessage(client, input)));
    // A second sync pass re-observing the same Message-ID (reconciliation) — converges onto
    // the same item, must not re-fire the newEmail event.
    await inTenantZero(() => withTransaction(pool, (client) => ingestEmailMessage(client, input)));
    await drainQueue(registry);

    const runs = await listAgentRunsByHeartbeat(pool, heartbeatId);
    expect(runs).toHaveLength(1);
    expect(runCalls).toHaveLength(1);
  });
});
