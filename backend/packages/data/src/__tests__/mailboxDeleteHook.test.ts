import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { computeDestructiveResourceProjection } from "../chokePoint/destructiveProjection.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import { ForbiddenError, NotFoundError } from "../errors.js";
import { ensureFolderItem } from "../mail/folderDiscovery.js";
import { ensureMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { upsertMailServerSettings } from "../mail/mailServerSettingsStore.js";
import { createMailboxRemovalRouteHandler } from "../mail/mailboxRemoval.js";
import { mailboxRemovalJobKey } from "../mail/mailboxRemovalJob.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { seedSystem } from "../seed/seedSystem.js";
import { provisionTenant } from "../tenancy/provisionTenant.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

/** A connected mailbox and one of its Folders. */
interface TestMailbox {
  id: string;
  folder: string;
}

/** The mailbox's item and the rows a removal deletes, as stored. */
interface MailboxSnapshot {
  item: Array<{ properties: unknown; updatedAt: string; deletedAt: string | null }>;
  credential: Array<{ ciphertext: string; nonce: string }>;
  syncState: Array<{ syncMode: string }>;
  serverSettings: Array<{ username: string }>;
}

let admin: Pool;
let runtime: Pool;
let chokePoint: ChokePoint;
let tenant: string;
let userId: string;
let mailboxesDatabaseId: string;
let foldersDatabaseId: string;

/** Runs `fn` in one transaction of `tenantId`, on the runtime role row-level security applies to. */
function inTenant<T>(fn: (client: PoolClient) => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(runtime, fn));
}

/** A mailbox with a credential, a sync state row and server settings, and one Folders item linked to it. */
function createConnectedMailbox(tenantId = tenant): Promise<TestMailbox> {
  return inTenant(async (client) => {
    const mail = await resolveMailModuleIds(client);
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = 'mailbox'",
      [mail.foldersDatabaseId],
    );
    const mailboxRelationPropertyId = rows[0]?.id;
    if (!mailboxRelationPropertyId) throw new Error("Folders.mailbox is not seeded");
    const mailbox = await createItemWithClient(client, {
      databaseId: mail.mailboxesDatabaseId,
      properties: { name: `Mailbox ${randomUUID()}`, provider: "generic" },
    });
    await storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: randomUUID() });
    await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" });
    await upsertMailServerSettings(client, mailbox.id, {
      imap: { host: "imap.example.test", port: 993, security: "tls" },
      smtp: null,
      username: "user@example.test",
    });
    const folder = await ensureFolderItem(client, {
      foldersDatabaseId: mail.foldersDatabaseId,
      mailboxItemId: mailbox.id,
      mailboxRelationPropertyId,
      providerId: "inbox",
      name: "inbox",
      behavior: "folder",
      specialPurpose: "inbox",
    });
    return { id: mailbox.id, folder };
  }, tenantId);
}

/** Reads the mailbox's rows in `tenantId`'s scope. */
function snapshot(mailboxItemId: string, tenantId = tenant): Promise<MailboxSnapshot> {
  return inTenant(async (client) => {
    const item = await client.query<{ properties: unknown; updatedAt: string; deletedAt: string | null }>(
      `SELECT properties, updated_at::text AS "updatedAt", deleted_at::text AS "deletedAt" FROM items WHERE id = $1`,
      [mailboxItemId],
    );
    const credential = await client.query<{ ciphertext: string; nonce: string }>(
      "SELECT encode(ciphertext, 'hex') AS ciphertext, encode(nonce, 'hex') AS nonce FROM external_credentials WHERE item_id = $1",
      [mailboxItemId],
    );
    const syncState = await client.query<{ syncMode: string }>(
      `SELECT sync_mode AS "syncMode" FROM mail_account_sync_state WHERE item_id = $1`,
      [mailboxItemId],
    );
    const serverSettings = await client.query<{ username: string }>(
      "SELECT username FROM mail_account_server_settings WHERE mailbox_item_id = $1",
      [mailboxItemId],
    );
    return {
      item: item.rows,
      credential: credential.rows,
      syncState: syncState.rows,
      serverSettings: serverSettings.rows,
    };
  }, tenantId);
}

