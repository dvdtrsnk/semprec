import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { loadModuleCatalogs } from "@semprec/module-registry";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import { LocalFsBlobStorageWriter } from "../mail/blobStorage.js";
import { createEmailDraft } from "../mail/draft.js";
import { ensureFolderItem } from "../mail/folderDiscovery.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { createMailFolderListRouteHandler } from "../mail/mailFolderList.js";
import { resolveMailModuleIds, type MailModuleIds } from "../mail/mailModuleIds.js";
import { createMailThreadListRouteHandler } from "../mail/mailThreadRoutes.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

// The real loader behind a spy, so one test can make a single load fail.
vi.mock("@semprec/module-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@semprec/module-registry")>();
  return { ...actual, loadModuleCatalogs: vi.fn(actual.loadModuleCatalogs) };
});

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

/** One tenant's mail fixture, every row written through the writers production uses. */
async function mailFixture(tenantId: string) {
  const ids = await seededIds(tenantId);

  const mailbox = (name: string, provider = "gmail"): Promise<string> =>
    inTenant(tenantId, async (client) => {
      const item = await createItemWithClient(client, {
        databaseId: ids.mailboxesDatabaseId,
        properties: { name, provider },
      });
      return item.id;
    });

  /** A folder of `mailboxId` under the provider's own `name`, through folder discovery. */
  const folder = (
    mailboxId: string,
    name: string,
    specialPurpose: string,
    behavior: "folder" | "label" = "label",
  ): Promise<string> =>
    inTenant(tenantId, (client) =>
      ensureFolderItem(client, {
        foldersDatabaseId: ids.foldersDatabaseId,
        mailboxItemId: mailboxId,
        mailboxRelationPropertyId: ids.folderMailboxProperty,
        providerId: name,
        name,
        behavior,
        specialPurpose,
      }),
    );

  /** One message through the ingest writer; a repeated `messageId` in the mailbox adds a folder to the same message. */
  const message = (input: {
    mailboxId: string;
    folderId: string;
    messageId: string;
    flags?: string[];
    references?: string[];
  }): Promise<string> =>
    inTenant(tenantId, async (client) => {
      const references = input.references ?? [];
      const result = await ingestEmailMessage(client, {
        emailsDatabaseId: ids.emailsDatabaseId,
        filesDatabaseId: ids.filesDatabaseId,
        folderRelationPropertyId: ids.emailFolderProperty,
        attachmentsRelationPropertyId: ids.emailAttachmentsProperty,
        folderItemId: input.folderId,
        mailboxItemId: input.mailboxId,
        messageId: input.messageId,
        inReplyTo: references.at(-1) ?? null,
        references,
        subject: input.messageId,
        envelope: {
          from: { name: "Sender", address: "sender@example.test" },
          to: [{ name: "Me", address: "me@example.test" }],
        },
        bodyText: "body",
        flags: input.flags ?? [],
        attachments: [],
        storage,
        storageKeyPrefix: "mail-folder-list",
      });
      return result.itemId;
    });

  /** A draft the user wrote in Semprec, through the draft writer. */
  const draft = (draftsFolderId: string): Promise<string> =>
    inTenant(tenantId, async (client) => {
      const item = await createEmailDraft(client, {
        emailsDatabaseId: ids.emailsDatabaseId,
        folderRelationPropertyId: ids.emailFolderProperty,
        draftsFolderItemId: draftsFolderId,
        subject: "Draft",
        bodyText: "Draft body",
      });
      return item.id;
    });

  /** Soft-deletes one item through the choke point and fails if nothing was deleted. */
  const softDelete = async (databaseId: string, itemId: string): Promise<void> => {
    const deleted = await runInTenant(tenantId, () => createChokePoint(runtime).softDeleteItem(databaseId, itemId));
    if (deleted === null) throw new Error(`item ${itemId} was not soft-deleted`);
  };

  return { ids, mailbox, folder, message, draft, softDelete };
}

