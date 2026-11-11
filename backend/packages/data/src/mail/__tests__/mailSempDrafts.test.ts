import "../../domainWriteHooks.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { LocalFsBlobStorageWriter } from "../blobStorage.js";
import { createEmailDraft } from "../draft.js";
import { ensureFolderItem } from "../folderDiscovery.js";
import { ingestEmailMessage } from "../ingest.js";
import { getMailDraft, markMailDraftSent, type MailDraftActor } from "../mailDraftsStore.js";
import { resolveMergedThreadId } from "../mailMessageMetaStore.js";
import { resolveMailModuleIds, type MailModuleIds } from "../mailModuleIds.js";
import { createMailSummaryRouteHandler } from "../mailSummary.js";
import { createMailThreadListRouteHandler } from "../mailThreadRoutes.js";

const OWN_ADDRESS = "me@example.test";

let admin: Pool;
let runtime: Pool;
let storageRoot: string;
let storage: LocalFsBlobStorageWriter;

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

/** One tenant's mail fixture, every row written through the writers production uses. */
async function mailFixture(tenantId: string) {
  const ids = await seededIds(tenantId);

  const mailboxId = await inTenant(tenantId, async (client) => {
    const item = await createItemWithClient(client, {
      databaseId: ids.mailboxesDatabaseId,
      properties: { name: "Personal", provider: "generic" },
    });
    return item.id;
  });

  /** A folder of the mailbox, through folder discovery. */
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
  const draftsFolderId = await folder("drafts");

  /** One message through the ingest writer; `references` joins it to an earlier message's thread. */
  const message = (input: {
    folderId: string;
    messageId: string;
    flags?: string[];
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
        subject: input.messageId,
        envelope: {
          from: { name: "Sender", address: "sender@example.test" },
          to: [{ name: "Me", address: OWN_ADDRESS }],
        },
        bodyText: "body",
        flags: input.flags ?? [],
        attachments: [],
        storage,
        storageKeyPrefix: "mail-semp-drafts",
      });
      const { rows } = await client.query<{ thread_id: string | null }>(
        "SELECT thread_id FROM mail_message_meta WHERE tenant_id = app_tenant_default() AND item_id = $1",
        [itemId],
      );
      const threadId = rows[0]?.thread_id;
      if (!threadId) throw new Error(`message ${input.messageId} has no thread`);
      return { itemId, threadId };
    });

  /** A Semprec draft with its `mail_drafts` row, through the draft writer; answers the draft's Emails item id. */
  const draft = (threadId: string | null, createdBy: MailDraftActor): Promise<string> =>
    inTenant(tenantId, async (client) => {
      const item = await createEmailDraft(client, {
        emailsDatabaseId: ids.emailsDatabaseId,
        folderRelationPropertyId: ids.emailFolderProperty,
        draftsFolderItemId: draftsFolderId,
        subject: "Draft",
        bodyText: "Draft body",
        metadata: {
          mailboxItemId: mailboxId,
          threadId,
          mode: threadId === null ? "new" : "reply",
          fromAddress: OWN_ADDRESS,
          createdBy,
        },
      });
      return item.id;
    });

  const markSent = async (draftItemId: string): Promise<void> => {
    await inTenant(tenantId, (client) => markMailDraftSent(client, draftItemId));
  };

  /** Soft-deletes one Emails item through the choke point and fails if nothing was deleted. */
  const softDeleteEmail = async (itemId: string): Promise<void> => {
    const deleted = await runInTenant(tenantId, () =>
      createChokePoint(runtime).softDeleteItem(ids.emailsDatabaseId, itemId),
    );
    if (deleted === null) throw new Error(`item ${itemId} was not soft-deleted`);
  };

  return { folder, message, draft, markSent, softDeleteEmail };
}

const listPage = z.object({
  threads: z.array(z.object({ threadId: z.string(), hasSempDraft: z.boolean() })),
  nextCursor: z.string().nullable(),
});
type ListedThread = z.infer<typeof listPage>["threads"][number];