/** The jobs queued under the mailbox's removal key, from Graphile Worker's public `jobs` view. */
async function removalJobs(mailboxItemId: string): Promise<string[]> {
  const { rows } = await admin.query<{ task_identifier: string }>(
    "SELECT task_identifier FROM graphile_worker.jobs WHERE key = $1",
    [mailboxRemovalJobKey(mailboxItemId)],
  );
  return rows.map((row) => row.task_identifier);
}

/** `DELETE /api/items/:id` as the generic service makes it: the choke point's trash, with the caller's writer. */
function genericDelete(databaseId: string, itemId: string, writer: WriterIdentity, tenantId = tenant) {
  return runInTenant(tenantId, () => chokePoint.softDeleteItem(databaseId, itemId, userId, writer));
}

/**
 * The approval projection of an agent run's `item.delete`, as the approval preflight and the executor
 * of an approved request compute it, in `tenantId`'s scope.
 */
function deleteProjection(itemId: string, tenantId = tenant) {
  return inTenant(
    (client) => computeDestructiveResourceProjection(client, { operation: "item.delete", input: { itemId } }),
    tenantId,
  );
}

/** The rejection of `promise`, failing when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

/** The item invalidations emitted while `run` runs, for `itemId`. */
async function invalidationsOf(itemId: string, run: () => Promise<unknown>): Promise<string[]> {
  const events: InvalidationEvent[] = [];
  setInvalidationHook((event) => events.push(event));
  try {
    await run();
  } finally {
    setInvalidationHook(() => {});
  }
  return events
    .filter((event) => event.scope === "item" && event.itemId === itemId)
    .map((event) => ("op" in event ? event.op : "unknown"));
}

