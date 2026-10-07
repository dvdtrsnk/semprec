import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import {
  getMailMessageMetaByItemId,
  getMailMessageMetaByProviderMessageId,
  isProviderMessageIdConflict,
  upsertMailMessageMeta,
} from "../mail/mailMessageMetaStore.js";
import { resolveThreadId } from "../mail/threading.js";

let pool: Pool;

interface Tenants {
  a: string;
  b: string;
}

/** Runs `fn` in a transaction on the owner role that is always rolled back. */
async function inRolledBackTransaction(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

async function scopeTo(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
}

/** Adds a second tenant beside the existing one and switches to the runtime role. */
async function twoTenantsAsRuntimeRole(client: PoolClient, options: { dropLegacyIndex: boolean }): Promise<Tenants> {
  const { rows: existing } = await client.query<{ id: string }>("SELECT id FROM tenants");
  const a = existing[0]?.id;
  if (!a) throw new Error("no existing tenant");
  await client.query("DROP INDEX IF EXISTS tenants_single_tenant_guard");
  if (options.dropLegacyIndex) await client.query("DROP INDEX mail_message_meta_provider_msg_uq");
  const { rows } = await client.query<{ id: string }>("INSERT INTO tenants (status) VALUES ('active') RETURNING id");
  const b = rows[0]?.id;
  if (!b) throw new Error("second tenant was not inserted");
  await client.query("SET LOCAL ROLE semprec_data");
  return { a, b };
}

function insertMessage(
  client: PoolClient,
  messageId: string,
  extra: {
    providerMessageId?: string;
    threadId?: string;
    inReplyTo?: string;
    references?: string[];
    mailboxItemId?: string;
  } = {},
) {
  return upsertMailMessageMeta(client, {
    itemId: randomUUID(),
    mailboxItemId: extra.mailboxItemId ?? randomUUID(),
    messageId,
    envelope: {},
    ...extra,
  });
}

async function threadIdOf(client: PoolClient, itemId: string): Promise<string | null> {
  return (await getMailMessageMetaByItemId(client, itemId))?.threadId ?? null;
}

async function threadExists(client: PoolClient, threadId: string): Promise<boolean> {
  const { rows } = await client.query("SELECT 1 FROM mail_threads WHERE id = $1", [threadId]);
  return rows.length > 0;
}

describe("mail identities stay within a tenant", () => {
  beforeAll(async () => {
    pool = getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe("isProviderMessageIdConflict", () => {
    it("recognizes a same-tenant provider-id conflict once the legacy index is dropped", async () => {
      await inRolledBackTransaction(async (client) => {
        await client.query("DROP INDEX mail_message_meta_provider_msg_uq");
        await insertMessage(client, "<p1@x>", { providerMessageId: "prov-1" });
        const error = await insertMessage(client, "<p2@x>", { providerMessageId: "prov-1" }).then(
          () => null,
          (err: unknown) => err,
        );
        expect(error).not.toBeNull();
        expect(isProviderMessageIdConflict(error)).toBe(true);
        expect((error as { constraint?: string }).constraint).toBe("mail_message_meta_tenant_provider_msg_uq");
      });
    });

    it("recognizes the legacy index while it still exists", async () => {
      await inRolledBackTransaction(async (client) => {
        await insertMessage(client, "<l1@x>", { providerMessageId: "prov-legacy" });
        const error = await insertMessage(client, "<l2@x>", { providerMessageId: "prov-legacy" }).then(
          () => null,
          (err: unknown) => err,
        );
        expect(isProviderMessageIdConflict(error)).toBe(true);
      });
    });

    it("does not recognize a violation of another unique index", async () => {
      await inRolledBackTransaction(async (client) => {
        await client.query("DROP INDEX mail_message_meta_provider_msg_uq");
        const row = await insertMessage(client, "<u1@x>");
        const error = await client
          .query(
            `INSERT INTO mail_message_meta (item_id, message_id, envelope, mailbox_item_id)
             VALUES ($1, $2, '{}'::jsonb, $3)`,
            [randomUUID(), "<u1@x>", row.mailboxItemId],
          )
          .then(
            () => null,
            (err: unknown) => err,
          );
        expect(error).toMatchObject({ code: "23505", constraint: "mail_message_meta_mailbox_message_uq" });
        expect(isProviderMessageIdConflict(error)).toBe(false);
      });
    });
  });

  it("stores the same provider message id in two tenants and looks each up in its own scope", async () => {
    await inRolledBackTransaction(async (client) => {
      const { a, b } = await twoTenantsAsRuntimeRole(client, { dropLegacyIndex: true });
      await scopeTo(client, a);
      const rowA = await insertMessage(client, "<pa@x>", { providerMessageId: "shared-prov" });
      await scopeTo(client, b);
      const rowB = await insertMessage(client, "<pb@x>", { providerMessageId: "shared-prov" });

      expect((await getMailMessageMetaByProviderMessageId(client, "shared-prov"))?.itemId).toBe(rowB.itemId);
      await scopeTo(client, a);
      expect((await getMailMessageMetaByProviderMessageId(client, "shared-prov"))?.itemId).toBe(rowA.itemId);
    });
  });

  it("does not join another tenant's thread through an ancestor Message-ID", async () => {
    await inRolledBackTransaction(async (client) => {
      const { a, b } = await twoTenantsAsRuntimeRole(client, { dropLegacyIndex: false });
      await scopeTo(client, a);
      const threadA = await resolveThreadId(client, { messageId: "<m1@x>" });
      const rowA = await insertMessage(client, "<m1@x>", { threadId: threadA });

      await scopeTo(client, b);
      const threadB = await resolveThreadId(client, { messageId: "<reply@x>", inReplyTo: "<m1@x>" });
      expect(threadB).not.toBe(threadA);

      await scopeTo(client, a);
      expect(await threadIdOf(client, rowA.itemId)).toBe(threadA);
    });
  });

  it("does not merge another tenant's thread through a descendant reference", async () => {
    await inRolledBackTransaction(async (client) => {
      const { a, b } = await twoTenantsAsRuntimeRole(client, { dropLegacyIndex: false });
      await scopeTo(client, a);
      const threadA = await resolveThreadId(client, { messageId: "<child@x>", references: ["<m2@x>"] });
      const rowA = await insertMessage(client, "<child@x>", { threadId: threadA, references: ["<m2@x>"] });

      await scopeTo(client, b);
      const threadB = await resolveThreadId(client, { messageId: "<m2@x>" });
      expect(threadB).not.toBe(threadA);

      await scopeTo(client, a);
      expect(await threadExists(client, threadA)).toBe(true);
      expect(await threadIdOf(client, rowA.itemId)).toBe(threadA);
    });
  });

  it("still merges two threads of one tenant bridged by a message and deletes the emptied thread", async () => {
    await inRolledBackTransaction(async (client) => {
      const { b } = await twoTenantsAsRuntimeRole(client, { dropLegacyIndex: false });
      await scopeTo(client, b);
      const thread1 = await resolveThreadId(client, { messageId: "<x1@x>" });
      const row1 = await insertMessage(client, "<x1@x>", { threadId: thread1 });
      const thread2 = await resolveThreadId(client, { messageId: "<x2@x>" });
      const row2 = await insertMessage(client, "<x2@x>", { threadId: thread2 });
      expect(thread2).not.toBe(thread1);

      const bridged = await resolveThreadId(client, { messageId: "<bridge@x>", references: ["<x1@x>", "<x2@x>"] });

      expect(bridged).toBe(thread1);
      expect(await threadIdOf(client, row1.itemId)).toBe(thread1);
      expect(await threadIdOf(client, row2.itemId)).toBe(thread1);
      expect(await threadExists(client, thread2)).toBe(false);
    });
  });
});
