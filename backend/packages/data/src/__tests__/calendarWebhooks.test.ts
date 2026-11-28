import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@alldots/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createUser } from "../auth/usersStore.js";
import { handleCalendarAccountSyncTask } from "../calendar/sync/calendarAccountSyncJob.js";
import {
  CALENDAR_PUSH_RENEW_BEFORE_MS,
  handleCalendarPushChannelsSweepTask,
  handleCalendarPushChannelsTask,
  setCalendarPushRuntime,
  type CalendarPushRuntime,
} from "../calendar/sync/calendarPushChannelsJob.js";
import { routeCalendarPushChannel } from "../calendar/sync/calendarPushChannelsStore.js";
import { resolveCalendarSyncIds } from "../calendar/sync/calendarSyncStore.js";
import { handleGoogleCalendarNotification } from "../calendar/sync/googleChannels.js";
import { handleGraphCalendarNotification } from "../calendar/sync/graphCalendarSubscriptions.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import { ensureMailAccountSyncState, recordGrantedOauthScopes } from "../mail/mailAccountSyncStateStore.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { removeMailbox } from "../mail/mailboxRemoval.js";
import { MICROSOFT_TOKEN_URL } from "../mail/oauthTokenExchange.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { seedSystem } from "../seed/seedSystem.js";
import { FakeCalendarProvider } from "../testSupport/fakeCalendarSyncAdapter.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const GOOGLE_API = "https://www.googleapis.com/calendar/v3";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GRAPH_SUBSCRIPTIONS = "https://graph.microsoft.com/v1.0/subscriptions";
const GOOGLE_WEBHOOK = "https://alldots.example.test/api/calendar/google/webhook";
const GRAPH_WEBHOOK = "https://alldots.example.test/api/calendar/graph/webhook";
const REFRESH_TOKEN = "1//refresh-token-of-the-account";
const CLIENT = { clientId: "client-id", clientSecret: "client-secret" };
const GOOGLE_GRANT = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
];
const GRAPH_GRANT = ["Mail.ReadWrite", "Mail.Send", "offline_access", "User.Read", "Calendars.ReadWrite"];
const START = new Date("2026-11-20T09:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const USER_WRITER = { writerKind: "user" } as const;

interface RecordedRequest {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

const jsonObject = z.record(z.string(), z.unknown());

/** Both providers' token endpoints and push APIs; an unexpected request fails the test. */
class FakeProviders {
  readonly requests: RecordedRequest[] = [];
  graphRenewStatus = 200;
  private subscriptions = 0;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    if (url === GOOGLE_TOKEN_URL || url === MICROSOFT_TOKEN_URL) {
      this.requests.push({ method, url, body: null });
      return Response.json({ access_token: "access-token", expires_in: 3599, token_type: "Bearer" });
    }
    const body = typeof init?.body === "string" ? jsonObject.parse(JSON.parse(init.body)) : null;
    this.requests.push({ method, url, body });
    if (method === "POST" && url.startsWith(`${GOOGLE_API}/calendars/`) && url.endsWith("/events/watch")) {
      return Response.json({
        kind: "api#channel",
        id: body?.id,
        resourceId: `resource-of-${decodeURIComponent(url.slice(`${GOOGLE_API}/calendars/`.length).split("/")[0] ?? "")}`,
        expiration: String(Date.now() + 7 * DAY_MS),
      });
    }
    if (method === "POST" && url === `${GOOGLE_API}/channels/stop`) return new Response(null, { status: 204 });
    if (method === "POST" && url === GRAPH_SUBSCRIPTIONS) {
      this.subscriptions += 1;
      return Response.json({
        id: `subscription-${this.subscriptions}`,
        expirationDateTime: new Date(Date.now() + 4230 * 60_000).toISOString(),
      });
    }
    if (method === "PATCH" && url.startsWith(`${GRAPH_SUBSCRIPTIONS}/`)) {
      if (this.graphRenewStatus !== 200) return new Response(null, { status: this.graphRenewStatus });
      return Response.json({
        id: decodeURIComponent(url.slice(GRAPH_SUBSCRIPTIONS.length + 1)),
        expirationDateTime: new Date(Date.now() + 4230 * 60_000).toISOString(),
      });
    }
    if (method === "DELETE" && url.startsWith(`${GRAPH_SUBSCRIPTIONS}/`)) return new Response(null, { status: 204 });
    throw new Error(`unexpected ${method} ${url}`);
  };

  /** The push API calls, without token refreshes. */
  pushCalls(): Array<{ method: string; url: string }> {
    return this.requests
      .filter((request) => request.url !== GOOGLE_TOKEN_URL && request.url !== MICROSOFT_TOKEN_URL)
      .map(({ method, url }) => ({ method, url }));
  }

  clear(): void {
    this.requests.length = 0;
  }
}

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;
const userIds = new Map<string, string>();
let providers: FakeProviders;

function inTenant<T>(fn: (client: PoolClient) => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(runtime, fn));
}

