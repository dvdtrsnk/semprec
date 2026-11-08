import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Notification, Pool, PoolClient } from "pg";
import { DateTime } from "luxon";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, enqueueJob, runOnce, type TaskList } from "@semprec/queue";
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
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import {
  enqueuePersonLastContactRecompute,
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
 * security applies; the recompute and the sweep run through the production `createCoreTaskList` handlers
 * drained with `runOnce`, except where a case needs a clock other than the real one (the sweep's next day, an
 * Event's start later today), which calls `recomputePersonLastContact` or `handlePeopleLastContactSweep` with
 * that `now`, the job's own entry point.
 */

let admin: Pool;
let pool: Pool;
let chokePoint: ChokePoint;
let recomputeTaskList: TaskList;
let sweepTaskList: TaskList;
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

/** Every queued job of any task, read through graphile-worker's public `jobs` view. */
async function allQueuedJobs(): Promise<{ task_identifier: string; key: string | null }[]> {
  const { rows } = await admin.query<{ task_identifier: string; key: string | null }>(
    "SELECT task_identifier, key FROM graphile_worker.jobs ORDER BY id",
  );
  return rows;
}

/**
 * One item's whole stored row and its tuple version. `xmin` changes on every UPDATE, even one that writes
 * equal values, so an unchanged pair shows that no write reached the row. Read on the runtime pool in `tenant`.
 */
async function storedItem(tenant: string, itemId: string): Promise<{ row: unknown; xmin: string }> {
  const { rows } = await runInTenant(tenant, () =>
    pool.query<{ row: unknown; xmin: string }>(
      "SELECT to_jsonb(i) AS row, i.xmin::text AS xmin FROM items i WHERE i.id = $1",
      [itemId],
    ),
  );
  const stored = rows[0];
  if (!stored) throw new Error("item not found");
  return stored;
}

/** Rejects with a message naming `what` when `work` has not settled within `ms`; the timer is cleared either way. */
async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

type Outcome = { failed: false } | { failed: true; error: unknown };

/** `work`'s outcome as a value, so a started actor is observed from the start and read when the case is ready. */
function outcomeOf(work: Promise<unknown>): Promise<Outcome> {
  return work.then(
    (): Outcome => ({ failed: false }),
    (error: unknown): Outcome => ({ failed: true, error }),
  );
}

/** Reads `probe` until it returns a value, failing after `ms`. */
async function pollFor<T>(probe: () => Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`${what} was not observed within ${ms} ms`);
    await sleep(20);
  }
}

/**
 * Rethrows the case's own failure first: alone, or inside an `AggregateError` with the cleanup failures after it.
 * A thrown falsy value counts, because `primary` wraps it.
 */
function settle(primary: { error: unknown } | undefined, cleanupFailures: unknown[]): void {
  if (primary && cleanupFailures.length > 0) {
    throw new AggregateError([primary.error, ...cleanupFailures], "The case and its cleanup failed", {
      cause: primary.error,
    });
  }
  if (primary) throw primary.error;
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length > 1) throw new AggregateError(cleanupFailures, "The case's cleanup failed");
}

interface ObservedEffects {
  /** Every realtime invalidation this process emitted: the in-process hook `@semprec/realtime` publishes as NOTIFYs. */
  invalidations: InvalidationEvent[];
  /** The payload of every graphile-worker `jobs:insert` NOTIFY, the one any job enqueue sends, before the sentinel. */
  jobInserts: string[];
}

/**
 * The side effects `operation` announced. Realtime invalidations are recorded through `setInvalidationHook`,
 * because this package's tests wire no realtime publisher, so no realtime NOTIFY could reach a listener here.
 * Job enqueues are observed on a dedicated LISTEN connection subscribed before `operation` runs; afterwards a
 * sentinel is sent on the same channel, and Postgres delivers notifications in commit order, so once the
 * sentinel has arrived every `jobs:insert` committed by `operation` has too. The hook and the subscription are
 * removed on every path, and a connection whose UNLISTEN failed is destroyed rather than returned to the pool.
 */
