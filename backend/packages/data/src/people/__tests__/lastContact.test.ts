import "../../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { DateTime } from "luxon";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, runOnce, type TaskList } from "@semprec/queue";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { getPropertyByKey } from "../../chokePoint/propertiesStore.js";
import { writeComputed } from "../../chokePoint/itemsStore.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../../transcription/transcriptionJob.js";
import { withTransaction } from "../../db/pool.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { today } from "../../calendarTime.js";
import { getSystemTimezone } from "../../systemSettings.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { createActionRegistry } from "../../scheduler/actions.js";
import { createCoreTaskList } from "../../worker.js";
import { EMAILS_MODULE_ID, FOLDERS_MODULE_ID, MAILBOXES_MODULE_ID } from "../../seed/emailModuleKeys.js";
import {
  EVENTS_MODULE_ID,
  FILES_MODULE_ID,
  PEOPLE_MODULE_ID,
  TRANSCRIPTS_MODULE_ID,
} from "../../seed/tenDatabaseKeys.js";
import { ensureFolderItem } from "../../mail/folderDiscovery.js";
import { ingestEmailMessage } from "../../mail/ingest.js";
import type { BlobStorageWriter } from "../../mail/blobStorage.js";
import { createLinkEmailToPeopleAction } from "../../mail/personLinkingActions.js";
import { reindexPersonEmails } from "../../mail/personEmailIndexStore.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import {
  handlePeopleLastContactSweep,
  peopleLastContactJobKey,
  readContactMoment,
  recomputePersonLastContact,
} from "../lastContact.js";
import { runPeopleLastContactCutoverMigration } from "../peopleLastContactCutoverMigration.js";
import { findOrphanedOwnerProcessIds } from "../../manifest/moduleRegistryDriftCheck.js";
import { KNOWN_OWNER_PROCESS_IDS } from "../../manifest/knownActionIds.js";

/**
 * Issue #1660: People `lastContact`, derived from linked Events, Emails and Transcripts. Every production
 * write goes through the choke point or the owning mail writers on a `semprec_data` pool, so row-level
 * security applies; the recompute runs through the production `createCoreTaskList` handler drained with
 * `runOnce`, except where a case needs a clock other than the real one (the sweep's next day, an Event's
 * start later today), which calls `recomputePersonLastContact` with that `now`, the job's own entry point.
 */

let admin: Pool;
let pool: Pool;
let chokePoint: ChokePoint;
let recomputeTaskList: TaskList;
let tenantA: string;
let tenantB: string;

const ZONE = "Europe/Prague";

/** No case here ingests attachments, so a storage call is a bug in the test. */
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

interface Catalog {
  peopleId: string;
  eventsId: string;
  emailsId: string;
  transcriptsId: string;
  eventsPeoplePropertyId: string;
  speakersPropertyId: string;
}

async function requireDatabaseId(client: PoolClient, moduleId: string): Promise<string> {
  const database = await getDatabaseByModuleId(client, moduleId);
  if (!database) throw new Error(`Database '${moduleId}' was not seeded`);
  return database.id;
}

async function requirePropertyId(client: PoolClient, databaseId: string, key: string): Promise<string> {
  const property = await getPropertyByKey(client, databaseId, key);
  if (!property) throw new Error(`Property '${key}' was not seeded`);
  return property.id;
}

async function catalog(tenant: string): Promise<Catalog> {
  return runInTenant(tenant, () =>
    withTransaction(pool, async (client) => {
      const peopleId = await requireDatabaseId(client, PEOPLE_MODULE_ID);
      const eventsId = await requireDatabaseId(client, EVENTS_MODULE_ID);
      const emailsId = await requireDatabaseId(client, EMAILS_MODULE_ID);
      const transcriptsId = await requireDatabaseId(client, TRANSCRIPTS_MODULE_ID);
      return {
        peopleId,
        eventsId,
        emailsId,
        transcriptsId,
        eventsPeoplePropertyId: await requirePropertyId(client, eventsId, "people"),
        speakersPropertyId: await requirePropertyId(client, transcriptsId, "speakers"),
      };
    }),
  );
}

