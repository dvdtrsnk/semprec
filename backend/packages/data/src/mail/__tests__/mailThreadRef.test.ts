// Issue gh-1933: the `mailThread` Semp message ref. Every fixture row goes through the writers production uses
// (folder discovery, the ingest writer, the choke point's soft delete); every read runs on the runtime role, inside
// the scope of one of two tenants.
import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant, type SempMessageRef } from "@semprec/shared";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { listSempThreadMessages, sendSempMessage } from "../../sempThreads/sempThreadsStore.js";
import { validateSempMessageRefs } from "../../semp/sempMessageRefs.js";
import { readSempRefContext } from "../../semp/sempRefReadContext.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { LocalFsBlobStorageWriter } from "../blobStorage.js";
import { ensureFolderItem } from "../folderDiscovery.js";
import { ingestEmailMessage } from "../ingest.js";
import { resolveMailModuleIds, type MailModuleIds } from "../mailModuleIds.js";
import { resolveMailThreadRefIds, resolveMailThreadRefTargets } from "../mailThreadRef.js";

let admin: Pool;
let runtime: Pool;
let storageRoot: string;
let storage: LocalFsBlobStorageWriter;
let tenant: string;
let foreign: string;

/** Runs `fn` in one transaction of `tenantId`, on the runtime role row-level security applies to. */
function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(runtime, fn));
}

interface SeededIds extends MailModuleIds {
  emailFolderProperty: string;
  emailAttachmentsProperty: string;
  folderMailboxProperty: string;
}

async function seededIds(tenantId: string): Promise<SeededIds> {
  return inTenant(tenantId, async (client) => {
    const mail = await resolveMailModuleIds(client);
    const propertyId = async (databaseId: string, key: string): Promise<string> => {
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM properties WHERE database_id = $1 AND key = $2",
        [databaseId, key],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error(`property '${key}' is not seeded`);
      return id;
    };
    return {
      ...mail,
      emailFolderProperty: await propertyId(mail.emailsDatabaseId, "folder"),
      emailAttachmentsProperty: await propertyId(mail.emailsDatabaseId, "attachments"),
      folderMailboxProperty: await propertyId(mail.foldersDatabaseId, "mailbox"),
    };
  });
}

/** One tenant's mail fixture. */
async function mailFixture(tenantId: string) {
  const ids = await seededIds(tenantId);
  const mailboxId = await inTenant(
    tenantId,
    async (client) =>
      (
        await createItemWithClient(client, {
          databaseId: ids.mailboxesDatabaseId,
          properties: { name: "Personal", provider: "generic" },
        })
      ).id,
  );

  const folder = (specialPurpose: string): Promise<string> =>
    inTenant(tenantId, (client) =>
      ensureFolderItem(client, {
        foldersDatabaseId: ids.foldersDatabaseId,
        mailboxItemId: mailboxId,
        mailboxRelationPropertyId: ids.folderMailboxProperty,
        providerId: specialPurpose,
        name: specialPurpose,
        behavior: "folder",
        specialPurpose,
      }),
    );

  /** One message through the ingest writer; `references` joins it to an earlier message's thread. */
  const message = (input: {
    folderId: string;
    messageId: string;
    subject: string;
    date: string;
    references?: string[];
  }): Promise<{ itemId: string; threadId: string }> =>
    inTenant(tenantId, async (client) => {
      const references = input.references ?? [];
      const { itemId } = await ingestEmailMessage(client, {
        emailsDatabaseId: ids.emailsDatabaseId,
        filesDatabaseId: ids.filesDatabaseId,
        folderRelationPropertyId: ids.emailFolderProperty,
        attachmentsRelationPropertyId: ids.emailAttachmentsProperty,
        folderItemId: input.folderId,
        mailboxItemId: mailboxId,
        messageId: input.messageId,
        inReplyTo: references.at(-1) ?? null,
        references,
        subject: input.subject,
        date: new Date(input.date),
        envelope: {
          from: { name: "Sender", address: "sender@example.test" },
          to: [{ name: "Me", address: "me@example.test" }],
        },
        bodyText: "body",
        attachments: [],
        storage,
        storageKeyPrefix: "mail-thread-ref",
      });
      const { rows } = await client.query<{ thread_id: string | null }>(
        "SELECT thread_id FROM mail_message_meta WHERE tenant_id = app_tenant_default() AND item_id = $1",
        [itemId],
      );
      const threadId = rows[0]?.thread_id;
      if (!threadId) throw new Error(`message ${input.messageId} has no thread`);
      return { itemId, threadId };
    });

  /** Soft-deletes one Emails item through the choke point and fails if nothing was deleted. */
  const softDeleteEmail = async (itemId: string): Promise<void> => {
    const deleted = await runInTenant(tenantId, () =>
      createChokePoint(runtime).softDeleteItem(ids.emailsDatabaseId, itemId),
    );
    if (deleted === null) throw new Error(`item ${itemId} was not soft-deleted`);
  };

  /** Soft-deletes one folder item through the choke point and fails if nothing was deleted. */
  const softDeleteFolder = async (folderId: string): Promise<void> => {
    const deleted = await runInTenant(tenantId, () =>
      createChokePoint(runtime).softDeleteItem(ids.foldersDatabaseId, folderId),
    );
    if (deleted === null) throw new Error(`folder ${folderId} was not soft-deleted`);
  };

  /** The id of the Threads item `mail_threads` binds `threadId` to: not a thread id. */
  const threadItemId = (threadId: string): Promise<string> =>
    inTenant(tenantId, async (client) => {
      const { rows } = await client.query<{ item_id: string | null }>(
        "SELECT item_id FROM mail_threads WHERE tenant_id = app_tenant_default() AND id = $1",
        [threadId],
      );
      const id = rows[0]?.item_id;
      if (!id) throw new Error(`thread ${threadId} has no Threads item`);
      return id;
    });

  /** The subject hint of `mail_threads` for `threadId`, which a thread without a live message is labelled with. */
  const subjectHint = (threadId: string): Promise<string | null> =>
    inTenant(tenantId, async (client) => {
      const { rows } = await client.query<{ subject_hint: string | null }>(
        "SELECT subject_hint FROM mail_threads WHERE tenant_id = app_tenant_default() AND id = $1",
        [threadId],
      );
      if (!rows[0]) throw new Error(`thread ${threadId} is missing`);
      return rows[0].subject_hint;
    });

  return { folder, message, softDeleteEmail, softDeleteFolder, threadItemId, subjectHint };
}