/** Every row `GET /api/mail/threads?<query>` returns, two a page, following its cursor to the end. */
async function listed(tenantId: string, query = ""): Promise<ListedThread[]> {
  const handler = createMailThreadListRouteHandler(runtime);
  const rows: ListedThread[] = [];
  let cursor: string | null = null;
  do {
    const url = `/api/mail/threads?limit=2&${query}${cursor === null ? "" : `&cursor=${cursor}`}`;
    const answer = await runInTenant(tenantId, () => handler({ req: { url } }));
    expect(answer.status).toBe(200);
    const page = listPage.parse(answer.body);
    rows.push(...page.threads);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return rows;
}

/**
 * `{ <thread name>: hasSempDraft }` of `rows`, under the names `threads` gives the thread ids. A row
 * of a thread `threads` does not name, and a thread listed twice, fail the test.
 */
function flagsByName(rows: ListedThread[], threads: Record<string, string>): Record<string, boolean> {
  const names = new Map(Object.entries(threads).map(([name, id]) => [id, name]));
  const flags: Record<string, boolean> = {};
  for (const row of rows) {
    const name = names.get(row.threadId);
    if (name === undefined) throw new Error(`thread ${row.threadId} is not one of the named threads`);
    if (Object.hasOwn(flags, name)) throw new Error(`thread '${name}' is listed twice`);
    flags[name] = row.hasSempDraft;
  }
  return flags;
}

const summaryBody = z.object({ sempDrafts: z.number() });

/** `sempDrafts` of `GET /api/mail/summary` as `tenantId`, the way the adapter calls it: inside the session's tenant. */
async function sempDraftCount(tenantId: string): Promise<number> {
  const answer = await runInTenant(tenantId, () => createMailSummaryRouteHandler(runtime)());
  expect(answer.status).toBe(200);
  return summaryBody.parse(answer.body).sempDrafts;
}

/**
 * The scenario of the flag and box tests: threads that differ in exactly what makes a draft a Semp
 * draft. Three threads the list can show have one: `agent`, `sentThenNew` and `archived`.
 */
async function seedDraftThreads(tenantId: string) {
  const fixture = await mailFixture(tenantId);
  const inbox = await fixture.folder("inbox");
  const archive = await fixture.folder("archive");
  const id = (name: string): string => `<${name}@example.test>`;
  const inInbox = async (name: string, flags?: string[]): Promise<string> =>
    (await fixture.message({ folderId: inbox, messageId: id(name), flags })).threadId;

  const agent = await inInbox("agent");
  await fixture.draft(agent, "agent");

  const user = await inInbox("user");
  await fixture.draft(user, "user");

  const sent = await inInbox("sent");
  await fixture.markSent(await fixture.draft(sent, "agent"));

  const deleted = await inInbox("deleted");
  await fixture.softDeleteEmail(await fixture.draft(deleted, "agent"));

  const none = await inInbox("none");

  // A read thread whose first agent draft was sent and which got a new one since.
  const sentThenNew = await inInbox("sent-then-new", ["\\Seen"]);
  await fixture.markSent(await fixture.draft(sentThenNew, "agent"));
  await fixture.draft(sentThenNew, "agent");

  // Two messages outside the inbox and one draft: one thread.
  const archived = (await fixture.message({ folderId: archive, messageId: id("archived") })).threadId;
  await fixture.message({ folderId: archive, messageId: id("archived-reply"), references: [id("archived")] });
  await fixture.draft(archived, "agent");

  // An agent draft that belongs to no thread.
  await fixture.draft(null, "agent");

  // An agent draft of a thread whose only message is deleted: the list has no row for that thread.
  const gone = await fixture.message({ folderId: inbox, messageId: id("gone") });
  await fixture.draft(gone.threadId, "agent");
  await fixture.softDeleteEmail(gone.itemId);

  return { inbox, archive, threads: { agent, user, sent, deleted, none, sentThenNew, archived, gone: gone.threadId } };
}

/** The live thread a merged-away thread id of `tenantId` leads to, through the production resolver. */
function mergeTarget(tenantId: string, threadId: string): Promise<string | null> {
  return inTenant(tenantId, (client) => resolveMergedThreadId(client, threadId));
}

/**
 * Two threads of `tenantId` made one by the threading of the ingest writer. `<name>-reply` arrives
 * before the `<name>-bridge` it answers and starts the thread `merged`; `<name>-root` starts
 * `survivor`. After `beforeMerge` ran (its result is answered as `prepared`), the bridge arrives as
 * a reply to the root, so `survivor` absorbs `merged`, whose id is left only as an alias.
 */
async function mergedThreads<T>(
  tenantId: string,
  fixture: Awaited<ReturnType<typeof mailFixture>>,
  folderId: string,
  name: string,
  beforeMerge: (threads: { survivor: string; merged: string }) => Promise<T>,
): Promise<{ survivor: string; merged: string; prepared: T }> {
  const id = (part: string): string => `<${name}-${part}@example.test>`;
  const survivor = (await fixture.message({ folderId, messageId: id("root") })).threadId;
  const merged = (await fixture.message({ folderId, messageId: id("reply"), references: [id("bridge")] })).threadId;
  expect(merged).not.toBe(survivor);
  const prepared = await beforeMerge({ survivor, merged });
  const bridge = await fixture.message({ folderId, messageId: id("bridge"), references: [id("root")] });
  expect(bridge.threadId).toBe(survivor);
  expect(await mergeTarget(tenantId, merged)).toBe(survivor);
  return { survivor, merged, prepared };
}

beforeAll(async () => {
  admin = getTestPool();
  runtime = await createRuntimeRolePool(admin, "semprec_data");
  const role = await runAsSystem("verify Semp draft test role", () =>
    runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    ),
  );
  expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  storageRoot = await mkdtemp(join(tmpdir(), "semprec-mail-semp-drafts-"));
  storage = new LocalFsBlobStorageWriter(storageRoot);
});

