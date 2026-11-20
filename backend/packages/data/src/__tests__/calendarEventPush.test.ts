import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createUser } from "../auth/usersStore.js";
import { createEventInCalendar } from "../calendar/defaultCalendarCreateHook.js";
import {
  CalendarSyncReauthorizationRequiredError,
  CalendarSyncProviderError,
  type RemoteEvent,
} from "../calendar/sync/adapter.js";
import { handleCalendarAccountSyncTask } from "../calendar/sync/calendarAccountSyncJob.js";
import { resolveCalendarSyncIds, type CalendarSyncIds } from "../calendar/sync/calendarSyncStore.js";
import { mergeEventFields } from "../calendar/sync/eventMerge.js";
import { handleCalendarEventPushTask, MAX_EVENT_PUSH_ATTEMPTS } from "../calendar/sync/eventPushJob.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { itemDeleteWithClient, restoreItemWithClient } from "../chokePoint/itemTrash.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { deleteRelationWithClient, createRelationWithClient } from "../chokePoint/relationOps.js";
import { CALENDAR_SYNC_WRITER, type WriterIdentity } from "../chokePoint/writerKind.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { ensureMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { seedSystem } from "../seed/seedSystem.js";
import { FakeCalendarProvider, remoteFields } from "../testSupport/fakeCalendarSyncAdapter.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const USER: WriterIdentity = { writerKind: "user" };
const AGENT: WriterIdentity = { writerKind: "agent", onBehalfOfUserId: randomUUID() };
/** An agent's trash as the approved replay executes it. */
const APPROVED_AGENT: WriterIdentity = {
  writerKind: "agent",
  agentRunId: randomUUID(),
  agentProjectItemId: randomUUID(),
  approvedRequestId: randomUUID(),
};

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;

function inTenant<T>(fn: (client: PoolClient) => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(runtime, fn));
}

async function ids(tenantId = tenant): Promise<CalendarSyncIds> {
  const resolved = await inTenant((client) => resolveCalendarSyncIds(client), tenantId);
  if (resolved === null) throw new Error("the tenant has no calendar databases");
  return resolved;
}

/** A Friday Event inside every sync window of this suite. */
function remoteEvent(remoteId: string, overrides: Partial<RemoteEvent> = {}): RemoteEvent {
  return {
    remoteId,
    href: null,
    etag: `"${remoteId}-1"`,
    seriesRemoteId: null,
    fields: remoteFields({
      name: "Dinner",
      date: "2026-11-27",
      timeFrom: "19:00",
      timeTo: "21:00",
      timeZone: "Europe/Prague",
    }),
    organizer: null,
    attendees: [],
    ...overrides,
  };
}

/** `family` and `work` are writable, `shared` is read-only; `family` holds the Dinner. */
function provider(): FakeCalendarProvider {
  const fake = new FakeCalendarProvider();
  for (const [remoteId, readOnly] of [
    ["family", false],
    ["work", false],
    ["shared", true],
  ] as const) {
    fake.addCalendar({ remoteId, url: null, name: remoteId, color: null, readOnly, ctag: null });
  }
  fake.putEvent("family", remoteEvent("dinner"));
  return fake;
}

function runPass(accountId: string, fake: FakeCalendarProvider, tenantId = tenant) {
  return runInTenant(tenantId, () =>
    handleCalendarAccountSyncTask(runtime, { accountItemId: accountId }, { adapters: fake.registry() }),
  );
}

function runPush(eventItemId: string, fake: FakeCalendarProvider, tenantId = tenant) {
  return runInTenant(tenantId, () =>
    handleCalendarEventPushTask(runtime, { eventItemId }, { adapters: fake.registry() }),
  );
}

async function syncedAccount(fake: FakeCalendarProvider, tenantId = tenant): Promise<string> {
  const { mailboxesDatabaseId } = await ids(tenantId);
  const accountId = await inTenant(async (client) => {
    const account = await createChokePoint(runtime).createItem({
      databaseId: mailboxesDatabaseId,
      properties: { name: "Family account", provider: "generic", mailEnabled: true, calendarsEnabled: true },
    });
    await writeMailboxAddresses(client, { mailboxesDatabaseId, mailboxItemId: account.id, address: "me@example.test" });
    await storeCredential(client, { itemId: account.id, credentialType: "plain_password", plaintext: "s3cret" });
    await ensureMailAccountSyncState(client, { itemId: account.id, syncMode: "imap" });
    return account.id;
  }, tenantId);
  expect((await runPass(accountId, fake, tenantId))?.kind).toBe("applied");
  return accountId;
}