type Fixture = Awaited<ReturnType<typeof mailFixture>>;

const msgId = (name: string): string => `<${name}@example.test>`;

/**
 * Two threads of `fixture` made one by the threading of the ingest writer: `<name>-reply` arrives before the
 * `<name>-bridge` it answers and starts `merged`; `<name>-root` starts `survivor`; the bridge then joins the root, so
 * `survivor` absorbs `merged`, whose id is left only as an alias.
 */
async function mergedThreads(
  tenantId: string,
  fixture: Fixture,
  folderId: string,
  name: string,
): Promise<{ survivor: string; merged: string }> {
  const survivor = (
    await fixture.message({
      folderId,
      messageId: msgId(`${name}-root`),
      subject: `${name} root`,
      date: "2026-11-01T10:00:00Z",
    })
  ).threadId;
  const merged = (
    await fixture.message({
      folderId,
      messageId: msgId(`${name}-reply`),
      subject: `${name} reply`,
      date: "2026-11-03T10:00:00Z",
      references: [msgId(`${name}-bridge`)],
    })
  ).threadId;
  expect(merged).not.toBe(survivor);
  const bridge = await fixture.message({
    folderId,
    messageId: msgId(`${name}-bridge`),
    subject: `${name} bridge`,
    date: "2026-11-02T10:00:00Z",
    references: [msgId(`${name}-root`)],
  });
  expect(bridge.threadId).toBe(survivor);
  const target = await inTenant(tenantId, async (client) => {
    const { rows } = await client.query<{ to_thread_id: string }>(
      "SELECT to_thread_id FROM mail_thread_aliases WHERE tenant_id = app_tenant_default() AND from_thread_id = $1",
      [merged],
    );
    return rows[0]?.to_thread_id ?? null;
  });
  expect(target).toBe(survivor);
  return { survivor, merged };
}

/** The statements `work` runs on its client whose text contains `fragment`. */
async function countStatements<T>(
  client: PoolClient,
  fragment: string,
  work: () => Promise<T>,
): Promise<{ result: T; count: number }> {
  let count = 0;
  const original = Object.getOwnPropertyDescriptor(client, "query");
  /* eslint-disable @typescript-eslint/unbound-method */
  client.query = new Proxy(client.query, {
    apply(target, receiver, args: unknown[]) {
      if (typeof args[0] === "string" && args[0].includes(fragment)) count += 1;
      return Reflect.apply(target, receiver, args);
    },
  });
  /* eslint-enable @typescript-eslint/unbound-method */
  try {
    return { result: await work(), count };
  } finally {
    if (original) Object.defineProperty(client, "query", original);
    else Reflect.deleteProperty(client, "query");
  }
}