const folderEntry = z
  .object({
    id: z.string(),
    name: z.string(),
    specialPurpose: z.string(),
    behavior: z.string().nullable(),
    unreadCount: z.number(),
    totalCount: z.number(),
  })
  .strict();

type FolderEntry = z.infer<typeof folderEntry>;

/** `GET /api/mail/mailboxes/:id/folders` as a user of `tenantId` with `locale`, inside that tenant as the adapter calls it. */
async function folders(tenantId: string, mailboxId: string, locale = "en"): Promise<FolderEntry[]> {
  const handler = createMailFolderListRouteHandler(runtime);
  const answer = await runInTenant(tenantId, () =>
    handler({ params: { id: mailboxId }, identity: { user: { locale } } }),
  );
  expect(answer.status).toBe(200);
  return z.array(folderEntry).parse(answer.body);
}

/** The rejection of `GET /api/mail/mailboxes/:id/folders`, failing when the request is answered. */
async function refusal(tenantId: string, mailboxId: string): Promise<unknown> {
  const handler = createMailFolderListRouteHandler(runtime);
  try {
    await runInTenant(tenantId, () => handler({ params: { id: mailboxId }, identity: { user: { locale: "en" } } }));
  } catch (error) {
    return error;
  }
  throw new Error("expected the folder list to be refused");
}

const listPage = z.object({
  threads: z.array(z.object({ threadId: z.string() })),
  nextCursor: z.string().nullable(),
});

/** Every thread `GET /api/mail/threads?folderId=...&unread=true` returns, following its cursor page by page. */
async function unreadThreadsInFolder(tenantId: string, folderId: string): Promise<string[]> {
  const handler = createMailThreadListRouteHandler(runtime);
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const url = `/api/mail/threads?limit=2&unread=true&folderId=${folderId}${cursor === null ? "" : `&cursor=${cursor}`}`;
    const page = listPage.parse((await runInTenant(tenantId, () => handler({ req: { url } }))).body);
    ids.push(...page.threads.map((thread) => thread.threadId));
    cursor = page.nextCursor;
  } while (cursor !== null);
  return ids;
}

/** The six system folders of a Gmail-mode mailbox under the names Gmail gives them, created out of sidebar order. */
async function gmailSystemFolders(
  fixture: Awaited<ReturnType<typeof mailFixture>>,
  mailboxId: string,
): Promise<Record<"inbox" | "sent" | "drafts" | "archive" | "junk" | "trash", string>> {
  const trash = await fixture.folder(mailboxId, "TRASH", "trash");
  const junk = await fixture.folder(mailboxId, "SPAM", "junk");
  const archive = await fixture.folder(mailboxId, "Archive", "archive");
  const drafts = await fixture.folder(mailboxId, "DRAFT", "drafts");
  const sent = await fixture.folder(mailboxId, "SENT", "sent");
  const inbox = await fixture.folder(mailboxId, "INBOX", "inbox");
  return { inbox, sent, drafts, archive, junk, trash };
}

beforeAll(async () => {
  admin = getTestPool();
  runtime = await createRuntimeRolePool(admin, "semprec_data");
  const role = await runAsSystem("verify mail folder list test role", () =>
    runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    ),
  );
  expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  storageRoot = await mkdtemp(join(tmpdir(), "semprec-mail-folder-list-"));
  storage = new LocalFsBlobStorageWriter(storageRoot);
});

beforeEach(async () => {
  await resetDatabase(admin);
  tenant = await createTestTenant(admin);
  foreign = await createTestTenant(admin);
  for (const id of [tenant, foreign]) await runInTenant(id, () => seedSystem(runtime));
});

afterEach(() => {
  // Drops a failure a test queued and did not use, so it cannot fail the next test's seeding.
  vi.mocked(loadModuleCatalogs).mockReset();
});

