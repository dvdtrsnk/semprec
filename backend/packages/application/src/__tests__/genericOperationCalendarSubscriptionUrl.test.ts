import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createTenantZeroUser, getTestPool, inTenantZero, resetDatabase } from "@semprec/data/testSupport";
import {
  CALENDAR_MODULE_ID,
  createAgentRun,
  createChokePoint,
  createItemWithClient,
  createViewTypeRegistry,
  getDatabaseByModuleId,
  seedSystem,
  withTransaction,
  type ChokePoint,
  type CollectionMetadataResolver,
  type DatabaseRow,
} from "@semprec/data";
import { CAPABILITY_IDS, type AuthenticatedActor } from "@semprec/shared";
import { createGenericOperationGateway } from "../genericOperationGateway.js";

// The subscription URL of a calendar (issue gh-1925) through the operations `/mcp` and the agent tools call. The
// rule itself is tested against the choke point in `@semprec/data` (`calendar/__tests__/calendarSubscriptionUrl.test.ts`).

const metadataResolver: CollectionMetadataResolver = {
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

const ALL_CAPABILITIES = new Set(CAPABILITY_IDS);
const INVALID_URL = { status: 400, code: "validation_failed", details: { field: "subscriptionUrl" } };
const SEEDING_TEST_TIMEOUT_MS = 120_000;

let pool: Pool;
let chokePoint: ChokePoint;
let calendars: DatabaseRow;
let projectsDatabase: DatabaseRow;
let userId: string;

const gateway = () => createGenericOperationGateway(pool, metadataResolver);

/** A run credential's actor: a run of a fresh Projects item, as the AgentTool and MCP composition roots build it. */
async function newAgentRun(): Promise<AuthenticatedActor> {
  const projectItemId = (await chokePoint.createItem({ databaseId: projectsDatabase.id, properties: {} })).id;
  const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "calendar" });
  return { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
}

/** A calendar of another `kind`: the key is written by the calendar module only, so the fixture writes it as that owner process. */
async function calendarOfKind(kind: string, name: string) {
  return withTransaction(pool, (client) =>
    createItemWithClient(
      client,
      { databaseId: calendars.id, properties: { name, color: "#8E8E93", kind } },
      { allowedSystemKeys: ["kind"], systemOwnerProcess: CALENDAR_MODULE_ID },
    ),
  );
}

async function storedUrl(itemId: string): Promise<unknown> {
  const { rows } = await pool.query<{ url: unknown }>(
    "SELECT properties -> 'subscriptionUrl' AS url FROM items WHERE id = $1",
    [itemId],
  );
  return rows[0]?.url;
}

/** The version a write of the item must name, as the choke point reports it. */
async function storedVersion(itemId: string): Promise<string> {
  const { rows } = await pool.query<{ updated_at: Date }>("SELECT updated_at FROM items WHERE id = $1", [itemId]);
  return rows[0]?.updated_at.toISOString() ?? "";
}

async function calendarCount(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
    calendars.id,
  ]);
  return rows[0]?.n ?? -1;
}

describe("a calendar's subscriptionUrl through the generic operation gateway (issue gh-1925)", () => {
  beforeAll(async () => {
    pool = getTestPool();
    chokePoint = createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    userId = (await createTenantZeroUser(pool)).id;
    const databases = await inTenantZero(async () => ({
      calendars: await withTransaction(pool, (client) => getDatabaseByModuleId(client, "calendars")),
      projects: await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects")),
    }));
    if (!databases.calendars || !databases.projects) throw new Error("System databases are missing");
    calendars = databases.calendars;
    projectsDatabase = databases.projects;
  }, SEEDING_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await pool?.end();
  });

  const actors: Array<[string, () => Promise<AuthenticatedActor>]> = [
    ["a REST session", async () => ({ userId, restSession: true })],
    ["an /mcp client on a human session", async () => ({ userId })],
    ["an agent run", newAgentRun],
  ];

  describe.each(actors)("as %s", (_name, actorOf) => {
    it.each([
      ["a plain http address", "http://example.com/a.ics"],
      ["an IP address", "https://127.0.0.1/a.ics"],
      ["a webcal address whose https form is an IP address", "webcal://127.0.0.1/a.ics"],
    ])("refuses %s on item.patch and keeps the stored address", async (_why, url) => {
      await inTenantZero(async () => {
        const actor = await actorOf();
        const feed = await calendarOfKind("subscription", "Feed");

        await expect(
          gateway().invoke("item.patch", actor, ALL_CAPABILITIES, {
            itemId: feed.id,
            properties: { subscriptionUrl: url },
            ifVersion: feed.updatedAt,
          }),
        ).rejects.toMatchObject(INVALID_URL);
        expect(await storedUrl(feed.id)).toBeNull();
      });
    });

    // `item.create` cannot set the system-owned `kind`, so a calendar it makes is never a subscription calendar and the
    // address is refused by the kind rule; the URL rule on a new subscription calendar is tested in `@semprec/data`.
    it("refuses an address on item.create, which cannot make a subscription calendar, and stores no calendar", async () => {
      await inTenantZero(async () => {
        const actor = await actorOf();
        const before = await calendarCount();

        await expect(
          gateway().invoke("item.create", actor, ALL_CAPABILITIES, {
            databaseId: calendars.id,
            properties: { name: "Mine", color: "#8E8E93", subscriptionUrl: "https://example.com/a.ics" },
          }),
        ).rejects.toMatchObject(INVALID_URL);
        expect(await calendarCount()).toBe(before);
      });
    });

    it("refuses an address on a calendar that is not a subscription", async () => {
      await inTenantZero(async () => {
        const actor = await actorOf();
        const own = await calendarOfKind("own", "Mine");

        await expect(
          gateway().invoke("item.patch", actor, ALL_CAPABILITIES, {
            itemId: own.id,
            properties: { subscriptionUrl: "https://example.com/a.ics" },
            ifVersion: own.updatedAt,
          }),
        ).rejects.toMatchObject(INVALID_URL);
        expect(await storedUrl(own.id)).toBeNull();
      });
    });

    it("stores a valid https address and the https form of a webcal address", async () => {
      await inTenantZero(async () => {
        const actor = await actorOf();
        const feed = await calendarOfKind("subscription", "Feed");

        await gateway().invoke("item.patch", actor, ALL_CAPABILITIES, {
          itemId: feed.id,
          properties: { subscriptionUrl: "https://example.com/a.ics" },
          ifVersion: feed.updatedAt,
        });
        expect(await storedUrl(feed.id)).toBe("https://example.com/a.ics");

        await gateway().invoke("item.patch", actor, ALL_CAPABILITIES, {
          itemId: feed.id,
          properties: { subscriptionUrl: "webcal://example.com/b.ics" },
          ifVersion: await storedVersion(feed.id),
        });
        expect(await storedUrl(feed.id)).toBe("https://example.com/b.ics");
      });
    });
  });
});