beforeAll(async () => {
  admin = getTestPool();
  runtime = await createRuntimeRolePool(admin, "semprec_data");
  const role = await runAsSystem("verify mail thread ref test role", () =>
    runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    ),
  );
  expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  storageRoot = await mkdtemp(join(tmpdir(), "semprec-mail-thread-ref-"));
  storage = new LocalFsBlobStorageWriter(storageRoot);
});

beforeEach(async () => {
  await resetDatabase(admin);
  tenant = await createTestTenant(admin);
  foreign = await createTestTenant(admin);
  for (const id of [tenant, foreign]) await runInTenant(id, () => seedSystem(runtime));
});

afterAll(async () => {
  await runtime?.end();
  await admin?.end();
  await rm(storageRoot, { recursive: true, force: true });
});

const threadRef = (threadId: string): SempMessageRef => ({ kind: "mailThread", threadId });

/** The merged thread and the Threads item of a thread seen by tenant `tenantId`, with a foreign tenant's thread. */
async function threadsOfTwoTenants() {
  const fixture = await mailFixture(tenant);
  const foreignFixture = await mailFixture(foreign);
  const inbox = await fixture.folder("inbox");
  const own = (
    await fixture.message({
      folderId: inbox,
      messageId: msgId("own"),
      subject: "Own thread",
      date: "2026-11-01T10:00:00Z",
    })
  ).threadId;
  const foreignThread = (
    await foreignFixture.message({
      folderId: await foreignFixture.folder("inbox"),
      messageId: msgId("foreign"),
      subject: "Foreign thread",
      date: "2026-11-01T10:00:00Z",
    })
  ).threadId;
  return { fixture, foreignFixture, inbox, own, foreignThread, ownItem: await fixture.threadItemId(own) };
}

describe("resolveMailThreadRefIds (issue gh-1933)", () => {
  it("answers a live thread as itself and a merged-away id as the thread that absorbed it, in the order asked", async () => {
    const fixture = await mailFixture(tenant);
    const inbox = await fixture.folder("inbox");
    const { survivor, merged } = await mergedThreads(tenant, fixture, inbox, "ids");
    const other = (
      await fixture.message({
        folderId: inbox,
        messageId: msgId("ids-other"),
        subject: "Other",
        date: "2026-11-04T10:00:00Z",
      })
    ).threadId;

    const answered = await inTenant(tenant, (client) =>
      countStatements(client, "mail_thread_aliases", () =>
        resolveMailThreadRefIds(client, [other, merged, survivor, merged]),
      ),
    );

    expect(answered.result).toEqual([other, survivor, survivor, survivor]);
    expect(answered.count).toBe(1);
  });

  it("answers null for an unknown id, for the id of a Threads item and for another tenant's thread", async () => {
    const { own, ownItem, foreignThread } = await threadsOfTwoTenants();

    const answered = await inTenant(tenant, (client) =>
      resolveMailThreadRefIds(client, [randomUUID(), ownItem, foreignThread, own]),
    );

    expect(answered).toEqual([null, null, null, own]);
  });

  it("answers another tenant's merged-away id as null for this tenant and as the survivor for its own", async () => {
    const foreignFixture = await mailFixture(foreign);
    const { survivor, merged } = await mergedThreads(
      foreign,
      foreignFixture,
      await foreignFixture.folder("inbox"),
      "alias",
    );

    expect(await inTenant(tenant, (client) => resolveMailThreadRefIds(client, [merged]))).toEqual([null]);
    expect(await inTenant(foreign, (client) => resolveMailThreadRefIds(client, [merged]))).toEqual([survivor]);
  });
});