async function calendarOf(remoteId: string): Promise<string> {
  const { rows } = await admin.query<{ calendar_item_id: string }>(
    "SELECT calendar_item_id FROM calendar_remote_state WHERE tenant_id = $1 AND remote_id = $2",
    [tenant, remoteId],
  );
  const id = rows[0]?.calendar_item_id;
  if (id === undefined) throw new Error(`no calendar ${remoteId}`);
  return id;
}

async function eventOf(remoteId: string): Promise<string> {
  const { rows } = await admin.query<{ event_item_id: string }>(
    "SELECT event_item_id FROM event_remote_state WHERE tenant_id = $1 AND remote_id = $2",
    [tenant, remoteId],
  );
  const id = rows[0]?.event_item_id;
  if (id === undefined) throw new Error(`no Event ${remoteId}`);
  return id;
}

const pushRow = z.object({
  operation: z.string(),
  status: z.string(),
  attempts: z.number(),
  last_error_code: z.string().nullable(),
});

async function pushState(eventItemId: string) {
  const { rows } = await admin.query<Record<string, unknown>>(
    "SELECT operation, status, attempts, last_error_code FROM calendar_event_push_state WHERE event_item_id = $1",
    [eventItemId],
  );
  return rows[0] === undefined ? null : pushRow.parse(rows[0]);
}

async function pushJobs(eventItemId: string): Promise<number> {
  const { rows } = await admin.query<{ count: string }>("SELECT count(*) FROM graphile_worker.jobs WHERE key = $1", [
    `calendar-event-push:${eventItemId}`,
  ]);
  return Number(rows[0]?.count ?? 0);
}

async function properties(eventItemId: string): Promise<Record<string, unknown>> {
  const { rows } = await admin.query<{ properties: Record<string, unknown> }>(
    "SELECT properties FROM items WHERE id = $1",
    [eventItemId],
  );
  return rows[0]?.properties ?? {};
}

async function overwrittenNotifications() {
  const { rows } = await admin.query<{ title: string; body: string | null; source_id: string }>(
    "SELECT title, body, source_id FROM notifications WHERE tenant_id = $1 AND kind = 'calendar_change_overwritten'",
    [tenant],
  );
  return rows;
}

function patchEvent(eventItemId: string, patch: Record<string, unknown>, writer = USER) {
  return inTenant(async (client) => {
    const { eventsDatabaseId } = (await resolveCalendarSyncIds(client))!;
    return updateItemWithClient(
      client,
      { databaseId: eventsDatabaseId, itemId: eventItemId, propertiesPatch: patch },
      {
        writer,
      },
    );
  });
}

beforeAll(async () => {
  admin = getTestPool();
  await resetDatabase(admin);
  runtime = await createRuntimeRolePool(admin, "semprec_data");
});

afterAll(async () => {
  await runtime.end();
});

beforeEach(async () => {
  for (const id of [(tenant = await createTestTenant(admin)), (foreign = await createTestTenant(admin))]) {
    await createUser(admin, {
      tenantId: id,
      email: `${randomUUID()}@example.test`,
      passwordHash: "unused",
      locale: "en",
    });
    await runInTenant(id, () => seedSystem(runtime));
  }
});

