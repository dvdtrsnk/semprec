import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { runInTenant } from "@semprec/shared";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createUser } from "../auth/usersStore.js";
import { readCalendarTimeline } from "../calendar/timelineRead.js";
import { CALENDAR_MODULE_ID } from "../calendar/calendarModuleId.js";
import { createEventInCalendar } from "../calendar/defaultCalendarCreateHook.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { computeDestructiveResourceProjection } from "../chokePoint/destructiveProjection.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { CALENDAR_SYNC_WRITER, SYSTEM_WRITER, type WriterIdentity } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import type { CollectionMetadataResolver } from "../manifest/collectionMetadata.js";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { seedSystem } from "../seed/seedSystem.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;

const USER: WriterIdentity = { writerKind: "user" };
const AGENT: WriterIdentity = { writerKind: "agent", onBehalfOfUserId: randomUUID() };
const EVENT = { name: "Dinner", date: "2026-11-20" };
const READ_ONLY = { status: 403, code: "calendar_read_only" };
const REMOTE_KEYS = ["remoteName", "remoteColor", "readOnly"];

const resolver: CollectionMetadataResolver = {
  resolve: () => ({
    icon: null,
    color: null,
    overviewOrder: null,
    switcherOrder: null,
    clientVisible: true,
    overviewHidden: false,
  }),
  collectionFilter: () => undefined,
  overviewHideable: () => false,
};

const listedCalendar = z.object({
  id: z.string(),
  properties: z.record(z.string(), z.unknown()),
  relations: z.object({ account: z.array(z.object({ id: z.string() })) }).optional(),
});

async function seededTenant(): Promise<string> {
  const tenantId = await createTestTenant(admin);
  await createUser(admin, { tenantId, email: `${randomUUID()}@example.com`, passwordHash: "unused", locale: "en" });
  await runInTenant(tenantId, () => seedSystem(runtime));
  return tenantId;
}

function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTenantTransaction(runtime, tenantId, fn));
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

/** The account calendar as the calendar sync creates it: kind, remote fields and the `account` edge. */
async function createAccountCalendar(
  client: PoolClient,
  ids: { calendars: string; accountProperty: string },
  mailboxId: string,
  remote: { remoteName: string; remoteColor: string; readOnly: boolean },
) {
  const calendar = await createItemWithClient(
    client,
    {
      databaseId: ids.calendars,
      properties: {
        kind: "account",
        name: null,
        color: null,
        notify: true,
        hidden: false,
        isDefault: false,
        ...remote,
      },
    },
    {
      writer: CALENDAR_SYNC_WRITER,
      allowedSystemKeys: ["kind", ...REMOTE_KEYS],
      systemOwnerProcess: CALENDAR_MODULE_ID,
    },
  );
  await createRelationWithClient(
    client,
    { relationPropertyId: ids.accountProperty, callerItemId: calendar.id, targetItemId: mailboxId },
    { ownerProcess: CALENDAR_MODULE_ID },
    CALENDAR_SYNC_WRITER,
  );
  return calendar;
}