describe("validateSempMessageRefs for a mailThread ref (issue gh-1933)", () => {
  it("accepts a ref to an existing thread, and a ref to a merged-away thread as given", async () => {
    const fixture = await mailFixture(tenant);
    const inbox = await fixture.folder("inbox");
    const { survivor, merged } = await mergedThreads(tenant, fixture, inbox, "accept");

    const accepted = await inTenant(tenant, (client) =>
      validateSempMessageRefs(client, [threadRef(survivor), threadRef(merged)]),
    );

    // The merged-away id is stored as given; it is not rewritten to the survivor and is not merged into its ref.
    expect(accepted).toEqual([threadRef(survivor), threadRef(merged)]);
  });

  it("keeps the first of two refs to the same thread id", async () => {
    const { own } = await threadsOfTwoTenants();

    const accepted = await inTenant(tenant, (client) =>
      validateSempMessageRefs(client, [threadRef(own), threadRef(own)]),
    );

    expect(accepted).toEqual([threadRef(own)]);
  });

  it("refuses an unknown thread id by its own index, and accepts nothing of the same list", async () => {
    const { own } = await threadsOfTwoTenants();

    await expect(
      inTenant(tenant, (client) => validateSempMessageRefs(client, [threadRef(own), threadRef(randomUUID())])),
    ).rejects.toMatchObject({ code: "validation_failed", details: { field: "context[1]" } });
  });

  it("refuses another tenant's thread, as it refuses a random id", async () => {
    const { foreignThread } = await threadsOfTwoTenants();

    await expect(
      inTenant(tenant, (client) => validateSempMessageRefs(client, [threadRef(foreignThread)])),
    ).rejects.toMatchObject({ code: "validation_failed", details: { field: "context[0]" } });
    // The same ref is valid inside the tenant that owns the thread, so the refusal above is the isolation.
    await expect(
      inTenant(foreign, (client) => validateSempMessageRefs(client, [threadRef(foreignThread)])),
    ).resolves.toEqual([threadRef(foreignThread)]);
  });

  it("refuses the id of a thread's Threads item as a thread id", async () => {
    const { ownItem } = await threadsOfTwoTenants();

    await expect(
      inTenant(tenant, (client) => validateSempMessageRefs(client, [threadRef(ownItem)])),
    ).rejects.toMatchObject({ code: "validation_failed", details: { field: "context[0]" } });
  });

  it("checks every thread ref of a message in one statement", async () => {
    const { own } = await threadsOfTwoTenants();

    const checked = await inTenant(tenant, (client) =>
      countStatements(client, "mail_thread_aliases", () =>
        validateSempMessageRefs(client, [threadRef(own), threadRef(randomUUID())]).catch((error: unknown) => error),
      ),
    );

    expect(checked.count).toBe(1);
    expect(checked.result).toMatchObject({ code: "validation_failed", details: { field: "context[1]" } });
  });
});