/** The calendar date `days` away from today in the tenant zone. */
function dayFromToday(days: number): string {
  const date = DateTime.fromISO(today(ZONE), { zone: "utc" }).plus({ days }).toISODate();
  if (date === null) throw new Error("invalid day");
  return date;
}

async function createPerson(tenant: string, c: Catalog, name = "Person"): Promise<string> {
  return runInTenant(
    tenant,
    async () => (await chokePoint.createItem({ databaseId: c.peopleId, properties: { name } })).id,
  );
}

async function createEvent(
  tenant: string,
  c: Catalog,
  date: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  return runInTenant(
    tenant,
    async () =>
      (await chokePoint.createItem({ databaseId: c.eventsId, properties: { name: "Meeting", date, ...extra } })).id,
  );
}

async function linkEvent(tenant: string, c: Catalog, eventId: string, personId: string): Promise<void> {
  await runInTenant(tenant, () =>
    chokePoint.createRelation({
      relationPropertyId: c.eventsPeoplePropertyId,
      callerItemId: eventId,
      targetItemId: personId,
    }),
  );
}

async function lastContactOf(tenant: string, c: Catalog, personId: string): Promise<unknown> {
  const item = await runInTenant(tenant, () => chokePoint.getItem(c.peopleId, personId));
  if (!item) throw new Error("person not found");
  return item.properties.lastContact;
}

interface QueuedJob {
  key: string | null;
  queue_name: string | null;
}

/** The queued `peopleLastContactRecompute` jobs, read through graphile-worker's public `jobs` view. */
async function queuedRecomputes(): Promise<QueuedJob[]> {
  const { rows } = await admin.query<QueuedJob>(
    "SELECT key, queue_name FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY key",
    [CORE_TASK_NAMES.PEOPLE_LAST_CONTACT_RECOMPUTE],
  );
  return rows;
}

/** Completes every queued job without running it, through graphile-worker's public `complete_jobs`. */
async function discardQueuedJobs(): Promise<void> {
  await admin.query(
    "SELECT graphile_worker.complete_jobs(ARRAY(SELECT id FROM graphile_worker.jobs WHERE locked_at IS NULL))",
  );
}

/** Drains the queued recomputes with the production handler; nothing else in the queue runs. */
async function runRecomputes(): Promise<void> {
  for (let pass = 0; pass < 5 && (await queuedRecomputes()).length > 0; pass += 1) {
    await runOnce({ pgPool: admin, taskList: recomputeTaskList });
  }
  expect(await queuedRecomputes()).toEqual([]);
}

beforeAll(async () => {
  admin = getTestPool();
  pool = await createRuntimeRolePool(admin, "semprec_data");
  chokePoint = createChokePoint(pool);
  const full = createCoreTaskList(pool, createActionRegistry());
  const recompute = full[CORE_TASK_NAMES.PEOPLE_LAST_CONTACT_RECOMPUTE];
  if (!recompute) throw new Error("createCoreTaskList has no peopleLastContactRecompute handler");
  recomputeTaskList = { [CORE_TASK_NAMES.PEOPLE_LAST_CONTACT_RECOMPUTE]: recompute };
});

beforeEach(async () => {
  await resetDatabase(admin);
  tenantA = await createTestTenant(admin);
  tenantB = await createTestTenant(admin);
  for (const tenant of [tenantA, tenantB]) {
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
  }
  await discardQueuedJobs();
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
});

