import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { runAsSystem, runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { prepareItemPreWriteTransforms } from "../../chokePoint/hooks.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import type { WriterIdentity } from "../../chokePoint/writerKind.js";
import { withTransaction } from "../../db/pool.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { CALENDARS_MODULE_ID } from "../../seed/calendarsKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { CALENDAR_MODULE_ID } from "../calendarModuleId.js";
import { runCalendarSubscriptionUrlCutoverMigration } from "../calendarSubscriptionUrlCutoverMigration.js";

let admin: Pool;
let runtime: Pool;

const USER: WriterIdentity = { writerKind: "user" };
/** An /mcp client on a human session: an agent writer without run ids. */
const MCP: WriterIdentity = { writerKind: "agent", onBehalfOfUserId: randomUUID() };
/** An agent run: an agent writer that carries the run and its project item. */
const AGENT_RUN: WriterIdentity = {
  writerKind: "agent",
  agentRunId: randomUUID(),
  agentProjectItemId: randomUUID(),
  onBehalfOfUserId: randomUUID(),
};
const WRITERS: Array<[string, WriterIdentity]> = [
  ["a REST user", USER],
  ["an /mcp client", MCP],
  ["an agent run", AGENT_RUN],
];

const INVALID_URL = { status: 400, code: "validation_failed", details: { field: "subscriptionUrl" } };

/** The URLs the baseline refuses (docs/adr/2026-09-27-ssrf-protection-for-stored-outbound-urls.md), by what is wrong. */
const REFUSED_URLS: Array<[string, string]> = [
  ["a plain http scheme", "http://example.com/a.ics"],
  ["an IPv4 literal host", "https://127.0.0.1/a.ics"],
  ["localhost", "https://localhost/a.ics"],
  ["credentials", "https://user:pw@example.com/a.ics"],
  ["an explicit port", "https://example.com:8443/a.ics"],
  ["an IPv6 literal host", "https://[::1]/a.ics"],
  ["a scheme other than https and webcal", "ftp://example.com/a.ics"],
  ["a webcals scheme", "webcals://example.com/a.ics"],
  ["no URL at all", "not a url"],
  ["an IP host behind a webcal scheme", "webcal://127.0.0.1/a.ics"],
  ["credentials behind a webcal scheme", "webcal://user:pw@example.com/a.ics"],
  ["a port behind a webcal scheme", "webcal://example.com:8443/a.ics"],
  ["only whitespace, which is not trimmed into a cleared address", "  "],
  ["whitespace before a webcal scheme, which is not trimmed", " webcal://example.com/a.ics"],
];

const itemRow = z.object({ properties: z.record(z.string(), z.unknown()) });

/** A tenant with one English-speaking user, so its calendars are seeded as `Personal`, `Work` and so on. */
async function seededTenant(status: "active" | "suspended" = "active"): Promise<string> {
  const tenantId = await createTestTenant(admin, { status });
  await createUser(admin, { tenantId, email: `${randomUUID()}@example.com`, passwordHash: "unused", locale: "en" });
  await runInTenant(tenantId, () => seedSystem(runtime));
  return tenantId;
}

/** The refusal a write was rejected with, or `undefined` when it was stored. */
function refusal(write: Promise<unknown>): Promise<unknown> {
  return write.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
}

beforeAll(async () => {
  admin = getTestPool();
  runtime = await createRuntimeRolePool(admin, "semprec_data");
});

afterAll(async () => {
  await runtime.end();
  await admin.end();
});

describe("calendar subscription URL (issue gh-1925)", () => {
  let tenant: string;

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await seededTenant();
  });

  /** The calendars of the tenant in scope; every write of a test goes through the choke point. */
  async function setup() {
    const cp = createChokePoint(runtime);
    const calendars = (await cp.listDatabases()).find((database) => database.ownerModuleId === CALENDARS_MODULE_ID);
    if (!calendars) throw new Error("Missing the calendars database");
    const calendarsId = calendars.id;
    const personal = z
      .array(z.object({ id: z.string(), properties: z.object({ name: z.string() }).passthrough() }))
      .parse((await cp.listItems(calendarsId, { limit: 50 })).items)
      .find((row) => row.properties.name === "Personal");
    if (!personal) throw new Error("Missing the Personal calendar");
    const patch = (calendarId: string, propertiesPatch: Record<string, unknown>, writer: WriterIdentity = USER) =>
      cp.updateItem({ databaseId: calendarsId, itemId: calendarId, propertiesPatch }, undefined, undefined, writer);
    const create = (properties: Record<string, unknown>, writer: WriterIdentity = USER) =>
      cp.createItem({ databaseId: calendarsId, properties }, undefined, undefined, writer);
    /** A calendar of another `kind`. The key is written by the calendar module only, so the fixture writes it as that owner process. */
    const createOfKind = (kind: string, properties: Record<string, unknown>) =>
      withTransaction(runtime, (client) =>
        createItemWithClient(
          client,
          { databaseId: calendarsId, properties: { ...properties, kind } },
          { allowedSystemKeys: ["kind"], systemOwnerProcess: CALENDAR_MODULE_ID },
        ),
      );
    /** The stored properties of a calendar, read in the tenant's scope. */
    const stored = async (calendarId: string) => {
      const { rows } = await withTransaction(runtime, (client) =>
        client.query("SELECT properties FROM items WHERE database_id = $1 AND id = $2", [calendarsId, calendarId]),
      );
      return itemRow.parse(rows[0]).properties;
    };
    const calendarCount = async () => {
      const { rows } = await withTransaction(runtime, (client) =>
        client.query<{ count: number }>("SELECT count(*)::int AS count FROM items WHERE database_id = $1", [
          calendarsId,
        ]),
      );
      return rows[0]?.count;
    };
    return { cp, calendarsId, personalId: personal.id, patch, create, createOfKind, stored, calendarCount };
  }

  describe.each(WRITERS)("written by %s", (_writerName, writer) => {
    it.each(REFUSED_URLS)("refuses %s on a new subscription calendar and stores nothing", (_why, url) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const before = await f.calendarCount();

        const thrown = await refusal(
          withTransaction(runtime, (client) =>
            createItemWithClient(
              client,
              {
                databaseId: f.calendarsId,
                properties: { name: "Feed", color: "#8E8E93", kind: "subscription", subscriptionUrl: url },
              },
              { allowedSystemKeys: ["kind"], systemOwnerProcess: CALENDAR_MODULE_ID, writer },
            ),
          ),
        );

        expect(thrown).toMatchObject(INVALID_URL);
        expect(await f.calendarCount()).toBe(before);
      }),
    );

    it.each(REFUSED_URLS)("refuses %s on update and keeps the stored address", (_why, url) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const feed = await f.createOfKind("subscription", {
          name: "Feed",
          color: "#8E8E93",
          subscriptionUrl: "https://example.com/old.ics",
        });
        const before = await f.stored(feed.id);

        expect(await refusal(f.patch(feed.id, { subscriptionUrl: url }, writer))).toMatchObject(INVALID_URL);
        expect(await f.stored(feed.id)).toEqual(before);
      }),
    );

    it("stores a valid https address on update and returns it", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const feed = await f.createOfKind("subscription", { name: "Feed", color: "#8E8E93" });

        const updated = await f.patch(feed.id, { subscriptionUrl: "https://example.com/a.ics" }, writer);

        expect(updated.properties.subscriptionUrl).toBe("https://example.com/a.ics");
        expect((await f.stored(feed.id)).subscriptionUrl).toBe("https://example.com/a.ics");
      }));

    it("stores the https form of a webcal address on update and returns it", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const feed = await f.createOfKind("subscription", { name: "Feed", color: "#8E8E93" });

        const updated = await f.patch(feed.id, { subscriptionUrl: "webcal://example.com/a.ics?x=1" }, writer);

        expect(updated.properties.subscriptionUrl).toBe("https://example.com/a.ics?x=1");
        expect((await f.stored(feed.id)).subscriptionUrl).toBe("https://example.com/a.ics?x=1");
      }));

    it("refuses an address on an own calendar and on a system calendar and keeps them as they were", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const system = await f.createOfKind("system", { name: "Holidays", color: "#34C759" });
        const ownBefore = await f.stored(f.personalId);
        const systemBefore = await f.stored(system.id);

        expect(
          await refusal(f.patch(f.personalId, { subscriptionUrl: "https://example.com/a.ics" }, writer)),
        ).toMatchObject(INVALID_URL);
        expect(
          await refusal(f.patch(system.id, { subscriptionUrl: "https://example.com/a.ics" }, writer)),
        ).toMatchObject(INVALID_URL);
        expect(await f.stored(f.personalId)).toEqual(ownBefore);
        expect(await f.stored(system.id)).toEqual(systemBefore);
      }));
  });

  describe("create", () => {
    it("stores a valid https address on a new subscription calendar", () =>
      runInTenant(tenant, async () => {
        const f = await setup();

        const feed = await f.createOfKind("subscription", {
          name: "Feed",
          color: "#8E8E93",
          subscriptionUrl: "https://example.com/a.ics",
        });

        expect(feed.properties.subscriptionUrl).toBe("https://example.com/a.ics");
        expect((await f.stored(feed.id)).subscriptionUrl).toBe("https://example.com/a.ics");
      }));

    it("stores the https form of a webcal address on a new subscription calendar", () =>
      runInTenant(tenant, async () => {
        const f = await setup();

        const feed = await f.createOfKind("subscription", {
          name: "Feed",
          color: "#8E8E93",
          subscriptionUrl: "WEBCAL://example.com/a.ics",
        });

        expect((await f.stored(feed.id)).subscriptionUrl).toBe("https://example.com/a.ics");
      }));

    it("lets a subscription calendar exist without an address", () =>
      runInTenant(tenant, async () => {
        const f = await setup();

        const feed = await f.createOfKind("subscription", { name: "Feed", color: "#8E8E93" });

        expect(await f.stored(feed.id)).not.toHaveProperty("subscriptionUrl");
      }));

    it("refuses an address on a new calendar that has no kind, and stores nothing", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const before = await f.calendarCount();

        const thrown = await refusal(
          f.create({ name: "Mine", color: "#8E8E93", subscriptionUrl: "https://example.com/a.ics" }),
        );

        expect(thrown).toMatchObject(INVALID_URL);
        expect(await f.calendarCount()).toBe(before);
      }));

    it("refuses an address on a new own calendar and on a new system calendar, and stores nothing", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const before = await f.calendarCount();

        for (const kind of ["own", "system"]) {
          expect(
            await refusal(
              f.createOfKind(kind, { name: kind, color: "#8E8E93", subscriptionUrl: "https://example.com/a.ics" }),
            ),
          ).toMatchObject(INVALID_URL);
        }
        expect(await f.calendarCount()).toBe(before);
      }));

    it("creates an own calendar that does not name an address as before", () =>
      runInTenant(tenant, async () => {
        const f = await setup();

        const own = await f.create({ name: "Mine", color: "#8E8E93" });

        expect(await f.stored(own.id)).not.toHaveProperty("subscriptionUrl");
      }));
  });

  describe("clearing", () => {
    it.each([
      ["null", null],
      ["the empty string", ""],
    ])("clears the address of a subscription calendar with %s", (_name, value) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const feed = await f.createOfKind("subscription", {
          name: "Feed",
          color: "#8E8E93",
          subscriptionUrl: "https://example.com/a.ics",
        });

        const updated = await f.patch(feed.id, { subscriptionUrl: value });

        expect(updated.properties.subscriptionUrl).toBeNull();
        expect((await f.stored(feed.id)).subscriptionUrl).toBeNull();
      }),
    );

    it.each([
      ["null", null],
      ["the empty string", ""],
    ])("accepts %s on an own calendar, where it is not an address", (_name, value) =>
      runInTenant(tenant, async () => {
        const f = await setup();

        const updated = await f.patch(f.personalId, { subscriptionUrl: value });

        expect(updated.properties.subscriptionUrl).toBeNull();
      }),
    );
  });

  describe("a value that is not text", () => {
    it.each([123, true, { href: "https://example.com/a.ics" }, ["https://example.com/a.ics"]])(
      "refuses %j and keeps the stored address",
      (value) =>
        runInTenant(tenant, async () => {
          const f = await setup();
          const feed = await f.createOfKind("subscription", {
            name: "Feed",
            color: "#8E8E93",
            subscriptionUrl: "https://example.com/a.ics",
          });

          expect(await refusal(f.patch(feed.id, { subscriptionUrl: value }))).toMatchObject(INVALID_URL);
          expect((await f.stored(feed.id)).subscriptionUrl).toBe("https://example.com/a.ics");
        }),
    );
  });

  describe("an update that does not name the address", () => {
    it("keeps the stored address and leaves the transform out of it", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const feed = await f.createOfKind("subscription", {
          name: "Feed",
          color: "#8E8E93",
          subscriptionUrl: "https://example.com/a.ics",
        });

        const updated = await f.patch(feed.id, { color: "#34C759" });

        expect(updated.properties.color).toBe("#34C759");
        expect(updated.properties.subscriptionUrl).toBe("https://example.com/a.ics");
      }));
  });

  describe("the proposal preparation", () => {
    const prepare = (stored: Parameters<typeof prepareItemPreWriteTransforms>[1]["stored"], patch: object) =>
      prepareItemPreWriteTransforms(CALENDARS_MODULE_ID, { stored, patch: { ...patch } });

    it("rewrites a webcal address of a subscription calendar and declares no deferred key", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const feed = await f.createOfKind("subscription", { name: "Feed", color: "#8E8E93" });

        expect(await prepare(feed, { subscriptionUrl: "webcal://example.com/a.ics" })).toEqual({
          patch: { subscriptionUrl: "https://example.com/a.ics" },
          deferredKeys: [],
        });
      }));

    it("returns a patch that does not name the address as it is", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const feed = await f.createOfKind("subscription", { name: "Feed", color: "#8E8E93" });

        expect(await prepare(feed, { color: "#34C759" })).toEqual({ patch: { color: "#34C759" }, deferredKeys: [] });
      }));

    it("refuses an address the baseline refuses, and an address on a calendar that is not a subscription", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const feed = await f.createOfKind("subscription", { name: "Feed", color: "#8E8E93" });
        const own = await f.createOfKind("own", { name: "Mine", color: "#8E8E93" });

        expect(await refusal(prepare(feed, { subscriptionUrl: "http://example.com/a.ics" }))).toMatchObject(
          INVALID_URL,
        );
        expect(await refusal(prepare(own, { subscriptionUrl: "https://example.com/a.ics" }))).toMatchObject(
          INVALID_URL,
        );
        expect(await refusal(prepare(null, { subscriptionUrl: "https://example.com/a.ics" }))).toMatchObject(
          INVALID_URL,
        );
      }));
  });
});