afterAll(async () => {
  await runtime?.end();
  await admin?.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe("GET /api/mail/mailboxes/:id/folders (issue gh-1689)", () => {
  it("lists the system folders in sidebar order, then the other folders by name, without the all folder", async () => {
    const fixture = await mailFixture(tenant);
    const box = await fixture.mailbox("Personal");
    const other = async (name: string, behavior: "folder" | "label") => ({
      id: await fixture.folder(box, name, "none", behavior),
      name,
      behavior,
    });
    // Six folders created in the order of their code units, before and after the system folders.
    const others = [await other("Zebra", "label"), await other("alpha", "folder"), await other("receipts", "label")];
    const system = await gmailSystemFolders(fixture, box);
    const all = await fixture.folder(box, "[Gmail]/All Mail", "all");
    others.push(await other("Émile", "label"), await other("Čeští klienti", "folder"), await other("žádosti", "label"));

    const listed = await folders(tenant, box);

    const byName = [...others].sort((left, right) => new Intl.Collator("en").compare(left.name, right.name));
    // The collation orders the names differently, so a list left unsorted or sorted by code unit fails below.
    expect(byName.map((folder) => folder.name)).not.toEqual(others.map((folder) => folder.name).sort());
    expect(listed.map((folder) => [folder.id, folder.specialPurpose, folder.behavior])).toEqual([
      [system.inbox, "inbox", "label"],
      [system.sent, "sent", "label"],
      [system.drafts, "drafts", "label"],
      [system.archive, "archive", "label"],
      [system.junk, "junk", "label"],
      [system.trash, "trash", "label"],
      ...byName.map((folder) => [folder.id, "none", folder.behavior]),
    ]);
    expect(listed.map((folder) => folder.id)).not.toContain(all);
  });

  it("orders folders of one name by id, so the order does not depend on the order they were created in", async () => {
    const fixture = await mailFixture(tenant);
    const box = await fixture.mailbox("Personal");
    // Five folders with one name and one purpose: only their provider ids differ.
    const namesakes = await inTenant(tenant, async (client) => {
      const ids: string[] = [];
      for (const providerId of ["Label_1", "Label_2", "Label_3", "Label_4", "Label_5"]) {
        ids.push(
          await ensureFolderItem(client, {
            foldersDatabaseId: fixture.ids.foldersDatabaseId,
            mailboxItemId: box,
            mailboxRelationPropertyId: fixture.ids.folderMailboxProperty,
            providerId,
            name: "Projects",
            behavior: "label",
            specialPurpose: "none",
          }),
        );
      }
      return ids;
    });

    expect((await folders(tenant, box)).map((folder) => folder.id)).toEqual([...namesakes].sort());
  });

  it.each([
    ["cs", ["Doručená pošta", "Odeslané", "Koncepty", "Archiv", "Nevyžádaná pošta", "Koš"]],
    ["en", ["Inbox", "Sent", "Drafts", "Archive", "Junk", "Trash"]],
    // A locale without a catalog reads the English reference catalog.
    ["de", ["Inbox", "Sent", "Drafts", "Archive", "Junk", "Trash"]],
  ])("names the system folders in the %s locale and keeps the name of every other folder", async (locale, labels) => {
    const fixture = await mailFixture(tenant);
    const box = await fixture.mailbox("Personal");
    await gmailSystemFolders(fixture, box);
    await fixture.folder(box, "Receipts 2026", "none");

    const listed = await folders(tenant, box, locale);

    expect(listed.map((folder) => folder.name)).toEqual([...labels, "Receipts 2026"]);
  });

  it("answers totalCount 2 for the Drafts folder of a Gmail account with two drafts", async () => {
    const fixture = await mailFixture(tenant);
    const box = await fixture.mailbox("Gmail", "gmail");
    const system = await gmailSystemFolders(fixture, box);
    // One draft Gmail reported, as the sync files it, and one the user wrote in Semprec.
    await fixture.message({ mailboxId: box, folderId: system.drafts, messageId: "<synced-draft@example.test>" });
    await fixture.draft(system.drafts);

    const listed = await folders(tenant, box);

    const drafts = listed.find((folder) => folder.id === system.drafts);
    expect(drafts).toEqual({
      id: system.drafts,
      name: "Drafts",
      specialPurpose: "drafts",
      behavior: "label",
      // The thread list leaves drafts out, so no thread of this folder is unread.
      unreadCount: (await unreadThreadsInFolder(tenant, system.drafts)).length,
      totalCount: 2,
    });
    expect(drafts?.unreadCount).toBe(0);
    expect(listed.filter((folder) => folder.id !== system.drafts).map((folder) => folder.totalCount)).toEqual([
      0, 0, 0, 0, 0,
    ]);
  });

  it("counts, per folder, the unread threads the thread list returns for it and the messages linked to it", async () => {
    const fixture = await mailFixture(tenant);
    const box = await fixture.mailbox("Personal");
    const system = await gmailSystemFolders(fixture, box);
    const label = await fixture.folder(box, "Receipts", "none");
    const send = (name: string, folderId: string, rest: { flags?: string[]; references?: string[] } = {}) =>
      fixture.message({ mailboxId: box, folderId, messageId: `<${name}@example.test>`, ...rest });

    // Inbox: three unread threads (one of them of two messages) and one read thread; five messages.
    await send("inbox-unread-1", system.inbox);
    await send("inbox-unread-2", system.inbox);
    await send("inbox-read", system.inbox, { flags: ["\\Seen"] });
    await send("inbox-thread-first", system.inbox, { flags: ["\\Seen"] });
    await send("inbox-thread-reply", system.inbox, { references: ["<inbox-thread-first@example.test>"] });
    // Archive: one unread and one read message, each its own thread.
    await send("archive-unread", system.archive);
    await send("archive-read", system.archive, { flags: ["\\Seen"] });
    // One unread message in two folders is one message and one unread thread in each of them.
    await send("labelled", system.inbox);
    await send("labelled", label);
    // A deleted message counts nowhere.
    const deleted = await send("junk-deleted", system.junk);
    await fixture.softDelete(fixture.ids.emailsDatabaseId, deleted);
    await send("junk-unread", system.junk);

    const listed = await folders(tenant, box);

    const counts = Object.fromEntries(listed.map((folder) => [folder.id, [folder.unreadCount, folder.totalCount]]));
    expect(counts).toEqual({
      [system.inbox]: [4, 6],
      [system.sent]: [0, 0],
      [system.drafts]: [0, 0],
      [system.archive]: [1, 2],
      [system.junk]: [1, 1],
      [system.trash]: [0, 0],
      [label]: [1, 1],
    });
    for (const folder of listed) {
      const unread = await unreadThreadsInFolder(tenant, folder.id);
      expect(new Set(unread).size).toBe(unread.length);
      expect(folder.unreadCount, `unread threads of ${folder.name}`).toBe(unread.length);
    }
  });

  it("lists only the mailbox's own live folders, with the counts of its own messages", async () => {
    const fixture = await mailFixture(tenant);
    const box = await fixture.mailbox("Personal");
    const other = await fixture.mailbox("Work");
    const inbox = await fixture.folder(box, "INBOX", "inbox");
    const removed = await fixture.folder(box, "Old", "none");
    const otherInbox = await fixture.folder(other, "INBOX", "inbox");
    await fixture.message({ mailboxId: box, folderId: inbox, messageId: "<own@example.test>" });
    await fixture.message({ mailboxId: other, folderId: otherInbox, messageId: "<other-1@example.test>" });
    await fixture.message({ mailboxId: other, folderId: otherInbox, messageId: "<other-2@example.test>" });
    await fixture.softDelete(fixture.ids.foldersDatabaseId, removed);

    expect(await folders(tenant, box)).toEqual([
      { id: inbox, name: "Inbox", specialPurpose: "inbox", behavior: "label", unreadCount: 1, totalCount: 1 },
    ]);
    expect(await folders(tenant, other)).toEqual([
      { id: otherInbox, name: "Inbox", specialPurpose: "inbox", behavior: "label", unreadCount: 2, totalCount: 2 },
    ]);
  });

  it("answers an empty list for a mailbox without folders", async () => {
    const fixture = await mailFixture(tenant);

    expect(await folders(tenant, await fixture.mailbox("New"))).toEqual([]);
  });

  it("answers another tenant's mailbox, an unknown one, a deleted one and a malformed id with the same 404", async () => {
    const own = await mailFixture(tenant);
    const deleted = await own.mailbox("Removed");
    await own.folder(deleted, "INBOX", "inbox");
    await own.softDelete(own.ids.mailboxesDatabaseId, deleted);
    const other = await mailFixture(foreign);
    const foreignBox = await other.mailbox("Foreign");
    const foreignInbox = await other.folder(foreignBox, "INBOX", "inbox");
    await other.message({ mailboxId: foreignBox, folderId: foreignInbox, messageId: "<foreign@example.test>" });

    // The foreign mailbox exists and lists its folder for its own tenant.
    expect((await folders(foreign, foreignBox)).map((folder) => folder.id)).toEqual([foreignInbox]);
    const unknown = await refusal(tenant, randomUUID());
    expect(unknown).toBeInstanceOf(NotFoundError);
    for (const id of [foreignBox, deleted, "not-a-uuid"]) {
      expect(await refusal(tenant, id)).toEqual(unknown);
    }
    // A tenant without a Mailboxes database has no mailbox either.
    expect(await refusal(await createTestTenant(admin), foreignBox)).toEqual(unknown);
  });

  it("counts none of another tenant's messages", async () => {
    const own = await mailFixture(tenant);
    const box = await own.mailbox("Personal");
    const inbox = await own.folder(box, "INBOX", "inbox");
    await own.message({ mailboxId: box, folderId: inbox, messageId: "<shared-id@example.test>" });
    const before = await folders(tenant, box);
    expect(before.map((folder) => [folder.unreadCount, folder.totalCount])).toEqual([[1, 1]]);

    const other = await mailFixture(foreign);
    const foreignBox = await other.mailbox("Foreign");
    const foreignInbox = await other.folder(foreignBox, "INBOX", "inbox");
    for (const name of ["shared-id", "foreign-2", "foreign-3"]) {
      await other.message({ mailboxId: foreignBox, folderId: foreignInbox, messageId: `<${name}@example.test>` });
    }

    expect((await folders(foreign, foreignBox)).map((folder) => [folder.unreadCount, folder.totalCount])).toEqual([
      [3, 3],
    ]);
    expect(await folders(tenant, box)).toEqual(before);
  });

  it("loads the catalogs once per handler, and tries again after a load that failed", async () => {
    const fixture = await mailFixture(tenant);
    const box = await fixture.mailbox("Personal");
    await fixture.folder(box, "INBOX", "inbox");
    const handler = createMailFolderListRouteHandler(runtime);
    const request = () =>
      runInTenant(tenant, () => handler({ params: { id: box }, identity: { user: { locale: "cs" } } }));
    // Seeding the tenants loads catalogs through the same loader; only the handler's loads are counted.
    vi.mocked(loadModuleCatalogs).mockClear();
    vi.mocked(loadModuleCatalogs).mockRejectedValueOnce(new Error("the catalog could not be read"));

    await expect(request()).rejects.toThrow("the catalog could not be read");
    const names = z.array(folderEntry).parse((await request()).body);
    await request();

    expect(names.map((folder) => folder.name)).toEqual(["Doručená pošta"]);
    expect(loadModuleCatalogs).toHaveBeenCalledTimes(2);
  });
});
