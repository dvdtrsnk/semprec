import "../../domainWriteHooks.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import type { RelatedCollectionRow } from "../../chokePoint/relatedContributors.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { withTransaction } from "../../db/pool.js";
import {
  createCollectionMetadataResolver,
  type CollectionMetadataResolver,
} from "../../manifest/collectionMetadata.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { LocalFsBlobStorageWriter } from "../blobStorage.js";
import { EMAILS_RELATION_CONTEXT } from "../emailsRelationContext.js";
import { ingestEmailMessage } from "../ingest.js";

// Seeding the system databases of two tenants is the slow part of this file.
const SEEDING_TEST_TIMEOUT_MS = 120_000;

let admin: Pool;
let runtime: Pool;
let cp: ChokePoint;
let resolver: CollectionMetadataResolver;
let storageRoot: string;
let tenant: string;
let foreign: string;

interface Fixture {
  inbox: string;
  trash: string;
  /** A folder without a `specialPurpose`, as a user's own folder is. */
  plain: string;
  database: (key: string) => Promise<string>;
  person: (name: string) => Promise<string>;
  /** Ingests one message into `folder`, in the thread `refs` names, and links `people` to it as the edge says. */
  message: (input: {
    id: string;
    refs?: string[];
    folder?: "inbox" | "trash" | "plain";
    sender?: string;
    recipients?: string[];
  }) => Promise<string>;
}

/** The Emails-side relation edge `key` from a message to a person, written as the Emails module writes it. */
async function linkPerson(key: "senderPeople" | "recipientsPeople", emailItemId: string, personId: string) {
  const emailsDatabase = (await cp.listDatabases()).find((database) => database.ownerModuleId === "emails");
  const property = (await cp.listProperties(emailsDatabase?.id ?? "")).find((candidate) => candidate.key === key);
  if (!property) throw new Error(`Missing Emails.${key}`);
  await withTransaction(runtime, (client) =>
    createRelationWithClient(
      client,
      { relationPropertyId: property.id, callerItemId: emailItemId, targetItemId: personId },
      EMAILS_RELATION_CONTEXT,
    ),
  );
}

