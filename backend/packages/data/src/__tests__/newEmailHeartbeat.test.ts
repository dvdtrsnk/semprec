import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createHash } from "node:crypto";
import { runOnce } from "@semprec/queue";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, createItemWithClient, createRelationWithClient, type ChokePoint } from "../chokePoint/chokePoint.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { createActionRegistry, CORE_AGENT_RUN_ACTION_ID, coreAgentRunAction } from "../scheduler/actions.js";
import { createCoreTaskList } from "../worker.js";
import { listAgentRunsByHeartbeat } from "../agentRuns/agentRunsStore.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";

let pool: Pool;
let chokePoint: ChokePoint;

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

function agentRunRegistry(runCalls: string[]) {
  const registry = createActionRegistry();
  registry.set(
    CORE_AGENT_RUN_ACTION_ID,
    coreAgentRunAction(pool, async ({ task }) => {
      runCalls.push(task);
      return { result: "ok" };
    }),
  );
  return registry;
}

async function drainQueue(registry: ReturnType<typeof createActionRegistry>) {
  await runOnce({ pgPool: pool, taskList: createCoreTaskList(pool, registry) });
}

describe("newEmail heartbeat (issue #99)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function ingestInto(specialPurposes: string[], messageId: string) {
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

    const result = await withTransaction(pool, async (client) => {
      const ingestResult = await ingestEmailMessage(client, {
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        folderRelationPropertyId: folderProperty.id,
        attachmentsRelationPropertyId: attachmentsProperty.id,
        folderItemId: folders[0].id,
        messageId,
        subject: "Hello",
        envelope: { from: { address: "alice@example.com", name: "Alice" }, to: [{ address: "bob@example.com" }] },
        bodyText: "hi",
        attachments: [],
        storage: noopStorage,
        storageKeyPrefix: "test",
      });
      // A message with multiple folder memberships (e.g. Gmail labels) — link the rest too.
      for (const folder of folders.slice(1)) {
        await createRelationWithClient(client, { relationPropertyId: folderProperty.id, itemId: ingestResult.itemId, targetItemId: folder.id });
      }
      return ingestResult;
    });

    return result;
  }

  it("emits one core.agentRun for a new Inbox message", async () => {
    const heartbeatId = await getNewEmailHeartbeatId();
    const runCalls: string[] = [];
    const registry = agentRunRegistry(runCalls);

    await ingestInto(["inbox"], "<inbox1@example.com>");
    await drainQueue(registry);

    const runs = await listAgentRunsByHeartbeat(pool, heartbeatId);
    expect(runs).toHaveLength(1);
    expect(runCalls).toHaveLength(1);
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
      messageId: "<resync1@example.com>",
      subject: "Hello",
      envelope: { from: { address: "alice@example.com", name: "Alice" }, to: [{ address: "bob@example.com" }] },
      bodyText: "hi",
      attachments: [],
      storage: noopStorage,
      storageKeyPrefix: "test",
    };

    await withTransaction(pool, (client) => ingestEmailMessage(client, input));
    // A second sync pass re-observing the same Message-ID (reconciliation) — converges onto
    // the same item, must not re-fire the newEmail event.
    await withTransaction(pool, (client) => ingestEmailMessage(client, input));
    await drainQueue(registry);

    const runs = await listAgentRunsByHeartbeat(pool, heartbeatId);
    expect(runs).toHaveLength(1);
    expect(runCalls).toHaveLength(1);
  });
});