async function observeEffects(operation: () => Promise<unknown>): Promise<ObservedEffects> {
  const effects: ObservedEffects = { invalidations: [], jobInserts: [] };
  const sentinel = JSON.stringify({ sentinel: randomUUID() });
  let sentinelSeen: () => void = () => undefined;
  const sentinelArrived = new Promise<void>((resolve) => {
    sentinelSeen = resolve;
  });
  const onNotification = (message: Notification) => {
    if (message.channel !== "jobs:insert") return;
    if (message.payload === sentinel) sentinelSeen();
    else effects.jobInserts.push(message.payload ?? "");
  };
  const listener = await admin.connect();
  listener.on("notification", onNotification);
  let listening = false;
  let primary: { error: unknown } | undefined;
  try {
    await listener.query('LISTEN "jobs:insert"');
    listening = true;
    setInvalidationHook((event) => effects.invalidations.push(event));
    await operation();
    await admin.query("SELECT pg_notify('jobs:insert', $1)", [sentinel]);
    await within(sentinelArrived, 10_000, "The sentinel NOTIFY");
  } catch (error) {
    primary = { error };
  }
  const failures: unknown[] = [];
  setInvalidationHook(() => {});
  listener.off("notification", onNotification);
  let destroyWith: Error | undefined;
  if (listening) {
    try {
      await listener.query('UNLISTEN "jobs:insert"');
    } catch (error) {
      failures.push(error);
      destroyWith = new Error("UNLISTEN failed; the connection is destroyed");
    }
  }
  listener.release(destroyWith);
  settle(primary, failures);
  return effects;
}

/**
 * A mailbox with its inbox in `tenant`, and an ingest there of one message, followed by the production
 * `mail.linkPeopleByEmail` action as the Emails onItemEvent heartbeat runs it. Returns the Emails item id.
 */