let tenant: string;
let foreign: string;

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

describe("Semp drafts in the mail thread list and the mail summary (issue gh-1694)", () => {
  it("flags a thread with an unsent agent draft, and none with only a user draft, a sent draft, a deleted draft or no draft", async () => {
    const { archive, threads } = await seedDraftThreads(tenant);

    expect(flagsByName(await listed(tenant), threads)).toEqual({
      agent: true,
      user: false,
      sent: false,
      deleted: false,
      none: false,
      sentThenNew: true,
    });
    expect(flagsByName(await listed(tenant, `folderId=${archive}`), threads)).toEqual({ archived: true });
  });

  it("returns exactly the threads that have a Semp draft for box=sempDrafts, and counts them in the summary", async () => {
    const { threads } = await seedDraftThreads(tenant);

    const box = await listed(tenant, "box=sempDrafts");

    // Three threads, two a page: the box is read over a cursor.
    expect(flagsByName(box, threads)).toEqual({ agent: true, sentThenNew: true, archived: true });
    expect(box).toHaveLength(3);
    // Threads, not drafts: neither the thread-less draft nor the draft of the thread without a message counts.
    expect(await sempDraftCount(tenant)).toBe(box.length);
  });

  it("narrows the box by unread, and lets a folderId replace it as it replaces the other boxes", async () => {
    const { inbox, threads } = await seedDraftThreads(tenant);

    expect(flagsByName(await listed(tenant, "box=sempDrafts&unread=true"), threads)).toEqual({
      agent: true,
      archived: true,
    });
    expect(flagsByName(await listed(tenant, `box=sempDrafts&folderId=${inbox}`), threads)).toEqual({
      agent: true,
      user: false,
      sent: false,
      deleted: false,
      none: false,
      sentThenNew: true,
    });
  });

  it("keeps a thread whose messages are all in Junk or Trash out of the box and the count, and still flags its row", async () => {
    const fixture = await mailFixture(tenant);
    const inbox = await fixture.folder("inbox");
    const junk = await fixture.folder("junk");
    const trash = await fixture.folder("trash");
    const junkOnly = (await fixture.message({ folderId: junk, messageId: "<junk@example.test>" })).threadId;
    await fixture.draft(junkOnly, "agent");
    const trashOnly = (await fixture.message({ folderId: trash, messageId: "<trash@example.test>" })).threadId;
    await fixture.draft(trashOnly, "agent");
    // One message in Trash and its reply in the inbox: the thread is not only in Trash.
    const partlyTrashed = (await fixture.message({ folderId: trash, messageId: "<partly@example.test>" })).threadId;
    await fixture.message({
      folderId: inbox,
      messageId: "<partly-reply@example.test>",
      references: ["<partly@example.test>"],
    });
    await fixture.draft(partlyTrashed, "agent");
    const threads = { junkOnly, trashOnly, partlyTrashed };

    expect(flagsByName(await listed(tenant, `folderId=${junk}`), threads)).toEqual({ junkOnly: true });
    expect(flagsByName(await listed(tenant, `folderId=${trash}`), threads)).toEqual({
      trashOnly: true,
      partlyTrashed: true,
    });
    expect(flagsByName(await listed(tenant, "box=sempDrafts"), threads)).toEqual({ partlyTrashed: true });
    expect(await sempDraftCount(tenant)).toBe(1);
  });

  it("neither flags, lists nor counts a thread for another tenant's draft", async () => {
    const own = await mailFixture(tenant);
    const ownThread = (await own.message({ folderId: await own.folder("inbox"), messageId: "<own@example.test>" }))
      .threadId;
    const other = await mailFixture(foreign);
    const otherThread = (
      await other.message({ folderId: await other.folder("inbox"), messageId: "<foreign@example.test>" })
    ).threadId;
    await other.draft(otherThread, "agent");
    // The other tenant's agent draft that names this tenant's thread id.
    await other.draft(ownThread, "agent");

    // The other tenant sees its own Semp draft, so its rows exist and are countable.
    expect(flagsByName(await listed(foreign, "box=sempDrafts"), { otherThread })).toEqual({ otherThread: true });
    expect(await sempDraftCount(foreign)).toBe(1);

    expect(flagsByName(await listed(tenant), { ownThread })).toEqual({ ownThread: false });
    expect(await listed(tenant, "box=sempDrafts")).toEqual([]);
    expect(await sempDraftCount(tenant)).toBe(0);

    // This tenant's own draft changes its own box and count only.
    await own.draft(ownThread, "agent");
    expect(flagsByName(await listed(tenant, "box=sempDrafts"), { ownThread })).toEqual({ ownThread: true });
    expect(await sempDraftCount(tenant)).toBe(1);
    expect(flagsByName(await listed(foreign, "box=sempDrafts"), { otherThread })).toEqual({ otherThread: true });
    expect(await sempDraftCount(foreign)).toBe(1);
  });

  describe("after a thread merge, which leaves the draft's thread id as it was", () => {
    it("flags, lists and counts the thread that absorbed the thread of a Semp draft", async () => {
      const fixture = await mailFixture(tenant);
      const {
        survivor,
        merged,
        prepared: draftItemId,
      } = await mergedThreads(tenant, fixture, await fixture.folder("inbox"), "agent", (threads) =>
        fixture.draft(threads.merged, "agent"),
      );

      // The draft row still names the merged-away thread: only the alias leads to the survivor.
      expect((await inTenant(tenant, (client) => getMailDraft(client, draftItemId)))?.threadId).toBe(merged);
      expect(flagsByName(await listed(tenant), { survivor })).toEqual({ survivor: true });
      expect(flagsByName(await listed(tenant, "box=sempDrafts"), { survivor })).toEqual({ survivor: true });
      expect(await sempDraftCount(tenant)).toBe(1);
    });

    it("follows the draft's thread through two merges", async () => {
      const fixture = await mailFixture(tenant);
      const inbox = await fixture.folder("inbox");
      const id = (name: string): string => `<${name}@example.test>`;
      const arrive = async (name: string, parent?: string): Promise<string> =>
        (await fixture.message({ folderId: inbox, messageId: id(name), references: parent ? [id(parent)] : [] }))
          .threadId;

      // Five messages that each answer the one before, m1 <- m2 <- m3 <- m4 <- m5, arriving out of order.
      const drafted = await arrive("m5", "m4");
      await fixture.draft(drafted, "agent");
      const second = await arrive("m3", "m2");
      expect(second).not.toBe(drafted);
      // m4 joins the thread of m3, which absorbs the thread of the m5 that waited for it.
      expect(await arrive("m4", "m3")).toBe(second);
      expect(await mergeTarget(tenant, drafted)).toBe(second);
      // m2 joins the thread of m1, which absorbs the thread of m3: the draft's thread now leads to the third thread.
      const third = await arrive("m1");
      expect(third).not.toBe(second);
      expect(await arrive("m2", "m1")).toBe(third);
      expect(await mergeTarget(tenant, drafted)).toBe(third);

      expect(flagsByName(await listed(tenant), { third })).toEqual({ third: true });
      expect(flagsByName(await listed(tenant, "box=sempDrafts"), { third })).toEqual({ third: true });
      expect(await sempDraftCount(tenant)).toBe(1);
    });

    it("lists and counts the surviving thread once when it and the thread merged into it both have a Semp draft", async () => {
      const fixture = await mailFixture(tenant);
      const { survivor } = await mergedThreads(
        tenant,
        fixture,
        await fixture.folder("inbox"),
        "both",
        async (threads) => {
          await fixture.draft(threads.survivor, "agent");
          await fixture.draft(threads.merged, "agent");
        },
      );

      const box = await listed(tenant, "box=sempDrafts");

      expect(flagsByName(box, { survivor })).toEqual({ survivor: true });
      expect(box).toHaveLength(1);
      expect(await sempDraftCount(tenant)).toBe(1);
    });

    it("does not flag the surviving thread for a user draft, a sent draft or a deleted draft of the thread merged into it", async () => {
      const fixture = await mailFixture(tenant);
      const inbox = await fixture.folder("inbox");
      const user = await mergedThreads(tenant, fixture, inbox, "user", async ({ merged }) => {
        await fixture.draft(merged, "user");
      });
      const sent = await mergedThreads(tenant, fixture, inbox, "sent", async ({ merged }) => {
        await fixture.markSent(await fixture.draft(merged, "agent"));
      });
      const deleted = await mergedThreads(tenant, fixture, inbox, "deleted", async ({ merged }) => {
        await fixture.softDeleteEmail(await fixture.draft(merged, "agent"));
      });
      const threads = { user: user.survivor, sent: sent.survivor, deleted: deleted.survivor };

      expect(flagsByName(await listed(tenant), threads)).toEqual({ user: false, sent: false, deleted: false });
      expect(await listed(tenant, "box=sempDrafts")).toEqual([]);
      expect(await sempDraftCount(tenant)).toBe(0);
    });

    it("does not flag the surviving thread for another tenant's draft of the thread merged into it", async () => {
      const own = await mailFixture(tenant);
      const { survivor, merged } = await mergedThreads(tenant, own, await own.folder("inbox"), "own", async () => {});
      const other = await mailFixture(foreign);
      // The other tenant's agent draft that names this tenant's merged-away thread id.
      const foreignDraft = await other.draft(merged, "agent");
      expect((await inTenant(foreign, (client) => getMailDraft(client, foreignDraft)))?.threadId).toBe(merged);

      expect(flagsByName(await listed(tenant), { survivor })).toEqual({ survivor: false });
      expect(await listed(tenant, "box=sempDrafts")).toEqual([]);
      expect(await sempDraftCount(tenant)).toBe(0);
    });
  });
});