/** Run inside the tenant scope. */
async function setup() {
  const cp = createChokePoint(runtime);
  const databases = await cp.listDatabases();
  const db = (moduleId: string) => {
    const row = databases.find((database) => database.ownerModuleId === moduleId);
    if (!row) throw new Error(`Missing ${moduleId}`);
    return row.id;
  };
  const calendars = db(CALENDARS_MODULE_ID);
  const events = db(EVENTS_MODULE_ID);
  const property = async (databaseId: string, key: string) => {
    const found = (await cp.listProperties(databaseId)).find((candidate) => candidate.key === key);
    if (!found) throw new Error(`Missing property ${key}`);
    return found;
  };
  const accountProperty = await property(calendars, "account");
  const eventCalendar = await property(events, "calendar");
  const { mailbox, writable, readOnly } = await withTransaction(runtime, async (client) => {
    const mailbox = await createItemWithClient(client, {
      databaseId: db(MAILBOXES_MODULE_ID),
      properties: { name: "Family account", provider: "generic" },
    });
    const ids = { calendars, accountProperty: accountProperty.id };
    return {
      mailbox,
      writable: await createAccountCalendar(client, ids, mailbox.id, {
        remoteName: "Family",
        remoteColor: "#34C759",
        readOnly: false,
      }),
      readOnly: await createAccountCalendar(client, ids, mailbox.id, {
        remoteName: "Holidays",
        remoteColor: "#FF9500",
        readOnly: true,
      }),
    };
  });
  const listed = (await cp.listItems(calendars, { limit: 50 })).items;
  const personal = listed.find((row) => row.properties.isDefault === true);
  if (!personal) throw new Error("Missing the default calendar");
  const calendarOf = async (eventId: string) =>
    ((await cp.listItemRelations(eventId, eventCalendar.id)) ?? []).map((entry) => entry.targetItemId);
  const calendarRow = async (calendarId: string) => {
    const row = (await cp.listItems(calendars, { limit: 50 })).items.find((candidate) => candidate.id === calendarId);
    if (!row) throw new Error(`Calendar ${calendarId} is not live`);
    return row;
  };
  const eventIn = (calendarId: string) =>
    withTransaction(runtime, (client) =>
      createEventInCalendar(client, { properties: EVENT }, calendarId, { writer: CALENDAR_SYNC_WRITER }),
    );
  return {
    cp,
    calendars,
    events,
    eventCalendar,
    mailbox,
    writable,
    readOnly,
    personal,
    calendarOf,
    calendarRow,
    eventIn,
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

describe("account calendars", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await seededTenant();
    foreign = await seededTenant();
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  it("seeds the account kind, the system-owned remote fields and the account relation to Mailboxes", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const properties = new Map((await f.cp.listProperties(f.calendars)).map((property) => [property.key, property]));
      expect(properties.get("kind")?.config).toMatchObject({ options: expect.arrayContaining([{ key: "account" }]) });
      for (const key of [...REMOTE_KEYS, "account"]) {
        expect(properties.get(key), key).toMatchObject({ owner: "system", ownerProcess: CALENDAR_MODULE_ID });
      }
      const mailboxCalendars = (await f.cp.listProperties(f.mailbox.databaseId)).find(
        (property) => property.key === "calendars",
      );
      expect(mailboxCalendars).toMatchObject({ owner: "system", ownerProcess: CALENDAR_MODULE_ID, type: "relation" });
      expect(await f.cp.listItemRelations(f.mailbox.id, mailboxCalendars?.id)).toHaveLength(2);
    }));

  it("lists an account calendar with its kind, account, read-only mark and remote name and colour", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const page = await f.cp.queryDatabaseItems(f.calendars, {}, { relations: { account: [] }, resolver });
      const rows = z.array(listedCalendar).parse(page.items);
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(f.readOnly.id)?.properties).toMatchObject({
        kind: "account",
        name: null,
        color: null,
        remoteName: "Holidays",
        remoteColor: "#FF9500",
        readOnly: true,
      });
      expect(byId.get(f.readOnly.id)?.relations?.account.map((target) => target.id)).toEqual([f.mailbox.id]);
      expect(byId.get(f.writable.id)?.properties).toMatchObject({ kind: "account", readOnly: false });
      expect(byId.get(f.personal.id)?.relations?.account).toEqual([]);
    }));

  describe("calendar rules", () => {
    it.each([
      ["a user", USER],
      ["an agent", AGENT],
    ])("refuses the trash of an account calendar by %s and keeps it and its events", (_label, writer) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const event = await f.eventIn(f.readOnly.id);
        const error = await rejection(f.cp.softDeleteItem(f.calendars, f.readOnly.id, undefined, writer));
        expect(error).toMatchObject({ status: 403, code: "forbidden", details: { field: "kind" } });
        expect((await f.calendarRow(f.readOnly.id)).deletedAt).toBeNull();
        expect(await f.cp.getItem(f.events, event.id)).toMatchObject({ deletedAt: null });
      }),
    );

    it("lets the calendar sync trash an account calendar with its events, leaving the default where it was", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const event = await f.eventIn(f.readOnly.id);
        await f.cp.softDeleteItem(f.calendars, f.readOnly.id, undefined, CALENDAR_SYNC_WRITER);
        expect((await f.cp.getItem(f.calendars, f.readOnly.id))?.deletedAt).not.toBeNull();
        expect((await f.cp.getItem(f.events, event.id))?.deletedAt).not.toBeNull();
        expect((await f.calendarRow(f.personal.id)).properties.isDefault).toBe(true);
      }));

    it("refuses to make an account calendar the default and keeps the default mark", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const error = await rejection(
          f.cp.updateItem(
            { databaseId: f.calendars, itemId: f.writable.id, propertiesPatch: { isDefault: true } },
            undefined,
            undefined,
            USER,
          ),
        );
        expect(error).toMatchObject({
          status: 400,
          code: "validation_failed",
          message: "An account calendar cannot be the default calendar",
        });
        expect((await f.calendarRow(f.writable.id)).properties.isDefault).toBe(false);
        expect((await f.calendarRow(f.personal.id)).properties.isDefault).toBe(true);
      }));

    it("renames, recolours, mutes and hides an account calendar locally, leaving the provider's values", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const local = { name: "Kids", color: "#FF0000", notify: false, hidden: true };
        await f.cp.updateItem(
          { databaseId: f.calendars, itemId: f.readOnly.id, propertiesPatch: local },
          undefined,
          undefined,
          USER,
        );
        expect((await f.calendarRow(f.readOnly.id)).properties).toMatchObject({
          ...local,
          remoteName: "Holidays",
          remoteColor: "#FF9500",
          readOnly: true,
        });
        // A cleared colour falls back to the provider's.
        await f.cp.updateItem(
          { databaseId: f.calendars, itemId: f.readOnly.id, propertiesPatch: { color: null } },
          undefined,
          undefined,
          USER,
        );
        expect((await f.calendarRow(f.readOnly.id)).properties).toMatchObject({ color: null, remoteColor: "#FF9500" });
      }));

    it("refuses a null name or colour on an own calendar, for the system writer too", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        for (const field of ["name", "color"]) {
          const error = await rejection(
            f.cp.updateItem(
              { databaseId: f.calendars, itemId: f.personal.id, propertiesPatch: { [field]: null } },
              undefined,
              undefined,
              SYSTEM_WRITER,
            ),
          );
          expect(error).toMatchObject({ status: 400, code: "validation_failed", details: { field } });
        }
      }));

    it.each([
      ["a user", USER, undefined],
      ["another calendar process", SYSTEM_WRITER, { allowedSystemKeys: REMOTE_KEYS, systemOwnerProcess: "calendar" }],
    ])("refuses a remote field written by %s and stores it from the calendar sync", (_label, writer, options) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const write = (by: WriterIdentity, writeOptions: typeof options) =>
          withTransaction(runtime, (client) =>
            updateItemWithClient(
              client,
              { databaseId: f.calendars, itemId: f.writable.id, propertiesPatch: { remoteName: "Renamed" } },
              { ...writeOptions, writer: by },
            ),
          );
        const error = await rejection(write(writer, options));
        expect(error).toMatchObject({ status: 403, code: "owner_violation", details: { field: "remoteName" } });
        expect((await f.calendarRow(f.writable.id)).properties.remoteName).toBe("Family");
        await write(CALENDAR_SYNC_WRITER, { allowedSystemKeys: REMOTE_KEYS, systemOwnerProcess: CALENDAR_MODULE_ID });
        expect((await f.calendarRow(f.writable.id)).properties.remoteName).toBe("Renamed");
      }),
    );
  });

  describe("events", () => {
    it("creates an event in a writable account calendar", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const event = await withTransaction(runtime, (client) =>
          createEventInCalendar(client, { properties: EVENT }, f.writable.id, { writer: USER }),
        );
        expect(await f.calendarOf(event.id)).toEqual([f.writable.id]);
      }));

    it.each([
      ["a user", USER],
      ["an agent", AGENT],
    ])("refuses %s creating an event in a read-only account calendar, and writes no event", (_label, writer) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const error = await rejection(
          withTransaction(runtime, (client) =>
            createEventInCalendar(client, { properties: EVENT }, f.readOnly.id, { writer }),
          ),
        );
        expect(error).toMatchObject({ ...READ_ONLY, details: { calendarId: f.readOnly.id } });
        expect((await f.cp.listItems(f.events, { limit: 50 })).items).toEqual([]);
      }),
    );

    it("lets the calendar sync create an event in a read-only account calendar", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const event = await f.eventIn(f.readOnly.id);
        expect(await f.calendarOf(event.id)).toEqual([f.readOnly.id]);
      }));

    interface Change {
      write: (f: Fixture, eventId: string, writer: WriterIdentity) => Promise<unknown>;
      /** Whether the write took effect. */
      applied: (f: Fixture, eventId: string) => Promise<boolean>;
    }

    /** Each write of an event in an account calendar, by `writer`. */
    const changes: Array<[string, Change]> = [
      [
        "a change",
        {
          write: (f, eventId, writer) =>
            f.cp.updateItem(
              { databaseId: f.events, itemId: eventId, propertiesPatch: { name: "Changed" } },
              undefined,
              undefined,
              writer,
            ),
          applied: async (f, eventId) => (await f.cp.getItem(f.events, eventId))?.properties.name === "Changed",
        },
      ],
      [
        "a trash",
        {
          write: (f, eventId, writer) => f.cp.softDeleteItem(f.events, eventId, undefined, writer),
          applied: async (f, eventId) => ((await f.cp.getItem(f.events, eventId))?.deletedAt ?? null) !== null,
        },
      ],
      [
        "a move out",
        {
          write: (f, eventId, writer) =>
            f.cp.setRelation(
              { relationPropertyId: f.eventCalendar.id, callerItemId: eventId, targetItemId: f.personal.id },
              writer,
            ),
          applied: async (f, eventId) => (await f.calendarOf(eventId))[0] === f.personal.id,
        },
      ],
    ];

    describe.each(changes)("%s", (_change, change) => {
      it.each([
        ["a user", USER],
        ["an agent", AGENT],
      ])("answers calendar_read_only to %s and leaves the event as it was", (_label, writer) =>
        runInTenant(tenant, async () => {
          const f = await setup();
          const event = await f.eventIn(f.readOnly.id);
          const error = await rejection(change.write(f, event.id, writer));
          expect(error).toMatchObject({ ...READ_ONLY, details: { calendarId: f.readOnly.id } });
          expect(await f.cp.getItem(f.events, event.id)).toMatchObject({
            deletedAt: null,
            version: event.version,
            properties: expect.objectContaining({ name: EVENT.name }),
          });
          expect(await f.calendarOf(event.id)).toEqual([f.readOnly.id]);
        }),
      );

      it("succeeds for the calendar sync", () =>
        runInTenant(tenant, async () => {
          const f = await setup();
          const event = await f.eventIn(f.readOnly.id);
          await change.write(f, event.id, CALENDAR_SYNC_WRITER);
          expect(await change.applied(f, event.id)).toBe(true);
        }));

      it("succeeds for a user in a writable account calendar", () =>
        runInTenant(tenant, async () => {
          const f = await setup();
          const event = await f.eventIn(f.writable.id);
          await change.write(f, event.id, USER);
          expect(await change.applied(f, event.id)).toBe(true);
        }));
    });

    it.each([
      ["a user", USER],
      ["an agent", AGENT],
    ])("refuses %s moving an event into a read-only account calendar", (_label, writer) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const event = await f.cp.createItem({ databaseId: f.events, properties: EVENT }, undefined, undefined, USER);
        const error = await rejection(
          f.cp.setRelation(
            { relationPropertyId: f.eventCalendar.id, callerItemId: event.id, targetItemId: f.readOnly.id },
            writer,
          ),
        );
        expect(error).toMatchObject({ ...READ_ONLY, details: { calendarId: f.readOnly.id } });
        expect(await f.calendarOf(event.id)).toEqual([f.personal.id]);
      }),
    );

    it("refuses an agent's trash of an event in a read-only account calendar before an approval is requested", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const readOnlyEvent = await f.eventIn(f.readOnly.id);
        const writableEvent = await f.eventIn(f.writable.id);
        const projection = (itemId: string) =>
          withTransaction(runtime, (client) =>
            computeDestructiveResourceProjection(client, { operation: "item.delete", input: { itemId } }),
          );
        expect(await rejection(projection(readOnlyEvent.id))).toMatchObject(READ_ONLY);
        await expect(projection(writableEvent.id)).resolves.toMatchObject({ currentResource: expect.anything() });
      }));

    it("marks timeline entries of a read-only account calendar read-only, and only those", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const inReadOnly = await f.eventIn(f.readOnly.id);
        const inWritable = await f.eventIn(f.writable.id);
        const own = await f.cp.createItem({ databaseId: f.events, properties: EVENT }, undefined, undefined, USER);
        const timeline = await withTransaction(runtime, (client) =>
          readCalendarTimeline(client, { from: EVENT.date, to: EVENT.date, shape: "full" }),
        );
        const readOnlyById = new Map(timeline.items.map((entry) => [entry.id, entry.readOnly]));
        expect(readOnlyById.get(inReadOnly.id)).toBe(true);
        expect(readOnlyById.get(inWritable.id)).toBe(false);
        expect(readOnlyById.get(own.id)).toBe(false);
      }));
  });

  describe("remote state tables", () => {
    async function writeRemoteState(tenantId: string) {
      return runInTenant(tenantId, async () => {
        const f = await setup();
        const event = await f.eventIn(f.readOnly.id);
        await inTenant(tenantId, async (client) => {
          // No writer of these rows exists yet; the calendar sync adds one.
          await client.query(
            "INSERT INTO calendar_remote_state (calendar_item_id, remote_id, sync_token) VALUES ($1, 'holidays', 's1')",
            [f.readOnly.id],
          );
          await client.query(
            `INSERT INTO event_remote_state (event_item_id, calendar_item_id, remote_id, etag, base_snapshot)
             VALUES ($1, $2, 'dinner', 'e1', '{"name": "Dinner"}'::jsonb)`,
            [event.id, f.readOnly.id],
          );
        });
        return { calendarId: f.readOnly.id, eventId: event.id, calendars: f.calendars, events: f.events };
      });
    }

    async function counts(tenantId: string): Promise<{ calendars: number; events: number }> {
      return inTenant(tenantId, async (client) => {
        const { rows } = await client.query<{ calendars: number; events: number }>(
          `SELECT (SELECT count(*)::int FROM calendar_remote_state) AS calendars,
                  (SELECT count(*)::int FROM event_remote_state) AS events`,
        );
        return rows[0] ?? { calendars: -1, events: -1 };
      });
    }

    it("keeps each tenant's rows to that tenant", async () => {
      const mine = await writeRemoteState(tenant);
      expect(await counts(tenant)).toEqual({ calendars: 1, events: 1 });
      expect(await counts(foreign)).toEqual({ calendars: 0, events: 0 });
      // Another tenant's item id is refused like a missing one, so no row can point into this tenant.
      const error = await rejection(
        inTenant(foreign, (client) =>
          client.query("INSERT INTO calendar_remote_state (calendar_item_id, remote_id) VALUES ($1, 'holidays')", [
            mine.calendarId,
          ]),
        ),
      );
      expect(error).toMatchObject({ code: "23503" });
      // The same remote ids are free in another tenant.
      await writeRemoteState(foreign);
      expect(await counts(foreign)).toEqual({ calendars: 1, events: 1 });
      expect(await counts(tenant)).toEqual({ calendars: 1, events: 1 });
    });

    it("refuses a second event with the same remote id in one calendar", async () => {
      const mine = await writeRemoteState(tenant);
      const other = await runInTenant(tenant, async () => {
        const f = await setup();
        return f.eventIn(mine.calendarId);
      });
      const error = await rejection(
        inTenant(tenant, (client) =>
          client.query(
            "INSERT INTO event_remote_state (event_item_id, calendar_item_id, remote_id) VALUES ($1, $2, 'dinner')",
            [other.id, mine.calendarId],
          ),
        ),
      );
      expect(error).toMatchObject({ code: "23505" });
    });

    it("removes the rows with their items", async () => {
      const mine = await writeRemoteState(tenant);
      await writeRemoteState(foreign);
      // The trash purge deletes item rows; the delete stands for it.
      await inTenant(tenant, (client) => client.query("DELETE FROM items WHERE id = $1", [mine.eventId]));
      expect(await counts(tenant)).toEqual({ calendars: 1, events: 0 });
      await inTenant(tenant, (client) => client.query("DELETE FROM items WHERE id = $1", [mine.calendarId]));
      expect(await counts(tenant)).toEqual({ calendars: 0, events: 0 });
      expect(await counts(foreign)).toEqual({ calendars: 1, events: 1 });
    });
  });
});
