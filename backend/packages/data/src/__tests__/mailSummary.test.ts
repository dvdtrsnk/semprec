import "../domainWriteHooks.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { LocalFsBlobStorageWriter } from "../mail/blobStorage.js";
import { ensureFolderItem } from "../mail/folderDiscovery.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { resolveMailModuleIds, type MailModuleIds } from "../mail/mailModuleIds.js";
import { createMailSummaryRouteHandler } from "../mail/mailSummary.js";
import { createMailThreadListRouteHandler } from "../mail/mailThreadRoutes.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

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

  /** A Mailboxes item; `syncStatus` is written the way the sync job writes it. */
  const mailbox = (name: string, syncStatus?: "ok" | "needsReauthorization"): Promise<string> =>
    inTenant(tenantId, async (client) => {
      const item = await createItemWithClient(client, {
        databaseId: ids.mailboxesDatabaseId,
        properties: { name, provider: "generic" },
      });
      if (syncStatus !== undefined) {
        await updateItemWithClient(
          client,
          { databaseId: ids.mailboxesDatabaseId, itemId: item.id, propertiesPatch: { syncStatus } },
          { allowedSystemKeys: ["syncStatus"] },
        );
      }
      return item.id;
    });

  /** A folder of `mailboxId`, through folder discovery. */
  const folder = (mailboxId: string, specialPurpose: string): Promise<string> =>
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

  /** One message through the ingest writer. `references` joins it to an earlier message's thread. */
  const message = (input: {
    mailboxId: string;
    folderId: string;
    messageId: string;
    flags?: string[];
    from?: string;
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
          from: { name: "Sender", address: input.from ?? "sender@example.test" },
          to: [{ name: "Me", address: OWN_ADDRESS }],
        },
        bodyText: "body",
        flags: input.flags ?? [],
        attachments: [],
        storage,
        storageKeyPrefix: "mail-summary",
      });
      return result.itemId;
    });

  return { ids, mailbox, folder, message };
}

const summaryBody = z
  .object({
    unreadInbox: z.number(),
    flagged: z.number(),
    sempDrafts: z.number(),
    accounts: z.number(),
    accountsNeedingReauth: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
  })
  .strict();

/** `GET /api/mail/summary` as `tenantId`, the way the adapter calls it: inside the session's tenant. */
async function summary(tenantId: string): Promise<z.infer<typeof summaryBody>> {
  const answer = await runInTenant(tenantId, () => createMailSummaryRouteHandler(runtime)());
  expect(answer.status).toBe(200);
  return summaryBody.parse(answer.body);
}

const listPage = z.object({
  threads: z.array(z.object({ threadId: z.string() })),
  nextCursor: z.string().nullable(),
});

/** Every thread `GET /api/mail/threads?<query>` returns, following its cursor page by page. */
async function listedThreadIds(tenantId: string, query: string): Promise<string[]> {
  const handler = createMailThreadListRouteHandler(runtime);
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const url = `/api/mail/threads?limit=2&${query}${cursor === null ? "" : `&cursor=${cursor}`}`;
    const page = listPage.parse((await runInTenant(tenantId, () => handler({ req: { url } }))).body);
    ids.push(...page.threads.map((thread) => thread.threadId));
    cursor = page.nextCursor;
  } while (cursor !== null);
  return ids;
}

/**
 * The scenario of the count tests: one mailbox whose own address is `OWN_ADDRESS`, and threads that
 * differ in exactly the properties the inbox, unread and flagged predicates read. Three threads are
 * unread in the inbox and two are flagged outside Junk.
 */
async function seedThreads(tenantId: string, prefix: string): Promise<string> {
  const fixture = await mailFixture(tenantId);
  const box = await fixture.mailbox("Personal");
  await inTenant(tenantId, (client) =>
    writeMailboxAddresses(client, {
      mailboxesDatabaseId: fixture.ids.mailboxesDatabaseId,
      mailboxItemId: box,
      address: OWN_ADDRESS,
    }),
  );
  const inbox = await fixture.folder(box, "inbox");
  const archive = await fixture.folder(box, "archive");
  const junk = await fixture.folder(box, "junk");
  const drafts = await fixture.folder(box, "drafts");
  const id = (name: string): string => `<${prefix}-${name}@example.test>`;
  const send = (
    name: string,
    folderId: string,
    rest: { flags?: string[]; from?: string; references?: string[] } = {},
  ) => fixture.message({ mailboxId: box, folderId, messageId: id(name), ...rest });

  await send("unread", inbox);
  await send("read", inbox, { flags: ["\\Seen"] });
  await send("unread-flagged", inbox, { flags: ["\\Flagged"] });
  await send("archived-flagged", archive, { flags: ["\\Flagged"] });
  await send("junk-flagged", junk, { flags: ["\\Flagged"] });
  // The user's own message is never unread for the user.
  await send("own", inbox, { from: OWN_ADDRESS });
  // Two messages of one thread, one of them unread: one unread thread, not two.
  await send("thread-first", inbox, { flags: ["\\Seen"] });
  await send("thread-reply", inbox, { references: [id("thread-first")] });
  // The list leaves a draft out, so no count includes it.
  await send("draft", drafts, { flags: ["\\Flagged"] });
  // A deleted message takes its thread out of every count.
  const deleted = await send("deleted", inbox, { flags: ["\\Flagged"] });
  const removed = await runInTenant(tenantId, () =>
    createChokePoint(runtime).softDeleteItem(fixture.ids.emailsDatabaseId, deleted),
  );
  if (removed === null) throw new Error("the message was not soft-deleted");
  return box;
}