function pushRuntime(overrides: Partial<CalendarPushRuntime> = {}): CalendarPushRuntime {
  return {
    pool: runtime,
    google: { ...CLIENT, notificationUrl: GOOGLE_WEBHOOK },
    graph: { ...CLIENT, notificationUrl: GRAPH_WEBHOOK },
    fetchImpl: providers.fetch,
    ...overrides,
  };
}

/** A provider with two calendars, as the calendar sync's fake adapter serves them. */
function calendarProvider(): FakeCalendarProvider {
  const fake = new FakeCalendarProvider();
  fake.addCalendar({ remoteId: "work", url: null, name: "Work", color: null, readOnly: false, ctag: null });
  fake.addCalendar({ remoteId: "holidays", url: null, name: "Holidays", color: null, readOnly: true, ctag: null });
  return fake;
}

/** An OAuth account with Calendars on whose first pass, over `fake`, ended `ok`. */
async function createSyncedAccount(
  kind: "google" | "graph",
  fake: FakeCalendarProvider,
  tenantId = tenant,
): Promise<string> {
  const ids = await inTenant((client) => resolveCalendarSyncIds(client), tenantId);
  if (ids === null) throw new Error("the tenant has no calendar databases");
  const accountId = await inTenant(async (client) => {
    const mailbox = await createChokePoint(runtime).createItem({
      databaseId: ids.mailboxesDatabaseId,
      properties: {
        name: kind === "google" ? "Google" : "Microsoft",
        provider: kind === "google" ? "gmail" : "outlook",
        mailEnabled: true,
        calendarsEnabled: true,
      },
    });
    await writeMailboxAddresses(client, {
      mailboxesDatabaseId: ids.mailboxesDatabaseId,
      mailboxItemId: mailbox.id,
      address: "me@example.test",
    });
    await storeCredential(client, {
      itemId: mailbox.id,
      credentialType: "oauth2_refresh_token",
      plaintext: REFRESH_TOKEN,
    });
    await ensureMailAccountSyncState(client, {
      itemId: mailbox.id,
      syncMode: kind === "google" ? "gmail_api" : "graph_api",
    });
    await recordGrantedOauthScopes(client, mailbox.id, kind === "google" ? GOOGLE_GRANT : GRAPH_GRANT);
    return mailbox.id;
  }, tenantId);
  await syncPass(accountId, fake, tenantId);
  return accountId;
}

async function syncPass(accountId: string, fake: FakeCalendarProvider, tenantId = tenant): Promise<void> {
  const result = await runInTenant(tenantId, () =>
    handleCalendarAccountSyncTask(runtime, { accountItemId: accountId }, { adapters: fake.registry() }),
  );
  expect(result?.kind).toBe("applied");
}

function maintain(accountId: string, current: CalendarPushRuntime | null = pushRuntime(), tenantId = tenant) {
  return runInTenant(tenantId, () =>
    handleCalendarPushChannelsTask(runtime, { accountItemId: accountId }, { runtime: current }),
  );
}

const channelRow = z.object({
  provider: z.string(),
  channel_id: z.string(),
  calendar_remote_id: z.string().nullable(),
  resource_id: z.string().nullable(),
  secret: z.string(),
  expires_at: z.date(),
});