describe("the Mailboxes item delete hook (gh-2031)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    chokePoint = createChokePoint(runtime);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    await seedSystem(admin);
    tenant = getTenantZeroId();
    userId = randomUUID();
    const mail = await inTenant((client) => resolveMailModuleIds(client));
    mailboxesDatabaseId = mail.mailboxesDatabaseId;
    foldersDatabaseId = mail.foldersDatabaseId;
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  const refusedWriters: Array<[string, () => WriterIdentity]> = [
    ["a user", () => ({ writerKind: "user" })],
    ["an agent without a run, as an MCP client writes", () => ({ writerKind: "agent", onBehalfOfUserId: userId })],
    [
      "an agent run, as the approved executor writes",
      () => ({
        writerKind: "agent",
        agentRunId: randomUUID(),
        agentProjectItemId: randomUUID(),
        onBehalfOfUserId: userId,
      }),
    ],
  ];

  it.each(refusedWriters)(
    "refuses the generic delete of a mailbox by %s with a 403 and changes nothing",
    async (_name, writer) => {
      const mailbox = await createConnectedMailbox();
      const before = await snapshot(mailbox.id);
      expect(before).toMatchObject({
        item: [{ deletedAt: null }],
        credential: [{}],
        syncState: [{ syncMode: "imap" }],
        serverSettings: [{ username: "user@example.test" }],
      });

      let error: unknown;
      const invalidations = await invalidationsOf(mailbox.id, async () => {
        error = await rejection(genericDelete(mailboxesDatabaseId, mailbox.id, writer()));
      });

      expect(error).toBeInstanceOf(ForbiddenError);
      expect(error).toMatchObject({ status: 403, code: "forbidden" });
      expect(await snapshot(mailbox.id)).toEqual(before);
      expect(await removalJobs(mailbox.id)).toEqual([]);
      expect(invalidations).toEqual([]);
    },
  );

  it("refuses the approval projection of an agent run's delete of a mailbox with the same 403, which names the mailbox as it is, and changes nothing", async () => {
    const mailbox = await createConnectedMailbox();
    const before = await snapshot(mailbox.id);
    const stored = await runInTenant(tenant, () => chokePoint.findItemIncludingDeleted(mailbox.id));
    const hookRefusal = await rejection(
      genericDelete(mailboxesDatabaseId, mailbox.id, { writerKind: "agent", onBehalfOfUserId: userId }),
    );
    if (!(hookRefusal instanceof ForbiddenError)) throw new Error("expected the hook's refusal");

    const refused = await rejection(deleteProjection(mailbox.id));

    expect(refused).toBeInstanceOf(ForbiddenError);
    expect(refused).toMatchObject({
      status: 403,
      code: "forbidden",
      message: hookRefusal.message,
      details: {
        currentResource: {
          id: mailbox.id,
          databaseId: mailboxesDatabaseId,
          updatedAt: stored?.updatedAt,
          deletedAt: null,
          databaseArchivedAt: null,
        },
      },
    });
    expect(stored?.updatedAt).toEqual(expect.any(String));
    expect(await snapshot(mailbox.id)).toEqual(before);
  });

  it("projects an agent run's delete of an item of another database, a Folders item of the mailbox included", async () => {
    const mailbox = await createConnectedMailbox();
    const database = await runInTenant(tenant, () => chokePoint.createDatabase({ name: "Notes" }));
    const note = await runInTenant(tenant, () => chokePoint.createItem({ databaseId: database.id, properties: {} }));

    const noteProjection = await deleteProjection(note.id);
    const folderProjection = await deleteProjection(mailbox.folder);

    expect(noteProjection.snapshot).toMatchObject({ kind: "item_delete", resourceId: note.id });
    expect(folderProjection.snapshot).toMatchObject({ kind: "item_delete", resourceId: mailbox.folder });
  });

  it("projects an agent run's delete of an item whose database carries the mailboxes module id without being a system database", async () => {
    const lookalikeItem = await runInTenant(tenant, async () => {
      const notes = await chokePoint.createDatabase({ name: "Notes" });
      const host = await chokePoint.createItem({ databaseId: notes.id, properties: {} });
      const lookalike = await chokePoint.createInlineDatabase({
        name: "Lookalike",
        parentItemId: host.id,
        ownerModuleId: MAILBOXES_MODULE_ID,
      });
      return chokePoint.createItem({ databaseId: lookalike.id, properties: {} });
    });

    const projection = await deleteProjection(lookalikeItem.id);

    expect(projection.snapshot).toMatchObject({ kind: "item_delete", resourceId: lookalikeItem.id });
  });

  it("answers the approval projection of a removed mailbox, and of another tenant's mailbox, as not found and not as a refusal", async () => {
    const other = await createTestTenant(admin);
    await provisionTenant(runtime, other);
    const removed = await createConnectedMailbox();
    const foreign = await createConnectedMailbox();
    const handler = createMailboxRemovalRouteHandler(runtime, {});
    await runInTenant(tenant, () => handler({ params: { id: removed.id }, identity: { user: { id: userId } } }));

    const removedAnswer = await rejection(deleteProjection(removed.id));
    const foreignAnswer = await rejection(deleteProjection(foreign.id, other));

    expect(removedAnswer).toBeInstanceOf(NotFoundError);
    expect(foreignAnswer).toBeInstanceOf(NotFoundError);
    // The owning tenant's projection of the live mailbox is the refusal, so the answer above hid it.
    expect(await rejection(deleteProjection(foreign.id))).toBeInstanceOf(ForbiddenError);
  });

  it("lets DELETE /api/mail/mailboxes/:id remove the mailbox, which trashes it as the system writer", async () => {
    const mailbox = await createConnectedMailbox();
    // The empty custom-route container: this test is about the removal's trash, not its cleanup (issue gh-2030).
    const handler = createMailboxRemovalRouteHandler(runtime, {});

    let answer: unknown;
    const invalidations = await invalidationsOf(mailbox.id, async () => {
      answer = await runInTenant(tenant, () =>
        handler({ params: { id: mailbox.id }, identity: { user: { id: userId } } }),
      );
    });

    expect(answer).toEqual({ status: 200, body: { id: mailbox.id } });
    // The removal's `syncStatus` write and its trash, which the refused deletes above do not send.
    expect(invalidations).toEqual(["update", "delete"]);
    const after = await snapshot(mailbox.id);
    expect(after.item).toHaveLength(1);
    expect(after.item[0]?.deletedAt).not.toBeNull();
    expect(after).toMatchObject({ credential: [], syncState: [], serverSettings: [] });
    expect(await removalJobs(mailbox.id)).toHaveLength(1);
  });

  it("answers a user's delete of a mailbox that is already in the trash with the trashed item, without a refusal, and changes nothing", async () => {
    const mailbox = await createConnectedMailbox();
    const handler = createMailboxRemovalRouteHandler(runtime, {});
    await runInTenant(tenant, () => handler({ params: { id: mailbox.id }, identity: { user: { id: userId } } }));
    const removed = await snapshot(mailbox.id);
    expect(removed.item[0]?.deletedAt).not.toBeNull();

    let repeated: unknown;
    const invalidations = await invalidationsOf(mailbox.id, async () => {
      repeated = await genericDelete(mailboxesDatabaseId, mailbox.id, { writerKind: "user" });
    });

    expect(repeated).toMatchObject({ id: mailbox.id, deletedAt: expect.any(String) });
    expect(await snapshot(mailbox.id)).toEqual(removed);
    expect(invalidations).toEqual([]);
  });

  it("leaves the generic delete of an item of another database to a user and to an agent, a Folders item of the mailbox included", async () => {
    const mailbox = await createConnectedMailbox();
    const before = await snapshot(mailbox.id);
    const database = await runInTenant(tenant, () => chokePoint.createDatabase({ name: "Notes" }));
    const note = await runInTenant(tenant, () => chokePoint.createItem({ databaseId: database.id, properties: {} }));
    const otherNote = await runInTenant(tenant, () =>
      chokePoint.createItem({ databaseId: database.id, properties: {} }),
    );

    const trashedNote = await genericDelete(database.id, note.id, { writerKind: "user" });
    const trashedOtherNote = await genericDelete(database.id, otherNote.id, {
      writerKind: "agent",
      onBehalfOfUserId: userId,
    });
    const trashedFolder = await genericDelete(foldersDatabaseId, mailbox.folder, { writerKind: "user" });

    expect(trashedNote).toMatchObject({ id: note.id, deletedAt: expect.any(String) });
    expect(trashedOtherNote).toMatchObject({ id: otherNote.id, deletedAt: expect.any(String) });
    expect(trashedFolder).toMatchObject({ id: mailbox.folder, deletedAt: expect.any(String) });
    expect(await snapshot(mailbox.id)).toEqual(before);
  });

  it("leaves a user's delete of an item alone when its database carries the mailboxes module id without being a system database", async () => {
    const lookalikeItem = await runInTenant(tenant, async () => {
      const notes = await chokePoint.createDatabase({ name: "Notes" });
      const host = await chokePoint.createItem({ databaseId: notes.id, properties: {} });
      const lookalike = await chokePoint.createInlineDatabase({
        name: "Lookalike",
        parentItemId: host.id,
        ownerModuleId: MAILBOXES_MODULE_ID,
      });
      expect(lookalike).toMatchObject({ system: false, ownerModuleId: MAILBOXES_MODULE_ID });
      return chokePoint.createItem({ databaseId: lookalike.id, properties: {} });
    });

    const trashed = await genericDelete(lookalikeItem.databaseId, lookalikeItem.id, { writerKind: "user" });

    expect(trashed).toMatchObject({ id: lookalikeItem.id, deletedAt: expect.any(String) });
  });

  it("answers another tenant's delete of the mailbox like the delete of an unknown id, without a refusal", async () => {
    const other = await createTestTenant(admin);
    await provisionTenant(runtime, other);
    const mailbox = await createConnectedMailbox();
    const before = await snapshot(mailbox.id);

    // What `DELETE /api/items/:id` does first: it looks the item up in the caller's tenant.
    const foreignLookup = await runInTenant(other, () => chokePoint.findItemIncludingDeleted(mailbox.id));
    const unknownLookup = await runInTenant(other, () => chokePoint.findItemIncludingDeleted(randomUUID()));
    // The trash itself, named with the owning tenant's database id and mailbox id.
    const foreign = await rejection(genericDelete(mailboxesDatabaseId, mailbox.id, { writerKind: "user" }, other));
    const unknown = await rejection(genericDelete(randomUUID(), randomUUID(), { writerKind: "user" }, other));

    expect(foreignLookup).toBeNull();
    expect(unknownLookup).toBeNull();
    expect(foreign).toBeInstanceOf(NotFoundError);
    expect(unknown).toBeInstanceOf(NotFoundError);
    expect(foreign).toMatchObject({ status: 404, code: "not_found" });
    expect(unknown).toMatchObject({ status: 404, code: "not_found" });
    expect(await snapshot(mailbox.id)).toEqual(before);
    expect(await snapshot(mailbox.id, other)).toEqual({ item: [], credential: [], syncState: [], serverSettings: [] });

    // The owning tenant's user is refused, so the other tenant's answer was not a refusal in disguise.
    const refused = await rejection(genericDelete(mailboxesDatabaseId, mailbox.id, { writerKind: "user" }));
    expect(refused).toBeInstanceOf(ForbiddenError);
  });
});