beforeAll(async () => {
  admin = getTestPool();
  runtime = await createRuntimeRolePool(admin, "semprec_data");
  const role = await runAsSystem("verify mail summary test role", () =>
    runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    ),
  );
  expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  storageRoot = await mkdtemp(join(tmpdir(), "semprec-mail-summary-"));
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

describe("GET /api/mail/summary (issue gh-1688)", () => {
  it("counts the unread inbox threads and the flagged threads the thread list returns for the same filter", async () => {
    await seedThreads(tenant, "own");

    const counts = await summary(tenant);

    const unread = await listedThreadIds(tenant, "unread=true");
    const flagged = await listedThreadIds(tenant, "box=flagged");
    // More threads than one page holds, so the comparison is against the whole list.
    expect(new Set(unread).size).toBe(unread.length);
    expect(new Set(flagged).size).toBe(flagged.length);
    expect(counts.unreadInbox).toBe(unread.length);
    expect(counts.flagged).toBe(flagged.length);
    expect({ unreadInbox: counts.unreadInbox, flagged: counts.flagged }).toEqual({ unreadInbox: 3, flagged: 2 });
  });

  it("answers the counts, sempDrafts 0, the accounts and the ones that need a new sign-in", async () => {
    const fixture = await mailFixture(tenant);
    await seedThreads(tenant, "own");
    const work = await fixture.mailbox("Work", "needsReauthorization");
    await fixture.mailbox("Healthy", "ok");
    const second = await fixture.mailbox("Second", "needsReauthorization");

    const answer = await runInTenant(tenant, () => createMailSummaryRouteHandler(runtime)());

    expect(answer).toEqual({
      status: 200,
      body: {
        unreadInbox: 3,
        flagged: 2,
        sempDrafts: 0,
        accounts: 4,
        accountsNeedingReauth: [
          { id: work, name: "Work" },
          { id: second, name: "Second" },
        ].sort((left, right) => (left.id < right.id ? -1 : 1)),
      },
    });
  });

  it("neither counts nor lists a deleted mailbox", async () => {
    const fixture = await mailFixture(tenant);
    const kept = await fixture.mailbox("Kept", "needsReauthorization");
    const removed = await fixture.mailbox("Removed", "needsReauthorization");
    expect((await summary(tenant)).accounts).toBe(2);

    const deleted = await runInTenant(tenant, () =>
      createChokePoint(runtime).softDeleteItem(fixture.ids.mailboxesDatabaseId, removed),
    );
    if (deleted === null) throw new Error("the mailbox was not soft-deleted");

    const counts = await summary(tenant);
    expect(counts.accounts).toBe(1);
    expect(counts.accountsNeedingReauth).toEqual([{ id: kept, name: "Kept" }]);
  });

  it("counts nothing of another tenant's mail and mailboxes", async () => {
    await seedThreads(tenant, "own");
    const before = await summary(tenant);
    expect(before).toMatchObject({ unreadInbox: 3, flagged: 2, accounts: 1, accountsNeedingReauth: [] });

    const other = await mailFixture(foreign);
    const otherBox = await other.mailbox("Foreign", "needsReauthorization");
    const otherInbox = await other.folder(otherBox, "inbox");
    await other.message({ mailboxId: otherBox, folderId: otherInbox, messageId: "<foreign-1@example.test>" });
    await other.message({
      mailboxId: otherBox,
      folderId: otherInbox,
      messageId: "<foreign-2@example.test>",
      flags: ["\\Flagged"],
    });

    // The other tenant sees exactly its own rows, so its rows exist and are countable.
    expect(await summary(foreign)).toEqual({
      unreadInbox: 2,
      flagged: 1,
      sempDrafts: 0,
      accounts: 1,
      accountsNeedingReauth: [{ id: otherBox, name: "Foreign" }],
    });
    expect(await summary(tenant)).toEqual(before);
  });

  it("answers zeros for a tenant with no mail, and for a tenant whose databases are not seeded", async () => {
    const empty = { unreadInbox: 0, flagged: 0, sempDrafts: 0, accounts: 0, accountsNeedingReauth: [] };

    expect(await summary(tenant)).toEqual(empty);
    expect(await summary(await createTestTenant(admin))).toEqual(empty);
  });
});
