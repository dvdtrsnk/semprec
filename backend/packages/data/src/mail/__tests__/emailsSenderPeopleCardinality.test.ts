import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { createPool, withTransaction } from "../../db/pool.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import * as propertiesStore from "../../chokePoint/propertiesStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { EMAILS_MODULE_ID, FOLDERS_MODULE_ID, MAILBOXES_MODULE_ID } from "../../seed/emailModuleKeys.js";
import { FILES_MODULE_ID, PEOPLE_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import { CardinalityViolationError } from "../../errors.js";
import { getTestPool, getTenantZeroId, resetDatabase } from "../../testSupport/testDb.js";
import { ensureFolderItem } from "../folderDiscovery.js";
import { ingestEmailMessage } from "../ingest.js";
import type { BlobStorageWriter } from "../blobStorage.js";
import { createLinkEmailToPeopleAction } from "../personLinkingActions.js";
import { reindexPersonEmails } from "../personEmailIndexStore.js";
import { runEmailsSenderPeopleCardinalityCutoverMigration } from "../emailsSenderPeopleCardinalityCutoverMigration.js";

let adminPool: Pool;
/** Runtime role (semprec_data) pool: every production write in this file goes through it, so row-level security applies. */
let dataPool: Pool;
let chokePoint: ChokePoint;

/** No test in this file ingests attachments, so any storage call is a bug in the test. */
const unusedStorage: BlobStorageWriter = {
  async writeStream() {
    throw new Error("attachment storage is not used by this test");
  },
  async delete() {
    throw new Error("attachment storage is not used by this test");
  },
  readStream() {
    throw new Error("attachment storage is not used by this test");
  },
};

/** The databases and relation properties one Mailbox ingests into, read from the tenant's own seed. */
interface MailFixture {
  emailsId: string;
  filesId: string;
  peopleId: string;
  mailboxItemId: string;
  inboxItemId: string;
  folderPropertyId: string;
  attachmentsPropertyId: string;
}

async function requireDatabaseId(client: PoolClient, moduleId: string): Promise<string> {
  const database = await getDatabaseByModuleId(client, moduleId);
  if (!database) throw new Error(`Database '${moduleId}' was not seeded`);
  return database.id;
}

async function seedTenant(tenantId: string): Promise<void> {
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
}

/**
 * Creates a Mailbox with its INBOX folder through the production writers, in the tenant's scope.
 * The folder's mailbox edge is looked up the way `gmailPseudoFolderCleanupJob.ts` looks it up.
 */
async function setUpMail(tenantId: string): Promise<MailFixture> {
  return runInTenant(tenantId, () =>
    withTransaction(dataPool, async (client) => {
      const emailsId = await requireDatabaseId(client, EMAILS_MODULE_ID);
      const filesId = await requireDatabaseId(client, FILES_MODULE_ID);
      const peopleId = await requireDatabaseId(client, PEOPLE_MODULE_ID);
      const foldersId = await requireDatabaseId(client, FOLDERS_MODULE_ID);
      const mailboxesId = await requireDatabaseId(client, MAILBOXES_MODULE_ID);

      const mailbox = await createItemWithClient(client, {
        databaseId: mailboxesId,
        properties: { name: "Mailbox", provider: "generic" },
      });
      const mailboxFolderProperty = await propertiesStore.getPropertyByKey(client, foldersId, "mailbox");
      const folderProperty = await propertiesStore.getPropertyByKey(client, emailsId, "folder");
      const attachmentsProperty = await propertiesStore.getPropertyByKey(client, emailsId, "attachments");
      if (!mailboxFolderProperty || !folderProperty || !attachmentsProperty) {
        throw new Error("The Emails and Folders relations were not seeded");
      }
      const inboxItemId = await ensureFolderItem(client, {
        foldersDatabaseId: foldersId,
        mailboxItemId: mailbox.id,
        mailboxRelationPropertyId: mailboxFolderProperty.id,
        providerId: "INBOX",
        name: "INBOX",
        behavior: "folder",
        specialPurpose: "inbox",
      });
      return {
        emailsId,
        filesId,
        peopleId,
        mailboxItemId: mailbox.id,
        inboxItemId,
        folderPropertyId: folderProperty.id,
        attachmentsPropertyId: attachmentsProperty.id,
      };
    }),
  );
}

/** Creates a Person with one address and indexes the address the way its People heartbeat does. */
async function createPerson(tenantId: string, mail: MailFixture, name: string, address: string): Promise<string> {
  return runInTenant(tenantId, async () => {
    const person = await chokePoint.createItem({ databaseId: mail.peopleId, properties: { name, emails: address } });
    await withTransaction(dataPool, (client) => reindexPersonEmails(client, person.id, [address]));
    return person.id;
  });
}

/** Ingests one message from `fromAddress` into the Mailbox, as the sync pass does, and returns its Emails item id. */
async function ingestFrom(
  tenantId: string,
  mail: MailFixture,
  messageId: string,
  fromAddress: string,
): Promise<string> {
  return runInTenant(tenantId, () =>
    withTransaction(dataPool, async (client) => {
      const result = await ingestEmailMessage(client, {
        emailsDatabaseId: mail.emailsId,
        filesDatabaseId: mail.filesId,
        folderRelationPropertyId: mail.folderPropertyId,
        attachmentsRelationPropertyId: mail.attachmentsPropertyId,
        folderItemId: mail.inboxItemId,
        mailboxItemId: mail.mailboxItemId,
        messageId,
        subject: messageId,
        envelope: { from: { address: fromAddress }, to: [{ address: "bob@example.com" }] },
        bodyText: "hi",
        attachments: [],
        storage: unusedStorage,
        storageKeyPrefix: "test",
      });
      return result.itemId;
    }),
  );
}

/** Runs the production `mail.linkPeopleByEmail` action for one email, as its onItemEvent heartbeat does. */
async function linkEmail(tenantId: string, mail: MailFixture, emailItemId: string): Promise<void> {
  await runInTenant(tenantId, () =>
    createLinkEmailToPeopleAction(dataPool)(
      { emailsDatabaseId: mail.emailsId, senderPeopleKey: "senderPeople", recipientsPeopleKey: "recipientsPeople" },
      { heartbeatId: "hb", projectItemId: "proj", itemId: emailItemId },
    ),
  );
}

/** The Person item ids joined to an email through the senderPeople relation, sorted. */
async function senderPersonIds(tenantId: string, mail: MailFixture, emailItemId: string): Promise<string[]> {
  return runInTenant(tenantId, async () => {
    const { rows } = await dataPool.query<{ person_id: string }>(
      `SELECT CASE WHEN r.item_a = $2 THEN r.item_b ELSE r.item_a END AS person_id
         FROM item_relations r
        WHERE r.relation_definition_id = (
                SELECT rd.id FROM relation_definitions rd
                  JOIN properties p ON p.id = rd.property_id_a
                 WHERE p.database_id = $1 AND p.key = 'senderPeople')
          AND (r.item_a = $2 OR r.item_b = $2)
        ORDER BY person_id`,
      [mail.emailsId, emailItemId],
    );
    return rows.map((row) => row.person_id);
  });
}

async function senderCardinality(tenantId: string): Promise<string | null> {
  return runInTenant(tenantId, async () => {
    const { rows } = await dataPool.query<{ cardinality: string }>(
      `SELECT rd.cardinality FROM relation_definitions rd
         JOIN properties p ON p.id = rd.property_id_a
         JOIN databases d ON d.id = p.database_id
        WHERE d.owner_module_id = 'emails' AND p.key = 'senderPeople'`,
    );
    return rows[0]?.cardinality ?? null;
  });
}

/**
 * Sets the tenant's Emails.senderPeople back to one_to_many, the shape every install seeded before
 * issue #1457 has. Direct SQL is the fixture: the seed now declares many_to_many, and no public
 * writer changes the cardinality of a schema-locked relation.
 */
async function setSenderOneToMany(tenantId: string): Promise<void> {
  await adminPool.query(
    `UPDATE relation_definitions SET cardinality = 'one_to_many'
      WHERE tenant_id = $1 AND id IN (
        SELECT rd.id FROM relation_definitions rd
          JOIN properties p ON p.id = rd.property_id_a
          JOIN databases d ON d.id = p.database_id
         WHERE d.owner_module_id = 'emails' AND p.key = 'senderPeople' AND d.tenant_id = $1)`,
    [tenantId],
  );
}

describe("Emails.senderPeople allows many emails per person (issue #1457)", () => {
  beforeAll(() => {
    adminPool = getTestPool();
    dataPool = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
    chokePoint = createChokePoint(dataPool);
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
  });

  afterAll(async () => {
    await dataPool.end();
    await adminPool.end();
  });

  it("a fresh install declares senderPeople as many_to_many", async () => {
    const zero = getTenantZeroId();
    await seedTenant(zero);

    expect(await senderCardinality(zero)).toBe("many_to_many");
  });

  it("one person sends two emails on a fresh install: both get a sender edge and the link action does not roll back", async () => {
    const zero = getTenantZeroId();
    await seedTenant(zero);
    const mail = await setUpMail(zero);
    const alice = await createPerson(zero, mail, "Alice", "alice@example.com");
    const first = await ingestFrom(zero, mail, "<first@example.com>", "alice@example.com");
    const second = await ingestFrom(zero, mail, "<second@example.com>", "alice@example.com");

    await linkEmail(zero, mail, first);
    await linkEmail(zero, mail, second);

    expect(await senderPersonIds(zero, mail, first)).toEqual([alice]);
    expect(await senderPersonIds(zero, mail, second)).toEqual([alice]);
  });

  it("after the cutover, a populated tenant lets one person send two emails; before it, the second link is refused and leaves no sender edge", async () => {
    const zero = getTenantZeroId();
    await seedTenant(zero);
    await setSenderOneToMany(zero);
    const mail = await setUpMail(zero);
    const alice = await createPerson(zero, mail, "Alice", "alice@example.com");
    const first = await ingestFrom(zero, mail, "<first@example.com>", "alice@example.com");
    const second = await ingestFrom(zero, mail, "<second@example.com>", "alice@example.com");

    await linkEmail(zero, mail, first);
    await expect(linkEmail(zero, mail, second)).rejects.toBeInstanceOf(CardinalityViolationError);
    expect(await senderPersonIds(zero, mail, second)).toEqual([]);

    await runInTenant(zero, () => runEmailsSenderPeopleCardinalityCutoverMigration(dataPool));
    await linkEmail(zero, mail, second);

    expect(await senderCardinality(zero)).toBe("many_to_many");
    expect(await senderPersonIds(zero, mail, first)).toEqual([alice]);
    expect(await senderPersonIds(zero, mail, second)).toEqual([alice]);
  });

  it("re-linking an email whose sender edge already exists leaves exactly one senderPeople edge", async () => {
    const zero = getTenantZeroId();
    await seedTenant(zero);
    const mail = await setUpMail(zero);
    const alice = await createPerson(zero, mail, "Alice", "alice@example.com");
    const email = await ingestFrom(zero, mail, "<once@example.com>", "alice@example.com");

    await linkEmail(zero, mail, email);
    await linkEmail(zero, mail, email);

    expect(await senderPersonIds(zero, mail, email)).toEqual([alice]);
  });
});
