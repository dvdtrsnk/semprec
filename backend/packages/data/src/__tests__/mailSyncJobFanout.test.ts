import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES } from "@semprec/queue";
import { runInTenant } from "@semprec/shared";
import { createUser } from "../auth/usersStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import { LocalFsBlobStorageWriter } from "../mail/blobStorage.js";
import type { ImapFetchedMessage, ImapMailClient } from "../mail/imapReconcile.js";
import { ensureMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { handleSyncMailAccountTask } from "../mail/mailSyncJob.js";
import { MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID } from "../mail/personLinkingKeys.js";
import { createActionRegistry, type ActionContext } from "../scheduler/actions.js";
import { ITEM_EVENT_BATCH_ACTION_IDS } from "../scheduler/itemEventBatchActions.js";
import { createHeartbeatFireCoreTask } from "../scheduler/sweep.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let storageRoot: string;

const MESSAGES = 10;

function inTenant<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenant, () => withTransaction(runtime, fn));
}

/** One INBOX holding `MESSAGES` messages of distinct senders, each its own thread. */
function inboxAccount(): ImapMailClient {
  const messages: ImapFetchedMessage[] = Array.from({ length: MESSAGES }, (_, index) => ({
    uid: index + 1,
    message: {
      messageId: `<fanout-${index}@example.test>`,
      subject: `Message ${index}`,
      envelope: { from: { name: `Sender ${index}`, address: `sender${index}@example.test` } },
      bodyText: "body",
      flags: [],
      attachments: [],
    },
  }));
  return {
    appendMessage: async () => {},
    getCapabilities: async () => new Set(),
    listFolders: async () => [{ path: "INBOX", specialUse: "\\Inbox" }],
    selectFolder: async () => ({ uidvalidity: 1, uidnext: MESSAGES + 1, highestModSeq: null, messages: 0 }),
    fetchMessagesSince: async (_path, sinceUid, limit) =>
      messages.filter((message) => message.uid >= sinceUid).slice(0, limit),
    fetchChangesSince: async () => ({ flags: [], vanished: [] }),
    fetchAllUids: async () => messages.map((message) => message.uid),
    fetchFlagsChangedSince: async () => [],
    setMessageFlag: async () => {},
    close: async () => {},
  };
}

const jobRow = z.object({ identifier: z.string(), key: z.string().nullable(), payload: z.unknown() });

async function queuedJobs(): Promise<Array<z.infer<typeof jobRow>>> {
  const { rows } = await admin.query<Record<string, unknown>>(
    `SELECT t.identifier, j.key, j.payload::jsonb -> 'payload' AS payload
       FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id
      ORDER BY t.identifier, j.key`,
  );
  return z.array(jobRow).parse(rows);
}

async function emailItemIds(): Promise<string[]> {
  return inTenant(async (client) => {
    const { emailsDatabaseId } = await resolveMailModuleIds(client);
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL ORDER BY id",
      [emailsDatabaseId],
    );
    return rows.map((row) => row.id);
  });
}

async function heartbeatsOfEmailCreate(): Promise<Array<{ id: string; action_id: string }>> {
  return inTenant(async (client) => {
    const { emailsDatabaseId } = await resolveMailModuleIds(client);
    const { rows } = await client.query<{ id: string; action_id: string }>(
      `SELECT id, action_id FROM project_heartbeats
        WHERE rule ->> 'kind' = 'onItemEvent' AND rule ->> 'databaseId' = $1 AND rule ->> 'event' = 'create'
        ORDER BY action_id`,
      [emailsDatabaseId],
    );
    return rows;
  });
}