describe("People lastContact (issue #1660)", () => {
  it("seeds lastContact as a system date owned by the people process, in the tenant zone", async () => {
    const property = await runInTenant(tenantA, () =>
      withTransaction(pool, async (client) =>
        getPropertyByKey(client, await requireDatabaseId(client, PEOPLE_MODULE_ID), "lastContact"),
      ),
    );
    expect(property).toMatchObject({ type: "date", owner: "system", ownerProcess: PEOPLE_MODULE_ID });
    expect(await runInTenant(tenantA, () => withTransaction(pool, getSystemTimezone))).toBe(ZONE);
  });

  it("is owned by a process the module registry drift check knows", async () => {
    const orphaned = await runInTenant(tenantA, () =>
      withTransaction(pool, async (client) => ({
        known: await findOrphanedOwnerProcessIds(client, KNOWN_OWNER_PROCESS_IDS),
        withoutPeople: await findOrphanedOwnerProcessIds(
          client,
          new Set([...KNOWN_OWNER_PROCESS_IDS].filter((id) => id !== PEOPLE_MODULE_ID)),
        ),
      })),
    );
    expect(orphaned.known).not.toContain(PEOPLE_MODULE_ID);
    expect(orphaned.withoutPeople).toContain(PEOPLE_MODULE_ID);
  });

  it("an event dated 15 October in the past linked to a person sets lastContact to 15 October", async () => {
    const c = await catalog(tenantA);
    const person = await createPerson(tenantA, c);
    const date = `${Number(today(ZONE).slice(0, 4)) - 1}-10-15`;
    const event = await createEvent(tenantA, c, date);
    await linkEvent(tenantA, c, event, person);

    expect(await queuedRecomputes()).toEqual([
      { key: peopleLastContactJobKey(person), queue_name: `people-last-contact:${tenantA}` },
    ]);
    await runRecomputes();
    expect(await lastContactOf(tenantA, c, person)).toBe(date);
  });

  it("an event only tomorrow leaves lastContact unchanged; the sweep the day after sets that event's date", async () => {
    const c = await catalog(tenantA);
    const person = await createPerson(tenantA, c);
    const tomorrow = dayFromToday(1);
    await linkEvent(tenantA, c, await createEvent(tenantA, c, tomorrow), person);
    // Out of the sweep window the next day: three days ago (already counted then) and the day after tomorrow.
    const pastPerson = await createPerson(tenantA, c, "Past");
    await linkEvent(tenantA, c, await createEvent(tenantA, c, dayFromToday(-3)), pastPerson);
    const futurePerson = await createPerson(tenantA, c, "Future");
    await linkEvent(tenantA, c, await createEvent(tenantA, c, dayFromToday(2)), futurePerson);

    await runRecomputes();
    expect(await lastContactOf(tenantA, c, person)).toBeUndefined();

    // 01:00 the next day in the tenant zone, when the daily crontab entry runs.
    const nextDay = DateTime.fromISO(`${tomorrow}T01:00`, { zone: ZONE }).toJSDate();
    await handlePeopleLastContactSweep(pool, { now: nextDay });
    expect(await queuedRecomputes()).toEqual([
      { key: peopleLastContactJobKey(person), queue_name: `people-last-contact:${tenantA}` },
    ]);
    // The queued job's own entry point at the time it runs.
    await runInTenant(tenantA, () => recomputePersonLastContact(pool, person, { now: nextDay }));
    expect(await lastContactOf(tenantA, c, person)).toBe(tomorrow);
  });

  it("removing the person, trashing or restoring the event moves lastContact between the latest dates", async () => {
    const c = await catalog(tenantA);
    const person = await createPerson(tenantA, c);
    const older = dayFromToday(-20);
    const newer = dayFromToday(-5);
    await linkEvent(tenantA, c, await createEvent(tenantA, c, older), person);
    const newerEvent = await createEvent(tenantA, c, newer);
    await linkEvent(tenantA, c, newerEvent, person);
    await runRecomputes();
    expect(await lastContactOf(tenantA, c, person)).toBe(newer);

    await runInTenant(tenantA, () =>
      chokePoint.deleteRelation({
        relationPropertyId: c.eventsPeoplePropertyId,
        callerItemId: newerEvent,
        targetItemId: person,
      }),
    );
    expect((await queuedRecomputes()).map((job) => job.key)).toEqual([peopleLastContactJobKey(person)]);
    await runRecomputes();
    expect(await lastContactOf(tenantA, c, person)).toBe(older);

    await linkEvent(tenantA, c, newerEvent, person);
    await runRecomputes();
    expect(await lastContactOf(tenantA, c, person)).toBe(newer);

    await runInTenant(tenantA, () => chokePoint.softDeleteItem(c.eventsId, newerEvent));
    expect((await queuedRecomputes()).map((job) => job.key)).toEqual([peopleLastContactJobKey(person)]);
    await runRecomputes();
    expect(await lastContactOf(tenantA, c, person)).toBe(older);

    await runInTenant(tenantA, () => chokePoint.restoreItem(c.eventsId, newerEvent));
    expect((await queuedRecomputes()).map((job) => job.key)).toEqual([peopleLastContactJobKey(person)]);
    await runRecomputes();
    expect(await lastContactOf(tenantA, c, person)).toBe(newer);
  });

  it("an event's start time later today counts only once it passed, and a timeFrom change requeues the person", async () => {
    const c = await catalog(tenantA);
    const person = await createPerson(tenantA, c);
    const event = await createEvent(tenantA, c, "2025-03-10", { timeFrom: "15:00" });
    await linkEvent(tenantA, c, event, person);
    await discardQueuedJobs();

    const before = DateTime.fromISO("2025-03-10T14:59", { zone: ZONE }).toJSDate();
    const after = DateTime.fromISO("2025-03-10T15:00", { zone: ZONE }).toJSDate();
    await runInTenant(tenantA, () => recomputePersonLastContact(pool, person, { now: before }));
    expect(await lastContactOf(tenantA, c, person)).toBeUndefined();
    await runInTenant(tenantA, () => recomputePersonLastContact(pool, person, { now: after }));
    expect(await lastContactOf(tenantA, c, person)).toBe("2025-03-10");

    await runInTenant(tenantA, () =>
      chokePoint.updateItem({ databaseId: c.eventsId, itemId: event, propertiesPatch: { timeFrom: "16:00" } }),
    );
    expect((await queuedRecomputes()).map((job) => job.key)).toEqual([peopleLastContactJobKey(person)]);
    await discardQueuedJobs();
    await runInTenant(tenantA, () => recomputePersonLastContact(pool, person, { now: after }));
    expect(await lastContactOf(tenantA, c, person)).toBeNull();

    // A patch of a non-date property queues nothing.
    await runInTenant(tenantA, () =>
      chokePoint.updateItem({ databaseId: c.eventsId, itemId: event, propertiesPatch: { name: "Renamed" } }),
    );
    expect(await queuedRecomputes()).toEqual([]);
  });

  it("reads each kind of source date with the calendar owners in the tenant zone", () => {
    expect(readContactMoment("2025-10-15", null, ZONE)).toEqual({
      instantMs: DateTime.fromISO("2025-10-15T00:00", { zone: ZONE }).toMillis(),
      date: "2025-10-15",
    });
    expect(readContactMoment("2025-10-15", "09:30", ZONE)?.instantMs).toBe(
      DateTime.fromISO("2025-10-15T09:30", { zone: ZONE }).toMillis(),
    );
    // An offset instant counts as its date in the tenant zone, not as the date it was written with.
    expect(readContactMoment("2025-10-15T23:30:00.000Z", null, ZONE)?.date).toBe("2025-10-16");
    // A date with a time but no offset is wall-clock time in the tenant zone.
    expect(readContactMoment("2025-10-15T23:30", null, ZONE)?.date).toBe("2025-10-15");
    // A start of 24:00 is not a start; the day's start is used.
    expect(readContactMoment("2025-10-15", "24:00", ZONE)?.instantMs).toBe(
      DateTime.fromISO("2025-10-15T00:00", { zone: ZONE }).toMillis(),
    );
    for (const unreadable of ["2025-02-30", "not a date", "", 20251015, null]) {
      expect(readContactMoment(unreadable, null, ZONE)).toBeNull();
    }
  });

  it("an email's date change and a second email from the same sender move lastContact without failing", async () => {
    const c = await catalog(tenantA);
    const mail = await runInTenant(tenantA, () =>
      withTransaction(pool, async (client) => {
        const mailboxesId = await requireDatabaseId(client, MAILBOXES_MODULE_ID);
        const foldersId = await requireDatabaseId(client, FOLDERS_MODULE_ID);
        const mailbox = await createItemWithClient(client, {
          databaseId: mailboxesId,
          properties: { name: "Mailbox", provider: "generic" },
        });
        const inboxItemId = await ensureFolderItem(client, {
          foldersDatabaseId: foldersId,
          mailboxItemId: mailbox.id,
          mailboxRelationPropertyId: await requirePropertyId(client, foldersId, "mailbox"),
          providerId: "INBOX",
          name: "INBOX",
          behavior: "folder",
          specialPurpose: "inbox",
        });
        return {
          mailboxItemId: mailbox.id,
          inboxItemId,
          filesId: await requireDatabaseId(client, FILES_MODULE_ID),
          folderPropertyId: await requirePropertyId(client, c.emailsId, "folder"),
          attachmentsPropertyId: await requirePropertyId(client, c.emailsId, "attachments"),
        };
      }),
    );
    const alice = await runInTenant(tenantA, async () => {
      const person = await chokePoint.createItem({
        databaseId: c.peopleId,
        properties: { name: "Alice", emails: "alice@example.com" },
      });
      await withTransaction(pool, (client) => reindexPersonEmails(client, person.id, ["alice@example.com"]));
      return person.id;
    });
    const ingest = (messageId: string, date: Date) =>
      runInTenant(tenantA, async () => {
        const { itemId } = await withTransaction(pool, (client) =>
          ingestEmailMessage(client, {
            emailsDatabaseId: c.emailsId,
            filesDatabaseId: mail.filesId,
            folderRelationPropertyId: mail.folderPropertyId,
            attachmentsRelationPropertyId: mail.attachmentsPropertyId,
            folderItemId: mail.inboxItemId,
            mailboxItemId: mail.mailboxItemId,
            messageId,
            subject: messageId,
            date,
            envelope: { from: { address: "alice@example.com" }, to: [{ address: "bob@example.com" }] },
            bodyText: "hi",
            attachments: [],
            storage: unusedStorage,
            storageKeyPrefix: "test",
          }),
        );
        // The production `mail.linkPeopleByEmail` action, as the Emails onItemEvent heartbeat runs it.
        await createLinkEmailToPeopleAction(pool)(
          { emailsDatabaseId: c.emailsId, senderPeopleKey: "senderPeople", recipientsPeopleKey: "recipientsPeople" },
          { heartbeatId: "hb", projectItemId: "proj", itemId },
        );
        return itemId;
      });

    const year = Number(today(ZONE).slice(0, 4)) - 1;
    // 23:30 UTC is already the next day in Prague (UTC+2 in October).
    const first = await ingest("<first@example.com>", new Date(`${year}-10-15T23:30:00.000Z`));
    await runRecomputes();
    expect(await lastContactOf(tenantA, c, alice)).toBe(`${year}-10-16`);

    await ingest("<second@example.com>", new Date(`${year}-11-02T09:00:00.000Z`));
    await runRecomputes();
    expect(await lastContactOf(tenantA, c, alice)).toBe(`${year}-11-02`);

    // The mail owner moves the first message's date past the second's.
    await runInTenant(tenantA, () =>
      withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          { databaseId: c.emailsId, itemId: first, propertiesPatch: { date: `${year}-12-01T08:00:00.000Z` } },
          { allowedSystemKeys: ["date"] },
        ),
      ),
    );
    expect((await queuedRecomputes()).map((job) => job.key)).toEqual([peopleLastContactJobKey(alice)]);
    await runRecomputes();
    expect(await lastContactOf(tenantA, c, alice)).toBe(`${year}-12-01`);
  });

  it("a transcript speaker counts, and a trashed or future source never does", async () => {
    const c = await catalog(tenantA);
    const person = await createPerson(tenantA, c);
    const past = dayFromToday(-9);
    const transcript = await runInTenant(tenantA, () =>
      withTransaction(pool, async (client) => {
        const created = await createItemWithClient(client, {
          databaseId: c.transcriptsId,
          properties: { name: "Call" },
        });
        // The transcription process's own writers: the segments cache and the recording time.
        await writeComputed(client, c.transcriptsId, created.id, "segments", [
          { speaker: "SPEAKER_00", text: "Hello", startsAt: 0, endsAt: 1 },
        ]);
        await updateItemWithClient(
          client,
          { databaseId: c.transcriptsId, itemId: created.id, propertiesPatch: { date: `${past}T10:00:00.000Z` } },
          { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
        );
        await createRelationWithClient(client, {
          relationPropertyId: c.speakersPropertyId,
          callerItemId: created.id,
          targetItemId: person,
          metadata: { speaker: "SPEAKER_00" },
        });
        return created.id;
      }),
    );
    await runRecomputes();
    expect(await lastContactOf(tenantA, c, person)).toBe(past);

    await runInTenant(tenantA, () => chokePoint.softDeleteItem(c.transcriptsId, transcript));
    await linkEvent(tenantA, c, await createEvent(tenantA, c, dayFromToday(4)), person);
    await runRecomputes();
    expect(await lastContactOf(tenantA, c, person)).toBeNull();
  });

  it("a person with no qualifying source has no lastContact", async () => {
    const c = await catalog(tenantA);
    const person = await createPerson(tenantA, c);
    await runInTenant(tenantA, () => recomputePersonLastContact(pool, person));
    expect(await lastContactOf(tenantA, c, person)).toBeUndefined();
  });

  it("a user write of lastContact, and a system writer naming another owner process, are refused with 403", async () => {
    const c = await catalog(tenantA);
    const person = await createPerson(tenantA, c);
    const refused = { status: 403, code: "owner_violation" };
    await expect(
      runInTenant(tenantA, () =>
        chokePoint.updateItem({
          databaseId: c.peopleId,
          itemId: person,
          propertiesPatch: { lastContact: "2020-01-01" },
        }),
      ),
    ).rejects.toMatchObject(refused);
    await expect(
      runInTenant(tenantA, () =>
        chokePoint.createItem({ databaseId: c.peopleId, properties: { name: "New", lastContact: "2020-01-01" } }),
      ),
    ).rejects.toMatchObject(refused);
    await expect(
      runInTenant(tenantA, () =>
        withTransaction(pool, (client) =>
          updateItemWithClient(
            client,
            { databaseId: c.peopleId, itemId: person, propertiesPatch: { lastContact: "2020-01-01" } },
            { allowedSystemKeys: ["lastContact"], systemOwnerProcess: EMAILS_MODULE_ID },
          ),
        ),
      ),
    ).rejects.toMatchObject(refused);
    expect(await lastContactOf(tenantA, c, person)).toBeUndefined();
  });

  it("an edge write that rolls back queues no recompute", async () => {
    const c = await catalog(tenantA);
    const person = await createPerson(tenantA, c);
    const event = await createEvent(tenantA, c, dayFromToday(-2));
    await discardQueuedJobs();
    const rollback = new Error("roll back");
    await expect(
      runInTenant(tenantA, () =>
        withTransaction(pool, async (client) => {
          await createRelationWithClient(client, {
            relationPropertyId: c.eventsPeoplePropertyId,
            callerItemId: event,
            targetItemId: person,
          });
          throw rollback;
        }),
      ),
    ).rejects.toBe(rollback);
    expect(await queuedRecomputes()).toEqual([]);
  });

  it("a recompute in tenant A never reads or writes tenant B", async () => {
    const a = await catalog(tenantA);
    const b = await catalog(tenantB);
    const personA = await createPerson(tenantA, a, "A");
    const personB = await createPerson(tenantB, b, "B");
    const dateA = dayFromToday(-3);
    const dateB = dayFromToday(-7);
    await linkEvent(tenantA, a, await createEvent(tenantA, a, dateA), personA);
    await linkEvent(tenantB, b, await createEvent(tenantB, b, dateB), personB);
    await runRecomputes();
    expect(await lastContactOf(tenantA, a, personA)).toBe(dateA);
    expect(await lastContactOf(tenantB, b, personB)).toBe(dateB);

    const snapshotB = () =>
      runInTenant(tenantB, async () => {
        const { rows } = await pool.query<{ id: string; properties: unknown; updated_at: Date }>(
          "SELECT id, properties, updated_at FROM items WHERE database_id = $1 ORDER BY id",
          [b.peopleId],
        );
        return rows;
      });
    const before = await snapshotB();
    // B's person id inside A, and A's person id inside B: neither tenant can reach the other's row.
    await runInTenant(tenantA, () => recomputePersonLastContact(pool, personB));
    await runInTenant(tenantB, () => recomputePersonLastContact(pool, personA));
    await runInTenant(tenantA, () => recomputePersonLastContact(pool, personA));
    expect(await snapshotB()).toEqual(before);
    expect(await lastContactOf(tenantA, a, personA)).toBe(dateA);
    expect(await queuedRecomputes()).toEqual([]);
  });
});

