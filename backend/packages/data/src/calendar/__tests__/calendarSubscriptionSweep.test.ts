import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Pool } from "pg";
import { runInTenant } from "@alldots/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { withTransaction } from "../../db/pool.js";
import { allowLoopbackOutboundForTests } from "../../net/outboundAddressPolicy.js";
import { CALENDARS_MODULE_ID } from "../../seed/calendarsKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { stubDnsLookup, type DnsLookupStub } from "../../testSupport/dnsLookupStub.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import {
  CALENDAR_FEED_LIMITS,
  handleCalendarSubscriptionSweepTask,
  registerCalendarFeedConsumer,
  type CalendarFeedInput,
} from "../calendarSubscriptionSweep.js";
import { CALENDAR_MODULE_ID } from "../calendarModuleId.js";
import { feedUrlHash } from "../calendarFeedState.js";
import { logger } from "../logger.js";

// Wrapped so one case can fail the store write of the first fetch of a run: a database failure, which the sweep
// must contain per calendar and per tenant.
const storeControl = vi.hoisted(() => ({ failFirstFetched: false, failedFor: null as string | null }));
vi.mock("../calendarFeedState.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../calendarFeedState.js")>();
  return {
    ...actual,
    recordCalendarFeedFetched: (...args: Parameters<typeof actual.recordCalendarFeedFetched>) => {
      if (storeControl.failFirstFetched && storeControl.failedFor === null) {
        storeControl.failedFor = args[1];
        return Promise.reject(new Error("store unavailable"));
      }
      return actual.recordCalendarFeedFetched(...args);
    },
  };
});

/**
 * Runs against a local HTTP server under the test-only loopback allowance; the cases of the baseline check and of
 * the connect-time refusal run under the default policy, which refuses a loopback address.
 */

const FEED = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-FEED-MARKER:FEEDCONTENT\r\nEND:VCALENDAR\r\n";
const LAST_MODIFIED = "Wed, 21 Oct 2026 07:28:00 GMT";
const VALID_URL = "https://feed.example.test/a.ics";

interface Tenant {
  id: string;
  calendarsId: string;
}

interface RecordedRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
}

type Behavior = (req: IncomingMessage, res: ServerResponse) => void;

let admin: Pool;
let runtime: Pool;
let cp: ChokePoint;
let server: http.Server;
let port: number;
let requests: RecordedRequest[];
let behaviors: Map<string, Behavior>;
let restorePolicy: (() => void) | null;
let dnsStub: DnsLookupStub | null;
let tenantA: Tenant;
let tenantB: Tenant;
let consumed: CalendarFeedInput[];

const stateSchema = z.object({
  etag: z.string().nullable(),
  last_modified: z.string().nullable(),
  feed_url_hash: z.string().nullable(),
  last_fetched_at: z.date().nullable(),
  last_status: z.number().nullable(),
  last_error_code: z.string().nullable(),
});

async function seededTenant(): Promise<Tenant> {
  const id = await createTestTenant(admin);
  await createUser(admin, {
    tenantId: id,
    email: `${randomUUID()}@example.test`,
    passwordHash: "unused",
    locale: "en",
  });
  await runInTenant(id, () => seedSystem(runtime));
  const databases = await runInTenant(id, () => cp.listDatabases());
  const calendars = databases.find((row) => row.ownerModuleId === CALENDARS_MODULE_ID);
  if (!calendars) throw new Error("Missing the calendars database");
  return { id, calendarsId: calendars.id };
}

/** `kind` is written by the calendar module only, so the fixture writes it as that owner process. */
async function subscription(tenant: Tenant, url: string = VALID_URL, name = "Feed"): Promise<string> {
  const item = await runInTenant(tenant.id, () =>
    withTransaction(runtime, (client) =>
      createItemWithClient(
        client,
        {
          databaseId: tenant.calendarsId,
          properties: { name, color: "#8E8E93", kind: "subscription", subscriptionUrl: url },
        },
        { allowedSystemKeys: ["kind"], systemOwnerProcess: CALENDAR_MODULE_ID },
      ),
    ),
  );
  return item.id;
}