async function fixture(): Promise<Fixture> {
  const databases = await cp.listDatabases();
  const database = async (key: string) => {
    const found = databases.find((row) => row.ownerModuleId === key);
    if (!found) throw new Error(`Missing database ${key}`);
    return found.id;
  };
  const emails = await database("emails");
  const properties = await cp.listProperties(emails);
  const property = (key: string) => {
    const found = properties.find((row) => row.key === key);
    if (!found) throw new Error(`Missing Emails.${key}`);
    return found.id;
  };
  const mailbox = await cp.createItem({ databaseId: await database("mailboxes"), properties: { name: "Personal" } });
  const folders = await withTransaction(runtime, async (client) => {
    const create = async (name: string, specialPurpose: string) =>
      createItemWithClient(
        client,
        { databaseId: await database("folders"), properties: { name, behavior: "folder", specialPurpose } },
        { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
      );
    const plain = await createItemWithClient(
      client,
      { databaseId: await database("folders"), properties: { name: "Clients", behavior: "folder" } },
      { allowedSystemKeys: ["name", "behavior"] },
    );
    return { inbox: await create("Inbox", "inbox"), trash: await create("Trash", "trash"), plain };
  });
  const storage = new LocalFsBlobStorageWriter(storageRoot);
  return {
    inbox: folders.inbox.id,
    trash: folders.trash.id,
    plain: folders.plain.id,
    database,
    person: async (name) => (await cp.createItem({ databaseId: await database("people"), properties: { name } })).id,
    message: async (input) => {
      const { itemId } = await withTransaction(runtime, async (client) =>
        ingestEmailMessage(client, {
          emailsDatabaseId: emails,
          filesDatabaseId: await database("files"),
          folderRelationPropertyId: property("folder"),
          attachmentsRelationPropertyId: property("attachments"),
          mailboxItemId: mailbox.id,
          folderItemId: { inbox: folders.inbox, trash: folders.trash, plain: folders.plain }[input.folder ?? "inbox"]
            .id,
          messageId: input.id,
          references: input.refs ?? [],
          subject: "Website proposal",
          envelope: {
            from: { name: "Sender", address: "sender@example.test" },
            to: [{ name: "Me", address: "me@example.test" }],
          },
          bodyText: "preview",
          attachments: [],
          storage,
          storageKeyPrefix: "fixtures",
        }),
      );
      if (input.sender !== undefined) await linkPerson("senderPeople", itemId, input.sender);
      for (const recipient of input.recipients ?? []) await linkPerson("recipientsPeople", itemId, recipient);
      return itemId;
    },
  };
}

function related(itemId: string, tenantId = tenant) {
  return runInTenant(tenantId, () => cp.listRelatedCollections(itemId, resolver));
}

async function relatedRows(itemId: string): Promise<RelatedCollectionRow[]> {
  const rows = await related(itemId);
  if (rows === null) throw new Error(`Item ${itemId} is not found`);
  return rows;
}

function threadsRow(threadsDatabaseId: string, count: number): RelatedCollectionRow {
  return { databaseKey: "threads", databaseId: threadsDatabaseId, count, via: "direct", filter: null };
}

describe("the mail threads of a person in the related collections (issue gh-1874)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    cp = createChokePoint(runtime);
    resolver = await createCollectionMetadataResolver(await loadFullModuleRegistry());
    storageRoot = await mkdtemp(join(tmpdir(), "semprec-person-threads-"));
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    for (const id of [tenant, foreign]) await runInTenant(id, () => seedSystem(runtime));
  }, SEEDING_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await runtime.end();
    await admin.end();
    await rm(storageRoot, { recursive: true, force: true });
  });

  it("lists one thread of four messages as a mail count of 1 and no Emails entry", () =>
    runInTenant(tenant, async () => {
      const f = await fixture();
      const person = await f.person("Alice");
      await f.message({ id: "<one@example.test>", sender: person });
      for (const index of [1, 2, 3])
        await f.message({ id: `<reply-${index}@example.test>`, refs: ["<one@example.test>"], sender: person });
      // Four messages, one thread.
      const threads = await admin.query<{ count: number }>(
        "SELECT count(DISTINCT thread_id)::int AS count FROM mail_message_meta WHERE tenant_id = $1",
        [tenant],
      );
      expect(threads.rows).toEqual([{ count: 1 }]);

      expect(await relatedRows(person)).toEqual([threadsRow(await f.database("threads"), 1)]);
    }));

  it("counts a thread through a recipient edge, and a thread of both kinds of edge once", () =>
    runInTenant(tenant, async () => {
      const f = await fixture();
      const person = await f.person("Alice");
      const other = await f.person("Bob");
      await f.message({ id: "<sent@example.test>", sender: person });
      await f.message({ id: "<received@example.test>", refs: ["<sent@example.test>"], recipients: [person] });
      await f.message({ id: "<second@example.test>", recipients: [person, other] });
      await f.message({ id: "<elsewhere@example.test>", sender: other });

      expect(await relatedRows(person)).toEqual([threadsRow(await f.database("threads"), 2)]);
      expect(await relatedRows(other)).toEqual([threadsRow(await f.database("threads"), 2)]);
    }));

  it("returns no mail entry for a person with no mail, and none for one whose mail is another person's", () =>
    runInTenant(tenant, async () => {
      const f = await fixture();
      const person = await f.person("Alice");
      const other = await f.person("Bob");
      expect(await relatedRows(person)).toEqual([]);
      await f.message({ id: "<bob@example.test>", sender: other });
      expect(await relatedRows(person)).toEqual([]);
    }));

  it("does not count a message in the Trash folder only, and counts the thread through a message outside it", () =>
    runInTenant(tenant, async () => {
      const f = await fixture();
      const person = await f.person("Alice");
      await f.message({ id: "<trashed@example.test>", folder: "trash", sender: person });
      expect(await relatedRows(person)).toEqual([]);

      await f.message({ id: "<kept@example.test>", refs: ["<trashed@example.test>"], sender: person });
      expect(await relatedRows(person)).toEqual([threadsRow(await f.database("threads"), 1)]);
    }));

  it("counts a message that is in the Trash folder and in another folder", () =>
    runInTenant(tenant, async () => {
      const f = await fixture();
      const person = await f.person("Alice");
      await f.message({ id: "<both@example.test>", folder: "trash", sender: person });
      await f.message({ id: "<both@example.test>", folder: "inbox", sender: undefined });

      expect(await relatedRows(person)).toEqual([threadsRow(await f.database("threads"), 1)]);
    }));

  it("counts a message in a folder without a special purpose", () =>
    runInTenant(tenant, async () => {
      const f = await fixture();
      const person = await f.person("Alice");
      await f.message({ id: "<plain@example.test>", folder: "plain", sender: person });

      expect(await relatedRows(person)).toEqual([threadsRow(await f.database("threads"), 1)]);
    }));

  it("counts a message with no live folder, as the Trash-folder rule only excludes a message that has one", () =>
    runInTenant(tenant, async () => {
      const f = await fixture();
      const person = await f.person("Alice");
      await f.message({ id: "<orphan@example.test>", folder: "trash", sender: person });
      expect(await relatedRows(person)).toEqual([]);
      // The message's only folder is deleted: it has an edge to a folder item that is in the Trash, so no live folder.
      expect(await cp.softDeleteItem(await f.database("folders"), f.trash)).not.toBeNull();

      expect(await relatedRows(person)).toEqual([threadsRow(await f.database("threads"), 1)]);
    }));

  it("does not count a message whose item is in the Trash, and counts it again once restored", () =>
    runInTenant(tenant, async () => {
      const f = await fixture();
      const person = await f.person("Alice");
      const message = await f.message({ id: "<deleted@example.test>", sender: person });
      const emails = await f.database("emails");
      expect(await cp.softDeleteItem(emails, message)).not.toBeNull();

      expect(await relatedRows(person)).toEqual([]);

      expect(await cp.restoreItem(emails, message)).not.toBeNull();
      expect(await relatedRows(person)).toEqual([threadsRow(await f.database("threads"), 1)]);
    }));

  it("does not count a thread whose own item is in the Trash", () =>
    runInTenant(tenant, async () => {
      const f = await fixture();
      const person = await f.person("Alice");
      await f.message({ id: "<threaded@example.test>", sender: person });
      const thread = await admin.query<{ item_id: string }>("SELECT item_id FROM mail_threads WHERE tenant_id = $1", [
        tenant,
      ]);
      const threadItem = thread.rows[0]?.item_id;
      if (threadItem === undefined || thread.rows.length !== 1) throw new Error("Expected one thread");
      expect(await cp.softDeleteItem(await f.database("threads"), threadItem)).not.toBeNull();

      expect(await relatedRows(person)).toEqual([]);
    }));

  it("counts only the asking tenant's threads and never lists another tenant's person", async () => {
    const mine = await runInTenant(tenant, async () => {
      const f = await fixture();
      const person = await f.person("Alice");
      await f.message({ id: "<mine@example.test>", sender: person });
      return { person, threads: await f.database("threads") };
    });
    const theirs = await runInTenant(foreign, async () => {
      const f = await fixture();
      const person = await f.person("Alice");
      for (const id of ["<theirs-1@example.test>", "<theirs-2@example.test>"]) await f.message({ id, sender: person });
      return { person, threads: await f.database("threads") };
    });

    expect(await relatedRows(mine.person)).toEqual([threadsRow(mine.threads, 1)]);
    expect(await related(theirs.person, foreign)).toEqual([threadsRow(theirs.threads, 2)]);
    // The other tenant's person is not found in this tenant's scope, as an unknown id is.
    expect(await related(theirs.person)).toBeNull();
  });
});