describe("pushing local changes of synced Events", () => {
  it("creates an Event made in the app at the provider, and the next pass changes nothing", async () => {
    const fake = provider();
    const accountId = await syncedAccount(fake);
    const family = await calendarOf("family");
    const created = await inTenant((client) =>
      createEventInCalendar(
        client,
        { properties: { name: "Swim", date: "2026-11-28", timeFrom: "08:00", timeTo: "09:00", place: "Pool" } },
        family,
        { writer: USER },
      ),
    );
    expect(await pushState(created.id)).toEqual({
      operation: "create",
      status: "pending",
      attempts: 0,
      last_error_code: null,
    });
    expect(await pushJobs(created.id)).toBe(1);

    expect(await runPush(created.id, fake)).toEqual({ kind: "sent", operation: "create" });

    const [swim] = fake.events("family").filter((event) => event.fields.name === "Swim");
    expect(swim?.fields).toEqual(
      remoteFields({
        name: "Swim",
        date: "2026-11-28",
        timeFrom: "08:00",
        timeTo: "09:00",
        timeZone: "Europe/Prague",
        place: "Pool",
      }),
    );
    expect(swim?.remoteId).toBe(created.properties.icalUid);
    expect(await eventOf(swim!.remoteId)).toBe(created.id);
    expect((await pushState(created.id))?.status).toBe("sent");

    const pass = await runPass(accountId, fake);
    expect(pass).toMatchObject({ kind: "applied", added: [], changed: [], cancelled: [] });
    expect(await pushState(created.id)).toMatchObject({ status: "sent" });
  });

  it("records nothing for the calendar sync's own writes, nor for an Event outside account calendars", async () => {
    const fake = provider();
    await syncedAccount(fake);
    const dinner = await eventOf("dinner");
    expect(await pushState(dinner)).toBeNull();
    await patchEvent(dinner, { place: "Garden" }, CALENDAR_SYNC_WRITER);
    expect(await pushState(dinner)).toBeNull();

    const { eventsDatabaseId } = await ids();
    const own = await runInTenant(tenant, () =>
      createChokePoint(runtime).createItem({
        databaseId: eventsDatabaseId,
        properties: { name: "Own", date: "2026-11-28" },
      }),
    );
    await patchEvent(own.id, { name: "Own, renamed" });
    expect(await pushState(own.id)).toBeNull();
  });

  it("keeps both changes when the title changed here and the place at the provider", async () => {
    const fake = provider();
    await syncedAccount(fake);
    const dinner = await eventOf("dinner");
    await patchEvent(dinner, { name: "Family dinner" });
    fake.putEvent(
      "family",
      remoteEvent("dinner", { etag: '"dinner-2"', fields: { ...remoteEvent("dinner").fields, place: "Garden" } }),
    );

    expect(await runPush(dinner, fake)).toEqual({ kind: "merged", overwritten: [] });

    expect(fake.event("family", "dinner").fields).toMatchObject({ name: "Family dinner", place: "Garden" });
    expect(await properties(dinner)).toMatchObject({ name: "Family dinner", place: "Garden" });
    expect(await pushState(dinner)).toMatchObject({ status: "sent" });
    expect(await overwrittenNotifications()).toEqual([]);
  });

  it("lets the provider's title win a title changed on both sides, and says so once", async () => {
    const fake = provider();
    await syncedAccount(fake);
    const dinner = await eventOf("dinner");
    await patchEvent(dinner, { name: "Family dinner", description: "Bring wine" });
    fake.putEvent(
      "family",
      remoteEvent("dinner", {
        etag: '"dinner-2"',
        fields: { ...remoteEvent("dinner").fields, name: "Dinner at Peter's" },
      }),
    );

    expect(await runPush(dinner, fake)).toEqual({ kind: "merged", overwritten: ["name"] });
    // A second run of the same job finds nothing pending.
    expect(await runPush(dinner, fake)).toEqual({ kind: "nothing" });

    expect(fake.event("family", "dinner").fields).toMatchObject({
      name: "Dinner at Peter's",
      description: "Bring wine",
    });
    expect(await properties(dinner)).toMatchObject({ name: "Dinner at Peter's", description: "Bring wine" });
    expect(await overwrittenNotifications()).toEqual([
      {
        title: "family",
        body: "Your change to Dinner at Peter's was overwritten by a change made elsewhere",
        source_id: dinner,
      },
    ]);
  });

  it("does not undo a pending local change in an incoming pass, and re-queues its push", async () => {
    const fake = provider();
    const accountId = await syncedAccount(fake);
    const dinner = await eventOf("dinner");
    await patchEvent(dinner, { name: "Family dinner" });
    fake.putEvent(
      "family",
      remoteEvent("dinner", { etag: '"dinner-2"', fields: { ...remoteEvent("dinner").fields, name: "Supper" } }),
    );
    await admin.query("DELETE FROM graphile_worker._private_jobs WHERE key = $1", [`calendar-event-push:${dinner}`]);

    const pass = await runPass(accountId, fake);

    expect(pass).toMatchObject({ kind: "applied", changed: [] });
    expect(await properties(dinner)).toMatchObject({ name: "Family dinner" });
    expect(await pushState(dinner)).toMatchObject({ status: "pending" });
    expect(await pushJobs(dinner)).toBe(1);
  });

  it("pushes a trash and a restore, and an agent's write goes the same way", async () => {
    const fake = provider();
    await syncedAccount(fake);
    const dinner = await eventOf("dinner");

    await patchEvent(dinner, { place: "Terrace" }, AGENT);
    expect(await pushState(dinner)).toMatchObject({ operation: "update", status: "pending" });
    expect(await runPush(dinner, fake)).toEqual({ kind: "sent", operation: "update" });
    expect(fake.event("family", "dinner").fields.place).toBe("Terrace");

    await inTenant(async (client) => {
      const { eventsDatabaseId } = (await resolveCalendarSyncIds(client))!;
      await itemDeleteWithClient(client, eventsDatabaseId, dinner, {
        writer: APPROVED_AGENT,
        queueAffinity: createActionQueueAffinity(),
      });
    });
    expect(await pushState(dinner)).toMatchObject({ operation: "delete", status: "pending" });
    expect(await runPush(dinner, fake)).toEqual({ kind: "sent", operation: "delete" });
    expect(fake.events("family").map((event) => event.remoteId)).not.toContain("dinner");

    await inTenant(async (client) => {
      const { eventsDatabaseId } = (await resolveCalendarSyncIds(client))!;
      await restoreItemWithClient(client, eventsDatabaseId, dinner, createActionQueueAffinity(), undefined, USER);
    });
    expect(await pushState(dinner)).toMatchObject({ operation: "create", status: "pending" });
    expect(await runPush(dinner, fake)).toEqual({ kind: "sent", operation: "create" });
    expect(fake.events("family").map((event) => event.fields.place)).toContain("Terrace");
  });

  it("moves an Event to another calendar of the account by deleting it and creating it there with its UID", async () => {
    const fake = provider();
    await syncedAccount(fake);
    const dinner = await eventOf("dinner");
    const [family, work] = [await calendarOf("family"), await calendarOf("work")];
    await inTenant(async (client) => {
      const { eventsDatabaseId } = (await resolveCalendarSyncIds(client))!;
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM properties WHERE database_id = $1 AND key = 'calendar'",
        [eventsDatabaseId],
      );
      const propertyId = rows[0]!.id;
      const edge = { relationPropertyId: propertyId, callerItemId: dinner };
      await deleteRelationWithClient(client, { ...edge, targetItemId: family }, undefined, USER);
      await createRelationWithClient(client, { ...edge, targetItemId: work }, undefined, USER);
    });
    expect(await pushState(dinner)).toMatchObject({ operation: "move", status: "pending" });

    expect(await runPush(dinner, fake)).toEqual({ kind: "sent", operation: "move" });

    expect(fake.events("family").map((event) => event.remoteId)).not.toContain("dinner");
    expect(fake.events("work").map((event) => event.remoteId)).toEqual(["dinner"]);
    const { rows } = await admin.query<{ calendar_item_id: string }>(
      "SELECT calendar_item_id FROM event_remote_state WHERE event_item_id = $1",
      [dinner],
    );
    expect(rows).toEqual([{ calendar_item_id: work }]);
  });

  it.each([
    [
      "a refused credential",
      new CalendarSyncReauthorizationRequiredError(),
      { kind: "waiting", code: "reauthorizationRequired" },
      "needsReauthorization",
    ],
    ["an unavailable provider", new CalendarSyncProviderError("providerUnavailable"), null, "never"],
  ])(
    "records %s as the push's status, and the account's only for the credential",
    async (_case, failure, result, accountStatus) => {
      const fake = provider();
      const accountId = await syncedAccount(fake);
      const dinner = await eventOf("dinner");
      await patchEvent(dinner, { name: "Family dinner" });
      fake.failNextWrite = failure;

      const run = runPush(dinner, fake);
      if (result === null) await expect(run).rejects.toBe(failure);
      else expect(await run).toEqual(result);

      expect(await pushState(dinner)).toMatchObject({
        status: "pending",
        attempts: 1,
        last_error_code:
          failure instanceof CalendarSyncProviderError ? "providerUnavailable" : "reauthorizationRequired",
      });
      const { rows } = await admin.query<{ status: string }>(
        "SELECT status FROM calendar_account_sync_state WHERE account_item_id = $1",
        [accountId],
      );
      expect(rows[0]?.status ?? "never").toBe(accountStatus === "never" ? "ok" : accountStatus);
      const problems = await admin.query(
        "SELECT 1 FROM semp_problems WHERE tenant_id = $1 AND kind = 'calendarSyncError' AND resolved_at IS NULL",
        [tenant],
      );
      expect(problems.rowCount).toBe(accountStatus === "never" ? 0 : 1);
    },
  );

  it("gives a push up as failed after its last attempt", async () => {
    const fake = provider();
    await syncedAccount(fake);
    const dinner = await eventOf("dinner");
    await patchEvent(dinner, { name: "Family dinner" });
    for (let attempt = 1; attempt < MAX_EVENT_PUSH_ATTEMPTS; attempt += 1) {
      fake.failNextWrite = new CalendarSyncProviderError("providerUnavailable");
      await expect(runPush(dinner, fake)).rejects.toBeInstanceOf(CalendarSyncProviderError);
    }
    fake.failNextWrite = new CalendarSyncProviderError("providerUnavailable");
    expect(await runPush(dinner, fake)).toEqual({ kind: "failed", code: "providerUnavailable" });
    expect(await pushState(dinner)).toMatchObject({ status: "failed", attempts: MAX_EVENT_PUSH_ATTEMPTS });
    expect(fake.event("family", "dinner").fields.name).toBe("Dinner");
  });

  it("converts a time edit of a zoned Event from the tenant's zone, and stores the sync's as sent", async () => {
    const fake = provider();
    fake.putEvent(
      "family",
      remoteEvent("call", {
        fields: remoteFields({
          name: "Call",
          date: "2026-11-27",
          timeFrom: "09:00",
          timeTo: "10:00",
          timeZone: "America/New_York",
        }),
      }),
    );
    await syncedAccount(fake);
    const call = await eventOf("call");

    // 09:00 in New York is 15:00 in Prague; the user moves it to 16:00–17:00 Prague time.
    await patchEvent(call, { timeFrom: "16:00", timeTo: "17:00" });
    expect(await properties(call)).toMatchObject({
      date: "2026-11-27",
      timeFrom: "10:00",
      timeTo: "11:00",
      timeZone: "America/New_York",
    });

    await patchEvent(call, { timeFrom: "12:00", timeTo: "13:00" }, CALENDAR_SYNC_WRITER);
    expect(await properties(call)).toMatchObject({ timeFrom: "12:00", timeTo: "13:00", timeZone: "America/New_York" });
  });

  it("pushes nothing for another tenant's Event", async () => {
    const fake = provider();
    await syncedAccount(fake);
    const dinner = await eventOf("dinner");
    await patchEvent(dinner, { name: "Family dinner" });

    expect(await runPush(dinner, fake, foreign)).toEqual({ kind: "nothing" });
    expect(fake.writes.filter((write) => write.kind === "put")).toEqual([]);
    expect(await pushState(dinner)).toMatchObject({ status: "pending" });
  });
});

describe("the per-field merge", () => {
  const base = remoteFields({ name: "Dinner", date: "2026-11-27", place: "Home" });
  it.each([
    ["unchanged on both sides", {}, {}, {}, []],
    ["changed here only", { name: "Supper" }, {}, { name: "Supper" }, []],
    ["changed at the provider only", {}, { name: "Supper" }, { name: "Supper" }, []],
    ["changed alike on both sides", { name: "Supper" }, { name: "Supper" }, { name: "Supper" }, []],
    ["changed differently on both sides", { name: "Supper" }, { name: "Feast" }, { name: "Feast" }, ["name"]],
    ["different fields on each side", { name: "Supper" }, { place: "Garden" }, { name: "Supper", place: "Garden" }, []],
  ])("%s", (_case, local, remote, merged, overwritten) => {
    const result = mergeEventFields({ ...base }, { ...base, ...local }, { ...base, ...remote });
    expect(result).toEqual({ fields: { ...base, ...merged }, overwritten });
  });
});