/** Raw SQL: the write rule refuses an `http` address with a port, which is exactly what the test server is. */
async function pointAtServer(calendarId: string, path = "/a.ics", query = ""): Promise<void> {
  const url = `http://127.0.0.1:${port}${path}${query}`;
  await admin.query(
    "UPDATE items SET properties = jsonb_set(properties, '{subscriptionUrl}', to_jsonb($2::text)) WHERE id = $1",
    [calendarId, url],
  );
}

/** Raw SQL: the calendar module refuses to delete a subscription calendar through the choke point. */
async function trash(calendarId: string): Promise<void> {
  await admin.query("UPDATE items SET deleted_at = now() - interval '1 hour' WHERE id = $1", [calendarId]);
}

async function feedCalendar(tenant: Tenant, path = "/a.ics", query = ""): Promise<string> {
  const id = await subscription(tenant);
  await pointAtServer(id, path, query);
  return id;
}

async function stateOf(calendarId: string) {
  const { rows } = await admin.query("SELECT * FROM calendar_feed_state WHERE calendar_item_id = $1", [calendarId]);
  return rows[0] === undefined ? null : stateSchema.parse(rows[0]);
}

function serve(path: string, behavior: Behavior): void {
  behaviors.set(path, behavior);
}

const feedAnswer: Behavior = (_req, res) => {
  res.writeHead(200, { "content-type": "text/calendar", etag: '"v1"', "last-modified": LAST_MODIFIED });
  res.end(FEED);
};

const sweep = (limits = CALENDAR_FEED_LIMITS) => handleCalendarSubscriptionSweepTask(runtime, limits);

function requestsFor(path: string): RecordedRequest[] {
  return requests.filter((request) => request.path === path);
}