/** A tenant provisioned before issue #1660: its People database has no lastContact property. */
async function removeLastContactProperty(tenant: string, peopleId: string): Promise<void> {
  // The seed now creates the property and no public writer removes a system property, so a
  // pre-#1660 People database is produced by deleting the row directly.
  await admin.query("DELETE FROM properties WHERE tenant_id = $1 AND database_id = $2 AND key = 'lastContact'", [
    tenant,
    peopleId,
  ]);
}

async function lastContactProperties(tenant: string, peopleId: string) {
  return runInTenant(tenant, async () => {
    const { rows } = await pool.query<{ type: string; owner: string; owner_process: string | null; config: unknown }>(
      "SELECT type, owner, owner_process, config FROM properties WHERE database_id = $1 AND key = 'lastContact'",
      [peopleId],
    );
    return rows;
  });
}

describe("People lastContact cutover (issue #1660)", () => {
  it("run twice on a populated tenant, adds the property once and recomputes every live person; B is untouched", async () => {
    const a = await catalog(tenantA);
    const b = await catalog(tenantB);
    const dateA = dayFromToday(-4);
    const linked = await createPerson(tenantA, a, "Linked");
    await linkEvent(tenantA, a, await createEvent(tenantA, a, dateA), linked);
    const unlinked = await createPerson(tenantA, a, "Unlinked");
    const trashed = await createPerson(tenantA, a, "Trashed");
    await runInTenant(tenantA, () => chokePoint.softDeleteItem(a.peopleId, trashed));
    const personB = await createPerson(tenantB, b, "B");
    await linkEvent(tenantB, b, await createEvent(tenantB, b, dayFromToday(-6)), personB);
    await removeLastContactProperty(tenantA, a.peopleId);
    await discardQueuedJobs();

    await runInTenant(tenantA, () => runPeopleLastContactCutoverMigration(pool));
    await runInTenant(tenantA, () => runPeopleLastContactCutoverMigration(pool));

    expect(await lastContactProperties(tenantA, a.peopleId)).toEqual([
      { type: "date", owner: "system", owner_process: PEOPLE_MODULE_ID, config: {} },
    ]);
    expect(await queuedRecomputes()).toEqual(
      [linked, unlinked]
        .sort()
        .map((id) => ({ key: peopleLastContactJobKey(id), queue_name: `people-last-contact:${tenantA}` })),
    );
    await runRecomputes();
    expect(await lastContactOf(tenantA, a, linked)).toBe(dateA);
    expect(await lastContactOf(tenantA, a, unlinked)).toBeUndefined();
    expect(await lastContactOf(tenantB, b, personB)).toBeUndefined();
  });

  it("hands an existing compatible date property to the people process; a user write is then refused", async () => {
    const a = await catalog(tenantA);
    const person = await createPerson(tenantA, a);
    // A user-owned `lastContact` date property with its own config, as a populated install could hold
    // before #1660; no public writer adds a property to the schema-locked People database.
    await admin.query(
      `UPDATE properties SET owner = 'user', owner_process = NULL, config = '{"includeTime": false}'::jsonb
       WHERE tenant_id = $1 AND database_id = $2 AND key = 'lastContact'`,
      [tenantA, a.peopleId],
    );
    await runInTenant(tenantA, () =>
      chokePoint.updateItem({ databaseId: a.peopleId, itemId: person, propertiesPatch: { lastContact: "2020-01-01" } }),
    );
    await discardQueuedJobs();

    await runInTenant(tenantA, () => runPeopleLastContactCutoverMigration(pool));

    expect(await lastContactProperties(tenantA, a.peopleId)).toEqual([
      { type: "date", owner: "system", owner_process: PEOPLE_MODULE_ID, config: { includeTime: false } },
    ]);
    expect(await lastContactOf(tenantA, a, person)).toBe("2020-01-01");
    await expect(
      runInTenant(tenantA, () =>
        chokePoint.updateItem({
          databaseId: a.peopleId,
          itemId: person,
          propertiesPatch: { lastContact: "2021-01-01" },
        }),
      ),
    ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
    await runRecomputes();
    expect(await lastContactOf(tenantA, a, person)).toBeNull();
  });

  it("fails a tenant whose lastContact is not a date before writing or queuing anything", async () => {
    const a = await catalog(tenantA);
    await createPerson(tenantA, a);
    // An incompatible populated state: a text property under the key, which only direct SQL produces now.
    await admin.query(
      `UPDATE properties SET type = 'text', owner = 'user', owner_process = NULL
       WHERE tenant_id = $1 AND database_id = $2 AND key = 'lastContact'`,
      [tenantA, a.peopleId],
    );
    await discardQueuedJobs();

    await expect(runInTenant(tenantA, () => runPeopleLastContactCutoverMigration(pool))).rejects.toThrow(
      "The People lastContact property has type 'text', not 'date'",
    );
    expect(await lastContactProperties(tenantA, a.peopleId)).toEqual([
      { type: "text", owner: "user", owner_process: null, config: {} },
    ]);
    expect(await queuedRecomputes()).toEqual([]);
  });

  it("is registered in runTenantCutoverMigrations and restores the property in every tenant", async () => {
    const a = await catalog(tenantA);
    const b = await catalog(tenantB);
    await removeLastContactProperty(tenantA, a.peopleId);
    await removeLastContactProperty(tenantB, b.peopleId);

    await runAsSystem("test:cutovers", () => runTenantCutoverMigrations(pool));

    for (const [tenant, peopleId] of [
      [tenantA, a.peopleId],
      [tenantB, b.peopleId],
    ] as const) {
      expect(await lastContactProperties(tenant, peopleId)).toEqual([
        { type: "date", owner: "system", owner_process: PEOPLE_MODULE_ID, config: {} },
      ]);
    }
  });
});