describe("resolveMailThreadRefTargets (issue gh-1933)", () => {
  it("labels a thread with the subject of its latest message and names it as the current thread", async () => {
    const fixture = await mailFixture(tenant);
    const inbox = await fixture.folder("inbox");
    const first = await fixture.message({
      folderId: inbox,
      messageId: msgId("label-first"),
      subject: "Original subject",
      date: "2026-11-01T10:00:00Z",
    });
    await fixture.message({
      folderId: inbox,
      messageId: msgId("label-second"),
      subject: "Re: Original subject",
      date: "2026-11-02T10:00:00Z",
      references: [msgId("label-first")],
    });

    const [target] = await inTenant(tenant, (client) => resolveMailThreadRefTargets(client, [first.threadId]));

    expect(target).toEqual({ currentThreadId: first.threadId, label: "Re: Original subject", state: "active" });
  });

  it("translates a merged-away id to the surviving thread, its subject and its state", async () => {
    const fixture = await mailFixture(tenant);
    const inbox = await fixture.folder("inbox");
    const { survivor, merged } = await mergedThreads(tenant, fixture, inbox, "translate");

    const targets = await inTenant(tenant, (client) => resolveMailThreadRefTargets(client, [merged, survivor]));

    // The merged thread's own message is the latest of the merged thread (3 November).
    const expected = { currentThreadId: survivor, label: "translate reply", state: "active" };
    expect(targets).toEqual([expected, expected]);
  });

  it("marks a thread whose every message is in the Trash folder as trashed and keeps its subject", async () => {
    const fixture = await mailFixture(tenant);
    const trash = await fixture.folder("trash");
    const first = await fixture.message({
      folderId: trash,
      messageId: msgId("trash-first"),
      subject: "Gone",
      date: "2026-11-01T10:00:00Z",
    });
    await fixture.message({
      folderId: trash,
      messageId: msgId("trash-second"),
      subject: "Re: Gone",
      date: "2026-11-02T10:00:00Z",
      references: [msgId("trash-first")],
    });

    const [target] = await inTenant(tenant, (client) => resolveMailThreadRefTargets(client, [first.threadId]));

    expect(target).toEqual({ currentThreadId: first.threadId, label: "Re: Gone", state: "trashed" });
  });

  it("keeps a thread active while one of its messages is outside the Trash folder", async () => {
    const fixture = await mailFixture(tenant);
    const trash = await fixture.folder("trash");
    const inbox = await fixture.folder("inbox");
    const first = await fixture.message({
      folderId: trash,
      messageId: msgId("partly-first"),
      subject: "Partly",
      date: "2026-11-01T10:00:00Z",
    });
    await fixture.message({
      folderId: inbox,
      messageId: msgId("partly-second"),
      subject: "Re: Partly",
      date: "2026-11-02T10:00:00Z",
      references: [msgId("partly-first")],
    });

    const [target] = await inTenant(tenant, (client) => resolveMailThreadRefTargets(client, [first.threadId]));

    expect(target).toMatchObject({ state: "active" });
  });

  it("does not count a message that was deleted into the item trash against the thread", async () => {
    const fixture = await mailFixture(tenant);
    const trash = await fixture.folder("trash");
    const inbox = await fixture.folder("inbox");
    const first = await fixture.message({
      folderId: trash,
      messageId: msgId("deleted-first"),
      subject: "Deleted",
      date: "2026-11-01T10:00:00Z",
    });
    const second = await fixture.message({
      folderId: inbox,
      messageId: msgId("deleted-second"),
      subject: "Re: Deleted",
      date: "2026-11-02T10:00:00Z",
      references: [msgId("deleted-first")],
    });
    await fixture.softDeleteEmail(second.itemId);

    const [target] = await inTenant(tenant, (client) => resolveMailThreadRefTargets(client, [first.threadId]));

    // The only live message is in Trash, and the deleted one in the Inbox is no longer one of the thread's messages.
    expect(target).toEqual({ currentThreadId: first.threadId, label: "Deleted", state: "trashed" });
  });

  it("marks a thread without a live message as trashed and labels it with its subject hint", async () => {
    const fixture = await mailFixture(tenant);
    const inbox = await fixture.folder("inbox");
    const only = await fixture.message({
      folderId: inbox,
      messageId: msgId("empty-only"),
      subject: "Emptied",
      date: "2026-11-01T10:00:00Z",
    });
    await fixture.softDeleteEmail(only.itemId);
    const hint = await fixture.subjectHint(only.threadId);

    const [target] = await inTenant(tenant, (client) => resolveMailThreadRefTargets(client, [only.threadId]));

    expect(target).toEqual({ currentThreadId: only.threadId, label: hint, state: "trashed" });
  });

  it("does not count a message in a deleted Trash folder as being in Trash", async () => {
    const fixture = await mailFixture(tenant);
    const trash = await fixture.folder("trash");
    const only = await fixture.message({
      folderId: trash,
      messageId: msgId("folder-gone"),
      subject: "Folder gone",
      date: "2026-11-01T10:00:00Z",
    });
    await fixture.softDeleteFolder(trash);

    const [target] = await inTenant(tenant, (client) => resolveMailThreadRefTargets(client, [only.threadId]));

    expect(target).toMatchObject({ label: "Folder gone", state: "active" });
  });

  it("answers null for an unknown id, a Threads item id and another tenant's thread, and reads a batch in one statement", async () => {
    const { own, ownItem, foreignThread } = await threadsOfTwoTenants();

    const read = await inTenant(tenant, (client) =>
      countStatements(client, "all_in_trash", () =>
        resolveMailThreadRefTargets(client, [randomUUID(), ownItem, foreignThread, own]),
      ),
    );

    expect(read.count).toBe(1);
    expect(read.result).toEqual([null, null, null, { currentThreadId: own, label: "Own thread", state: "active" }]);
  });
});