describe("calendar subscription URL cutover (issue gh-1925)", () => {
  let active: string;
  let suspended: string;
  let withoutCalendars: string;

  beforeEach(async () => {
    await resetDatabase(admin);
    active = await seededTenant();
    suspended = await seededTenant("suspended");
    withoutCalendars = await createTestTenant(admin);
  });

  const propertyRow = z.object({
    key: z.string(),
    name: z.string().nullable(),
    type: z.string(),
    config: z.unknown(),
    locked: z.boolean(),
    owner: z.string(),
    owner_process: z.string().nullable(),
    id: z.string(),
  });

  /** The `subscriptionUrl` definition of a tenant's Calendars database, in every column that describes it. */
  async function definitions(tenantId: string) {
    const { rows } = await admin.query<Record<string, unknown>>(
      `SELECT p.id, p.key, p.name, p.type, p.config, p.locked, p.owner, p.owner_process
         FROM properties p JOIN databases d ON d.id = p.database_id
        WHERE d.tenant_id = $1 AND d.owner_module_id = 'calendars' AND p.key = 'subscriptionUrl'`,
      [tenantId],
    );
    return z.array(propertyRow).parse(rows);
  }

  /** Reproduces a tenant seeded before issue gh-1925: its Calendars database has no `subscriptionUrl` definition. */
  async function revertToOldShape(tenantId: string): Promise<void> {
    await admin.query(
      `DELETE FROM properties p USING databases d
        WHERE d.id = p.database_id AND d.tenant_id = $1 AND d.owner_module_id = 'calendars' AND p.key = 'subscriptionUrl'`,
      [tenantId],
    );
  }

  it("declares the property in a fresh seed as a user-owned url property without a name or config", async () => {
    expect(await definitions(active)).toEqual([
      {
        id: expect.any(String),
        key: "subscriptionUrl",
        name: null,
        type: "url",
        config: {},
        locked: false,
        owner: "user",
        owner_process: null,
      },
    ]);
  });

  it("gives an active and a suspended tenant a definition identical to a fresh seed, touching no calendar", async () => {
    const [fresh] = await definitions(active);
    await revertToOldShape(active);
    await revertToOldShape(suspended);
    const calendars = await admin.query("SELECT id, properties, updated_at FROM items ORDER BY id");
    expect(await definitions(active)).toEqual([]);
    expect(await definitions(suspended)).toEqual([]);

    await runAsSystem("test calendar subscription URL cutover", () => runTenantCutoverMigrations(runtime));

    for (const tenantId of [active, suspended]) {
      const added = await definitions(tenantId);
      expect(added).toEqual([{ ...fresh, id: expect.any(String) }]);
    }
    expect((await admin.query("SELECT id, properties, updated_at FROM items ORDER BY id")).rows).toEqual(
      calendars.rows,
    );
  });

  it("makes the added property writable on a subscription calendar through the choke point", async () => {
    await revertToOldShape(active);
    await runInTenant(active, () => runCalendarSubscriptionUrlCutoverMigration(runtime));

    const feed = await runInTenant(active, async () => {
      const cp = createChokePoint(runtime);
      const calendars = (await cp.listDatabases()).find((database) => database.ownerModuleId === CALENDARS_MODULE_ID);
      if (!calendars) throw new Error("Missing the calendars database");
      return withTransaction(runtime, (client) =>
        createItemWithClient(
          client,
          {
            databaseId: calendars.id,
            properties: {
              name: "Feed",
              color: "#8E8E93",
              kind: "subscription",
              subscriptionUrl: "webcal://example.com/a.ics",
            },
          },
          { allowedSystemKeys: ["kind"], systemOwnerProcess: CALENDAR_MODULE_ID },
        ),
      );
    });

    expect(feed.properties.subscriptionUrl).toBe("https://example.com/a.ics");
  });

  it("changes nothing when it runs a second time", async () => {
    await revertToOldShape(active);
    await runInTenant(active, () => runCalendarSubscriptionUrlCutoverMigration(runtime));
    const afterFirst = await definitions(active);
    expect(afterFirst).toHaveLength(1);

    await runInTenant(active, () => runCalendarSubscriptionUrlCutoverMigration(runtime));
    await runAsSystem("test calendar subscription URL cutover", () => runTenantCutoverMigrations(runtime));

    expect(await definitions(active)).toEqual(afterFirst);
  });

  it("skips a tenant without a Calendars database", async () => {
    await runInTenant(withoutCalendars, () => runCalendarSubscriptionUrlCutoverMigration(runtime));

    expect(await definitions(withoutCalendars)).toEqual([]);
    const { rows } = await admin.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM databases WHERE tenant_id = $1",
      [withoutCalendars],
    );
    expect(rows[0]?.count).toBe(0);
  });
});