describe("background jobs of a mail sync batch", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    storageRoot = await mkdtemp(join(tmpdir(), "mail-sync-fanout-"));
  });

  afterAll(async () => {
    await runtime.end();
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
    await runInTenant(tenant, () => seedSystem(runtime));
  });

  it("queues one fire per deterministic Email-create heartbeat for the whole batch and no no-op reindex or project rule job", async () => {
    const ids = await inTenant((client) => resolveMailModuleIds(client));
    const mailbox = await inTenant(async (client) => {
      const item = await createItemWithClient(client, {
        databaseId: ids.mailboxesDatabaseId,
        properties: { name: "Personal", provider: "generic" },
      });
      await ensureMailAccountSyncState(client, { itemId: item.id, syncMode: "imap" });
      await storeCredential(client, { itemId: item.id, credentialType: "app_password", plaintext: "secret" });
      return item.id;
    });
    await admin.query("DELETE FROM graphile_worker._private_jobs");

    await runInTenant(tenant, () =>
      handleSyncMailAccountTask(
        runtime,
        { mailboxItemId: mailbox },
        { createImapClient: async () => inboxAccount() },
        ids,
        new LocalFsBlobStorageWriter(storageRoot),
      ),
    );

    const emails = await emailItemIds();
    expect(emails).toHaveLength(MESSAGES);
    const heartbeats = await heartbeatsOfEmailCreate();
    const batched = heartbeats.filter((heartbeat) => ITEM_EVENT_BATCH_ACTION_IDS.has(heartbeat.action_id));
    expect(batched).toHaveLength(3);
    const jobs = await queuedJobs();

    const coreFires = jobs.filter((job) => job.identifier === CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE);
    expect(coreFires).toHaveLength(batched.length);
    for (const heartbeat of batched) {
      const fire = coreFires.find(
        (job) => z.object({ heartbeatId: z.string() }).passthrough().parse(job.payload).heartbeatId === heartbeat.id,
      );
      const payload = z
        .object({ heartbeatId: z.string(), itemIds: z.array(z.string()) })
        .strict()
        .parse(fire?.payload);
      expect([...payload.itemIds].sort()).toEqual(emails);
    }
    // The agent heartbeat keeps one fire per Email.
    expect(jobs.filter((job) => job.identifier === "heartbeatFireAgent")).toHaveLength(MESSAGES);

    const reindexed = jobs
      .filter((job) => job.identifier === CORE_TASK_NAMES.ITEM_SEARCH_REINDEX_DEPENDENTS)
      .map((job) => z.object({ kind: z.string(), itemId: z.string() }).passthrough().parse(job.payload).itemId);
    expect(reindexed.filter((itemId) => emails.includes(itemId))).toEqual([]);

    const propagated = jobs
      .filter((job) => job.identifier === CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE)
      .map((job) => z.object({ ruleKey: z.string() }).passthrough().parse(job.payload).ruleKey);
    expect(propagated.filter((ruleKey) => ruleKey === "threadCompanyFromSender")).toHaveLength(MESSAGES);
    expect(propagated.filter((ruleKey) => ruleKey === "threadProjectFromCompany")).toEqual([]);
  });

  it("runs a batched fire's handler for every item, and fails after all of them ran when one failed", async () => {
    const [heartbeat] = (await heartbeatsOfEmailCreate()).filter(
      (row) => row.action_id === MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID,
    );
    if (!heartbeat) throw new Error("the Link Emails to People heartbeat is not seeded");
    const itemIds = [randomUUID(), randomUUID(), randomUUID()];
    const handled: Array<string | undefined> = [];
    let failing: string | null = itemIds[1] ?? null;
    const registry = createActionRegistry();
    registry.set(MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID, async (_config, context: ActionContext) => {
      handled.push(context.itemId);
      if (context.itemId === failing) throw new Error("this item failed");
    });
    const fire = createHeartbeatFireCoreTask(runtime, registry);
    // Synthetic Graphile helpers provide the attempt metadata read by the fire task.
    const helpers = { job: { id: randomUUID(), attempts: 1, max_attempts: 3 } } as Parameters<typeof fire>[1];

    await expect(runInTenant(tenant, () => fire({ heartbeatId: heartbeat.id, itemIds }, helpers))).rejects.toThrow(
      "this item failed",
    );
    expect(handled).toEqual(itemIds);

    handled.length = 0;
    failing = null;
    await runInTenant(tenant, () => fire({ heartbeatId: heartbeat.id, itemIds }, helpers));
    expect(handled).toEqual(itemIds);
  });
});