describe("the subscription calendar sweep (issue gh-1960)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "alldots_data");
    cp = createChokePoint(runtime);
    server = http.createServer((req, res) => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      requests.push({ path, headers: req.headers });
      const behavior = behaviors.get(path);
      if (!behavior) {
        res.writeHead(404);
        res.end();
        return;
      }
      behavior(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("The test server has no port");
    port = address.port;
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    requests = [];
    behaviors = new Map();
    consumed = [];
    dnsStub = null;
    restorePolicy = allowLoopbackOutboundForTests();
    registerCalendarFeedConsumer(async (_client, feed) => {
      consumed.push(feed);
    });
    storeControl.failFirstFetched = false;
    storeControl.failedFor = null;
    tenantA = await seededTenant();
    tenantB = await seededTenant();
  });

  afterEach(() => {
    registerCalendarFeedConsumer(null);
    restorePolicy?.();
    dnsStub?.restore();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.end();
    await admin.end();
  });

  describe("a feed that answers", () => {
    it("stores the validators and calls the consumer once with the feed", async () => {
      const id = await feedCalendar(tenantA);
      serve("/a.ics", feedAnswer);

      await sweep();

      expect(requestsFor("/a.ics")).toHaveLength(1);
      expect(requestsFor("/a.ics")[0]?.headers["if-none-match"]).toBeUndefined();
      expect(requestsFor("/a.ics")[0]?.headers["if-modified-since"]).toBeUndefined();
      expect(consumed).toEqual([{ calendarItemId: id, body: FEED, etag: '"v1"', lastModified: LAST_MODIFIED }]);
      expect(await stateOf(id)).toMatchObject({
        etag: '"v1"',
        last_modified: LAST_MODIFIED,
        last_status: 200,
        last_error_code: null,
      });
    });

    it("sends the stored validators next time, and the consumer is not called when the server answers 304", async () => {
      const id = await feedCalendar(tenantA);
      serve("/a.ics", feedAnswer);
      await sweep();
      serve("/a.ics", (_req, res) => {
        res.writeHead(304);
        res.end();
      });

      await sweep();

      expect(requestsFor("/a.ics")).toHaveLength(2);
      expect(requestsFor("/a.ics")[1]?.headers).toMatchObject({
        "if-none-match": '"v1"',
        "if-modified-since": LAST_MODIFIED,
      });
      expect(consumed).toHaveLength(1);
      expect(await stateOf(id)).toMatchObject({ etag: '"v1"', last_modified: LAST_MODIFIED, last_status: 304 });
    });

    it("sends only the validator the server gave", async () => {
      await feedCalendar(tenantA);
      serve("/a.ics", (_req, res) => {
        res.writeHead(200, { etag: '"only-etag"' });
        res.end(FEED);
      });
      await sweep();

      await sweep();

      const second = requestsFor("/a.ics")[1];
      expect(second?.headers["if-none-match"]).toBe('"only-etag"');
      expect(second?.headers["if-modified-since"]).toBeUndefined();
    });

    it("requests each calendar once per run", async () => {
      const first = await feedCalendar(tenantA, "/one.ics");
      const second = await feedCalendar(tenantA, "/two.ics");
      serve("/one.ics", feedAnswer);
      serve("/two.ics", feedAnswer);

      await sweep();

      expect(requestsFor("/one.ics")).toHaveLength(1);
      expect(requestsFor("/two.ics")).toHaveLength(1);
      expect(consumed.map((feed) => feed.calendarItemId).sort()).toEqual([first, second].sort());
    });

    it("requests no calendar that is trashed, not a subscription or without an address", async () => {
      const trashed = await feedCalendar(tenantA, "/trashed.ics");
      await trash(trashed);
      const own = await runInTenant(tenantA.id, () =>
        cp.createItem({ databaseId: tenantA.calendarsId, properties: { name: "Own", color: "#8E8E93" } }),
      );
      const bare = await runInTenant(tenantA.id, () =>
        withTransaction(runtime, (client) =>
          createItemWithClient(
            client,
            {
              databaseId: tenantA.calendarsId,
              properties: { name: "No address", color: "#8E8E93", kind: "subscription" },
            },
            { allowedSystemKeys: ["kind"], systemOwnerProcess: CALENDAR_MODULE_ID },
          ),
        ),
      );
      const live = await feedCalendar(tenantA, "/live.ics");
      for (const path of ["/trashed.ics", "/live.ics"]) serve(path, feedAnswer);

      await sweep();

      expect(requests.map((request) => request.path)).toEqual(["/live.ics"]);
      expect(consumed.map((feed) => feed.calendarItemId)).toEqual([live]);
      expect(await stateOf(trashed)).toBeNull();
      expect(await stateOf(own.id)).toBeNull();
      expect(await stateOf(bare.id)).toBeNull();
    });

    it("requests the calendars requested longest ago first when a tenant has more than the cap", async () => {
      const ids = [await feedCalendar(tenantA, "/c1.ics"), await feedCalendar(tenantA, "/c2.ics")];
      const third = await feedCalendar(tenantA, "/c3.ics");
      for (const path of ["/c1.ics", "/c2.ics", "/c3.ics"]) serve(path, feedAnswer);
      const limits = { ...CALENDAR_FEED_LIMITS, maxCalendarsPerTenant: 2 };

      await sweep(limits);
      expect(requests).toHaveLength(2);
      const firstRun = requests.map((request) => request.path);
      requests.length = 0;
      await sweep(limits);

      const left = ["/c1.ics", "/c2.ics", "/c3.ics"].find((path) => !firstRun.includes(path));
      expect(requests.map((request) => request.path)).toContain(left);
      expect(requests).toHaveLength(2);
      expect(await stateOf(third)).not.toBeNull();
      for (const id of ids) expect(await stateOf(id)).not.toBeNull();
    });
  });

  describe("a feed that does not arrive", () => {
    async function calendarWithStoredFeed(path = "/a.ics", query = ""): Promise<string> {
      const id = await feedCalendar(tenantA, path, query);
      serve(path, feedAnswer);
      await sweep();
      expect(await stateOf(id)).toMatchObject({ etag: '"v1"', last_status: 200 });
      consumed.length = 0;
      return id;
    }

    async function expectFailureLeavesValidators(id: string, code: string, status: number | null) {
      expect(consumed).toEqual([]);
      expect(await stateOf(id)).toMatchObject({
        etag: '"v1"',
        last_modified: LAST_MODIFIED,
        last_error_code: code,
        last_status: status,
      });
    }

    it("records a redirect as an error and follows nothing", async () => {
      const id = await calendarWithStoredFeed();
      serve("/a.ics", (_req, res) => {
        res.writeHead(302, { location: "/elsewhere.ics" });
        res.end();
      });
      serve("/elsewhere.ics", feedAnswer);

      await sweep();

      await expectFailureLeavesValidators(id, "redirect", null);
      expect(requestsFor("/elsewhere.ics")).toHaveLength(0);
    });

    it("records a body over the limit as an error: one that declares its size", async () => {
      const id = await calendarWithStoredFeed();
      serve("/a.ics", (_req, res) => {
        res.writeHead(200, { etag: '"v2"' });
        res.end("x".repeat(2000));
      });

      await sweep({ ...CALENDAR_FEED_LIMITS, maxBodyBytes: 1000 });

      await expectFailureLeavesValidators(id, "tooLarge", 200);
    });

    it("records a body over the limit as an error: one that streams without a length", async () => {
      const id = await calendarWithStoredFeed();
      serve("/a.ics", (_req, res) => {
        res.writeHead(200, { etag: '"v2"', "transfer-encoding": "chunked" });
        res.write("x".repeat(600));
        res.write("x".repeat(600));
        res.end();
      });

      await sweep({ ...CALENDAR_FEED_LIMITS, maxBodyBytes: 1000 });

      await expectFailureLeavesValidators(id, "tooLarge", 200);
    });

    it("accepts a body exactly at the limit", async () => {
      const id = await feedCalendar(tenantA);
      serve("/a.ics", (_req, res) => {
        res.writeHead(200, { etag: '"edge"' });
        res.end("y".repeat(1000));
      });

      await sweep({ ...CALENDAR_FEED_LIMITS, maxBodyBytes: 1000 });

      expect(consumed.map((feed) => feed.body.length)).toEqual([1000]);
      expect(await stateOf(id)).toMatchObject({ etag: '"edge"', last_error_code: null });
    });

    it("records a server that stops answering as a timeout", async () => {
      const id = await calendarWithStoredFeed();
      serve("/a.ics", () => {
        // Never answers.
      });

      await sweep({ ...CALENDAR_FEED_LIMITS, requestTimeoutMs: 300 });

      await expectFailureLeavesValidators(id, "timeout", null);
      server.closeAllConnections();
    });

    it("records a server that stops in the middle of the body as a timeout", async () => {
      const id = await calendarWithStoredFeed();
      serve("/a.ics", (_req, res) => {
        res.writeHead(200, { etag: '"v2"', "transfer-encoding": "chunked" });
        res.write("BEGIN:VCALENDAR");
      });

      await sweep({ ...CALENDAR_FEED_LIMITS, requestTimeoutMs: 300 });

      await expectFailureLeavesValidators(id, "timeout", null);
      server.closeAllConnections();
    });

    it("records a 500 as an error with its status", async () => {
      const id = await calendarWithStoredFeed();
      serve("/a.ics", (_req, res) => {
        res.writeHead(500);
        res.end("boom");
      });

      await sweep();

      await expectFailureLeavesValidators(id, "httpStatus", 500);
    });

    it("records a 404 and a 204 as errors, since only 200 and 304 are answers", async () => {
      const missing = await calendarWithStoredFeed("/missing.ics");
      serve("/missing.ics", (_req, res) => {
        res.writeHead(404);
        res.end();
      });
      const empty = await calendarWithStoredFeed("/empty.ics");
      serve("/empty.ics", (_req, res) => {
        res.writeHead(204);
        res.end();
      });

      await sweep();

      expect(await stateOf(missing)).toMatchObject({ etag: '"v1"', last_error_code: "httpStatus", last_status: 404 });
      expect(await stateOf(empty)).toMatchObject({ etag: '"v1"', last_error_code: "httpStatus", last_status: 204 });
    });

    it("records a connection that closes without an answer as a network error", async () => {
      const id = await calendarWithStoredFeed();
      serve("/a.ics", (req) => {
        req.socket.destroy();
      });

      await sweep();

      await expectFailureLeavesValidators(id, "networkError", null);
    });

    it("records a failure to resolve a host named like a redirect as a network error, and logs the error class", async () => {
      restorePolicy?.();
      restorePolicy = null;
      dnsStub = stubDnsLookup({ "redirect.example.test": [] });
      const id = await subscription(tenantA, "https://redirect.example.test/a.ics");
      const warn = vi.spyOn(logger, "warn");

      await sweep();

      expect(await stateOf(id)).toMatchObject({ last_error_code: "networkError", last_status: null });
      const text = JSON.stringify(warn.mock.calls);
      expect(text).toContain("causeName");
      expect(text).toMatch(/TypeError|Error/);
      expect(text).not.toContain("redirect.example.test");
    });

    it("clears the error code once the feed answers again", async () => {
      const id = await calendarWithStoredFeed();
      serve("/a.ics", (_req, res) => {
        res.writeHead(500);
        res.end();
      });
      await sweep();
      serve("/a.ics", feedAnswer);

      await sweep();

      expect(await stateOf(id)).toMatchObject({ last_error_code: null, last_status: 200 });
    });

    it("keeps feed content, the address and its query string out of the log", async () => {
      const id = await feedCalendar(tenantA, "/a.ics", "?token=SECRETTOKEN");
      registerCalendarFeedConsumer(async () => {
        throw new Error(`cannot read ${FEED}`);
      });
      const spies = [vi.spyOn(logger, "warn"), vi.spyOn(logger, "error"), vi.spyOn(logger, "info")];
      serve("/a.ics", feedAnswer);

      await sweep();
      serve("/a.ics", (_req, res) => {
        res.writeHead(500);
        res.end(FEED);
      });
      await sweep();

      expect(spies.flatMap((spy) => spy.mock.calls).length).toBeGreaterThan(0);
      const text = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
      expect(text).toContain(id);
      expect(text).not.toContain("FEEDCONTENT");
      expect(text).not.toContain("SECRETTOKEN");
      expect(text).not.toContain("127.0.0.1");
    });
  });

  describe("the address a feed was requested from", () => {
    const conditionalFeed: Behavior = (req, res) => {
      if (req.headers["if-none-match"] !== undefined || req.headers["if-modified-since"] !== undefined) {
        res.writeHead(304);
        res.end();
        return;
      }
      res.writeHead(200, { etag: '"b1"', "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT" });
      res.end(FEED);
    };

    it("is sent no validator of the address the calendar had before, so its feed is imported", async () => {
      const id = await feedCalendar(tenantA, "/a.ics");
      serve("/a.ics", feedAnswer);
      serve("/b.ics", conditionalFeed);
      await sweep();
      consumed.length = 0;
      await pointAtServer(id, "/b.ics");

      await sweep();

      expect(requestsFor("/b.ics")).toHaveLength(1);
      expect(requestsFor("/b.ics")[0]?.headers["if-none-match"]).toBeUndefined();
      expect(requestsFor("/b.ics")[0]?.headers["if-modified-since"]).toBeUndefined();
      expect(consumed.map((feed) => feed.etag)).toEqual(['"b1"']);
      expect(await stateOf(id)).toMatchObject({ etag: '"b1"', last_status: 200 });
    });

    it("is sent the validators again once the calendar returns to the address they came from", async () => {
      const id = await feedCalendar(tenantA, "/a.ics");
      serve("/a.ics", feedAnswer);
      serve("/b.ics", feedAnswer);
      await sweep();
      await pointAtServer(id, "/b.ics");
      await sweep();
      await pointAtServer(id, "/a.ics");

      await sweep();

      // The state holds the validators of the address it was last stored for: b, so a gets none.
      expect(requestsFor("/a.ics").map((request) => request.headers["if-none-match"])).toEqual([undefined, undefined]);
      await sweep();
      expect(requestsFor("/a.ics")[2]?.headers["if-none-match"]).toBe('"v1"');
    });

    it.each([
      ["a feed", feedAnswer],
      ["a 304", (_req: IncomingMessage, res: ServerResponse) => res.writeHead(304).end()],
      ["a 500", (_req: IncomingMessage, res: ServerResponse) => res.writeHead(500).end()],
    ] as const)("that was changed while it was requested neither delivers nor records %s", async (_name, answer) => {
      const id = await feedCalendar(tenantA, "/a.ics");
      serve("/a.ics", (req, res) => {
        void pointAtServer(id, "/b.ics").then(() => answer(req, res));
      });

      await sweep();

      expect(consumed).toEqual([]);
      expect(await stateOf(id)).toBeNull();
    });

    it("of a calendar that was trashed while it was requested is neither delivered nor recorded", async () => {
      const id = await feedCalendar(tenantA, "/a.ics");
      serve("/a.ics", (req, res) => {
        void trash(id).then(() => feedAnswer(req, res));
      });

      await sweep();

      expect(consumed).toEqual([]);
      expect(await stateOf(id)).toBeNull();
    });

    it("keeps the hash of the address with the validators it stores", async () => {
      const id = await feedCalendar(tenantA, "/a.ics");
      serve("/a.ics", feedAnswer);

      await sweep();

      const { rows } = await admin.query("SELECT properties->>'subscriptionUrl' AS url FROM items WHERE id = $1", [id]);
      const url = z.object({ url: z.string() }).parse(rows[0]).url;
      expect((await stateOf(id))?.feed_url_hash).toBe(feedUrlHash(url));
    });
  });

  describe("a consumer", () => {
    it("that fails leaves the stored validators as they were and the next run requests the feed in full again", async () => {
      const id = await feedCalendar(tenantA);
      serve("/a.ics", feedAnswer);
      let failures = 1;
      registerCalendarFeedConsumer(async (client, feed) => {
        await client.query("UPDATE calendar_feed_state SET last_status = 999 WHERE calendar_item_id = $1", [
          feed.calendarItemId,
        ]);
        if (failures-- > 0) throw new Error("cannot read the feed");
        consumed.push(feed);
      });

      await sweep();

      expect(await stateOf(id)).toMatchObject({
        etag: null,
        last_modified: null,
        last_error_code: "consumerFailed",
        last_status: 200,
      });
      expect(consumed).toEqual([]);

      await sweep();

      expect(requestsFor("/a.ics")[1]?.headers["if-none-match"]).toBeUndefined();
      expect(consumed).toHaveLength(1);
      expect(await stateOf(id)).toMatchObject({ etag: '"v1"', last_error_code: null });
    });

    it("that fails keeps earlier validators when the feed changed", async () => {
      const id = await feedCalendar(tenantA);
      serve("/a.ics", feedAnswer);
      await sweep();
      serve("/a.ics", (_req, res) => {
        res.writeHead(200, { etag: '"v2"' });
        res.end(FEED);
      });
      registerCalendarFeedConsumer(async () => {
        throw new Error("cannot read the feed");
      });

      await sweep();

      expect(await stateOf(id)).toMatchObject({
        etag: '"v1"',
        last_modified: LAST_MODIFIED,
        last_error_code: "consumerFailed",
      });
    });

    it("that is absent records the fetch and stores no validators, so the feed is requested in full later", async () => {
      registerCalendarFeedConsumer(null);
      const id = await feedCalendar(tenantA);
      serve("/a.ics", feedAnswer);

      await sweep();
      await sweep();

      expect(await stateOf(id)).toMatchObject({
        etag: null,
        last_modified: null,
        last_status: 200,
        last_error_code: null,
      });
      expect(requestsFor("/a.ics").map((request) => request.headers["if-none-match"])).toEqual([undefined, undefined]);
    });
  });

  describe("the address", () => {
    it("is judged again before it is requested: one that fails the baseline is skipped", async () => {
      restorePolicy?.();
      restorePolicy = null;
      const id = await feedCalendar(tenantA);
      serve("/a.ics", feedAnswer);

      await sweep();

      expect(requests).toEqual([]);
      expect(consumed).toEqual([]);
      expect(await stateOf(id)).toMatchObject({ last_error_code: "urlNotAllowed", last_status: null });
    });

    it("that names a host resolving to an internal address is refused at connect time", async () => {
      restorePolicy?.();
      restorePolicy = null;
      dnsStub = stubDnsLookup({ "feed.internal.test": ["10.0.0.5"] });
      const id = await subscription(tenantA, "https://feed.internal.test/a.ics");

      await sweep();

      expect(dnsStub.calls).toEqual(["feed.internal.test"]);
      expect(consumed).toEqual([]);
      expect(await stateOf(id)).toMatchObject({ last_error_code: "addressRefused", last_status: null });
    });

    it("that names a host resolving to a loopback address is refused at connect time", async () => {
      restorePolicy?.();
      restorePolicy = null;
      dnsStub = stubDnsLookup({ "feed.loopback.test": ["127.0.0.1"] });
      const id = await subscription(tenantA, "https://feed.loopback.test/a.ics");

      await sweep();

      expect(requests).toEqual([]);
      expect(await stateOf(id)).toMatchObject({ last_error_code: "addressRefused" });
    });
  });

  describe("tenants and calendars", () => {
    it("processes two tenants independently, each in its own scope", async () => {
      const a = await feedCalendar(tenantA, "/a.ics");
      const b = await feedCalendar(tenantB, "/b.ics");
      serve("/a.ics", feedAnswer);
      serve("/b.ics", feedAnswer);
      const scopes = new Map<string, string>();
      registerCalendarFeedConsumer(async (client, feed) => {
        const { rows } = await client.query<{ tenant: string }>("SELECT app_tenant_default()::text AS tenant");
        scopes.set(feed.calendarItemId, z.object({ tenant: z.string() }).parse(rows[0]).tenant);
      });

      await sweep();

      expect(scopes.get(a)).toBe(tenantA.id);
      expect(scopes.get(b)).toBe(tenantB.id);
      // Through the runtime role, a tenant reads its own calendar's row and no other.
      const visible = (tenant: Tenant) =>
        runInTenant(tenant.id, () =>
          withTransaction(runtime, async (client) => {
            const { rows } = await client.query<{ calendar_item_id: string }>(
              "SELECT calendar_item_id FROM calendar_feed_state",
            );
            return rows.map((row) => row.calendar_item_id);
          }),
        );
      expect(await visible(tenantA)).toEqual([a]);
      expect(await visible(tenantB)).toEqual([b]);
    });

    it("does not stop the other calendars or tenants when one calendar's consumer fails", async () => {
      const a = await feedCalendar(tenantA, "/a.ics");
      const a2 = await feedCalendar(tenantA, "/a2.ics");
      const b = await feedCalendar(tenantB, "/b.ics");
      for (const path of ["/a.ics", "/a2.ics", "/b.ics"]) serve(path, feedAnswer);
      registerCalendarFeedConsumer(async (_client, feed) => {
        if (feed.calendarItemId === a) throw new Error("cannot read the feed");
        consumed.push(feed);
      });

      await sweep();

      expect(consumed.map((feed) => feed.calendarItemId).sort()).toEqual([a2, b].sort());
      expect(await stateOf(a)).toMatchObject({ last_error_code: "consumerFailed" });
      expect(await stateOf(a2)).toMatchObject({ etag: '"v1"' });
      expect(await stateOf(b)).toMatchObject({ etag: '"v1"' });
    });

    it("does not stop the other calendars or tenants when the store fails for the first calendar, and the task then fails", async () => {
      // Two calendars in each of two tenants, and the first write of the run fails: whichever calendar and tenant come
      // first, a missing per-calendar or per-tenant catch skips at least one more calendar.
      const all = [
        await feedCalendar(tenantA, "/a.ics"),
        await feedCalendar(tenantA, "/a2.ics"),
        await feedCalendar(tenantB, "/b.ics"),
        await feedCalendar(tenantB, "/b2.ics"),
      ];
      for (const path of ["/a.ics", "/a2.ics", "/b.ics", "/b2.ics"]) serve(path, feedAnswer);
      storeControl.failFirstFetched = true;
      const errorLog = vi.spyOn(logger, "error");

      const failure = await sweep().then(
        () => null,
        (error: unknown) => error,
      );

      const failedId = storeControl.failedFor;
      expect(failure).toBeInstanceOf(AggregateError);
      expect(all).toContain(failedId);
      expect(await stateOf(failedId ?? "")).toBeNull();
      for (const id of all.filter((candidate) => candidate !== failedId)) {
        expect(await stateOf(id)).toMatchObject({ etag: '"v1"', last_error_code: null });
      }
      // The log names the error's class and the calendar's id and nothing of the error's message.
      const text = JSON.stringify(errorLog.mock.calls);
      expect(text).toContain(failedId);
      expect(text).not.toContain("store unavailable");
    });

    it("does nothing for a tenant without subscription calendars", async () => {
      await sweep();

      expect(requests).toEqual([]);
    });
  });

  describe("purging a calendar", () => {
    it("deletes its download state with it", async () => {
      const id = await feedCalendar(tenantA);
      serve("/a.ics", feedAnswer);
      await sweep();
      expect(await stateOf(id)).not.toBeNull();
      const other = await feedCalendar(tenantA, "/a.ics");
      await sweep();

      await trash(id);
      const purged = await runInTenant(tenantA.id, () =>
        cp.purgeExpiredTrashSubtree(id, new Date(Date.now() + 60_000)),
      );

      expect(purged.purgedItemIds).toEqual([id]);
      expect(await stateOf(id)).toBeNull();
      expect(await stateOf(other)).not.toBeNull();
    });

    it("removes the row with the purged item even when the item is not a calendar", async () => {
      const databases = await runInTenant(tenantA.id, () => cp.listDatabases());
      const tasks = databases.find((row) => row.ownerModuleId === "tasks");
      if (!tasks) throw new Error("Missing the tasks database");
      const task = await runInTenant(tenantA.id, () =>
        cp.createItem({ databaseId: tasks.id, properties: { name: "Task" } }),
      );
      // Raw SQL as the superuser: no production write puts a download state row on an item that is no calendar; the
      // row is keyed by its item, so it goes with it whatever the item's database.
      await admin.query(
        "INSERT INTO calendar_feed_state (tenant_id, calendar_item_id, last_status) VALUES ($1, $2, 200)",
        [tenantA.id, task.id],
      );
      await runInTenant(tenantA.id, () => cp.softDeleteItem(tasks.id, task.id));
      await admin.query("UPDATE items SET deleted_at = now() - interval '1 hour' WHERE id = $1", [task.id]);

      const purged = await runInTenant(tenantA.id, () =>
        cp.purgeExpiredTrashSubtree(task.id, new Date(Date.now() + 60_000)),
      );

      expect(purged.purgedItemIds).toEqual([task.id]);
      expect(await stateOf(task.id)).toBeNull();
    });
  });
});