async function mailIngest(
  tenant: string,
  c: Catalog,
): Promise<(input: { messageId: string; date: Date; from: string; to: string }) => Promise<string>> {
  const mail = await runInTenant(tenant, () =>
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
  return (input) =>
    runInTenant(tenant, async () => {
      const { itemId } = await withTransaction(pool, (client) =>
        ingestEmailMessage(client, {
          emailsDatabaseId: c.emailsId,
          filesDatabaseId: mail.filesId,
          folderRelationPropertyId: mail.folderPropertyId,
          attachmentsRelationPropertyId: mail.attachmentsPropertyId,
          folderItemId: mail.inboxItemId,
          mailboxItemId: mail.mailboxItemId,
          messageId: input.messageId,
          subject: input.messageId,
          date: input.date,
          envelope: { from: { address: input.from }, to: [{ address: input.to }] },
          bodyText: "hi",
          attachments: [],
          storage: unusedStorage,
          storageKeyPrefix: "test",
        }),
      );
      await createLinkEmailToPeopleAction(pool)(
        { emailsDatabaseId: c.emailsId, senderPeopleKey: "senderPeople", recipientsPeopleKey: "recipientsPeople" },
        { heartbeatId: "hb", projectItemId: "proj", itemId },
      );
      return itemId;
    });
}

/** A transcript dated `date` at 10:00 UTC, written by the transcription owner, with `personId` as its speaker. */
async function createTranscriptWithSpeaker(
  tenant: string,
  c: Catalog,
  date: string,
  personId: string,
): Promise<string> {
  return runInTenant(tenant, () =>
    withTransaction(pool, async (client) => {
      const created = await createItemWithClient(client, { databaseId: c.transcriptsId, properties: { name: "Call" } });
      await writeComputed(client, c.transcriptsId, created.id, "segments", [
        { speaker: "SPEAKER_00", text: "Hello", startsAt: 0, endsAt: 1 },
      ]);
      await updateItemWithClient(
        client,
        { databaseId: c.transcriptsId, itemId: created.id, propertiesPatch: { date: `${date}T10:00:00.000Z` } },
        { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
      );
      await createRelationWithClient(client, {
        relationPropertyId: c.speakersPropertyId,
        callerItemId: created.id,
        targetItemId: personId,
        metadata: { speaker: "SPEAKER_00" },
      });
      return created.id;
    }),
  );
}

beforeAll(async () => {
  admin = getTestPool();
  pool = await createRuntimeRolePool(admin, "semprec_data");
  chokePoint = createChokePoint(pool);
  const full = createCoreTaskList(pool, createActionRegistry());
  const recompute = full[CORE_TASK_NAMES.PEOPLE_LAST_CONTACT_RECOMPUTE];
  if (!recompute) throw new Error("createCoreTaskList has no peopleLastContactRecompute handler");
  recomputeTaskList = { [CORE_TASK_NAMES.PEOPLE_LAST_CONTACT_RECOMPUTE]: recompute };
  const sweep = full[CORE_TASK_NAMES.PEOPLE_LAST_CONTACT_SWEEP];
  if (!sweep) throw new Error("createCoreTaskList has no peopleLastContactSweep handler");
  sweepTaskList = { [CORE_TASK_NAMES.PEOPLE_LAST_CONTACT_SWEEP]: sweep };
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

  it("an email linked to a person through recipientsPeople sets lastContact to its date in the tenant zone", async () => {
    const c = await catalog(tenantA);
    const bob = await runInTenant(tenantA, async () => {
      const person = await chokePoint.createItem({
        databaseId: c.peopleId,
        properties: { name: "Bob", emails: "bob@example.com" },
      });
      await withTransaction(pool, (client) => reindexPersonEmails(client, person.id, ["bob@example.com"]));
      return person.id;
    });
    await discardQueuedJobs();
    const ingest = await mailIngest(tenantA, c);
    const year = Number(today(ZONE).slice(0, 4)) - 1;
    // From someone who is no person, to Bob: only the recipients relation can link him.
    const email = await ingest({
      messageId: "<to-bob@example.com>",
      date: new Date(`${year}-10-15T23:30:00.000Z`),
      from: "carol@example.com",
      to: "bob@example.com",
    });

    const linked = await runInTenant(tenantA, () => chokePoint.listItemRelations(email));
    expect(linked?.map(({ propertyKey, targetItemId }) => ({ propertyKey, targetItemId }))).toContainEqual({
      propertyKey: "recipientsPeople",
      targetItemId: bob,
    });
    expect(linked?.filter((entry) => entry.propertyKey === "senderPeople")).toEqual([]);
    expect(await queuedRecomputes()).toEqual([
      { key: peopleLastContactJobKey(bob), queue_name: `people-last-contact:${tenantA}` },
    ]);
    await runRecomputes();
    // 23:30 UTC on 15 October is already 16 October in Prague.
    expect(await lastContactOf(tenantA, c, bob)).toBe(`${year}-10-16`);
  });

  it("an event's date patch requeues its people and moves lastContact to the new date", async () => {
    const c = await catalog(tenantA);
    const person = await createPerson(tenantA, c);
    const first = dayFromToday(-10);
    const second = dayFromToday(-2);
    const event = await createEvent(tenantA, c, first);
    await linkEvent(tenantA, c, event, person);
    await runRecomputes();
    expect(await lastContactOf(tenantA, c, person)).toBe(first);

    await runInTenant(tenantA, () =>
      chokePoint.updateItem({ databaseId: c.eventsId, itemId: event, propertiesPatch: { date: second } }),
    );
    expect(await queuedRecomputes()).toEqual([
      { key: peopleLastContactJobKey(person), queue_name: `people-last-contact:${tenantA}` },
    ]);
    await runRecomputes();
    expect(await lastContactOf(tenantA, c, person)).toBe(second);
  });

  it("a transcript's date patch by the transcription owner requeues its speakers and moves lastContact", async () => {
    const c = await catalog(tenantA);
    const person = await createPerson(tenantA, c);
    const first = dayFromToday(-9);
    const second = dayFromToday(-3);
    const transcript = await createTranscriptWithSpeaker(tenantA, c, first, person);
    await runRecomputes();
    expect(await lastContactOf(tenantA, c, person)).toBe(first);

    await runInTenant(tenantA, () =>
      withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          { databaseId: c.transcriptsId, itemId: transcript, propertiesPatch: { date: `${second}T10:00:00.000Z` } },
          { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
        ),
      ),
    );
    expect(await queuedRecomputes()).toEqual([
      { key: peopleLastContactJobKey(person), queue_name: `people-last-contact:${tenantA}` },
    ]);
    await runRecomputes();
    expect(await lastContactOf(tenantA, c, person)).toBe(second);
  });

  it("a recompute that finds the stored date current writes nothing, queues nothing and emits nothing", async () => {
    const c = await catalog(tenantA);
    const person = await createPerson(tenantA, c);
    const date = dayFromToday(-5);
    await linkEvent(tenantA, c, await createEvent(tenantA, c, date), person);
    await runRecomputes();
    expect(await lastContactOf(tenantA, c, person)).toBe(date);
    await discardQueuedJobs();
    // A second recompute of the same person, queued by the production enqueue before the observation starts.
    await runInTenant(tenantA, () =>
      withTransaction(pool, (client) => enqueuePersonLastContactRecompute(client, person)),
    );
    const before = await storedItem(tenantA, person);

    const effects = await observeEffects(() => runRecomputes());

    expect(effects).toEqual({ invalidations: [], jobInserts: [] });
    expect(await storedItem(tenantA, person)).toEqual(before);
    expect(await allQueuedJobs()).toEqual([]);
  });

  it("a recompute of a trashed person is a no-op that leaves the trashed row as it is", async () => {
    const c = await catalog(tenantA);
    const person = await createPerson(tenantA, c);
    const date = dayFromToday(-5);
    await linkEvent(tenantA, c, await createEvent(tenantA, c, date), person);
    await runRecomputes();
    // A newer source the recompute would otherwise pick up, linked while the person is live.
    await linkEvent(tenantA, c, await createEvent(tenantA, c, dayFromToday(-1)), person);
    await runInTenant(tenantA, () => chokePoint.softDeleteItem(c.peopleId, person));
    await discardQueuedJobs();
    await runInTenant(tenantA, () =>
      withTransaction(pool, (client) => enqueuePersonLastContactRecompute(client, person)),
    );
    const before = await storedItem(tenantA, person);
    expect(before.row).toMatchObject({ deleted_at: expect.any(String), properties: { lastContact: date } });

    // `runRecomputes` fails when the job fails, since a failed job stays queued for its retry.
    const effects = await observeEffects(() => runRecomputes());

    expect(effects).toEqual({ invalidations: [], jobInserts: [] });
    expect(await storedItem(tenantA, person)).toEqual(before);
    expect(await allQueuedJobs()).toEqual([]);
  });

  it("the registered sweep queues every person of a source dated within the last day, across sweep batches and in each person's tenant", async () => {
    const a = await catalog(tenantA);
    const b = await catalog(tenantB);
    // An hour before the sweep, which runs at the actual time; the minute is truncated, so never later than now.
    const hourAgo = DateTime.now().setZone(ZONE).minus({ hours: 1 });
    const date = hourAgo.toISODate();
    if (date === null) throw new Error("invalid day");
    const start = { date, timeFrom: hourAgo.toFormat("HH:mm") };
    // 501 edges of one Event: one more than a sweep batch holds, so the sweep needs two batches.
    const peopleA = await runInTenant(tenantA, () =>
      withTransaction(pool, async (client) => {
        const event = await createItemWithClient(client, {
          databaseId: a.eventsId,
          properties: { name: "All hands", ...start },
        });
        const ids: string[] = [];
        for (let index = 0; index < 501; index += 1) {
          const person = await createItemWithClient(client, {
            databaseId: a.peopleId,
            properties: { name: `Attendee ${index}` },
          });
          await createRelationWithClient(client, {
            relationPropertyId: a.eventsPeoplePropertyId,
            callerItemId: event.id,
            targetItemId: person.id,
          });
          ids.push(person.id);
        }
        return ids;
      }),
    );
    const personB = await createPerson(tenantB, b, "B");
    await linkEvent(tenantB, b, await createEvent(tenantB, b, start.date, { timeFrom: start.timeFrom }), personB);
    await discardQueuedJobs();

    await runAsSystem("test:people-last-contact-sweep", () =>
      enqueueJob(pool, CORE_TASK_NAMES.PEOPLE_LAST_CONTACT_SWEEP, {}),
    );
    await runOnce({ pgPool: admin, taskList: sweepTaskList });

    const byKey = (left: QueuedJob, right: QueuedJob) => (left.key ?? "").localeCompare(right.key ?? "");
    expect((await queuedRecomputes()).sort(byKey)).toEqual(
      [
        ...peopleA.map((id) => ({ key: peopleLastContactJobKey(id), queue_name: `people-last-contact:${tenantA}` })),
        { key: peopleLastContactJobKey(personB), queue_name: `people-last-contact:${tenantB}` },
      ].sort(byKey),
    );
    expect(new Set(peopleA).size).toBe(501);
    expect(
      (await allQueuedJobs()).filter((job) => job.task_identifier === CORE_TASK_NAMES.PEOPLE_LAST_CONTACT_SWEEP),
    ).toEqual([]);
  });

  it("a recompute waiting on the person's row lock reads the sources committed while it waited", async () => {
    const c = await catalog(tenantA);
    const person = await createPerson(tenantA, c);
    const older = dayFromToday(-20);
    const newer = dayFromToday(-4);
    await linkEvent(tenantA, c, await createEvent(tenantA, c, older), person);
    const newerEvent = await createEvent(tenantA, c, newer);
    expect((await queuedRecomputes()).map((job) => job.key)).toEqual([peopleLastContactJobKey(person)]);

    // A lock-only admin transaction: FOR NO KEY UPDATE conflicts with the recompute's FOR UPDATE of the person,
    // but not with the FOR KEY SHARE that a new edge's foreign key check takes on it.
    const holder = await admin.connect();
    let holding = false;
    let recompute: Promise<Outcome> | undefined;
    let linking: Promise<Outcome> | undefined;
    // The actors whose outcome the case itself already read.
    const read = new Set<Promise<Outcome>>();
    let primary: { error: unknown } | undefined;
    try {
      await holder.query("BEGIN");
      holding = true;
      const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      if (pid === undefined) throw new Error("no holder pid");
      const locked = await holder.query("SELECT id FROM items WHERE id = $1 FOR NO KEY UPDATE", [person]);
      expect(locked.rowCount).toBe(1);

      recompute = outcomeOf(runOnce({ pgPool: admin, taskList: recomputeTaskList }));
      const blocked = await pollFor(
        async () => {
          const { rows } = await admin.query<{ pid: number }>(
            "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
            [pid],
          );
          return rows.length > 0 ? rows.map((row) => row.pid) : undefined;
        },
        10_000,
        "A backend blocked by the held person row",
      );
      // Exactly one other backend, the recompute's, waits on this holder.
      expect(blocked).toHaveLength(1);
      expect(blocked[0]).not.toBe(pid);

      linking = outcomeOf(linkEvent(tenantA, c, newerEvent, person));
      const linked = await within(linking, 10_000, "Linking the newer event while the person is held");
      read.add(linking);
      if (linked.failed) throw linked.error;
      // The link requeued the person as a new job beside the running one; that one is completed unrun, so only
      // the waiting recompute can store the newer date.
      expect((await queuedRecomputes()).filter((job) => job.key === peopleLastContactJobKey(person))).toHaveLength(1);
      await discardQueuedJobs();

      await holder.query("COMMIT");
      holding = false;
      const recomputed = await within(recompute, 10_000, "The waiting recompute");
      read.add(recompute);
      if (recomputed.failed) throw recomputed.error;
      expect(await lastContactOf(tenantA, c, person)).toBe(newer);
      expect(await queuedRecomputes()).toEqual([]);
    } catch (error) {
      primary = { error };
    }
    const failures: unknown[] = [];
    if (holding) {
      try {
        await holder.query("ROLLBACK");
      } catch (error) {
        failures.push(error);
      }
    }
    holder.release(
      failures.length > 0 ? new Error("The holder's ROLLBACK failed; its connection is destroyed") : undefined,
    );
    // Every started actor settles before the pools can end; one that does not, or fails unread, is a failure.
    for (const [actor, what] of [
      [recompute, "The waiting recompute"],
      [linking, "Linking the newer event"],
    ] as const) {
      if (!actor || read.has(actor)) continue;
      try {
        const outcome = await within(actor, 10_000, what);
        if (outcome.failed) failures.push(outcome.error);
      } catch (error) {
        failures.push(error);
      }
    }
    settle(primary, failures);
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

  it("fails a tenant whose lastContact is not a date before writing, queuing or emitting anything", async () => {
    const a = await catalog(tenantA);
    const person = await createPerson(tenantA, a);
    // An incompatible populated state: a text property under the key, which only direct SQL produces now.
    await admin.query(
      `UPDATE properties SET type = 'text', owner = 'user', owner_process = NULL
       WHERE tenant_id = $1 AND database_id = $2 AND key = 'lastContact'`,
      [tenantA, a.peopleId],
    );
    await discardQueuedJobs();
    const before = await storedItem(tenantA, person);

    const effects = await observeEffects(() =>
      expect(runInTenant(tenantA, () => runPeopleLastContactCutoverMigration(pool))).rejects.toThrow(
        "The People lastContact property has type 'text', not 'date'",
      ),
    );
    expect(effects).toEqual({ invalidations: [], jobInserts: [] });
    expect(await lastContactProperties(tenantA, a.peopleId)).toEqual([
      { type: "text", owner: "user", owner_process: null, config: {} },
    ]);
    expect(await storedItem(tenantA, person)).toEqual(before);
    expect(await queuedRecomputes()).toEqual([]);
    expect(await allQueuedJobs()).toEqual([]);
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