async function channels(accountId: string, tenantId = tenant) {
  return inTenant(async (client) => {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT p.provider, p.channel_id, s.remote_id AS calendar_remote_id, p.resource_id, p.secret, p.expires_at
         FROM calendar_push_channels p
         LEFT JOIN calendar_remote_state s ON s.calendar_item_id = p.calendar_item_id
        WHERE p.account_item_id = $1
        ORDER BY s.remote_id NULLS FIRST, p.expires_at`,
      [accountId],
    );
    return z.array(channelRow).parse(rows);
  }, tenantId);
}

/** The single channel of the account on `remoteId` (Google) or its subscription (Graph, `null`). */
async function channelOf(accountId: string, remoteId: string | null, tenantId = tenant) {
  const found = (await channels(accountId, tenantId)).filter((row) => row.calendar_remote_id === remoteId);
  expect(found).toHaveLength(1);
  return found[0]!;
}

const jobRow = z.object({ key: z.string().nullable(), tenant_id: z.string().nullable() });

async function jobs(taskIdentifier: string) {
  const { rows } = await admin.query<Record<string, unknown>>(
    `SELECT j.key, j.payload->>'tenantId' AS tenant_id
       FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id
      WHERE t.identifier = $1 ORDER BY j.key`,
    [taskIdentifier],
  );
  return z.array(jobRow).parse(rows);
}

async function clearJobs(): Promise<void> {
  await admin.query("DELETE FROM graphile_worker._private_jobs");
}

async function switchCalendarsOff(accountId: string) {
  const ids = await inTenant((client) => resolveCalendarSyncIds(client));
  const userId = userIds.get(tenant);
  await runInTenant(tenant, () =>
    createChokePoint(runtime).updateItem(
      { databaseId: ids!.mailboxesDatabaseId, itemId: accountId, propertiesPatch: { calendarsEnabled: false } },
      userId,
      userId,
      USER_WRITER,
    ),
  );
}

describe("calendar push channels and webhooks", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "alldots_data");
  });

  afterAll(async () => {
    await runtime.end();
  });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: START });
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    for (const id of [tenant, foreign]) {
      const user = await createUser(admin, {
        tenantId: id,
        email: `${randomUUID()}@example.test`,
        passwordHash: "unused",
        locale: "en",
      });
      userIds.set(id, user.id);
      await runInTenant(id, () => seedSystem(runtime));
    }
    providers = new FakeProviders();
  });

  afterEach(() => {
    setCalendarPushRuntime(null);
    vi.useRealTimers();
  });

  describe("router functions", () => {
    it.each(["route_google_calendar_channel", "route_graph_calendar_subscription"])(
      "%s is a SECURITY DEFINER function of alldots_router returning tenant ids, run by alldots_data only",
      async (name) => {
        const signature = `${name}(text)`;
        const { rows } = await admin.query<Record<string, unknown>>(
          `SELECT p.prosecdef AS secdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config,
                  pg_get_function_result(p.oid) AS result,
                  has_function_privilege('alldots_data', $2, 'EXECUTE') AS data,
                  has_function_privilege('alldots_side', $2, 'EXECUTE') AS side,
                  has_function_privilege('public', $2, 'EXECUTE') AS pub
             FROM pg_proc p WHERE p.proname = $1`,
          [name, signature],
        );
        expect(rows).toEqual([
          {
            secdef: true,
            owner: "alldots_router",
            config: ["search_path=pg_catalog, public, pg_temp"],
            result: "TABLE(tenant_id uuid)",
            data: true,
            side: false,
            pub: false,
          },
        ]);
      },
    );

    it("limits alldots_router to SELECT on the three columns the functions read", async () => {
      const columns = ["tenant_id", "provider", "channel_id", "secret", "account_item_id", "resource_id"];
      const { rows } = await admin.query<{ table_select: boolean; columns: boolean[] }>(
        `SELECT has_table_privilege('alldots_router', 'calendar_push_channels', 'SELECT') AS table_select,
                array(SELECT has_column_privilege('alldots_router', 'calendar_push_channels', c, 'SELECT')
                        FROM unnest($1::text[]) WITH ORDINALITY AS t(c, n) ORDER BY n) AS columns`,
        [columns],
      );
      expect(rows[0]).toEqual({ table_select: false, columns: [true, true, true, false, false, false] });
    });

    it("alldots_side cannot call them", async () => {
      const side = await createRuntimeRolePool(admin, "alldots_side");
      try {
        await expect(
          runAsSystem("test", () => side.query("SELECT tenant_id FROM route_google_calendar_channel('x')")),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await side.end();
      }
    });

    it("route a channel of either tenant from no tenant scope, per provider, and nothing else", async () => {
      const ownAccount = await createSyncedAccount("google", calendarProvider());
      const foreignAccount = await createSyncedAccount("graph", calendarProvider(), foreign);
      await maintain(ownAccount);
      await maintain(foreignAccount, pushRuntime(), foreign);
      const own = await channelOf(ownAccount, "work");
      const foreignSubscription = await channelOf(foreignAccount, null, foreign);

      expect(await routeCalendarPushChannel(runtime, "google", own.channel_id)).toBe(tenant);
      expect(await routeCalendarPushChannel(runtime, "graph", foreignSubscription.channel_id)).toBe(foreign);
      expect(await routeCalendarPushChannel(runtime, "graph", own.channel_id)).toBeNull();
      expect(await routeCalendarPushChannel(runtime, "google", foreignSubscription.channel_id)).toBeNull();
      expect(await routeCalendarPushChannel(runtime, "google", randomUUID())).toBeNull();
    });
  });

  describe("Google channels", () => {
    it("watches every tracked calendar with its own id and a random token, and stores them", async () => {
      const accountId = await createSyncedAccount("google", calendarProvider());
      expect(await maintain(accountId)).toEqual({ created: 2, renewed: 0, stopped: 0, failed: 0 });

      const watches = providers.requests.filter((request) => request.url.endsWith("/events/watch"));
      expect(watches.map((request) => request.url).sort()).toEqual([
        `${GOOGLE_API}/calendars/holidays/events/watch`,
        `${GOOGLE_API}/calendars/work/events/watch`,
      ]);
      for (const watch of watches) {
        expect(watch.body).toMatchObject({ type: "web_hook", address: GOOGLE_WEBHOOK, params: { ttl: "604800" } });
      }
      const stored = await channels(accountId);
      expect(stored.map((row) => [row.calendar_remote_id, row.resource_id])).toEqual([
        ["holidays", "resource-of-holidays"],
        ["work", "resource-of-work"],
      ]);
      for (const row of stored) {
        const watch = watches.find((request) => request.body?.id === row.channel_id);
        expect(watch?.body?.token).toBe(row.secret);
        expect(row.secret).toMatch(/^[0-9a-f]{64}$/);
        expect(row.expires_at.getTime()).toBe(START.getTime() + 7 * DAY_MS);
      }
      expect(new Set(stored.map((row) => row.secret)).size).toBe(2);

      providers.clear();
      expect(await maintain(accountId)).toEqual({ created: 0, renewed: 0, stopped: 0, failed: 0 });
      expect(providers.pushCalls()).toEqual([]);
    });

    it("a valid token queues exactly one sync of the account; an unknown channel or a wrong token queues nothing", async () => {
      const accountId = await createSyncedAccount("google", calendarProvider());
      await maintain(accountId);
      const work = await channelOf(accountId, "work");
      await clearJobs();

      const notify = (channelId: string, token: string | null, resourceState = "exists") =>
        handleGoogleCalendarNotification(runtime, { channelId, token, resourceState });

      expect(await notify(randomUUID(), work.secret)).toBe("unknownChannel");
      expect(await notify(work.channel_id, "0".repeat(64))).toBe("invalidSecret");
      expect(await notify(work.channel_id, null)).toBe("invalidSecret");
      expect(await notify(work.channel_id, work.secret, "sync")).toBe("accepted");
      expect(await jobs("calendarAccountSync")).toEqual([]);

      expect(await notify(work.channel_id, work.secret)).toBe("accepted");
      expect(await notify(work.channel_id, work.secret, "not_exists")).toBe("accepted");
      expect(await jobs("calendarAccountSync")).toEqual([
        { key: `calendar-account-sync:${accountId}`, tenant_id: tenant },
      ]);
    });

    it("replaces a channel within a day of its expiry, not before, and stops the old one", async () => {
      const accountId = await createSyncedAccount("google", calendarProvider());
      await maintain(accountId);
      const before = await channels(accountId);

      vi.setSystemTime(new Date(START.getTime() + 7 * DAY_MS - CALENDAR_PUSH_RENEW_BEFORE_MS - 60_000));
      providers.clear();
      expect(await maintain(accountId)).toEqual({ created: 0, renewed: 0, stopped: 0, failed: 0 });
      expect(providers.pushCalls()).toEqual([]);

      vi.setSystemTime(new Date(START.getTime() + 6 * DAY_MS + 60 * 60_000));
      providers.clear();
      expect(await maintain(accountId)).toEqual({ created: 2, renewed: 0, stopped: 2, failed: 0 });
      const stops = providers.requests.filter((request) => request.url === `${GOOGLE_API}/channels/stop`);
      expect(stops.map((request) => request.body)).toEqual(
        expect.arrayContaining(before.map((row) => ({ id: row.channel_id, resourceId: row.resource_id }))),
      );
      expect(stops).toHaveLength(2);
      const after = await channels(accountId);
      expect(after).toHaveLength(2);
      expect(after.some((row) => before.some((old) => old.channel_id === row.channel_id))).toBe(false);
    });

    it("stops the channel of a calendar the provider no longer lists", async () => {
      const fake = calendarProvider();
      const accountId = await createSyncedAccount("google", fake);
      await maintain(accountId);
      const holidays = await channelOf(accountId, "holidays");
      fake.removeCalendar("holidays");
      await syncPass(accountId, fake);
      providers.clear();

      expect(await maintain(accountId)).toEqual({ created: 0, renewed: 0, stopped: 1, failed: 0 });
      expect(providers.pushCalls()).toEqual([{ method: "POST", url: `${GOOGLE_API}/channels/stop` }]);
      expect(providers.requests.at(-1)?.body).toEqual({ id: holidays.channel_id, resourceId: holidays.resource_id });
      expect((await channels(accountId)).map((row) => row.calendar_remote_id)).toEqual(["work"]);
      expect(await handleGoogleCalendarNotification(runtime, { ...holidaysNotification(holidays) })).toBe(
        "unknownChannel",
      );
    });

    it("switching Calendars off queues the maintenance, which stops every channel of the account", async () => {
      const accountId = await createSyncedAccount("google", calendarProvider());
      await maintain(accountId);
      await clearJobs();

      await switchCalendarsOff(accountId);
      expect(await jobs("calendarPushChannels")).toEqual([
        { key: `calendar-push-channels:${accountId}`, tenant_id: tenant },
      ]);
      providers.clear();
      expect(await maintain(accountId)).toEqual({ created: 0, renewed: 0, stopped: 2, failed: 0 });
      expect(providers.pushCalls()).toEqual([
        { method: "POST", url: `${GOOGLE_API}/channels/stop` },
        { method: "POST", url: `${GOOGLE_API}/channels/stop` },
      ]);
      expect(await channels(accountId)).toEqual([]);
    });

    it("removing the account forgets its channels in the removal and stops them after the commit", async () => {
      const accountId = await createSyncedAccount("google", calendarProvider());
      await maintain(accountId);
      const stored = await channels(accountId);
      providers.clear();

      const removed = await runInTenant(tenant, () =>
        removeMailbox(runtime, accountId, {
          queueAffinity: createActionQueueAffinity(),
          cleanupDependencies: { oauth: { gmail: CLIENT }, outboundHttp: providers.fetch },
        }),
      );
      expect(removed).toBe(true);
      expect(await channels(accountId)).toEqual([]);
      const urls = providers.requests.map((request) => request.url);
      expect(urls).toEqual([GOOGLE_TOKEN_URL, `${GOOGLE_API}/channels/stop`, `${GOOGLE_API}/channels/stop`]);
      expect(providers.requests.slice(1, 3).map((request) => request.body)).toEqual(
        expect.arrayContaining(stored.map((row) => ({ id: row.channel_id, resourceId: row.resource_id }))),
      );
    });

    it("keeps no channel while the deployment does not host the webhook, and stops existing ones", async () => {
      const accountId = await createSyncedAccount("google", calendarProvider());
      const unhosted = pushRuntime({ google: { ...CLIENT, notificationUrl: null } });
      expect(await maintain(accountId, unhosted)).toEqual({ created: 0, renewed: 0, stopped: 0, failed: 0 });
      expect(providers.pushCalls()).toEqual([]);

      await maintain(accountId);
      providers.clear();
      expect(await maintain(accountId, unhosted)).toEqual({ created: 0, renewed: 0, stopped: 2, failed: 0 });
      expect(await channels(accountId)).toEqual([]);
    });
  });

  describe("Graph subscriptions", () => {
    it("subscribes to /me/events with a random clientState, which the webhook checks", async () => {
      const accountId = await createSyncedAccount("graph", calendarProvider());
      expect(await maintain(accountId)).toEqual({ created: 1, renewed: 0, stopped: 0, failed: 0 });
      const create = providers.requests.find((request) => request.url === GRAPH_SUBSCRIPTIONS);
      expect(create?.body).toMatchObject({
        changeType: "created,updated,deleted",
        notificationUrl: GRAPH_WEBHOOK,
        resource: "/me/events",
      });
      const subscription = await channelOf(accountId, null);
      expect(subscription).toMatchObject({ provider: "graph", channel_id: "subscription-1", resource_id: null });
      expect(create?.body?.clientState).toBe(subscription.secret);
      await clearJobs();

      const notify = (subscriptionId: string, clientState: string | null) =>
        handleGraphCalendarNotification(runtime, { subscriptionId, clientState });
      expect(await notify("subscription-2", subscription.secret)).toBe("unknownChannel");
      expect(await notify("subscription-1", "wrong")).toBe("invalidSecret");
      expect(await jobs("calendarAccountSync")).toEqual([]);
      expect(await notify("subscription-1", subscription.secret)).toBe("accepted");
      expect(await notify("subscription-1", subscription.secret)).toBe("accepted");
      expect(await jobs("calendarAccountSync")).toEqual([
        { key: `calendar-account-sync:${accountId}`, tenant_id: tenant },
      ]);
    });

    it("extends the subscription within a day of its expiry, and subscribes anew when Graph lost it", async () => {
      const accountId = await createSyncedAccount("graph", calendarProvider());
      await maintain(accountId);
      const created = await channelOf(accountId, null);

      vi.setSystemTime(new Date(START.getTime() + 2 * DAY_MS));
      providers.clear();
      expect(await maintain(accountId)).toEqual({ created: 0, renewed: 1, stopped: 0, failed: 0 });
      expect(providers.pushCalls()).toEqual([{ method: "PATCH", url: `${GRAPH_SUBSCRIPTIONS}/subscription-1` }]);
      const renewed = await channelOf(accountId, null);
      expect(renewed.secret).toBe(created.secret);
      expect(renewed.expires_at.getTime()).toBe(START.getTime() + 2 * DAY_MS + 4230 * 60_000);

      vi.setSystemTime(new Date(START.getTime() + 4 * DAY_MS));
      providers.graphRenewStatus = 404;
      providers.clear();
      expect(await maintain(accountId)).toEqual({ created: 1, renewed: 0, stopped: 0, failed: 0 });
      expect(providers.pushCalls()).toEqual([
        { method: "PATCH", url: `${GRAPH_SUBSCRIPTIONS}/subscription-1` },
        { method: "POST", url: GRAPH_SUBSCRIPTIONS },
      ]);
      expect((await channelOf(accountId, null)).channel_id).toBe("subscription-2");
    });

    it("deletes the subscription when Calendars are switched off", async () => {
      const accountId = await createSyncedAccount("graph", calendarProvider());
      await maintain(accountId);
      await switchCalendarsOff(accountId);
      providers.clear();
      expect(await maintain(accountId)).toEqual({ created: 0, renewed: 0, stopped: 1, failed: 0 });
      expect(providers.pushCalls()).toEqual([{ method: "DELETE", url: `${GRAPH_SUBSCRIPTIONS}/subscription-1` }]);
      expect(await channels(accountId)).toEqual([]);
    });
  });

  describe("sweep", () => {
    it("queues the maintenance of OAuth accounts of hosted providers and of accounts with channels, per tenant", async () => {
      const google = await createSyncedAccount("google", calendarProvider());
      const graph = await createSyncedAccount("graph", calendarProvider(), foreign);
      await clearJobs();

      setCalendarPushRuntime(pushRuntime({ graph: { ...CLIENT, notificationUrl: null } }));
      await handleCalendarPushChannelsSweepTask(runtime);
      expect(await jobs("calendarPushChannels")).toEqual([
        { key: `calendar-push-channels:${google}`, tenant_id: tenant },
      ]);

      await maintain(graph, pushRuntime(), foreign);
      await clearJobs();
      await handleCalendarPushChannelsSweepTask(runtime);
      expect(await jobs("calendarPushChannels")).toEqual(
        [
          { key: `calendar-push-channels:${google}`, tenant_id: tenant },
          { key: `calendar-push-channels:${graph}`, tenant_id: foreign },
        ].sort((a, b) => a.key.localeCompare(b.key)),
      );
    });
  });
});

function holidaysNotification(channel: { channel_id: string; secret: string }) {
  return { channelId: channel.channel_id, token: channel.secret, resourceState: "exists" };
}