describe("a mailThread ref in the Semp thread history (issue gh-1933)", () => {
  /** Sends one message carrying `context` as `tenantId` and reads its history entry back. */
  async function history(tenantId: string, context: unknown[]) {
    const sent = await inTenant(tenantId, (client) =>
      sendSempMessage(client, { text: "Question", context, hasContext: true }),
    );
    const read = await inTenant(tenantId, (client) =>
      countStatements(client, "all_in_trash", () => listSempThreadMessages(client, sent.threadId, 50, null)),
    );
    const row = read.result.rows.find((entry) => entry.id === sent.messageId);
    if (!row) throw new Error("The sent message is missing from its history");
    return { context: row.context, statements: read.count };
  }

  it("shows the subject of a live thread, the subject of the survivor for a merged-away id, trashed for a thread in Trash and purged for an unknown id, in one statement", async () => {
    const fixture = await mailFixture(tenant);
    const inbox = await fixture.folder("inbox");
    const trash = await fixture.folder("trash");
    const { survivor, merged } = await mergedThreads(tenant, fixture, inbox, "history");
    const trashed = (
      await fixture.message({
        folderId: trash,
        messageId: msgId("history-trashed"),
        subject: "In the bin",
        date: "2026-11-05T10:00:00Z",
      })
    ).threadId;
    const unknown = randomUUID();

    const shown = await history(tenant, [
      threadRef(survivor),
      threadRef(merged),
      threadRef(trashed),
      threadRef(unknown),
    ]);

    expect(shown.statements).toBe(1);
    expect(shown.context).toEqual([
      { ...threadRef(survivor), resolved: { label: "history reply", databaseKey: null, state: "active" } },
      { ...threadRef(merged), resolved: { label: "history reply", databaseKey: null, state: "active" } },
      { ...threadRef(trashed), resolved: { label: "In the bin", databaseKey: null, state: "trashed" } },
      { ...threadRef(unknown), resolved: { label: null, databaseKey: null, state: "purged" } },
    ]);
  });

  it("keeps the stored label of a historical ref and shows another tenant's thread as purged", async () => {
    const { own, foreignThread } = await threadsOfTwoTenants();

    const shown = await history(tenant, [{ ...threadRef(own), label: "Label at send time" }, threadRef(foreignThread)]);

    expect(shown.context).toEqual([
      {
        ...threadRef(own),
        label: "Label at send time",
        resolved: { label: "Own thread", databaseKey: null, state: "active" },
      },
      { ...threadRef(foreignThread), resolved: { label: null, databaseKey: null, state: "purged" } },
    ]);
  });
});

describe("readSempRefContext for a mailThread ref (issue gh-1933)", () => {
  const read = (tenantId: string, ref: SempMessageRef) =>
    inTenant(tenantId, (client) => readSempRefContext(client, ref));

  it("hands the agent the current thread id of a merged-away ref, with the subject and no blob", async () => {
    const fixture = await mailFixture(tenant);
    const inbox = await fixture.folder("inbox");
    const { survivor, merged } = await mergedThreads(tenant, fixture, inbox, "expand");

    expect(await read(tenant, threadRef(merged))).toEqual({
      label: "expand reply",
      state: "active",
      details: { threadId: survivor },
      blob: null,
    });
    expect(await read(tenant, threadRef(survivor))).toMatchObject({ details: { threadId: survivor } });
  });

  it("reads a thread whose messages are all in Trash as trashed", async () => {
    const fixture = await mailFixture(tenant);
    const only = await fixture.message({
      folderId: await fixture.folder("trash"),
      messageId: msgId("expand-trashed"),
      subject: "Binned",
      date: "2026-11-01T10:00:00Z",
    });

    expect(await read(tenant, threadRef(only.threadId))).toEqual({
      label: "Binned",
      state: "trashed",
      details: { threadId: only.threadId },
      blob: null,
    });
  });

  it("bounds the label to 500 code points", async () => {
    const fixture = await mailFixture(tenant);
    const only = await fixture.message({
      folderId: await fixture.folder("inbox"),
      messageId: msgId("expand-long"),
      subject: "\u{1F4E7}".repeat(600),
      date: "2026-11-01T10:00:00Z",
    });

    const context = await read(tenant, threadRef(only.threadId));

    expect(Array.from(context?.label ?? "")).toHaveLength(500);
  });

  it("reads nothing for an unknown id, the id of a Threads item and another tenant's thread", async () => {
    const { ownItem, foreignThread } = await threadsOfTwoTenants();

    expect(await read(tenant, threadRef(randomUUID()))).toBeNull();
    expect(await read(tenant, threadRef(ownItem))).toBeNull();
    expect(await read(tenant, threadRef(foreignThread))).toBeNull();
    expect(await read(foreign, threadRef(foreignThread))).toMatchObject({ details: { threadId: foreignThread } });
  });
});
